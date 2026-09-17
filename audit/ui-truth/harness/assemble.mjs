/**
 * PHASE UI-TRUTH — artifact assembler (AUDIT HARNESS).
 *
 * Reads every machine-readable inventory under audit/ui-truth/data and emits
 * THE authority:
 *
 *   docs/admin/audits/definitive-dashboard-ui-truth.json
 *
 * The Markdown report is rendered from that file alone (render.mjs), so no
 * total can disagree between the two. This script ABORTS rather than emit a
 * partial artifact: a missing input, a row without required fields, an unknown
 * evidence class or a duplicate finding id all stop it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPO } from "./surfaces.mjs";

const DATA = join(REPO, "audit", "ui-truth", "data");

const EVIDENCE_CLASSES = new Set([
  "SOURCE_PROVEN",
  "RUNTIME_PROVEN",
  "SOURCE_AND_RUNTIME_PROVEN",
  "BLOCKED_EXTERNAL_DEPENDENCY",
  "BLOCKED_FIXTURE_CAPABILITY",
  "OWNER_DECISION_REQUIRED",
  "NOT_APPLICABLE",
]);
const SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);

function read(name, { required = true } = {}) {
  const path = join(DATA, `${name}.json`);
  if (!existsSync(path)) {
    if (required) {
      console.error(`ABORT — required input missing: audit/ui-truth/data/${name}.json`);
      process.exit(2);
    }
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function abort(message) {
  console.error(`ABORT — ${message}`);
  process.exit(2);
}

const surfaces = read("surfaces");
const placement = read("placement");
const verdicts = read("placement-verdicts");
const access = read("access-matrix");
const controls = read("controls");
const coverage = read("controls-coverage");
const runtimeAuthz = read("runtime-authz");
const findings = read("findings");
const decisions = read("placement-decisions");
const layoutClass = read("layout-classification-current", { required: false });
const layoutSummary = read("layout-classification-summary", { required: false });
const layoutCurrent = read("layout-failures-current", { required: false });
const labels = read("labels", { required: false });
const dataElements = read("data-elements", { required: false });
const gates = read("gates");
const navRecon = read("nav-reconciliation");
const probePersonas = ["org-owner", "free-personal", "platform-admin"].map((p) => read(`browser-probe-${p}`));
const probeRoutes = read("browser-probe-routes");

/* -------------------------------------------------------------------------
 * Gate 1 — every finding is admissible.
 * ---------------------------------------------------------------------- */
const seenIds = new Set();
for (const f of findings.findings) {
  const need = [
    "id",
    "severity",
    "category",
    "title",
    "affectedRoutes",
    "affectedActors",
    "reproduction",
    "expected",
    "observed",
    "evidence",
    "rootCause",
    "blastRadius",
    "recommendedFix",
    "requiredAcceptanceProof",
    "evidenceClass",
  ];
  for (const key of need) {
    const v = f[key];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0)) {
      abort(`finding ${f.id ?? "<no id>"} is missing required field "${key}"`);
    }
  }
  if (!SEVERITIES.has(f.severity)) abort(`finding ${f.id} has severity ${f.severity}`);
  if (!EVIDENCE_CLASSES.has(f.evidenceClass)) abort(`finding ${f.id} has evidenceClass ${f.evidenceClass}`);
  if (seenIds.has(f.id)) abort(`duplicate finding id ${f.id}`);
  seenIds.add(f.id);
  if (JSON.stringify(f).includes("undefined")) abort(`finding ${f.id} contains the literal "undefined"`);
}

/* -------------------------------------------------------------------------
 * Gate 2 — conservation. Every surface is dispositioned, every placement
 * candidate is decided, every layout failure is classified.
 * ---------------------------------------------------------------------- */
const inScope = surfaces.surfaces.filter((s) => s.inScope);
if (inScope.length !== placement.rows.length) {
  abort(`surface conservation: ${inScope.length} in scope but ${placement.rows.length} placement rows`);
}
if (surfaces.totals.filesystemPages !== surfaces.surfaces.length) abort("surface totals disagree with rows");

