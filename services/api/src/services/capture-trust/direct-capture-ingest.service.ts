/**
 * UC-0 — Direct-capture ingest adapter core.
 *
 * The ONE orchestration every capture adapter (today: the PROOVRA mobile app;
 * later: the browser extension and native screen capture) uses to turn a
 * capture into canonical Evidence. It owns NO evidence authority of its own —
 * it sequences the existing ones:
 *
 *   openDirectCaptureSession      server-issued CaptureSession (ACTIVE) +
 *                                 unpredictable nonce (only its SHA-256 is
 *                                 stored) + CAPTURE_SESSION_STARTED
 *   reserveDirectCaptureEvidence  createEvidence (acquisition = the session's
 *                                 mode) and the one-way session → Evidence
 *                                 binding (`finalizedEvidenceId`, unique)
 *   declareDirectCapturePart      the client's per-part digest claim,
 *                                 optionally signed by the session's device key
 *                                 over a payload that must carry THIS session
 *                                 id and THIS session's nonce
 *   (bytes)                       canonical part presign
 *                                 (POST /v1/evidence/:id/parts) + storage PUT —
 *                                 never base64 in a JSON body
 *   completeDirectCapture         completeEvidence with the declared digests:
 *                                 the SERVER hashes every stored part and
 *                                 refuses a mismatch before anything is signed;
 *                                 then exactly one CAPTURE_SESSION_BOUND
 *
 * What it never does: hash, sign, timestamp, anchor, write custody directly,
 * or decide tenancy. Those stay with completeEvidence, the custody service and
 * the canonical authorization primitive (enforced by the routes).
 *
 * Denials are bounded codes (DIRECT_CAPTURE_DENIALS); no provider or driver
 * text reaches a trust payload or a response.
 */

import { evaluateFinalizationGovernance } from "../governance/finalization-governance.service.js";
import { createHash, randomBytes } from "node:crypto";

