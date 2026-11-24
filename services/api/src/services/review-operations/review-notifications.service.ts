/**
 * Phase 13.5 — Review-operations notification dispatch.
 *
 * Translates review-workflow events into safe transactional emails to
 * the assigned reviewer. Uses the existing notification infrastructure
 * (`safeSendEmailNotification`) and the `ReviewAssigned` template
 * context — bodies NEVER include internal review notes, rejection
 * reasons, escalation reasons, decision content, or workspace-internal
 * metadata. They are operational ("a review you own has been
 * escalated") and link back to the workspace.
 *
 * Every helper:
 *   - resolves the assignee's email + workspace name
 *   - silently no-ops if any required field is missing
 *   - never throws into the caller (all dispatch goes through
 *     `safeSendEmailNotification`)
 *
 * DELIVERY CONTRACT (remediation verdict, 2026-07-14 — Decision A):
 * these emails are a BEST-EFFORT convenience channel for INTERNAL
 * users. The canonical discovery paths do not depend on them:
 *   - assigned reviews live in the reviewer work queues (/workflows,
 *     reviewer-ops surfaces), which the reviewer reaches without email;
 *   - reviews that actually need attention reach the Bell/Operations
 *     Center through the ESCALATION path (ReviewEscalation → the
 *     `review_escalation` category) and conflict adjudication
 *     (`review_decision`), never through email delivery state.
 * A failed send therefore blocks no work. Delivery failures remain
 * visible to workspace OWNER/ADMIN in the global delivery log
 * (/notifications), which owns retry. We deliberately do NOT surface
 * "your assignment email failed" to the reviewer: they cannot fix
 * SMTP, and the assignment itself is already in their queue.
 */

import type {
  EvidenceReviewWorkflow as DbWorkflow,
  PrismaClient,
} from "@prisma/client";
import {
  absoluteInternalUrl,
  internalNavPath,
  internalResourcePath,
  type NotificationEventType,
} from "@proovra/shared";

/**
 * The workflow fields a review email needs. `id` is optional only for older
 * callers; every in-tree caller passes the row, which carries it.
 */
type NotifiedWorkflow = Pick<DbWorkflow, "evidenceId" | "teamId" | "assignedToUserId"> & { id?: string };

/**
 * TEAM-SPEC §3 (2026-11-23) — where a review email sends the reviewer: the
 * review inspector `/reviewer-ops/<workflowId>`, where the assignment,
 * deadline and decision actions live. It used to open `/evidence/<id>`, the
 * record page, which carries none of them. The ReviewAssigned template has a
 * single link, so the evidence page stays reachable from the inspector
 * ("Open evidence detail"); a workflow without an id falls back to it.
 */
export function reviewEmailLink(workflow: { id?: string | null; evidenceId: string }): string {
  const path = workflow.id
    ? internalNavPath(`/reviewer-ops/${encodeURIComponent(workflow.id)}`)
    : internalResourcePath({ type: "evidence", id: workflow.evidenceId });
  return absoluteInternalUrl(getEmailWebBaseUrl(), path);
}

import { prisma as defaultPrisma } from "../../db.js";
import { safeSendEmailNotification, type NotificationSendResult } from "../notifications/index.js";
import { getEmailWebBaseUrl } from "../notifications/templates.js";
import { evaluateMemberAccess } from "../identity/access-policy.service.js";
import { resolveEvidenceRecordAccess } from "../evidence/evidence-record-access.service.js";

async function resolveAssigneeAndWorkspace(
  workflow: NotifiedWorkflow,
  client: PrismaClient,
): Promise<{
  reviewer: { id: string; email: string; displayName: string | null } | null;
  workspaceName: string;
  reviewUrl: string;
}> {
  let reviewer: {
    id: string;
    email: string;
    displayName: string | null;
  } | null = null;
  if (workflow.assignedToUserId) {
    try {
      const user = await client.user.findUnique({
        where: { id: workflow.assignedToUserId },
        select: { id: true, email: true, displayName: true },
      });
      if (user?.email) {
        reviewer = {
          id: user.id,
          email: user.email,
          displayName: user.displayName ?? null,
        };
      }
    } catch {
      reviewer = null;
    }
  }

  let workspaceName = "Workspace";
  if (workflow.teamId) {
    try {
      const team = await client.team.findUnique({
        where: { id: workflow.teamId },
        select: { name: true },
      });
      if (team?.name) workspaceName = team.name;
    } catch {
      /* keep default */
    }
  }

  // TEAM-SPEC §3 — the review inspector, not the record page (reviewEmailLink).
  const reviewUrl = reviewEmailLink(workflow);

  return { reviewer, workspaceName, reviewUrl };
}

