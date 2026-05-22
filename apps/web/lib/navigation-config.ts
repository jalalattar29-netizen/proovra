/**
 * Phase 32.8B — Enterprise navigation config (data-driven).
 *
 * This module is the SINGLE source of truth for the app's sidebar
 * structure. The sidebar component (`AppSidebarV2`) consumes the
 * `NAVIGATION_GROUPS` array and the topbar consumes
 * `ACCOUNT_MENU_ITEMS`. NO navigation is defined inline in JSX
 * anywhere else in the app shell — that is a hard rule.
 *
 * Why data-driven, not JSX:
 *   Phase 37 will introduce persona-aware filtering — the same
 *   sidebar must be filterable by persona (lawyer / investigator /
 *   insurance reviewer / journalist / enterprise admin / reviewer /
 *   auditor / workspace owner), in addition to role (OWNER / ADMIN /
 *   MEMBER / REVIEWER / VIEWER / EXTERNAL_REVIEWER), workspace scope
 *   (PERSONAL / TEAM), plan, and feature flags. The data shape here
 *   carries all the metadata fields needed for that filtering. The
 *   filtering itself is NOT implemented today — only the architecture
 *   is in place.
 *
 * Hard rules:
 *   * Adding a new sidebar item requires editing THIS file. No
 *     scattered `<Link>`s. No "just one more nav" in a parent
 *     component.
 *   * `futurePersonaTags` is declared per item NOW so when Phase 37
 *     lands, the filter predicate has data to read. Today the field
 *     is ignored by the renderer.
 *   * Backend permission enforcement is authoritative. Client-side
 *     visibility filtering is a UX nicety only — never a security
 *     boundary.
 *   * `DEPRECATED_ROUTE_REDIRECTS` is the canonical map of
 *     consolidated routes; every entry must have a matching
 *     `app/(app)/{old-route}/page.tsx` redirect handler.
 */

import type {
  SidebarVisibility,
  WorkspaceRole,
  WorkspaceProfile,
} from "./workspace-profile";

// =============================================================================
// Domain vocabulary
// =============================================================================

/**
 * The 5 top-level domains from Phase 32.8A's information
 * architecture. EVERY navigation item belongs to exactly one.
 *
 *  - WORKSPACE: day-to-day evidence/case/report work.
 *  - REVIEW_GOVERNANCE: queue triage + policy/preservation/audit.
 *  - PLATFORM_HEALTH: runtime/observability/workers/incidents.
 *  - ADMINISTRATION: team/billing/settings/platform-admin.
 *  - ACCOUNT: personal identity surfaces (topbar dropdown ONLY,
 *    never in the sidebar).
 */
export const NAV_DOMAINS = [
  "WORKSPACE",
  "REVIEW_GOVERNANCE",
  "PLATFORM_HEALTH",
  "ADMINISTRATION",
  "ACCOUNT",
] as const;
export type NavDomain = (typeof NAV_DOMAINS)[number];

/**
 * Workspace scope determines whether an item appears in personal
 * (single-user) workspaces, team workspaces, or both.
 *
 *  - PERSONAL: only in personal workspaces.
 *  - TEAM: only in team workspaces.
 *  - BOTH: visible regardless of workspace type.
 *
 * Phase 32.8B leaves the actual workspace-type signal hookup to
 * Phase 32.8C — today every item is rendered as if scope is BOTH.
 * The field MUST still be declared so future-you doesn't have to
 * retrofit it across every entry.
 */
export const NAV_WORKSPACE_SCOPES = ["PERSONAL", "TEAM", "BOTH"] as const;
export type NavWorkspaceScope = (typeof NAV_WORKSPACE_SCOPES)[number];

/**
 * Phase 37 persona tags. RESERVED — these are declared per nav item
 * so the Phase 37 persona-filtering predicate has data to read on
 * day one. The current renderer ignores this field.
 *
 * The list is BOUNDED. Adding a persona requires updating this
 * union AND adding the corresponding backend persona resolution.
 */
