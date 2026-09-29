#!/usr/bin/env node
// Evidence-Truth audit — canonical JSON builder.
//
// Inputs (all inside this audit directory, nothing else is read):
//   fragments/*.json  domain fragments produced by the tracing passes
//   lead.json         the lead auditor's adjudication: every candidate finding
//                     is CONFIRMED (optionally re-severitised) or REJECTED with
//                     a reason; plus runtime proofs, answers, gates input.
// Output:
//   ../definitive-evidence-lifecycle-truth.json
//
// Deterministic: keys are emitted in a fixed order, arrays are sorted by
// stable keys, and no clock is read (timestamps come from lead.json).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.resolve(root, "..", "definitive-evidence-lifecycle-truth.json");

export const DISPOSITIONS = [
  "SOURCE_PROVEN_CORRECT",
  "SOURCE_AND_RUNTIME_PROVEN_CORRECT",
  "SOURCE_PROVEN_DEFECT",
  "SOURCE_AND_RUNTIME_PROVEN_DEFECT",
  "BLOCKED_EXTERNAL_PROVIDER",
  "BLOCKED_FIXTURE_CAPABILITY",
  "OWNER_DECISION_REQUIRED",
  "NOT_APPLICABLE",
];
const SEVERITIES = ["P0", "P1", "P2", "P3"];
// Report section a domain's findings render under unless lead.json says otherwise.
const DEFAULT_SECTION = {
  acquisition: "acquisition", statemachine: "stateMachine", custody: "custody", tsa: "tsa",
  ots: "ots", queues: "queues", reports: "reports", "package-verify": "package",
  recovery: "recovery", commercial: "freeLimit", security: "security",
  uploads: "acquisition", directcapture: "acquisition", intake: "acquisition",
};
export const FINDING_REQUIRED = [
  "id", "severity", "category", "title", "affected", "evidence", "observed",
  "expected", "dataFlow", "rootCause", "blastRadius", "impact", "reproduction",
  "runtimeEvidence", "remediation", "acceptanceProof", "migrationBackfill",
  "dependency", "disposition", "leadVerification",
];

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function fail(msg) {
  console.error(`build: ${msg}`);
  process.exit(1);
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const lead = readJson(path.join(root, "lead.json"));
const fragDir = path.join(root, "fragments");
const fragments = fs
  .readdirSync(fragDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ file: f, ...readJson(path.join(fragDir, f)) }));

const adjud = lead.adjudication ?? {};
// Citation resolution (check-citations.mjs) — every accepted finding must carry
// at least one citation that resolves in the audited tree.
const citations = readJson(path.join(here, "citation-report.json"));
const findings = [];
const rejected = [];
const seenCandidates = new Set();

for (const frag of fragments) {
  for (const cand of frag.findings ?? []) {
    const key = `${frag.domain}:${cand.localId}`;
    if (seenCandidates.has(key)) fail(`duplicate candidate ${key}`);
    seenCandidates.add(key);
    const a = adjud[key];
    if (!a) fail(`candidate ${key} has no adjudication in lead.json`);
    if (a.verdict === "REJECTED") {
      rejected.push({ candidate: key, title: cand.title, proposedSeverity: cand.severity, reason: a.reason });
      continue;
    }
    if (a.verdict === "MERGED") {
      rejected.push({ candidate: key, title: cand.title, proposedSeverity: cand.severity, reason: `merged into ${a.into}: ${a.reason ?? ""}`.trim() });
      continue;
    }
    if (a.verdict !== "CONFIRMED") fail(`candidate ${key} has invalid verdict ${a.verdict}`);
    const f = {
      id: a.id,
      severity: a.severity ?? cand.severity,
      category: a.category ?? cand.category,
      title: a.title ?? cand.title,
      affected: cand.affected ?? {},
      evidence: [...(cand.evidence ?? []), ...(a.extraEvidence ?? [])],
      observed: a.observed ?? cand.observed,
      expected: a.expected ?? cand.expected,
      dataFlow: a.dataFlow ?? cand.dataFlow,
      rootCause: a.rootCause ?? cand.rootCause,
      blastRadius: a.blastRadius ?? cand.blastRadius,
      impact: a.impact ?? cand.impact,
      reproduction: a.reproduction ?? cand.reproduction,
      runtimeEvidence: a.runtimeEvidence ?? "not required (source-proven)",
      remediation: a.remediation ?? cand.remediation,
      acceptanceProof: a.acceptanceProof ?? cand.acceptanceProof,
      migrationBackfill: a.migrationBackfill ?? cand.migrationBackfill ?? "none",
      dependency: a.dependency ?? cand.dependency ?? "none",
      ownerDecision: a.ownerDecision ?? cand.ownerDecision ?? null,
      disposition: a.disposition,
      leadVerification: a.leadVerification,
      sourceCandidates: [key, ...(a.absorbs ?? [])],
      domain: frag.domain,
      section: a.section ?? DEFAULT_SECTION[frag.domain],
      citations: (() => { const c = citations.candidates[key]; return c ? `${c.resolved}/${c.total} resolve in the audited tree` : "not checked"; })(),
    };
    if (!citations.candidates[key] || citations.candidates[key].resolved === 0) fail(`finding ${f.id} has no resolving citation`);
    findings.push(f);
  }
}

