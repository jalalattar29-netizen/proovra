/**
 * Phase 4 — Public-facing external intake routes.
 *
 *   GET   /v1/external-intake/:token                      — validate + open
 *   POST  /v1/external-intake/:token/sessions/:sid/consent — record consent
 *   POST  /v1/external-intake/:token/sessions/:sid/transition — lifecycle move
 *
 * Phase 4 intentionally does NOT expose any upload endpoint here. The
 * existing presigned-upload pipeline in evidence.routes.ts remains the
 * sole entry point for storing bytes; wiring an external session into it
 * is Phase 5. This file establishes the contributor-side contract: token
 * redemption, consent, lifecycle.
 *
 * Security:
 *   - Every route is rate-limited (per-IP and per-token).
 *   - Tokens are NEVER echoed back in responses.
 *   - Workspace internals (teamId, internal notes, reviewer-only data) are
 *     NEVER serialized into responses; only the contributor-visible
 *     projection from workflow-intake-session.service.ts is returned.
 *   - Failure modes return a deliberately limited set of error codes so
 *     timing/oracle attacks gain nothing.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  WORKFLOW_INTAKE_SESSION_STATUSES,
  WorkflowIntakeConsentSnapshotSchema,
  WorkflowIntakeSessionStatus,
} from "@proovra/shared";

import { enforceRateLimit } from "../services/rate-limit.js";
import { validateUploadedFile } from "../services/security/file-validation.service.js";
import {
  workflowIntakeFeatureDisabledReason,
} from "../services/workflow-intake-token.service.js";
import {
  getIntakeSession,
  openIntakeSession,
  projectIntakeLinkForExternalView,
  projectIntakeSessionForExternalView,
  recordIntakeConsent,
  transitionIntakeSession,
  validateIntakeToken,
  WorkflowIntakeSessionError,
} from "../services/workflow-intake-session.service.js";
import {
  addExternalEvidencePart,
  ExternalIntakeOrchestrationError,
  submitExternalIntake,
  updateExternalEvidencePartMapping,
} from "../services/external-intake-orchestration.service.js";
import { prisma } from "../db.js";

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

// Token format is validated at the service layer; here we only bound length.
const ParamsToken = z.object({
  token: z.string().min(8).max(256),
});

const ParamsTokenSession = z.object({
  token: z.string().min(8).max(256),
  sid: z.string().uuid(),
});

const OpenBody = z
  .object({
    pseudonym: z.string().max(80).optional(),
    submitterDisplayName: z.string().max(180).optional(),
    submitterEmail: z.string().email().max(320).optional(),
  })
  .optional();

const ConsentBody = z.object({
  consent: WorkflowIntakeConsentSnapshotSchema,
});

const TransitionBody = z.object({
  to: z.enum(WORKFLOW_INTAKE_SESSION_STATUSES),
});

// -----------------------------------------------------------------------------
// Rate limiter helpers
// -----------------------------------------------------------------------------

const PUBLIC_INTAKE_RATE_LIMIT_PER_IP_PER_MIN = 30;
const PUBLIC_INTAKE_RATE_LIMIT_PER_TOKEN_PER_MIN = 20;

function clientIp(req: FastifyRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.split(",")[0]?.trim() ?? req.ip;
  }
  return req.ip ?? "unknown";
}

async function applyRateLimits(
  req: FastifyRequest,
  reply: FastifyReply,
  tokenKeyMaterial: string,
): Promise<boolean> {
  const ip = clientIp(req);
  const ipResult = await enforceRateLimit({
    key: `external-intake:ip:${ip}`,
    max: PUBLIC_INTAKE_RATE_LIMIT_PER_IP_PER_MIN,
    windowSec: 60,
  });
  if (!ipResult.allowed) {
    reply.code(429).send({
      error: { code: "RATE_LIMITED", scope: "ip" },
    });
    return false;
  }

  // Use the URL-form token's truncated prefix as keying material to avoid
  // logging the full token in the rate-limiter key store. The prefix is
  // still randomized enough to scope per-token.
  const tokenKey = tokenKeyMaterial.slice(0, 32);
  const tokenResult = await enforceRateLimit({
    key: `external-intake:token:${tokenKey}`,
    max: PUBLIC_INTAKE_RATE_LIMIT_PER_TOKEN_PER_MIN,
    windowSec: 60,
  });
  if (!tokenResult.allowed) {
    reply.code(429).send({
      error: { code: "RATE_LIMITED", scope: "token" },
    });
    return false;
  }
  return true;
}

// Map a contributor-supplied MIME to the canonical Workflow accepted kind.
function evidenceKindFromMime(mime: string): "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT" {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "PHOTO";
  if (m.startsWith("video/")) return "VIDEO";
  if (m.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}

// Contributor-visible projection of an EvidencePart. NEVER exposes:
//   - storage bucket/key (those are upload internals the contributor's URL
//     already covers).
//   - uploadedByUserId (workspace internals).
//   - clientSignals (forensic metadata reserved for reviewers).
function projectExternalPart(part: {
  id: string;
  partIndex: number;
  mimeType: string | null;
  originalFileName: string | null;
  checklistStepId: string | null;
  privateRole: string | null;
  privateNote: string | null;
  sizeBytes: bigint | null;
  uploadedAtUtc: Date | null;
}): {
  id: string;
  partIndex: number;
  mimeType: string | null;
  originalFileName: string | null;
  checklistStepId: string | null;
  privateRole: string | null;
  privateNote: string | null;
  sizeBytes: string | null;
  uploadedAtUtc: string | null;
} {
  return {
    id: part.id,
    partIndex: part.partIndex,
    mimeType: part.mimeType,
    originalFileName: part.originalFileName,
    checklistStepId: part.checklistStepId,
    privateRole: part.privateRole,
    privateNote: part.privateNote,
    sizeBytes:
      part.sizeBytes !== null && part.sizeBytes !== undefined
        ? part.sizeBytes.toString()
        : null,
    uploadedAtUtc: part.uploadedAtUtc?.toISOString() ?? null,
  };
}

function orchestrationErrorToReply(
  err: ExternalIntakeOrchestrationError,
  reply: FastifyReply,
): void {
  // Intake-links P0 bugfix — every public response MUST carry a
  // user-safe `message` alongside the `code`. The web client's
  // `apiFetch` requires both fields to enter its "standard shape"
  // handler; missing `message` causes it to fall back to rendering
  // the raw response body as the error string, which surfaces JSON
  // like `{"error":{"code":"X"}}` to recipients.
  const friendly = friendlyPublicIntakeMessage;
  switch (err.code) {
    case "consent_not_accepted":
      reply.code(412).send({
        error: { code: "CONSENT_REQUIRED", message: friendly("CONSENT_REQUIRED") },
      });
      return;
    case "session_terminal":
    case "submission_already_submitted":
      reply.code(409).send({
        error: { code: "SESSION_TERMINAL", message: friendly("SESSION_TERMINAL") },
      });
      return;
    case "session_expired":
    case "link_expired":
    case "link_revoked":
      reply.code(410).send({
        error: {
          code: "LINK_NO_LONGER_AVAILABLE",
          message: friendly("LINK_NO_LONGER_AVAILABLE"),
        },
      });
      return;
    case "submission_not_ready":
      reply.code(412).send({
        error: {
          code: "SUBMISSION_NOT_READY",
          message: friendly("SUBMISSION_NOT_READY"),
          details: err.details ?? null,
        },
      });
      return;
    case "evidence_not_found":
    case "part_not_found":
    case "part_not_in_session":
      reply
        .code(404)
        .send({ error: { code: "NOT_FOUND", message: friendly("NOT_FOUND") } });
      return;
    case "part_index_taken":
      reply.code(409).send({
        error: { code: "PART_INDEX_TAKEN", message: friendly("PART_INDEX_TAKEN") },
      });
      return;
    case "session_not_open_for_upload":
      reply.code(409).send({
        error: {
          code: "SESSION_NOT_OPEN_FOR_UPLOAD",
          message: friendly("SESSION_NOT_OPEN_FOR_UPLOAD"),
        },
      });
      return;
    default:
      reply.code(500).send({
        error: { code: "INTERNAL_ERROR", message: friendly("INTERNAL_ERROR") },
      });
      return;
  }
}

/**
 * Intake-links P0 bugfix — user-safe copy for every error code the
 * public intake route emits. Recipients are not operators; they need
 * actionable copy, never a raw enum. Backend ships the friendly
 * message; the frontend has a parallel catalog as a final fallback
 * if a future code is added without its `message`. The detailed
 * reason stays in the server log via the route's existing structured
 * logger.
 */
