/**
 * Phase 32.8 Foundation — Canonical navigation registry.
 *
 * This module is the ONE place where sidebar navigation is declared.
 * The frontend MUST receive a server-resolved, pre-filtered subset of
 * these groups via PlatformContextEnvelope.navigation — it MUST NOT
 * filter the registry locally.
 *
 * Visibility model:
 *
 *   - Each item declares `requiresCapability: CapabilityKey | null`.
 *   - If `null`, the item is visible to every authenticated user with
 *     an active workspace.
 *   - If set, the item is visible only when
 *     ctx.capabilities[requiresCapability] === true.
 *
 * Hard rules:
 *
 *   1. No `roles` array. Capability-keyed visibility only — role-list
 *     duplication is exactly what we're eliminating.
 *
 *   2. Adding a nav item ALWAYS requires editing this file. No inline
 *      <Link> on the sidebar. No "just one more nav" in a parent
 *      component.
 *
 *   3. The TEAMS nav item is restored as a TEAM_VIEW-gated item. Any
 *      team member (OWNER/ADMIN/MEMBER/VIEWER) sees Teams; users in
 *      personal workspaces do not.
 *
 *   4. The registry shape is frozen by the navigationSchemaVersion
 *      constant in types.ts. Bumping the registry requires bumping
 *      that version.
 *
 * T-125 / PRD-01 — WHAT THIS PAYLOAD MAY ADVERTISE (2026-11-24).
 *
 *   The web does not render this payload (its sidebar, command palette and
 *   All Tools read `apps/web/lib/navigation/routeRegistry.ts`); it is a
 *   contract for API consumers. It advertised `/redaction`, `/workflows`,
 *   `/intelligence`, `/investigation`, `/packaging` (404 for a Team context)
 *   and `/evidence-lifecycle` (a redirect), because an item here was gated on a
 *   ROLE capability only, while the web route it names is also gated on the
 *   COMMERCIAL answer (Enterprise workspace, a plan feature) and on the
 *   workspace kind.
 *
 *   Every item therefore mirrors the gate of the web registry entry it lands
 *   on: `requiresCapability` (+ `alsoRequiresCapabilities`) for the role,
 *   `requiresEnterpriseWorkspace` / `requiresPlanFeature` for the commercial
 *   answer (platform admins bypass both, as on the web), and
 *   `requiresOrganizationWorkspace` for the kind. An item may be STRICTER than
 *   its web route, never looser. The builders take a `NavigationGateContext`
 *   (server-projected booleans only, never a plan name) and fail closed
 *   without one. The projected item shape is unchanged. Proven per context by
 *   `apps/web/__tests__/navigation-contract-resolves.test.ts`: every item the
 *   payload advertises names a real page that opens through both web gates.
 */

import type { CapabilityKey } from "./types.js";

export type NavDomain =
  | "WORKSPACE"
  | "REVIEW_GOVERNANCE"
  | "PLATFORM_HEALTH"
  | "ADMINISTRATION"
  | "ACCOUNT"
  | "BILLING_PLAN"
  | "PUBLIC_MARKETING";

/**
 * Phase ROUTE-FIX — surface a nav item is allowed to appear on.
 *
 *   SIDEBAR       — sidebar groups (operator surfaces).
 *   ACCOUNT_MENU  — topbar's user-dropdown (account / billing / pricing
 *                   / help — the routes that must remain available to
 *                   every logged-in user regardless of workspace).
 *   BOTH          — visible in both surfaces (used when a route is a
 *                   genuine operator surface AND a logged-in account
 *                   route — e.g. Billing).
 */
export type NavSurface = "SIDEBAR" | "ACCOUNT_MENU" | "BOTH";

export type NavRegistryItem = {
  /** Bounded stable id (also used by tests). */
  id: string;
  /** Human label. */
  label: string;
  /** Canonical route this item navigates to. */
  href: string;
  /** Icon key (frontend maps to Lucide component). */
  iconKey: string;
  /** Top-level domain — drives which sidebar group hosts the item. */
  domain: NavDomain;
  /** Bounded badge key (frontend hydrates from runtime state). */
  badgeKey: string | null;
  /**
   * Phase ROUTE-FIX — bounded surface the item appears on. Sidebar
   * groups (operator surfaces) and the account menu (always-available
   * for logged-in users) are intentionally distinct.
   *
   * Default `SIDEBAR` preserves backward compatibility for existing
   * groups.
   */
  surface?: NavSurface;
  /**
   * Single capability gate. `null` = visible to every authenticated
   * user with an active workspace.
   */
  requiresCapability: CapabilityKey | null;
  /** T-125 — further role capabilities the web route also requires (all must hold). */
  alsoRequiresCapabilities?: ReadonlyArray<CapabilityKey>;
  /**
   * T-125 — the web route's plan-feature gate (`requiredPlanFeature` or the
   * nav-only `navPlanFeature`): the item is advertised only when
   * `planFeatures[key] === true`. Platform admins bypass.
   */
  requiresPlanFeature?: NavPlanFeatureKey;
  /**
   * T-125 — the web route is in `ENTERPRISE_ONLY_ROUTE_IDS`: advertised only
   * when `flags.isEnterpriseWorkspace` is true. Platform admins bypass.
   */
  requiresEnterpriseWorkspace?: true;
  /** T-125 — the web route is `ORGANIZATION_ONLY`: the active space must be an organization. */
  requiresOrganizationWorkspace?: true;
};

