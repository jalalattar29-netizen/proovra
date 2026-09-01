/**
 * PHASE 0 — THE AUDIT SYSTEM'S SINGLE REGISTRY.
 *
 * Why this file exists
 * ---------------------------------------------------------------------------
 * Before Phase 0 the audit system had no statement of what it was. Which script
 * was the authority for routes, which JSON was current and which was a record
 * of a pass that ended in July, which gate was measuring and which was pinning
 * the shape of a tool that no longer ran — all of that lived in prose, in file
 * names, and in the memory of whoever wrote the last report. Three separate
 * regex scanners each believed they knew what a registered route was, and they
 * disagreed with each other and with the AST engine.
 *
 * This file is the one place that answers those questions, and the governance
 * inventory (`governance.mjs`) checks the answers against the tree rather than
 * trusting them. A declaration here that names a file which does not exist, or
 * that claims an authority a second file also claims, is a FAILURE — the
 * registry is falsifiable, which is the whole point.
 *
 * It is NOT a findings ledger, NOT a route registry and NOT a capability map.
 * It holds no counts. Every number in the audit system is derived by an
 * analyzer at run time; this file only says which analyzer is allowed to
 * derive it.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root, derived from this file's location. */
export const REPO = path.resolve(HERE, "../../../../..");

export const ENGINE_VERSION = "audit-engine@1.0.0";
export const FACTS_SCHEMA_VERSION = "architecture-facts@1";
export const INVENTORY_SCHEMA_VERSION = "audit-governance-inventory@1";
export const RECOVERY_SCHEMA_VERSION = "phase0-recovery-manifest@1";

// ===========================================================================
// THE CANONICAL AUTHORITIES — exactly one of each.
//
// `sourceOfTruthFor` is the claim. `governance.mjs` proves that no other file
// in the tree claims the same subject, so a second opinion cannot reappear
// without failing the engine check.
// ===========================================================================

export const CANONICAL = Object.freeze({
  orchestrator: {
    path: "services/api/scripts/audit/index.mjs",
    sourceOfTruthFor: "AUDIT_ORCHESTRATION",
    entryPoint: "pnpm audit:architecture",
  },
  engineComponents: Object.freeze([
    "services/api/scripts/audit/index.mjs",
    "services/api/scripts/audit/engine/registry.mjs",
    "services/api/scripts/audit/engine/governance.mjs",
    "services/api/scripts/audit/engine/domain-proofs.mjs",
    "services/api/scripts/audit/engine/facts.mjs",
    "services/api/scripts/audit/engine/worktree.mjs",
    "services/api/scripts/audit/engine/report.mjs",
    "services/api/scripts/audit/engine/test-caller-diagnostic.mjs",
    "services/api/scripts/generate-runtime-capability-map.mjs",
    "services/api/scripts/capability-authority/analyzer.mjs",
    "services/api/scripts/capability-authority/routes.mjs",
    "services/api/scripts/capability-authority/consumers.mjs",
  ]),
  routeAuthority: {
    path: "services/api/scripts/capability-authority/routes.mjs",
    sourceOfTruthFor: "ROUTE_INVENTORY",
  },
  consumerAuthority: {
    path: "services/api/scripts/capability-authority/consumers.mjs",
    sourceOfTruthFor: "CONSUMER_INVENTORY",
  },
  capabilityMap: {
    path: "docs/architecture/current-runtime-capability-map.json",
    // The orchestrator WRITES it; the generator MEASURES it. Keeping the two
    // apart is what let the generator stop reading its own output as a fact and
    // stop owning a second set of exit-code semantics.
    producer: "services/api/scripts/audit/index.mjs",
    measuredBy: "services/api/scripts/generate-runtime-capability-map.mjs",
    sourceOfTruthFor: "CAPABILITY_CLASSIFICATION",
  },
  currentFacts: {
    path: "audit-output/current/architecture-facts.json",
    producer: "services/api/scripts/audit/engine/facts.mjs",
    sourceOfTruthFor: "CURRENT_ARCHITECTURE_FACTS",
  },
  governanceInventory: {
    path: "audit-output/current/audit-governance-inventory.json",
    producer: "services/api/scripts/audit/engine/governance.mjs",
    sourceOfTruthFor: "AUDIT_SYSTEM_INVENTORY",
  },
  findingsLedger: {
    // THE one ledger source. Everything else in that directory has a different
    // role: `generate-ledger.mjs` is the validator/generator, `ledger.json` and
    // `ledger.md` are renderings of these rows. Naming all four
    // "CANONICAL_FINDINGS_LEDGER" made it look like four ledgers, which is the
    // ambiguity this field removes.
    rows: "audit-output/current/ledger/rows.json",
    producer: "audit-output/current/ledger/generate-ledger.mjs",
    derived: Object.freeze([
      "audit-output/current/ledger/ledger.json",
      "audit-output/current/ledger/ledger.md",
    ]),
    sourceOfTruthFor: "FINDINGS",
  },
  currentReport: {
    path: "audit-output/current/report.md",
    producer: "services/api/scripts/audit/index.mjs",
    renderer: "services/api/scripts/audit/engine/report.mjs",
    sourceOfTruthFor: "CURRENT_AUDIT_REPORT",
  },
});

