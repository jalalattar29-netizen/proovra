/**
 * GOVERNED EXPORT PREFLIGHT (T-15) — the native port of
 * `apps/web/components/governance/GovernedExportAction.tsx`.
 *
 * GET /v1/governance/export-eligibility?teamId&evidenceId answers whether a
 * report / verification-package export may proceed (legal hold, lifecycle,
 * destruction review, workspace policy). The server enforces the same verdict
 * on the download routes; the preflight exists so the person is told WHY
 * before the (audited) download, not after — "no silent disable".
 */
export type ExportOutcome =
  | "ALLOWED"
  | "BLOCKED_BY_HOLD"
  | "BLOCKED_BY_LIFECYCLE"
  | "BLOCKED_BY_REVIEW_GATE"
  | "BLOCKED_BY_POLICY";

export interface ExportEligibility {
  outcome: ExportOutcome;
  reason: string;
  lifecycleState: string | null;
}

const OUTCOMES: readonly ExportOutcome[] = ["ALLOWED", "BLOCKED_BY_HOLD", "BLOCKED_BY_LIFECYCLE", "BLOCKED_BY_REVIEW_GATE", "BLOCKED_BY_POLICY"];

export function buildExportEligibilityPath(teamId: string, evidenceId: string): string {
  return `/v1/governance/export-eligibility?teamId=${encodeURIComponent(teamId)}&evidenceId=${encodeURIComponent(evidenceId)}`;
}

/** An unrecognised outcome is treated as NOT allowed — the action stays disabled. */
export function parseExportEligibility(payload: unknown): ExportEligibility | null {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const outcome = typeof d["outcome"] === "string" ? (d["outcome"] as string) : null;
  if (!outcome) return null;
  return {
    outcome: (OUTCOMES as readonly string[]).includes(outcome) ? (outcome as ExportOutcome) : "BLOCKED_BY_POLICY",
    reason: typeof d["reason"] === "string" ? (d["reason"] as string) : "",
    lifecycleState: typeof d["lifecycleState"] === "string" ? (d["lifecycleState"] as string) : null,
  };
}

/** GovernedExportAction OUTCOME_LABEL, verbatim. */
export const EXPORT_OUTCOME_LABEL: Record<ExportOutcome, string> = {
  ALLOWED: "Eligible",
  BLOCKED_BY_HOLD: "Blocked by legal hold",
  BLOCKED_BY_LIFECYCLE: "Blocked by lifecycle state",
  BLOCKED_BY_REVIEW_GATE: "Blocked by active destruction review",
  BLOCKED_BY_POLICY: "Blocked by workspace policy",
};

/** GovernedExportAction NEXT_STEP, verbatim. */
export const EXPORT_NEXT_STEP: Record<ExportOutcome, string> = {
  ALLOWED: "",
  BLOCKED_BY_HOLD: "Release the active legal hold from the governance surface before retrying.",
  BLOCKED_BY_LIFECYCLE:
    "The current lifecycle state prevents this action. Wait for the operator review to complete, or restore from archival.",
  BLOCKED_BY_REVIEW_GATE: "An active destruction review must resolve before exports proceed.",
  BLOCKED_BY_POLICY: "Workspace policy disallows this action. Update the policy from the governance surface.",
};

export const EXPORT_CHECK_FAILED = "Could not check export eligibility.";
export const EXPORT_NO_WORKSPACE = "A workspace context is required to check eligibility.";

export function exportBlockedMessage(e: ExportEligibility): string {
  return [EXPORT_OUTCOME_LABEL[e.outcome], EXPORT_NEXT_STEP[e.outcome]].filter(Boolean).join(". ").replace(/\.\./g, ".");
}