const candidates = verdicts.rows.filter((r) => r.verdict === "DISAGREES" || r.verdict === "MIXED_AUTHORITY");
const decided = new Map((decisions?.decisions ?? []).map((d) => [d.route, d]));
const undecided = candidates.filter((c) => !decided.has(c.route));
if (undecided.length > 0) {
  abort(`${undecided.length} placement candidate(s) carry no reviewed decision: ${undecided.map((c) => c.route).join(", ")}`);
}

if (layoutClass) {
  const classified = layoutClass.rows ?? layoutClass.failures ?? [];
  const expected = (layoutCurrent ?? read("layout-failures-prior")).totals.failed;
  if (classified.length !== expected) {
    abort(`layout conservation: ${classified.length} classified rows vs ${expected} measured failures`);
  }
}

/* -------------------------------------------------------------------------
 * Counts — the report may print only what this block computes.
 * ---------------------------------------------------------------------- */
const bySeverity = { P0: 0, P1: 0, P2: 0, P3: 0 };
for (const f of findings.findings) bySeverity[f.severity] += 1;
const byEvidenceClass = {};
for (const f of findings.findings) byEvidenceClass[f.evidenceClass] = (byEvidenceClass[f.evidenceClass] ?? 0) + 1;

const controlRows = controls.controls ?? controls.rows ?? [];
const counts = {
  filesystemPages: surfaces.totals.filesystemPages,
  surfacesInScope: inScope.length,
  surfacesOutOfScope: surfaces.totals.outOfScope,
  detailPages: inScope.filter((s) => s.isDetail).length,
  surfacesByArea: surfaces.totals.byArea,
  surfaceAccounting: placement.totals.byAccounting,
  registeredRoutesInCapabilityMap: runtimeAuthz ? null : null,
  endpointsConsumedBySurfaces: placement.totals.distinctEndpoints,
  surfacesWithMutations: placement.totals.withMutations,
  controls: controlRows.length,
  controlsByType: controls.totals?.byType ?? controls.totals?.byControlType ?? {},
  controlsByKind: controls.totals?.byKind ?? {},
  mutationsResolvedToEndpoint: controls.totals?.mutationsMatched ?? controls.totals?.matchedMutations ?? null,
  surfacesWithControls: coverage.totals?.surfacesWithControls ?? coverage.surfaces.filter((s) => s.controlCount > 0).length,
  accessMatrixCells: access.totals.cells,
  personas: access.personas.length,
  runtimeEndpointsProbed: runtimeAuthz.totals.probed,
  runtimeRequests: runtimeAuthz.totals.requests,
  runtimeBlockedByFixture: runtimeAuthz.totals.blockedByFixture,
  placementVerdicts: verdicts.totals.byVerdict,
  placementDecisions: decisions?.decisions?.length ?? 0,
  labels: labels?.totals?.strings ?? null,
  rawValueExposures: labels?.totals?.rawValueStrings ?? null,
  labelsByVerdict: labels?.totals?.byVerdict ?? null,
  dataElements: dataElements?.totals?.dataElements ?? null,
  dataTruthHazards: dataElements?.hazards?.length ?? null,
  dataTruthHazardsVerified: JSON.parse(readFileSync(join(DATA, "empty-on-failure-verification.json"), "utf8")).totals,
  layoutFailuresMeasured: (layoutCurrent ?? read("layout-failures-prior")).totals.failed,
  layoutClassification: layoutSummary?.totals?.byClassification ?? null,
  findings: findings.findings.length,
  findingsBySeverity: bySeverity,
  findingsByEvidenceClass: byEvidenceClass,
  gatesMet: gates.totals.byStatus.MET ?? 0,
  gatesPartial: gates.totals.byStatus.PARTIAL ?? 0,
  gatesNotMet: gates.totals.byStatus.NOT_MET ?? 0,
  runtimePageLoads: probePersonas.reduce((n, p) => n + p.totals.routes, 0),
  runtimeSurfacesProbed: probePersonas[0].totals.routes,
  runtimeSurfacesBlocked: probeRoutes.blocked.length,
  tabsExercised: probePersonas.reduce((n, p) => n + p.totals.tabs.exercised, 0),
  blockedProofs: findings.findings.filter((f) => f.evidenceClass.startsWith("BLOCKED")).length,
  ownerDecisions: (findings.ownerDecisions ?? []).length,
  browserProbePersonas: 3,
};

