/**
 * Capture Trust routes.
 *
 *   POST   /v1/capture/devices                       — register a device
 *   GET    /v1/capture/devices                       — list workspace devices
 *   GET    /v1/capture/devices/:id                   — read single device
 *   POST   /v1/capture/devices/:id/revoke            — revoke a device
 *
 *   POST   /v1/capture/direct-sessions                              — open a server-issued session (nonce)
 *   POST   /v1/capture/direct-sessions/:id/evidence                 — reserve the session's Evidence
 *   POST   /v1/capture/direct-sessions/:id/parts/:partIndex/declaration — declare a part digest (signed when device-bound)
 *   POST   /v1/capture/direct-sessions/:id/attestation              — platform attestation (fails closed)
 *   POST   /v1/capture/direct-sessions/:id/complete                 — server digest check, seal, bind
 *
 *   POST   /v1/capture/mobile/ingest                 — RETIRED (410). See below.
 *
 *   GET    /v1/capture/sessions/:id/trust-timeline   — trust event timeline for a session
 *
 *   GET    /v1/provenance/:evidenceId                — bounded ProvenanceChain projection
 *
 * Hard rules:
 *   * Device registry and read routes require a workspace context (teamId);
 *     personal-space callers receive a bounded 403.
 *   * Direct-capture sessions are authorized with the canonical primitive
 *     (`authorizeOrFail`, evidence.create, anti-enumeration) at open, reserve,
 *     declaration and completion, plus the personal-space guard. A session is
 *     only ever visible to its owner; a foreign or unknown id is a 404.
 *   * Bytes never travel in these JSON bodies: parts are uploaded through the
 *     canonical presign (POST /v1/evidence/:id/parts) to storage.
 *   * NEVER returns raw assertion bytes, device public keys, nonce hashes or
 *     storage keys.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  CAPTURE_MODES,
  CAPTURE_PROVENANCE_CLASSES,
  CAPTURE_SIGNATURE_ALGORITHMS,
  DEVICE_ATTESTATION_PROVIDERS,
  type CaptureSignaturePayload,
} from "@proovra/shared";
import * as prismaPkg from "@prisma/client";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail, evaluateCurrentWorkspace } from "../middleware/authorize.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { assertPersonalUploadMutationAllowed } from "./upload-sessions.routes.js";

import {
  listDevicesForTeam,
  getDevice as getDeviceById,
  registerDevice,
  revokeDevice,
} from "../services/capture-trust/device-identity.service.js";
import { completeWebCaptureSession } from "../services/capture-trust/web-capture.service.js";
import { completeScreenCaptureSession } from "../services/capture-trust/screen-capture.service.js";
import {
  DIRECT_CAPTURE_CLIENT_SOURCES,
  DIRECT_CAPTURE_SESSION_MODES,
  DirectCaptureError,
  completeDirectCapture,
  declareDirectCapturePart,
  loadOwnedDirectCaptureSession,
  openDirectCaptureSession,
  reserveDirectCaptureEvidence,
  submitDirectCaptureAttestation,
} from "../services/capture-trust/direct-capture-ingest.service.js";
import { projectProvenanceChain } from "../services/capture-trust/provenance-projection.service.js";
import { readCaptureTrustTimeline } from "../services/capture-trust/trust-event.service.js";
import { ensurePersonalWorkspace } from "../services/platform-context/workspace-bootstrap.service.js";
import { enforceRateLimit } from "../services/rate-limit.js";

// =============================================================================
// Zod input schemas
// =============================================================================

const RegisterDeviceBody = z.object({
  label: z.string().min(1).max(120),
  deviceModel: z.string().min(1).max(120),
  osVersion: z.string().min(1).max(80),
  appVersion: z.string().min(1).max(80),
  signatureAlgorithm: z.enum(CAPTURE_SIGNATURE_ALGORITHMS),
  publicKeyHex: z.string().regex(/^[0-9a-fA-F]+$/).min(64).max(160),
  attestationProvider: z.enum(DEVICE_ATTESTATION_PROVIDERS),
  attestationKeyId: z.string().min(1).max(160).nullable().optional(),
});

const RevokeDeviceBody = z.object({
  reason: z.enum([
    "OPERATOR_REQUESTED",
    "LOST",
    "STOLEN",
    "COMPROMISED",
    "DECOMMISSIONED",
    "ATTESTATION_FAILED",
    "POLICY",
  ]),
});

const CaptureSignaturePayloadSchema = z.object({
  schemaVersion: z.literal("PROOVRA_CAPTURE_SIG_V1"),
  assetHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  captureMode: z.enum(CAPTURE_MODES),
  provenanceClass: z.enum(CAPTURE_PROVENANCE_CLASSES),
  deviceKeyId: z.string().uuid(),
  algorithm: z.enum(CAPTURE_SIGNATURE_ALGORITHMS),
  captureSessionId: z.string().uuid(),
  signedAtUtc: z.string().datetime(),
  signedAtMonotonicNs: z.string().min(1).max(40),
  nonceHex: z.string().regex(/^[0-9a-fA-F]{64}$/),
  metadata: z.object({
    deviceModel: z.string().min(1).max(120),
    osVersion: z.string().min(1).max(80),
    appVersion: z.string().min(1).max(80),
    networkState: z.enum(["ONLINE", "OFFLINE", "UNKNOWN"]),
    locationPolicy: z.enum(["OFF", "COARSE", "PRECISE"]),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        accuracyMeters: z.number().nonnegative(),
        method: z.enum(["GPS", "NETWORK", "MANUAL"]),
      })
      .nullable(),
    camera: z
      .object({
        facing: z.enum(["FRONT", "BACK", "EXTERNAL", "UNKNOWN"]),
        flashOn: z.boolean(),
        focalLengthMm: z.number().nullable(),
        iso: z.number().nullable(),
      })
      .nullable(),
    sensor: z
      .object({
        batteryPct: z.number().nullable(),
        orientationDegrees: z.number().nullable(),
        gravityVector: z.array(z.number()).max(3).nullable(),
      })
      .nullable(),
    operatorContext: z
      .object({
        caseId: z.string().nullable(),
        tag: z.string().nullable(),
      })
      .nullable(),
  }),
});

const OpenDirectSessionBody = z
  .object({
    mode: z.enum(DIRECT_CAPTURE_SESSION_MODES),
    // Omitted = the caller's personal workspace (resolved server-side).
    teamId: z.string().uuid().optional(),
    deviceId: z.string().uuid().nullable().optional(),
  })
  .strict();

const ReserveDirectEvidenceBody = z
  .object({
    type: z.nativeEnum(prismaPkg.EvidenceType),
    mimeType: z.string().min(1).max(128).optional(),
    originalFileName: z.string().trim().min(1).max(255).optional(),
    deviceTimeIso: z.string().min(1).max(64).optional(),
    gps: z
      .object({
        lat: z.number().finite().min(-90).max(90),
        lng: z.number().finite().min(-180).max(180),
        accuracyMeters: z.number().finite().min(0).max(1_000_000).optional(),
      })
      .optional(),
  })
  .strict();

const DeclarePartBody = z
  .object({
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
    clientReportedSource: z.enum(DIRECT_CAPTURE_CLIENT_SOURCES),
    signed: z
      .object({
        payload: CaptureSignaturePayloadSchema,
        signatureHex: z.string().regex(/^[0-9a-fA-F]+$/).min(64).max(512),
      })
      .nullable()
      .optional(),
  })
  .strict();

const AttestationBody = z
  .object({
    provider: z.enum(["APPLE_APP_ATTEST", "GOOGLE_PLAY_INTEGRITY"]),
    rawAssertionBase64: z.string().min(1).max(64 * 1024),
    nonceHex: z.string().regex(/^[0-9a-fA-F]{64}$/),
    assertedAtUtc: z.string().datetime(),
  })
  .strict();

const SessionParams = z.object({ id: z.string().uuid() });
const WebCompleteBody = z
  .object({
    // The EXACT manifest bytes the extension uploaded, as a string. Bounded to
    // the manifest size ceiling; the shared validator enforces the schema.
    manifestJson: z.string().min(2).max(256 * 1024),
  })
  .strict();
const ScreenCompleteBody = z
  .object({
    // The EXACT screen-capture manifest bytes the Android app uploaded, as a
    // string. Bounded to the screen manifest size ceiling; the shared validator
    // enforces the schema.
    manifestJson: z.string().min(2).max(128 * 1024),
  })
  .strict();
const PartParams = z.object({
  id: z.string().uuid(),
  partIndex: z.coerce.number().int().min(0).max(199),
});

const DIRECT_SESSION_OPEN_LIMIT_PER_MIN = 30;

// =============================================================================
// Route handlers
// =============================================================================

export async function captureTrustRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /v1/capture/devices — register a workspace-bound device
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/capture/devices",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      const teamId = await resolveTeamIdOrDeny(req, reply);
      if (!teamId) return reply;
      const body = RegisterDeviceBody.parse(req.body);
      const result = await registerDevice({
        teamId,
        ownerUserId: userId,
        label: body.label,
        deviceModel: body.deviceModel,
        osVersion: body.osVersion,
        appVersion: body.appVersion,
        signatureAlgorithm: body.signatureAlgorithm,
        publicKeyHex: body.publicKeyHex,
        attestationProvider: body.attestationProvider,
        attestationKeyId: body.attestationKeyId ?? null,
      });
      if (!result.ok) {
        return reply.code(409).send({ denial: result.denial });
      }
      return reply.code(201).send({
        deviceId: result.deviceId,
        publicKeyFingerprint: result.publicKeyFingerprint,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/capture/devices — list workspace devices
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/capture/devices",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const teamId = await resolveTeamIdOrDeny(req, reply);
      if (!teamId) return reply;
      const includeRevoked = z
        .object({ includeRevoked: z.enum(["true", "false"]).optional() })
        .parse(req.query ?? {});
      const devices = await listDevicesForTeam(teamId, {
        includeRevoked: includeRevoked.includeRevoked === "true",
      });
      return reply.code(200).send({ devices });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/capture/devices/:id — single device
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/capture/devices/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const teamId = await resolveTeamIdOrDeny(req, reply);
      if (!teamId) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const device = await getDeviceById(teamId, id);
      if (!device) return reply.code(404).send({ message: "Device not found" });
      return reply.code(200).send({ device });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/capture/devices/:id/revoke — revoke a device
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/capture/devices/:id/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // NEW-050: revocation is destructive and irreversible — it is not a read.
      const teamId = await resolveTeamIdOrDeny(req, reply, "evidence.archive");
      if (!teamId) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = RevokeDeviceBody.parse(req.body);
      const result = await revokeDevice({
        teamId,
        deviceId: id,
        reason: body.reason,
      });
      if (!result.ok) {
        return reply.code(409).send({ denial: result.denial });
      }
      return reply.code(200).send({ revokedAtUtc: result.revokedAtUtc });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/capture/mobile/ingest — RETIRED (UC-0, 2026-09-16)
  //
  // This route verified an envelope, wrote trust events with evidenceId null,
  // created no Evidence, returned `evidenceId: ""`, claimed `otsQueued: true`
  // without queuing anything, and carried the whole asset as base64 JSON under
  // the 1 MiB default body limit — while the app uploaded the same bytes a
  // second time through POST /v1/evidence, and nothing joined the two. Its
  // trust chain could never reach the record it described. The mobile app now
  // uses the direct-capture session adapter below. The route answers 410 so an
  // outdated client fails loudly instead of believing a receipt.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/capture/mobile/ingest",
    { preHandler: requireAuth },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.code(410).send({
        denial: "INGEST_RETIRED",
        replacement: "/v1/capture/direct-sessions",
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/capture/direct-sessions — open a server-issued capture session
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/capture/direct-sessions",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      const body = OpenDirectSessionBody.parse(req.body ?? {});

      const rate = await enforceRateLimit({
        key: `ratelimit:capture:direct-session:open:${userId}`,
        max: DIRECT_SESSION_OPEN_LIMIT_PER_MIN,
        windowSec: 60,
      });
      if (!rate.allowed) {
        return reply.code(429).send({ denial: "RATE_LIMITED" });
      }

      // The workspace is the caller's own personal Team unless one is named;
      // either way the canonical primitive decides access.
      let candidateTeamId = body.teamId ?? null;
      if (!candidateTeamId) {
        try {
          candidateTeamId = (await ensurePersonalWorkspace({ userId })).teamId;
        } catch (err) {
          return sendPersonalSpaceDenial(reply, err);
        }
      }
      const teamId = await authorizeDirectCapture(req, reply, candidateTeamId, userId);
      if (!teamId) return reply;

      try {
        const opened = await openDirectCaptureSession({
          ownerUserId: userId,
          teamId,
          mode: body.mode,
          deviceId: body.deviceId ?? null,
        });
        return reply.code(201).send({ session: opened });
      } catch (err) {
        return sendDirectCaptureError(reply, err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/capture/direct-sessions/:id/evidence — reserve the session's record
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/capture/direct-sessions/:id/evidence",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      const { id } = SessionParams.parse(req.params);
      const body = ReserveDirectEvidenceBody.parse(req.body ?? {});
      if (!(await authorizeOwnedSession(req, reply, id, userId))) return reply;
      try {
        const reserved = await reserveDirectCaptureEvidence({
          sessionId: id,
          ownerUserId: userId,
          type: body.type,
          mimeType: body.mimeType,
          originalFileName: body.originalFileName ?? null,
          deviceTimeIso: body.deviceTimeIso,
          gps: body.gps,
        });
        return reply.code(201).send({ evidence: reserved });
      } catch (err) {
        return sendDirectCaptureError(reply, err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/capture/direct-sessions/:id/parts/:partIndex/declaration
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/capture/direct-sessions/:id/parts/:partIndex/declaration",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      const { id, partIndex } = PartParams.parse(req.params);
      const body = DeclarePartBody.parse(req.body ?? {});
      if (!(await authorizeOwnedSession(req, reply, id, userId))) return reply;
      try {
        const out = await declareDirectCapturePart({
          sessionId: id,
          ownerUserId: userId,
          partIndex,
          sha256: body.sha256,
          clientReportedSource: body.clientReportedSource,
          signed: body.signed
            ? {
                payload: body.signed.payload as CaptureSignaturePayload,
                signatureHex: body.signed.signatureHex,
              }
            : null,
        });
        return reply.code(out.created ? 201 : 200).send({
          declaration: out.declaration,
        });
      } catch (err) {
        return sendDirectCaptureError(reply, err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/capture/direct-sessions/:id/attestation
  //
  // A platform attestation for a device-bound session, bound to THIS session's
  // nonce. Verified by the canonical verifier, which fails closed: no client
  // field can produce a verified verdict.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/capture/direct-sessions/:id/attestation",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      const { id } = SessionParams.parse(req.params);
      const body = AttestationBody.parse(req.body ?? {});
      if (!(await authorizeOwnedSession(req, reply, id, userId))) return reply;
      try {
        const out = await submitDirectCaptureAttestation({
          sessionId: id,
          ownerUserId: userId,
          ...body,
        });
        return reply.code(200).send({ attestation: out });
      } catch (err) {
        return sendDirectCaptureError(reply, err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/capture/direct-sessions/:id/complete
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/capture/direct-sessions/:id/complete",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      const { id } = SessionParams.parse(req.params);
      if (!(await authorizeOwnedSession(req, reply, id, userId))) return reply;
      try {
        const done = await completeDirectCapture({ sessionId: id, ownerUserId: userId });
        return reply.code(200).send({ result: done });
      } catch (err) {
        return sendDirectCaptureError(reply, err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/capture/direct-sessions/:id/web-complete  (UC-1 Direct Web Capture)
  //
  // Seals a DIRECT_WEB_CAPTURE_EXTENSION session with its capture manifest. The
  // manifest is validated server-side, tied to the uploaded bytes by digest,
  // cross-checked against the declared parts, then the session seals through the
  // canonical direct-capture completion. A non-web session is refused here.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/capture/direct-sessions/:id/web-complete",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      const { id } = SessionParams.parse(req.params);
      const body = WebCompleteBody.parse(req.body ?? {});
      if (!(await authorizeOwnedSession(req, reply, id, userId))) return reply;
      try {
        const done = await completeWebCaptureSession({
          sessionId: id,
          ownerUserId: userId,
          manifestJson: body.manifestJson,
        });
        return reply.code(200).send({ result: done });
      } catch (err) {
        return sendDirectCaptureError(reply, err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/capture/direct-sessions/:id/screen-complete  (UC-2 Android Direct
  // Screen Capture)
  //
  // Seals a DIRECT_SCREEN_CAPTURE_ANDROID session with its screen-capture
  // manifest. The manifest is validated server-side, tied to the uploaded frame
  // bytes by digest, cross-checked against the declared parts, then the session
  // seals through the canonical direct-capture completion. A non-screen session
  // is refused here.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/capture/direct-sessions/:id/screen-complete",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      const { id } = SessionParams.parse(req.params);
      const body = ScreenCompleteBody.parse(req.body ?? {});
      if (!(await authorizeOwnedSession(req, reply, id, userId))) return reply;
      try {
        const done = await completeScreenCaptureSession({
          sessionId: id,
          ownerUserId: userId,
          manifestJson: body.manifestJson,
        });
        return reply.code(200).send({ result: done });
      } catch (err) {
        return sendDirectCaptureError(reply, err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/capture/sessions/:id/trust-timeline
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/capture/sessions/:id/trust-timeline",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const teamId = await resolveTeamIdOrDeny(req, reply);
      if (!teamId) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const limit = z
        .object({ limit: z.coerce.number().int().min(1).max(500).optional() })
        .parse(req.query ?? {}).limit ?? 200;
      const events = await readCaptureTrustTimeline({
        teamId,
        captureSessionId: id,
        limit,
      });
      return reply.code(200).send({ events });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/provenance/:evidenceId — public-readable provenance chain
  //
  // Note: this route is callable by any authenticated user with access
  // to the evidence. The public verify page calls a parallel
  // token-anchored read implemented in `routes/external-review.routes`.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/provenance/:evidenceId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const teamId = await resolveTeamIdOrDeny(req, reply);
      if (!teamId) return reply;
      const { evidenceId } = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);

      // Workspace anchoring: confirm the evidence belongs to the team.
      const ev = await prisma.evidence.findFirst({
        where: { id: evidenceId, teamId },
        select: { id: true },
      });
      if (!ev) {
        return reply.code(404).send({ message: "Evidence not found" });
      }

      const chain = await projectProvenanceChain({ evidenceId });
      return reply.code(200).send({ chain });
    },
  );
}

// =============================================================================
// Helpers
// =============================================================================

async function requireAuthAndLegal(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  await requireLegalAcceptance(req, reply);
}

/**
 * Canonical authorization for a direct-capture workspace: ACTIVE membership,
 * evidence.create, org lifecycle — all decided by `authorizeOrFail` — plus the
 * managed-identity personal-space guard. Returns the proven team id or null
 * (the response has been sent).
 */
