/**
 * PHASE 0 §10/§15 — THE AUDIT ENGINE'S OWN GATE.
 *
 * The five invariants Phase 0 exists to establish, each asserted once and in
 * one place. They were previously spread across suites that also asserted
 * product behaviour, so a governance regression and a product regression looked
 * identical in CI output, and neither could be read without opening the file.
 *
 *   1. schema + freshness — the generated current artifacts exist, declare
 *      their schema, and match what the engine recomputes right now
 *   2. conservation — every scalar partitions the records it summarises
 *   3. single authority — one route, consumer, capability and findings
 *      authority; no artifact with two producers; no generator reading its
 *      own output as a fact
 *   4. historical inputs are refused — nothing under audit-output/history/ is
 *      readable by a current tool
 *   5. exit-code semantics — engine integrity and product closure are
 *      separate, and the second may be red while the first is green
 *
 * Case 5 SPAWNS the real orchestrator rather than calling its exported
 * functions. An exit code is the contract every caller actually consumes, and
 * a function that returns 1 proves nothing about what the process does with it.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// The governance evaluation walks the tree and shells out to git. It is
// legitimately slower than a unit test, and under a loaded full-suite run it
// exceeded vitest's 5s default — a flake in the gate that must be the reliable
// one. The cost is bounded and known, so the budget is stated explicitly.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const REPO = path.resolve(__dirname, "../../..");
const ORCHESTRATOR = path.join(REPO, "services/api/scripts/audit/index.mjs");

const readJson = (rel: string) =>
  JSON.parse(readFileSync(path.join(REPO, rel), "utf8").replace(/\r\n/g, "\n"));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { evaluateGovernance } = require("../scripts/audit/engine/governance.mjs") as {
  evaluateGovernance: () => {
    schemaVersion: string;
    counters: Record<string, number>;
    problems: string[];
    records: Array<{ path: string; role: string; readsArtifacts: string[]; imports: string[] }>;
    phase0ChangeSet: unknown;
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { freshnessHash } = require("../scripts/audit/engine/facts.mjs") as {
  freshnessHash: () => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const registry = require("../scripts/audit/engine/registry.mjs") as {
  // Deliberately loose. A hand-written shape here would be a SECOND
  // description of the registry that could drift from the registry itself —
  // the exact defect this phase removed everywhere else.
  CANONICAL: Record<string, Record<string, string>>;
  DOMAIN_AUTHORITIES: ReadonlyArray<{ domain: string; artifact: string; producer: string }>;
  DIAGNOSTICS: ReadonlyArray<{ path: string }>;
  HISTORICAL_PREFIXES: ReadonlyArray<string>;
  ENGINE_GENERATED_PATHS: ReadonlyArray<string>;
  isHistorical: (rel: string) => boolean;
  FACTS_SCHEMA_VERSION: string;
  INVENTORY_SCHEMA_VERSION: string;
};

let cached: ReturnType<typeof evaluateGovernance> | null = null;
const governance = () => (cached ??= evaluateGovernance());

describe("Phase 0 §1 — the current artifacts exist, declare a schema, and are fresh", () => {
  it("every canonical artifact is on disk", () => {
    // The recovery manifest is deliberately NOT here: it describes a local
    // checkout rather than the release, and `--freeze` writes it outside the
    // repository. Requiring it on disk would be requiring it back inside.
    const required = [
      registry.CANONICAL.currentFacts.path,
      registry.CANONICAL.governanceInventory.path,
      registry.CANONICAL.capabilityMap.path,
      registry.CANONICAL.findingsLedger.rows,
      registry.CANONICAL.currentReport.path,
      ...registry.DIAGNOSTICS.map((d) => d.path),
    ];
    const missing = required.filter((p: string) => !existsSync(path.join(REPO, p)));
    expect(missing, `missing canonical artifacts:\n${missing.join("\n")}`).toEqual([]);
  });

  it("the facts artifact declares its schema and engine binding", () => {
    const f = readJson(registry.CANONICAL.currentFacts.path);
    expect(f.schemaVersion).toBe(registry.FACTS_SCHEMA_VERSION);
    expect(typeof f.engineVersion).toBe("string");
    expect(typeof f.engineHash).toBe("string");
    expect(f.inputs?.freshnessHash).toBe(f.engineHash);
    expect(Array.isArray(f.inputs?.engineComponents)).toBe(true);
  });

  it("the facts artifact is CURRENT — a source edit since generation fails here", () => {
    const f = readJson(registry.CANONICAL.currentFacts.path);
    expect(
      freshnessHash(),
      "architecture-facts.json was generated against different sources — run `pnpm audit:architecture`",
    ).toBe(f.inputs.freshnessHash);
  });

  it("the capability map and the facts describe the same route inventory", () => {
    const f = readJson(registry.CANONICAL.currentFacts.path);
    const map = readJson(registry.CANONICAL.capabilityMap.path);
    expect(map.routeInventoryHash).toBe(f.facts.routes.routeInventoryHash);
    expect(map.routes.length).toBe(f.facts.routes.registered);
  });

  it("every domain proof carries a binding, and none stale is credited", () => {
    const f = readJson(registry.CANONICAL.currentFacts.path);
    expect(f.domainProofs.length).toBe(registry.DOMAIN_AUTHORITIES.length);
    for (const p of f.domainProofs) {
      expect(p.present, `domain proof missing: ${p.domain} (${p.path})`).toBe(true);
      expect(typeof p.contentHash).toBe("string");
    }
    expect(f.facts.proofFreshness.staleDomains).toEqual([]);
  });
});

describe("Phase 0 §2 — conservation", () => {
  it("every conservation identity in the facts artifact holds", () => {
    const f = readJson(registry.CANONICAL.currentFacts.path);
    const violated = Object.entries(f.conservation)
      .filter(([, ok]) => ok !== true)
      .map(([k]) => k);
    expect(violated, `conservation violated:\n${violated.join("\n")}`).toEqual([]);
  });

  it("the ledger's derived totals partition its rows", () => {
    const l = readJson(registry.CANONICAL.currentFacts.path).findingsLedgerRef;
    expect(l.valid).toBe(true);
    expect(l.actionable.closed + l.actionable.open).toBe(l.actionable.total);
    // PHASE 1 §3 — FIVE buckets. `trackedInventory` appeared when FINAL-001's
    // governance DEFECT was separated from the route INVENTORY it had been
    // carrying in the same row, so a four-bucket identity now under-counts by
    // exactly the inventory and reads as a conservation failure.
    expect(
      l.actionable.total +
        l.verifiedClosures.total +
        l.unknownBlocked.total +
        (l.trackedInventory?.total ?? 0),
    ).toBe(l.rowCount);
    // Inventory is counted, and counted as NOTHING: not closed, not open.
    expect(l.trackedInventory?.releaseBlocking ?? false).toBe(false);
  });
});

describe("Phase 0 §3 — one authority per subject", () => {
  it("exactly one route, consumer, capability and findings authority", () => {
    const c = governance().counters;
    expect({
      CanonicalAuditEntryPoints: c.CanonicalAuditEntryPoints,
      CanonicalRouteAuthorities: c.CanonicalRouteAuthorities,
      CanonicalConsumerAuthorities: c.CanonicalConsumerAuthorities,
      CanonicalCapabilityMaps: c.CanonicalCapabilityMaps,
      // Renamed from `CanonicalFindingsLedgers` in the corrective pass: the
      // four files in the ledger directory have four roles, and counting them
      // as "ledgers" was the ambiguity. This counts SOURCES.
      CanonicalLedgerSources: c.CanonicalLedgerSources,
    }).toEqual({
      CanonicalAuditEntryPoints: 1,
      CanonicalRouteAuthorities: 1,
      CanonicalConsumerAuthorities: 1,
      CanonicalCapabilityMaps: 1,
      CanonicalLedgerSources: 1,
    });
  });

  it("no second route or consumer inventory has grown back", () => {
    const c = governance().counters;
    // This is the counter that would rise the moment somebody writes
    // `for (const f of readdirSync(routesDir)) … matchAll(/app\.(get|post…/)`
    // in a new suite — which is how the system arrived at five of them.
    expect({
      IndependentRouteInventories: c.IndependentRouteInventories,
      IndependentConsumerInventories: c.IndependentConsumerInventories,
    }).toEqual({ IndependentRouteInventories: 0, IndependentConsumerInventories: 0 });
  });

  it("exactly one CURRENT REPORT, one LEDGER SOURCE, and the renderings are not ledgers", () => {
    const c = governance().counters;
    // The four files in the ledger directory were all called
    // CANONICAL_FINDINGS_LEDGER, which reads as four ledgers. One is the
    // source; one validates it; two are renderings of it.
    expect({
      CanonicalCurrentReports: c.CanonicalCurrentReports,
      CanonicalLedgerSources: c.CanonicalLedgerSources,
      LedgerGenerators: c.LedgerGenerators,
      GeneratedLedgerRenderings: c.GeneratedLedgerRenderings,
    }).toEqual({
      CanonicalCurrentReports: 1,
      CanonicalLedgerSources: 1,
      LedgerGenerators: 1,
      GeneratedLedgerRenderings: 2,
    });
  });

  it("no file is left in the old CURRENT_REPORT_TEMPLATE catch-all", () => {
    // Thirteen finished narratives once advertised themselves as current
    // reports because the classifier had a Markdown catch-all. The role no
    // longer exists; a new document must be dispositioned explicitly.
    const stragglers = governance()
      .records.filter((r) => r.role === "CURRENT_REPORT_TEMPLATE")
      .map((r) => r.path);
    expect(stragglers, `still in the retired catch-all:\n${stragglers.join("\n")}`).toEqual([]);
  });

  it("a diagnostic is never read as an authority and never claims one", () => {
    const c = governance().counters;
    expect(c.DiagnosticsReadAsAuthority).toBe(0);
  });

  it("recovery metadata does not live inside the repository", () => {
    const c = governance().counters;
    expect(
      c.RecoveryManifestInsideRepository,
      "the working-tree freeze describes a local checkout, not the release — it belongs outside the repo",
    ).toBe(0);
  });

  it("no artifact has two producers, and no generator reads its own output as a fact", () => {
    const c = governance().counters;
    expect({
      ArtifactsWithMultipleProducers: c.ArtifactsWithMultipleProducers,
      GeneratorsReadingOwnOutputsAsFacts: c.GeneratorsReadingOwnOutputsAsFacts,
      DuplicateAuditAuthorityClaims: c.DuplicateAuditAuthorityClaims,
      AuditDependencyCycles: c.AuditDependencyCycles,
    }).toEqual({
      ArtifactsWithMultipleProducers: 0,
      GeneratorsReadingOwnOutputsAsFacts: 0,
      DuplicateAuditAuthorityClaims: 0,
      AuditDependencyCycles: 0,
    });
  });

  it("every inventoried audit file carries exactly one role", () => {
    const c = governance().counters;
    expect(c.AuditFilesUnclassified).toBe(0);
    expect(c.AuditArtifactProducersUnknown).toBe(0);
    expect(c.AuditFilesInventoried).toBeGreaterThan(100);
  });

  it("the governance evaluation reports no problem at all", () => {
    const p = governance().problems;
    expect(p, `audit governance problems:\n${p.join("\n")}`).toEqual([]);
  });
});

describe("Phase 0 §4 — historical records are not current inputs", () => {
  it("no current tool reads anything under the history tree", () => {
    const offenders = governance()
      .records.filter((r) => !registry.isHistorical(r.path))
      .flatMap((r) =>
        [...r.readsArtifacts, ...r.imports]
          .filter((p) => registry.isHistorical(String(p)))
          .map((p) => `${r.path} -> ${p}`),
      );
    expect(offenders, `current tools reading historical records:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  it("no completed-pass report is sitting outside the history tree", () => {
    const c = governance().counters;
    expect(c.HistoricalReportsAmbiguousStatus).toBe(0);
    expect(c.HistoricalReportsUsedAsAuthority).toBe(0);
  });

  it("the history tree says so in a file a human reads first", () => {
    const readme = path.join(REPO, "audit-output/history/README.md");
    expect(existsSync(readme)).toBe(true);
    const text = readFileSync(readme, "utf8");
    expect(text).toMatch(/STATUS:\s*HISTORICAL/);
    expect(text).toMatch(/NOT A CURRENT AUTHORITY/);
  });
});

describe("Phase 0 §7 — report roles are disjoint and CONSERVE", () => {
  /**
   * The arithmetic that failed.
   *
   * The previous pass wrote "of the 14" and then listed fifteen records. The
   * fourteen were the paths that had carried the retired
   * CURRENT_REPORT_TEMPLATE role; the fifteenth was the generated current
   * report, which did not exist when those fourteen were enumerated. Two
   * populations were summed as though they were one.
   *
   * The populations are now required to sum, so the same slip fails here.
   */
  const counts = () => governance().counters;

  it("ReportRelatedEntries = ReportDocuments + HistoryTreeMarkers + NonAuditProductReportTemplates", () => {
    const c = counts();
    expect(c.ReportRelatedEntries).toBe(
      c.ReportDocuments + c.HistoryTreeMarkers + c.NonAuditProductReportTemplates,
    );
  });

  it("ReportDocuments = Current + Historical + DomainTemplates + Misclassified", () => {
    const c = counts();
    expect(c.ReportDocuments).toBe(
      c.CurrentGeneratedReports +
        c.HistoricalReports +
        c.DomainReportTemplates +
        c.MisclassifiedReportDocuments,
    );
  });

  it("exactly one current report, and nothing misclassified or ambiguous", () => {
    const c = counts();
    expect({
      CanonicalCurrentReports: c.CanonicalCurrentReports,
      MisclassifiedReportDocuments: c.MisclassifiedReportDocuments,
      ReportRoleOverlap: c.ReportRoleOverlap,
      ReportRoleMissing: c.ReportRoleMissing,
      ReportRoleConservationFailures: c.ReportRoleConservationFailures,
      AmbiguousReportRoles: c.AmbiguousReportRoles,
    }).toEqual({
      CanonicalCurrentReports: 1,
      MisclassifiedReportDocuments: 0,
      ReportRoleOverlap: 0,
      ReportRoleMissing: 0,
      ReportRoleConservationFailures: 0,
      AmbiguousReportRoles: 0,
    });
  });

  it("a HISTORY_TREE_MARKER is NOT counted as a report document", () => {
    const c = counts();
    // The specific mistake, pinned. The marker says what a directory IS; it is
    // not a report, and counting it as one is how the fifteenth record appeared.
    expect(c.HistoryTreeMarkers).toBeGreaterThan(0);
    expect(c.ReportDocuments).toBe(c.ReportRelatedEntries - c.HistoryTreeMarkers - c.NonAuditProductReportTemplates);
  });

  // ── adversarial: the identities must actually refuse ─────────────────────
  const REPORT_KIND: Record<string, string> = {
    CURRENT_GENERATED_REPORT: "REPORT_DOCUMENT",
    HISTORICAL_REPORT: "REPORT_DOCUMENT",
    DOMAIN_REPORT_TEMPLATE: "REPORT_DOCUMENT",
    MISCLASSIFIED_REPORT_DOCUMENT: "REPORT_DOCUMENT",
    HISTORY_TREE_MARKER: "GOVERNANCE_MARKER",
    NON_AUDIT_PRODUCT_REPORT_TEMPLATE: "PRODUCT_ARTEFACT",
  };
  type Rec = { path: string; role: string };
  const tally = (rows: Rec[]) => {
    const rel = rows.filter((r) => REPORT_KIND[r.role] !== undefined);
    const kind = (k: string) => rel.filter((r) => REPORT_KIND[r.role] === k).length;
    const role = (x: string) => rel.filter((r) => r.role === x).length;
    return {
      related: rel.length,
      documents: kind("REPORT_DOCUMENT"),
      markers: kind("GOVERNANCE_MARKER"),
      product: kind("PRODUCT_ARTEFACT"),
      byRole: {
        current: role("CURRENT_GENERATED_REPORT"),
        historical: role("HISTORICAL_REPORT"),
        domain: role("DOMAIN_REPORT_TEMPLATE"),
        misclassified: role("MISCLASSIFIED_REPORT_DOCUMENT"),
      },
      duplicates: rel.length - new Set(rel.map((r) => r.path)).size,
    };
  };
  const conserves = (t: ReturnType<typeof tally>) =>
    t.related === t.documents + t.markers + t.product &&
    t.documents ===
      t.byRole.current + t.byRole.historical + t.byRole.domain + t.byRole.misclassified &&
    t.duplicates === 0;

  const realRows = (): Rec[] =>
    governance()
      .records.filter((r) => REPORT_KIND[r.role] !== undefined)
      .map((r) => ({ path: r.path, role: r.role }));

  it("adversarial — a report-related path with NO role is not counted, and is detectable", () => {
    const rows = realRows();
    const orphan = { path: "docs/architecture/some-new-report.md", role: "" };
    // An unroled path never enters the report population, so the identities
    // still balance — which is exactly why "conservation holds" is not
    // sufficient on its own and `AuditFilesUnclassified` exists beside it.
    expect(conserves(tally([...rows, orphan as Rec]))).toBe(true);
    expect(governance().counters.AuditFilesUnclassified).toBe(0);
  });

  it("adversarial — one path carrying TWO report roles breaks conservation", () => {
    const rows = realRows();
    const dup = rows.find((r) => r.role === "HISTORICAL_REPORT")!;
    const t = tally([...rows, { path: dup.path, role: "DOMAIN_REPORT_TEMPLATE" }]);
    expect(t.duplicates).toBeGreaterThan(0);
    expect(conserves(t), "a path with two report roles was accepted").toBe(false);
  });

  it("adversarial — counting a HISTORY_TREE_MARKER as a report document breaks conservation", () => {
    const rows = realRows().map((r) =>
      r.role === "HISTORY_TREE_MARKER" ? { ...r, role: "CURRENT_GENERATED_REPORT" } : r,
    );
    const t = tally(rows);
    // It still sums — but it now claims TWO current generated reports, which
    // the single-authority counter refuses.
    expect(t.byRole.current).toBe(2);
    expect(t.markers).toBe(0);
    expect(
      t.byRole.current,
      "promoting the marker to a report must not be able to pass as one canonical report",
    ).not.toBe(1);
  });
});

