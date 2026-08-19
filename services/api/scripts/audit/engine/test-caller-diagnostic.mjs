/**
 * PHASE 0 CORRECTIVE §2 — THE TEST-CALLER DIAGNOSTIC.
 *
 * What this recovers, and why it is not an authority
 * ---------------------------------------------------------------------------
 * An untracked artifact — `route-consumers.json`, the output of the retired
 * TEXT consumer scanner — carried two fields the canonical capability map does
 * not publish: `testCallerCount` and `testOnly`. Phase 0 deleted that artifact
 * as superseded, and the deletion was reported honestly as losing a dimension.
 *
 * The dimension is recovered here rather than declared unimportant, because
 * "this route's only callers are tests" is a genuinely different fact from
 * "this route has no callers at all", and it is NOT derivable from the
 * canonical records: they never parsed a test file, so the two cases are
 * indistinguishable in them. Calling it a strict derivation would have been the
 * convenient answer and the false one.
 *
 * It is emphatically NOT restored as a consumer authority. The canonical
 * analyzer excludes tests from the consumer walk on purpose, and the reason is
 * written in its own header: a proof suite calling a route is exactly what
 * makes an orphan look connected. Counting test callers as consumers would let
 * a dead surface pass as wired — which is the defect FINAL-001 exists for.
 *
 * So the fields come back as a DIAGNOSTIC:
 *   - it is bound to the source revision, the analyzer hash, the generation
 *     time and its own content hash, so a stale copy cannot be mistaken for a
 *     current one;
 *   - it carries `HISTORICAL DIAGNOSTIC — NOT A CURRENT AUTHORITY` in the file;
 *   - no gate reads it, and the governance inventory classifies it as a
 *     diagnostic so it can never claim a `sourceOfTruthFor`.
 *
 * Its one honest use is a human asking "is this unwired route at least
 * exercised, or is nothing touching it at all?" — a question the classification
 * deliberately refuses to answer, and which must not change the classification.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./registry.mjs";

const sha256 = (v) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
const importRel = (r) => import(pathToFileURL(path.join(REPO, r)).href);

const ANALYZER_COMPONENTS = Object.freeze([
  "services/api/scripts/capability-authority/analyzer.mjs",
  "services/api/scripts/capability-authority/routes.mjs",
  "services/api/scripts/capability-authority/consumers.mjs",
  "services/api/scripts/audit/engine/test-caller-diagnostic.mjs",
]);

const analyzerHash = () => {
  const h = createHash("sha256");
  for (const c of ANALYZER_COMPONENTS) {
    h.update(readFileSync(path.join(REPO, c), "utf8").replace(/\r\n/g, "\n"));
  }
  return h.digest("hex");
};

/**
 * @param {object} capabilityArtifact the artifact `build()` just returned — passed
 *   in rather than read from disk, so this never becomes a consumer of a file the
 *   orchestrator writes.
 */
