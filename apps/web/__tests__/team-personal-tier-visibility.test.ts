/**
 * Team is a personal-workspace tier (Stage E, W2). Surfaces that were gated on
 * the ORGANIZATION kind, or labelled by it, now follow the server-projected
 * plan feature and the workspace's own membership — with an Enterprise
 * ORGANIZATION envelope proving the shared fix still reaches Enterprise and a
 * FREE envelope proving nothing opens where the plan sells no collaboration.
 *
 *   T-109  Home "Team work" card (normalizeHomeViewModel)
 *   T-110  Settings "Roles & permissions" pane (resolveSettingsNavigation)
 *   T-115  one Team-aware workspace label (describeActiveWorkspace)
 *   T-116  Settings scope label (deriveSettingsUiContext)
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { PLAN_CAPABILITIES } from "@proovra/shared-billing";

import {
  normalizeHomeViewModel,
  type NormalizeInputs,
} from "../components/home-experience/home-view-model";
import { resolveSettingsNavigation } from "../lib/settings/settingsNavigation";
import { deriveSettingsUiContext } from "../lib/settings/settingsUiContext";
import {
  describeActiveWorkspace,
  workspaceNameWithKind,
} from "../lib/platform-context/workspaceLabel";
import { resolveCaseScopeLabel } from "../components/cases-experience/case-scope-label";

// ---------------------------------------------------------------------------
// Envelope fixtures — the planFeatures come from the ONE plan catalog.
// ---------------------------------------------------------------------------

type Plan = "FREE" | "PRO" | "TEAM" | "ENTERPRISE";

function features(plan: Plan) {
  const c = PLAN_CAPABILITIES[plan];
  return {
    teamCollaborationIncluded: c.maxCollaborationTeamsPerWorkspace > 0,
    reviewerOperationsIncluded: c.reviewerOperationsIncluded,
    reviewQueuesIncluded: c.reviewQueuesIncluded,
  };
}

const WS = "11111111-1111-4111-8111-111111111111";

/** The caller's OWN Personal Workspace on `plan` with `members` (owner included). */
function personalEnvelope(plan: Plan, members: number, name = "Dana Reyes's personal workspace") {
  return {
    workspace: {
      status: "active",
      id: WS,
      name,
      scope: "PERSONAL",
      workspaceKind: "PERSONAL",
      plan,
      membership: { role: "OWNER", isOwner: true, isAdmin: true, memberCount: members },
    },
    activeSpace: { type: "PERSONAL", id: WS, displayName: "Personal Space", roleLabel: "Owner", plan },
    planFeatures: features(plan),
    personalSpace: { status: "active", id: WS, label: "Personal Space", ownerUserId: "u-1", plan },
    contextOptions: {
      personalSpace: { workspaceId: WS, name: "Personal Space", kind: "PERSONAL", role: "OWNER", lifecycleStatus: "active" },
      ownedWorkspaces: [],
      sharedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: WS, kind: "PERSONAL", organizationId: null, displayName: "Personal Space" },
    },
  } as never;
}

/** A MEMBER inside somebody else's Team workspace. */
function sharedEnvelope(plan: Plan) {
  return {
    workspace: {
      status: "active",
      id: WS,
      name: "Dana Reyes's personal workspace",
      scope: "PERSONAL",
      workspaceKind: "PERSONAL",
      plan,
      membership: { role: "MEMBER", isOwner: false, isAdmin: false, memberCount: 3 },
    },
    activeSpace: { type: "PERSONAL", id: WS, displayName: "Dana Reyes's workspace", roleLabel: "MEMBER", shared: true, plan },
    planFeatures: features(plan),
  } as never;
}

const ORG_WS = "22222222-2222-4222-8222-222222222222";

/** An Enterprise ORGANIZATION workspace (the real envelope shape). */
function enterpriseEnvelope(members = 12) {
  return {
    workspace: {
      status: "active",
      id: ORG_WS,
      name: "Northwind Legal",
      scope: "ORGANIZATION",
      workspaceKind: "ORGANIZATION",
      organizationKind: "CUSTOMER",
      plan: "ENTERPRISE",
      membership: { role: "OWNER", isOwner: true, isAdmin: true, memberCount: members },
    },
    activeSpace: { type: "ORGANIZATION", id: ORG_WS, displayName: "Northwind Legal", roleLabel: "OWNER", plan: "ENTERPRISE" },
    planFeatures: features("ENTERPRISE"),
    flags: { isEnterpriseWorkspace: true },
  } as never;
}

// ===========================================================================
// T-109 — Home "Team work"
// ===========================================================================

