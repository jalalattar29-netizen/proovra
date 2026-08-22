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
export type PlatformContextPlanFeatures = {
  reportsIncluded: boolean;
  verificationPackageIncluded: boolean;
  intakeIncluded: boolean;
  casesIncluded: boolean;
  reviewerOperationsIncluded: boolean;
  /** PHASE 12B Track 1A — PROFESSIONAL surface tier included (catalog-derived). */
  professionalSurfacesIncluded: boolean;
  reviewQueuesIncluded: boolean;
  /** Team ownership included (maxOwnedTeams > 0). */
  teamCollaborationIncluded: boolean;
  /**
   * Monthly AI-assistance operation allowance for the active plan
   * (2026-07-17 Settings remediation): 0 = AI not included (FREE),
   * n>0 = monthly cap, null = custom/contract (ENTERPRISE). UI-relevance
   * only — the AI cost guard enforces the cap server-side on every call.
   */
  aiAssistanceMonthlyOperations: number | null;
  /**
   * PHASE 12 — POINT 7 (2026-08-05) — the NUMERIC commercial limits for the
   * ACTIVE workspace, projected from the one catalog.
   *
   * The frontend renders capacity from these. It does not compute them, and it
   * does not key them on a plan NAME: the three collaboration surfaces that
   * used to call `getCollaborationTeamPlanLimits(accountPlan)` were both a
   * duplicate authority and wrong about the subject — a collaboration team's
   * capacity belongs to its WORKSPACE, not to the account that owns it.
   */
  limits: {
    /** `maxOwnedTeams` — Owned Workspaces this ACCOUNT may create. */
    maxOwnedWorkspaces: number;
    maxMembersPerTeam: number;
    maxPendingInvitesPerTeam: number;
    maxInvitesPer24h: number;
  };
};

/**
 * Operational eligibility (2026-07-15) — the canonical, backend-derived,
 * tenant-scoped answer to "which operational surfaces are RELEVANT to this
 * user right now", combining plan + workspace type + real role/capability +
 * real participation. It is the single projection consumed by the Operations
 * Center filters, Notification Preferences groups, and adaptive copy.
 *
 * It is NOT authorization — every data decision stays enforced by the
 * aggregation's per-source membership/role scoping. This block only controls
 * UI RELEVANCE. Static eligibility is combined on the client with the
 * aggregation's filter-independent `scopeSummary.byCategory` actual-item
 * signal, so a real authorized item can always REVEAL its category even when
 * static eligibility would hide it (an incoming Team invitee, a downgraded
 * user's historical assignment).
 */
export type PlatformContextOperationalEligibility = {
  collaboration: {
    /** Active member of ≥1 shared space (organization OR collaboration team) —
     *  the precondition for receiving mentions / assigned threads /
     *  collaboration notifications. */
    hasActiveMembership: boolean;
    /** A still-actionable incoming invitation exists (organization OR
     *  collaboration team). Lets Free/PAYG see Invitations legitimately. */
    hasPendingInvitation: boolean;
    /** Plan permits OWNING collaboration teams (maxOwnedTeams > 0). Distinct
     *  from incoming participation. */
    canOwnTeams: boolean;
  };
  reviews: {
    /** Writer-level reviewer participation in the active review-capable
     *  workspace (capability REVIEWER_OPS_ACT). Excludes VIEWER and
     *  non-review-capable scopes — NOT every Team/Enterprise member. */
    canParticipate: boolean;
    /** Review oversight / adjudication authority (active-workspace OWNER/ADMIN
     *  of a review-capable workspace). */
    canManage: boolean;
  };
  assignments: {
    /** Personal cases can assign work to the user (plan casesIncluded). */
    hasCaseAssignmentCapability: boolean;
    /** Reviewer workflows can assign work (reviews.canParticipate). */
    hasReviewAssignmentCapability: boolean;
    /** Shared-space participation can assign discussion threads. */
    hasCollaborationAssignmentCapability: boolean;
  };
  deadlines: {
    /** ≥1 deadline-producing workflow is reachable (intake, personal cases,
     *  reviews, or shared-space participation). Only 4 categories carry a real
     *  dueAt, so a scope with no eligible source must not show permanent empty
     *  Due-soon / Overdue filters. */
    hasEligibleSource: boolean;
  };
  security: {
    /** Personal/account security — universal; always relevant when real. */
    hasPersonalSurface: boolean;
    /** Organization/admin security surface — adjudicator (OWNER/ADMIN) of an
     *  organization. Ordinary members never receive admin-security items
     *  (the aggregation scopes them to adjudicator teams). */
    hasAdminSurface: boolean;
  };
  governance: {
    /** Operational governance queue access (capability GOVERNANCE_VIEW).
     *  DECISION — Pro Personal = FALSE (Outcome B): Pro "personal-workspace
     *  governance controls" are Settings/retention configuration, NOT an
     *  Operations Center governance queue. A real personal-team governance
     *  item can still reveal the category via the actual-item override. */
    canViewOperational: boolean;
  };
};

