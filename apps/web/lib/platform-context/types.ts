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

export const AUTHORITY_SCHEMA_VERSION = 2 as const;
export const CAPABILITY_SCHEMA_VERSION = 2 as const;
// Phase B0 / STAGE 1 SCHEMA ALIGNMENT — bumped from 1 → 2 to match the
// API's emitted navigationSchemaVersion (NAVIGATION_SCHEMA_VERSION = 2 in
// services/api/src/services/platform-context/types.ts). The previous value
// (1) caused the client to reject every envelope the API produced and the
// provider showed a permanent "Refresh required" banner. The previously
// accepted value (1) is whitelisted below in
// ACCEPTED_NAVIGATION_SCHEMA_VERSIONS so any envelopes still in flight from
// a short legacy window do not lock users out.
export const NAVIGATION_SCHEMA_VERSION = 2 as const;

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
export const ACCEPTED_AUTHORITY_SCHEMA_VERSIONS: ReadonlyArray<number> = [
  // API emits 2 by default and 3 when the client opts in via the
  // `x-platform-context-version` header. Both shapes are consumed by this
  // build (legacy `workspace` + canonical `activeSpace` both populated).
  2, 3,
];
export const ACCEPTED_CAPABILITY_SCHEMA_VERSIONS: ReadonlyArray<number> = [
  // Current. No prior accepted value to retain.
  2,
];
export const ACCEPTED_NAVIGATION_SCHEMA_VERSIONS: ReadonlyArray<number> = [
  // 1 = previously accepted (pre-alignment); 2 = current API emission.
  1, 2,
];

export const WORKSPACE_ROLES = [
  "OWNER",
  "ADMIN",
  "MEMBER",
  "VIEWER",
] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const WORKSPACE_SCOPES = ["PERSONAL", "TEAM"] as const;
export type WorkspaceScope = (typeof WORKSPACE_SCOPES)[number];

export const WORKSPACE_PLANS = ["FREE", "PAYG", "PRO", "TEAM"] as const;
export type WorkspacePlan = (typeof WORKSPACE_PLANS)[number];

export const PERSONAS = [
  "INDIVIDUAL",
  "WORKSPACE_OWNER",
  "TEAM_ADMIN",
  "TEAM_MEMBER",
  "TEAM_VIEWER",
] as const;
export type Persona = (typeof PERSONAS)[number];

export type SectionStatus = "ok" | "degraded" | "unavailable" | "not_applicable";

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
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export type CapabilityMap = Record<CapabilityKey, boolean>;

export type PlatformContextUser = {
  id: string;
  email: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  locale: string | null;
  timezone: string | null;
};

export type PlatformContextPlatform = {
  isPlatformAdmin: boolean;
  platformRole: string | null;
};

export type PlatformContextMembership = {
  role: WorkspaceRole | null;
  isOwner: boolean;
  isAdmin: boolean;
  memberCount: number;
};

export type PlatformContextWorkspace = {
  status: "active" | "no-workspace";
  id: string | null;
  name: string | null;
  scope: WorkspaceScope | null;
  plan: WorkspacePlan | null;
  membership: PlatformContextMembership;
};

export type PlatformContextFlags = {
  isPersonalWorkspace: boolean;
  isTeamWorkspace: boolean;
  isProAccount: boolean;
  isEnterpriseWorkspace: boolean;
};

export type PlatformContextPersona = {
  resolvedPersona: Persona;
};

export type PlatformContextNavItem = {
  id: string;
  label: string;
  href: string;
  iconKey: string;
  badgeKey: string | null;
  domain: string;
};

export type PlatformContextNavGroup = {
  id: string;
  title: string;
  domain: string;
  items: ReadonlyArray<PlatformContextNavItem>;
};

