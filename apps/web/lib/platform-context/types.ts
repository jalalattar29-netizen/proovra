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

export type PlatformContextPlanFeatures = {
  reportsIncluded: boolean;
  verificationPackageIncluded: boolean;
  intakeIncluded: boolean;
  /** PHASE 12B Track 1A — PROFESSIONAL surface tier included (catalog-derived, server-projected). */
  professionalSurfacesIncluded?: boolean;
  casesIncluded: boolean;
  reviewerOperationsIncluded: boolean;
  reviewQueuesIncluded: boolean;
  /** Collaboration Teams included (maxCollaborationTeamsPerWorkspace > 0). */
  teamCollaborationIncluded: boolean;
  /**
   * PHASE 12 POINT 4 — guest-invitation eligibility, server-projected from the
   * SAME catalog value the API enforces (canPlanOperateSharedWorkspace).
   *
   * Declared REQUIRED, like its sibling booleans, so it is reachable through
   * `usePlanFeature` — that hook's key union is built with a `-?` mapped type
   * whose lookup still yields `boolean | undefined` for an optional property,
   * which excludes optional keys from the union. The hook already fails closed
   * at runtime (`typeof value === "boolean" ? value : null`), so an older
   * envelope that predates the field yields `null` and the caller shows the
   * locked state rather than an optimistic affordance.
   */
  canInviteGuests: boolean;
  /**
   * Monthly AI-assistance operation allowance (2026-07-17): 0 = AI not
   * included (FREE), n>0 = monthly cap, null = custom (Enterprise).
   * Optional so envelopes emitted before the field existed still parse.
   */
  aiAssistanceMonthlyOperations?: number | null;
  /**
   * PHASE 12 — POINT 7 (2026-08-05): the NUMERIC commercial limits for the
   * ACTIVE workspace, resolved by the server from the one catalog.
   *
   * Render these; never recompute them. The collaboration surfaces used to
   * call `getCollaborationTeamPlanLimits(accountPlan)` in the browser, which
   * made the client a limit authority AND asked the wrong subject — a
   * collaboration team's capacity belongs to its workspace, not to the account
   * that happens to own it.
   *
   * OPTIONAL, because an envelope emitted before this field existed must not
   * be read as "the limits are zero". Call sites treat an absent block as
   * UNKNOWN and render the honest unknown state rather than a fabricated cap.
   */
  limits?: {
    // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the server stopped
    // projecting `maxOwnedWorkspaces`, because no plan grants additional
    // workspaces. Removed here in lockstep: a client type that still declared
    // it would be describing a field that never arrives.
    /** ACTIVE Collaboration Teams allowed inside ONE workspace. */
    maxCollaborationTeamsPerWorkspace: number;
    /** ACCEPTED members allowed in ONE Collaboration Team. */
    maxAcceptedMembersPerCollaborationTeam: number;
    /** ACCEPTED TeamMember seats allowed in ONE shared workspace. */
    maxWorkspaceSeats: number;
    maxPendingInvitesPerTeam: number;
    maxInvitesPer24h: number;
  };
};

/**
 * Operational eligibility — canonical, backend-derived relevance projection
 * for the Operations Center + Notification Preferences surfaces. Plan +
 * workspace type + real role/capability + real participation. Combined on the
 * client with the aggregation's `scopeSummary.byCategory` actual-item signal
 * (an authorized item can always reveal its category). See the API-side type
 * doc for the authoritative contract. UI relevance only — never authorization.
 */
export type PlatformContextOperationalEligibility = {
  collaboration: {
    hasActiveMembership: boolean;
    hasPendingInvitation: boolean;
    canOwnTeams: boolean;
  };
  reviews: {
    canParticipate: boolean;
    canManage: boolean;
  };
  assignments: {
    hasCaseAssignmentCapability: boolean;
    hasReviewAssignmentCapability: boolean;
    hasCollaborationAssignmentCapability: boolean;
  };
  deadlines: {
    hasEligibleSource: boolean;
  };
  security: {
    hasPersonalSurface: boolean;
    hasAdminSurface: boolean;
  };
  governance: {
    canViewOperational: boolean;
  };
};

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

