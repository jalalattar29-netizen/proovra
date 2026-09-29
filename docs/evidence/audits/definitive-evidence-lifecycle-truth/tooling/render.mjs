#!/usr/bin/env node
// Evidence-Truth audit — deterministic Markdown renderer.
// Reads ONLY the canonical JSON and writes the Markdown beside it. Fails on a
// missing mandatory field rather than rendering a hole.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const auditsDir = path.resolve(here, "..", "..");
const jsonPath = process.env.AUDIT_JSON ?? path.join(auditsDir, "definitive-evidence-lifecycle-truth.json");
const mdPath = process.env.AUDIT_MD ?? path.join(auditsDir, "definitive-evidence-lifecycle-truth.md");

const FINDING_REQUIRED = [
  "id", "severity", "category", "title", "affected", "evidence", "observed",
  "expected", "dataFlow", "rootCause", "blastRadius", "impact", "reproduction",
  "runtimeEvidence", "remediation", "acceptanceProof", "migrationBackfill",
  "dependency", "disposition", "leadVerification",
];
// The 26 mandated report sections, in order. Each key must exist in
// doc.sections (the lead's prose) — a missing one fails the render.
const SECTION_ORDER = [
  ["verdict", "1. Executive verdict"],
  ["methodology", "2. Audited SHA and methodology"],
  ["lifecycle", "3. Complete lifecycle diagram"],
  ["acquisition", "4. Acquisition inventory"],
  ["stateMachine", "5. Evidence state machine"],
  ["storage", "6. Storage and hash truth"],
  ["custody", "7. Custody/audit truth"],
  ["tsa", "8. TSA findings"],
  ["ots", "9. OTS findings"],
  ["queues", "10. Worker/queue findings"],
  ["reports", "11. Report findings"],
  ["package", "12. Verification-package findings"],
  ["verify", "13. Verify-page findings"],
  ["reportsPage", "14. Reports-page findings"],
  ["recovery", "15. Recovery matrix"],
  ["freeLimit", "16. FREE three-evidence analysis"],
  ["freeToPro", "17. FREE → PRO analysis"],
  ["credits", "18. Credit allocation answer"],
  ["downgrade", "19. Downgrade/refund behaviour"],
  ["duplicates", "20. Duplicate/legacy authority inventory"],
  ["security", "21. Security and tenant-boundary findings"],
  ["concurrency", "22. Concurrency/idempotency findings"],
  ["runtime", "23. Proven runtime cases"],
  ["blocked", "24. Blocked external proofs"],
  ["owner", "25. Owner decisions"],
  ["backlog", "26. Ordered remediation backlog"],
];

function fail(msg) {
  console.error(`render: ${msg}`);
  process.exit(1);
}
const doc = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
for (const k of ["meta", "verdict", "sections", "totals", "findings", "answers", "gates", "finalAnswers"]) {
  if (doc[k] === undefined) fail(`JSON missing ${k}`);
}

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const L = [];
const p = (s = "") => L.push(s);
const loc = (e) => `\`${e.file}:${e.line}\``;
const byDomain = (d) => doc.findings.filter((f) => (f.sections ?? [f.domain]).includes(d));

p(`# ${doc.meta.title}`);
p();
p(`<!-- GENERATED from definitive-evidence-lifecycle-truth.json by tooling/render.mjs — do not edit by hand. -->`);
p();
p(`| field | value |`);
p(`|---|---|`);
for (const k of ["auditedSha", "originMainShaAtStart", "branch", "worktree", "startedAt", "completedAt", "productFilesChanged", "productionContacted"]) {
  if (doc.meta[k] === undefined) fail(`meta.${k} missing`);
  p(`| ${k} | ${esc(Array.isArray(doc.meta[k]) ? (doc.meta[k].length ? doc.meta[k].join(", ") : "none") : doc.meta[k])} |`);
}
p();
p(`**Totals:** ${doc.totals.findings} findings — P0 ${doc.totals.P0} · P1 ${doc.totals.P1} · P2 ${doc.totals.P2} · P3 ${doc.totals.P3} · ${doc.totals.mergedCandidates} duplicate candidates merged · ${doc.totals.rejectedCandidates} rejected (of ${doc.totals.candidates} candidates) · ${doc.totals.answers} dispositioned answers.`);
p();

// Sections that carry a findings table; a finding appears under exactly one.
const FINDING_SECTIONS = new Set([
  "acquisition", "stateMachine", "storage", "custody", "tsa", "ots", "queues", "reports", "package",
  "verify", "reportsPage", "recovery", "freeLimit", "freeToPro", "credits", "downgrade", "duplicates",
  "security", "concurrency",
]);
for (const f of doc.findings) if (!FINDING_SECTIONS.has(f.section)) fail(`finding ${f.id} has unknown section ${f.section}`);

