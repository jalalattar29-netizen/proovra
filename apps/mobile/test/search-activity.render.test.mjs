/**
 * T-15 — Search activity (GET /v1/search/audit) beside Records on native
 * search. Native had no way to see who searched the workspace, what came back
 * and what governance or visibility withheld.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
const ROW = (over) => ({
  id: "a1", teamId: TEST_TEAM_ID, actorUserId: "user-1234567890", surface: "search_console", queryHash: "9f3a1c", queryLength: 12,
  documentTypes: null, filters: null, resultCount: 7, filteredGovernanceCount: 2, filteredVisibilityCount: 1, failClosed: true,
  requestId: null, occurredAtUtc: "2026-09-24T09:00:00.000Z", ...over,
});

before(async () => {
  M = await loadModule("app/(stack)/search.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/search/diagnostics": () => ({ readiness: { state: "READY", resultsAreComplete: true, canRecover: false } }),
    "/v1/search/audit": () => ({ rows: [ROW({}), ROW({ id: "a2", teamId: "another-team" })], nextBeforeUtc: "2026-09-23T00:00:00.000Z" }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path) : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const openActivity = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Search console scope: Search activity");
  await settle();
  return r;
};
const audits = () => requests.filter((q) => q.path.startsWith("/v1/search/audit"));

test("the log is read for this workspace; fingerprints only; another workspace's row is dropped", async () => {
  const r = await openActivity();
  assert.equal(audits()[0].path, `/v1/search/audit?teamId=${TEST_TEAM_ID}&limit=50`);
  assert.ok(r.hasText("9f3a1c · 12 chars"));
  assert.ok(r.hasText("Returned 7 · Withheld 3") && r.hasText("Results withheld"));
  assert.equal(r.byTestId("search-activity-panel")[0].findAll((n) => n.props?.children === "Person user-123… · search_console").length > 0, true);
  assert.equal(r.texts().filter((t) => t === "Returned 7 · Withheld 3").length, 1, "a row claiming another workspace was rendered");
  await r.press("Load more");
  await settle();
  assert.ok(audits().some((q) => q.path.endsWith(`&beforeUtc=${encodeURIComponent("2026-09-23T00:00:00.000Z")}`)));
});

test("'Withheld results only' is the server's filter", async () => {
  const r = await openActivity();
  const sw = r.byLabel("Withheld results only").find((n) => n.props.onValueChange);
  await act(async () => { sw.props.onValueChange(true); });
  await settle();
  assert.ok(audits().some((q) => q.path === `/v1/search/audit?teamId=${TEST_TEAM_ID}&limit=50&failClosedOnly=true`));
});

test("403 is the server's refusal, with no retry", async () => {
  routes["/v1/search/audit"] = () => ({ __status: 403 });
  const r = await openActivity();
  assert.ok(r.hasText("You do not have permission to read this workspace's search activity. An owner, admin, or reviewer can open it."));
  assert.equal(r.byLabel("Try again").length, 0);
});
