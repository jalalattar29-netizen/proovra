/**
 * PHASE 0 §5 — THE ONE CURRENT-FACTS ARTIFACT.
 *
 * Before Phase 0 a reader asking "how many routes are registered?" could get
 * 1083 from the capability map, 785 from a hand-maintained column, 773 from a
 * retired text scanner and a fourth number from whichever gate happened to
 * build its own regex inventory that week. Every one of those was quoted in a
 * report as a measurement.
 *
 * This file produces the single answer. Every scalar in it is returned by an
 * analyzer called HERE, at run time, on this tree:
 *
 *   capability engine (AST)      -> routes, authorization, consumers, dispositions
 *   reachability verifier        -> module reachability
 *   ledger validator             -> findings, derived from rows
 *   governance inventory         -> the audit system's own shape
 *   domain proofs                -> REFERENCED by path/hash/binding, never transcribed
 *
 * Nothing is typed in. There is no place in this file to write a number.
 *
 * `inputs.freshnessHash` is what lets a cheap gate prove the artifact is
 * current without paying for a TypeScript program: it is the content hash of
 * the sources the facts are derived from, so a route added after the artifact
 * was written changes the hash and the gate fails.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  REPO,
  CANONICAL,
  ENGINE_VERSION,
  FACTS_SCHEMA_VERSION,
  FRESHNESS_INPUT_ROOTS,
  CONTINUATION_CHECKPOINT,
} from "./registry.mjs";
import { evaluateGovernance } from "./governance.mjs";
import { readDomainProofs, staleDomainProofs } from "./domain-proofs.mjs";

const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const readRel = (r) => readFileSync(path.join(REPO, r), "utf8").replace(/\r\n/g, "\n");

// ===========================================================================
// POINT 7 — the browser layer, read from the proof artifact
// ===========================================================================

const POINT7_PROOF = "docs/architecture/point7-proven-scenarios.json";
const UI_CAPABILITY_MANIFEST =
  "services/api/scripts/capability-authority/manifests/ui-capabilities.json";

const POINT7_MANIFEST = "services/api/test/point7/scenario-manifest.ts";

/**
 * Every scenario id the Point-7 manifest declares.
 *
 * Read from the manifest SOURCE rather than restated, so this cannot drift
 * from the inventory the closure gate reconciles against. The manifest builds
 * each entry with a single `S("<id>", …)` call, which is the only shape this
 * needs to recognise; a manifest that stopped using it would return an empty
 * list here and every family verdict would read NOT_EXECUTED — failing loudly
 * rather than silently crediting nothing.
 */
