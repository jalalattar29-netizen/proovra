/**
 * PHASE UI-TRUTH — layout E2E failure extractor (AUDIT HARNESS).
 *
 * Parses a Playwright list-reporter log from the eight layout projects and
 * emits one row per FAILING test, with the project, spec file, line, title,
 * duration and the first error line. Classification is a separate, reviewed
 * step (audit/ui-truth/data/layout-classification.json) — this file only
 * establishes WHICH tests failed, from the run's own output.
 *
 * Usage: node audit/ui-truth/harness/layout-failures.mjs <log> <outName> <measuredAtSha>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPO } from "./surfaces.mjs";

const [, , logPath, outName, sha] = process.argv;
if (!logPath || !outName || !sha) {
  console.error("usage: layout-failures.mjs <log> <outName> <measuredAtSha>");
  process.exit(2);
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const text = readFileSync(logPath, "utf8").replace(ANSI, "");
const lines = text.split(/\r?\n/);

/** `  x    4 [search-layout] › e2e\...spec.ts:225:11 › title › case (1.0m)` */
const RESULT = /^\s{2}(ok|x|±|-)\s+(\d+)\s+\[([^\]]+)\]\s+›\s+(\S+?):(\d+):(\d+)\s+›\s+(.*?)\s*(?:\(([0-9.]+(?:ms|s|m))\))?$/;

const results = [];
for (const line of lines) {
  const m = RESULT.exec(line);
  if (!m) continue;
  const [, mark, index, project, spec, specLine, specCol, title, duration] = m;
  results.push({
    index: Number(index),
    outcome: mark === "ok" ? "PASSED" : mark === "x" ? "FAILED" : mark === "-" ? "SKIPPED" : "FLAKY",
    project,
    spec: spec.split("\\").join("/"),
    specLine: Number(specLine),
    specColumn: Number(specCol),
    title: title.trim(),
    duration: duration ?? null,
  });
}

/**
 * The failure detail blocks at the end of the log carry the actual reason.
 * Each starts with `  N) [project] › spec:line:col › title` and the first
 * `Error:` / `TimeoutError` line after it is the reason.
 */
const DETAIL = /^\s{2}(\d+)\)\s+\[([^\]]+)\]\s+›\s+(\S+?):(\d+):(\d+)\s+›\s+(.*)$/;
const reasons = new Map();
for (let i = 0; i < lines.length; i += 1) {
  const m = DETAIL.exec(lines[i]);
  if (!m) continue;
  const key = `${m[2]}|${m[3].split("\\").join("/")}:${m[4]}|${m[6].trim()}`;
  let reason = null;
  let expected = null;
  for (let j = i + 1; j < Math.min(i + 60, lines.length); j += 1) {
    const l = lines[j].trim();
    if (!reason && /^(Error|TimeoutError|AssertionError|TypeError)\b/.test(l)) reason = l;
    if (!expected && /^(Expected|Received|expect\()/.test(l)) expected = l;
    if (DETAIL.test(lines[j])) break;
  }
  if (!reasons.has(key)) reasons.set(key, { reason, expected });
}

const failures = results
  .filter((r) => r.outcome === "FAILED")
  .map((r) => {
    const key = `${r.project}|${r.spec}:${r.specLine}|${r.title}`;
    const detail = reasons.get(key) ?? { reason: null, expected: null };
    return {
      failureId: `LAY-${String(r.index).padStart(4, "0")}`,
      project: r.project,
      spec: r.spec,
      specLine: r.specLine,
      title: r.title,
      duration: r.duration,
      reason: detail.reason,
      detail: detail.expected,
      looksLikeTimeout: /Timeout|timed out|exceeded/i.test(`${detail.reason ?? ""} ${r.duration ?? ""}`) || r.duration === "1.0m",
    };
  });

const byProject = {};
for (const f of failures) byProject[f.project] = (byProject[f.project] ?? 0) + 1;
const bySpec = {};
for (const f of failures) bySpec[f.spec] = (bySpec[f.spec] ?? 0) + 1;

const payload = {
  artifact: `ui-truth/${outName}`,
  schemaVersion: 1,
  note: "Failing layout-project tests extracted from a Playwright list-reporter log.",
  measuredAtSha: sha,
  source: logPath.split("\\").join("/"),
  totals: {
    testsReported: results.length,
    passed: results.filter((r) => r.outcome === "PASSED").length,
    failed: failures.length,
    skipped: results.filter((r) => r.outcome === "SKIPPED").length,
    timeoutShaped: failures.filter((f) => f.looksLikeTimeout).length,
    byProject: Object.fromEntries(Object.entries(byProject).sort()),
    distinctSpecs: Object.keys(bySpec).length,
    bySpec: Object.fromEntries(Object.entries(bySpec).sort((a, b) => b[1] - a[1])),
  },
  failures,
};

writeFileSync(join(REPO, "audit", "ui-truth", "data", `${outName}.json`), JSON.stringify(payload, null, 2) + "\n");
console.log(JSON.stringify(payload.totals, null, 2));
