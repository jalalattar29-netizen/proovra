/**
 * GUARD — canonical native global search logic (Master Program §10, N1).
 *
 * buildSearchPath must refuse to fetch without a workspace teamId or a query
 * (the idle state), always include teamId (the endpoint 400s without it), and
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

test("no fetch without a workspace teamId or without a query (idle)", () => {
  assert.equal(mod.buildSearchPath({ teamId: null, q: "hello" }), null);
  assert.equal(mod.buildSearchPath({ teamId: "ws_1", q: "   " }), null);
  assert.equal(mod.buildSearchPath({ teamId: "ws_1", q: "" }), null);
});

test("built path always carries teamId, q, limit and mode", () => {
  const path = mod.buildSearchPath({ teamId: "ws_1", q: " report " });
  assert.match(path, /^\/v1\/search\?/);
  assert.match(path, /teamId=ws_1/);
  assert.match(path, /q=report/); // trimmed
  assert.match(path, /limit=25/);
  assert.match(path, /mode=KEYWORD/);
});

test("cursor is included only when paging", () => {
  assert.doesNotMatch(mod.buildSearchPath({ teamId: "ws_1", q: "a" }), /cursor=/);
  assert.match(mod.buildSearchPath({ teamId: "ws_1", q: "a", cursor: "c2" }), /cursor=c2/);
});

test("result routes only to surfaces native has; unknown/missing → not tappable", () => {
  assert.equal(mod.resolveSearchResultRoute({ documentType: "EVIDENCE", evidenceId: "e1" }), "/evidence/e1");
  assert.equal(mod.resolveSearchResultRoute({ documentType: "CASE", caseId: "c1" }), "/case/c1");
  assert.equal(mod.resolveSearchResultRoute({ documentType: "EVIDENCE", sourceId: "s1" }), "/evidence/s1");
  assert.equal(mod.resolveSearchResultRoute({ documentType: "AUDIT_EVENT", sourceId: "x" }), null);
  assert.equal(mod.resolveSearchResultRoute({ documentType: "EVIDENCE" }), null);
});

test("response parsing is defensive", () => {
  assert.deepEqual(mod.parseSearchResponse(null), { rows: [], nextCursor: null, total: null });
  assert.deepEqual(mod.parseSearchResponse({ rows: [{ documentId: "d" }], nextCursor: "n" }).nextCursor, "n");
});

test("document type display never leaves a raw enum", () => {
  assert.equal(mod.documentTypeDisplay("EVIDENCE").label, "Evidence");
  assert.equal(mod.documentTypeDisplay("CASE").tone, "governance");
  assert.ok(mod.documentTypeDisplay("SOMETHING_NEW").label.length > 0);
});

/* ------------------------------------------------------------------ added
 * Filters, typeahead and result count — the remaining normal-user gaps.
 *
 * Nine of the eleven /v1/search* endpoints are operator surfaces gated on the
 * server-projected isPlatformAdmin flag (saved views, audit, diagnostics,
 * reconcile, semantic backfill), so they are correctly absent from native.
 * These cover what a normal user actually has on the web and did not have here.
 */

test("a workspace total is carried through when the server reports one", () => {
  // Without it the surface can only say "N on this page", which reads as a
  // workspace total to anyone not looking closely.
  assert.equal(mod.parseSearchResponse({ rows: [], total: 1280 }).total, 1280);
  assert.equal(mod.parseSearchResponse({ rows: [] }).total, null);
});

test("the type filter narrows the query and ALL sends no family param", () => {
  const all = mod.buildSearchPath({
    teamId: "t1",
    q: "roof",
    documentTypes: mod.filterToDocumentTypes("ALL"),
  });
  assert.equal(all.includes("documentType="), false, "no chip means every family");

  const one = mod.buildSearchPath({
    teamId: "t1",
    q: "roof",
    documentTypes: mod.filterToDocumentTypes("EVIDENCE"),
  });
  assert.ok(one.includes("documentType=EVIDENCE"));
});

test("the filter chips only offer families native can actually open", () => {
  // AUDIT_EVENT and WORKFLOW_STEP are real document types, but native has no
  // destination for them — offering them as filters would promise a dead end.
  const values = mod.NATIVE_SEARCH_FILTERS.map((f) => f.value);
  assert.deepEqual(values, ["ALL", "EVIDENCE", "CASE", "REPORT", "INTAKE_LINK"]);
  for (const v of ["EVIDENCE", "CASE"]) {
    assert.ok(
      mod.resolveSearchResultRoute({ documentType: v, sourceId: "x", documentId: "d" }),
      `${v} is offered as a filter but has no native route`,
    );
  }
});

test("suggest is not requested for a query too short to be useful", () => {
  assert.equal(mod.buildSuggestPath({ teamId: "t1", q: "" }), null);
  assert.equal(mod.buildSuggestPath({ teamId: "t1", q: "a" }), null);
  assert.equal(mod.buildSuggestPath({ teamId: null, q: "roof" }), null, "no workspace, no request");
  assert.ok(mod.buildSuggestPath({ teamId: "t1", q: "roof" }).startsWith("/v1/search/suggest?"));
});

test("suggestions parse from either envelope and drop anything unusable", () => {
  assert.deepEqual(mod.parseSuggestions({ suggestions: ["roof", "roofing"] }), ["roof", "roofing"]);
  assert.deepEqual(mod.parseSuggestions({ items: [{ text: "roof" }, { nope: 1 }, ""] }), ["roof"]);
  assert.deepEqual(mod.parseSuggestions(null), []);
  assert.equal(mod.parseSuggestions({ suggestions: Array(50).fill("x") }).length, 8, "bounded");
});