function manifestScenarioIds() {
  const abs = path.join(REPO, POINT7_MANIFEST);
  if (!existsSync(abs)) return [];
  const src = readFileSync(abs, "utf8");
  return [...src.matchAll(/\bS\(\s*"([^"]+)"/g)].map((m) => m[1]);
}

function readJsonRel(rel) {
  const abs = path.join(REPO, rel);
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

/**
 * What the BROWSER layer actually proved, and whether the run that proved it
 * was a fresh one.
 *
 * This reads the artifact the Point-7 runner writes and the closure gate
 * re-derives; it computes no proof of its own and cannot grant credit. The
 * point of surfacing it in the facts is that the RELEASE decision needs it:
 * "the source is fixed" and "a browser ran the fixed code" are different
 * claims, and the previous pass shipped a checkpoint where the second was
 * NOT EXECUTED while every counter around it read zero.
 *
 * `fresh` is deliberately conjunctive. A production build under strict CSP,
 * one run id and one build id across every record — because each of those has
 * already, once, been the thing that made a green artifact meaningless: a dev
 * server never meets the static-HTML / per-request-nonce mismatch, and a
 * survivor process wrote a previous run's id into a cleared ledger.
 */
export function point7Facts() {
  const artifact = readJsonRel(POINT7_PROOF);
  const manifest = readJsonRel(UI_CAPABILITY_MANIFEST);
  const capabilities = manifest?.entries ?? [];

  const records = Object.values(artifact?.suites ?? {});
  const browser = records.filter((r) => r.layer === "BROWSER");
  const provenBrowser = new Set(browser.flatMap((r) => r.scenarios ?? []));

  const runIds = new Set(records.map((r) => r.runId).filter(Boolean));
  const buildIds = new Set(records.map((r) => r.buildId).filter(Boolean));
  const allProductionBuild =
    browser.length > 0 && browser.every((r) => r.webRuntimeMode === "production-build");
  const allStrictCsp = browser.length > 0 && browser.every((r) => r.strictCsp === true);

  const fresh =
    browser.length > 0 && runIds.size === 1 && buildIds.size === 1 && allProductionBuild && allStrictCsp;

  const verifiedCapabilities = capabilities.filter((c) =>
    provenBrowser.has(c.provingScenario),
  );

  /**
   * PASS only when EVERY scenario the manifest requires for the family was
   * proven in this same run.
   *
   * The first version of this counted the family's PROVEN ids and reported
   * PASS when there was at least one — which credited NEW-027 and NEW-028 as
   * passing on a run where their three refusal scenarios passed and their
   * positive path FAILED. A verdict derived from what happened to succeed can
   * only ever agree with itself; the denominator has to come from the
   * manifest, so a scenario that did not run makes the family fail rather than
   * shrinking the expectation.
   *
   * The required ids are read from `scenario-manifest.ts` — the same authority
   * the closure gate reconciles against — rather than restated here.
   */
  const requiredIds = manifestScenarioIds();
  const familyVerdict = (prefix) => {
    const required = requiredIds.filter((id) => id.startsWith(prefix));
    if (required.length === 0) return "NOT_EXECUTED";
    const missing = required.filter((id) => !provenBrowser.has(id));
    return fresh && missing.length === 0 ? "PASS" : "NOT_EXECUTED";
  };

  return {
    artifactPresent: artifact !== null,
    browserSuites: browser.length,
    browserProvenScenarios: provenBrowser.size,
    runIds: runIds.size,
    buildIds: buildIds.size,
    productionBuild: allProductionBuild,
    strictCsp: allStrictCsp,
    fresh,
    implementedUiCapabilities: capabilities.length,
    browserVerifiedUiCapabilities: verifiedCapabilities.length,
    unexecutedUiCapabilities: capabilities.length - verifiedCapabilities.length,
    unverifiedCapabilityIds: capabilities
      .filter((c) => !provenBrowser.has(c.provingScenario))
      .map((c) => c.capabilityId),
    new027Runtime: familyVerdict("p7.new027."),
    new028Runtime: familyVerdict("p7.new028."),
    new029Runtime: familyVerdict("p7.new029."),
    /**
     * PHASE 13 (NEW-058). The finding may not close on source alone: the whole
     * point of it is what a REAL CLIENT sends, so its disposition is gated on
     * the browser family the same way NEW-027/028/029 are.
     */
    new058Runtime: familyVerdict("p7.new058."),
  };
}

/**
 * The continuation checkpoint, evaluated against the facts this run produced.
 *
 * Uses the SAME evaluator the adversarial gate drives — see
 * `checkpoint-truth.mjs` for why there is exactly one of it.
 */
async function checkpointFacts(factsDoc) {
  const abs = path.join(REPO, CONTINUATION_CHECKPOINT);
  if (!existsSync(abs)) {
    return { present: false, contradictions: 0, staleNextCommands: 0, duplicateActiveStateSections: 0, violations: ["CHECKPOINT MISSING"] };
  }
  const { evaluateCheckpoint } = await import(
    pathToFileURL(path.join(REPO, "services/api/scripts/audit/engine/checkpoint-truth.mjs")).href
  );
  const result = evaluateCheckpoint({
    markdown: readFileSync(abs, "utf8"),
    facts: factsDoc,
    commandTargetExists: (p) => existsSync(path.join(REPO, p)),
  });
  return {
    present: true,
    contradictions: result.checkpointContradictions,
    staleNextCommands: result.staleNextCommands,
    duplicateActiveStateSections: result.duplicateActiveStateSections,
    scalarsChecked: result.scalarsChecked,
    violations: result.violations.map((v) => `${v.kind}: ${v.detail}`),
  };
}

// ===========================================================================
// FRESHNESS INPUTS
// ===========================================================================

function hashTree(rootRel) {
  const abs = path.join(REPO, rootRel);
  if (!existsSync(abs)) return [];
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (/^(node_modules|dist|\.next)$/.test(e.name)) continue;
        walk(p);
      } else if (e.isFile() && /\.(ts|tsx|mjs|json)$/.test(e.name)) {
        const r = path.relative(REPO, p).split(path.sep).join("/");
        out.push(`${r}:${sha256(readFileSync(p, "utf8").replace(/\r\n/g, "\n"))}`);
      }
    }
  };
  if (statSync(abs).isDirectory()) walk(abs);
  return out;
}