import * as prismaPkg from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import {
  CAPTURE_MANIFEST_FACTS_STAGE,
  CAPTURE_SEAL_CLAIM,
  MAX_EVIDENCE_PARTS,
  isLiveSealClaim,
  isStaleSealClaim,
  canonicalJson,
  isPositiveAttestationVerdict,
  isEvidenceAcquisitionMode,
  readCaptureManifestFacts,
  type CaptureManifestFacts,
  type CaptureSignaturePayload,
  type EvidenceAcquisitionMode,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { createEvidence } from "../evidence.service.js";
import { completeEvidence } from "../evidence-complete.service.js";
import { emitCaptureTrustEvent } from "./trust-event.service.js";
import { headObject } from "../../storage.js";
import { releaseEvidenceReservationTx } from "@proovra/shared-runtime";
import { verifyCaptureSignature } from "./signature-verifier.service.js";
import { verifyDeviceAttestation } from "./attestation-verifier.service.js";
import { authorizeCaseEvidenceLink } from "../cases/case-permission.service.js";
import { attachEvidenceToCase, CaseEvidenceAuthorityError } from "../cases/case-evidence-link.service.js";

// -----------------------------------------------------------------------------
// Contract
// -----------------------------------------------------------------------------

/** Acquisition modes a direct-capture session may be opened for. */
export const DIRECT_CAPTURE_SESSION_MODES = [
  "PROOVRA_MOBILE_APP",
  // UC-1 — the PROOVRA browser extension, in an unbound (no device key) session.
  "DIRECT_WEB_CAPTURE_EXTENSION",
  // UC-2 — the PROOVRA Android app captured the device screen via MediaProjection,
  // in an unbound (no device key) session, exactly like the web mode.
  "DIRECT_SCREEN_CAPTURE_ANDROID",
  // UC-3 — the PROOVRA Android app recorded a CONTINUOUS screen session (ordered
  // segments) via MediaProjection, in an unbound session.
  "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
  // UC-5 — the PROOVRA iOS app recorded the device screen through Apple's
  // user-authorised system broadcast (ReplayKit + a PROOVRA Broadcast Upload
  // Extension), preserved as ordered segments, in an unbound session — the iOS
  // analogue of the Android continuous mode.
  "DIRECT_SCREEN_CAPTURE_IOS",
] as const;
export type DirectCaptureSessionMode = (typeof DIRECT_CAPTURE_SESSION_MODES)[number];

/**
 * UC-ARCH-001 — WHO SAYS WHICH CLIENT PRODUCED THE BYTES.
 *
 * The session's acquisition mode is the provenance channel label ("Web
 * capture — PROOVRA extension", "iOS screen recording — PROOVRA app"). It was
 * copied verbatim from the open-session body, so any signed-in API client
 * could mint a record labelled as the extension's or the app's.
 *
 * The server now decides what the CREDENTIAL can establish:
 *
 *   EXTENSION_SCOPED_CREDENTIAL  a `capture.direct`-scoped token, which only
 *                                the first-party extension OAuth flow issues
 *                                (services/auth/extension-scope.ts). It may
 *                                open DIRECT_WEB_CAPTURE_EXTENSION and nothing
 *                                else; and only it may open that mode.
 *   CLIENT_DECLARED              an ordinary session token. There is NO
 *                                trustworthy mobile channel fact today: the app
 *                                authenticates with the same AUTH_JWT as the
 *                                web, sends no client credential, and device
 *                                registration + platform attestation have no
 *                                shipped client (UC-ARCH-007). The mobile and
 *                                screen modes stay available to such a token,
 *                                but their authority is recorded as
 *                                CLIENT_DECLARED on the session's
 *                                CAPTURE_SESSION_STARTED trust event — never
 *                                upgraded — and the mode descriptors already
 *                                say "(client-attested)" / "reports that".
 *
 * Any other restricted scope opens nothing. When device binding ships, a
 * device-bound session becomes a third authority; this is the one place that
 * decides it.
 */
export const DIRECT_CAPTURE_MODE_AUTHORITIES = ["EXTENSION_SCOPED_CREDENTIAL", "CLIENT_DECLARED"] as const;
export type DirectCaptureModeAuthority = (typeof DIRECT_CAPTURE_MODE_AUTHORITIES)[number];
/** Kept equal to EXTENSION_CAPTURE_SCOPE (services/auth/extension-scope.ts). */
const EXTENSION_CREDENTIAL_SCOPE = "capture.direct";

export function resolveDirectCaptureModeAuthority(
  mode: string,
  credentialScope: string | null | undefined,
): { allowed: true; authority: DirectCaptureModeAuthority } | { allowed: false } {
  if (!(DIRECT_CAPTURE_SESSION_MODES as ReadonlyArray<string>).includes(mode)) return { allowed: false };
  if (credentialScope === EXTENSION_CREDENTIAL_SCOPE) {
    return mode === "DIRECT_WEB_CAPTURE_EXTENSION"
      ? { allowed: true, authority: "EXTENSION_SCOPED_CREDENTIAL" }
      : { allowed: false };
  }
  if (credentialScope) return { allowed: false };
  // An ordinary token cannot claim the extension channel: only the extension's
  // own scoped credential establishes it.
  if (mode === "DIRECT_WEB_CAPTURE_EXTENSION") return { allowed: false };
  return { allowed: true, authority: "CLIENT_DECLARED" };
}

export const DIRECT_CAPTURE_CLIENT_SOURCES = [
  "CAMERA",
  "FILE_PICKER",
  "UNKNOWN",
  // UC-1 web-capture artifact roles (client-reported; the manifest is authoritative).
  "WEB_VIEWPORT",
  "WEB_FULL_PAGE",
  "WEB_DOM",
  "WEB_MANIFEST",
  // UC-2 screen-capture artifact roles (client-reported; the manifest is authoritative).
  "SCREEN_FRAME",
  "SCREEN_MANIFEST",
  // UC-3 continuous screen-capture artifact roles.
  "SCREEN_SEGMENT",
  "CONTINUOUS_MANIFEST",
  // Contract A (2026-10-29) — the ONE recording file of a SINGLE_FILE session.
  "SCREEN_RECORDING",
] as const;
export type DirectCaptureClientSource = (typeof DIRECT_CAPTURE_CLIENT_SOURCES)[number];

export const DIRECT_CAPTURE_DENIALS = {
  SESSION_NOT_FOUND: 404,
  SESSION_NOT_ACTIVE: 409,
  SESSION_EXPIRED: 409,
  SESSION_ALREADY_RESERVED: 409,
  // AUD-026 — a client attempt id names exactly one capture.
  CAPTURE_ATTEMPT_CONFLICT: 409,
  CAPTURE_ATTEMPT_ALREADY_SEALED: 409,
  SESSION_NOT_RESERVED: 409,
  EVIDENCE_NOT_OPEN: 409,
  DEVICE_NOT_REGISTERED: 409,
  DEVICE_REVOKED: 409,
  DEVICE_NOT_BOUND: 400,
  SIGNATURE_REQUIRED: 400,
  SIGNATURE_INVALID: 422,
  NONCE_MISMATCH: 422,
  PAYLOAD_SESSION_MISMATCH: 422,
  PAYLOAD_DIGEST_MISMATCH: 422,
  PAYLOAD_MODE_MISMATCH: 422,
  PART_ALREADY_DECLARED: 409,
  INVALID_PART_INDEX: 400,
  INVALID_DIGEST: 400,
  UNSUPPORTED_MODE: 400,
  CAPTURE_DIGEST_MISMATCH: 409,
  CAPTURE_PART_UNDECLARED: 409,
  CAPTURE_PART_DECLARATION_MISMATCH: 409,
  CAPTURE_PARTS_REQUIRED: 409,
  // UC-1 web capture.
  WEB_MANIFEST_REQUIRED: 400,
  WEB_MANIFEST_INVALID: 422,
  WEB_MANIFEST_DIGEST_UNDECLARED: 422,
  WEB_MANIFEST_ARTIFACT_MISMATCH: 422,
  // UC-2 screen capture.
  SCREEN_MANIFEST_REQUIRED: 400,
  SCREEN_MANIFEST_INVALID: 422,
  SCREEN_MANIFEST_DIGEST_UNDECLARED: 422,
  SCREEN_MANIFEST_ARTIFACT_MISMATCH: 422,
  // UC-3 continuous screen capture.
  CONTINUOUS_MANIFEST_REQUIRED: 400,
  CONTINUOUS_MANIFEST_INVALID: 422,
  CONTINUOUS_MANIFEST_DIGEST_UNDECLARED: 422,
  CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH: 422,
  // AUD-24 (2026-10-20) — COMPLETE claimed without the recorder's running count.
  CONTINUOUS_COMPLETENESS_UNDECLARED: 422,
  // A manifest-sealed mode completed through the generic route (2026-09-29).
  MANIFEST_SEAL_ROUTE_REQUIRED: 409,
  // Workspace policy refuses finalization (2026-09-29, audit D3).
  FINALIZATION_BLOCKED_BY_POLICY: 409,
  // A discard of a session whose record is already signed (2026-09-29, D11).
  EVIDENCE_ALREADY_FINALIZED: 409,
  // UC-ARCH-001 — the credential cannot establish the channel the mode names.
  MODE_NOT_ALLOWED_FOR_CREDENTIAL: 403,
  // UC-STR-002 — the session lock is held (a seal in progress); retry.
  SESSION_BUSY: 409,
  // UC-EXT-010 — a case named at open that the caller may not see (anti-
  // enumeration: the same answer as a missing case) or may not file into.
  CASE_NOT_FOUND: 404,
  CASE_LINK_NOT_PERMITTED: 403,
  // AUD-017 — a running recorder count that cannot be true for this part
  // (fewer recorded segments than this one's position), or one sent with a
  // part that is not a screen segment.
  INVALID_RECORDED_THROUGH: 400,
  // AUD-37 (2026-10-20) — stating a declared segment lost.
  LOSS_NOT_SUPPORTED_FOR_MODE: 422,
  PART_NOT_DECLARED: 409,
  PART_NOT_A_SEGMENT: 409,
  PART_BYTES_PRESENT: 409,
  PART_LOST: 409,
} as const;
export type DirectCaptureDenial = keyof typeof DIRECT_CAPTURE_DENIALS;

/**
 * 2026-10-29 — the ACTIONABLE message a client can show (or act on) for the
 * refusals a recorder meets mid-flow. The `denial` code stays the stable,
 * machine-readable contract; the message says what to do next.
 */
export const DIRECT_CAPTURE_DENIAL_MESSAGES: Readonly<Partial<Record<DirectCaptureDenial, string>>> = {
  PART_ALREADY_DECLARED:
    "This part number is already declared in this capture session with a different file. Fetch the session's declared parts (GET /v1/capture/direct-sessions/:id/parts) and declare this file at the next free part number.",
  PART_LOST:
    "This part number was stated lost in this capture session and cannot be declared again. Fetch the session's declared parts (GET /v1/capture/direct-sessions/:id/parts) and declare the file at the next free part number.",
  MANIFEST_SEAL_ROUTE_REQUIRED:
    "This capture session is sealed with its capture manifest, not through /complete. Upload and declare the manifest, then complete the session through its own route.",
  CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH:
    "The recording manifest does not match the files declared in this capture session: every recording file must be declared once, at the part number the manifest gives it, with the same digest and size, and the manifest must be declared as the capture manifest after them. Rebuild the manifest from the session's declared parts (GET /v1/capture/direct-sessions/:id/parts) and seal again.",
};

export class DirectCaptureError extends Error {
  readonly statusCode: number;
  readonly code: DirectCaptureDenial;
  /** A bounded, non-sensitive statement of WHICH check refused (for the client and logs). */
  readonly detail: string | null;
  constructor(code: DirectCaptureDenial, detail?: string | null) {
    super(code);
    this.code = code;
    this.statusCode = DIRECT_CAPTURE_DENIALS[code];
    this.detail = detail ? detail.slice(0, 200) : null;
  }
  /** The actionable message for this refusal, when it has one. */
  get actionableMessage(): string | null {
    return DIRECT_CAPTURE_DENIAL_MESSAGES[this.code] ?? null;
  }
}

const DEFAULT_TTL_SECONDS = 60 * 60;
const MAX_TTL_SECONDS = 4 * 60 * 60;
/**
 * ET-DC-06: the absolute lifetime of a direct-capture session. The expiry
 * SLIDES — every accepted reservation or declaration moves it to
 * now + DEFAULT_TTL_SECONDS — but never past startedAt + this. A continuous
 * capture that keeps uploading segments stays open; one that goes silent
 * expires an hour after its last activity.
 */
export const MAX_SESSION_LIFETIME_SECONDS = 24 * 60 * 60;

/**
 * Slide the session's expiry forward on authenticated activity. The fixed
 * one-hour expiry stranded continuous captures finalized more than an hour
 * after the session opened — after the app had already deleted its local
 * segments, so the recording was unrecoverable.
 */
export async function extendDirectCaptureSessionOnActivity(
  db: PrismaClient,
  session: Pick<SessionRow, "id" | "startedAtUtc">,
  now: Date,
): Promise<Date | null> {
  const started = session.startedAtUtc ?? now;
  const next = new Date(
    Math.min(now.getTime() + DEFAULT_TTL_SECONDS * 1000, started.getTime() + MAX_SESSION_LIFETIME_SECONDS * 1000),
  );
  const moved = await db.captureSession.updateMany({
    where: {
      id: session.id,
      status: prismaPkg.CaptureSessionStatus.ACTIVE,
      expiresAtUtc: { gt: now, lt: next },
    },
    data: { expiresAtUtc: next },
  });
  return moved.count === 1 ? next : null;
}
// ET-ACQ-07 — the one part bound, shared with the owner parts route.
const MAX_PARTS = MAX_EVIDENCE_PARTS;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Completion failures that prove the session's claims were false. */
const TERMINAL_COMPLETION_CODES: ReadonlySet<string> = new Set([
  "CAPTURE_DIGEST_MISMATCH",
  "CAPTURE_PART_UNDECLARED",
  "CAPTURE_PART_DECLARATION_MISMATCH",
  "CAPTURE_PARTS_REQUIRED",
]);

export function sha256HexOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type SessionRow = {
  id: string;
  ownerUserId: string;
  teamId: string | null;
  status: prismaPkg.CaptureSessionStatus;
  acquisitionMode: string | null;
  nonceSha256: string | null;
  deviceId: string | null;
  finalizedEvidenceId: string | null;
  expiresAtUtc: Date | null;
  startedAtUtc: Date | null;
  /** NULL while ACTIVE, except CAPTURE_SEAL_CLAIM.endReason while a seal holds it. */
  endReason: string | null;
  /** The seal claim's timestamp while one is held. */
  updatedAt: Date | null;
};

const SESSION_SELECT = {
  id: true,
  ownerUserId: true,
  teamId: true,
  status: true,
  acquisitionMode: true,
  nonceSha256: true,
  deviceId: true,
  finalizedEvidenceId: true,
  expiresAtUtc: true,
  startedAtUtc: true,
  endReason: true,
  updatedAt: true,
} as const;

// -----------------------------------------------------------------------------
// Open
// -----------------------------------------------------------------------------

export type OpenDirectCaptureSessionInput = {
  prisma?: PrismaClient;
  ownerUserId: string;
  /** The AUTHORIZED workspace id (the route has already proven access). */
  teamId: string;
  mode: DirectCaptureSessionMode;
  /** A registered device of this owner in this workspace, or null. */
  deviceId: string | null;
  /**
   * UC-ARCH-001 — the authenticated credential's scope (req.user.tokenScope):
   * the channel fact the mode is checked against. Null = an ordinary token.
   */
  credentialScope?: string | null;
  /**
   * UC-EXT-010 — a case to file the sealed record into. Authorized here by
   * THE case-link authority and linked in the same transaction as the bind.
   */
  caseId?: string | null;
  /**
   * AUD-026 — the client's id for THIS capture attempt. A retried open with
   * the same id (the response was lost, the network dropped) returns the same
   * live session instead of opening a second one. Unique per owner.
   */
  clientAttemptId?: string | null;
  ttlSeconds?: number;
  now?: Date;
};

export type OpenDirectCaptureSessionResult = {
  captureSessionId: string;
  /** Returned ONCE. Only its SHA-256 is stored. */
  nonceHex: string;
  acquisitionMode: DirectCaptureSessionMode;
  /** UC-ARCH-001 — what established the mode (never upgraded later). */
  modeAuthority: DirectCaptureModeAuthority;
  deviceBound: boolean;
  /** UC-EXT-010 — the case the record will be filed into at seal, if any. */
  caseId: string | null;
  startedAtUtc: string;
  expiresAtUtc: string;
  /** AUD-026 — true when a retried open returned the attempt's existing session. */
  reused: boolean;
  /** AUD-026 — the record this session already reserved, so a retry can skip reserve. */
  reservedEvidenceId: string | null;
};

export async function openDirectCaptureSession(
  input: OpenDirectCaptureSessionInput,
): Promise<OpenDirectCaptureSessionResult> {
  const db = input.prisma ?? defaultPrisma;
  if (!(DIRECT_CAPTURE_SESSION_MODES as ReadonlyArray<string>).includes(input.mode)) {
    throw new DirectCaptureError("UNSUPPORTED_MODE");
  }
  const authority = resolveDirectCaptureModeAuthority(input.mode, input.credentialScope ?? null);
  if (!authority.allowed) throw new DirectCaptureError("MODE_NOT_ALLOWED_FOR_CREDENTIAL");

  // UC-EXT-010 — the case is authorized NOW (so a capture is never recorded
  // against a case the caller cannot file into) and again at seal.
  const caseId = input.caseId ?? null;
  if (caseId) {
    const link = await authorizeCaseEvidenceLink({ userId: input.ownerUserId, caseId }, db);
    if (!link.allowed) {
      throw new DirectCaptureError(link.status === 404 ? "CASE_NOT_FOUND" : "CASE_LINK_NOT_PERMITTED");
    }
    const kase = await db.case.findUnique({ where: { id: caseId }, select: { teamId: true } });
    // The record is created in the session's workspace; a case elsewhere could
    // never hold it (the link authority refuses cross-workspace links).
    if (!kase || kase.teamId !== input.teamId) throw new DirectCaptureError("CASE_NOT_FOUND");
  }

  if (input.deviceId) {
    const device = await db.device.findFirst({
      where: {
        id: input.deviceId,
        teamId: input.teamId,
        ownerUserId: input.ownerUserId,
      },
      select: { id: true, revokedAtUtc: true },
    });
    if (!device) throw new DirectCaptureError("DEVICE_NOT_REGISTERED");
    if (device.revokedAtUtc !== null) throw new DirectCaptureError("DEVICE_REVOKED");
  }

  const now = input.now ?? new Date();
  const clientAttemptId = input.clientAttemptId ?? null;
  if (clientAttemptId) {
    const replay = await replayDirectCaptureAttempt(db, input, clientAttemptId, caseId, authority.authority, now);
    if (replay) return replay;
  }
  const ttl = Math.min(
    Math.max(Math.trunc(input.ttlSeconds ?? DEFAULT_TTL_SECONDS), 60),
    MAX_TTL_SECONDS,
  );
  const expiresAtUtc = new Date(now.getTime() + ttl * 1000);
  const nonceHex = randomBytes(32).toString("hex");

  let session: { id: string };
  try {
    session = await db.captureSession.create({
      data: {
        ownerUserId: input.ownerUserId,
        teamId: input.teamId,
        status: prismaPkg.CaptureSessionStatus.ACTIVE,
        acquisitionMode: input.mode,
        nonceSha256: sha256HexOf(nonceHex),
        deviceId: input.deviceId,
        startedAtUtc: now,
        expiresAtUtc,
        clientAttemptId,
      },
      select: { id: true },
    });
  } catch (err) {
    // Two concurrent opens of one attempt: the unique index admits one, and
    // the other returns the winner's session.
    if (clientAttemptId && (err as { code?: string }).code === "P2002") {
      const replay = await replayDirectCaptureAttempt(db, input, clientAttemptId, caseId, authority.authority, now);
      if (replay) return replay;
    }
    throw err;
  }

  await emitCaptureTrustEvent({
    prisma: db,
    teamId: input.teamId,
    captureSessionId: session.id,
    evidenceId: null,
    deviceId: input.deviceId,
    code: "CAPTURE_SESSION_STARTED",
    payload: {
      acquisitionMode: input.mode,
      modeAuthority: authority.authority,
      deviceBound: input.deviceId !== null,
      expiresAtUtc: expiresAtUtc.toISOString(),
      ...(caseId ? { caseId } : {}),
    },
  });

  return {
    captureSessionId: session.id,
    nonceHex,
    acquisitionMode: input.mode,
    modeAuthority: authority.authority,
    deviceBound: input.deviceId !== null,
    caseId,
    startedAtUtc: now.toISOString(),
    expiresAtUtc: expiresAtUtc.toISOString(),
    reused: false,
    reservedEvidenceId: null,
  };
}

/**
 * AUD-026 — the existing session of a client attempt, or null when a fresh one
 * must be opened. The replay is authorized exactly like a first open (the
 * caller re-ran every check above) and emits no second STARTED event.
 *
 *   ACTIVE, unexpired, same workspace/mode/case → the same session (a fresh
 *     nonce: the first response, and its nonce, may never have arrived);
 *   BOUND → refused: the attempt already sealed a record;
 *   anything else (discarded, interrupted, expired) → the attempt holds
 *     nothing, so it gives up its id and a fresh session is opened.
 */
async function replayDirectCaptureAttempt(
  db: PrismaClient,
  input: OpenDirectCaptureSessionInput,
  clientAttemptId: string,
  caseId: string | null,
  modeAuthority: DirectCaptureModeAuthority,
  now: Date,
): Promise<OpenDirectCaptureSessionResult | null> {
  const prior = await db.captureSession.findFirst({
    where: { ownerUserId: input.ownerUserId, clientAttemptId, acquisitionMode: { not: null } },
    select: SESSION_SELECT,
  });
  if (!prior) return null;
  if (
    prior.teamId !== input.teamId ||
    prior.acquisitionMode !== input.mode ||
    prior.deviceId !== (input.deviceId ?? null) ||
    (await readSessionCaseId(db, prior)) !== caseId
  ) {
    throw new DirectCaptureError("CAPTURE_ATTEMPT_CONFLICT");
  }
  if (prior.status === prismaPkg.CaptureSessionStatus.BOUND) {
    throw new DirectCaptureError("CAPTURE_ATTEMPT_ALREADY_SEALED");
  }
  const live =
    prior.status === prismaPkg.CaptureSessionStatus.ACTIVE &&
    (!prior.expiresAtUtc || prior.expiresAtUtc.getTime() > now.getTime());
  if (!live) {
    if (prior.status === prismaPkg.CaptureSessionStatus.ACTIVE) await interruptSession(db, prior, "EXPIRED", now);
    await db.captureSession.updateMany({
      where: { id: prior.id, clientAttemptId },
      data: { clientAttemptId: null },
    });
    return null;
  }
  const nonceHex = randomBytes(32).toString("hex");
  await db.captureSession.update({
    where: { id: prior.id },
    data: { nonceSha256: sha256HexOf(nonceHex) },
  });
  return {
    captureSessionId: prior.id,
    nonceHex,
    acquisitionMode: input.mode,
    modeAuthority,
    deviceBound: prior.deviceId !== null,
    caseId,
    startedAtUtc: (prior.startedAtUtc ?? now).toISOString(),
    expiresAtUtc: prior.expiresAtUtc!.toISOString(),
    reused: true,
    reservedEvidenceId: prior.finalizedEvidenceId,
  };
}

// -----------------------------------------------------------------------------
// Load (owner-scoped; unknown and foreign sessions are indistinguishable)
// -----------------------------------------------------------------------------

export async function loadOwnedDirectCaptureSession(
  db: PrismaClient,
  sessionId: string,
  ownerUserId: string,
): Promise<SessionRow> {
  const session = await db.captureSession.findFirst({
    where: { id: sessionId, ownerUserId, acquisitionMode: { not: null } },
    select: SESSION_SELECT,
  });
  if (!session || !session.teamId) throw new DirectCaptureError("SESSION_NOT_FOUND");
  return session;
}

async function requireActive(
  db: PrismaClient,
  session: SessionRow,
  now: Date,
): Promise<SessionRow> {
  if (session.status !== prismaPkg.CaptureSessionStatus.ACTIVE) {
    throw new DirectCaptureError("SESSION_NOT_ACTIVE");
  }
  if (session.expiresAtUtc && session.expiresAtUtc.getTime() <= now.getTime()) {
    // F-23 (independent forward audit, closure) — a session whose record is
    // ALREADY SEALED is not interrupted by a late call: interrupting it would
    // append CAPTURE_SESSION_INTERRUPTED to a sealed record's custody and leave
    // the bind retry (the seal committed, the bind did not) refused forever.
    // The late call is refused; the session stays ACTIVE for its bind.
    if (!(await reservedRecordSealed(db, session))) {
      await interruptSession(db, session, "EXPIRED", now);
    }
    throw new DirectCaptureError("SESSION_EXPIRED");
  }
  return session;
}

async function reservedRecordSealed(db: PrismaClient, session: SessionRow): Promise<boolean> {
  if (!session.finalizedEvidenceId) return false;
  const record = await db.evidence.findUnique({ where: { id: session.finalizedEvidenceId }, select: { status: true } });
  return record?.status === prismaPkg.EvidenceStatus.SIGNED || record?.status === prismaPkg.EvidenceStatus.REPORTED;
}

async function interruptSession(
  db: PrismaClient,
  session: SessionRow,
  endReason: string,
  now: Date,
): Promise<void> {
  const claim = await db.captureSession.updateMany({
    where: { id: session.id, status: prismaPkg.CaptureSessionStatus.ACTIVE },
    data: {
      status: prismaPkg.CaptureSessionStatus.INTERRUPTED,
      endedAtUtc: now,
      endReason,
    },
  });
  if (claim.count !== 1) return;
  await emitCaptureTrustEvent({
    prisma: db,
    teamId: session.teamId!,
    captureSessionId: session.id,
    evidenceId: session.finalizedEvidenceId,
    deviceId: session.deviceId,
    code: "CAPTURE_SESSION_INTERRUPTED",
    payload: { endReason },
  });
}

// -----------------------------------------------------------------------------
// Reserve the record
// -----------------------------------------------------------------------------

export type ReserveDirectCaptureEvidenceInput = {
  prisma?: PrismaClient;
  sessionId: string;
  ownerUserId: string;
  type: prismaPkg.EvidenceType;
  mimeType?: string;
  originalFileName?: string | null;
  deviceTimeIso?: string;
  gps?: { lat: number; lng: number; accuracyMeters?: number; providerReportedMock?: boolean };
  locationRequestOutcome?: "DENIED" | "UNAVAILABLE" | "TIMEOUT" | "NOT_REQUESTED";
  now?: Date;
};

export async function reserveDirectCaptureEvidence(
  input: ReserveDirectCaptureEvidenceInput,
): Promise<{ evidenceId: string; teamId: string; acquisitionMode: EvidenceAcquisitionMode }> {
  const db = input.prisma ?? defaultPrisma;
  const now = input.now ?? new Date();

  // Serialise reservations of ONE session: the advisory lock is held by this
  // transaction while createEvidence runs, so a concurrent reserve for the same
  // session waits, re-reads, and is refused instead of minting a second record.
  //
  // ET-DC-07 — the record is written IN this transaction: it used to commit on
  // the global client, so a reserve that failed after it (the binding, the
  // session extension) left an unbound committed record and the retry minted a
  // second one. Its post-commit steps run after this transaction commits.
  const reserved = await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capture-session:${input.sessionId}`}))`;
      const session = await loadOwnedDirectCaptureSession(
        tx as unknown as PrismaClient,
        input.sessionId,
        input.ownerUserId,
      );
      if (isLiveSealClaim(session, now)) throw new DirectCaptureError("SESSION_BUSY");
      await requireActive(db, session, now);
      if (session.finalizedEvidenceId) {
        throw new DirectCaptureError("SESSION_ALREADY_RESERVED");
      }
      if (!isEvidenceAcquisitionMode(session.acquisitionMode)) {
        throw new DirectCaptureError("UNSUPPORTED_MODE");
      }

      const created = await createEvidence({
        ownerUserId: input.ownerUserId,
        teamId: session.teamId,
        type: input.type,
        mimeType: input.mimeType,
        originalFileName: input.originalFileName ?? null,
        captureFileName: null,
        deviceTimeIso: input.deviceTimeIso,
        gps: input.gps,
        locationRequestOutcome: input.locationRequestOutcome,
        acquisitionMode: session.acquisitionMode,
        captureSessionId: session.id,
        transaction: tx,
      });

      await tx.captureSession.update({
        where: { id: session.id },
        data: { finalizedEvidenceId: created.id },
      });
      await extendDirectCaptureSessionOnActivity(tx as unknown as PrismaClient, session, now);

      return {
        evidenceId: created.id,
        teamId: created.teamId,
        acquisitionMode: session.acquisitionMode,
        afterCommit: created.afterCommit,
      };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  await reserved.afterCommit?.();
  return {
    evidenceId: reserved.evidenceId,
    teamId: reserved.teamId,
    acquisitionMode: reserved.acquisitionMode,
  };
}

// -----------------------------------------------------------------------------
// Declare a part's digest
// -----------------------------------------------------------------------------

export type DeclareDirectCapturePartInput = {
  prisma?: PrismaClient;
  sessionId: string;
  ownerUserId: string;
  partIndex: number;
  sha256: string;
  clientReportedSource: DirectCaptureClientSource;
  /**
   * AUD-017 — a continuous recorder's running count when this segment was
   * declared. Optional (a legacy client never sends it); recorded with the
   * declaration so the seal can refuse a manifest whose recorded count is
   * lower than the count the client already declared.
   */
  recordedThrough?: number | null;
  signed: { payload: CaptureSignaturePayload; signatureHex: string } | null;
  now?: Date;
};

export type PartDeclaration = {
  partIndex: number;
  sha256: string;
  signatureVerdict: string;
  /** What the client said the part is (SCREEN_SEGMENT, CONTINUOUS_MANIFEST, …). */
  clientReportedSource: string | null;
  /** AUD-017 — the recorder's running count the client declared with this part, if any. */
  recordedThrough: number | null;
};

export async function declareDirectCapturePart(
  input: DeclareDirectCapturePartInput,
): Promise<{ declaration: PartDeclaration; created: boolean; sessionExpiresAtUtc: string | null }> {
  const db = input.prisma ?? defaultPrisma;
  const now = input.now ?? new Date();
  const sha256 = input.sha256.toLowerCase();
  if (!Number.isInteger(input.partIndex) || input.partIndex < 0 || input.partIndex >= MAX_PARTS) {
    throw new DirectCaptureError("INVALID_PART_INDEX");
  }
  if (!SHA256_HEX.test(sha256)) throw new DirectCaptureError("INVALID_DIGEST");
  const recordedThrough = input.recordedThrough ?? null;
  if (
    recordedThrough !== null &&
    // Contract A — the one SCREEN_RECORDING of a single-file session may carry
    // the recorder's count too (always 1, at part 0).
    ((input.clientReportedSource !== "SCREEN_SEGMENT" && input.clientReportedSource !== "SCREEN_RECORDING") ||
      !Number.isInteger(recordedThrough) ||
      recordedThrough < input.partIndex + 1 ||
      recordedThrough > MAX_PARTS)
  ) {
    throw new DirectCaptureError("INVALID_RECORDED_THROUGH");
  }

  const session = await requireActive(
    db,
    await loadOwnedDirectCaptureSession(db, input.sessionId, input.ownerUserId),
    now,
  );
  if (!session.finalizedEvidenceId) throw new DirectCaptureError("SESSION_NOT_RESERVED");

  const evidence = await db.evidence.findUnique({
    where: { id: session.finalizedEvidenceId },
    select: { status: true, deletedAt: true },
  });
  if (
    !evidence ||
    evidence.deletedAt ||
    (evidence.status !== prismaPkg.EvidenceStatus.CREATED &&
      evidence.status !== prismaPkg.EvidenceStatus.UPLOADING)
  ) {
    throw new DirectCaptureError("EVIDENCE_NOT_OPEN");
  }

  // A device-bound session must sign every declaration; an unbound session
  // has no key to verify against, so it may not present a signature.
  let signatureVerdict = "MISSING";
  if (session.deviceId) {
    if (!input.signed) throw new DirectCaptureError("SIGNATURE_REQUIRED");
    const p = input.signed.payload;
    if (p.captureSessionId !== session.id) {
      throw new DirectCaptureError("PAYLOAD_SESSION_MISMATCH");
    }
    if (!session.nonceSha256 || sha256HexOf(p.nonceHex.toLowerCase()) !== session.nonceSha256) {
      await recordDeclarationFailure(db, session, input.partIndex, "NONCE_MISMATCH");
      throw new DirectCaptureError("NONCE_MISMATCH");
    }
    if (p.assetHash.toLowerCase() !== sha256) {
      throw new DirectCaptureError("PAYLOAD_DIGEST_MISMATCH");
    }
    if (p.captureMode !== session.acquisitionMode || p.deviceKeyId !== session.deviceId) {
      throw new DirectCaptureError("PAYLOAD_MODE_MISMATCH");
    }
    const verification = await verifyCaptureSignature({
      prisma: db,
      teamId: session.teamId!,
      payload: p,
      signatureHex: input.signed.signatureHex,
      // Bytes are not in this request — they go to storage. The asset hash in
      // the payload is compared with the SERVER digest at completion.
      assetBytes: null,
    });
    if (verification.verdict !== "VALID") {
      await recordDeclarationFailure(db, session, input.partIndex, verification.verdict);
      throw new DirectCaptureError("SIGNATURE_INVALID");
    }
    signatureVerdict = verification.verdict;
  } else if (input.signed) {
    throw new DirectCaptureError("DEVICE_NOT_BOUND");
  }

  // UC-STR-002 — a declaration is SERIALISED with the seal, under the session
  // lock the seal holds from reading the declarations until it binds. A
  // declaration either commits before the seal reads them (and the manifest
  // must then cover it) or waits and finds the session sealed — it can never
  // land between the seal's check and its bind, so a late segment cannot slip
  // past a COMPLETE claim.
  try {
    return await db.$transaction(
      async (tx) => {
        // A seal can hold the lock while it hashes every part; a declaration
        // waits a bounded time for it, then is answered SESSION_BUSY (retryable)
        // rather than hanging or surfacing as a server error.
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${DECLARATION_LOCK_WAIT_MS}ms`}, true)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capture-session:${session.id}`}))`;
        const locked = await loadOwnedDirectCaptureSession(tx as unknown as PrismaClient, session.id, input.ownerUserId);
        // UC-STR-002 — a seal has claimed the session: no part may join it now.
        if (isLiveSealClaim(locked, now)) throw new DirectCaptureError("SESSION_BUSY");
        if (isStaleSealClaim(locked, now)) {
          // A crashed seal: its lease is over, so the session is open again.
          await db.captureSession.updateMany({
            where: { id: locked.id, status: prismaPkg.CaptureSessionStatus.ACTIVE, endReason: CAPTURE_SEAL_CLAIM.endReason },
            data: { endReason: null },
          });
        }
        const fresh = await requireActive(db, locked, now);
        return declareUnderSessionLock(tx as unknown as PrismaClient, db, fresh, input, sha256, signatureVerdict, now);
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  } catch (err) {
    if (isLockWaitCancelled(err)) throw new DirectCaptureError("SESSION_BUSY");
    throw err;
  }
}

/** How long a declaration waits for a seal (or another writer) holding the session lock. */
const DECLARATION_LOCK_WAIT_MS = 15_000;

/** PostgreSQL cancelled a lock wait (lock_timeout 55P03, or statement_timeout 57014). */
function isLockWaitCancelled(err: unknown): boolean {
  const text = `${(err as { message?: unknown })?.message ?? ""} ${JSON.stringify((err as { meta?: unknown })?.meta ?? {})}`;
  return /\b(55P03|57014)\b|lock timeout|statement timeout/i.test(text);
}

async function declareUnderSessionLock(
  tx: PrismaClient,
  db: PrismaClient,
  session: SessionRow,
  input: DeclareDirectCapturePartInput,
  sha256: string,
  signatureVerdict: string,
  now: Date,
): Promise<{ declaration: PartDeclaration; created: boolean; sessionExpiresAtUtc: string | null }> {
  // AUD-37 — an index stated lost stays lost: it is never declared again.
  if ((await readLostPartIndexes(tx, session)).has(input.partIndex)) {
    throw new DirectCaptureError("PART_LOST");
  }
  const existing = (await readPartDeclarations(tx, session)).get(input.partIndex);
  if (existing) {
    // The same index with a different digest is a second, conflicting claim.
    if (existing.sha256 !== sha256) throw new DirectCaptureError("PART_ALREADY_DECLARED");
    return {
      declaration: existing,
      created: false,
      sessionExpiresAtUtc: session.expiresAtUtc?.toISOString() ?? null,
    };
  }

  await emitCaptureTrustEvent({
    prisma: db,
    teamId: session.teamId!,
    captureSessionId: session.id,
    evidenceId: null,
    deviceId: session.deviceId,
    code: input.signed ? "CAPTURE_ARTIFACT_SIGNED_AT_SOURCE" : "CAPTURE_ARTIFACT_RECEIVED",
    payload: {
      stage: "part_declared",
      partIndex: input.partIndex,
      declaredSha256: sha256,
      signatureVerdict,
      clientReportedSource: input.clientReportedSource,
      // AUD-017 — the client's running recorder count, stored as its statement.
      ...(input.recordedThrough != null ? { clientReportedRecordedThrough: input.recordedThrough } : {}),
      ...(input.signed
        ? {
            algorithm: input.signed.payload.algorithm,
            signedAtUtc: input.signed.payload.signedAtUtc,
            // The canonical signed bytes are reproducible from the payload;
            // their digest lets a reviewer tie this event to the signature.
            signedPayloadSha256: sha256HexOf(canonicalJson(input.signed.payload)),
          }
        : {}),
    },
  });

  // UC-STR-003 — the slid expiry is RETURNED, so the client's durable record
  // follows the server's session instead of the expiry it was given at open.
  const extended = await extendDirectCaptureSessionOnActivity(db, session, now);
  const expiresAt = extended ?? session.expiresAtUtc;

  return {
    declaration: {
      partIndex: input.partIndex,
      sha256,
      signatureVerdict,
      clientReportedSource: input.clientReportedSource,
      recordedThrough: input.recordedThrough ?? null,
    },
    created: true,
    sessionExpiresAtUtc: expiresAt ? expiresAt.toISOString() : null,
  };
}

async function recordDeclarationFailure(
  db: PrismaClient,
  session: SessionRow,
  partIndex: number,
  verdict: string,
): Promise<void> {
  await emitCaptureTrustEvent({
    prisma: db,
    teamId: session.teamId!,
    captureSessionId: session.id,
    evidenceId: null,
    deviceId: session.deviceId,
    code: "CAPTURE_ARTIFACT_VERIFICATION_FAILED",
    payload: { stage: "part_declared", partIndex, verdict },
  });
}

/** Declarations are the server-written trust events of this session. */
export async function readPartDeclarations(
  db: PrismaClient,
  session: Pick<SessionRow, "id" | "teamId">,
): Promise<Map<number, PartDeclaration>> {
  const rows = await db.captureTrustEventRecord.findMany({
    where: {
      teamId: session.teamId!,
      captureSessionId: session.id,
      code: { in: ["CAPTURE_ARTIFACT_SIGNED_AT_SOURCE", "CAPTURE_ARTIFACT_RECEIVED", "CAPTURE_ARTIFACT_LOST"] },
    },
    orderBy: { sequence: "asc" },
    select: { payload: true, code: true },
    take: MAX_PARTS * 3,
  });
  const out = new Map<number, PartDeclaration>();
  // AUD-37 — a segment stated LOST is not part of the set the seal expects.
  const lost = new Set<number>();
  for (const r of rows) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    if (r.code === "CAPTURE_ARTIFACT_LOST") {
      if (p["stage"] === "part_lost" && typeof p["partIndex"] === "number") lost.add(p["partIndex"]);
      continue;
    }
    if (p["stage"] !== "part_declared") continue;
    const idx = p["partIndex"];
    const digest = p["declaredSha256"];
    if (typeof idx !== "number" || typeof digest !== "string") continue;
    if (!out.has(idx)) {
      out.set(idx, {
        partIndex: idx,
        sha256: digest,
        signatureVerdict: typeof p["signatureVerdict"] === "string" ? p["signatureVerdict"] : "MISSING",
        clientReportedSource:
          typeof p["clientReportedSource"] === "string" ? p["clientReportedSource"] : null,
        recordedThrough:
          typeof p["clientReportedRecordedThrough"] === "number" &&
          Number.isInteger(p["clientReportedRecordedThrough"]) &&
          p["clientReportedRecordedThrough"] > 0
            ? p["clientReportedRecordedThrough"]
            : null,
      });
    }
  }
  for (const idx of lost) out.delete(idx);
  return out;
}

/** AUD-37 — the part indexes this session's recorder stated LOST. */
export async function readLostPartIndexes(
  db: PrismaClient,
  session: Pick<SessionRow, "id" | "teamId">,
): Promise<Set<number>> {
  const rows = await db.captureTrustEventRecord.findMany({
    where: { teamId: session.teamId!, captureSessionId: session.id, code: "CAPTURE_ARTIFACT_LOST" },
    select: { payload: true },
    take: MAX_PARTS,
  });
  const out = new Set<number>();
  for (const r of rows) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    if (p["stage"] === "part_lost" && typeof p["partIndex"] === "number") out.add(p["partIndex"]);
  }
  return out;
}

/**
 * F-02 (independent forward audit) — the lowest recorder count a session's
 * LOSSES prove: a segment stated lost at index i was recorded, so at least
 * i + 1 segments were (and at least the running count declared with it).
 * Null when nothing was stated lost. The continuous seal binds the manifest to
 * it, so a lost TAIL cannot be hidden by lowering the recorder count.
 */
export async function readLostRecordedThroughMin(
  db: PrismaClient,
  session: Pick<SessionRow, "id" | "teamId">,
): Promise<number | null> {
  const rows = await db.captureTrustEventRecord.findMany({
    where: { teamId: session.teamId!, captureSessionId: session.id, code: "CAPTURE_ARTIFACT_LOST" },
    select: { payload: true },
    take: MAX_PARTS,
  });
  let bound: number | null = null;
  for (const r of rows) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    if (p["stage"] !== "part_lost" || typeof p["partIndex"] !== "number") continue;
    const through = p["clientReportedRecordedThrough"];
    const proven = Math.max(
      p["partIndex"] + 1,
      typeof through === "number" && Number.isInteger(through) && through > 0 ? through : 0,
    );
    bound = bound === null ? proven : Math.max(bound, proven);
  }
  return bound;
}

export type DirectCapturePartListing = {
  partIndex: number;
  sha256: string;
  state: "DECLARED" | "UPLOADED" | "LOST";
  /** What the client said the part is, verbatim from its declaration. */
  source: string | null;
};

/**
 * Wire contract C (2026-10-29) — THE server-authoritative list of a session's
 * declared parts, for its owner. A client allocates its next part index as
 * max(partIndex) + 1 from this list (a LOST index is never reused) and treats
 * PART_ALREADY_DECLARED as "refetch and retry"; the declaration under the
 * session lock stays the uniqueness authority. UPLOADED means the bytes are in
 * storage (a sealed record's parts all are); it is read, not assumed.
 */
export async function listDirectCaptureParts(input: {
  prisma?: PrismaClient;
  sessionId: string;
  ownerUserId: string;
}): Promise<{ parts: DirectCapturePartListing[] }> {
  const db = input.prisma ?? defaultPrisma;
  const session = await loadOwnedDirectCaptureSession(db, input.sessionId, input.ownerUserId);
  const rows = await db.captureTrustEventRecord.findMany({
    where: {
      teamId: session.teamId!,
      captureSessionId: session.id,
      code: { in: ["CAPTURE_ARTIFACT_SIGNED_AT_SOURCE", "CAPTURE_ARTIFACT_RECEIVED", "CAPTURE_ARTIFACT_LOST"] },
    },
    orderBy: { sequence: "asc" },
    select: { payload: true, code: true },
    take: MAX_PARTS * 3,
  });
  const declared = new Map<number, { sha256: string; source: string | null }>();
  const lost = new Set<number>();
  for (const r of rows) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const idx = p["partIndex"];
    if (typeof idx !== "number" || !Number.isInteger(idx)) continue;
    if (r.code === "CAPTURE_ARTIFACT_LOST") {
      if (p["stage"] === "part_lost") lost.add(idx);
      continue;
    }
    if (p["stage"] !== "part_declared" || typeof p["declaredSha256"] !== "string") continue;
    if (!declared.has(idx)) {
      declared.set(idx, {
        sha256: p["declaredSha256"],
        source: typeof p["clientReportedSource"] === "string" ? p["clientReportedSource"] : null,
      });
    }
  }

  // Which declared parts' bytes are stored. A sealed record holds every part;
  // otherwise one bounded HEAD per declared part that has a part row.
  const uploaded = new Set<number>();
  const evidenceId = session.finalizedEvidenceId;
  if (evidenceId && declared.size > 0) {
    const record = await db.evidence.findUnique({ where: { id: evidenceId }, select: { status: true } });
    const sealed =
      record?.status === prismaPkg.EvidenceStatus.SIGNED || record?.status === prismaPkg.EvidenceStatus.REPORTED;
    const partRows = await db.evidencePart.findMany({
      where: { evidenceId, partIndex: { in: [...declared.keys()] } },
      select: { partIndex: true, storageBucket: true, storageKey: true },
    });
    const pending = partRows.filter((p) => !lost.has(p.partIndex) && p.storageBucket && p.storageKey);
    if (sealed) {
      for (const p of pending) uploaded.add(p.partIndex);
    } else {
      const HEAD_CONCURRENCY = 8;
      for (let i = 0; i < pending.length; i += HEAD_CONCURRENCY) {
        await Promise.all(
          pending.slice(i, i + HEAD_CONCURRENCY).map(async (p) => {
            try {
              const head = await headObject({ bucket: p.storageBucket, key: p.storageKey });
              if ((head.sizeBytes ?? 0) > 0) uploaded.add(p.partIndex);
            } catch {
              /* absent: still only declared */
            }
          }),
        );
      }
    }
  }

  const parts: DirectCapturePartListing[] = [...declared.entries()]
    .sort(([a], [b]) => a - b)
    .map(([partIndex, d]) => ({
      partIndex,
      sha256: d.sha256,
      state: lost.has(partIndex) ? "LOST" : uploaded.has(partIndex) ? "UPLOADED" : "DECLARED",
      source: d.source,
    }));
  return { parts };
}

/**
 * AUD-37 — is this part of a direct-capture record stated LOST? The canonical
 * part presign refuses to re-open a lost index (its bytes would be a part no
 * declaration covers).
 */
export async function isDirectCapturePartLost(db: PrismaClient, evidenceId: string, partIndex: number): Promise<boolean> {
  const session = await db.captureSession.findFirst({
    where: { finalizedEvidenceId: evidenceId },
    select: { id: true, teamId: true },
  });
  if (!session || !session.teamId) return false;
  return (await readLostPartIndexes(db, session)).has(partIndex);
}

/** Modes whose segments stream WHILE recording, so a declared one can be lost. */
const LOSS_CAPABLE_MODES: ReadonlySet<string> = new Set([
  "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
  "DIRECT_SCREEN_CAPTURE_IOS",
]);

/**
 * AUD-37 (2026-10-20) — STATE A DECLARED SEGMENT LOST.
 *
 * A continuous recorder declares a segment's digest, then uploads its bytes.
 * When the upload failed for good, the declaration stayed: the seal expects
 * every declared part (1:1 with the manifest) and every part's stored bytes,
 * so the WHOLE session became unsealable — the recorded remainder could never
 * become evidence, where the honest outcome is an INTERRUPTED session with
 * SEGMENT_UPLOAD_LOST.
 *
 * The declaration is never withdrawn (the trust chain is append-only). A
 * CAPTURE_ARTIFACT_LOST event is appended; the seal then expects every
 * declaration EXCEPT the lost ones, a COMPLETE manifest cannot be satisfied
 * (its sequence is no longer contiguous), and the lost index can be neither
 * declared again nor re-presigned. A loss is refused when the bytes ARE stored
 * (that segment is not lost; seal it). The bytes-less part row of the
 * still-unsealed record is withdrawn so the seal does not read an absent object.
 * Idempotent.
 */
export async function declareDirectCapturePartLost(input: {
  prisma?: PrismaClient;
  sessionId: string;
  ownerUserId: string;
  partIndex: number;
  now?: Date;
}): Promise<{ partIndex: number; created: boolean }> {
  const db = input.prisma ?? defaultPrisma;
  const now = input.now ?? new Date();
  if (!Number.isInteger(input.partIndex) || input.partIndex < 0 || input.partIndex >= MAX_PARTS) {
    throw new DirectCaptureError("INVALID_PART_INDEX");
  }
  const session = await requireActive(db, await loadOwnedDirectCaptureSession(db, input.sessionId, input.ownerUserId), now);
  if (!LOSS_CAPABLE_MODES.has(session.acquisitionMode ?? "")) throw new DirectCaptureError("LOSS_NOT_SUPPORTED_FOR_MODE");
  const evidenceId = session.finalizedEvidenceId;
  if (!evidenceId) throw new DirectCaptureError("SESSION_NOT_RESERVED");
  const evidence = await db.evidence.findUnique({ where: { id: evidenceId }, select: { status: true, deletedAt: true } });
  if (
    !evidence ||
    evidence.deletedAt ||
    (evidence.status !== prismaPkg.EvidenceStatus.CREATED && evidence.status !== prismaPkg.EvidenceStatus.UPLOADING)
  ) {
    throw new DirectCaptureError("EVIDENCE_NOT_OPEN");
  }

  // F-17 (independent forward audit) — whether the bytes are stored is read
  // UNDER the session lock (below), so a loss is never declared over bytes that
  // landed between an unlocked read and the withdrawal. One HEAD, bounded.
  const storedBytesPresent = async (txc: PrismaClient): Promise<boolean> => {
    const part = await txc.evidencePart.findFirst({
      where: { evidenceId, partIndex: input.partIndex },
      select: { storageBucket: true, storageKey: true },
    });
    if (!part?.storageBucket || !part.storageKey) return false;
    try {
      return ((await headObject({ bucket: part.storageBucket, key: part.storageKey })).sizeBytes ?? 0) > 0;
    } catch {
      return false; // absent — which is what a loss is
    }
  };

  try {
    return await db.$transaction(
      async (tx) => {
        // Parameterised (not a tagged template): the same lock and wait the declaration takes.
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${DECLARATION_LOCK_WAIT_MS}ms`}, true)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capture-session:${session.id}`}))`;
        const locked = await loadOwnedDirectCaptureSession(tx as unknown as PrismaClient, session.id, input.ownerUserId);
        if (isLiveSealClaim(locked, now)) throw new DirectCaptureError("SESSION_BUSY");
        const fresh = await requireActive(db, locked, now);
        const txc = tx as unknown as PrismaClient;
        if ((await readLostPartIndexes(txc, fresh)).has(input.partIndex)) {
          return { partIndex: input.partIndex, created: false };
        }
        if (await storedBytesPresent(txc)) throw new DirectCaptureError("PART_BYTES_PRESENT");
        const declaration = (await readPartDeclarations(txc, fresh)).get(input.partIndex);
        if (!declaration) throw new DirectCaptureError("PART_NOT_DECLARED");
        if (declaration.clientReportedSource !== null && declaration.clientReportedSource !== "SCREEN_SEGMENT") {
          throw new DirectCaptureError("PART_NOT_A_SEGMENT");
        }
        // The unsealed record's bytes-less part row is withdrawn (nothing is
        // signed yet; no object is touched).
        await txc.evidencePart.deleteMany({ where: { evidenceId, partIndex: input.partIndex } });
        // F-17 — the loss is stated in THIS transaction: it commits with the
        // part withdrawal above or not at all (it used to commit on its own).
        await emitCaptureTrustEvent({
          tx,
          teamId: fresh.teamId!,
          captureSessionId: fresh.id,
          evidenceId: null,
          deviceId: fresh.deviceId,
          code: "CAPTURE_ARTIFACT_LOST",
          payload: {
            stage: "part_lost",
            partIndex: input.partIndex,
            declaredSha256: declaration.sha256,
            ...(declaration.recordedThrough != null ? { clientReportedRecordedThrough: declaration.recordedThrough } : {}),
            statedBy: "CAPTURE_CLIENT",
          },
        });
        return { partIndex: input.partIndex, created: true };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  } catch (err) {
    if (isLockWaitCancelled(err)) throw new DirectCaptureError("SESSION_BUSY");
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Device attestation for a device-bound session
// -----------------------------------------------------------------------------

/**
 * Submit a platform attestation for THIS session. The client must present the
 * session's own nonce (the server stores only its hash), so a token cannot be
 * replayed into another session; the verifier additionally refuses a nonce a
 * device has used before. The verdict is whatever the canonical verifier
 * decides — today UNVERIFIED, because no cryptographic verifier exists.
 */
export async function submitDirectCaptureAttestation(input: {
  prisma?: PrismaClient;
  sessionId: string;
  ownerUserId: string;
  provider: "APPLE_APP_ATTEST" | "GOOGLE_PLAY_INTEGRITY";
  rawAssertionBase64: string;
  nonceHex: string;
  assertedAtUtc: string;
  now?: Date;
}): Promise<{ verdict: string; failureReason: string | null }> {
  const db = input.prisma ?? defaultPrisma;
  const now = input.now ?? new Date();
  const session = await requireActive(
    db,
    await loadOwnedDirectCaptureSession(db, input.sessionId, input.ownerUserId),
    now,
  );
  if (!session.deviceId) throw new DirectCaptureError("DEVICE_NOT_BOUND");
  if (!session.nonceSha256 || sha256HexOf(input.nonceHex.toLowerCase()) !== session.nonceSha256) {
    await emitCaptureTrustEvent({
      prisma: db,
      teamId: session.teamId!,
      captureSessionId: session.id,
      evidenceId: null,
      deviceId: session.deviceId,
      code: "ATTESTATION_FAILED",
      payload: { stage: "attestation", provider: input.provider, failureReason: "NONCE_MISMATCH" },
    });
    throw new DirectCaptureError("NONCE_MISMATCH");
  }
  const result = await verifyDeviceAttestation({
    prisma: db,
    teamId: session.teamId!,
    deviceId: session.deviceId,
    captureSessionId: session.id,
    provider: input.provider,
    rawAssertionBase64: input.rawAssertionBase64,
    assertedAtUtc: input.assertedAtUtc,
    nonceHex: input.nonceHex.toLowerCase(),
    expiresAtUtc: null,
  });
  await emitCaptureTrustEvent({
    prisma: db,
    teamId: session.teamId!,
    captureSessionId: session.id,
    evidenceId: null,
    deviceId: session.deviceId,
    code:
      result.failureReason === "ASSERTION_REPLAYED"
        ? "ATTESTATION_REPLAY_DETECTED"
        : result.verdict === "FAILED" || result.verdict === "REVOKED"
          ? "ATTESTATION_FAILED"
          : isPositiveAttestationVerdict(result.verdict)
            ? "ATTESTATION_VERIFIED"
            : "ATTESTATION_UNVERIFIED",
    payload: {
      provider: input.provider,
      verdict: result.verdict,
      failureReason: result.failureReason,
      attestationRecordId: result.attestationRecordId,
    },
  });
  return { verdict: result.verdict, failureReason: result.failureReason };
}

// -----------------------------------------------------------------------------
// Complete + bind
// -----------------------------------------------------------------------------

export type CompleteDirectCaptureResult = {
  evidenceId: string;
  status: string;
  fileSha256: string | null;
  bound: boolean;
  alreadyBound: boolean;
  digestsConfirmed: number;
  /**
   * UC-EXT-010 — the case named when the session was opened: linked in the
   * same transaction as the bind, or refused (the capture still seals).
   */
  caseLink?: DirectCaptureCaseLinkOutcome | null;
};

export type DirectCaptureCaseLinkOutcome = {
  caseId: string;
  linked: boolean;
  /** Set when the link was refused at seal (access to the case ended). */
  denial: "CASE_NOT_FOUND" | "CASE_LINK_NOT_PERMITTED" | null;
};

/**
 * THE mode-specific part of a seal, decided UNDER the session lock from the
 * same declaration snapshot the seal hashes against (UC-STR-002).
 */
export type DirectCaptureSealPlan = {
  /** The part that holds the manifest: classed CAPTURE_MANIFEST before the seal. */
  manifestPartIndex: number | null;
  /**
   * UC-STR-006 — the session's end reason, written by the SAME update that
   * binds it (a continuous session's completeness). Default "COMPLETED".
   */
  endReason?: string;
  /** UC-PROV-003 — validated manifest facts, recorded before the bind. */
  manifestFacts?: CaptureManifestFacts | null;
  /**
   * Checks that read storage (object sizes). Run after the claim, OUTSIDE the
   * session lock — network calls never extend a transaction.
   */
  verifyStorage?: () => Promise<void>;
};

export type DirectCaptureSealPlanner = (ctx: {
  db: PrismaClient;
  session: SessionRow;
  declarations: Map<number, PartDeclaration>;
  now: Date;
}) => Promise<DirectCaptureSealPlan>;

/**
 * MODES WHOSE SEAL VALIDATES A CAPTURE MANIFEST (2026-09-29, audit D12).
 *
 * UC-1/UC-2/UC-3/UC-5 sessions are sealed by their own routes, which check the
 * manifest schema, that the manifest's digest is a declared part and that its
 * artifacts map 1:1 to the declared parts. The generic complete route called
 * `completeDirectCapture` with no mode check, so the same session could be
 * sealed there with no manifest validation at all.
 */
export const MANIFEST_SEALED_DIRECT_CAPTURE_MODES: ReadonlySet<string> = new Set([
  "DIRECT_WEB_CAPTURE_EXTENSION",
  "DIRECT_SCREEN_CAPTURE_ANDROID",
  "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
  "DIRECT_SCREEN_CAPTURE_IOS",
]);

/** The GENERIC seal: refused for a manifest-sealed mode. */
export async function completeGenericDirectCapture(input: {
  prisma?: PrismaClient;
  sessionId: string;
  ownerUserId: string;
  now?: Date;
}): Promise<CompleteDirectCaptureResult> {
  const db = input.prisma ?? defaultPrisma;
  const loaded = await loadOwnedDirectCaptureSession(db, input.sessionId, input.ownerUserId);
  if (MANIFEST_SEALED_DIRECT_CAPTURE_MODES.has(String(loaded.acquisitionMode))) {
    throw new DirectCaptureError(
      "MANIFEST_SEAL_ROUTE_REQUIRED",
      `seal this session with POST /v1/capture/direct-sessions/:id/${MANIFEST_SEAL_ROUTE_BY_MODE[String(loaded.acquisitionMode)]}`,
    );
  }
  return completeDirectCapture(input);
}

/** The seal route (last path segment) of each manifest-sealed mode. */
const MANIFEST_SEAL_ROUTE_BY_MODE: Readonly<Record<string, string>> = {
  DIRECT_WEB_CAPTURE_EXTENSION: "web-complete",
  DIRECT_SCREEN_CAPTURE_ANDROID: "screen-complete",
  DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS: "continuous-complete",
  DIRECT_SCREEN_CAPTURE_IOS: "continuous-complete",
};

/** The short transactions of a seal (claim, bind, release) never hash anything. */
const SEAL_STEP_TRANSACTION = { timeout: 30_000, maxWait: 10_000 } as const;

/**
 * THE seal of a direct-capture session — three steps, and no transaction is
 * ever open while bytes are hashed (ET-ACQ-04).
 *
 *   A. CLAIM (short transaction, session lock): read the session and its
 *      declarations, let the mode's planner check its manifest against exactly
 *      that declaration snapshot (UC-STR-002), pass the governance gate, and
 *      claim the session for sealing (CAPTURE_SEAL_CLAIM). While the claim is
 *      live, declarations / reservation / discard / another seal answer
 *      SESSION_BUSY, so no part can be declared after the check.
 *   B. HASH (no transaction): class the manifest part, record the manifest
 *      facts, run the planner's storage checks, and seal through the canonical
 *      `completeEvidence` with the CLAIMED declaration snapshot as the expected
 *      part set — it refuses a record whose stored parts differ from it.
 *   C. BIND (short transaction, session lock): claimed ACTIVE → BOUND with the
 *      FINAL end reason (UC-STR-006) and the requested case link (UC-EXT-010)
 *      in one commit; then exactly one CAPTURE_SESSION_BOUND.
 *
 * A failed hash releases the claim (back to ACTIVE, retryable) unless the
 * failure proves the session's claims false (terminal → INTERRUPTED). A
 * crashed seal leaves a claim whose lease expires; the next seal attempt
 * reclaims it and the capture reaper releases it.
 */
export async function completeDirectCapture(input: {
  prisma?: PrismaClient;
  sessionId: string;
  ownerUserId: string;
  now?: Date;
  plan?: DirectCaptureSealPlanner;
}): Promise<CompleteDirectCaptureResult & { manifestPartIndex: number | null }> {
  const db = input.prisma ?? defaultPrisma;
  const now = input.now ?? new Date();

  // ---- A. claim -------------------------------------------------------------
  const claimed = await db.$transaction(async (txClient) => {
    const tx = txClient as unknown as PrismaClient;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capture-session:${input.sessionId}`}))`;
    const loaded = await loadOwnedDirectCaptureSession(tx, input.sessionId, input.ownerUserId);
    const declarations = await readPartDeclarations(tx, loaded);

    if (loaded.status === prismaPkg.CaptureSessionStatus.BOUND && loaded.finalizedEvidenceId) {
      // Idempotent re-seal. The planner still validates what was sent, so a
      // different manifest is refused rather than answered as sealed.
      const plan = input.plan ? await input.plan({ db, session: loaded, declarations, now }) : null;
      const ev = await tx.evidence.findUnique({
        where: { id: loaded.finalizedEvidenceId },
        select: { status: true, fileSha256: true },
      });
      return {
        kind: "already" as const,
        result: {
          evidenceId: loaded.finalizedEvidenceId,
          status: String(ev?.status ?? "UNKNOWN"),
          fileSha256: ev?.fileSha256 ?? null,
          bound: true,
          alreadyBound: true,
          digestsConfirmed: declarations.size,
          manifestPartIndex: plan?.manifestPartIndex ?? null,
          caseLink: null,
        },
      };
    }
    // Another seal is hashing this session right now.
    if (isLiveSealClaim(loaded, now)) throw new DirectCaptureError("SESSION_BUSY");

    // (A stale claim — a crashed seal — is simply reclaimed below.)
    // F-23 (independent forward audit) — a session whose record is ALREADY
    // SEALED (its seal committed, the bind did not) is completed by binding it,
    // even past its expiry: the record exists, signed; only its session
    // binding and completeness are missing. Expiry is for unsealed sessions.
    const reservedRecord = loaded.finalizedEvidenceId
      ? await tx.evidence.findUnique({ where: { id: loaded.finalizedEvidenceId }, select: { status: true } })
      : null;
    const recordSealed =
      reservedRecord?.status === prismaPkg.EvidenceStatus.SIGNED ||
      reservedRecord?.status === prismaPkg.EvidenceStatus.REPORTED;
    const session =
      recordSealed && loaded.status === prismaPkg.CaptureSessionStatus.ACTIVE
        ? loaded
        : await requireActive(db, loaded, now);
    if (!session.finalizedEvidenceId) throw new DirectCaptureError("SESSION_NOT_RESERVED");
    const plan: DirectCaptureSealPlan = input.plan
      ? await input.plan({ db, session, declarations, now })
      : { manifestPartIndex: null };

    // The ONE finalization governance gate (2026-09-29, audit D3): the same
    // policy the web upload obeys. A refusal leaves the session ACTIVE and the
    // record unsigned — nothing is published that policy forbids.
    const gate = await evaluateFinalizationGovernance({
      evidenceId: session.finalizedEvidenceId,
      actorUserId: input.ownerUserId,
    });
    if (!gate.allowed) throw new DirectCaptureError("FINALIZATION_BLOCKED_BY_POLICY");

    await extendDirectCaptureSessionOnActivity(tx, session, now);
    const claim = await tx.captureSession.updateMany({
      where: { id: session.id, status: prismaPkg.CaptureSessionStatus.ACTIVE },
      // updatedAt (set by this write) is the claim's timestamp.
      data: { endReason: CAPTURE_SEAL_CLAIM.endReason },
    });
    if (claim.count !== 1) throw new DirectCaptureError("SESSION_NOT_ACTIVE");
    return { kind: "claimed" as const, session, declarations, plan, evidenceId: session.finalizedEvidenceId };
  }, SEAL_STEP_TRANSACTION);

  if (claimed.kind === "already") return claimed.result;
  const { session, declarations, plan, evidenceId } = claimed;

  // ---- B. hash (outside any transaction) -------------------------------------
  let result: { status: unknown; fileSha256: string | null };
  try {
    result = await hashAndSealClaimed(db, session, declarations, plan, evidenceId, input.ownerUserId);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && TERMINAL_COMPLETION_CODES.has(code)) {
      // The session's claims did not match the bytes PROOVRA holds. The record
      // was not sealed (completeEvidence refused before signing); the session
      // can never complete it now. (Interrupting also ends the claim.)
      await emitCaptureTrustEvent({
        prisma: db,
        teamId: session.teamId!,
        captureSessionId: session.id,
        evidenceId,
        deviceId: session.deviceId,
        code: "CAPTURE_ARTIFACT_VERIFICATION_FAILED",
        payload: { stage: "completion", denial: code },
      });
      await interruptSession(db, session, code, now);
      throw new DirectCaptureError(code as DirectCaptureDenial);
    }
    /*
     * A FAILURE AFTER THE RECORD WAS SIGNED DOES NOT UNSEAL IT
     * (2026-09-29, audit D11): bind the session to the signed record.
     * Any other failure RELEASES the claim, so the client can retry.
     */
    const signed = await db.evidence.findUnique({
      where: { id: evidenceId },
      select: { status: true, fileSha256: true },
    });
    if (
      signed?.status !== prismaPkg.EvidenceStatus.SIGNED &&
      signed?.status !== prismaPkg.EvidenceStatus.REPORTED
    ) {
      await releaseSealClaim(db, session.id);
      throw err;
    }
    result = { status: signed.status, fileSha256: signed.fileSha256 ?? null };
  }

  // ---- C. bind -------------------------------------------------------------
  const bound = await db.$transaction(async (txClient) => {
    const tx = txClient as unknown as PrismaClient;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capture-session:${session.id}`}))`;
    // Exactly one bind: only the holder of THIS claim moves it to BOUND.
    // UC-STR-006 — the end reason is part of THIS update.
    const claim = await tx.captureSession.updateMany({
      where: {
        id: session.id,
        status: prismaPkg.CaptureSessionStatus.ACTIVE,
        endReason: CAPTURE_SEAL_CLAIM.endReason,
        finalizedEvidenceId: evidenceId,
      },
      data: {
        status: prismaPkg.CaptureSessionStatus.BOUND,
        finalizedAtUtc: now,
        endedAtUtc: now,
        endReason: plan.endReason ?? "COMPLETED",
      },
    });
    if (claim.count !== 1) {
      // ET-DC-01: only a session that IS bound to this record may be answered as
      // bound (a reclaimed stale claim may have bound it meanwhile).
      const current = await tx.captureSession.findUnique({
        where: { id: session.id },
        select: { status: true, finalizedEvidenceId: true },
      });
      if (
        current?.status !== prismaPkg.CaptureSessionStatus.BOUND ||
        current.finalizedEvidenceId !== evidenceId
      ) {
        throw new DirectCaptureError("SESSION_NOT_ACTIVE");
      }
      return { claimed: false, caseLink: null };
    }
    // UC-EXT-010 — the case link commits with the bind, or not at all.
    const caseLink = await linkSessionCaseAtSeal(tx, session, evidenceId, input.ownerUserId);
    return { claimed: true, caseLink };
  }, SEAL_STEP_TRANSACTION);

  if (bound.claimed) {
    const head = await db.captureTrustEventRecord.findFirst({
      where: { teamId: session.teamId!, captureSessionId: session.id },
      orderBy: { sequence: "desc" },
      select: { eventHash: true, sequence: true },
    });
    await emitCaptureTrustEvent({
      prisma: db,
      teamId: session.teamId!,
      captureSessionId: session.id,
      evidenceId,
      deviceId: session.deviceId,
      code: "CAPTURE_SESSION_BOUND",
      payload: {
        acquisitionMode: session.acquisitionMode,
        trustChainHeadHash: head?.eventHash ?? null,
        trustEventCount: head?.sequence ?? 0,
        digestsConfirmed: declarations.size,
        fileSha256: result.fileSha256 ?? null,
        ...(bound.caseLink ? { caseId: bound.caseLink.caseId, caseLinked: bound.caseLink.linked } : {}),
      },
    });
  }

  return {
    evidenceId,
    status: String(result.status),
    fileSha256: result.fileSha256 ?? null,
    bound: true,
    alreadyBound: !bound.claimed,
    digestsConfirmed: declarations.size,
    manifestPartIndex: plan.manifestPartIndex,
    caseLink: bound.caseLink,
  };
}

