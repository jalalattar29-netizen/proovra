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
 * All routes require authentication + canonical authorization against the
 * request's teamId (ACTIVE membership + org lifecycle + anti-enumeration).
 * PHASE 1 (2026-07-21) made the capability OPERATION-SPECIFIC rather than
 * bare membership: reads → evidence.read; create/send/patch →
 * evidence_request.create; cancel → evidence_request.cancel; close →
 * evidence_request.close; review/needs-info/waive → evidence_request.review;
 * assign → evidence_request.assign. Reviewer notes are visible to holders of
 * evidence.read via the authenticated projection.
 */

import { caseClosedTo, evidenceClosedTo, hiddenRecordIdsInWorkspace } from "../services/access/record-reach.js";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { enforceRateLimit } from "../services/rate-limit.js";
import {
  assertWorkspaceAllowsIntake,
  resolveEnforcementScopeForRequester,
} from "../services/billing-enforcement.service.js";
import {
  EVIDENCE_REQUEST_PRIORITIES,
  EVIDENCE_REQUEST_STATUSES,
  EvidenceRequestInputSchema,
  type Permission,
} from "@proovra/shared";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail, evaluateAuthorize, sendDenyResponse } from "../middleware/authorize.js";
import { resendNotificationDelivery } from "../services/notifications/index.js";
import { intakeLinkPublicUrl } from "../services/intake-link-delivery-dispatcher.service.js";
import { resolveRecipientContactDisclosure } from "../services/privacy/recipient-contact-disclosure.js";
import {
  createEvidenceRequest,
  assignEvidenceRequestReviewer,
  editDraftEvidenceRequest,
  EvidenceRequestError,
  evidenceRequestsFeatureDisabledReason,
  getEvidenceRequest,
  listEvidenceRequestEvents,
  listEvidenceRequests,
  NEEDS_MORE_INFO_CONTRIBUTOR_MESSAGE_MAX,
  NEEDS_MORE_INFO_DELIVERY,
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

/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21, capability-precise) — canonical
 * authorization. Routes through authorizeOrFail (ACTIVE membership + org
 * lifecycle + the OPERATION-SPECIFIC capability + fail-closed +
 * anti-enumeration 404). Reads use `evidence.read` (no `evidence_request.read`
 * exists in the vocabulary; evidence.read is the canonical evidence-domain
 * read every member holds). Mutations use their specific evidence_request.*
 * capability: create/send/patch → create; cancel → cancel; close → close;
 * review/needs-info/waive → review; assign → assign.
 */
async function requireMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
  permission: Permission,
): Promise<{ userId: string } | null> {
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission,
    antiEnumeration: true,
  });
  return outcome ? { userId: outcome.actorUserId } : null;
}

/**
 * A request names a record or a case. One closed to the caller answers exactly
 * like a request that does not exist (AUTHZ-002).
 */
async function requireRequestMember(
  req: FastifyRequest,
  reply: FastifyReply,
  row: { teamId: string; evidenceId: string | null; caseId: string | null },
  permission: Permission,
): Promise<{ userId: string } | null> {
  // A2-19 — the id came from the path, so a request of a workspace the caller
  // cannot enter answers byte-identically to an id that names nothing
  // (`request_not_found`), not with the workspace-level `not_found` body.
  // Other denials (403 capability, 401, 503) keep their canonical bodies: they
  // only describe what the caller may do in a workspace they are in.
  const outcome = await evaluateAuthorize(req, {
    teamId: row.teamId,
    permission,
    antiEnumeration: true,
  });
  if (!outcome.allowed) {
    if (outcome.httpStatus === 404) reply.code(404).send({ error: { code: "request_not_found" } });
    else sendDenyResponse(reply, outcome);
    return null;
  }
  const ok = { userId: outcome.actorUserId };
  const closed =
    (row.evidenceId !== null && (await evidenceClosedTo(row.evidenceId, ok.userId))) ||
    (row.caseId !== null && (await caseClosedTo(row.caseId, ok.userId)));
  if (closed) {
    reply.code(404).send({ error: { code: "request_not_found" } });
    return null;
  }
  return ok;
}

