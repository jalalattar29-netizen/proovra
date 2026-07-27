/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical Workspace-kind
 * classifier.
 *
 * A Team (workspace) is one of three kinds:
 *   PERSONAL     — the owner's bootstrap Personal Space (isPersonal=true),
 *                  backed by an internal SYSTEM Organization (never a
 *                  customer-lifecycle boundary).
 *   OWNED        — a paid single-owner workspace that is NOT an enterprise
 *                  organization; also backed by a SYSTEM Organization.
 *   ORGANIZATION — an enterprise operational workspace backed by a CUSTOMER
 *                  Organization, which IS a governance / contract / lifecycle
 *                  boundary (ACTIVE / SUSPENDED / ARCHIVED).
 *
 * The canonical source is the persisted `Team.workspaceKind`. During the
 * migration window some rows created before the P1 backfill carry NULL; we
 * classify those with the SAME deterministic rule the backfill uses
 * (isPersonal → PERSONAL; ENTERPRISE plan → ORGANIZATION; else OWNED).
 *
 * If the kind cannot be proven (the team row / its fields are not loaded),
 * the result is UNKNOWN and callers MUST fail closed — Organization
 * lifecycle enforcement is never silently skipped.
 */

// Corrected 2026-07-22 — the classifier is a DOMAIN fact; its single
// implementation lives in the general domain package, not shared-billing.
import { normalizeWorkspaceKind } from "@proovra/shared";

export type ResolvedWorkspaceKind =
  | "PERSONAL"
  | "OWNED"
  | "ORGANIZATION"
  | "UNKNOWN";

export type WorkspaceKindInput = {
  /** Persisted Team.workspaceKind (nullable during the migration window). */
  workspaceKind: string | null | undefined;
  /** Persisted Team.isPersonal. */
  isPersonal: boolean | null | undefined;
  /** Persisted Team.billingPlan (PlanType). */
  billingPlan: string | null | undefined;
  /**
   * Whether the Team row itself was loaded. When false, nothing about the
   * workspace can be proven and the result is UNKNOWN (fail closed).
   */
  teamLoaded: boolean;
};

export function resolveWorkspaceKind(
  input: WorkspaceKindInput,
): ResolvedWorkspaceKind {
  // PHASE 9 §9.4 corrected (2026-07-22) — the classification math moved to
  // the shared pure policy (`normalizeWorkspaceKind`, @proovra/shared-billing)
  // so API and worker share ONE implementation. This module remains the
  // canonical API entry point; it delegates with zero duplicated logic.
  return normalizeWorkspaceKind(input);
}

/**
 * Whether CUSTOMER-Organization lifecycle (ACTIVE/SUSPENDED/ARCHIVED)
 * applies to this workspace kind. Only ORGANIZATION workspaces are backed by
 * a lifecycle-managed CUSTOMER Organization. PERSONAL/OWNED are backed by
 * SYSTEM containers and are exempt. UNKNOWN is NOT exempt — callers must
 * fail closed rather than treat it as "not applicable".
 */
export function organizationLifecycleApplies(
  kind: ResolvedWorkspaceKind,
): boolean {
  return kind === "ORGANIZATION";
}
