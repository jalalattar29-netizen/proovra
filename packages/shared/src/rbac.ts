/**
 * Phase 26 — Enterprise RBAC engine canonical types.
 *
 * Browser-safe (no Prisma, no Node imports). The RBAC engine in the
 * API layer (`services/api/src/services/access-control/rbac-engine.service.ts`)
 * is the SINGLE writer of access decisions; this file holds the shape +
 * inheritance helpers used by both the engine and the UI.
 *
 * Hard invariants:
 *   - Explicit deny ALWAYS wins. Even if a delegated scope or a
 *     capability grant would allow, a higher-precedence deny overrides.
 *   - Inheritance is deterministic: org policy → workspace policy →
 *     member explicit. Each layer either ALLOW, DENY, or DEFER.
 *   - Temporary elevation is opt-in per member + per permission with
 *     bounded expiry; the engine refuses to elevate beyond the
 *     workspace policy's `allowed_elevations` set.
 *   - No protocol-specific data (SAML / OIDC / SCIM) leaks into RBAC
 *     types. SSO + SCIM live in `identity-providers.ts`.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Permission outcome
// -----------------------------------------------------------------------------

export const RBAC_DECISION_OUTCOMES = [
  "ALLOW",
  "DENY",
  "STEP_UP_REQUIRED",
  "NOT_APPLICABLE",
] as const;
export type RbacDecisionOutcome = (typeof RBAC_DECISION_OUTCOMES)[number];

// -----------------------------------------------------------------------------
// Decision source — used by the audit chain + the admin UI's
// "where does this permission come from?" inspector.
// -----------------------------------------------------------------------------

export const RBAC_DECISION_SOURCES = [
  "ORG_POLICY",          // organization-level allow/deny (Phase 17 org policy)
  "WORKSPACE_POLICY",    // workspace-level allow/deny (Phase 14 governance)
  "ROLE_MATRIX",         // canonical role → permission mapping
  "CAPABILITY_GRANT",    // explicit per-member grant (Phase 17)
  "DELEGATED_SCOPE",     // delegated admin scope (Phase 17)
  "TEMPORARY_ELEVATION", // bounded time-windowed grant
  "SERVICE_ACCOUNT",     // API credential scope
  "CONTRIBUTOR",         // anonymous / external contributor allowlist
  "EXPLICIT_DENY",       // explicit deny override
] as const;
export type RbacDecisionSource = (typeof RBAC_DECISION_SOURCES)[number];

// -----------------------------------------------------------------------------
// Decision shape — one row per (actor, permission) evaluation.
// -----------------------------------------------------------------------------

export type RbacDecision = {
  outcome: RbacDecisionOutcome;
  source: RbacDecisionSource;
  /** Operator-readable reason. Catalog-bound. */
  reason: string;
  /** Step-up purpose when outcome === STEP_UP_REQUIRED. */
  stepUpPurpose?: string | null;
};

// -----------------------------------------------------------------------------
// Inheritance helper
// -----------------------------------------------------------------------------

/**
 * Apply the org → workspace → member precedence chain to a list of
 * layer decisions. The chain is ordered most-specific-first; the helper
 * returns the first DENY (always wins) or the first ALLOW (when no
 * DENY surfaces), else NOT_APPLICABLE.
 */
export function applyInheritanceChain(
  layers: ReadonlyArray<RbacDecision>,
): RbacDecision {
  // DENY anywhere in the chain wins.
  for (const l of layers) {
    if (l.outcome === "DENY") return l;
  }
  // Otherwise the first ALLOW wins.
  for (const l of layers) {
    if (l.outcome === "ALLOW") return l;
  }
  // Step-up required propagates if no allow/deny.
  for (const l of layers) {
    if (l.outcome === "STEP_UP_REQUIRED") return l;
  }
  return {
    outcome: "NOT_APPLICABLE",
    source: "ROLE_MATRIX",
    reason: "no matching layer",
  };
}

// -----------------------------------------------------------------------------
// Permission snapshot — operator-safe projection used by the admin UI
// to render "what can this member do here?"
// -----------------------------------------------------------------------------

export type RbacPermissionRow = {
  permission: string;
  outcome: RbacDecisionOutcome;
  source: RbacDecisionSource;
  /** Display label for the source ("Owner role", "Capability grant", etc). */
  sourceLabel: string;
  reason: string;
};