/**
 * The hash a gate recomputes to prove the facts artifact is not stale.
 *
 * Cheap on purpose: reading route source is milliseconds, while re-running the
 * AST engine is seconds. A gate that cannot afford the engine can still refuse
 * to read a stale answer.
 */
export function freshnessHash() {
  const lines = FRESHNESS_INPUT_ROOTS.flatMap(hashTree);
  for (const p of CANONICAL.engineComponents) {
    if (existsSync(path.join(REPO, p))) lines.push(`${p}:${sha256(readRel(p))}`);
  }
  return sha256(lines.sort().join("\n"));
}

function sourceRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// ===========================================================================
// THE ANALYZERS, CALLED — never quoted
// ===========================================================================

const importRel = (r) => import(pathToFileURL(path.join(REPO, r)).href);

async function capabilityFacts() {
  const mod = await importRel("services/api/scripts/generate-runtime-capability-map.mjs");
  const artifact = mod.build();
  const t = artifact.totals;
  return {
    artifact,
    facts: {
      routes: {
        registered: t.RegisteredRoutes,
        productionRegistered: t.ProductionRegisteredRoutes ?? t.RegisteredRoutes,
        developmentOnly: t.DevelopmentOnlyRoutes,
        routeInventoryHash: artifact.routeInventoryHash,
      },
      authorization: {
        unresolved: t.AuthorizationUnresolved,
        publicUnguarded: t.PublicUnguardedRoutes,
      },
      consumers: {
        productConsumerRoutes: t.ProductConsumerRoutes,
        machineOnlyConsumerRoutes: t.MachineOnlyConsumerRoutes,
        noConsumerRoutes: t.NoConsumerRoutes,
        wrongOriginConsumers: t.WrongOriginConsumers,
        consumerInventoryHash: artifact.consumerInventoryHash,
      },
      capabilities: {
        totalRoutes: artifact.totalRoutes,
        productConsumed: t.ProductConsumedRoutes,
        nonProductDispositioned: t.NonProductDispositionedRoutes,
        undisposed: t.UndisposedRoutes,
        byDisposition: t.byDisposition,
        byMandateDisposition: t.byMandateDisposition,
        mandateConservationHolds: t.MandateDispositionConservationHolds,
        missingProductUiReleaseRequired:
          t.byMandateDisposition?.MISSING_PRODUCT_UI_RELEASE_REQUIRED ?? null,
        missingProductUiPostRelease:
          t.byMandateDisposition?.MISSING_PRODUCT_UI_POST_RELEASE ?? null,
        deadRemovePending: t.byMandateDisposition?.DEAD_REMOVE ?? null,
        classificationCounts: artifact.classificationCounts,
        dispositionsHash: artifact.dispositionsHash,
      },
      instrumentIntegrity: {
        DynamicUnresolvedRouteRegistrations: t.DynamicUnresolvedRouteRegistrations,
        DynamicUnresolvedConsumers: t.DynamicUnresolvedConsumers,
        UnreviewedOriginConsumers: t.UnreviewedOriginConsumers,
        AmbiguousConsumerSites: t.AmbiguousConsumerSites,
        UnmatchedConsumerCalls: t.UnmatchedConsumerCalls,
        ClassificationConflicts: t.ClassificationConflicts,
        WrongOriginConsumers: t.WrongOriginConsumers,
        AuthorizationUnresolved: t.AuthorizationUnresolved,
        // PHASE 13 §A — tenancy is an INSTRUMENT dimension: a route whose
        // tenant binding could not be derived means some other number here is a
        // guess, exactly like an unresolved consumer.
        TenantBindingUnresolved: t.TenantBindingUnresolved,
        OrganizationAuthorizationUnresolved: t.OrganizationAuthorizationUnresolved,
        OrganizationRoutesMissingRequiredAuthorization:
          t.OrganizationRoutesMissingRequiredAuthorization,
        TenantUnboundInsertRoutes: t.TenantUnboundInsertRoutes,
        // PHASE 13 §B — a writer the mutation pass could not classify, or a
        // call it could not follow, means some other mutation number here is a
        // guess. Same category as an unresolved consumer.
        UnclassifiedMutationWriters: t.UnclassifiedMutationWriters,
        MutationReachabilityUnresolved: t.MutationReachabilityUnresolved,
        QueueRegistryProblems: t.QueueRegistryProblems,
      },
      // PHASE 13 §B — mutation closure, row-derived from the writer inventory.
      mutations: {
        terminalWriters: t.TerminalWriters,
        reachable: t.ReachableSensitiveMutations,
        classified: t.ClassifiedSensitiveMutations,
        unclassified: t.UnclassifiedMutationWriters,
        moduleScopedAttribution: t.ModuleScopedAttributionWriters,
        nonRequest: t.NonRequestWriters,
        deadUnreachable: t.DeadUnreachableWriters,
        authorizationAfterMutation: t.AuthorizationAfterMutation,
        tenantUnbound: t.TenantUnboundMutations,
        unsafeEffectsInsideTransactions: t.UnsafeEffectsInsideTransactions,
        orphanQueueProducers: t.OrphanQueueProducers,
        parallelAuthorities: t.ParallelMutationAuthorities,
        legacyWriters: t.LegacyWriters,
        nonIdempotentRetryableEffects: t.NonIdempotentRetryableEffects,
        unprocessedQueueFamilies: t.UnprocessedQueueFamilies,
        conservationHolds: t.MutationConservationHolds,
        writerConservationHolds: t.MutationWriterConservationHolds,
        byWriterBucket: t.byWriterBucket,
        writerBucketOverlaps: t.WriterBucketOverlaps,
        writerBucketMissing: t.WriterBucketMissing,
        unresolvedWriters: t.UnresolvedWriters,
        moduleScopedAttribution: t.ModuleScopedAttributionWriters,
        closurePass: t.MutationClosurePass,
        byFamily: t.byFamily,
      },
    },
  };
}

