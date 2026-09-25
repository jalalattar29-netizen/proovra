/**
 * GUARD — canonical native global search logic (Master Program §10, N1).
 *
 * buildSearchPath must refuse to fetch without a workspace teamId (a blank
 * query lists the workspace, as on the web), always include teamId (the endpoint 400s without it), and
 * resolveSearchResultRoute must only produce routes native actually has — never a
 * dead link. Pure module → transpile-and-import (stub the domain-display import).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/search.ts"), "utf8")
  .replace(/^import type .*$/m, "")
  // Inline a tiny humanizeEnum stand-in for the domain-display import.
  .replace(/^import \{ humanizeEnum \}.*$/m, "function humanizeEnum(v){return v;}");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);


const ROUTE = readFileSync(resolve(HERE, "../../../services/api/src/routes/search.routes.ts"), "utf8");
const qs = (path) => new URL(`https://h${path}`).searchParams;

/*
 * CORRECTIONS (web-parity pass, 2026-09-25). Earlier versions of this file
 * asserted behaviour the web console does not have and a reply key the route
 * never sends:
 *   - a blank query was "idle, no fetch" — the web runs the workspace listing
 *     with no `q` (search/page.tsx runSearch) and lists recent records;
 *   - `mode=KEYWORD` was always sent — the web sends a mode only when it is not
 *     the server default, and no longer offers a mode control at all;
 *   - `parseSearchResponse` read a `total` — GET /v1/search replies
 *     `totalReturned` + the withheld counts (search.routes.ts:389), never `total`;
 *   - the type filter was single-select over 4 families — the web toggles any
 *     of 6 (DOCUMENT_TYPES) and offers an Evidence kind row;
 *   - type labels/tones follow searchTones.ts (CASE is blue → info; INTAKE_LINK
 *     is "Intake request").
 */

test("no fetch without a workspace; a blank query lists the workspace (no q)", () => {
  assert.equal(mod.buildSearchPath({ teamId: null, q: "hello" }), null);
  const blank = qs(mod.buildSearchPath({ teamId: "ws_1", q: "   " }));
  assert.equal(blank.get("teamId"), "ws_1");
  assert.equal(blank.has("q"), false, "a blank q would be a 400 (min(1))");
  assert.equal(blank.get("limit"), "25");
});

test("q is trimmed and bounded at the schema's 200; mode only when not the default", () => {
  assert.equal(qs(mod.buildSearchPath({ teamId: "ws_1", q: " report " })).get("q"), "report");
  assert.equal(qs(mod.buildSearchPath({ teamId: "ws_1", q: "x".repeat(300) })).get("q").length, 200);
  assert.equal(qs(mod.buildSearchPath({ teamId: "ws_1", q: "a" })).has("mode"), false);
  assert.equal(qs(mod.buildSearchPath({ teamId: "ws_1", q: "a", mode: "HYBRID" })).get("mode"), "HYBRID");
});

test("cursor is included only when paging", () => {
  assert.equal(qs(mod.buildSearchPath({ teamId: "ws_1", q: "a" })).has("cursor"), false);
  assert.equal(qs(mod.buildSearchPath({ teamId: "ws_1", q: "a", cursor: "c2c2c2c2" })).get("cursor"), "c2c2c2c2");
});

test("result routes only to surfaces native has; unknown/missing → not tappable", () => {
  assert.equal(mod.resolveSearchResultRoute({ documentType: "EVIDENCE", evidenceId: "e1" }), "/evidence/e1");
  assert.equal(mod.resolveSearchResultRoute({ documentType: "CASE", caseId: "c1" }), "/case/c1");
  assert.equal(mod.resolveSearchResultRoute({ documentType: "AUDIT_EVENT", sourceId: "x" }), null);
});

test("the reply is read by the keys the ROUTE sends; a malformed 200 is not 'no results'", () => {
  assert.match(ROUTE, /totalReturned: result\.totalReturned,\s*filteredByGovernance: result\.filteredByGovernance,\s*filteredByVisibility: result\.filteredByVisibility/);
  const r = mod.parseSearchResponse({ rows: [{ documentId: "d" }], nextCursor: "n", totalReturned: 1, filteredByGovernance: 2, filteredByVisibility: 3 });
  assert.deepEqual(r, { rows: [{ documentId: "d" }], nextCursor: "n", totalReturned: 1, filteredByGovernance: 2, filteredByVisibility: 3 });
  assert.equal("total" in r, false);
  assert.equal(mod.parseSearchResponse(null), null);
  assert.equal(mod.parseSearchResponse({ results: [], total: 0 }), null, "a body without rows was rendered as an empty result");
});