export const WORKSPACE_PLANS = [
  "FREE",
  "PAYG",
  "PRO",
  "TEAM",
  "ENTERPRISE",
] as const;
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
  // ==========================================================================
  // ATTENTION ARCHITECTURE PHASE 4B (2026-08-22) — TENANT OPERATIONS.
  //
  // Mirrors the server capability set exactly. The UI consumes these RESOLVED
  // booleans; it never re-derives them from a plan name, a role string or a
  // workspace kind. That is the whole contract: pricing and authorization are
  // decided once, on the server, and the client renders what it is told.
  //
  // There is no OPERATIONS_RETRY — retry is authorized by the domain that owns
  // the work, so a retry control is gated on that domain's capability.
  // ==========================================================================
  "OPERATIONS_VIEW",
  "OPERATIONS_ACKNOWLEDGE",
  "OPERATIONS_ASSIGN",
  "OPERATIONS_RESOLVE",
  "OPERATIONS_SUPPRESS",
  /**
   * May create and manage WORKSPACE-SHARED saved views.
   *
   * Governs shared CONFIGURATION rather than any incident: a TEAM view
   * appears in every authorized colleague's toolbar. PRIVATE views need no
   * capability — they are one person's own bookmarks.
   */
  "OPERATIONS_SAVED_VIEWS_MANAGE",
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

export const ORGANIZATION_KINDS = ["SYSTEM", "CUSTOMER"] as const;
export type OrganizationKindValue = (typeof ORGANIZATION_KINDS)[number];

export const RESOLVED_WORKSPACE_KINDS = [
  "PERSONAL",
  "OWNED",
  "ORGANIZATION",
  "UNKNOWN",
] as const;
export type ResolvedWorkspaceKind = (typeof RESOLVED_WORKSPACE_KINDS)[number];

export type PlatformContextWorkspace = {
  status: "active" | "no-workspace";
  id: string | null;
  name: string | null;
  /**
   * @deprecated ATTENTION ARCHITECTURE (2026-08-22) — LEGACY two-value classification,
   * now DERIVED server-side from `workspaceKind`. New code reads
   * `workspaceKind`, which distinguishes OWNED from ORGANIZATION.
   */
  scope: WorkspaceScope | null;
  /** CANONICAL structural kind. `UNKNOWN`/null → consumers fail closed. */
  workspaceKind?: ResolvedWorkspaceKind | null;
  /**
   * Parent organization kind. `SYSTEM` is an internal bootstrap container
   * that every workspace has and that must NEVER render as a customer
   * Organization; only `CUSTOMER` is a governance boundary.
   */
  organizationKind?: OrganizationKindValue | null;
  organizationId?: string | null;
  /** LEGACY billing package. Not the enterprise authority. */
  plan: WorkspacePlan | null;
  membership: PlatformContextMembership;
};

/**
 * ATTENTION ARCHITECTURE (2026-08-22) — canonical enterprise commercial verdict, sourced
 * from `EnterpriseContract` with a bounded legacy plan-string fallback.
 * Optional on the client type so an older cached envelope still parses.
 */