type DispatchKind =
  | { eventType: Extract<NotificationEventType, "REVIEW_REQUEST_ASSIGNED">; isReassignment: false }
  | { eventType: Extract<NotificationEventType, "REVIEW_REASSIGNED">; isReassignment: true }
  | { eventType: Extract<NotificationEventType, "REVIEW_SECOND_REVIEW_ASSIGNED">; isReassignment: true }
  | { eventType: Extract<NotificationEventType, "REVIEW_ESCALATED"> }
  | { eventType: Extract<NotificationEventType, "REVIEW_NEEDS_MORE_INFO"> }
  | { eventType: Extract<NotificationEventType, "REVIEW_RESPONSE_RECEIVED"> }
  | { eventType: Extract<NotificationEventType, "REVIEW_OVERDUE_REMINDER"> }
  | { eventType: Extract<NotificationEventType, "REVIEW_DUE_SOON_REMINDER"> }
  | { eventType: Extract<NotificationEventType, "REVIEW_INACTIVITY_REMINDER"> };

async function dispatchToAssignee(
  workflow: NotifiedWorkflow,
  kind: DispatchKind,
  initiatedByUserId: string | null,
  client: PrismaClient,
): Promise<NotificationSendResult | null> {
  const { reviewer, workspaceName, reviewUrl } =
    await resolveAssigneeAndWorkspace(workflow, client);

  // No assignee → nothing to do. Caller may still want to log an
  // operations event; the notification is just a no-op.
  if (!reviewer) return null;

  return safeSendEmailNotification(
    {
      eventType: kind.eventType,
      teamId: workflow.teamId ?? null,
      recipientEmail: reviewer.email,
      recipientName: reviewer.displayName ?? null,
      recipientUserId: reviewer.id,
      evidenceId: workflow.evidenceId,
      initiatedByUserId: initiatedByUserId ?? null,
      template: {
        kind: "ReviewAssigned",
        data: {
          // The ReviewAssigned context renderer treats requestTitle as
          // the human-readable subject anchor. We use a short
          // evidence-anchored label so the email body stays
          // workspace-only and never echoes private detail.
          workspaceName,
          requestTitle: `Evidence ${workflow.evidenceId.slice(0, 8)}…`,
          reviewerName: reviewer.displayName ?? null,
          requestUrl: reviewUrl,
        },
      },
    },
    client,
  );
}

// -----------------------------------------------------------------------------
// Public API — every function is safe-by-default; failures NEVER throw.
// -----------------------------------------------------------------------------

/** The current round holds a FIRST decision by someone other than the assignee, and no SECOND. */
async function isSecondReviewHandoff(workflow: DbWorkflow, client: PrismaClient): Promise<boolean> {
  if (!workflow.assignedToUserId) return false;
  const rows = await client.workflowReviewDecision.findMany({
    where: { workflowId: workflow.id, round: workflow.decisionRound },
    select: { stage: true, reviewerUserId: true },
  });
  const first = rows.find((r) => r.stage === "FIRST");
  return !!first && first.reviewerUserId !== workflow.assignedToUserId && !rows.some((r) => r.stage !== "FIRST");
}

