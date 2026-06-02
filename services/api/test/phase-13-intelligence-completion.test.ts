/**
 * Phase 13 — Intelligence chain COMPLETION contract test.
 *
 * Pins every Section 4 item that landed under the Phase 13 brief
 * (intelligence chain completion: Evidence → OCR → Transcript →
 * Entities → Relationships → Graph → Timeline → Search → Similarity
 * → Cross-Evidence). Companion to `phase-13-intelligence-chain.test.ts`
 * which covers the same wiring at the wire-format level — this file
 * is the COMPLETION pin (Section 4 deliverables + bounded GUARDs
 * required by the Phase 13 ground rules).
 *
 * Section 4 deliverables pinned here:
 *
 *   S4.1  ENTITY_GRAPH_EDGE_WIRE     — reconcileTeamGraph reads
 *                                       evidence_entities + writes
 *                                       ENTITY nodes + EXTRACTED_FROM
 *                                       edges via existing helpers.
 *   S4.2  GRAPH_CATALOG_WIDEN        — GRAPH_NODE_KINDS / GRAPH_EDGE_TYPES
 *                                       include ENTITY + EXTRACTED_FROM.
 *   S4.3  NEW_MIGRATION_ADDITIVE     — exactly ONE Phase 13 migration
 *                                       under prisma/migrations.
 *   S4.4  SCHEMA_MIRROR              — EvidenceSimilarity.graphEdgeId
 *                                       mapped to graph_edge_id.
 *   S4.5  TIMELINE_UNION_EXTEND      — EXTRACTED_TEXT_COMPLETED +
 *                                       ENTITY_EXTRACTED UNION branches
 *                                       on the per-evidence timeline.
 *   S4.6  DOC/TRANSCRIPT_SIMILARITY  — single shared handler in the
 *                                       EXISTING media-intelligence
 *                                       processor, gated on textKind.
 *   S4.7  WORKER_QUEUE_PAYLOAD       — MediaIntelligenceJobPayload
 *                                       carries optional textKind.
 *   S4.8  SEARCH_INDEXER_WIRE        — entity normalizedValue chunks
 *                                       land in searchableText.
 *   S4.9  CROSS_EVIDENCE_SERVICE     — listCrossEvidenceFindings exists
 *                                       on the entity-extraction service
 *                                       with grouped-SQL semantics.
 *   S4.10 CROSS_EVIDENCE_ROUTE       — GET /v1/investigation/cross-evidence
 *                                       registered on the EXISTING
 *                                       intelligence.routes.ts.
 *   S4.11 TYPED_API_CLIENT           — apps/web/lib/api/intelligence.ts
 *                                       exports getCrossEvidenceFindings.
 *   S4.12 UI_SURFACE_INVESTIGATION   — /investigation renders the
 *                                       Cross-Evidence Findings card
 *                                       with /search?q= deep links.
 *   S4.13 UI_SURFACE_SEARCH          — /search renders a bounded
 *                                       "semantic search not available"
 *                                       pill (Phase 14 deferred).
 *   S4.14 DOC_EXISTS                 — Phase 13 architecture doc lives
 *                                       under docs/architecture.
 *
 * Bounded GUARDs (Phase 13 ground rules):
 *
 *   G1    NO_V2_FILES               — no new ocr/transcript/entity/
 *                                       graph/timeline/search/similarity/
 *                                       relationship/intelligence v2
 *                                       file under any source tree.
 *   G2    ONE_PHASE_13_MIGRATION    — exactly one
 *                                       phase13_intelligence_chain
 *                                       migration directory.
 *   G3    NO_NEW_WORKER_FILE        — services/worker/src has exactly
 *                                       the pre-Phase-13 processor file
 *                                       set (4 entries).
 *   G4    CORE_ROUTES_DISCOVERABLE  — Capture / Evidence / Cases /
 *                                       Search / Home / Billing /
 *                                       Settings keep their canonical
 *                                       sidebarEligible +
 *                                       commandPaletteVisible flags.
 *
 * Style: source-contract (fs.readFileSync). Matches the
 * `phase-7-team-vs-workspace-anti-confusion.test.ts` pattern.
 * Production code is the source of truth — assertions are tolerant
 * of formatting variation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const API_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB_ROOT = resolve(REPO_ROOT, "apps/web");
const WORKER_ROOT = resolve(REPO_ROOT, "services/worker");
const SHARED_RUNTIME_ROOT = resolve(REPO_ROOT, "packages/shared-runtime");
const DOCS_ROOT = resolve(REPO_ROOT, "docs");

const GRAPH_BUILDER = resolve(
  SHARED_RUNTIME_ROOT,
  "src/graph/graph-builder.service.ts",
);
const GRAPH_CATALOG = resolve(
  SHARED_RUNTIME_ROOT,
  "src/graph/graph-catalog.ts",
);
const WORKER_PROCESSOR = resolve(
  WORKER_ROOT,
  "src/media-intelligence.processor.ts",
);
const WORKER_QUEUE = resolve(WORKER_ROOT, "src/queue.ts");
const ENTITY_EXTRACTION_SERVICE = resolve(
  API_ROOT,
  "src/services/intelligence/entity-extraction.service.ts",
);
const SEARCH_INDEXING_SERVICE = resolve(
  API_ROOT,
  "src/services/search/evidence-indexing.service.ts",
);
const INTELLIGENCE_ROUTES = resolve(
  API_ROOT,
  "src/routes/intelligence.routes.ts",
);
const INTELLIGENCE_CLIENT = resolve(WEB_ROOT, "lib/api/intelligence.ts");
const INVESTIGATION_PAGE = resolve(
  WEB_ROOT,
  "app/(app)/investigation/page.tsx",
);
const SEARCH_PAGE = resolve(WEB_ROOT, "app/(app)/search/page.tsx");
const SCHEMA_PRISMA = resolve(API_ROOT, "prisma/schema.prisma");
const MIGRATIONS_DIR = resolve(API_ROOT, "prisma/migrations");
const PHASE_13_MIGRATION_DIR = resolve(
  MIGRATIONS_DIR,
  "20270601000000_phase13_intelligence_chain",
);
const PHASE_13_MIGRATION_SQL = resolve(
  PHASE_13_MIGRATION_DIR,
  "migration.sql",
);
const WORKER_SRC_DIR = resolve(WORKER_ROOT, "src");
const ROUTE_REGISTRY = resolve(WEB_ROOT, "lib/navigation/routeRegistry.ts");
const PHASE_13_DOC = resolve(
  DOCS_ROOT,
  "architecture/phase-13-intelligence-chain.md",
);

function readSrc(path: string): string {
  return readFileSync(path, "utf8");
}

// ===========================================================================
// S4.1 — ENTITY_GRAPH_EDGE_WIRE
// ===========================================================================

describe("Phase 13 S4.1 — reconcileTeamGraph wires entity nodes + EXTRACTED_FROM edges", () => {
  const src = readSrc(GRAPH_BUILDER);

  it("the reconciler reads from evidence_entities", () => {
    expect(src).toMatch(/evidence_entities/);
  });

  it("upserts ENTITY nodes through the existing upsertNode helper", () => {
    expect(src).toMatch(/upsertNode\([^)]*"ENTITY"/);
  });

  it("writes EXTRACTED_FROM edges (ENTITY -> EVIDENCE)", () => {
    expect(src).toMatch(/"EXTRACTED_FROM"/);
  });

  it("wraps the entity-reconciliation block in try/catch (never fails reconcile)", () => {
    expect(src).toMatch(
      /Phase 13 — ENTITY domain reconciliation[\s\S]{0,4000}\}\s*catch\b/,
    );
  });
});

// ===========================================================================
// S4.2 — GRAPH_CATALOG_WIDEN
// ===========================================================================

describe("Phase 13 S4.2 — graph catalog widens with ENTITY + EXTRACTED_FROM", () => {
  const src = readSrc(GRAPH_CATALOG);

  it("declares ENTITY in GRAPH_NODE_KINDS", () => {
    expect(src).toMatch(/GRAPH_NODE_KINDS[\s\S]{0,800}"ENTITY"/);
  });

  it("declares EXTRACTED_FROM in GRAPH_EDGE_TYPES", () => {
    expect(src).toMatch(/GRAPH_EDGE_TYPES[\s\S]{0,1200}"EXTRACTED_FROM"/);
  });
});

// ===========================================================================
// S4.3 — NEW_MIGRATION_ADDITIVE
// ===========================================================================

describe("Phase 13 S4.3 — single additive Phase 13 migration", () => {
  it("the Phase 13 migration directory exists", () => {
    expect(existsSync(PHASE_13_MIGRATION_DIR)).toBe(true);
    expect(statSync(PHASE_13_MIGRATION_DIR).isDirectory()).toBe(true);
  });

  it("the migration.sql file exists inside the directory", () => {
    expect(existsSync(PHASE_13_MIGRATION_SQL)).toBe(true);
  });

  const sql = existsSync(PHASE_13_MIGRATION_SQL)
    ? readSrc(PHASE_13_MIGRATION_SQL)
    : "";

  it("adds graph_edge_id with ADD COLUMN IF NOT EXISTS + terminating ;", () => {
    expect(sql).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"graph_edge_id"[\s\S]*?UUID[^;]*;/i,
    );
  });

  it("creates the partial graph_edge_id index with terminating ;", () => {
    expect(sql).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"evidence_similarities_graph_edge_id_idx"[\s\S]*?;/i,
    );
  });

  it("widens investigation_graph_nodes_kind_bounded CHECK to include ENTITY", () => {
    expect(sql).toMatch(/investigation_graph_nodes_kind_bounded/);
    expect(sql).toMatch(/'ENTITY'/);
  });

  it("widens investigation_graph_edges_type_bounded CHECK to include EXTRACTED_FROM", () => {
    expect(sql).toMatch(/investigation_graph_edges_type_bounded/);
    expect(sql).toMatch(/'EXTRACTED_FROM'/);
  });

  it("contains no destructive DDL beyond the CHECK constraint replacements", () => {
    const executable = sql
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    expect(executable).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(executable).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(executable).not.toMatch(/\bRENAME\b/i);
  });

  it("wraps every mutation in a DO $$ guard (Phase O additive pattern)", () => {
    expect(sql).toMatch(/DO\s+\$\$/);
    expect(sql).toMatch(/pg_tables/);
  });
});

// ===========================================================================
// S4.4 — SCHEMA_MIRROR
// ===========================================================================

describe("Phase 13 S4.4 — schema.prisma mirrors the additive column", () => {
  const schema = readSrc(SCHEMA_PRISMA);

  it("declares graphEdgeId mapped to graph_edge_id on EvidenceSimilarity", () => {
    expect(schema).toMatch(
      /graphEdgeId[\s\S]{0,80}@map\(\s*"graph_edge_id"\s*\)/,
    );
  });

  it("indexes graphEdgeId for the audit-row back-reference lookup", () => {
    expect(schema).toMatch(/@@index\(\[\s*graphEdgeId\s*\]\)/);
  });
});

// ===========================================================================
// S4.5 — TIMELINE_UNION_EXTEND
// ===========================================================================

describe("Phase 13 S4.5 — timeline UNION extended with extracted-text + entity events", () => {
  const src = readSrc(GRAPH_BUILDER);

  it("declares EXTRACTED_TEXT_COMPLETED in the TimelineEventKind union", () => {
    expect(src).toMatch(/"EXTRACTED_TEXT_COMPLETED"/);
  });

  it("declares ENTITY_EXTRACTED in the TimelineEventKind union", () => {
    expect(src).toMatch(/"ENTITY_EXTRACTED"/);
  });

  it("unions evidence_extracted_texts on the timeline query", () => {
    expect(src).toMatch(/evidence_extracted_texts/);
  });

  it("unions evidence_entities (alias ent.) on the timeline query", () => {
    expect(src).toMatch(/FROM\s+"evidence_entities"\s+ent\b/);
  });
});

// ===========================================================================
// S4.6 — DOC/TRANSCRIPT_SIMILARITY shared handler
// ===========================================================================

describe("Phase 13 S4.6 — single shared text-similarity handler in existing processor", () => {
  const src = readSrc(WORKER_PROCESSOR);

  it("branches on reconcile + textKind for the new text-similarity sub-path", () => {
    expect(src).toMatch(/kind\s*===\s*"reconcile"\s*&&\s*job\.data\?.textKind/);
  });

  it("invokes a single shared processTextSimilarityPromotion handler", () => {
    expect(src).toMatch(/processTextSimilarityPromotion/);
  });

  it("promotes EvidenceSimilarity rows to SIMILAR_TO investigation_graph_edges", () => {
    expect(src).toMatch(/SIMILAR_TO/);
    expect(src).toMatch(/investigation_graph_edges/);
  });

  it("back-references the resulting edge via UPDATE evidence_similarities SET graph_edge_id", () => {
    expect(src).toMatch(
      /UPDATE\s+"evidence_similarities"[\s\S]{0,200}"graph_edge_id"/,
    );
  });

  it("uses a shingle + Jaccard implementation (no heavy npm dep)", () => {
    expect(src).toMatch(/computeShingleSet/);
    expect(src).toMatch(/function\s+jaccard\s*\(/);
  });

  it("declares LOW / HIGH confidence bands at 0.30 and 0.60", () => {
    expect(src).toMatch(/TEXT_SIM_LOW_BAND\s*=\s*0\.30/);
    expect(src).toMatch(/TEXT_SIM_HIGH_BAND\s*=\s*0\.60/);
  });
});

// ===========================================================================
// S4.7 — WORKER_QUEUE_PAYLOAD
// ===========================================================================

describe("Phase 13 S4.7 — MediaIntelligenceJobPayload carries optional textKind", () => {
  const src = readSrc(WORKER_QUEUE);

  it("extends the payload with textKind?: 'OCR' | 'TRANSCRIPT'", () => {
    expect(src).toMatch(/textKind\?\s*:\s*"OCR"\s*\|\s*"TRANSCRIPT"/);
  });
});

// ===========================================================================
// S4.8 — SEARCH_INDEXER_WIRE
// ===========================================================================

describe("Phase 13 S4.8 — entity-name chunks land in searchable text", () => {
  const src = readSrc(SEARCH_INDEXING_SERVICE);

  it("reads from evidenceEntity for the indexed evidence", () => {
    expect(src).toMatch(/evidenceEntity\.findMany/);
  });

  it("appends `[entity] {normalizedValue}` chunks to the projection", () => {
    expect(src).toMatch(/\[entity\]/);
  });
});

// ===========================================================================
// S4.9 — CROSS_EVIDENCE_SERVICE
// ===========================================================================

describe("Phase 13 S4.9 — listCrossEvidenceFindings service method", () => {
  const src = readSrc(ENTITY_EXTRACTION_SERVICE);

  it("exports listCrossEvidenceFindings from the entity-extraction service", () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+listCrossEvidenceFindings/,
    );
  });

  it("groups by (kind, normalized_value) in raw SQL — no new Prisma table", () => {
    expect(src).toMatch(/GROUP\s+BY[\s\S]{0,200}"normalized_value"/i);
  });

  it("returns only findings with evidence_count > 1", () => {
    expect(src).toMatch(/HAVING\s+COUNT\(DISTINCT[\s\S]{0,80}>\s*1/i);
  });

  it("clamps the result LIMIT to 20", () => {
    expect(src).toMatch(/Math\.min\([^)]*,\s*20\)/);
  });
});

// ===========================================================================
// S4.10 — CROSS_EVIDENCE_ROUTE on existing intelligence.routes.ts
// ===========================================================================

describe("Phase 13 S4.10 — GET /v1/investigation/cross-evidence route", () => {
  const src = readSrc(INTELLIGENCE_ROUTES);

  it("imports listCrossEvidenceFindings", () => {
    expect(src).toMatch(/listCrossEvidenceFindings/);
  });

  it("registers GET /v1/investigation/cross-evidence", () => {
    expect(src).toMatch(/"\/v1\/investigation\/cross-evidence"/);
  });

  it("does NOT introduce a new route family — uses existing intelligence.routes.ts", () => {
    expect(existsSync(INTELLIGENCE_ROUTES)).toBe(true);
  });
});

// ===========================================================================
// S4.11 — TYPED_API_CLIENT
// ===========================================================================

describe("Phase 13 S4.11 — typed cross-evidence API client", () => {
  const src = readSrc(INTELLIGENCE_CLIENT);

  it("exports getCrossEvidenceFindings", () => {
    expect(src).toMatch(/export\s+async\s+function\s+getCrossEvidenceFindings/);
  });

  it("exports the CrossEvidenceFinding type", () => {
    expect(src).toMatch(/export\s+type\s+CrossEvidenceFinding/);
  });

  it("calls /v1/investigation/cross-evidence (no new route family)", () => {
    expect(src).toMatch(/\/v1\/investigation\/cross-evidence/);
  });

  it("uses the existing apiFetch helper", () => {
    expect(src).toMatch(/apiFetch/);
  });
});

// ===========================================================================
// S4.12 — UI_SURFACE_INVESTIGATION
// ===========================================================================

describe("Phase 13 S4.12 — /investigation renders Cross-Evidence Findings card", () => {
  const src = readSrc(INVESTIGATION_PAGE);

  it("imports the typed cross-evidence client", () => {
    expect(src).toMatch(/getCrossEvidenceFindings/);
  });

  it("renders a section labelled 'Cross-Evidence Findings'", () => {
    expect(src).toMatch(/Cross-Evidence Findings/);
  });

  it("mounts the CrossEvidenceFindingsCard component", () => {
    expect(src).toMatch(/CrossEvidenceFindingsCard/);
  });

  it("deep-links chips to /search?q= for the matched normalizedValue", () => {
    expect(src).toMatch(/\/search\?q=/);
  });

  it("uses useTeamId (no envelope.workspace.* access)", () => {
    expect(src).toMatch(/useTeamId/);
    expect(src).not.toMatch(/envelope\.workspace\./);
  });

  it("contains no window.confirm calls", () => {
    expect(src).not.toMatch(/window\.confirm/);
  });
});

// ===========================================================================
// S4.13 — UI_SURFACE_SEARCH (semantic-search disabled pill)
// ===========================================================================

describe("Phase 13 S4.13 — /search renders bounded semantic-search disabled pill", () => {
  const src = readSrc(SEARCH_PAGE);

  it("renders an operator-safe disabled-state indicator", () => {
    expect(src).toMatch(/Semantic search not available/);
    expect(src).toMatch(/keyword search active/);
  });

  it("uses the data-semantic-search-status attribute for the chip", () => {
    // Phase 15 evolution: the chip's status is now driven dynamically —
    // disabled / active / unavailable — so the attribute is emitted
    // from a JSX expression (`data-semantic-search-status={status}`)
    // rather than a literal. The Phase 13 contract that the chip
    // carries this attribute is preserved. Accept either shape.
    expect(src).toMatch(
      /data-semantic-search-status=(?:"disabled"|\{status\})/,
    );
  });

  it("does not leak internal config or env-var names in chip copy", () => {
    const chipBlock = src.match(/Semantic search not available[\s\S]{0,200}/);
    expect(chipBlock).not.toBeNull();
    const chipText = chipBlock?.[0] ?? "";
    expect(chipText).not.toMatch(
      /SEMANTIC_SEARCH_ENABLED|OPENAI_EMBEDDING_MODEL|pgvector|qdrant|weaviate/i,
    );
  });
});

// ===========================================================================
// S4.14 — DOC_EXISTS
// ===========================================================================

describe("Phase 13 S4.14 — Phase 13 architecture doc exists", () => {
  it("docs/architecture/phase-13-intelligence-chain.md exists", () => {
    expect(existsSync(PHASE_13_DOC)).toBe(true);
  });

  it("the doc mentions the deferred Phase 14 semantic-search scope", () => {
    const body = readSrc(PHASE_13_DOC);
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/Phase\s*14/i);
  });
});

// ===========================================================================
// G1 — GUARD: no new *v2* / *_new* / *_v2* file under affected trees
// ===========================================================================

describe("Phase 13 G1 — no v2 / _new / _v2 files in any affected tree", () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (
          name === "node_modules" ||
          name === ".next" ||
          name === "dist" ||
          name === "build" ||
          name === ".turbo"
        ) {
          continue;
        }
        out.push(...walk(full));
        continue;
      }
      if (
        name.endsWith(".ts") ||
        name.endsWith(".tsx") ||
        name.endsWith(".js")
      ) {
        out.push(full);
      }
    }
    return out;
  }

  // Bounded list of v2-style basenames the Phase 13 brief forbids.
  // Case-insensitive. The brief explicitly enumerates: ocr-v2,
  // transcript-v2, entity-v2, graph-v2, timeline-v2, search-v2,
  // similarity-v2, relationship-v2, intelligence-v2.
  const FORBIDDEN_BASENAMES =
    /^(ocr|transcript|entity|graph|timeline|search|similarity|relationship|intelligence)[._-]v2\.(ts|tsx|js)$/i;

  function offendersUnder(root: string): string[] {
    return walk(root)
      .map((p) => p.replace(/\\/g, "/"))
      .filter((p) => {
        const base = p.split("/").pop() ?? "";
        return FORBIDDEN_BASENAMES.test(base);
      });
  }

  it("apps/web has no v2-duplicate file in any of the listed families", () => {
    const offenders = offendersUnder(resolve(WEB_ROOT, "app")).concat(
      offendersUnder(resolve(WEB_ROOT, "components")),
      offendersUnder(resolve(WEB_ROOT, "lib")),
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("services/api/src has no v2-duplicate file in any of the listed families", () => {
    const offenders = offendersUnder(resolve(API_ROOT, "src"));
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("services/worker/src has no v2-duplicate file in any of the listed families", () => {
    const offenders = offendersUnder(resolve(WORKER_ROOT, "src"));
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("packages/shared-runtime/src has no v2-duplicate file in any of the listed families", () => {
    const offenders = offendersUnder(resolve(SHARED_RUNTIME_ROOT, "src"));
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

// ===========================================================================
// G2 — GUARD: exactly ONE phase13_intelligence_chain migration directory
// ===========================================================================

describe("Phase 13 G2 — exactly one phase13_intelligence_chain migration", () => {
  it("matches the canonical Phase 13 intelligence-chain slug exactly once", () => {
    const entries = readdirSync(MIGRATIONS_DIR);
    const intelligenceChain = entries.filter((name) =>
      /phase13_intelligence_chain/i.test(name),
    );
    expect(intelligenceChain, intelligenceChain.join("\n")).toEqual([
      "20270601000000_phase13_intelligence_chain",
    ]);
  });

  it("no sibling migration shares the 20270601000000_ timestamp prefix", () => {
    const entries = readdirSync(MIGRATIONS_DIR);
    const siblings = entries.filter((name) =>
      name.startsWith("20270601000000_"),
    );
    expect(siblings, siblings.join("\n")).toEqual([
      "20270601000000_phase13_intelligence_chain",
    ]);
  });
});

// ===========================================================================
// G3 — GUARD: no new worker processor file added under services/worker/src
// ===========================================================================

describe("Phase 13 G3 — no new worker processor file added", () => {
  it("services/worker/src holds exactly the pre-Phase-13 processor baseline", () => {
    // Baseline pre-Phase 13: derived-assets, media-intelligence,
    // ots-upgrade, search-indexing. Phase 13 forbids adding any new
    // *.processor.ts file — text-similarity must live inside the
    // existing media-intelligence.processor.ts. A fifth processor
    // file would fail this assertion.
    //
    // Phase 16 (D) — rebaseline: live indexing introduces the new
    // mi-embed.processor.ts which the API-side mi-embed-queue.ts feeds.
    // The new processor is a producer/consumer of the dedicated
    // mi-embed BullMQ queue and is intentionally a separate file so it
    // owns its own bounded wall-clock budget. Adding it here is the
    // expected drift from the Phase 13 baseline — any further new
    // processor file must still fail this guard.
    const entries = readdirSync(WORKER_SRC_DIR);
    const processors = entries
      .filter((name) => /\.processor\.(ts|js)$/.test(name))
      .sort();
    expect(processors, processors.join("\n")).toEqual([
      "derived-assets.processor.ts",
      "media-intelligence.processor.ts",
      "mi-embed.processor.ts",
      "ots-upgrade.processor.ts",
      "search-indexing.processor.ts",
    ]);
  });
});

// ===========================================================================
// G4 — GUARD: core daily routes keep sidebarEligible + commandPaletteVisible
// ===========================================================================

describe("Phase 13 G4 — core daily routes remain sidebar + cmd-K discoverable", () => {
  const registry = readSrc(ROUTE_REGISTRY);

  // Routes the Phase 13 brief explicitly pins as core daily surfaces
  // that must NOT be hidden by Phase 13 (intelligence-chain work is
  // additive — never demotes core navigation).
  //
  // Each entry maps the canonical route id used in routeRegistry.ts
  // to the sidebar+palette assertion.
  const CORE_ROUTES: ReadonlyArray<{
    id: string;
    requiresSidebar: boolean;
    requiresPalette: boolean;
  }> = [
    // Workspace-tier daily surfaces — both sidebar + palette.
    { id: "workspace.home",     requiresSidebar: true,  requiresPalette: true },
    { id: "workspace.capture",  requiresSidebar: true,  requiresPalette: true },
    { id: "workspace.evidence", requiresSidebar: true,  requiresPalette: true },
    { id: "workspace.cases",    requiresSidebar: true,  requiresPalette: true },
    { id: "workspace.search",   requiresSidebar: true,  requiresPalette: true },
    // Account-tier (Billing / Settings) — registry convention is
    // sidebarEligible:false (they live in the account menu, not the
    // sidebar) BUT must remain command-palette-visible. The Phase 13
    // brief calls them "core daily" for discoverability; this guard
    // pins the palette flag and tolerates the canonical sidebar flag.
    { id: "account.billing",    requiresSidebar: false, requiresPalette: true },
    { id: "account.settings",   requiresSidebar: false, requiresPalette: true },
  ];

  for (const { id, requiresSidebar, requiresPalette } of CORE_ROUTES) {
    it(`route "${id}" keeps the canonical discoverability flags`, () => {
      // Find the bounded definition block for this route id. The
      // registry uses a single-line `id: "..."` followed by the
      // definition body, terminated by the next `id: "` or end of
      // array. We scan a bounded window after the id marker.
      const idMarker = new RegExp(`id:\\s*"${id.replace(/\./g, "\\.")}"`);
      const idMatch = idMarker.exec(registry);
      expect(idMatch, `route id "${id}" not found in routeRegistry.ts`).not.toBeNull();
      const startIdx = idMatch?.index ?? 0;
      // Bounded definition window: 2000 chars is comfortably more
      // than the largest single RouteDefinition in the registry.
      const block = registry.slice(startIdx, startIdx + 2000);

      const sidebarMatch = /sidebarEligible:\s*(true|false)/.exec(block);
      const paletteMatch = /commandPaletteVisible:\s*(true|false)/.exec(block);

      expect(sidebarMatch, `sidebarEligible missing on "${id}"`).not.toBeNull();
      expect(paletteMatch, `commandPaletteVisible missing on "${id}"`).not.toBeNull();

      if (requiresSidebar) {
        expect(sidebarMatch?.[1]).toBe("true");
      }
      if (requiresPalette) {
        expect(paletteMatch?.[1]).toBe("true");
      }
    });
  }
});
