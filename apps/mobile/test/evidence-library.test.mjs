/**
 * GUARD — native evidence-library helpers (Master Program §4/A, M1). Query
 * building maps each filter to the REAL server param; the summary projects real
 * counts; bulk actions match the scope's lifecycle. Pure module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/evidence-library.ts"), "utf8").replace(/^import type .*$/m, "");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const TONES = new Set(["verified", "pending", "risk", "neutral", "governance", "info"]);

test("query maps each filter to its real server param", () => {
  const q = mod.buildLibraryQuery({ scope: "active", search: " car ", type: "PHOTO", status: "SIGNED", source: "MOBILE_APP", reportReady: "ready", sort: "priority" });
  assert.match(q, /^\/v1\/evidence\?/);
  assert.match(q, /scope=active/);
  assert.match(q, /search=car/); // trimmed
  assert.match(q, /type=PHOTO/);
  assert.match(q, /status=SIGNED/);
  assert.match(q, /acquisition=MOBILE_APP/); // source → acquisition param
  assert.match(q, /reportReady=ready/);
  assert.match(q, /sort=priority/);
});

test("ALL filters and blank search are omitted", () => {
  const q = mod.buildLibraryQuery({ scope: "trash", type: "ALL", status: "ALL", source: "ALL", reportReady: "ALL", sort: "newest", search: "" });
  assert.doesNotMatch(q, /type=|status=|acquisition=|reportReady=|search=/);
  assert.match(q, /scope=trash/);
});

test("sort cycles newest → oldest → priority → newest", () => {
  assert.equal(mod.nextSort("newest"), "oldest");
  assert.equal(mod.nextSort("oldest"), "priority");
  assert.equal(mod.nextSort("priority"), "newest");
});

test("hasActiveFilters detects any non-ALL refinement", () => {
  assert.equal(mod.hasActiveFilters({ type: "ALL", status: "ALL", source: "ALL", reportReady: "ALL" }), false);
  assert.equal(mod.hasActiveFilters({ type: "ALL", status: "SIGNED", source: "ALL", reportReady: "ALL" }), true);
});

test("library metrics project real counts with honest tones", () => {
  const m = mod.projectLibraryMetrics({ totalActiveRecords: 20, reportsReadyCount: 12, needsActionCount: 3, verificationIssuesCount: 0 });
  const byKey = Object.fromEntries(m.map((x) => [x.key, x]));
  assert.equal(byKey.total.value, 20);
  assert.equal(byKey.needs.value, 3);
  assert.equal(byKey.needs.tone, "risk"); // >0 → risk
  assert.equal(byKey.issues.tone, "neutral"); // 0 → neutral
  for (const x of m) assert.ok(TONES.has(x.tone));
});

test("bulk actions match the scope's lifecycle", () => {
  assert.deepEqual(mod.bulkActionsForScope("active").map((a) => a.action), ["ARCHIVE", "TRASH", "EXPORT_METADATA_CSV"]);
  assert.deepEqual(mod.bulkActionsForScope("archived").map((a) => a.action), ["RESTORE_ARCHIVED", "TRASH", "EXPORT_METADATA_CSV"]);
  assert.deepEqual(mod.bulkActionsForScope("trash").map((a) => a.action), ["RESTORE_TRASH", "EXPORT_METADATA_CSV"]);
});