/** Step B: everything that touches bytes, with the claimed snapshot as the expected part set. */
async function hashAndSealClaimed(
  db: PrismaClient,
  session: SessionRow,
  declarations: Map<number, PartDeclaration>,
  plan: DirectCaptureSealPlan,
  evidenceId: string,
  ownerUserId: string,
): Promise<{ status: unknown; fileSha256: string | null }> {
  // ET-DC-11 / UC-AND-008 — class the manifest part BEFORE the seal, for every
  // manifest-sealed mode: relabelling a part of a sealed record changed it
  // after its fingerprint was signed.
  if (plan.manifestPartIndex !== null) {
    await db.evidencePart.updateMany({
      where: { evidenceId, partIndex: plan.manifestPartIndex },
      data: { artifactClass: "CAPTURE_MANIFEST" },
    });
  }
  // UC-PROV-003 — the validated manifest facts join the session's trust chain
  // BEFORE the bind, so the bind's chain head covers them.
  if (plan.manifestFacts) await recordManifestFacts(db, session, plan.manifestFacts);
  // Storage checks the planner needs (object sizes) — network, so not under the lock.
  if (plan.verifyStorage) await plan.verifyStorage();
  return completeEvidence({
    evidenceId,
    ownerUserId,
    captureSession: {
      sessionId: session.id,
      // THE planned part set: the declarations the claim was checked against.
      // completeEvidence refuses a record whose stored parts are not exactly these.
      expectedSha256ByPartIndex: new Map([...declarations.values()].map((d) => [d.partIndex, d.sha256])),
    },
  });
}

