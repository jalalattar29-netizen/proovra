/**
 * T-15 / T-14 — the search result Inspector and GET /v1/search/relationships.
 * Native results were bare rows: only Evidence/Case were tappable (Report,
 * Intake link and Note rows did nothing although they are offered as filters),
 * and a record's signals, lifecycle and related evidence were never shown.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
const EV = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ROWS = [
  {
    documentId: "doc-ev", documentType: "EVIDENCE", sourceId: EV, evidenceId: EV, caseId: null, title: "Roof photo",
    subtitle: "Signed", summary: "North-east corner, water ingress.", updatedAtUtc: "2026-09-24T09:00:00.000Z",
    badges: ["legal-hold", "review-linked"], reviewState: "IN_REVIEW", workflowState: null, exportState: "RESTRICTED",
    retentionState: null, legalHoldState: "ACTIVE", semanticScore: 0,
  },
  { documentId: "doc-rp", documentType: "REPORT", sourceId: "rp-1", evidenceId: EV, title: "Report v3", badges: [] },
  { documentId: "doc-il", documentType: "INTAKE_LINK", sourceId: "link-9", title: "Claim 4842 request", badges: [] },
];

before(async () => {
  M = await loadModule("app/(stack)/search.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  M.calls.reset();
  routes = {
    ...authenticatedRoutes(),
    "/v1/search/diagnostics": () => ({ readiness: { state: "READY", resultsAreComplete: true, canRecover: false, eligibleCount: 3, indexedCount: 3, outstandingCount: 0 } }),
    "/v1/search/suggest": () => ({ suggestions: [] }),
    "/v1/search/relationships/": () => ({
      relationships: [{ relationshipId: "rel-1", sourceEvidenceId: OTHER, targetEvidenceId: EV, relationshipType: "DERIVED_FROM", note: "Cropped copy", createdByUserId: null, createdAt: "2026-09-20T00:00:00Z" }],
    }),
    "/v1/search": () => ({ rows: ROWS, nextCursor: null, totalReturned: 3, filteredByGovernance: 0, filteredByVisibility: 0, modeUsed: "KEYWORD", semanticAvailable: false, fallbackReason: null }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res ? 200 : 500, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async (ms = 0) => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, ms)); });
};
const search = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.type("Search query", "roof");
  await r.press("Search");
  await settle();
  return r;
};

test("selecting a result opens its Inspector: signals, pointers, lifecycle, summary, related evidence", async () => {
  const r = await search();
  await r.press("Roof photo");
  await settle();
  assert.ok(requests.some((q) => q.path === `/v1/search/relationships/${EV}?teamId=${TEST_TEAM_ID}`), "relationships were never read");
  assert.ok(r.byTestId("search-inspector").length > 0);
  assert.ok(r.hasText("Legal hold") && r.hasText("Review-linked"), "signals not shown in words");
  assert.ok(r.hasText("In review") && r.hasText("Restricted") && r.hasText("Active"), "lifecycle facts missing");
  assert.ok(r.hasText("North-east corner, water ingress."));
  assert.ok(r.hasText("DERIVED_FROM") && r.hasText(OTHER) && r.hasText("Cropped copy"), "the OTHER record of the relationship not shown");
  await r.press("Open evidence");
  assert.equal(M.calls.push.at(-1), `/evidence/${EV}`);
});

test("report and intake-link results are no longer dead rows", async () => {
  let r = await search();
  await r.press("Report v3");
  await settle();
  await r.press("Open report");
  assert.equal(M.calls.push.at(-1), `/evidence/${EV}`);
  r.unmount();
  r = await search();
  await r.press("Claim 4842 request");
  await settle();
  assert.ok(!requests.some((q) => q.path.startsWith("/v1/search/relationships/") && q.path.includes("link-9")));
  await r.press("Open request");
  assert.deepEqual(M.calls.push.at(-1), { pathname: "/intake-links", params: { linkId: "link-9" } });
});

test("a failed relationships read says 'No related evidence.', never an error wall", async () => {
  delete routes["/v1/search/relationships/"];
  const r = await search();
  await r.press("Roof photo");
  await settle();
  assert.ok(r.hasText("No related evidence."));
});
