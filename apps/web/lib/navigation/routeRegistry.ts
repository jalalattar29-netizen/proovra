/**
 * PHASE 38.6 — Canonical route registry.
 *
 * One canonical record per product route. This is the SOURCE OF TRUTH
 * for:
 *
 *   - route existence (which routes the app knows about)
 *   - required capabilities (which capability keys unlock the route)
 *   - active-space requirements (PERSONAL_OR_ORG, ORGANIZATION_ONLY,
 *     NONE)
 *   - fallback behavior when access is denied
 *   - workflow tags (drive ordering / emphasis, NOT access)
 *   - All Tools surface visibility
 *
 * Hard rules pinned by tests:
 *
 *   1. `advancedByDefault: true` demotes a route to More/Advanced,
 *      but the route remains reachable via search + All Tools.
 *   3. Capability-allowed routes are reachable from at least one
 *      navigation surface (sidebar OR All Tools OR command palette).
 *   4. Account-tier routes (settings, billing, pricing) declare
 *      `requiredActiveSpace: "NONE"` so they NEVER hide on workspace
 *      issues.
 */

import type {
  CapabilityKey,
  PlatformContextPlanFeatures,
} from "../platform-context/types";

/**
 * Track 1A (surface-tier removal) — boolean commercial-entitlement keys of
 * the SERVER-computed `envelope.planFeatures` projection that a route may
 * require. The backend PLAN_CAPABILITIES catalog is the single source of
 * truth; the client only reads the projected boolean.
 */
export type PlanFeatureGateKey = {
  [K in keyof PlatformContextPlanFeatures]-?: PlatformContextPlanFeatures[K] extends boolean
    ? K
    : never;
}[keyof PlatformContextPlanFeatures];

export const ROUTE_DOMAINS = [
  "PUBLIC",
  "ACCOUNT",
  "PERSONAL_WORKSPACE",
  "ORGANIZATION_WORKSPACE",
  "TEAM_ONLY",
  "GOVERNANCE",
  "REVIEW_OPERATIONS",
  "OPS",
  "PLATFORM_ADMIN",
] as const;
export type RouteDomain = (typeof ROUTE_DOMAINS)[number];

export const REQUIRED_ACTIVE_SPACES = [
  "NONE",
  "PERSONAL_OR_ORG",
  "ORGANIZATION_ONLY",
  "PLATFORM_ADMIN",
] as const;
export type RequiredActiveSpace = (typeof REQUIRED_ACTIVE_SPACES)[number];

export const FALLBACK_BEHAVIORS = [
  "LOAD",
  "DEGRADED",
  "REQUEST_ACCESS",
  "CREATE_ORG",
  "UPGRADE",
  "HIDDEN_IF_NO_CAPABILITY",
] as const;
export type FallbackBehavior = (typeof FALLBACK_BEHAVIORS)[number];

export type RouteDefinition = {
  /** Stable id used in tests + nav + analytics. */
  id: string;
  /** App route path (Next.js). */
  href: string;
  /** Operator-facing label. */
  label: string;
  /** Short, operationally-toned description. */
  description: string;
  domain: RouteDomain;
  /**
   * Capability keys the actor must have to USE the route. Empty array
   * means "no capability check beyond the active-space requirement".
   * If any required capability is missing, the access resolver applies
   * `fallbackBehavior` (typically `REQUEST_ACCESS`).
   */
  requiredCapabilities: ReadonlyArray<CapabilityKey>;
  requiredActiveSpace: RequiredActiveSpace;
  fallbackBehavior: FallbackBehavior;
  /**
   * Workflow tags that PRIORITIZE the route in the sidebar / dashboard.
   * NEVER used as a gate by the access resolver.
   */

  /** When true, the route renders under More/Advanced by default. */
  advancedByDefault: boolean;
  /** When true, the command palette returns this route as a result. */
  commandPaletteVisible: boolean;
  /** When true, the All Tools surface lists this route. */
  allToolsVisible: boolean;
  /** When true, the sidebar may render this route directly. */
  sidebarEligible: boolean;
  /**
   * Optional route-specific denial copy. PageRouteGate prefers this over
   * the generic canonical guidance from `@proovra/shared` when the user
   * lacks a required capability. Use it for routes where the canonical
   * "Request access" panel is too vague — e.g. /intake-links should
   * tell a Viewer-role user to ask their workspace owner instead of
   * showing a generic capability prompt.
   */
  denialGuidance?: string;
  /**
   * Track 1A (surface-tier removal) — SERVER-projected commercial
   * entitlement gate. When set, the route additionally requires
   * `envelope.planFeatures[<key>] === true` (fail-closed while the
   * envelope is loading/degraded). Platform admins bypass. This replaces
   * the deleted `lib/surface/tiers.ts` `entitlementOverride` mechanism —
   * the boolean is computed by the backend PLAN_CAPABILITIES projection;
   * the client never derives it from a plan name.
   */
  requiredPlanFeature?: PlanFeatureGateKey;
};

/**
 * Track 1A (surface-tier removal) — routes that additionally require the
 * SERVER-computed `envelope.flags.isEnterpriseWorkspace` projection (the
 * backend derives it from ENTERPRISE_PLAN_KEYS = {"ENTERPRISE"} for the
 * ACTIVE workspace) or platform-admin elevation.
 *
 * This is the capability-era replacement for the deleted ENTERPRISE tier
 * in `lib/surface/tiers.ts`: the decision input is a server-projected
 * boolean, never a raw plan string, and the rule lives inside the ONE
 * canonical route registry instead of a parallel path table. The
 * `resolveRouteAccess` resolver consults this set; membership yields
 * `NEEDS_UPGRADE` (hidden from nav, bounded denial panel on direct URL)
 * for non-enterprise, non-platform-admin actors.
 */
export const ENTERPRISE_ONLY_ROUTE_IDS: ReadonlySet<string> = new Set([
  // NOTE (12B correction): the organizations LIST + member-safe DETAIL are
  // MEMBERSHIP-gated, not enterprise-workspace-gated — a FREE-plan personal
  // user with an ACTIVE org membership must reach their org list even while
  // their ACTIVE workspace is personal (canonical account-menu contract:
  // "membership is the ONLY input — never plan"). Administration below the
  // detail stays capability-gated and the org ADMIN surfaces below remain
  // enterprise-workspace-gated.
  "account.organization-setup",
  "account.organization_admin",
  "account.organization_admin_overview",
  "account.organization_admin_members",
  "account.organization_admin_departments",
  "account.organization_admin_governance",
  "account.organization_admin_governance_external_reviewers",
  "account.organization_admin_access_reviews",
  "account.organization_admin_retention",
  "account.organization_admin_audit",
  "account.organization_admin_bulk_invite",
  "account.organization_admin_reports",
  "account.organization_admin_readiness",
  "account.organization_admin_security",
  "account.organization_admin_domains",
  "account.organization_admin_trust",
  "account.organization_admin_roles",
  "account.organization_admin_billing",
  "account.organization_admin_integrations",
  // Workspace-admin tenancy + enterprise-shell surfaces.
  //
  // NOTE (PHASE 13 / NEW-062): `admin.teams` is deliberately NOT here.
  //
  // This one route id serves TWO paths — the `/workspaces` switcher list AND
  // the per-workspace administration detail at `/teams/[id]` — and the two
  // have different tiers. `/workspaces` IS enterprise, and that is enforced
  // where it belongs: `app/(app)/workspaces/layout.tsx` applies `SurfaceGate`
  // against the `/workspaces` rule in `lib/surface/tiers.ts`
  // (ENTERPRISE → redirect to /collaboration-teams). Removing the id from this
  // set therefore does not open the switcher list to self-serve plans.
  //
  // `/teams/[id]` is a different surface, declared PROFESSIONAL
  // ("workspace (PRO/TEAM)") by that same tier table — and it is the ONLY
  // surface in the product that hosts `WorkspaceClosureCard` and
  // `WorkspaceOwnershipTransferCard`. Those capabilities are, by their own
  // service design, valid ONLY on the OWNED workspace kind:
  // `workspace-lifecycle.service.ts` refuses an ORGANIZATION workspace
  // (`ORG_WORKSPACE_OWNERSHIP_IS_ORG_GOVERNED`) and equally refuses a Personal
  // Space. An OWNED workspace is never on an ENTERPRISE plan, so
  // `isEnterpriseWorkspace` is false for it by construction.
  //
  // Gating the page on an enterprise workspace therefore made the closure and
  // ownership-transfer capabilities unreachable for exactly the owners they
  // exist for: a PRO/TEAM owner got "Plan upgrade required", while an
  // Enterprise operator could only reach them by administering an OWNED
  // workspace by id while parked in a different, Enterprise workspace. Closing
  // or handing over your own workspace is not an upsell surface.
  //
  // The page keeps its real gates: `requiredCapabilities: ["TEAM_VIEW"]` here,
  // and server-side ownership plus step-up on every `/v1/teams/:id/closure`,
  // `/cancel`, `/reopen` and transfer route.
  "workspace.notification_deliveries",
  "workspace.evidence_lifecycle",
  "workspace.exchange",
  "workspace.integrations",
  "workspace.workflows",
  "workspace.communications",
  "workspace.packaging",
  // Reviewer operations.
  "workspace.review",
  "review.queue",
  "review.operations",
  "review.escalations",
  "review.queue_detail",
  "review.sla",
  "workspace.review_workspace",
  "workspace.coding_schemas",
  "workspace.review_qc",
  "workspace.review_disagreements",
  "workspace.review_metrics",
  "workspace.review_queues",
  "workspace.review_external",
  "workspace.review_redaction",
  // Governance / compliance.
  "governance.hub",
  "governance.policy",
  "governance.analytics",
  "governance.lifecycle",
  "governance.destruction",
  "governance.notifications",
  "governance.retention",
  "workspace.governance_platform",
  "workspace.audit_transparency",
  // Identity / security operator consoles.
  "workspace.security_center",
  "security_center.mfa_recovery",
  "security_center.sso",
  // Enterprise analytics / intelligence / investigation power tools.
  "workspace.executive",
  "workspace.intelligence",
  "workspace.intelligence_quality",
  "workspace.budget_center",
  "investigation.hub",
  "investigation.timeline",
  "investigation.relationships",
  "investigation.graph",
  "investigation.duplicates",
  "investigation.reviewers",
]);

