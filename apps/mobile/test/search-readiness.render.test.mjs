/**
 * T-15 — search index readiness (GET /v1/search/diagnostics) and the owner's
 * rebuild (POST /v1/search/reconcile). Native showed "No results — Nothing
 * matched" while the workspace index was still being built or had stalled,
 * which reads as "your records are gone"; it never said so and offered no
 * recovery.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
const readiness = (over = {}) => ({
  readiness: {
    state: "STALLED", eligibleCount: 40, indexedCount: 12, outstandingCount: 28, unresolvedRemovals: 0,
    lastIndexedAtUtc: null, progressing: false, runStatus: "FAILED", runStartedAtUtc: null, runFinishedAtUtc: null,
    failureReason: null, degradedCapabilities: [], shouldPoll: false, resultsAreComplete: false, canRecover: true, ...over,
  },
});

const ROW = { documentId: "doc-1", documentType: "EVIDENCE", sourceId: "e1", evidenceId: "e1", title: "Roof photo", badges: [], updatedAtUtc: "2026-09-24T09:00:00.000Z" };

before(async () => {
  M = await loadModule("app/(stack)/search.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/search/diagnostics": () => readiness(),
    "/v1/search/reconcile": () => ({ status: "RUNNING" }),
    "/v1/search/suggest": () => ({ suggestions: [] }),
    // search.routes.ts:389 — the real reply. (This stub used to be
    // { results, total }, keys the route never sends.) One indexed row, so the
    // readiness NOTICE qualifies results on screen; with no rows the full
    // state panel owns the region instead (see the last test).
    "/v1/search": () => ({ rows: [ROW], nextCursor: null, totalReturned: 1, filteredByGovernance: 0, filteredByVisibility: 0, modeUsed: "KEYWORD", semanticAvailable: false, fallbackReason: null }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res ? 200 : 500, headers: { "content-type": "application/json" } });
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

test("a STALLED index is said, with the counts, and the owner can rebuild it", async () => {
  const r = await render();
  assert.ok(requests.some((q) => q.path === `/v1/search/diagnostics?teamId=${TEST_TEAM_ID}`), "readiness was never read");
  assert.ok(r.hasText("Indexing is not progressing"));
  assert.ok(r.hasText("12 of 40 records are searchable."));
  await r.press("Rebuild index");
  await settle();
  const post = requests.find((q) => q.method === "POST" && q.path === "/v1/search/reconcile");
  assert.deepEqual(post?.body, { teamId: TEST_TEAM_ID });
  assert.ok(r.hasText("Indexing started."));
});

test("an actor the server does not allow to recover gets the hint, never a dead button", async () => {
  routes["/v1/search/diagnostics"] = () => readiness({ canRecover: false });
  const r = await render();
  assert.equal(r.byLabel("Rebuild index").length, 0);
  assert.ok(r.hasText("Indexing retries automatically. Contact support if records stay missing."));
});

test("FAILED names the reason; PARTIAL says results may be incomplete; READY says nothing", async () => {
  routes["/v1/search/diagnostics"] = () => readiness({ state: "FAILED", failureReason: "WORKER_TIMEOUT" });
  let r = await render();
  assert.ok(r.hasText("The last indexing run did not finish") && r.hasText("Reason: WORKER_TIMEOUT."));
  assert.equal(r.byLabel("Retry indexing").length, 1);
  r.unmount();
  routes["/v1/search/diagnostics"] = () => readiness({ state: "PARTIAL", shouldPoll: false });
  r = await render();
  assert.ok(r.hasText("Indexing in progress — 12 of 40 records searchable."));
  r.unmount();
  routes["/v1/search/diagnostics"] = () => readiness({ state: "READY", resultsAreComplete: true });
  r = await render();
  assert.equal(r.byTestId("search-readiness").length, 0);
});

test("an older API with no readiness block says nothing about readiness", async () => {
  routes["/v1/search/diagnostics"] = () => ({ workspace: { id: TEST_TEAM_ID } });
  const r = await render();
  assert.equal(r.byTestId("search-readiness").length, 0);
});

test("STALLED with nothing listed: the panel owns the region — one heading, one rebuild control, no count", async () => {
  routes["/v1/search"] = () => ({ rows: [], nextCursor: null, totalReturned: 0, filteredByGovernance: 0, filteredByVisibility: 0 });
  const r = await render();
  assert.ok(r.hasText("Search indexing is not progressing"));
  assert.ok(r.hasText("12 of 40 records in this workspace are searchable, and no indexing run is currently making progress. Rebuilding will index the outstanding records."));
  assert.equal(r.byTestId("search-readiness").length, 0, "the notice stacked a second rebuild control over the panel");
  assert.equal(r.byLabel("Rebuild index").length, 1);
  assert.equal(r.byTestId("search-results-head").length, 0, "a count was printed beside a stopped index");
  await r.press("Rebuild index");
  await settle();
  assert.ok(r.hasText("Indexing started."));
  r.unmount();
});

test("INITIALIZING / EMPTY_WORKSPACE with nothing listed say so, named, never No results", async () => {
  routes["/v1/search"] = () => ({ rows: [], nextCursor: null, totalReturned: 0, filteredByGovernance: 0, filteredByVisibility: 0 });
  routes["/v1/search/diagnostics"] = () => ({ ...readiness({ state: "INITIALIZING", indexedCount: 3, eligibleCount: 9 }), workspace: { id: TEST_TEAM_ID, name: "Acme", isPersonal: false } });
  let r = await render();
  assert.ok(r.hasText("Preparing workspace search…") && r.hasText("3 of 9 records are searchable so far. This page updates on its own."));
  r.unmount();
  routes["/v1/search/diagnostics"] = () => ({ ...readiness({ state: "EMPTY_WORKSPACE" }), workspace: { id: TEST_TEAM_ID, name: "Acme", isPersonal: false } });
  r = await render();
  assert.ok(r.hasText("No searchable records yet in \"Acme\""));
  r.unmount();
});