/** Give a claimed session back (a failed, retryable hash). Only THE claim is released. */
async function releaseSealClaim(db: PrismaClient, sessionId: string): Promise<void> {
  await db.captureSession.updateMany({
    where: { id: sessionId, status: prismaPkg.CaptureSessionStatus.ACTIVE, endReason: CAPTURE_SEAL_CLAIM.endReason },
    data: { endReason: null },
  });
}

/**
 * UC-PROV-003 — record validated manifest facts on the session's trust chain,
 * once per manifest digest. evidenceId stays null: the private source URL must
 * never be mirrored into the custody chain (custody payloads travel into the
 * report and package summaries).
 */
async function recordManifestFacts(
  db: PrismaClient,
  session: SessionRow,
  facts: CaptureManifestFacts,
): Promise<void> {
  const prior = await db.captureTrustEventRecord.findMany({
    where: { teamId: session.teamId!, captureSessionId: session.id, code: "CAPTURE_ARTIFACT_RECEIVED" },
    select: { payload: true },
    take: MAX_PARTS * 2,
  });
  for (const r of prior) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    if (p["stage"] !== CAPTURE_MANIFEST_FACTS_STAGE) continue;
    if (readCaptureManifestFacts(p)?.manifestSha256 === facts.manifestSha256) return;
  }
  await emitCaptureTrustEvent({
    prisma: db,
    teamId: session.teamId!,
    captureSessionId: session.id,
    evidenceId: null,
    deviceId: session.deviceId,
    code: "CAPTURE_ARTIFACT_RECEIVED",
    payload: { stage: CAPTURE_MANIFEST_FACTS_STAGE, facts: facts as unknown as Record<string, unknown> },
  });
}