export const FUTURE_PERSONA_TAGS = [
  "INDIVIDUAL_USER",
  "LAWYER",
  "INVESTIGATOR",
  "INSURANCE_REVIEWER",
  "JOURNALIST",
  "ENTERPRISE_ADMIN",
  "REVIEWER",
  "AUDITOR",
  "WORKSPACE_OWNER",
] as const;
export type FuturePersonaTag = (typeof FUTURE_PERSONA_TAGS)[number];

/**
 * Bounded badge-key catalog. The renderer hydrates the real value
 * from the runtime state hook; this string is the only contract
 * between the data layer and the render layer.
 */
export const NAV_BADGE_KEYS = [
  "escalations_open",
  "ops_center_runtime",
  "observability_runtime",
  "governance_incidents",
] as const;
export type NavBadgeKey = (typeof NAV_BADGE_KEYS)[number];

/**
 * Icon key catalog. The renderer maps each key to a Lucide icon
 * component. Keeping this as a string in the data layer avoids
 * leaking JSX into the config, which would defeat the
 * data-driven architecture.
 */
export const NAV_ICON_KEYS = [
  "home",
  "capture",
  "evidence",
  "cases",
  "reports",
  "search",
  "reviewer_ops",
  "sla",
  "escalations",
  "governance",
  "lifecycle",
  "retention",
  "destruction",
  "policy",
  "ops_center",
  "observability",
  "runbooks",
  "security_center",
  "teams",
  "billing",
  "settings",
  "admin",
  "integrations",
  "intake_links",
  "profile",
  "notifications",
  "logout",
] as const;
export type NavIconKey = (typeof NAV_ICON_KEYS)[number];

// =============================================================================
// Item / group shape
// =============================================================================

export type NavItem = {
  /** Bounded stable id — used by tests and telemetry. */
  id: string;
  /** Human label shown in the sidebar. */
  label: string;
  /** Canonical route this item navigates to. */
  href: string;
  /** Icon key — the renderer maps this to a Lucide component. */
  iconKey: NavIconKey;
  /** Top-level domain — drives which sidebar group hosts the item. */
  domain: NavDomain;
  /** Personal / team / both. Phase 32.8C will wire actual filtering. */
  workspaceScope: NavWorkspaceScope;
  /**
   * Bounded role / profile / platform-admin predicate (Phase 32.5).
   * When omitted, the item shows for any authenticated user.
   */
  visibility?: SidebarVisibility;
  /**
   * Phase 37 persona tags. Today this is data-only; the filter
   * isn't implemented. ALWAYS at least one tag — empty arrays are
   * suspicious (they would hide the item from every future
   * persona).
   */
  futurePersonaTags: ReadonlyArray<FuturePersonaTag>;
  /** Optional bounded runtime badge key. */
  badgeKey?: NavBadgeKey;
  /**
   * If set, this item represents a DEPRECATED route. The renderer
   * MAY still surface it (typically hidden) but the canonical route
   * is `deprecated.redirectTo`. Used by the redirect-page generator
   * tests to verify every deprecation has a working redirect.
   */
  deprecated?: {
    redirectTo: string;
    reason: string;
  };
};

export type NavGroup = {
  /** Bounded stable id — sidebar group test asserts. */
  id: string;
  /** Group heading shown in the sidebar. */
  title: string;
  /** Domain the group belongs to. */
  domain: NavDomain;
  /** Display order (ascending). */
  order: number;
  /**
   * Optional bounded role / profile / platform-admin predicate
   * applied to the WHOLE group. If the group has no items after
   * per-item filtering, the renderer hides the group header too.
   */
  visibility?: SidebarVisibility;
  items: ReadonlyArray<NavItem>;
};

// =============================================================================
// Canonical sidebar hierarchy (Phase 32.8A)
// =============================================================================

/**
 * Group 1 — WORKSPACE.
 *
 * Day-to-day evidence operator work. Visible in EVERY workspace
 * (personal or team) for every authenticated role. This is the
 * single landing surface — `/home` is the canonical workspace
 * landing page (replaces /dashboard).
 */
