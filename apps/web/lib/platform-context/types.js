/**
 * Phase 32.8 Foundation — Canonical PlatformContextEnvelope types
 * (frontend mirror of services/api/src/services/platform-context/types.ts).
 *
 * These types are the ONE shape the frontend is permitted to read for
 * user identity, workspace, role, persona, capabilities, navigation,
 * and platform-admin elevation. Every other "authority" derivation
 * across the web app is forbidden — see the F-6 grep tests.
 *
 * Hard rules — enforced by tests:
 *   1. No parallel role/scope/persona/capability enums. Frontend uses
 *      the bounded values declared here.
 *   2. Authority schema versions guard against stale envelopes during
 *      workspace switching — the state machine discards envelopes
 *      with mismatched versions.
 *   3. The envelope shape is identical to the backend response.
 */
export const AUTHORITY_SCHEMA_VERSION = 2;
export const CAPABILITY_SCHEMA_VERSION = 2;
// Phase B0 / STAGE 1 SCHEMA ALIGNMENT — bumped from 1 → 2 to match the
// API's emitted navigationSchemaVersion (NAVIGATION_SCHEMA_VERSION = 2 in
// services/api/src/services/platform-context/types.ts). The previous value
// (1) caused the client to reject every envelope the API produced and the
// provider showed a permanent "Refresh required" banner. The previously
// accepted value (1) is whitelisted below in
// ACCEPTED_NAVIGATION_SCHEMA_VERSIONS so any envelopes still in flight from
// a short legacy window do not lock users out.
export const NAVIGATION_SCHEMA_VERSION = 2;
// =============================================================================
// STAGE 1 SCHEMA ALIGNMENT — Accepted-version whitelists.
//
// `versionsAreCompatible` (see ./PlatformContextProvider.tsx) consults these
// arrays rather than equality with the single current constant so that the
// client tolerates BOTH the previous accepted version AND the current
// emitted version. This protects users who load a page during a brief window
// where the API and client are at adjacent schema versions.
//
// HARD RULES:
//   - These lists must always INCLUDE the matching `*_SCHEMA_VERSION`
//     constant above (the current build's expected value).
//   - They are intentionally narrow: only the immediately-previous accepted
//     version is added. Wider tolerance hides real schema drift.
//   - Adding a new accepted version is ALWAYS paired with the build's
//     handling code for that older shape — never widen without code that
//     copes with the older payload.
// =============================================================================
export const ACCEPTED_AUTHORITY_SCHEMA_VERSIONS = [
    // API emits 2 by default and 3 when the client opts in via the
    // `x-platform-context-version` header. Both shapes are consumed by this
    // build (legacy `workspace` + canonical `activeSpace` both populated).
    2, 3,
];
export const ACCEPTED_CAPABILITY_SCHEMA_VERSIONS = [
    // Current. No prior accepted value to retain.
    2,
];
export const ACCEPTED_NAVIGATION_SCHEMA_VERSIONS = [
    // 1 = previously accepted (pre-alignment); 2 = current API emission.
    1, 2,
];
export const WORKSPACE_ROLES = [
    "OWNER",
    "ADMIN",
    "MEMBER",
    "VIEWER",
];
export const WORKSPACE_SCOPES = ["PERSONAL", "TEAM"];
export const WORKSPACE_PLANS = ["FREE", "PAYG", "PRO", "TEAM"];
export const PERSONAS = [
    "INDIVIDUAL",
    "WORKSPACE_OWNER",
    "TEAM_ADMIN",
    "TEAM_MEMBER",
    "TEAM_VIEWER",
];
export const CAPABILITY_KEYS = [
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
    "REVIEWER_OPS_VIEW",
    "REVIEWER_OPS_ACT",
    "SLA_VIEW",
    "ESCALATIONS_VIEW",
    "GOVERNANCE_VIEW",
    "GOVERNANCE_ACT",
    "LIFECYCLE_VIEW",
    "REVIEW_ASSIGN",
    "REVIEW_REASSIGN",
    "REVIEW_ESCALATE",
    "LEGAL_HOLD_PLACE",
    "LEGAL_HOLD_RELEASE",
    "RETENTION_MANAGE",
    "EXPORT_GOVERNANCE_MANAGE",
    "OPS_CENTER_VIEW",
    "OBSERVABILITY_VIEW",
    "RUNBOOKS_VIEW",
    "SECURITY_CENTER_VIEW",
    "TEAM_VIEW",
    "TEAM_MANAGE",
    "BILLING_VIEW",
    "BILLING_MANAGE",
    "INTEGRATIONS_MANAGE",
    "INTAKE_LINKS_MANAGE",
    "SETTINGS_VIEW",
    "SETTINGS_MANAGE",
    "PLATFORM_ADMIN",
    "BULK_ACTIONS",
    // ENTERPRISE TENANT MODEL — Account / Personal Space / Organization split.
    //
    // @deprecated PHASE 3 — The PERSONAL_* and ORG_* namespaces below
    //   were granted by `capability-registry.ts` for a planned
    //   namespace migration that never reached the consumers. Phase 1
    //   audit confirmed that no route, no UI surface, and no service
    //   reads these keys today; the equivalent non-namespaced keys
    //   (EVIDENCE_VIEW, CASES_VIEW, REPORTS_VIEW, SEARCH_VIEW,
    //   REVIEWER_OPS_VIEW, GOVERNANCE_VIEW, OPS_CENTER_VIEW,
    //   TEAM_MANAGE, BILLING_MANAGE) ARE consumed and remain the
    //   canonical gating keys.
    //
    //   The ACCOUNT_* and ORGANIZATION_CREATE/JOIN keys below ARE
    //   consumed by `routeRegistry.ts` (account-tier routes) — they
    //   are NOT deprecated.
    //
    //   Phase 3 retains the dead PERSONAL_* + ORG_* keys to avoid
    //   a destructive capability-shape change pre-Phase-4. Future
    //   phases will either wire them to real consumers or remove
    //   them after a deprecation window.
    //   See docs/architecture/domain-debt-register.md (DBT-CAP-01).
    "ACCOUNT_SETTINGS_VIEW",
    "ACCOUNT_BILLING_VIEW",
    "ACCOUNT_UPGRADE_VIEW",
    "ORGANIZATION_CREATE",
    "ORGANIZATION_JOIN",
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
    // Phase E3 — operational automation foundation.
    "AUTOMATION_VIEW",
    "AUTOMATION_MANAGE",
    // Phase E4 — operational analytics (single bounded VIEW capability).
    "ANALYTICS_VIEW",
];
// =============================================================================
// PHASE 38 — Workspace persona profile (UX-layer only).
//
// The profile drives ordering, defaults, and terminology. It NEVER grants
// capabilities — pages MUST keep gating features on `ctx.can(CAPABILITY)`
// even when the persona prioritizes a surface.
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
// Convenience predicate used by the workspace switcher + tests.
export function isReady(s) {
    return s.name === "READY";
}