export const AUTHORITY_SCHEMA_VERSION: number = 3;
/** Bumped when CAPABILITY_KEYS is extended or semantics change. */
export const CAPABILITY_SCHEMA_VERSION = 2 as const;
/** Bumped when NAVIGATION groups/items/ids shift. */
export const NAVIGATION_SCHEMA_VERSION = 2 as const;

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
] as const;
export type ProovraPillar = (typeof PROOVRA_PILLARS)[number];

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

// (2026-07-20) The USE-CASE workspace-persona profile vocabulary
// (WORKSPACE_PERSONA_PROFILES / WorkspacePersonaProfile), the
// operational-density vocabulary (OPERATIONAL_DENSITY_PREFERENCES /
// OperationalDensityPreference), and the PlatformContextPersonaProfile
// envelope shape were removed with the workspace-persona /
// workflow-personalization / operational-density feature. The
// role-derived `Persona` above (role × scope, authorization input)
// is unaffected.

// =============================================================================
// Bounded plan vocabulary (mirrors Prisma PlanType)
// =============================================================================

export const WORKSPACE_PLANS = [
  "FREE",
  "PAYG",
  "PRO",
  "TEAM",
  "ENTERPRISE",
] as const;
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
  // ===========================================================================
  // PLATFORM health — PROOVRA-INTERNAL consoles.
  //
  // PHASE 4A (2026-08-22): these gate `/platform/*`, not tenant surfaces.
  // They were previously granted to every TEAM-scope member while the
  // routes carrying them were `requiredActiveSpace: "PLATFORM_ADMIN"` —
  // a capability and a gate that contradicted each other. They are now
  // platform-admin-only, which is what the routes always enforced.
  // ===========================================================================
  "OPS_CENTER_VIEW",
  "OBSERVABILITY_VIEW",
  "RUNBOOKS_VIEW",
  "SECURITY_CENTER_VIEW",
  // ===========================================================================
  // TENANT OPERATIONS — the workspace Operations Center (`/operations`).
  //
  // Distinct from the PLATFORM keys above: these describe what an operator
  // may do with their OWN workspace's unresolved operational conditions.
  //
  // `OPERATIONS_VIEW` is deliberately NOT a plan check. It is granted when
  // the workspace can actually PRODUCE operational conditions — reports,
  // packages, intake or reviews are included, or the workspace is shared.
  // That rule yields the intended tier behaviour (Personal Free: no;
  // Personal Pro: yes; Team/Org/Enterprise: yes) without a single
  // plan-name comparison, and stays correct when packaging changes.
  //
  // RETRY is deliberately absent. Retry authority belongs to the domain
  // (`evidence.generate_report`, `notification.delivery.resend`, evidence
  // integrity). Operations INVOKES the domain action; it never overrides
  // the domain's permission model with a generic operations grant.
  // ===========================================================================
  "OPERATIONS_VIEW",
  "OPERATIONS_ACKNOWLEDGE",
  "OPERATIONS_ASSIGN",
  "OPERATIONS_RESOLVE",
  "OPERATIONS_SUPPRESS",
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
  /**
   * @deprecated ATTENTION ARCHITECTURE (2026-08-22) — LEGACY two-value classification.
   *
   * `scope` was derived as `team.isPersonal ? "PERSONAL" : "TEAM"`, which
   * collapses the canonical three-value `workspaceKind` (PERSONAL / OWNED /
   * ORGANIZATION) into two — precisely the distinction the P1 domain
   * remediation created `Team.workspaceKind` to make, and that migration
   * `20271125000000` made NOT NULL to enforce.
   *
   * It is now DERIVED from `workspaceKind` rather than from `isPersonal`,
   * so the two can no longer disagree, and is retained only while
   * first-party consumers migrate. New code MUST read `workspaceKind`.
   */
  scope: WorkspaceScope | null;
  /**
   * CANONICAL structural classification of the active workspace, read from
   * the persisted `Team.workspaceKind` via the canonical classifier
   * (`resolveWorkspaceKind`). `UNKNOWN` means the kind could not be
   * proven — consumers MUST fail closed rather than assume PERSONAL.
   */
  workspaceKind: ResolvedWorkspaceKind | null;
  /**
   * Structural classification of the workspace's parent Organization.
   *
   * `Team.organizationId` is NOT NULL, so EVERY workspace — including a
   * FREE personal space — is organization-backed at the database level.
   * `SYSTEM` is the internal 1:1 bootstrap container and must never
   * surface as an "Organization" in product UI; only `CUSTOMER` is a
   * governance / contract boundary.
   */
  organizationKind: OrganizationKindValue | null;
  organizationId: string | null;
  /**
   * LEGACY BILLING PACKAGE on the workspace. This answers "what is
   * included in this workspace's package", NOT "is this an Enterprise
   * customer" — that is `enterprise.isEnterpriseCustomer`.
   */
  plan: WorkspacePlan | null;
  membership: PlatformContextMembership;
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

