/**
 * Settings navigation — the ONE resolver for what the Settings shell offers.
 *
 * WHY THIS IS A PURE MODULE
 * ---------------------------------------------------------------------------
 * Settings used to be a single scrolling page whose every section rendered for
 * everyone, with the components themselves deciding at the last moment whether
 * to show anything. That put the "can I do this here?" question in a dozen
 * places and answered it a dozen ways.
 *
 * This answers it once. It is pure — no hooks, no fetches — so the whole
 * navigation model is testable as a function of the envelope, and the shell
 * simply renders what it returns.
 *
 * IT DECIDES NOTHING ITSELF
 * ---------------------------------------------------------------------------
 * Every destination that is a real route is gated by `resolveRouteAccess`, the
 * same resolver the sidebar and the account menu already pass through, reading
 * the same server-projected capabilities. Nothing here compares a role name, and
 * nothing here reads a plan string: a surface appears because the canonical
 * resolver says the route would LOAD for this actor, or because the envelope
 * projected the capability the section needs.
 *
 * Fails closed. An unknown route id, an absent capability and a loading
 * envelope all resolve the same way: the entry is not offered.
 */

import { ROUTE_REGISTRY, type RouteDefinition } from "../navigation/routeRegistry";
import type { CapabilityKey } from "../platform-context/types";
import { resolveRouteAccess } from "../navigation/routeAccessResolver";

/** Same index the account menu builds, for the same reason: id -> route. */
const ROUTE_BY_ID: ReadonlyMap<string, RouteDefinition> = new Map(
  ROUTE_REGISTRY.map((r) => [r.id, r]),
);

/** An in-page section of the Settings shell. */
export type SettingsPaneId =
  | "overview"
  | "profile"
  | "security"
  | "notifications"
  | "workspace"
  | "members"
  | "roles"
  | "cases-evidence"
  | "retention"
  | "integrations"
  | "sso"
  | "audit"
  | "billing";

export type SettingsNavItem = {
  id: SettingsPaneId;
  label: string;
  /**
   * The canonical surface this pane summarises and hands off to, when one
   * exists. Settings is the entry point; it is never a second copy of the
   * product behind the link.
   */
  href: string | null;
};

export type SettingsNavGroup = {
  id: "account" | "workspace" | "integrations" | "system";
  label: string;
  items: SettingsNavItem[];
};

export type SettingsNavModel = {
  /** Always present, always first, always the landing pane. */
  overview: SettingsNavItem;
  groups: SettingsNavGroup[];
  /** Flat lookup for the shell's pane resolution and deep links. */
  allowed: Set<SettingsPaneId>;
};

export type SettingsNavInput = {
  activeSpace: { type: "PERSONAL" | "ORGANIZATION"; id: string; displayName?: string | null } | null;
  isPlatformAdmin: boolean;
  capabilities: Partial<Record<CapabilityKey, boolean>> | null;
  accountPlan: string | null;
  personalSpace: { id: string | null; status?: string | null } | null;
  /** Organization id for org-admin destinations, when the actor has one. */
  orgAdminOrgId: string | null;
  /**
   * The SERVER-projected `envelope.flags.isEnterpriseWorkspace`.
   *
   * The SSO/SCIM console at `/security-center/sso` is not in the route
   * registry, so `resolveRouteAccess` cannot answer for it. This is the same
   * server boolean `deriveSettingsUiContext` and `useEnterpriseSurfaceAccess`
   * already consume — NOT a plan-name comparison, which is exactly what §33
   * forbids and what would drift the moment a plan is renamed.
   */
  isEnterpriseWorkspace: boolean;
};

/** True iff the canonical route would actually load for this actor. */
function routeLoads(routeId: string, input: SettingsNavInput): boolean {
  const route = ROUTE_BY_ID.get(routeId);
  if (!route) return false;
  return resolveRouteAccess({
    route,
    activeSpaceType: input.activeSpace?.type ?? null,
    isPlatformAdmin: input.isPlatformAdmin,
    capabilities: input.capabilities ?? {},
    accountPlan: input.accountPlan,
    workspace: input.activeSpace
      ? { id: input.activeSpace.id, status: "active" }
      : null,
    personalSpace: input.personalSpace,
    // Several workspace destinations are in `ENTERPRISE_ONLY_ROUTE_IDS`, and
    // the resolver fails them closed without this. Same server-projected flag
    // the shell reads — never a plan-name comparison.
    isEnterpriseWorkspace: input.isEnterpriseWorkspace,
  }).canLoad;
}

/** A server-projected capability, read strictly. Absent or loading = no. */
function has(input: SettingsNavInput, capability: CapabilityKey): boolean {
  return input.capabilities?.[capability] === true;
}