/**
 * T-125 — the `planFeatures` keys a navigation item may require. Each is a
 * boolean of the envelope's `planFeatures` projection.
 */
export type NavPlanFeatureKey =
  | "casesIncluded"
  | "intakeIncluded"
  | "teamCollaborationIncluded"
  | "reviewerOperationsIncluded"
  | "redactionIncluded";

/**
 * T-125 — what the builders need to know about the ACTIVE workspace besides
 * the role capabilities. Server-projected values only: the same
 * `flags.isEnterpriseWorkspace`, `planFeatures` and `activeSpace.type` the
 * envelope carries to the web gates.
 */
export type NavigationGateContext = {
  activeSpaceType: "PERSONAL" | "ORGANIZATION" | null;
  isEnterpriseWorkspace: boolean;
  isPlatformAdmin: boolean;
  planFeatures: Partial<Record<NavPlanFeatureKey, boolean | null>> | null;
};

export type NavRegistryGroup = {
  id: string;
  title: string;
  domain: NavDomain;
  order: number;
  items: ReadonlyArray<NavRegistryItem>;
};

// =============================================================================
// Group 1 — WORKSPACE
// =============================================================================

const WORKSPACE_GROUP: NavRegistryGroup = {
  id: "workspace",
  title: "Workspace",
  domain: "WORKSPACE",
  order: 1,
  items: [
    {
      id: "workspace.home",
      label: "Home",
      href: "/home",
      iconKey: "home",
      domain: "WORKSPACE",
      badgeKey: null,
      requiresCapability: "DASHBOARD_VIEW",
    },
    {
      id: "workspace.capture",
      label: "Capture",
      href: "/capture",
      iconKey: "capture",
      domain: "WORKSPACE",
      badgeKey: null,
      requiresCapability: "EVIDENCE_CAPTURE",
    },
    {
      id: "workspace.evidence",
      label: "Evidence",
      href: "/evidence",
      iconKey: "evidence",
      domain: "WORKSPACE",
      badgeKey: null,
      requiresCapability: "EVIDENCE_VIEW",
    },
    {
      id: "workspace.cases",
      label: "Cases",
      href: "/cases",
      iconKey: "cases",
      domain: "WORKSPACE",
      badgeKey: null,
      requiresCapability: "CASES_VIEW",
      // T-125 — web `navPlanFeature: "casesIncluded"` (FREE sells no cases).
      requiresPlanFeature: "casesIncluded",
    },
    // Phase 2.6 §10.5 — Workspace governance discoverability.
    //
    // `admin.teams` lives in the ADMINISTRATION group (order: 4) which
    // is visually buried at the bottom of the sidebar — operators who
    // work in the WORKSPACE flow (Evidence → Cases) miss it. We add a
    // workspace-context entry HERE so the team/governance surface is
    // discoverable from the daily-work mental model, without removing
    // the admin-context entry below.
    //
    // This is the same dual-surface pattern that `admin.billing` +
    // `account.billing` already use (both point to /billing under
    // different labels). It is NOT a duplicate within the same group;
    // each entry serves a different operator mental model.
    //
    // Gated by `TEAM_VIEW` — same as `admin.teams` — so capability
    // resolution is identical. The /teams page itself renders the
    // create-team flow when the active workspace has no team yet, so
    // even no-workspace users see the entry as a useful CTA.
    {
      id: "workspace.team_governance",
      label: "Workspace",
      href: "/collaboration-teams",
      iconKey: "teams",
      domain: "WORKSPACE",
      badgeKey: null,
      requiresCapability: "TEAM_VIEW",
      // T-125 — web `navPlanFeature: "teamCollaborationIncluded"`.
      requiresPlanFeature: "teamCollaborationIncluded",
    },
    {
      id: "workspace.reports",
      label: "Reports",
      href: "/reports",
      iconKey: "reports",
      domain: "WORKSPACE",
      badgeKey: null,
      requiresCapability: "REPORTS_VIEW",
    },
    {
      id: "workspace.search",
      label: "Search",
      href: "/search",
      iconKey: "search",
      domain: "WORKSPACE",
      badgeKey: null,
      requiresCapability: "SEARCH_VIEW",
    },
    {
      id: "workspace.packaging",
      label: "Product & Packaging",
      href: "/packaging",
      iconKey: "packaging",
      domain: "WORKSPACE",
      badgeKey: null,
      requiresCapability: "EXPORT_GOVERNANCE_MANAGE",
      // T-125 / PRD-01 — the web route is Enterprise-only, organization-only and
      // needs EXPORT_GOVERNANCE_MANAGE; DASHBOARD_VIEW advertised a 404 to every
      // self-serve plan.
      requiresEnterpriseWorkspace: true,
      requiresOrganizationWorkspace: true,
    },
    {
      id: "workspace.evidence_lifecycle",
      label: "Evidence Lifecycle",
      href: "/evidence-lifecycle",
      iconKey: "lifecycle",
      domain: "WORKSPACE",
      badgeKey: null,
      requiresCapability: "LIFECYCLE_VIEW",
      // T-125 / PRD-01 — Enterprise-only, organization-only and LIFECYCLE_VIEW on
      // the web; a self-serve plan was advertised a redirect to /evidence.
      requiresEnterpriseWorkspace: true,
      requiresOrganizationWorkspace: true,
    },
    // Trust nav removed (2026-07-15): the authenticated static Trust Hub
    // (`/trust-hub`, id `workspace.trust`) was deleted as redundant. The
    // canonical trust portal is the public Trust Center (`/trust`, reached via
    // the footer); the in-app `/trust-center/*` articles are a non-nav
    // documentation surface (frontend gate id `workspace.trust_center`,
    // sidebarEligible=false) and therefore have no entry in this nav projection.
    // Phase 4A — Governance Platform discoverability. The /governance-platform
    // page is the canonical org governance hub (departments, delegated admin,
    // policies, access reviews, cross-org). Gated by GOVERNANCE_VIEW.
    // ATTENTION ARCHITECTURE PHASE 4B (2026-08-22) — TENANT OPERATIONS.
    //
    // "What unresolved shared work must we act on?" is a workspace question,
    // so it is a workspace nav item. OPERATIONS_VIEW is granted by whether
    // the workspace can PRODUCE operational conditions, never by a plan name,
    // so a solo Pro investigator sees it and a Free personal space does not —
    // and neither outcome is hardcoded anywhere.
    {
      id: "workspace.operations",
      label: "Operations",
      href: "/operations",
      iconKey: "ops_center",
      domain: "WORKSPACE",
      badgeKey: "ops_center_runtime",
      requiresCapability: "OPERATIONS_VIEW",
    },
    {
      id: "workspace.governance_platform",
      label: "Governance Platform",
      href: "/governance-platform",
      iconKey: "governance",
      domain: "WORKSPACE",
      badgeKey: null,
      requiresCapability: "GOVERNANCE_VIEW",
      requiresEnterpriseWorkspace: true,
      requiresOrganizationWorkspace: true,
    },
  ],
};