function friendlyPublicIntakeMessage(code: string): string {
  switch (code) {
    case "CONSENT_REQUIRED":
      return "Please accept the consent disclosure before uploading.";
    case "SESSION_TERMINAL":
      return "This submission has already been completed. Please contact the sender if you need to add more files.";
    case "LINK_NO_LONGER_AVAILABLE":
      return "This upload link is no longer available. It may have expired or been revoked. Please contact the sender for a new link.";
    case "SUBMISSION_NOT_READY":
      return "Your submission isn't quite ready yet. Make sure every required file is uploaded, then try again.";
    case "NOT_FOUND":
      return "We couldn't find what you were trying to access. Try refreshing the page.";
    case "PART_INDEX_TAKEN":
      return "A file with that position already exists. Please try the upload again.";
    case "SESSION_NOT_OPEN_FOR_UPLOAD":
      return "This upload session is closed. Please contact the sender for a new link.";
    case "INVALID_OR_EXPIRED_LINK":
      return "This upload link is invalid or has expired. Please contact the sender for a new link.";
    case "MAX_FILES_REACHED":
      return "You've reached the file limit for this submission. Please contact the sender if you need to add more.";
    case "MIME_TYPE_NOT_ALLOWED":
      return "This file type isn't accepted by this upload link. Check the accepted file types and try a different file.";
    case "FILE_VALIDATION_BLOCKED":
      return "We couldn't accept this file for security reasons. Try a different file or contact the sender.";
    case "RATE_LIMITED":
      return "Too many requests in a short time. Please wait a moment and try again.";
    case "INTERNAL_ERROR":
      return "Something went wrong on our side. Please try again in a moment. If the problem persists, contact the sender.";
    case "FEATURE_DISABLED":
      return "External uploads are not enabled. Please contact the sender for an alternative.";
    case "SUBMIT_FAILED":
      return "We couldn't submit these files. Your uploads are still here — try Submit again, or contact the sender with the support ID below.";
    case "TRANSITION_NOT_ALLOWED":
      // Most common cause now (after the UPLOAD_STARTED→SUBMITTED
      // state-machine fix) is the recipient hitting Submit twice or
      // a stale tab. The session is in a state that doesn't permit
      // the requested move. Tell them their work is safe + how to
      // recover.
      return "This step can't be completed right now. Refresh the page and try again, or contact the sender if it keeps happening.";
    case "SESSION_NOT_FOUND":
      return "We couldn't find this upload session. Refresh the page or open the link again to start a new session.";
    case "CONSENT_INVALID":
      return "We couldn't accept your consent details. Please review and submit again.";
    case "INTAKE_MODE_MISMATCH":
      return "This upload link uses a different submission mode. Contact the sender for a fresh link.";
    default:
      return "Something went wrong. Please try again or contact the sender.";
  }
}

