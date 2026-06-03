/**
 * Phase 30.6 — API-key ingestion routes for resumable multipart uploads.
 *
 * Mirrors the Phase 30.5 authenticated web surface but for service-
 * account / API-key callers. The credential's `teamId` is the source
 * of truth — callers do NOT pass `teamId` in body / query / path.
 *
 * Routes:
 *   POST   /v1/integrations/api/uploads/sessions
 *   GET    /v1/integrations/api/uploads/sessions/:sessionId
 *   POST   /v1/integrations/api/uploads/sessions/:sessionId/parts/:partIndex/uploaded
 *   POST   /v1/integrations/api/uploads/sessions/:sessionId/complete
 *   POST   /v1/integrations/api/uploads/sessions/:sessionId/abort
 *
 * Hard contracts:
 *   - Every route: `requireApiKey` + `requireApiScope` + `runWithApiAudit`.
 *   - Required scope is `integration.evidence.upload` for mutating
 *     routes (POST/abort) and `integration.evidence.read` for the GET.
 *   - The session-create route additionally enforces:
 *       * `idempotencyKey` is REQUIRED on API-key path (machine clients
 *         must always supply one — a retry without idempotency is the
 *         single most reliable way to corrupt custody).
 *       * Workspace governance gate: target evidence row exists in the
 *         caller's team AND is not under an active legal hold.
 *   - Anti-enumeration: every "evidence not in your team" / "session
 *     not in your team" response is the canonical 404 not_found.
 *   - Bounded denial vocabulary: route errors map to a closed catalog
 *     of HTTP statuses. NO free-text Prisma errors.
 *   - The response NEVER projects: storage keys, signed URLs, S3
 *     multipart upload IDs, ETags, actor user IDs, or any other
 *     workspace-internal identifier beyond what the operator-side
 *     web routes already expose.
 *   - The `service_account` actor type is recorded on every audit
 *     emission via `runWithApiAudit`.
 *
 * NOT included in this phase (explicit scope-out):
 *   - S3-native multipart initiate / presigned-part / abort handlers.
 *     This route surface accepts session-level metadata only; the
 *     actual byte transfer flows through the existing presigned-URL
 *     path (single-shot) or — when the multipart SDK integration
 *     ships — through future per-part presign endpoints. Adding those
 *     here without the underlying storage code would be misleading.
 *   - The `/verified` route is OPERATOR-ONLY (web surface) — trusted
 *     workers compute server hashes; API-key clients cannot claim
 *     server-side verification of their own bytes.
 */
import { z } from "zod";
import { prisma } from "../db.js";
import { requireApiKey, requireApiScope, runWithApiAudit, } from "../middleware/integrations-auth.js";
import { isUnderActiveLegalHold } from "../services/governance.service.js";
import { bump } from "../services/ops/metrics.service.js";
import { abortStorageMultipart, abortUploadSession, completeStorageMultipart, completeUploadSession, createUploadSession, initiateStorageMultipart, markPartUploaded, presignStorageUploadPart, recordPartEtag, resumeUploadSession, } from "../services/uploads/upload-session.service.js";
// =============================================================================
// Bounded validators
// =============================================================================
const ParamsSessionId = z.object({
    sessionId: z.string().uuid(),
});
const ParamsSessionAndPart = z.object({
    sessionId: z.string().uuid(),
    partIndex: z.coerce.number().int().min(0).max(9_999),
});
const CreateSessionBodySchema = z
    .object({
    evidenceId: z.string().uuid(),
    expectedPartCount: z.number().int().min(1).max(10_000),
    expectedTotalBytes: z.number().int().min(0).max(50 * 1024 ** 3).optional(),
    expectedSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
    safeNote: z.string().max(400).optional(),
    expiresAtUtc: z.string().datetime().optional(),
    /**
     * REQUIRED on the API-key path. Machine clients MUST supply an
     * idempotency key on every session-create POST. The service layer
     * collapses repeat POSTs onto the existing row for the team.
     */
    idempotencyKey: z.string().min(1).max(120),
    // Phase 30.12 — upload-session → EvidencePart bridge metadata.
    // When supplied (all three), completeStorageMultipart will
    // create a bridging EvidencePart row on success so the
    // multipart material appears in report-v2 / verification
    // package / search / verify automatically via the existing
    // EvidencePart contract.
    targetPartIndex: z.number().int().min(0).max(9_999).optional(),
    originalFileName: z.string().min(1).max(255).optional(),
    expectedMimeType: z.string().min(1).max(128).optional(),
})
    .strict();