// =============================================================================
// Group 2 — REVIEW & GOVERNANCE
// =============================================================================

const REVIEW_GOVERNANCE_GROUP: NavRegistryGroup = {
  id: "review_governance",
  title: "Review & Governance",
  domain: "REVIEW_GOVERNANCE",
  order: 2,
  items: [
    {
      id: "review.queue",
      label: "Reviewer Ops",
      href: "/review",
      iconKey: "reviewer_ops",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: "REVIEWER_OPS_VIEW",
      // T-125 — the web route's `requiredPlanFeature`.
      requiresPlanFeature: "reviewerOperationsIncluded",
    },
    {
      id: "review.sla",
      label: "SLA",
      href: "/reviewer-ops/sla",
      iconKey: "sla",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: "SLA_VIEW",
      requiresPlanFeature: "reviewerOperationsIncluded",
    },
    {
      id: "review.escalations",
      label: "Escalations",
      href: "/reviewer-ops/escalations",
      iconKey: "escalations",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: "escalations_open",
      requiresCapability: "ESCALATIONS_VIEW",
      requiresPlanFeature: "reviewerOperationsIncluded",
    },
    // Phase 2.1 — discoverability promotion. These 4 surfaces were
    // fully wired to backend (Phase 18 Twilio, Phase 23 workflows,
    // Phase 15 intelligence, Phase 31.12 investigation) but absent
    // from the sidebar. The audit confirmed real route handlers + UI
    // for each. Gated by existing capabilities so a VIEWER who can
    // already see Reviewer Ops will also see Workflows / Intelligence /
    // Investigation; admins additionally see Communications.
    //
    // Each linked page already implements its own auth-error /
    // unavailable / no-workspace states. The nav item only changes
    // DISCOVERABILITY — the backend remains authoritative.
    {
      id: "review.workflows",
      label: "Workflows",
      href: "/workflows",
      iconKey: "workflows",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      // Use REVIEWER_OPS_VIEW: workflow instances are part of the
      // review/governance domain and any team member who can see
      // reviewer ops should be able to inspect workflow state.
      requiresCapability: "INTEGRATIONS_MANAGE",
      // T-125 / PRD-01 — `/workflows` is the workflow TEMPLATE admin
      // (`workspace.workflows`): Enterprise-only and INTEGRATIONS_MANAGE on the
      // web. REVIEWER_OPS_VIEW advertised a 404 to every Team reviewer.
      requiresEnterpriseWorkspace: true,
    },
    {
      id: "review.intelligence",
      label: "Intelligence",
      href: "/intelligence",
      iconKey: "intelligence",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      // OCR / transcript / entity jobs operate on evidence the user
      // can already view. Use EVIDENCE_VIEW.
      requiresCapability: "EVIDENCE_VIEW",
      // T-125 / PRD-01 — `workspace.intelligence` is Enterprise-only on the web.
      requiresEnterpriseWorkspace: true,
    },
    {
      id: "review.investigation",
      label: "Investigation",
      href: "/investigation",
      iconKey: "investigation",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      // Investigation overview surfaces signal totals / graph activity
      // for cases the user has access to. Use CASES_VIEW.
      requiresCapability: "EVIDENCE_VIEW",
      // T-125 / PRD-01 — `investigation.hub`: Enterprise-only, EVIDENCE_VIEW.
      requiresEnterpriseWorkspace: true,
    },
    {
      id: "governance.hub",
      label: "Governance",
      href: "/governance",
      iconKey: "governance",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: "governance_incidents",
      requiresCapability: "GOVERNANCE_VIEW",
      requiresEnterpriseWorkspace: true,
      requiresOrganizationWorkspace: true,
    },
    // -------------------------------------------------------------------
    // Phase 3A — Redaction Platform nav binding. Canonical id
    // `workspace.review_redaction` points at the real /redaction page.
    // Bound under REVIEW_GOVERNANCE because redaction is a reviewer
    // surface gated by REVIEWER_OPS_VIEW (the existing reviewer-tier
    // capability — the bounded redaction.* permissions live in the
    // shared permission catalog and are enforced inside the redaction
    // routes layer).
    // -------------------------------------------------------------------
    {
      id: "workspace.review_redaction",
      label: "Redaction",
      href: "/redaction",
      iconKey: "redaction",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: null,
      // T-125 / ARCH-09 — ONE authority for redaction: FEATURE_REDACTION,
      // projected as planFeatures.redactionIncluded (any workspace kind). It is
      // not a reviewer-operations surface: REVIEWER_OPS_VIEW was the wrong gate
      // and advertised a 404 to every Team reviewer without the grant.
      requiresPlanFeature: "redactionIncluded",
    },
    // -------------------------------------------------------------------
    // Phase 3B — Intelligence Platform nav bindings. Canonical ids for
    // the 3 platform pages: intelligence-platform hub, executive
    // dashboard, audit-transparency center. Distinct from the legacy
    // `review.intelligence` (Phase 31 entry) which remains for back-
    // compat. The new ids point at the Phase 3B pages on disk.
    // -------------------------------------------------------------------
    {
      id: "workspace.executive",
      label: "Executive Dashboard",
      href: "/executive",
      iconKey: "executive",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: "GOVERNANCE_VIEW",
      requiresEnterpriseWorkspace: true,
      requiresOrganizationWorkspace: true,
    },
    {
      id: "workspace.audit_transparency",
      label: "Audit & Transparency",
      href: "/audit-transparency",
      iconKey: "audit_transparency",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: "GOVERNANCE_VIEW",
      alsoRequiresCapabilities: ["ANALYTICS_VIEW"],
      requiresEnterpriseWorkspace: true,
      requiresOrganizationWorkspace: true,
    },
    // -------------------------------------------------------------------
    // Phase 3B Closure — Intelligence Quality + Budget Center. Distinct
    // pages from the Phase 3B platform hub, registered for sidebar
    // discoverability. Both point at REAL pages on disk:
    //   /intelligence-quality → apps/web/app/(app)/intelligence-quality/page.tsx
    //   /budget-center        → apps/web/app/(app)/budget-center/page.tsx
    // -------------------------------------------------------------------
    {
      id: "workspace.intelligence_quality",
      label: "Intelligence Quality",
      href: "/intelligence-quality",
      iconKey: "intelligence",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: "GOVERNANCE_VIEW",
      // T-125 / O-01 — Enterprise-only, organization-only and GOVERNANCE_VIEW on
      // the web; EVIDENCE_VIEW advertised a 404 to every self-serve plan.
      requiresEnterpriseWorkspace: true,
      requiresOrganizationWorkspace: true,
    },
    {
      id: "workspace.budget_center",
      label: "Budget Center",
      href: "/budget-center",
      iconKey: "intelligence",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: "GOVERNANCE_VIEW",
      requiresEnterpriseWorkspace: true,
      requiresOrganizationWorkspace: true,
    },
    {
      id: "governance.lifecycle",
      label: "Lifecycle",
      href: "/governance/lifecycle",
      iconKey: "lifecycle",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: "LIFECYCLE_VIEW",
      requiresEnterpriseWorkspace: true,
      requiresOrganizationWorkspace: true,
    },
    {
      id: "governance.policy",
      label: "Policy",
      href: "/governance/policy",
      iconKey: "policy",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: "GOVERNANCE_ACT",
      requiresEnterpriseWorkspace: true,
      requiresOrganizationWorkspace: true,
    },
    {
      id: "governance.retention",
      label: "Retention",
      href: "/governance/retention",
      iconKey: "retention",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: "GOVERNANCE_ACT",
      alsoRequiresCapabilities: ["RETENTION_MANAGE"],
      requiresEnterpriseWorkspace: true,
      requiresOrganizationWorkspace: true,
    },
    {
      id: "governance.destruction",
      label: "Destruction",
      href: "/governance/destruction",
      iconKey: "destruction",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: "GOVERNANCE_ACT",
      alsoRequiresCapabilities: ["RETENTION_MANAGE"],
      requiresEnterpriseWorkspace: true,
      requiresOrganizationWorkspace: true,
    },
  ],
};