/**
 * NOT authorities. Reproducible observations that no gate may consume.
 *
 * A diagnostic exists to answer a human's question. The moment one is read to
 * decide something, it is an authority with no producer discipline — so the
 * governance inventory refuses to let any of these claim a `sourceOfTruthFor`,
 * and refuses to let a gate read them.
 */
export const DIAGNOSTICS = Object.freeze([
  {
    path: "audit-output/diagnostics/test-caller-diagnostic.json",
    producer: "services/api/scripts/audit/index.mjs",
    derivedBy: "services/api/scripts/audit/engine/test-caller-diagnostic.mjs",
    why: "Recovers `testCallerCount` / `testOnly` from the retired route-consumers.json. Test callers are excluded from the consumer AUTHORITY on purpose — a proof suite calling a route is what makes an orphan look connected — so this may never be read to decide whether a route is wired.",
  },
]);

/**
 * THE PATHS THIS ENGINE WRITES ON EVERY RUN.
 *
 * Why this exists
 * ---------------------------------------------------------------------------
 * The Phase-0 change set is derived from `git status --porcelain`, and the
 * engine writes into the very tree that status describes. That made the change
 * set self-referential in two separate ways, both observed at a CLEAN `HEAD`:
 *
 *   1. The engine's own five outputs appeared in the change set, so a tree with
 *      no source change at all reported changed paths.
 *   2. Worse, the number depended on WHEN during the run git was sampled.
 *      `regenerate()` samples once for the inventory (0 artifacts written yet)
 *      and again inside `buildFacts()` (3 written by then), while `engineCheck()`
 *      samples after all 5 exist. So the recorded value was a function of write
 *      order rather than of the tree, and could never equal what the next run
 *      recomputed — the staleness gate fired on every single run, at every
 *      commit, forever.
 *
 * Excluding exactly these paths from the change-set derivation makes it a pure
 * function of the SOURCE tree: identical before the run, mid-run and after it.
 *
 * SCOPE IS DELIBERATELY NARROW. This is not the `audit-output/` prefix. The
 * findings ledger rows under that prefix are a hand-maintained governance
 * SOURCE, and drift in them must still be detected — so they are absent here,
 * as is every production, test, config, migration and docs path. `governance.mjs`
 * proves at run time that what it actually excluded equals this list, so the
 * exclusion cannot quietly widen to cover an inconvenient dirty file.
 */
export const ENGINE_GENERATED_PATHS = Object.freeze([
  CANONICAL.governanceInventory.path,
  CANONICAL.currentFacts.path,
  CANONICAL.currentReport.path,
  CANONICAL.capabilityMap.path,
  ...DIAGNOSTICS.map((d) => d.path),
]);

/**
 * Working-tree freeze / recovery metadata.
 *
 * It describes a LOCAL CHECKOUT, not the release, so it is not a current audit
 * fact and does not belong in the artifact tree. `--freeze` writes it to a
 * verified location OUTSIDE the repository; this constant exists only so the
 * governance gate can prove nothing has put it back inside.
 */
export const RECOVERY_MANIFEST_BASENAME = "recovery-manifest.json";
export const FORBIDDEN_IN_REPO_RECOVERY_PREFIX = "audit-output/phase0-recovery/";

// ===========================================================================
// REPORT ROLES — disjoint, and made to CONSERVE.
//
// The previous pass reported "of the 14" and then listed fifteen records. The
// arithmetic was wrong in a specific and instructive way: the fourteen were the
// paths that had carried the retired CURRENT_REPORT_TEMPLATE role, and the
// fifteenth — the generated current report — had not existed when that list was
// taken. Two populations were added together as if they were one.
//
// The fix is not a corrected sentence. It is that the populations are now
// named, disjoint, and required to sum, so a miscount fails the engine check
// instead of reaching a report.
//
//   ReportRelatedEntries
//     = ReportDocuments + HistoryTreeMarkers + NonAuditProductReportTemplates
//
//   ReportDocuments
//     = CurrentGeneratedReports + HistoricalReports
//     + DomainReportTemplates + MisclassifiedReportDocuments
//
// A HISTORY_TREE_MARKER is deliberately NOT a report document: it is a
// governance marker that says what a directory is. Counting it as a report was
// how the fifteenth record appeared.
// ===========================================================================

