/**
 * Team remediation — mobile surfaces of a Team workspace. Team is a
 * PERSONAL-workspace tier (never the ORGANIZATION kind), so:
 *
 *   T-109  Home "Team work" shows in a TEAM PERSONAL workspace with members
 *          (gated on `planFeatures.teamCollaborationIncluded` plus the active
 *          workspace's member count); FREE and a solo owner do not see it;
 *          the ORGANIZATION path is unchanged.
 *   T-115  the header names a Team owner's workspace with members Team-aware,
 *          never "Personal Space"; a member sees the owner's workspace name.
 *   T-121  "Team" names the plan only: the groups screen is "Collaboration
 *          Teams" in navigation and on the Home action that opens it.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let N;
let routes = {};
let envelope;

const TEAM_PERSONAL = (memberCount = 2) => ({
  activeSpace: { id: "ws-own", type: "PERSONAL", plan: "TEAM", displayName: "Personal Space", roleLabel: "Owner", status: "active", shared: false },
  workspace: { id: "ws-own", status: "active", membership: { role: "OWNER", memberCount } },
  planFeatures: { teamCollaborationIncluded: true, casesIncluded: true },
  capabilities: {},
  flags: { isEnterpriseWorkspace: false },
  organizations: [],
  personalSpaceAllowed: true,
});

const FREE_PERSONAL = () => ({
  activeSpace: { id: "ws-free", type: "PERSONAL", plan: "FREE", displayName: "Personal Space", roleLabel: "Owner", status: "active", shared: false },
  workspace: { id: "ws-free", status: "active", membership: { role: "OWNER", memberCount: 1 } },
  planFeatures: { teamCollaborationIncluded: false, casesIncluded: false },
  capabilities: {},
  flags: { isEnterpriseWorkspace: false },
  organizations: [],
  personalSpaceAllowed: true,
});

before(async () => {
  M = await loadModule("app/(tabs)/index.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/ui/header.tsx"]);
  N = await loadModule("src/product/navigation.ts", []);
});
beforeEach(async () => {
  envelope = TEAM_PERSONAL();
  routes = {
    ...authenticatedRoutes({ "/v1/platform/context": () => envelope }),
    "/v1/evidence": () => ({ items: [] }),
    "/v1/dashboard/command-center": () => ({ sections: {} }),
    "/v1/dashboard/trust-summary": () => ({ totalEvidence: 3, intake: { submissionsAwaitingReview: 4 } }),
    "/v1/billing/overview": () => ({}),
    "/v1/reports": () => ({ items: [], nextCursor: null }),
    "/v1/workflow/intake-links": () => ({ links: [] }),
    "/v1/me/inbox": () => ({ items: [] }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res === undefined ? 500 : 200, headers: { "content-type": "application/json" } });
  };
  M.calls.reset();
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const renderHome = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Workspace views: Analytics");
  return r;
};
const renderHeader = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.ProovraHeader, {})));
  await settle();
  return r;
};

test("T-109: a TEAM PERSONAL workspace with 2 members shows Team work with its member count", async () => {
  const r = await renderHome();
  assert.ok(r.hasText("Team work"), "Team work hidden from a Team workspace (gated on ORGANIZATION)");
  assert.ok(r.hasText("Members"));
  assert.ok(r.texts().includes("2"), "the active workspace's member count was not shown");
  assert.ok(r.texts().includes("4"), "awaiting review missing");
  // The envelope carries no invitation count for a personal workspace: not shown as 0.
  assert.equal(r.hasText("Pending invites"), false);
});

test("T-109: FREE does not show Team work, nor does a solo Team owner", async () => {
  envelope = FREE_PERSONAL();
  let r = await renderHome();
  assert.equal(r.hasText("Team work"), false, "FREE shows Team work");
  r.unmount();
  envelope = TEAM_PERSONAL(1);
  r = await renderHome();
  assert.equal(r.hasText("Team work"), false, "a Team owner with nobody else shows Team work");
});

test("T-121: the Team work action names the groups screen Collaboration Teams, not 'team'", async () => {
  const r = await renderHome();
  assert.equal(r.byLabel("Manage team").length, 0, "the groups screen is called 'team'");
  await r.press("Collaboration Teams");
  assert.equal(M.calls.push.at(-1), "/teams");
});

test("T-121: navigation never names the groups or the members screen just 'Team(s)'", () => {
  const labels = N.NATIVE_NAV_ROUTES.map((r) => r.label);
  for (const label of labels) {
    if (/\bteams?\b/i.test(label)) assert.equal(label, "Collaboration Teams", `"${label}" uses Team for something other than the plan`);
  }
  const groups = N.NATIVE_NAV_ROUTES.find((r) => r.href === "/teams");
  assert.equal(groups.label, "Collaboration Teams");
  const people = N.NATIVE_NAV_ROUTES.find((r) => r.href === "/workspace-people");
  assert.equal(people.label, "Members & Access");
});

test("T-115: the header names a Team owner's workspace with members, not 'Personal Space'", async () => {
  const r = await renderHeader();
  assert.equal(r.byTestId("header-workspace").length >= 1, true);
  assert.ok(r.hasText("Your Team workspace"), "the header still reads the kind label");
  assert.equal(r.hasText("Personal Space"), false);
});

test("T-115: a member sees the owner's workspace name; FREE keeps Personal Space", async () => {
  envelope = {
    ...TEAM_PERSONAL(3),
    activeSpace: { id: "ws-dana", type: "PERSONAL", plan: "TEAM", displayName: "Dana Reyes's personal workspace", roleLabel: "MEMBER", status: "active", shared: true },
    workspace: { id: "ws-dana", membership: { role: "MEMBER", memberCount: 3 } },
  };
  let r = await renderHeader();
  assert.ok(r.hasText("Dana Reyes's personal workspace"));
  r.unmount();
  envelope = FREE_PERSONAL();
  r = await renderHeader();
  assert.ok(r.hasText("Personal Space"));
});
