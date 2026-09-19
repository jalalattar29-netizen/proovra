/**
 * GUARD — native Home KPI projection (Master Program §9, H5). Every tile is a
 * real trust-summary count; tones must be honest (ready → verified only when >0,
 * attention → risk only when >0) and stay within ProovraStatusTone. Pure module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/home-metrics.ts"), "utf8").replace(/^import type .*$/m, "");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { projectTrustKpis, parseTrustSummary } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const TONES = new Set(["verified", "pending", "risk", "neutral", "governance", "info"]);

test("projects the four canonical KPIs from real counts", () => {
  const kpis = projectTrustKpis({ totalEvidence: 12, endToEndReady: 5, needingAttention: 2, tsa: { stamped: 8 } });
  const byKey = Object.fromEntries(kpis.map((k) => [k.key, k]));
  assert.equal(byKey.total.value, 12);
  assert.equal(byKey.ready.value, 5);
  assert.equal(byKey.attention.value, 2);
  assert.equal(byKey.timestamped.value, 8);
  for (const k of kpis) assert.ok(TONES.has(k.tone));
});

test("honest tones — positives green only when present, attention red only when present", () => {
  const some = Object.fromEntries(projectTrustKpis({ endToEndReady: 3, needingAttention: 1 }).map((k) => [k.key, k]));
  assert.equal(some.ready.tone, "verified");
  assert.equal(some.attention.tone, "risk");
  const none = Object.fromEntries(projectTrustKpis({ endToEndReady: 0, needingAttention: 0 }).map((k) => [k.key, k]));
  assert.equal(none.ready.tone, "neutral");
  assert.equal(none.attention.tone, "neutral");
});

test("missing / garbage envelope yields zeroed tiles, never a crash", () => {
  const kpis = projectTrustKpis(parseTrustSummary(null));
  assert.equal(kpis.length, 4);
  for (const k of kpis) assert.equal(k.value, 0);
});
