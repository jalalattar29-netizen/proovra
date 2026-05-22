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
      href: "/reviewer-ops",
      iconKey: "reviewer_ops",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: "REVIEWER_OPS_VIEW",
    },
    {
      id: "review.sla",
      label: "SLA",
      href: "/reviewer-ops/sla",
      iconKey: "sla",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: "SLA_VIEW",
    },
    {
      id: "review.escalations",
      label: "Escalations",
      href: "/reviewer-ops/escalations",
      iconKey: "escalations",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: "escalations_open",
      requiresCapability: "ESCALATIONS_VIEW",
    },
    {
      id: "governance.hub",
      label: "Governance",
      href: "/governance",
      iconKey: "governance",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: "governance_incidents",
      requiresCapability: "GOVERNANCE_VIEW",
    },
    {
      id: "governance.lifecycle",
      label: "Lifecycle",
      href: "/governance/lifecycle",
      iconKey: "lifecycle",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: "LIFECYCLE_VIEW",
    },
    {
      id: "governance.policy",
      label: "Policy",
      href: "/governance/policy",
      iconKey: "policy",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: "GOVERNANCE_ACT",
    },
    {
      id: "governance.retention",
      label: "Retention",
      href: "/governance/retention",
      iconKey: "retention",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: "GOVERNANCE_ACT",
    },
    {
      id: "governance.destruction",
      label: "Destruction",
      href: "/governance/destruction",
      iconKey: "destruction",
      domain: "REVIEW_GOVERNANCE",
      badgeKey: null,
      requiresCapability: "GOVERNANCE_ACT",
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
    {
      id: "platform.ops_center",
      label: "Operations Center",
      href: "/ops",
      iconKey: "ops_center",
      domain: "PLATFORM_HEALTH",
      badgeKey: "ops_center_runtime",
      requiresCapability: "OPS_CENTER_VIEW",
    },
    {
      id: "platform.observability",
      label: "Observability",
      href: "/ops/observability",
      iconKey: "observability",
      domain: "PLATFORM_HEALTH",
      badgeKey: "observability_runtime",
      requiresCapability: "OBSERVABILITY_VIEW",
    },
    {
      id: "platform.runbooks",
      label: "Runbooks",
      href: "/ops/runbooks",
      iconKey: "runbooks",
      domain: "PLATFORM_HEALTH",
      badgeKey: null,
      requiresCapability: "RUNBOOKS_VIEW",
    },
    {
      id: "platform.security_center",
      label: "Security Center",
      href: "/security-center",
      iconKey: "security_center",
      domain: "PLATFORM_HEALTH",
      badgeKey: null,
      requiresCapability: "SECURITY_CENTER_VIEW",
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
      label: "Teams",
      href: "/teams",
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
    },
    {
      id: "admin.intake_links",
      label: "Intake Links",
      href: "/intake-links",
      iconKey: "intake_links",
      domain: "ADMINISTRATION",
      badgeKey: null,
      requiresCapability: "INTAKE_LINKS_MANAGE",
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
// Group 5 — ACCOUNT (topbar account-menu only, never in the sidebar)
// =============================================================================

/**
 * Phase ROUTE-FIX — the account menu is the always-available surface
 * for logged-in users. It must NEVER be hidden by workspace gating:
 *
 *   - Profile / Notifications / Settings are personal-account routes.
 *   - Pricing / Billing / Plans / Help are product/account routes.
 *
 * Items here have `surface: "ACCOUNT_MENU"`. The filter pipeline
 * returns them as a separate `accountMenu` array on the envelope so
 * the topbar can render them independently of the sidebar groups.
 *
 * Capabilities here are deliberately permissive (`null` or
 * `SETTINGS_VIEW` which is granted to every authenticated user):
 * the account surface stays usable when workspace capabilities
 * degrade.
 */
const ACCOUNT_GROUP: NavRegistryGroup = {
  id: "account",
  title: "Account",
  domain: "ACCOUNT",
  order: 5,
  items: [
    {
      id: "account.profile",
      label: "Profile",
      href: "/settings",
      iconKey: "profile",
      domain: "ACCOUNT",
      badgeKey: null,
      surface: "ACCOUNT_MENU",
      requiresCapability: null,
    },
    {
      id: "account.notifications",
      label: "Notifications",
      href: "/notifications",
      iconKey: "notifications",
      domain: "ACCOUNT",
      badgeKey: null,
      surface: "ACCOUNT_MENU",
      requiresCapability: null,
    },
    {
      id: "account.pricing",
      label: "Pricing & plans",
      href: "/pricing",
      iconKey: "billing",
      domain: "BILLING_PLAN",
      badgeKey: null,
      surface: "ACCOUNT_MENU",
      // Pricing is a public marketing page — visible in the account
      // menu for every authenticated user regardless of workspace.
      requiresCapability: null,
    },
    {
      id: "account.billing",
      label: "Billing",
      href: "/billing",
      iconKey: "billing",
      domain: "BILLING_PLAN",
      badgeKey: null,
      surface: "ACCOUNT_MENU",
      // BILLING_VIEW is granted to every authenticated user (personal
      // + team) in the capability resolver — billing is an account
      // surface, not a workspace surface.
      requiresCapability: "BILLING_VIEW",
    },
    {
      id: "account.teams",
      label: "Teams",
      href: "/teams",
      iconKey: "teams",
      domain: "ACCOUNT",
      badgeKey: null,
      surface: "ACCOUNT_MENU",
      // Teams is reachable from the account menu as a CREATE-team
      // entry point for personal users. The /teams page renders the
      // create flow when no team workspace exists.
      requiresCapability: "TEAM_VIEW",
    },
    {
      id: "account.help",
      label: "Help & support",
      href: "/support",
      iconKey: "support",
      domain: "ACCOUNT",
      badgeKey: null,
      surface: "ACCOUNT_MENU",
      requiresCapability: null,
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
  ACCOUNT_GROUP,
];

// =============================================================================
// Filter — pure
// =============================================================================

import type {
  CapabilityMap,
  PlatformContextNavGroup,
  PlatformContextNavItem,
} from "./types.js";

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
  if (item.requiresCapability === null) return true;
  return caps[item.requiresCapability] === true;
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
): ReadonlyArray<PlatformContextNavGroup> {
  return NAVIGATION_REGISTRY.map<PlatformContextNavGroup>((group) => {
    const items: PlatformContextNavItem[] = group.items
      .filter((item) => appearsOnSurface(item, "SIDEBAR"))
      .filter((item) => passesCapabilityGate(item, caps))
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
export function buildNavigationProjection(caps: CapabilityMap): {
  sidebar: { groups: ReadonlyArray<PlatformContextNavGroup> };
  accountMenu: { items: ReadonlyArray<PlatformContextNavItem> };
} {
  const sidebarGroups = NAVIGATION_REGISTRY.map<PlatformContextNavGroup>(
    (group) => {
      const items: PlatformContextNavItem[] = group.items
        .filter((item) => appearsOnSurface(item, "SIDEBAR"))
        .filter((item) => passesCapabilityGate(item, caps))
        .map(projectItem);
      return {
        id: group.id,
        title: group.title,
        domain: group.domain,
        items,
      };
    },
  ).filter((group) => group.items.length > 0);

  // Account menu — flat, ordered: respect registry order. Dedupe by
  // id so an item appearing on BOTH surfaces is only listed once.
  const seen = new Set<string>();
  const accountMenuItems: PlatformContextNavItem[] = [];
  for (const group of NAVIGATION_REGISTRY) {
    for (const item of group.items) {
      if (!appearsOnSurface(item, "ACCOUNT_MENU")) continue;
      if (!passesCapabilityGate(item, caps)) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      accountMenuItems.push(projectItem(item));
    }
  }

  return {
    sidebar: { groups: sidebarGroups },
    accountMenu: { items: accountMenuItems },
  };
}