// =============================================================================
// Group 3 — PLATFORM HEALTH
// =============================================================================

const PLATFORM_HEALTH_GROUP: NavRegistryGroup = {
  id: "platform_health",
  title: "Platform Health",
  domain: "PLATFORM_HEALTH",
  order: 3,
  items: [
    // ATTENTION ARCHITECTURE PHASE 4B (2026-08-22) — Operations LEFT this
    // group. It was listed under PLATFORM HEALTH with the platform-tier
    // OPS_CENTER_VIEW capability, which made the one surface that answers
    // "what unresolved work does MY workspace have?" visible only to PROOVRA
    // staff. It is now a WORKSPACE item gated on OPERATIONS_VIEW; see the
    // WORKSPACE group above. Nothing PROOVRA-internal moved with it — the
    // platform consoles below stay exactly where they were.
    {
      id: "platform.observability",
      label: "Observability",
      href: "/admin/platform/observability",
      iconKey: "observability",
      domain: "PLATFORM_HEALTH",
      badgeKey: "observability_runtime",
      requiresCapability: "OBSERVABILITY_VIEW",
    },
    {
      id: "platform.runbooks",
      label: "Runbooks",
      href: "/admin/platform/runbooks",
      iconKey: "runbooks",
      domain: "PLATFORM_HEALTH",
      badgeKey: null,
      requiresCapability: "RUNBOOKS_VIEW",
    },
    // Phase IA-collapse — renamed "Security Center" → "Identity &
    // Security". Personal account security (password, sessions,
    // security events) moved to /settings/security; this entry remains
    // the workspace operator-facing identity console.
    {
      id: "platform.security_center",
      label: "Identity & Security",
      href: "/security-center",
      iconKey: "security_center",
      domain: "PLATFORM_HEALTH",
      badgeKey: null,
      requiresCapability: "SECURITY_CENTER_VIEW",
      requiresEnterpriseWorkspace: true,
    },
    // Phase 2.3 — Identity administration hub. The /admin/identity
    // landing page links to: providers (SSO), SCIM, sessions, access
    // reviews, permission matrix, identity timeline, runtime monitor.
    // Read-only audit found these pages exist (Phase 26-26.75 ships
    // them) but are NOT discoverable from any nav surface, so
    // operators rely on direct URLs. SECURITY_CENTER_VIEW is the
    // right gate: it's granted to OWNER/ADMIN and already controls
    // the sibling /security-center page.
    // PV-PLACE-001 — identity administration is the WORKSPACE's, and lives
    // in its Security Center; `/admin` is the platform console only.
    {
      id: "platform.identity_admin",
      label: "Identity Admin",
      href: "/security-center/identity",
      iconKey: "security_center",
      domain: "PLATFORM_HEALTH",
      badgeKey: null,
      requiresCapability: "SECURITY_CENTER_VIEW",
      requiresEnterpriseWorkspace: true,
      requiresOrganizationWorkspace: true,
    },
  ],
};

