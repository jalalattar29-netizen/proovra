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
  canonicalJson,
  isPositiveAttestationVerdict,
  isEvidenceAcquisitionMode,
  type CaptureSignaturePayload,
  type EvidenceAcquisitionMode,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { createEvidence } from "../evidence.service.js";
import { completeEvidence } from "../evidence-complete.service.js";
import { emitCaptureTrustEvent } from "./trust-event.service.js";
import { releaseEvidenceReservationTx } from "@proovra/shared-runtime";
import { verifyCaptureSignature } from "./signature-verifier.service.js";
import { verifyDeviceAttestation } from "./attestation-verifier.service.js";
import { MAX_EVIDENCE_PARTS } from "../evidence/evidence-part-writer.service.js";

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
] as const;
export type DirectCaptureClientSource = (typeof DIRECT_CAPTURE_CLIENT_SOURCES)[number];

export const DIRECT_CAPTURE_DENIALS = {
  SESSION_NOT_FOUND: 404,
  SESSION_NOT_ACTIVE: 409,
  SESSION_EXPIRED: 409,
  SESSION_ALREADY_RESERVED: 409,
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
  // A manifest-sealed mode completed through the generic route (2026-09-29).
  MANIFEST_SEAL_ROUTE_REQUIRED: 409,
  // Workspace policy refuses finalization (2026-09-29, audit D3).
  FINALIZATION_BLOCKED_BY_POLICY: 409,
  // A discard of a session whose record is already signed (2026-09-29, D11).
  EVIDENCE_ALREADY_FINALIZED: 409,
} as const;
export type DirectCaptureDenial = keyof typeof DIRECT_CAPTURE_DENIALS;