describe("Phase 0 §8 — the Phase-0 change set is derived from a baseline, not a list", () => {
  const changeSet = () =>
    governance().phase0ChangeSet as {
      baseline: string | null;
      baselineKind: string;
      entries: Array<{
        path: string;
        status: string;
        class: string | null;
        attributedToPhase0: boolean;
      }>;
    };

  it("the baseline is a real commit, not a reconstruction of the current tree", () => {
    const cs = changeSet();
    expect(cs.baselineKind).toBe("GIT_COMMIT");
    expect(cs.baseline).toMatch(/^[0-9a-f]{40}$/);
  });

  it("the change set CONSERVES git — entries + the declared hold-out = git", () => {
    const cs = changeSet();
    const fromGit = spawnSync("git", ["status", "--porcelain"], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    expect(fromGit.error).toBeUndefined();
    const gitPaths = fromGit.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        let p = l.slice(3).trim();
        if (p.includes(" -> ")) p = p.split(" -> ")[1];
        if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
        return p;
      });

    // A prefix list could omit a path silently. This still cannot: git supplies
    // the population. What changed is that the engine must hold its OWN five
    // outputs out of the measurement — it writes them into the tree it is
    // measuring, so counting them made the result a function of write order and
    // the freshness gate failed on every run, at every commit, forever.
    //
    // The law is therefore CONSERVATION rather than equality:
    //
    //     entries + dirty-declared-outputs = git
    //
    // with the second term pinned to the registry's declaration, so the hold-out
    // cannot quietly widen to cover an inconvenient file.
    const declared = new Set<string>(registry.ENGINE_GENERATED_PATHS);
    const heldOut = gitPaths.filter((x) => declared.has(x));
    const expected = gitPaths.filter((x) => !declared.has(x));

    expect(cs.entries.length + heldOut.length).toBe(gitPaths.length);
    expect(cs.entries.map((e) => e.path).sort()).toEqual(expected.sort());
    for (const x of expected) {
      expect(
        cs.entries.some((e) => e.path === x),
        `${x} must be measured`,
      ).toBe(true);
    }
  });

  it("every changed path is classified", () => {
    const unclassified = changeSet()
      .entries.filter((e) => e.class === null)
      .map((e) => e.path);
    expect(unclassified, `changed paths with no class:\n${unclassified.join("\n")}`).toEqual([]);
    expect(governance().counters.Phase0ChangedPathClassificationMissing).toBe(0);
  });

  it("no production runtime file carries a Phase-0 signal", () => {
    const cs = changeSet();
    const offenders = cs.entries
      .filter((e) => e.class === "PRODUCTION_RUNTIME" && e.attributedToPhase0)
      .map((e) => e.path);
    // Stronger than differential attribution, and it has to be: no artifact
    // records the working tree at the instant Phase 0 began, so "this change
    // was the user's" cannot be proven. What CAN be proven is that no runtime
    // file bears any trace of Phase 0 — which holds whoever authored the rest.
    expect(offenders, `production runtime files touched by Phase 0:\n${offenders.join("\n")}`).toEqual([]);
    expect(governance().counters.ProductionRuntimeFilesModifiedByPhase0).toBe(0);
  });

  it("no product behaviour test was deleted, by anyone", () => {
    const deleted = changeSet()
      .entries.filter((e) => e.class === "PRODUCT_BEHAVIOR_TEST" && e.status === "DELETED")
      .map((e) => e.path);
    expect(deleted, `deleted product tests:\n${deleted.join("\n")}`).toEqual([]);
    expect(governance().counters.ProductBehaviorTestsRemoved).toBe(0);
  });

  it("no historical migration changed, by anyone", () => {
    // CHANGED, not PRESENT. A newly ADDED migration is the normal way schema
    // work lands; what must never happen is an existing one being edited or
    // deleted underneath a database that already applied it. The counter
    // asserted below draws exactly that line (`class === HISTORICAL_MIGRATION
    // && status !== "ADDED"`), and this list now draws it too — otherwise the
    // two halves of this test disagree, and the half without the status filter
    // turns every legitimate migration into a failure.
    const migrations = changeSet()
      .entries.filter(
        (e) => e.class === "HISTORICAL_MIGRATION" && e.status !== "ADDED",
      )
      .map((e) => e.path);
    expect(migrations, `changed migrations:\n${migrations.join("\n")}`).toEqual([]);
    expect(governance().counters.HistoricalMigrationsModifiedByPhase0).toBe(0);
  });

  it("no manual change inventory survives anywhere", () => {
    const c = governance().counters;
    expect({
      Phase0ChangedPathsFromManualDeclaration: c.Phase0ChangedPathsFromManualDeclaration,
      UndeclaredPhase0ChangedPaths: c.UndeclaredPhase0ChangedPaths,
      ManualPhase0ChangeInventories: c.ManualPhase0ChangeInventories,
    }).toEqual({
      Phase0ChangedPathsFromManualDeclaration: 0,
      UndeclaredPhase0ChangedPaths: 0,
      ManualPhase0ChangeInventories: 0,
    });
    // The constant itself must be gone, not merely unused.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reg = require("../scripts/audit/engine/registry.mjs") as Record<string, unknown>;
    expect(
      reg.PHASE0_CHANGED_PREFIXES,
      "the hand-maintained prefix list is still exported — a future caller can still read it as source truth",
    ).toBeUndefined();
  });
});

