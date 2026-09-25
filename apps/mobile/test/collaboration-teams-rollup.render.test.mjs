/**
 * T-14 — collaboration-teams list (collaboration-teams/page.tsx:492-570, 820,
 * 1540, 1422/1598): the workspace rollup band, the per-group work counts, the
 * optional Description on create, and a create failure that is actually shown
 * (with its request id). A failed create used to set the page error, which
 * only renders in the error phase — so it vanished.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
const ROLLUP = {
  groups: { active: 3, withOpenWork: 2 },
  work: { open: 14, unassigned: 4, overdue: 2, highPriority: 3, attention: 5, dueSoon: 1 },
  workload: { people: 6, busiest: { userId: "u1", open: 7, overdue: 1 } },
};

before(async () => {
  M = await loadModule("app/(tabs)/teams.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/product/collaboration.ts"]);
});
beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/collaboration-teams/entitlement": () => ({ canCreateCollaborationTeam: true, featureIncluded: true, plan: "TEAM", collaborationTeams: { used: 1, limit: 5 } }),
    "/v1/collaboration-teams": (method) =>
      method === "POST"
        ? { __status: 409, error: { code: "TEAM_NAME_TAKEN", message: "A group with that name exists.", requestId: "req-abc-123" } }
        : { teams: [{ id: "a", name: "Claims", status: "ACTIVE", memberCount: 4, openAssignmentCount: 5, overdueAssignmentCount: 2, highPriorityAssignmentCount: 1 }], nextCursor: null, canGovernWorkspace: true, rollup: ROLLUP },
    "/v1/me/inbox/summary": () => ({ unread: 0 }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](method) : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? {}), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};

test("the workspace rollup band and each group's open / overdue / high counts", async () => {
  const r = await render();
  assert.equal(r.byLabel("Open work: 14. across 2 of 3 Teams").length, 1);
  assert.equal(r.byLabel("Unassigned: 4. held by a Team, not by a person").length, 1);
  assert.equal(r.byLabel("Needs attention: 5. 2 overdue · 3 high priority").length, 1);
  assert.equal(r.byLabel("People carrying work: 6. heaviest load 7 open").length, 1);
  assert.ok(r.texts().some((t) => t.includes("4 members · 5 open · 2 overdue · 1 high")), "the group row lost its work counts");
});

test("a participation-scoped response (no rollup) hides the band", async () => {
  routes["/v1/collaboration-teams"] = () => ({ teams: [], nextCursor: null, canGovernWorkspace: false, rollup: null });
  const r = await render();
  assert.equal(r.byTestId("teams-rollup").length, 0);
});

test("create carries the optional description, and a failure is shown with its request id", async () => {
  const r = await render();
  await r.press("Create Team");
  await r.type("Team name", "Claims");
  await r.type("Description (optional)", "Water-damage claims");
  await r.press("Submit new team");
  await settle();
  const post = requests.find((q) => q.method === "POST" && q.path === "/v1/collaboration-teams");
  assert.equal(post.body.description, "Water-damage claims");
  assert.ok(r.hasText("Support reference") && r.hasText("req-abc-123"), "the failure vanished instead of being shown with its support reference");
});

test("the plan's group capacity is shown, with Upgrade at the limit (PlanLimitBadge)", async () => {
  let r = await render();
  assert.ok(r.hasText("TEAM plan · 1 of 5 teams used"), "the capacity read the server's collaborationTeams");
  assert.equal(r.byLabel("Upgrade").length, 0);
  r.unmount();
  routes["/v1/collaboration-teams/entitlement"] = () => ({ canCreateCollaborationTeam: false, featureIncluded: true, plan: "TEAM", collaborationTeams: { used: 5, limit: 5 }, exceededDimensions: ["COLLABORATION_TEAMS"] });
  r = await render();
  assert.ok(r.hasText("TEAM plan · 5 of 5 teams used"));
  assert.ok(r.hasText("Your TEAM plan allows up to 5 active Teams. Upgrade to add more."));
  assert.equal(r.byLabel("Upgrade").length, 1);
  r.unmount();
  routes["/v1/collaboration-teams/entitlement"] = () => ({ canCreateCollaborationTeam: false, featureIncluded: false, plan: "FREE", collaborationTeams: { used: 0, limit: 0 } });
  r = await render();
  assert.ok(r.hasText("Teams are available on Pro, Team, and Enterprise plans. Existing Teams and their data remain accessible."));
  assert.equal(r.byLabel("Upgrade plan").length, 1);
});