export const REPORT_ROLES = Object.freeze({
  CURRENT_GENERATED_REPORT: "REPORT_DOCUMENT",
  HISTORICAL_REPORT: "REPORT_DOCUMENT",
  DOMAIN_REPORT_TEMPLATE: "REPORT_DOCUMENT",
  MISCLASSIFIED_REPORT_DOCUMENT: "REPORT_DOCUMENT",
  HISTORY_TREE_MARKER: "GOVERNANCE_MARKER",
  NON_AUDIT_PRODUCT_REPORT_TEMPLATE: "PRODUCT_ARTEFACT",
});

// ===========================================================================
// DOMAIN AUTHORITIES — genuinely different subjects, deliberately NOT collapsed.
//
// Each names ONE producer and ONE artifact. The engine reads them, hashes them
// and reports their freshness; it never re-derives their subject, and they
// never re-derive routes, consumers, capabilities or findings.
//
// `binding` says what makes the artifact current:
//   SOURCE_REVISION — it records the revision it measured
//   BUILD_ID        — it records the build it was executed against
//   RUN_ID          — it records the run that produced it
//   CONTENT_ONLY    — it is a hand-curated registry; only its hash is tracked
// ===========================================================================

export const DOMAIN_AUTHORITIES = Object.freeze([
  {
    domain: "POINT5_EXECUTED_PROOF",
    artifact: "docs/architecture/point5-family-proven-cases.json",
    producer: "services/api/test/point5/family-coverage-manifest.ts",
    binding: "RUN_ID",
    why: "Family state machines are credited from EXECUTED cases plus the SHA-256 of the suite that executed them and the integration run that produced the record.",
  },
  {
    domain: "POINT7_EXECUTED_PROOF",
    artifact: "docs/architecture/point7-proven-scenarios.json",
    producer: "services/api/test/point7/scenario-manifest.ts",
    binding: "BUILD_ID",
    why: "Plan-journey scenarios are only credited against the build id they were executed on.",
  },
  {
    domain: "MIGRATION_INVENTORY",
    artifact: "docs/architecture/migration-inventory-p6.json",
    producer: "services/api/scripts/migration-inventory.mjs",
    binding: "CONTENT_ONLY",
    why: "One record per migration directory on disk. The source engine never classifies migrations; this is the database domain's own authority.",
  },
  {
    domain: "SCHEMA_MODEL_CLASSIFICATION",
    artifact: "docs/architecture/schema-migration-classification.json",
    producer: "REVIEWED_BY_HUMAN",
    binding: "CONTENT_ONLY",
    why: "MODEL-level schema classification. Its migration half is SUPERSEDED by migration-inventory-p6.json; it remains the authority for the model layer only, so the two are not competing inventories.",
  },
  {
    domain: "ROUTE_DISPOSITIONS",
    artifact: "services/api/scripts/capability-authority/manifests/route-dispositions.json",
    producer: "REVIEWED_BY_HUMAN",
    binding: "CONTENT_ONLY",
    why: "Human JUDGEMENT about a route with no product consumer. Kept OUT of the generated map on purpose: the generator refuses a judgement whose subject has disappeared.",
  },
  {
    domain: "CAPABILITY_TAXONOMY",
    artifact: "services/api/scripts/capability-authority/manifests/capability-taxonomy.json",
    producer: "REVIEWED_BY_HUMAN",
    binding: "CONTENT_ONLY",
    why: "Vertical + evidence-level judgement per route, consumed by the generator's legacy projection.",
  },
  {
    domain: "CONSUMER_RESOLUTIONS",
    artifact: "services/api/scripts/capability-authority/manifests/consumer-resolutions.json",
    producer: "REVIEWED_BY_HUMAN",
    binding: "CONTENT_ONLY",
    why: "Reviewed resolution of a call site the analyzer refused to guess about.",
  },
  {
    domain: "DYNAMIC_RESOLUTIONS",
    artifact: "services/api/scripts/capability-authority/manifests/dynamic-resolutions.json",
    producer: "REVIEWED_BY_HUMAN",
    binding: "CONTENT_ONLY",
    why: "Reviewed resolution of a dynamically-registered route or dynamically-built request path.",
  },
  {
    domain: "ORIGIN_RESOLUTIONS",
    artifact: "services/api/scripts/capability-authority/manifests/origin-resolutions.json",
    producer: "REVIEWED_BY_HUMAN",
    binding: "CONTENT_ONLY",
    why: "Reviewed judgement that a request origin belongs to a third party rather than this API.",
  },
  {
    domain: "ROUTE_CLASSIFICATION_REGISTRY",
    artifact: "docs/architecture/route-classification/wiring-registry.json",
    producer: "REVIEWED_BY_HUMAN",
    binding: "CONTENT_ONLY",
    why: "The fixed STEP-3 wiring baseline. It classifies a FROZEN operation set, not the live tree, so it is not a second route inventory.",
  },
]);

