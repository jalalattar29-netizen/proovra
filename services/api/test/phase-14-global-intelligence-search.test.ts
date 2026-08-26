/**
 * Phase 14 — Global Intelligence Search source-contract test.
 *
 * Pins the Phase 14 closure deliverables for the canonical
 * /search surface. Phase 14 ground rules forbid ANY semantic /
 * vector / embedding work — this test only verifies the
 * keyword-search re-index wiring, the intelligence/search alias
 * consolidation, and the frontend deep-link affordances.
 *
 * Cross-reference:
 *   - docs/architecture/search-reality-audit.md
 *   - docs/architecture/phase-13-intelligence-chain.md
 *
 * Test style: vitest source-contract (fs.readFileSync). No DB I/O.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Repo roots
// ---------------------------------------------------------------------------

const API_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = resolve(API_ROOT, "..", "..");
const WEB_ROOT = resolve(REPO_ROOT, "apps", "web");
const SHARED_RUNTIME_ROOT = resolve(REPO_ROOT, "packages", "shared-runtime");
const WORKER_ROOT = resolve(REPO_ROOT, "services", "worker");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

// ===========================================================================
// BACKEND — Stage 2 re-index trigger wiring
// ===========================================================================

describe("Phase 14 — Stage 2 re-index triggers (backend)", () => {
  const EXTRACTION_PATH = resolve(
    API_ROOT,
    "src/services/intelligence/extraction.service.ts",
  );
  const GRAPH_BUILDER_PATH = resolve(
    SHARED_RUNTIME_ROOT,
    "src/graph/graph-builder.service.ts",
  );
  const MEDIA_INTEL_PATH = resolve(
    WORKER_ROOT,
    "src/media-intelligence.processor.ts",
  );

  it("Trigger #1 — extraction.service.ts enqueues with reason 'ocr_completed'", () => {
    const src = read(EXTRACTION_PATH);
    expect(src).toContain("enqueueSearchIndexingJob");
    expect(src).toMatch(/["']ocr_completed["']/);
  });

  it("Trigger #2 — extraction.service.ts enqueues with reason 'transcript_completed'", () => {
    const src = read(EXTRACTION_PATH);
    expect(src).toMatch(/["']transcript_completed["']/);
  });

  it("Trigger #3 — extraction.service.ts enqueues with reason 'entities_extracted'", () => {
    const src = read(EXTRACTION_PATH);
    expect(src).toMatch(/["']entities_extracted["']/);
  });

  it("Trigger #4 — graph-builder.service.ts exposes the onReconciled post-reconcile hook", () => {
    const src = read(GRAPH_BUILDER_PATH);
    // The shared-runtime reconciler exposes an optional hook so
    // API + worker call sites can wire enqueueSearchIndexingJob
    // without shared-runtime taking a dependency on the queue helper.
    expect(src).toMatch(/onReconciled/);
    expect(src).toMatch(/ReconcileTeamGraphHooks/);
  });

  it("Trigger #4 — worker subsystem-queue-processors.ts wires onReconciled → enqueueSearchIndexingJob('graph_reconciled')", () => {
    // Architecture moved post-Part 1: the API enqueues a graph-reconcile
    // worker job (via evidence-finalization-fanout.service.ts) and the
    // WORKER is the canonical caller of reconcileTeamGraph with the
    // onReconciled hook. The hook fires enqueueSearchIndexingJob with
    // reason "graph_reconciled". Pin the consumer side directly — this
    // is the only place that actually invokes the hook in production.
    const WORKER_GRAPH_RECONCILE_PATH = resolve(
      WORKER_ROOT,
      "src/subsystem-queue-processors.ts",
    );
    const src = read(WORKER_GRAPH_RECONCILE_PATH);
    expect(src).toContain("enqueueSearchIndexingJob");
    expect(src).toMatch(/onReconciled/);
    expect(src).toMatch(/["']graph_reconciled["']/);

    // Also pin that the API-side fan-out enqueues the worker job (so
    // the worker actually receives the reconcile request that triggers
    // the onReconciled hook).
    const FANOUT_PATH = resolve(
      API_ROOT,
      "src/services/evidence-finalization-fanout.service.ts",
    );
    const fanoutSrc = read(FANOUT_PATH);
    expect(fanoutSrc).toMatch(/enqueueGraphReconcileJob\s*\(/);
  });

  it("Trigger #5 — media-intelligence.processor.ts enqueues with reason 'similarity_completed'", () => {
    const src = read(MEDIA_INTEL_PATH);
    expect(src).toContain("enqueueSearchIndexingJob");
    expect(src).toMatch(/["']similarity_completed["']/);
  });

  it("each enqueueSearchIndexingJob site in extraction.service.ts is wrapped in try/catch (best-effort)", () => {
    const src = read(EXTRACTION_PATH);
    // Match a try { ... enqueueSearchIndexingJob( ... ) ... } catch
    // block. We assert there are at LEAST two such guarded blocks
    // (OCR/transcript + entities) — failure of any enqueue must
    // never block the parent COMPLETED write.
    const guardedRe =
      /try\s*\{[\s\S]*?enqueueSearchIndexingJob\([\s\S]*?\}\s*catch/g;
    const matches = src.match(guardedRe) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("media-intelligence.processor.ts wraps the similarity_completed enqueue in try/catch", () => {
    const src = read(MEDIA_INTEL_PATH);
    const guardedRe =
      /try\s*\{[\s\S]*?enqueueSearchIndexingJob\([\s\S]*?\}\s*catch/g;
    const matches = src.match(guardedRe) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// BACKEND — Stage 3 /v1/intelligence/search consolidation
// ===========================================================================

describe("Phase 14 — Stage 3 /v1/intelligence/search consolidation (alias forward)", () => {
  const INTEL_ROUTES_PATH = resolve(
    API_ROOT,
    "src/routes/intelligence.routes.ts",
  );
  const SEARCH_ROUTES_PATH = resolve(API_ROOT, "src/routes/search.routes.ts");
  const EVIDENCE_SEARCH_PATH = resolve(
    API_ROOT,
    "src/services/search/evidence-search.service.ts",
  );

  it("/v1/intelligence/search is a deprecated alias that delegates to the canonical /v1/search backend", () => {
    const src = read(INTEL_ROUTES_PATH);
    // The route is still registered (preserves backward compat for
    // surviving callers)…
    expect(src).toMatch(/["']\/v1\/intelligence\/search["']/);
    // …but it forwards to the canonical executeSearch backend (the
    // same handler /v1/search uses). The handler also records a
    // deprecation hint in the response envelope.
    expect(src).toMatch(/executeSearch/);
    expect(src.toLowerCase()).toMatch(/deprecat/);
  });

  it("/v1/search remains workspace-scoped (handler reads teamId)", () => {
    const src = read(SEARCH_ROUTES_PATH);
    // teamId is part of the parsed query / body shape across the
    // search routes — workspace isolation is enforced at every
    // handler entry.
    expect(src).toMatch(/teamId/);
  });

  it("evidence-search.service.ts preserves governance filtering (legal-hold / destroyed / export-restricted)", () => {
    const src = read(EVIDENCE_SEARCH_PATH);
    // Legal-hold filter must be addressable on the search filter.
    expect(src).toMatch(/legalHold/i);
    // Export-restricted projection still emits a badge so the
    // canonical surface visibly distinguishes those documents.
    expect(src).toMatch(/exportState|exportRestricted/i);
  });
});

// ===========================================================================
// FRONTEND — /search canonical route + negative guards
// ===========================================================================

describe("Phase 14 — /search canonical route (frontend)", () => {
  const ROUTE_REGISTRY_PATH = resolve(
    WEB_ROOT,
    "lib/navigation/routeRegistry.ts",
  );
  const SEARCH_PAGE_PATH = resolve(WEB_ROOT, "app/(app)/search/page.tsx");

  it("workspace.search → /search remains the canonical route entry in routeRegistry", () => {
    const src = read(ROUTE_REGISTRY_PATH);
    // The id + href appear within a small window (Phase 14 brief
    // pin #10).
    expect(src).toMatch(
      /id:\s*"workspace\.search"[\s\S]{0,200}href:\s*"\/search"/,
    );
  });

  it("no Search v2 / Investigation Search / Semantic Search route directories exist (negative guard)", () => {
    const forbidden = [
      "app/(app)/search-v2",
      "app/(app)/investigation-search",
      "app/(app)/semantic-search",
    ];
    for (const rel of forbidden) {
      expect(existsSync(resolve(WEB_ROOT, rel))).toBe(false);
    }
  });

  it("search/page.tsx renders the Phase 13 'Semantic search not available' chip", () => {
    const src = read(SEARCH_PAGE_PATH);
    expect(src).toContain("Semantic search not available");
  });

  it("search/page.tsx Inspector exposes the 3 investigation pivots (graph + timeline + duplicates)", () => {
    const src = read(SEARCH_PAGE_PATH);
    expect(src).toMatch(/investigation\/cases\/[^"]*\/graph/);
    expect(src).toMatch(/investigation\/timeline\?evidenceId=/);
    expect(src).toMatch(/investigation\/duplicates\?evidenceId=/);
  });

  it("Phase SEARCH-REMEDIATION-3 — empty-state is split into 4 truthful branches (loading / error / idle / no-match)", () => {
    const src = read(SEARCH_PAGE_PATH);
    // The legacy "No results yet" line (which ran for both the
    // pre-query and the zero-match case) was replaced by four
    // distinct, honestly-labelled empty states.
    expect(src).not.toContain("No results yet");
    expect(src).toContain('data-search-empty-state-kind="idle"');
    expect(src).toContain('data-search-empty-state-kind="no-match"');
    expect(src).toContain('data-search-empty-state-kind="error"');
    expect(src).toContain('data-search-empty-state-kind="loading"');
  });
});

// ===========================================================================
// FRONTEND — deep-link affordances into /search across 7 pages
// ===========================================================================

describe("Phase 14 — Stage 6 deep-link affordances (frontend)", () => {
  it("evidence/[id]/page.tsx imports EntityChipGroup (which links chips into /search?q=)", () => {
    // Phase EVIDENCE-IA-DECOMPOSE — EntityChipGroup moved from
    // page.tsx into EvidenceOverviewTab.tsx; the deep-link wiring
    // is preserved there.
    const src = read(
      resolve(WEB_ROOT, "app/(app)/evidence/[id]/_tabs/EvidenceOverviewTab.tsx"),
    );
    expect(src).toContain("EntityChipGroup");
  });

  it("components/intelligence/EntityChipGroup.tsx wires each chip into a /search?q= deep link", () => {
    const src = read(
      resolve(WEB_ROOT, "components/intelligence/EntityChipGroup.tsx"),
    );
    expect(src).toMatch(/href=\{?[`'"]\/search\?q=/);
  });

  // The case-scoped Search affordance moved out of the route file when the
  // canonical Case Details header absorbed it: the route now only picks
  // between the Enterprise and Personal branches, and the deep link rides the
  // shared header's secondary-action slot inside MatterWorkspace. Identical
  // guarantee — a Case Details surface can jump to Search scoped to that case.
  it("the Case Details surface contains a /search?caseId= deep link", () => {
    const src = read(
      resolve(WEB_ROOT, "components/cases-experience/MatterWorkspace.tsx"),
    );
    expect(src).toMatch(/href=\{`\/search\?caseId=\$\{encodeURIComponent\(/);
  });

  it("the reports surface searches IN PAGE, not by deep-linking to /search", () => {
    // WITHDRAWN AFFORDANCE (2026-08-26), not a lost one.
    //
    // The header carried a "Search reports" button deep-linking to
    // `/search?documentType=REPORT`. The page has its own search field and its
    // own lifecycle filters, both of which query the reports aggregator — so
    // the button sent an operator AWAY from the surface that could already
    // answer their question, to one filtered by document type rather than by
    // report or package state.
    //
    // The Phase 14 guarantee was that reports are searchable. They are, on the
    // page itself, which is what this now asserts: the deep link is gone AND
    // the in-page search remains. Asserting only the removal would pass over a
    // page with no search at all.
    const src = read(
      resolve(WEB_ROOT, "components/reports-experience/ReportsIndex.tsx"),
    );
    expect(src).not.toMatch(/\/search\?documentType=REPORT/);
    expect(src).toMatch(/<FilterBar\.Search/);
    expect(src).toMatch(/data-reports-search-input/);
    // The field is wired to the query the aggregator actually honours.
    expect(src).toMatch(/params\.set\("search"/);
  });

  it("investigation/graph/page.tsx contains a /search?q= deep link (entity affordance)", () => {
    const src = read(
      resolve(WEB_ROOT, "app/(app)/investigation/graph/page.tsx"),
    );
    expect(src).toMatch(/\/search\?q=/);
  });

  it("investigation/timeline/page.tsx contains a /search? deep link", () => {
    const src = read(
      resolve(WEB_ROOT, "app/(app)/investigation/timeline/page.tsx"),
    );
    expect(src).toMatch(/\/search\?/);
  });

  it("investigation/duplicates/page.tsx contains a /search? deep link", () => {
    const src = read(
      resolve(WEB_ROOT, "app/(app)/investigation/duplicates/page.tsx"),
    );
    expect(src).toMatch(/\/search\?/);
  });
});

// ===========================================================================
// BOUNDED GUARDS — no schema changes, no v2 surfaces
// ===========================================================================

describe("Phase 14 — bounded guards (no new schema / no v2 surfaces)", () => {
  const MIGRATIONS_DIR = resolve(API_ROOT, "prisma", "migrations");
  const SEARCH_SERVICES_DIR = resolve(API_ROOT, "src/services/search");
  const ROUTES_DIR = resolve(API_ROOT, "src/routes");

  function listDirs(dir: string): string[] {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(resolve(dir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  }

  function listFiles(dir: string): string[] {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(resolve(dir, name)).isFile();
      } catch {
        return false;
      }
    });
  }

  it("Phase 14 added NO new Prisma migration (phase has no schema changes)", () => {
    // Phase 14 ground rules forbid schema changes. The Phase 14
    // closure runs AFTER the Phase 13 intelligence chain migration
    // (20270601000000_phase13_intelligence_chain), so any new
    // Phase-14-scoped migration would carry a timestamp strictly
    // greater than that prefix. Legacy migrations from much earlier
    // batches that happen to mention "phase14" in their name (e.g.
    // 20260523100000_add_governance_platform_phase14 — Phase 14 of
    // the OLD pre-Phase-R numbering scheme) are explicitly allowed
    // because they predate the canonical Phase 14 closure scope.
    const PHASE_13_BOUNDARY = "20270601000000";
    const offenders = listDirs(MIGRATIONS_DIR).filter((d) => {
      if (!/phase[_-]?14|phase14/i.test(d)) return false;
      const ts = d.slice(0, 14);
      // Only flag migrations whose timestamp is at or after the
      // Phase 14 closure boundary.
      return ts > PHASE_13_BOUNDARY;
    });
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no new search service file has 'v2' in its name", () => {
    const offenders = listFiles(SEARCH_SERVICES_DIR).filter((f) =>
      /v2/i.test(f),
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no new route file matches search.*v2 (would imply a Search v2 route)", () => {
    const offenders = listFiles(ROUTES_DIR).filter((f) =>
      /search.*v2|v2.*search/i.test(f),
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