async function authorizeDirectCapture(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
  userId: string,
): Promise<string | null> {
  const auth = await authorizeOrFail(req, reply, {
    teamId,
    permission: "evidence.create",
    resourceKind: "capture_session",
    antiEnumeration: true,
  });
  if (!auth) return null;
  const personalDenial = await assertPersonalUploadMutationAllowed(auth.teamId, userId);
  if (personalDenial) {
    reply.code(personalDenial.statusCode).send({
      code: personalDenial.code,
      message: personalDenial.message,
    });
    return null;
  }
  return auth.teamId;
}

/**
 * A session is visible only to its owner, and only while the owner is still
 * authorized in the session's workspace (membership can end mid-session).
 */
async function authorizeOwnedSession(
  req: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
  userId: string,
): Promise<boolean> {
  let teamId: string;
  try {
    const session = await loadOwnedDirectCaptureSession(prisma, sessionId, userId);
    teamId = session.teamId!;
  } catch (err) {
    sendDirectCaptureError(reply, err);
    return false;
  }
  return (await authorizeDirectCapture(req, reply, teamId, userId)) !== null;
}

function sendDirectCaptureError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof DirectCaptureError) {
    return reply.code(err.statusCode).send({ denial: err.code });
  }
  const e = err as { statusCode?: unknown; code?: unknown };
  const status = typeof e.statusCode === "number" ? e.statusCode : 500;
  if (status >= 500) throw err;
  // Canonical creation / completion refusals (commercial gates, personal-space
  // policy, upload-session gate) keep their own bounded code.
  return reply.code(status).send({
    denial: typeof e.code === "string" ? e.code : "CAPTURE_REQUEST_REFUSED",
  });
}

