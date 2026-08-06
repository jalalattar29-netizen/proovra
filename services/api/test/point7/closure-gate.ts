/**
 * PHASE 12 — POINT 7: the closure evaluator.
 *
 * A PURE function over (proof artifact, repository on disk). Everything it
 * reasons about it discovers for itself:
 *
 *   the canonical plans           from the PRODUCTION catalog, not the manifest
 *   the registered surfaces       from the manifest
 *   the scenario suites           from the filesystem
 *   the executed scenarios        from the artifact
 *   the suite hashes              re-computed from the files
 *   the build identifier          re-derived from the production authority
 *   the run identifier            compared across every record
 *
 * The manifest cannot prove itself: a scenario the manifest requires but no
 * suite executed fails, a scenario an artifact claims but the manifest does not
 * require fails, a plan in the catalog with no scenario fails, and a plan in
 * the manifest that the catalog does not have fails.
 *
 * Separated from the test file so the NEGATIVE cases can call it with
 * deliberately corrupted inputs and assert that it refuses. A gate whose only
 * evidence is that it passed once has not been shown to be capable of failing.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PLAN_CAPABILITIES } from "@proovra/shared-billing";

import { CANONICAL_PLANS, type CanonicalPlan } from "./plan-contract.js";
import {
  SCENARIOS,
  discoverScenarioSuites,
  plansInManifest,
  point7BuildId,
  proofBindingHash,
  repoRoot,
  type ProofLayer,
  type ProvenScenariosArtifact,
} from "./scenario-manifest.js";

/**
 * A destination a local run is permitted to have reached.
 *
 * Loopback only, plus the `*.localhost` form. Anything else — a Sentry ingest
 * host, an Upstash endpoint, an S3 region, `api.proovra.com` — makes the proof
 * that recorded it invalid, whatever its scenarios say.
 */
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "0.0.0.0" ||
    h === "localhost" ||
    h === "::ffff:127.0.0.1" ||
    h.endsWith(".localhost")
  );
}

// ===========================================================================
// The outbound ledgers
// ===========================================================================

/**
 * PHASE 12 — POINT 7 (final pass): a BLOCKED attempt is not the same as no
 * attempt, and the gate now says so.
 *
 * The corrected run's artifact passed while its product ledger held eighteen
 * refused attempts at `api.resend.com`, twelve at `fonts.googleapis.com` and
 * one at `registry.npmjs.org`. Nothing had connected, so the gate's
 * `allowedHosts` check was satisfied — and the conclusion drawn from it,
 * "no production destination was attempted", was false.
 *
 * Four states, kept apart:
 *
 *   `canary`              a DELIBERATE forbidden attempt, made by the
 *                         isolation canary to prove the guard works. It lives
 *                         in its own ledger and earns no product credit.
 *   `local-allowed`       loopback: the disposable Postgres, Redis, MinIO.
 *   `external-attempted`  the product reached for a real external destination
 *                         and was refused. Containment worked; the behaviour
 *                         is still wrong.
 *   `external-connected`  the product reached one and got there.
 *
 * The last two must both be zero for a local product run.
 */
export type LedgerEntry = {
  runId?: string;
  buildId?: string;
  phase?: string;
  process?: string;
  scenarioId?: string;
  host: string;
  category?: string;
  outcome: string;
  transportAuthority?: string;
  boundedCallSite?: string;
  atUtc?: string;
};

export type OutboundLedgerVerdict = {
  productLedgerPresent: boolean;
  productLocalAllowed: number;
  unexpectedExternalAttempts: number;
  unexpectedExternalConnections: number;
  productionDestinationAttempts: number;
  productionDestinationConnections: number;
  canaryAttempts: number;
  /** Canary-phase records that leaked into the PRODUCT ledger. */
  canaryRecordsInProductLedger: number;
  /** Product records whose runId is not this run's. */
  foreignRunRecords: number;
  /** Distinct offending hosts, for the failure message. */
  offendingHosts: string[];
};