function homeInputs(over: Partial<NormalizeInputs>): NormalizeInputs {
  return {
    workspaceId: WS,
    plan: "TEAM",
    activeSpaceType: "PERSONAL",
    trustSummary: null,
    billing: null,
    reports: null,
    intakeLinks: null,
    inbox: null,
    communications: null,
    orgs: [],
    evidenceList: null,
    commandCenter: null,
    nowMs: Date.parse("2026-11-24T12:00:00.000Z"),
    ...over,
  } as NormalizeInputs;
}

test("T-109 — a TEAM Personal Workspace with 2 members shows Team work, counted from the workspace", () => {
  const vm = normalizeHomeViewModel(
    homeInputs({ plan: "TEAM", planFeatures: features("TEAM"), workspaceMemberCount: 2 }),
  );
  assert.ok(vm.teamWork, "Team work must render for a Team workspace with members (it was null)");
  assert.equal(vm.teamWork.members, 2);
  // organizations[] PENDING rows are invitations TO the viewer — not this workspace's.
  assert.equal(vm.teamWork.pendingInvites, null);
});

test("T-109 — a solo TEAM owner, and FREE, show no Team work", () => {
  const solo = normalizeHomeViewModel(
    homeInputs({ plan: "TEAM", planFeatures: features("TEAM"), workspaceMemberCount: 1 }),
  );
  assert.equal(solo.teamWork, null);
  const free = normalizeHomeViewModel(
    homeInputs({ plan: "FREE", planFeatures: features("FREE"), workspaceMemberCount: 2 }),
  );
  assert.equal(free.teamWork, null, "a plan without collaboration never shows Team work");
  const unknown = normalizeHomeViewModel(homeInputs({ plan: "TEAM", planFeatures: features("TEAM") }));
  assert.equal(unknown.teamWork, null, "an unknown member count is not 'a team'");
});

test("T-109 — the Enterprise ORGANIZATION envelope keeps its Team work card", () => {
  const vm = normalizeHomeViewModel(
    homeInputs({
      plan: "TEAM", // display label only (HomePlan has no ENTERPRISE); entitlements come from planFeatures
      workspaceId: ORG_WS,
      activeSpaceType: "ORGANIZATION",
      planFeatures: features("ENTERPRISE"),
      workspaceMemberCount: 12,
      orgs: [
        { id: ORG_WS, name: "Northwind Legal", displayName: "Northwind Legal", memberCount: 12, role: "OWNER", membershipStatus: "ACTIVE" },
        { id: "o-2", name: "Other", displayName: "Other", memberCount: 3, role: null, membershipStatus: "PENDING" },
      ],
    }),
  );
  assert.ok(vm.teamWork);
  assert.equal(vm.teamWork.members, 12);
  assert.equal(vm.teamWork.pendingInvites, 1);
  // An older organization envelope without the count still counts from organizations[].
  const legacy = normalizeHomeViewModel(
    homeInputs({
      plan: "TEAM", // display label only (HomePlan has no ENTERPRISE); entitlements come from planFeatures
      workspaceId: ORG_WS,
      activeSpaceType: "ORGANIZATION",
      planFeatures: features("ENTERPRISE"),
      orgs: [{ id: ORG_WS, name: "N", displayName: "N", memberCount: 7, role: "OWNER", membershipStatus: "ACTIVE" }],
    }),
  );
  assert.equal(legacy.teamWork?.members, 7);
});

// ===========================================================================
// T-110 — Roles & permissions in Settings
// ===========================================================================

function settingsNav(envelopeKind: "TEAM" | "FREE" | "ENTERPRISE", caps: Record<string, boolean> = { SETTINGS_VIEW: true }) {
  const org = envelopeKind === "ENTERPRISE";
  return resolveSettingsNavigation({
    activeSpace: org
      ? { type: "ORGANIZATION", id: ORG_WS, displayName: "Northwind Legal" }
      : { type: "PERSONAL", id: WS, displayName: "Personal Space" },
    isPlatformAdmin: false,
    capabilities: caps,
    accountPlan: org ? null : envelopeKind,
    personalSpace: { id: WS },
    orgAdminOrgId: null,
    isEnterpriseWorkspace: org,
    planFeatures: features(envelopeKind),
  } as never);
}
const offersRoles = (nav: ReturnType<typeof resolveSettingsNavigation>) =>
  nav.groups.some((g) => g.items.some((i) => i.id === "roles")) && nav.allowed.has("roles");

test("T-110 — a TEAM Personal Workspace owner is offered Roles & permissions", () => {
  assert.equal(offersRoles(settingsNav("TEAM")), true);
});

test("T-110 — FREE is not; SETTINGS_VIEW is still required; Enterprise still is", () => {
  assert.equal(offersRoles(settingsNav("FREE")), false);
  assert.equal(offersRoles(settingsNav("TEAM", {})), false);
  assert.equal(offersRoles(settingsNav("ENTERPRISE")), true);
});

