/**
 * WEB-PARITY — the search console (apps/web/app/(app)/search/page.tsx,
 * components/SearchStates.tsx, components/SearchGuidance.tsx) on native.
 *
 * Stubs are the route's REAL replies (services/api/src/routes/search.routes.ts):
 *   GET /v1/search              :389  { rows, nextCursor, totalReturned, filteredByGovernance, filteredByVisibility, modeUsed, semanticAvailable, fallbackReason }
 *   GET /v1/search/saved-views  :424  { views: [projectView] }
 *   GET /v1/search/suggest      :869  { suggestions: [{ id, documentType, sourceId, title, subtitle, evidenceId, caseId, updatedAt }] }
 *   GET /v1/search/diagnostics  :1307 { workspace, readiness, …, queryProbe }
 *   403 from requireSearchActor :188  { error: { code: "permission_denied", … } }
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
const reply = (rows, over = {}) => ({
  rows, nextCursor: null, totalReturned: rows.length, filteredByGovernance: 0, filteredByVisibility: 0,
  modeUsed: "KEYWORD", semanticAvailable: false, fallbackReason: null, ...over,
});
const ROW = (id, title, over = {}) => ({
  documentId: `doc-${id}`, documentType: "EVIDENCE", sourceId: id, evidenceId: id, caseId: null, title, subtitle: null, summary: null,
  badges: [], updatedAtUtc: "2026-09-24T09:00:00.000Z", reviewState: null, workflowState: null, ...over,
});
const READY = { state: "READY", eligibleCount: 3, indexedCount: 3, outstandingCount: 0, shouldPoll: false, resultsAreComplete: true, canRecover: false };

before(async () => {
  M = await loadModule("app/(stack)/search.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  M.calls.reset();
  delete globalThis.__EXPO_PARAMS__;
  routes = {
    ...authenticatedRoutes(),
    "/v1/search/diagnostics": () => ({ workspace: { id: TEST_TEAM_ID, name: "Acme", isPersonal: false }, readiness: READY }),
    "/v1/search/saved-views": () => ({ views: [] }),
    "/v1/search/suggest": () => ({ suggestions: [] }),
    "/v1/search": () => reply([]),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path) : undefined;
    const status = res && res.__status ? res.__status : res ? 200 : 500;
    const body = res && res.__status ? res.body : res ?? { message: "unstubbed" };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async (ms = 0) => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, ms)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};
const searches = () => requests.filter((q) => q.path.startsWith("/v1/search?")).map((q) => new URL(`http://x${q.path}`).searchParams);
const submit = async (r, q) => {
  await r.type("Search query", q);
  await r.press("Search");
  await settle();
};

test("the page opens on the workspace listing (no q), headed and counted as the web", async () => {
  routes["/v1/search"] = () => reply([ROW("e1", "Roof photo")], { filteredByVisibility: 2 });
  const r = await render();
  const first = searches()[0];
  assert.ok(first, "native waited for a query the web never needs");
  assert.equal(first.has("q"), false);
  assert.equal(first.has("mode"), false, "a mode was sent the web never sends");
  assert.ok(r.hasText("Search evidence, cases, reports, notes and OCR text across this workspace. Results respect visibility and governance."));
  assert.ok(r.hasText("Deterministic match"));
  assert.ok(r.hasText("1 result") && r.hasText("no filters applied") && r.hasText("2 withheld by visibility"));
  assert.ok(r.hasText("Roof photo") && r.hasText("updated "));
  r.unmount();
});

test("an empty listing is the pristine state, beside the guidance panel", async () => {
  const r = await render();
  assert.ok(r.hasText("Search across this workspace"));
  assert.ok(r.hasText("Your recent searches will appear here.") && r.hasText("No saved searches yet.") && r.hasText("Search tips"));
  await r.press("Contact system admin");
  assert.equal(M.calls.push.at(-1), "/support");
  r.unmount();
});

test("a query that matches nothing names the workspace", async () => {
  const r = await render();
  await submit(r, "roof");
  assert.equal(searches().at(-1).get("q"), "roof");
  assert.ok(r.hasText('No matches in "Acme"') && r.hasText("Try a different filename, case name, report title, note, or record ID."));
  r.unmount();
});

test("typing does not search; submit does, and joins Recent searches (remove one / clear all)", async () => {
  const r = await render();
  const before = searches().length;
  await r.type("Search query", "roof");
  await settle(20);
  assert.equal(searches().length, before, "a keystroke fired a search");
  await r.press("Search");
  await settle();
  await submit(r, "gutter");
  // Recent searches in the guidance panel, most recent first.
  assert.ok(r.byLabel("Recent search: gutter").length === 1 && r.byLabel("Recent search: roof").length === 1);
  // The typeahead (field focused, < 2 chars) offers them with a per-entry remove.
  await r.type("Search query", "");
  await settle();
  await r.press('Remove search "roof"');
  await settle();
  assert.equal(r.byLabel("Recent search: roof").length, 0);
  await r.press("Search again: gutter");
  await settle();
  assert.equal(searches().at(-1).get("q"), "gutter");
  await r.type("Search query", "");
  await r.press("Clear all recent searches");
  await settle();
  assert.ok(r.hasText("Tip: try searching by filename, case name, or report title."));
  r.unmount();
});

test("typeahead suggestions carry their type; none says Enter still searches", async () => {
  routes["/v1/search/suggest"] = () => ({ suggestions: [{ id: "s1", documentType: "REPORT", sourceId: "r1", title: "Roof report", subtitle: null, evidenceId: "e1", caseId: null, updatedAt: "2026-09-24T09:00:00.000Z" }] });
  const r = await render();
  await r.type("Search query", "roo");
  await settle(300);
  assert.ok(requests.some((q) => q.path.startsWith("/v1/search/suggest?")));
  assert.ok(r.hasText("Suggestions") && r.hasText("Roof report"));
  await r.press("Suggestion: Roof report");
  await settle();
  assert.equal(searches().at(-1).get("q"), "Roof report");
  routes["/v1/search/suggest"] = () => ({ suggestions: [] });
  await r.type("Search query", "zzz");
  await settle(300);
  assert.ok(r.hasText("No matching titles. Press Enter to search anyway."));
  r.unmount();
});

test("Evidence kind and Document type chips are multi-select, as on the web", async () => {
  const r = await render();
  await r.press("Evidence kind: Photo");
  await settle();
  await r.press("Evidence kind: Audio");
  await settle();
  await r.press("Document type: Evidence");
  await settle();
  await r.press("Document type: Note");
  await settle();
  const p = searches().at(-1);
  assert.equal(p.get("evidenceTypes"), "PHOTO,AUDIO");
  assert.equal(p.get("documentTypes"), "EVIDENCE,NOTE");
  assert.ok(r.hasText("narrowed by 2 record types, 2 evidence kinds"));
  await r.press("Evidence kind: Photo");
  await settle();
  assert.equal(searches().at(-1).get("evidenceTypes"), "AUDIO");
  r.unmount();
});

test("Since is a draft applied with Until, as a local instant", async () => {
  const r = await render();
  await r.type("Since", "2026-08-01 09:00");
  await settle();
  await r.press("Apply filters");
  await settle();
  assert.equal(searches().at(-1).get("updatedSinceUtc"), new Date(2026, 7, 1, 9, 0).toISOString());
  assert.ok(r.hasText("an updated-date range"));
  r.unmount();
});

test("type-only narrowing that empties the list names the types that DID match (diagnostics probe)", async () => {
  routes["/v1/search/diagnostics"] = (path) => {
    const q = new URL(`http://x${path}`).searchParams.get("q");
    return { workspace: { id: TEST_TEAM_ID, name: "Acme", isPersonal: false }, readiness: READY, queryProbe: q ? { q, matchedTotal: 2, matchedByType: { EVIDENCE: 0, REPORT: 2 } } : null };
  };
  const r = await render();
  await r.press("Document type: Evidence");
  await settle();
  await submit(r, "roof");
  assert.ok(requests.some((q) => q.path === `/v1/search/diagnostics?teamId=${TEST_TEAM_ID}&q=roof`), "the probe was never asked for this query");
  assert.ok(r.hasText('No Evidence records match in "Acme"'));
  assert.ok(r.hasText("Report records DID match your search — clear the type filter to see them."));
  r.unmount();
});

test("a 403 is 'not available for this workspace' — no retry, no outage language", async () => {
  routes["/v1/search"] = () => ({ __status: 403, body: { error: { code: "permission_denied", reason: "x" } } });
  const r = await render();
  assert.ok(r.hasText("Search is not available for this workspace"));
  assert.equal(r.byLabel("Retry Connection").length, 0);
  assert.equal(r.hasText("Service Connection Interrupted"), false);
  r.unmount();
});

test("an outage (and a malformed 200) is the unavailable state + banner; Retry re-issues the same request", async () => {
  routes["/v1/search"] = () => ({ results: [], total: 0 });
  const r = await render();
  assert.ok(r.hasText("Search is temporarily unavailable") && r.hasText("Service Connection Interrupted"));
  assert.ok(r.hasText("No results to show"));
  routes["/v1/search"] = () => reply([ROW("e1", "Roof photo")]);
  const before = searches().length;
  await r.press("Retry Connection");
  await settle();
  assert.equal(searches().length, before + 1);
  assert.ok(r.hasText("Roof photo") && !r.hasText("Service Connection Interrupted"));
  r.unmount();
});

test("a failed Load more keeps the rows and reports the action, not a search outage", async () => {
  routes["/v1/search"] = (path) =>
    new URL(`http://x${path}`).searchParams.get("cursor")
      ? { __status: 500, body: { error: { code: "internal" } } }
      : reply([ROW("e1", "Roof photo")], { nextCursor: "cursor-page-2" });
  const r = await render();
  await r.press("Load more");
  await settle();
  assert.ok(r.hasText("Roof photo"), "the rows on screen were thrown away");
  assert.ok(r.byTestId("search-action-error").length > 0);
  assert.equal(r.hasText("Service Connection Interrupted"), false);
  r.unmount();
});

test("load more appends and adds the counts", async () => {
  routes["/v1/search"] = (path) =>
    new URL(`http://x${path}`).searchParams.get("cursor") === "cursor-page-2"
      ? reply([ROW("e2", "Gutter photo")])
      : reply([ROW("e1", "Roof photo")], { nextCursor: "cursor-page-2" });
  const r = await render();
  await r.press("Load more");
  await settle();
  assert.ok(r.hasText("Roof photo") && r.hasText("Gutter photo") && r.hasText("2 results"));
  r.unmount();
});

test("a saved search (GET /v1/search/saved-views) is listed and applies its query and filters", async () => {
  routes["/v1/search/saved-views"] = () => ({
    views: [{
      id: "v1", name: "Held roof photos", description: null, visibility: "TEAM", pinned: false, createdByUserId: "u1",
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", lastUsedAtUtc: null,
      query: { teamId: TEST_TEAM_ID, q: "roof", documentTypes: ["EVIDENCE"], evidenceTypes: ["PHOTO"], onLegalHold: true, sort: "UPDATED_ASC" },
    }],
  });
  const r = await render();
  assert.ok(r.hasText("Held roof photos") && r.hasText("Workspace"));
  await r.press("Saved search: Held roof photos");
  await settle();
  const p = searches().at(-1);
  assert.equal(p.get("q"), "roof");
  assert.equal(p.get("documentTypes"), "EVIDENCE");
  assert.equal(p.get("evidenceTypes"), "PHOTO");
  assert.equal(p.get("onLegalHold"), "true");
  assert.equal(p.get("sort"), "UPDATED_ASC");
  r.unmount();
});

test("How search works is a disclosure", async () => {
  const r = await render();
  assert.equal(r.hasText("Records you cannot access are counted above the results, never listed."), false);
  await r.press("Show how search works");
  assert.ok(r.hasText("Records you cannot access are counted above the results, never listed."));
  r.unmount();
});

test("a result card leads with its legal hold, then its signals and match reasons", async () => {
  routes["/v1/search"] = () => reply([ROW("e1", "Roof photo", { badges: ["review-linked", "legal-hold"], matchReasons: ["Matched title"], subtitle: "Signed", summary: "North-east corner." })]);
  const r = await render();
  const status = r.byTestId("search-result-status");
  assert.ok(status.length > 0 && r.texts().includes("Legal hold"));
  assert.ok(r.hasText("Review-linked") && r.hasText("Matched title") && r.hasText("Signed") && r.hasText("North-east corner."));
  r.unmount();
});

test("a /search?q= deep link runs that query, as the web honours it", async () => {
  globalThis.__EXPO_PARAMS__ = { q: "invoice" };
  const r = await render();
  assert.equal(searches()[0].get("q"), "invoice");
  delete globalThis.__EXPO_PARAMS__;
  r.unmount();
});
