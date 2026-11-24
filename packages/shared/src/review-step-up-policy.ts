/**
 * THE REVIEW STEP-UP POLICY, AS DATA (T-030, T-031, T-035, T-036).
 *
 * One table answers, for every review action a door can perform:
 *   - which adaptive check runs (the privileged action and its session window);
 *   - which Review-settings checkbox governs it;
 *   - which step-up purpose the challenge is minted for.
 *
 * The API gate (`services/api/.../review-action-gate.ts`) reads the gate rows;
 * Review settings renders its help text from the same rows, so what the page
 * says a checkbox controls is exactly what the server enforces.
 *
 * Decisions recorded here:
 *   - A single Archive (close one review without a decision) is its own action
 *     class, governed by the REJECT checkbox (as the Evidence-page Close always
 *     was), with the single-review session window. It is never labelled bulk.
 *   - Bulk close stays under the BULK checkbox.
 *   - Assignment, single or bulk, is not a step-up action (P8). Authorization,
 *     eligible-reviewer checks and the audit row stay; session trust
 *     (quarantine, critical risk) still applies to the bulk doors. No Enterprise
 *     contract flag requiring step-up for assignment exists today; one would be
 *     added here, never per door.
 *   - Revocation (external reviewer, share link) stays frictionless (P9).
 *
 * Browser-safe: no Node or Prisma imports.
 */

import type { PrivilegedAction } from "./identity-runtime.js";
import { PRIVILEGED_ACTION_REQUIRES_FRESH_AUTH_HOURS } from "./identity-runtime.js";
import type { StepUpPurpose } from "./identity-security.js";

export const REVIEW_STEP_UP_FLAG_KEYS = [
  "requireStepUpForApprove",
  "requireStepUpForReject",
  "requireStepUpForEscalationResolve",
  "requireStepUpForBulk",
] as const;
export type ReviewStepUpFlagKey = (typeof REVIEW_STEP_UP_FLAG_KEYS)[number];

export type ReviewGateAction =
  | "approve"
  | "reject"
  | "archive"
  | "bulk"
  | "escalationResolve"
  | "escalationSuppress";

export type ReviewGateRow = {
  adaptive: PrivilegedAction;
  flag: ReviewStepUpFlagKey;
  purpose: StepUpPurpose;
};

export const REVIEW_GATE_TABLE: Readonly<Record<ReviewGateAction, ReviewGateRow>> = Object.freeze({
  approve: { adaptive: "REVIEWER_APPROVE", flag: "requireStepUpForApprove", purpose: "REVIEW_APPROVAL_HIGH_RISK" },
  reject: { adaptive: "REVIEWER_REJECT", flag: "requireStepUpForReject", purpose: "REVIEWER_OPS_REJECT" },
  archive: { adaptive: "REVIEWER_ARCHIVE", flag: "requireStepUpForReject", purpose: "REVIEWER_OPS_ARCHIVE" },
  bulk: { adaptive: "REVIEWER_BULK", flag: "requireStepUpForBulk", purpose: "REVIEWER_OPS_BULK_ACTION" },
  escalationResolve: {
    adaptive: "REVIEW_ESCALATION_RESOLVE",
    flag: "requireStepUpForEscalationResolve",
    purpose: "REVIEWER_OPS_ESCALATION_RESOLVE",
  },
  escalationSuppress: {
    adaptive: "REVIEW_ESCALATION_SUPPRESS",
    flag: "requireStepUpForEscalationResolve",
    purpose: "REVIEWER_OPS_ESCALATION_RESOLVE",
  },
});

/** The session window (hours) a gate action allows before a fresh sign-in. */
export function reviewGateSessionWindowHours(action: ReviewGateAction): number {
  return PRIVILEGED_ACTION_REQUIRES_FRESH_AUTH_HOURS[REVIEW_GATE_TABLE[action].adaptive];
}

/**
 * Every governed action a person can perform, by the door they use, with the
 * gate it answers to. Review settings lists these under each checkbox.
 */
export const REVIEW_GOVERNED_ACTIONS: ReadonlyArray<{ gate: ReviewGateAction; label: string }> = Object.freeze([
  { gate: "approve", label: "Approve a review" },
  { gate: "approve", label: "Uphold a decision when adjudicating a disagreement" },
  { gate: "reject", label: "Reject a review" },
  { gate: "reject", label: "Close a review from the Evidence page" },
  { gate: "reject", label: "Reopen a review from the Evidence page" },
  { gate: "archive", label: "Archive one review (close it without a decision)" },
  { gate: "escalationResolve", label: "Resolve an escalation" },
  { gate: "escalationSuppress", label: "Suppress an escalation" },
  { gate: "bulk", label: "Bulk decisions and bulk close" },
  { gate: "bulk", label: "Bulk priority, pause, request information and escalate" },
  { gate: "bulk", label: "Bulk coding" },
]);

/** The governed-action labels for one checkbox, in table order. */
export function reviewStepUpFlagGoverns(flag: ReviewStepUpFlagKey): string[] {
  return REVIEW_GOVERNED_ACTIONS.filter((row) => REVIEW_GATE_TABLE[row.gate].flag === flag).map(
    (row) => row.label,
  );
}

/** Actions no checkbox governs and that never ask for a second factor. */
export const REVIEW_ACTIONS_WITHOUT_STEP_UP: ReadonlyArray<string> = Object.freeze([
  "Assign or reassign reviews, one or many",
  "Start, pause or resume a review",
  "Request information on one review",
  "Raise or acknowledge an escalation",
  "Add notes",
  "Revoke an external reviewer or a share link",
]);

/**
 * The layers that apply whatever the checkboxes say. Stated on the settings
 * page so "off" is never read as "never asks".
 */
export const REVIEW_STEP_UP_ALWAYS_ON: ReadonlyArray<string> = Object.freeze([
  "Genuinely elevated sign-in risk (for example sessions from several networks or countries at once) asks for a second factor, or for a fresh sign-in when the risk is high.",
  "A sign-in older than the action's session window asks you to sign in again: 8 hours for single-review actions, 4 hours for bulk actions and escalation suppression.",
  "Saving these settings always needs a second factor, because it can lower protection.",
]);

/**
 * THE ONE CLASSIFICATION OF A BULK-DOOR REQUEST (T-030, T-036).
 *
 * Every bulk door asks this before it asks the gate:
 *   - ASSIGN / REASSIGN (any count) → "assignment": not a step-up action.
 *   - CLOSE of exactly one review sent as `scope: "single"` → "archive".
 *   - anything else → "bulk".
 */
export type ReviewBulkClassification = ReviewGateAction | "assignment";

export function classifyReviewBulkRequest(input: {
  action: string;
  itemCount: number;
  scope?: "single" | "bulk" | null;
}): ReviewBulkClassification {
  const action = input.action.toUpperCase();
  if (action === "ASSIGN" || action === "REASSIGN") return "assignment";
  if (action === "CLOSE" && input.scope === "single" && input.itemCount === 1) return "archive";
  return "bulk";
}

/**
 * T-028 — the machine-readable reason a step-up or re-authentication refusal
 * carries in `error.details.reason`, so a client can say WHY.
 */
export type StepUpRefusalReason =
  | `policy_flag:${ReviewStepUpFlagKey}`
  | "elevated_session_risk"
  | "high_session_risk"
  | "session_age_window"
  | "legacy_session"
  | "save_policy_requires_mfa"
  | "action_requires_step_up";

export function policyFlagReason(flag: ReviewStepUpFlagKey): StepUpRefusalReason {
  return `policy_flag:${flag}`;
}