const WORKSPACE_GROUP: NavGroup = {
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
      workspaceScope: "BOTH",
      futurePersonaTags: [
        "INDIVIDUAL_USER",
        "LAWYER",
        "INVESTIGATOR",
        "INSURANCE_REVIEWER",
        "JOURNALIST",
        "ENTERPRISE_ADMIN",
        "REVIEWER",
        "AUDITOR",
        "WORKSPACE_OWNER",
      ],
    },
    {
      id: "workspace.capture",
      label: "Capture",
      href: "/capture",
      iconKey: "capture",
      domain: "WORKSPACE",
      workspaceScope: "BOTH",
      futurePersonaTags: [
        "INDIVIDUAL_USER",
        "LAWYER",
        "INVESTIGATOR",
        "INSURANCE_REVIEWER",
        "JOURNALIST",
        "ENTERPRISE_ADMIN",
        "REVIEWER",
        "WORKSPACE_OWNER",
      ],
    },
    {
      id: "workspace.evidence",
      label: "Evidence",
      href: "/evidence",
      iconKey: "evidence",
      domain: "WORKSPACE",
      workspaceScope: "BOTH",
      futurePersonaTags: [
        "INDIVIDUAL_USER",
        "LAWYER",
        "INVESTIGATOR",
        "INSURANCE_REVIEWER",
        "JOURNALIST",
        "ENTERPRISE_ADMIN",
        "REVIEWER",
        "AUDITOR",
        "WORKSPACE_OWNER",
      ],
    },
    {
      id: "workspace.cases",
      label: "Cases",
      href: "/cases",
      iconKey: "cases",
      domain: "WORKSPACE",
      workspaceScope: "BOTH",
      futurePersonaTags: [
        "LAWYER",
        "INVESTIGATOR",
        "INSURANCE_REVIEWER",
        "JOURNALIST",
        "ENTERPRISE_ADMIN",
        "REVIEWER",
        "AUDITOR",
        "WORKSPACE_OWNER",
      ],
    },
    {
      id: "workspace.reports",
      label: "Reports",
      href: "/reports",
      iconKey: "reports",
      domain: "WORKSPACE",
      workspaceScope: "BOTH",
      futurePersonaTags: [
        "LAWYER",
        "INVESTIGATOR",
        "INSURANCE_REVIEWER",
        "JOURNALIST",
        "ENTERPRISE_ADMIN",
        "AUDITOR",
        "WORKSPACE_OWNER",
      ],
    },
    {
      id: "workspace.search",
      label: "Search",
      href: "/search",
      iconKey: "search",
      domain: "WORKSPACE",
      workspaceScope: "BOTH",
      futurePersonaTags: [
        "INDIVIDUAL_USER",
        "LAWYER",
        "INVESTIGATOR",
        "INSURANCE_REVIEWER",
        "JOURNALIST",
        "ENTERPRISE_ADMIN",
        "REVIEWER",
        "AUDITOR",
        "WORKSPACE_OWNER",
      ],
    },
  ],
};

/**
 * Group 2 — REVIEW & GOVERNANCE.
 *
 * Triage queue + policy/preservation/audit. Combines reviewer ops
 * and governance under one heading per Phase 32.8A. Most items are
 * TEAM-scope; the role gating mirrors the backend enforcement.
 *
 * Phase 32.8A redirect rule: `/reviewer-ops/policy` is consolidated
 * under `/governance/policy`. The sidebar links to the canonical
 * target; backward-compat redirect lives at the deprecated route.
 */