/** UC-EXT-010 — the case named at open, read from the session's own STARTED event. */
async function readSessionCaseId(db: PrismaClient, session: Pick<SessionRow, "id" | "teamId">): Promise<string | null> {
  const started = await db.captureTrustEventRecord.findFirst({
    where: { teamId: session.teamId!, captureSessionId: session.id, code: "CAPTURE_SESSION_STARTED" },
    orderBy: { sequence: "asc" },
    select: { payload: true },
  });
  const caseId = (started?.payload as Record<string, unknown> | null)?.["caseId"];
  return typeof caseId === "string" && caseId.length > 0 ? caseId : null;
}

/**
 * The canonical case-link authority, re-asked at seal (access can end between
 * open and seal), then THE link writer, both on the bind's transaction.
 * `attachEvidenceToCase` opens its own nested transaction for the link row +
 * tenant audit; inside an interactive transaction that is the enclosing one.
 */
async function linkSessionCaseAtSeal(
  tx: PrismaClient,
  session: SessionRow,
  evidenceId: string,
  ownerUserId: string,
): Promise<DirectCaptureCaseLinkOutcome | null> {
  const caseId = await readSessionCaseId(tx, session);
  if (!caseId) return null;
  const auth = await authorizeCaseEvidenceLink({ userId: ownerUserId, caseId, evidenceId }, tx);
  if (!auth.allowed) {
    return { caseId, linked: false, denial: auth.status === 404 ? "CASE_NOT_FOUND" : "CASE_LINK_NOT_PERMITTED" };
  }
  try {
    await attachEvidenceToCase(
      {
        caseId,
        evidenceId,
        actorUserId: ownerUserId,
        source: "USER",
        reason: "Filed to this case when the capture session was opened.",
      },
      withinTransaction(tx),
    );
  } catch (err) {
    // A refusal decided BEFORE any write (the authority's own tenancy checks)
    // leaves the bind intact and is reported; anything else aborts the seal.
    if (err instanceof CaseEvidenceAuthorityError) {
      return { caseId, linked: false, denial: "CASE_NOT_FOUND" };
    }
    throw err;
  }
  return { caseId, linked: true, denial: null };
}

