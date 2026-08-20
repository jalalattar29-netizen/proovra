/**
 * PHASE 13 — the continuation checkpoint's truth evaluator.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * A resume note is the one document a later pass reads FIRST and trusts MOST,
 * and it is also the document most likely to rot: every pass appends its own
 * "current state" block, nobody deletes the previous one, and within two passes
 * the file carries two generations of the same counter with no way to tell
 * which is live. That is worse than having no checkpoint at all — a stale
 * scalar that looks authoritative gets acted on.
 *
 * So the checkpoint is held to three properties:
 *
 *   1. EXACTLY ONE active-state section. Historical narrative belongs in the
 *      canonical reports; a second `## CURRENT STATE` heading is a defect.
 *   2. Every release scalar it prints must EQUAL the value derived from the
 *      generated facts. The checkpoint may CITE; it may not RESTATE.
 *   3. No scalar name may appear twice in the file with two different values,
 *      anywhere — including inside prose and inside historical sections.
 *
 * WHY IT LIVES IN THE ENGINE AND NOT IN THE TEST
 * ---------------------------------------------------------------------------
 * Both the canonical closure evaluator and the adversarial gate need this
 * answer. Implementing it twice would be the second authority this whole audit
 * system exists to forbid — the engine would say the checkpoint is honest while
 * the test said it was not, and each would be reading its own rules. It is
 * plain `.mjs` for the same reason every other engine module is: it runs under
 * bare Node during generation, with no build step between an edit and a
 * regenerated artifact. The suite imports it through the ambient declarations
 * in `services/api/test/capability-authority-modules.d.ts`.
 *
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * It is NOT a second facts authority. It reads `architecture-facts.json` — the
 * same artifact the engine writes and the report renders — and compares. It
 * derives nothing of its own and has no place to type a value into. The only
 * thing that can fail here is the PROSE having drifted from the measurement.
 *
 * The evaluator is a pure function over (markdown, facts) precisely so the gate
 * can hand it corrupted inputs and prove it refuses. A check implemented inline
 * in its own `it()` cannot be shown to fail without breaking the repository.
 */

/**
 * The heading that opens the ONE active-state section.
 *
 * Matched on the `## CURRENT STATE` prefix rather than the whole line, so the
 * section may carry a qualifier ("— closed, regression-only") without the gate
 * needing to know today's qualifier.
 */
const ACTIVE_STATE_HEADING = /^##\s+CURRENT STATE\b/;
const NEXT_COMMANDS_HEADING = /^##\s+NEXT COMMANDS\b/;
const ANY_H2 = /^##\s+/;

/**
 * How each scalar the checkpoint is allowed to print is DERIVED.
 *
 * A name absent from this table is REJECTED rather than ignored: a checkpoint
 * that prints a counter nothing can derive is exactly the hand-maintained
 * number this evaluator exists to forbid. Adding a scalar to the checkpoint
 * therefore requires adding its derivation here, which is the point.
 */