export class DirectCaptureError extends Error {
  readonly statusCode: number;
  readonly code: DirectCaptureDenial;
  constructor(code: DirectCaptureDenial) {
    super(code);
    this.code = code;
    this.statusCode = DIRECT_CAPTURE_DENIALS[code];
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

type SessionRow = {
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
  ttlSeconds?: number;
  now?: Date;
};

export type OpenDirectCaptureSessionResult = {
  captureSessionId: string;
  /** Returned ONCE. Only its SHA-256 is stored. */
  nonceHex: string;
  acquisitionMode: DirectCaptureSessionMode;
  deviceBound: boolean;
  startedAtUtc: string;
  expiresAtUtc: string;
};

export async function openDirectCaptureSession(
  input: OpenDirectCaptureSessionInput,
): Promise<OpenDirectCaptureSessionResult> {
  const db = input.prisma ?? defaultPrisma;
  if (!(DIRECT_CAPTURE_SESSION_MODES as ReadonlyArray<string>).includes(input.mode)) {
    throw new DirectCaptureError("UNSUPPORTED_MODE");
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
  const ttl = Math.min(
    Math.max(Math.trunc(input.ttlSeconds ?? DEFAULT_TTL_SECONDS), 60),
    MAX_TTL_SECONDS,
  );
  const expiresAtUtc = new Date(now.getTime() + ttl * 1000);
  const nonceHex = randomBytes(32).toString("hex");

  const session = await db.captureSession.create({
    data: {
      ownerUserId: input.ownerUserId,
      teamId: input.teamId,
      status: prismaPkg.CaptureSessionStatus.ACTIVE,
      acquisitionMode: input.mode,
      nonceSha256: sha256HexOf(nonceHex),
      deviceId: input.deviceId,
      startedAtUtc: now,
      expiresAtUtc,
    },
    select: { id: true },
  });

  await emitCaptureTrustEvent({
    prisma: db,
    teamId: input.teamId,
    captureSessionId: session.id,
    evidenceId: null,
    deviceId: input.deviceId,
    code: "CAPTURE_SESSION_STARTED",
    payload: {
      acquisitionMode: input.mode,
      deviceBound: input.deviceId !== null,
      expiresAtUtc: expiresAtUtc.toISOString(),
    },
  });

  return {
    captureSessionId: session.id,
    nonceHex,
    acquisitionMode: input.mode,
    deviceBound: input.deviceId !== null,
    startedAtUtc: now.toISOString(),
    expiresAtUtc: expiresAtUtc.toISOString(),
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
    await interruptSession(db, session, "EXPIRED", now);
    throw new DirectCaptureError("SESSION_EXPIRED");
  }
  return session;
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
  gps?: { lat: number; lng: number; accuracyMeters?: number };
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
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capture-session:${input.sessionId}`}))`;
      const session = await loadOwnedDirectCaptureSession(
        tx as unknown as PrismaClient,
        input.sessionId,
        input.ownerUserId,
      );
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
        acquisitionMode: session.acquisitionMode,
        captureSessionId: session.id,
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
      };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
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
  signed: { payload: CaptureSignaturePayload; signatureHex: string } | null;
  now?: Date;
};

export type PartDeclaration = {
  partIndex: number;
  sha256: string;
  signatureVerdict: string;
};

export async function declareDirectCapturePart(
  input: DeclareDirectCapturePartInput,
): Promise<{ declaration: PartDeclaration; created: boolean }> {
  const db = input.prisma ?? defaultPrisma;
  const now = input.now ?? new Date();
  const sha256 = input.sha256.toLowerCase();
  if (!Number.isInteger(input.partIndex) || input.partIndex < 0 || input.partIndex >= MAX_PARTS) {
    throw new DirectCaptureError("INVALID_PART_INDEX");
  }
  if (!SHA256_HEX.test(sha256)) throw new DirectCaptureError("INVALID_DIGEST");

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

  const existing = (await readPartDeclarations(db, session)).get(input.partIndex);
  if (existing) {
    if (existing.sha256 !== sha256) throw new DirectCaptureError("PART_ALREADY_DECLARED");
    return { declaration: existing, created: false };
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

  await extendDirectCaptureSessionOnActivity(db, session, now);

  return {
    declaration: { partIndex: input.partIndex, sha256, signatureVerdict },
    created: true,
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
      code: { in: ["CAPTURE_ARTIFACT_SIGNED_AT_SOURCE", "CAPTURE_ARTIFACT_RECEIVED"] },
    },
    orderBy: { sequence: "asc" },
    select: { payload: true },
    take: MAX_PARTS * 2,
  });
  const out = new Map<number, PartDeclaration>();
  for (const r of rows) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    if (p["stage"] !== "part_declared") continue;
    const idx = p["partIndex"];
    const digest = p["declaredSha256"];
    if (typeof idx !== "number" || typeof digest !== "string") continue;
    if (!out.has(idx)) {
      out.set(idx, {
        partIndex: idx,
        sha256: digest,
        signatureVerdict: typeof p["signatureVerdict"] === "string" ? p["signatureVerdict"] : "MISSING",
      });
    }
  }
  return out;
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
};

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
    throw new DirectCaptureError("MANIFEST_SEAL_ROUTE_REQUIRED");
  }
  return completeDirectCapture(input);
}