/**
 * ATTENTION ARCHITECTURE (2026-08-22) — the enterprise verdict plus its provenance.
 * Mirrors `EnterpriseAuthority` in `enterprise-authority.ts`; declared here
 * so the envelope type has no import cycle back into the service layer.
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
  /** ACCOUNT-tier entitlement. Follows the USER, not the workspace. */
  isProAccount: boolean;
  /**
   * ATTENTION ARCHITECTURE (2026-08-22) — now sourced from the canonical
   * `EnterpriseContract` authority via `resolveEnterpriseAuthority()`,
   * with a bounded legacy plan-string fallback. Retained under its
   * long-standing name so existing consumers keep working; read
   * `enterprise` for the provenance.
   */
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
   * New consumers should read `sidebar.groups` and `accountMenu.items`
   * separately so account/billing/pricing surfaces are not hidden by
   * workspace-scoped gating.
   */
  groups: ReadonlyArray<PlatformContextNavGroup>;
  /**
   * Sidebar projection (operator surfaces). Same shape as the legacy
   * `groups` field — included here so callers can move to the
   * surface-aware envelope.
   *
   * Phase 1A — `pillars` is the canonical 8-pillar grouped projection.
   * Each pillar groups the sidebar items that belong to it. Consumers
   * that support pillar-aware rendering should read `pillars`; legacy
   * consumers that read `groups` directly continue to work unchanged.
   */
  sidebar: {
    groups: ReadonlyArray<PlatformContextNavGroup>;
    pillars: ReadonlyArray<{
      pillar: ProovraPillar;
      items: ReadonlyArray<PlatformContextNavItem>;
    }>;
  };
  /**
   * Account-menu projection (always-available account / billing /
   * pricing / teams-entry / help items). NEVER hidden by workspace
   * scope — every authenticated user gets a usable account menu.
   */
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
// These types are the canonical product model that consumers should read.
// The legacy `workspace` + `availableWorkspaces` fields above remain on the
// envelope for backward compatibility for one phase. New code paths must
// consume `account`, `personalSpace`, `organizations`, and `activeSpace`.
// =============================================================================

