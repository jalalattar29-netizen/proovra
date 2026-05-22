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

/** Bumped when the envelope outer shape changes. */
export const AUTHORITY_SCHEMA_VERSION = 1 as const;
/** Bumped when CAPABILITY_KEYS is extended or semantics change. */
export const CAPABILITY_SCHEMA_VERSION = 1 as const;
/** Bumped when NAVIGATION groups/items/ids shift. */
export const NAVIGATION_SCHEMA_VERSION = 1 as const;

// =============================================================================
// Bounded role vocabulary (mirrors Prisma TeamRole exactly)
// =============================================================================

export const WORKSPACE_ROLES = [
  "OWNER",
  "ADMIN",
  "MEMBER",
  "VIEWER",
] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function isWorkspaceRole(value: string | null | undefined): value is WorkspaceRole {
  return (
    typeof value === "string" &&
    (WORKSPACE_ROLES as ReadonlyArray<string>).includes(value)
  );
}

// =============================================================================
// Bounded scope vocabulary
// =============================================================================

export const WORKSPACE_SCOPES = ["PERSONAL", "TEAM"] as const;
export type WorkspaceScope = (typeof WORKSPACE_SCOPES)[number];

// =============================================================================
// Bounded persona vocabulary (resolved from role + scope, deterministic)
// =============================================================================

export const PERSONAS = [
  "INDIVIDUAL",
  "WORKSPACE_OWNER",
  "TEAM_ADMIN",
  "TEAM_MEMBER",
  "TEAM_VIEWER",
] as const;
export type Persona = (typeof PERSONAS)[number];

// =============================================================================
// Bounded plan vocabulary (mirrors Prisma PlanType)
// =============================================================================

export const WORKSPACE_PLANS = ["FREE", "PAYG", "PRO", "TEAM"] as const;
export type WorkspacePlan = (typeof WORKSPACE_PLANS)[number];

// =============================================================================
// Bounded section status vocabulary
// =============================================================================

export type SectionStatus = "ok" | "degraded" | "unavailable" | "not_applicable";

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
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export type CapabilityMap = Record<CapabilityKey, boolean>;

// =============================================================================
// Envelope shape
// =============================================================================

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
  groups: ReadonlyArray<PlatformContextNavGroup>;
};

export type PlatformContextAvailableWorkspace = {
  id: string;
  name: string | null;
  scope: WorkspaceScope;
  role: WorkspaceRole | null;
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
};

export type PlatformContextEnvelope = {
  authoritySchemaVersion: typeof AUTHORITY_SCHEMA_VERSION;
  capabilitySchemaVersion: typeof CAPABILITY_SCHEMA_VERSION;
  navigationSchemaVersion: typeof NAVIGATION_SCHEMA_VERSION;
  generatedAt: string;

  user: PlatformContextUser;
  platform: PlatformContextPlatform;
  workspace: PlatformContextWorkspace;
  flags: PlatformContextFlags;
  persona: PlatformContextPersona;
  capabilities: CapabilityMap;
  navigation: PlatformContextNavigation;
  availableWorkspaces: ReadonlyArray<PlatformContextAvailableWorkspace>;
  diagnostics: PlatformContextDiagnostics;
};
