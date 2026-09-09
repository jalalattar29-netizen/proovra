#!/usr/bin/env node
/**
 * PROVE THE FOUR ADMIN SHARDS TOGETHER RAN THE WHOLE SUITE.
 *
 * =============================================================================
 * WHY COUNTING PER SHARD IS NOT ENOUGH
 * =============================================================================
 * Sharding can lose tests without anything going red. The defect this job
 * exists to catch already happened here: `--shard=N/4` against a file-scope
 * serial group put 72 cases on shard 1 and ZERO on shard 2, and the honest
 * reading of that run is "three shards passed" — three green ticks, one
 * cancellation, and no statement anywhere about what was actually executed.
 *
 * A split that drops a test looks identical to a split that is simply fast.
 * So each shard writes what it ran, and this reads the union.
 *
 * It asserts four things, and they are different questions:
 *
 *   1. every shard reported at all      (a missing report is not a pass)
 *   2. the union is exactly N tests     (nothing dropped)
 *   3. no test id appears twice         (no shard overlap, so the count is real)
 *   4. no test failed, and the matrix job succeeded
 *
 * Usage: node scripts/admin-shard-accounting.mjs <dir> <expectedTotal> <shards>
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, expectedRaw, shardsRaw] = process.argv.slice(2);
const EXPECTED = Number(expectedRaw ?? 97);
const SHARDS = Number(shardsRaw ?? 4);

function die(msg, detail) {
  console.error(`\nADMIN SHARD ACCOUNTING — FAIL\n  ${msg}`);
  if (detail) console.error(detail);
  process.exit(1);
}

let files;
try {
  files = readdirSync(dir).filter((f) => f.endsWith(".json"));
} catch {
  die(`no report directory at ${dir} — the shards uploaded nothing.`);
}

if (files.length !== SHARDS) {
  die(
    `expected ${SHARDS} shard reports, found ${files.length}.`,
    `  found: ${files.join(", ") || "(none)"}\n` +
      "  A shard that produced no report did not run to completion.",
  );
}

/** Every test in a Playwright JSON report, as stable ids. */
function collect(report) {
  const ids = [];
  const walk = (suites, trail) => {
    for (const suite of suites ?? []) {
      const here = [...trail, suite.title].filter(Boolean);
      for (const spec of suite.specs ?? []) {
        // file + full title is stable across shards; `id` is not comparable
        // between runs, and title alone collides across the role describes.
        ids.push(`${spec.file} :: ${[...here, spec.title].join(" › ")}`);
      }
      walk(suite.suites, here);
    }
  };
  walk(report.suites, []);
  return ids;
}

const seen = new Map(); // id -> [shard files]
let failed = 0;
let executed = 0;

for (const f of files.sort()) {
  let report;
  try {
    report = JSON.parse(readFileSync(join(dir, f), "utf8"));
  } catch (err) {
    die(`report ${f} is not readable JSON: ${err.message}`);
  }
  const ids = collect(report);
  executed += ids.length;
  for (const id of ids) {
    if (!seen.has(id)) seen.set(id, []);
    seen.get(id).push(f);
  }
  const stats = report.stats ?? {};
  failed += (stats.unexpected ?? 0) + (stats.flaky ?? 0);
  console.log(
    `  ${f}: ${ids.length} tests, ` +
      `${stats.expected ?? 0} passed, ${stats.unexpected ?? 0} failed, ` +
      `${stats.skipped ?? 0} skipped, ${stats.flaky ?? 0} flaky`,
  );
}

const duplicates = [...seen.entries()].filter(([, where]) => where.length > 1);
const unique = seen.size;

console.log(
  `\n  executed rows ${executed} | unique ${unique} | expected ${EXPECTED}`,
);

if (duplicates.length > 0) {
  die(
    `${duplicates.length} test(s) ran in more than one shard — the shards overlap.`,
    duplicates
      .slice(0, 10)
      .map(([id, where]) => `  ${id}\n    in: ${where.join(", ")}`)
      .join("\n"),
  );
}

if (unique !== EXPECTED) {
  die(
    `the four shards executed ${unique} unique tests, expected ${EXPECTED}.`,
    unique < EXPECTED
      ? `  ${EXPECTED - unique} test(s) were never executed by any shard.`
      : `  ${unique - EXPECTED} more than the suite is supposed to contain.`,
  );
}

if (failed > 0) die(`${failed} test(s) did not pass across the shards.`);

// The matrix job's own verdict. A shard can produce a complete report and still
// have been cancelled or failed to set up, which the reports cannot show.
const jobResult = process.env.SHARD_RESULT;
if (jobResult && jobResult !== "success") {
  die(`the admin-control-plane matrix job reported "${jobResult}", not success.`);
}

console.log(
  `\nADMIN SHARD ACCOUNTING — PASS\n` +
    `  ${EXPECTED}/${EXPECTED} unique tests executed across ${SHARDS} shards\n` +
    `  0 missing, 0 duplicated, 0 failed, all shards exit 0\n`,
);
