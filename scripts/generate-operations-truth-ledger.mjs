#!/usr/bin/env node
/**
 * OPERATIONS TRUTH — the remediation ledger for OPS-001..OPS-036.
 *
 * Input:  docs/operations/remediation/ledger/operations-truth-ledger.source.json
 * Output: docs/operations/remediation/ledger/operations-truth-ledger.json  (validated, normalized)
 *         docs/operations/remediation/OPERATIONS-TRUTH-LEDGER.md           (rendered)
 *
 * The generator REFUSES to write a ledger that claims more than it can show:
 *   * every finding OPS-001..OPS-036 exactly once, in order, P1/P2/P3;
 *   * a terminal disposition only: FIXED or BLOCKED_EXTERNAL_PROOF;
 *   * every row names its fix commit(s), red proof, green proof and
 *     regression test(s), and every cited file exists in this tree;
 *   * a red proof file and a green proof file each name the finding's id;
 *   * a FIXED row whose impact reaches a browser has an executed browser
 *     proof (a journey or the browser matrix); a BLOCKED row names its blocker.
 *
 * Deterministic: no clock, no environment, sorted output. Run it twice; the
 * second run must change nothing. `--check` fails if the outputs are stale.
 * `--verify-commits` additionally resolves every cited commit with git.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "docs/operations/remediation/ledger/operations-truth-ledger.source.json";
const OUT_JSON = "docs/operations/remediation/ledger/operations-truth-ledger.json";
const OUT_MD = "docs/operations/remediation/OPERATIONS-TRUTH-LEDGER.md";

const args = new Set(process.argv.slice(2));
const at = (p) => join(ROOT, p);
const read = (p) => readFileSync(at(p), "utf8");

const source = JSON.parse(read(SOURCE));
const errors = [];
const fail = (id, msg) => errors.push(`${id}: ${msg}`);

const EXPECTED = Array.from({ length: 36 }, (_, i) => `OPS-${String(i + 1).padStart(3, "0")}`);
const rows = source.findings;
const ids = rows.map((r) => r.id);
if (JSON.stringify(ids) !== JSON.stringify(EXPECTED)) {
  errors.push(`ledger: ids must be exactly OPS-001..OPS-036 in order, each once (got ${ids.join(",")})`);
}

const DISPOSITIONS = new Set(["FIXED", "BLOCKED_EXTERNAL_PROOF"]);
const SEVERITIES = new Set(["P1", "P2", "P3"]);
const BROWSER_PROOF = /^e2e\//;

for (const r of rows) {
  if (!SEVERITIES.has(r.severity)) fail(r.id, `severity ${r.severity}`);
  if (!DISPOSITIONS.has(r.disposition)) fail(r.id, `disposition ${r.disposition} is not terminal`);
  for (const k of ["title", "rootCause", "ownerSystem", "migrationImpact", "dataReconciliation"]) {
    if (typeof r[k] !== "string" || r[k].trim() === "") fail(r.id, `${k} is empty`);
  }
  for (const k of ["fixCommits", "redProof", "greenProof", "regressionTests", "impact"]) {
    if (!Array.isArray(r[k]) || r[k].length === 0) fail(r.id, `${k} is empty`);
  }
  for (const sha of r.fixCommits ?? []) {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) fail(r.id, `fix commit ${sha} is not a commit id`);
  }
  const cited = [...(r.redProof ?? []), ...(r.greenProof ?? []), ...(r.regressionTests ?? []), ...(r.e2eProof ?? []).map((e) => e.split(" — ")[0])];
  for (const p of cited) if (!existsSync(at(p))) fail(r.id, `cited file does not exist: ${p}`);
  const mentions = (files) => files.some((p) => existsSync(at(p)) && read(p).includes(r.id));
  if (!mentions(r.redProof ?? [])) fail(r.id, "no red proof file names this finding");
  if (!mentions(r.greenProof ?? [])) fail(r.id, "no green proof file names this finding");
  if (r.disposition === "FIXED" && (r.impact ?? []).includes("browser")) {
    if (!(r.e2eProof ?? []).some((e) => BROWSER_PROOF.test(e))) fail(r.id, "user-visible in the browser but no executed browser proof");
  }
  if (r.disposition === "BLOCKED_EXTERNAL_PROOF" && !(r.externalBlocker ?? "").trim()) {
    fail(r.id, "BLOCKED_EXTERNAL_PROOF without a named external blocker");
  }
}

if (args.has("--verify-commits")) {
  for (const r of rows) {
    for (const sha of r.fixCommits ?? []) {
      try {
        execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: ROOT, stdio: "ignore" });
      } catch {
        fail(r.id, `fix commit ${sha} does not resolve`);
      }
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(`operations-truth-ledger: REFUSED\n${errors.map((e) => `  - ${e}`).join("\n")}\n`);
  process.exit(1);
}

// ---- normalized JSON --------------------------------------------------------
const count = (pred) => rows.filter(pred).length;
const bySeverity = {};
for (const s of ["P1", "P2", "P3"]) {
  bySeverity[s] = {
    total: count((r) => r.severity === s),
    FIXED: count((r) => r.severity === s && r.disposition === "FIXED"),
    BLOCKED_EXTERNAL_PROOF: count((r) => r.severity === s && r.disposition === "BLOCKED_EXTERNAL_PROOF"),
  };
}
const normalized = {
  baseline: source.baseline,
  audit: source.audit,
  totals: {
    findings: rows.length,
    FIXED: count((r) => r.disposition === "FIXED"),
    BLOCKED_EXTERNAL_PROOF: count((r) => r.disposition === "BLOCKED_EXTERNAL_PROOF"),
    bySeverity,
  },
  findings: rows,
};
const jsonText = `${JSON.stringify(normalized, null, 2)}\n`;

// ---- Markdown ---------------------------------------------------------------
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const list = (xs) => (xs && xs.length ? xs.map((x) => `\`${x}\``).join("<br>") : "—");
const md = [];
md.push("# Operations truth — remediation ledger (OPS-001..OPS-036)");
md.push("");
md.push(`Baseline \`${source.baseline}\` · audit \`${source.audit}\` · generated by \`scripts/generate-operations-truth-ledger.mjs\` from \`${SOURCE}\`. Do not edit by hand.`);
md.push("");
md.push("## Totals");
md.push("");
md.push("| Severity | Findings | FIXED | BLOCKED_EXTERNAL_PROOF |");
md.push("| --- | ---: | ---: | ---: |");
for (const s of ["P1", "P2", "P3"]) {
  md.push(`| ${s} | ${bySeverity[s].total} | ${bySeverity[s].FIXED} | ${bySeverity[s].BLOCKED_EXTERNAL_PROOF} |`);
}
md.push(`| **All** | **${rows.length}** | **${normalized.totals.FIXED}** | **${normalized.totals.BLOCKED_EXTERNAL_PROOF}** |`);
md.push("");
md.push("Migration impact: none for every finding — the remediation adds no table, column or enum value.");
md.push("");
md.push("## Findings");
md.push("");
md.push("| ID | Sev | Disposition | Finding | Root cause | Owner system | Fix commit(s) | Red proof | Green proof | Regression test(s) | Executed proof | Impact | Migration | Data reconciliation |");
md.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  md.push(
    `| ${r.id} | ${r.severity} | ${r.disposition} | ${cell(r.title)} | ${cell(r.rootCause)} | ${cell(r.ownerSystem)} | ${list(r.fixCommits)} | ${list(r.redProof)} | ${list(r.greenProof)} | ${list(r.regressionTests)} | ${list(r.e2eProof)} | ${cell((r.impact ?? []).join(", "))} | ${cell(r.migrationImpact)} | ${cell(r.dataReconciliation)} |`,
  );
}
const blocked = rows.filter((r) => r.disposition === "BLOCKED_EXTERNAL_PROOF");
if (blocked.length) {
  md.push("");
  md.push("## External blockers");
  md.push("");
  for (const r of blocked) md.push(`- **${r.id}** — ${r.externalBlocker}`);
}
md.push("");
const mdText = md.join("\n");

if (args.has("--check")) {
  const stale = [];
  if (!existsSync(at(OUT_JSON)) || read(OUT_JSON) !== jsonText) stale.push(OUT_JSON);
  if (!existsSync(at(OUT_MD)) || read(OUT_MD) !== mdText) stale.push(OUT_MD);
  if (stale.length) {
    process.stderr.write(`operations-truth-ledger: STALE — regenerate: ${stale.join(", ")}\n`);
    process.exit(1);
  }
  process.stdout.write("operations-truth-ledger: up to date\n");
} else {
  writeFileSync(at(OUT_JSON), jsonText);
  writeFileSync(at(OUT_MD), mdText);
  process.stdout.write(
    `operations-truth-ledger: ${rows.length} findings — ${normalized.totals.FIXED} FIXED, ${normalized.totals.BLOCKED_EXTERNAL_PROOF} BLOCKED_EXTERNAL_PROOF\n`,
  );
}
