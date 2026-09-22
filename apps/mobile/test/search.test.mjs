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

/* ---------------------------------------------- modes, recency, and honesty */

/**
 * Semantic search can be unavailable while a control offering it is not. A
 * surface that asks for SEMANTIC, silently receives KEYWORD and says nothing
 * has told the user their query was answered a way it was not — and the two
 * answer differently enough that the user reads an empty result as "nothing
 * matches" rather than "that was not the search I asked for".
 */
test("semantic modes are offered only when the server says they exist", () => {
  assert.deepEqual(mod.availableSearchModes(false), ["KEYWORD"]);
  assert.deepEqual(mod.availableSearchModes(true), ["KEYWORD", "HYBRID", "SEMANTIC"]);
});

test("an API build that reports nothing is treated as having no semantic search", () => {
  // The safe direction for a capability the client cannot otherwise observe.
  const r = mod.parseSearchRuntime({});
  assert.equal(r.semanticAvailable, false);
  assert.equal(r.modeUsed, null);
  assert.equal(r.fallbackReason, null);
});

test("an unrecognised modeUsed is not believed", () => {
  assert.equal(mod.parseSearchRuntime({ modeUsed: "MAGIC" }).modeUsed, null);
  assert.equal(mod.parseSearchRuntime({ modeUsed: "semantic" }).modeUsed, "SEMANTIC");
});

test("a fallback is stated, with the server's reason when it gave one", () => {
  const notice = mod.searchFallbackNotice("SEMANTIC", {
    modeUsed: "KEYWORD",
    fallbackReason: "embeddings are still being built",
  });
  assert.match(notice, /keyword search instead/i);
  assert.match(notice, /embeddings are still being built/);

  // No reason still says what happened.
  assert.match(
    mod.searchFallbackNotice("SEMANTIC", { modeUsed: "KEYWORD", fallbackReason: null }),
    /keyword search instead/i,
  );

  // No fallback, nothing to say.
  assert.equal(mod.searchFallbackNotice("KEYWORD", { modeUsed: "KEYWORD", fallbackReason: null }), null);
  assert.equal(mod.searchFallbackNotice("KEYWORD", { modeUsed: null, fallbackReason: null }), null);
});

test("the recency window converts to an instant, and 'any time' to none", () => {
  const now = Date.parse("2026-09-22T12:00:00.000Z");
  assert.equal(mod.recencyToIso("any", now), null);
  assert.equal(mod.recencyToIso("not-a-window", now), null);
  assert.equal(mod.recencyToIso("7d", now), "2026-09-15T12:00:00.000Z");
  assert.equal(mod.recencyToIso("30d", now), "2026-08-23T12:00:00.000Z");
});

test("the query carries mode and recency only when they mean something", () => {
  const base = { teamId: "t1", q: "roof" };
  const plain = mod.buildSearchPath(base);
  assert.match(plain, /mode=KEYWORD/);
  assert.doesNotMatch(plain, /updatedSinceUtc/);

  const narrowed = mod.buildSearchPath({
    ...base,
    mode: "SEMANTIC",
    updatedSinceUtc: "2026-09-15T12:00:00.000Z",
  });
  assert.match(narrowed, /mode=SEMANTIC/);
  assert.match(narrowed, /updatedSinceUtc=2026-09-15T12%3A00%3A00.000Z/);
});
