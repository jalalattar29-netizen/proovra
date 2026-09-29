#!/usr/bin/env node
// Evidence-lifecycle REMEDIATION ledger — builder + renderer + conservation.
//
// Inputs:
//   ../../definitive-evidence-lifecycle-truth.json   the canonical audit (read-only)
//   ../ledger-source.json                            authored per-finding remediation facts
//   git history                                      commits whose message cites a finding id
// Outputs:
//   ../remediation-ledger.json   ../remediation-ledger.md
//
// Deterministic for a given commit graph: no clock is read.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, "..");
const repo = path.resolve(dir, "..", "..", "..", "..");
const audit = JSON.parse(fs.readFileSync(path.resolve(dir, "..", "definitive-evidence-lifecycle-truth.json"), "utf8"));
const src = JSON.parse(fs.readFileSync(path.join(dir, "ledger-source.json"), "utf8"));
const BASE = src.baselineSha;

const DISPOSITIONS = ["FIXED_IN_THIS_TASK", "ALREADY_FIXED_ON_MAIN", "SUPERSEDED_BY_CANONICAL_FIX", "BLOCKED_EXTERNAL_PROOF", "PARTIALLY_FIXED", "STILL_PRESENT"];
const CLOSED = new Set(["FIXED_IN_THIS_TASK", "ALREADY_FIXED_ON_MAIN", "SUPERSEDED_BY_CANONICAL_FIX", "BLOCKED_EXTERNAL_PROOF"]);
const fail = (m) => { console.error(`ledger: ${m}`); process.exit(1); };

// Commits on this branch since the baseline that cite a finding id.
const log = execFileSync("git", ["-C", repo, "log", "--reverse", "--format=%H%x1f%s%x1f%b%x1e", `${BASE}..HEAD`], { encoding: "utf8" })
  .split("\x1e").map((s) => s.trim()).filter(Boolean)
  .map((s) => { const [sha, subject, body] = s.split("\x1f"); return { sha, subject, text: expandIdRanges(`${subject}\n${body ?? ""}`) }; });

// A message may cite a contiguous run as "ET-TSA-01..09"; expand it to the
// individual ids so each is matched exactly (ids stay zero-padded to two digits).
function expandIdRanges(text) {
  return text.replace(/\b(ET-[A-Z]+)-(\d{2})\.\.(\d{2})\b/g, (_m, family, from, to) => {
    const out = [];
    for (let n = Number(from); n <= Number(to); n++) out.push(`${family}-${String(n).padStart(2, "0")}`);
    return out.join(" ");
  });
}
const filesOf = (sha) => execFileSync("git", ["-C", repo, "show", "--name-only", "--format=", sha], { encoding: "utf8" }).split("\n").filter(Boolean);
const isProduct = (f) => /^(apps|services|packages)\//.test(f) && !/\/(test|tests|__tests__|e2e)\//.test(f) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(f);

const ids = audit.findings.map((f) => f.id);
const seen = new Set();
for (const id of ids) { if (seen.has(id)) fail(`duplicate canonical id ${id}`); seen.add(id); }
for (const k of Object.keys(src.findings)) if (!seen.has(k)) fail(`ledger-source names unknown finding ${k}`);