/**
 * Destination categories that name a real PRODUCTION dependency.
 *
 * Any non-loopback host is already a failure; this subset exists so the report
 * can say *what kind* of thing was reached for, which is the difference
 * between "a font CDN" and "the production evidence bucket".
 */
const PRODUCTION_CATEGORIES = new Set([
  "sentry",
  "redis",
  "aws",
  "otlp",
  "proovra-production",
  "payments",
  "email",
  "ai-provider",
  "identity",
]);

function readLedgerFile(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as LedgerEntry];
      } catch {
        return [];
      }
    });
}

/**
 * Evaluate the ledgers on disk.
 *
 * Discovered independently: the gate reads the files itself rather than
 * trusting a count a suite reported about its own run.
 */
export function evaluateOutboundLedgers(input?: {
  root?: string;
  productLedger?: string;
  canaryLedger?: string;
  expectedRunId?: string | null;
}): OutboundLedgerVerdict {
  const root = input?.root ?? repoRoot();
  const productPath = resolve(
    root,
    input?.productLedger ??
      process.env.P7_PRODUCT_LEDGER ??
      ".p7tmp/product-run-network.jsonl",
  );
  const canaryPath = resolve(
    root,
    input?.canaryLedger ?? process.env.P7_CANARY_LEDGER ?? ".p7tmp/canary-network.jsonl",
  );

  const product = readLedgerFile(productPath);
  const canary = readLedgerFile(canaryPath);

  let productLocalAllowed = 0;
  let unexpectedExternalAttempts = 0;
  let unexpectedExternalConnections = 0;
  let productionDestinationAttempts = 0;
  let productionDestinationConnections = 0;
  let canaryRecordsInProductLedger = 0;
  let foreignRunRecords = 0;
  const offendingHosts = new Set<string>();

  for (const entry of product) {
    if ((entry.phase ?? "") === "canary") {
      canaryRecordsInProductLedger += 1;
      continue;
    }
    if (
      input?.expectedRunId &&
      entry.runId !== undefined &&
      entry.runId !== "" &&
      entry.runId !== input.expectedRunId
    ) {
      foreignRunRecords += 1;
    }
    if (isLocalHost(entry.host)) {
      productLocalAllowed += 1;
      continue;
    }
    const connected = entry.outcome !== "BLOCKED" && entry.outcome !== "DENIED";
    offendingHosts.add(entry.host);
    if (connected) unexpectedExternalConnections += 1;
    else unexpectedExternalAttempts += 1;
    if (PRODUCTION_CATEGORIES.has(entry.category ?? "")) {
      if (connected) productionDestinationConnections += 1;
      else productionDestinationAttempts += 1;
    }
  }

  return {
    productLedgerPresent: existsSync(productPath),
    productLocalAllowed,
    unexpectedExternalAttempts,
    unexpectedExternalConnections,
    productionDestinationAttempts,
    productionDestinationConnections,
    canaryAttempts: canary.filter((e) => !isLocalHost(e.host)).length,
    canaryRecordsInProductLedger,
    foreignRunRecords,
    offendingHosts: [...offendingHosts].sort(),
  };
}

export type ClosureMetrics = {
  canonicalPlans: number;
  plansInScenarioManifest: number;
  plansExecutedInCurrentRun: number;
  requiredScenarioIds: number;
  executedScenarioIds: number;
  browserSuitesHashValid: boolean;
  oneRunId: boolean;
  oneBuildId: boolean;
  staleArtifacts: number;
  skippedRequiredScenarios: number;
  unknownScenarios: number;
  /** PHASE 12 — POINT 7 (final pass). See {@link OutboundLedgerVerdict}. */
  outbound: OutboundLedgerVerdict;
  /** Every BROWSER record came from next build + next start. */
  productionBuildBrowserProof: boolean;
  /** Every BROWSER record ran under the nonce-based CSP. */
  strictCspEnabled: boolean;
};

export type ClosureVerdict = {
  ok: boolean;
  failures: string[];
  metrics: ClosureMetrics;
  /** Scenario ids the manifest requires that no current-run record proves. */
  missing: Array<{ id: string; layer: ProofLayer }>;
};

