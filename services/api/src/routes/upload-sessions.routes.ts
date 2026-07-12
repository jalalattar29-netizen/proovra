/**
 * Phase 30.5 — Resumable upload session REST routes (operator/web path).
 *
 * Wires the Phase 30 `upload-session.service.ts` lifecycle into a
 * complete REST surface for authenticated workspace members. Every
 * route is gated by the Phase 26 `authorizeOrFail` helper.
 *
 * Routes:
 *   POST   /v1/uploads/sessions
 *   GET    /v1/uploads/sessions/:sessionId
 *   GET    /v1/uploads/sessions/:sessionId/status
 *   POST   /v1/uploads/sessions/:sessionId/parts/:partIndex/uploaded
 *   POST   /v1/uploads/sessions/:sessionId/parts/:partIndex/verified
 *   POST   /v1/uploads/sessions/:sessionId/complete
 *   POST   /v1/uploads/sessions/:sessionId/abort
 *
 * Hard contracts:
 *   - Every mutation requires `evidence.create`; every read requires
 *     `evidence.read`. Both go through `authorizeOrFail` with
 *     `antiEnumeration: true` so non-members of the workspace see 404
 *     `not_found`, never a permission-denied probe surface.
 *   - Every response shape is bounded — `UPLOAD_SESSION_DENIAL_CODES`
 *     maps to a closed catalog of HTTP statuses; route handlers never
 *     surface raw Prisma errors or free-text.
 *   - NO storage keys, NO signed URLs, NO raw S3 object identifiers
 *     are projected anywhere in this file. The session shape is
 *     metadata-only; the actual byte transfer happens via the
 *     existing per-part presigned URL path.
 *   - Mark-uploaded + mark-verified accept ONLY a single part's
 *     metadata. The custody-safe semantics (server clock,
 *     verified-only completion, hash mismatch → FAILED) are enforced
 *     in the service layer; routes are the thin transport.
 *   - `markPartVerified` exposes a `serverSha256` parameter so the
 *     hash-verification worker / the inline HEAD/SHA-256 check can
 *     post the server-computed value. This route is operator-only;
 *     trusted callers (worker, S3 multipart completion handler) hand
 *     in the hash they computed from the actual bytes. We do NOT
 *     accept a client-provided server hash via untrusted channels.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { bump } from "../services/ops/metrics.service.js";
import {
  abortStorageMultipart,
  abortUploadSession,
  completeStorageMultipart,
  completeUploadSession,
  createUploadSession,
  initiateStorageMultipart,
  markPartUploaded,
  markPartVerified,
  presignStorageUploadPart,
  recordPartEtag,
  resumeUploadSession,
  type StorageMultipartLifecycleDenialCode,
  type UploadSessionDenialCode,
  type UploadSessionPartRow,
  type UploadSessionRow,
} from "../services/uploads/upload-session.service.js";

// =============================================================================
// Bounded validators
// =============================================================================

const CreateSessionBodySchema = z
  .object({
    teamId: z.string().uuid(),
    evidenceId: z.string().uuid(),
    expectedPartCount: z.number().int().min(1).max(10_000),
    expectedTotalBytes: z.number().int().min(0).max(50 * 1024 ** 3).optional(),
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    safeNote: z.string().max(400).optional(),
    expiresAtUtc: z.string().datetime().optional(),
    idempotencyKey: z.string().min(1).max(120).optional(),
    // Phase 30.12 — upload-session → EvidencePart bridge metadata.
    // When supplied (all three), completeStorageMultipart will
    // create a bridging EvidencePart row on success.
    targetPartIndex: z.number().int().min(0).max(9_999).optional(),
    originalFileName: z.string().min(1).max(255).optional(),
    expectedMimeType: z.string().min(1).max(128).optional(),
  })
  .strict();

const SessionParamsSchema = z.object({
  sessionId: z.string().uuid(),
});

const PartParamsSchema = z.object({
  sessionId: z.string().uuid(),
  partIndex: z.coerce.number().int().min(0).max(9_999),
});

const TeamQuerySchema = z.object({
  teamId: z.string().uuid(),
});

const MarkPartUploadedBodySchema = z
  .object({
    teamId: z.string().uuid(),
    clientSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .nullable()
      .optional(),
    clientUploadedAtUtc: z.string().datetime().nullable().optional(),
    // Phase 30.8 — S3-supplied ETag from the UploadPartResponse.
    // Storage metadata only; never treated as a hash. When present,
    // the route also records partSizeBytes so the operator surface
    // can show "5 of 12 parts uploaded (480 MB / 1.2 GB)".
    partEtag: z.string().min(1).max(256).optional(),
    partSizeBytes: z.number().int().min(0).optional(),
  })
  .strict();

// Phase 30.8 — multipart-specific bodies.
const MultipartInitiateBodySchema = z
  .object({
    teamId: z.string().uuid(),
    contentType: z.string().min(1).max(255).optional(),
  })
  .strict();

const MultipartPresignBodySchema = z
  .object({
    teamId: z.string().uuid(),
    expiresInSeconds: z.number().int().min(60).max(900).optional(),
  })
  .strict();

const MultipartCompleteBodySchema = z
  .object({
    teamId: z.string().uuid(),
    /** When true, the server streams the final object through SHA-256
     *  and compares to the session's expected_sha256. */
    verifyHash: z.boolean().optional(),
  })
  .strict();