async function reachabilityFacts() {
  const mod = await importRel("services/api/scripts/verify-module-reachability.mjs");
  const r = mod.evaluate();
  return {
    ok: Boolean(r.ok),
    unreachableModules: r.counters?.UnreachableProductionModules ?? r.unreachable?.length ?? null,
    counters: r.counters ?? null,
    problemCount: (r.problems ?? []).length,
  };
}

/**
 * What a refused ledger reports in place of every countable scalar.
 *
 * A string, so no arithmetic and no `=== 0` comparison anywhere downstream can
 * quietly treat "unreadable" as "zero".
 */
export const LEDGER_REFUSED = "REFUSED";

async function ledgerFacts() {
  const rowsPath = CANONICAL.findingsLedger.rows;
  const mod = await importRel(CANONICAL.findingsLedger.producer);
  const rowsRaw = readRel(rowsPath);
  const result = mod.evaluateRows(JSON.parse(rowsRaw));
  if (!result.ok) {
    /**
     * A REFUSED ledger is a controlled finding, not a missing field.
     *
     * This branch used to return four keys. Every downstream consumer —
     * `derivedScalars` reading `.actionable.open`, the report's counter table,
     * the checkpoint comparison — then read `.actionable` off an object that
     * did not have one and threw a TypeError. So the audit's response to
     * "the findings ledger disagrees with the Point-7 proof" was a stack trace
     * from a completely different module, which says nothing about the
     * refusal and hides it behind an engine crash.
     *
     * The shape is therefore COMPLETE and deliberately UNUSABLE. Every field a
     * consumer reads exists, so nothing throws; every field that could be
     * mistaken for progress carries {@link LEDGER_REFUSED} rather than a
     * number, so nothing can be credited. `open === 0` — the one comparison
     * that decides `ReleaseBlockingClosure` — is false against a string, which
     * means a refused ledger reports OPEN by construction and cannot report
     * PASS by accident.
     */
    return {
      path: rowsPath,
      producer: CANONICAL.findingsLedger.producer,
      rowsHash: sha256(rowsRaw),
      valid: false,
      problems: result.problems,
      rowCount: LEDGER_REFUSED,
      actionable: {
        total: LEDGER_REFUSED,
        closed: LEDGER_REFUSED,
        open: LEDGER_REFUSED,
      },
      verifiedClosures: { total: LEDGER_REFUSED, ids: [] },
      unknownBlocked: { total: LEDGER_REFUSED, ids: [] },
      trackedInventory: { total: 0, ids: [], releaseBlocking: false },
      // NOT an empty list. "No open findings" and "the ledger could not be
      // read" must never render the same, and `releaseBlockingProblems` reads
      // this to decide whether a release is blocked.
      openIds: ["LEDGER_REFUSED"],
      conservationEquation: `${LEDGER_REFUSED} — the ledger did not validate`,
    };
  }
  const l = result.ledger;
  return {
    path: rowsPath,
    producer: CANONICAL.findingsLedger.producer,
    rowsHash: sha256(rowsRaw),
    valid: true,
    rowCount: l.rowCount,
    actionable: l.actionable,
    verifiedClosures: l.verifiedClosures,
    unknownBlocked: l.unknownBlocked,
    // Carried so closure can report it WITHOUT crediting it. Inventory is
    // release-blocking for nothing and earns no fixed, security or completeness
    // credit; it is here to stay visible, not to be counted as progress.
    trackedInventory: l.trackedInventory ?? { total: 0, ids: [], releaseBlocking: false },
    openIds: l.remainingIds,
    conservationEquation: l.conservationEquation,
  };
}