export type RbacMemberSnapshot = {
  teamId: string;
  userId: string;
  canonicalRole: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  permissions: ReadonlyArray<RbacPermissionRow>;
  /** Active capability grants on this member. */
  capabilityGrantCount: number;
  /** Active delegated admin scopes on this member. */
  delegatedScopeCount: number;
  /** Any temporary elevation row that has not yet expired. */
  temporaryElevationCount: number;
  computedAtUtc: string;
};

// -----------------------------------------------------------------------------
// Temporary elevation — bounded ALLOW for a specific permission within
// a window. Used for emergency access. The engine refuses to elevate
// beyond the workspace's `allowed_elevations` set.
// -----------------------------------------------------------------------------

export const TEMPORARY_ELEVATION_MIN_SECONDS = 60; // 1 min
export const TEMPORARY_ELEVATION_MAX_SECONDS = 4 * 3600; // 4 hours
export const TEMPORARY_ELEVATION_DEFAULT_SECONDS = 30 * 60; // 30 min

export const TemporaryElevationSchema = z
  .object({
    teamId: z.string().uuid(),
    userId: z.string().uuid(),
    permission: z.string().min(1).max(96),
    reason: z.string().min(1).max(400),
    ttlSeconds: z
      .number()
      .int()
      .min(TEMPORARY_ELEVATION_MIN_SECONDS)
      .max(TEMPORARY_ELEVATION_MAX_SECONDS)
      .optional(),
  })
  .strict();
export type TemporaryElevationInput = z.infer<typeof TemporaryElevationSchema>;

// -----------------------------------------------------------------------------
// Source label catalog (operator-readable). Used by the admin UI's
// permission matrix tooltip.
// -----------------------------------------------------------------------------

export const RBAC_SOURCE_LABELS: Record<RbacDecisionSource, string> = {
  ORG_POLICY: "Organization policy",
  WORKSPACE_POLICY: "Workspace policy",
  ROLE_MATRIX: "Role default",
  CAPABILITY_GRANT: "Capability grant",
  DELEGATED_SCOPE: "Delegated admin",
  TEMPORARY_ELEVATION: "Temporary elevation",
  SERVICE_ACCOUNT: "Service account scope",
  CONTRIBUTOR: "Contributor allowlist",
  EXPLICIT_DENY: "Explicit deny",
};

export function rbacSourceLabel(source: RbacDecisionSource): string {
  return RBAC_SOURCE_LABELS[source];
}

// -----------------------------------------------------------------------------
// Permission domain catalog — Phase 26 brief calls these out explicitly
// for the admin "Permission Matrix" UI. The catalog mirrors the
// `PERMISSIONS` namespace prefixes (evidence.*, review.*, etc).
// -----------------------------------------------------------------------------

export const RBAC_PERMISSION_DOMAINS = [
  "evidence",
  "review",
  "reviewer_ops",
  "exports",
  "governance",
  "retention",
  "legal_hold",
  "integrations",
  "api",
  "notifications",
  "incidents",
  "workflows",
  "search",
  "access_reviews",
  "org_admin",
  "workspace_admin",
  "billing",
  "trust_center",
  "identity",
  "intelligence",
  "collaboration",
  "publication",
] as const;
export type RbacPermissionDomain = (typeof RBAC_PERMISSION_DOMAINS)[number];

/**
 * Extract the leading domain segment from a canonical permission ID
 * (e.g. `review.queue.read` → `review`, `evidence.generate_package`
 * → `evidence`). Returns null when the string has no dot.
 */
export function rbacPermissionDomain(
  permission: string,
): RbacPermissionDomain | null {
  const head = permission.split(".")[0];
  return (RBAC_PERMISSION_DOMAINS as ReadonlyArray<string>).includes(head)
    ? (head as RbacPermissionDomain)
    : null;
}

// -----------------------------------------------------------------------------
// Granularity — Phase 26 brief defines the operation verbs.
// -----------------------------------------------------------------------------

export const RBAC_PERMISSION_VERBS = [
  "READ",
  "WRITE",
  "DELETE",
  "EXPORT",
  "APPROVE",
  "ASSIGN",
  "ESCALATE",
  "GOVERN",
  "ADMINISTER",
] as const;
export type RbacPermissionVerb = (typeof RBAC_PERMISSION_VERBS)[number];