const MarkPartUploadedBodySchema = z
    .object({
    clientSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .nullable()
        .optional(),
    clientUploadedAtUtc: z.string().datetime().nullable().optional(),
    // Phase 30.8 — optional S3 ETag from UploadPartResponse + part size.
    partEtag: z.string().min(1).max(256).optional(),
    partSizeBytes: z.number().int().min(0).optional(),
})
    .strict();
const AbortBodySchema = z
    .object({
    reason: z.string().min(1).max(120),
})
    .strict();
// Phase 30.8 — API-key multipart bodies.
const MultipartInitiateApiBodySchema = z
    .object({
    contentType: z.string().min(1).max(255).optional(),
})
    .strict();
const MultipartPresignApiBodySchema = z
    .object({
    expiresInSeconds: z.number().int().min(60).max(900).optional(),
})
    .strict();
const MultipartCompleteApiBodySchema = z
    .object({
    verifyHash: z.boolean().optional(),
})
    .strict();
// =============================================================================
// Denial → HTTP mapping (mirrors the web route mapping)
// =============================================================================
function statusForDenial(reason) {
    switch (reason) {
        case "session_not_found":
        case "multipart_not_found":
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
function sendDenial(req, reply, reason, extras) {
    const status = statusForDenial(reason);
    const requestId = req.id ?? null;
    if (status === 404) {
        return reply
            .code(404)
            .send({ error: { code: "not_found" }, requestId });
    }
    return reply.code(status).send({
        error: { code: "upload_session_denied", reason, ...(extras ?? {}) },
        requestId,
    });
}
// =============================================================================
// API-key safe projection (intentionally narrower than the web surface)
// =============================================================================
function projectSessionForApi(session) {
    return {
        id: session.id,
        evidenceId: session.evidenceId,
        state: session.state,
        expectedPartCount: session.expectedPartCount,
        expectedTotalBytes: session.expectedTotalBytes,
        expectedSha256: session.expectedSha256,
        idempotencyKey: session.idempotencyKey,
        expiresAtUtc: session.expiresAtUtc,
        completedAtUtc: session.completedAtUtc,
        abortedAtUtc: session.abortedAtUtc,
        createdAtUtc: session.createdAtUtc,
        updatedAtUtc: session.updatedAtUtc,
        // Deliberately NOT projected: actorUserId, abortedByUserId,
        // teamId (the caller already knows their team), abortReason
        // (free-text; operator-side only), safeNote (operator-side
        // private context).
    };
}
function projectPartForApi(part) {
    return {
        partIndex: part.partIndex,
        state: part.state,
        expectedBytes: part.expectedBytes,
        clientSha256: part.clientSha256,
        serverSha256: part.serverSha256,
        verifiedAtUtc: part.verifiedAtUtc,
        retryCount: part.retryCount,
        // Deliberately NOT projected: failureReason (free-text), client
        // upload timestamp (advisory only — leaking it would invite
        // confusion with the authoritative verified_at_utc).
    };
}
// =============================================================================
// Governance + ownership gate for session creation
// =============================================================================
/**
 * Refuse session creation if the evidence row doesn't exist in the
 * caller's team OR is currently under an active legal hold. Returns
 * null on success; a denial code + status on failure.
 *
 * Anti-enumeration: a cross-team evidence ID returns the SAME shape
 * as a not-yet-existing evidence ID — both are 404 not_found.
 */
async function gateEvidenceForUpload(input) {
    const evidence = await prisma.evidence.findUnique({
        where: { id: input.evidenceId },
        select: { id: true, teamId: true, archivedAt: true },
    });
    if (!evidence || evidence.teamId !== input.teamId) {
        return { ok: false, status: 404, code: "not_found" };
    }
    if (evidence.archivedAt) {
        return {
            ok: false,
            status: 403,
            code: "evidence_archived",
        };
    }
    if (await isUnderActiveLegalHold(evidence.id)) {
        return {
            ok: false,
            status: 403,
            code: "blocked_by_legal_hold",
        };
    }
    return { ok: true };
}
// =============================================================================
// Routes
// =============================================================================
export async function integrationsUploadsRoutes(app) {
    // ===========================================================================
    // POST /v1/integrations/api/uploads/sessions
    // ===========================================================================
    app.post("/v1/integrations/api/uploads/sessions", async (req, reply) => {
        if (!(await requireApiKey(req, reply)))
            return;
        if (!requireApiScope(req, reply, "integration.evidence.upload"))
            return;
        const cred = req.apiCredential;
        return runWithApiAudit(req, reply, "upload_session.create", async () => {
            const body = CreateSessionBodySchema.parse(req.body ?? {});
            // Governance + ownership gate FIRST — never create a session
            // pointed at an evidence row the caller can't legally write to.
            const gate = await gateEvidenceForUpload({
                teamId: cred.teamId,
                evidenceId: body.evidenceId,
            });
            if (!gate.ok) {
                return reply.code(gate.status).send({
                    error: { code: gate.code, ...(gate.reason ? { reason: gate.reason } : {}) },
                    requestId: req.id ?? null,
                });
            }
            const result = await createUploadSession({
                teamId: cred.teamId,
                evidenceId: body.evidenceId,
                // Service-account credential ID stands in for actorUserId
                // on the API-key path. Downstream audit chain logs this as
                // `actorType: service_account` via runWithApiAudit.
                actorUserId: cred.credentialId,
                expectedPartCount: body.expectedPartCount,
                expectedTotalBytes: body.expectedTotalBytes ?? null,
                expectedSha256: body.expectedSha256?.toLowerCase() ?? null,
                safeNote: body.safeNote ?? null,
                expiresAtUtc: body.expiresAtUtc,
                idempotencyKey: body.idempotencyKey,
                targetPartIndex: body.targetPartIndex ?? null,
                originalFileName: body.originalFileName ?? null,
                expectedMimeType: body.expectedMimeType ?? null,
            });
            if (!result.ok) {
                return sendDenial(req, reply, result.reason);
            }
            bump("upload_session_route_created_total");
            return reply.code(result.reused ? 200 : 201).send({
                session: projectSessionForApi(result.session),
                reused: result.reused,
                requestId: req.id ?? null,
            });
        });
    });
    // ===========================================================================
    // GET /v1/integrations/api/uploads/sessions/:sessionId
    // ===========================================================================
    app.get("/v1/integrations/api/uploads/sessions/:sessionId", async (req, reply) => {
        if (!(await requireApiKey(req, reply)))
            return;
        if (!requireApiScope(req, reply, "integration.evidence.read"))
            return;
        const cred = req.apiCredential;
        return runWithApiAudit(req, reply, "upload_session.get", async () => {
            const { sessionId } = ParamsSessionId.parse(req.params);
            const result = await resumeUploadSession({
                teamId: cred.teamId,
                sessionId,
            });
            if (!result.ok) {
                return sendDenial(req, reply, result.reason);
            }
            return reply.code(200).send({
                session: projectSessionForApi(result.session),
                parts: result.parts.map(projectPartForApi),
                pendingPartIndices: result.pendingPartIndices,
                requestId: req.id ?? null,
            });
        });
    });
    // ===========================================================================
    // POST /v1/integrations/api/uploads/sessions/:sessionId/parts/:partIndex/uploaded
    // ===========================================================================
    app.post("/v1/integrations/api/uploads/sessions/:sessionId/parts/:partIndex/uploaded", async (req, reply) => {
        if (!(await requireApiKey(req, reply)))
            return;
        if (!requireApiScope(req, reply, "integration.evidence.upload"))
            return;
        const cred = req.apiCredential;
        return runWithApiAudit(req, reply, "upload_part.marked_uploaded", async () => {
            const { sessionId, partIndex } = ParamsSessionAndPart.parse(req.params);
            const body = MarkPartUploadedBodySchema.parse(req.body ?? {});
            const result = await markPartUploaded({
                teamId: cred.teamId,
                sessionId,
                partIndex,
                clientSha256: body.clientSha256?.toLowerCase() ?? null,
                clientUploadedAtUtc: body.clientUploadedAtUtc ?? null,
            });
            if (!result.ok) {
                return sendDenial(req, reply, result.reason);
            }
            // Phase 30.8 — optional S3 ETag bookkeeping. Storage metadata
            // only; the part remains UPLOADED_UNVERIFIED until server-
            // side SHA-256 verification.
            if (body.partEtag) {
                const etagResult = await recordPartEtag({
                    teamId: cred.teamId,
                    sessionId,
                    partIndex,
                    etag: body.partEtag,
                    partSizeBytes: body.partSizeBytes ?? null,
                });
                if (!etagResult.ok) {
                    return sendDenial(req, reply, etagResult.reason);
                }
                bump("multipart_part_marked_uploaded_total");
            }
            return reply.code(200).send({
                part: projectPartForApi(result.part),
                requestId: req.id ?? null,
            });
        });
    });
    // ===========================================================================
    // POST /v1/integrations/api/uploads/sessions/:sessionId/complete
    // ===========================================================================
    app.post("/v1/integrations/api/uploads/sessions/:sessionId/complete", async (req, reply) => {
        if (!(await requireApiKey(req, reply)))
            return;
        if (!requireApiScope(req, reply, "integration.evidence.upload"))
            return;
        const cred = req.apiCredential;
        return runWithApiAudit(req, reply, "upload_session.complete", async () => {
            const { sessionId } = ParamsSessionId.parse(req.params);
            const result = await completeUploadSession({
                teamId: cred.teamId,
                sessionId,
            });
            if (!result.ok) {
                return sendDenial(req, reply, result.reason, result.pendingPartIndices
                    ? { pendingPartIndices: result.pendingPartIndices }
                    : undefined);
            }
            bump("upload_session_route_completed_total");
            return reply.code(200).send({
                session: projectSessionForApi(result.session),
                requestId: req.id ?? null,
            });
        });
    });
    // ===========================================================================
    // POST /v1/integrations/api/uploads/sessions/:sessionId/abort
    // ===========================================================================
    app.post("/v1/integrations/api/uploads/sessions/:sessionId/abort", async (req, reply) => {
        if (!(await requireApiKey(req, reply)))
            return;
        if (!requireApiScope(req, reply, "integration.evidence.upload"))
            return;
        const cred = req.apiCredential;
        return runWithApiAudit(req, reply, "upload_session.abort", async () => {
            const { sessionId } = ParamsSessionId.parse(req.params);
            const body = AbortBodySchema.parse(req.body ?? {});
            const result = await abortUploadSession({
                teamId: cred.teamId,
                sessionId,
                actorUserId: cred.credentialId,
                reason: body.reason,
            });
            if (!result.ok) {
                return sendDenial(req, reply, result.reason);
            }
            return reply.code(200).send({
                session: projectSessionForApi(result.session),
                requestId: req.id ?? null,
            });
        });
    });
    // ===========================================================================
    // Phase 30.8 — API-key S3 NATIVE MULTIPART ROUTES
    // ===========================================================================
    //
    // Same surface as the web routes, but auth = Bearer API key with
    // `integration.evidence.upload` scope. teamId is always read off
    // the credential (never user input). Responses NEVER project
    // storage_bucket / storage_key / multipart_upload_id.
    // ---------------------------------------------------------------------------
    // POST /v1/integrations/api/uploads/sessions/:sessionId/multipart/initiate
    // ---------------------------------------------------------------------------
    app.post("/v1/integrations/api/uploads/sessions/:sessionId/multipart/initiate", async (req, reply) => {
        if (!(await requireApiKey(req, reply)))
            return;
        if (!requireApiScope(req, reply, "integration.evidence.upload"))
            return;
        const cred = req.apiCredential;
        return runWithApiAudit(req, reply, "multipart.initiate", async () => {
            const { sessionId } = ParamsSessionId.parse(req.params);
            const body = MultipartInitiateApiBodySchema.parse(req.body ?? {});
            const result = await initiateStorageMultipart({
                teamId: cred.teamId,
                sessionId,
                contentType: body.contentType ?? null,
            });
            if (!result.ok) {
                return sendDenial(req, reply, result.reason);
            }
            return reply.code(200).send({
                storageInitiated: true,
                requestId: req.id ?? null,
            });
        });
    });
    // ---------------------------------------------------------------------------
    // POST /v1/integrations/api/uploads/sessions/:sessionId/parts/:partIndex/presign
    // ---------------------------------------------------------------------------
    app.post("/v1/integrations/api/uploads/sessions/:sessionId/parts/:partIndex/presign", async (req, reply) => {
        if (!(await requireApiKey(req, reply)))
            return;
        if (!requireApiScope(req, reply, "integration.evidence.upload"))
            return;
        const cred = req.apiCredential;
        return runWithApiAudit(req, reply, "multipart.presign", async () => {
            const { sessionId, partIndex } = ParamsSessionAndPart.parse(req.params);
            const body = MultipartPresignApiBodySchema.parse(req.body ?? {});
            const result = await presignStorageUploadPart({
                teamId: cred.teamId,
                sessionId,
                partIndex,
                expiresInSeconds: body.expiresInSeconds,
            });
            if (!result.ok) {
                return sendDenial(req, reply, result.reason);
            }
            return reply.code(200).send({
                uploadUrl: result.uploadUrl,
                method: result.method,
                expiresAt: result.expiresAt,
                partIndex: result.partIndex,
                requestId: req.id ?? null,
            });
        });
    });
    // ---------------------------------------------------------------------------
    // POST /v1/integrations/api/uploads/sessions/:sessionId/multipart/complete
    // ---------------------------------------------------------------------------
    app.post("/v1/integrations/api/uploads/sessions/:sessionId/multipart/complete", async (req, reply) => {
        if (!(await requireApiKey(req, reply)))
            return;
        if (!requireApiScope(req, reply, "integration.evidence.upload"))
            return;
        const cred = req.apiCredential;
        return runWithApiAudit(req, reply, "multipart.complete", async () => {
            const { sessionId } = ParamsSessionId.parse(req.params);
            const body = MultipartCompleteApiBodySchema.parse(req.body ?? {});
            const result = await completeStorageMultipart({
                teamId: cred.teamId,
                sessionId,
                verifyHash: body.verifyHash ?? false,
            });
            if (!result.ok) {
                return sendDenial(req, reply, result.reason, result.missingEtags ? { missingPartIndices: result.missingEtags } : undefined);
            }
            return reply.code(200).send({
                etag: result.etag,
                contentLength: result.contentLength,
                serverSha256: result.serverSha256,
                requestId: req.id ?? null,
            });
        });
    });
    // ---------------------------------------------------------------------------
    // POST /v1/integrations/api/uploads/sessions/:sessionId/multipart/abort
    // ---------------------------------------------------------------------------
    app.post("/v1/integrations/api/uploads/sessions/:sessionId/multipart/abort", async (req, reply) => {
        if (!(await requireApiKey(req, reply)))
            return;
        if (!requireApiScope(req, reply, "integration.evidence.upload"))
            return;
        const cred = req.apiCredential;
        return runWithApiAudit(req, reply, "multipart.abort", async () => {
            const { sessionId } = ParamsSessionId.parse(req.params);
            const body = AbortBodySchema.parse(req.body ?? {});
            const result = await abortStorageMultipart({
                teamId: cred.teamId,
                sessionId,
                actorUserId: cred.credentialId,
                reason: body.reason,
            });
            if (!result.ok) {
                return sendDenial(req, reply, result.reason);
            }
            return reply.code(200).send({
                aborted: true,
                alreadyAbsent: result.alreadyAbsent,
                requestId: req.id ?? null,
            });
        });
    });
}
