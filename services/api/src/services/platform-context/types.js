/**
 * Phase 32.8 Foundation — Canonical platform-context types.
 *
 * This module is the ONE source of truth for:
 *   - WorkspaceRole vocabulary (matches Prisma TeamRole)
 *   - WorkspaceScope vocabulary (PERSONAL vs TEAM)
 *   - Persona vocabulary (resolved from role + scope, deterministic)
 *   - PlatformContextEnvelope shape consumed by GET /v1/platform/context
 *
 * Hard rules — see services/api/test/phase-32-8-foundation-platform-context.test.ts
 * for the contract assertions that enforce them:
 *
 *   1. NO additional role enum is created anywhere. Frontend re-exports
 *      these constants — it must not declare parallel enums.
 *
 *   2. PERSONAL workspaces ALWAYS resolve membership.role to OWNER. A
 *      user is the owner of their own evidence by definition.
 *
 *   3. PRO/TEAM plan ≠ workspace scope. A PRO user on a personal
 *      workspace must NOT render as MEMBER of any team.
 *
 *   4. The envelope carries `authoritySchemaVersion`,
 *      `capabilitySchemaVersion`, and `navigationSchemaVersion`. The
 *      frontend MUST discard envelopes with mismatched versions during
 *      workspace switches.
 *
 *   5. Server-resolved navigation is returned pre-filtered. Frontend
 *      renders verbatim — no client-side capability checks.
 */
// =============================================================================
// Authority schema versions
// =============================================================================
/**
 * Bumped when the envelope outer shape changes.
 *
 * Phase B0 — server now accepts an `x-platform-context-version`
 * request header. When the client sends `3` the server stamps the
 * response with `authoritySchemaVersion = 3`; otherwise it stamps
 * `2` (the pre-B0 default). The wire data still carries both legacy
 * `workspace` and canonical `account` / `personalSpace` /
 * `organizations[]` / `activeSpace` for compatibility — clients on
 * v3 are expected to consume only the canonical sections.
 *
 * The value emitted on the wire is `number` (not the `as const`
 * literal) because the server runtime decides v2 vs v3 per request.
 */