/**
 * Evaluate closure.
 *
 * `root` and `artifact` are injectable so the negative tests can point the
 * evaluator at a perturbed copy without touching the real one.
 */
export function evaluatePoint7Closure(input?: {
  root?: string;
  artifact?: ProvenScenariosArtifact | null;
  productLedger?: string;
  canaryLedger?: string;
}): ClosureVerdict {
  const root = input?.root ?? repoRoot();
  const failures: string[] = [];
  let productionBuildBrowserProof = true;
  let strictCspEnabled = true;

  // ---------------------------------------------------------------- plans ---
  // Discovered from the PRODUCTION catalog. If someone adds a sixth plan, this
  // moves and every downstream reconciliation moves with it; if someone adds a
  // fictional plan to the manifest, it is not here and the comparison fails.
  const catalogPlans = Object.keys(PLAN_CAPABILITIES).sort();
  const contractPlans = [...CANONICAL_PLANS].sort();
  if (JSON.stringify(catalogPlans) !== JSON.stringify(contractPlans)) {
    failures.push(
      `catalog plans ${catalogPlans.join(",")} != contract plans ${contractPlans.join(",")}`,
    );
  }
  const manifestPlans = plansInManifest();
  for (const plan of contractPlans as CanonicalPlan[]) {
    if (!manifestPlans.includes(plan)) {
      failures.push(`plan ${plan} has no scenarios in the manifest`);
    }
  }
  for (const plan of manifestPlans) {
    if (!contractPlans.includes(plan)) {
      failures.push(`manifest names plan ${plan}, which the catalog does not have`);
    }
  }

  // --------------------------------------------------------------- suites ---
  const serverSuites = discoverScenarioSuites("SERVER", root);
  const browserSuites = discoverScenarioSuites("BROWSER", root);
  if (serverSuites.length === 0) failures.push("no SERVER scenario suites on disk");
  if (browserSuites.length === 0) failures.push("no BROWSER scenario suites on disk");

  // ------------------------------------------------------------- artifact ---
  let artifact: ProvenScenariosArtifact | null | undefined = input?.artifact;
  if (artifact === undefined) {
    const path = resolve(root, "docs/architecture/point7-proven-scenarios.json");
    artifact = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as ProvenScenariosArtifact)
      : null;
  }
  if (!artifact || !artifact.suites) {
    return {
      ok: false,
      failures: [...failures, "no proof artifact — nothing executed"],
      metrics: emptyMetrics(catalogPlans.length, manifestPlans.length),
      missing: SCENARIOS.flatMap((s) => s.layers.map((layer) => ({ id: s.id, layer }))),
    };
  }

  const expectedBinding = proofBindingHash();
  const expectedBuild = point7BuildId(root);

  // A record is CURRENT only if all four independent locks hold.
  const runIds = new Set<string>();
  const buildIds = new Set<string>();
  let staleArtifacts = 0;
  const proven = new Map<ProofLayer, Set<string>>([
    ["SERVER", new Set()],
    ["BROWSER", new Set()],
  ]);
  let browserSuitesHashValid = true;

  for (const [suiteRel, record] of Object.entries(artifact.suites)) {
    const abs = resolve(root, suiteRel);
    if (!existsSync(abs)) {
      staleArtifacts += 1;
      failures.push(`record for ${suiteRel}, which no longer exists`);
      if (record.layer === "BROWSER") browserSuitesHashValid = false;
      continue;
    }
    const sha = createHash("sha256").update(readFileSync(abs)).digest("hex");
    if (sha !== record.sha256) {
      staleArtifacts += 1;
      failures.push(`${suiteRel} changed since it was proven — re-run required`);
      if (record.layer === "BROWSER") browserSuitesHashValid = false;
      continue;
    }
    if (record.binding !== expectedBinding) {
      staleArtifacts += 1;
      failures.push(`${suiteRel} was proven against a different scenario inventory`);
      continue;
    }
    if (record.buildId !== expectedBuild) {
      staleArtifacts += 1;
      failures.push(`${suiteRel} was proven against a different build of the production authority`);
      continue;
    }
    // POINT 7 CORRECTIVE PASS — the isolation predicates.
    //
    // The first run's artifact was structurally perfect and was produced by
    // processes talking to the production Sentry project and the production
    // evidence bucket. Nothing in the record could have shown that, so these
    // three checks make the boundary part of what a proof asserts.
    if (!record.isolation) {
      staleArtifacts += 1;
      failures.push(
        `${suiteRel} carries no outbound-network ledger — it predates the isolation requirement`,
      );
      continue;
    }
    const external = record.isolation.allowedHosts.filter(
      (h) => !isLocalHost(h),
    );
    if (external.length > 0) {
      failures.push(
        `${suiteRel} reached external destination(s): ${external.join(", ")}`,
      );
    }
    if (record.isolation.observabilityErrorEvents > 0) {
      failures.push(
        `${suiteRel} recorded ${record.isolation.observabilityErrorEvents} error-level observability event(s) — an expected denial must not be one`,
      );
    }

    // PHASE 12 — POINT 7 (final pass): a BROWSER record must say it came from
    // a production build under strict CSP.
    //
    // The hydration failure existed only there. `next dev` renders every route
    // per request, so it never met the static-HTML / per-request-nonce
    // mismatch that left the entire application unhydrated — a dev-mode
    // browser proof was, for that whole class of defect, evidence of nothing.
    if (record.layer === "BROWSER") {
      if (record.webRuntimeMode !== "production-build") {
        productionBuildBrowserProof = false;
        failures.push(
          `${suiteRel} was proven in ${record.webRuntimeMode ?? "an undeclared"} runtime mode — ` +
            "browser credit requires next build + next start",
        );
      }
      if (record.strictCsp !== true) {
        strictCspEnabled = false;
        failures.push(
          `${suiteRel} was proven without strict CSP — the policy under test must be the one production serves`,
        );
      }
    }

    runIds.add(record.runId);
    buildIds.add(record.buildId);
    for (const id of record.scenarios) proven.get(record.layer)!.add(id);
  }

  // Every scenario suite ON DISK must have produced a record. Deleting a suite
  // and its record together must not read as "everything covered".
  for (const suite of [...serverSuites, ...browserSuites]) {
    if (!artifact.suites[suite]) {
      failures.push(`${suite} exists but produced no proof record`);
    }
  }

  const oneRunId = runIds.size === 1;
  const oneBuildId = buildIds.size === 1;
  if (!oneRunId) {
    failures.push(
      runIds.size === 0
        ? "no current proof records at all"
        : `proof is stitched from ${runIds.size} runs`,
    );
  }
  if (!oneBuildId && buildIds.size > 1) {
    failures.push(`proof spans ${buildIds.size} builds of the production authority`);
  }

  // -------------------------------------------------------- reconciliation ---
  const missing: Array<{ id: string; layer: ProofLayer }> = [];
  let requiredCount = 0;
  for (const scenario of SCENARIOS) {
    for (const layer of scenario.layers) {
      requiredCount += 1;
      if (!proven.get(layer)!.has(scenario.id)) {
        missing.push({ id: scenario.id, layer });
      }
    }
  }
  for (const m of missing) {
    failures.push(`scenario ${m.id} has no ${m.layer} proof in this run`);
  }

  // A scenario the artifact claims that the manifest does not require.
  const requiredIds = new Set(SCENARIOS.map((s) => s.id));
  let unknownScenarios = 0;
  for (const [, set] of proven) {
    for (const id of set) {
      if (!requiredIds.has(id)) {
        unknownScenarios += 1;
        failures.push(`artifact claims unknown scenario ${id}`);
      }
    }
  }

  // Which plans a CURRENT run actually exercised, counted from executed ids.
  const executedPlans = new Set<CanonicalPlan>();
  for (const scenario of SCENARIOS) {
    if (scenario.plan === "CROSS") continue;
    const fully = scenario.layers.every((l) => proven.get(l)!.has(scenario.id));
    if (fully) executedPlans.add(scenario.plan);
  }
  for (const plan of contractPlans as CanonicalPlan[]) {
    if (!executedPlans.has(plan)) {
      failures.push(`plan ${plan} was not behaviourally executed in this run`);
    }
  }

  const executedCount = [...proven.values()].reduce((n, s) => n + s.size, 0);

  // ------------------------------------------------------ outbound ledger ---
  // Read from disk, not reported by the run. A proof that says nothing about
  // what its processes reached for is the proof this pass exists to replace.
  const outbound = evaluateOutboundLedgers({
    root,
    productLedger: input?.productLedger,
    canaryLedger: input?.canaryLedger,
    expectedRunId: [...runIds][0] ?? null,
  });
  if (!outbound.productLedgerPresent) {
    failures.push(
      "no product-run outbound ledger on disk — a run that recorded nothing about its boundary proves nothing about it",
    );
  }
  if (outbound.unexpectedExternalAttempts > 0) {
    failures.push(
      `the product run ATTEMPTED ${outbound.unexpectedExternalAttempts} external destination(s): ${outbound.offendingHosts.join(", ")}. ` +
        "A blocked attempt is containment, not a local-provider proof.",
    );
  }
  if (outbound.unexpectedExternalConnections > 0) {
    failures.push(
      `the product run CONNECTED to ${outbound.unexpectedExternalConnections} external destination(s): ${outbound.offendingHosts.join(", ")}`,
    );
  }
  if (outbound.productionDestinationAttempts > 0) {
    failures.push(
      `the product run attempted ${outbound.productionDestinationAttempts} PRODUCTION destination(s)`,
    );
  }
  if (outbound.productionDestinationConnections > 0) {
    failures.push(
      `the product run connected to ${outbound.productionDestinationConnections} PRODUCTION destination(s)`,
    );
  }
  if (outbound.canaryRecordsInProductLedger > 0) {
    failures.push(
      `${outbound.canaryRecordsInProductLedger} deliberate canary attempt(s) were written into the PRODUCT ledger — the canary must not be able to excuse or accuse a product run`,
    );
  }
  if (outbound.foreignRunRecords > 0) {
    failures.push(
      `${outbound.foreignRunRecords} ledger record(s) belong to a different run id`,
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    metrics: {
      canonicalPlans: catalogPlans.length,
      plansInScenarioManifest: manifestPlans.length,
      plansExecutedInCurrentRun: executedPlans.size,
      requiredScenarioIds: requiredCount,
      executedScenarioIds: executedCount,
      browserSuitesHashValid,
      oneRunId,
      oneBuildId,
      staleArtifacts,
      skippedRequiredScenarios: missing.length,
      unknownScenarios,
      outbound,
      productionBuildBrowserProof,
      strictCspEnabled,
    },
    missing,
  };
}

