/**
 * Review workflow — what a viewer may do next, and how the history reads
 * (2026-10-23).
 *
 * The Evidence page's Review Actions panel kept its OWN copy of the stage
 * matrix, enabled buttons from a status it never refreshed, showed the stage
 * and the history as raw enum names, and printed a truncated user id as the
 * assignee. Claim, Escalate and Reopen therefore looked like they did nothing.
 *
 * This module is the one projection both sides use:
 *
 *   - `projectReviewWorkflowActions` — built on the shared stage matrix
 *     (`listAllowedReviewStageTransitions`) plus the facts the server refuses
 *     on (no workspace, no review permission, a verdict already recorded,
 *     someone else owns the review). The API runs it per viewer and sends it;
 *     the web enables exactly what it says and shows the reason otherwise.
 *   - human labels for stages, priorities and workflow events;
 *   - `summarizeReviewWorkflowEvents` — collapses the automatic events written
 *     when a workflow is created into one "Review workflow created" entry for
 *     DISPLAY. The stored history is never rewritten.
 *
 * Review is an internal workflow: none of this alters the evidence record's
 * integrity, its public verification or any legal standing.
 */

import {
  decisionRequiresNote,
  decisionTargetStage,
  listAllowedReviewStageTransitions,
  mapDbStatusToReviewStage,
  type ReviewDecisionType,
  type ReviewStage,
} from "./review-operations.js";

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const REVIEW_STAGE_LABELS: Readonly<Record<ReviewStage, string>> = {
  QUEUED: "Not started",
  ASSIGNED: "Assigned",
  IN_REVIEW: "In review",
  NEEDS_MORE_INFO: "More information requested",
  RESPONSE_RECEIVED: "Response received",
  APPROVED_INTERNAL: "Approved (internal)",
  REJECTED_INSUFFICIENT: "Rejected as insufficient",
  ESCALATED: "Escalated",
  REOPENED: "Reopened",
  CLOSED: "Closed",
};

/** The human label for a stored workflow status (legacy values included). */
export function reviewStatusLabel(dbStatus: string | null | undefined): string {
  if (!dbStatus) return REVIEW_STAGE_LABELS.QUEUED;
  return REVIEW_STAGE_LABELS[mapDbStatusToReviewStage(dbStatus)] ?? "Unknown state";
}

export const REVIEW_PRIORITY_LABELS: Readonly<Record<string, string>> = {
  LOW: "Low",
  NORMAL: "Normal",
  HIGH: "High",
  URGENT: "Urgent",
};

export function reviewPriorityLabel(priority: string | null | undefined): string {
  return (priority && REVIEW_PRIORITY_LABELS[priority]) || "Normal";
}

const EVENT_LABELS: Readonly<Record<string, string>> = {
  CREATED: "Review workflow created",
  ASSIGNED: "Reviewer assigned",
  UNASSIGNED: "Reviewer removed",
  REASSIGNED: "Reviewer changed",
  CLAIMED: "Review claimed",
  STATUS_CHANGED: "Status changed",
  STAGE_CHANGED: "Status changed",
  PRIORITY_CHANGED: "Priority changed",
  DUE_DATE_CHANGED: "Due date changed",
  REVIEW_STARTED: "Review started",
  REVIEW_COMPLETED: "Review completed",
  ESCALATED: "Escalated",
  CLOSED: "Closed",
  APPROVED_INTERNAL: "Approved (internal)",
  REJECTED_INSUFFICIENT: "Rejected as insufficient",
  NEEDS_MORE_INFO: "More information requested",
  RESPONSE_RECEIVED: "Response received",
  REOPENED: "Reopened",
  SLA_UPDATED: "Review deadline updated",
  SLA_BREACHED: "Review deadline passed",
  BULK_ACTION: "Updated in a bulk action",
  DECISION_LOGGED: "Decision recorded",
};

/** Never a raw enum: an unknown type reads as a generic update. */
export function reviewWorkflowEventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? "Workflow updated";
}

// ---------------------------------------------------------------------------
// Available actions
// ---------------------------------------------------------------------------

export type ReviewWorkflowAction = "CLAIM" | ReviewDecisionType;

export const REVIEW_WORKFLOW_ACTIONS: ReadonlyArray<ReviewWorkflowAction> = [
  "CLAIM",
  "APPROVE_INTERNAL",
  "REQUEST_MORE_INFO",
  "REJECT_INSUFFICIENT",
  "ESCALATE",
  "REOPEN",
  "CLOSE",
];