const REVIEW_GOVERNANCE_GROUP: NavGroup = {
  id: "review_governance",
  title: "Review & Governance",
  domain: "REVIEW_GOVERNANCE",
  order: 2,
  items: [
    {
      id: "review.queue",
      label: "Reviewer Ops",
      href: "/reviewer-ops",
      iconKey: "reviewer_ops",
      domain: "REVIEW_GOVERNANCE",
      workspaceScope: "TEAM",
      futurePersonaTags: [
        "REVIEWER",
        "INSURANCE_REVIEWER",
        "AUDITOR",
        "ENTERPRISE_ADMIN",
        "WORKSPACE_OWNER",
      ],
    },
    {
      id: "review.sla",
      label: "SLA",
      href: "/reviewer-ops/sla",
      iconKey: "sla",
      domain: "REVIEW_GOVERNANCE",
      workspaceScope: "TEAM",
      futurePersonaTags: [
        "REVIEWER",
        "AUDITOR",
        "ENTERPRISE_ADMIN",
        "WORKSPACE_OWNER",
      ],
    },
    {
      id: "review.escalations",
      label: "Escalations",
      href: "/reviewer-ops/escalations",
      iconKey: "escalations",
      domain: "REVIEW_GOVERNANCE",
      workspaceScope: "TEAM",
      badgeKey: "escalations_open",
      futurePersonaTags: [
        "REVIEWER",
        "AUDITOR",
        "ENTERPRISE_ADMIN",
        "WORKSPACE_OWNER",
      ],
    },
    {
      id: "governance.hub",
      label: "Governance",
      href: "/governance",
      iconKey: "governance",
      domain: "REVIEW_GOVERNANCE",
      workspaceScope: "TEAM",
      badgeKey: "governance_incidents",
      futurePersonaTags: [
        "LAWYER",
        "AUDITOR",
        "ENTERPRISE_ADMIN",
        "WORKSPACE_OWNER",
      ],
    },
    {
      id: "governance.lifecycle",
      label: "Lifecycle",
      href: "/governance/lifecycle",
      iconKey: "lifecycle",
      domain: "REVIEW_GOVERNANCE",
      workspaceScope: "TEAM",
      futurePersonaTags: [
        "LAWYER",
        "AUDITOR",
        "ENTERPRISE_ADMIN",
        "WORKSPACE_OWNER",
      ],
    },
    {
      id: "governance.policy",
      label: "Policy",
      href: "/governance/policy",
      iconKey: "policy",
      domain: "REVIEW_GOVERNANCE",
      workspaceScope: "TEAM",
      visibility: { roles: ["OWNER", "ADMIN"] },
      futurePersonaTags: [
        "LAWYER",
        "AUDITOR",
        "ENTERPRISE_ADMIN",
        "WORKSPACE_OWNER",
      ],
    },
    {
      id: "governance.retention",
      label: "Retention",
      href: "/governance/retention",
      iconKey: "retention",
      domain: "REVIEW_GOVERNANCE",
      workspaceScope: "TEAM",
      visibility: { roles: ["OWNER", "ADMIN"] },
      futurePersonaTags: [
        "LAWYER",
        "AUDITOR",
        "ENTERPRISE_ADMIN",
        "WORKSPACE_OWNER",
      ],
    },
    {
      id: "governance.destruction",
      label: "Destruction",
      href: "/governance/destruction",
      iconKey: "destruction",
      domain: "REVIEW_GOVERNANCE",
      workspaceScope: "TEAM",
      visibility: { roles: ["OWNER", "ADMIN"] },
      futurePersonaTags: [
        "LAWYER",
        "AUDITOR",
        "ENTERPRISE_ADMIN",
        "WORKSPACE_OWNER",
      ],
    },
  ],
};

/**
 * Group 3 — PLATFORM HEALTH.
 *
 * Runtime / workers / Redis / observability / incidents /
 * security center. INTENTIONALLY visually separated from governance
 * (Phase 32.8A): "the system is degraded" lives here; "policy and
 * audit" lives under Review & Governance. Affected-domain scoping
 * (Phase 32.7 contract) is preserved at the banner level.
 */
