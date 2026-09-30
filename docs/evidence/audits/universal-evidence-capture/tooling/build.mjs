#!/usr/bin/env node
/**
 * Canonical artifact generator — Definitive Universal Evidence Capture audit.
 *
 *   node build.mjs          regenerate the eight artifacts and run every gate
 *   node build.mjs --check  regenerate in memory, compare byte-for-byte, run gates; writes nothing
 *
 * Inputs (all inside the audit directory): sources/*.json (area findings, verified at file:line),
 * tooling/lead-source.mjs (lead adjudication), runtime/* (command ledger + journey/probe/test output).
 * Output is a pure function of those inputs: no clocks, no randomness, sorted keys where order is free.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as L from "./lead-source.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const rj = (p) => JSON.parse(rd(p));
const SEV = ["P0", "P1", "P2", "P3"];

// ------------------------------------------------------------------ inputs
const areaFiles = readdirSync(join(ROOT, "sources")).filter((f) => f.endsWith(".json")).sort();
const areas = areaFiles.map((f) => ({ file: `sources/${f}`, ...rj(`sources/${f}`) }));
// Generator runs are recorded in the same ledger but excluded here: an artifact cannot list its own regeneration.
const commands = rd("runtime/commands.jsonl")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((c) => !c.label.startsWith("generator-"));
const apiInt = rj("runtime/api-integration-capture.json");
const workerRun = rj("runtime/worker-tests.json");
const journeysRaw = rj("runtime/journeys-raw.json");
const phase2Raw = existsSync(join(ROOT, "runtime/journeys-phase2-raw.json")) ? rj("runtime/journeys-phase2-raw.json") : { journeys: [] };
const probes = {
  continuousIos: rj("runtime/probes/continuous-ios.json"),
  platformContext: rj("runtime/probes/platform-context-shape.json"),
  uploadSessionMemberVitest: rj("runtime/probes/upload-session-member.json"),
  extensionSteps: rj("runtime/probes/extension-steps.json"),
  reportPrintedVerifyLink: rj("runtime/probes/report-printed-verify-link.json"),
  packageIndependentRecompute: rj("runtime/probes/package-recompute.json"),
};
const extResult = existsSync(join(ROOT, "runtime/extension-acceptance-result.json")) ? rj("runtime/extension-acceptance-result.json") : null;

// ------------------------------------------------------------------ findings
const consolidated = new Map(L.CONSOLIDATIONS.map((c) => [c.id, c]));
const raw = [];
for (const a of areas) for (const f of a.findings) raw.push({ ...f, sourceFile: a.file });
for (const f of L.ADDED_FINDINGS) raw.push({ ...f, sourceFile: "tooling/lead-source.mjs" });

const byId = new Map();
for (const f of raw) {
  if (byId.has(f.id)) throw new Error(`duplicate finding id ${f.id}`);
  byId.set(f.id, f);
}
const findings = [];
for (const f of raw) {
  if (consolidated.has(f.id)) continue;
  const aliases = new Set(f.aliases ?? []);
  for (const c of L.CONSOLIDATIONS) if (c.into === f.id) aliases.add(c.id);
  const bind = L.RUNTIME_BINDINGS[f.id];
  const adj = L.SEVERITY_ADJUSTMENTS.find((s) => s.id === f.id);
  findings.push({
    id: f.id,
    severity: adj ? adj.to : f.severity,
    title: f.title,
    ucs: [...(f.ucs ?? [])].sort(),
    platforms: [...(f.platforms ?? [])].sort(),
    status: "present",
    proof: bind ? "runtime-proven" : f.proof,
    userImpact: f.userImpact,
    legalImpact: f.legalImpact,
    securityImpact: f.securityImpact,
    locations: f.locations,
    reproduction: f.reproduction,
    observed: bind ? `${f.observed} RUNTIME: ${bind.observed}` : f.observed,
    expected: f.expected,
    rootCause: f.rootCause,
    remediation: f.remediation,
    requiredTests:
      f.id === "UC-IOS-001"
        ? `${f.requiredTests} Test-authoring gap (consolidated UC-TQ-001): every UC-5 test hand-authors an Android-shaped device block; add a contract test that feeds the Swift result.json shape through buildContinuousManifest → validator.`
        : f.requiredTests,
    migrationImpact: f.migrationImpact,
    dependsOn: [...(f.dependsOn ?? [])].sort(),
    aliases: [...aliases].sort(),
    runtimeEvidence: [...(bind?.evidence ?? []), ...(f.runtimeEvidence ?? [])],
    severityAdjustment: adj ? { from: f.severity, reason: adj.reason } : null,
    sourceFile: f.sourceFile,
  });
}
const sevRank = (s) => SEV.indexOf(s);
findings.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.id.localeCompare(b.id, "en"));
const findingIds = new Set(findings.map((f) => f.id));

const sevCounts = Object.fromEntries(SEV.map((s) => [s, findings.filter((f) => f.severity === s).length]));
const proofCounts = {};
for (const f of findings) proofCounts[f.proof] = (proofCounts[f.proof] ?? 0) + 1;

// ------------------------------------------------------------------ journeys (resolve pending rows from raw runs)
const allRuns = [...journeysRaw.journeys, ...phase2Raw.journeys];
const runById = (prefix) => allRuns.find((j) => j.id.startsWith(prefix));
function resolveJourney(j) {
  const out = { ...j };
  if (j.status === "PENDING_PHASE2") {
    const map = { R03: ["J08"], R09a: ["J10"] }[j.id];
    const runs = map.map(runById);
    if (runs.some((r) => !r)) {
      out.status = "BLOCKED";
      out.note = "Phase-2 stack run not recorded.";
    } else {
      const pass = runs.every((r) => r.verdict === "PASS");
      out.status = pass ? "PASS" : "FAIL";
      out.note = runs.map((r) => `${r.id}: ${r.verdict} (${r.checks.filter((c) => c.ok).length}/${r.checks.length})${r.checks.filter((c) => !c.ok).map((c) => ` ✗ ${c.name}`).join("")}`).join("; ");
    }
  }
  if (j.status === "PENDING_EXT") {
    if (!extResult) {
      out.status = "BLOCKED";
      out.note = "Extension acceptance result not recorded.";
    } else {
      out.status = extResult.status;
      out.note = extResult.note;
      out.evidence = [...j.evidence, "runtime/extension-acceptance-result.json"];
    }
  }
  return out;
}
const journeys = L.JOURNEYS.map(resolveJourney);
const jCounts = { PASS: 0, FAIL: 0, BLOCKED: 0 };
for (const j of journeys) jCounts[j.status] = (jCounts[j.status] ?? 0) + 1;

const executedRuns = allRuns.map((r) => ({
  id: r.id,
  title: r.title,
  verdict: r.verdict,
  checksPassed: r.checks.filter((c) => c.ok).length,
  checksTotal: r.checks.length,
  failedChecks: r.checks.filter((c) => !c.ok).map((c) => ({ name: c.name, detail: c.detail })),
  requests: r.requests.length,
  leadGradedVerdict: L.EXECUTED_RUN_OVERRIDES[r.id]?.gradedVerdict ?? r.verdict,
  leadNote: L.EXECUTED_RUN_OVERRIDES[r.id]?.reason ?? null,
}));

// ------------------------------------------------------------------ inventory / convergence
const arch = areas.find((a) => a.area === "ARCH").facts;
const surfaces = arch.surfaces.map((s) => ({ ...s }));
const DISPOSITIONS = new Set(["LIVE_CANONICAL", "LIVE_DUPLICATE", "RETIRED_410", "DEAD_NO_CALLER", "CALLER_NO_ROUTE", "TEST_ONLY"]);
const absent = arch.absentChannels;
const queues = arch.queues;
const QUEUE_CLASSES = new Set(["LIVE", "PRODUCERLESS", "CONSUMERLESS", "RETIRED"]);
const mutations = arch.mutations;

const testSummary = (r) => ({
  files: r.testResults.length,
  suites: r.numTotalTestSuites,
  tests: r.numTotalTests,
  passed: r.numPassedTests,
  failed: r.numFailedTests,
  skipped: r.numPendingTests + r.numTodoTests,
});

// ------------------------------------------------------------------ assemble truth
const ucCounts = { complete: 0, partial: 0, missing: 0, blocked: 0 };
const ucVerdicts = L.UC_VERDICTS.map((u) => {
  const bucket = L.UC_BUCKET[u.verdict];
  ucCounts[bucket] += 1;
  return { ...u, bucket };
});
const openP0P1 = findings.filter((f) => f.severity === "P0" || f.severity === "P1").map((f) => f.id);
const headline =
  sevCounts.P0 === 0 && sevCounts.P1 === 0 && jCounts.FAIL === 0 && jCounts.BLOCKED === 0 && ucCounts.complete === ucVerdicts.length
    ? "A. UNIVERSAL EVIDENCE CAPTURE VERIFIED END TO END"
    : sevCounts.P0 === 0 && sevCounts.P1 === 0
      ? "B. UNIVERSAL EVIDENCE CAPTURE PARTIALLY VERIFIED"
      : "C. UNIVERSAL EVIDENCE CAPTURE NOT READY";

const reviewed = areas.flatMap((a) => a.reviewed.map((r) => ({ area: a.area, ...r })));

const truth = {
  schema: "PROOVRA_UNIVERSAL_CAPTURE_TRUTH_V1",
  headline,
  meta: L.META,
  auditShaNote: "The audit commit SHA is the commit that adds this directory on the audit branch; it is recorded in the final report, not inside the artifact (a file cannot contain its own commit hash).",
  counts: {
    findings: findings.length,
    consolidated: L.CONSOLIDATIONS.length,
    bySeverity: sevCounts,
    byProof: Object.fromEntries(Object.entries(proofCounts).sort()),
    journeys: jCounts,
    ucBuckets: ucCounts,
    surfaces: surfaces.length,
    mutations: mutations.length,
    queues: queues.length,
    reviewedTopics: reviewed.length,
  },
  ucVerdicts,
  platformMatrix: L.PLATFORM_MATRIX.map((p) =>
    p.platform === "Browser Extension" ? { ...p, realBrowser: journeys.find((j) => j.id === "R05").status } : p,
  ),
  convergenceVerdict: {
    verdict: "CONVERGED WRITERS, DIVERGENT SIDE EFFECTS",
    statement:
      "Every live capture channel reaches ONE Evidence writer, ONE part writer, ONE finalizer (completeEvidence), ONE custody appender, ONE report builder, ONE package builder and ONE Public Verify route; no duplicate evidence model or writer was found and every queue has a consumer. The divergence is in what surrounds the finalizer: custody EVIDENCE_COMPLETED, reviewer-workflow initialisation, tenant audit and workspace retention run only in the web route, so direct-capture and intake records differ from uploads (UC-ARCH-002/003). iOS never reaches the finalizer (UC-IOS-001).",
  },
  openP0P1,
  validation: {
    apiIntegration: testSummary(apiInt),
    worker: testSummary(workerRun),
    commands: commands.map((c) => ({ label: c.label, exit: c.exit, log: c.log, ...(c.note ? { note: c.note } : {}) })),
  },
  reviewedCoverage: reviewed,
};

const inventory = {
  schema: "PROOVRA_UNIVERSAL_CAPTURE_SURFACE_INVENTORY_V1",
  baselineSha: L.META.baselineSha,
  surfaces,
  absentChannels: absent,
  mutations,
  counts: {
    surfaces: surfaces.length,
    byDisposition: Object.fromEntries([...DISPOSITIONS].sort().map((d) => [d, surfaces.filter((s) => s.disposition === d).length])),
    mutations: mutations.length,
  },
};

const convergence = {
  schema: "PROOVRA_UNIVERSAL_CAPTURE_CONVERGENCE_V1",
  baselineSha: L.META.baselineSha,
  verdict: truth.convergenceVerdict,
  arrows: arch.convergence,
  queues,
  detections: arch.detections,
};

const runtimeJourneys = {
  schema: "PROOVRA_UNIVERSAL_CAPTURE_RUNTIME_JOURNEYS_V1",
  baselineSha: L.META.baselineSha,
  required: journeys,
  counts: jCounts,
  executedRuns,
  probes,
  testRuns: { apiIntegration: testSummary(apiInt), worker: testSummary(workerRun) },
};

const findingsDoc = {
  schema: "PROOVRA_UNIVERSAL_CAPTURE_FINDINGS_V1",
  baselineSha: L.META.baselineSha,
  counts: { total: findings.length, bySeverity: sevCounts, byStatus: { fixed: 0, partial: 0, present: findings.length, acceptedRisk: 0 } },
  consolidations: L.CONSOLIDATIONS,
  findings,
};

// ------------------------------------------------------------------ gates
const gates = [];
const gate = (name, ok, detail) => gates.push({ name, ok: Boolean(ok), detail });
gate("discovered capture surfaces = dispositioned capture surfaces", surfaces.every((s) => DISPOSITIONS.has(s.disposition)), `${surfaces.length} surfaces`);
gate("discovered mutations = dispositioned mutations", mutations.every((m) => typeof m.disposition === "string" && m.disposition.length > 0), `${mutations.length} mutations`);
gate("discovered queues = classified queues", queues.every((q) => QUEUE_CLASSES.has(q.classification)), `${queues.length} queue rows`);
gate("runtime journeys = passed + failed + blocked", journeys.length === jCounts.PASS + jCounts.FAIL + jCounts.BLOCKED && journeys.every((j) => ["PASS", "FAIL", "BLOCKED"].includes(j.status)), JSON.stringify(jCounts));
gate("findings = fixed + partial + present + accepted-risk", findings.length === findingsDoc.counts.byStatus.present && findings.every((f) => f.status === "present"), `${findings.length}`);
gate("every UC = complete + partial + missing + blocked", ucVerdicts.length === ucCounts.complete + ucCounts.partial + ucCounts.missing + ucCounts.blocked && ucVerdicts.every((u) => u.bucket), JSON.stringify(ucCounts));
gate("no UNKNOWN without explicit blocker", ucVerdicts.every((u) => u.bucket !== "blocked" || u.blockers.length > 0), "");
gate("no NOT_REVIEWED", reviewed.every((r) => r.verdict !== "NOT_REVIEWED"), `${reviewed.length} reviewed topics`);
gate("no duplicate finding IDs", new Set(findings.map((f) => f.id)).size === findings.length, "");
gate("consolidations point at a kept finding", L.CONSOLIDATIONS.every((c) => findingIds.has(c.into) && byId.has(c.id)), "");
gate("every finding has the required fields", findings.every((f) => SEV.includes(f.severity) && f.locations?.length && f.reproduction && f.observed && f.expected && f.rootCause && f.remediation && f.requiredTests && f.migrationImpact && f.proof), "");
gate("every finding id matches UC-AREA-NNN", findings.every((f) => /^UC-[A-Z]+-\d{3}$/.test(f.id)), "");
gate("every UC key finding exists", ucVerdicts.every((u) => u.keyFindings.every((id) => findingIds.has(id))), "");
gate("every remediation-order finding exists", L.REMEDIATION_ORDER.every((w) => w.findings.every((id) => findingIds.has(id))), "");
gate("every open P0/P1 is in the remediation order", openP0P1.every((id) => L.REMEDIATION_ORDER.some((w) => w.findings.includes(id))), openP0P1.join(","));
gate("every dependsOn resolves", findings.every((f) => f.dependsOn.every((d) => findingIds.has(d) || d.startsWith("ET-") || consolidated.has(d))), "");
gate("executed-run overrides name executed runs", Object.keys(L.EXECUTED_RUN_OVERRIDES).every((id) => allRuns.some((r) => r.id === id)), "");
gate("runtime-bound findings exist", Object.keys(L.RUNTIME_BINDINGS).every((id) => findingIds.has(id)), "");
gate("every blocker names an external proof row", ucVerdicts.every((u) => u.blockers.every((b) => L.EXTERNAL_PROOFS.some((e) => e.id === b))), "");
gate("every command in the ledger has an exit code", commands.every((c) => Number.isInteger(c.exit)), `${commands.length} commands`);
gate("API integration run executed (not skipped) and green", apiInt.numPendingTests === 0 && apiInt.numFailedTests === 0 && apiInt.numPassedTests > 0, `${apiInt.numPassedTests}/${apiInt.numTotalTests}`);
gate("independent package recompute passed (incl. negative controls)", probes.packageIndependentRecompute.passed === probes.packageIndependentRecompute.total && probes.packageIndependentRecompute.total >= 14, `${probes.packageIndependentRecompute.passed}/${probes.packageIndependentRecompute.total}`);
gate("worker run green", workerRun.numFailedTests === 0 && workerRun.numPassedTests > 0, `${workerRun.numPassedTests}/${workerRun.numTotalTests} (${workerRun.numPendingTests} skipped)`);

// ------------------------------------------------------------------ render
const J = (o) => JSON.stringify(o, null, 2) + "\n";
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const loc = (f) => f.locations.map((l) => `\`${l.file}:${l.line}\``).join(", ");

function mdTruth() {
  const o = [];
  o.push(`# ${L.META.title}`, "");
  o.push(`**${headline}**`, "");
  o.push(`Baseline \`${L.META.baselineSha}\` (${L.META.baselineRef}). Branch \`${L.META.auditBranch}\`. Generated from \`definitive-universal-evidence-capture-truth.json\` by \`tooling/build.mjs\`; do not edit by hand.`, "");
  o.push("## Safety", "");
  for (const [k, v] of Object.entries(L.META.safety)) if (k !== "notes") o.push(`- ${k}: **${v}**`);
  for (const n of L.META.safety.notes) o.push(`- ${n}`);
  o.push("", "## Runtime-evidence caveats", "");
  for (const n of L.META.runtimeCaveats) o.push(`- ${n}`);
  o.push("", "## Environment limits", "");
  for (const n of L.META.environmentLimits) o.push(`- ${n}`);
  o.push("", "## UC verdicts", "", "| UC | Name | Verdict | Key findings | External blockers |", "|---|---|---|---|---|");
  for (const u of ucVerdicts) o.push(`| ${u.uc} | ${esc(u.name)} | **${u.verdict}** | ${u.keyFindings.join(", ")} | ${u.blockers.join(", ") || "—"} |`);
  o.push("");
  for (const u of ucVerdicts) o.push(`- **${u.uc}** — ${esc(u.rationale)}`);
  o.push("", "## Platform matrix", "", "| Platform | Capture | Evidence pipeline | Case at capture | Build | Real browser/device | Distribution | Note |", "|---|---|---|---|---|---|---|---|");
  for (const p of truth.platformMatrix) o.push(`| ${p.platform} | ${p.capture} | ${p.evidencePipeline} | ${p.caseAtCapture} | ${p.build} | ${p.realBrowser} | ${p.distribution} | ${esc(p.note)} |`);
  o.push("", "## Capture-to-Public-Verify convergence", "", `**${truth.convergenceVerdict.verdict}** — ${truth.convergenceVerdict.statement}`, "");
  o.push("## Counts", "", `- Findings: ${findings.length} open (P0 ${sevCounts.P0} · P1 ${sevCounts.P1} · P2 ${sevCounts.P2} · P3 ${sevCounts.P3}); ${L.CONSOLIDATIONS.length} consolidated into kept findings.`);
  o.push(`- Proof: ${Object.entries(truth.counts.byProof).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  o.push(`- Required journeys: PASS ${jCounts.PASS} · FAIL ${jCounts.FAIL} · BLOCKED ${jCounts.BLOCKED} (of ${journeys.length}).`);
  o.push(`- API integration (capture-relevant, real PG16/Redis/MinIO): ${truth.validation.apiIntegration.passed}/${truth.validation.apiIntegration.tests} passed, ${truth.validation.apiIntegration.skipped} skipped, ${truth.validation.apiIntegration.files} files.`);
  o.push(`- Worker suite: ${truth.validation.worker.passed}/${truth.validation.worker.tests} passed, ${truth.validation.worker.skipped} skipped (the 4 skipped Object-Lock cases were run separately: see commands).`, "");
  o.push("## Open P0/P1", "");
  for (const f of findings.filter((x) => x.severity === "P0" || x.severity === "P1")) {
    o.push(`### ${f.id} (${f.severity}, ${f.proof}) — ${esc(f.title)}`, "");
    o.push(`- UCs: ${f.ucs.join(", ")} · Platforms: ${f.platforms.join(", ")}`);
    o.push(`- Where: ${loc(f)}`);
    o.push(`- Observed: ${esc(f.observed)}`);
    o.push(`- Expected: ${esc(f.expected)}`);
    o.push(`- Root cause: ${esc(f.rootCause)}`);
    o.push(`- User impact: ${esc(f.userImpact)}`);
    o.push(`- Legal/evidentiary: ${esc(f.legalImpact)}`);
    o.push(`- Security/tenancy: ${esc(f.securityImpact)}`);
    o.push(`- Remediation: ${esc(f.remediation)}`);
    o.push(`- Required tests: ${esc(f.requiredTests)}`);
    o.push(`- Migration: ${esc(f.migrationImpact)} · Depends on: ${f.dependsOn.join(", ") || "—"} · Aliases: ${f.aliases.join(", ") || "—"}`);
    if (f.runtimeEvidence.length) o.push(`- Runtime evidence: ${f.runtimeEvidence.join(", ")}`);
    o.push("");
  }
  o.push("## Required runtime journeys", "", "| # | Journey | Status | Evidence | Note |", "|---|---|---|---|---|");
  for (const j of journeys) o.push(`| ${j.id} | ${esc(j.title)} | **${j.status}** | ${j.evidence.join("<br>")} | ${esc(j.note)} |`);
  o.push("", "## Executed journey runs (driver)", "", "| Run | Driver verdict | Lead-graded verdict | Checks | Lead note |", "|---|---|---|---|---|");
  for (const r of executedRuns) o.push(`| ${r.id} | ${r.verdict} | **${r.leadGradedVerdict}** | ${r.checksPassed}/${r.checksTotal} | ${esc(r.leadNote ?? "")} |`);
  o.push("", "## Conservation gates", "", "| Gate | Result | Detail |", "|---|---|---|");
  for (const g of gates) o.push(`| ${esc(g.name)} | ${g.ok ? "PASS" : "FAIL"} | ${esc(g.detail)} |`);
  o.push("", "## Validation commands", "", "| Label | Exit | Log |", "|---|---|---|");
  for (const c of truth.validation.commands) o.push(`| ${c.label} | ${c.exit} | ${c.log}${c.note ? ` — ${esc(c.note)}` : ""} |`);
  o.push("", "## Artifacts", "");
  for (const a of ARTIFACTS) o.push(`- \`${a}\``);
  o.push("");
  return o.join("\n");
}

function mdExternal() {
  const o = [`# Universal Capture — External Proof Register`, "", `Baseline \`${L.META.baselineSha}\`. A blocked external proof is not a product defect, but it blocks any claim of full public launch where relevant. Generated by \`tooling/build.mjs\`.`, ""];
  for (const e of L.EXTERNAL_PROOFS) {
    o.push(`## ${e.id} — ${e.item}`, "", `- Locally proven: ${e.locallyProven}`, `- Unproven: ${e.unproven}`, `- Requires: ${e.requires}`, `- Procedure: ${e.procedure}`, `- Pass criteria: ${e.passCriteria}`, `- Production risk if omitted: ${e.risk}`, "");
  }
  return o.join("\n");
}

function mdRemediation() {
  const o = [`# Universal Capture — Recommended Remediation Order`, "", `Baseline \`${L.META.baselineSha}\`. Audit only: nothing here has been implemented. Generated by \`tooling/build.mjs\`.`, ""];
  const placed = new Set(L.REMEDIATION_ORDER.flatMap((w) => w.findings));
  for (const w of L.REMEDIATION_ORDER) {
    o.push(`## Wave ${w.wave} — ${w.title}`, "", w.why, "");
    const ids = w.findings.length ? w.findings : findings.filter((f) => !placed.has(f.id)).map((f) => f.id);
    for (const id of ids) {
      const f = findings.find((x) => x.id === id);
      o.push(`- **${f.id}** (${f.severity}, ${f.proof}) ${esc(f.title)}`);
    }
    o.push("");
  }
  return o.join("\n");
}

const ARTIFACTS = [
  "definitive-universal-evidence-capture-truth.json",
  "definitive-universal-evidence-capture-truth.md",
  "universal-capture-surface-inventory.json",
  "universal-capture-convergence-map.json",
  "universal-capture-runtime-journeys.json",
  "universal-capture-findings.json",
  "universal-capture-external-proof-register.md",
  "universal-capture-remediation-order.md",
];

truth.gates = gates;
const outputs = {
  "definitive-universal-evidence-capture-truth.json": J(truth),
  "definitive-universal-evidence-capture-truth.md": mdTruth(),
  "universal-capture-surface-inventory.json": J(inventory),
  "universal-capture-convergence-map.json": J(convergence),
  "universal-capture-runtime-journeys.json": J(runtimeJourneys),
  "universal-capture-findings.json": J(findingsDoc),
  "universal-capture-external-proof-register.md": mdExternal(),
  "universal-capture-remediation-order.md": mdRemediation(),
};

// Render-agreement + hygiene gates run over the final bytes.
const md = outputs["definitive-universal-evidence-capture-truth.md"];
gate("no artifact/render disagreement", md.includes(headline) && findings.filter((f) => f.severity === "P1" || f.severity === "P0").every((f) => md.includes(`### ${f.id} `)) && journeys.every((j) => md.includes(`| ${j.id} |`)), "");
// Unfilled slots, not English prose: a finding may legitimately describe a shipped "placeholder".
const banned = /\bundefined\b|\bTODO\b|\bTBD\b|PENDING_PHASE2|PENDING_EXT|<placeholder>|\[placeholder\]|lorem ipsum|\bNaN\b/i;
const bad = Object.entries(outputs).filter(([, v]) => banned.test(v)).map(([k, v]) => `${k}: ${v.match(banned)[0]}`);
gate("no undefined, placeholder or TODO in final artifacts", bad.length === 0, bad.join("; "));
truth.gates = gates;
outputs["definitive-universal-evidence-capture-truth.json"] = J(truth);
outputs["definitive-universal-evidence-capture-truth.md"] = mdTruth();

// ------------------------------------------------------------------ write / check
let diffs = 0;
for (const [name, content] of Object.entries(outputs)) {
  const p = join(ROOT, name);
  if (CHECK) {
    const cur = existsSync(p) ? readFileSync(p, "utf8") : null;
    if (cur !== content) {
      diffs += 1;
      console.error(`DIFF ${name}`);
    }
  } else writeFileSync(p, content);
}
const failed = gates.filter((g) => !g.ok);
for (const g of gates) console.log(`${g.ok ? "PASS" : "FAIL"}  ${g.name}${g.detail ? `  (${g.detail})` : ""}`);
console.log(`${headline} | findings ${findings.length} ${JSON.stringify(sevCounts)} | journeys ${JSON.stringify(jCounts)} | ${CHECK ? `byte diffs ${diffs}` : "written"}`);
process.exit(failed.length || diffs ? 1 : 0);