export const REVIEW_WORKFLOW_ACTION_LABELS: Readonly<Record<ReviewWorkflowAction, string>> = {
  CLAIM: "Claim review",
  APPROVE_INTERNAL: "Approve (internal)",
  REQUEST_MORE_INFO: "Request more information",
  REJECT_INSUFFICIENT: "Reject as insufficient",
  ESCALATE: "Escalate",
  REOPEN: "Reopen",
  CLOSE: "Close",
};

/** Why an action is not available — each has one sentence of copy. */
export type ReviewWorkflowActionBlock =
  | "NO_WORKSPACE"
  | "NOT_INCLUDED"
  | "NOT_PERMITTED"
  | "NOT_FROM_STAGE"
  | "VERDICT_RECORDED"
  | "OWNED_BY_SOMEONE_ELSE"
  | "ALREADY_YOURS";

export const REVIEW_WORKFLOW_BLOCK_COPY: Readonly<Record<ReviewWorkflowActionBlock, string>> = {
  NO_WORKSPACE: "Review runs in a team workspace. This record is not in one.",
  NOT_INCLUDED: "The review workflow is not included in this workspace's plan.",
  NOT_PERMITTED: "Your role cannot make review decisions in this workspace.",
  NOT_FROM_STAGE: "Not available at the current review stage.",
  VERDICT_RECORDED:
    "A verdict is already recorded for this review. It cannot be replaced from here.",
  OWNED_BY_SOMEONE_ELSE: "Another reviewer owns this review.",
  ALREADY_YOURS: "You already own this review.",
};

/**
 * What each action DOES — said before it is taken, so Escalate and Close are
 * never a step into the unknown.
 */
export const REVIEW_WORKFLOW_ACTION_OUTCOMES: Readonly<Record<ReviewWorkflowAction, string>> = {
  CLAIM: "Assigns this review to you.",
  APPROVE_INTERNAL: "Records an internal approval. It does not change the evidence or its verification.",
  REQUEST_MORE_INFO: "Marks the review as waiting for more information and notifies the assigned reviewer.",
  REJECT_INSUFFICIENT: "Records that the material is insufficient for this review. The evidence is not changed or deleted.",
  ESCALATE:
    "Moves the review to Escalated. The assigned reviewer is notified by email, and the review appears under Escalated in the team review queue until someone continues, decides or closes it.",
  REOPEN: "Returns a finished review to Reopened so work can continue.",
  CLOSE: "Ends the review without a new verdict. It can be reopened later.",
};

export type ReviewWorkflowActionAvailability = {
  action: ReviewWorkflowAction;
  enabled: boolean;
  /** Null when enabled. */
  blockedBy: ReviewWorkflowActionBlock | null;
  /** A written reason is required (and checked by the server). */
  requiresNote: boolean;
};

export type ReviewWorkflowActionInput = {
  /** The stored workflow status; null when no workflow row exists. */
  dbStatus: string | null;
  assignedToUserId: string | null;
  viewerUserId: string;
  /** Does the viewer hold the review permission in this workspace? */
  viewerMayReview: boolean;
  /** The record belongs to a team workspace (review routes require one). */
  hasWorkspace: boolean;
  /**
   * The workspace's plan includes reviewer operations (the commercial
   * authority the review routes enforce). Absent → treated as included, for
   * callers that check it themselves.
   */
  planIncludesReview?: boolean;
  /** At least one verdict (approve / reject / request info) is recorded. */
  verdictRecorded: boolean;
};

const VERDICTS: ReadonlySet<ReviewWorkflowAction> = new Set([
  "APPROVE_INTERNAL",
  "REQUEST_MORE_INFO",
  "REJECT_INSUFFICIENT",
]);