// ===========================================================================
// ASSEMBLY
// ===========================================================================

export async function buildFacts() {
  const governance = evaluateGovernance();
  const domainProofs = readDomainProofs();
  const cap = await capabilityFacts();
  const reachability = await reachabilityFacts();
  const ledger = await ledgerFacts();

  const stale = staleDomainProofs(domainProofs);

  const facts = {
    ...cap.facts,
    reachability,
    auditGovernance: governance.counters,
    proofFreshness: {
      domainProofsRead: domainProofs.length,
      bound: domainProofs.length - stale.length,
      stale: stale.length,
      staleDomains: stale.map((p) => `${p.domain}:${p.freshness}`),
    },
    point7: point7Facts(),
  };

  // Conservation identities. Each is an EQUATION over records, so a scalar
  // that drifts cannot stay hidden behind a plausible-looking total.
  const conservation = {
    capabilityPrimarySetsPartitionRoutes:
      facts.capabilities.productConsumed +
        facts.capabilities.nonProductDispositioned +
        facts.capabilities.undisposed ===
      cap.artifact.routes.filter((r) => r.productionRegistered).length,
    consumerBucketsPartitionRoutes:
      facts.consumers.productConsumerRoutes +
        facts.consumers.machineOnlyConsumerRoutes +
        facts.consumers.noConsumerRoutes ===
      facts.routes.registered,
    capabilityProjectionMatchesRouteCount:
      facts.capabilities.totalRoutes === cap.artifact.capabilities.length,
    classificationCountsSumToRoutes:
      Object.values(facts.capabilities.classificationCounts).reduce((a, b) => a + b, 0) ===
      facts.capabilities.totalRoutes,
    // PHASE 1 §3 — five buckets, not four. `trackedInventory` was added when
    // FINAL-001's governance DEFECT was separated from the route INVENTORY it
    // had been carrying in the same row. Leaving this identity at four buckets
    // would have made the separation itself look like a conservation failure.
    ledgerRowsConserve: ledger.valid
      ? ledger.actionable.total +
          ledger.verifiedClosures.total +
          ledger.unknownBlocked.total +
          (ledger.trackedInventory?.total ?? 0) ===
        ledger.rowCount
      : false,
    ledgerActionableConserves: ledger.valid
      ? ledger.actionable.closed + ledger.actionable.open === ledger.actionable.total
      : false,
  };

  const document = {
    schemaVersion: FACTS_SCHEMA_VERSION,
    // NO `generatedAtUtc` and NO `sourceRevision`. Both are metadata about the
    // RUN, and persisting them made the artifact impossible to keep current:
    // an artifact recording the revision it belongs to would have to contain
    // the hash of the commit that contains it. The run banner prints them,
    // which is where a log belongs.
    releaseCandidateId: null,
    engineVersion: ENGINE_VERSION,
    engineHash: freshnessHash(),
    note:
      "GENERATED by services/api/scripts/audit/index.mjs. Every scalar is returned by an " +
      "analyzer executed at generation time. Domain proofs are REFERENCED by path, hash and " +
      "binding — never transcribed. Do not hand-edit: `pnpm audit:architecture --engine-check` " +
      "recomputes and refuses a mismatch.",
    inputs: {
      freshnessInputRoots: FRESHNESS_INPUT_ROOTS,
      freshnessHash: freshnessHash(),
      engineComponents: CANONICAL.engineComponents.map((p) => ({
        path: p,
        hash: existsSync(path.join(REPO, p)) ? sha256(readRel(p)) : null,
      })),
    },
    facts,
    // Phase-0's own change set, derived from the HEAD baseline. Carried in the
    // facts so the report renders it from a record rather than from prose.
    phase0: {
      // ONLY the parts that are a function of the committed SOURCE.
      //
      // The change set itself answers "what differs between this working tree
      // and HEAD" — a property of somebody local checkout, the same category
      // the registry already refuses to keep in the artifact tree. It is
      // reported in the run banner and asserted live in `engineProblems()`;
      // persisting it made the artifact differ before and after every commit,
      // which is what kept the freshness gate permanently red.
      note:
        "The Phase-0 change set is a property of the working tree, not of the committed revision, " +
        "so it is REPORTED by the run rather than recorded here. Every Phase-0 assertion is raised " +
        "from the live evaluation. Only the source-derived parts are persisted.",
      baselineKind: governance.phase0ChangeSet?.baselineKind ?? null,
      derivedFromBaseline: governance.phase0ExitCounters.phase0ChangedPathsDerivedFromBaseline,
      // The engine own generated outputs are held out of the change set so a
      // run cannot measure its own writes. The DECLARATION is a constant, and
      // `undeclaredSelfGeneratedExclusions` is gated to 0 by the engine check,
      // so the hold-out can never widen past the registry declaration.
      selfGeneratedPathsDeclared:
        governance.phase0ExitCounters.phase0SelfGeneratedPathsDeclared,
      undeclaredSelfGeneratedExclusions:
        governance.phase0ExitCounters.phase0UndeclaredSelfGeneratedExclusions,
    },
    domainProofs,
    conservation,
    findingsLedgerRef: ledger,
    auditGovernanceRef: {
      path: CANONICAL.governanceInventory.path,
      problems: governance.problems,
    },
  };

  /**
   * The checkpoint is evaluated LAST, against the document that was just
   * built, because the whole question it answers is whether the prose agrees
   * with THESE numbers. It is attached rather than merged into `facts` so the
   * evaluator's own input stays exactly the shape it validates.
   */
  document.checkpoint = await checkpointFacts(document);
  return document;
}

