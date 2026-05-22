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
  | "ADMINISTRATION";

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
      // TEAMS RESTORATION — visible to every team member, not just
      // OWNER/ADMIN. Personal workspaces never grant TEAM_VIEW so
      // they do not see the entry. TEAM_MANAGE controls write access
      // for invite/role/seat actions inside /teams pages.
      requiresCapability: "TEAM_VIEW",
    },
    {
      id: "admin.billing",
      label: "Billing",
      href: "/billing",
      iconKey: "billing",
      domain: "ADMINISTRATION",
      badgeKey: null,
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
 * Pure filter — returns the visible nav tree for the given capability
 * map. Items with `requiresCapability === null` are always visible
 * (provided the parent group has at least one visible item).
 */
export function filterNavigationRegistry(
  caps: CapabilityMap,
): ReadonlyArray<PlatformContextNavGroup> {
  return NAVIGATION_REGISTRY.map<PlatformContextNavGroup>((group) => {
    const items: PlatformContextNavItem[] = group.items
      .filter((item) => {
        if (item.requiresCapability === null) return true;
        return caps[item.requiresCapability] === true;
      })
      .map((item) => ({
        id: item.id,
        label: item.label,
        href: item.href,
        iconKey: item.iconKey,
        badgeKey: item.badgeKey,
        domain: item.domain,
      }));
    return {
      id: group.id,
      title: group.title,
      domain: group.domain,
      items,
    };
  }).filter((group) => group.items.length > 0);
}