export const AUTHORITY_SCHEMA_VERSION = 3;
/** Bumped when CAPABILITY_KEYS is extended or semantics change. */
export const CAPABILITY_SCHEMA_VERSION = 2;
/** Bumped when NAVIGATION groups/items/ids shift. */
export const NAVIGATION_SCHEMA_VERSION = 2;
// =============================================================================
// Phase 1A — 8-pillar canonical architecture.
//
// Mirrors the client-side PROOVRA_PILLARS in
// apps/web/lib/navigation/pillarRegistry.ts. Order is canonical and
// drives both sidebar render order and server-side pillar projection.
// =============================================================================
export const PROOVRA_PILLARS = [
    "HOME",
    "CAPTURE",
    "CASES",
    "REVIEW",
    "GOVERNANCE",
    "OPERATIONS",
    "ADMIN",
    "TRUST",
];
// =============================================================================
// Bounded role vocabulary (mirrors Prisma TeamRole exactly)
// =============================================================================
export const WORKSPACE_ROLES = [
    "OWNER",
    "ADMIN",
    "MEMBER",
    "VIEWER",
];
export function isWorkspaceRole(value) {
    return (typeof value === "string" &&
        WORKSPACE_ROLES.includes(value));
}
// =============================================================================
// Bounded scope vocabulary
// =============================================================================
export const WORKSPACE_SCOPES = ["PERSONAL", "TEAM"];
// =============================================================================
// Bounded persona vocabulary (resolved from role + scope, deterministic)
// =============================================================================
export const PERSONAS = [
    "INDIVIDUAL",
    "WORKSPACE_OWNER",
    "TEAM_ADMIN",
    "TEAM_MEMBER",
    "TEAM_VIEWER",
];
// =============================================================================
// PHASE 38 — Workspace persona profile vocabulary.
//
// This is the USE-CASE persona — distinct from the role-derived `Persona`
// above which captures (role × scope). The use-case persona drives UX
// ordering, terminology, dashboard emphasis, and capture defaults.
//
// HARD RULE: persona profiles are UX-LAYER ONLY.
//
//   - They MUST NOT grant capabilities.
//   - They MUST NOT bypass capability checks.
//   - They MUST NOT change the canonical access-helper outcomes.
//   - They MAY change ordering / defaults / terminology / emphasis.
//
// See test/phase-38-persona-foundation.test.ts for the contract.
// =============================================================================
export const WORKSPACE_PERSONA_PROFILES = [
    "INDIVIDUAL",
    "LAWYER",
    "INSURANCE",
    "INVESTIGATOR",
    "JOURNALIST",
    "ENTERPRISE_COMPLIANCE",
    "ADMIN_OPERATOR",
];
export const OPERATIONAL_DENSITY_PREFERENCES = [
    "compact",
    "comfortable",
    "spacious",
];
// =============================================================================
// Bounded plan vocabulary (mirrors Prisma PlanType)
// =============================================================================
export const WORKSPACE_PLANS = ["FREE", "PAYG", "PRO", "TEAM"];
// =============================================================================
// Capability keys — server-only resolution
// =============================================================================
export const CAPABILITY_KEYS = [
    // Workspace day-to-day
    "DASHBOARD_VIEW",
    "EVIDENCE_VIEW",
    "EVIDENCE_CAPTURE",
    "EVIDENCE_MANAGE",
    "CASES_VIEW",
    "CASES_MANAGE",
    "CASE_ASSIGN",
    "CASE_STATUS_CHANGE",
    "CASE_EVIDENCE_LINK",
    "CASE_COMMENT",
    "CASE_COMMENT_RESOLVE",
    "REPORTS_VIEW",
    "REPORTS_GENERATE",
    "SEARCH_VIEW",
    // Review & governance — view
    "REVIEWER_OPS_VIEW",
    "REVIEWER_OPS_ACT",
    "SLA_VIEW",
    "ESCALATIONS_VIEW",
    "GOVERNANCE_VIEW",
    "GOVERNANCE_ACT",
    "LIFECYCLE_VIEW",
    // Review & governance — fine-grained act (mutation gates)
    "REVIEW_ASSIGN",
    "REVIEW_REASSIGN",
    "REVIEW_ESCALATE",
    "LEGAL_HOLD_PLACE",
    "LEGAL_HOLD_RELEASE",
    "RETENTION_MANAGE",
    "EXPORT_GOVERNANCE_MANAGE",
    // Platform health
    "OPS_CENTER_VIEW",
    "OBSERVABILITY_VIEW",
    "RUNBOOKS_VIEW",
    "SECURITY_CENTER_VIEW",
    // Administration
    "TEAM_VIEW",
    "TEAM_MANAGE",
    "BILLING_VIEW",
    "BILLING_MANAGE",
    "INTEGRATIONS_MANAGE",
    "INTAKE_LINKS_MANAGE",
    "SETTINGS_VIEW",
    "SETTINGS_MANAGE",
    "PLATFORM_ADMIN",
    // Cross-cutting
    "BULK_ACTIONS",
    // ===========================================================================
    // ENTERPRISE TENANT MODEL — Account / Personal Space / Organization split.
    //
    // The keys below are the canonical replacement for the legacy capability
    // names. They are computed from (accountPlan, activeSpace.type, role) and
    // let pages render the right CTA without re-deriving role locally.
    //
    // The legacy keys above remain populated for backward compatibility — new
    // pages should consume the namespaced keys.
    // ===========================================================================
    // Account-tier — always available to an authenticated user, regardless of
    // which space is active.
    "ACCOUNT_SETTINGS_VIEW",
    "ACCOUNT_BILLING_VIEW",
    "ACCOUNT_UPGRADE_VIEW",
    "ORGANIZATION_CREATE",
    "ORGANIZATION_JOIN",
    // Personal-space-tier — gated to the active personal space.
    //
    // @deprecated PHASE 3 — The PERSONAL_* + ORG_* keys below are dead
    //   capabilities. They are granted by `capability-registry.ts` but
    //   never consumed: Phase 1 audit confirmed no route, no UI surface,
    //   and no service reads these keys. The equivalent non-namespaced
    //   keys (EVIDENCE_VIEW, CASES_VIEW, REPORTS_VIEW, SEARCH_VIEW,
    //   REVIEWER_OPS_VIEW, GOVERNANCE_VIEW, OPS_CENTER_VIEW, TEAM_MANAGE,
    //   BILLING_MANAGE) remain the canonical gating keys.
    //
    //   The ACCOUNT_* keys above (lines 253-257) ARE consumed by
    //   `apps/web/lib/navigation/routeRegistry.ts` for account-tier
    //   routes — they are NOT deprecated.
    //
    //   Phase 3 retains the dead PERSONAL_* + ORG_* keys to avoid a
    //   destructive capability-shape change pre-Phase-4. Future phases
    //   will either wire them to real consumers or remove them after a
    //   deprecation window.
    //   See docs/architecture/domain-debt-register.md (DBT-CAP-01).
    /** @deprecated PHASE 3 — dead key; no consumer. See block comment above. */
    "PERSONAL_CAPTURE",
    /** @deprecated PHASE 3 — dead key; no consumer. See block comment above. */
    "PERSONAL_EVIDENCE_VIEW",
    /** @deprecated PHASE 3 — dead key; no consumer. See block comment above. */
    "PERSONAL_CASES_VIEW",
    /** @deprecated PHASE 3 — dead key; no consumer. See block comment above. */
    "PERSONAL_REPORTS_VIEW",
    /** @deprecated PHASE 3 — dead key; no consumer. See block comment above. */
    "PERSONAL_SEARCH_VIEW",
    // Organization-tier — gated to an active organization workspace plus role.
    /** @deprecated PHASE 3 — dead key; no consumer. See block comment above. */
    "ORG_EVIDENCE_VIEW",
    /** @deprecated PHASE 3 — dead key; no consumer. See block comment above. */
    "ORG_CASES_VIEW",
    /** @deprecated PHASE 3 — dead key; no consumer. See block comment above. */
    "ORG_REPORTS_VIEW",
    /** @deprecated PHASE 3 — dead key; no consumer. See block comment above. */
    "ORG_SEARCH_VIEW",
    /** @deprecated PHASE 3 — dead key; no consumer. See block comment above. */
    "ORG_REVIEWER_OPS_VIEW",
    /** @deprecated PHASE 3 — dead key; no consumer. See block comment above. */
    "ORG_GOVERNANCE_VIEW",
    /** @deprecated PHASE 3 — dead key; no consumer. See block comment above. */
    "ORG_OPS_VIEW",
    /** @deprecated PHASE 3 — dead key; no consumer. See block comment above. */
    "ORG_TEAM_MANAGE",
    /** @deprecated PHASE 3 — dead key; no consumer. See block comment above. */
    "ORG_BILLING_MANAGE",
    // ===========================================================================
    // Phase E3 — Operational Automation Foundation
    //
    // VIEW: any team writer can read rules + run history (operators need
    //   to know what automation runs in their workspace).
    // MANAGE: owner/admin only — rule create / update / enable / disable.
    // ===========================================================================
    "AUTOMATION_VIEW",
    "AUTOMATION_MANAGE",
    // ===========================================================================
    // Phase E4 — Analytics & Operational Intelligence
    //
    // Single bounded VIEW capability. Reading operational analytics is a
    // read-only surface; no MANAGE counterpart exists because analytics
    // is not mutable. Granted to any team writer + platform admin.
    // ===========================================================================
    "ANALYTICS_VIEW",
];
