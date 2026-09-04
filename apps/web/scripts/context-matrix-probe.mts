/**
 * CROSS-CONTEXT VERIFICATION PROBE.
 *
 * Resolves the four discovery/entitlement surfaces for seven commercial and
 * workspace contexts by CALLING the canonical resolvers, so the matrix reports
 * what the product actually decides rather than what a plan name suggests.
 *
 * Not a test: it asserts nothing. It prints the resolved answer so a mismatch
 * is visible before anything is changed.
 *
 *   npx tsx apps/web/scripts/context-matrix-probe.mts
 */

import { resolveSettingsNavigation } from "../lib/settings/settingsNavigation";
import { resolveAccountMenu } from "../lib/navigation/accountMenu";
import { resolveRouteAccess } from "../lib/navigation/routeAccessResolver";
import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";

type Ctx = {
  name: string;
  space: "PERSONAL" | "ORGANIZATION";
  /** Capability map as the SERVER projects it — never derived from a plan. */
  caps: Record<string, boolean>;
  /** Monthly AI allowance from planFeatures. 0 = not included, null = custom. */
  aiOps: number | null;
  orgs: number;
  workspaces: number;
  isEnterprise: boolean;
};

/*
 * Capability sets mirror `capability-registry.ts`: REVIEWER_OPS_VIEW and the
 * other team keys are granted on a TEAM/ORG workspace shape, not on a personal
 * one; SETTINGS_MANAGE goes to OWNER/ADMIN.
 */
// Account-tier keys the capability registry grants to every authenticated
// user, degraded path included — not derived from a plan.
const PERSONAL_CAPS = {
  ACCOUNT_SETTINGS_VIEW: true,
  ACCOUNT_BILLING_VIEW: true,
  SETTINGS_VIEW: true,
};
const TEAM_BASE = {
  ...PERSONAL_CAPS,
  TEAM_VIEW: true,
  REVIEWER_OPS_VIEW: true,
  GOVERNANCE_VIEW: true,
  LIFECYCLE_VIEW: true,
};

const CONTEXTS: Ctx[] = [
  { name: "Personal FREE", space: "PERSONAL", caps: PERSONAL_CAPS, aiOps: 10, orgs: 0, workspaces: 1, isEnterprise: false },
  { name: "PAYG", space: "PERSONAL", caps: PERSONAL_CAPS, aiOps: 50, orgs: 0, workspaces: 1, isEnterprise: false },
  { name: "Personal PRO", space: "PERSONAL", caps: PERSONAL_CAPS, aiOps: 100, orgs: 0, workspaces: 1, isEnterprise: false },
  { name: "Team Owner/Admin", space: "ORGANIZATION", caps: { ...TEAM_BASE, SETTINGS_MANAGE: true, BILLING_MANAGE: true }, aiOps: 500, orgs: 1, workspaces: 2, isEnterprise: false },
  { name: "Team Member", space: "ORGANIZATION", caps: TEAM_BASE, aiOps: 500, orgs: 1, workspaces: 2, isEnterprise: false },
  { name: "Enterprise Org Admin", space: "ORGANIZATION", caps: { ...TEAM_BASE, SETTINGS_MANAGE: true, BILLING_MANAGE: true }, aiOps: null, orgs: 1, workspaces: 3, isEnterprise: true },
  { name: "Enterprise Member/Reviewer", space: "ORGANIZATION", caps: TEAM_BASE, aiOps: null, orgs: 1, workspaces: 3, isEnterprise: true },
];

function navInput(c: Ctx) {
  return {
    activeSpace: { type: c.space, id: c.space === "PERSONAL" ? "p-1" : "o-1", displayName: c.name },
    isPlatformAdmin: false,
    capabilities: c.caps,
    accountPlan: null,
    personalSpace: { id: "p-1" },
    orgAdminOrgId: c.caps.SETTINGS_MANAGE && c.space === "ORGANIZATION" ? "o-1" : null,
    isEnterpriseWorkspace: c.isEnterprise,
    planFeatures: { aiAssistanceMonthlyOperations: c.aiOps },
    organizations: c.orgs > 0 ? [{ organizationId: "o-1", membershipStatus: "ACTIVE" }] : [],
  } as never;
}

function menuInput(c: Ctx) {
  const owned = Array.from({ length: c.space === "PERSONAL" ? 0 : c.workspaces - 1 }, (_, i) => ({
    workspaceId: `w-${i}`,
    name: `Workspace ${i}`,
    role: "ADMIN",
  }));
  return {
    capabilities: c.caps,
    isPlatformAdmin: false,
    activeSpace: { type: c.space, id: c.space === "PERSONAL" ? "p-1" : "o-1" },
    personalSpace: { id: "p-1" },
    organizations: c.orgs > 0 ? [{ organizationId: "o-1", membershipStatus: "ACTIVE" }] : [],
    accountPlan: null,
    contextOptions: { ownedWorkspaces: owned, organizations: [] },
    personalSpaceAllowed: true,
    isEnterpriseWorkspace: c.isEnterprise,
    planFeatures: { aiAssistanceMonthlyOperations: c.aiOps },
  } as never;
}

function routeState(c: Ctx, routeId: string) {
  const route = ROUTE_REGISTRY.find((r) => r.id === routeId);
  if (!route) return "route missing";
  const a = resolveRouteAccess({
    route,
    activeSpaceType: c.space,
    isPlatformAdmin: false,
    capabilities: c.caps,
    accountPlan: null,
    isEnterpriseWorkspace: c.isEnterprise,
    planFeatures: { aiAssistanceMonthlyOperations: c.aiOps },
    workspace: { id: c.space === "PERSONAL" ? "p-1" : "o-1", status: "active" },
    personalSpace: { id: "p-1" },
  } as never);
  return `${a.canSeeNav ? "nav" : "hidden"}/${a.canLoad ? "load" : "denied"}`;
}

/** AI chat entitlement, from the allowance the server projects. */
function aiChat(c: Ctx) {
  if (c.aiOps === null) return "included (custom/unmetered)";
  if (c.aiOps === 0) return "NOT included → AI_NOT_INCLUDED (402)";
  return `included, ${c.aiOps}/mo`;
}

console.log("");
for (const c of CONTEXTS) {
  const nav = resolveSettingsNavigation(navInput(c));
  const labels = nav.groups.flatMap((g: { items: { label: string }[] }) => g.items.map((i) => i.label));
  const menu = resolveAccountMenu(menuInput(c));
  const rows = [
    ...menu.account.map((i: { label: string }) => i.label),
    menu.workspaces.total > 1 ? "Switch workspace" : null,
    ...menu.organization.map((i: { label: string }) => i.label),
    ...menu.support.map((i: { label: string }) => i.label),
    "Sign out",
  ].filter(Boolean);

  console.log(`── ${c.name}`);
  console.log(`   AI SETTINGS  : ${labels.includes("AI & assistance") ? "visible" : "HIDDEN"}` +
    `  (editable: ${c.space === "PERSONAL" ? "yes (owner)" : c.caps.SETTINGS_MANAGE ? "yes" : "read-only"})`);
  console.log(`   AI CHAT      : ${aiChat(c)}`);
  console.log(`   PROFILE MENU : ${rows.join(" · ")}`);
  console.log(`   TOOLS        : ${routeState(c, "workspace.tools")}`);
  console.log(`   REVIEWER CRIT: ${routeState(c, "workspace.reviewer_criteria")}`);
  console.log("");
}