// Findings the lead auditor found directly (not from a fragment).
for (const f of lead.leadFindings ?? []) {
  findings.push({ ...f, sourceCandidates: ["lead"], domain: f.domain ?? "lead" });
}

const ids = new Set();
for (const f of findings) {
  for (const k of FINDING_REQUIRED) {
    if (f[k] === undefined || f[k] === null || f[k] === "") fail(`finding ${f.id ?? f.title} missing ${k}`);
  }
  if (!f.section) fail(`finding ${f.id} has no report section`);
  if (ids.has(f.id)) fail(`duplicate finding id ${f.id}`);
  ids.add(f.id);
  if (!SEVERITIES.includes(f.severity)) fail(`finding ${f.id} bad severity ${f.severity}`);
  if (!DISPOSITIONS.includes(f.disposition)) fail(`finding ${f.id} bad disposition ${f.disposition}`);
  if (!Array.isArray(f.evidence) || f.evidence.length === 0) fail(`finding ${f.id} has no evidence`);
  for (const e of f.evidence) {
    if (!e.file || !Number.isInteger(e.line)) fail(`finding ${f.id} evidence lacks file:line`);
  }
}
findings.sort((a, b) => cmp(a.severity, b.severity) || cmp(a.id, b.id));

// Answers: every fragment answer plus lead overrides.
const answers = [];
const answerOverrides = lead.answerOverrides ?? {};
for (const frag of fragments) {
  for (const ans of frag.answers ?? []) {
    const key = `${frag.domain}:${ans.id}`;
    const o = answerOverrides[key] ?? {};
    const merged = { domain: frag.domain, ...ans, ...o, key };
    if (o.runtime) merged.answer = `${merged.answer} [Runtime: ${o.runtime}]`;
    delete merged.runtime;
    if (!DISPOSITIONS.includes(merged.disposition)) fail(`answer ${key} bad disposition ${merged.disposition}`);
    answers.push(merged);
  }
}
for (const ans of lead.leadAnswers ?? []) {
  if (!DISPOSITIONS.includes(ans.disposition)) fail(`lead answer ${ans.id} bad disposition`);
  answers.push({ domain: "lead", key: `lead:${ans.id}`, ...ans });
}
answers.sort((a, b) => cmp(a.key, b.key));

const inventories = {};
for (const frag of fragments) {
  for (const [name, rows] of Object.entries(frag.inventories ?? {}).sort(([a], [b]) => cmp(a, b))) {
    inventories[`${frag.domain}.${name}`] = rows;
  }
}

const totals = { findings: findings.length };
for (const s of SEVERITIES) totals[s] = findings.filter((f) => f.severity === s).length;
totals.mergedCandidates = rejected.filter((r) => r.reason.startsWith("merged into")).length;
totals.rejectedCandidates = rejected.length - totals.mergedCandidates;
totals.candidates = seenCandidates.size;
totals.answers = answers.length;
totals.dispositionCounts = Object.fromEntries(
  DISPOSITIONS.map((d) => [d, answers.filter((a) => a.disposition === d).length + findings.filter((f) => f.disposition === d).length]),
);

for (const item of lead.backlog ?? []) {
  for (const id of item.findings) if (!ids.has(id)) fail(`backlog cites unknown finding ${id}`);
}
for (const f of findings) if (f.id.includes("undefined")) fail(`bad id ${f.id}`);

const doc = {
  schema: "proovra.audit.definitive-evidence-lifecycle-truth/v1",
  meta: lead.meta,
  verdict: lead.verdict,
  finalAnswers: lead.finalAnswers,
  sections: lead.sections,
  totals,
  findings,
  rejectedCandidates: rejected.sort((a, b) => cmp(a.candidate, b.candidate)),
  answers,
  runtimeProofs: lead.runtimeProofs ?? [],
  blocked: lead.blocked ?? [],
  ownerDecisions: lead.ownerDecisions ?? [],
  backlog: lead.backlog ?? [],
  gates: lead.gates ?? [],
  inventories,
  fragmentCoverage: fragments.map((f) => ({ domain: f.domain, file: f.file, coverage: f.coverage ?? null })),
};

fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`build: ${findings.length} findings (P0 ${totals.P0}, P1 ${totals.P1}, P2 ${totals.P2}, P3 ${totals.P3}), ${rejected.length} rejected candidates, ${answers.length} answers -> ${path.relative(process.cwd(), out)}`);