/**
 * A2-07 — every authenticated request projection carries the recipient's
 * contact masked; NEW-RG-19-1 (DEC-14) — for every reader, a holder of
 * `workflow.intake_recipient_contact.reveal` included (they are told they may
 * reveal; the raw values leave only through the audited reveal route).
 * Resolved once per response.
 */
type ProjectableRequest = Parameters<typeof projectRequestForAuthenticatedView>[0];

async function projectRequestsForCaller(
  req: FastifyRequest,
  teamId: string,
  rows: readonly ProjectableRequest[],
) {
  const disclosure = await resolveRecipientContactDisclosure(req, { teamId });
  // PRO-I1-01 — additive: tells a client deployed ahead of this API that the
  // needs-more-info reviewer note is no longer emailed (see the constant).
  return rows.map((row) => ({
    ...projectRequestForAuthenticatedView(row, disclosure),
    needsMoreInfoDelivery: NEEDS_MORE_INFO_DELIVERY,
  }));
}

async function projectRequestForCaller(
  req: FastifyRequest,
  row: ProjectableRequest,
) {
  return (await projectRequestsForCaller(req, row.teamId, [row]))[0]!;
}

function intakeUrlFromToken(rawToken: string | null): string | null {
  if (!rawToken) return null;
  // PRO-PW-04 — THE public intake URL authority, the same one the email and
  // SMS use: absolute with the production default, never `WEB_BASE_URL ?? ""`
  // (a relative link in the API field when the variable was unset).
  return intakeLinkPublicUrl(rawToken);
}

/** PRO-I1-06 — evidence-request sends per actor / workspace (hour) and per recipient (day). */
const EVIDENCE_REQUEST_SENDS_PER_ACTOR_PER_HOUR = 30;
const EVIDENCE_REQUEST_SENDS_PER_WORKSPACE_PER_HOUR = 100;
const EVIDENCE_REQUEST_SENDS_PER_RECIPIENT_PER_DAY = 10;

async function withinEvidenceRequestSendBounds(
  reply: FastifyReply,
  teamId: string,
  actorUserId: string,
  recipientEmail: string | null,
): Promise<boolean> {
  const bounds = [
    { key: `evidence-request-send:actor:${actorUserId}`, max: EVIDENCE_REQUEST_SENDS_PER_ACTOR_PER_HOUR, windowSec: 3600 },
    { key: `evidence-request-send:team:${teamId}`, max: EVIDENCE_REQUEST_SENDS_PER_WORKSPACE_PER_HOUR, windowSec: 3600 },
    ...(recipientEmail
      ? [{
          key: `evidence-request-send:recipient:${createHash("sha256").update(recipientEmail.trim().toLowerCase()).digest("hex").slice(0, 32)}`,
          max: EVIDENCE_REQUEST_SENDS_PER_RECIPIENT_PER_DAY,
          windowSec: 86_400,
        }]
      : []),
  ];
  for (const bound of bounds) {
    const verdict = await enforceRateLimit({ key: bound.key, bound: "global", max: bound.max, windowSec: bound.windowSec });
    if (!verdict.allowed) {
      reply.header("Retry-After", String(Math.max(1, Math.ceil((verdict.resetAtMs - Date.now()) / 1000))));
      if (verdict.store === "unavailable") {
        reply.code(503).send({ error: { code: "temporarily_unavailable" } });
      } else {
        reply.code(429).send({ error: { code: "rate_limited" } });
      }
      return false;
    }
  }
  return true;
}

/** PRO-N1Z-03 — one retryable rule for the contextual list and its retry route. */
function isContextuallyRetryable(
  d: { status: string; templateContextJson: unknown },
  requestStatus: string,
): boolean {
  if (requestStatus === "CANCELLED" || requestStatus === "CLOSED") return false;
  if (d.status === "FAILED" || d.status === "RETRY_SCHEDULED") return true;
  return d.status === "SKIPPED" && d.templateContextJson !== null && typeof d.templateContextJson === "object";
}

