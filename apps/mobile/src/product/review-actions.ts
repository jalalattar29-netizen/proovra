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

import {
  INFORMATION_REQUESTED_MESSAGE,
  REVIEW_WORKFLOW_BLOCK_COPY,
  describeReviewOutcome,
  type ReviewDecisionOutcomeCopyInput,
} from "@proovra/shared";

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

/**
 * The decisions that need an internal note, and the note's label. Team
 * remediation T-010 — every verdict carries a written rationale (the decision
 * authority refuses an empty one on every door), approvals included.
 */
export function reviewNoteLabel(d: ReviewDecision): string | null {
  if (d === "ESCALATE") return "Escalation reason";
  if (d === "REJECT_INSUFFICIENT") return "Reason for rejection";
  if (d === "REOPEN") return "Reason for reopening";
  if (d === "APPROVE_INTERNAL") return "Reason for approval";
  if (d === "REQUEST_MORE_INFO") return "Information needed";
  return null;
}

/** mapStatusToStage, verbatim. */
export function reviewStageOf(status: string | null | undefined): ReviewStage {
  if (!status || status === "NOT_STARTED") return "QUEUED";
  if (status === "NEEDS_INFO") return "NEEDS_MORE_INFO";
  if (status === "READY_FOR_EXTERNAL_REVIEW") return "APPROVED_INTERNAL";
  return (status in ALLOWED ? status : "QUEUED") as ReviewStage;
}

/**
 * Team remediation T-165 — what this viewer may decide is the SERVER's answer
 * (`availableActions`: the shared projection with the decision authority's
 * rules — assignee, second review, independence, adjudication). The local
 * stage matrix is only the fallback for an API that projects no actions.
 */
export function reviewDecisionAllowed(stage: ReviewStage, d: ReviewDecision, workflow?: ReviewWorkflowRef | null): boolean {
  const server = workflow?.actions;
  if (server && server.length > 0) {
    const a = server.find((x) => x.action === d);
    return !!a && a.enabled;
  }
  return ALLOWED[stage].includes(TARGET[d]);
}

/** Why the server closed a decision for this viewer, in words (null when open or unknown). */
export function reviewDecisionBlockedReason(d: ReviewDecision, workflow?: ReviewWorkflowRef | null): string | null {
  const a = workflow?.actions?.find((x) => x.action === d);
  if (!a || a.enabled || !a.blockedBy) return null;
  return REVIEW_WORKFLOW_BLOCK_COPY[a.blockedBy as keyof typeof REVIEW_WORKFLOW_BLOCK_COPY] ?? null;
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
  /**
   * T-084 / T-086 (team remediation) — the assignee named the one way the web
   * names them (display name, else the MASKED e-mail, else "a workspace
   * member"); never a user-id fragment. Null when unassigned.
   */
  assigneeLabel?: string | null;
  /**
   * PRO-R2Z-10 (WS-ENT) — decisions the SERVER says are outside the plan
   * (`availableActions[].blockedBy === "ESCALATION_NOT_INCLUDED"`): Escalate on
   * Pro. Empty when the API does not project actions (older API).
   */
  notIncluded?: ReadonlyArray<string>;
  /** T-165 — the server's per-action availability (empty on an older API). */
  actions?: ReadonlyArray<{ action: string; enabled: boolean; blockedBy: string | null }>;
}

/** `review-workspace.reviewWorkflow` — the fields the panel reads. */
export function projectReviewWorkflowRef(reviewWorkspace: unknown): ReviewWorkflowRef {
  const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const wf = o(o(reviewWorkspace)["reviewWorkflow"]);
  const s = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const actions = Array.isArray(wf.availableActions) ? (wf.availableActions as unknown[]) : [];
  const notIncluded = actions
    .map((a) => o(a))
    .filter((a) => a.blockedBy === "ESCALATION_NOT_INCLUDED" && typeof a.action === "string")
    .map((a) => a.action as string);
  const projected = actions
    .map((a) => o(a))
    .filter((a) => typeof a.action === "string")
    .map((a) => ({
      action: a.action as string,
      enabled: a.enabled === true,
      blockedBy: typeof a.blockedBy === "string" ? (a.blockedBy as string) : null,
    }));
  const assignee = o(wf.assignedTo);
  const assignedToUserId = s(assignee.id);
  return {
    teamId: s(wf.teamId),
    status: s(wf.status),
    assignedToUserId,
    assigneeLabel: assignedToUserId ? reviewAssigneeLabel(assignee.displayName, assignee.email) : null,
    notIncluded,
    actions: projected,
  };
}

/** T-084 / T-086 — display name, else masked e-mail ("j***@example.com"), else a neutral noun. */
export function reviewAssigneeLabel(displayName: unknown, email: unknown): string {
  if (typeof displayName === "string" && displayName.trim().length > 0) return displayName.trim();
  if (typeof email === "string") {
    const at = email.indexOf("@");
    if (at > 0) return `${email[0]}***${email.slice(at)}`;
  }
  return "a workspace member";
}

export const REVIEW_ACTIONS_COPY = {
  kicker: "Review actions",
  title: "Internal review decisions",
  boundary:
    "Internal-only actions. Decisions and notes stay in the workspace and are never shared with public verify, external contributors, or the report.",
  unassigned: "unassigned",
  claim: "Claim review",
  claimFailed: "Could not claim.",
  /** T-098 — the placement prerequisite, said to the person claiming. */
  claimNotPlacedTitle: "Place them in a team first",
  claimNotPlaced:
    "You are not in a Collaboration Team in this workspace yet, so you cannot claim reviews. An owner or admin places you in a team on the Collaboration Teams screen; then claim again.",
  claimNotPlacedAction: "Open Collaboration Teams",
  decisionFailed: "Decision failed.",
} as const;

/**
 * T-098 — the placement prerequisite refusal (422): a non-Enterprise person
 * must be in a Collaboration Team before they can be given or claim work.
 * Current servers answer REVIEW_ASSIGNEE_NOT_PLACED (reason
 * `assignee_not_placed`); older ones sent the lowercase engine code itself.
 */
export function isPlacementRefusal(err: unknown): boolean {
  const e = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
  const code = typeof e.code === "string" ? e.code.trim().toUpperCase() : "";
  if (code === "REVIEW_ASSIGNEE_NOT_PLACED" || code === "ASSIGNEE_NOT_PLACED") return true;
  const details = e.details && typeof e.details === "object" ? (e.details as Record<string, unknown>) : {};
  return details.reason === "assignee_not_placed";
}

/**
 * What a recorded decision did, in the copy every surface shares (review
 * remediation 2026-11-27). Null-safe: a request for information records NO
 * decision (`decision: null`, `outcome.stageRecorded: "NONE"`,
 * `nextRequirement: "information"`), and an older API may send no outcome at
 * all. Never reads `decision`; null when there is nothing certain to say.
 */
export function reviewDecisionResultMessage(d: ReviewDecision, response: unknown): string | null {
  const kind =
    d === "APPROVE_INTERNAL" ? "approve" : d === "REJECT_INSUFFICIENT" ? "reject" : d === "REQUEST_MORE_INFO" ? "request_info" : null;
  if (!kind) return null;
  const body = response && typeof response === "object" ? (response as { outcome?: unknown }) : null;
  const outcome =
    body && body.outcome && typeof body.outcome === "object" ? (body.outcome as ReviewDecisionOutcomeCopyInput) : null;
  if (outcome) return describeReviewOutcome(kind, outcome);
  return kind === "request_info" ? INFORMATION_REQUESTED_MESSAGE : null;
}