for (const [key, title] of SECTION_ORDER) {
  const s = doc.sections[key];
  if (!s || typeof s.body !== "string" || !s.body.trim()) fail(`section ${key} missing body`);
  p(`## ${title}`);
  p();
  p(s.body.trim());
  p();
  if (FINDING_SECTIONS.has(key)) {
    const fs_ = doc.findings.filter((f) => f.section === key);
    if (fs_.length) {
      p(`| id | sev | title | disposition |`);
      p(`|---|---|---|---|`);
      for (const f of fs_) p(`| [${f.id}](#${f.id.toLowerCase()}) | ${f.severity} | ${esc(f.title)} | ${f.disposition} |`);
      p();
    } else {
      p(`_No confirmed findings in this section._`);
      p();
    }
  }
  if (key === "runtime") {
    if (!doc.runtimeProofs.length) fail("runtime section has no proofs recorded");
    for (const r of doc.runtimeProofs) {
      for (const k of ["id", "claim", "fixture", "command", "expected", "actual", "result", "cleanup"]) if (!r[k]) fail(`runtime proof ${r.id} missing ${k}`);
      p(`### ${r.id} — ${r.title ?? r.claim}`);
      p();
      p(`- **Source claim:** ${r.claim}`);
      p(`- **Fixture:** ${r.fixture}`);
      p(`- **Command:** \`${r.command}\``);
      p(`- **Expected:** ${r.expected}`);
      p(`- **Actual:** ${r.actual}`);
      if (r.stateBeforeAfter) p(`- **State before/after:** ${r.stateBeforeAfter}`);
      p(`- **Result:** ${r.result}`);
      p(`- **Cleanup:** ${r.cleanup}`);
      p();
    }
  }
  if (key === "blocked") {
    for (const b of doc.blocked) {
      for (const k of ["id", "item", "blocker", "attempted", "established", "futureProof"]) if (!b[k]) fail(`blocked ${b.id} missing ${k}`);
      p(`- **${b.id}** ${b.item} — blocker: ${b.blocker}. Attempted: ${b.attempted}. Established from source: ${b.established}. Future proof: ${b.futureProof}`);
    }
    p();
  }
  if (key === "owner") {
    for (const o of doc.ownerDecisions) {
      for (const k of ["id", "question", "context", "recommendation"]) if (!o[k]) fail(`owner decision ${o.id} missing ${k}`);
      p(`- **${o.id}** ${o.question} — ${o.context} **Recommendation:** ${o.recommendation}`);
    }
    p();
  }
  if (key === "backlog") {
    doc.backlog.forEach((b, i) => {
      if (!b.findings?.length || !b.action) fail(`backlog item ${i} incomplete`);
      p(`${i + 1}. **${b.findings.join(", ")}** — ${b.action}`);
    });
    p();
  }
}

p(`## Final answers`);
p();
for (const a of doc.finalAnswers) {
  if (!a.q || !a.a) fail("final answer incomplete");
  p(`**${a.q}**`);
  p();
  p(a.a);
  p();
}

p(`## Conservation gates`);
p();
p(`| # | gate | status | detail |`);
p(`|---|---|---|---|`);
for (const g of doc.gates) {
  if (!g.id || !g.gate || !g.status) fail(`gate incomplete`);
  p(`| ${g.id} | ${esc(g.gate)} | ${g.status} | ${esc(g.detail)} |`);
}
p();

p(`## Findings register`);
p();
for (const f of doc.findings) {
  for (const k of FINDING_REQUIRED) {
    if (f[k] === undefined || f[k] === null || f[k] === "") fail(`finding ${f.id} missing ${k}`);
  }
  p(`### ${f.id}`);
  p();
  p(`**${f.severity} · ${f.category} · ${f.disposition}** — ${f.title}`);
  p();
  const aff = Object.entries(f.affected).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => `${k}: ${v.join(", ")}`);
  p(`- **Affected:** ${aff.length ? aff.join("; ") : "see evidence"}`);
  p(`- **Evidence:** ${f.evidence.map(loc).join(", ")}`);
  p(`- **Citations:** ${f.citations}`);
  if (f.sourceCandidates.length > 1) p(`- **Merged candidates:** ${f.sourceCandidates.join(", ")}`);
  for (const [k, label] of [
    ["observed", "Observed"], ["expected", "Expected"], ["dataFlow", "Data flow"], ["rootCause", "Root cause"],
    ["blastRadius", "Blast radius"], ["impact", "Impact"], ["reproduction", "Reproduction"],
    ["runtimeEvidence", "Runtime evidence"], ["remediation", "Recommended remediation"],
    ["acceptanceProof", "Acceptance proof"], ["migrationBackfill", "Migration/backfill"],
    ["dependency", "Dependency"], ["leadVerification", "Lead verification"],
  ]) p(`- **${label}:** ${String(f[k]).trim()}`);
  if (f.ownerDecision) p(`- **Owner decision:** ${f.ownerDecision}`);
  p();
  const snippets = f.evidence.filter((e) => e.snippet);
  if (snippets.length) {
    p("```text");
    for (const e of snippets) p(`${e.file}:${e.line}  ${String(e.snippet).replace(/\r?\n/g, " ⏎ ").slice(0, 400)}`);
    p("```");
    p();
  }
}

p(`## Merged and rejected candidates`);
p();
p(`Candidates raised by a tracing pass that were merged into a finding with the same root cause, or rejected on lead verification — kept so before/after counts stay auditable.`);
p();
p(`| candidate | proposed | title | reason |`);
p(`|---|---|---|---|`);
for (const r of doc.rejectedCandidates) p(`| ${r.candidate} | ${r.proposedSeverity} | ${esc(r.title)} | ${esc(r.reason)} |`);
p();

p(`## Dispositioned questions`);
p();
p(`| key | disposition | question | answer |`);
p(`|---|---|---|---|`);
for (const a of doc.answers) {
  if (!a.question || !a.answer) fail(`answer ${a.key} incomplete`);
  p(`| ${a.key} | ${a.disposition} | ${esc(a.question)} | ${esc(a.answer).slice(0, 700)} |`);
}
p();

p(`## Machine-readable inventories`);
p();
p(`Full rows live in the JSON under \`inventories\`. Row counts:`);
p();
p(`| inventory | rows |`);
p(`|---|---|`);
for (const [k, v] of Object.entries(doc.inventories)) p(`| ${k} | ${Array.isArray(v) ? v.length : Object.keys(v ?? {}).length} |`);
p();

const md = L.join("\n") + "\n";
fs.writeFileSync(mdPath, md);
console.log(`render: ${L.length} lines -> ${path.basename(mdPath)}`);