/**
 * INSTRUMENT integrity, separated from PRODUCT closure.
 *
 * Everything here is a hole in the measuring device: an unresolved request, an
 * artifact with two producers, a stale proof credited as current. None of it is
 * a statement about the product, and all of it must be zero before any number
 * this system prints means anything.
 */
export function engineProblems(f, governance) {
  const problems = [];
  for (const [k, v] of Object.entries(f.facts.instrumentIntegrity)) {
    if (v !== 0) problems.push(`INSTRUMENT: ${k} = ${v}`);
  }
  for (const [k, holds] of Object.entries(f.conservation)) {
    if (!holds) problems.push(`CONSERVATION VIOLATED: ${k}`);
  }
  if (!f.findingsLedgerRef.valid)
    problems.push(`LEDGER REFUSED: ${(f.findingsLedgerRef.problems ?? []).join(" | ")}`);
  if (f.facts.proofFreshness.stale !== 0)
    problems.push(`STALE DOMAIN PROOF CREDITED: ${f.facts.proofFreshness.staleDomains.join(", ")}`);
  if (!f.facts.reachability.ok)
    problems.push(`REACHABILITY VERIFIER RED: ${f.facts.reachability.problemCount} problems`);
  // The self-reference hold-out is bounded by the registry's declaration. If a
  // path were ever dropped from the change set without being declared as engine
  // output, that is an arbitrary exclusion and the engine refuses it.
  if ((f.phase0?.undeclaredSelfGeneratedExclusions ?? 0) !== 0)
    problems.push(
      `UNDECLARED SELF-GENERATED EXCLUSION: ${f.phase0.undeclaredSelfGeneratedExclusions}`,
    );
  problems.push(...governance.problems);
  return problems;
}

