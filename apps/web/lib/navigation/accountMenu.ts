/**
 * CANONICAL ACCOUNT-MENU RESOLVER (2026-07-21).
 *
 * ONE pure function decides EVERY item in the top-bar account menu. The
 * account menu is ACCOUNT MANAGEMENT ONLY — it is not a second sidebar and
 * never duplicates application navigation. Structure (enterprise-canonical,
 * modelled on GitHub Enterprise / Stripe / Cloudflare account menus):
 *
 *   Header ............ avatar · name · email · active-workspace badge
 *   Section 1 ......... Account Settings · Security · Notification
 *                       Preferences · Billing
 *   Section 2 ......... Workspace Switcher (Personal + Organizations),
 *                       switches the active workspace in place — NEVER
 *                       navigates to a Teams/Workspaces admin page.
 *   Organization ...... Organization Settings — ONLY when the user has an
 *                       ACTIVE membership in ≥1 organization AND the
 *                       destination is actually reachable.
 *   Support ........... Help & Support — PUBLIC, opens in a new tab.
 *   Sign out .......... rendered by the component (a control, not a link).
 *
 * HARD RULES (pinned by tests):
 *   - Every LINK is gated by real route availability via `resolveRouteAccess`
 *     over the canonical `ROUTE_REGISTRY`. If a destination would not load
 *     for this actor, the item is NOT rendered — no dead links, no hidden
 *     404 / Forbidden. (Phase 9)
 *   - Organization visibility depends ONLY on real membership, NEVER on
 *     subscription plan. (Phase 4)
 *   - No Pricing & Plans entry (Billing already owns plan/checkout/pricing).
 *     (Phase 7)
 *   - No sidebar/application-navigation items (no /workspaces admin link, no
 *     duplicated Settings/Billing "administration" rows). (Phase 2)
 *   - All decisions happen HERE. The component is a pure renderer; it holds
 *     no visibility `if`s of its own. (Phase 10)
 *
 * Inputs are strictly: capabilities, active workspace, organization
 * memberships, platform role, account plan, and route availability. Persona /
 * workflow is never consulted.
 */

import type { CapabilityKey, WorkspaceRole } from "../platform-context/types";
import { ROUTE_REGISTRY, type RouteDefinition } from "./routeRegistry";
import { resolveRouteAccess } from "./routeAccessResolver";

export type AccountMenuIconKey =
  | "settings"
  | "security"
  | "notifications"
  | "billing"
  | "organization"
  | "help";

/** A navigational item in the account menu. */
export type AccountMenuLink = {
  id: string;
  label: string;
  href: string;
  iconKey: AccountMenuIconKey;
  /** PUBLIC destination — opens in a new browser tab (target=_blank). */
  external?: boolean;
};

/** One switchable space in the Workspace Switcher (Section 2). */
export type AccountMenuWorkspaceOption = {
  id: string;
  label: string;
  kind: "PERSONAL" | "ORGANIZATION";
  roleLabel: string | null;
  active: boolean;
};

export type AccountMenuModel = {
  /** Section 1 — account management. */
  account: AccountMenuLink[];
  /** Section 2 — the in-place workspace switcher. */
  workspaces: {
    personal: AccountMenuWorkspaceOption | null;
    organizations: AccountMenuWorkspaceOption[];
    /** Total switchable spaces (personal + active orgs). */
    total: number;
  };
  /** Organization-management link(s) — member-gated, route-gated. */
  organization: AccountMenuLink[];
  /** Support — public, external. */
  support: AccountMenuLink[];
};

export type AccountMenuOrganizationInput = {
  id: string;
  name: string | null;
  displayName: string | null;
  role: WorkspaceRole | null;
  membershipStatus: "ACTIVE" | "PENDING" | "INACTIVE";
};

export type AccountMenuInput = {
  capabilities: Partial<Record<CapabilityKey, boolean>>;
  isPlatformAdmin: boolean;
  activeSpace: { type: "PERSONAL" | "ORGANIZATION"; id: string | null } | null;
  personalSpace: { id: string | null; status?: string | null } | null;
  organizations: ReadonlyArray<AccountMenuOrganizationInput>;
  accountPlan: string | null;
};

const ROUTE_BY_ID: ReadonlyMap<string, RouteDefinition> = new Map(
  ROUTE_REGISTRY.map((route) => [route.id, route]),
);

