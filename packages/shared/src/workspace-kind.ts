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
 * PHASE 12 CORRECTIVE PASS §5.2 (ARCH-002, 2026-08-06) — THE PLAN-DERIVED
 * FALLBACK IS GONE.
 *
 * This function used to end with:
 *
 *     if (input.isPersonal === false) {
 *       return input.billingPlan === "ENTERPRISE" ? "ORGANIZATION" : "OWNED";
 *     }
 *
 * which infers a TENANCY fact from a COMMERCIAL one. The consequences were not
 * hypothetical: an Owned workspace whose account was upgraded to ENTERPRISE
 * silently became an ORGANIZATION workspace to the authorization chain, which
 * then enforced customer-Organization lifecycle against a workspace that has
 * no customer Organization; and the same workspace downgraded silently stopped
 * having it enforced. Neither transition was a decision anyone made, and
 * neither produced an audit record.
 *
 * The column is now NOT NULL (migration 20271125000000), backfilled from
 * structural authority only, and every writer supplies it explicitly. There is
 * therefore nothing left to fall back TO, and a row that reaches here without
 * a kind is a real defect that must be visible rather than papered over.
 *
 * Fail-closed semantics (locked):
 *   - team row unprovable        → UNKNOWN;
 *   - explicit persisted kind    → that kind;
 *   - isPersonal = true          → PERSONAL (a STRUCTURAL fact, see below);
 *   - anything else              → UNKNOWN. Callers fail closed.
 *
 * `isPersonal` is kept because it is not an inference: it is the same
 * structural authority the backfill classifies from, the database now makes it
 * equivalent to the PERSONAL kind by CHECK constraint, and a rolling deploy
 * that reads a row before the contract migration lands must not lock a user
 * out of their own Personal Space. `billingPlan` is kept in the SHAPE and
 * never read; `phase-12-arch-002-workspace-kind-authority.test.ts` fails if it
 * becomes readable again.
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
  /**
   * Persisted Team.billingPlan.
   *
   * RETAINED IN THE SHAPE, IGNORED IN THE DECISION. Removing the field would
   * force an edit at every call site for no behavioural gain, and would hide
   * the fact that this input used to matter. It is never read; the gate test
   * fails if it becomes readable again.
   */
  billingPlan?: string | null | undefined;
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
  // The PERSONAL-SPACE OWNERSHIP INVARIANT is retained, and it is not an
  // inference: `is_personal` is a structural fact about how the row came to
  // exist, it is the same authority migration 20271124000000 backfills from,
  // and 20271125000000 adds a CHECK making `workspace_kind = 'PERSONAL'` and
  // `is_personal = TRUE` equivalent in the database. Keeping it also means a
  // rolling deploy that reads a row before the contract migration lands does
  // not lock a user out of their own Personal Space.
  if (input.isPersonal === true) return "PERSONAL";

  // Everything else fails closed. There is no longer anything to derive a kind
  // FROM: the column is NOT NULL, every writer supplies it, and the plan-based
  // branch that used to live here is the defect ARCH-002 removed.
  return "UNKNOWN";
}