export type PlatformContextNavigation = {
  status: SectionStatus;
  /**
   * @deprecated Phase ROUTE-FIX — retained for backwards compatibility.
   * Prefer `sidebar.groups` + `accountMenu.items` so account routes
   * are never hidden by workspace-scoped gating.
   */
  groups: ReadonlyArray<PlatformContextNavGroup>;
  sidebar: { groups: ReadonlyArray<PlatformContextNavGroup> };
  accountMenu: { items: ReadonlyArray<PlatformContextNavItem> };
};

export type PlatformContextAvailableWorkspace = {
  id: string;
  name: string | null;
  scope: WorkspaceScope;
  role: WorkspaceRole | null;
};

// =============================================================================
// ENTERPRISE TENANT MODEL — Account / Personal Space / Organization
//
// Mirrors services/api/src/services/platform-context/types.ts. The legacy
// `workspace` + `availableWorkspaces` fields above remain on the envelope for
// backward compatibility for one phase. New code paths must consume
// `account`, `personalSpace`, `organizations`, and `activeSpace`.
// =============================================================================

export type PlatformContextAccount = {
  userId: string;
  email: string | null;
  displayName: string | null;
  accountPlan: WorkspacePlan | null;
  accountStatus: "active" | "suspended" | "pending";
};

export type PlatformContextPersonalSpace = {
  status: "active" | "degraded";
  id: string | null;
  label: "Personal Space";
  ownerUserId: string;
  plan: WorkspacePlan | null;
};

export type PlatformContextOrganization = {
  id: string;
  name: string | null;
  displayName: string | null;
  role: WorkspaceRole | null;
  membershipStatus: "ACTIVE" | "PENDING" | "INACTIVE";
  plan: WorkspacePlan | null;
  memberCount: number;
};

export type PlatformContextActiveSpace =
  | {
      type: "PERSONAL";
      id: string | null;
      displayName: "Personal Space";
      roleLabel: "Owner";
    }
  | {
      type: "ORGANIZATION";
      id: string;
      displayName: string | null;
      roleLabel: WorkspaceRole | null;
    };

export type PlatformContextDuplicatePersonalCandidate = {
  teamId: string;
  name: string | null;
  ownerUserId: string;
  memberCount: number;
  reasons: ReadonlyArray<
    | "name_matches_email_personal"
    | "single_owner_member"
    | "no_invites"
    | "free_plan"
  >;
};

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
] as const;
export type WorkspacePersonaProfile =
  (typeof WORKSPACE_PERSONA_PROFILES)[number];

export const OPERATIONAL_DENSITY_PREFERENCES = [
  "compact",
  "comfortable",
  "spacious",
] as const;
export type OperationalDensityPreference =
  (typeof OPERATIONAL_DENSITY_PREFERENCES)[number];

export type PlatformContextPersonaProfile = {
  teamId: string | null;
  primaryProfile: WorkspacePersonaProfile;
  secondaryUseCases: ReadonlyArray<WorkspacePersonaProfile>;
  onboardingCompleted: boolean;
  preferredDashboardLayout: string | null;
  operationalDensityPreference: OperationalDensityPreference;
  featurePriorityOverrides: ReadonlyArray<string>;
  resolvedRolePersona: Persona;
  source: "default" | "stored";
};

export type PlatformContextDiagnostics = {
  sectionStatus: {
    user: SectionStatus;
    workspace: SectionStatus;
    capabilities: SectionStatus;
    navigation: SectionStatus;
    availableWorkspaces: SectionStatus;
  };
  resolvedAt: string;
  requestId: string;
  /**
   * Phase EMERGENCY-RECOVERY — bounded diagnostic surface.
   */
  workspaceSource?:
    | "current_workspace_id"
    | "personal_bootstrap"
    | "personal_bootstrap_after_stale";
  bootstrap?: {
    attempted: boolean;
    reused: boolean;
    created: boolean;
    activeWorkspaceUpdated: boolean;
  };
  // ENTERPRISE TENANT MODEL diagnostics.
  activeSpaceSource?:
    | "personal_space_bootstrap"
    | "personal_space_existing"
    | "organization"
    | "unavailable";
  staleWorkspaceHealed?: boolean;
  duplicatePersonalRowsDetected?: number;
};

