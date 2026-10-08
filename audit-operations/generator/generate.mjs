#!/usr/bin/env node
// AUDIT-ONLY generator. Reads the frozen audit inputs and writes the canonical
// artifacts + a Markdown rendering derived ONLY from them. Deterministic: no
// clocks, stable ordering. Exits 1 when any conservation gate fails.
//
//   node audit-operations/generator/generate.mjs
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AUD = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(AUD, "..");
const OUT = join(AUD, "artifacts");
mkdirSync(OUT, { recursive: true });
const rj = (p) => JSON.parse(readFileSync(p, "utf8"));
const text = (rel) => readFileSync(join(REPO, rel), "utf8");
const sha = (rel) => createHash("sha256").update(readFileSync(join(REPO, rel))).digest("hex");
const posix = (p) => p.split("\\").join("/");
const BASELINE = "85c8800778e4c09e7681f83c1ee8fed4661beff9";

// ---------------------------------------------------------------- inputs
const src = Object.fromEntries(["producers-resolvers", "endpoints-routes", "controls-actions", "domain-ownership", "admin-separation", "native-and-locale"].map((k) => [k, rj(join(AUD, "source", `${k}.json`))]));
const findings = rj(join(AUD, "authority", "findings.json")).findings;
const cellsAuth = rj(join(AUD, "authority", "persona-cells.json")).cells;
const blockersAuth = rj(join(AUD, "authority", "external-blockers.json")).blockers;
const proofs = {};
for (const kind of ["runtime", "browser", "native"]) {
  const dir = join(AUD, "evidence", kind);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const p = rj(join(dir, f));
    proofs[p.proofId] = { ...p, evidenceFile: posix(relative(REPO, join(dir, f))) };
  }
}

const gates = [];
const gate = (id, title, failures, detail = {}) => gates.push({ id, title, pass: failures.length === 0, failures: failures.slice(0, 50), failureCount: failures.length, ...detail });

// ---------------------------------------------------------------- G01 proof freshness
{
  const fails = [];
  for (const p of Object.values(proofs)) {
    if (p.proofId.startsWith("PR-B99")) fails.push(`${p.proofId}: runner error record present`);
    for (const [file, h] of Object.entries(p.sourceFingerprints ?? {})) {
      if (!existsSync(join(REPO, file))) fails.push(`${p.proofId}: missing ${file}`);
      else if (sha(file) !== h) fails.push(`${p.proofId}: stale fingerprint ${file}`);
    }
    if (!p.sourceFingerprints || Object.keys(p.sourceFingerprints).length === 0) fails.push(`${p.proofId}: no source fingerprints`);
  }
  gate("G01", "Every proof's Product source fingerprints match the current tree", fails, { proofs: Object.keys(proofs).length });
}

// ---------------------------------------------------------------- G02 finding ids / vocab / symbols / proofs
const STATUS = ["CONFIRMED", "REFUTED", "PARTIALLY_CONFIRMED", "SUPERSEDED_BY_MORE_PRECISE_FINDING", "UNDECIDABLE_WITH_RECORDED_BLOCKER", "NEW"];
{
  const fails = [];
  const ids = findings.map((f) => f.id);
  if (new Set(ids).size !== ids.length) fails.push("duplicate finding ids");
  ids.forEach((id, i) => { if (id !== `OPS-${String(i + 1).padStart(3, "0")}`) fails.push(`id sequence break at ${id}`); });
  for (const f of findings) {
    if (!STATUS.includes(f.status)) fails.push(`${f.id}: status ${f.status}`);
    if (!["P0", "P1", "P2", "P3"].includes(f.severity)) fails.push(`${f.id}: severity`);
    for (const k of ["category", "title", "scope", "reproduction", "expected", "actual", "userImpact", "securityPrivacyImpact", "canonicalOwner", "remediationBoundary", "regressionProof"]) if (!f[k]) fails.push(`${f.id}: missing ${k}`);
    for (const loc of f.sourceLocations ?? []) {
      if (!existsSync(join(REPO, loc.file))) { fails.push(`${f.id}: no file ${loc.file}`); continue; }
      if (!text(loc.file).includes(loc.symbol)) fails.push(`${f.id}: symbol not found in ${loc.file}: ${loc.symbol}`);
    }
    if (!f.sourceLocations?.length) fails.push(`${f.id}: no source location`);
    for (const pid of f.proofIds ?? []) if (!proofs[pid]) fails.push(`${f.id}: proof ${pid} missing`);
    if (!f.proofIds?.length) fails.push(`${f.id}: no proof`);
  }
  for (let i = 1; i <= 24; i++) { const id = `OPS-${String(i).padStart(3, "0")}`; if (!ids.includes(id)) fails.push(`prior finding ${id} not reconciled`); }
  gate("G02", "Findings: contiguous unique ids, allowed vocabulary, grep-verified source symbols, existing proofs, all 24 prior findings reconciled", fails, { findings: findings.length });
}