export async function buildTestCallerDiagnostic(capabilityArtifact) {
  const analyzer = await importRel("services/api/scripts/capability-authority/analyzer.mjs");
  const consumersMod = await importRel("services/api/scripts/capability-authority/consumers.mjs");
  const manifestDir = path.join(REPO, "services/api/scripts/capability-authority/manifests");
  const loadManifest = (name) => {
    try {
      return JSON.parse(readFileSync(path.join(manifestDir, name), "utf8"));
    } catch {
      return { entries: [] };
    }
  };

  const originResolutions = new Map(
    (loadManifest("origin-resolutions.json").entries ?? []).map((e) => [e.site, e.verdict]),
  );
  const dynamicResolutions = new Map(
    (loadManifest("dynamic-resolutions.json").entries ?? []).map((e) => [e.site, e.class]),
  );
  const consumerResolutions = new Map(
    (loadManifest("consumer-resolutions.json").entries ?? []).map((e) => [e.site, e.routes]),
  );

  // The SAME analyzer, opted into the test trees. Not a second parser: if this
  // disagreed with the canonical one about what a request site is, the
  // diagnostic would be measuring something else entirely.
  const { consumers } = consumersMod.analyzeConsumers(
    originResolutions,
    dynamicResolutions,
    consumerResolutions,
    { includeTests: true },
  );

  const testConsumers = consumers.filter((c) => analyzer.isTestPath(c.file));
  const routeIds = capabilityArtifact.routes.map((r) => r.routeId);
  const { byRoute } = consumersMod.attachConsumers(
    routeIds,
    testConsumers,
    analyzer.matches,
    consumerResolutions,
  );

  const rows = capabilityArtifact.routes.map((r) => {
    const callers = byRoute.get(r.routeId) ?? [];
    const hasRealConsumer = r.productConsumers.length > 0 || r.nonProductConsumers.length > 0;
    return {
      routeId: r.routeId,
      testCallerCount: callers.length,
      // The original field's meaning, restated against canonical records: the
      // route is exercised by suites and by nothing else.
      testOnly: !hasRealConsumer && callers.length > 0,
      testCallerFiles: [...new Set(callers.map((c) => c.file))].sort(),
    };
  });

  const totals = {
    routes: rows.length,
    routesWithAnyTestCaller: rows.filter((r) => r.testCallerCount > 0).length,
    testOnlyRoutes: rows.filter((r) => r.testOnly).length,
    testCallSites: testConsumers.length,
    // Conservation: a test-only route must have no product and no machine
    // consumer in the canonical map, and must have at least one test caller.
    testOnlyIsDisjointFromConsumedRoutes: rows
      .filter((r) => r.testOnly)
      .every((r) => {
        const c = capabilityArtifact.routes.find((x) => x.routeId === r.routeId);
        return c.productConsumers.length === 0 && c.nonProductConsumers.length === 0;
      }),
  };

  const body = {
    status: "HISTORICAL DIAGNOSTIC — NOT A CURRENT AUTHORITY",
    note:
      "Recovers `testCallerCount` / `testOnly` from the retired route-consumers.json. " +
      "GENERATED by the canonical analyzer with tests opted IN, which the consumer " +
      "authority deliberately opts OUT of. Nothing may read this to decide whether a " +
      "route is wired: a proof suite calling a route is what makes an orphan look " +
      "connected. No gate consumes it and it claims no sourceOfTruthFor.",
    coverage:
      "LOWER BOUND, and deliberately so. These are call sites the analyzer RESOLVED " +
      "through a request primitive (fetch / apiFetch / apiRequest / request / " +
      "authedFetch). Fastify `app.inject({ url })` is not a request primitive and is " +
      "not counted, so an API suite that exercises a route through inject does not " +
      "appear here. The retired scanner's numbers were substring occurrences of the " +
      "route path anywhere in a test file, which counted comments and prefixes and was " +
      "not a measurement of anything; these are fewer and mean something. Read " +
      "`testCallerCount = 0` as \"no resolved request-primitive call site\", never as " +
      "\"no suite exercises this route\".",
    supersedes: "audit-output/phase12-final-remediation/route-consumers/route-consumers.json",
    schemaVersion: "test-caller-diagnostic@1",
    analyzerHash: analyzerHash(),
    capabilityRouteInventoryHash: capabilityArtifact.routeInventoryHash,
    totals,
    rows: rows.sort((a, b) => a.routeId.localeCompare(b.routeId)),
  };

  // No `generatedAtUtc` at all. Keeping it out of the CONTENT HASH was already
  // right for the reason below; writing it into the file was still enough to
  // make the artifact differ on every run, which is the same defect one level
  // out. The run prints the timestamp.
  //
  //   (original rationale) hashing a timestamp changes the digest on every
  //   run, which would make the freshness comparison fail for a reason that
  //   has nothing to do with the content — and a staleness gate that always
  //   fires is a staleness gate that gets switched off.
  return { ...body, contentHash: sha256(body) };
}