// =============================================================================
// Group 4 — ADMINISTRATION
// =============================================================================

const ADMINISTRATION_GROUP: NavRegistryGroup = {
  id: "administration",
  title: "Administration",
  domain: "ADMINISTRATION",
  order: 4,
  items: [
    {
      id: "admin.teams",
      // Phase B0 — operational vocabulary is "Workspaces". The
      // sidebar surfaces this label; the URL keeps `/teams` for
      // backwards-compat (the new `/v1/workspaces/*` aliases route
      // to the same controllers). A future migration can flip the
      // URL once every consumer is on the v3 envelope.
      label: "Workspaces",
      href: "/workspaces",
      iconKey: "teams",
      domain: "ADMINISTRATION",
      badgeKey: null,
      // Phase ROUTE-FIX — Teams must remain reachable for personal
      // users as a CREATE-team entry point. The /teams page itself
      // renders the create flow when no team workspace exists.
      // TEAM_MANAGE controls write access inside the page for team-
      // scoped actions.
      surface: "BOTH",
      requiresCapability: "TEAM_VIEW",
    },
    {
      id: "admin.billing",
      label: "Billing",
      href: "/billing",
      iconKey: "billing",
      domain: "ADMINISTRATION",
      badgeKey: null,
      // Phase ROUTE-FIX — Billing is BOTH operator-surface (team
      // workspace billing/seats) and account-surface (personal
      // subscription / upgrade). The capability resolver grants
      // BILLING_VIEW to personal users for their own account.
      surface: "BOTH",
      requiresCapability: "BILLING_VIEW",
    },
    {
      id: "admin.integrations",
      label: "Integrations",
      href: "/integrations",
      iconKey: "integrations",
      domain: "ADMINISTRATION",
      badgeKey: null,
      requiresCapability: "INTEGRATIONS_MANAGE",
      requiresEnterpriseWorkspace: true,
    },
    {
      id: "admin.intake_links",
      label: "Intake Links",
      href: "/intake-links",
      iconKey: "intake_links",
      domain: "ADMINISTRATION",
      badgeKey: null,
      requiresCapability: "INTAKE_LINKS_MANAGE",
      // T-125 — web `navPlanFeature: "intakeIncluded"`.
      requiresPlanFeature: "intakeIncluded",
    },
    // Phase 2.1 — Communications surface (Twilio admin) was wired
    // (Phase 18) but absent from the sidebar. Gated by INTEGRATIONS_MANAGE
    // because it carries the same operational sensitivity (per-team
    // outbound channel + retry visibility) and inherits the same
    // admin-only audience.
    //
    // Phase IA-collapse — renamed "Communications" → "Messaging
    // operations" to match the operator-facing nature of the surface
    // (SMS/WhatsApp/OTP delivery state + retry/cancel + provider
    // health). Same href + capability.
    {
      id: "admin.communications",
      label: "Messaging operations",
      href: "/communications",
      iconKey: "communications",
      domain: "ADMINISTRATION",
      badgeKey: null,
      requiresCapability: "INTEGRATIONS_MANAGE",
      alsoRequiresCapabilities: ["INTAKE_LINKS_MANAGE"],
      requiresEnterpriseWorkspace: true,
    },
    {
      id: "admin.settings",
      label: "Settings",
      href: "/settings",
      iconKey: "settings",
      domain: "ADMINISTRATION",
      badgeKey: null,
      // Settings is a CORE route — visible in both sidebar (operator
      // workspace) and account menu (always-available account
      // surface).
      surface: "BOTH",
      requiresCapability: "SETTINGS_VIEW",
    },
    {
      id: "admin.platform",
      label: "Platform Admin",
      href: "/admin",
      iconKey: "admin",
      domain: "ADMINISTRATION",
      badgeKey: null,
      requiresCapability: "PLATFORM_ADMIN",
    },
  ],
};