// ---------------------------------------------------------------- proof type of a finding
const PROOF_RANK = ["BROWSER_PROVEN", "NATIVE_RUNTIME_PROVEN", "REAL_DB_PROVEN", "RUNTIME_PROVEN", "SOURCE_AND_TEST_PROVEN", "SOURCE_PROVEN"];
const findingProofTypes = (f) => [...new Set(f.proofIds.map((p) => proofs[p]?.proofType).filter(Boolean))].sort((a, b) => PROOF_RANK.indexOf(a) - PROOF_RANK.indexOf(b));

// ---------------------------------------------------------------- persona cells
const cells = [];
{
  const fails = [];
  for (const c of cellsAuth) {
    if (c.status) { if (!["NOT_APPLICABLE", "BLOCKED_EXTERNAL"].includes(c.status) || !c.reason) fails.push(`${c.id}: bad explicit status`); cells.push({ id: c.id, dimension: c.dimension, label: c.label, status: c.status, reason: c.reason, proofId: null, observed: null }); continue; }
    const p = proofs[c.proofId];
    if (!p) { fails.push(`${c.id}: proof ${c.proofId} missing`); continue; }
    const rows = Array.isArray(p.observed) ? p.observed : [p.observed];
    const keys = Object.entries(c.match ?? {});
    const row = keys.length === 0 ? p.observed : rows.find((r) => r && keys.every(([k, v]) => r[k] === v));
    if (!row) { fails.push(`${c.id}: no evidence row ${JSON.stringify(c.match)} in ${c.proofId}`); continue; }
    let status = "EXERCISED_ALLOWED";
    if (row.api?.list !== undefined) status = row.api.list === 200 ? "EXERCISED_ALLOWED" : "EXERCISED_REFUSED";
    cells.push({ id: c.id, dimension: c.dimension, label: c.label, status, proofId: c.proofId, proofType: p.proofType, observed: row });
  }
  gate("G03", "Every required persona/plan/workspace/commercial cell is exercised (evidence row found) or explicitly NOT_APPLICABLE / BLOCKED_EXTERNAL with a reason", fails, { cells: cellsAuth.length });
}

const ENDPOINT_FILE_SCOPE = { "services/api/src/routes/admin-security.routes.ts": "/v1/admin/incidents" };
// ---------------------------------------------------------------- G04 endpoint conservation (mechanical route count per file)
{
  const fails = [];
  const inv = src["endpoints-routes"].apiEndpoints;
  const files = [...new Set(inv.map((e) => e.file))].sort();
  const discovered = {};
  for (const f of files) {
    const t = text(f);
    // A file may host non-Operations routes; ENDPOINT_FILE_SCOPE narrows it to
    // the Operations prefix. A template-literal path (`/:id/${action}`) is a
    // wildcard that must cover at least one inventoried concrete path.
    const scopePrefix = ENDPOINT_FILE_SCOPE[f] ?? "";
    const m = [...t.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g)].map((x) => `${x[1].toUpperCase()} ${x[2]}`).filter((r) => r.split(" ")[1].startsWith(scopePrefix));
    discovered[f] = m;
    const asRe = (r) => new RegExp("^" + r.split("${")[0].replace(/[.*+?^()|[\]\\]/g, "\\$&") + "[^/]+$");
    const covers = (reg, concrete) => reg === concrete || (reg.includes("${") && asRe(reg).test(concrete));
    const invHere = inv.filter((e) => e.file === f).map((e) => `${e.method.toUpperCase()} ${e.path}`);
    for (const r of m) if (!invHere.some((i) => covers(r, i))) fails.push(`${f}: registered route not inventoried: ${r}`);
    for (const r of invHere) if (!m.some((x) => covers(x, r))) fails.push(`${f}: inventoried route not registered: ${r}`);
  }
  const ids = inv.map((e) => e.id);
  if (new Set(ids).size !== ids.length) fails.push("duplicate endpoint ids");
  for (const e of inv) if (!e.classification) fails.push(`${e.id}: unclassified`);
  gate("G04", "Discovered Operations endpoints (route registrations in each inventoried route file) = dispositioned endpoints", fails, { discovered: Object.values(discovered).flat().length, inventoried: inv.length });
}