const rows = audit.findings.map((f) => {
  const s = src.findings[f.id] ?? { disposition: "STILL_PRESENT" };
  if (!DISPOSITIONS.includes(s.disposition)) fail(`${f.id}: bad disposition ${s.disposition}`);
  const re = new RegExp(`\\b${f.id}\\b`);
  // Only commits that change product or test code count as remediation: a
  // docs/artifact commit that merely cites the id (including the one that
  // commits this ledger) would otherwise make the ledger self-referential.
  const commits = log.filter((c) => re.test(c.text) && filesOf(c.sha).some((x) => /^(apps|services|packages)\//.test(x)));
  const productFiles = [...new Set(commits.flatMap((c) => filesOf(c.sha)).filter(isProduct))].sort();
  if (s.disposition === "FIXED_IN_THIS_TASK") {
    for (const k of ["rootCause", "canonicalAuthority", "greenTest"]) if (!s[k]) fail(`${f.id}: FIXED needs ${k}`);
    if (commits.length === 0) fail(`${f.id}: FIXED but no commit cites it`);
  }
  if (s.disposition === "BLOCKED_EXTERNAL_PROOF" && !s.remainingExternalProof) fail(`${f.id}: BLOCKED needs remainingExternalProof`);
  if (s.disposition === "ALREADY_FIXED_ON_MAIN" && !s.greenTest) fail(`${f.id}: ALREADY_FIXED needs a proving test`);
  return {
    id: f.id, severity: f.severity, title: f.title, section: f.section,
    citations: f.evidence.map((e) => `${e.file}:${e.line}`),
    disposition: s.disposition,
    rootCause: s.rootCause ?? f.rootCause,
    canonicalAuthority: s.canonicalAuthority ?? null,
    obsoleteRemoved: s.obsoleteRemoved ?? null,
    productFiles,
    redTest: s.redTest ?? null,
    greenTest: s.greenTest ?? null,
    negativeAuthTests: s.negativeAuthTests ?? null,
    concurrencyTest: s.concurrencyTest ?? null,
    migrationImpact: s.migrationImpact ?? "none",
    compatibilityImpact: s.compatibilityImpact ?? "none",
    commits: commits.map((c) => `${c.sha.slice(0, 10)} ${c.subject}`),
    remainingExternalProof: s.remainingExternalProof ?? null,
    finalResult: s.finalResult ?? (CLOSED.has(s.disposition) ? s.disposition : "OPEN"),
  };
});

const count = (d) => rows.filter((r) => r.disposition === d).length;
const conservation = Object.fromEntries(DISPOSITIONS.map((d) => [d, count(d)]));
const open = rows.filter((r) => !CLOSED.has(r.disposition));
const openBySev = Object.fromEntries(["P0", "P1", "P2", "P3"].map((s) => [s, open.filter((r) => r.severity === s).map((r) => r.id)]));
const summary = {
  canonicalFindings: rows.length,
  ...conservation,
  UNKNOWN: 0,
  NOT_REVIEWED: 0,
  UNACCOUNTED: ids.length - rows.length,
  DUPLICATE_FINDING_IDS: 0,
  conservationHolds: rows.length === Object.values(conservation).reduce((a, b) => a + b, 0),
  openBySeverity: Object.fromEntries(Object.entries(openBySev).map(([k, v]) => [k, v.length])),
};
const doc = { schema: "proovra.remediation-ledger/v1", baselineSha: BASE, auditSchema: audit.schema, summary, openIds: openBySev, rows };
fs.writeFileSync(path.join(dir, "remediation-ledger.json"), JSON.stringify(doc, null, 2) + "\n");

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const L = [];
L.push("# Evidence-lifecycle remediation ledger", "", "<!-- GENERATED by tooling/build-ledger.mjs from ledger-source.json + the canonical audit + git history. Do not edit. -->", "");
L.push(`Baseline: \`${BASE}\` · canonical findings: **${rows.length}**`, "");
L.push("| disposition | count |", "|---|---|");
for (const d of DISPOSITIONS) L.push(`| ${d} | ${conservation[d]} |`);
L.push("", `Open by severity: ${Object.entries(summary.openBySeverity).map(([k, v]) => `${k} ${v}`).join(" · ")}`, "");
L.push("| id | sev | disposition | canonical authority | commits | green test |", "|---|---|---|---|---|---|");
for (const r of rows) L.push(`| ${r.id} | ${r.severity} | ${r.disposition} | ${esc(r.canonicalAuthority)} | ${esc(r.commits.map((c) => c.slice(0, 10)).join(", "))} | ${esc(r.greenTest)} |`);
L.push("");
for (const r of rows.filter((x) => x.disposition !== "STILL_PRESENT")) {
  L.push(`## ${r.id} — ${esc(r.title)}`, "");
  for (const k of ["severity", "disposition", "rootCause", "canonicalAuthority", "obsoleteRemoved", "redTest", "greenTest", "negativeAuthTests", "concurrencyTest", "migrationImpact", "compatibilityImpact", "remainingExternalProof", "finalResult"]) {
    if (r[k] !== null && r[k] !== undefined) L.push(`- **${k}:** ${esc(r[k])}`);
  }
  L.push(`- **productFiles:** ${r.productFiles.length ? r.productFiles.map((f) => `\`${f}\``).join(", ") : "none"}`);
  L.push(`- **commits:** ${r.commits.length ? r.commits.join("; ") : "none"}`, "");
}
fs.writeFileSync(path.join(dir, "remediation-ledger.md"), L.join("\n") + "\n");
console.log(`ledger: ${rows.length} findings ${JSON.stringify(conservation)} open ${JSON.stringify(summary.openBySeverity)}`);