/** An interactive-transaction client whose nested `$transaction(fn)` runs `fn` in it. */
function withinTransaction(tx: PrismaClient): PrismaClient {
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === "$transaction") {
        return (fn: (client: PrismaClient) => Promise<unknown>) => fn(tx);
      }
      return Reflect.get(target, prop);
    },
  }) as PrismaClient;
}

// -----------------------------------------------------------------------------
// Discard the session (UC-0 abort)
// -----------------------------------------------------------------------------

export type DiscardDirectCaptureSessionInput = {
  prisma?: PrismaClient;
  sessionId: string;
  ownerUserId: string;
  now?: Date;
};

export type DiscardDirectCaptureSessionResult = {
  sessionId: string;
  status: prismaPkg.CaptureSessionStatus;
  /** The reservation that was released, when the session had made one. */
  releasedEvidenceId: string | null;
  /** True when this call performed the discard (false = already terminal). */
  discarded: boolean;
};

/**
 * ABORT AN UNSEALED DIRECT-CAPTURE SESSION.
 *
 * Why this exists: `reserveDirectCaptureEvidence` calls the canonical
 * `createEvidence()` on the FIRST staged item, which writes a durable, owned,
 * listed Evidence row plus an EVIDENCE_CREATED custody event — before a single
 * byte has been uploaded. The mobile client's "Discard Session" made no server
 * call at all and there was no abort route, so every abandoned capture left a
 * permanent, custody-logged, empty record in the user's Active library. The web
 * upload model has had `POST /v1/uploads/sessions/:id/abort` all along; UC-0 was
 * built without carrying that concept across.
 *
 * Semantics, mirroring `abortUploadSession`:
 *   - idempotent: a session that is already terminal returns its state, 200;
 *   - a BOUND (sealed) session is REFUSED. Its Evidence is committed and real;
 *     removing it is the Evidence lifecycle's job (archive / trash), under its
 *     own authorization and legal-hold rules. Discard may never be a back door
 *     around that;
 *   - otherwise the session goes terminal (DISCARDED) and the reservation is
 *     released: the never-committed Evidence is soft-deleted and the release is
 *     recorded as EVIDENCE_DELETED on the custody chain.
 *
 * The custody chain is append-only, so the record is NOT hard-deleted — that
 * would orphan the EVIDENCE_CREATED event this reservation already wrote. It is
 * moved to a terminal, non-listed state with an auditable reason, which is what
 * "cleaned according to canonical lifecycle semantics" means here. It is not
 * cosmetic hiding: the row is genuinely terminal, and the list query
 * independently refuses to show never-committed records (see
 * `buildEvidenceListBaseWhere`).
 */
