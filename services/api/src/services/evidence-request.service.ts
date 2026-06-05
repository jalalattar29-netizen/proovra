/**
 * Phase 7 — Evidence Request service.
 *
 * Central, transition-guarded coordinator for the EvidenceRequest domain.
 * Routes are thin Fastify wrappers; all status changes go through this
 * service so the state machine in @proovra/shared is the single source of
 * truth.
 *
 * Reuse statement:
 *   - Workflow-intake-link creation reuses Phase 4
 *     `createWorkflowIntakeLink` — there is no duplicate token/HMAC code.
 *   - The contributor's submission via the bound link reuses the Phase 5
 *     `submitExternalIntake` path entirely; this service only listens for
 *     the resulting Evidence id via `linkResponseFromIntakeSession`.
 *   - Reviewer decisions append `EvidenceRequestEvent` records using the
 *     same event-log pattern as `CaptureSessionEvent` /
 *     `EvidenceReviewWorkflowEvent`. No new audit chain.
 */

import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  EvidenceRequest as DbEvidenceRequest,
  EvidenceRequestDeliverable as DbDeliverable,
  EvidenceRequestResponse as DbResponse,
  WorkflowIntakeLink as DbWorkflowIntakeLink,
  WorkflowIntakeSession as DbWorkflowIntakeSession,
} from "@prisma/client";
import {
  canTransitionEvidenceRequest,
  EvidenceRequestInput,
  EvidenceRequestInputSchema,
  EvidenceRequestStatus,
  isExternalRecipientMode,
  isTerminalEvidenceRequestStatus,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../db.js";
import { createWorkflowIntakeLink } from "./workflow-intake-link.service.js";
import { workflowIntakeFeatureDisabledReason } from "./workflow-intake-token.service.js";
import { safeSendEmailNotification } from "./notifications/index.js";
import { emitWebhookEvent } from "./integrations/webhook-dispatcher.js";
import { getEmailWebBaseUrl } from "./notifications/templates.js";
// Phase 18 — optional SMS/WhatsApp delivery for external recipients.
// Failures are absorbed by `enqueueOutboundMessage` (returns a result
// object; never throws) so the request-send workflow is decoupled from
// message delivery.
import { enqueueOutboundMessage } from "./communications/communication.service.js";
import {
  renderEvidenceRequestSmsBody,
  appendStopFooter,
} from "@proovra/shared";

// -----------------------------------------------------------------------------
// Feature flag — Phase 7.5
//
// Evidence Requests have their own kill switch independent of the workflow
// intake links flag. When disabled, every authenticated /v1/evidence-requests
// and /v1/review/queue route returns 503; the external intake pipeline keeps
// working for non-request links.
// -----------------------------------------------------------------------------

const EVIDENCE_REQUESTS_FLAG_ENV = "EVIDENCE_REQUESTS_ENABLED";

export function isEvidenceRequestsFeatureEnabled(): boolean {
  return process.env[EVIDENCE_REQUESTS_FLAG_ENV] === "true";
}

export function evidenceRequestsFeatureDisabledReason():
  | "feature_flag_off"
  | null {
  return isEvidenceRequestsFeatureEnabled() ? null : "feature_flag_off";
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export type EvidenceRequestErrorCode =
  | "request_not_found"
  | "request_team_mismatch"
  | "request_not_editable"
  | "transition_not_allowed"
  | "request_terminal"
  | "external_recipient_requires_intake"
  | "internal_recipient_requires_assignee"
  | "reviewer_note_required"
  | "intake_disabled"
  | "deliverable_not_found"
  | "deliverable_already_resolved"
  | "response_not_found"
  | "response_already_reviewed";

export class EvidenceRequestError extends Error {
  constructor(
    public readonly code: EvidenceRequestErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "EvidenceRequestError";
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type RequestRow = DbEvidenceRequest & {
  deliverables?: DbDeliverable[];
  responses?: DbResponse[];
};

async function appendRequestEvent(
  client: PrismaClient | Prisma.TransactionClient,
  evidenceRequestId: string,
  eventType: string,
  actorUserId: string | null,
  payload?: Prisma.InputJsonValue,
): Promise<void> {
  await client.evidenceRequestEvent.create({
    data: {
      evidenceRequestId,
      eventType,
      actorUserId,
      payload: payload ?? Prisma.JsonNull,
    },
  });
}

function buildIntakeExpiryFromDueAt(
  dueAtUtc: Date | null | undefined,
  fallbackHours = 14 * 24,
): Date {
  if (dueAtUtc && dueAtUtc.getTime() > Date.now()) {
    return dueAtUtc;
  }
  return new Date(Date.now() + fallbackHours * 3600 * 1000);
}

function mapRecipientModeToIntakeMode(
  recipientMode: string,
):
  | "EXTERNAL_ONE_TIME"
  | "EXTERNAL_REUSABLE"
  | "EXTERNAL_ANONYMOUS"
  | "EXTERNAL_PSEUDONYMOUS" {
  switch (recipientMode) {
    case "EXTERNAL_CONTRIBUTOR":
      return "EXTERNAL_ONE_TIME";
    case "ANONYMOUS_SOURCE":
      return "EXTERNAL_ANONYMOUS";
    case "PSEUDONYMOUS_SOURCE":
      return "EXTERNAL_PSEUDONYMOUS";
    default:
      return "EXTERNAL_ONE_TIME";
  }
}

// -----------------------------------------------------------------------------
// Create
// -----------------------------------------------------------------------------

export type CreateEvidenceRequestContext = {
  actorUserId: string;
};

export type CreateEvidenceRequestResult = {
  request: RequestRow;
  rawToken: string | null;
};

export async function createEvidenceRequest(
  input: EvidenceRequestInput,
  ctx: CreateEvidenceRequestContext,
  client: PrismaClient = defaultPrisma,
): Promise<CreateEvidenceRequestResult> {
  const parsed = EvidenceRequestInputSchema.parse(input);

  return client.$transaction(async (tx) => {
    const created = await tx.evidenceRequest.create({
      data: {
        teamId: parsed.teamId,
        evidenceId: parsed.evidenceId ?? null,
        caseId: parsed.caseId ?? null,
        workflowTemplateSlug: parsed.workflowTemplateSlug ?? null,
        workflowStepId: parsed.workflowStepId ?? null,
        requestType: parsed.requestType,
        title: parsed.title,
        instructions: parsed.instructions ?? "",
        priority: parsed.priority,
        dueAtUtc: parsed.dueAtUtc ? new Date(parsed.dueAtUtc) : null,
        recipientMode: parsed.recipientMode,
        recipientLabel: parsed.recipientLabel ?? null,
        recipientEmail: parsed.recipientEmail ?? null,
        recipientPhone: parsed.recipientPhone ?? null,
        requestedByUserId: ctx.actorUserId,
        assignedReviewerUserId: parsed.assignedReviewerUserId ?? null,
        status: "DRAFT",
      },
    });

    if (parsed.deliverables.length > 0) {
      await tx.evidenceRequestDeliverable.createMany({
        data: parsed.deliverables.map((d, idx) => ({
          evidenceRequestId: created.id,
          title: d.title,
          description: d.description ?? "",
          required: d.required,
          acceptedKinds: d.acceptedKinds,
          minCount: d.minCount,
          maxCount: d.maxCount ?? null,
          locationRequirement: d.locationRequirement,
          captureAfterRequest: d.captureAfterRequest,
          workflowStepId: d.workflowStepId ?? null,
          sortOrder: d.sortOrder ?? idx,
          status: "PENDING" as const,
        })),
      });
    }

    await appendRequestEvent(
      tx,
      created.id,
      "EVIDENCE_REQUEST_CREATED",
      ctx.actorUserId,
      {
        title: created.title,
        requestType: created.requestType,
        recipientMode: created.recipientMode,
        deliverableCount: parsed.deliverables.length,
      } as Prisma.InputJsonValue,
    );

    return {
      request: await loadRequest(tx, created.id),
      rawToken: null,
    };
  }).then(async (result) => {
    // Phase 10 — fire `evidence_request.created`. Best-effort; the
    // dispatcher swallows errors and is feature-flag gated.
    try {
      await emitWebhookEvent({
        teamId: result.request.teamId,
        eventType: "evidence_request.created",
        payload: {
          evidenceRequestId: result.request.id,
          requestType: result.request.requestType,
          title: result.request.title,
          status: result.request.status,
          recipientMode: result.request.recipientMode,
          evidenceId: result.request.evidenceId,
          caseId: result.request.caseId,
        },
        attemptInline: true,
      });
    } catch {
      // ignore
    }
    return result;
  });
}

// -----------------------------------------------------------------------------
// Load
// -----------------------------------------------------------------------------

async function loadRequest(
  client: PrismaClient | Prisma.TransactionClient,
  id: string,
): Promise<RequestRow> {
  const row = await client.evidenceRequest.findUnique({
    where: { id },
    include: {
      deliverables: { orderBy: { sortOrder: "asc" } },
      responses: { orderBy: { submittedAtUtc: "desc" } },
    },
  });
  if (!row) throw new EvidenceRequestError("request_not_found");
  return row;
}

export async function getEvidenceRequest(
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<RequestRow | null> {
  const row = await client.evidenceRequest.findUnique({
    where: { id },
    include: {
      deliverables: { orderBy: { sortOrder: "asc" } },
      responses: { orderBy: { submittedAtUtc: "desc" } },
    },
  });
  return row;
}

// -----------------------------------------------------------------------------
// PATCH (DRAFT-only edit)
//
// Editable while status === DRAFT only. Replaces the deliverable set as a
// whole — caller sends the complete desired list. We do not allow partial
// upserts here because deliverable identity (id) is internal; allowing
// patch-by-id would silently re-add deleted deliverables after a list
// roundtrip.
// -----------------------------------------------------------------------------

export type EditEvidenceRequestInput = {
  title?: string;
  instructions?: string;
  requestType?: string;
  priority?: string;
  dueAtUtc?: string | null;
  assignedReviewerUserId?: string | null;
  recipientMode?: string;
  recipientLabel?: string | null;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  workflowStepId?: string | null;
  workflowTemplateSlug?: string | null;
  deliverables?: Array<{
    title: string;
    description?: string;
    required?: boolean;
    acceptedKinds: string[];
    minCount?: number;
    maxCount?: number | null;
    locationRequirement?: string;
    captureAfterRequest?: boolean;
    workflowStepId?: string | null;
    sortOrder?: number;
  }>;
};

export async function editDraftEvidenceRequest(
  input: {
    id: string;
    teamId: string;
    actorUserId: string;
    patch: EditEvidenceRequestInput;
  },
  client: PrismaClient = defaultPrisma,
): Promise<RequestRow> {
  return client.$transaction(async (tx) => {
    const existing = await tx.evidenceRequest.findUnique({
      where: { id: input.id },
    });
    if (!existing || existing.teamId !== input.teamId) {
      throw new EvidenceRequestError("request_not_found");
    }
    if (existing.status !== "DRAFT") {
      throw new EvidenceRequestError("request_not_editable", {
        currentStatus: existing.status,
      });
    }

    const data: Prisma.EvidenceRequestUpdateInput = {};
    const p = input.patch;
    if (p.title !== undefined) data.title = p.title;
    if (p.instructions !== undefined) data.instructions = p.instructions;
    if (p.requestType !== undefined)
      data.requestType = p.requestType as Prisma.EvidenceRequestUpdateInput["requestType"];
    if (p.priority !== undefined)
      data.priority = p.priority as Prisma.EvidenceRequestUpdateInput["priority"];
    if (p.dueAtUtc !== undefined)
      data.dueAtUtc = p.dueAtUtc ? new Date(p.dueAtUtc) : null;
    if (p.recipientMode !== undefined)
      data.recipientMode = p.recipientMode as Prisma.EvidenceRequestUpdateInput["recipientMode"];
    if (p.recipientLabel !== undefined) data.recipientLabel = p.recipientLabel;
    if (p.recipientEmail !== undefined) data.recipientEmail = p.recipientEmail;
    if (p.recipientPhone !== undefined) data.recipientPhone = p.recipientPhone;
    if (p.workflowStepId !== undefined) data.workflowStepId = p.workflowStepId;
    if (p.workflowTemplateSlug !== undefined)
      data.workflowTemplateSlug = p.workflowTemplateSlug;
    if (p.assignedReviewerUserId !== undefined) {
      data.assignedReviewer = p.assignedReviewerUserId
        ? { connect: { id: p.assignedReviewerUserId } }
        : { disconnect: true };
    }

    await tx.evidenceRequest.update({
      where: { id: input.id },
      data,
    });

    // Deliverables — full replace when provided.
    if (Array.isArray(p.deliverables)) {
      await tx.evidenceRequestDeliverable.deleteMany({
        where: { evidenceRequestId: input.id },
      });
      if (p.deliverables.length > 0) {
        await tx.evidenceRequestDeliverable.createMany({
          data: p.deliverables.map((d, idx) => ({
            evidenceRequestId: input.id,
            title: d.title,
            description: d.description ?? "",
            required: d.required ?? true,
            acceptedKinds: d.acceptedKinds,
            minCount: d.minCount ?? 1,
            maxCount: d.maxCount ?? null,
            locationRequirement: d.locationRequirement ?? "optional",
            captureAfterRequest: d.captureAfterRequest ?? false,
            workflowStepId: d.workflowStepId ?? null,
            sortOrder: d.sortOrder ?? idx,
            status: "PENDING" as const,
          })),
        });
      }
    }

    await appendRequestEvent(
      tx,
      input.id,
      "EVIDENCE_REQUEST_EDITED",
      input.actorUserId,
      {
        changedKeys: Object.keys(p),
        deliverableCount: Array.isArray(p.deliverables)
          ? p.deliverables.length
          : undefined,
      } as Prisma.InputJsonValue,
    );

    return loadRequest(tx, input.id);
  });
}

// -----------------------------------------------------------------------------
// Listing — used by both /v1/evidence-requests and /v1/review/queue
// -----------------------------------------------------------------------------

export type ListEvidenceRequestsInput = {
  teamId: string;
  evidenceId?: string;
  caseId?: string;
  status?: EvidenceRequestStatus;
  assignedReviewerUserId?: string | null;
  unassigned?: boolean;
  limit?: number;
};

export async function listEvidenceRequests(
  input: ListEvidenceRequestsInput,
  client: PrismaClient = defaultPrisma,
): Promise<RequestRow[]> {
  const where: Prisma.EvidenceRequestWhereInput = {
    teamId: input.teamId,
    ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
    ...(input.caseId ? { caseId: input.caseId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.unassigned
      ? { assignedReviewerUserId: null }
      : input.assignedReviewerUserId
        ? { assignedReviewerUserId: input.assignedReviewerUserId }
        : {}),
  };

  return client.evidenceRequest.findMany({
    where,
    include: {
      deliverables: { orderBy: { sortOrder: "asc" } },
      responses: { orderBy: { submittedAtUtc: "desc" } },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    take: Math.min(Math.max(input.limit ?? 50, 1), 200),
  });
}

// -----------------------------------------------------------------------------
// Status transitions
// -----------------------------------------------------------------------------

// Phase 7.5 — these statuses require a reviewer note when reached via
// the transition endpoint. Cancellations and closures often carry
// compliance / accountability significance; we make the note an enforced
// invariant rather than a UI convention so callers can't accidentally
// skip it.
const REQUIRE_REVIEWER_NOTE_ON_TRANSITION: ReadonlyArray<EvidenceRequestStatus> = [
  "NEEDS_MORE_INFO",
  "CANCELLED",
  "CLOSED",
];

export type TransitionEvidenceRequestInput = {
  id: string;
  teamId: string;
  actorUserId: string;
  to: EvidenceRequestStatus;
  reviewerNote?: string | null;
  payload?: Prisma.InputJsonValue;
};

export async function transitionEvidenceRequest(
  input: TransitionEvidenceRequestInput,
  client: PrismaClient = defaultPrisma,
): Promise<RequestRow> {
  return client.$transaction(async (tx) => {
    const existing = await tx.evidenceRequest.findUnique({
      where: { id: input.id },
    });
    if (!existing || existing.teamId !== input.teamId) {
      throw new EvidenceRequestError("request_not_found");
    }

    const transition = canTransitionEvidenceRequest(
      existing.status as EvidenceRequestStatus,
      input.to,
    );
    if (!transition.ok) {
      if (transition.reason === "terminal_from_status") {
        throw new EvidenceRequestError("request_terminal");
      }
      throw new EvidenceRequestError("transition_not_allowed", {
        from: existing.status,
        to: input.to,
        reason: transition.reason,
      });
    }

    // Phase 7.5 — required-note guard. Caller can pass `null` (no note),
    // empty string, or a real note. Real note required for sensitive
    // transitions so the audit log carries justification.
    if (REQUIRE_REVIEWER_NOTE_ON_TRANSITION.includes(input.to)) {
      const note = (input.reviewerNote ?? "").trim();
      if (note.length === 0) {
        throw new EvidenceRequestError("reviewer_note_required", {
          requiredFor: input.to,
        });
      }
    }

    const data: Prisma.EvidenceRequestUpdateInput = {
      status: input.to,
    };
    const now = new Date();

    switch (input.to) {
      case "SENT":
        data.sentAtUtc = now;
        break;
      case "VIEWED":
        if (!existing.firstOpenedAtUtc) data.firstOpenedAtUtc = now;
        break;
      case "CANCELLED":
        data.cancelledAtUtc = now;
        break;
      case "CLOSED":
        data.closedAtUtc = now;
        break;
      case "FULFILLED":
      case "PARTIALLY_FULFILLED":
      case "NEEDS_MORE_INFO":
        data.reviewerDecisionAt = now;
        data.reviewerDecisionBy = { connect: { id: input.actorUserId } };
        if (input.reviewerNote !== undefined) {
          data.reviewerNote = input.reviewerNote ?? null;
        }
        break;
      default:
        break;
    }

    await tx.evidenceRequest.update({
      where: { id: input.id },
      data,
    });

    await appendRequestEvent(
      tx,
      input.id,
      `EVIDENCE_REQUEST_${input.to}`,
      input.actorUserId,
      input.payload,
    );

    return loadRequest(tx, input.id);
  }).then(async (result) => {
    // Phase 8 — fire-and-forget notifications for sensitive transitions.
    // Outside the transaction so a failure here cannot roll back the
    // state change. The reviewer note has already been validated as
    // non-empty by the require-note guard; the renderer treats it as a
    // safe-to-show "context message" (sanitization via escapeEmailHtml
    // in templates.ts).
    try {
      if (input.to === "NEEDS_MORE_INFO" && result.intakeLinkId) {
        const team = await client.team.findUnique({
          where: { id: input.teamId },
          select: { name: true, evidenceWorkspaceLabel: true },
        });
        if (result.recipientEmail) {
          await safeSendEmailNotification(
            {
              eventType: "EVIDENCE_REQUEST_NEEDS_MORE_INFO",
              teamId: input.teamId,
              recipientEmail: result.recipientEmail,
              recipientName: result.recipientLabel ?? null,
              evidenceRequestId: result.id,
              intakeLinkId: result.intakeLinkId,
              initiatedByUserId: input.actorUserId,
              template: {
                kind: "NeedsMoreInfo",
                data: {
                  workspaceName:
                    team?.evidenceWorkspaceLabel ?? team?.name ?? "Your workspace",
                  requestTitle: result.title,
                  // The reviewer note is the operator's safe-to-share
                  // explanation for the additional ask. It is escaped by
                  // the template renderer before going into HTML.
                  contextMessage: input.reviewerNote ?? "",
                  intakeUrl: null,
                },
              },
            },
            client,
          );
        }
      }
    } catch {
      // never abort the transition on notification failure
    }
    return result;
  });
}

// -----------------------------------------------------------------------------
// Send — generate an intake link if external recipient
// -----------------------------------------------------------------------------

export async function sendEvidenceRequest(
  input: { id: string; teamId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<{ request: RequestRow; rawToken: string | null }> {
  const existing = await client.evidenceRequest.findUnique({
    where: { id: input.id },
  });
  if (!existing || existing.teamId !== input.teamId) {
    throw new EvidenceRequestError("request_not_found");
  }
  if (isTerminalEvidenceRequestStatus(existing.status as EvidenceRequestStatus)) {
    throw new EvidenceRequestError("request_terminal");
  }

  // Phase 7.5 — INTERNAL_USER recipients require an assignee. Without one
  // the request has nowhere to land in the review queue, so block the
  // send rather than silently sending into the void.
  if (
    existing.recipientMode === "INTERNAL_USER" &&
    !existing.assignedReviewerUserId
  ) {
    throw new EvidenceRequestError("internal_recipient_requires_assignee");
  }

  // First transition: DRAFT → OPEN (if needed).
  if (existing.status === "DRAFT") {
    await transitionEvidenceRequest(
      { id: input.id, teamId: input.teamId, actorUserId: input.actorUserId, to: "OPEN" },
      client,
    );
  }

  let rawToken: string | null = null;
  let intakeLinkId: string | null = existing.intakeLinkId;

  // External recipient — generate intake link if not already bound. For
  // INTERNAL_USER recipients we deliberately skip token issuance; no
  // public URL is created and `rawToken` stays null.
  if (
    isExternalRecipientMode(existing.recipientMode as "EXTERNAL_CONTRIBUTOR") &&
    !intakeLinkId
  ) {
    if (workflowIntakeFeatureDisabledReason()) {
      throw new EvidenceRequestError("intake_disabled");
    }
    const intakeMode = mapRecipientModeToIntakeMode(existing.recipientMode);
    const result = await createWorkflowIntakeLink(
      {
        teamId: existing.teamId,
        workflowTemplateSlug:
          existing.workflowTemplateSlug ?? "general-evidence-record",
        intakeMode,
        caseId: existing.caseId ?? null,
        recipientLabel: existing.recipientLabel ?? null,
        recipientEmail: existing.recipientEmail ?? null,
        recipientPhone: existing.recipientPhone ?? null,
        maxUses: intakeMode === "EXTERNAL_REUSABLE" ? 100 : 1,
        expiresAtUtc: buildIntakeExpiryFromDueAt(existing.dueAtUtc),
      },
      { actorUserId: input.actorUserId },
      client,
    );
    rawToken = result.rawToken;
    intakeLinkId = result.link.id;

    await client.evidenceRequest.update({
      where: { id: input.id },
      data: { intakeLinkId },
    });

    await appendRequestEvent(
      client,
      input.id,
      "EVIDENCE_REQUEST_LINK_CREATED",
      input.actorUserId,
      { intakeLinkId } as Prisma.InputJsonValue,
    );
  }

  // Mark the request SENT (covers both internal and external).
  await transitionEvidenceRequest(
    { id: input.id, teamId: input.teamId, actorUserId: input.actorUserId, to: "SENT" },
    client,
  );

  // Phase 8 — fire-and-forget notification. Notification failures must
  // never block the workflow; safeSendEmailNotification swallows errors
  // and persists a NotificationDelivery row for the audit trail.
  const finalRequest = await loadRequest(client, input.id);

  const team = await client.team.findUnique({
    where: { id: input.teamId },
    select: { name: true, evidenceWorkspaceLabel: true },
  });
  const workspaceName =
    team?.evidenceWorkspaceLabel ?? team?.name ?? "Your workspace";

  const intakeUrl = rawToken
    ? `${getEmailWebBaseUrl().replace(/\/+$/, "")}/intake/${encodeURIComponent(rawToken)}`
    : null;

  if (isExternalRecipientMode(finalRequest.recipientMode as "EXTERNAL_CONTRIBUTOR")) {
    if (finalRequest.recipientEmail) {
      await safeSendEmailNotification(
        {
          eventType: "EVIDENCE_REQUEST_SENT",
          teamId: input.teamId,
          recipientEmail: finalRequest.recipientEmail,
          recipientName: finalRequest.recipientLabel ?? null,
          evidenceRequestId: finalRequest.id,
          evidenceId: finalRequest.evidenceId ?? null,
          intakeLinkId: finalRequest.intakeLinkId ?? null,
          initiatedByUserId: input.actorUserId,
          template: {
            kind: "EvidenceRequest",
            data: {
              workspaceName,
              requestTitle: finalRequest.title,
              requestInstructions: finalRequest.instructions || null,
              dueAtUtcIso: finalRequest.dueAtUtc?.toISOString() ?? null,
              intakeUrl,
              deliverableSummaries:
                finalRequest.deliverables?.map((d) => ({
                  title: d.title,
                  required: d.required,
                })) ?? [],
            },
          },
        },
        client,
      );
    }
    // Phase 18 — optional SMS/WhatsApp delivery. Only attempted when a
    // phone was provided AND we have an intake URL. The body is a
    // short, operational template that NEVER includes the request
    // title, instructions, or any private context. Provider failures
    // are recorded on the CommunicationMessage row and never propagate
    // back to the request workflow.
    if (finalRequest.recipientPhone && intakeUrl) {
      const body = appendStopFooter(
        renderEvidenceRequestSmsBody({ workspaceName, intakeUrl }),
      );
      await enqueueOutboundMessage(
        {
          teamId: input.teamId,
          channel: "SMS",
          purpose: "EVIDENCE_REQUEST",
          recipientPhone: finalRequest.recipientPhone,
          body,
          sender: "PROOVRA",
          related: {
            evidenceRequestId: finalRequest.id,
            intakeLinkId: finalRequest.intakeLinkId ?? null,
            evidenceId: finalRequest.evidenceId ?? null,
          },
          createdByUserId: input.actorUserId,
        },
        client,
      ).catch(() => null);
    }
  } else if (
    finalRequest.recipientMode === "INTERNAL_USER" &&
    finalRequest.assignedReviewerUserId
  ) {
    const reviewer = await client.user.findUnique({
      where: { id: finalRequest.assignedReviewerUserId },
      select: { email: true, displayName: true, id: true },
    });
    if (reviewer?.email) {
      const requestUrl = finalRequest.evidenceId
        ? `${getEmailWebBaseUrl().replace(/\/+$/, "")}/evidence/${encodeURIComponent(finalRequest.evidenceId)}`
        : `${getEmailWebBaseUrl().replace(/\/+$/, "")}/review`;
      await safeSendEmailNotification(
        {
          eventType: "REVIEW_REQUEST_ASSIGNED",
          teamId: input.teamId,
          recipientEmail: reviewer.email,
          recipientName: reviewer.displayName ?? null,
          recipientUserId: reviewer.id,
          evidenceRequestId: finalRequest.id,
          initiatedByUserId: input.actorUserId,
          template: {
            kind: "ReviewAssigned",
            data: {
              workspaceName,
              requestTitle: finalRequest.title,
              reviewerName: reviewer.displayName ?? null,
              requestUrl,
            },
          },
        },
        client,
      );
    }
  }

  // Phase 6 — fire `evidence_request.sent` after the SENT transition has
  // committed and the recipient notification(s) have been queued. Reuses
  // the SAME canonical dispatcher (`emitWebhookEvent`) — no parallel
  // emitter. Payload carries IDs + non-sensitive transition metadata
  // only; never recipient PII (email / phone) or the raw intake URL.
  // Best-effort: the dispatcher swallows errors and is feature-flag
  // gated, but we also wrap in try/catch so a webhook-layer failure
  // cannot break the SEND lifecycle.
  try {
    await emitWebhookEvent({
      teamId: input.teamId,
      eventType: "evidence_request.sent",
      payload: {
        evidenceRequestId: finalRequest.id,
        requestType: finalRequest.requestType,
        title: finalRequest.title,
        status: finalRequest.status,
        recipientMode: finalRequest.recipientMode,
        evidenceId: finalRequest.evidenceId,
        caseId: finalRequest.caseId,
        intakeLinkId: finalRequest.intakeLinkId,
        sentAtUtc: finalRequest.sentAtUtc?.toISOString() ?? null,
      },
      attemptInline: true,
    });
  } catch {
    // never abort the send on webhook delivery failure
  }

  return {
    request: finalRequest,
    rawToken,
  };
}

// -----------------------------------------------------------------------------
// Link an external intake session's submission to this request as a response
// -----------------------------------------------------------------------------

export async function linkResponseFromIntakeSession(
  params: {
    intakeLinkId: string;
    intakeSession: DbWorkflowIntakeSession;
    evidenceId: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const request = await client.evidenceRequest.findFirst({
    where: { intakeLinkId: params.intakeLinkId },
  });
  if (!request) return; // not request-driven; nothing to do

  await client.$transaction(async (tx) => {
    await tx.evidenceRequestResponse.create({
      data: {
        evidenceRequestId: request.id,
        intakeSessionId: params.intakeSession.id,
        responseEvidenceId: params.evidenceId,
        submittedByUserId: null,
        submittedByExternalLabel:
          params.intakeSession.submitterDisplayName ?? null,
        status: "RECEIVED",
      },
    });

    // Phase 7.5 — proper fulfilment counting across all responses for this
    // request, not just the in-flight submission. We count the number of
    // matching parts per deliverable across every Evidence row already
    // linked to a response (RECEIVED + the one we just created), then
    // compute status from minCount / maxCount.
    const deliverables = await tx.evidenceRequestDeliverable.findMany({
      where: { evidenceRequestId: request.id },
    });
    if (deliverables.length > 0) {
      const allResponses = await tx.evidenceRequestResponse.findMany({
        where: { evidenceRequestId: request.id },
        select: { responseEvidenceId: true },
      });
      const evidenceIds = allResponses
        .map((r) => r.responseEvidenceId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);

      const allParts =
        evidenceIds.length > 0
          ? await tx.evidencePart.findMany({
              where: { evidenceId: { in: evidenceIds } },
              select: { checklistStepId: true },
            })
          : [];

      const stepCount = new Map<string, number>();
      for (const part of allParts) {
        const stepId = part.checklistStepId;
        if (typeof stepId !== "string" || stepId.length === 0) continue;
        stepCount.set(stepId, (stepCount.get(stepId) ?? 0) + 1);
      }

      for (const d of deliverables) {
        // Operator decisions (WAIVED / REJECTED) win over any new
        // submission. Re-opening goes through NEEDS_MORE_INFO + a fresh
        // operator decision.
        if (d.status === "WAIVED" || d.status === "REJECTED") continue;

        const matches = d.workflowStepId
          ? stepCount.get(d.workflowStepId) ?? 0
          : 0;
        // Cap at maxCount when configured. Excess submissions don't
        // overflow the counter into a misleading value.
        const cappedMatches =
          typeof d.maxCount === "number" && d.maxCount > 0
            ? Math.min(matches, d.maxCount)
            : matches;
        const required = Math.max(0, d.minCount);

        let nextStatus: "PENDING" | "PARTIALLY_FULFILLED" | "FULFILLED" =
          "PENDING";
        if (cappedMatches >= required && required > 0) nextStatus = "FULFILLED";
        else if (cappedMatches > 0) nextStatus = "PARTIALLY_FULFILLED";
        else nextStatus = d.status === "PARTIALLY_FULFILLED" ? "PARTIALLY_FULFILLED" : "PENDING";

        await tx.evidenceRequestDeliverable.update({
          where: { id: d.id },
          data: {
            status: nextStatus,
            fulfilledCount: cappedMatches,
          },
        });
      }
    }

    // Move the request forward. RESPONSE_RECEIVED is always emitted; if all
    // required deliverables are fulfilled, additionally advance to
    // FULFILLED (or PARTIALLY_FULFILLED otherwise).
    const refreshed = await tx.evidenceRequestDeliverable.findMany({
      where: { evidenceRequestId: request.id },
    });
    // A required deliverable is "resolved" when it is fulfilled or
    // explicitly waived by an operator. Rejected required deliverables
    // are NOT resolved — they're an outstanding ask that needs more
    // info.
    const requiredRemaining = refreshed.filter(
      (d) =>
        d.required &&
        d.status !== "FULFILLED" &&
        d.status !== "WAIVED",
    );
    const anyFulfilledOrPartial = refreshed.some(
      (d) => d.status === "FULFILLED" || d.status === "PARTIALLY_FULFILLED",
    );

    let toStatus: EvidenceRequestStatus = "RESPONSE_RECEIVED";
    if (refreshed.length > 0) {
      if (requiredRemaining.length === 0) toStatus = "FULFILLED";
      else if (anyFulfilledOrPartial) toStatus = "PARTIALLY_FULFILLED";
    }

    const transitionCheck = canTransitionEvidenceRequest(
      request.status as EvidenceRequestStatus,
      toStatus,
    );
    if (transitionCheck.ok) {
      await tx.evidenceRequest.update({
        where: { id: request.id },
        data: { status: toStatus },
      });
      await appendRequestEvent(
        tx,
        request.id,
        toStatus === "RESPONSE_RECEIVED"
          ? "EVIDENCE_REQUEST_RESPONSE_RECEIVED"
          : toStatus === "FULFILLED"
            ? "EVIDENCE_REQUEST_FULFILLED"
            : "EVIDENCE_REQUEST_PARTIALLY_FULFILLED",
        null,
        {
          intakeSessionId: params.intakeSession.id,
          responseEvidenceId: params.evidenceId,
        } as Prisma.InputJsonValue,
      );
    }
  });

  // Phase 8 — notify the assigned reviewer (or the requester if no
  // reviewer is assigned) outside the transaction so a notification
  // failure cannot roll back the response linkage.
  const refreshed = await client.evidenceRequest.findUnique({
    where: { id: request.id },
  });
  if (!refreshed) return;

  const notifyUserId =
    refreshed.assignedReviewerUserId ?? refreshed.requestedByUserId;
  if (notifyUserId) {
    const user = await client.user.findUnique({
      where: { id: notifyUserId },
      select: { id: true, email: true, displayName: true },
    });
    const team = await client.team.findUnique({
      where: { id: refreshed.teamId },
      select: { name: true, evidenceWorkspaceLabel: true },
    });
    if (user?.email) {
      const evidenceUrl = `${getEmailWebBaseUrl().replace(/\/+$/, "")}/evidence/${encodeURIComponent(params.evidenceId)}`;
      await safeSendEmailNotification(
        {
          eventType: "EVIDENCE_REQUEST_RESPONSE_RECEIVED",
          teamId: refreshed.teamId,
          recipientEmail: user.email,
          recipientName: user.displayName ?? null,
          recipientUserId: user.id,
          evidenceRequestId: refreshed.id,
          evidenceId: params.evidenceId,
          template: {
            kind: "ResponseReceived",
            data: {
              workspaceName:
                team?.evidenceWorkspaceLabel ?? team?.name ?? "Your workspace",
              requestTitle: refreshed.title,
              evidenceUrl,
            },
          },
        },
        client,
      );
    }
  }

  // Phase 6 — fire `evidence_request.response_received` after the
  // response row has been persisted and the deliverable rollup +
  // request-status transition have committed. Reuses the SAME canonical
  // dispatcher. Payload contains IDs + non-sensitive lifecycle metadata
  // only — NEVER the contributor's email, IP, intake token, or any
  // freeform reviewer note.
  try {
    await emitWebhookEvent(
      {
        teamId: refreshed.teamId,
        eventType: "evidence_request.response_received",
        payload: {
          evidenceRequestId: refreshed.id,
          requestType: refreshed.requestType,
          title: refreshed.title,
          status: refreshed.status,
          recipientMode: refreshed.recipientMode,
          evidenceId: params.evidenceId,
          caseId: refreshed.caseId,
          intakeLinkId: refreshed.intakeLinkId,
          intakeSessionId: params.intakeSession.id,
        },
        attemptInline: true,
      },
      client,
    );
  } catch {
    // never abort the link-response flow on webhook delivery failure
  }
}

// -----------------------------------------------------------------------------
// Reviewer decisions on individual responses
// -----------------------------------------------------------------------------

export async function reviewEvidenceRequestResponse(
  input: {
    requestId: string;
    teamId: string;
    responseId: string;
    actorUserId: string;
    status: "UNDER_REVIEW" | "ACCEPTED" | "NEEDS_MORE_INFO" | "REJECTED";
    reviewerNote?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<DbResponse> {
  return client.$transaction(async (tx) => {
    const request = await tx.evidenceRequest.findUnique({
      where: { id: input.requestId },
    });
    if (!request || request.teamId !== input.teamId) {
      throw new EvidenceRequestError("request_not_found");
    }

    const response = await tx.evidenceRequestResponse.findUnique({
      where: { id: input.responseId },
    });
    if (!response || response.evidenceRequestId !== input.requestId) {
      throw new EvidenceRequestError("response_not_found");
    }

    const updated = await tx.evidenceRequestResponse.update({
      where: { id: input.responseId },
      data: {
        status: input.status,
        reviewerNote:
          input.reviewerNote === undefined ? undefined : input.reviewerNote ?? null,
        reviewedAtUtc: new Date(),
        reviewedByUserId: input.actorUserId,
      },
    });

    await appendRequestEvent(
      tx,
      input.requestId,
      input.status === "NEEDS_MORE_INFO"
        ? "EVIDENCE_REQUEST_NEEDS_MORE_INFO"
        : `EVIDENCE_REQUEST_RESPONSE_${input.status}`,
      input.actorUserId,
      {
        responseId: input.responseId,
      } as Prisma.InputJsonValue,
    );

    return updated;
  });
}

// -----------------------------------------------------------------------------
// Waive a deliverable
// -----------------------------------------------------------------------------

export async function waiveDeliverable(
  input: {
    requestId: string;
    teamId: string;
    deliverableId: string;
    actorUserId: string;
    reason?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<DbDeliverable> {
  const request = await client.evidenceRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!request || request.teamId !== input.teamId) {
    throw new EvidenceRequestError("request_not_found");
  }

  const deliverable = await client.evidenceRequestDeliverable.findUnique({
    where: { id: input.deliverableId },
  });
  if (!deliverable || deliverable.evidenceRequestId !== input.requestId) {
    throw new EvidenceRequestError("deliverable_not_found");
  }
  if (deliverable.status === "FULFILLED" || deliverable.status === "WAIVED") {
    throw new EvidenceRequestError("deliverable_already_resolved");
  }

  const updated = await client.evidenceRequestDeliverable.update({
    where: { id: input.deliverableId },
    data: {
      status: "WAIVED",
      waivedReason: input.reason ?? null,
    },
  });

  await appendRequestEvent(
    client,
    input.requestId,
    "EVIDENCE_REQUEST_DELIVERABLE_WAIVED",
    input.actorUserId,
    { deliverableId: input.deliverableId, reason: input.reason ?? null } as Prisma.InputJsonValue,
  );

  return updated;
}

// -----------------------------------------------------------------------------
// Public projection — what the EXTERNAL contributor sees about the request
// when they open /v1/external-intake/:token bound to a request.
//
// Returns ONLY safe fields. Never returns:
//   - reviewer notes
//   - internal status (status code is OK)
//   - recipient email/phone of OTHER recipients
//   - assigned reviewer
//   - request audit log
// -----------------------------------------------------------------------------

export type ExternalRequestPublicView = {
  id: string;
  title: string;
  instructions: string;
  requestType: string;
  /**
   * Phase C3 — request-level status surfaced to the public intake
   * page so the contributor can see when the workspace has explicitly
   * asked for more information (`NEEDS_MORE_INFO`), is reviewing
   * (`UNDER_REVIEW`), or has fulfilled it (`FULFILLED`). This NEVER
   * exposes reviewer notes — only the bounded status enum. Operators
   * never have their internal correspondence leaked to the
   * contributor.
   */
  status: string;
  dueAtUtc: string | null;
  /**
   * Phase C3 — deterministic completion summary computed across all
   * deliverables. Drives the intake progress bar and the
   * review-readiness chip. The contributor sees the same numbers the
   * reviewer sees so expectations stay aligned.
   */
  completion: {
    requiredTotal: number;
    requiredFulfilled: number;
    optionalTotal: number;
    optionalFulfilled: number;
    /** 0-100 integer percentage of all deliverables in FULFILLED or WAIVED state. */
    completionPercent: number;
    /** All REQUIRED deliverables are FULFILLED or WAIVED. */
    reviewReady: boolean;
    /** Request-level `NEEDS_MORE_INFO` — the workspace has asked for more. */
    needsMoreInfo: boolean;
  };
  deliverables: Array<{
    id: string;
    title: string;
    description: string;
    required: boolean;
    acceptedKinds: string[];
    minCount: number;
    maxCount: number | null;
    locationRequirement: string;
    /**
     * Phase C3 — capture guidance flag from the deliverable's template
     * step. When `true`, the workspace expects the contributor to
     * capture fresh evidence rather than upload an existing file.
     */
    captureAfterRequest: boolean;
    workflowStepId: string | null;
    sortOrder: number;
    status: string;
    /**
     * Phase C3 — count of accepted submissions against this
     * deliverable. The intake page renders `fulfilledCount/minCount`
     * (or `fulfilledCount/maxCount` if a maximum is set) so the
     * contributor can see exactly how many files they still owe.
     */
    fulfilledCount: number;
  }>;
};

export async function projectRequestForExternalView(
  intakeLinkId: string,
  client: PrismaClient = defaultPrisma,
): Promise<ExternalRequestPublicView | null> {
  const request = await client.evidenceRequest.findFirst({
    where: { intakeLinkId },
    include: {
      deliverables: { orderBy: { sortOrder: "asc" } },
    },
  });
  if (!request) return null;

  // -----------------------------------------------------------------
  // Phase C3 — deterministic completion summary.
  //
  // Required deliverables in {FULFILLED, WAIVED} count as satisfied.
  // Optional deliverables in {FULFILLED, WAIVED} also count toward
  // overall percent but never block review-readiness.
  // -----------------------------------------------------------------
  const deliverables = request.deliverables ?? [];
  const requiredItems = deliverables.filter((d) => d.required);
  const optionalItems = deliverables.filter((d) => !d.required);
  const isSatisfied = (status: string) =>
    status === "FULFILLED" || status === "WAIVED";
  const requiredFulfilled = requiredItems.filter((d) =>
    isSatisfied(d.status),
  ).length;
  const optionalFulfilled = optionalItems.filter((d) =>
    isSatisfied(d.status),
  ).length;
  const allItems = deliverables.length;
  const allSatisfied = deliverables.filter((d) => isSatisfied(d.status)).length;
  const completionPercent =
    allItems === 0 ? 0 : Math.round((allSatisfied / allItems) * 100);
  const reviewReady =
    requiredItems.length === 0 || requiredFulfilled === requiredItems.length;
  const needsMoreInfo = request.status === "NEEDS_MORE_INFO";

  return {
    id: request.id,
    title: request.title,
    instructions: request.instructions,
    requestType: request.requestType,
    status: request.status,
    dueAtUtc: request.dueAtUtc?.toISOString() ?? null,
    completion: {
      requiredTotal: requiredItems.length,
      requiredFulfilled,
      optionalTotal: optionalItems.length,
      optionalFulfilled,
      completionPercent,
      reviewReady,
      needsMoreInfo,
    },
    deliverables: deliverables.map((d) => ({
      id: d.id,
      title: d.title,
      description: d.description,
      required: d.required,
      acceptedKinds: d.acceptedKinds,
      minCount: d.minCount,
      maxCount: d.maxCount,
      locationRequirement: d.locationRequirement,
      captureAfterRequest: d.captureAfterRequest,
      workflowStepId: d.workflowStepId,
      sortOrder: d.sortOrder,
      status: d.status,
      fulfilledCount: d.fulfilledCount,
    })),
  };
}

// -----------------------------------------------------------------------------
// Authenticated projection — full visibility for workspace members.
// Always strips workspace-internal-only fields where ambiguous.
// -----------------------------------------------------------------------------

export function projectRequestForAuthenticatedView(request: RequestRow): {
  id: string;
  teamId: string;
  evidenceId: string | null;
  caseId: string | null;
  workflowTemplateSlug: string | null;
  workflowStepId: string | null;
  requestType: string;
  status: string;
  priority: string;
  title: string;
  instructions: string;
  dueAtUtc: string | null;
  recipientMode: string;
  recipientLabel: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  requestedByUserId: string;
  assignedReviewerUserId: string | null;
  intakeLinkId: string | null;
  reviewerNote: string | null;
  reviewerDecisionAt: string | null;
  reviewerDecisionByUserId: string | null;
  sentAtUtc: string | null;
  firstOpenedAtUtc: string | null;
  closedAtUtc: string | null;
  cancelledAtUtc: string | null;
  createdAt: string;
  updatedAt: string;
  deliverables: Array<{
    id: string;
    title: string;
    description: string;
    required: boolean;
    acceptedKinds: string[];
    minCount: number;
    maxCount: number | null;
    locationRequirement: string;
    captureAfterRequest: boolean;
    workflowStepId: string | null;
    sortOrder: number;
    status: string;
    waivedReason: string | null;
    fulfilledCount: number;
  }>;
  responses: Array<{
    id: string;
    intakeSessionId: string | null;
    responseEvidenceId: string | null;
    submittedByUserId: string | null;
    submittedByExternalLabel: string | null;
    status: string;
    submittedAtUtc: string;
    reviewedAtUtc: string | null;
    reviewedByUserId: string | null;
    reviewerNote: string | null;
  }>;
} {
  return {
    id: request.id,
    teamId: request.teamId,
    evidenceId: request.evidenceId,
    caseId: request.caseId,
    workflowTemplateSlug: request.workflowTemplateSlug,
    workflowStepId: request.workflowStepId,
    requestType: request.requestType,
    status: request.status,
    priority: request.priority,
    title: request.title,
    instructions: request.instructions,
    dueAtUtc: request.dueAtUtc?.toISOString() ?? null,
    recipientMode: request.recipientMode,
    recipientLabel: request.recipientLabel,
    recipientEmail: request.recipientEmail,
    recipientPhone: request.recipientPhone,
    requestedByUserId: request.requestedByUserId,
    assignedReviewerUserId: request.assignedReviewerUserId,
    intakeLinkId: request.intakeLinkId,
    reviewerNote: request.reviewerNote,
    reviewerDecisionAt: request.reviewerDecisionAt?.toISOString() ?? null,
    reviewerDecisionByUserId: request.reviewerDecisionByUserId,
    sentAtUtc: request.sentAtUtc?.toISOString() ?? null,
    firstOpenedAtUtc: request.firstOpenedAtUtc?.toISOString() ?? null,
    closedAtUtc: request.closedAtUtc?.toISOString() ?? null,
    cancelledAtUtc: request.cancelledAtUtc?.toISOString() ?? null,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    deliverables: (request.deliverables ?? []).map((d) => ({
      id: d.id,
      title: d.title,
      description: d.description,
      required: d.required,
      acceptedKinds: d.acceptedKinds,
      minCount: d.minCount,
      maxCount: d.maxCount,
      locationRequirement: d.locationRequirement,
      captureAfterRequest: d.captureAfterRequest,
      workflowStepId: d.workflowStepId,
      sortOrder: d.sortOrder,
      status: d.status,
      waivedReason: d.waivedReason,
      fulfilledCount: d.fulfilledCount,
    })),
    responses: (request.responses ?? []).map((r) => ({
      id: r.id,
      intakeSessionId: r.intakeSessionId,
      responseEvidenceId: r.responseEvidenceId,
      submittedByUserId: r.submittedByUserId,
      submittedByExternalLabel: r.submittedByExternalLabel,
      status: r.status,
      submittedAtUtc: r.submittedAtUtc.toISOString(),
      reviewedAtUtc: r.reviewedAtUtc?.toISOString() ?? null,
      reviewedByUserId: r.reviewedByUserId,
      reviewerNote: r.reviewerNote,
    })),
  };
}

// -----------------------------------------------------------------------------
// Activity timeline — authenticated only.
// -----------------------------------------------------------------------------

export type EvidenceRequestActivityEvent = {
  id: string;
  eventType: string;
  actorUserId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

export async function listEvidenceRequestEvents(
  requestId: string,
  client: PrismaClient = defaultPrisma,
): Promise<EvidenceRequestActivityEvent[]> {
  const rows = await client.evidenceRequestEvent.findMany({
    where: { evidenceRequestId: requestId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    actorUserId: r.actorUserId,
    // Defensive: the payload column is free-form JSON; cast carefully and
    // never echo it directly to a public surface. The route is authenticated
    // workspace-only, so we trust internal data here.
    payload:
      r.payload && typeof r.payload === "object" && !Array.isArray(r.payload)
        ? (r.payload as Record<string, unknown>)
        : null,
    createdAt: r.createdAt.toISOString(),
  }));
}
