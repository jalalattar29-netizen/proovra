/**
 * CANONICAL NATIVE REVIEWER WORKFLOW — pure.
 *
 * `GET /v1/evidence/:id/reviewer-workflow` → `{ available, workflow }`
 * `PATCH /v1/evidence/:id/reviewer-workflow` → the same summary
 * `GET /v1/evidence/:id/reviewer-workflow/events` → `{ items }`
 * (evidence.routes.ts:8167, :8179, :8352; the summary is built by
 * `toWorkflowSummary`, reviewer-workflow.service.ts:14.)
 *
 * None of the three was called from a phone. A reviewer could read every hash
 * and custody event on a record and not see who it was assigned to, when it
 * was due, or what anyone had done to it — which is the state of the review,
 * i.e. the only part of the record that changes while it is being reviewed.
 *
 * THE ONE RULE THIS MODULE EXISTS TO HOLD
 *
 * `status` carries two different kinds of value, and the server is emphatic
 * about it (review-status-vocabulary.ts): ROUTING states are lifecycle
 * position and may be set directly; VERDICT states — APPROVED_INTERNAL,
 * REJECTED_INSUFFICIENT, NEEDS_INFO — are a PROJECTION of the immutable
 * decision log and may only be produced by recording a decision. The PATCH
 * route's own schema filters them out of what it will accept.
 *
 * A picker that offered them would be offering to forge a verdict. It would be
 * refused, but the refusal is not the point: the surface would have told the
 * reviewer that a decision is something you can select.
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

import { humanizeEnum } from "./domain-display";
import { listEnvelope } from "./envelope";
import {
  EVIDENCE_REVIEW_WORKFLOW_STATUSES,
  EVIDENCE_REVIEW_WORKFLOW_PRIORITIES,
  DECISION_DERIVED_WORKFLOW_STATUSES,
} from "./domain-enums.generated";

/* ----------------------------------------------------------------- paths */

export function buildReviewerWorkflowPath(evidenceId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/reviewer-workflow`;
}
export function buildReviewerWorkflowEventsPath(evidenceId: string): string {
  return `${buildReviewerWorkflowPath(evidenceId)}/events`;
}

/* -------------------------------------------------------------- the rule */

/** True when only the decision authority may produce this status. */
export function isVerdictStatus(status: string | null | undefined): boolean {
  return !!status && (DECISION_DERIVED_WORKFLOW_STATUSES as readonly string[]).includes(status);
}

/**
 * The statuses a reviewer may set by hand.
 *
 * Derived by SUBTRACTION from the schema's full list, exactly as the route
 * derives its own accept-list (evidence.routes.ts:450). Writing the routing
 * states out here instead would be a second list, and the day a state is added
 * to the schema the two would disagree about which kind it is.
 */
export const ROUTING_WORKFLOW_STATUSES: readonly string[] =
  EVIDENCE_REVIEW_WORKFLOW_STATUSES.filter((s) => !isVerdictStatus(s));

export const WORKFLOW_PRIORITIES = EVIDENCE_REVIEW_WORKFLOW_PRIORITIES;

export function workflowStatusLabel(status: string | null | undefined): string {
  return status ? humanizeEnum(status) : "Not started";
}
export function workflowPriorityLabel(priority: string | null | undefined): string {
  return priority ? humanizeEnum(priority) : "Normal";
}

/**
 * Why a verdict status is shown but not offered.
 *
 * Shown, because it is the record's real state and hiding it would be worse.
 * Not offered, because it is a reading of the decision log rather than a
 * setting.
 */
export const VERDICT_STATUS_NOTE =
  "This status comes from a recorded review decision. It is not set directly.";

/* -------------------------------------------------------------- the read */

export interface ReviewerWorkflow {
  status: string;
  priority: string;
  dueAtIso: string | null;
  lastReviewedAtIso: string | null;
  closedAtIso: string | null;
  /** Never a raw user id: a name, an email, or absent. */
  assignedToLabel: string | null;
  assignedToUserId: string | null;
}

/**
 * `{ available, workflow }`.
 *
 * `available: false` is a real answer — the record has no workflow row yet —
 * and is returned as null rather than an empty workflow, because "not started"
 * and "no workflow exists" are different things to say about a record.
 */
export function parseReviewerWorkflow(payload: unknown): ReviewerWorkflow | null {
  const d = obj(payload);
  if (d.available === false) return null;
  const w = obj(d.workflow ?? d);
  const status = str(w.status);
  if (!status) return null;
  const assigned = obj(w.assignedTo);
  return {
    status,
    priority: str(w.priority) ?? "NORMAL",
    dueAtIso: str(w.dueAt),
    lastReviewedAtIso: str(w.lastReviewedAt),
    closedAtIso: str(w.closedAt),
    // A raw user id is not a person. Absent stays absent.
    assignedToLabel: str(assigned.displayName) ?? str(assigned.email),
    assignedToUserId: str(assigned.id),
  };
}

export interface ReviewerWorkflowEvent {
  id: string;
  eventType: string;
  note: string | null;
  actorLabel: string | null;
  createdAtIso: string | null;
}

/** `{ items }` — the workflow's own history. */
export function parseReviewerWorkflowEvents(payload: unknown): ReviewerWorkflowEvent[] {
  return listEnvelope(payload, ["items"])
    .map((raw) => {
      const e = obj(raw);
      const id = str(e.id);
      if (!id) return null;
      const actor = obj(e.actor);
      return {
        id,
        eventType: str(e.eventType) ?? "UPDATED",
        note: str(e.note),
        actorLabel: str(actor.displayName) ?? str(actor.email),
        createdAtIso: str(e.createdAt),
      };
    })
    .filter((e): e is ReviewerWorkflowEvent => e !== null);
}

export function workflowEventLabel(eventType: string): string {
  return humanizeEnum(eventType);
}

/* ------------------------------------------------------------- the write */

export const WORKFLOW_NOTE_MAX = 1000;

export function validateWorkflowNote(note: string): string | null {
  if (note.trim().length > WORKFLOW_NOTE_MAX) {
    return `A note cannot be longer than ${WORKFLOW_NOTE_MAX} characters.`;
  }
  return null;
}

/**
 * The PATCH body.
 *
 * Every field is optional on the route, and this sends only what CHANGED.
 * Re-sending the current status would append a workflow event saying it was
 * set — on the one feed whose purpose is to be an accurate account of what was
 * done to the record.
 *
 * A verdict status is refused here rather than filtered silently: a caller
 * asking for one has misunderstood something, and swallowing it would hide
 * that.
 */
export function buildWorkflowUpdateBody(input: {
  status?: string | null;
  priority?: string | null;
  dueAtIso?: string | null;
  note?: string;
  current: ReviewerWorkflow | null;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (input.status && input.status !== input.current?.status) {
    if (isVerdictStatus(input.status)) {
      throw new Error(`${input.status} is produced by a review decision and cannot be set here.`);
    }
    body.status = input.status;
  }
  if (input.priority && input.priority !== input.current?.priority) {
    body.priority = input.priority;
  }
  if (input.dueAtIso !== undefined && input.dueAtIso !== input.current?.dueAtIso) {
    body.dueAt = input.dueAtIso;
  }
  const note = (input.note ?? "").trim();
  if (note) body.note = note;

  return body;
}

/** Nothing to send is not a request. */
export function workflowUpdateIsEmpty(body: Record<string, unknown>): boolean {
  return Object.keys(body).length === 0;
}