/**
 * True iff the destination route would actually LOAD for this actor. This is
 * the single eligibility gate every account-menu link passes through, so the
 * menu can never render a link that lands on 404 / Forbidden / a workspace it
 * cannot enter. Fails safe: an unknown route id is treated as unreachable.
 */
function routeLoads(routeId: string, input: AccountMenuInput): boolean {
  const route = ROUTE_BY_ID.get(routeId);
  if (!route) return false;
  const access = resolveRouteAccess({
    route,
    activeSpaceType: input.activeSpace?.type ?? null,
    isPlatformAdmin: input.isPlatformAdmin,
    capabilities: input.capabilities,
    accountPlan: input.accountPlan,
    workspace: input.activeSpace
      ? { id: input.activeSpace.id, status: "active" }
      : null,
    personalSpace: input.personalSpace,
  });
  return access.canLoad;
}

function orgLabel(org: AccountMenuOrganizationInput): string {
  return org.displayName ?? org.name ?? "Organization workspace";
}

/**
 * Resolve the complete, ordered account menu. Pure — no hooks, no fetches.
 */
export function resolveAccountMenu(input: AccountMenuInput): AccountMenuModel {
  // ---------------------------------------------------------------------------
  // Section 1 — account management.
  //
  // Account Settings / Security / Notification Preferences all resolve to the
  // unified /settings surface (anchors into its sections); they are gated as a
  // group on the /settings route loading. Billing resolves to its own route.
  // ---------------------------------------------------------------------------
  const account: AccountMenuLink[] = [];

  if (routeLoads("account.settings", input)) {
    account.push({
      id: "account.settings",
      label: "Account settings",
      href: "/settings",
      iconKey: "settings",
    });
    account.push({
      id: "account.security",
      label: "Security",
      href: "/settings#security",
      iconKey: "security",
    });
    account.push({
      id: "account.notifications",
      label: "Notification preferences",
      href: "/settings#notifications",
      iconKey: "notifications",
    });
  }

  if (routeLoads("account.billing", input)) {
    account.push({
      id: "account.billing",
      label: "Billing",
      href: "/billing",
      iconKey: "billing",
    });
  }

  // ---------------------------------------------------------------------------
  // Section 2 — workspace switcher. Personal Space always leads; organizations
  // are the actor's ACTIVE memberships only (a PENDING invite is not yet a
  // switchable space). Membership is the ONLY input — never plan.
  // ---------------------------------------------------------------------------
  const personal: AccountMenuWorkspaceOption | null = input.personalSpace?.id
    ? {
        id: input.personalSpace.id,
        label: "Personal Space",
        kind: "PERSONAL",
        roleLabel: "Owner",
        active: input.activeSpace?.type === "PERSONAL",
      }
    : null;

  const activeOrganizations = input.organizations.filter(
    (org) => org.membershipStatus === "ACTIVE",
  );

  const organizations: AccountMenuWorkspaceOption[] = activeOrganizations.map(
    (org) => ({
      id: org.id,
      label: orgLabel(org),
      kind: "ORGANIZATION",
      roleLabel: org.role,
      active:
        input.activeSpace?.type === "ORGANIZATION" &&
        input.activeSpace.id === org.id,
    }),
  );

  const total = (personal ? 1 : 0) + organizations.length;

  // ---------------------------------------------------------------------------
  // Organization Settings — ONLY when the actor has ≥1 ACTIVE organization
  // membership (Phase 4: membership, not plan) AND the destination is
  // reachable. A personal-only user never sees it.
  // ---------------------------------------------------------------------------
  const organization: AccountMenuLink[] = [];
  if (activeOrganizations.length > 0 && routeLoads("account.organizations", input)) {
    organization.push({
      id: "account.organizations",
      label: "Organization settings",
      href: "/organizations",
      iconKey: "organization",
    });
  }

  // ---------------------------------------------------------------------------
  // Support — PUBLIC help centre, opens in a new tab so the authenticated app
  // is never replaced.
  // ---------------------------------------------------------------------------
  const support: AccountMenuLink[] = [
    {
      id: "account.help",
      label: "Help & support",
      href: "/support",
      iconKey: "help",
      external: true,
    },
  ];

  return {
    account,
    workspaces: { personal, organizations, total },
    organization,
    support,
  };
}