export async function completeDirectCapture(input: {
  prisma?: PrismaClient;
  sessionId: string;
  ownerUserId: string;
  now?: Date;
}): Promise<CompleteDirectCaptureResult> {
  const db = input.prisma ?? defaultPrisma;
  const now = input.now ?? new Date();
  const loaded = await loadOwnedDirectCaptureSession(db, input.sessionId, input.ownerUserId);

  if (loaded.status === prismaPkg.CaptureSessionStatus.BOUND && loaded.finalizedEvidenceId) {
    const ev = await db.evidence.findUnique({
      where: { id: loaded.finalizedEvidenceId },
      select: { status: true, fileSha256: true },
    });
    const declared = await readPartDeclarations(db, loaded);
    return {
      evidenceId: loaded.finalizedEvidenceId,
      status: String(ev?.status ?? "UNKNOWN"),
      fileSha256: ev?.fileSha256 ?? null,
      bound: true,
      alreadyBound: true,
      digestsConfirmed: declared.size,
    };
  }

  const session = await requireActive(db, loaded, now);
  if (!session.finalizedEvidenceId) throw new DirectCaptureError("SESSION_NOT_RESERVED");
  const evidenceId = session.finalizedEvidenceId;
  const declarations = await readPartDeclarations(db, session);

  // The ONE finalization governance gate (2026-09-29, audit D3): the same
  // policy the web upload obeys. A refusal leaves the session ACTIVE and the
  // record unsigned — nothing is published that policy forbids.
  const gate = await evaluateFinalizationGovernance({ evidenceId, actorUserId: input.ownerUserId });
  if (!gate.allowed) throw new DirectCaptureError("FINALIZATION_BLOCKED_BY_POLICY");

  let result: { status: unknown; fileSha256: string | null } | undefined;
  try {
    result = await completeEvidence({
      evidenceId,
      ownerUserId: input.ownerUserId,
      captureSession: {
        sessionId: session.id,
        expectedSha256ByPartIndex: new Map(
          [...declarations.values()].map((d) => [d.partIndex, d.sha256]),
        ),
      },
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && TERMINAL_COMPLETION_CODES.has(code)) {
      // The session's claims did not match the bytes PROOVRA holds. The record
      // was not sealed (completeEvidence refused before signing); the session
      // can never complete it now.
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
     * (2026-09-29, audit D11). completeEvidence commits the signature and
     * only then applies retention; a throw there left the record SIGNED and
     * the session unbound — and the mobile client then discarded the session.
     * If the record is finalized, bind the session to it (the reconcilers
     * carry the post-commit OTS/report work) and surface nothing to discard.
     */
    const sealed = await db.evidence.findUnique({
      where: { id: evidenceId },
      select: { status: true, fileSha256: true },
    });
    if (
      sealed?.status !== prismaPkg.EvidenceStatus.SIGNED &&
      sealed?.status !== prismaPkg.EvidenceStatus.REPORTED
    ) {
      throw err;
    }
    result = { status: sealed.status, fileSha256: sealed.fileSha256 ?? null };
  }
  if (!result) throw new DirectCaptureError("SESSION_NOT_ACTIVE");

  // Exactly one bind: only the caller that moves ACTIVE -> BOUND emits it.
  const claim = await db.captureSession.updateMany({
    where: {
      id: session.id,
      status: prismaPkg.CaptureSessionStatus.ACTIVE,
      finalizedEvidenceId: evidenceId,
    },
    data: {
      status: prismaPkg.CaptureSessionStatus.BOUND,
      finalizedAtUtc: now,
      endedAtUtc: now,
      endReason: "COMPLETED",
    },
  });
  if (claim.count !== 1) {
    // ET-DC-01: only a session that IS bound to this record may be answered as
    // bound. A session a discard ended is not — never report bound:true for it.
    const current = await db.captureSession.findUnique({
      where: { id: session.id },
      select: { status: true, finalizedEvidenceId: true },
    });
    if (
      current?.status !== prismaPkg.CaptureSessionStatus.BOUND ||
      current.finalizedEvidenceId !== evidenceId
    ) {
      throw new DirectCaptureError("SESSION_NOT_ACTIVE");
    }
  }
  if (claim.count === 1) {
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
        fileSha256: result.fileSha256,
      },
    });
  }

  return {
    evidenceId,
    status: String(result.status),
    fileSha256: result.fileSha256 ?? null,
    bound: true,
    alreadyBound: claim.count !== 1,
    digestsConfirmed: declarations.size,
  };
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
      select: { id: true, status: true, finalizedEvidenceId: true },
    });
    if (!fresh) throw new DirectCaptureError("SESSION_NOT_FOUND");
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