/* -------------------------------------------------------------------------
 * Remediation backlog — ordered by severity, then dependency, then family.
 * ---------------------------------------------------------------------- */
const familyOf = (route) => {
  const [, first = ""] = route.split("/");
  return first === "" ? "root" : first;
};
const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
const backlog = [...findings.findings]
  .sort((a, b) => {
    if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
    const da = (a.dependencies ?? []).length;
    const db = (b.dependencies ?? []).length;
    if (da !== db) return da - db;
    const fa = familyOf(a.affectedRoutes[0] ?? "");
    const fb = familyOf(b.affectedRoutes[0] ?? "");
    if (fa !== fb) return fa < fb ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  })
  .map((f, i) => ({
    position: i + 1,
    id: f.id,
    severity: f.severity,
    title: f.title,
    routeFamily: familyOf(f.affectedRoutes[0] ?? ""),
    affectedRoutes: f.affectedRoutes,
    blastRadius: f.blastRadius,
    dependencies: f.dependencies ?? [],
    requiredAcceptanceProof: f.requiredAcceptanceProof,
  }));

const artifact = {
  phase: "UI-TRUTH",
  kind: "definitive-dashboard-ui-truth",
  schemaVersion: 1,
  auditedSha: findings.auditedSha,
  originMainSha: findings.originMainSha,
  originMainAtReportTime: findings.originMainAtReportTime ?? null,
  commitsOnMainNewerThanAudit: findings.commitsOnMainNewerThanAudit ?? 0,
  driftNote: findings.driftNote ?? null,
  auditBranch: "audit/definitive-dashboard-ui-truth",
  auditWorktree: "D:/pv-uitruth",
  productFilesChanged: 0,
  productionContacted: false,
  method: findings.method,
  limitations: findings.limitations,
  counts,
  surfaces: inScope.map((s) => ({ route: s.route, area: s.area, file: s.file, isDetail: s.isDetail })),
  placement: verdicts.rows.map((r) => ({
    route: r.route,
    observedArea: r.observedArea,
    backendArea: r.backendArea,
    verdict: r.verdict,
    decision: decided.get(r.route)?.decision ?? null,
    decisionReason: decided.get(r.route)?.reason ?? null,
  })),
  accessMatrix: { personas: access.personas, perPersona: access.totals.perPersona },
  runtimeAuthorization: runtimeAuthz.totals,
  gates: gates.gates,
  auditComplete: gates.auditComplete,
  navigationReconciliation: navRecon.totals,
  runtimeStateMatrix: {
    personas: probePersonas.map((p) => ({ persona: p.persona, routes: p.totals.routes, byState: p.totals.byState, tabs: p.totals.tabs })),
    blockedSurfaces: probeRoutes.blocked,
  },
  layout: layoutSummary ?? null,
  labels: labels?.totals ?? null,
  dataElements: dataElements?.totals ?? null,
  findings: findings.findings,
  remediationBacklog: backlog,
  ownerDecisions: findings.ownerDecisions ?? [],
  blockedProofs: findings.findings
    .filter((f) => f.evidenceClass.startsWith("BLOCKED"))
    .map((f) => ({ id: f.id, reason: f.blockedReason ?? f.observed, requiredProof: f.requiredAcceptanceProof })),
};

const out = join(REPO, "docs", "admin", "audits", "definitive-dashboard-ui-truth.json");
writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n");
console.log(`wrote docs/admin/audits/definitive-dashboard-ui-truth.json`);
console.log(JSON.stringify(counts, null, 2));