// ===========================================================================
// DELEGATES — names kept because CI, docs and habit invoke them.
//
// A delegate may parse CLI arguments, call the canonical evaluator and format
// output. It may NOT parse source, classify a route, carry a baseline, or hold
// an opinion of its own. `governance.mjs` enforces the byte-size and the
// absence of a scanner in each one.
// ===========================================================================

export const DELEGATES = Object.freeze([
  {
    path: "services/api/scripts/verify-route-consumers.mjs",
    delegatesTo: "services/api/scripts/generate-runtime-capability-map.mjs",
    retiredAuthority: "TEXT_CONSUMER_SCANNER",
  },
]);

// ===========================================================================
// RETIRED — removed in Phase 0, and recorded so the removal is falsifiable.
//
// A deletion described only in a report is a deletion that can quietly come
// back. Each entry names what was removed, what replaced it, and — honestly —
// whether anything it carried exists nowhere else. `governance.mjs` fails if
// any of these paths reappears, which turns the record into a contract.
// ===========================================================================

export const RETIRED = Object.freeze([
  {
    path: "audit-output/phase12-final-remediation/route-consumers/route-consumers.json",
    reason:
      "Output of the retired TEXT consumer scanner. Its subject — which routes have a product or machine caller — is measured by the AST engine, whose per-route records carry the caller's file and line. The retired scanner's own numbers were the known-wrong half of the 773-vs-785 disagreement that FINAL-001 was opened for.",
    /** Gates, reports or tools reading it at the time it was deleted. */
    lastConsumers: [],
    /** Decisions, findings or dispositions ever taken on the strength of it. */
    decisionConsumers: [],
    replacement: "docs/architecture/current-runtime-capability-map.json",
    recoverable: false,

    /**
     * What the deleted artifact actually WAS. `authority: "none"` is the load-
     * bearing field: it is why retiring this is housekeeping rather than the
     * loss of evidence, and it is asserted per-row rather than argued in prose.
     */
    semantics: {
      fields: ["testCallerCount", "testOnly"],
      derivation: "substring occurrence of a route path anywhere in a test file",
      authority: "none",
      quality:
        "NOISY. A substring match counts a path that appears in a comment, in a doc string, or as a prefix of a different route's path, and misses every caller that builds its path from a template. The same scanner produced the 773-vs-785 disagreement that FINAL-001 was opened for.",
      currentConsumers: 0,
      decisionConsumers: 0,
      reproducibleExactly: false,
      whyNotReproducible:
        "Reproducing the figures exactly would mean rebuilding the substring scanner, which is the thing Phase 0 retired. The replacement measures a different, narrower and better-defined population.",
    },

    uniqueDataLost:
      "`testCallerCount` / `testOnly` per route. The canonical map does not publish a test-caller dimension, and the two cases it collapses — 'no callers at all' and 'only suites call this' — are genuinely different facts.",

    /**
     * NOT an exact re-derivation, and the previous pass was wrong to imply it
     * was. The replacement measures an AST-resolved lower bound over a
     * different population; the old metric is not reproducible and will not be
     * reproduced. Recorded here so the difference travels with the record.
     */
    uniqueDataResolution: {
      option: "A — REPLACED BY A HISTORICAL DIAGNOSTIC (NOT AN EXACT RE-DERIVATION)",
      artifact: "audit-output/diagnostics/test-caller-diagnostic.json",
      derivedBy: "services/api/scripts/audit/engine/test-caller-diagnostic.mjs",
      exactReproduction: false,
      replacementSemantics: "AST-resolved lower bound over test request call sites",
      semanticDifference:
        "The old metric counted SUBSTRINGS; the new one counts RESOLVED CALLS. It therefore excludes comments, doc strings and coincidental path prefixes that the old one counted, and excludes Fastify `app.inject()` — not a request primitive — that the old one would have caught as a substring. The two numbers are not comparable in either direction, and the new one is a lower bound.",
      how: "The canonical analyzer, opted into the test trees (`analyzeSources({ includeTests: true })`), resolving request primitives to routes exactly as it does for product callers. Suites live outside every product root, so the diagnostic supplies the test roots as a `product: false` tree — widening what is OBSERVED without widening what may be classified as a consumer.",
      whyNotAnAuthority:
        "Test callers are excluded from the consumer authority on purpose: a proof suite calling a route is exactly what makes an orphan look connected. The governance gate refuses to let any gate read this file, refuses to let it claim a sourceOfTruthFor, and refuses to credit it toward product closure.",
      fieldsAccountedFor: ["testCallerCount", "testOnly"],
    },
  },
  {
    path: "audit-output/phase12-final-remediation/freeze/freeze.json",
    reason: "Regenerable output of the working-tree freeze collector.",
    lastConsumers: [],
    replacement: "audit-output/phase0-recovery/recovery-manifest.json (`pnpm audit:architecture --freeze`)",
    recoverable: true,
    uniqueDataLost: null,
  },
  {
    path: "audit-output/phase12-final-remediation/freeze/classify-working-tree.mjs",
    reason:
      "A collector living inside the directory it wrote to, with no package script, no CI reference and no consuming gate. MOVED rather than deleted.",
    lastConsumers: [],
    replacement: "services/api/scripts/audit/engine/worktree.mjs",
    recoverable: true,
    uniqueDataLost: null,
  },
]);