export function derivedScalars(doc) {
  const f = doc.facts;
  const bucket = f.mutations.byWriterBucket;
  return {
    // ------------------------------------------------------------ routes ---
    ProductionRegisteredRoutes: f.routes.productionRegistered,
    RegisteredRoutes: f.routes.registered,

    // ----------------------------------------------- instrument integrity ---
    TenantBindingUnresolved: f.instrumentIntegrity.TenantBindingUnresolved,
    TenantUnboundInsertRoutes: f.instrumentIntegrity.TenantUnboundInsertRoutes,
    OrganizationAuthorizationUnresolved:
      f.instrumentIntegrity.OrganizationAuthorizationUnresolved,
    OrganizationRoutesMissingRequiredAuthorization:
      f.instrumentIntegrity.OrganizationRoutesMissingRequiredAuthorization,
    ClassificationConflicts: f.instrumentIntegrity.ClassificationConflicts,
    AuthorizationUnresolved: f.instrumentIntegrity.AuthorizationUnresolved,
    UnclassifiedMutationWriters: f.instrumentIntegrity.UnclassifiedMutationWriters,
    MutationReachabilityUnresolved: f.instrumentIntegrity.MutationReachabilityUnresolved,

    // -------------------------------------------------------- capability ---
    ProductConsumedRoutes: f.capabilities.productConsumed,
    NonProductDispositionedRoutes: f.capabilities.nonProductDispositioned,
    UndisposedRoutes: f.capabilities.undisposed,
    MissingProductUiReleaseRequired: f.capabilities.missingProductUiReleaseRequired,
    ConservationIdentityHolds: f.capabilities.mandateConservationHolds,

    // --------------------------------------------------------- mutations ---
    TerminalWriters: f.mutations.terminalWriters,
    ROUTE_ATTRIBUTED_REACHABLE: bucket.ROUTE_ATTRIBUTED_REACHABLE,
    JOB_ATTRIBUTED_REACHABLE: bucket.JOB_ATTRIBUTED_REACHABLE,
    MODULE_SCOPED_REACHABLE: bucket.MODULE_SCOPED_REACHABLE,
    REGISTERED_CLI: bucket.REGISTERED_CLI,
    STARTUP_OR_SCHEDULED: bucket.STARTUP_OR_SCHEDULED,
    MIGRATION_ONLY: bucket.MIGRATION_ONLY,
    TEST_OR_BUILD_ONLY: bucket.TEST_OR_BUILD_ONLY,
    PRESERVED_PLANNED_WRITER: bucket.PRESERVED_PLANNED_WRITER ?? 0,
    DEAD_UNREACHABLE: bucket.DEAD_UNREACHABLE,
    UNRESOLVED: bucket.UNRESOLVED,
    ModuleScopedAttributionWriters: f.mutations.moduleScopedAttribution,
    DeadUnreachableWritersPending: f.mutations.deadUnreachable,
    AuthorizationAfterMutation: f.mutations.authorizationAfterMutation,
    TenantUnboundMutations: f.mutations.tenantUnbound,
    LegacyWriters: f.mutations.legacyWriters,
    ParallelMutationAuthorities: f.mutations.parallelAuthorities,
    OrphanQueueProducers: f.mutations.orphanQueueProducers,
    UnprocessedQueueFamilies: f.mutations.unprocessedQueueFamilies,
    MutationWriterConservationHolds: f.mutations.writerConservationHolds,
    MutationClosurePass: f.mutations.closurePass,
    /**
     * The scalar this pass turns on.
     *
     * An executable terminal writer with ZERO entrypoints is release-blocking
     * whatever bucket it is filed under, so it is derived from the buckets
     * rather than asserted separately — there is no way to move the number
     * without moving the writers.
     */
    UnwiredExecutableWriters:
      (bucket.PRESERVED_PLANNED_WRITER ?? 0) + (bucket.DEAD_UNREACHABLE ?? 0),

    // ------------------------------------------------------- conservation ---
    LedgerRowsConserve: doc.conservation.ledgerRowsConserve,
    LedgerActionableConserves: doc.conservation.ledgerActionableConserves,
    ClassificationCountsSumToRoutes: doc.conservation.classificationCountsSumToRoutes,
    CapabilityProjectionMatchesRouteCount:
      doc.conservation.capabilityProjectionMatchesRouteCount,

    // ------------------------------------------------------------ closure ---
    /**
     * Defensive on purpose, as well as structurally supplied.
     *
     * `ledgerFacts()` now always returns an `actionable` object, refused or
     * not. This read stays optional anyway: a facts document handed in by the
     * ADVERSARIAL gate is deliberately corrupted, and the evaluator's whole
     * value is that it refuses such input rather than crashing on it. A
     * TypeError here would be indistinguishable from the engine being broken.
     */
    OpenActionableFindings: doc.findingsLedgerRef?.actionable?.open ?? "REFUSED",
    StaleDomainProofs: f.proofFreshness.stale,
    /**
     * The release verdict, DERIVED rather than declared.
     *
     * `--closure-check` reports this same verdict from the same two inputs.
     * Restating it here as a literal would create a value that can be edited to
     * say PASS; deriving it means the only way to PRINT pass is for both inputs
     * to be zero.
     */
    ReleaseBlockingClosure:
      doc.findingsLedgerRef?.actionable?.open === 0 && f.capabilities.undisposed === 0
        ? "PASS"
        : "OPEN",

    // ------------------------------------------------- browser / runtime ---
    // Present only once the Point-7 facts block exists; a checkpoint that
    // prints them before the run has happened is refused by the comparison,
    // which is the correct answer.
    ...(f.point7
      ? {
          Point7Fresh: f.point7.fresh,
          BrowserVerifiedUiCapabilities: f.point7.browserVerifiedUiCapabilities,
          ImplementedUiCapabilities: f.point7.implementedUiCapabilities,
          BrowserProvenScenarios: f.point7.browserProvenScenarios,
          "NEW-027Runtime": f.point7.new027Runtime,
          "NEW-028Runtime": f.point7.new028Runtime,
          "NEW-029Runtime": f.point7.new029Runtime,
          "NEW-058Runtime": f.point7.new058Runtime,
        }
      : {}),
  };
}

/** `Name        value` inside a fenced block. Two or more spaces separate them. */
const SCALAR_LINE = /^([A-Za-z][A-Za-z0-9_/-]*)\s{2,}(\S.*?)\s*$/;

function parseScalarLines(block) {
  const out = [];
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = SCALAR_LINE.exec(line);
    if (!m) continue;
    out.push([m[1], m[2]]);
  }
  return out;
}

