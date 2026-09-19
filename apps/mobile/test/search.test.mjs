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
  assert.deepEqual(mod.parseSearchResponse(null), { rows: [], nextCursor: null });
  assert.deepEqual(mod.parseSearchResponse({ rows: [{ documentId: "d" }], nextCursor: "n" }).nextCursor, "n");
});

test("document type display never leaves a raw enum", () => {
  assert.equal(mod.documentTypeDisplay("EVIDENCE").label, "Evidence");
  assert.equal(mod.documentTypeDisplay("CASE").tone, "governance");
  assert.ok(mod.documentTypeDisplay("SOMETHING_NEW").label.length > 0);
});