// ===========================================================================
// T-115 — one Team-aware label
// ===========================================================================

test("T-115 — a TEAM owner's workspace with members is named, as a Team workspace, never 'Personal Space · Personal Space'", () => {
  const d = describeActiveWorkspace(personalEnvelope("TEAM", 3));
  assert.equal(d.kind, "TEAM_OWNER");
  assert.equal(d.name, "Dana Reyes's personal workspace");
  assert.equal(d.kindLabel, "Team workspace");
  assert.equal(d.roleLabel, "Owner");
  assert.notEqual(workspaceNameWithKind(d), "Personal Space · Personal Space");
  assert.equal(workspaceNameWithKind(d), "Dana Reyes's personal workspace · Team workspace");
});

test("T-115 — a member sees the owner's workspace name and their own role", () => {
  const d = describeActiveWorkspace(sharedEnvelope("TEAM"));
  assert.equal(d.kind, "SHARED");
  assert.equal(d.name, "Dana Reyes's workspace");
  assert.equal(d.kindLabel, "Team workspace");
  assert.equal(d.roleLabel, "Member");
});

test("T-115 — FREE solo Personal Space and a solo TEAM owner keep 'Personal Space'; Enterprise keeps its org label", () => {
  for (const env of [personalEnvelope("FREE", 1), personalEnvelope("FREE", 2), personalEnvelope("TEAM", 1)]) {
    const d = describeActiveWorkspace(env);
    assert.equal(d.kind, "PERSONAL_SOLO");
    assert.equal(d.name, "Personal Space");
    assert.equal(workspaceNameWithKind(d), "Personal Space");
  }
  const ent = describeActiveWorkspace(enterpriseEnvelope());
  assert.equal(ent.kind, "ORGANIZATION");
  assert.equal(ent.name, "Northwind Legal");
  assert.equal(ent.kindLabel, "Organization workspace");
  assert.equal(ent.teamWorkspace, false);
});

test("T-115 — the case breadcrumb names a TEAM owner's workspace the same way; FREE unchanged", () => {
  const team = { ...(personalEnvelope("TEAM", 3) as object), personalSpace: { id: WS } } as never;
  assert.equal(resolveCaseScopeLabel(WS, team), "Dana Reyes's personal workspace");
  const free = { ...(personalEnvelope("FREE", 1) as object), personalSpace: { id: WS } } as never;
  assert.equal(resolveCaseScopeLabel(WS, free), "Personal Space");
});

// ===========================================================================
// T-116 — Settings scope
// ===========================================================================

function settingsUi(envelope: never, plan: Plan) {
  const e = envelope as {
    activeSpace: { type: "PERSONAL" | "ORGANIZATION"; id: string; displayName: string; shared?: boolean };
  };
  return deriveSettingsUiContext({
    activeSpace: { ...e.activeSpace, shared: e.activeSpace.shared === true },
    workspacePlan: plan,
    accountPlan: e.activeSpace.type === "ORGANIZATION" ? "FREE" : plan,
    canManageBilling: true,
    canManageWorkspaceSettings: true,
    isEnterpriseWorkspace: plan === "ENTERPRISE",
    organizations:
      e.activeSpace.type === "ORGANIZATION"
        ? [{ id: ORG_WS, name: "Northwind Legal", membershipStatus: "ACTIVE", role: "OWNER", plan }]
        : [],
    planFeatures: features(plan),
    workspaceDescription: describeActiveWorkspace(envelope),
  });
}

test("T-116 — a TEAM owner's scope reads 'Team plan on your workspace', not 'Personal plan'", () => {
  const ui = settingsUi(personalEnvelope("TEAM", 3), "TEAM");
  assert.equal(ui.billing.scopeLabel, "Team plan on your workspace");
  assert.equal(ui.activeWorkspaceName, "Dana Reyes's personal workspace");
  // Team is a plan on a Personal Workspace, never a workspace kind.
  assert.equal(ui.workspaceTypeLabel, "Personal Workspace with members");
});

test("T-116 — FREE keeps 'Personal plan' / Personal Space; Enterprise keeps its agreement", () => {
  const free = settingsUi(personalEnvelope("FREE", 1), "FREE");
  assert.equal(free.billing.scopeLabel, "Personal plan");
  assert.equal(free.activeWorkspaceName, "Personal Space");
  assert.equal(free.workspaceTypeLabel, "Personal Workspace");
  const ent = settingsUi(enterpriseEnvelope(), "ENTERPRISE");
  assert.equal(ent.billing.scopeLabel, "Organization agreement");
  assert.equal(ent.activeWorkspaceName, "Northwind Legal");
  assert.equal(ent.workspaceTypeLabel, "Organization Workspace");
});