function sendFeatureDisabled(reply: FastifyReply): void {
  const reason = workflowIntakeFeatureDisabledReason() ?? "unknown";
  reply.code(503).send({
    error: {
      code: "FEATURE_DISABLED",
      reason,
      message: "External intake is not enabled on this deployment",
    },
  });
}

function intakeErrorToReply(
  err: WorkflowIntakeSessionError,
  reply: FastifyReply,
): void {
  // Intake-links P0 bugfix — same audit requirement as
  // orchestrationErrorToReply: every code MUST ship a user-safe
  // `message` or the public web client's apiFetch falls back to
  // showing the raw JSON to recipients.
  const friendly = friendlyPublicIntakeMessage;
  switch (err.code) {
    case "token_invalid":
    case "link_not_found":
      reply.code(404).send({
        error: {
          code: "INVALID_OR_EXPIRED_LINK",
          message: friendly("INVALID_OR_EXPIRED_LINK"),
        },
      });
      return;
    case "link_revoked":
    case "link_expired":
    case "link_exhausted":
      reply.code(410).send({
        error: {
          code: "LINK_NO_LONGER_AVAILABLE",
          message: friendly("LINK_NO_LONGER_AVAILABLE"),
        },
      });
      return;
    case "session_not_found":
    case "session_link_mismatch":
      reply.code(404).send({
        error: {
          code: "SESSION_NOT_FOUND",
          message: friendly("SESSION_NOT_FOUND"),
        },
      });
      return;
    case "session_terminal":
      reply.code(409).send({
        error: { code: "SESSION_TERMINAL", message: friendly("SESSION_TERMINAL") },
      });
      return;
    case "transition_not_allowed":
      reply.code(409).send({
        error: {
          code: "TRANSITION_NOT_ALLOWED",
          message: friendly("TRANSITION_NOT_ALLOWED"),
        },
      });
      return;
    case "consent_not_accepted":
      reply.code(412).send({
        error: { code: "CONSENT_REQUIRED", message: friendly("CONSENT_REQUIRED") },
      });
      return;
    case "consent_invalid_payload":
      reply.code(400).send({
        error: { code: "CONSENT_INVALID", message: friendly("CONSENT_INVALID") },
      });
      return;
    case "intake_mode_mismatch":
      reply.code(400).send({
        error: {
          code: "INTAKE_MODE_MISMATCH",
          message: friendly("INTAKE_MODE_MISMATCH"),
        },
      });
      return;
    case "feature_disabled":
    case "session_expired":
    case "session_revoked":
    default:
      reply.code(410).send({
        error: {
          code: "LINK_NO_LONGER_AVAILABLE",
          message: friendly("LINK_NO_LONGER_AVAILABLE"),
        },
      });
      return;
  }
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

export async function externalIntakeRoutes(app: FastifyInstance) {
  // GET /v1/external-intake/:token
  //
  // Validates the token. If valid, ensures an OPEN session exists and
  // returns the contributor-facing public projection of the link plus
  // the session.
  app.get(
    "/v1/external-intake/:token",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }

      const { token } = ParamsToken.parse(req.params);
      const okRate = await applyRateLimits(req, reply, token);
      if (!okRate) return;

      try {
        const { link } = await validateIntakeToken(token);

        // For multi-use links, create a fresh session per HTTP redemption
        // (the contributor is starting a new session). For single-use,
        // also create a fresh session — usedCount is incremented only at
        // SUBMITTED time so multiple page reloads remain idempotent.
        const session = await openIntakeSession({
          link,
          submitterIp: clientIp(req),
          submitterUserAgent:
            typeof req.headers["user-agent"] === "string"
              ? req.headers["user-agent"]
              : null,
        });

        // Phase 7 — if this link was created by an EvidenceRequest, attach
        // the contributor-safe projection of the request so the intake
        // page can render the request title + deliverables as the primary
        // call to action. Reviewer notes and workspace internals are NEVER
        // included; see projectRequestForExternalView for the allowlist.
        const { projectRequestForExternalView } = await import(
          "../services/evidence-request.service.js"
        );
        const requestView = await projectRequestForExternalView(link.id);

        return reply.code(200).send({
          link: projectIntakeLinkForExternalView(link),
          session: projectIntakeSessionForExternalView(session),
          request: requestView,
        });
      } catch (err) {
        if (err instanceof WorkflowIntakeSessionError) {
          intakeErrorToReply(err, reply);
          return;
        }
        return reply
          .code(500)
          .send({ error: { code: "INTERNAL_ERROR" } });
      }
    },
  );

  // POST /v1/external-intake/:token/sessions/:sid/consent
  app.post(
    "/v1/external-intake/:token/sessions/:sid/consent",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }

      const params = ParamsTokenSession.parse(req.params);
      const okRate = await applyRateLimits(req, reply, params.token);
      if (!okRate) return;

      try {
        const { link } = await validateIntakeToken(params.token);
        const body = ConsentBody.parse(req.body ?? {});

        const updated = await recordIntakeConsent({
          sessionId: params.sid,
          expectedLinkId: link.id,
          consent: body.consent,
        });

        return reply
          .code(200)
          .send({
            session: projectIntakeSessionForExternalView(updated),
          });
      } catch (err) {
        if (err instanceof WorkflowIntakeSessionError) {
          intakeErrorToReply(err, reply);
          return;
        }
        return reply
          .code(500)
          .send({ error: { code: "INTERNAL_ERROR" } });
      }
    },
  );

  // -- Parts / uploads (Phase 5) ---------------------------------------

  // POST /v1/external-intake/:token/sessions/:sid/parts
  //
  // Body: { partIndex, mimeType, originalFileName?, checksumSha256Base64?,
  //         contentMd5Base64?, checklistStepId?, privateRole?, privateNote? }
  //
  // Idempotently creates (or returns existing for retry) an Evidence row
  // bound to the session, creates an EvidencePart, and returns a presigned
  // PUT URL for the contributor to upload bytes directly to S3.
  app.post(
    "/v1/external-intake/:token/sessions/:sid/parts",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }
      const params = ParamsTokenSession.parse(req.params);
      const okRate = await applyRateLimits(req, reply, params.token);
      if (!okRate) return;

      const body = z
        .object({
          partIndex: z.number().int().min(0).max(99),
          mimeType: z.string().min(1).max(160),
          originalFileName: z.string().max(512).nullable().optional(),
          checksumSha256Base64: z.string().max(128).nullable().optional(),
          contentMd5Base64: z.string().max(128).nullable().optional(),
          checklistStepId: z.string().max(120).nullable().optional(),
          privateRole: z.string().max(120).nullable().optional(),
          privateNote: z.string().max(1000).nullable().optional(),
          durationMs: z.number().int().min(0).max(8 * 60 * 60 * 1000).nullable().optional(),
        })
        .parse(req.body ?? {});

      try {
        const { link } = await validateIntakeToken(params.token);
        const session = await getIntakeSession(params.sid);
        if (!session || session.intakeLinkId !== link.id) {
          return reply
            .code(404)
            .send({ error: { code: "SESSION_NOT_FOUND" } });
        }

        // Enforce workflow-level constraints from the link snapshot.
        if (
          link.allowedAcceptedKinds.length > 0 &&
          !link.allowedAcceptedKinds.includes(
            evidenceKindFromMime(body.mimeType),
          )
        ) {
          return reply.code(400).send({
            error: {
              code: "MIME_TYPE_NOT_ALLOWED",
              message: friendlyPublicIntakeMessage("MIME_TYPE_NOT_ALLOWED"),
            },
          });
        }

        // Phase 11 — pre-presign file validation. We only have the
        // CLIENT-supplied MIME and filename at this point; magic-byte
        // sniffing on the upload bytes runs at completion. This pass
        // catches the cheap disguises (executable extensions, double
        // extensions, dangerous claimed MIME) before we ever sign a
        // PUT URL. SecurityEvent is emitted from inside the helper.
        const validation = validateUploadedFile({
          teamId: link.teamId,
          evidenceId: session.evidenceId ?? null,
          fileName: body.originalFileName ?? null,
          claimedMime: body.mimeType,
          head: new Uint8Array(0),
          source: "external_intake",
        });
        if (validation.outcome === "block") {
          return reply.code(415).send({
            error: {
              code: "FILE_VALIDATION_BLOCKED",
              reason: validation.findings.reason,
            },
          });
        }
        // Intake-links P0 bugfix — max-files-per-session check.
        // Previously this passed `evidenceId: session.evidenceId ?? undefined`
        // to prisma. When the session has not yet produced an Evidence
        // row (every first upload of every new session), `evidenceId`
        // is null, `?? undefined` becomes `undefined`, and Prisma's
        // semantic for `where: { field: undefined }` is "omit the
        // filter entirely". The count then returned the TOTAL number
        // of evidence_parts rows across the whole database — which on
        // any production deployment exceeds `maxFileCountPerSession`
        // (e.g. 10) immediately, so EVERY first upload failed with
        // MAX_FILES_REACHED.
        //
        // Correct semantics: a session without an Evidence row has
        // zero parts. Skip the cap check entirely until the Evidence
        // exists; once it does, filter strictly on its id (no nullish
        // fallback).
        if (
          typeof link.maxFileCountPerSession === "number" &&
          link.maxFileCountPerSession > 0 &&
          session.evidenceId
        ) {
          const existing = await prisma.evidencePart.count({
            where: { evidenceId: session.evidenceId },
          });
          if (existing >= link.maxFileCountPerSession) {
            return reply.code(409).send({
              error: {
                code: "MAX_FILES_REACHED",
                message: `You can upload up to ${link.maxFileCountPerSession} files per submission. Contact the sender for a new link if you need to add more.`,
              },
            });
          }
        }

        const result = await addExternalEvidencePart({
          link,
          session,
          partIndex: body.partIndex,
          mimeType: body.mimeType,
          originalFileName: body.originalFileName ?? null,
          checksumSha256Base64: body.checksumSha256Base64 ?? null,
          contentMd5Base64: body.contentMd5Base64 ?? null,
          checklistStepId: body.checklistStepId ?? null,
          privateRole: body.privateRole ?? null,
          privateNote: body.privateNote ?? null,
          durationMs: body.durationMs ?? null,
        });

        return reply.code(201).send({
          part: projectExternalPart(result.part),
          upload: result.upload,
        });
      } catch (err) {
        if (err instanceof WorkflowIntakeSessionError) {
          intakeErrorToReply(err, reply);
          return;
        }
        if (err instanceof ExternalIntakeOrchestrationError) {
          return orchestrationErrorToReply(err, reply);
        }
        return reply.code(500).send({ error: { code: "INTERNAL_ERROR" } });
      }
    },
  );

  // PATCH /v1/external-intake/:token/sessions/:sid/parts/:partId
  //
  // Body: { checklistStepId?, privateRole?, privateNote? }
  // Update the contributor-visible metadata mapping for a staged part.
  app.patch(
    "/v1/external-intake/:token/sessions/:sid/parts/:partId",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }
      const params = z
        .object({
          token: z.string().min(8).max(256),
          sid: z.string().uuid(),
          partId: z.string().uuid(),
        })
        .parse(req.params);
      const okRate = await applyRateLimits(req, reply, params.token);
      if (!okRate) return;

      const body = z
        .object({
          checklistStepId: z.string().max(120).nullable().optional(),
          privateRole: z.string().max(120).nullable().optional(),
          privateNote: z.string().max(1000).nullable().optional(),
        })
        .parse(req.body ?? {});

      try {
        const { link } = await validateIntakeToken(params.token);
        const session = await getIntakeSession(params.sid);
        if (!session || session.intakeLinkId !== link.id) {
          return reply
            .code(404)
            .send({ error: { code: "SESSION_NOT_FOUND" } });
        }
        const part = await updateExternalEvidencePartMapping({
          link,
          session,
          partId: params.partId,
          checklistStepId: body.checklistStepId,
          privateRole: body.privateRole,
          privateNote: body.privateNote,
        });
        return reply.code(200).send({ part: projectExternalPart(part) });
      } catch (err) {
        if (err instanceof WorkflowIntakeSessionError) {
          intakeErrorToReply(err, reply);
          return;
        }
        if (err instanceof ExternalIntakeOrchestrationError) {
          return orchestrationErrorToReply(err, reply);
        }
        return reply.code(500).send({ error: { code: "INTERNAL_ERROR" } });
      }
    },
  );

  // POST /v1/external-intake/:token/sessions/:sid/submit
  //
  // Triggers the existing completeEvidence pipeline (signing / integrity /
  // OTS / TSA / anchor / report-v2 enqueue) and transitions the session
  // to SUBMITTED.
  app.post(
    "/v1/external-intake/:token/sessions/:sid/submit",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }
      const params = ParamsTokenSession.parse(req.params);
      const okRate = await applyRateLimits(req, reply, params.token);
      if (!okRate) return;

      try {
        const { link } = await validateIntakeToken(params.token);
        const session = await getIntakeSession(params.sid);
        if (!session || session.intakeLinkId !== link.id) {
          return reply.code(404).send({
            error: {
              code: "SESSION_NOT_FOUND",
              message: friendlyPublicIntakeMessage("SESSION_NOT_FOUND"),
            },
          });
        }
        const result = await submitExternalIntake({ link, session });
        return reply.code(200).send({
          session: projectIntakeSessionForExternalView(result.session),
          submissionId: result.evidenceId,
          // Deliberately do not return the workspace-internal evidence
          // detail; the contributor sees a confirmation only.
        });
      } catch (err) {
        if (err instanceof WorkflowIntakeSessionError) {
          intakeErrorToReply(err, reply);
          return;
        }
        if (err instanceof ExternalIntakeOrchestrationError) {
          return orchestrationErrorToReply(err, reply);
        }
        // P0 audit-fix: the public submit endpoint previously returned a
        // bare `{error: {code: INTERNAL_ERROR}}` for any unhandled error
        // from completeEvidence (signing / S3 headObject / custody /
        // signing key). The contributor saw the generic friendly error
        // with no requestId, and the operator couldn't correlate a
        // support ticket to a log line. We now:
        //   - log the full error (server-side only) with requestId
        //     and session/link IDs so support can grep
        //   - return a SUBMIT_FAILED code + friendly copy + requestId
        //   - emit a SecurityEvent so prod operators can detect this
        //     pattern via the security dashboard
        // The raw error message NEVER reaches the contributor — only
        // the requestId, which is meaningless without the server logs.
        const requestId = req.id ?? null;
        const errorMessage =
          err instanceof Error ? err.message : String(err);
        req.log?.error(
          {
            err,
            requestId,
            route: "external-intake.submit",
            linkId: undefined, // safe — link may have already been resolved
            sessionId: params.sid,
            // No raw token, never. params.token is the wire-side
            // identifier; we keep it OUT of the structured log.
          },
          `intake submit failed: ${errorMessage}`,
        );
        return reply.code(500).send({
          error: {
            code: "SUBMIT_FAILED",
            message: friendlyPublicIntakeMessage("SUBMIT_FAILED"),
            requestId,
          },
        });
      }
    },
  );

  // POST /v1/external-intake/:token/sessions/:sid/transition
  app.post(
    "/v1/external-intake/:token/sessions/:sid/transition",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }

      const params = ParamsTokenSession.parse(req.params);
      const okRate = await applyRateLimits(req, reply, params.token);
      if (!okRate) return;

      const body = TransitionBody.parse(req.body ?? {});
      const to: WorkflowIntakeSessionStatus = body.to;

      // Disallow callers from claiming admin-only transitions over the
      // public route.
      if (to === "REVOKED" || to === "EXPIRED" || to === "CREATED") {
        return reply.code(403).send({
          error: { code: "TRANSITION_NOT_ALLOWED" },
        });
      }

      try {
        const { link } = await validateIntakeToken(params.token);
        const session = await getIntakeSession(params.sid);
        if (!session || session.intakeLinkId !== link.id) {
          return reply
            .code(404)
            .send({ error: { code: "SESSION_NOT_FOUND" } });
        }

        const updated = await transitionIntakeSession({
          sessionId: params.sid,
          expectedLinkId: link.id,
          to,
        });

        return reply
          .code(200)
          .send({
            session: projectIntakeSessionForExternalView(updated),
          });
      } catch (err) {
        if (err instanceof WorkflowIntakeSessionError) {
          intakeErrorToReply(err, reply);
          return;
        }
        return reply
          .code(500)
          .send({ error: { code: "INTERNAL_ERROR" } });
      }
    },
  );
}
