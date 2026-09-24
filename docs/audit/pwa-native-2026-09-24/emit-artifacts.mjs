/**
 * ARTIFACT EMITTER — builds the machine-derived tables for deliverables
 * (B) route matrix, (D) interaction register, (G) test coverage, (I) counts.
 * Every number in the written report comes from here, not from a keyboard.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve, sep } from "node:path";

/**
 * REPO ROOT — derived from this file, never hardcoded. These instruments live at
 * <repo>/docs/audit/pwa-native-2026-09-24/, so the root is three levels up. An
 * earlier revision pinned "D:/digital-witness", which meant running them from a
 * worktree silently measured the MAIN checkout instead of the branch under test.
 * PROOVRA_AUDIT_REPO overrides it for a deliberate cross-tree comparison.
 */
const REPO = resolve(process.env.PROOVRA_AUDIT_REPO ?? resolve(import.meta.dirname, "..", "..", ".."));
const SCRATCH = resolve(import.meta.dirname, ".");
const OUTDIR = join(REPO, "docs/audit/pwa-native-2026-09-24");
mkdirSync(OUTDIR, { recursive: true });

const asUrl = (p) => "file:///" + p.split(sep).join("/");
const { buildManifest } = await import(asUrl(join(REPO, "apps/mobile/tools/derive-product-manifest.mjs")));
const manifest = await buildManifest();
const { NATIVE_DESTINATIONS: LEDGER } = await import(
  asUrl(join(REPO, "apps/mobile/src/product/native-destinations.mjs"))
);

const inverse = JSON.parse(readFileSync(join(SCRATCH, "inverse-coverage.json"), "utf8"));
const controls = JSON.parse(readFileSync(join(SCRATCH, "controls-and-states.json"), "utf8"));

const RECLASSIFIED = new Map([
  [
    "/operations",
    "Excluded by the deriver's `ENTERPRISE_DOMAINS` heuristic (domain=OPS). NOT in ENTERPRISE_ONLY_ROUTE_IDS, and requiredActiveSpace is PERSONAL_OR_ORG. The registry author listed operations.reliability/automation/analytics explicitly and deliberately omitted workspace.operations — so the heuristic over-excludes a personal-scope surface.",
  ],
  [
    "/operations/health",
    "Same: domain=OPS heuristic, requiredActiveSpace PERSONAL_OR_ORG, id workspace.operations_health absent from ENTERPRISE_ONLY_ROUTE_IDS.",
  ],
]);

const invByRoute = new Map(inverse.results.map((r) => [r.routePath, r]));

/* ------------------------------------------------- (G) test coverage map */

const testDir = join(REPO, "apps/mobile/test");
const testFiles = readdirSync(testDir).filter((f) => f.endsWith(".test.mjs"));
const testSrc = new Map();
for (const f of testFiles) testSrc.set(f, readFileSync(join(testDir, f), "utf8"));