export async function notifyReviewAssigned(
  input: {
    workflow: DbWorkflow;
    actorUserId: string;
    isReassignment: boolean;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  try {
    // T-159 — a hand-off for the SECOND review tells the new assignee what it
    // is ("Second review assigned to you"), once: the current round holds a
    // FIRST decision by someone else and no SECOND yet.
    const secondReviewHandoff =
      input.isReassignment && (await isSecondReviewHandoff(input.workflow, client).catch(() => false));
    await dispatchToAssignee(
      input.workflow,
      secondReviewHandoff
        ? { eventType: "REVIEW_SECOND_REVIEW_ASSIGNED", isReassignment: true }
        : input.isReassignment
          ? { eventType: "REVIEW_REASSIGNED", isReassignment: true }
          : { eventType: "REVIEW_REQUEST_ASSIGNED", isReassignment: false },
      input.actorUserId,
      client,
    );
  } catch {
    /* swallowed — caller flow is unaffected */
  }
}

export async function notifyReviewEscalated(
  input: { workflow: DbWorkflow; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  try {
    await dispatchToAssignee(
      input.workflow,
      { eventType: "REVIEW_ESCALATED" },
      input.actorUserId,
      client,
    );
  } catch {
    /* swallow */
  }
}

export async function notifyReviewNeedsMoreInfo(
  input: { workflow: DbWorkflow; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  try {
    await dispatchToAssignee(
      input.workflow,
      { eventType: "REVIEW_NEEDS_MORE_INFO" },
      input.actorUserId,
      client,
    );
  } catch {
    /* swallow */
  }
}

export async function notifyReviewResponseReceived(
  input: { workflow: DbWorkflow; actorUserId: string | null },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  try {
    await dispatchToAssignee(
      input.workflow,
      { eventType: "REVIEW_RESPONSE_RECEIVED" },
      input.actorUserId ?? null,
      client,
    );
  } catch {
    /* swallow */
  }
}

/** The reminder engine's send. Reports the outcome, so the row can record it. */
export async function sendReviewReminder(
  input: {
    workflow: NotifiedWorkflow;
    kind: "DUE_SOON" | "REVIEWER_INACTIVE";
  },
  client: PrismaClient = defaultPrisma,
): Promise<NotificationSendResult | null> {
  return dispatchToAssignee(
    input.workflow,
    { eventType: input.kind === "DUE_SOON" ? "REVIEW_DUE_SOON_REMINDER" : "REVIEW_INACTIVITY_REMINDER" },
    null,
    client,
  );
}

export async function notifyReviewSlaBreached(
  input: { workflow: DbWorkflow },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  try {
    await dispatchToAssignee(
      input.workflow,
      { eventType: "REVIEW_OVERDUE_REMINDER" },
      null,
      client,
    );
  } catch {
    /* swallow */
  }
}

// -----------------------------------------------------------------------------
// TEAM-SPEC R3 (2026-11-23) — second-review handoff.
// -----------------------------------------------------------------------------

/**
 * The workspace's ASSIGNMENT MANAGERS for one review: ACTIVE members holding
 * `review.assign` (the permission the reassign route requires) who can also
 * open the record (a restricted case keeps its own list), minus `excludeUserId`
 * — the first reviewer, who may never hand the second review to themselves.
 * Read through the same policy engine the routes use, so a delegated grant
 * counts and a suspended member does not.
 */
export async function listReviewAssignmentManagers(
  input: { teamId: string; evidenceId: string; excludeUserIds: ReadonlyArray<string> },
  client: PrismaClient = defaultPrisma,
): Promise<Array<{ id: string; email: string | null; displayName: string | null }>> {
  const members = await client.teamMember.findMany({
    where: { teamId: input.teamId, status: "ACTIVE", userId: { notIn: [...input.excludeUserIds] } },
    select: { userId: true, user: { select: { id: true, email: true, displayName: true } } },
    orderBy: { userId: "asc" },
    take: 200,
  });
  const managers: Array<{ id: string; email: string | null; displayName: string | null }> = [];
  for (const m of members) {
    const assign = await evaluateMemberAccess(
      { teamId: input.teamId, userId: m.userId, permission: "review.assign" },
      client,
    );
    if (!assign.allowed) continue;
    const reach = await resolveEvidenceRecordAccess(
      { userId: m.userId, evidenceId: input.evidenceId, permission: "evidence.read" },
      client,
    );
    if (!reach.allowed) continue;
    managers.push({ id: m.user.id, email: m.user.email ?? null, displayName: m.user.displayName ?? null });
  }
  return managers;
}

/**
 * A FIRST decision was recorded and the round now needs an independent SECOND
 * reviewer.
 *
 *   - The workspace's ASSIGNMENT MANAGERS (never the first reviewer) are told
 *     to select one, with a link to the review page where reassignment lives.
 *     The reviewer finally chosen is told when the review is handed to them
 *     ("Second review assigned to you", notifyReviewAssigned) — eligible
 *     reviewers are not all messaged up front (no indiscriminate notice).
 *   - T-160 — when NOBODY is eligible (`eligibleReviewerCount === 0`), the
 *     workspace OWNER is told instead, once per round, with what they can do:
 *     invite or place a reviewer, or keep the review open. In a one-person
 *     workspace that is the first reviewer themself — the only person who can
 *     act on it.
 *
 * Best-effort, like every helper here: never throws, never undoes the decision.
 * Idempotent per workflow + round against the delivery log: a recipient
 * already sent this event for the record since the round's FIRST decision is
 * not sent it again (a later round's FIRST decision notifies afresh).
 */
export async function notifySecondReviewRequired(
  input: {
    workflow: NotifiedWorkflow & { id: string };
    firstReviewerUserId: string;
    firstDecidedAt: Date;
    /** From THE assignee authority (countEligibleSecondReviewers). Absent = unknown (managers only). */
    eligibleReviewerCount?: number;
    cause?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ notifiedUserIds: string[]; unavailableNotifiedUserIds: string[] }> {
  const notifiedUserIds: string[] = [];
  const unavailableNotifiedUserIds: string[] = [];
  try {
    if (!input.workflow.teamId) return { notifiedUserIds, unavailableNotifiedUserIds };
    const teamId = input.workflow.teamId;
    let workspaceName = "Workspace";
    const team = await client.team.findUnique({ where: { id: teamId }, select: { name: true } }).catch(() => null);
    if (team?.name) workspaceName = team.name;
    const reviewUrl = reviewEmailLink(input.workflow);
    const requestTitle = "Evidence " + input.workflow.evidenceId.slice(0, 8) + "…";
    const send = async (
      eventType: "REVIEW_SECOND_REVIEW_REQUIRED" | "REVIEW_SECOND_REVIEWER_UNAVAILABLE",
      recipients: Array<{ id: string; email: string | null; displayName: string | null }>,
      out: string[],
    ) => {
      if (recipients.length === 0) return;
      const already = await client.notificationDelivery.findMany({
        where: {
          eventType,
          evidenceId: input.workflow.evidenceId,
          recipientUserId: { in: recipients.map((m) => m.id) },
          createdAt: { gte: input.firstDecidedAt },
        },
        select: { recipientUserId: true },
      });
      const sent = new Set(already.map((r) => r.recipientUserId));
      for (const r of recipients) {
        if (sent.has(r.id)) continue;
        await safeSendEmailNotification(
          {
            eventType,
            teamId,
            recipientEmail: r.email ?? "",
            recipientName: r.displayName,
            recipientUserId: r.id,
            evidenceId: input.workflow.evidenceId,
            initiatedByUserId: input.firstReviewerUserId,
            template: {
              kind: "ReviewAssigned",
              data: { workspaceName, requestTitle, reviewerName: r.displayName, requestUrl: reviewUrl },
            },
          },
          client,
        );
        out.push(r.id);
      }
    };

    if (input.eligibleReviewerCount === 0) {
      // T-160 — nobody can give it: the owner(s), first reviewer included.
      const owners = await client.teamMember.findMany({
        where: { teamId, status: "ACTIVE", role: "OWNER" },
        select: { user: { select: { id: true, email: true, displayName: true } } },
        take: 20,
      });
      await send(
        "REVIEW_SECOND_REVIEWER_UNAVAILABLE",
        owners.map((o) => ({ id: o.user.id, email: o.user.email ?? null, displayName: o.user.displayName ?? null })),
        unavailableNotifiedUserIds,
      );
      return { notifiedUserIds, unavailableNotifiedUserIds };
    }

    const managers = await listReviewAssignmentManagers(
      { teamId, evidenceId: input.workflow.evidenceId, excludeUserIds: [input.firstReviewerUserId] },
      client,
    );
    await send("REVIEW_SECOND_REVIEW_REQUIRED", managers, notifiedUserIds);
  } catch {
    /* swallowed — the decision stands */
  }
  return { notifiedUserIds, unavailableNotifiedUserIds };
}

/**
 * T-170 — a PERSON raised an escalation: the person who now holds it is told
 * (the escalation's assignee, else the review's assignee), never the person
 * who raised it. Automatic sweep escalations notify through the SLA reminder
 * path instead (no second message for the same breach); an unrouted
 * escalation on an unassigned review reaches owners and admins through the
 * inbox.
 */
export async function notifyEscalationRaised(
  input: {
    workflow: NotifiedWorkflow & { id: string };
    escalationAssigneeUserId: string | null;
    raisedByUserId: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<NotificationSendResult | null> {
  try {
    const recipient = input.escalationAssigneeUserId ?? input.workflow.assignedToUserId ?? null;
    if (!recipient || recipient === input.raisedByUserId) return null;
    return await dispatchToAssignee(
      { ...input.workflow, assignedToUserId: recipient },
      { eventType: "REVIEW_ESCALATED" },
      input.raisedByUserId,
      client,
    );
  } catch {
    return null;
  }
}
