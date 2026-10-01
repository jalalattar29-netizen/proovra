#!/usr/bin/env node
/**
 * REMEDIATION-RERUN helper (not product code): turns the acceptance harness log into a
 * run record ({ journeys: [...] }) for build.mjs. Pure function of the log: every
 * "[<browser>/<page>] ALL SURFACES PASS" line and every step line becomes a check, and
 * the harness's own per-browser verdict lines decide the run.
 *
 * Usage: node ext-acceptance-to-run.mjs <uc1-acceptance.log> <out.json>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [logPath, outPath] = process.argv.slice(2);
const log = readFileSync(logPath, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
const lines = log.split(/\r?\n/);

const checks = [];
let steps = [];
for (const line of lines) {
  const step = /^([A-Z_]+)\s+(PASS|FAIL)\b\s*(.*)$/.exec(line.trim());
  if (step) steps.push({ step: step[1], ok: step[2] === "PASS" });
  const done = /^\[([a-z]+)\/([a-z-]+)\] (ALL SURFACES PASS|.*FAIL.*)(?: — evidence ([0-9a-f-]+))?/.exec(line.trim());
  if (done) {
    const ok = done[3] === "ALL SURFACES PASS" && steps.length > 0 && steps.every((s) => s.ok);
    checks.push({
      name: `${done[1]} / ${done[2]} page: ${steps.length} steps from OAuth to Public Verify`,
      ok,
      detail: `${steps.filter((s) => s.ok).length}/${steps.length} steps${done[4] ? `; evidence ${done[4]}` : ""}`,
    });
    steps = [];
  }
}
for (const browser of ["chromium", "edge"]) {
  const verdict = new RegExp(`\\[uc1-acceptance\\]\\s+${browser}\\s+(PASS|FAIL)`).exec(log)?.[1] ?? "MISSING";
  checks.push({ name: `harness verdict: ${browser}`, ok: verdict === "PASS", detail: verdict });
}
const gate = /UC-1 CLOSED \(browser gate\) \[PASS\]/.test(log);
checks.push({ name: "harness gate: UC-1 browser gate", ok: gate, detail: gate ? "PASS" : "not reported" });

const verdict = checks.length >= 3 && checks.every((c) => c.ok) ? "PASS" : "FAIL";
writeFileSync(
  outPath,
  JSON.stringify(
    {
      journeys: [
        {
          id: "R05-extension-real-browsers",
          title: "Browser extension (real Chrome + Edge, unpacked build): OAuth/PKCE → workspace → capture → seal → library/detail/case/search → report → package → Public Verify",
          verdict,
          checks,
          requests: [],
          source: logPath.split(/[\\/]/).pop(),
        },
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(`R05 ${verdict} ${checks.filter((c) => c.ok).length}/${checks.length}`);
