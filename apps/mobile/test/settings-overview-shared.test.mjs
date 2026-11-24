/**
 * Team remediation T-110 / T-111 / T-116 — mobile Settings overview for a
 * Team workspace. Team is a PERSONAL-workspace tier, so nothing here may hang
 * on the ORGANIZATION kind:
 *
 *   T-110  "Roles & permissions" follows `planFeatures.teamCollaborationIncluded`
 *          (with SETTINGS_VIEW), not `activeSpace.type === "ORGANIZATION"`.
 *   T-111  an invited MEMBER inside another person's Team workspace sees that
 *          workspace's name, their own role and the MEMBER matrix column —
 *          not "Personal Workspace" and OWNER.
 *   T-116  a Team owner's scope label is not "Personal plan".
 *
 * Envelope shapes are the server's (platform-context.service.ts activeSpace:
 * a joined workspace carries `shared: true`, its owner-derived `displayName`
 * and the caller's `roleLabel`; `workspace.membership.memberCount`).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

let S;
before(async () => {
  S = await loadModule("src/product/settings-overview.ts", []);
});

const TEAM_OWNER = (over = {}) => ({
  activeSpace: { id: "ws-own", type: "PERSONAL", displayName: "Personal Space", roleLabel: "Owner", plan: "TEAM", shared: false },
  workspace: { id: "ws-own", membership: { role: "OWNER", memberCount: 3 } },
  capabilities: { SETTINGS_VIEW: true, SETTINGS_MANAGE: true, BILLING_MANAGE: true },
  planFeatures: { teamCollaborationIncluded: true, aiAssistanceMonthlyOperations: 500 },
  flags: { isEnterpriseWorkspace: false },
  account: { userId: "u-owner", accountPlan: "TEAM" },
  personalSpace: { id: "ws-own", plan: "TEAM" },
  organizations: [],
  ...over,
});

const SHARED_MEMBER = () => ({
  activeSpace: { id: "ws-dana", type: "PERSONAL", displayName: "Dana Reyes's personal workspace", roleLabel: "MEMBER", plan: "TEAM", shared: true },
  workspace: { id: "ws-dana", membership: { role: "MEMBER", memberCount: 3 } },
  capabilities: { SETTINGS_VIEW: true, SETTINGS_MANAGE: false, BILLING_MANAGE: false },
  planFeatures: { teamCollaborationIncluded: true, aiAssistanceMonthlyOperations: 500 },
  flags: { isEnterpriseWorkspace: false },
  account: { userId: "u-member", accountPlan: "FREE" },
  personalSpace: { id: "ws-mine", plan: "FREE" },
  organizations: [],
});

const FREE_OWNER = () => ({
  activeSpace: { id: "ws-free", type: "PERSONAL", displayName: "Personal Space", roleLabel: "Owner", plan: "FREE", shared: false },
  workspace: { id: "ws-free", membership: { role: "OWNER", memberCount: 1 } },
  capabilities: { SETTINGS_VIEW: true, SETTINGS_MANAGE: true, BILLING_MANAGE: true },
  planFeatures: { teamCollaborationIncluded: false, aiAssistanceMonthlyOperations: 0 },
  flags: { isEnterpriseWorkspace: false },
  account: { userId: "u-free", accountPlan: "FREE" },
  personalSpace: { id: "ws-free", plan: "FREE" },
  organizations: [],
});

test("T-111: an invited MEMBER sees the owner's workspace name, role Member and the MEMBER matrix column", () => {
  const o = S.projectSettingsOverview(SHARED_MEMBER());
  assert.equal(o.workspaceName, "Dana Reyes's personal workspace");
  assert.equal(o.role, "MEMBER");
  assert.equal(o.roleLabel, "Member");
  assert.equal(o.matrixRole, "MEMBER", "the Roles pane marks the OWNER column as the member's own");
  assert.equal(o.typeLabel, "Shared with you");
  // The plan they work under is the workspace's, not their own FREE account plan.
  assert.equal(o.billing.displayPlan, "TEAM");
  assert.notEqual(o.billing.scopeLabel, "Personal plan");
});

test("T-111: a shared ADMIN is told ADMIN, never OWNER", () => {
  const env = SHARED_MEMBER();
  env.activeSpace.roleLabel = "ADMIN";
  const o = S.projectSettingsOverview(env);
  assert.equal(o.roleLabel, "Admin");
  assert.equal(o.matrixRole, "ADMIN");
});

test("T-110: a TEAM PERSONAL owner sees Roles & permissions; FREE does not; SETTINGS_VIEW still required", () => {
  assert.equal(S.projectSettingsOverview(TEAM_OWNER()).canViewRoles, true);
  assert.equal(S.projectSettingsOverview(SHARED_MEMBER()).canViewRoles, true);
  assert.equal(S.projectSettingsOverview(FREE_OWNER()).canViewRoles, false);
  const noView = TEAM_OWNER({ capabilities: { SETTINGS_VIEW: false } });
  assert.equal(S.projectSettingsOverview(noView).canViewRoles, false);
});

test("T-116: a Team owner's scope reads as the plan on their workspace, not 'Personal plan'", () => {
  const o = S.projectSettingsOverview(TEAM_OWNER());
  assert.equal(o.billing.scopeLabel, "Team plan on your workspace");
  assert.equal(o.roleLabel, "Owner");
  assert.equal(o.matrixRole, "OWNER");
  // T-115 — with members it is not called a personal workspace either.
  assert.equal(o.workspaceName, "Your Team workspace");
  assert.equal(o.typeLabel, "Team workspace");
  // A FREE owner keeps the personal wording.
  const f = S.projectSettingsOverview(FREE_OWNER());
  assert.equal(f.billing.scopeLabel, "Personal plan");
  assert.equal(f.workspaceName, "Personal Workspace");
  assert.equal(f.typeLabel, "Personal space");
  assert.equal(f.roleLabel, null);
});

test("a solo Team owner (no members yet) keeps the personal workspace name but not 'Personal plan'", () => {
  const o = S.projectSettingsOverview(TEAM_OWNER({ workspace: { id: "ws-own", membership: { memberCount: 1 } } }));
  assert.equal(o.workspaceName, "Personal Workspace");
  assert.equal(o.billing.scopeLabel, "Team plan on your workspace");
});

test("Enterprise ORGANIZATION is unchanged", () => {
  const o = S.projectSettingsOverview({
    activeSpace: { id: "org-1", type: "ORGANIZATION", plan: "ENTERPRISE", displayName: "Acme Legal", roleLabel: "ADMIN" },
    organizations: [{ id: "org-1", name: "Acme Legal", displayName: "Acme Legal", role: "ADMIN", membershipStatus: "ACTIVE", plan: "ENTERPRISE" }],
    capabilities: { SETTINGS_VIEW: true, BILLING_MANAGE: true },
    planFeatures: { teamCollaborationIncluded: true },
    flags: { isEnterpriseWorkspace: true },
  });
  assert.equal(o.workspaceName, "Acme Legal");
  assert.equal(o.roleLabel, "Admin");
  assert.equal(o.matrixRole, "ADMIN");
  assert.equal(o.typeLabel, "Organization");
  assert.equal(o.billing.scopeLabel, "Organization agreement");
  assert.equal(o.billing.canOpenBilling, false);
  assert.equal(o.canViewRoles, true);
});
