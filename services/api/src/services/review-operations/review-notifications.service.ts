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
 */

import type {
  EvidenceReviewWorkflow as DbWorkflow,
  PrismaClient,
} from "@prisma/client";
import type { NotificationEventType } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { safeSendEmailNotification } from "../notifications/index.js";
import { getEmailWebBaseUrl } from "../notifications/templates.js";

async function resolveAssigneeAndWorkspace(
  workflow: Pick<DbWorkflow, "evidenceId" | "teamId" | "assignedToUserId">,
  client: PrismaClient,
): Promise<{
  reviewer: { id: string; email: string; displayName: string | null } | null;
  workspaceName: string;
  evidenceUrl: string;
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

  const base = getEmailWebBaseUrl().replace(/\/+$/, "");
  const evidenceUrl = `${base}/evidence/${workflow.evidenceId}`;

  return { reviewer, workspaceName, evidenceUrl };
}

type DispatchKind =
  | { eventType: Extract<NotificationEventType, "REVIEW_REQUEST_ASSIGNED">; isReassignment: false }
  | { eventType: Extract<NotificationEventType, "REVIEW_REASSIGNED">; isReassignment: true }
  | { eventType: Extract<NotificationEventType, "REVIEW_ESCALATED"> }
  | { eventType: Extract<NotificationEventType, "REVIEW_NEEDS_MORE_INFO"> }
  | { eventType: Extract<NotificationEventType, "REVIEW_RESPONSE_RECEIVED"> }
  | { eventType: Extract<NotificationEventType, "REVIEW_OVERDUE_REMINDER"> };

async function dispatchToAssignee(
  workflow: Pick<DbWorkflow, "evidenceId" | "teamId" | "assignedToUserId">,
  kind: DispatchKind,
  initiatedByUserId: string | null,
  client: PrismaClient,
): Promise<void> {
  const { reviewer, workspaceName, evidenceUrl } =
    await resolveAssigneeAndWorkspace(workflow, client);

  // No assignee → nothing to do. Caller may still want to log an
  // operations event; the notification is just a no-op.
  if (!reviewer) return;

  await safeSendEmailNotification(
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
          requestUrl: evidenceUrl,
        },
      },
    },
    client,
  );
}

// -----------------------------------------------------------------------------
// Public API — every function is safe-by-default; failures NEVER throw.
// -----------------------------------------------------------------------------

export async function notifyReviewAssigned(
  input: {
    workflow: DbWorkflow;
    actorUserId: string;
    isReassignment: boolean;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  try {
    await dispatchToAssignee(
      input.workflow,
      input.isReassignment
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