// =============================================================================
// Canonical registry
// =============================================================================

export const NAVIGATION_REGISTRY: ReadonlyArray<NavRegistryGroup> = [
  WORKSPACE_GROUP,
  REVIEW_GOVERNANCE_GROUP,
  PLATFORM_HEALTH_GROUP,
  ADMINISTRATION_GROUP,
  // ACCOUNT_GROUP retired (2026-07-21). The top-bar account menu is now
  // resolved entirely on the client by the single canonical resolver
  // `apps/web/lib/navigation/accountMenu.ts` (account management only, no
  // duplicated application navigation, no public /pricing entry). The server
  // no longer projects account-menu items — `accountMenu.items` is emitted
  // empty for schema stability. Account routes remain discoverable via the
  // client route registry (command palette + All Tools).
];

// =============================================================================
// Filter — pure
// =============================================================================

import type {
  CapabilityMap,
  PlatformContextNavGroup,
  PlatformContextNavItem,
  ProovraPillar,
} from "./types.js";

// =============================================================================
// Phase 1A — 8-pillar canonical order (server-side mirror of pillarRegistry.ts)
// =============================================================================

/**
 * Canonical pillar order. Matches the client-side PROOVRA_PILLARS constant
 * in apps/web/lib/navigation/pillarRegistry.ts.
 *
 * Route-id → pillar assignment: the server-side registry does not embed the
 * full PILLAR_FOR_ROUTE_ID client map. Instead `buildPillarProjection` assigns
 * items to pillars based on their `domain` field using the bounded mapping
 * below, which mirrors the canonical client-side assignment.
 */
const PILLAR_ORDER: ReadonlyArray<ProovraPillar> = [
  "HOME",
  "CAPTURE",
  "CASES",
  "REVIEW",
  "GOVERNANCE",
  "OPERATIONS",
  "ADMIN",
  "TRUST",
];

/**
 * Domain → pillar mapping for the server-side registry items.
 * Each NavDomain maps to exactly one pillar.
 */
const DOMAIN_TO_PILLAR: Record<NavDomain, ProovraPillar> = {
  WORKSPACE: "CASES",          // workspace-scoped items default to CASES pillar
  REVIEW_GOVERNANCE: "REVIEW", // reviewer + governance items → REVIEW pillar
  PLATFORM_HEALTH: "OPERATIONS", // ops / security items → OPERATIONS pillar
  ADMINISTRATION: "ADMIN",     // teams / settings / billing → ADMIN pillar
  ACCOUNT: "ADMIN",            // account-menu items → ADMIN pillar
  BILLING_PLAN: "ADMIN",       // billing → ADMIN pillar
  PUBLIC_MARKETING: "TRUST",   // marketing / public → TRUST pillar
};

/**
 * Predicate: should the item appear on the given surface, given
 * its declared `surface` (defaulting to SIDEBAR if absent)?
 */
function appearsOnSurface(item: NavRegistryItem, target: NavSurface): boolean {
  const declared: NavSurface = item.surface ?? "SIDEBAR";
  if (declared === "BOTH") return target === "SIDEBAR" || target === "ACCOUNT_MENU";
  return declared === target;
}

function passesCapabilityGate(
  item: NavRegistryItem,
  caps: CapabilityMap,
): boolean {
  if (item.requiresCapability !== null && caps[item.requiresCapability] !== true) {
    return false;
  }
  for (const extra of item.alsoRequiresCapabilities ?? []) {
    if (caps[extra] !== true) return false;
  }
  return true;
}

/**
 * T-125 — the web route's commercial and kind gates, in the web resolver's
 * order (`routeAccessResolver.ts`): the organization requirement applies to
 * everyone; the Enterprise-workspace and plan-feature requirements are
 * bypassed by platform admins. Unknown values fail closed.
 */
function passesWorkspaceGate(
  item: NavRegistryItem,
  gate: NavigationGateContext,
): boolean {
  if (item.requiresOrganizationWorkspace && gate.activeSpaceType !== "ORGANIZATION") {
    return false;
  }
  if (gate.isPlatformAdmin) return true;
  if (item.requiresEnterpriseWorkspace && gate.isEnterpriseWorkspace !== true) {
    return false;
  }
  if (item.requiresPlanFeature && gate.planFeatures?.[item.requiresPlanFeature] !== true) {
    return false;
  }
  return true;
}

function isAdvertised(
  item: NavRegistryItem,
  caps: CapabilityMap,
  gate: NavigationGateContext,
): boolean {
  // Stage E (registry flags) and stage F (per-item web-route table) both
  // implement T-125; an item is advertised only when BOTH agree, so neither
  // check can re-open a route the other closes.
  return (
    passesCapabilityGate(item, caps) &&
    passesWorkspaceGate(item, gate) &&
    passesSurfaceGate(item, {
      isPlatformAdmin: gate.isPlatformAdmin,
      isEnterpriseWorkspace: gate.isEnterpriseWorkspace,
      activeSpaceType: gate.activeSpaceType,
      planFeatures: (gate.planFeatures ?? {}) as Readonly<Record<string, unknown>>,
    })
  );
}

