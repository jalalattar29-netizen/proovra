/**
 * INTERNAL REVIEW ACTIONS (T-15) — the native port of
 * `apps/web/app/(app)/evidence/[id]/components/EvidenceReviewActionsPanel.tsx`.
 *
 * POST /v1/review-operations/evidence/:id/claim     { teamId }
 * POST /v1/review-operations/evidence/:id/decision  { decision, note, escalationReason? }
 *
 * Shown where the web shows it: the Review tab, for plans with reviewer
 * operations. The stage machine below is the web's UI guard only — the server
 * enforces every transition, and the workspace for a decision is derived from
 * the record by the server (the client does not name the tenant). Wording is
 * operational: no claim of authenticity, admissibility or truth.
 */

export type ReviewStage =
  | "QUEUED"
  | "ASSIGNED"
  | "IN_REVIEW"
  | "NEEDS_MORE_INFO"
  | "RESPONSE_RECEIVED"
  | "APPROVED_INTERNAL"
  | "REJECTED_INSUFFICIENT"
  | "ESCALATED"
  | "REOPENED"
  | "CLOSED";

export type ReviewDecision = "APPROVE_INTERNAL" | "REQUEST_MORE_INFO" | "REJECT_INSUFFICIENT" | "ESCALATE" | "REOPEN" | "CLOSE";

/** ALLOWED_TRANSITIONS, verbatim. */
const ALLOWED: Record<ReviewStage, readonly ReviewStage[]> = {
  QUEUED: ["ASSIGNED", "IN_REVIEW", "ESCALATED", "CLOSED"],
  ASSIGNED: ["IN_REVIEW", "NEEDS_MORE_INFO", "ESCALATED", "QUEUED", "CLOSED"],
  IN_REVIEW: ["NEEDS_MORE_INFO", "APPROVED_INTERNAL", "REJECTED_INSUFFICIENT", "ESCALATED", "ASSIGNED", "CLOSED"],
  NEEDS_MORE_INFO: ["RESPONSE_RECEIVED", "IN_REVIEW", "ESCALATED", "REJECTED_INSUFFICIENT", "CLOSED"],
  RESPONSE_RECEIVED: ["IN_REVIEW", "APPROVED_INTERNAL", "REJECTED_INSUFFICIENT", "NEEDS_MORE_INFO", "ESCALATED", "CLOSED"],
  APPROVED_INTERNAL: ["REOPENED", "CLOSED"],
  REJECTED_INSUFFICIENT: ["REOPENED", "CLOSED"],
  ESCALATED: ["IN_REVIEW", "APPROVED_INTERNAL", "REJECTED_INSUFFICIENT", "NEEDS_MORE_INFO", "CLOSED"],
  REOPENED: ["IN_REVIEW", "NEEDS_MORE_INFO", "ESCALATED"],
  CLOSED: ["REOPENED"],
};

const TARGET: Record<ReviewDecision, ReviewStage> = {
  APPROVE_INTERNAL: "APPROVED_INTERNAL",
  REQUEST_MORE_INFO: "NEEDS_MORE_INFO",
  REJECT_INSUFFICIENT: "REJECTED_INSUFFICIENT",
  ESCALATE: "ESCALATED",
  REOPEN: "REOPENED",
  CLOSE: "CLOSED",
};

export const REVIEW_DECISIONS: readonly ReviewDecision[] = ["APPROVE_INTERNAL", "REQUEST_MORE_INFO", "REJECT_INSUFFICIENT", "ESCALATE", "REOPEN", "CLOSE"];

export const REVIEW_DECISION_LABEL: Record<ReviewDecision, string> = {
  APPROVE_INTERNAL: "Approve (internal review)",
  REQUEST_MORE_INFO: "Request more information",
  REJECT_INSUFFICIENT: "Reject as insufficient",
  ESCALATE: "Escalate",
  REOPEN: "Reopen",
  CLOSE: "Close",
};

/** The decisions that need an internal note, and the note's label. */
export function reviewNoteLabel(d: ReviewDecision): string | null {
  if (d === "ESCALATE") return "Escalation reason";
  if (d === "REJECT_INSUFFICIENT") return "Reason for rejection";
  if (d === "REOPEN") return "Reason for reopening";
  return null;
}

/** mapStatusToStage, verbatim. */
export function reviewStageOf(status: string | null | undefined): ReviewStage {
  if (!status || status === "NOT_STARTED") return "QUEUED";
  if (status === "NEEDS_INFO") return "NEEDS_MORE_INFO";
  if (status === "READY_FOR_EXTERNAL_REVIEW") return "APPROVED_INTERNAL";
  return (status in ALLOWED ? status : "QUEUED") as ReviewStage;
}

export function reviewDecisionAllowed(stage: ReviewStage, d: ReviewDecision): boolean {
  return ALLOWED[stage].includes(TARGET[d]);
}

export function canClaimReview(teamId: string | null, assignedToUserId: string | null, stage: ReviewStage): boolean {
  return !!teamId && !assignedToUserId && stage !== "CLOSED";
}

export function buildReviewClaimPath(evidenceId: string): string {
  return `/v1/review-operations/evidence/${encodeURIComponent(evidenceId)}/claim`;
}
export function buildReviewDecisionPath(evidenceId: string): string {
  return `/v1/review-operations/evidence/${encodeURIComponent(evidenceId)}/decision`;
}
export function buildReviewDecisionBody(d: ReviewDecision, note: string | null) {
  return { decision: d, note, ...(d === "ESCALATE" ? { escalationReason: note } : {}) };
}

export interface ReviewWorkflowRef {
  teamId: string | null;
  status: string | null;
  assignedToUserId: string | null;
}

/** `review-workspace.reviewWorkflow` — the fields the panel reads. */
export function projectReviewWorkflowRef(reviewWorkspace: unknown): ReviewWorkflowRef {
  const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const wf = o(o(reviewWorkspace)["reviewWorkflow"]);
  const s = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  return { teamId: s(wf.teamId), status: s(wf.status), assignedToUserId: s(o(wf.assignedTo).id) };
}

export const REVIEW_ACTIONS_COPY = {
  kicker: "Review actions",
  title: "Internal review decisions",
  boundary:
    "Internal-only actions. Decisions and notes stay in the workspace and are never shared with public verify, external contributors, or the report.",
  unassigned: "unassigned",
  claim: "Claim review",
  claimFailed: "Could not claim.",
  decisionFailed: "Decision failed.",
} as const;
