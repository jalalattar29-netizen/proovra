#!/usr/bin/env node
/**
 * Remediation ledger — mechanically derived from ../universal-capture-findings.json.
 *
 *   node build-ledger.mjs            write remediation-ledger.{json,md}; exit 1 if any gate fails
 *   node build-ledger.mjs --check    regenerate in memory, compare bytes, run gates
 *   node build-ledger.mjs --report   write and print gates, but always exit 0 (progress view)
 *
 * Inputs: the audit's 119 canonical findings (+ consolidated aliases), lanes/*.json (per-finding
 * remediation reports), lead-decisions.mjs (lead adjudication), and `git log` — a finding's
 * implementation commit is any commit on this branch whose message cites the id and which
 * touches apps/, services/, packages/, scripts/, infra/ or .github/.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as LEAD from "./lead-decisions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIT = resolve(HERE, "..");
const REPO = resolve(AUDIT, "../../../..");
const CHECK = process.argv.includes("--check");
const REPORT = process.argv.includes("--report");
const ALLOWED = new Set(["FIXED_RUNTIME_PROVEN", "FIXED_SOURCE_AND_TEST_PROVEN", "BLOCKED_EXTERNAL_PROOF"]);
const RUNTIME_KINDS = new Set(["runtime", "integration-real-db"]);

const findingsDoc = JSON.parse(readFileSync(join(AUDIT, "universal-capture-findings.json"), "utf8"));
const findings = findingsDoc.findings;
const consolidations = findingsDoc.consolidations;

const lanes = {};
const laneDir = join(HERE, "lanes");
if (existsSync(laneDir)) {
  for (const f of readdirSync(laneDir).filter((n) => n.endsWith(".json")).sort()) {
    const doc = JSON.parse(readFileSync(join(laneDir, f), "utf8"));
    for (const [id, row] of Object.entries(doc.findings ?? {})) {
      if (lanes[id]) throw new Error(`finding ${id} reported by two lanes (${lanes[id].lane} and ${doc.lane})`);
      lanes[id] = { lane: doc.lane, ...row };
    }
  }
}

// Commits citing each id (product paths only).
const PRODUCT = /^(apps|services|packages|scripts|infra|\.github)\//;
const commitsById = {};
const log = execFileSync("git", ["-C", REPO, "log", "--format=%H%x1f%s%x1f%b%x1e", `${LEAD.BASE_SHA}..HEAD`], { encoding: "utf8" });
for (const rec of log.split("\x1e").map((s) => s.trim()).filter(Boolean)) {
  const [sha, subject, body] = rec.split("\x1f");
  const files = execFileSync("git", ["-C", REPO, "show", "--name-only", "--format=", sha], { encoding: "utf8" }).split("\n").filter(Boolean);
  if (!files.some((f) => PRODUCT.test(f))) continue;
  for (const id of new Set(`${subject}\n${body}`.match(/UC-[A-Z]+-\d{3}/g) ?? [])) {
    (commitsById[id] ??= []).push({ sha: sha.slice(0, 12), subject });
  }
}

const rows = findings.map((f) => {
  const lane = lanes[f.id] ?? null;
  const lead = LEAD.DECISIONS[f.id] ?? null;
  const src = lead ?? lane;
  const commits = (commitsById[f.id] ?? []).slice().reverse();
  let disposition = "OPEN";
  if (src?.status === "FIXED") disposition = RUNTIME_KINDS.has(src.proofKind) ? "FIXED_RUNTIME_PROVEN" : "FIXED_SOURCE_AND_TEST_PROVEN";
  if (src?.status === "BLOCKED_EXTERNAL_PROOF") disposition = "BLOCKED_EXTERNAL_PROOF";
  if (disposition !== "OPEN" && commits.length === 0) disposition = "OPEN (no implementation commit cites this id)";
  return {
    id: f.id,
    aliases: f.aliases,
    originalSeverity: f.severity,
    finalSeverity: src?.finalSeverity ?? f.severity,
    ucs: f.ucs,
    platforms: f.platforms,
    rootCause: f.rootCause,
    sourceEvidence: f.locations.map((l) => `${l.file}:${l.line}`),
    runtimeEvidenceStatus: f.proof,
    owner: lead ? "lead" : lane ? `lane ${lane.lane}` : null,
    decision: src?.decision ?? null,
    red: src?.red ?? null,
    green: src?.green ?? null,
    proofKind: src?.proofKind ?? null,
    implementationCommits: commits,
    migrations: src?.migration ?? null,
    impacts: src?.impacts ?? null,
    externalProofRemaining: src?.externalProofRemaining ?? null,
    finalDisposition: disposition,
  };
});

// ---------------------------------------------------------------- gates
const gates = [];
const gate = (name, ok, detail = "") => gates.push({ name, ok: Boolean(ok), detail });
const ids = rows.map((r) => r.id);
gate("ledger rows = 119 original findings", rows.length === 119, `${rows.length}`);
gate("no duplicate ids", new Set(ids).size === ids.length);
gate("every consolidated alias maps to exactly one ledger row", consolidations.every((c) => rows.filter((r) => r.aliases.includes(c.id)).length === 1 && ids.includes(c.into)), consolidations.map((c) => `${c.id}->${c.into}`).join(", "));
gate("no lane reports an unknown id", Object.keys(lanes).every((id) => ids.includes(id)), Object.keys(lanes).filter((id) => !ids.includes(id)).join(","));
const counts = {};
for (const r of rows) counts[r.finalDisposition] = (counts[r.finalDisposition] ?? 0) + 1;
const fixed = (counts.FIXED_RUNTIME_PROVEN ?? 0) + (counts.FIXED_SOURCE_AND_TEST_PROVEN ?? 0);
const blocked = counts.BLOCKED_EXTERNAL_PROOF ?? 0;
gate("119 = fixed + externally-blocked", fixed + blocked === 119, JSON.stringify(counts));
gate("every disposition is allowed", rows.every((r) => ALLOWED.has(r.finalDisposition)), rows.filter((r) => !ALLOWED.has(r.finalDisposition)).map((r) => r.id).join(","));
gate("every fixed row has red proof, green proof and a commit", rows.filter((r) => r.finalDisposition.startsWith("FIXED")).every((r) => r.red && r.green && r.implementationCommits.length), "");
gate("every blocked row names the exact external proof and has a commit", rows.filter((r) => r.finalDisposition === "BLOCKED_EXTERNAL_PROOF").every((r) => r.externalProofRemaining && r.externalProofRemaining !== "none" && r.implementationCommits.length), "");
gate("remaining P0/P1/P2/P3 = 0", rows.every((r) => ALLOWED.has(r.finalDisposition)), "");

// ---------------------------------------------------------------- render
const doc = {
  schema: "PROOVRA_UNIVERSAL_CAPTURE_REMEDIATION_LEDGER_V1",
  auditBranch: LEAD.AUDIT_BRANCH,
  auditSha: LEAD.AUDIT_SHA,
  auditRemote: LEAD.AUDIT_REMOTE_STATUS,
  baseSha: LEAD.BASE_SHA,
  counts: { total: rows.length, ...Object.fromEntries(Object.entries(counts).sort()), fixed, blocked, remaining: rows.length - fixed - blocked },
  gates,
  rows,
};
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const md = [
  "# Universal Evidence Capture — Remediation Ledger",
  "",
  `Generated by \`remediation/build-ledger.mjs\` from \`universal-capture-findings.json\`; do not edit by hand. Audit ${LEAD.AUDIT_BRANCH} @ \`${LEAD.AUDIT_SHA}\` (${LEAD.AUDIT_REMOTE_STATUS}). Base \`${LEAD.BASE_SHA}\`.`,
  "",
  `**Total ${rows.length} · fixed ${fixed} · externally blocked ${blocked} · remaining ${rows.length - fixed - blocked}**`,
  "",
  "## Gates",
  "",
  "| Gate | Result | Detail |",
  "|---|---|---|",
  ...gates.map((g) => `| ${esc(g.name)} | ${g.ok ? "PASS" : "FAIL"} | ${esc(g.detail)} |`),
  "",
  "## Rows",
  "",
  "| ID | Sev (orig→final) | UC | Owner | Proof | Commits | Disposition |",
  "|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.id} | ${r.originalSeverity}→${r.finalSeverity} | ${r.ucs.join(", ")} | ${r.owner ?? "—"} | ${r.proofKind ?? "—"} | ${r.implementationCommits.map((c) => c.sha.slice(0, 8)).join(" ") || "—"} | ${r.finalDisposition} |`),
  "",
  "## Decisions",
  "",
  ...rows.flatMap((r) => [
    `### ${r.id} — ${r.finalDisposition}`,
    "",
    `- Root cause: ${esc(r.rootCause)}`,
    `- Decision: ${esc(r.decision ?? "—")}`,
    `- Red: ${esc(r.red ? `${r.red.test} — ${r.red.observed}` : "—")}`,
    `- Green: ${esc(r.green ? `${(r.green.tests ?? []).join(", ")} — ${r.green.result}` : "—")}`,
    `- Migration: ${esc(r.migrations ?? "—")} · External proof remaining: ${esc(r.externalProofRemaining ?? "—")}`,
    "",
  ]),
].join("\n");

const out = { "remediation-ledger.json": JSON.stringify(doc, null, 2) + "\n", "remediation-ledger.md": md + "\n" };
let diffs = 0;
for (const [name, content] of Object.entries(out)) {
  const p = join(HERE, name);
  if (CHECK) {
    if (!existsSync(p) || readFileSync(p, "utf8") !== content) {
      diffs += 1;
      console.error(`DIFF ${name}`);
    }
  } else writeFileSync(p, content);
}
for (const g of gates) console.log(`${g.ok ? "PASS" : "FAIL"}  ${g.name}${g.detail ? `  (${g.detail.slice(0, 200)})` : ""}`);
console.log(`total ${rows.length} · fixed ${fixed} · blocked ${blocked} · remaining ${rows.length - fixed - blocked}${CHECK ? ` · byte diffs ${diffs}` : ""}`);
if (REPORT) process.exit(0);
process.exit(gates.some((g) => !g.ok) || diffs ? 1 : 0);