function errorToReply(err: EvidenceRequestError, reply: FastifyReply): void {
  switch (err.code) {
    // ET-SEC-33 — a foreign case / evidence answers exactly like a missing one.
    case "request_not_found":
    case "deliverable_not_found":
    case "response_not_found":
    case "case_not_in_workspace":
    case "evidence_not_in_workspace":
      reply.code(404).send({ error: { code: err.code } });
      return;
    case "request_team_mismatch":
      reply.code(403).send({ error: { code: err.code } });
      return;
    case "assignee_not_workspace_member":
      sendAssigneeNotMember(reply);
      return;
    // Members re-audit B3 — the one assignee authority refused the reviewer
    // (the same codes every reviewer-assignment writer answers with).
    case "assignee_not_placed":
      reply.code(422).send({ error: { code: "REVIEW_ASSIGNEE_NOT_PLACED" } });
      return;
    case "assignee_not_eligible":
      reply.code(422).send({ error: { code: "REVIEW_ASSIGNEE_NOT_ELIGIBLE" } });
      return;
    // ET-INT-07 — the intake-link mint gate refused.
    case "intake_not_included":
      reply.code(409).send({ error: { code: err.code } });
      return;
    case "commercial_lifecycle_restricted":
      reply.code(402).send({ error: { code: err.code } });
      return;
    case "intake_blocked_by_policy":
      reply.code(403).send({ error: { code: err.code, details: err.details } });
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

/** The reviewer's justification for a transition that requires one. */
const TransitionNoteBody = z.object({
  reviewerNote: z.string().max(4000).nullable().optional(),
});

/**
 * K3 (2026-09-16) — a request may only name a reviewer who belongs to ITS
 * workspace. `POST /:id/assign` enforced this; create and PATCH wrote the
 * client-supplied id unchecked, so a request in one workspace could name
 * another tenant's user — and sending an INTERNAL_USER request emails that
 * reviewer the request title and a link. Same rule as `/assign`.
 */
async function assigneeBelongsToWorkspace(
  teamId: string,
  assignedReviewerUserId: string | null | undefined,
): Promise<boolean> {
  if (!assignedReviewerUserId) return true;
  const target = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId: assignedReviewerUserId } },
    select: { status: true },
  });
  // D36 — a suspended or revoked member cannot be handed a request (and
  // would be emailed its title and link on send).
  return target?.status === "ACTIVE";
}

/** D36 — a cancelled or closed request is finished; it takes no assignee. */
const UNASSIGNABLE_REQUEST_STATUSES: ReadonlySet<string> = new Set(["CANCELLED", "CLOSED"]);

