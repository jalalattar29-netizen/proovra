/**
 * T-12 / RC-13 — the collaboration-teams list filters
 * (collaboration-teams/page.tsx:738-766).
 *
 * Native called a bare `/v1/collaboration-teams`: archived teams never
 * appeared, a governor only ever saw their own teams, and there was no type
 * filter, sort or search.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let listBody = () => ({ teams: TEAMS, nextCursor: null, canGovernWorkspace: true });
const TEAMS = [
  { id: "a", name: "Zulu", status: "ACTIVE", teamType: "LEGAL", memberCount: 2, lastActivityAt: "2026-09-01T00:00:00Z" },
  { id: "b", name: "Alpha", status: "ARCHIVED", teamType: "GENERAL", memberCount: 9, lastActivityAt: "2026-09-20T00:00:00Z" },
  { id: "c", name: "Mike", status: "ACTIVE", teamType: "GENERAL", memberCount: 5, lastActivityAt: "2026-09-10T00:00:00Z" },
];

before(async () => {
  M = await loadModule("app/(tabs)/teams.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/product/collaboration.ts"]);
});
beforeEach(async () => {
  requests = [];
  const routes = {
    ...authenticatedRoutes(),
    "/v1/collaboration-teams/entitlement": () => ({}),
    "/v1/collaboration-teams": () => listBody(),
    "/v1/me/inbox/summary": () => ({ unread: 0 }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push(path);
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    return new Response(JSON.stringify(key ? routes[key]() : {}), { status: key ? 200 : 500, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});

const settle = async (n = 4) => {
  for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const lastList = () => requests.filter((p) => /^\/v1\/collaboration-teams(\?|$)/.test(p)).at(-1);

test("a governor defaults to the whole workspace, once, and the scope reaches the server", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  assert.match(lastList(), /scope=all/, "a governor should land on the workspace they govern");
  await r.press("Which teams to show: My teams");
  await settle();
  assert.doesNotMatch(lastList(), /scope=all/, "choosing My teams must stick");
});

test("status ALL or ARCHIVED asks the server for archived teams; type and sort apply to the page", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Filter by status: All statuses");
  await settle();
  assert.match(lastList(), /includeArchived=true/);
  await r.press("Filter by team type: General");
  await r.press("Sort teams: Name (A–Z)");
  const names = r.root.findAll((n) => typeof n.type === "string" && n.props?.accessibilityRole === "button" && ["Zulu", "Alpha", "Mike"].includes(n.props.accessibilityLabel)).map((n) => n.props.accessibilityLabel);
  assert.deepEqual(names, ["Alpha", "Mike"]);
});

test("search reaches the server as q", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.type("Search teams…", "fraud");
  await act(async () => { await new Promise((x) => setTimeout(x, 700)); });
  await settle();
  assert.match(lastList(), /[?&]q=fraud(&|$)/);
});

test("a non-governor is not offered the scope filter", async () => {
  listBody = () => ({ teams: TEAMS, nextCursor: null, canGovernWorkspace: false });
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  assert.equal(r.byLabel("Which teams to show: All workspace teams").length, 0);
});