/** A test "covers" a route if it imports/mentions the native screen file or its product module. */
function testsFor(nativeFile) {
  if (!nativeFile) return [];
  const base = nativeFile.replace("apps/mobile/", "");
  const stem = base.split("/").pop().replace(/\.tsx$/, "");
  const dirStem = base.replace(/^app\/\(?\w*\)?\//, "").replace(/\.tsx$/, "");
  const out = [];
  for (const [f, src] of testSrc) {
    if (src.includes(base) || src.includes(dirStem) || (stem !== "index" && stem !== "[id]" && src.includes(`/${stem}`))) out.push(f);
  }
  return out;
}

const RENDER = /\.render\.test\.mjs$/;

/* ---------------------------------------------------------- (B) matrix */

const rows = manifest.rows.map((r) => {
  const applicable = r.classification === "NATIVE_REQUIRED" || RECLASSIFIED.has(r.routePath);
  const ledger = LEDGER[r.routePath] ?? null;
  const nativeFile = ledger ? `apps/mobile/app/${ledger.routeFile}` : null;
  const inv = invByRoute.get(r.routePath) ?? null;
  const tests = applicable ? testsFor(nativeFile) : [];
  return {
    routePath: r.routePath,
    sourceFile: r.sourceFile,
    routeId: r.routeId,
    domain: r.domain,
    requiredActiveSpace: r.requiredActiveSpace,
    manifestClassification: r.classification,
    auditDisposition: applicable ? "APPLICABLE" : "EXCLUDED",
    exclusionRationale: applicable
      ? null
      : r.classification === "ADMIN_ONLY"
        ? "PLATFORM_ADMIN surface (domain and/or requiredActiveSpace = PLATFORM_ADMIN). Operator console, out of scope by the brief."
        : r.classification === "ENTERPRISE_ONLY"
          ? `Enterprise/org console. Gate: ${r.gatedVia ?? "n/a"}. ${r.evidence ?? ""}`.slice(0, 300)
          : "Public marketing funnel rendered on the marketing host (middleware split). An installed app has no in-app acquisition funnel.",
    reclassifiedRationale: RECLASSIFIED.get(r.routePath) ?? null,
    nativeFile,
    ledgerStatus: ledger?.status ?? (applicable ? "NO_LEDGER_ROW" : "n/a"),
    physicallyAccepted: ledger ? ledger.physicallyAccepted : null,
    webEndpointsPageScoped: inv?.webEndpointsPageScoped ?? null,
    nativeEndpointsPresent: inv?.present.length ?? null,
    endpointsMissingEntirely: inv?.missingEntirely.length ?? null,
    endpointsElsewhereInApp: inv?.missingOnScreen.length ?? null,
    nativeControls: nativeFile ? (controls.nativeByFile[nativeFile]?.controls.length ?? 0) : null,
    nativeStates: nativeFile ? (controls.nativeByFile[nativeFile]?.states ?? null) : null,
    webControls: controls.webByFile[r.sourceFile]?.controls.length ?? 0,
    webStates: controls.webByFile[r.sourceFile]?.states ?? null,
    testFiles: tests,
    renderTests: tests.filter((t) => RENDER.test(t)),
  };
});

const applicableRows = rows.filter((r) => r.auditDisposition === "APPLICABLE");

/* ------------------------------------------------- (D) interaction reg */

const interaction = [];
for (const r of applicableRows) {
  if (!r.nativeFile) continue;
  const a = controls.nativeByFile[r.nativeFile];
  if (!a) continue;
  for (const c of a.controls) {
    interaction.push({
      routePath: r.routePath,
      nativeFile: r.nativeFile,
      line: c.line,
      prop: c.prop,
      wiredTo: c.kind,
      handler: c.handler.slice(0, 160),
      verdict: c.kind.startsWith("UNRESOLVED") || c.kind === "EXTERNAL_HANDLER_UNRESOLVED" ? "UNVERIFIED" : "WIRED_SOURCE_INFERRED",
    });
  }
}

/* ------------------------------------------------------------ counters */

const counts = {
  auditedSha: execSync("git rev-parse HEAD", { cwd: REPO }).toString().trim(),
  webRoutesDiscovered: rows.length,
  applicable: applicableRows.length,
  excluded: rows.length - applicableRows.length,
  excludedAdmin: rows.filter((r) => r.manifestClassification === "ADMIN_ONLY").length,
  excludedEnterprise: rows.filter((r) => r.auditDisposition === "EXCLUDED" && r.manifestClassification === "ENTERPRISE_ONLY").length,
  excludedMarketing: rows.filter((r) => r.manifestClassification === "PUBLIC_INFORMATIONAL_ONLY").length,
  reclassifiedIntoScope: [...RECLASSIFIED.keys()].length,
  applicableWithNativeScreen: applicableRows.filter((r) => r.nativeFile).length,
  applicableWithoutLedgerRow: applicableRows.filter((r) => r.ledgerStatus === "NO_LEDGER_ROW").length,
  ledgerCodeParity: applicableRows.filter((r) => r.ledgerStatus === "CODE_PARITY").length,
  physicallyAcceptedTrue: applicableRows.filter((r) => r.physicallyAccepted === true).length,
  distinctNativeScreens: new Set(applicableRows.map((r) => r.nativeFile).filter(Boolean)).size,
  nativeControlsOnApplicableScreens: interaction.length,
  nativeControlsWired: interaction.filter((i) => i.verdict === "WIRED_SOURCE_INFERRED").length,
  nativeControlsUnresolved: interaction.filter((i) => i.verdict === "UNVERIFIED").length,
  nativeControlsTotalApp: controls.summary.native.controls,
  webControlsTotalApp: controls.summary.web.controls,
  routesWithEndpointGaps: applicableRows.filter((r) => (r.endpointsMissingEntirely ?? 0) > 0).length,
  distinctEndpointsMissing: inverse.summary.distinctMissingEntirely,
  routesWithZeroTests: applicableRows.filter((r) => r.testFiles.length === 0).length,
  routesWithRenderTest: applicableRows.filter((r) => r.renderTests.length > 0).length,
  mobileTestFiles: testFiles.length,
  mobileRenderTestFiles: testFiles.filter((f) => RENDER.test(f)).length,
  screenshotsCaptured: 0,
  simulatorRuns: 0,
  physicalDeviceRuns: 0,
};

writeFileSync(join(OUTDIR, "route-matrix.json"), JSON.stringify({ auditedSha: counts.auditedSha, counts, rows }, null, 1));
writeFileSync(join(OUTDIR, "interaction-register.json"), JSON.stringify({ auditedSha: counts.auditedSha, count: interaction.length, controls: interaction }, null, 1));
writeFileSync(join(OUTDIR, "endpoint-gap-register.json"), JSON.stringify(inverse, null, 1));

console.log(JSON.stringify(counts, null, 1));
console.log("\n--- applicable routes with NO test file ---");
console.log(applicableRows.filter((r) => r.testFiles.length === 0).map((r) => r.routePath).join(", ") || "(none)");
console.log("\n--- applicable routes with NO native screen ---");
console.log(applicableRows.filter((r) => !r.nativeFile).map((r) => r.routePath).join(", ") || "(none)");
console.log("\n--- native screens missing a state affordance ---");
for (const r of applicableRows) {
  if (!r.nativeStates) continue;
  const missing = Object.entries(r.nativeStates).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) console.log("  ", r.routePath.padEnd(44), "missing:", missing.join(","));
}