export function projectReviewWorkflowActions(
  input: ReviewWorkflowActionInput,
): ReviewWorkflowActionAvailability[] {
  const stage: ReviewStage = input.dbStatus ? mapDbStatusToReviewStage(input.dbStatus) : "QUEUED";
  const allowed = listAllowedReviewStageTransitions(stage);
  return REVIEW_WORKFLOW_ACTIONS.map((action) => {
    const requiresNote = action === "CLAIM" ? false : decisionRequiresNote(action);
    const block = ((): ReviewWorkflowActionBlock | null => {
      if (!input.hasWorkspace || input.dbStatus === null) return "NO_WORKSPACE";
      if (input.planIncludesReview === false) return "NOT_INCLUDED";
      if (!input.viewerMayReview) return "NOT_PERMITTED";
      if (action === "CLAIM") {
        if (input.assignedToUserId === input.viewerUserId) return "ALREADY_YOURS";
        if (input.assignedToUserId) return "OWNED_BY_SOMEONE_ELSE";
        return stage === "CLOSED" ? "NOT_FROM_STAGE" : null;
      }
      if (VERDICTS.has(action) && input.verdictRecorded) return "VERDICT_RECORDED";
      return allowed.includes(decisionTargetStage(action)) ? null : "NOT_FROM_STAGE";
    })();
    return { action, enabled: block === null, blockedBy: block, requiresNote };
  });
}

// ---------------------------------------------------------------------------
// History presentation
// ---------------------------------------------------------------------------

export type ReviewWorkflowEventInput = {
  id: string;
  eventType: string;
  createdAt: string;
  actor: { id: string; displayName: string | null; email: string | null } | null;
  note: string | null;
};

export type ReviewWorkflowHistoryEntry = {
  /** The ids of the stored events this entry stands for (one, or the creation group). */
  eventIds: string[];
  label: string;
  createdAt: string;
  /** SYSTEM entries were written by PROOVRA, not by a person. */
  origin: "SYSTEM" | "PERSON";
  actorLabel: string;
  note: string | null;
};

/** The events a workflow's creation writes in one transaction. */
const CREATION_COMPANIONS: ReadonlySet<string> = new Set([
  "UNASSIGNED",
  "STATUS_CHANGED",
  "PRIORITY_CHANGED",
  "DUE_DATE_CHANGED",
]);

/** How long after CREATED a companion still belongs to the creation. */
const CREATION_WINDOW_MS = 2000;

/**
 * The history as a reader should see it, newest first.
 *
 * Creating a workflow writes CREATED plus UNASSIGNED, STATUS_CHANGED and
 * PRIORITY_CHANGED in the same instant — four rows that said nothing a reader
 * needed. They are shown as ONE "Review workflow created" entry. Every stored
 * event stays in `eventIds`; nothing is removed from the record.
 *
 * `viewerUserId` lets an actor read as "You". An actor the API could not
 * resolve (a deleted account) reads as "Former workspace member" — never as
 * an identifier. CREATED by the record's own completion is a SYSTEM entry.
 */
export function summarizeReviewWorkflowEvents(
  events: ReadonlyArray<ReviewWorkflowEventInput>,
  viewerUserId: string | null,
): ReviewWorkflowHistoryEntry[] {
  const ordered = [...events].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
  );
  const out: ReviewWorkflowHistoryEntry[] = [];
  const actorLabel = (e: ReviewWorkflowEventInput) =>
    !e.actor
      ? "Former workspace member"
      : viewerUserId && e.actor.id === viewerUserId
        ? "You"
        : e.actor.displayName?.trim() || e.actor.email?.trim() || "Workspace member";
  let creation: ReviewWorkflowHistoryEntry | null = null;
  for (const e of ordered) {
    if (e.eventType === "CREATED") {
      creation = {
        eventIds: [e.id],
        label: reviewWorkflowEventLabel("CREATED"),
        createdAt: e.createdAt,
        origin: "SYSTEM",
        actorLabel: "PROOVRA",
        note: null,
      };
      out.push(creation);
      continue;
    }
    if (
      creation &&
      CREATION_COMPANIONS.has(e.eventType) &&
      Date.parse(e.createdAt) - Date.parse(creation.createdAt) <= CREATION_WINDOW_MS &&
      !e.note
    ) {
      creation.eventIds.push(e.id);
      continue;
    }
    creation = null;
    out.push({
      eventIds: [e.id],
      label: reviewWorkflowEventLabel(e.eventType),
      createdAt: e.createdAt,
      origin: "PERSON",
      actorLabel: actorLabel(e),
      note: e.note,
    });
  }
  return out.reverse();
}

/** The assignee as a person reads it — never an identifier. */
export function reviewAssigneeLabel(
  assignee: { id: string; displayName: string | null; email: string | null } | null,
  viewerUserId: string | null,
): string {
  if (!assignee) return "Unassigned";
  if (viewerUserId && assignee.id === viewerUserId) return "You";
  return assignee.displayName?.trim() || assignee.email?.trim() || "Workspace member";
}
