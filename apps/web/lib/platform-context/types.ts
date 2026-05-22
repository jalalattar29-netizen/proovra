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

export const AUTHORITY_SCHEMA_VERSION = 1 as const;
export const CAPABILITY_SCHEMA_VERSION = 1 as const;
export const NAVIGATION_SCHEMA_VERSION = 1 as const;

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
  authoritySchemaVersion: number;
  capabilitySchemaVersion: number;
  navigationSchemaVersion: number;
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