/**
 * PRODUCT closure. Expected to be RED while the route backlog is open — that is
 * the point of keeping it apart from the check above.
 */
export function closureProblems(f) {
  return [...releaseBlockingProblems(f), ...architectureBacklogProblems(f)];
}

/**
 * PHASE 1 §12 — RELEASE-BLOCKING closure, which is a different question from
 * whether the architecture backlog is empty.
 *
 * An open defect blocks a release. A registered route that nobody has written a
 * product disposition for does not — it is work that is real, visible, and not
 * a reason to hold a shipment. Reporting them as one number meant the release
 * question could not be answered at all: the total was permanently non-zero for
 * a reason no release decision could act on.
 *
 * What is NOT relaxed: a NEW unreviewed route appearing after the Phase-1
 * baseline IS release-blocking. The existing inventory may remain; growing it
 * silently may not.
 */
export function releaseBlockingProblems(f) {
  const problems = [];
  const open = f.findingsLedgerRef.openIds ?? [];
  if (open.length > 0) problems.push(`OPEN LOCAL FINDINGS: ${open.join(", ")}`);
  for (const [k, v] of Object.entries(f.facts.instrumentIntegrity)) {
    if (v !== 0) problems.push(`INSTRUMENT: ${k} = ${v}`);
  }
  // PHASE 13 §B — the mutation invariants. A mutation reachable from an
  // ungoverned entrypoint, an unbound tenant, an external effect inside a
  // transaction, a producer with no processor: each is a release-blocking
  // fact about the PRODUCT, not about the instrument.
  const mut = f.facts.mutations;
  if (mut) {
    for (const k of [
      "authorizationAfterMutation",
      "tenantUnbound",
      "unsafeEffectsInsideTransactions",
      "orphanQueueProducers",
      "parallelAuthorities",
      "legacyWriters",
      "nonIdempotentRetryableEffects",
      "unprocessedQueueFamilies",
    ]) {
      if (mut[k] !== 0) problems.push(`MUTATION: ${k} = ${mut[k]}`);
    }
    if (mut.conservationHolds === false) problems.push("MUTATION: conservation identity FAILED");
    if (mut.writerConservationHolds === false) {
      problems.push("MUTATION: the disjoint writer-bucket identity FAILED");
    }
    for (const k of ["moduleScopedAttribution", "unresolvedWriters", "writerBucketOverlaps", "writerBucketMissing"]) {
      if (mut[k] !== 0) problems.push(`MUTATION: ${k} = ${mut[k]}`);
    }
  }

  // PHASE 13 §6 — A RELEASE-REQUIRED UI GAP BLOCKS THE RELEASE.
  //
  // It was previously reported under `ArchitectureBacklog` as
  // NON_BLOCKING_VISIBLE, which is the correct treatment for an undisposed
  // route and the WRONG treatment for a capability the product ships a
  // registered route for and no way to reach. "Release-required" and
  // "non-blocking" cannot both be true; the name says which one wins.
  //
  // A row that is genuinely out of scope belongs in MISSING_PRODUCT_UI_POST_RELEASE
  // with its evidence, and stays non-blocking there.
  const ui = f.facts.capabilities?.missingProductUiReleaseRequired;
  if (ui) {
    problems.push(
      `RELEASE-REQUIRED UI MISSING: ${ui} capabilities have a registered route and no product surface`,
    );
  }

  // PHASE 13 §4 — AN EXECUTABLE WRITER NOTHING REACHES BLOCKS THE RELEASE.
  //
  // `PRESERVED_PLANNED_WRITER` was a bucket, which was the right first move:
  // it counted the backlog instead of absorbing it. But a bucket is still a
  // place a writer can sit indefinitely, and "preserved" is not a state a
  // shipped product has — either something reaches the code or it does not.
  // Both unreached buckets are therefore release-blocking, and the number is
  // derived from the buckets so it cannot be moved without moving the writers.
  const mutations = f.facts.mutations;
  if (mutations?.byWriterBucket) {
    const unwired =
      (mutations.byWriterBucket.PRESERVED_PLANNED_WRITER ?? 0) +
      (mutations.byWriterBucket.DEAD_UNREACHABLE ?? 0);
    if (unwired > 0) {
      problems.push(
        `UNWIRED EXECUTABLE WRITERS: ${unwired} terminal writers have zero entrypoints ` +
          "(PRESERVED_PLANNED_WRITER + DEAD_UNREACHABLE)",
      );
    }
  }

  // PHASE 13 §8-9 — THE BROWSER LAYER IS PART OF THE RELEASE DECISION.
  //
  // The previous pass reported every source-level counter at zero alongside a
  // checkpoint row reading "NOT EXECUTED" for the browser proof of three fixed
  // defects and twenty-four built capabilities. Those two statements were both
  // true and could not both be acted on. A capability with a user surface and
  // no evidence that a browser ever reached it is not closed, so it is counted
  // here rather than in the narrative.
  const p7 = f.facts.point7;
  if (p7) {
    if (!p7.artifactPresent) {
      problems.push("POINT 7: no browser proof artifact — the matrix has not run");
    } else {
      if (!p7.fresh) {
        problems.push(
          "POINT 7: the proof is not FRESH — it needs one run id, one build id, " +
            `a production build and strict CSP (runIds=${p7.runIds}, buildIds=${p7.buildIds}, ` +
            `productionBuild=${p7.productionBuild}, strictCsp=${p7.strictCsp})`,
        );
      }
      if (p7.browserVerifiedUiCapabilities < p7.implementedUiCapabilities) {
        problems.push(
          `POINT 7: ${p7.unexecutedUiCapabilities} of ${p7.implementedUiCapabilities} implemented UI ` +
            `capabilities were never exercised by a browser: ${p7.unverifiedCapabilityIds.join(", ")}`,
        );
      }
      for (const [label, verdict] of [
        ["NEW-027Runtime", p7.new027Runtime],
        ["NEW-028Runtime", p7.new028Runtime],
        ["NEW-029Runtime", p7.new029Runtime],
        ["NEW-058Runtime", p7.new058Runtime],
      ]) {
        if (verdict !== "PASS") problems.push(`POINT 7: ${label} = ${verdict}`);
      }
    }
  }

  // PHASE 13 §1 — A CHECKPOINT THAT CONTRADICTS THE MEASUREMENT BLOCKS TOO.
  //
  // It is the document the next pass reads first. A stale scalar in it is
  // acted on, and acting on a stale scalar is how a closed counter gets
  // reopened by hand.
  const cp = f.checkpoint;
  if (cp) {
    if (!cp.present) problems.push("CHECKPOINT: the continuation checkpoint is missing");
    else if (cp.violations.length > 0) {
      problems.push(
        `CHECKPOINT: ${cp.violations.length} violation(s) — ${cp.violations.slice(0, 5).join(" | ")}`,
      );
    }
  }
  return problems;
}

/**
 * The architecture backlog. Visible, counted, and NOT release-blocking.
 *
 * It earns no credit of any kind: these routes are not claimed to be correct,
 * intentional, API-only or complete.
 */
export function architectureBacklogProblems(f) {
  const problems = [];
  const c = f.facts.capabilities;
  if (c.undisposed !== 0) {
    problems.push(
      `ArchitectureBacklog: UndisposedRoutes = ${c.undisposed} — registered routes with no reviewed product disposition (ARCH-BACKLOG-001, NON-BLOCKING, no security or completeness credit)`,
    );
  }
  if (c.deadRemovePending) {
    problems.push(
      `ArchitectureBacklog: DeadRemovePending = ${c.deadRemovePending} — routes dispositioned DEAD_REMOVE whose removal has not been executed (ARCH-BACKLOG-003)`,
    );
  }
  if (c.mandateConservationHolds === false) {
    problems.push("MandateDispositionConservation FAILED — the disposition families do not sum to the production route count");
  }
  return problems;
}