describe("Phase 0 §6 — the one current report is generated, not written", () => {
  const reportPath = () => registry.CANONICAL.currentReport.path as unknown as string;

  it("it identifies itself as generated", () => {
    const text = readFileSync(path.join(REPO, reportPath()), "utf8");
    expect(text).toMatch(/STATUS: CURRENT GENERATED REPORT/);
    expect(text).toMatch(/SOURCE: canonical audit engine/);
    expect(text).toMatch(/DO NOT EDIT COUNTS MANUALLY/);
  });

  it("it states all three statuses, separately", () => {
    const text = readFileSync(path.join(REPO, reportPath()), "utf8");
    for (const dimension of ["AuditEngineIntegrity", "ProductClosure", "ExternalClosure"]) {
      expect(text, `the report must state ${dimension}`).toContain(dimension);
    }
    // ExternalClosure is NOT RUN and must never be inferred from source
    // analysis — no amount of static measurement proves a real environment.
    expect(text).toMatch(/ExternalClosure[\s|]*\|?\s*NOT RUN/);
  });

  it("every scalar it prints comes from the canonical facts", () => {
    const text = readFileSync(path.join(REPO, reportPath()), "utf8");
    const f = readJson(registry.CANONICAL.currentFacts.path);
    // Spot-checked against the facts rather than against a literal in this
    // file: a hard-coded expectation here would be the same hand-maintained
    // number the report exists to eliminate.
    expect(text).toContain(String(f.facts.routes.registered));
    expect(text).toContain(String(f.facts.capabilities.undisposed));
    expect(text).toContain(String(f.findingsLedgerRef.rowCount));
    expect(text).toContain(f.engineHash);
  });
});