// ===========================================================================
// HISTORICAL — records of what a past pass concluded. Never a current input.
//
// The status is carried by the PATH rather than by a header inside each of
// thirty-odd files, so a reader and a program reach the same conclusion, and a
// file cannot drift back into being read as current by being edited.
// ===========================================================================

export const HISTORICAL_PREFIXES = Object.freeze([
  "audit-output/history/",
]);

/**
 * PHASE 0 CORRECTIVE §7 — finished audit narratives that live in `docs/`.
 *
 * These are the same kind of document as everything under `audit-output/
 * history/`: a pass that ended, written up on the day it ended. They were
 * classified `CURRENT_REPORT_TEMPLATE`, which says the opposite of what they
 * are — a reader looking for the current answer had thirteen files that
 * announced themselves as current reports and one that actually was.
 *
 * They are NOT moved. They are cross-linked from runbooks, plans and commit
 * manifests, and rewriting those links is churn that buys nothing: the status
 * is what needed fixing, not the location. Declaring them here gives the engine
 * the same refusal it has for the history tree — a current tool that READS one
 * fails the engine check — without touching a single link.
 *
 * Membership is a judgement, so each carries the reason it is finished.
 */
export const HISTORICAL_DOCUMENTS = Object.freeze({
  "docs/architecture/investigation-suite-audit.md": "Point-in-time audit of the investigation suite; superseded by the capability map's per-route measurement.",
  "docs/architecture/phase-7-closure-audit.md": "Closure write-up for a phase that ended.",
  "docs/architecture/phase-8-organization-governance-final.md": "Final report for a phase that ended.",
  "docs/architecture/phase-9-team-platform-audit-final.md": "Final report for a phase that ended.",
  "docs/architecture/point7-corrective-closure-2026-08-05.md": "Dated corrective-pass narrative. The Point-7 CURRENT fact is the executed-proof artifact, not this.",
  "docs/architecture/point7-determinism-closure-2026-08-05.md": "Dated corrective-pass narrative.",
  "docs/architecture/point7-external-destination-closure-2026-08-05.md": "Dated corrective-pass narrative.",
  "docs/architecture/point7-production-build-closure-2026-08-05.md": "Dated corrective-pass narrative.",
  "docs/architecture/point8-external-staging-gates-2026-08-05.md": "Dated narrative of a staging-gate pass. External closure is NOT RUN; this file must never be read as evidence that it was.",
  "docs/architecture/route-classification/CAPABILITY-AUDIT-RESOLUTION.md": "Resolution narrative for the capability-preservation audit; the resolution itself lives in the manifests and the map.",
  "docs/architecture/search-reality-audit.md": "Point-in-time audit of the search surface.",
  "docs/architecture/workspace-surface-audit.md": "Point-in-time audit of the workspace surface.",
});

/**
 * The tree's own status marker. It lives inside the history tree because that
 * is where a reader arrives, but it is not itself a historical record — it is
 * the sign on the door, and the Phase-0 gate READS it to prove the sign is
 * still up. Without this exception that gate reports itself as a current tool
 * reading a historical record, which is true of the path and false of the fact.
 */
export const HISTORICAL_MARKER = "audit-output/history/README.md";

/**
 * The ONE resume note for work in progress.
 *
 * Deliberately singular and deliberately current: a second one would be two
 * accounts of where execution stopped, which is the same failure as two route
 * inventories one level down. It states no count of its own — every number in
 * it is copied from the generated facts and is re-derivable by running the
 * engine — so it is neither an authority nor a report, and nothing may
 * reconcile against it.
 */
export const CONTINUATION_CHECKPOINT = "audit-output/current/CONTINUATION-CHECKPOINT.md";