function sendAssigneeNotMember(reply: FastifyReply): void {
  reply.code(400).send({
    error: {
      code: "assignee_not_workspace_member",
      message: "Assigned reviewer must be a member of the workspace.",
    },
  });
}

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
      const ok = await requireMember(req, reply, body.teamId, "evidence_request.create");
      if (!ok) return;
      // Secure-intake plan gate (2026-07-15) — submission requests are
      // excluded from FREE per the Pricing contract. Enforced before any
      // DB write; a known plan restriction, never a generic failure.
      {
        const scope = await resolveEnforcementScopeForRequester({
          ownerUserId: ok.userId,
          teamId: body.teamId,
        });
        try {
          await assertWorkspaceAllowsIntake(scope);
        } catch (err) {
          const e = err as { statusCode?: number; code?: string; message?: string };
          // B3B-F-108 — a lapsed workspace's lifecycle refusal is a known plan
          // answer too (402, as the intake-link mint gate maps it), never a
          // rethrow to the generic error handler.
          if (e?.code === "INTAKE_NOT_INCLUDED" || e?.code === "COMMERCIAL_LIFECYCLE_RESTRICTED") {
            return reply
              .code(e.statusCode ?? (e.code === "INTAKE_NOT_INCLUDED" ? 409 : 402))
              .send({ error: { code: e.code, message: e.message } });
          }
          throw err;
        }
      }

      if (!(await assigneeBelongsToWorkspace(body.teamId, body.assignedReviewerUserId))) {
        return sendAssigneeNotMember(reply);
      }

      const bodyRef = body as { evidenceId?: string | null; caseId?: string | null };
      // A2-19 — a closed record or case answers with the byte-identical 404 a
      // foreign or missing id gets from the service (ET-SEC-33), so the body
      // reveals neither the restricted flag nor which workspace holds the id
      // (the same answer the key-authenticated route gives, A2-17).
      // Judged here, right where the service judges foreign/missing ids (after
      // the plan gate and the assignee check), and in the service's order (case
      // first), so no earlier refusal can tell a closed id from a missing one.
      if (bodyRef.caseId && (await caseClosedTo(bodyRef.caseId, ok.userId))) {
        return reply.code(404).send({ error: { code: "case_not_in_workspace" } });
      }
      if (bodyRef.evidenceId && (await evidenceClosedTo(bodyRef.evidenceId, ok.userId))) {
        const caseMissing =
          !!bodyRef.caseId &&
          (await prisma.case.count({ where: { id: bodyRef.caseId, teamId: body.teamId } })) === 0;
        return reply
          .code(404)
          .send({ error: { code: caseMissing ? "case_not_in_workspace" : "evidence_not_in_workspace" } });
      }

      try {
        const result = await createEvidenceRequest(body, {
          actorUserId: ok.userId,
        });
        return reply.code(201).send({
          request: await projectRequestForCaller(req, result.request),
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

      const ok = await requireMember(req, reply, query.teamId, "evidence.read");
      if (!ok) return;

      const rows = await listEvidenceRequests({
        teamId: query.teamId,
        hidden: await hiddenRecordIdsInWorkspace(query.teamId, ok.userId),
        evidenceId: query.evidenceId,
        caseId: query.caseId,
        status: query.status,
        assignedReviewerUserId: query.assignedReviewerUserId,
        unassigned: query.unassigned === "true",
        limit: query.limit,
      });

      return reply.code(200).send({
        requests: await projectRequestsForCaller(req, query.teamId, rows),
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
      const ok = await requireRequestMember(req, reply, row, "evidence.read");
      if (!ok) return;
      return reply.code(200).send({
        request: await projectRequestForCaller(req, row),
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
      // PRO-I1-12 — the delivery routes honour the feature flag like their siblings.
      if (sendFeatureDisabled(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const row = await getEvidenceRequest(id);
      if (!row) return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireRequestMember(req, reply, row, "evidence.read");
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
          templateContextJson: true,
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
          // PRO-N1Z-03 — the resend's OWN eligibility: a SKIPPED row is
          // retryable only when it stored its template; never on a closed request.
          retryable: isContextuallyRetryable(d, row.status),
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
      if (sendFeatureDisabled(reply)) return;
      const params = z
        .object({ id: z.string().uuid(), deliveryId: z.string().uuid() })
        .parse(req.params);
      const row = await getEvidenceRequest(params.id);
      if (!row) return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireRequestMember(req, reply, row, "evidence_request.create");
      if (!ok) return;
      // The delivery must belong to THIS request (cross-workspace /
      // cross-request retries are impossible by construction).
      const delivery = await prisma.notificationDelivery.findFirst({
        where: { id: params.deliveryId, evidenceRequestId: params.id },
        select: { id: true, status: true, templateContextJson: true },
      });
      if (!delivery) {
        return reply.code(404).send({ error: { code: "delivery_not_found" } });
      }
      if (!isContextuallyRetryable(delivery, row.status)) {
        return reply.code(409).send({ error: { code: "not_retryable" } });
      }
      // PRO-N1-14 — bounded like the delivery-log resend.
      const bound = await enforceRateLimit({ key: `notification-resend:delivery:${params.deliveryId}`, bound: "global", max: 3, windowSec: 3600 });
      if (!bound.allowed) {
        reply.header("Retry-After", String(Math.max(1, Math.ceil((bound.resetAtMs - Date.now()) / 1000))));
        return bound.store === "unavailable"
          ? reply.code(503).send({ error: { code: "temporarily_unavailable" } })
          : reply.code(429).send({ error: { code: "rate_limited" } });
      }
      const result = await resendNotificationDelivery({
        id: params.deliveryId,
        teamId: row.teamId,
        actorUserId: ok.userId,
      });
      // PRO-N1Z-03 — every outcome is answered as what it is; only an actual
      // resend is a 200 success.
      switch (result.outcome) {
        case "resent":
          return reply.code(200).send({ ok: true, outcome: result.outcome });
        case "failed_to_dispatch":
          return reply.code(502).send({ ok: false, outcome: result.outcome, error: { code: result.outcome } });
        case "not_found":
          return reply.code(404).send({ ok: false, outcome: result.outcome, error: { code: "delivery_not_found" } });
        default:
          return reply.code(409).send({ ok: false, outcome: result.outcome, error: { code: result.outcome } });
      }
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
      const ok = await requireRequestMember(req, reply, existing, "evidence_request.create");
      if (!ok) return;
      // PRO-I1-06 — a send mails an outside address through the platform's
      // sender with sender-written text. Bounded per actor, per workspace and
      // per recipient (across workspaces), before any link is minted or mail sent.
      if (!(await withinEvidenceRequestSendBounds(reply, existing.teamId, ok.userId, existing.recipientEmail ?? null))) return;

      try {
        const result = await sendEvidenceRequest({
          id,
          teamId: existing.teamId,
          actorUserId: ok.userId,
        });
        return reply.code(200).send({
          request: await projectRequestForCaller(req, result.request),
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
      // K3 (2026-09-16) — the service REQUIRES a justification for CANCELLED
      // (REQUIRE_REVIEWER_NOTE_ON_TRANSITION), but this route never read one,
      // so every cancellation was refused with 422 reviewer_note_required.
      const body = TransitionNoteBody.parse(req.body ?? {});
      const existing = await getEvidenceRequest(id);
      if (!existing)
        return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireRequestMember(req, reply, existing, "evidence_request.cancel");
      if (!ok) return;

      try {
        const row = await transitionEvidenceRequest({
          id,
          teamId: existing.teamId,
          actorUserId: ok.userId,
          to: "CANCELLED",
          reviewerNote: body.reviewerNote ?? null,
          // The justification is kept on the request's event trail.
          payload: { reviewerNote: body.reviewerNote ?? null },
        });
        return reply
          .code(200)
          .send({ request: await projectRequestForCaller(req, row) });
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
      // K3 (2026-09-16) — CLOSED requires a justification; see CANCEL above.
      const body = TransitionNoteBody.parse(req.body ?? {});
      const existing = await getEvidenceRequest(id);
      if (!existing)
        return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireRequestMember(req, reply, existing, "evidence_request.close");
      if (!ok) return;

      try {
        const row = await transitionEvidenceRequest({
          id,
          teamId: existing.teamId,
          actorUserId: ok.userId,
          to: "CLOSED",
          reviewerNote: body.reviewerNote ?? null,
          payload: { reviewerNote: body.reviewerNote ?? null },
        });
        return reply
          .code(200)
          .send({ request: await projectRequestForCaller(req, row) });
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
      // PRO-I1-01 — `reviewerNote` is workspace-internal and optional;
      // `contributorMessage` is the only text the contributor is emailed.
      const body = z
        .object({
          reviewerNote: z.string().max(4000).nullable().optional(),
          contributorMessage: z.string().max(NEEDS_MORE_INFO_CONTRIBUTOR_MESSAGE_MAX).nullable().optional(),
        })
        .parse(req.body ?? {});

      const existing = await getEvidenceRequest(id);
      if (!existing)
        return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireRequestMember(req, reply, existing, "evidence_request.review");
      if (!ok) return;

      try {
        const note = (body.reviewerNote ?? "").trim();
        const contributorMessage = (body.contributorMessage ?? "").trim();
        const row = await transitionEvidenceRequest({
          id,
          teamId: existing.teamId,
          actorUserId: ok.userId,
          to: "NEEDS_MORE_INFO",
          reviewerNote: note.length > 0 ? note : null,
          contributorMessage: contributorMessage.length > 0 ? contributorMessage : null,
          payload: { contributorMessageProvided: contributorMessage.length > 0 },
        });
        return reply
          .code(200)
          .send({ request: await projectRequestForCaller(req, row) });
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
      const ok = await requireRequestMember(req, reply, existing, "evidence_request.review");
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
          /*
           * WHATSAPP IS GONE FROM NEW INTAKE, AND THIS IS NEW INTAKE.
           *
           * A reviewer decision can notify the external contributor, and the
           * "needs more information" branch issues a FRESH intake link to do
           * it. That makes this an intake creation path, and it still accepted
           * WHATSAPP after the retirement removed it from the wizard, from
           * `POST /:id/send` and from `DELIVERY_METHODS` — so the one way left
           * to start a WhatsApp intake conversation was through a reviewer.
           *
           * Historical rows keep rendering as WhatsApp, and the shared Twilio
           * transport that MFA and communications rely on is untouched. Only
           * the ability to CHOOSE it here is removed.
           */
          notifyChannel: z.enum(["SMS"]).optional(),
        })
        .parse(req.body ?? {});

      const existing = await getEvidenceRequest(params.id);
      if (!existing)
        return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireRequestMember(req, reply, existing, "evidence_request.review");
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
          // Request-more issues a NEW intake link — see the note on the
          // decision route above.
          notifyChannel: z.enum(["SMS"]).optional(),
          expiresInHours: z.number().int().min(1).max(24 * 30).optional(),
        })
        .parse(req.body ?? {});

      const existing = await getEvidenceRequest(params.id);
      if (!existing)
        return reply.code(404).send({ error: { code: "request_not_found" } });
      const ok = await requireRequestMember(req, reply, existing, "evidence_request.create");
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
      const ok = await requireRequestMember(req, reply, existing, "evidence_request.create");
      if (!ok) return;

      if (!(await assigneeBelongsToWorkspace(existing.teamId, body.assignedReviewerUserId))) {
        return sendAssigneeNotMember(reply);
      }

      try {
        const row = await editDraftEvidenceRequest({
          id,
          teamId: existing.teamId,
          actorUserId: ok.userId,
          patch: body,
        });
        return reply
          .code(200)
          .send({ request: await projectRequestForCaller(req, row) });
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
      const ok = await requireRequestMember(req, reply, existing, "evidence.read");
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
      const ok = await requireRequestMember(req, reply, existing, "evidence_request.assign");
      if (!ok) return;

      if (UNASSIGNABLE_REQUEST_STATUSES.has(existing.status)) {
        return reply.code(409).send({
          error: {
            code: "request_not_assignable",
            message: "A cancelled or closed request cannot be reassigned.",
          },
        });
      }

      // The target must be an ACTIVE member of the request's workspace (the
      // same rule create and PATCH apply).
      if (!(await assigneeBelongsToWorkspace(existing.teamId, body.assignedReviewerUserId))) {
        return sendAssigneeNotMember(reply);
      }

      // Members re-audit B3 — the reviewer passes the one assignee authority
      // (reviewer permission, reach to the request's record, placement), and
      // the decision, the write and its event are one transaction.
      try {
        const updated = await assignEvidenceRequestReviewer({
          id,
          teamId: existing.teamId,
          actorUserId: ok.userId,
          assignedReviewerUserId: body.assignedReviewerUserId,
        });
        return reply
          .code(200)
          .send({ request: await projectRequestForCaller(req, updated) });
      } catch (err) {
        if (err instanceof EvidenceRequestError) return errorToReply(err, reply);
        throw err;
      }
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

      const ok = await requireMember(req, reply, query.teamId, "evidence.read");
      if (!ok) return;

      const rows = await listEvidenceRequests({
        teamId: query.teamId,
        hidden: await hiddenRecordIdsInWorkspace(query.teamId, ok.userId),
        status: query.status,
        assignedReviewerUserId: query.assignedReviewerUserId,
        unassigned: query.unassigned === "true",
        limit: query.limit,
      });

      const filtered = query.priority
        ? rows.filter((r) => r.priority === query.priority)
        : rows;

      return reply.code(200).send({
        items: await projectRequestsForCaller(req, query.teamId, filtered),
      });
    },
  );
}
