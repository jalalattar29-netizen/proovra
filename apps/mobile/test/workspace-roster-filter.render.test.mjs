/**
 * T-12 / RC-13 — the workspace roster's status filter and search
 * (WorkspaceMembersPanel.tsx:326). Native listed every member with no way to
 * narrow a large roster; the builder only knew `cursor`.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let membersFor = () => [{ id: "m1", userId: "u1", role: "OWNER", status: "ACTIVE", user: { displayName: "Owner", email: "o@x.io" } }];

before(async () => {
  M = await loadModule("app/(stack)/workspace-people.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  const routes = {
    ...authenticatedRoutes(),
    "/v1/teams/team-1/members": (path) => ({ members: membersFor(path), nextCursor: null }),
    "/v1/teams/team-1/invites": () => ({ invites: [] }),
    "/v1/teams/team-1/cases": () => ({ items: [] }),
    "/v1/teams/team-1/activity": () => ({ activities: [] }),
    "/v1/teams/team-1/closure": () => ({}),
    "/v1/teams/team-1": () => ({ id: "team-1", name: "Acme", canManageMembers: true, stats: { memberCount: 1 } }),
    "/v1/me/inbox/summary": () => ({ unread: 0 }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push(path);
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    return new Response(JSON.stringify(key ? routes[key](path) : {}), { status: key ? 200 : 500, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});

const settle = async (n = 3) => {
  for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const lastMembers = () => requests.filter((p) => p.startsWith("/v1/teams/team-1/members")).at(-1);

test("the status filter and search reach the server roster query", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle(5);
  await r.press("Filter members by status: Suspended");
  await settle();
  assert.match(lastMembers(), /[?&]status=SUSPENDED(&|$)/);
  await r.type("Search by name or email", "dana");
  await act(async () => { await new Promise((x) => setTimeout(x, 700)); });
  await settle();
  assert.match(lastMembers(), /[?&]q=dana(&|$)/);
  await r.press("Filter members by status: All statuses");
  await settle();
  assert.doesNotMatch(lastMembers(), /status=/, "ALL is omitted, as on the web");
});

test("a filter that matches nobody says so, not 'No members are listed.'", async () => {
  membersFor = (path) => (path.includes("status=SUSPENDED") ? [] : [{ id: "m1", role: "OWNER", status: "ACTIVE", user: { displayName: "Owner" } }]);
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle(5);
  await r.press("Filter members by status: Suspended");
  await settle();
  assert.ok(r.hasText("Nobody here matches that"));
  assert.ok(r.hasText("Try a different name, address or status."));
});