function emptyMetrics(plans: number, manifestPlans: number): ClosureMetrics {
  return {
    canonicalPlans: plans,
    plansInScenarioManifest: manifestPlans,
    plansExecutedInCurrentRun: 0,
    requiredScenarioIds: SCENARIOS.reduce((n, s) => n + s.layers.length, 0),
    executedScenarioIds: 0,
    browserSuitesHashValid: false,
    oneRunId: false,
    oneBuildId: false,
    staleArtifacts: 0,
    skippedRequiredScenarios: SCENARIOS.reduce((n, s) => n + s.layers.length, 0),
    unknownScenarios: 0,
    productionBuildBrowserProof: false,
    strictCspEnabled: false,
    // No artifact means no run, and no run means nothing was observed at the
    // boundary. Reported as absent rather than as zero: "we saw no external
    // attempts" and "we did not look" must not read the same.
    outbound: {
      productLedgerPresent: false,
      productLocalAllowed: 0,
      unexpectedExternalAttempts: 0,
      unexpectedExternalConnections: 0,
      productionDestinationAttempts: 0,
      productionDestinationConnections: 0,
      canaryAttempts: 0,
      canaryRecordsInProductLedger: 0,
      foreignRunRecords: 0,
      offendingHosts: [],
    },
  };
}
