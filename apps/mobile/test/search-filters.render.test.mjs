/**
 * T-14 — search filter panel (search/page.tsx:2042 Lifecycle, :2097 Until,
 * :2134 Clear filters). Native had no lifecycle toggles, no upper date bound,
 * and no one-tap reset. Each toggle is a server `parseBool` param; Until is a
 * draft that only Apply sends, as on the web.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
before(async () => {
  M = await loadModule("app/(stack)/search.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  const routes = {
    ...authenticatedRoutes(),
    "/v1/search/diagnostics": () => ({ readiness: { state: "READY", resultsAreComplete: true, canRecover: false, eligibleCount: 1, indexedCount: 1, outstandingCount: 0 } }),
    "/v1/search/suggest": () => ({ suggestions: [] }),
    // search.routes.ts:389 — the reply the route actually sends.
    "/v1/search": () => ({ rows: [], nextCursor: null, totalReturned: 0, filteredByGovernance: 0, filteredByVisibility: 0, modeUsed: "KEYWORD", semanticAvailable: false, fallbackReason: null }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push(path);
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    return new Response(JSON.stringify(key ? routes[key]() : { message: "unstubbed" }), { status: key ? 200 : 500, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const lastSearch = () => new URL(`http://x${requests.filter((p) => p.startsWith("/v1/search?")).at(-1)}`).searchParams;
const toggle = async (r, label, v) => {
  await act(async () => { r.byLabel(label).find((n) => n.props.onValueChange).props.onValueChange(v); });
  await settle();
};
const search = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.type("Search query", "roof");
  await r.press("Search");
  await settle();
  return r;
};

test("lifecycle toggles reach the query as true, and only while on", async () => {
  const r = await search();
  await toggle(r, "On legal hold", true);
  await toggle(r, "Contributor-scoped", true);
  let p = lastSearch();
  assert.equal(p.get("onLegalHold"), "true");
  assert.equal(p.get("contributorScoped"), "true");
  assert.equal(p.get("workflowLinked"), null);
  await toggle(r, "On legal hold", false);
  p = lastSearch();
  assert.equal(p.get("onLegalHold"), null, "an off toggle still narrowed the search");
});

test("Until is sent only on Apply, as a local instant", async () => {
  const r = await search();
  const before = requests.length;
  await r.type("Until", "2026-09-01 18:30");
  await settle();
  assert.equal(requests.filter((p, i) => i >= before && p.startsWith("/v1/search?")).length, 0, "a draft date fired a search");
  await r.press("Apply filters");
  await settle();
  assert.equal(lastSearch().get("updatedUntilUtc"), new Date(2026, 8, 1, 18, 30).toISOString());
});

test("Clear filters resets every narrowing dimension and keeps the query", async () => {
  const r = await search();
  await toggle(r, "Export-restricted", true);
  await r.type("Until", "2026-09-01 18:30");
  await r.press("Apply filters");
  await settle();
  await r.press("Clear filters");
  await settle();
  const p = lastSearch();
  assert.equal(p.get("q"), "roof");
  assert.equal(p.get("exportRestricted"), null);
  assert.equal(p.get("updatedUntilUtc"), null);
  assert.equal(r.byLabel("Clear filters").length, 0, "Clear stayed with nothing to clear");
});

test("no results under a filter offers Clear filters in the empty state itself", async () => {
  const r = await search();
  await toggle(r, "On legal hold", true);
  assert.ok(r.hasText("No matches with the current filters"));
  const clears = r.byLabel("Clear filters").filter((n) => n.props.onPress);
  assert.equal(clears.length, 2, "the no-results state offered no way out");
  await act(async () => { clears.at(-1).props.onPress(); });
  await settle();
  assert.equal(lastSearch().get("onLegalHold"), null);
});