/**
 * Phase EMERGENCY-RECOVERY — structured recovery actions returned by
 * the canonical envelope when the workspace cannot be assembled
 * normally. The frontend renders these as buttons/links in a
 * recovery panel (never a blank shell).
 */
export type PlatformContextRecoveryAction = {
  id: "create_personal_workspace" | "create_team" | "open_settings" | "retry";
  label: string;
  href: string | null;
};

export type PlatformContextEnvelope = {
  authoritySchemaVersion: number;
  capabilitySchemaVersion: number;
  navigationSchemaVersion: number;
  generatedAt: string;

  user: PlatformContextUser;
  platform: PlatformContextPlatform;
  /** @deprecated read `activeSpace` instead. */
  workspace: PlatformContextWorkspace;
  flags: PlatformContextFlags;
  persona: PlatformContextPersona;
  capabilities: CapabilityMap;
  navigation: PlatformContextNavigation;
  /** @deprecated read `personalSpace` + `organizations` instead. */
  availableWorkspaces: ReadonlyArray<PlatformContextAvailableWorkspace>;
  // ENTERPRISE TENANT MODEL — canonical product model.
  account?: PlatformContextAccount;
  personalSpace?: PlatformContextPersonalSpace;
  organizations?: ReadonlyArray<PlatformContextOrganization>;
  activeSpace?: PlatformContextActiveSpace;
  personaProfile?: PlatformContextPersonaProfile;
  duplicatePersonalCandidates?: ReadonlyArray<PlatformContextDuplicatePersonalCandidate>;
  diagnostics: PlatformContextDiagnostics;
  /**
   * Phase EMERGENCY-RECOVERY — recovery action descriptors. Empty
   * array for healthy envelopes.
   */
  recoveryActions?: ReadonlyArray<PlatformContextRecoveryAction>;
};

// =============================================================================
// Workspace switching state machine
// =============================================================================

/**
 * Phase 32.8 Foundation — Workspace switching state machine.
 *
 * The provider transitions through these states atomically. Header,
 * sidebar, and pages MUST gate their renders on
 * `state === "READY"` — never read stale envelope fields during
 * SWITCHING or LOADING_CONTEXT, otherwise the cross-page authority
 * inconsistency (header MEMBER while page OWNER) reappears.
 */
export type PlatformContextStateName =
  | "IDLE"
  | "LOADING_CONTEXT"
  | "READY"
  | "SWITCHING"
  | "FAILED";

export type PlatformContextErrorCode =
  | "AUTH_REQUIRED"
  | "PERMISSION_DENIED"
  | "USER_NOT_FOUND"
  | "WORKSPACE_MEMBERSHIP_REQUIRED"
  | "NETWORK_ERROR"
  | "STALE_ENVELOPE"
  // STAGE 1 SCHEMA ALIGNMENT — distinct error code used by the provider
  // when a freshly-fetched envelope declares schema versions outside the
  // accepted whitelists in `ACCEPTED_*_SCHEMA_VERSIONS`. Shell components
  // can branch on this code to render an explicit "Refresh required"
  // surface rather than the generic operational error.
  | "SCHEMA_VERSION_MISMATCH"
  | "OPERATIONAL";

export type PlatformContextState =
  | { name: "IDLE" }
  | { name: "LOADING_CONTEXT" }
  | { name: "READY"; envelope: PlatformContextEnvelope }
  | {
      name: "SWITCHING";
      previous: PlatformContextEnvelope;
      targetWorkspaceId: string | null;
    }
  | {
      name: "FAILED";
      errorCode: PlatformContextErrorCode;
      message: string;
      requestId: string | null;
      previous: PlatformContextEnvelope | null;
    };

// Convenience predicate used by the workspace switcher + tests.
export function isReady(
  s: PlatformContextState,
): s is Extract<PlatformContextState, { name: "READY" }> {
  return s.name === "READY";
}