/**
 * Account identity — independent of any space.
 *
 * Account-tier capabilities (settings, billing, upgrade, organization
 * create/join) live here, not on a workspace. Every authenticated user
 * has exactly one Account.
 */
export type PlatformContextAccount = {
  userId: string;
  email: string | null;
  displayName: string | null;
  /**
   * The account-tier plan that follows the *user*, not any one workspace.
   * Drives upgrade CTAs and personal-space PRO entitlements.
   */
  accountPlan: WorkspacePlan | null;
  /** Lifecycle status of the account itself. */
  accountStatus: "active" | "suspended" | "pending";
};

/**
 * Personal Space — the user's private default work area.
 *
 * Every authenticated user has exactly one Personal Space. It is NOT an
 * organization; it does NOT appear in the organizations list; the user is
 * always its OWNER. Internally it may be stored as a `Team` row with
 * `isPersonal=true`, but the public contract treats it as PERSONAL.
 */
export type PlatformContextPersonalSpace = {
  /**
   * Status of the personal space:
   *   - `active`    — bootstrap succeeded; product surfaces are usable
   *   - `degraded`  — bootstrap could not complete; consumer should render
   *                   the recovery panel rather than personal product UI
   */
  status: "active" | "degraded";
  /** Stable identifier for the personal space (internal Team id). */
  id: string | null;
  /** Bounded display label. Always "Personal Space" for the switcher. */
  label: "Personal Space";
  ownerUserId: string;
  /**
   * Plan applied to the personal space (mirrors `account.accountPlan` for
   * personal entitlement overlays). Never affects organization plans.
   */
  plan: WorkspacePlan | null;
};

/**
 * Organization workspace — collaborative enterprise tenant.
 *
 * Excludes `isPersonal=true` rows. Membership role is bounded to the canonical
 * `WorkspaceRole` enum and is always sourced from the canonical envelope.
 */
export type PlatformContextOrganization = {
  id: string;
  name: string | null;
  /** Display-safe slug (currently mirrors `name`; reserved for future use). */
  displayName: string | null;
  role: WorkspaceRole | null;
  membershipStatus: "ACTIVE" | "PENDING" | "INACTIVE";
  plan: WorkspacePlan | null;
  memberCount: number;
  /**
   * ATTENTION ARCHITECTURE (2026-08-22) — this array is named `organizations` but is
   * populated with EVERY non-personal workspace the caller belongs to,
   * which is both self-service OWNED workspaces and real CUSTOMER-backed
   * ORGANIZATION workspaces. Consumers that mean "organizations" in the
   * product sense (org navigation, org counters, enterprise context,
   * governance) must filter on these two fields rather than on the array's
   * name.
   *
   * Entries are NOT removed here: the switcher and several first-party
   * consumers legitimately want every non-personal workspace, and dropping
   * rows would silently break them. The distinction is exposed instead.
   */
  workspaceKind?: ResolvedWorkspaceKind;
  /** SYSTEM = internal bootstrap container; CUSTOMER = real organization. */
  organizationKind?: OrganizationKindValue | null;
};

/**
 * The currently-active space — either the user's Personal Space or one of
 * their Organizations. Never null for an authenticated user with a healthy
 * envelope; the recovery panel handles the unhealthy case.
 */
export type PlatformContextActiveSpace =
  | {
      type: "PERSONAL";
      id: string | null;
      displayName: "Personal Space";
      /** Role label rendered in chips. Always "Owner" for personal mode. */
      roleLabel: "Owner";
      /**
       * PHASE 12 POINT 4 STEP 1 — SERVER-resolved plan of the ACTIVE space.
       * The canonical place to read the active plan; consumers must not
       * re-derive it from `account` / `personalSpace` / `organizations`, and
       * must not fall back to the owner's Account plan.
       */
      plan: WorkspacePlan | null;
    }
  | {
      type: "ORGANIZATION";
      id: string;
      displayName: string | null;
      /** Role label sourced verbatim from `WorkspaceRole`. */
      roleLabel: WorkspaceRole | null;
      /** SERVER-resolved plan of the ACTIVE organization space. */
      plan: WorkspacePlan | null;
    };