function sendPersonalSpaceDenial(reply: FastifyReply, err: unknown): FastifyReply {
  const e = err as { statusCode?: unknown; code?: unknown };
  if (typeof e.statusCode === "number" && e.statusCode < 500) {
    return reply.code(e.statusCode).send({
      denial: typeof e.code === "string" ? e.code : "WORKSPACE_NOT_FOUND",
    });
  }
  throw err;
}

/**
 * Resolve the workspace id for the authenticated request. Personal-space
 * callers are denied — device + ingest are organization concepts.
 */
async function resolveTeamIdOrDeny(
  req: FastifyRequest,
  reply: FastifyReply,
  /**
   * PHASE 13 (NEW-050) — the permission the CALLER needs, not one permission
   * for every operation on the surface.
   *
   * `evidence.read` is the right answer for reading the device registry and
   * the wrong answer for REVOKING a device: revocation burns an evidence
   * signing key, it cannot be undone, and every future capture from that
   * device is refused. Any ordinary member could do it, because the resolver
   * asked the same question for a list and for a destruction.
   *
   * The default stays `evidence.read` so the read surfaces are unchanged; the
   * destructive leg names what it actually needs. This RAISES the bar on one
   * route and lowers it on none.
   */
  permission: "evidence.read" | "evidence.archive" = "evidence.read",
): Promise<string | null> {
  // PHASE 12 CORRECTIVE PASS §1.3 (2026-08-06) — ONE AUTHORITY, NOT A
  // PARALLEL ONE.
  //
  // The P0 remediation of 2026-07-21 was right about the defect (a stale
  // pointer must not authorize) and built its own four-step check to fix it:
  // pointer -> team row -> isPersonal -> ACTIVE membership. That closed the
  // status hole but left this surface as a SECOND authorization authority,
  // and a second authority is a second place to forget something. It did
  // forget three things the canonical chain enforces:
  //
  //   * member ACCESS EXPIRY   — an ACTIVE row past `accessExpiresAtUtc`
  //                              still passed;
  //   * WORKSPACE KIND         — an unprovable kind was treated as fine;
  //   * ORGANIZATION LIFECYCLE — capture ingest continued to work inside a
  //                              SUSPENDED or ARCHIVED customer Organization.
  //
  // All three are now enforced because this resolver no longer decides
  // anything itself: it hands the pointer to the canonical primitive as a
  // CANDIDATE and reads the proven context back.
  //
  // The ONE surface-specific rule is retained verbatim: capture ingest is not
  // a Personal-Space surface. It is now expressed against the PROVEN canonical
  // kind rather than against a re-read `isPersonal` column.
  const outcome = await evaluateCurrentWorkspace(req, { permission });
  if (!outcome.allowed) {
    reply.code(403).send({ denial: "WORKSPACE_NOT_FOUND" });
    return null;
  }
  if (outcome.context.workspaceKind === "PERSONAL") {
    reply.code(403).send({ denial: "WORKSPACE_NOT_FOUND" });
    return null;
  }
  return outcome.context.workspaceId;
}