/**
 * T-125 (Team remediation stage F, audit PRD-01/O-01) — WHO A NAVIGATION ITEM
 * MAY BE ADVERTISED TO, beyond its capability.
 *
 * The web decides whether a route loads (apps/web routeRegistry +
 * resolveRouteAccess, and the /path surface rules in lib/surface/tiers.ts).
 * This payload used to filter by capability only, so a Team workspace was
 * advertised /workflows, /intelligence, /investigation, /packaging, /redaction
 * and /evidence-lifecycle, which that context cannot open. Each item names
 * the web route it opens and the same gates; the web contract test
 * `navigation-contract-resolves.test.ts` proves, for FREE, PRO, TEAM and
 * ENTERPRISE contexts, that every advertised item resolves to a page that
 * loads. Platform admins bypass the commercial gates (as on the web); the
 * organization-workspace requirement applies to everyone.
 */
export type NavSurfaceContext = {
  isPlatformAdmin: boolean;
  isEnterpriseWorkspace: boolean;
  activeSpaceType: "PERSONAL" | "ORGANIZATION" | null;
  planFeatures: Readonly<Record<string, unknown>>;
};
export type NavSurfaceGate = {
  /** The web route registry id this item opens. */
  webRouteId: string;
  enterpriseOnly?: true;
  organizationOnly?: true;
  platformAdminOnly?: true;
  /** A planFeatures key that must be true (requiredPlanFeature / navPlanFeature on the web). */
  planFeature?: string;
};
const ENT_ORG = { enterpriseOnly: true, organizationOnly: true } as const;
export const NAV_SURFACE_GATES: Readonly<Record<string, NavSurfaceGate>> = {
  "workspace.home": { webRouteId: "workspace.home" },
  "workspace.capture": { webRouteId: "workspace.capture" },
  "workspace.evidence": { webRouteId: "workspace.evidence" },
  "workspace.cases": { webRouteId: "workspace.cases", planFeature: "casesIncluded" },
  "workspace.team_governance": { webRouteId: "workspace.collaboration_teams", planFeature: "teamCollaborationIncluded" },
  "workspace.reports": { webRouteId: "workspace.reports" },
  "workspace.search": { webRouteId: "workspace.search" },
  "workspace.packaging": { webRouteId: "workspace.packaging", ...ENT_ORG },
  "workspace.evidence_lifecycle": { webRouteId: "workspace.evidence_lifecycle", ...ENT_ORG },
  "workspace.operations": { webRouteId: "workspace.operations" },
  "workspace.governance_platform": { webRouteId: "workspace.governance_platform", ...ENT_ORG },
  "review.queue": { webRouteId: "workspace.review", planFeature: "reviewerOperationsIncluded" },
  "review.sla": { webRouteId: "review.sla", planFeature: "reviewerOperationsIncluded" },
  "review.escalations": { webRouteId: "review.escalations", planFeature: "reviewerOperationsIncluded" },
  "review.workflows": { webRouteId: "workspace.workflows", enterpriseOnly: true },
  "review.intelligence": { webRouteId: "workspace.intelligence", enterpriseOnly: true },
  "review.investigation": { webRouteId: "investigation.hub", enterpriseOnly: true },
  "governance.hub": { webRouteId: "governance.hub", ...ENT_ORG },
  "workspace.review_redaction": { webRouteId: "workspace.review_redaction", planFeature: "redactionIncluded" },
  "workspace.executive": { webRouteId: "workspace.executive", ...ENT_ORG },
  "workspace.audit_transparency": { webRouteId: "workspace.audit_transparency", ...ENT_ORG },
  "workspace.intelligence_quality": { webRouteId: "workspace.intelligence_quality", ...ENT_ORG },
  "workspace.budget_center": { webRouteId: "workspace.budget_center", ...ENT_ORG },
  "governance.lifecycle": { webRouteId: "governance.lifecycle", ...ENT_ORG },
  "governance.policy": { webRouteId: "governance.policy", ...ENT_ORG },
  "governance.retention": { webRouteId: "governance.retention", ...ENT_ORG },
  "governance.destruction": { webRouteId: "governance.destruction", ...ENT_ORG },
  "platform.observability": { webRouteId: "platform.observability", platformAdminOnly: true },
  "platform.runbooks": { webRouteId: "platform.runbooks", platformAdminOnly: true },
  "platform.security_center": { webRouteId: "workspace.security_center", enterpriseOnly: true },
  "platform.identity_admin": { webRouteId: "security_center.identity", ...ENT_ORG },
  // /workspaces (the switcher list) is an Enterprise surface (tiers.ts); the
  // self-serve owner's workspace page is /teams/:id, not advertised here.
  "admin.teams": { webRouteId: "admin.teams", enterpriseOnly: true },
  "admin.billing": { webRouteId: "account.billing" },
  "admin.integrations": { webRouteId: "workspace.integrations", enterpriseOnly: true },
  "admin.intake_links": { webRouteId: "workspace.intake_links", planFeature: "intakeIncluded" },
  "admin.communications": { webRouteId: "workspace.communications", enterpriseOnly: true },
  "admin.settings": { webRouteId: "account.settings" },
  "admin.platform": { webRouteId: "platform.admin", platformAdminOnly: true },
};

/** True when the item may be advertised in this context (capability aside). */
export function passesSurfaceGate(item: NavRegistryItem, ctx: NavSurfaceContext | undefined): boolean {
  if (!ctx) return true;
  const gate = NAV_SURFACE_GATES[item.id];
  // An item with no declared gate is never advertised once a context is
  // known: an undeclared route is how the 404s above got into this payload.
  if (!gate) return false;
  if (gate.platformAdminOnly) return ctx.isPlatformAdmin;
  if (gate.organizationOnly && ctx.activeSpaceType !== "ORGANIZATION") return false;
  if (ctx.isPlatformAdmin) return true;
  if (gate.enterpriseOnly && !ctx.isEnterpriseWorkspace) return false;
  if (gate.planFeature && ctx.planFeatures[gate.planFeature] !== true) return false;
  return true;
}

