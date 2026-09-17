/**
 * PHASE UI-TRUTH — Markdown renderer (AUDIT HARNESS).
 *
 * Renders docs/admin/audits/definitive-dashboard-ui-truth.md from the JSON
 * artifact and from NOTHING ELSE, so the two can never disagree. Every number
 * printed here is read out of `counts`; the renderer computes none of its own.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPO } from "./surfaces.mjs";

const JSON_PATH = join(REPO, "docs", "admin", "audits", "definitive-dashboard-ui-truth.json");
const a = JSON.parse(readFileSync(JSON_PATH, "utf8"));
const c = a.counts;

const table = (headers, rows) =>
  [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join(
    "\n",
  );

const dict = (obj) =>
  Object.entries(obj ?? {})
    .sort((x, y) => (typeof y[1] === "number" && typeof x[1] === "number" ? y[1] - x[1] : x[0] < y[0] ? -1 : 1))
    .map(([k, v]) => [k, String(v)]);

const out = [];
out.push(`# PHASE UI-TRUTH — definitive dashboard, admin, platform-admin and enterprise audit`);
out.push("");
out.push(`Generated from \`docs/admin/audits/definitive-dashboard-ui-truth.json\` by \`audit/ui-truth/harness/render.mjs\`. Do not hand-edit: every total below is read from that file.`);
out.push("");

out.push(`## Executive verdict`);
out.push("");
out.push(a.verdict ?? "See the findings table; the closing line of this report states the verdict.");
out.push("");
out.push(
  table(
    ["Item", "Value"],
    [
      ["Audited SHA", a.auditedSha],
      ["origin/main SHA", a.originMainSha],
      ["Audit branch", a.auditBranch],
      ["Audit worktree", a.auditWorktree],
      ["Product files changed", String(a.productFilesChanged)],
      ["Production contacted", a.productionContacted ? "yes" : "no"],
      ["Findings", String(c.findings)],
      ["P0 / P1 / P2 / P3", `${c.findingsBySeverity.P0} / ${c.findingsBySeverity.P1} / ${c.findingsBySeverity.P2} / ${c.findingsBySeverity.P3}`],
      ["Blocked proofs", String(c.blockedProofs)],
      ["Owner decisions", String(a.ownerDecisions.length)],
    ],
  ),
);
out.push("");

out.push(`## Method`);
out.push("");
for (const m of a.method) out.push(`- ${m}`);
out.push("");
out.push(`### Limitations`);
out.push("");
for (const l of a.limitations) out.push(`- ${l}`);
out.push("");

out.push(`## Surface accounting`);
out.push("");
out.push(
  table(
    ["Measure", "Count"],
    [
      ["Filesystem pages", String(c.filesystemPages)],
      ["In scope", String(c.surfacesInScope)],
      ["Out of scope", String(c.surfacesOutOfScope)],
      ["Detail pages (dynamic parameters)", String(c.detailPages)],
      ["Distinct endpoints consumed", String(c.endpointsConsumedBySurfaces)],
      ["Surfaces with at least one mutation", String(c.surfacesWithMutations)],
    ],
  ),
);
out.push("");
out.push(`### By area`);
out.push("");
out.push(table(["Area", "Pages"], dict(c.surfacesByArea)));
out.push("");
out.push(`### Registration and gating`);
out.push("");
out.push(table(["Accounting", "Surfaces"], dict(c.surfaceAccounting)));
out.push("");

out.push(`## Placement: backend authority versus filesystem position`);
out.push("");
out.push(table(["Verdict", "Surfaces"], dict(c.placementVerdicts)));
out.push("");
out.push(`${c.placementDecisions} surface(s) whose backend disagreed with their position carry a reviewed decision:`);
out.push("");
out.push(
  table(
    ["Route", "Observed", "Backend says", "Decision"],
    a.placement
      .filter((p) => p.decision)
      .map((p) => [p.route, p.observedArea, p.backendArea ?? "—", p.decision]),
  ),
);
out.push("");

out.push(`## Role, plan and workspace matrix`);
out.push("");
out.push(`${c.accessMatrixCells} cells: ${c.surfacesInScope} surfaces × ${c.personas} personas, resolved through the product's own capability and route-access resolvers.`);
out.push("");
out.push(
  table(
    ["Persona", "Access states"],
    Object.entries(a.accessMatrix.perPersona).map(([id, states]) => [
      id,
      Object.entries(states)
        .sort((x, y) => y[1] - x[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(", "),
    ]),
  ),
);
out.push("");
out.push(`### Runtime authorization`);
out.push("");
out.push(
  `${c.runtimeEndpointsProbed} read endpoints probed against the disposable loopback fixture across ${c.runtimeRequests} requests; ${c.runtimeBlockedByFixture} endpoints could not be probed and are recorded as blocked, never assumed.`,
);
out.push("");

out.push(`## Controls`);
out.push("");
out.push(
  table(
    ["Measure", "Count"],
    [
      ["Interactive controls inventoried", String(c.controls)],
      ["Surfaces with controls", String(c.surfacesWithControls)],
      ["Mutations resolved to an endpoint", String(c.mutationsResolvedToEndpoint ?? "—")],
    ],
  ),
);
out.push("");
if (Object.keys(c.controlsByKind ?? {}).length > 0) {
  out.push(table(["Kind", "Count"], dict(c.controlsByKind)));
  out.push("");
}
if (Object.keys(c.controlsByType ?? {}).length > 0) {
  out.push(table(["Type", "Count"], dict(c.controlsByType)));
  out.push("");
}

if (c.labels !== null || c.dataElements !== null) {
  out.push(`## Content and data truth`);
  out.push("");
  out.push(
    table(
      ["Measure", "Count"],
      [
        ["User-visible strings inventoried", String(c.labels ?? "—")],
        ["Raw-value exposures", String(c.rawValueExposures ?? "—")],
        ["Data elements inventoried", String(c.dataElements ?? "—")],
        ["Data-truth hazards", String(c.dataTruthHazards ?? "—")],
      ],
    ),
  );
  out.push("");
}

if (c.layoutClassification) {
  out.push(`## Layout, responsive and accessibility`);
  out.push("");
  out.push(`${c.layoutFailuresMeasured} failing layout tests were measured on the audited SHA and every one is classified:`);
  out.push("");
  out.push(table(["Classification", "Count"], dict(c.layoutClassification)));
  out.push("");
}

out.push(`## Conservation and quality gates`);
out.push("");
out.push(`${c.gatesMet} met, ${c.gatesPartial} partial, ${c.gatesNotMet} not met. The audit is complete only when every gate is met; this one is ${a.auditComplete ? "complete" : "INCOMPLETE"}.`);
out.push("");
out.push(table(["#", "Gate", "Status", "Measure", "Remainder"], a.gates.map((g) => [String(g.id), g.statement, g.status, g.measure, g.remainder ?? "—"])));
out.push("");
out.push(`## Runtime state matrix`);
out.push("");
out.push(`${c.runtimeSurfacesProbed} surfaces probed signed-in for each of three personas (${c.runtimePageLoads} page loads), ${c.tabsExercised} tabs clicked. ${c.runtimeSurfacesBlocked} surfaces are blocked by fixture capability and were never probed with an invented id.`);
out.push("");
out.push(table(["Persona", "Routes", "States"], a.runtimeStateMatrix.personas.map((p) => [p.persona, String(p.routes), Object.entries(p.byState).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(", ")])));
out.push("");
out.push(`## Findings`);
out.push("");
out.push(
  table(
    ["ID", "Severity", "Category", "Title", "Evidence"],
    a.findings.map((f) => [f.id, f.severity, f.category, f.title, f.evidenceClass]),
  ),
);
out.push("");
for (const f of a.findings) {
  out.push(`### ${f.id} — ${f.title}`);
  out.push("");
  out.push(`**Severity** ${f.severity} · **Category** ${f.category} · **Evidence** ${f.evidenceClass}`);
  out.push("");
  out.push(`**Routes** ${f.affectedRoutes.join(", ")}`);
  out.push("");
  out.push(`**Actors** ${f.affectedActors.join(", ")}`);
  out.push("");
  out.push(`**Reproduction.** ${f.reproduction}`);
  out.push("");
  out.push(`**Expected.** ${f.expected}`);
  out.push("");
  out.push(`**Observed.** ${f.observed}`);
  out.push("");
  out.push(`**Evidence.**`);
  for (const e of f.evidence) out.push(`- ${e}`);
  out.push("");
  out.push(`**Root cause.** ${f.rootCause}`);
  out.push("");
  out.push(`**Blast radius.** ${f.blastRadius}`);
  out.push("");
  out.push(`**Recommended fix.** ${f.recommendedFix}`);
  out.push("");
  out.push(`**Required acceptance proof.** ${f.requiredAcceptanceProof}`);
  out.push("");
}

out.push(`## Owner decisions`);
out.push("");
for (const d of a.ownerDecisions) {
  out.push(`### ${d.id} — ${d.question}`);
  out.push("");
  out.push(d.context);
  out.push("");
  out.push(`Options: ${d.options.join("; ")}.`);
  out.push("");
  out.push(`Recommendation: ${d.recommendation}`);
  out.push("");
}

out.push(`## Remediation backlog`);
out.push("");
out.push(
  table(
    ["#", "ID", "Severity", "Route family", "Title", "Depends on"],
    a.remediationBacklog.map((b) => [
      String(b.position),
      b.id,
      b.severity,
      b.routeFamily,
      b.title,
      b.dependencies.length > 0 ? b.dependencies.join(", ") : "—",
    ]),
  ),
);
out.push("");

if (a.blockedProofs.length > 0) {
  out.push(`## Blocked proofs`);
  out.push("");
  out.push(table(["ID", "Required proof"], a.blockedProofs.map((b) => [b.id, b.requiredProof])));
  out.push("");
}

writeFileSync(join(REPO, "docs", "admin", "audits", "definitive-dashboard-ui-truth.md"), out.join("\n") + "\n");
console.log("wrote docs/admin/audits/definitive-dashboard-ui-truth.md");