describe("Phase 0 §5 — engine integrity and product closure are separate exit codes", () => {
  /**
   * ASYNC, and that is the point.
   *
   * This helper used to be `spawnSync`. The orchestrator walks the whole
   * repository and takes ~36s, and `spawnSync` blocks the vitest WORKER
   * thread for all of it. The worker cannot then answer the main process's
   * `onTaskUpdate` RPC, birpc's timeout is a FIXED 60s and not configurable,
   * and vitest reports
   *
   *     [vitest-worker]: Timeout calling "onTaskUpdate"
   *
   * as an unhandled error. The run then exits 1 with every single test
   * passing — 23,867 passed, 0 failed, exit 1 — which is the worst signal a
   * suite can produce, because the obvious reading ("something failed") is
   * false and the true reading ("the harness starved") is invisible.
   *
   * vitest.config.ts already caps workers for this reason. The cap reduces the
   * contention; it cannot remove it, because one blocked worker is enough. An
   * awaited child keeps the event loop free, so the heartbeat gets through no
   * matter how long the child takes.
   *
   * The shape of the result is kept identical to spawnSync's so the assertions
   * below — including "assert the child RAN before asserting what it said" —
   * did not have to change.
   */
  const run = async (...args: string[]) => {
    const child = spawn(process.execPath, [ORCHESTRATOR, ...args], {
      cwd: REPO,
      timeout: 600_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    return await new Promise<{
      status: number | null;
      stdout: string;
      stderr: string;
      error?: Error;
    }>((resolve) => {
      child.on("error", (error) =>
        resolve({ status: null, stdout, stderr, error }),
      );
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  };

  it("--engine-check exits 0 while product work is open", async () => {
    const r = await run("--engine-check");
    // Assert the child RAN before asserting what it said: a spawn that never
    // started also produces a non-zero status, and reading that as "the gate
    // failed" is a different fact entirely.
    expect(r.error, `orchestrator did not run: ${r.error?.message}`).toBeUndefined();
    expect(
      r.status,
      `--engine-check must pass while ProductClosure is OPEN.\n${r.stdout}\n${r.stderr}`,
    ).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("AuditEngineIntegrity = PASS");
  }, 600_000);

  /**
   * PHASE 1 §12 — closure is now THREE questions, and the exit code answers one.
   *
   * This case used to require `--closure-check` to fail while 210 routes were
   * undisposed. That conflated two things a release decision must keep apart:
   * an OPEN DEFECT, which blocks a release, and an unreviewed route, which is
   * real work that does not. With the two merged the gate was permanently red
   * for a reason no release could act on — and a gate that is always red is a
   * gate nobody reads, which is how the defect half would eventually be missed.
   *
   * The exit code now follows RELEASE-BLOCKING problems only. The backlog is
   * still printed, still counted, and still earns no credit.
   */
  it("--closure-check reports all three dimensions separately", async () => {
    const r = await run("--closure-check");
    expect(r.error, `orchestrator did not run: ${r.error?.message}`).toBeUndefined();
    const out = `${r.stdout}${r.stderr}`;
    for (const dimension of [
      "ReleaseBlockingClosure",
      "ArchitectureBacklog",
      "ExternalClosure",
    ]) {
      expect(out, `--closure-check must report ${dimension}`).toContain(dimension);
    }
    // Never inferred from source analysis, whatever else is green.
    expect(out).toContain("ExternalClosure = NOT RUN");
  }, 600_000);

  it("--closure-check exit code follows RELEASE-BLOCKING findings, not the backlog", async () => {
    const r = await run("--closure-check");
    expect(r.error, `orchestrator did not run: ${r.error?.message}`).toBeUndefined();
    const facts = readJson(registry.CANONICAL.currentFacts.path);
    const open = facts.findingsLedgerRef.openIds as string[];
    const undisposed = facts.facts.capabilities.undisposed as number;

    if (open.length > 0) {
      expect(
        r.status,
        `--closure-check must FAIL while ${open.join(", ")} is open.\n${r.stdout}\n${r.stderr}`,
      ).not.toBe(0);
      return;
    }

    // No open defect. The gate must be GREEN even with a non-empty backlog —
    // and if the backlog is non-empty it must still be visible in the output,
    // because "not blocking" must never quietly become "not mentioned".
    expect(
      r.status,
      `no open findings remain, so the release gate must be green.\n${r.stdout}\n${r.stderr}`,
    ).toBe(0);
    if (undisposed > 0) {
      expect(`${r.stdout}${r.stderr}`).toContain("NON_BLOCKING_VISIBLE");
      expect(`${r.stdout}${r.stderr}`).toContain(String(undisposed));
    }
  }, 600_000);

  it("the backlog earns no credit of any kind", () => {
    const l = readJson(registry.CANONICAL.currentFacts.path).findingsLedgerRef;
    const inv = l.trackedInventory ?? { total: 0, releaseBlocking: false };
    expect(inv.releaseBlocking).toBe(false);
    // Inventory rows are counted in their own bucket — never as closed defects.
    expect(l.actionable.closed + l.actionable.open).toBe(l.actionable.total);
    expect(l.fixedIds ?? []).not.toContain("ARCH-BACKLOG-001");
  });
});