/**
 * Hand-maintained programme narratives that are still being written, and are
 * therefore not historical — but are not audit authorities either. They carry
 * counts; nothing may reconcile against them.
 */
export const DOMAIN_REPORT_TEMPLATES = Object.freeze({
  "docs/architecture/program-ledger.md":
    "The unified programme's own implementation narrative, still being appended to. It records what each phase did; it does not measure the tree. One suite reads it, and only to assert that its NON-AUTHORITATIVE disclaimer for the old 19,360 figure is still present — a disclaimer check, not a count read.",
});

/** True when `rel` (a repo-relative POSIX path) is a historical record. */
export const isHistorical = (rel) =>
  rel !== HISTORICAL_MARKER &&
  (HISTORICAL_PREFIXES.some((p) => rel.startsWith(p)) ||
    Object.hasOwn(HISTORICAL_DOCUMENTS, rel));

// ===========================================================================
// The trees the audit system is allowed to READ as production source.
// ===========================================================================

// ===========================================================================
// PHASE-0 CHANGE ATTRIBUTION — from the baseline and the content, never a list.
//
// This replaced a hand-maintained `PHASE0_CHANGED_PREFIXES`, and the reason it
// had to go is the same reason every other hand-maintained thing in this
// programme had to go: a changed path that somebody forgot to add to the list
// was INVISIBLE to the counter computed from it, so
// `ProductionRuntimeFilesModifiedByPhase0 = 0` could be true of the list while
// being false of the tree.
//
// The baseline is now HEAD — a real, hashed, verified snapshot — and the
// complete changed set comes from git, so nothing that changed can hide.
// Attribution WITHIN that set is content-derived by the three signals below.
//
// WHAT THIS PROVES, EXACTLY. No artifact records the working tree at the
// instant Phase 0 began: the earliest external recovery manifest was written
// during Phase 0, the probe-stash export is mid-pass, and `.p12snapshot` is
// from an older HEAD (a7863bec). So a path changed relative to HEAD cannot be
// differentially attributed to Phase 0 versus the user's pre-existing work.
//
// The safety counters do not need that attribution. They are proven by a
// STRONGER, attribution-free statement: no changed production-runtime file
// bears any Phase-0 authorship signal at all, no `.test.` path is deleted
// anywhere in the change set, and no path under a migrations directory is
// changed at all. Those hold whoever authored the rest.
// ===========================================================================

/**
 * Content signals that a file was written into by Phase 0.
 *
 * Applied to the lines ADDED relative to HEAD, so a pre-existing mention in the
 * committed version cannot create a false attribution.
 */
export const PHASE0_AUTHORSHIP_MARKERS = Object.freeze([
  "PHASE 0",
  "Phase 0",
  "PHASE-0",
  "Phase-0",
]);

/** References to the canonical engine — how a manifest or type file joins it. */
export const PHASE0_ENGINE_REFERENCES = Object.freeze([
  "audit:architecture",
  "scripts/audit/index.mjs",
  "audit/engine/",
  "capability-authority",
  "_canonical-facts",
]);

/**
 * Code that EXECUTES in production. Deliberately narrower than "source": a
 * package manifest determines what ships but runs nothing, and `scripts/` is
 * tooling. Phase 0 changed two files under `services/api/scripts/` — the
 * migration inventory and its reconciler — and neither is reachable from a
 * running service.
 */
export const PRODUCTION_RUNTIME_ROOTS = Object.freeze([
  "services/api/src/",
  "services/worker/src/",
  "apps/web/app/",
  "apps/web/components/",
  "apps/web/lib/",
  "apps/web/hooks/",
  /**
   * PHASE 13 (PHASE 2) — Next.js REQUEST MIDDLEWARE, which lives at the app
   * root and therefore matched none of the directory prefixes above.
   *
   * The classification table refused it rather than defaulting it, which is the
   * behaviour it exists for: an unmatched path is a kind of file nobody has
   * looked at. Having looked — this is the single most runtime-ish file in the
   * web tier. It executes on EVERY request, and it is where the production
   * Content-Security-Policy is built, including the `connect-src` entries that
   * name the API and object-store origins. Filing it as anything other than
   * production runtime would have left the CSP authority outside the rule that
   * says a Phase-0 pass may not touch production runtime.
   *
   * Named as an exact file, not as `apps/web/`, so config and type-declaration
   * files sitting beside it are not swept in with it.
   */
  "apps/web/middleware.ts",
  /**
   * ATTENTION ARCHITECTURE (2026-08-22) — the Next.js ROUTING CONFIGURATION,
   * which sits at the app root beside `middleware.ts` and matched none of
   * the directory prefixes above.
   *
   * The table refused it rather than defaulting it — again the behaviour it
   * exists for. Having looked: `next.config.js` holds `redirects()`, and a
   * redirect executes on every matching request exactly as middleware does.
   * It is also, as of this pass, where the TENANT/PLATFORM namespace
   * boundary is written down: the `/operations/* → /admin/platform/*`
   * entries are what keep a historical URL for an internal console landing
   * on the platform-admin-gated route rather than inside the tenant
   * Operations namespace. A file that decides where a request lands is
   * production runtime; filing it as RELEASE_CONFIGURATION beside
   * `tsconfig.json` would put a routing authority outside the rule that
   * says an audit-engine pass may not touch production runtime.
   *
   * Named as an exact file, for the same reason `middleware.ts` is: so the
   * type-declaration and config files beside it are not swept in.
   */
  "apps/web/next.config.js",
  "apps/mobile/",
  "packages/",
]);