/** Fenced code blocks in a slice of markdown, contents only. */
function fencedBlocks(markdown) {
  const blocks = [];
  let open = false;
  let current = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (/^```/.test(line.trim())) {
      if (open) {
        blocks.push(current.join("\n"));
        current = [];
      }
      open = !open;
      continue;
    }
    if (open) current.push(line);
  }
  return blocks;
}

/** The markdown between a heading and the next `## ` heading. */
function sectionsMatching(markdown, heading) {
  const found = [];
  let collecting = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (heading.test(line)) {
      if (collecting) found.push(collecting.join("\n"));
      collecting = [];
      continue;
    }
    if (collecting && ANY_H2.test(line)) {
      found.push(collecting.join("\n"));
      collecting = null;
      continue;
    }
    if (collecting) collecting.push(line);
  }
  if (collecting) found.push(collecting.join("\n"));
  return found;
}

function normaliseExpected(v) {
  return typeof v === "boolean" ? (v ? "true" : "false") : String(v);
}

/**
 * Evaluate a checkpoint against the generated facts.
 *
 * `commandTargetExists` is injected rather than read here so the negative
 * battery can drive the stale-command branch without creating files on disk.
 */
export function evaluateCheckpoint(input) {
  const violations = [];
  const expected = derivedScalars(input.facts);

  // ------------------------------------------------------ one active state ---
  const active = sectionsMatching(input.markdown, ACTIVE_STATE_HEADING);
  const duplicateActiveStateSections = Math.max(0, active.length - 1);
  if (active.length === 0) {
    violations.push({
      kind: "NO_ACTIVE_STATE_SECTION",
      detail:
        "the checkpoint has no `## CURRENT STATE` section; a resume note with " +
        "no current state is not a resume note",
    });
  }
  for (let i = 1; i < active.length; i += 1) {
    violations.push({
      kind: "DUPLICATE_ACTIVE_STATE_SECTION",
      detail: `active-state section #${i + 1} — a checkpoint may carry exactly one`,
    });
  }

  // ---------------------------------- every printed scalar must be derived ---
  let scalarsChecked = 0;
  for (const section of active) {
    for (const block of fencedBlocks(section)) {
      for (const [name, printed] of parseScalarLines(block)) {
        if (!(name in expected)) {
          violations.push({
            kind: "UNKNOWN_SCALAR",
            detail:
              `\`${name}\` is printed in the active-state section but no ` +
              "derivation exists for it in derivedScalars(); a checkpoint may " +
              "cite the generated facts, never restate a hand-maintained value",
          });
          continue;
        }
        scalarsChecked += 1;
        const want = normaliseExpected(expected[name]);
        if (printed !== want) {
          violations.push({
            kind: "SCALAR_DISAGREES_WITH_FACTS",
            detail: `${name}: checkpoint says ${printed}, facts say ${want}`,
          });
        }
      }
    }
  }

  // --------------------------- no scalar name carries two values, anywhere ---
  const seen = new Map();
  for (const block of fencedBlocks(input.markdown)) {
    for (const [name, printed] of parseScalarLines(block)) {
      if (!(name in expected)) continue;
      const set = seen.get(name) ?? new Set();
      set.add(printed);
      seen.set(name, set);
    }
  }
  let checkpointContradictions = 0;
  for (const [name, values] of seen) {
    if (values.size > 1) {
      checkpointContradictions += 1;
      violations.push({
        kind: "CONTRADICTORY_SCALAR",
        detail: `${name} appears with ${values.size} different values: ${[...values].join(" / ")}`,
      });
    }
  }

  // ---------------------------------------------------- next commands live ---
  let staleNextCommands = 0;
  for (const section of sectionsMatching(input.markdown, NEXT_COMMANDS_HEADING)) {
    for (const block of fencedBlocks(section)) {
      for (const raw of block.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        // Every path-shaped token in the command must exist. A command naming a
        // script the tree no longer has is the classic stale instruction: it
        // looks runnable and fails on the next pass's first action.
        for (const token of line.split(/\s+/)) {
          if (!/[/\\]/.test(token)) continue;
          if (token.startsWith("-")) continue;
          if (/^[a-z]+:\/\//.test(token)) continue;
          if (!input.commandTargetExists(token)) {
            staleNextCommands += 1;
            violations.push({
              kind: "STALE_NEXT_COMMAND",
              detail: `NEXT COMMANDS names \`${token}\`, which does not exist`,
            });
          }
        }
      }
    }
  }

  return {
    pass: violations.length === 0,
    duplicateActiveStateSections,
    checkpointContradictions,
    staleNextCommands,
    scalarsChecked,
    violations,
  };
}