const PLATFORM_HEALTH_GROUP: NavGroup = {
  id: "platform_health",
  title: "Platform Health",
  domain: "PLATFORM_HEALTH",
  order: 3,
  items: [
    {
      id: "platform.ops_center",
      label: "Operations Center",
      href: "/ops",
      iconKey: "ops_center",
      domain: "PLATFORM_HEALTH",
      workspaceScope: "BOTH",
      badgeKey: "ops_center_runtime",
      futurePersonaTags: [
        "ENTERPRISE_ADMIN",
        "WORKSPACE_OWNER",
        "AUDITOR",
      ],
    },
    {
      id: "platform.observability",
      label: "Observability",
      href: "/ops/observability",
      iconKey: "observability",
      domain: "PLATFORM_HEALTH",
      workspaceScope: "BOTH",
      badgeKey: "observability_runtime",
      futurePersonaTags: [
        "ENTERPRISE_ADMIN",
        "WORKSPACE_OWNER",
        "AUDITOR",
      ],
    },
    {
      id: "platform.runbooks",
      label: "Runbooks",
      href: "/ops/runbooks",
      iconKey: "runbooks",
      domain: "PLATFORM_HEALTH",
      workspaceScope: "BOTH",
      futurePersonaTags: [
        "ENTERPRISE_ADMIN",
        "WORKSPACE_OWNER",
        "AUDITOR",
      ],
    },
    {
      id: "platform.security_center",
      label: "Security Center",
      href: "/security-center",
      iconKey: "security_center",
      domain: "PLATFORM_HEALTH",
      workspaceScope: "BOTH",
      visibility: { roles: ["OWNER", "ADMIN"] },
      futurePersonaTags: [
        "ENTERPRISE_ADMIN",
        "WORKSPACE_OWNER",
        "AUDITOR",
      ],
    },
  ],
};

/**
 * Group 4 — ADMINISTRATION.
 *
 * Team / billing / settings / platform admin. Most items are
 * role-gated. Settings is the only item visible to non-admins
 * because it covers account-adjacent workspace preferences.
 */
const ADMINISTRATION_GROUP: NavGroup = {
  id: "administration",
  title: "Administration",
  domain: "ADMINISTRATION",
  order: 4,
  items: [
    {
      id: "admin.teams",
      label: "Teams",
      href: "/teams",
      iconKey: "teams",
      domain: "ADMINISTRATION",
      workspaceScope: "TEAM",
      visibility: { roles: ["OWNER", "ADMIN"] },
      futurePersonaTags: ["ENTERPRISE_ADMIN", "WORKSPACE_OWNER"],
    },
    {
      id: "admin.billing",
      label: "Billing",
      href: "/billing",
      iconKey: "billing",
      domain: "ADMINISTRATION",
      workspaceScope: "BOTH",
      visibility: { roles: ["OWNER", "ADMIN"] },
      futurePersonaTags: ["ENTERPRISE_ADMIN", "WORKSPACE_OWNER"],
    },
    {
      id: "admin.integrations",
      label: "Integrations",
      href: "/integrations",
      iconKey: "integrations",
      domain: "ADMINISTRATION",
      workspaceScope: "TEAM",
      visibility: { roles: ["OWNER", "ADMIN"] },
      futurePersonaTags: ["ENTERPRISE_ADMIN", "WORKSPACE_OWNER"],
    },
    {
      id: "admin.intake_links",
      label: "Intake Links",
      href: "/intake-links",
      iconKey: "intake_links",
      domain: "ADMINISTRATION",
      workspaceScope: "TEAM",
      visibility: { roles: ["OWNER", "ADMIN"] },
      futurePersonaTags: [
        "ENTERPRISE_ADMIN",
        "WORKSPACE_OWNER",
        "INSURANCE_REVIEWER",
        "JOURNALIST",
      ],
    },
    {
      id: "admin.settings",
      label: "Settings",
      href: "/settings",
      iconKey: "settings",
      domain: "ADMINISTRATION",
      workspaceScope: "BOTH",
      futurePersonaTags: [
        "INDIVIDUAL_USER",
        "LAWYER",
        "INVESTIGATOR",
        "INSURANCE_REVIEWER",
        "JOURNALIST",
        "ENTERPRISE_ADMIN",
        "REVIEWER",
        "AUDITOR",
        "WORKSPACE_OWNER",
      ],
    },
    {
      id: "admin.platform",
      label: "Platform Admin",
      href: "/admin",
      iconKey: "admin",
      domain: "ADMINISTRATION",
      workspaceScope: "BOTH",
      visibility: { requiresPlatformAdmin: true },
      futurePersonaTags: ["ENTERPRISE_ADMIN"],
    },
  ],
};

export const NAVIGATION_GROUPS: ReadonlyArray<NavGroup> = [
  WORKSPACE_GROUP,
  REVIEW_GOVERNANCE_GROUP,
  PLATFORM_HEALTH_GROUP,
  ADMINISTRATION_GROUP,
];

