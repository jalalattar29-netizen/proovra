/**
 * PHASE 12 — POINT 5: worker test census generator.
 *
 * The API has had an authoritative, re-derivable test baseline since Point 4
 * (`docs/architecture/api-test-census.json`). The worker did not, which is why
 * a hand-reported "856" could sit in a report with nothing to check it against.
 *
 * This script produces the equivalent artifact for the worker: per-file counts
 * from the vitest JSON reporter, so a future reconciliation is arithmetic
 * rather than recollection.
 *
 * Usage (from services/worker):
 *   npx vitest run --reporter=json --outputFile=./.test-report.json
 *   node scripts/build-test-census.mjs ./.test-report.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: node scripts/build-test-census.mjs <vitest-json-report>");
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));

const perFile = {};
for (const suite of report.testResults) {
  const normalised = suite.name.split("\\").join("/");
  const idx = normalised.indexOf("services/worker/");
  const rel = idx === -1 ? normalised : normalised.slice(idx);
  const results = suite.assertionResults;
  const skipped = results.filter((a) => a.status === "pending").length;
  const todo = results.filter((a) => a.status === "todo").length;
  perFile[rel] = {
    tests: results.length,
    passed: results.length - skipped - todo,
    skipped,
    todo,
  };
}

const files = Object.keys(perFile).sort();
const ordered = {};
for (const f of files) ordered[f] = perFile[f];

const census = {
  $comment:
    "PHASE 12 — POINT 5. The FIRST authoritative worker test baseline. " +
    "Generated from the vitest JSON reporter, per file, so it can be " +
    "re-derived exactly. Reconcile against this file, never against a " +
    "hand-reported number.",
  generatedFor: "phase-12-point-5-closure",
  generator: "services/worker/scripts/build-test-census.mjs",
  project: {
    command: "pnpm --filter proovra-worker test",
    config: "services/worker/vitest.config.ts",
    files: files.length,
    tests: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests,
    todo: report.numTodoTests,
    suites: report.numTotalTestSuites,
  },
  historicalBaselines: [
    {
      value: "856 tests",
      classification: "HAND_REPORTED_ONLY / NON_AUTHORITATIVE",
      reason:
        "No JSON report, runner log or census artifact was ever preserved for " +
        "it, and the tree that produced it was an uncommitted working state " +
        "that cannot be reconstructed. It is not reproducible even in " +
        "principle: several worker suites generate one assertion PER QUEUE or " +
        "PER CALL SITE — phase-final-worker-visibility iterates 17 queue " +
        "names, and phase-o1-4-span-emission previously iterated every " +
        "queue.add call site in queue.ts — so a raw total is a function of the " +
        "tree, and totals from two different tree states are not comparable by " +
        "subtraction. It must NOT be used as an executable baseline.",
    },
    {
      value: "this manifest",
      classification: "DERIVED_FROM_MANIFEST / AUTHORITATIVE",
      reason:
        "Generated from the vitest JSON reporter with per-file counts. The " +
        "first worker baseline that can be re-derived exactly.",
    },
  ],
  perFile: ordered,
};

const out = resolve(REPO, "docs/architecture/worker-test-census.json");
writeFileSync(out, `${JSON.stringify(census, null, 2)}\n`);
console.log(
  `wrote ${out}: ${files.length} files / ${report.numTotalTests} tests / ` +
    `${report.numPendingTests} skipped / ${report.numTodoTests} todo`,
);
