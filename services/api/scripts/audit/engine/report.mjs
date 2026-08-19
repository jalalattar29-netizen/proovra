/**
 * PHASE 0 §6 — THE ONE CURRENT REPORT.
 *
 * Why a GENERATED report, and only one
 * ---------------------------------------------------------------------------
 * Every count this programme has had to withdraw was withdrawn from a report.
 * Reports are where a number stops being a measurement and becomes a sentence:
 * somebody runs a tool, types the answer into prose, the tool's answer moves,
 * and the prose does not. `audit-output/history/` holds ten documents that were
 * each honest on the day they were written and are each wrong now, and the only
 * reason anyone can tell is that a later pass happened to re-run something.
 *
 * So this renderer has no place to type a number. It takes the facts artifact
 * and the ledger's derived totals and formats them. If a scalar is not in those
 * inputs it does not appear, and if an input changes the report changes with it
 * on the next `pnpm audit:architecture`.
 *
 * It states the three statuses separately and always, because collapsing them
 * is the failure this phase spent most of its effort undoing:
 *
 *   AuditEngineIntegrity — is the measuring instrument sound?
 *   ProductClosure       — is the product finished?
 *   ExternalClosure      — has anything been proven against a real environment?
 *
 * `AuditEngineIntegrity = PASS` with `ProductClosure = OPEN` is a correct and
 * expected state, not a contradiction to be smoothed over.
 */

import { CANONICAL, ENGINE_VERSION } from "./registry.mjs";

const pad = (s, n) => String(s).padEnd(n);

const table = (headers, rows) => {
  if (rows.length === 0) return "_(none)_\n";
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => `| ${cells.map((c, i) => pad(c, widths[i])).join(" | ")} |`;
  return [
    line(headers),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...rows.map((r) => line(r.map(String))),
  ].join("\n");
};

const counterTable = (obj) =>
  table(
    ["counter", "value"],
    Object.entries(obj).map(([k, v]) => [k, typeof v === "boolean" ? (v ? "true" : "false") : v]),
  );

/**
 * @param {object} facts   the architecture-facts artifact just built
 * @param {string[]} engineProblems  instrument problems, already derived
 * @param {string[]} closureProblems product problems, already derived
 */