export async function discardDirectCaptureSession(
  input: DiscardDirectCaptureSessionInput,
): Promise<DiscardDirectCaptureSessionResult> {
  const db = input.prisma ?? defaultPrisma;
  const now = input.now ?? new Date();

  const session = await loadOwnedDirectCaptureSession(db, input.sessionId, input.ownerUserId);

  // A sealed session's Evidence is committed product. Refuse rather than
  // silently deleting a real record through the capture path.
  if (session.status === prismaPkg.CaptureSessionStatus.BOUND) {
    throw new DirectCaptureError("SESSION_NOT_ACTIVE");
  }
  if (
    session.status === prismaPkg.CaptureSessionStatus.DISCARDED ||
    session.status === prismaPkg.CaptureSessionStatus.EXPIRED
  ) {
    return {
      sessionId: session.id,
      status: session.status,
      releasedEvidenceId: null,
      discarded: false,
    };
  }

  const released = await db.$transaction(async (tx) => {
    // Serialise against a concurrent reserve/complete for the SAME session, the
    // same lock reserve takes — so a discard can never race a binding.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capture-session:${session.id}`}))`;

    const fresh = await tx.captureSession.findUnique({
      where: { id: session.id },
      select: { id: true, status: true, finalizedEvidenceId: true, endReason: true, updatedAt: true },
    });
    if (!fresh) throw new DirectCaptureError("SESSION_NOT_FOUND");
    // A seal is hashing this session: retry once it has bound or released.
    if (isLiveSealClaim(fresh, now)) throw new DirectCaptureError("SESSION_BUSY");
    // ET-DC-01: and against FINALIZATION of the reserved record, which holds
    // the evidence lock (evidence-complete.service) for its whole transaction.
    // Without it a discard sent while finalization was hashing released the
    // reservation underneath it: the record was signed after being deleted, or
    // the two transactions deadlocked. Taken BEFORE anything is read or
    // written, so the status checks below see finalization's committed result.
    // Lock order: capture session, then evidence — finalization never takes
    // the session lock.
    if (fresh.finalizedEvidenceId) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${fresh.finalizedEvidenceId}))`;
    }
    if (fresh.status === prismaPkg.CaptureSessionStatus.BOUND) {
      throw new DirectCaptureError("SESSION_NOT_ACTIVE");
    }
    // A session whose record is already signed is not discarded — it is
    // completed again, which binds it (2026-09-29, audit D11).
    if (fresh.finalizedEvidenceId) {
      const reserved = await tx.evidence.findUnique({
        where: { id: fresh.finalizedEvidenceId },
        select: { status: true },
      });
      if (
        reserved?.status === prismaPkg.EvidenceStatus.SIGNED ||
        reserved?.status === prismaPkg.EvidenceStatus.REPORTED
      ) {
        throw new DirectCaptureError("EVIDENCE_ALREADY_FINALIZED");
      }
    }

    const claim = await tx.captureSession.updateMany({
      where: {
        id: session.id,
        status: {
          in: [
            prismaPkg.CaptureSessionStatus.ACTIVE,
            prismaPkg.CaptureSessionStatus.INTERRUPTED,
          ],
        },
      },
      data: {
        status: prismaPkg.CaptureSessionStatus.DISCARDED,
        discardedAtUtc: now,
        endedAtUtc: now,
        endReason: "DISCARDED",
      },
    });
    if (claim.count !== 1) return null;

    if (!fresh.finalizedEvidenceId) return null;

    // Release the reservation through THE reservation authority (shared with
    // the Worker's reservation sweep): only while it is still unsealed, under
    // the evidence lock, recorded as EVIDENCE_DELETED on the custody chain.
    const released = await releaseEvidenceReservationTx(tx, {
      evidenceId: fresh.finalizedEvidenceId,
      reason: "CAPTURE_SESSION_DISCARDED",
      now,
      captureSessionId: session.id,
    });
    return released ? fresh.finalizedEvidenceId : null;
  });

  // Outside the transaction: the trust chain has its own sequencing and must
  // not extend the reservation lock.
  await emitCaptureTrustEvent({
    prisma: db,
    teamId: session.teamId!,
    captureSessionId: session.id,
    evidenceId: null,
    deviceId: session.deviceId,
    code: "CAPTURE_SESSION_ENDED",
    payload: { endReason: "DISCARDED", releasedEvidence: released !== null },
  }).catch(() => undefined);

  return {
    sessionId: session.id,
    status: prismaPkg.CaptureSessionStatus.DISCARDED,
    releasedEvidenceId: released,
    discarded: true,
  };
}
