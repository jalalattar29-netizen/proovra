/**
 * CANONICAL TENANT/DOMAIN CLASSIFIER (relocated 2026-07-22).
 *
 * WorkspaceKind is a TENANT/DOMAIN fact, not a commercial conclusion — so the
 * single normalization implementation lives HERE in the general domain
 * package, not in shared-billing. Layering:
 *
 *   this domain normalizer → explicit WorkspaceKind
 *   → shared-billing pure commercial policy (receives the kind, never infers)
 *   → resolveCommercialContext.
 *
 * Consumers: services/api `identity/workspace-kind.ts` (the canonical API
 * entry, delegating) and services/worker `workspace-billing.ts`.
 *
 * Fail-closed semantics (locked):
 *   - team row unprovable → UNKNOWN;
 *   - explicit persisted kind wins;
 *   - isPersonal=true → PERSONAL;
 *   - isPersonal=false → deterministic backfill: ENTERPRISE billing string →
 *     ORGANIZATION, else OWNED (the plan string is a BACKFILL SIGNAL input
 *     only — commercial coverage still requires the explicit ORGANIZATION
 *     kind plus contract state downstream);
 *   - isPersonal unprovable → UNKNOWN (never guessed).
 */

export type NormalizedWorkspaceKind =
  | "PERSONAL"
  | "OWNED"
  | "ORGANIZATION"
  | "UNKNOWN";

export type WorkspaceKindNormalizationInput = {
  /** Persisted Team.workspaceKind (nullable during the migration window). */
  workspaceKind: string | null | undefined;
  /** Persisted Team.isPersonal. */
  isPersonal: boolean | null | undefined;
  /** Persisted Team.billingPlan — deterministic backfill signal ONLY. */
  billingPlan: string | null | undefined;
  /** Whether the Team row itself was loaded (false → UNKNOWN, fail closed). */
  teamLoaded: boolean;
};

export function normalizeWorkspaceKind(
  input: WorkspaceKindNormalizationInput,
): NormalizedWorkspaceKind {
  if (!input.teamLoaded) return "UNKNOWN";
  if (
    input.workspaceKind === "PERSONAL" ||
    input.workspaceKind === "OWNED" ||
    input.workspaceKind === "ORGANIZATION"
  ) {
    return input.workspaceKind;
  }
  if (input.isPersonal === true) return "PERSONAL";
  if (input.isPersonal === false) {
    return input.billingPlan === "ENTERPRISE" ? "ORGANIZATION" : "OWNED";
  }
  // Team loaded but isPersonal unprovable → fail closed.
  return "UNKNOWN";
}
