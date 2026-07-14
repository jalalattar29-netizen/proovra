/**
 * Phase 7 — Authenticated routes for the EvidenceRequest domain + review queue.
 *
 *   POST  /v1/evidence-requests                                    — create draft
 *   GET   /v1/evidence-requests                                    — list (filtered)
 *   GET   /v1/evidence-requests/:id                                — fetch one
 *   PATCH /v1/evidence-requests/:id                                — edit (DRAFT only)
 *   POST  /v1/evidence-requests/:id/send                           — send (+ create link)
 *   POST  /v1/evidence-requests/:id/cancel                         — cancel
 *   POST  /v1/evidence-requests/:id/close                          — close
 *   POST  /v1/evidence-requests/:id/needs-more-info                — flag
 *   POST  /v1/evidence-requests/:id/deliverables/:deliverableId/waive
 *   POST  /v1/evidence-requests/:id/responses/:responseId/review
 *
 *   GET   /v1/review/queue                                         — review queue
 *
 * All routes require authentication and workspace membership of the
 * request's teamId. Mutations require role >= MEMBER (any member can
 * create or move a request through review states; the existing /capture
 * uses the same baseline). Reviewer notes are visible to MEMBER+ via the
 * authenticated projection.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  EVIDENCE_REQUEST_PRIORITIES,
  EVIDENCE_REQUEST_STATUSES,
  EvidenceRequestInputSchema,
} from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { resendNotificationDelivery } from "../services/notifications/index.js";
import {
  createEvidenceRequest,
  editDraftEvidenceRequest,
  EvidenceRequestError,
  evidenceRequestsFeatureDisabledReason,
  getEvidenceRequest,
  listEvidenceRequestEvents,
  listEvidenceRequests,
  projectRequestForAuthenticatedView,
  requestMoreEvidenceForResponse,
  reviewEvidenceRequestResponse,
  sendEvidenceRequest,
  transitionEvidenceRequest,
  waiveDeliverable,
} from "../services/evidence-request.service.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function requireMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  const userId = getAuthUserId(req);
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) {
    reply.code(403).send({ message: "Not a member of the workspace" });
    return null;
  }
  return { userId };
}

function intakeUrlFromToken(rawToken: string | null): string | null {
  if (!rawToken) return null;
  const base = process.env.WEB_BASE_URL?.replace(/\/+$/, "") ?? "";
  return `${base}/intake/${encodeURIComponent(rawToken)}`;
}

function errorToReply(err: EvidenceRequestError, reply: FastifyReply): void {
  switch (err.code) {
    case "request_not_found":
    case "deliverable_not_found":
    case "response_not_found":
      reply.code(404).send({ error: { code: err.code } });
      return;
    case "request_team_mismatch":
      reply.code(403).send({ error: { code: err.code } });
      return;
    case "request_not_editable":
    case "request_terminal":
    case "deliverable_already_resolved":
    case "response_already_reviewed":
      reply
        .code(409)
        .send({ error: { code: err.code, details: err.details } });
      return;
    case "reviewer_note_required":
    case "internal_recipient_requires_assignee":
      reply
        .code(422)
        .send({ error: { code: err.code, details: err.details } });
      return;
    case "transition_not_allowed":
      reply.code(409).send({ error: { code: err.code, details: err.details } });
      return;
    case "external_recipient_requires_intake":
    case "intake_disabled":
      reply.code(503).send({ error: { code: err.code } });
      return;
    default:
      reply.code(500).send({ error: { code: "INTERNAL_ERROR" } });
      return;
  }
}

// Phase 7.5 — single feature-flag guard reused by every handler. Returns
// true when the route should short-circuit with 503; false when the
// handler should run.
function sendFeatureDisabled(reply: FastifyReply): boolean {
  const reason = evidenceRequestsFeatureDisabledReason();
  if (!reason) return false;
  reply.code(503).send({
    error: {
      code: "FEATURE_DISABLED",
      reason,
      message: "Evidence Requests are not enabled on this deployment",
    },
  });
  return true;
}

const ParamsId = z.object({ id: z.string().uuid() });

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

export async function evidenceRequestsRoutes(app: FastifyInstance) {
  // CREATE
  app.post(
    "/v1/evidence-requests",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (sendFeatureDisabled(reply)) return;
      const body = EvidenceRequestInputSchema.parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;

      try {
        const result = await createEvidenceRequest(body, {
          actorUserId: ok.userId,
        });
        return reply.code(201).send({
          request: projectRequestForAuthenticatedView(result.request),
        });
      } catch (err) {
        if (err instanceof EvidenceRequestError) return errorToReply(err, reply);
        throw err;
      }
    },
  );

  // LIST
  app.get(
    "/v1/evidence-requests",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (sendFeatureDisabled(reply)) return;
      const query = z
        .object({
          teamId: z.string().uuid(),
          evidenceId: z.string().uuid().optional(),
          caseId: z.string().uuid().optional(),
          status: z.enum(EVIDENCE_REQUEST_STATUSES).optional(),
          assignedReviewerUserId: z.string().uuid().optional(),
          unassigned: z.union([z.literal("true"), z.literal("false")]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});

      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;

      const rows = await listEvidenceRequests({
        teamId: query.teamId,
        evidenceId: query.evidenceId,
        caseId: query.caseId,
        status: query.status,
        assignedReviewerUserId: query.assignedReviewerUserId,
        unassigned: query.unassigned === "true",
        limit: query.limit,
      });

      return reply.code(200).send({
        requests: rows.map(projectRequestForAuthenticatedView),
      });
    },
  );

  // GET ONE
  app.get(
    "/v1/evidence-requests/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (sendFeatureDisabled(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const row = await getEvidenceRequest(id);
      if (!row) return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireMember(req, reply, row.teamId);
      if (!ok) return;
      return reply.code(200).send({
        request: projectRequestForAuthenticatedView(row),
      });
    },
  );

  // ---------------------------------------------------------------------
  // CONTEXTUAL delivery status — the ONLY delivery surface for Personal
  // users and ordinary members: outbound emails for THIS request, safe
  // projection only (status, timestamps, bounded error code). Provider
  // internals, unrelated rows, and cron/retry diagnostics never appear —
  // the global delivery log stays an org-operations surface.
  // ---------------------------------------------------------------------
  app.get(
    "/v1/evidence-requests/:id/deliveries",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const row = await getEvidenceRequest(id);
      if (!row) return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireMember(req, reply, row.teamId);
      if (!ok) return;
      const deliveries = await prisma.notificationDelivery.findMany({
        where: { evidenceRequestId: id },
        select: {
          id: true,
          eventType: true,
          status: true,
          errorCode: true,
          retryCount: true,
          sentAtUtc: true,
          failedAtUtc: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      return reply.code(200).send({
        deliveries: deliveries.map((d) => ({
          id: d.id,
          eventType: d.eventType,
          status: d.status,
          // Bounded, safe reason only — never provider payloads.
          errorCode: d.errorCode ?? null,
          retryCount: d.retryCount,
          lastAttemptAtUtc: (d.failedAtUtc ?? d.sentAtUtc ?? d.createdAt).toISOString(),
          retryable: ["FAILED", "RETRY_SCHEDULED", "SKIPPED"].includes(d.status),
        })),
      });
    },
  );

  // Contextual retry — reuses the existing resend infrastructure with
  // the SAME workflow authorization as the request itself; idempotent
  // (a non-retryable row is rejected) and recorded by the pipeline.
  app.post(
    "/v1/evidence-requests/:id/deliveries/:deliveryId/retry",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().uuid(), deliveryId: z.string().uuid() })
        .parse(req.params);
      const row = await getEvidenceRequest(params.id);
      if (!row) return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireMember(req, reply, row.teamId);
      if (!ok) return;
      // The delivery must belong to THIS request (cross-workspace /
      // cross-request retries are impossible by construction).
      const delivery = await prisma.notificationDelivery.findFirst({
        where: { id: params.deliveryId, evidenceRequestId: params.id },
        select: { id: true, status: true },
      });
      if (!delivery) {
        return reply.code(404).send({ error: { code: "delivery_not_found" } });
      }
      if (!["FAILED", "RETRY_SCHEDULED", "SKIPPED"].includes(delivery.status)) {
        return reply.code(409).send({ error: { code: "not_retryable" } });
      }
      const result = await resendNotificationDelivery({
        id: params.deliveryId,
        teamId: row.teamId,
        actorUserId: ok.userId,
      });
      return reply
        .code(200)
        .send({ ok: true, outcome: result.outcome ?? "resent" });
    },
  );

  // SEND
  app.post(
    "/v1/evidence-requests/:id/send",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (sendFeatureDisabled(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const existing = await getEvidenceRequest(id);
      if (!existing)
        return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireMember(req, reply, existing.teamId);
      if (!ok) return;

      try {
        const result = await sendEvidenceRequest({
          id,
          teamId: existing.teamId,
          actorUserId: ok.userId,
        });
        return reply.code(200).send({
          request: projectRequestForAuthenticatedView(result.request),
          rawToken: result.rawToken,
          intakeUrl: intakeUrlFromToken(result.rawToken),
          warning: result.rawToken
            ? "The intake link is shown exactly once. Capture it now — it is not retrievable later."
            : null,
        });
      } catch (err) {
        if (err instanceof EvidenceRequestError) return errorToReply(err, reply);
        throw err;
      }
    },
  );

  // CANCEL
  app.post(
    "/v1/evidence-requests/:id/cancel",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (sendFeatureDisabled(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const existing = await getEvidenceRequest(id);
      if (!existing)
        return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireMember(req, reply, existing.teamId);
      if (!ok) return;

      try {
        const row = await transitionEvidenceRequest({
          id,
          teamId: existing.teamId,
          actorUserId: ok.userId,
          to: "CANCELLED",
        });
        return reply
          .code(200)
          .send({ request: projectRequestForAuthenticatedView(row) });
      } catch (err) {
        if (err instanceof EvidenceRequestError) return errorToReply(err, reply);
        throw err;
      }
    },
  );

  // CLOSE
  app.post(
    "/v1/evidence-requests/:id/close",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (sendFeatureDisabled(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const existing = await getEvidenceRequest(id);
      if (!existing)
        return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireMember(req, reply, existing.teamId);
      if (!ok) return;

      try {
        const row = await transitionEvidenceRequest({
          id,
          teamId: existing.teamId,
          actorUserId: ok.userId,
          to: "CLOSED",
        });
        return reply
          .code(200)
          .send({ request: projectRequestForAuthenticatedView(row) });
      } catch (err) {
        if (err instanceof EvidenceRequestError) return errorToReply(err, reply);
        throw err;
      }
    },
  );

  // NEEDS MORE INFO
  app.post(
    "/v1/evidence-requests/:id/needs-more-info",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (sendFeatureDisabled(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({ reviewerNote: z.string().max(4000).nullable().optional() })
        .parse(req.body ?? {});

      const existing = await getEvidenceRequest(id);
      if (!existing)
        return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireMember(req, reply, existing.teamId);
      if (!ok) return;

      try {
        const row = await transitionEvidenceRequest({
          id,
          teamId: existing.teamId,
          actorUserId: ok.userId,
          to: "NEEDS_MORE_INFO",
          reviewerNote: body.reviewerNote ?? null,
        });
        return reply
          .code(200)
          .send({ request: projectRequestForAuthenticatedView(row) });
      } catch (err) {
        if (err instanceof EvidenceRequestError) return errorToReply(err, reply);
        throw err;
      }
    },
  );

  // WAIVE DELIVERABLE
  app.post(
    "/v1/evidence-requests/:id/deliverables/:deliverableId/waive",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (sendFeatureDisabled(reply)) return;
      const params = z
        .object({
          id: z.string().uuid(),
          deliverableId: z.string().uuid(),
        })
        .parse(req.params);
      const body = z
        .object({ reason: z.string().max(400).nullable().optional() })
        .parse(req.body ?? {});

      const existing = await getEvidenceRequest(params.id);
      if (!existing)
        return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireMember(req, reply, existing.teamId);
      if (!ok) return;

      try {
        const deliverable = await waiveDeliverable({
          requestId: params.id,
          teamId: existing.teamId,
          deliverableId: params.deliverableId,
          actorUserId: ok.userId,
          reason: body.reason ?? null,
        });
        return reply.code(200).send({ deliverable });
      } catch (err) {
        if (err instanceof EvidenceRequestError) return errorToReply(err, reply);
        throw err;
      }
    },
  );

  // REVIEW RESPONSE
  app.post(
    "/v1/evidence-requests/:id/responses/:responseId/review",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (sendFeatureDisabled(reply)) return;
      const params = z
        .object({
          id: z.string().uuid(),
          responseId: z.string().uuid(),
        })
        .parse(req.params);
      const body = z
        .object({
          status: z.enum(["UNDER_REVIEW", "ACCEPTED", "NEEDS_MORE_INFO", "REJECTED"]),
          reviewerNote: z.string().max(4000).nullable().optional(),
          // Phase IA-intake-completion — optionally notify the external
          // contributor when the reviewer rejects (or requests more
          // information). When true AND the link has a phone, the
          // service queues a templated CommunicationMessage.
          notifyContributor: z.boolean().optional(),
          notifyChannel: z.enum(["SMS", "WHATSAPP"]).optional(),
        })
        .parse(req.body ?? {});

      const existing = await getEvidenceRequest(params.id);
      if (!existing)
        return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireMember(req, reply, existing.teamId);
      if (!ok) return;

      try {
        const response = await reviewEvidenceRequestResponse({
          requestId: params.id,
          teamId: existing.teamId,
          responseId: params.responseId,
          actorUserId: ok.userId,
          status: body.status,
          reviewerNote: body.reviewerNote ?? null,
          notifyContributor: body.notifyContributor ?? false,
          notifyChannel: body.notifyChannel ?? "SMS",
        });
        return reply.code(200).send({ response });
      } catch (err) {
        if (err instanceof EvidenceRequestError) return errorToReply(err, reply);
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Phase IA-intake-completion — Request more evidence by issuing a fresh
  // intake link in the same EvidenceRequest thread. Atomically marks the
  // response NEEDS_MORE_INFO and returns the new link + raw token in the
  // same one-shot reveal shape as `POST /v1/workflow/intake-links`.
  // -------------------------------------------------------------------------
  app.post(
    "/v1/evidence-requests/:id/responses/:responseId/request-more",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (sendFeatureDisabled(reply)) return;
      const params = z
        .object({
          id: z.string().uuid(),
          responseId: z.string().uuid(),
        })
        .parse(req.params);
      const body = z
        .object({
          reviewerNote: z.string().max(4000).nullable().optional(),
          notifyContributor: z.boolean().optional(),
          notifyChannel: z.enum(["SMS", "WHATSAPP"]).optional(),
          expiresInHours: z.number().int().min(1).max(24 * 30).optional(),
        })
        .parse(req.body ?? {});

      const existing = await getEvidenceRequest(params.id);
      if (!existing)
        return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireMember(req, reply, existing.teamId);
      if (!ok) return;

      try {
        const result = await requestMoreEvidenceForResponse({
          requestId: params.id,
          teamId: existing.teamId,
          responseId: params.responseId,
          actorUserId: ok.userId,
          reviewerNote: body.reviewerNote ?? null,
          notifyContributor: body.notifyContributor ?? false,
          notifyChannel: body.notifyChannel ?? "SMS",
          expiresInHours: body.expiresInHours,
        });
        return reply.code(200).send({
          response: result.response,
          newIntakeLinkId: result.newIntakeLinkId,
          rawToken: result.newRawToken,
          communicationMessageId: result.communicationMessageId,
        });
      } catch (err) {
        if (err instanceof EvidenceRequestError) return errorToReply(err, reply);
        throw err;
      }
    },
  );

  // PATCH (DRAFT only)
  app.patch(
    "/v1/evidence-requests/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (sendFeatureDisabled(reply)) return;
      const { id } = ParamsId.parse(req.params);

      const body = z
        .object({
          title: z.string().min(1).max(180).optional(),
          instructions: z.string().max(4000).optional(),
          requestType: z
            .enum([
              "ADDITIONAL_EVIDENCE",
              "CLARIFICATION",
              "REPLACEMENT_FILE",
              "WITNESS_STATEMENT",
              "DOCUMENT",
              "OTHER",
            ])
            .optional(),
          priority: z.enum(EVIDENCE_REQUEST_PRIORITIES).optional(),
          dueAtUtc: z.string().datetime().nullable().optional(),
          assignedReviewerUserId: z.string().uuid().nullable().optional(),
          recipientMode: z
            .enum([
              "INTERNAL_USER",
              "EXTERNAL_CONTRIBUTOR",
              "ANONYMOUS_SOURCE",
              "PSEUDONYMOUS_SOURCE",
            ])
            .optional(),
          recipientLabel: z.string().max(180).nullable().optional(),
          recipientEmail: z.string().email().max(320).nullable().optional(),
          recipientPhone: z.string().max(32).nullable().optional(),
          workflowStepId: z.string().max(120).nullable().optional(),
          workflowTemplateSlug: z.string().max(120).nullable().optional(),
          deliverables: z
            .array(
              z.object({
                title: z.string().min(1).max(180),
                description: z.string().max(2000).optional(),
                required: z.boolean().optional(),
                acceptedKinds: z
                  .array(z.enum(["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"]))
                  .min(1)
                  .max(4),
                minCount: z.number().int().min(0).max(100).optional(),
                maxCount: z.number().int().min(1).max(100).nullable().optional(),
                locationRequirement: z
                  .enum(["required", "recommended", "optional"])
                  .optional(),
                captureAfterRequest: z.boolean().optional(),
                workflowStepId: z.string().max(120).nullable().optional(),
                sortOrder: z.number().int().min(0).max(999).optional(),
              }),
            )
            .max(32)
            .optional(),
        })
        .parse(req.body ?? {});

      const existing = await getEvidenceRequest(id);
      if (!existing)
        return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireMember(req, reply, existing.teamId);
      if (!ok) return;

      try {
        const row = await editDraftEvidenceRequest({
          id,
          teamId: existing.teamId,
          actorUserId: ok.userId,
          patch: body,
        });
        return reply
          .code(200)
          .send({ request: projectRequestForAuthenticatedView(row) });
      } catch (err) {
        if (err instanceof EvidenceRequestError) return errorToReply(err, reply);
        throw err;
      }
    },
  );

  // EVENTS (activity timeline)
  app.get(
    "/v1/evidence-requests/:id/events",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (sendFeatureDisabled(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const existing = await getEvidenceRequest(id);
      if (!existing)
        return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireMember(req, reply, existing.teamId);
      if (!ok) return;

      const events = await listEvidenceRequestEvents(id);
      return reply.code(200).send({ events });
    },
  );

  // ASSIGN REVIEWER (quick action — works in any non-terminal status)
  app.post(
    "/v1/evidence-requests/:id/assign",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (sendFeatureDisabled(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          assignedReviewerUserId: z.string().uuid().nullable(),
        })
        .parse(req.body ?? {});

      const existing = await getEvidenceRequest(id);
      if (!existing)
        return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireMember(req, reply, existing.teamId);
      if (!ok) return;

      // Verify the target is a workspace member (when not null).
      if (body.assignedReviewerUserId) {
        const target = await prisma.teamMember.findUnique({
          where: {
            teamId_userId: {
              teamId: existing.teamId,
              userId: body.assignedReviewerUserId,
            },
          },
        });
        if (!target) {
          return reply.code(400).send({
            error: {
              code: "assignee_not_workspace_member",
              message: "Assigned reviewer must be a member of the workspace.",
            },
          });
        }
      }

      const updated = await prisma.evidenceRequest.update({
        where: { id },
        data: { assignedReviewerUserId: body.assignedReviewerUserId },
        include: {
          deliverables: { orderBy: { sortOrder: "asc" } },
          responses: { orderBy: { submittedAtUtc: "desc" } },
        },
      });

      await prisma.evidenceRequestEvent.create({
        data: {
          evidenceRequestId: id,
          eventType: body.assignedReviewerUserId
            ? "EVIDENCE_REQUEST_ASSIGNED"
            : "EVIDENCE_REQUEST_UNASSIGNED",
          actorUserId: ok.userId,
          payload: {
            assignedReviewerUserId: body.assignedReviewerUserId,
          },
        },
      });

      return reply
        .code(200)
        .send({ request: projectRequestForAuthenticatedView(updated) });
    },
  );

  // REVIEW QUEUE
  app.get(
    "/v1/review/queue",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (sendFeatureDisabled(reply)) return;
      const query = z
        .object({
          teamId: z.string().uuid(),
          status: z.enum(EVIDENCE_REQUEST_STATUSES).optional(),
          priority: z.enum(EVIDENCE_REQUEST_PRIORITIES).optional(),
          assignedReviewerUserId: z.string().uuid().optional(),
          unassigned: z.union([z.literal("true"), z.literal("false")]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});

      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;

      const rows = await listEvidenceRequests({
        teamId: query.teamId,
        status: query.status,
        assignedReviewerUserId: query.assignedReviewerUserId,
        unassigned: query.unassigned === "true",
        limit: query.limit,
      });

      const filtered = query.priority
        ? rows.filter((r) => r.priority === query.priority)
        : rows;

      return reply.code(200).send({
        items: filtered.map(projectRequestForAuthenticatedView),
      });
    },
  );
}