export function resolveSettingsNavigation(
  input: SettingsNavInput,
): SettingsNavModel {
  const isOrg = input.activeSpace?.type === "ORGANIZATION";

  // -------------------------------------------------------------------------
  // ACCOUNT — the actor's own settings. Never workspace-gated: every
  // authenticated person has a profile, a password and notification
  // preferences regardless of where they are working.
  // -------------------------------------------------------------------------
  const account: SettingsNavItem[] = [
    { id: "profile", label: "Profile & preferences", href: null },
    {
      id: "security",
      label: "Security",
      // Settings summarises; the Security Center owns the advanced controls.
      href: routeLoads("workspace.security_center", input) ? "/security-center" : null,
    },
    { id: "notifications", label: "Notifications", href: null },
  ];

  // -------------------------------------------------------------------------
  // WORKSPACE — only what this workspace actually has.
  //
  // A personal space has no membership, no roles and no workspace-level
  // retention policy, so offering those panes there would be offering
  // functionality that does not exist. This is the §34 boundary.
  // -------------------------------------------------------------------------
  const workspace: SettingsNavItem[] = [];
  if (has(input, "SETTINGS_MANAGE") || isOrg) {
    workspace.push({ id: "workspace", label: "General", href: null });
  }
  // Membership is administered on the organization admin surface. Offering
  // the entry without asking the canonical resolver would have produced a
  // link that lands on a refusal — the resolver answers, not this module.
  if (
    input.orgAdminOrgId &&
    routeLoads("account.organization_admin_members", input)
  ) {
    workspace.push({
      id: "members",
      label: "Members",
      href: `/organizations/${input.orgAdminOrgId}/admin/members`,
    });
  }
  // Roles are a property of a workspace with membership; a personal space has
  // none, so the pane would describe roles nobody can hold.
  if (isOrg) {
    workspace.push({ id: "roles", label: "Roles & permissions", href: null });
  }
  if (isOrg) {
    workspace.push({ id: "cases-evidence", label: "Cases & evidence", href: null });
  }
  if (routeLoads("governance.retention", input)) {
    workspace.push({
      id: "retention",
      label: "Retention & lifecycle",
      href: "/governance/retention",
    });
  }

  // -------------------------------------------------------------------------
  // INTEGRATIONS — commercial and capability gated by the canonical resolver.
  // No plan-string comparison anywhere: `resolveRouteAccess` already folds
  // entitlement into whether the route loads.
  // -------------------------------------------------------------------------
  const integrations: SettingsNavItem[] = [];
  if (routeLoads("workspace.integrations", input)) {
    integrations.push({
      id: "integrations",
      label: "API & integrations",
      href: "/integrations",
    });
  }
  // SSO/SCIM is an enterprise identity surface, and it is administered — a
  // member of an enterprise workspace does not configure the IdP. Both
  // conditions are server-projected: the enterprise flag and the Security
  // Center capability, neither read from a plan name.
  if (input.isEnterpriseWorkspace && has(input, "SECURITY_CENTER_VIEW")) {
    integrations.push({
      id: "sso",
      label: "SCIM & SSO",
      // The documented procurement deep link, which server-redirects to the
      // canonical SAML console. Settings does not re-implement it.
      href: "/settings/security/saml",
    });
  }

  // -------------------------------------------------------------------------
  // SYSTEM
  // -------------------------------------------------------------------------
  const system: SettingsNavItem[] = [];
  if (routeLoads("workspace.audit_transparency", input)) {
    system.push({ id: "audit", label: "Audit log", href: "/audit-transparency" });
  }
  if (routeLoads("account.billing", input)) {
    system.push({ id: "billing", label: "Billing & plan", href: "/billing" });
  }

  const groups: SettingsNavGroup[] = (
    [
      { id: "account", label: "Account", items: account },
      { id: "workspace", label: "Workspace", items: workspace },
      { id: "integrations", label: "Integrations", items: integrations },
      { id: "system", label: "System", items: system },
    ] as SettingsNavGroup[]
  ).filter((g) => g.items.length > 0);

  const overview: SettingsNavItem = { id: "overview", label: "Overview", href: null };
  const allowed = new Set<SettingsPaneId>(["overview"]);
  for (const group of groups) for (const item of group.items) allowed.add(item.id);

  return { overview, groups, allowed };
}

/**
 * The pane a URL hash asks for, or `overview`.
 *
 * Deep links survive the redesign — `/settings#security` still lands on
 * Security — but a hash naming a pane this actor cannot see resolves to the
 * landing pane rather than rendering a surface the resolver refused.
 */
export function resolvePaneFromHash(
  hash: string,
  model: SettingsNavModel,
): SettingsPaneId {
  const raw = hash.replace(/^#/, "").trim();
  // The pre-redesign anchors, kept working.
  const legacy: Record<string, SettingsPaneId> = {
    preferences: "profile",
    privacy: "profile",
    ai: "workspace",
  };
  const candidate = (legacy[raw] ?? raw) as SettingsPaneId;
  return model.allowed.has(candidate) ? candidate : "overview";
}