/**
 * Heuristic match for legacy duplicate personal-like Team rows. Surfaced in
 * diagnostics so the /teams page can show an admin remediation card. NEVER
 * auto-deleted.
 */
export type PlatformContextDuplicatePersonalCandidate = {
  teamId: string;
  name: string | null;
  ownerUserId: string;
  memberCount: number;
  /** Reasons the heuristic flagged this row. */
  reasons: ReadonlyArray<
    | "name_matches_email_personal"
    | "single_owner_member"
    | "no_invites"
    | "free_plan"
  >;
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
   * Phase EMERGENCY-RECOVERY — bounded diagnostic surface for the
   * personal-workspace bootstrap. Lets the frontend (and humans
   * reading logs) know exactly how the active workspace was chosen.
   *
   * `workspaceSource`:
   *   - `current_workspace_id`  — used `User.currentWorkspaceId`
   *   - `personal_bootstrap`    — fell back to the user's personal Team
   *   - `personal_bootstrap_after_stale` — `currentWorkspaceId` pointed
   *     to a deleted/non-member team; cleared and used the personal Team.
   *
   * `bootstrap`:
   *   - `attempted` — true iff the bootstrap helper ran
   *   - `reused`    — true iff the bootstrap found an existing personal team
   *   - `created`   — true iff the bootstrap created a new personal team
   *   - `activeWorkspaceUpdated` — true iff `User.currentWorkspaceId`
   *     was updated to point at the personal team during this request
   */
  workspaceSource:
    | "current_workspace_id"
    | "personal_bootstrap"
    | "personal_bootstrap_after_stale";
  bootstrap: {
    attempted: boolean;
    reused: boolean;
    created: boolean;
    activeWorkspaceUpdated: boolean;
  };
  /**
   * ENTERPRISE TENANT MODEL — diagnostics for the active-space resolver.
   *
   *   `personal_space_bootstrap` — ensurePersonalWorkspace ran this request
   *   `personal_space_existing`  — found an existing personal Team row
   *   `organization`             — active space resolved to an organization
   *   `unavailable`              — bootstrap failed; recovery panel shows
   */
  activeSpaceSource:
    | "personal_space_bootstrap"
    | "personal_space_existing"
    | "organization"
    | "unavailable";
  /**
   * ENTERPRISE TENANT MODEL — was a stale `User.currentWorkspaceId` healed?
   */
  staleWorkspaceHealed: boolean;
  /**
   * ENTERPRISE TENANT MODEL — count of legacy duplicate personal-like rows
   * detected for this user. Zero on healthy envelopes.
   */
  duplicatePersonalRowsDetected: number;
};

/**
 * Phase EMERGENCY-RECOVERY — recovery action descriptors.
 *
 * When the envelope cannot be assembled into a usable shape, the
 * frontend renders a structured recovery panel instead of a blank
 * shell. Each action is a bounded link/CTA. The list is empty when
 * the envelope is healthy.
 */
export type PlatformContextRecoveryAction = {
  id: "create_personal_workspace" | "create_team" | "open_settings" | "retry";
  label: string;
  href: string | null;
};

// P3 DOMAIN REMEDIATION (2026-07-21) — canonical grouped context options.
export type PlatformContextWorkspaceOption = {
  workspaceId: string;
  name: string | null;
  kind: "PERSONAL" | "OWNED";
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
  personalSpace:
    | (Omit<PlatformContextWorkspaceOption, "kind" | "role"> & {
        kind: "PERSONAL";
        role: "OWNER";
      })
    | null;
  ownedWorkspaces: ReadonlyArray<
    Omit<PlatformContextWorkspaceOption, "kind"> & { kind: "OWNED" }
  >;
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

/**
 * PHASE 10 STEP 5 (2026-07-23) — active SUPPORT ACCESS projection.
 *
 * Present ONLY when the authenticated actor is a support user with an
 * ACTIVE, unexpired, unrevoked SupportAccessGrant. Carries BOTH identities
 * (the support actor + the customer org) so the web shell can render a
 * persistent, visible support banner. Absent / null means no active support
 * access — the default for every ordinary user.
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
  /** ISO-8601 expiry — the banner reports the remaining window. */
  expiresAtUtc: string;
};