/** Does this route require an enterprise workspace (or platform admin)? */
export function routeRequiresEnterpriseWorkspace(
  route: Pick<RouteDefinition, "id">,
): boolean {
  return ENTERPRISE_ONLY_ROUTE_IDS.has(route.id);
}

/**
 * Canonical product routes. Additive — extend this list when adding new
 * routes. Each entry is a single source of truth that nav, page gates,
 * and All Tools all read from.
 */
export const ROUTE_REGISTRY: ReadonlyArray<RouteDefinition> = [
  // ---------------------------------------------------------------------------
  // ACCOUNT-tier: never hidden by workspace issues.
  // ---------------------------------------------------------------------------
  {
    id: "account.settings",
    href: "/settings",
    label: "Account settings",
    description: "Profile, identity, sessions, security, notifications.",
    domain: "ACCOUNT",
    requiredCapabilities: ["ACCOUNT_SETTINGS_VIEW"],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // Settings IA remediation (2026-07-16) — dedicated child pages behind the
  // compact /settings overview. ACCOUNT-domain, capability-free, NONE
  // active-space: universal personal account surfaces are never plan- or
  // workspace-gated. Discoverable via the overview + cmd-K + All Tools;
  // deliberately not sidebar pillars.
  {
    id: "account.profile",
    href: "/settings#overview",
    label: "Profile & identity",
    description: "Display name, avatar, email, and login method.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "account.preferences",
    href: "/settings#preferences",
    label: "Preferences",
    description: "UI language and account timezone.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "account.privacy",
    href: "/settings#privacy",
    label: "Privacy & legal records",
    description:
      "Cookie preferences, policy acceptance history, and privacy requests.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    // Internal legal reader (2026-07-19 routing correction) — the
    // AUTHENTICATED route for viewing canonical legal documents WITHOUT
    // leaving the App Shell. Reads the SAME markdown/metadata source as
    // the public /legal/[slug] pages (one content source, two shells).
    // Universal account surface — never plan- or workspace-gated.
    // Discovery is contextual (Settings privacy references, trust-center
    // related documents), not palette/sidebar noise.
    id: "account.legal_document",
    href: "/settings/legal/:slug",
    label: "Legal document",
    description:
      "Authenticated reader for canonical legal documents (same content as the public legal pages).",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: false,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  {
    id: "account.billing",
    href: "/billing",
    label: "Billing",
    description: "Account-tier plan, invoices, payment methods.",
    domain: "ACCOUNT",
    requiredCapabilities: ["ACCOUNT_BILLING_VIEW"],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    // Account-menu refactor (2026-07-21) — Billing is now ALSO a sidebar
    // surface (Phase 6). Same canonical `/billing` route and component; the
    // account menu and the sidebar open the identical internal page. No
    // duplicate route, no duplicate component.
    sidebarEligible: true,
  },

  // Phase A.1 — Operational cohesion: register the Phase 2.7X Stage 3+4+5
  // Organization surfaces in the canonical route registry. They were
  // intentionally NOT registered when the Stage 3 surface first shipped
  // ("reachable only by URL for now" per the Stage 3 readiness doc).
  // Registration here gives them the same PageRouteGate / loading /
  // denied / command-palette / discoverability treatment every other
  // canonical surface gets. Sidebar promotion remains OFF — the
  // existing `admin.teams` Workspace Administration index is still the
  // primary entry point for org management, matching the dual-read
  // discipline the Stage 3 readiness doc established. Command-palette
  // (cmd-K) + deep links from CommandCenter are the discoverability
  // path for power users.
  {
    id: "account.organizations",
    href: "/organizations",
    label: "Organizations",
    description:
      "Organizations you belong to (governance, members, workspaces, audit).",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "account.organization-detail",
    href: "/organizations/:id",
    label: "Organization detail",
    description: "Members, workspaces, pending invites, and audit timeline.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  {
    // Enterprise onboarding wizard (owner-facing). Mirrors
    // account.organization-detail: ACCOUNT domain, no capability gate here
    // (ORG_OWNER/ORG_ADMIN is enforced server-side by the /v1/orgs/:id
    // endpoints the wizard reuses; the ENTERPRISE tier gate is inherited
    // from organizations/layout.tsx). Reachable by deep link from the org
    // detail page; kept out of sidebar / command palette / All Tools like
    // the detail route.
    id: "account.organization-setup",
    href: "/organizations/:id/setup",
    label: "Organization setup",
    description:
      "Guided enterprise onboarding — company profile, workspace, invites, security, retention, first capture.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  {
    id: "account.org-invite-accept",
    href: "/org-invites/:token/accept",
    label: "Accept organization invite",
    description:
      "Accept an invitation token issued by an organization administrator.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  // ========================================================================
  // ATTENTION ARCHITECTURE PHASE 5 (2026-08-22) — THE PERSONAL NOTIFICATION
  // CENTRE.
  //
  // WAS: id `account.notifications`, href `/inbox`, label "Operations Center".
  //
  // Every part of that was wrong after Phases 1–4. It is not an Operations
  // Center — Operations is the SHARED workspace surface at `/operations`, and
  // calling a personal feed by that name is what let one person's archive read
  // as a workspace decision. And the answer to "where are my notifications?"
  // was a route called /inbox while /notifications served an email delivery
  // log.
  //
  // Domain stays ACCOUNT: notifications follow the PERSON, so an
  // account-scoped security event and an organization invitation both belong
  // here regardless of which workspace happens to be active.
  //
  // `/inbox` remains a permanent compatibility redirect (next.config.js).
  // ========================================================================
  {
    id: "account.notifications",
    href: "/notifications",
    label: "Notifications",
    description:
      "Everything addressed to you — mentions, assignments, invitations, security events, and integrity signals. Read, archive, or set a reminder; nothing you do here changes shared work.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    // Operations-Center completion — the Operations Center is a primary
    // work surface with exactly ONE sidebar entry (the Bell stays the
    // quick preview). Categories inside stay role/workspace-scoped by
    // the backend, so personal users see personal work only.
    sidebarEligible: true,
  },

  // ---------------------------------------------------------------------------
  // Personal-OR-org workspace surfaces.
  // ---------------------------------------------------------------------------
  {
    id: "workspace.home",
    href: "/home",
    label: "Home",
    description: "Workspace overview and quick actions.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["DASHBOARD_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.capture",
    href: "/capture",
    label: "Capture",
    description: "Record media with hashed, signed integrity.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_CAPTURE"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.evidence",
    href: "/evidence",
    label: "Evidence",
    description: "Browse and manage evidence records.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.cases",
    href: "/cases",
    label: "Cases",
    description:
      "Group evidence into cases, matters, claims, or investigations.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["CASES_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.reports",
    href: "/reports",
    label: "Reports",
    description: "Generated report snapshots and verification packages.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["REPORTS_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.search",
    href: "/search",
    label: "Search",
    description: "Operator search across evidence, workflows, audit events.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["SEARCH_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    // Notification preferences (System 3) — the user-facing settings
    // surface for the per-workspace, per-category, per-channel
    // notification preference model. Distinct from the Operations Center
    // (where items are worked) and the delivery log (admin debugging).
    id: "account.notification_settings",
    href: "/settings#notifications",
    label: "Notification preferences",
    description:
      "Per-workspace notification preferences — which operational categories reach you in-app and by email.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    // ACCOUNT-domain rule (phase 38.6): always NONE — the page itself
    // asks the user to pick a workspace when none is active.
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // ========================================================================
  // ATTENTION ARCHITECTURE PHASE 5 (2026-08-22) — THE DELIVERY LOG MOVED.
  //
  // This surface owned `/notifications`, and its own description said what
  // was wrong with that: "an operations/admin debugging surface, NOT user
  // notifications". A person looking for their notifications found a list of
  // provider errors with resend buttons.
  //
  // It moved intact — same page, same capability gate, same resend actions —
  // to a location that says what it is. `/notifications/deliveries` redirects
  // here for anybody holding the old link.
  // ========================================================================
  {
    id: "workspace.notification_deliveries",
    href: "/settings/notifications/deliveries",
    label: "Notification deliveries",
    description:
      "Outbound delivery log (email) with retry actions — an operations/admin debugging surface, not user notifications.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["SETTINGS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.integrations",
    href: "/integrations",
    label: "Integrations",
    description: "API keys and webhook endpoints for this workspace.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["INTEGRATIONS_MANAGE"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.intake_links",
    href: "/intake-links",
    label: "Intake links",
    description: "Create and manage workflow intake links for external submissions.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["INTAKE_LINKS_MANAGE"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "REQUEST_ACCESS",
    // Track 1A — commercial gate follows the SERVER-computed
    // `envelope.planFeatures.intakeIncluded` boolean (PAYG/PRO/TEAM/
    // ENTERPRISE include intake; FREE does not). Replaces the deleted
    // surface-tier `entitlementOverride` for this path.
    requiredPlanFeature: "intakeIncluded",

    // Phase IA-intake-access-fix — Intake Links is a CORE self-serve
    // surface for PRO/TEAM, not an advanced add-on. It must render in
    // the primary sidebar group instead of being demoted to "More /
    // Advanced". The disclosure resolver still relies on
    // `CANONICAL_PRIMARY_ROUTE_IDS` for the bounded primary set —
    // see canonicalNavigationGroups.ts:51.
    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
    denialGuidance:
      "Intake links are managed by workspace owners, admins, and members. Ask the owner of this workspace to add you as a member, or open Billing to start your own workspace.",
  },
  // Phase C — the /workflows surface administers EvidenceWorkflowTemplate
  // catalog entries (Phase B). It is NOT an operations surface; reviewer
  // workflow execution lives in /review (Reviewer Operations). The label
  // is relabeled to "Workflow Templates" so the sidebar / cmd-K / All
  // Tools all advertise this surface honestly. Capability gating is
  // strengthened to INTEGRATIONS_MANAGE — only workspace administrators
  // (the same role gate the page itself enforces) should see this entry.
  // The route folds into the System group via the Phase C update to
  // phaseBOperationalGroups.ts so it sits with the other Administration
  // surfaces rather than alongside daily operator workflow.
  {
    id: "workspace.workflows",
    href: "/workflows",
    label: "Workflow Templates",
    description:
      "Administer workflow templates used at capture time. Reviewer workflow execution lives in Reviewer Operations.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["INTEGRATIONS_MANAGE"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.security_center",
    href: "/security-center",
    // Phase IA-collapse — `/security-center` is the org/workspace
    // identity-and-security operator console. Personal account security
    // (password, my MFA enrollment, my sessions, my security events)
    // moved to /settings/security (route id `account.security`); the
    // surfaces here are MFA policy, trusted devices, session revocations,
    // MFA recovery approvals, SSO admin. Demoted from primary sidebar
    // (sidebarEligible=false); remains reachable via Settings →
    // "Identity & Security" link, command palette, and All Tools.
    label: "Identity & Security",
    description:
      "Workspace identity operations — MFA policy, trusted devices, session revocations, recovery approvals.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["SECURITY_CENTER_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    /*
     * CONTEXT AUTHORITY (2026-09-03) — the SSO/SCIM console joins the registry.
     *
     * It was reachable and correctly gated, but it was the one Settings
     * destination `resolveRouteAccess` could not answer for: with no entry
     * here, `routeLoads()` returned false for it, so the Settings rail carried
     * a bespoke `isEnterpriseWorkspace && SECURITY_CENTER_VIEW` pair written
     * out by hand. Two authorities decided who may see identity federation,
     * and only one of them was the canonical one.
     *
     * The entry states the same two conditions the bespoke pair did — the
     * capability here, the enterprise requirement via
     * ENTERPRISE_ONLY_ROUTE_IDS — so nothing about who reaches it changes.
     * What changes is that one resolver now answers for every Settings
     * destination.
     *
     * `sidebarEligible: false`: this is administered from Settings and from
     * the Security Center, not from the primary rail.
     */
    id: "security_center.sso",
    href: "/security-center/sso",
    label: "SCIM & SSO",
    description:
      "Single sign-on and directory provisioning for this organization — identity provider configuration, attribute mapping and connection health.",
    domain: "ORGANIZATION_WORKSPACE",
    requiredCapabilities: ["SECURITY_CENTER_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // Final Closure Remediation Part A — MfaRecoveryRequestApproval was
  // HARD_TO_FIND: backend service + UI page existed but no registry
  // entry, no command-palette entry, only a deep link from /settings/
  // security. Now a first-class route so cmd-K + All Tools both
  // surface it. `sidebarEligible: false` because /security-center is
  // already in the sidebar — the parent page now links to this
  // console with an explicit "Open MFA recovery console" button.
  {
    id: "security_center.mfa_recovery",
    href: "/security-center/mfa-recovery",
    label: "MFA recovery approvals",
    description:
      "Approve or reject member MFA recovery requests with full audit history.",
    domain: "ORGANIZATION_WORKSPACE",
    requiredCapabilities: ["SECURITY_CENTER_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "platform.runbooks",
    href: "/admin/platform/runbooks",
    label: "Runbooks",
    description: "Operator runbook catalog for incidents and recovery.",
    domain: "OPS",
    requiredCapabilities: ["RUNBOOKS_VIEW"],
    // PHASE 4 — Operations is a platform-admin area, not a workspace.
    // Non-platform-admins MUST not see this surface anywhere
    // (constitutional rule 9; see docs/architecture/phase-4-route-persona-matrix.md §3.8).
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "review.escalations",
    href: "/reviewer-ops/escalations",
    label: "Escalations",
    description: "Escalation lifecycle: acknowledge, reassign, resolve, suppress.",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["ESCALATIONS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "governance.policy",
    href: "/governance/policy",
    label: "Governance policy",
    description: "Preservation, SLA, and step-up enforcement policies.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["GOVERNANCE_ACT"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "governance.analytics",
    href: "/governance/analytics",
    label: "Governance insights",
    description: "Bounded compliance metrics: lifecycle, retention, drift, reconciliation runs.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["GOVERNANCE_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "governance.lifecycle",
    href: "/governance/lifecycle",
    label: "Governance Posture",
    description: "Read-only lifecycle posture overview.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["LIFECYCLE_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "governance.destruction",
    href: "/governance/destruction",
    label: "Destruction reviews",
    description: "Pending destruction reviews, dispositions, audit records.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["RETENTION_MANAGE"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "governance.notifications",
    href: "/governance/notifications",
    label: "Governance notifications",
    description: "Governance event subscriptions and notification routing.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["GOVERNANCE_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "platform.observability",
    href: "/admin/platform/observability",
    label: "Observability",
    description: "Runtime metrics + firing alerts.",
    domain: "OPS",
    requiredCapabilities: ["OBSERVABILITY_VIEW"],
    // PHASE 4 — Operations is a platform-admin area (rule 9).
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "review.queue_detail",
    // Phase 38.12 — canonical href is the queue-anchored entry
    // `/reviewer-ops/queue`. The runtime page lives at
    // `app/(app)/reviewer-ops/[reviewId]/page.tsx` (dynamic param);
    // the canonical href in the registry stays queue-anchored so the
    // route surfaces as "reached from the queue" rather than as a
    // dynamic-id template URL that operators can't actually type.
    href: "/reviewer-ops/queue",
    label: "Review workspace",
    description: "Per-review workspace: lifecycle, SLA, escalation, action surface.",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["REVIEWER_OPS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",

    advancedByDefault: true,
    // Detail page reached from the queue — not listed independently in
    // discoverability surfaces.
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  {
    id: "workspace.communications",
    href: "/communications",
    // Phase IA-collapse — `/communications` is an operator-facing
    // delivery state console (SMS / WhatsApp / OTP / Twilio Verify
    // provider health, message status, retry / cancel). It is NOT a
    // user-workflow surface — sending happens from intake-links /
    // evidence-requests. Renamed "Messaging operations" and demoted
    // out of the primary workspace sidebar (sidebarEligible=false);
    // remains reachable via All Tools, the command palette, and from
    // contextual links on evidence-request / intake-link detail.
    label: "Messaging operations",
    description:
      "SMS, WhatsApp, OTP delivery state, retry/cancel, and provider health.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "workspace.intelligence",
    href: "/intelligence",
    label: "Intelligence",
    description: "Reviewer-and-above intelligence operations console.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "investigation.timeline",
    href: "/investigation/timeline",
    label: "Investigation timeline",
    description: "Reconstructed timeline view across signals and evidence.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "investigation.relationships",
    href: "/investigation/relationships",
    label: "Investigation relationships",
    description: "Evidence relationship inspector and cross-case mapping.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "platform.reliability",
    href: "/admin/platform/reliability",
    label: "Reliability operations",
    description: "Upload pipeline, session-state recovery, queue policy summaries.",
    domain: "OPS",
    requiredCapabilities: ["OPS_CENTER_VIEW"],
    // PHASE 4 — Operations is a platform-admin area (rule 9).
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    // Final Closure Remediation Part E — flipped from false to true so
    // SREs see Reliability ops in the sidebar's Operations group
    // without prior knowledge.
    sidebarEligible: true,
  },
  // Phase Final-Closure-Verification — `/admin/platform/queues` was the
  // canonical BullMQ queue-triage surface but lived only at typed URL;
  // not in sidebar, not in cmd-K, not in "all tools". Operators
  // discovered it through tribal knowledge. Now `commandPaletteVisible:
  // true` so SREs can jump to it from anywhere.
  {
    id: "platform.queue_ops",
    href: "/admin/platform/queues",
    label: "Queue operations",
    description:
      "BullMQ queue triage — failed jobs, replay safety, DLQ, stuck OTS.",
    domain: "OPS",
    requiredCapabilities: ["OPS_CENTER_VIEW"],
    // PHASE 4 — Operations is a platform-admin area (rule 9).
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    // Final Closure Remediation Part E — flipped from false to true so
    // Queue Operations sits in the canonical Operations sidebar group.
    sidebarEligible: true,
  },
  {
    id: "platform.media_graph",
    href: "/admin/platform/media-graph",
    label: "Media intelligence ops",
    description: "Media intelligence + investigation graph operational metrics.",
    domain: "OPS",
    requiredCapabilities: ["OBSERVABILITY_VIEW"],
    // PHASE 4 — Operations is a platform-admin area (rule 9).
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // PHASE 6 — Team Collaboration Platform. The canonical Team UI
  // surface. Available to BOTH personal and organization workspaces
  // (constitutional rule 4-7: Team is core collaboration, Organization
  // is optional). UI label is "Teams"; URL path uses
  // `/collaboration-teams` to avoid colliding with the legacy
  // /teams/[id] workspace-admin page.
  //
  // No capability gate: any workspace member can SEE the Teams page;
  // creation is permitted whenever the user has an active workspace.
  // Per-team management permissions are enforced at the backend
  // service layer (LEAD/ADMIN/MEMBER/VIEWER/EXTERNAL).
  {
    id: "workspace.collaboration_teams",
    href: "/collaboration-teams",
    label: "Teams",
    description:
      "Collaboration teams — coordinate people, assignments, and evidence work.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: [],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.collaboration_team_detail",
    href: "/collaboration-teams/[teamId]",
    label: "Team detail",
    description: "Team detail surface — members, invites, assignments, activity, settings.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: [],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: true,
    // Detail page reached from /collaboration-teams; not listed
    // independently in discovery surfaces.
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  {
    id: "workspace.collaboration_team_hub",
    href: "/collaboration-teams/[teamId]/collaboration",
    label: "Team collaboration hub",
    description:
      "Comments, mentions, notifications, preferences, guests, access review.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: [],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: true,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  {
    id: "workspace.collaboration_team_invite_accept",
    href: "/collaboration-teams/invites/[token]/accept",
    label: "Accept team invite",
    description: "Accept a Team invitation via secure token.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  // Phase Final-A3-PT2 — `/dashboard/api-keys` retired. The canonical
  // surface is `/integrations` (team-scoped, durable, audit-backed).
  // The old route now redirects via `next.config.js`. Registry entry
  // removed so cmd-K + "all tools" no longer surface it.
  {
    id: "dashboard.quotas",
    // Phase R7.5 — canonical URL is /operations/quotas (the live page moved
    // here from /dashboard/quotas, removing the re-export inversion). The
    // legacy /dashboard/quotas URL now 308-redirects (next.config.js). Gate
    // stays PERSONAL_WORKSPACE/DASHBOARD_VIEW: this is a self-service quota
    // view, NOT a platform-admin tool.
    href: "/operations/quotas",
    label: "Quotas & usage",
    description: "Account quotas, usage breakdown, and reset windows.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["DASHBOARD_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: true,
    // Phase R7.5 — canonical location RESOLVED: the live quota console now
    // lives at app/(app)/operations/quotas/page.tsx (moved from /dashboard/
    // quotas; the /dashboard URL 308-redirects). Kept out of all nav
    // surfaces (self-service, reached contextually); PROFESSIONAL-tier so
    // FREE users never see it regardless. Do not flip visibility until the
    // canonical URL is chosen, to avoid churn.
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  // Phase 6 cleanup — `dashboard.insights` retired.
  //
  // The /dashboard/insights page was hidden from every nav surface and
  // permanently redirected to /home via next.config.js. The page file
  // called a backend route that never existed. The entry has been
  // removed from this registry; the next.config redirect remains so any
  // external link continues to land on /home. See the
  // phase-ia-route-authz-hardening test for the contract pin.
  {
    id: "dashboard.batch_analysis",
    // Phase R7.5 — canonical URL is /operations/batch-analysis (live page
    // moved here from /dashboard/batch-analysis; inversion removed; legacy
    // URL 308-redirects). Gate stays PERSONAL_WORKSPACE — self-service view.
    href: "/operations/batch-analysis",
    label: "Batch analysis",
    description: "Batch processing jobs and queue status.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["DASHBOARD_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: true,
    // Phase R7.5 — canonical location RESOLVED: the live batch console now
    // lives at app/(app)/operations/batch-analysis/page.tsx (moved from
    // /dashboard/batch-analysis; the /dashboard URL 308-redirects). Kept out
    // of nav (self-service); PROFESSIONAL-tier so FREE users never see it.
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  {
    id: "investigation.graph",
    href: "/investigation/graph",
    label: "Investigation graph",
    description: "Graph explorer for evidence relationships.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "investigation.duplicates",
    href: "/investigation/duplicates",
    label: "Duplicate review",
    description: "Detect and review duplicate evidence across the workspace.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "investigation.reviewers",
    href: "/investigation/reviewers",
    label: "Reviewer intelligence",
    description: "Reviewer intelligence console — analyst workload + signal context.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: true,
    // -------------------------------------------------------------------------
    // Investigation-suite audit (persona-fit decision):
    // The reviewer-intelligence console surfaces review-workflow queues,
    // escalations, and external-reviewer grants — content that is only
    // meaningful for actors who actually perform or coordinate review work.
    // Personal / solo personas (FREE / PAYG) and most PRO single-operator
    // users have no reviewer queue to inspect; surfacing this in the
    // primary sidebar yields an empty surface that reads as broken.
    //
    // Decision: keep this route reachable from the command palette and
    // the All Tools index (so review-capable actors can always navigate
    // to it), but remove it from the always-on sidebar surface. Personas
    // that actually perform review work reach it via the review pillar.
    // requiredCapabilities, requiredActiveSpace, and fallbackBehavior are
    // intentionally unchanged — backend gating is the authority.
    // -------------------------------------------------------------------------
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "investigation.hub",
    href: "/investigation",
    label: "Investigation overview",
    description: "Signals, recent graph activity, queue health.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },

  // ---------------------------------------------------------------------------
  // ORGANIZATION-only operator surfaces.
  // ---------------------------------------------------------------------------
  // Phase Final-Vocab-Alignment — `/review` is the single canonical
  // reviewer console (Queue · Mine · Escalations · SLA · Workload).
  // The legacy `/reviewer-ops` index has been retired:
  //   * the page file was deleted
  //   * `next.config.js` redirects `/reviewer-ops` → `/review`
  //   * the legacy registry entry below was removed so cmd-K + "all
  //     tools" no longer surface a competing reviewer entry-point
  // The per-workflow mutation inspector `/reviewer-ops/[reviewId]` is
  // a DIFFERENT surface and remains. The SLA / escalations sub-routes
  // also remain at their canonical `/reviewer-ops/*` paths and are
  // registered separately below.
  {
    id: "workspace.review",
    href: "/review",
    label: "Review",
    description: "Canonical reviewer console — queue, escalations, SLA, workload.",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["REVIEWER_OPS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  // Phase Final-Vocab-Alignment — `review.queue` retained as an id
  // because the sidebar (AppSidebarV2), hub landing routes
  // (hubDefinitions.ts), persona priority lists, the disclosure model,
  // and the permission matrix all reference it. Its `href` now points
  // at the canonical `/review` console (the old `/reviewer-ops` index
  // was deleted and redirects to `/review` via next.config.js). To
  // avoid two competing sidebar entries with the same href, this
  // entry is `commandPaletteVisible: false` + `sidebarEligible: false`
  // — it is a pure id-binding kept for backward compatibility with
  // the persona/hub machinery.
  {
    id: "review.queue",
    href: "/review",
    label: "Reviewer queue",
    description: "Reviewer queue (canonical surface; legacy /reviewer-ops index redirects here).",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["REVIEWER_OPS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",

    advancedByDefault: false,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  // Phase B — Phase 13 per-evidence review operations queue.
  {
    id: "review.operations",
    href: "/review/operations",
    label: "Review operations",
    description: "Per-evidence review stage queue (Phase 13).",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["REVIEWER_OPS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // Phase B — Phase C3 intake inspector.
  {
    id: "workspace.evidence_requests",
    href: "/evidence-requests",
    label: "Evidence requests",
    description: "Phase C3 intake-request inspector — checklist fulfillment, response review, re-request.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["INTAKE_LINKS_MANAGE"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    // PHASE 4 — root list page does not exist (only the [id] detail page
    // ships). Constitutional rule 11: no visible route may lead to Page
    // Not Found. Detail page remains reachable from MatterWorkspace.
    // Re-enable in Phase 5 when the root list page ships.
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  {
    id: "review.sla",
    href: "/reviewer-ops/sla",
    label: "SLA tracking",
    description: "SLA windows + breach signals.",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["SLA_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "governance.hub",
    href: "/governance",
    label: "Governance",
    description: "Legal holds, retention, audit posture, policy workflows.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["GOVERNANCE_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "governance.retention",
    href: "/governance/retention",
    label: "Retention",
    description: "Retention windows and destruction reviews.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["RETENTION_MANAGE"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.operations",
    href: "/operations",
    label: "Operations",
    description: "Unresolved work this workspace has to act on.",
    domain: "OPS",
    // ========================================================================
    // ATTENTION ARCHITECTURE PHASE 4B (2026-08-22) — TENANT OPERATIONS UNLOCK.
    //
    // WHAT THIS ROUTE USED TO BE
    // --------------------------
    //   id:                  platform.ops_center
    //   requiredCapabilities: OPS_CENTER_VIEW      (a PLATFORM-tier key)
    //   requiredActiveSpace:  PLATFORM_ADMIN
    //
    // So the one surface that answers "what unresolved work does MY workspace
    // have?" was reachable only by PROOVRA staff. A tenant admin with a failed
    // report and an unanchored record had nowhere to see either as shared
    // work; the only thing that showed them was their own personal feed, which
    // is exactly the conflation this program removes.
    //
    // WHAT IT IS NOW
    // --------------
    // A TENANT surface, gated on a valid active workspace plus OPERATIONS_VIEW
    // — the capability the server derives from whether a workspace can
    // actually PRODUCE operational conditions (its package includes a
    // condition-producing feature, or more than one operator shares it),
    // never from a plan name.
    //
    // PROOVRA's own internal consoles did NOT move here. They live under
    // `/admin/platform/*` with PLATFORM_ADMIN, and the Phase-4A isolation gate
    // proves a tenant holding OPERATIONS_VIEW still cannot reach them.
    // ========================================================================
    requiredCapabilities: ["OPERATIONS_VIEW"],
    // A valid ACTIVE workspace of either kind. Operations is about the
    // workspace you are in, so there is nothing to show without one.
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  // Phase E3 — Operational Automation Foundation. Lives UNDER the
  // Operations Center hub (`/admin/platform/automation`), NOT as a root nav item.
  // No new root entries are introduced — the 32.8 canonical primaries
  // remain bounded at 6.
  {
    id: "platform.automation",
    href: "/admin/platform/automation",
    label: "Automation rules",
    description:
      "Bounded operational automation: trigger + action rules with audit history.",
    domain: "OPS",
    requiredCapabilities: ["AUTOMATION_VIEW"],
    // PHASE 4 — Operations is a platform-admin area (rule 9).
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // Phase E4 — Bounded operational analytics. Lives UNDER the Operations
  // Center hub (`/admin/platform/analytics`), NOT as a root nav item. The 32.8
  // canonical primaries remain bounded at 6. Read-only surface; every
  // metric is source-traceable to a real Prisma model, never fabricated.
  {
    id: "platform.analytics",
    href: "/admin/platform/analytics",
    label: "Operational analytics",
    description:
      "Bounded operational analytics: real counts from real tables. No fake metrics, no AI predictions, no legal/admissibility scores.",
    domain: "OPS",
    requiredCapabilities: ["ANALYTICS_VIEW"],
    // PHASE 4 — Operations is a platform-admin area (rule 9).
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // Phase G0 (B0.5) — canonical frontend route is now `/workspaces`.
  // Phase 2B — the parallel self-serve `/teams` landing page was
  // DELETED (it duplicated the canonical Teams product at
  // `/collaboration-teams`). The bare `/teams` URL now 308s to
  // `/collaboration-teams` (next.config.js); `/teams/[id]` (legacy
  // team detail on `/v1/teams`) still renders and is deferred to the
  // backend migration phase. Backend `/v1/teams/*` endpoints are
  // unchanged. The route id remains `admin.teams` because tests +
  // capability mappings key off the literal — the canonical href is
  // `/workspaces`.
  //
  // Phase 9 audit note: route id is historical; canonical href is /workspaces;
  // this is workspace-admin tenancy, NOT the constitutional Team product
  // (see id=workspace.collaboration_teams).
  {
    id: "admin.teams",
    href: "/workspaces",
    label: "Workspaces",
    description:
      "Personal Workspace + organization-governed Workspaces management.",
    domain: "ACCOUNT",
    requiredCapabilities: ["TEAM_VIEW"],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },

  // ---------------------------------------------------------------------------
  // Platform-admin only.
  // ---------------------------------------------------------------------------
  {
    id: "platform.admin",
    href: "/admin",
    label: "Platform admin",
    description: "Platform-level administration (PLATFORM_ADMIN only).",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },

  // Enterprise provisioning — platform-admin only. Mirrors platform.admin
  // gating exactly (PLATFORM_ADMIN capability + PLATFORM_ADMIN active
  // space). The page (/admin/provisioning) additionally inherits the
  // `platform.admin` gate from admin/layout.tsx; this entry exists so the
  // route is a first-class registry citizen (PageRouteGate can resolve it,
  // route-consistency test can pin its page, nav surfaces stay honest).
  {
    id: "platform.provisioning",
    href: "/admin/provisioning",
    label: "Provision enterprise customer",
    description:
      "Activate an enterprise customer end-to-end (PLATFORM_ADMIN only): create the enterprise workspace + owner, or grant ENTERPRISE to an existing org. Step-up gated.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    // Surfaced so a Platform Admin can reach provisioning from the command
    // palette / All Tools (and the /admin console nav) — never a direct-URL
    // guess. Non-admins never see it (HIDDEN_IF_NO_CAPABILITY + PLATFORM_ADMIN).
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // PHASE 12B C10 — Support Access + Break-Glass. Restricted INTERNAL STAFF
  // capabilities, so this is a first-class registry citizen under the same
  // PLATFORM_ADMIN contract as the rest of /admin/* (the page additionally
  // inherits the `platform.admin` gate from admin/layout.tsx). Surfaced in the
  // command palette / All Tools so an on-call responder reaches it by name
  // rather than by guessing a URL; HIDDEN_IF_NO_CAPABILITY means a customer
  // admin never sees that it exists, and the API returns a flat 404 to them.
  {
    id: "platform.support_access",
    href: "/admin/support-access",
    label: "Support access & break-glass",
    description:
      "Support-access and break-glass grant lifecycle (PLATFORM_ADMIN only): enter session-bound support context, revoke support grants, cut emergency access. Dual-identity audited.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    // ADM-033 — renamed from platform.organizations. The population is
    // Organization.kind = 'CUSTOMER'; the SYSTEM bootstrap container every
    // workspace owns is NOT a customer and is excluded.
    id: "platform.customers",
    href: "/admin/customers",
    label: "Customers",
    description:
      "Platform roster of every CUSTOMER organization (PLATFORM_ADMIN only): enterprise contract, workspace plan projection, seats, owner, domains, SSO/SCIM health, billing posture. Read-only aggregation.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "platform.customer_detail",
    href: "/admin/customers/:id",
    label: "Customer detail",
    description:
      "Deep-dive on a single customer organization (PLATFORM_ADMIN only): identity health, provisioning history, evidence/billing posture. Read-only.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    // Dynamic detail route — reached from the roster, not the palette/All Tools.
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  // ADM-027 — THE workspace directory. The platform's central commercial and
  // tenancy object had no admin surface at all before this route.
  {
    id: "platform.workspaces",
    href: "/admin/workspaces",
    label: "Workspaces",
    description:
      "Platform roster of every workspace (PLATFORM_ADMIN only): kind, lifecycle, customer, owner, seats, evidence and open incidents. Read-only aggregation.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "platform.workspace_detail",
    href: "/admin/workspaces/:id",
    label: "Workspace detail",
    description:
      "Deep-dive on one workspace (PLATFORM_ADMIN only): canonical commercial context, seats, storage, subscriptions, incidents. Read-only. No evidence content.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  {
    id: "platform.person_detail",
    href: "/admin/users/:id",
    label: "Person detail",
    description:
      "Deep-dive on one person (PLATFORM_ADMIN only): canonical commercial context, subscriptions, workspaces, payments, lifecycle requests. Read-only. No secrets.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  // ADM-011 / ADM-034 — platform operations, separated from the workspace
  // security page it used to share.
  {
    id: "platform.operations",
    href: "/admin/operations",
    label: "Platform operations",
    description:
      "Every operational condition on the platform (PLATFORM_ADMIN only), with the workspace and customer it affects, plus acknowledge/resolve through the canonical incident lifecycle.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // ADM-029 / ADM-019 — the evidence-health drill-down.
  {
    id: "platform.evidence_records",
    href: "/admin/evidence-ops/records",
    label: "Affected evidence records",
    description:
      "The evidence records behind one health signal (PLATFORM_ADMIN only), with workspace and customer attribution. Operational metadata only — never evidence content.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  {
    id: "platform.users",
    href: "/admin/users",
    label: "People",
    description:
      "Platform roster of every person (PLATFORM_ADMIN only): account tier, provider subscription, pending cancellation, personal workspace, memberships, MFA, last login. Read-only aggregation. No secrets.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "platform.evidence_ops",
    href: "/admin/evidence-ops",
    label: "Evidence operations",
    description:
      "Platform evidence pipeline health (PLATFORM_ADMIN only): upload/processing status, signing/TSA/OTS failures, queue backlog, operational incidents. Read-only aggregation. No evidence content.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "platform.security",
    href: "/admin/security",
    label: "Security & incidents",
    description:
      "Platform security posture (PLATFORM_ADMIN only): security events, admin audit trail, operational incidents. Read-only aggregation. No raw IPs/tokens.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "platform.billing",
    href: "/admin/billing",
    label: "Billing & revenue",
    description:
      "Platform billing posture (PLATFORM_ADMIN only): subscriptions by plan, payment/webhook status, storage add-on MRR, gross revenue. Read-only aggregation. No card/Stripe secrets.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // Platform Admin Control Center — final-completion read-only surfaces.
  {
    id: "platform.platform_health",
    href: "/admin/platform-health",
    label: "Platform health",
    description:
      "Platform service & infrastructure health (PLATFORM_ADMIN only): DB/Redis/workers/queues/storage/KMS/SSO/providers status + a live Now panel. Read-only, connects existing health probes. Honest unknown where no live probe exists.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "platform.costs",
    href: "/admin/costs",
    label: "Cost dashboard",
    description:
      "Platform provider-cost posture (PLATFORM_ADMIN only): estimated spend per provider/operation, budgets, embeddings spend. Read-only. Honest not-connected for unmetered categories. No secrets.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "platform.adoption",
    href: "/admin/adoption",
    label: "Feature adoption",
    description:
      "Platform feature usage & adoption (PLATFORM_ADMIN only): per-capability enabled/used/never-used derived from real entity counts. Read-only. No fabricated adoption score.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "platform.search",
    href: "/admin/search",
    label: "Platform search",
    description:
      "Cross-entity platform search (PLATFORM_ADMIN only): organizations, users, workspaces, leads, evidence/report IDs. Metadata only — no secrets, no evidence content.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "platform.timeline",
    href: "/admin/timeline",
    label: "Platform timeline",
    description:
      "Platform-wide event timeline (PLATFORM_ADMIN only): admin audit, org audit, security events, incidents, selected billing/team events. Read-only. Separate from evidence custody timelines.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "platform.alerts",
    href: "/admin/alerts",
    label: "Alerts center",
    description:
      "Platform alerts center (PLATFORM_ADMIN only): open incidents, high security events, failed jobs, degraded services, billing/identity failures. Read-only point-in-time snapshot.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "platform.executive",
    href: "/admin/executive",
    label: "Executive summary",
    description:
      "Platform executive KPIs (PLATFORM_ADMIN only): revenue, customers, leads, evidence/report/package volume, top & at-risk customers. Read-only. Growth/MRR/ARR honestly not-measured.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // P0-6 — previously-unregistered admin console pages. They shipped
  // reachable via the /admin console nav but were absent from the registry
  // (so invisible to the command palette / All Tools). Register them under
  // the platform-admin shape so every admin page is discoverable.
  {
    id: "platform.dashboard",
    href: "/admin/dashboard",
    label: "Platform analytics",
    description:
      "Platform-wide product analytics (PLATFORM_ADMIN only): traffic, events, geography — honest not-connected/not-measured states where a signal is absent.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "platform.demo_requests",
    href: "/admin/demo-requests",
    label: "Demo requests",
    description:
      "Inbound enterprise demo / contact-sales requests (PLATFORM_ADMIN only).",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "platform.audit",
    href: "/admin/audit",
    label: "Audit integrity",
    description:
      "Platform audit-log integrity console (PLATFORM_ADMIN only): tamper-evident chain verification over the admin/audit trail.",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "platform.contact_sales",
    href: "/admin/contact-sales",
    label: "Contact sales",
    description:
      "Operator view of a contact-sales / enterprise-interest submission (PLATFORM_ADMIN only).",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    // Reached from Demo Requests / the sales flow — not a palette entry.
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },

  // ---------------------------------------------------------------------------
  // The All Tools surface itself.
  // ---------------------------------------------------------------------------
  {
    id: "workspace.tools",
    href: "/tools",
    label: "All Tools",
    description: "Searchable index of every product surface.",
    domain: "ACCOUNT",
    requiredCapabilities: ["ACCOUNT_SETTINGS_VIEW"],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: false, // self-reference; doesn't list itself
    sidebarEligible: false,
  },

  // ---------------------------------------------------------------------------
  // Trust documentation gate (2026-07-15). The former authenticated static
  // Trust Hub (`/trust-hub`, id `workspace.trust`) was removed as redundant —
  // the public Trust Center (`/trust`) is the canonical customer-facing trust
  // portal, and trust-related operational controls live in their canonical
  // Operations/Governance/Evidence homes. This entry is NOT a navigation item
  // (no sidebar / cmd-K / All Tools presence); it exists only to gate the
  // in-app `/trust-center/*` documentation article pages (security,
  // methodology, subprocessors, status, AI disclosure). The `/trust-center`
  // index itself redirects to the public `/trust`.
  // ---------------------------------------------------------------------------
  {
    id: "workspace.trust_center",
    href: "/trust-center",
    label: "Trust & Compliance",
    description:
      "In-app trust documentation articles (security, methodology, subprocessors, status, AI disclosure). The canonical trust portal is the public Trust Center at /trust.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: [],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "LOAD",

    advancedByDefault: false,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },

  // ---------------------------------------------------------------------------
  // Phase 2A — Reviewer Workspace surfaces. Canonical ids for the new
  // Phase 2A pages. Each entry points at the REAL page on disk; nothing
  // here invents an empty route. Pillar mapping lives in pillarRegistry.
  // ---------------------------------------------------------------------------
  {
    id: "workspace.review_workspace",
    href: "/review/workspace",
    label: "Reviewer workspace",
    description:
      "Reviewer operational surface — coding panel, hotkeys, evidence + coding side-by-side.",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["REVIEWER_OPS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.coding_schemas",
    href: "/review/schemas",
    label: "Coding schemas",
    description: "Coding schema admin — fields, versioning, workflow binding.",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["REVIEWER_OPS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "workspace.review_qc",
    href: "/review/qc",
    label: "Reviewer QC",
    description: "QC sample queue + verdict capture + accuracy metrics.",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["REVIEWER_OPS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "workspace.review_disagreements",
    href: "/review/disagreements",
    label: "Reviewer disagreements",
    description: "Challenge → second review → supervisor → resolution queue.",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["REVIEWER_OPS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "workspace.review_metrics",
    href: "/review/metrics",
    label: "Reviewer metrics",
    description:
      "Reviewer throughput, approval/escalation rates, QC accuracy, rework.",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["REVIEWER_OPS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },

  // ---------------------------------------------------------------------------
  // Phase 2A Closure — bulk operations queue. Points at the canonical
  // /review/queues page (operator queues + bulk action bar).
  // ---------------------------------------------------------------------------
  {
    id: "workspace.review_queues",
    href: "/review/queues",
    label: "Reviewer queues",
    description: "Multi-select reviewer queues + bulk action bar.",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["REVIEWER_OPS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },

  // ---------------------------------------------------------------------------
  // Phase 2B — External Reviewer Portal internal admin surface. The portal
  // itself lives at /portal (token-gated); this id binds the internal
  // invitation/management page at /review/external.
  // ---------------------------------------------------------------------------
  {
    id: "workspace.review_external",
    href: "/review/external",
    label: "External reviewer management",
    description:
      "Issue, resend, revoke external reviewer invitations + monitor portal sessions.",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["REVIEWER_OPS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },

  // ---------------------------------------------------------------------------
  // Stage 3 — Backfill registry entries for pages that called PageRouteGate
  // with routeIds the registry didn't yet know about. Without these the
  // PageRouteGate "unknown id → render children" fall-through left these
  // surfaces completely unprotected. Each entry below points at the REAL
  // page on disk; nothing here invents an empty route.
  // ---------------------------------------------------------------------------
  {
    id: "admin.identity",
    // Phase IA-collapse — admin identity hub moved from /settings/security
    // (which is now the personal Account Security home — route id
    // `account.security`) to /admin/identity, where the procurement-grade
    // SAML / SCIM / Audit + Sessions / Runtime / Access reviews / Permission
    // matrix / MFA admin entry points already live. The legacy URL
    // /settings/security/{saml,scim,audit} sub-paths continue to redirect
    // to their canonical homes via next.config.js — deep links are
    // preserved.
    href: "/admin/identity",
    label: "Identity operations",
    description:
      "Enterprise identity operations hub — SAML, SCIM, identity audit, active sessions.",
    // P0-5 — this lives under /admin/* which is platform-admin-gated by
    // admin/layout.tsx (routeId platform.admin). It is a PROOVRA Platform
    // Admin surface, NOT a customer org-workspace surface, so it must be
    // PLATFORM_ADMIN-scoped (was mis-tagged ORGANIZATION_ONLY, which made it
    // nav-visible to org users who then hit the platform-admin layout gate).
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // Phase IA-collapse — Account Security is the personal-security home
  // under Settings. Renders the user-scoped surfaces: password change,
  // active sessions, "sign out other sessions", and the bounded
  // security-events feed (the surfaces previously embedded at the top
  // of /security-center via `PersonalSecuritySections`). ACCOUNT-tier
  // domain + NONE active space so it loads for every authenticated user
  // (the contained surfaces are user-scoped, not workspace-scoped).
  {
    id: "account.security",
    href: "/settings#security",
    label: "Account security",
    description:
      "Personal account security — password, sessions, security events.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // PROOVRA Enterprise AI Program — workspace AI governance (owner/admin
  // policy toggles + capability disclosure). Works for personal AND
  // organization workspaces: the AI policy row is per-team, and the API
  // enforces owner/admin on write — the page is a management surface, not
  // the enforcement point.
  {
    id: "workspace.ai_settings",
    href: "/settings#ai",
    label: "AI & Automation",
    description:
      "Workspace AI governance — enable/disable AI capabilities, data-class limits, and truthful capability disclosure.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "LOAD",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // PROOVRA Enterprise AI Program — human-authored Reviewer Criteria
  // Catalog (versioned, immutable after publish). Members read; the API
  // enforces owner/admin on authoring/publishing.
  {
    id: "workspace.reviewer_criteria",
    href: "/settings/reviewer-criteria",
    label: "Reviewer Criteria",
    description:
      "Human-authored, versioned reviewer criteria sets — draft, publish (immutable), duplicate, retire.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "LOAD",

    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "workspace.intelligence_quality",
    href: "/intelligence-quality",
    label: "Intelligence Quality",
    description:
      "Provider, reviewer, and team correction analytics. Aggregate-only, never raw extraction.",
    domain: "ORGANIZATION_WORKSPACE",
    requiredCapabilities: ["GOVERNANCE_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "workspace.audit_transparency",
    href: "/audit-transparency",
    label: "Audit & Transparency Center",
    description:
      "Federated audit timeline across provider usage, corrections, redaction, policy, video, portal. Bounded counts only — never PII.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["GOVERNANCE_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "workspace.budget_center",
    href: "/budget-center",
    label: "Budget Center",
    description:
      "Per-scope spend, remaining budget, projected burn, breach timeline. Bounded ids only.",
    domain: "ORGANIZATION_WORKSPACE",
    requiredCapabilities: ["GOVERNANCE_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "workspace.evidence_lifecycle",
    href: "/evidence-lifecycle",
    label: "Lifecycle Operations",
    description: "Configure & execute lifecycle actions.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["LIFECYCLE_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "workspace.exchange",
    href: "/exchange",
    label: "Exchange",
    description:
      "Evidence exchange packages — share, export, legal production, internal transfer.",
    domain: "ORGANIZATION_WORKSPACE",
    requiredCapabilities: ["EXPORT_GOVERNANCE_MANAGE"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "workspace.executive",
    href: "/executive",
    label: "Executive Dashboard",
    description:
      "Cross-domain enterprise metrics with historical trend. Aggregate-only, never PII.",
    domain: "ORGANIZATION_WORKSPACE",
    requiredCapabilities: ["GOVERNANCE_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    // -------------------------------------------------------------------------
    // workspace-surface audit — persona rationale:
    // Executive Dashboard is the C-suite consumption surface for org-tier
    // metrics, but it was previously cmd-K-only, so leadership personas
    // (ORG + GOVERNANCE_VIEW) could not discover it without prior URL
    // knowledge. Flipping sidebarEligible to true so the dashboard appears
    // in the Governance pillar for actors who actually have the capability.
    // Backend gating (GOVERNANCE_VIEW + ORGANIZATION_ONLY) is unchanged —
    // PERSONAL workspaces and non-governance actors still cannot see it.
    // -------------------------------------------------------------------------
    sidebarEligible: true,
  },
  {
    id: "workspace.governance_platform",
    href: "/governance-platform",
    label: "Governance Platform",
    description:
      "Enterprise org-level governance — orgs, departments, delegated admin, policies, access reviews, cross-org.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["GOVERNANCE_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "workspace.packaging",
    href: "/packaging",
    label: "Packaging",
    description:
      "Plan entitlements per product line — Capture & Verify, Investigations, Enterprise.",
    domain: "ORGANIZATION_WORKSPACE",
    requiredCapabilities: ["EXPORT_GOVERNANCE_MANAGE"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "workspace.review_redaction",
    href: "/redaction",
    label: "Redaction Projects",
    description:
      "Workspace redaction projects list + per-workspace summary. Bounded review-pillar entry point.",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["REVIEWER_OPS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },

  // ---------------------------------------------------------------------------
  // Phase 8 — Organization Admin shell. The /organizations/:id/admin surface
  // is a tabbed shell (overview / members / departments / governance /
  // access-reviews / retention / audit / security / trust) that aggregates
  // org-tier administration into a single canonical entry point. The shell
  // index + 9 tab pages each wrap in <PageRouteGate routeId="account.
  // organization-detail"> today; the registry entries below give every tab
  // first-class cmd-K + All Tools discoverability without putting them in
  // the sidebar (sidebarEligible: false — org detail is the canonical
  // sidebar entry, the admin shell is reached from that page's CTA).
  //
  // domain: ACCOUNT + requiredActiveSpace: NONE means personal-only users
  // never see these in cmd-K (the routes resolve via org membership at
  // /organizations/:id which already 404s for non-members). advancedByDefault:
  // true keeps them out of any persona's top-N tagged surfacing.
  //
  // No new capabilities — the underlying org endpoints enforce per-tab
  // role checks (ORG_OWNER / ORG_ADMIN required for mutating tabs).
  // ---------------------------------------------------------------------------
  {
    id: "account.organization_admin",
    href: "/organizations/:id/admin",
    label: "Organization admin",
    description:
      "Org admin shell — members, departments, governance, access reviews, retention, audit, security, trust.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "account.organization_admin_overview",
    href: "/organizations/:id/admin/overview",
    label: "Organization admin — Overview",
    description:
      "Read-only posture summary across members, workspaces, audit, retention, and governance.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "account.organization_admin_members",
    href: "/organizations/:id/admin/members",
    label: "Organization admin — Members",
    description: "Manage organization members, roles, and pending invitations.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "account.organization_admin_departments",
    href: "/organizations/:id/admin/departments",
    label: "Organization admin — Departments",
    description: "Departments and scoped membership inside the organization.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "account.organization_admin_governance",
    href: "/organizations/:id/admin/governance",
    label: "Organization admin — Governance",
    description:
      "Deep-links to org-tier governance surfaces (policies, posture, lifecycle).",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // Phase 5 (Enterprise Governance) — read-only external-reviewer grant
  // governance view. A sub-view under the Governance tab that reuses the
  // existing `/v1/external-review/grants` + `/activity` reads to show the
  // lifecycle detail behind the control center's active-grant count. Same
  // ACCOUNT + NONE active-space contract as its sibling org-admin tabs.
  {
    id: "account.organization_admin_governance_external_reviewers",
    href: "/organizations/:id/admin/governance/external-reviewers",
    label: "Organization admin — External reviewer grants",
    description:
      "Read-only governance view of external-reviewer grants: state, issuer, scope, expiration, watermark/download policy, and access audit.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "account.organization_admin_access_reviews",
    href: "/organizations/:id/admin/access-reviews",
    label: "Organization admin — Access reviews",
    description:
      "Access review campaigns and per-item decisions across the organization.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "account.organization_admin_retention",
    href: "/organizations/:id/admin/retention",
    label: "Organization admin — Retention",
    description: "Organization-level retention posture and destruction reviews.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "account.organization_admin_audit",
    href: "/organizations/:id/admin/audit",
    label: "Organization admin — Audit",
    description:
      "Organization audit timeline — invitations, role changes, governance events.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    // Phase 8 — Enterprise Production Readiness: safe high-volume onboarding.
    id: "account.organization_admin_bulk_invite",
    href: "/organizations/:id/admin/bulk-invite",
    label: "Organization admin — Bulk invite",
    description:
      "Invite many members at once (paste or CSV) with validation, dry-run preview, and partial-success handling.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    // Phase 8 — Enterprise operational report CSV exports (real data only).
    id: "account.organization_admin_reports",
    href: "/organizations/:id/admin/reports",
    label: "Organization admin — Reports",
    description:
      "Operational report exports — members, seats, audit, governance, external access.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    // Phase 8 — Org-scoped operational readiness / health (no platform secrets).
    id: "account.organization_admin_readiness",
    href: "/organizations/:id/admin/readiness",
    label: "Organization admin — Readiness",
    description:
      "Organization operational readiness — status, SSO/integration health, evidence-operations signals.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    // Phase 8 — Platform production-readiness posture (backup/DR, keys,
    // resiliency, runbooks). Platform-admin only; read-only; no secrets.
    id: "operations.readiness",
    href: "/admin/platform/readiness",
    label: "Production readiness",
    description:
      "Backup/DR, key management, resiliency posture and runbooks (verified config only).",
    domain: "OPS",
    requiredCapabilities: ["OBSERVABILITY_VIEW"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    // Phase R2 — dedicated PLATFORM_ADMIN gate for the signer-operations
    // surface. Previously `/admin/platform/signers` used the WRONG routeId
    // (`workspace.security_center` → OPS-tier PERSONAL_OR_ORG), which let
    // any org member with SECURITY_CENTER_VIEW satisfy the client gate.
    // These are platform-admin operator tools (rule 9). Discovery flags
    // are OFF: the surface is reached from the Operations Center / Trust
    // Hub, not primary nav — R2 corrects the gate without changing the
    // nav surface.
    id: "operations.signers",
    href: "/admin/platform/signers",
    label: "Signer operations",
    description:
      "Evidence-signing key custody and signer health (platform-admin only).",
    domain: "OPS",
    requiredCapabilities: ["OPS_CENTER_VIEW"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  {
    // Phase R2 — dedicated PLATFORM_ADMIN gate for the exports surface.
    // See `operations.signers` for the routeId-correction rationale.
    id: "operations.exports",
    href: "/admin/platform/exports",
    label: "Evidence exports",
    description:
      "Operator export jobs and delivery status (platform-admin only).",
    domain: "OPS",
    requiredCapabilities: ["OPS_CENTER_VIEW"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  {
    // Phase R2 — dedicated PLATFORM_ADMIN gate for the recovery surface.
    // See `operations.signers` for the routeId-correction rationale.
    id: "operations.recovery",
    href: "/admin/platform/recovery",
    label: "Recovery operations",
    description:
      "Disaster-recovery validation and restore posture (platform-admin only).",
    domain: "OPS",
    requiredCapabilities: ["OPS_CENTER_VIEW"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",

    advancedByDefault: true,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  {
    id: "account.organization_admin_security",
    href: "/organizations/:id/admin/security",
    label: "Organization admin — Security",
    description:
      "Organization security posture: MFA, SSO, SCIM, sessions readiness with deep-links to canonical surfaces.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // Phase 3 (Enterprise Identity) — Domains verification tab. Lists claimed
  // domains + DNS TXT verification status; add/verify/remove call the
  // enterprise-gated /v1/orgs/:orgId/domains backend. Same ACCOUNT + NONE
  // active-space contract as its sibling org-admin tabs: personal-only users
  // never see it (routes resolve via org membership at /organizations/:id).
  // The /organizations path prefix is ENTERPRISE-tier in lib/surface/tiers.ts,
  // so FREE/PAYG/PRO/TEAM never reach it; org admins deep-link from the admin
  // shell tab bar (sidebarEligible: false — org detail is the sidebar entry).
  {
    id: "account.organization_admin_domains",
    href: "/organizations/:id/admin/domains",
    label: "Organization admin — Domains",
    description:
      "Verified email domains (DNS TXT). Gate SSO and auto-associate members to the organization.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "account.organization_admin_trust",
    href: "/organizations/:id/admin/trust",
    label: "Organization admin — Trust",
    description: "Organization trust center deep-links and methodology references.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // Phase 4 (Enterprise Administration) — three finalization tabs wired
  // into the admin shell tab bar. Same ACCOUNT + NONE active-space contract
  // as their sibling org-admin tabs: the /organizations prefix is
  // ENTERPRISE-tier (lib/surface/tiers.ts), so FREE/PAYG/PRO/TEAM never
  // reach them; org admins deep-link from the shell (sidebarEligible: false
  // — org detail is the sidebar entry).
  {
    id: "account.organization_admin_roles",
    href: "/organizations/:id/admin/roles",
    label: "Organization admin — Roles & permissions",
    description:
      "Reference for the six built-in org roles and their org-scope capabilities. Assignment happens on the Members tab.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "account.organization_admin_billing",
    href: "/organizations/:id/admin/billing",
    label: "Organization admin — Billing & seats",
    description:
      "Enterprise plan + seat rollup across workspaces (read-only). Requires ORG_BILLING_ADMIN or higher.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "account.organization_admin_integrations",
    href: "/organizations/:id/admin/integrations",
    label: "Organization admin — API & integrations",
    description:
      "Per-workspace API keys + webhook endpoints, deep-linked to the canonical integrations portal.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",

    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
];

/**
 * Lookup helper. Returns null for unknown ids.
 */
export function getRouteDefinition(id: string): RouteDefinition | null {
  return ROUTE_REGISTRY.find((r) => r.id === id) ?? null;
}

/**
 * Track 1A (surface-tier removal) — resolve the registry entry for a URL
 * pathname. Segment-boundary aware, `:param` / `[param]` tolerant, and
 * LONGEST-match wins so `/organizations/abc/admin/domains` resolves to the
 * dedicated admin-domains entry rather than the `/organizations` index.
 *
 * Returns null for unregistered paths — callers treat that as "no route
 * gate declared" (mirrors PageRouteGate's unknown-routeId fallback).
 */
export function findRouteDefinitionByPath(
  pathname: string,
): RouteDefinition | null {
  const clean = (pathname.split(/[?#]/)[0] ?? "").replace(/\/+$/, "") || "/";
  const pathSegs = clean.split("/").filter(Boolean);

  let best: RouteDefinition | null = null;
  let bestLen = -1;
  for (const route of ROUTE_REGISTRY) {
    // Hash-anchored hrefs (e.g. /settings#security) match their base path
    // only as the plain base route; skip them for path resolution.
    if (route.href.includes("#")) continue;
    const hrefSegs = route.href.split("/").filter(Boolean);
    if (hrefSegs.length > pathSegs.length) continue;
    let matches = true;
    for (let i = 0; i < hrefSegs.length; i++) {
      const h = hrefSegs[i]!;
      const isParam = h.startsWith(":") || (h.startsWith("[") && h.endsWith("]"));
      if (!isParam && h !== pathSegs[i]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (hrefSegs.length > bestLen) {
      best = route;
      bestLen = hrefSegs.length;
    }
  }
  return best;
}