function projectItem(item: NavRegistryItem): PlatformContextNavItem {
  return {
    id: item.id,
    label: item.label,
    href: item.href,
    iconKey: item.iconKey,
    badgeKey: item.badgeKey,
    domain: item.domain,
  };
}

/**
 * Pure filter — returns the visible nav tree for the given capability
 * map. Items with `requiresCapability === null` are always visible
 * (provided the parent group has at least one visible item).
 *
 * This is the LEGACY sidebar-only filter, retained for backwards
 * compatibility with the existing envelope's `navigation.groups`
 * field. New consumers should use `buildNavigationProjection`.
 */
export function filterNavigationRegistry(
  caps: CapabilityMap,
  gate: NavigationGateContext,
): ReadonlyArray<PlatformContextNavGroup> {
  return NAVIGATION_REGISTRY.map<PlatformContextNavGroup>((group) => {
    const items: PlatformContextNavItem[] = group.items
      .filter((item) => appearsOnSurface(item, "SIDEBAR"))
      .filter((item) => isAdvertised(item, caps, gate))
      .map(projectItem);
    return {
      id: group.id,
      title: group.title,
      domain: group.domain,
      items,
    };
  }).filter((group) => group.items.length > 0);
}

/**
 * Phase ROUTE-FIX — full navigation projection.
 *
 * Returns the navigation surfaces SEPARATELY so the frontend can
 * render the sidebar and the topbar account menu independently:
 *
 *   - `sidebar.groups` — operator surfaces (workspace / review /
 *     platform-health / administration). Filtered by capability.
 *   - `accountMenu.items` — always-available account surfaces
 *     (profile / notifications / pricing / billing / teams / help).
 *     Filtered by capability but NOT by workspace scope.
 *
 * The same NavRegistryItem can appear on both surfaces when its
 * `surface` is `"BOTH"` (e.g. Settings, Billing, Teams).
 */
export function buildNavigationProjection(
  caps: CapabilityMap,
  gate: NavigationGateContext,
): {
  sidebar: {
    groups: ReadonlyArray<PlatformContextNavGroup>;
    pillars: ReadonlyArray<{
      pillar: ProovraPillar;
      items: ReadonlyArray<PlatformContextNavItem>;
    }>;
  };
  accountMenu: { items: ReadonlyArray<PlatformContextNavItem> };
} {
  const sidebarGroups = NAVIGATION_REGISTRY.map<PlatformContextNavGroup>(
    (group) => {
      const items: PlatformContextNavItem[] = group.items
        .filter((item) => appearsOnSurface(item, "SIDEBAR"))
        .filter((item) => isAdvertised(item, caps, gate))
        .map(projectItem);
      return {
        id: group.id,
        title: group.title,
        domain: group.domain,
        items,
      };
    },
  ).filter((group) => group.items.length > 0);

  // Account menu — RETIRED server-side (2026-07-21). The top-bar account
  // menu is resolved entirely on the client by the single canonical resolver
  // `apps/web/lib/navigation/accountMenu.ts`. The server emits an empty list
  // for schema stability; no account-menu items are projected here anymore.
  const accountMenuItems: PlatformContextNavItem[] = [];

  // Phase 1A — also expose the canonical 8-pillar grouping so callers don't
  // have to call buildPillarProjection separately. Same capability gating,
  // single pass-through to the canonical pillar-builder for shape parity.
  const pillars = buildPillarProjection(caps, gate);

  return {
    sidebar: { groups: sidebarGroups, pillars },
    accountMenu: { items: accountMenuItems },
  };
}

/**
 * Phase 1A — 8-pillar grouped projection.
 *
 * Returns the sidebar items grouped by their canonical pillar in
 * PILLAR_ORDER order. This is the server-side analogue of the client-side
 * `buildPillarGroupedNav` in `navigationGroupingResolver.ts`.
 *
 * Consumers that render the pillar-aware sidebar (Phase 1A+) should use
 * this function instead of `buildNavigationProjection`. The output shape
 * maps 1:1 to `PlatformContextNavigation.sidebar.pillars`.
 */
export function buildPillarProjection(
  caps: CapabilityMap,
  gate: NavigationGateContext,
): ReadonlyArray<{ pillar: ProovraPillar; items: ReadonlyArray<PlatformContextNavItem> }> {
  // Collect all sidebar-eligible items that pass the capability gate.
  const allItems: Array<{ pillar: ProovraPillar; item: PlatformContextNavItem }> = [];
  for (const group of NAVIGATION_REGISTRY) {
    for (const registryItem of group.items) {
      if (!appearsOnSurface(registryItem, "SIDEBAR")) continue;
      if (!isAdvertised(registryItem, caps, gate)) continue;
      const pillar = DOMAIN_TO_PILLAR[registryItem.domain as NavDomain] ?? "ADMIN";
      allItems.push({ pillar, item: projectItem(registryItem) });
    }
  }

  // Group by pillar in canonical PILLAR_ORDER order.
  return PILLAR_ORDER.map((pillar) => ({
    pillar,
    items: allItems
      .filter((entry) => entry.pillar === pillar)
      .map((entry) => entry.item),
  }));
}