// =============================================================================
// PHASE 12 CORRECTIVE PASS §1 (ARCH-003, 2026-08-07) — THE CANONICAL,
// VERSIONED PLATFORM CONTEXT.
//
// THE FINDING
// -----------------------------------------------------------------------------
// The envelope carried a field called `organizations` whose entries were built
// with `id: m.team.id` — WORKSPACE ids, in a field named after Organizations,
// alongside a `memberCount` that counted WORKSPACE members. A consumer reading
// `organizations[i].id` and handing it to an Organization endpoint was handing
// it a Workspace id, and nothing in the type said so. `membershipStatus` on the
// same row described the WORKSPACE membership, not the governance one.
//
// Two identifier spaces sharing one field name is the defect. This block is the
// separation: Organization fields carry Organization ids, Workspace fields
// carry Workspace ids, and the two membership id spaces are named apart.
//
// VERSIONED, because the legacy shape stays populated for one phase and a
// client has to be able to tell which contract it was answered in.
// =============================================================================

/** The canonical context contract version. Bumped when a field changes meaning. */
export const PLATFORM_CONTEXT_VERSION = 2 as const;

/** Identity of the ACCOUNT — one per authenticated human, never per tenant. */
export type CanonicalContextAccount = {
  accountId: string;
  email: string | null;
  displayName: string | null;
  /** The ACCOUNT-tier plan. Never the active workspace's effective plan. */
  accountPlan: WorkspacePlan | null;
};

/** A Workspace the caller may enter. `workspaceId` is always a Workspace id. */
export type CanonicalContextWorkspace = {
  workspaceId: string;
  name: string | null;
  kind: "PERSONAL" | "OWNED" | "ORGANIZATION";
  /** The caller's WORKSPACE role. Never an Organization role. */
  workspaceRole: WorkspaceRole | null;
  /** The caller's WORKSPACE membership id — a different id space from governance. */
  workspaceMembershipId: string | null;
  /**
   * Present only for ORGANIZATION workspaces, and it is an ORGANIZATION id.
   * `null` for PERSONAL and OWNED, which are backed by internal SYSTEM
   * containers that are not customer Organizations.
   */
  organizationId: string | null;
};

/**
 * An ORGANIZATION the caller governs or belongs to.
 *
 * `organizationId` is an Organization id. This type deliberately carries NO
 * workspace id and NO workspace member count — the workspaces are in
 * `organizationWorkspaces`, keyed by this id.
 */
export type CanonicalContextOrganization = {
  organizationId: string;
  name: string | null;
  /** CUSTOMER organizations only; SYSTEM containers never appear here. */
  status: "ACTIVE";
};

/**
 * The caller's GOVERNANCE membership of an Organization.
 *
 * `organizationMembershipId` is deliberately a different field from
 * `workspaceMembershipId`: they are different rows in different tables, and
 * one being mistaken for the other is how a governance action gets applied to
 * a workspace membership.
 */
export type CanonicalContextOrganizationMembership = {
  organizationMembershipId: string;
  organizationId: string;
  organizationRole: string;
  /** ACTIVE only — a suspended or revoked membership does not appear at all. */
  status: "ACTIVE";
};

