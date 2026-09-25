/**
 * Collaboration Teams list ↔ web collaboration-teams/page.tsx parity: the
 * header and its Members & Access handoff, the governance notice for a
 * GRANTED workspace scope, each row's status / type / last activity and its
 * overflow actions, the two empty states, the load error, create → open the
 * new team, the TEAM_LIMIT_REACHED sentence and the billing-restricted reason.
 * Real reply shapes:
 *   GET  /v1/collaboration-teams              → { teams, nextCursor, scope, rollup, canGovernWorkspace }
 *   GET  /v1/collaboration-teams/entitlement  → collaboration-entitlement.service.ts:222
 *   POST /v1/collaboration-teams              → 201 { team: { id } } | { error: { code, message, details } }
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests;
let routes;

const ENT = { canCreateCollaborationTeam: true, featureIncluded: true, mutationsAllowed: true, plan: "TEAM", collaborationTeams: { used: 1, limit: 5 } };
const TEAMS = [
  { id: "t1", name: "Claims", description: "Water damage", status: "ACTIVE", teamType: "INVESTIGATION", memberCount: 3, viewerRole: "LEAD", lastActivityAt: null },
  { id: "t2", name: "Old", status: "ARCHIVED", teamType: "GENERAL", memberCount: 1, viewerRole: null, lastActivityAt: "2026-09-01T00:00:00Z" },
];

before(async () => {
  M = await loadModule("app/(tabs)/teams.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/product/collaboration.ts"]);
});
beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/collaboration-teams/entitlement": () => ENT,
    "/v1/collaboration-teams": (method) =>
      method === "POST" ? { __status: 201, team: { id: "t-new" } } : { teams: TEAMS, nextCursor: null, scope: "ALL", rollup: null, canGovernWorkspace: true },
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
  M.calls.reset();
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

test("the header names the page, hands off to Members & Access, and states a granted workspace view", async () => {
  const r = await render();
  assert.ok(r.hasText("Collaboration Teams"));
  assert.ok(r.texts().some((t) => t.includes("Teams group members who already have access — they do not grant it.")));
  assert.ok(r.texts().some((t) => t.startsWith("Showing every Team in this workspace.")));
  await r.press("Manage members & access");
  assert.equal(M.calls.push.at(-1), "/(stack)/workspace-people");
  r.unmount();
});

test("each row says its status, type and activity; the overflow opens the team on the right section", async () => {
  const r = await render();
  assert.ok(r.hasText("Archived") && r.hasText("Investigation") && r.hasText("No activity yet"));
  assert.ok(r.hasText("Water damage"));
  await r.press("More actions for Claims");
  await r.press("Add people");
  assert.equal(M.calls.push.at(-1), "/collaboration-team/t1?tab=members");
  await r.press("More actions for Claims");
  await r.press("Settings");
  assert.equal(M.calls.push.at(-1), "/collaboration-team/t1?tab=settings");
  r.unmount();
});

test("a filter that hides every team offers the reset; an empty workspace offers Create team", async () => {
  const r = await render();
  await r.press("Filter by team type: Compliance");
  assert.ok(r.hasText("No teams match the current filters"));
  await r.press("Show all teams");
  assert.ok(r.hasText("Claims"));
  r.unmount();
  routes["/v1/collaboration-teams"] = () => ({ teams: [], nextCursor: null, scope: "PARTICIPATING", rollup: null, canGovernWorkspace: false });
  const r2 = await render();
  assert.ok(r2.hasText("No teams yet"));
  assert.equal(r2.byLabel("Create team").length, 1);
  r2.unmount();
});

test("a created team is opened, as the web does", async () => {
  const r = await render();
  await r.press("Create Team");
  await r.type("Team name", "Fraud");
  await r.press("Template: Legal");
  assert.ok(r.texts().some((t) => t.startsWith("Matter & disclosure.")));
  await r.press("Submit new team");
  await settle();
  const post = requests.find((q) => q.method === "POST");
  assert.deepEqual(post.body, { name: "Fraud", teamType: "LEGAL" });
  assert.equal(M.calls.push.at(-1), "/collaboration-team/t-new");
  r.unmount();
});

test("TEAM_LIMIT_REACHED is said with the server's own limit", async () => {
  routes["/v1/collaboration-teams"] = (method) =>
    method === "POST"
      ? { __status: 409, error: { code: "TEAM_LIMIT_REACHED", message: "limit", details: { limit: 2, plan: "PRO" } } }
      : { teams: TEAMS, nextCursor: null, canGovernWorkspace: false };
  const r = await render();
  await r.press("Create Team");
  await r.type("Team name", "Fraud");
  await r.press("Submit new team");
  await settle();
  assert.ok(r.hasText("Your Pro plan includes up to 2 Teams. Upgrade to create another Team."));
  r.unmount();
});

test("a billing-restricted workspace is told why it cannot create, and a load failure is named", async () => {
  routes["/v1/collaboration-teams/entitlement"] = () => ({ ...ENT, canCreateCollaborationTeam: false, mutationsAllowed: false });
  const r = await render();
  assert.ok(r.hasText("This workspace's billing needs attention before new Teams can be created."));
  r.unmount();
  routes["/v1/collaboration-teams"] = () => ({ __status: 500, error: { code: "INTERNAL", requestId: "req-9" } });
  const r2 = await render();
  assert.ok(r2.hasText("Couldn't load Teams"));
  r2.unmount();
});