const MarkPartVerifiedBodySchema = z
  .object({
    teamId: z.string().uuid(),
    serverSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict();

const CompleteBodySchema = z
  .object({
    teamId: z.string().uuid(),
  })
  .strict();

const AbortBodySchema = z
  .object({
    teamId: z.string().uuid(),
    reason: z.string().min(1).max(120),
  })
  .strict();

// =============================================================================
// Denial code → HTTP status mapping (bounded)
// =============================================================================

/**
 * Maps the service-layer denial vocabulary onto bounded HTTP statuses.
 * No free-text leaks from this table; only typed reason codes.
 */
function statusForDenial(
  reason: UploadSessionDenialCode | StorageMultipartLifecycleDenialCode,
): number {
  switch (reason) {
    case "session_not_found":
    case "multipart_not_found":
    case "evidence_not_found":
      return 404;
    case "service_unavailable":
    case "storage_unavailable":
    case "configuration_missing":
      return 503;
    case "hash_mismatch":
      return 422;
    case "invalid_part_index":
    case "invalid_part_count":
    case "invalid_expiry":
    case "invalid_part":
    case "missing_part_etag":
      return 400;
    case "complete_failed":
    case "head_failed":
    case "multipart_already_initiated":
    case "multipart_not_initiated":
      return 409;
    case "completion_blocked_pending_parts":
    case "session_not_active":
    case "session_already_completed":
    case "session_already_terminal":
    case "invalid_state_transition":
      return 409;
    default:
      return 400;
  }
}

function sendDenial(
  reply: FastifyReply,
  reason: UploadSessionDenialCode | StorageMultipartLifecycleDenialCode,
  extras?: Record<string, unknown>,
): FastifyReply {
  const status = statusForDenial(reason);
  // Anti-enumeration: 404 always uses the canonical bounded shape so
  // non-members + not-yet-existing sessions look identical.
  if (status === 404) {
    return reply.code(404).send({ error: { code: "not_found" } });
  }
  return reply.code(status).send({
    error: { code: "upload_session_denied", reason, ...(extras ?? {}) },
  });
}

// =============================================================================
// Projections — anti-leak (no storage keys, no signed URLs, no raw IDs
// beyond what's already in the workspace surface)
// =============================================================================

function projectSession(session: UploadSessionRow) {
  return {
    id: session.id,
    evidenceId: session.evidenceId,
    state: session.state,
    expectedPartCount: session.expectedPartCount,
    expectedTotalBytes: session.expectedTotalBytes,
    expectedSha256: session.expectedSha256,
    safeNote: session.safeNote,
    idempotencyKey: session.idempotencyKey,
    expiresAtUtc: session.expiresAtUtc,
    completedAtUtc: session.completedAtUtc,
    abortedAtUtc: session.abortedAtUtc,
    abortReason: session.abortReason,
    createdAtUtc: session.createdAtUtc,
    updatedAtUtc: session.updatedAtUtc,
  };
}

function projectPart(part: UploadSessionPartRow) {
  return {
    partIndex: part.partIndex,
    state: part.state,
    expectedBytes: part.expectedBytes,
    clientSha256: part.clientSha256,
    serverSha256: part.serverSha256,
    uploadedAtUtcClient: part.uploadedAtUtcClient,
    verifiedAtUtc: part.verifiedAtUtc,
    retryCount: part.retryCount,
    failureReason: part.failureReason,
  };
}

// =============================================================================
// Routes
// =============================================================================

export async function uploadSessionsRoutes(app: FastifyInstance) {
  // ===========================================================================
  // POST /v1/uploads/sessions — create (or reuse via idempotency key)
  // ===========================================================================
  app.post(
    "/v1/uploads/sessions",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = CreateSessionBodySchema.parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.create",
        antiEnumeration: true,
      });
      if (!actor) return;

      const result = await createUploadSession({
        teamId: body.teamId,
        evidenceId: body.evidenceId,
        actorUserId: actor.actorUserId,
        expectedPartCount: body.expectedPartCount,
        expectedTotalBytes: body.expectedTotalBytes ?? null,
        expectedSha256: body.expectedSha256?.toLowerCase() ?? null,
        safeNote: body.safeNote ?? null,
        expiresAtUtc: body.expiresAtUtc,
        idempotencyKey: body.idempotencyKey ?? null,
        targetPartIndex: body.targetPartIndex ?? null,
        originalFileName: body.originalFileName ?? null,
        expectedMimeType: body.expectedMimeType ?? null,
      });
      if (!result.ok) {
        return sendDenial(reply, result.reason);
      }
      bump("upload_session_route_created_total");
      // Idempotent reuse: 200 (existed); fresh insert: 201.
      return reply.code(result.reused ? 200 : 201).send({
        session: projectSession(result.session),
        reused: result.reused,
      });
    },
  );

  // ===========================================================================
  // GET /v1/uploads/sessions/:sessionId — single session + parts (resume)
  // ===========================================================================
  app.get(
    "/v1/uploads/sessions/:sessionId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { sessionId } = SessionParamsSchema.parse(req.params);
      const { teamId } = TeamQuerySchema.parse(req.query ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId,
        permission: "evidence.read",
        antiEnumeration: true,
      });
      if (!actor) return;

      const result = await resumeUploadSession({
        teamId,
        sessionId,
      });
      if (!result.ok) {
        return sendDenial(reply, result.reason);
      }
      return reply.code(200).send({
        session: projectSession(result.session),
        parts: result.parts.map(projectPart),
        pendingPartIndices: result.pendingPartIndices,
      });
    },
  );

  // ===========================================================================
  // GET /v1/uploads/sessions/:sessionId/status — compact status probe
  //
  // Returns ONLY the state + pending count. Cheap to call from a
  // mobile client polling for the verification worker to finish.
  // ===========================================================================
  app.get(
    "/v1/uploads/sessions/:sessionId/status",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { sessionId } = SessionParamsSchema.parse(req.params);
      const { teamId } = TeamQuerySchema.parse(req.query ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId,
        permission: "evidence.read",
        antiEnumeration: true,
      });
      if (!actor) return;

      const result = await resumeUploadSession({
        teamId,
        sessionId,
      });
      if (!result.ok) {
        return sendDenial(reply, result.reason);
      }
      return reply.code(200).send({
        sessionId: result.session.id,
        state: result.session.state,
        completedAtUtc: result.session.completedAtUtc,
        pendingPartCount: result.pendingPartIndices.length,
        pendingPartIndices: result.pendingPartIndices,
      });
    },
  );

  // ===========================================================================
  // POST /v1/uploads/sessions/:sessionId/parts/:partIndex/uploaded
  //   — client claims a part finished uploading
  // ===========================================================================
  app.post(
    "/v1/uploads/sessions/:sessionId/parts/:partIndex/uploaded",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { sessionId, partIndex } = PartParamsSchema.parse(req.params);
      const body = MarkPartUploadedBodySchema.parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.create",
        antiEnumeration: true,
      });
      if (!actor) return;

      const result = await markPartUploaded({
        teamId: body.teamId,
        sessionId,
        partIndex,
        clientSha256: body.clientSha256?.toLowerCase() ?? null,
        clientUploadedAtUtc: body.clientUploadedAtUtc ?? null,
      });
      if (!result.ok) {
        return sendDenial(reply, result.reason);
      }
      // Phase 30.8 — if the client also supplied a part ETag (native
      // S3 multipart path), record it as storage metadata. The ETag
      // is NOT used for integrity — that's the server-side SHA-256.
      // The record itself never moves the part to VERIFIED.
      if (body.partEtag) {
        const etagResult = await recordPartEtag({
          teamId: body.teamId,
          sessionId,
          partIndex,
          etag: body.partEtag,
          partSizeBytes: body.partSizeBytes ?? null,
        });
        if (!etagResult.ok) {
          return sendDenial(reply, etagResult.reason);
        }
        bump("multipart_part_marked_uploaded_total");
      }
      return reply.code(200).send({ part: projectPart(result.part) });
    },
  );

  // ===========================================================================
  // POST /v1/uploads/sessions/:sessionId/parts/:partIndex/verified
  //   — trusted caller (verification worker / S3 completion handler)
  //     reports the server-computed SHA-256
  //
  // Authorized callers must hold `evidence.create`. The hash supplied
  // is treated as the server-side truth; the service compares it
  // against the client's claim and refuses to mark VERIFIED on
  // mismatch.
  // ===========================================================================
  app.post(
    "/v1/uploads/sessions/:sessionId/parts/:partIndex/verified",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { sessionId, partIndex } = PartParamsSchema.parse(req.params);
      const body = MarkPartVerifiedBodySchema.parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.create",
        antiEnumeration: true,
      });
      if (!actor) return;

      const result = await markPartVerified({
        teamId: body.teamId,
        sessionId,
        partIndex,
        serverSha256: body.serverSha256.toLowerCase(),
      });
      if (!result.ok) {
        return sendDenial(reply, result.reason);
      }
      return reply.code(200).send({ part: projectPart(result.part) });
    },
  );

  // ===========================================================================
  // POST /v1/uploads/sessions/:sessionId/complete — server-side gate
  //
  // Refuses unless every part is VERIFIED. Returns 409 +
  // `pendingPartIndices` when still blocked so the client can show
  // "we're still verifying 3 of 12 parts" rather than a generic error.
  // ===========================================================================
  app.post(
    "/v1/uploads/sessions/:sessionId/complete",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { sessionId } = SessionParamsSchema.parse(req.params);
      const body = CompleteBodySchema.parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.create",
        antiEnumeration: true,
      });
      if (!actor) return;

      const result = await completeUploadSession({
        teamId: body.teamId,
        sessionId,
      });
      if (!result.ok) {
        return sendDenial(
          reply,
          result.reason,
          result.pendingPartIndices
            ? { pendingPartIndices: result.pendingPartIndices }
            : undefined,
        );
      }
      bump("upload_session_route_completed_total");
      return reply.code(200).send({ session: projectSession(result.session) });
    },
  );

  // ===========================================================================
  // POST /v1/uploads/sessions/:sessionId/abort — operator/client cancel
  // ===========================================================================
  app.post(
    "/v1/uploads/sessions/:sessionId/abort",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { sessionId } = SessionParamsSchema.parse(req.params);
      const body = AbortBodySchema.parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.create",
        antiEnumeration: true,
      });
      if (!actor) return;

      const result = await abortUploadSession({
        teamId: body.teamId,
        sessionId,
        actorUserId: actor.actorUserId,
        reason: body.reason,
      });
      if (!result.ok) {
        return sendDenial(reply, result.reason);
      }
      return reply.code(200).send({ session: projectSession(result.session) });
    },
  );

  // ===========================================================================
  // Phase 30.8 — S3 NATIVE MULTIPART ROUTES
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // POST /v1/uploads/sessions/:sessionId/multipart/initiate
  //
  // Binds the session to a real S3 multipart upload. The response is
  // intentionally NARROW — no storage key, no multipart upload ID,
  // no bucket name. The client just needs to know "initiate
  // succeeded; you can now request presigned part URLs".
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/uploads/sessions/:sessionId/multipart/initiate",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { sessionId } = SessionParamsSchema.parse(req.params);
      const body = MultipartInitiateBodySchema.parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.create",
        antiEnumeration: true,
      });
      if (!actor) return;

      const result = await initiateStorageMultipart({
        teamId: body.teamId,
        sessionId,
        contentType: body.contentType ?? null,
      });
      if (!result.ok) {
        return sendDenial(reply, result.reason);
      }
      // Anti-leak: NEVER project storageBucket / storageKey /
      // multipartUploadId. The session is now live on S3; the
      // client just needs presigned part URLs from here on.
      return reply
        .code(200)
        .send({ storageInitiated: true });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/uploads/sessions/:sessionId/parts/:partIndex/presign
  //
  // Mint a short-lived presigned PUT URL for one part of the
  // multipart upload. The URL is scoped to bucket + key + uploadId
  // + part number. Client uploads bytes to it, then reports the
  // ETag back via /parts/:partIndex/uploaded.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/uploads/sessions/:sessionId/parts/:partIndex/presign",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { sessionId, partIndex } = PartParamsSchema.parse(req.params);
      const body = MultipartPresignBodySchema.parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.create",
        antiEnumeration: true,
      });
      if (!actor) return;

      const result = await presignStorageUploadPart({
        teamId: body.teamId,
        sessionId,
        partIndex,
        expiresInSeconds: body.expiresInSeconds,
      });
      if (!result.ok) {
        return sendDenial(reply, result.reason);
      }
      // Bounded safe shape: uploadUrl + method + expiresAt + partIndex.
      // No bucket name, no key, no uploadId.
      return reply.code(200).send({
        uploadUrl: result.uploadUrl,
        method: result.method,
        expiresAt: result.expiresAt,
        partIndex: result.partIndex,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/uploads/sessions/:sessionId/multipart/complete
  //
  // Drive S3 CompleteMultipartUpload + HEAD + optional server-hash.
  // Refuses if any part is missing an ETag. Does NOT finalize
  // evidence — the caller must still hit /v1/evidence/:id/complete
  // which runs the custody-safe finalize gate.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/uploads/sessions/:sessionId/multipart/complete",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { sessionId } = SessionParamsSchema.parse(req.params);
      const body = MultipartCompleteBodySchema.parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.create",
        antiEnumeration: true,
      });
      if (!actor) return;

      const result = await completeStorageMultipart({
        teamId: body.teamId,
        sessionId,
        verifyHash: body.verifyHash ?? false,
      });
      if (!result.ok) {
        return sendDenial(
          reply,
          result.reason,
          result.missingEtags ? { missingPartIndices: result.missingEtags } : undefined,
        );
      }
      // Etag + contentLength are storage metadata — safe to surface.
      // serverSha256 is the custody-grade hash if the caller asked
      // for verification. Storage key / bucket / uploadId still
      // never leave the server.
      return reply.code(200).send({
        etag: result.etag,
        contentLength: result.contentLength,
        serverSha256: result.serverSha256,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/uploads/sessions/:sessionId/multipart/abort
  //
  // Cancel the S3 multipart and mark the session ABORTED.
  // Idempotent — S3 NoSuchUpload is treated as success.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/uploads/sessions/:sessionId/multipart/abort",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { sessionId } = SessionParamsSchema.parse(req.params);
      const body = AbortBodySchema.parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.create",
        antiEnumeration: true,
      });
      if (!actor) return;

      const result = await abortStorageMultipart({
        teamId: body.teamId,
        sessionId,
        actorUserId: actor.actorUserId,
        reason: body.reason,
      });
      if (!result.ok) {
        return sendDenial(reply, result.reason);
      }
      return reply.code(200).send({
        aborted: true,
        alreadyAbsent: result.alreadyAbsent,
      });
    },
  );
}