export type CanonicalPlatformContext = {
  contextVersion: typeof PLATFORM_CONTEXT_VERSION;
  account: CanonicalContextAccount;
  /**
   * `null` when the caller has none — an ENTERPRISE identity under an
   * Organization policy of `noPersonalSpace`, for example. Never substituted.
   */
  personalSpace: CanonicalContextWorkspace | null;
  ownedWorkspaces: ReadonlyArray<CanonicalContextWorkspace>;
  /** ORGANIZATION IDS ONLY. */
  organizations: ReadonlyArray<CanonicalContextOrganization>;
  organizationMemberships: ReadonlyArray<CanonicalContextOrganizationMembership>;
  /** WORKSPACE IDS ONLY, each carrying the Organization id it belongs to. */
  organizationWorkspaces: ReadonlyArray<CanonicalContextWorkspace>;
  /**
   * Where the caller currently IS. A NAVIGATION PREFERENCE, resolved and
   * re-authorized server-side on every request — never an authorization input.
   *
   * A stale pointer HEALS to the caller's own Personal Space rather than
   * producing a broken shell, and `currentWorkspaceSource` says so. That is the
   * difference between healing and a SILENT fallback: the client can tell
   * "you are where you asked to be" from "your pointer was stale and we put you
   * home", and it can never be healed onto somebody else's workspace.
   */
  currentWorkspace: CanonicalContextWorkspace | null;
  /**
   * How `currentWorkspace` was arrived at.
   *
   *   POINTER                 the caller's pointer named it and they may enter it
   *   REPAIRED_TO_PERSONAL    the pointer named something they may not enter (or
   *                           nothing), so it healed to their OWN Personal Space
   *   NONE                    nothing could be resolved — no substitute was made
   */
  currentWorkspaceSource: "POINTER" | "REPAIRED_TO_PERSONAL" | "NONE";
  /** The Organization of `currentWorkspace`, when it has one. Navigation only. */
  currentOrganization: CanonicalContextOrganization | null;
  /** Effective capabilities in the CURRENT workspace. */
  capabilities: ReadonlyArray<string>;
  commercialContext: {
    /** The effective plan of the CURRENT workspace, server-resolved. */
    effectivePlan: WorkspacePlan | null;
    /** The commercial SHAPE of the current workspace. Never a tenancy kind. */
    billingShape: "SINGLE_OCCUPANT" | "SHARED" | null;
  };
};

