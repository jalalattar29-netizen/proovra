/**
 * Phase 13 — Intelligence chain source-contract + GUARD test.
 *
 * Phase 13 is a "connect + extend" pass over the already-shipped
 * intelligence plumbing (see
 * `docs/architecture/phase-13-intelligence-chain.md`).  It wires:
 *
 *   1. ENTITY_GRAPH_EDGE_WIRE — `reconcileTeamGraph` upserts ENTITY
 *      nodes + EXTRACTED_FROM edges from `evidence_entities`.
 *   2. NEW_MIGRATION_ADDITIVE — `20270601000000_phase13_intelligence_chain`
 *      adds `graph_edge_id` (nullable FK) to `evidence_similarities`,
 *      widens the node_kind CHECK with `ENTITY`, and widens the
 *      edge_type CHECK with `EXTRACTED_FROM`.  All inside DO $$ /
 *      pg_tables guards (Phase O additive pattern).
 *   3. TIMELINE_UNION_EXTEND — extracted-text + entity-extraction
 *      branches added to the per-evidence timeline UNION (gated on
 *      `evidenceId`).
 *   4. DOC_SIMILARITY_WORKER + TRANSCRIPT_SIMILARITY_WORKER — one
 *      shared handler in the EXISTING `media-intelligence.processor.ts`
 *      via the `reconcile` job kind + new `textKind` payload field.
 *   5. SEARCH_INDEXER_WIRE — `indexEvidence` appends `[entity]` chunks
 *      built from the evidence's `analyzedEntities` rows.
 *   6. CROSS_EVIDENCE_ENDPOINT — `GET /v1/investigation/cross-evidence`
 *      route registered on the EXISTING `intelligence.routes.ts`;
 *      backed by a new `listCrossEvidenceFindings` service method.
 *   7. NEW_TYPED_API_CLIENT — `apps/web/lib/api/intelligence.ts`
 *      exports `getCrossEvidenceFindings`.
 *   8. UI_SURFACE_EXISTING_DATA — `/investigation` mounts a new
 *      `Cross-Evidence Findings` card with chips that deep-link to
 *      `/search?q=<normalizedValue>`.
 *   9. EMPTY_STATE_COPY — `/search` renders a disabled-state pill
 *      indicating semantic search is unavailable (keyword-only).
 *
 * GUARDS (bounded by the Phase 13 ground rules):
 *   * NO new file matches `*v2*|*_new*|*_v2*` under apps/web,
 *     services/api, services/worker, packages/shared-runtime.
 *   * EXACTLY ONE Phase 13 migration directory exists.
 *   * NO new worker processor file (services/worker/src has the same
 *     processor file count as before — only `media-intelligence.processor.ts`
 *     is modified).
 *
 * Style: source-contract (file-text `readFileSync`), matching
 * `phase-12-investigation-productization.test.ts`.  Production code
 * is the source of truth.  Assertions are tolerant of formatting /
 * argument-order variation.
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
const INTELLIGENCE_CLIENT = resolve(
  WEB_ROOT,
  "lib/api/intelligence.ts",
);
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

function readSrc(path: string): string {
  return readFileSync(path, "utf8");
}

// ===========================================================================
// ENTITY_GRAPH_EDGE_WIRE — reconcileTeamGraph reads entity rows and writes
// ENTITY nodes + EXTRACTED_FROM edges.
// ===========================================================================

describe("Phase 13 ENTITY_GRAPH_EDGE_WIRE — reconcileTeamGraph wires entity nodes + edges", () => {
  const src = readSrc(GRAPH_BUILDER);

  it("references the evidence_entities table from the reconciler", () => {
    expect(src).toMatch(/evidence_entities/);
  });

  // Wave 1 taxonomy: ENTITY → EXTRACTED_ENTITY rename. Producers
  // now write the canonical EXTRACTED_ENTITY name; old ENTITY rows
  // remain valid via the deprecated alias in the catalog + CHECK.
  it("upserts EXTRACTED_ENTITY nodes via the existing upsertNode helper", () => {
    expect(src).toMatch(/upsertNode\([^)]*"EXTRACTED_ENTITY"/);
  });

  it("writes EXTRACTED_FROM edges via the existing upsertEdge helper", () => {
    expect(src).toMatch(/"EXTRACTED_FROM"/);
  });

  it("wraps the ENTITY domain section in try/catch (best-effort, never fails reconcile)", () => {
    // The entity reconcile block is the last `try {` before
    // section 2 (MEDIA_SIGNAL). Tolerate formatting.
    expect(src).toMatch(/Phase 13 — ENTITY domain reconciliation[\s\S]{0,4000}\}\s*catch\b/);
  });
});

describe("Phase 13 ENTITY_GRAPH_EDGE_WIRE — graph-catalog widens with ENTITY + EXTRACTED_FROM", () => {
  const src = readSrc(GRAPH_CATALOG);

  it("adds ENTITY to GRAPH_NODE_KINDS", () => {
    expect(src).toMatch(/"ENTITY"/);
  });

  it("adds EXTRACTED_FROM to GRAPH_EDGE_TYPES", () => {
    expect(src).toMatch(/"EXTRACTED_FROM"/);
  });
});

// ===========================================================================
// NEW_MIGRATION_ADDITIVE — single Phase 13 migration directory.
// ===========================================================================

describe("Phase 13 NEW_MIGRATION_ADDITIVE — additive Phase 13 migration", () => {
  it("the Phase 13 migration directory exists", () => {
    expect(existsSync(PHASE_13_MIGRATION_DIR)).toBe(true);
    expect(statSync(PHASE_13_MIGRATION_DIR).isDirectory()).toBe(true);
  });

  it("the migration.sql file exists inside the directory", () => {
    expect(existsSync(PHASE_13_MIGRATION_SQL)).toBe(true);
  });

  const sql = readSrc(PHASE_13_MIGRATION_SQL);

  it("adds the graph_edge_id column with ADD COLUMN IF NOT EXISTS and a terminating ;", () => {
    expect(sql).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"graph_edge_id"[\s\S]*?UUID[^;]*;/i,
    );
  });

  it("creates the partial graph_edge_id index with a terminating ;", () => {
    expect(sql).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"evidence_similarities_graph_edge_id_idx"[\s\S]*?;/i,
    );
  });

  it("widens investigation_graph_nodes CHECK with ENTITY", () => {
    expect(sql).toMatch(/investigation_graph_nodes_kind_bounded/);
    expect(sql).toMatch(/'ENTITY'/);
  });

  it("widens investigation_graph_edges CHECK with EXTRACTED_FROM", () => {
    expect(sql).toMatch(/investigation_graph_edges_type_bounded/);
    expect(sql).toMatch(/'EXTRACTED_FROM'/);
  });

  it("performs NO destructive operations in executable SQL (other than the CHECK constraint replacement)", () => {
    const executable = sql
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    expect(executable).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(executable).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(executable).not.toMatch(/\bRENAME\b/i);
  });
});

describe("Phase 13 NEW_MIGRATION_ADDITIVE — schema.prisma mirror", () => {
  const schema = readSrc(SCHEMA_PRISMA);

  it("declares graphEdgeId mapped to graph_edge_id on EvidenceSimilarity", () => {
    expect(schema).toMatch(
      /graphEdgeId[\s\S]{0,80}@map\(\s*"graph_edge_id"\s*\)/,
    );
  });
});

// ===========================================================================
// TIMELINE_UNION_EXTEND — extracted-text + entity event branches.
// ===========================================================================

describe("Phase 13 TIMELINE_UNION_EXTEND — extracted-text and entity events", () => {
  const src = readSrc(GRAPH_BUILDER);

  it("declares EXTRACTED_TEXT_COMPLETED in the TimelineEventKind union", () => {
    expect(src).toMatch(/"EXTRACTED_TEXT_COMPLETED"/);
  });

  it("declares ENTITY_EXTRACTED in the TimelineEventKind union", () => {
    expect(src).toMatch(/"ENTITY_EXTRACTED"/);
  });

  it("unions evidence_extracted_texts when evidenceId is set", () => {
    expect(src).toMatch(/evidence_extracted_texts/);
  });

  it("unions evidence_entities (alias ent.) on the timeline", () => {
    expect(src).toMatch(/FROM\s+"evidence_entities"\s+ent\b/);
  });
});

// ===========================================================================
// DOC_SIMILARITY_WORKER + TRANSCRIPT_SIMILARITY_WORKER — same handler.
// ===========================================================================

describe("Phase 13 DOC/TRANSCRIPT_SIMILARITY_WORKER — single shared handler in existing processor", () => {
  it("services/worker/src/queue.ts extends MediaIntelligenceJobPayload with textKind: 'OCR' | 'TRANSCRIPT'", () => {
    const src = readSrc(WORKER_QUEUE);
    expect(src).toMatch(/textKind\?\s*:\s*"OCR"\s*\|\s*"TRANSCRIPT"/);
  });

  it("services/worker/src/media-intelligence.processor.ts handles the textKind branch on `reconcile`", () => {
    const src = readSrc(WORKER_PROCESSOR);
    expect(src).toMatch(/kind\s*===\s*"reconcile"\s*&&\s*job\.data\?.textKind/);
    expect(src).toMatch(/processTextSimilarityPromotion/);
  });

  it("promotes EvidenceSimilarity rows to SIMILAR_TO investigation_graph_edges", () => {
    const src = readSrc(WORKER_PROCESSOR);
    expect(src).toMatch(/SIMILAR_TO/);
    expect(src).toMatch(/investigation_graph_edges/);
  });

  it("back-references the resulting edge id via UPDATE evidence_similarities SET graph_edge_id", () => {
    const src = readSrc(WORKER_PROCESSOR);
    expect(src).toMatch(/UPDATE\s+"evidence_similarities"[\s\S]{0,200}"graph_edge_id"/);
  });

  it("uses a shingle + Jaccard implementation (no heavy npm dep)", () => {
    const src = readSrc(WORKER_PROCESSOR);
    expect(src).toMatch(/computeShingleSet/);
    expect(src).toMatch(/function\s+jaccard\s*\(/);
  });

  it("uses confidence bands LOW < 0.30, MEDIUM 0.30-0.60, HIGH > 0.60", () => {
    const src = readSrc(WORKER_PROCESSOR);
    expect(src).toMatch(/TEXT_SIM_LOW_BAND\s*=\s*0\.30/);
    expect(src).toMatch(/TEXT_SIM_HIGH_BAND\s*=\s*0\.60/);
  });
});

// ===========================================================================
// SEARCH_INDEXER_WIRE — buildEvidenceProjection eats entity chunks.
// ===========================================================================

describe("Phase 13 SEARCH_INDEXER_WIRE — entity-name chunks land in searchable text", () => {
  const src = readSrc(SEARCH_INDEXING_SERVICE);

  it("reads from evidenceEntity for the indexed evidence", () => {
    expect(src).toMatch(/evidenceEntity\.findMany/);
  });

  it("appends `[entity] {normalizedValue}` chunks to the extracted text projection", () => {
    expect(src).toMatch(/\[entity\]/);
  });
});

// ===========================================================================
// CROSS_EVIDENCE_ENDPOINT — service method + route registration.
// ===========================================================================

describe("Phase 13 CROSS_EVIDENCE_ENDPOINT — service method", () => {
  const src = readSrc(ENTITY_EXTRACTION_SERVICE);

  it("exports listCrossEvidenceFindings from the entity-extraction service", () => {
    expect(src).toMatch(/export\s+async\s+function\s+listCrossEvidenceFindings/);
  });

  it("groups by (kind, normalized_value) in raw SQL (no new Prisma table)", () => {
    expect(src).toMatch(/GROUP\s+BY[\s\S]{0,200}"normalized_value"/i);
  });

  it("returns only findings with evidenceCount > 1", () => {
    expect(src).toMatch(/HAVING\s+COUNT\(DISTINCT[\s\S]{0,80}>\s*1/i);
  });

  it("clamps the result LIMIT to 20", () => {
    expect(src).toMatch(/Math\.min\([^)]*,\s*20\)/);
  });
});

describe("Phase 13 CROSS_EVIDENCE_ENDPOINT — route registration", () => {
  const src = readSrc(INTELLIGENCE_ROUTES);

  it("imports listCrossEvidenceFindings from the entity-extraction service", () => {
    expect(src).toMatch(/listCrossEvidenceFindings/);
  });

  it("registers GET /v1/investigation/cross-evidence", () => {
    expect(src).toMatch(/"\/v1\/investigation\/cross-evidence"/);
  });
});

// ===========================================================================
// NEW_TYPED_API_CLIENT — getCrossEvidenceFindings on the web client.
// ===========================================================================

describe("Phase 13 NEW_TYPED_API_CLIENT — getCrossEvidenceFindings", () => {
  const src = readSrc(INTELLIGENCE_CLIENT);

  it("exports the typed getCrossEvidenceFindings function", () => {
    expect(src).toMatch(/export\s+async\s+function\s+getCrossEvidenceFindings/);
  });

  it("exports the CrossEvidenceFinding type", () => {
    expect(src).toMatch(/export\s+type\s+CrossEvidenceFinding/);
  });

  it("calls /v1/investigation/cross-evidence (no new route family)", () => {
    expect(src).toMatch(/\/v1\/investigation\/cross-evidence/);
  });

  it("uses the existing apiFetch helper (no bespoke fetch layer)", () => {
    expect(src).toMatch(/apiFetch/);
  });
});

// ===========================================================================
// UI_SURFACE_EXISTING_DATA — investigation page renders the card.
// ===========================================================================

describe("Phase 13 UI_SURFACE_EXISTING_DATA — Cross-Evidence Findings card on /investigation", () => {
  const src = readSrc(INVESTIGATION_PAGE);

  it("imports the typed cross-evidence client", () => {
    expect(src).toMatch(/getCrossEvidenceFindings/);
  });

  it("renders a section labelled 'Cross-Evidence Findings'", () => {
    expect(src).toMatch(/Cross-Evidence Findings/);
  });

  it("renders a CrossEvidenceFindingsCard component", () => {
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
// EMPTY_STATE_COPY — disabled-state pill on /search.
// ===========================================================================

describe("Phase 13 EMPTY_STATE_COPY — semantic-search disabled pill on /search", () => {
  const src = readSrc(SEARCH_PAGE);

  it("renders an operator-safe disabled-state indicator", () => {
    expect(src).toMatch(/Semantic search not available/);
    expect(src).toMatch(/keyword search active/);
  });

  it("uses the data-semantic-search-status attribute for the chip", () => {
    // Phase 15 evolution: the chip's status is now driven dynamically —
    // it can be "disabled" (semantic off), "active" (hybrid/semantic
    // mode + provider available), or "unavailable" (admin selected
    // semantic but no provider configured). The attribute is therefore
    // emitted from a JSX expression (`data-semantic-search-status={status}`)
    // rather than a string literal. The Phase 13 intent — that the chip
    // exposes this attribute for selector-based observability — is
    // preserved. Accept either the legacy literal OR the new JSX form.
    expect(src).toMatch(
      /data-semantic-search-status=(?:"disabled"|\{status\})/,
    );
  });

  it("does not leak internal config / env-var names in the chip copy", () => {
    // The chip copy stays within bounded operator vocabulary — must
    // not mention SEMANTIC_SEARCH_ENABLED / OPENAI_EMBEDDING_MODEL /
    // pgvector / qdrant / weaviate / similar internal names.
    const chipBlock = src.match(/Semantic search not available[\s\S]{0,200}/);
    expect(chipBlock).not.toBeNull();
    const chipText = chipBlock?.[0] ?? "";
    expect(chipText).not.toMatch(
      /SEMANTIC_SEARCH_ENABLED|OPENAI_EMBEDDING_MODEL|pgvector|qdrant|weaviate/i,
    );
  });
});

// ===========================================================================
// GUARD — no v2 / _new / _v2 files under any tree.
// ===========================================================================

describe("Phase 13 GUARD — no v2 / _new / _v2 files in affected trees", () => {
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

  const FORBIDDEN_BASENAMES =
    /(ocr|transcript|entity|graph|search|similarity|timeline|intelligence|cross[-_]?evidence)[._-]?(v2|new|_v2)\b/i;

  it("apps/web has no new v2 file under the affected capability families", () => {
    const files = walk(resolve(WEB_ROOT, "app"));
    const offenders = files
      .map((p) => p.replace(/\\/g, "/"))
      .filter((p) => {
        const base = p.split("/").pop() ?? "";
        return FORBIDDEN_BASENAMES.test(base);
      });
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("services/api/src has no new v2 file under the affected capability families", () => {
    const files = walk(resolve(API_ROOT, "src"));
    const offenders = files
      .map((p) => p.replace(/\\/g, "/"))
      .filter((p) => {
        const base = p.split("/").pop() ?? "";
        return FORBIDDEN_BASENAMES.test(base);
      });
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("services/worker/src has no new v2 file under the affected capability families", () => {
    const files = walk(resolve(WORKER_ROOT, "src"));
    const offenders = files
      .map((p) => p.replace(/\\/g, "/"))
      .filter((p) => {
        const base = p.split("/").pop() ?? "";
        return FORBIDDEN_BASENAMES.test(base);
      });
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("packages/shared-runtime/src has no new v2 file under the affected capability families", () => {
    const files = walk(resolve(SHARED_RUNTIME_ROOT, "src"));
    const offenders = files
      .map((p) => p.replace(/\\/g, "/"))
      .filter((p) => {
        const base = p.split("/").pop() ?? "";
        return FORBIDDEN_BASENAMES.test(base);
      });
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

// ===========================================================================
// GUARD — exactly ONE Phase 13 migration directory.
// ===========================================================================

describe("Phase 13 GUARD — exactly one Phase 13 intelligence-chain migration", () => {
  it("the migrations directory contains exactly one entry matching the Phase 13 intelligence-chain sentinel name", () => {
    // The Phase 13 (intelligence chain) brief permits exactly one
    // additive migration. Earlier phases reused the literal token
    // "phase13" for unrelated review-operations work
    // (`20260521100000_add_review_operations_phase13`,
    // `20260522100000_add_review_sla_defaults_phase13_5`); those
    // are NOT in scope here. We match only the
    // `phase13_intelligence_chain` slug introduced by this phase.
    const entries = readdirSync(MIGRATIONS_DIR);
    const intelligenceChain = entries.filter((name) =>
      /phase13_intelligence_chain/i.test(name),
    );
    expect(intelligenceChain, intelligenceChain.join("\n")).toEqual([
      "20270601000000_phase13_intelligence_chain",
    ]);
  });

  it("no other migration directory was added with the Phase 13 intelligence-chain timestamp prefix", () => {
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
// GUARD — no new worker processor file added.
// ===========================================================================

describe("Phase 13 GUARD — no new worker processor file added", () => {
  it("services/worker/src contains exactly the pre-Phase-13 processor baseline", () => {
    // Pre-Phase-13 baseline: 4 processor files lived in
    // services/worker/src already (derived-assets, media-intelligence,
    // ots-upgrade, search-indexing). Phase 13 explicitly forbids
    // adding any new processor file — only `media-intelligence.processor.ts`
    // may be modified to host the new text-similarity branch. This
    // guard pins the file count so a fifth processor would fail the
    // suite.
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