export type PlatformContextEnterprise = {
  isEnterpriseCustomer: boolean;
  source: "contract" | "legacy_plan" | "none" | "unavailable";
  contractStatus: string | null;
  contractInEffect: boolean | null;
  organizationId: string | null;
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

// P3 DOMAIN REMEDIATION (2026-07-21) — canonical, SERVER-AUTHORIZED grouped
// context options (Personal / Your workspaces / Organizations). The client
// may group and render but never creates additional choices. Optional on the
// envelope for tolerance of an older API during rollout.
export type PlatformContextOwnedWorkspaceOption = {
  workspaceId: string;
  name: string | null;
  kind: "OWNED";
  role: WorkspaceRole | null;
  lifecycleStatus: "active";
};

export type PlatformContextOrganizationWorkspaceOption = {
  workspaceId: string;
  workspaceName: string | null;
  kind: "ORGANIZATION";
  workspaceRole: WorkspaceRole | null;
  lifecycleStatus: "active";
};

export type PlatformContextContextOptions = {
  personalSpace: {
    workspaceId: string;
    name: "Personal Space";
    kind: "PERSONAL";
    role: "OWNER";
    lifecycleStatus: "active";
  } | null;
  ownedWorkspaces: ReadonlyArray<PlatformContextOwnedWorkspaceOption>;
  organizations: ReadonlyArray<{
    organizationId: string;
    organizationName: string | null;
    workspaces: ReadonlyArray<PlatformContextOrganizationWorkspaceOption>;
  }>;
  activeContext: {
    workspaceId: string | null;
    kind: "PERSONAL" | "OWNED" | "ORGANIZATION";
    organizationId: string | null;
    displayName: string | null;
  };
};

export type PlatformContextActiveSpace =
  | {
      type: "PERSONAL";
      id: string | null;
      displayName: "Personal Space";
      roleLabel: "Owner";
      /**
       * PHASE 12 POINT 4 STEP 1 — SERVER-resolved plan of the ACTIVE space.
       * The canonical place to read the active plan. Never re-derive it from
       * `account` / `personalSpace` / `organizations`, and never fall back to
       * the owner's Account plan.
       */
      plan: WorkspacePlan | null;
    }
  | {
      type: "ORGANIZATION";
      id: string;
      displayName: string | null;
      roleLabel: WorkspaceRole | null;
      /** SERVER-resolved plan of the ACTIVE organization space. */
      plan: WorkspacePlan | null;
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

// (2026-07-20) Workspace-persona / workflow-personalization / operational-
// density feature family removed. The authorization ROLE persona
// (`PERSONAS` / `Persona` / `PlatformContextPersona.resolvedPersona`) is a
// separate, retained system — navigation/labels/density are now canonical
// and no longer personalized.

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

/**
 * PHASE 10 STEP 5 (2026-07-23) — active support-access projection. Present
 * only when the authenticated actor is a support user operating within a
 * customer org under an ACTIVE grant. Drives the persistent support banner.
 */
export type PlatformContextSupportAccess = {
  active: true;
  grantId: string;
  supportActorUserId: string;
  organizationId: string;
  organizationName: string | null;
  teamId: string | null;
  mode: "READ_ONLY" | "ELEVATED";
  reason: string;
  expiresAtUtc: string;
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
  planFeatures: PlatformContextPlanFeatures;
  /**
   * ATTENTION ARCHITECTURE — canonical enterprise authority. Optional on the client so a
   * cached older envelope still parses; consumers that need it must
   * fail closed on absence rather than fall back to a plan-name check.
   */
  enterprise?: PlatformContextEnterprise;
  /** Operational eligibility projection (see type doc). REQUIRED, matching
   *  the canonical server contract — `deriveOperationalEligibility` runs on
   *  every envelope build. Phase 12 Point 4 (Pass E) removed the optional
   *  marker that described a "degraded / pre-migration envelope"; consumers
   *  still fail closed on a null projection, which is the load-bearing
   *  safety property (see `useOperationsUiContext`). */
  operationalEligibility: PlatformContextOperationalEligibility;
  navigation: PlatformContextNavigation;
  /** @deprecated read `personalSpace` + `organizations` instead. */
  availableWorkspaces: ReadonlyArray<PlatformContextAvailableWorkspace>;
  // ENTERPRISE TENANT MODEL — canonical product model.
  //
  // Phase 12 Point 4 (Pass E) — these five were declared OPTIONAL here
  // while `services/api/src/services/platform-context/types.ts` declares
  // them REQUIRED and the service returns them unconditionally. The
  // client-side optionality was the sole reason every "older deployment /
  // older envelope shape" fallback branch existed, and one of those
  // branches fabricated a synthetic `organizationId: "legacy"` group.
  // The web contract now matches the server contract; the fallbacks are
  // deleted rather than left as unreachable legacy paths.
  account: PlatformContextAccount;
  personalSpace: PlatformContextPersonalSpace;
  organizations: ReadonlyArray<PlatformContextOrganization>;
  activeSpace: PlatformContextActiveSpace;
  /** P3 (2026-07-21) — canonical grouped context options (see type doc). */
  contextOptions: PlatformContextContextOptions;
  duplicatePersonalCandidates?: ReadonlyArray<PlatformContextDuplicatePersonalCandidate>;
  diagnostics: PlatformContextDiagnostics;
  /**
   * Phase EMERGENCY-RECOVERY — recovery action descriptors. Empty
   * array for healthy envelopes.
   */
  recoveryActions?: ReadonlyArray<PlatformContextRecoveryAction>;
  /**
   * PHASE 10 STEP 5 (2026-07-23) — active support access, or null for
   * ordinary users. Optional for backward compatibility with a
   * pre-Step-5 envelope.
   */
  supportAccess?: PlatformContextSupportAccess | null;
  /**
   * PHASE 10 §13.2 STEP 6 (2026-07-23) — `false` when the authenticated
   * identity is managed (no personal space). CLIENT-HIDING SIGNAL ONLY —
   * the server independently enforces every personal-scope mutation.
   * Optional for backward compatibility with a pre-Step-6 envelope; treat
   * an absent value as `true` (legacy/STANDARD behavior).
   */
  personalSpaceAllowed?: boolean;
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