export type PlatformContextEnvelope = {
  authoritySchemaVersion: typeof AUTHORITY_SCHEMA_VERSION;
  capabilitySchemaVersion: typeof CAPABILITY_SCHEMA_VERSION;
  navigationSchemaVersion: typeof NAVIGATION_SCHEMA_VERSION;
  generatedAt: string;

  user: PlatformContextUser;
  platform: PlatformContextPlatform;
  /**
   * @deprecated ENTERPRISE TENANT MODEL — kept for backward compatibility for
   * one phase. New consumers should read `activeSpace` (typed PERSONAL or
   * ORGANIZATION) and `personalSpace` / `organizations`.
   */
  workspace: PlatformContextWorkspace;
  flags: PlatformContextFlags;
  persona: PlatformContextPersona;
  capabilities: CapabilityMap;
  /**
   * Canonical commercial plan feature flags for the active workspace
   * (projected from PLAN_CAPABILITIES). Entitlement-aware surfaces
   * (Operations Center, Notification Preferences) read these instead of
   * importing the billing package.
   */
  planFeatures: PlatformContextPlanFeatures;
  /**
   * ATTENTION ARCHITECTURE (2026-08-22) — CANONICAL enterprise commercial authority.
   *
   * The five concepts this envelope keeps deliberately apart:
   *   `workspace.workspaceKind`     structural  (PERSONAL/OWNED/ORGANIZATION)
   *   `workspace.organizationKind`  structural  (SYSTEM/CUSTOMER)
   *   `account.accountPlan`         commercial  (follows the USER)
   *   `workspace.plan`              commercial  (billing package, workspace)
   *   `enterprise`                  commercial  (contract, CUSTOMER org)
   *
   * Capabilities are derived FROM these. They are not one of them, and no
   * page may reconstruct any of them from a plan-name comparison.
   */
  enterprise: PlatformContextEnterprise;
  /** Operational eligibility projection (see type doc). */
  operationalEligibility: PlatformContextOperationalEligibility;
  navigation: PlatformContextNavigation;
  /**
   * @deprecated ENTERPRISE TENANT MODEL — kept for backward compatibility for
   * one phase. New consumers should read `personalSpace` and `organizations`.
   */
  availableWorkspaces: ReadonlyArray<PlatformContextAvailableWorkspace>;
  // ===========================================================================
  // ENTERPRISE TENANT MODEL — canonical product model.
  //
  // Consumers should prefer these fields. The legacy `workspace` and
  // `availableWorkspaces` fields above remain populated for backward
  // compatibility for one phase.
  // ===========================================================================
  /** Account identity + account-tier plan. */
  account: PlatformContextAccount;
  /** Always exactly one Personal Space (private default work area). */
  personalSpace: PlatformContextPersonalSpace;
  /**
   * PHASE 12 CORRECTIVE PASS §1 (ARCH-003, 2026-08-07) — DEPRECATED, AND THE
   * ENTRIES ARE WORKSPACES.
   *
   * @deprecated Read `canonical.organizations` (Organization ids) and
   * `canonical.organizationWorkspaces` (Workspace ids) instead. Every entry
   * here has `id = <workspace id>` and `memberCount = <workspace members>`,
   * despite the field name — which is the ARCH-003 finding itself. It stays
   * populated for one phase so an installed client does not break, and it is
   * built by projecting the canonical model rather than by a second query, so
   * the two cannot disagree.
   *
   * REMOVAL CONDITION: delete when no client below the minimum supported build
   * reads it — measured by `legacy_platform_context_organizations_reads_total`.
   */
  organizations: ReadonlyArray<PlatformContextOrganization>;
  /**
   * ARCH-003 — the CANONICAL, versioned context. Organization fields carry
   * Organization ids; Workspace fields carry Workspace ids; the two membership
   * id spaces are named apart. New consumers read this and nothing else.
   */
  canonical: CanonicalPlatformContext;
  /** Resolved active space (PERSONAL or ORGANIZATION). */
  activeSpace: PlatformContextActiveSpace;
  /**
   * P3 DOMAIN REMEDIATION (2026-07-21) — canonical, SERVER-AUTHORIZED
   * context options grouped by explicit workspaceKind:
   * Personal / Your workspaces (OWNED) / Organizations (grouped by parent
   * org). Only ACTIVE memberships in active/open contexts appear. The
   * client may group and render but must never create additional choices.
   */
  contextOptions: PlatformContextContextOptions;
  // (2026-07-20) `personaProfile` (use-case workspace-persona profile)
  // was removed with the workspace-persona / workflow-personalization
  // feature. Authorization `persona` (role × scope) is unaffected.
  /**
   * Legacy duplicate-personal-like Team rows discovered during this request.
   * The frontend renders them in /teams as an admin diagnostic with safe
   * remediation guidance. Never auto-deleted.
   */
  duplicatePersonalCandidates: ReadonlyArray<PlatformContextDuplicatePersonalCandidate>;
  diagnostics: PlatformContextDiagnostics;
  /**
   * Phase EMERGENCY-RECOVERY — bounded list of structured recovery
   * actions the frontend can surface when the envelope is unhealthy.
   * Empty array when the platform context resolved normally.
   */
  recoveryActions: ReadonlyArray<PlatformContextRecoveryAction>;
  /**
   * PHASE 10 STEP 5 (2026-07-23) — active support access, when the actor is
   * a support user operating within a customer org under an ACTIVE grant.
   * `null` for every ordinary request. Additive — pre-Step-5 consumers
   * ignore it.
   */
  supportAccess: PlatformContextSupportAccess | null;
  /**
   * PHASE 10 §13.2 STEP 6 (2026-07-23) — `false` when the authenticated
   * identity is a MANAGED_ENTERPRISE identity (or MANAGED_UNRESOLVED, which
   * fails closed) with no personal space. CLIENT-HIDING SIGNAL ONLY — the
   * authoritative deny is server-side (workspace-bootstrap.service.ts,
   * the `/v1/platform/context/switch-workspace` guard, and the personal
   * capture/evidence/upload/checkout/export guards). `true` for every
   * STANDARD identity (the default, unchanged behavior).
   */
  personalSpaceAllowed: boolean;
};