// =============================================================================
// Account menu (topbar dropdown — NOT sidebar)
// =============================================================================

/**
 * Account dropdown items. These live in the topbar's account
 * dropdown, NEVER in the sidebar. Workspace context (workspace
 * name, role, switcher) is rendered separately in the topbar — it
 * is NOT a list of NavItems because it is dynamic per-session
 * data, not a static route catalog.
 */
export type AccountMenuItem = {
  id: string;
  label: string;
  href?: string;
  iconKey: NavIconKey;
  /** When true, the renderer treats this as the sign-out action. */
  isSignOut?: boolean;
};

export const ACCOUNT_MENU_ITEMS: ReadonlyArray<AccountMenuItem> = [
  {
    id: "account.profile",
    label: "Profile",
    href: "/settings",
    iconKey: "profile",
  },
  {
    id: "account.notifications",
    label: "Notifications",
    href: "/notifications",
    iconKey: "notifications",
  },
  {
    id: "account.settings",
    label: "Account Settings",
    href: "/settings",
    iconKey: "settings",
  },
  {
    id: "account.signout",
    label: "Sign out",
    iconKey: "logout",
    isSignOut: true,
  },
];

// =============================================================================
// Deprecated route redirects (Phase 32.8A consolidation)
// =============================================================================

/**
 * Canonical map of legacy routes → consolidated canonical routes.
 *
 * Every entry MUST have a matching backward-compat redirect page
 * at `app/(app)/<old>/page.tsx`. The redirect tests assert this.
 *
 * The map is exported so future tooling can verify both ends:
 *   1. The legacy route still resolves (redirect page exists).
 *   2. The canonical target is reachable (sidebar links to it or
 *      a hub page links to it).
 */
export const DEPRECATED_ROUTE_REDIRECTS = {
  "/dashboard": "/home",
  "/review": "/reviewer-ops",
  "/operations": "/ops",
  "/security": "/security-center",
  "/locked": "/evidence?filter=locked",
  "/deleted": "/evidence?filter=deleted",
  "/archive": "/evidence?filter=archived",
  "/reviewer-ops/policy": "/governance/policy",
} as const;
export type DeprecatedRoute = keyof typeof DEPRECATED_ROUTE_REDIRECTS;

// =============================================================================
// Visibility filter
// =============================================================================

/**
 * Apply role / profile / platform-admin filtering to a group. The
 * group itself may be hidden if all of its items are filtered out.
 *
 * Note: this does NOT consider `workspaceScope` today — that is
 * deferred to Phase 32.8C when the workspace-type signal is wired
 * through the shell. NOR does it consider `futurePersonaTags` —
 * persona filtering is the Phase 37 responsibility.
 */
export function selectNavigationGroups(context: {
  isPlatformAdmin: boolean;
  role: WorkspaceRole | null;
  profile: WorkspaceProfile | null;
}): NavGroup[] {
  return NAVIGATION_GROUPS.map((group) => {
    const items = group.items.filter((item) => {
      const v = item.visibility;
      if (!v) return true;
      if (v.requiresPlatformAdmin && !context.isPlatformAdmin) return false;
      if (v.roles && v.roles.length > 0) {
        if (!context.role) return false;
        if (!v.roles.includes(context.role)) return false;
      }
      if (v.profiles && v.profiles.length > 0) {
        if (!context.profile) return false;
        if (!v.profiles.includes(context.profile)) return false;
      }
      return true;
    });

    return { ...group, items } satisfies NavGroup;
  }).filter((group) => {
    // Group-level visibility — hide if specified and not satisfied
    // OR if every child item was filtered out.
    if (group.items.length === 0) return false;
    const v = group.visibility;
    if (!v) return true;
    if (v.requiresPlatformAdmin && !context.isPlatformAdmin) return false;
    if (v.roles && v.roles.length > 0) {
      if (!context.role) return false;
      if (!v.roles.includes(context.role)) return false;
    }
    if (v.profiles && v.profiles.length > 0) {
      if (!context.profile) return false;
      if (!v.profiles.includes(context.profile)) return false;
    }
    return true;
  });
}