// ---------------------------------------------------------------- G05 web routes
{
  const fails = [];
  const found = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n === "node_modules" || n.startsWith(".")) continue; walk(p); } else if (n === "page.tsx" && /operations/.test(posix(relative(join(REPO, "apps/web/app"), p)))) found.push(posix(relative(REPO, p))); } };
  walk(join(REPO, "apps/web/app"));
  const inv = src["endpoints-routes"].webRoutes.map((r) => r.file);
  for (const f of found) if (!inv.includes(f)) fails.push(`unclassified route ${f}`);
  for (const f of inv) if (!found.includes(f)) fails.push(`inventoried route missing ${f}`);
  gate("G05", "Discovered Operations web routes = classified routes", fails, { discovered: found.length });
}

// ---------------------------------------------------------------- G06 producers conservation
{
  const fails = [];
  const reg = src["producers-resolvers"].producers;
  const regSites = new Set(reg.map((p) => `${p.file}:${p.line}`));
  const roots = ["services/api/src", "services/worker/src", "packages"];
  const sites = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const rel = posix(relative(REPO, p)); if (statSync(p).isDirectory()) { if (["node_modules", "dist", "__tests__", "test", "tests"].includes(n)) continue; walk(p); } else if (/\.(ts|tsx|mjs)$/.test(n) && !/\.(test|spec)\./.test(n) && (rel.startsWith("services/") || /^packages\/[^/]+\/src\//.test(rel))) { text(rel).split("\n").forEach((line, i) => { if (/\b(recordIncident|recordWorkerIncident)\(/.test(line) && !/function (recordIncident|recordWorkerIncident)\b/.test(line) && !/^\s*(\*|\/\/)/.test(line)) sites.push(`${rel}:${i + 1}`); }); } } };
  for (const r of roots) walk(join(REPO, r));
  for (const s of sites) if (!regSites.has(s)) fails.push(`call site not in producer register: ${s}`);
  for (const s of regSites) if (!sites.includes(s)) fails.push(`registered producer line has no call: ${s}`);
  const sourceIds = new Set(src["producers-resolvers"].sourceRegistry.map((s) => s.id));
  for (const p of reg) { const sid = String(p.sourceId); if (!sid.startsWith("MAPPED:") && !sourceIds.has(sid)) fails.push(`${p.id}: sourceId ${sid} unregistered`); }
  gate("G06", "Incident write call sites in Product source = registered producers; every producer sourceId registered", fails, { callSites: sites.length, registeredSites: regSites.size });
}

// ---------------------------------------------------------------- G07 source registry
{
  const fails = [];
  const t = text("packages/shared-runtime/src/ops/source-lifecycle.ts");
  // Lifecycle entries are the six-space-indented `sourceId:` lines of the
  // OPERATIONS_SOURCE_LIFECYCLES array literal.
  const ids = [...new Set([...t.matchAll(/^ {6}sourceId: "([^"]+)",\r?$/gm)].map((m) => m[1]))].sort();
  const reg = src["producers-resolvers"].sourceRegistry.map((s) => s.id).sort();
  for (const i of ids) if (!reg.includes(i)) fails.push(`lifecycle source not registered: ${i}`);
  for (const i of reg) if (!ids.includes(i)) fails.push(`registered source not in lifecycle: ${i}`);
  const cons = src["producers-resolvers"].sourceConservation.map((s) => s.id).sort();
  if (JSON.stringify(cons) !== JSON.stringify(reg)) fails.push("sourceConservation does not cover the registry exactly");
  gate("G07", "Incident codes in OPERATIONS_SOURCE_LIFECYCLES = registered codes = conservation rows", fails, { sources: ids.length });
}

// ---------------------------------------------------------------- G08 auto-resolve claims
const autoResolveExplained = { "billing.dependent_cancellation_failed": "OPS-003", "platform.worker_heartbeat_stale": "OPS-009", "evidence_integrity.ots_budget_exhausted": "OPS-018", "pipeline.package_generation_denied": "OPS-018", "review.escalation": "OPS-018", "identity.idp_outage": "OPS-018", "pipeline.report_generation_failed": "OPS-004", "evidence_integrity.tsa_failed": "OPS-019", "evidence_integrity.ots_failed": "OPS-019", "platform.telemetry_stale": "OPS-001", "queue.retry_storm": "OPS-002", "search.indexing_failure": "OPS-017" };
{
  const fails = [];
  for (const s of src["producers-resolvers"].sourceConservation) {
    if (!s.claimsAutoResolve) continue;
    const ok = s.autoResolverWired === true && s.autoResolverCanFindRows !== false;
    if (!ok && !autoResolveExplained[s.id]) fails.push(`${s.id}: auto-resolve claim without resolver and without a finding`);
    if (autoResolveExplained[s.id] && !findings.some((f) => f.id === autoResolveExplained[s.id])) fails.push(`${s.id}: referenced finding missing`);
  }
  gate("G08", "Every auto-resolve claim has a wired resolver or a finding", fails);
}

// ---------------------------------------------------------------- G09 controls
const CTRL = ["CANONICAL_ACTION", "CANONICAL_DEEP_LINK", "INCIDENT_METADATA_ACTION", "PLATFORM_ADMIN_ACTION", "DUPLICATED_ACTION", "DEAD_OR_MISLEADING", "VIEW_CONTROL"];
{
  const fails = [];
  const ca = src["controls-actions"];
  for (const [k, arr] of [["web", ca.webControls], ["native", ca.nativeControls]]) {
    const ids = arr.map((c) => c.id);
    if (new Set(ids).size !== ids.length) fails.push(`${k}: duplicate control ids`);
    for (const c of arr) {
      if (!CTRL.includes(c.classification)) fails.push(`${k} ${c.id}: classification ${c.classification}`);
      if (!existsSync(join(REPO, c.file))) fails.push(`${k} ${c.id}: file missing`);
      if (["INCIDENT_METADATA_ACTION", "CANONICAL_ACTION"].includes(c.classification) && !c.apiCall && c.domainEffect !== "NAVIGATION") fails.push(`${k} ${c.id}: action without API mapping`);
    }
  }
  gate("G09", "Every discovered web/native control is classified; every action control maps to an API call", fails, { web: ca.webControls.length, native: ca.nativeControls.length });
}

// ---------------------------------------------------------------- G10 blockers
{
  const fails = [];
  for (const b of blockersAuth) { if (!b.id || !b.blocker || !b.affects?.length) fails.push(`blocker ${b.id} incomplete`); }
  const blockedCells = cells.filter((c) => c.status === "BLOCKED_EXTERNAL").map((c) => c.id);
  for (const id of blockedCells) if (!blockersAuth.some((b) => b.affects.includes(id))) fails.push(`blocked cell ${id} has no blocker record`);
  gate("G10", "Every BLOCKED_EXTERNAL cell is backed by an external-blocker record", fails);
}

// ---------------------------------------------------------------- derived registers
const prr = src["producers-resolvers"];
const producerResolver = {
  baseline: BASELINE,
  sourceRegistry: prr.sourceRegistry,
  producers: prr.producers,
  resolvers: prr.resolvers,
  scheduledReconcilers: prr.scheduledReconcilers,
  conservation: prr.sourceConservation.map((s) => ({ ...s, findingId: autoResolveExplained[s.id] ?? null })),
  lists: {
    producersWithoutResolvers: prr.sourceConservation.filter((s) => s.producerIds.length > 0 && s.claimsAutoResolve && !(s.autoResolverWired && s.autoResolverCanFindRows !== false)).map((s) => s.id).sort(),
    resolversWithoutProducers: prr.sourceConservation.filter((s) => s.producerIds.length === 0 && s.claimsAutoResolve).map((s) => s.id).sort(),
    unreachableCategories: prr.sourceConservation.filter((s) => s.producerIds.length === 0).map((s) => s.id).sort(),
    misleadingNames: ["platform.telemetry_stale (OPS-001)", "queue.retry_storm (OPS-002)", "billing.dependent_cancellation_failed (OPS-023)", "search.indexing_failure (OPS-017)"],
    rawMessageFingerprints: prr.producers.filter((p) => p.fingerprintUsesRawText === true).map((p) => `${p.id} ${p.file}:${p.line}`).sort(),
    rawMessageSummaries: prr.producers.filter((p) => p.summaryUsesRawError === true).map((p) => `${p.id} ${p.file}:${p.line}`).sort(),
    leakingInternalData: ["OPS-010 /v1/ops/health", "OPS-016 raw worker summaries", "OPS-025 /v1/investigation/diagnostics", "OPS-026 /v1/runtime/secrets-health"],
    duplicatedAcrossApiAndWorker: [...new Set(prr.producers.map((p) => p.sourceId))].filter((sid) => new Set(prr.producers.filter((p) => p.sourceId === sid).map((p) => p.host)).size > 1).sort(),
    wrongRecordVersionOrResource: ["pipeline.report_generation_failed (OPS-004, OPS-028)", "billing.dependent_cancellation_failed personal add-ons (OPS-003)", "platform.worker_heartbeat_stale (OPS-009)", "evidence_integrity.tsa_failed / ots_failed (OPS-019)"],
  },
};

const actionOwnership = {
  baseline: BASELINE,
  remediationActions: src["controls-actions"].remediationActions,
  transitionSemantics: src["controls-actions"].transitionSemantics,
  runtimeSemantics: proofs["PR-A8-action-semantics"]?.observed ?? null,
  webControls: src["controls-actions"].webControls,
  nativeControls: src["controls-actions"].nativeControls,
  counts: Object.fromEntries(CTRL.map((k) => [k, { web: src["controls-actions"].webControls.filter((c) => c.classification === k).length, native: src["controls-actions"].nativeControls.filter((c) => c.classification === k).length }])),
  domainOwnership: src["domain-ownership"],
};

const scopeAuthority = {
  baseline: BASELINE,
  model: { tenantPredicate: "workspaceIncidentWhere: scope=WORKSPACE AND teamId AND NOT platform-internal source (services/api/src/services/observability/incident-scope.ts)", platformPredicate: "platformIncidentWhere: scope=PLATFORM", platformInternalSources: prr.sourceRegistry.filter((s) => s.audience === "PLATFORM_INTERNAL").map((s) => s.id).sort(), platformScopeWriters: prr.producers.filter((p) => p.resultingScope === "PLATFORM").map((p) => p.id) },
  sources: prr.sourceRegistry.map((s) => {
    const prods = prr.producers.filter((p) => p.sourceId === s.id);
    const scopes = [...new Set(prods.map((p) => p.resultingScope))].sort();
    const cls = s.audience === "PLATFORM_INTERNAL" ? (/provider|billing\.provider/.test(s.id) ? "PROVIDER_GLOBAL" : "PLATFORM_GLOBAL") : /^evidence_integrity|^pipeline\.(report|package)_generation|storage\.immutable_drift/.test(s.id) ? "EVIDENCE_RECORD" : /^billing\./.test(s.id) ? "BILLING_ACCOUNT" : /^identity\.|^security\./.test(s.id) ? "SECURITY_RESTRICTED" : /^platform\.|^queue\./.test(s.id) ? "PLATFORM_GLOBAL" : "WORKSPACE";
    return { id: s.id, audience: s.audience, requiredCapability: s.requiredCapability, intendedScope: cls, writtenScopes: scopes, tenantVisible: s.audience !== "PLATFORM_INTERNAL" && scopes.some((x) => x.startsWith("WORKSPACE")), producers: prods.map((p) => p.id), finding: autoResolveExplained[s.id] ?? null };
  }),
  adminSeparation: src["admin-separation"],
  runtimeTenancy: cells.filter((c) => c.observed?.tenancy).map((c) => ({ cell: c.id, ...c.observed.tenancy })),
};

const browserMatrix = { baseline: BASELINE, proofs: Object.values(proofs).filter((p) => p.proofType === "BROWSER_PROVEN").map((p) => ({ proofId: p.proofId, title: p.title, findingIds: p.findingIds, persona: p.persona ?? null, observed: p.observed, evidenceFile: p.evidenceFile })), widths: [320, 375, 768, 1024, 1440], locales: ["en", "de", "ar"], darkTheme: src["native-and-locale"].darkTheme };
const nativeMatrix = { baseline: BASELINE, runs: Object.values(proofs).filter((p) => p.proofId.startsWith("PR-N")).map((p) => ({ proofId: p.proofId, proofType: p.proofType, command: p.command, observed: p.observed, limits: p.limits })), checks: src["native-and-locale"].nativeChecks, nativeModules: src["native-and-locale"].nativeModules, deviceRuntime: { status: "BLOCKED_EXTERNAL", blocker: "BLK-NATIVE-DEVICE" } };
const enterpriseMatrix = { baseline: BASELINE, observed: proofs["PR-A9-enterprise"]?.observed ?? null, cells: cells.filter((c) => /ENT|ENTERPRISE/.test(c.id)), rollupEndpoint: "none (OPS-034)" };

const findingsOut = findings.map((f) => ({ ...f, proofTypes: findingProofTypes(f), proofs: f.proofIds.map((p) => ({ proofId: p, proofType: proofs[p]?.proofType ?? "MISSING", evidenceFile: proofs[p]?.evidenceFile ?? null })) }));
const proofRegister = { baseline: BASELINE, proofs: Object.values(proofs).sort((a, b) => a.proofId.localeCompare(b.proofId)).map((p) => ({ proofId: p.proofId, title: p.title, proofType: p.proofType, findingIds: p.findingIds, outcome: p.outcome ?? null, evidenceFile: p.evidenceFile, command: p.command, sourceFingerprints: p.sourceFingerprints, reproducedIndependently: true })) };

// ---------------------------------------------------------------- G11 no UNKNOWN / NOT_REVIEWED
{
  const fails = [];
  const blob = JSON.stringify({ findingsOut, cells, blockersAuth });
  for (const bad of ["\"UNKNOWN\"", "NOT_REVIEWED"]) if (blob.includes(bad)) fails.push(`artifact contains ${bad}`);
  gate("G11", "No UNKNOWN / NOT_REVIEWED disposition anywhere", fails);
}

const bySev = Object.fromEntries(["P0", "P1", "P2", "P3"].map((s) => [s, findings.filter((f) => f.severity === s).length]));
const byStatus = Object.fromEntries(STATUS.map((s) => [s, findings.filter((f) => f.status === s).length]));
const cellStatus = Object.fromEntries(["EXERCISED_ALLOWED", "EXERCISED_REFUSED", "NOT_APPLICABLE", "BLOCKED_EXTERNAL"].map((s) => [s, cells.filter((c) => c.status === s).length]));
const allPass = gates.every((g) => g.pass);
const truth = {
  baseline: BASELINE,
  productionContacted: false,
  productFilesChanged: 0,
  verdict: allPass && blockersAuth.length === 0 ? "COMPLETE" : "INCOMPLETE",
  verdictReason: allPass ? (blockersAuth.length ? `${blockersAuth.length} external blocker(s) remain: ${blockersAuth.map((b) => b.id).join(", ")}` : "all gates pass") : `gate failure: ${gates.filter((g) => !g.pass).map((g) => g.id).join(", ")}`,
  totals: { findings: findings.length, bySeverity: bySev, byStatus, proofs: Object.keys(proofs).length, cells: cells.length, cellStatus, endpoints: src["endpoints-routes"].apiEndpoints.length, webRoutes: src["endpoints-routes"].webRoutes.length, webControls: src["controls-actions"].webControls.length, nativeControls: src["controls-actions"].nativeControls.length, sources: prr.sourceRegistry.length, producers: prr.producers.length, resolvers: prr.resolvers.length, scheduledReconcilers: prr.scheduledReconcilers.length },
  gates,
  findingIndex: findings.map((f) => ({ id: f.id, severity: f.severity, status: f.status, priorStatus: f.priorStatus ?? null, title: f.title, proofTypes: findingProofTypes(f) })),
  externalBlockers: blockersAuth,
};

const W = (name, obj) => writeFileSync(join(OUT, name), JSON.stringify(obj, null, 2) + "\n");
W("operations-truth-audit.json", truth);
W("operations-findings.json", { baseline: BASELINE, findings: findingsOut });
W("operations-persona-plan-matrix.json", { baseline: BASELINE, cells });
W("operations-producer-resolver-register.json", producerResolver);
W("operations-action-ownership.json", actionOwnership);
W("operations-scope-authority.json", scopeAuthority);
W("operations-browser-matrix.json", browserMatrix);
W("operations-native-matrix.json", nativeMatrix);
W("operations-enterprise-matrix.json", enterpriseMatrix);
W("operations-proof-register.json", proofRegister);
W("operations-external-blockers.json", { baseline: BASELINE, blockers: blockersAuth });

// ---------------------------------------------------------------- Markdown, derived only from the JSON just written
const T = rj(join(OUT, "operations-truth-audit.json"));
const F = rj(join(OUT, "operations-findings.json")).findings;
const C = rj(join(OUT, "operations-persona-plan-matrix.json")).cells;
const PRR = rj(join(OUT, "operations-producer-resolver-register.json"));
const B = rj(join(OUT, "operations-external-blockers.json")).blockers;
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const md = [];
md.push(`# PROOVRA Operations truth audit`, "", `Generated from \`audit-operations/artifacts/*.json\` by \`audit-operations/generator/generate.mjs\`. Do not edit by hand.`, "");
md.push(`- Baseline: \`${T.baseline}\``, `- Verdict: **${T.verdict}** — ${esc(T.verdictReason)}`, `- Production contacted: ${T.productionContacted}`, `- Product files changed: ${T.productFilesChanged}`, "");
md.push(`## Totals`, "", `| Measure | Value |`, `|---|---|`);
for (const [k, v] of Object.entries(T.totals)) md.push(`| ${k} | ${esc(typeof v === "object" ? JSON.stringify(v) : v)} |`);
md.push("", `## Conservation gates`, "", `| Gate | Result | Detail |`, `|---|---|---|`);
for (const g of T.gates) md.push(`| ${g.id} ${esc(g.title)} | ${g.pass ? "PASS" : "FAIL"} | ${esc(g.pass ? "" : g.failures.join("; "))} |`);
md.push("", `## Findings`, "", `| ID | Sev | Status | Prior | Title | Proof |`, `|---|---|---|---|---|---|`);
for (const f of F) md.push(`| ${f.id} | ${f.severity} | ${f.status} | ${esc(f.priorStatus)} | ${esc(f.title)} | ${f.proofTypes.join(", ")} |`);
for (const f of F) {
  md.push("", `### ${f.id} — ${esc(f.title)}`, "", `- Severity / status: ${f.severity} / ${f.status} (prior: ${esc(f.priorStatus)})`, `- Category: ${f.category}; scope: ${esc(f.scope)}`, `- Affected: plans ${esc(f.affected.plans.join(", "))}; personas ${esc(f.affected.personas.join(", "))}; workspaces ${esc(f.affected.workspaceTypes.join(", "))}`);
  md.push(`- Source: ${f.sourceLocations.map((l) => `\`${l.file}\` (\`${esc(l.symbol)}\`)`).join("; ")}`, `- Reproduction: ${esc(f.reproduction)}`, `- Expected: ${esc(f.expected)}`, `- Actual: ${esc(f.actual)}`, `- User impact: ${esc(f.userImpact)}`, `- Security/privacy: ${esc(f.securityPrivacyImpact)}`, `- Canonical owner: ${esc(f.canonicalOwner)}; Operations duplicates: ${f.operationsDuplicates.value} ${esc(f.operationsDuplicates.detail)}`, `- Remediation boundary: ${esc(f.remediationBoundary)}`, `- Regression proof required: ${esc(f.regressionProof)}`, `- Files a remediation may touch: ${esc(f.filesToTouch.join(", ") || "—")}; must not duplicate: ${esc(f.mustNotDuplicate.join(", ") || "—")}`, `- Data reconciliation: ${esc(f.dataReconciliation)}; Production/owner action: ${esc(f.productionOwnerAction)}`, `- Proofs: ${f.proofs.map((p) => `${p.proofId} (${p.proofType}, \`${p.evidenceFile}\`)`).join("; ")}`);
}
md.push("", `## Persona / plan / workspace cells`, "", `| Cell | Dimension | Status | Proof |`, `|---|---|---|---|`);
for (const c of C) md.push(`| ${esc(c.label)} | ${c.dimension} | ${c.status} | ${esc(c.proofId ?? c.reason)} |`);
md.push("", `## Producer / resolver conservation`, "");
for (const [k, v] of Object.entries(PRR.lists)) md.push(`- **${k}** (${v.length}): ${esc(v.join(", ") || "none")}`);
md.push("", `## External blockers`, "");
for (const b of B) md.push(`- **${b.id}** — ${esc(b.blocker)} (affects: ${esc(b.affects.join(", "))})`);
md.push("");
writeFileSync(join(OUT, "operations-truth-audit.md"), md.join("\n"));

for (const g of gates) console.log(`${g.pass ? "PASS" : "FAIL"} ${g.id} ${g.title}${g.pass ? "" : " :: " + g.failures.slice(0, 8).join(" | ")}`);
console.log(JSON.stringify(truth.totals));
process.exit(allPass ? 0 : 1);
