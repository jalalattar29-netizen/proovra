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

/** One switchable space in the canonical context switcher. */
export type AccountMenuWorkspaceOption = {
  id: string;
  label: string;
  /**
   * P3 (2026-07-21) — explicit canonical kind. OWNED = a self-service
   * user-owned workspace ("Your workspaces"); it is NEVER presented as an
   * Organization merely because it is non-personal.
   */
  kind: "PERSONAL" | "OWNED" | "ORGANIZATION";
  roleLabel: string | null;
  active: boolean;
};

/** Organization group — the org's authorized workspaces, grouped. */
export type AccountMenuOrganizationGroup = {
  organizationId: string;
  organizationName: string | null;
  workspaces: AccountMenuWorkspaceOption[];
};

export type AccountMenuModel = {
  /** Section 1 — account management. */
  account: AccountMenuLink[];
  /**
   * The canonical context switcher — SERVER-AUTHORIZED options grouped
   * Personal / Your workspaces / Organizations. Rendered by the persistent
   * context chip's panel (and reachable from the account menu's "Switch
   * workspace" action). One resolver, however many triggers.
   */
  workspaces: {
    personal: AccountMenuWorkspaceOption | null;
    owned: AccountMenuWorkspaceOption[];
    organizations: AccountMenuOrganizationGroup[];
    /** Total switchable spaces across all groups. */
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

/** Mirror of the envelope's canonical contextOptions section. */
export type AccountMenuContextOptionsInput = {
  personalSpace: {
    workspaceId: string;
    name: string | null;
    role: "OWNER";
  } | null;
  ownedWorkspaces: ReadonlyArray<{
    workspaceId: string;
    name: string | null;
    role: string | null;
  }>;
  organizations: ReadonlyArray<{
    organizationId: string;
    organizationName: string | null;
    workspaces: ReadonlyArray<{
      workspaceId: string;
      workspaceName: string | null;
      workspaceRole: string | null;
    }>;
  }>;
} | null;

export type AccountMenuInput = {
  capabilities: Partial<Record<CapabilityKey, boolean>>;
  isPlatformAdmin: boolean;
  activeSpace: { type: "PERSONAL" | "ORGANIZATION"; id: string | null } | null;
  personalSpace: { id: string | null; status?: string | null } | null;
  organizations: ReadonlyArray<AccountMenuOrganizationInput>;
  accountPlan: string | null;
  /**
   * P3 (2026-07-21) — the server-authorized grouped options. The switcher
   * is built EXCLUSIVELY from it. Required, matching the canonical
   * envelope contract (Phase 12 Point 4, Pass E — the optional marker and
   * its "older API" rollout fallback were removed; the API service always
   * projects this section).
   */
  contextOptions: AccountMenuContextOptionsInput;
  /**
   * PHASE 10 §13.2 STEP 6 (2026-07-23) — `false` for a managed enterprise
   * identity (no personal space), including a grandfathered personal Team
   * row from before it became managed. CLIENT-HIDING SIGNAL ONLY — the
   * server independently denies any personal-scope mutation regardless of
   * this flag. Absent/undefined defaults to `true` (legacy/STANDARD
   * behavior, unaffected).
   */
  personalSpaceAllowed?: boolean;
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

/**
 * Resolve the complete, ordered account menu. Pure — no hooks, no fetches.
 */
export function resolveAccountMenu(input: AccountMenuInput): AccountMenuModel {
  // ---------------------------------------------------------------------------
  // Section 1 — account management.
  //
  // ONE Settings entry, not three anchors into the same page.
  //
  // This section used to push "Account settings", "Security" and "Notification
  // preferences" — three rows whose hrefs were `/settings`,
  // `/settings#security` and `/settings#notifications`. One destination,
  // three doors, and the menu grew a Settings rail of its own: the deeper the
  // Settings navigation got, the more candidates there were to promote here,
  // and the taller the dropdown became.
  //
  // Settings already has a navigation rail listing every section, and the
  // command palette already finds those sections directly ("Settings ·
  // Security"). The account menu's job is identity and context, so it carries
  // ONE way into Settings and lets Settings do the rest.
  //
  // Billing keeps its own row: `/billing` is a different route, not a tab, and
  // a commercial destination worth reaching in one step.
  // ---------------------------------------------------------------------------
  const account: AccountMenuLink[] = [];

  if (routeLoads("account.settings", input)) {
    account.push({
      id: "account.settings",
      label: "Settings",
      href: "/settings",
      iconKey: "settings",
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
  const activeWorkspaceId =
    input.activeSpace?.type === "ORGANIZATION" ? input.activeSpace.id : null;

  // PHASE 10 §13.2 STEP 6 (2026-07-23) — a managed enterprise identity has no
  // personal space; `personalSpaceAllowed === false` suppresses the switcher
  // entry even when a grandfathered `personalSpace.id` is still present on
  // the envelope. Defaults to `true` (unaffected) when the field is absent.
  const personal: AccountMenuWorkspaceOption | null =
    input.personalSpace?.id && input.personalSpaceAllowed !== false
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

  // P3 — SERVER-AUTHORIZED grouping by explicit workspaceKind. The client
  // renders exactly what the server authorized; nothing is inferred from
  // isPersonal or plan literals here.
  //
  // `null` means the envelope has not loaded yet — the switcher shows no
  // workspaces until the server answers. It does NOT mean "older API":
  // Phase 12 Point 4 (Pass E) removed the rollout fallback that used to
  // synthesize an `organizationId: "legacy"` group from the flat
  // `organizations` list, because the API service projects this section
  // unconditionally.
  const owned: AccountMenuWorkspaceOption[] = (
    input.contextOptions?.ownedWorkspaces ?? []
  ).map((w) => ({
    id: w.workspaceId,
    label: w.name ?? "Workspace",
    kind: "OWNED" as const,
    roleLabel: w.role,
    active: activeWorkspaceId === w.workspaceId,
  }));
  const organizationGroups: AccountMenuOrganizationGroup[] = (
    input.contextOptions?.organizations ?? []
  ).map((group) => ({
    organizationId: group.organizationId,
    organizationName: group.organizationName,
    workspaces: group.workspaces.map((w) => ({
      id: w.workspaceId,
      label: w.workspaceName ?? "Organization workspace",
      kind: "ORGANIZATION" as const,
      roleLabel: w.workspaceRole,
      active: activeWorkspaceId === w.workspaceId,
    })),
  }));

  const total =
    (personal ? 1 : 0) +
    owned.length +
    organizationGroups.reduce((n, g) => n + g.workspaces.length, 0);

  // ---------------------------------------------------------------------------
  // Organization Settings — ONLY when the actor has ≥1 ACTIVE organization
  // membership (Phase 4: membership, not plan) AND the destination is
  // reachable. A personal-only user never sees it.
  // ---------------------------------------------------------------------------
  const organization: AccountMenuLink[] = [];
  if (activeOrganizations.length > 0 && routeLoads("account.organizations", input)) {
    organization.push({
      id: "account.organizations",
      // P3 (2026-07-21) — renamed from "Organization settings": the
      // destination is the organizations LIST/membership view (member-safe);
      // administration remains capability-gated one level deeper.
      label: "Organizations",
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
    workspaces: { personal, owned, organizations: organizationGroups, total },
    organization,
    support,
  };
}