/**
 * Classification of a changed path, in order. Every changed path must match
 * one — an unmatched path is a FAILURE, never a default, because a new kind of
 * file must be looked at rather than swept into a bucket.
 */
export const CHANGED_PATH_CLASSES = Object.freeze([
  { class: "HISTORICAL_MIGRATION", test: (p) => /(^|\/)migrations\//.test(p) },
  /**
   * PHASE 13 — the Prisma schema is its OWN class.
   *
   * It matched nothing and therefore failed the "every changed path must be
   * classified" rule, which is correct behaviour from a table that refuses to
   * default — a new kind of file must be looked at. Having looked: it is
   * neither a historical migration (its bytes are meant to change) nor product
   * runtime code (nothing imports it) nor documentation. It is the schema
   * DECLARATION, and the thing that protects it is the migration that
   * accompanies it, which the rule above governs.
   */
  {
    class: "SCHEMA_DECLARATION",
    test: (p) => /(^|\/)prisma\/schema\.prisma$/.test(p),
  },
  /**
   * EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — `.env.example` is its own
   * class, added for the same reason and by the same procedure as
   * `SCHEMA_DECLARATION` above: it matched nothing, the table correctly refused
   * to default, and somebody had to look at it.
   *
   * Having looked. It is not PRODUCTION_RUNTIME — no module imports it, and
   * changing it changes no shipped behaviour. It is not DOCUMENTATION: prose
   * describes the system, whereas this file is copied by an operator and
   * becomes the system's configuration, so a wrong line here is a wrong
   * deployment rather than a wrong sentence. And it is not
   * RELEASE_CONFIGURATION alongside `tsconfig.json`, which configures the
   * BUILD; this declares the variables a running service reads.
   *
   * What it is: the ENVIRONMENT CONTRACT — the enumerated set of variables the
   * service consults, with defaults chosen to be safe and with no secret
   * values. The change that prompted the class is the case in point: a variable
   * that used to be read straight into `PutObjectLegalHold` is now inert, and
   * saying so in this file is the only place an operator would ever find out.
   *
   * `.env` itself is never in a change set — it is gitignored — so this rule
   * deliberately matches only the committed templates.
   */
  {
    class: "ENVIRONMENT_TEMPLATE",
    test: (p) => /(^|\/)\.env\.(example|sample|template)$/.test(p),
  },
  // Before DOCUMENTATION: the snapshot holds `.txt` and `.patch` files, and a
  // suffix rule further down was claiming them as prose. A recovery snapshot
  // filed as documentation is a recovery snapshot nobody protects.
  { class: "RECOVERY_SNAPSHOT", test: (p) => p.startsWith(".p12snapshot/") },
  /**
   * ADM-013 PHASE 4 — OPERATOR SQL: its own class, added by the same procedure
   * as `SCHEMA_DECLARATION` and `ENVIRONMENT_TEMPLATE` above. It matched
   * nothing, the table correctly refused to default, and somebody had to look
   * at it.
   *
   * Having looked. It is not HISTORICAL_MIGRATION: nothing applies it, Prisma
   * does not know it exists, and no checksum is recorded for it — the whole
   * reason it is here rather than under `migrations/` is that applying it is a
   * DECISION. It is not PRODUCTION_RUNTIME: no module imports it and no request
   * path executes it. And it is emphatically not DOCUMENTATION, which is the
   * class a `.sql` suffix rule would otherwise hand it — prose describes the
   * system, whereas an operator pastes this into psql and it BECOMES the
   * system, so a wrong line here is a wrong database rather than a wrong
   * sentence. Filing a destructive convergence as prose is precisely the
   * mistake the RECOVERY_SNAPSHOT rule above exists to prevent for snapshots.
   *
   * What it is: SQL an operator runs deliberately, once, against a live
   * database, after reading what it will do. Two things follow and are worth
   * stating because the class is what carries them:
   *
   *   * it is held to the migration safety gate's STANDARDS even though the
   *     gate does not scan it — it is idempotent, it is one transaction, and it
   *     guards every object it names; and
   *   * it ships with a read-only `.preview.sql` sibling, because a script
   *     that deletes rows and cannot first say which rows is not reviewable.
   */
  {
    class: "OPERATOR_SQL",
    test: (p) => /(^|\/)sql\/(convergence|drift-patches)\//.test(p),
  },
  {
    class: "PRODUCT_BEHAVIOR_TEST",
    test: (p) =>
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
      /(^|\/)(test|tests|__tests__)\//.test(p) ||
      p.startsWith("e2e/"),
  },
  { class: "PRODUCTION_RUNTIME", test: (p) => PRODUCTION_RUNTIME_ROOTS.some((r) => p.startsWith(r)) },
  /**
   * The container image definition — its OWN class, for the same reason
   * `SCHEMA_DECLARATION` is.
   *
   * A `Dockerfile` matched nothing and therefore failed the "every changed
   * path must be classified" rule, which is this table working as intended: an
   * unmatched path is a kind of file nobody has looked at yet. Having looked —
   * it is none of the existing classes. Nothing imports it, so it is not
   * production runtime. It does not live under `.github/`, so it is not CI. And
   * filing it as RELEASE_CONFIGURATION alongside `tsconfig.json` would
   * understate it: a Dockerfile decides the base image, the OS package set, the
   * runtime user and what is copied into the shipped artifact. It is the
   * single file that determines what a production container IS.
   *
   * `infra/docker/` is included because the image build helpers there — the
   * hardened apk installer — are executed BY these Dockerfiles at build time
   * and are meaningless apart from them. Scoped to that directory rather than
   * to `*.sh` anywhere, so unrelated shell scripts are not swept in.
   */
  {
    class: "CONTAINER_IMAGE_DEFINITION",
    test: (p) =>
      /(^|\/)Dockerfile(\.[\w.-]+)?$/.test(p) ||
      p.startsWith("infra/docker/"),
  },
  { class: "AUDIT_ARTIFACT", test: (p) => p.startsWith("audit-output/") },
  { class: "AUDIT_TOOLING", test: (p) => /(^|\/)scripts\//.test(p) || /(^|\/)tools\//.test(p) },
  { class: "CI", test: (p) => p.startsWith(".github/") },
  { class: "DOCUMENTATION", test: (p) => p.startsWith("docs/") || /\.(md|mdx|txt)$/i.test(p) },
  {
    class: "RELEASE_CONFIGURATION",
    test: (p) =>
      /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json)$/.test(p) ||
      /^\.(gitignore|dockerignore|gitattributes|npmrc|nvmrc)$/.test(p) ||
      /^tsconfig(\.[\w.-]+)?\.json$/.test(p) ||
      /(^|\/)package\.json$/.test(p) ||
      // Lint configuration, at the root or scoped to one workspace. It ships
      // nothing and executes nothing, but CI runs `pnpm -r lint`, so it decides
      // whether the tree is releasable — which is precisely a release
      // configuration and not, as the suffix rules would otherwise have it,
      // documentation.
      /(^|\/)\.eslintrc\.cjs$/.test(p) ||
      /(^|\/)\.eslintignore$/.test(p) ||
      /(^|\/)eslint\.config\.[cm]?js$/.test(p) ||
      // Runner configuration, on exactly the reasoning above. A vitest or
      // playwright config ships nothing and executes nothing, but CI runs
      // `pnpm -r test`, and the file decides which suites are discovered, how
      // they are isolated and how many workers contend — so it decides whether
      // the tree is releasable. It is not a product behaviour test (it asserts
      // nothing) and not documentation (the suffix rules would otherwise claim
      // it), which is how `services/api/vitest.config.ts` reached the change
      // set with no class at all.
      /(^|\/)vitest(\.[\w.-]+)?\.config\.[cm]?[jt]s$/.test(p) ||
      /(^|\/)playwright(\.[\w.-]+)?\.config\.[cm]?[jt]s$/.test(p),
  },
  { class: "INFRASTRUCTURE", test: (p) => p.startsWith("infra/") || p.startsWith("deploy/") },
]);

export const PRODUCTION_SOURCE_ROOTS = Object.freeze([
  "services/api/src",
  "services/worker/src",
  "apps/web",
  "apps/mobile",
  "packages",
]);

/** Route source, hashed cheaply so a gate can prove the facts artifact is fresh. */
export const FRESHNESS_INPUT_ROOTS = Object.freeze([
  "services/api/src/routes",
  "services/api/scripts/capability-authority",
]);