export function renderReport(facts, engineProblems, closureProblems) {
  const f = facts.facts;
  const ledger = facts.findingsLedgerRef;
  const engineOk = engineProblems.length === 0;
  const closureOk = closureProblems.length === 0;

  const out = [];
  const w = (s = "") => out.push(s);

  w("STATUS: CURRENT GENERATED REPORT");
  w("SOURCE: canonical audit engine (`pnpm audit:architecture`)");
  w("DO NOT EDIT COUNTS MANUALLY");
  w();
  w("# Proovra — current architecture audit");
  w();
  w(
    "Every number below is produced by an analyzer executed at generation time and " +
      "read from `" +
      CANONICAL.currentFacts.path +
      "`. This file has no place to type a value into; regenerate it with `pnpm audit:architecture`.",
  );
  w();

  // --- the three statuses --------------------------------------------------
  w("## Status");
  w();
  w(
    table(
      ["dimension", "status", "basis"],
      [
        [
          "AuditEngineIntegrity",
          engineOk ? "PASS" : "FAIL",
          "instrument counters, conservation identities, single-authority checks",
        ],
        [
          "ProductClosure",
          closureOk ? "CLOSED" : "OPEN",
          "undisposed routes + locally actionable open findings",
        ],
        [
          "ExternalClosure",
          "NOT RUN",
          "requires a real environment; never asserted from source analysis",
        ],
      ],
    ),
  );
  w();
  w(
    "`AuditEngineIntegrity = PASS` alongside `ProductClosure = OPEN` is the expected " +
      "state while work remains. They are separate exit codes on purpose: a permanent " +
      "red meaning \"open work\" teaches everyone to ignore a red meaning \"every number " +
      "here is a guess\".",
  );
  w();

  // --- provenance ----------------------------------------------------------
  w("## Provenance");
  w();
  w(
    table(
      ["field", "value"],
      [
        ["engineVersion", facts.engineVersion ?? ENGINE_VERSION],
        ["engineHash", facts.engineHash],
        ["schemaVersion", facts.schemaVersion],
      ],
    ),
  );
  w();

  // --- measured surface ----------------------------------------------------
  w("## Measured surface");
  w();
  w(
    counterTable({
      registeredRoutes: f.routes.registered,
      developmentOnlyRoutes: f.routes.developmentOnly,
      productConsumerRoutes: f.consumers.productConsumerRoutes,
      machineOnlyConsumerRoutes: f.consumers.machineOnlyConsumerRoutes,
      noConsumerRoutes: f.consumers.noConsumerRoutes,
      dispositionedNonProductRoutes: f.capabilities.nonProductDispositioned,
      undisposedRoutes: f.capabilities.undisposed,
      authorizationUnresolved: f.authorization.unresolved,
      publicUnguardedRoutes: f.authorization.publicUnguarded,
    }),
  );
  w();

  // --- instrument integrity ------------------------------------------------
  w("## Instrument integrity");
  w();
  w("Each of these is a hole in the MEASURING DEVICE, not in the product. A non-zero value means some other number in this report is a guess.");
  w();
  w(counterTable(f.instrumentIntegrity));
  w();

  w("### Conservation");
  w();
  w(counterTable(facts.conservation));
  w();

  w("### Audit-system governance");
  w();
  w(counterTable(f.auditGovernance));
  w();

  // --- report roles, stated as an EQUATION -----------------------------------
  //
  // Printed as identities rather than as a list, because the mistake this
  // replaces was arithmetic: a previous write-up said "of the 14" and then
  // enumerated fifteen records, having added the generated current report to a
  // population it was never part of. An equation cannot be miscounted silently.
  const g = f.auditGovernance;
  if (g.ReportRelatedEntries !== undefined) {
    w("### Report roles");
    w();
    w("```");
    w(
      `ReportRelatedEntries ${g.ReportRelatedEntries} = ReportDocuments ${g.ReportDocuments}` +
        ` + HistoryTreeMarkers ${g.HistoryTreeMarkers}` +
        ` + NonAuditProductReportTemplates ${g.NonAuditProductReportTemplates}`,
    );
    w(
      `ReportDocuments ${g.ReportDocuments} = CurrentGeneratedReports ${g.CurrentGeneratedReports}` +
        ` + HistoricalReports ${g.HistoricalReports}` +
        ` + DomainReportTemplates ${g.DomainReportTemplates}` +
        ` + MisclassifiedReportDocuments ${g.MisclassifiedReportDocuments}`,
    );
    w("```");
    w();
    w(
      "A HISTORY_TREE_MARKER is a governance marker, not a report document: it says what a " +
        "directory IS. Counting it as a report is what produced the earlier miscount.",
    );
    w();
  }

  // --- what Phase 0 itself changed -------------------------------------------
  if (facts.phase0 !== undefined) {
    const p = facts.phase0 ?? {};
    w("### Phase-0 change set");
    w();
    w(
      counterTable({
        baseline: p.baselineKind ?? "GIT_COMMIT",
        derivedFromBaseline: p.derivedFromBaseline ?? false,
        selfGeneratedPathsDeclared: p.selfGeneratedPathsDeclared ?? 0,
        undeclaredSelfGeneratedExclusions: p.undeclaredSelfGeneratedExclusions ?? 0,
      }),
    );
    w();
    w(
      "The COUNTS are not recorded in the artifact. They describe the working tree the run " +
        "happened to execute against, so a document holding them could never agree with the " +
        "next run once the change was committed. The run prints them, and every Phase-0 " +
        "assertion is raised from the live evaluation rather than from this document.",
    );
    w();
    w(
      "Derived by diffing the working tree against the HEAD commit, so the set is complete — " +
        "a path cannot be omitted the way it could from the hand-maintained prefix list this " +
        "replaced. Attribution within the set is content-derived; no artifact records the tree " +
        "at the instant Phase 0 began, so a change cannot be differentially attributed to " +
        "Phase 0 versus pre-existing work. The three safety counters do not rely on that: they " +
        "hold because no runtime file carries a Phase-0 signal, no test was deleted anywhere, " +
        "and no migration changed at all.",
    );
    w();
  }

  // --- findings ------------------------------------------------------------
  w("## Findings ledger");
  w();
  if (!ledger.valid) {
    w("**THE LEDGER WAS REFUSED BY ITS OWN VALIDATOR.**");
    w();
    for (const p of ledger.problems ?? []) w(`- ${p}`);
  } else {
    w(
      counterTable({
        rows: ledger.rowCount,
        actionableTotal: ledger.actionable.total,
        actionableClosed: ledger.actionable.closed,
        actionableOpen: ledger.actionable.open,
        verifiedClosures: ledger.verifiedClosures.total,
        unknownBlocked: ledger.unknownBlocked.total,
      }),
    );
    w();
    w(`Conservation: ${ledger.conservationEquation}`);
    w();
    w("### Open");
    w();
    w(
      table(
        ["id"],
        (ledger.openIds ?? []).map((id) => [id]),
      ),
    );
    w();
    w("### Blocked on the owner");
    w();
    w(
      table(
        ["id"],
        (ledger.unknownBlocked.ids ?? []).map((id) => [id]),
      ),
    );
  }
  w();

  // --- domain proofs -------------------------------------------------------
  w("## Domain authorities");
  w();
  w("Referenced, never transcribed. Each is measured by its own producer; this report carries the binding and the hash so a stale proof cannot be credited.");
  w();
  w(
    table(
      ["domain", "artifact", "binding", "freshness"],
      facts.domainProofs.map((p) => [p.domain, p.path, p.binding, p.freshness]),
    ),
  );
  w();

  // --- what is blocking ----------------------------------------------------
  w("## Blockers");
  w();
  w("### Engine");
  w();
  if (engineOk) w("_(none — the instrument is sound)_");
  else for (const p of engineProblems) w(`- ${p}`);
  w();
  w("### Product closure");
  w();
  if (closureOk) w("_(none)_");
  else for (const p of closureProblems) w(`- ${p}`);

  // No trailing blank write: `join("\n")` plus the newline below already ends
  // the document with exactly one LF. Emitting a final empty line as well
  // produced a blank line at EOF, which `git diff --check` reports as a
  // whitespace error on every regeneration.
  return `${out.join("\n")}\n`;
}