test("load more appends rows and ADDS the counts", () => {
  const a = { rows: [{ documentId: "1" }], nextCursor: "x", totalReturned: 1, filteredByGovernance: 1, filteredByVisibility: 0 };
  const b = { rows: [{ documentId: "2" }], nextCursor: null, totalReturned: 1, filteredByGovernance: 0, filteredByVisibility: 2 };
  assert.deepEqual(mod.mergeSearchPages(a, b), { rows: [{ documentId: "1" }, { documentId: "2" }], nextCursor: null, totalReturned: 2, filteredByGovernance: 1, filteredByVisibility: 2 });
});

test("document types read in the web's words and tones", () => {
  assert.equal(mod.documentTypeDisplay("EVIDENCE").label, "Evidence");
  assert.equal(mod.documentTypeDisplay("CASE").tone, "info");
  assert.equal(mod.documentTypeDisplay("REPORT").tone, "pending");
  assert.equal(mod.documentTypeDisplay("INTAKE_LINK").label, "Intake request");
  assert.ok(mod.documentTypeDisplay("SOMETHING_NEW").label.length > 0);
});

test("document type + evidence kind chips are the web's, and every type has a native destination", () => {
  assert.deepEqual(mod.SEARCH_DOCUMENT_TYPE_FILTERS.map((f) => f.label), ["Evidence", "Case", "Report", "Package", "Note", "Intake request"]);
  assert.deepEqual(mod.SEARCH_EVIDENCE_KIND_FILTERS.map((f) => f.value), ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"]);
  for (const { value } of mod.SEARCH_DOCUMENT_TYPE_FILTERS) {
    assert.ok(mod.searchOpenAction({ documentType: value, documentId: "d", sourceId: "s", evidenceId: "e", caseId: "c", badges: [] }), `${value} has no native destination`);
  }
  const p = qs(mod.buildSearchPath({ teamId: "t1", q: "x", documentTypes: ["EVIDENCE", "NOTE"], evidenceTypes: ["PHOTO", "AUDIO"] }));
  assert.equal(p.get("documentTypes"), "EVIDENCE,NOTE");
  assert.equal(p.get("evidenceTypes"), "PHOTO,AUDIO");
  assert.match(ROUTE, /evidenceTypes: parseStringList\(raw\.evidenceTypes\)/);
  assert.deepEqual(mod.toggleSearchValue(["A"], "B"), ["A", "B"]);
  assert.deepEqual(mod.toggleSearchValue(["A", "B"], "A"), ["B"]);
});

test("the family parameter is the one the ROUTE reads (documentTypes)", () => {
  assert.match(ROUTE, /documentTypes: parseStringList\(raw\.documentTypes\)/);
  const p = qs(mod.buildSearchPath({ teamId: "t1", q: "x", documentTypes: ["EVIDENCE", "CASE"] }));
  assert.equal(p.get("documentTypes"), "EVIDENCE,CASE");
  assert.equal(p.has("documentType"), false);
});

test("sort reaches the query with the web's five modes", () => {
  assert.deepEqual(mod.SEARCH_SORT_OPTIONS.map((o) => o.label), ["Most recent first", "Oldest first", "Newest by creation", "Earliest by creation", "Relevance"]);
  assert.equal(qs(mod.buildSearchPath({ teamId: "t1", q: "x", sort: "RELEVANCE_DESC" })).get("sort"), "RELEVANCE_DESC");
});

test("the result head: filter summary never echoes the query; withheld is counted", () => {
  const none = { documentTypes: [], evidenceTypes: [], lifecycle: {}, updatedSinceUtc: null, updatedUntilUtc: null };
  assert.equal(mod.searchFilterSummary(none), "no filters applied");
  assert.equal(
    mod.searchFilterSummary({ ...none, documentTypes: ["EVIDENCE"], evidenceTypes: ["PHOTO", "VIDEO"], lifecycle: { onLegalHold: true }, updatedUntilUtc: "2026-01-01T00:00:00.000Z" }),
    "narrowed by 1 record type, 2 evidence kinds, legal hold, an updated-date range",
  );
  assert.equal(mod.searchWithheldSummary({ filteredByVisibility: 2, filteredByGovernance: 1 }), "2 withheld by visibility · 1 withheld by governance");
  assert.equal(mod.searchWithheldSummary({ filteredByVisibility: 0, filteredByGovernance: 0 }), null);
  assert.equal(mod.searchCountLabel(1), "1 result");
  assert.equal(mod.searchCountLabel(0), "0 results");
  assert.equal(mod.hasNarrowingFilters(none), false);
  assert.equal(mod.hasNarrowingFilters({ ...none, evidenceTypes: ["AUDIO"] }), true);
});

test("a type-only empty result names the types that DID match this query", () => {
  const f = { q: "roof", documentTypes: ["EVIDENCE"], evidenceTypes: [], lifecycle: {}, updatedSinceUtc: null, updatedUntilUtc: null };
  const probe = { q: "roof", matchedTotal: 3, matchedByType: { EVIDENCE: 0, REPORT: 2, PACKAGE: 1 } };
  assert.deepEqual(mod.describeFilterEmpty(f, probe), {
    headline: "No Evidence records match",
    detail: "Report / Package records DID match your search — clear the type filter to see them.",
  });
  assert.equal(mod.describeFilterEmpty(f, { ...probe, q: "other" }).headline, "No matches with the current filters", "a probe for another query was believed");
  assert.equal(mod.describeFilterEmpty({ ...f, lifecycle: { onLegalHold: true } }, probe).headline, "No matches with the current filters");
});

test("a refusal is not an outage", () => {
  assert.equal(mod.classifySearchFailure({ statusCode: 403 }), "restricted");
  assert.equal(mod.classifySearchFailure({ statusCode: 404 }), "restricted");
  assert.equal(mod.classifySearchFailure({ code: "permission_denied" }), "restricted");
  assert.equal(mod.classifySearchFailure({ statusCode: 503 }), "unavailable");
  assert.equal(mod.classifySearchFailure(new Error("network")), "unavailable");
});

test("suggest: not for a short query, and clipped to the route's max(80)", () => {
  assert.equal(mod.buildSuggestPath({ teamId: "t1", q: "a" }), null);
  assert.equal(mod.buildSuggestPath({ teamId: null, q: "roof" }), null);
  assert.match(ROUTE, /q: z\.string\(\)\.min\(1\)\.max\(80\)/);
  assert.equal(qs(mod.buildSuggestPath({ teamId: "t1", q: "r".repeat(120) })).get("q").length, 80);
});

test("suggestion rows keep their record type (the route's real shape)", () => {
  assert.deepEqual(
    mod.parseSuggestionRows({ suggestions: [{ id: "d1", documentType: "EVIDENCE", sourceId: "s", title: "Roof photo", subtitle: null }, { id: "d2", title: "" }] }),
    [{ id: "d1", documentType: "EVIDENCE", title: "Roof photo" }],
  );
  assert.deepEqual(mod.parseSuggestionRows(null), []);
});

test("what ranked the results is said from what RAN", () => {
  assert.equal(mod.parseSearchModeUsed({ modeUsed: "MAGIC" }), null);
  assert.equal(mod.parseSearchModeUsed({ modeUsed: "hybrid" }), "HYBRID");
  assert.equal(mod.searchRankingLabel("KEYWORD"), "Deterministic match");
  assert.equal(mod.searchRankingLabel(null), "Deterministic match");
  assert.equal(mod.searchRankingLabel("HYBRID"), "Deterministic match · advisory ranking");
});

test("a row's leading state: legal hold first, else its lifecycle; a subtitle that repeats it is dropped", () => {
  assert.equal(mod.primaryStatusBadge(["review-linked", "archived", "legal-hold"]), "legal-hold");
  assert.equal(mod.primaryStatusBadge(["review-linked"]), null);
  assert.equal(mod.searchBadgeTone("legal-hold"), "risk");
  assert.equal(mod.rowLifecycleState({ workflowState: null, reviewState: "IN_REVIEW" }), "IN_REVIEW");
  assert.equal(mod.searchLifecycleTone("OPEN"), "verified");
  assert.equal(mod.rowSupportingSubtitle({ subtitle: "Open", workflowState: "OPEN" }), null);
  assert.equal(mod.rowSupportingSubtitle({ subtitle: "Signed", workflowState: "OPEN" }), "Signed");
});

test("recent searches: tenant-scoped key, most recent first, deduped, 10 at most", () => {
  assert.equal(mod.searchRecentKey("ws_1"), "proovra:tenant:ws_1:search:recent");
  assert.deepEqual(mod.pushRecentSearch(["a", "b"], " b "), ["b", "a"]);
  assert.equal(mod.pushRecentSearch(Array.from({ length: 10 }, (_, i) => `q${i}`), "new").length, 10);
  assert.deepEqual(mod.parseRecentSearches("not json"), []);
  assert.deepEqual(mod.parseRecentSearches(JSON.stringify(["x", 1])), []);
});
