# Phase 13 — Intelligence chain wiring

Date: 2026-06-02
Author: agent-13
Status: SHIPPED

Phase 13 closes the intelligence chain
**Evidence → OCR → Transcript → Entities → Relationships → Graph → Timeline → Search → Similarity → Cross-Evidence Intelligence**
by wiring storage that Phases 11, 12 and 15 already shipped — without adding a v2 layer for any capability.

This document captures the contracts the phase commits to and the deliberately deferred surfaces.

## 1. What changed

| # | Kind | File |
|---|---|---|
| 1 | ENTITY_GRAPH_EDGE_WIRE | `packages/shared-runtime/src/graph/graph-builder.service.ts` — new section 1j inside `reconcileTeamGraph`, upserts `ENTITY` nodes + `EXTRACTED_FROM` edges from `evidence_entities`. |
| 2 | GRAPH_CATALOG | `packages/shared-runtime/src/graph/graph-catalog.ts` — `GRAPH_NODE_KINDS` gains `ENTITY`; `GRAPH_EDGE_TYPES` gains `EXTRACTED_FROM`. |
| 3 | NEW_MIGRATION_ADDITIVE | `services/api/prisma/migrations/20270601000000_phase13_intelligence_chain/migration.sql` — adds nullable `graph_edge_id` UUID FK on `evidence_similarities` with partial index; widens the two CHECK constraints (`investigation_graph_nodes.node_kind` adds `ENTITY`; `investigation_graph_edges.edge_type` adds `EXTRACTED_FROM`). Phase O additive pattern throughout. |
| 4 | SCHEMA_MIRROR | `services/api/prisma/schema.prisma` — `EvidenceSimilarity` gains `graphEdgeId` (`@map("graph_edge_id")`) + `@@index([graphEdgeId])`. |
| 5 | TIMELINE_UNION_EXTEND | `packages/shared-runtime/src/graph/graph-builder.service.ts` — `buildInvestigationTimeline` unions two more event branches when `evidenceId` is supplied: `EXTRACTED_TEXT_COMPLETED` (from `evidence_extracted_texts.status='COMPLETED'`) and `ENTITY_EXTRACTED` (from `evidence_entities`). Both also added to the `TimelineEventKind` union. |
| 6 | DOC_SIMILARITY_WORKER + TRANSCRIPT_SIMILARITY_WORKER | `services/worker/src/media-intelligence.processor.ts` — new branch on the existing `reconcile` job kind. When `payload.textKind` is `"OCR"` or `"TRANSCRIPT"`, the worker computes shingle-set Jaccard similarity across peer extracted-text bodies, UPSERTs `EvidenceSimilarity` rows, and promotes MEDIUM/HIGH-band rows into `SIMILAR_TO` edges on `investigation_graph_edges`. The resulting edge id is written back into `evidence_similarities.graph_edge_id` (one-way promotion only). Worker uses an inline shingle+Jaccard implementation — no heavy NPM dependency. Confidence bands: LOW < 0.30, MEDIUM 0.30-0.60, HIGH > 0.60. Workspace-scoped. Idempotent. Never throws to BullMQ. |
| 7 | WORKER_QUEUE_PAYLOAD | `services/worker/src/queue.ts` — `MediaIntelligenceJobPayload` gains optional `textKind?: "OCR" \| "TRANSCRIPT" \| null`. No new queue, no new job kind enum value. |
| 8 | SEARCH_INDEXER_WIRE | `services/api/src/services/search/evidence-indexing.service.ts` — `indexEvidence` reads up to 100 entity rows for the evidence and appends `[entity] {normalizedValue}` chunks to the `extractedTextChunks` array consumed by the shared `buildEvidenceProjection`. The keyword search already covers OCR + transcript text; entity names now flow through the same path. |
| 9 | CROSS_EVIDENCE_ENDPOINT | `services/api/src/routes/intelligence.routes.ts` — new `GET /v1/investigation/cross-evidence?teamId=&limit=` route handler. Bounded LIMIT 20. Workspace-scoped. Backed by `listCrossEvidenceFindings(teamId, limit)` in `services/api/src/services/intelligence/entity-extraction.service.ts` — raw GROUP BY on `evidence_entities (team_id, kind, normalized_value) HAVING COUNT(DISTINCT evidence_id) > 1`. |
| 10 | NEW_TYPED_API_CLIENT | `apps/web/lib/api/intelligence.ts` — adds `getCrossEvidenceFindings(teamId, limit?)` typed wrapper + `CrossEvidenceFinding` / `CrossEvidenceFindingsResponse` types. Uses the existing `apiFetch` helper. |
| 11 | UI_SURFACE_EXISTING_DATA | `apps/web/app/(app)/investigation/page.tsx` — adds a "Cross-Evidence Findings" card. Each finding is rendered as a chip with the entity kind, evidence count, normalized value, and a deep-link to `/search?q=<normalizedValue>`. Uses `useTeamId` (no `envelope.workspace.*`); no `window.confirm`; bounded operator vocabulary. |
| 12 | EMPTY_STATE_COPY | `apps/web/app/(app)/search/page.tsx` — adds an operator-readable disabled-state pill: "Semantic search not available — keyword search active". No internal env-var or config names leak into the UI. |
| 13 | TEST | `services/api/test/phase-13-intelligence-chain.test.ts` — source-contract test pinning every Phase 13 wiring + bounded GUARD assertions. |
| 14 | DOC | `docs/architecture/phase-13-intelligence-chain.md` — this file. |

## 2. EvidenceSimilarity ↔ SIMILAR_TO promotion contract

Two storage shapes existed before Phase 13 for "these two evidence items are alike":

- **`evidence_similarities`** (Phase 15) — operator-visible audit row keyed by `(sourceEvidenceId, targetEvidenceId, kind)` where `kind` is one of `HASH_DUPLICATE | FILENAME_SIMILAR | OCR_SIMILAR | TRANSCRIPT_SIMILAR | METADATA_SIMILAR | EMBEDDING_SIMILAR`. Carries a 0..1 `score` + bounded `advisorySummary`.
- **`investigation_graph_edges` with `edge_type=SIMILAR_TO`** (Phase 12) — graph hint for traversal/UI keyed by `(team_id, source_node_id, target_node_id, edge_type)`. Carries `confidence` + `safe_summary`.

These are NOT duplicates — they serve different surfaces (audit list vs graph traversal). Phase 13 introduces a deliberately **one-way promotion**:

1. Worker runs text-similarity for an evidence (`textKind=OCR` or `TRANSCRIPT`).
2. For each peer with Jaccard ≥ 0.30, UPSERT `evidence_similarities` row.
3. For rows in the MEDIUM (≥ 0.30) or HIGH (> 0.60) band, UPSERT `investigation_graph_edges` with `edge_type=SIMILAR_TO`.
4. Back-write `evidence_similarities.graph_edge_id = <edge.id>` so an operator pivoting from the graph can find the audit row.

The graph never writes back into `evidence_similarities`. The audit row remains authoritative for operator review; the graph row is derived.

## 3. Semantic search decision

**Deferred to Phase 14.** Discovery confirmed no embedding provider is configured (no `OPENAI_EMBEDDING_MODEL`, no pgvector, no qdrant/weaviate client, no embedding columns wired into the search path even though `EvidenceSemanticChunk.embedding` exists as a forward-compatible byte column). Per the absolute no-V2 rule and the brief's "embeddings ONLY if config/provider already exists" clause, Phase 13 did not introduce a provider integration. Instead:

- Keyword + OCR + transcript indexing remains (Phase 11/15).
- Entity-name chunks are now appended to the same searchable column (item #8 above).
- A disabled-state pill on `/search` makes the boundary visible to operators in bounded language.

Phase 14 scope (carry-forward):
1. Embedding provider contract decision + column wiring.
2. Hybrid keyword + vector ranker.
3. MinHash/LSH for cross-workspace similarity at scale (Phase 13 uses pair-wise Jaccard up to 200 peers; fine for current volumes).
4. Entity disambiguation / canonicalization beyond regex normalisation.
5. Similarity event stream in the timeline (requires denormalised `updated_at` on similarity rows or a new event table).
6. ENTITY-to-ENTITY cross-evidence edges (`MENTIONED_WITH`) — Phase 13 only writes ENTITY → EVIDENCE.
7. Confidence scoring on `EvidenceEntity.confidence` (currently null).

## 4. Cross-evidence intelligence decision

ONE thin endpoint, ONE UI card.

- Endpoint: `GET /v1/investigation/cross-evidence?teamId=<uuid>&limit=20`.
- Service method: `listCrossEvidenceFindings(teamId, limit)` — raw GROUP BY on `evidence_entities` using the existing `(team_id, kind, normalized_value)` index; HAVING COUNT(DISTINCT evidence_id) > 1.
- Response shape (operator-readable): each finding carries an `operatorSummary` like `"This phone appears in 3 evidence records."` plus up to 5 sample evidence ids.
- UI: a card on `/investigation` with chips that deep-link to `/search?q=<normalizedValue>`. The keyword search already indexes OCR + transcript + entity names (after item #8), so the click lands on the full result set.

No new Prisma table. No plan gating. Workspace-scoped by `teamId` WHERE clause; anti-enumeration via the same `requireMember` check used by `/v1/intelligence/evidence/:id`.

## 5. Hard-no list (re-asserted)

- NO new worker file (only `media-intelligence.processor.ts` modified).
- NO new queue (only the existing `mediaIntelligenceQueue` `reconcile` job kind is extended via the new `textKind` payload field).
- NO new Prisma table (only one new nullable FK column + two CHECK constraint widenings).
- NO `method` column on `investigation_graph_edges` (would touch the hot graph-edges table; the `graph_edge_id` back-reference lives on `evidence_similarities` instead).
- NO embedding provider integration.
- NO new pages or route families.
- NO renames, no `v2`/`_new`/`_v2` files.
- NO raw OCR/transcript text in audit logs — entity events log kind + normalizedValue only.
- NO `window.confirm`, NO `envelope.workspace.*`, NO raw env-var names in UI.
- NO ENTITY-to-ENTITY edges (`MENTIONED_WITH`) — deferred to Phase 14.
- NO MinHash/LSH/ANN indexing — deferred to Phase 14.

## 6. Permitted migration audit summary

Exactly one Phase 13 migration directory:

```
services/api/prisma/migrations/20270601000000_phase13_intelligence_chain/migration.sql
```

Contents:
1. `ALTER TABLE evidence_similarities ADD COLUMN IF NOT EXISTS graph_edge_id UUID NULL;`
2. Nullable FK constraint with table + column existence guards; `ON DELETE SET NULL`.
3. Partial `CREATE INDEX IF NOT EXISTS evidence_similarities_graph_edge_id_idx WHERE graph_edge_id IS NOT NULL`.
4. CHECK constraint widening on `investigation_graph_nodes.node_kind` to add `'ENTITY'`.
5. CHECK constraint widening on `investigation_graph_edges.edge_type` to add `'EXTRACTED_FROM'`.

Every CREATE/ALTER lives inside a `DO $$ ... $$` block guarded by `pg_tables` (and `information_schema.columns` for column-existence) — partial-state DBs degrade to a clean no-op. No DROP TABLE, no DROP COLUMN, no RENAME. Each statement ends with a terminating `;`.

## 7. Test coverage

`services/api/test/phase-13-intelligence-chain.test.ts` pins:

1. Entity wiring (reconciler) — ENTITY upsert + EXTRACTED_FROM emission + try/catch isolation.
2. Migration — column add, partial index, two CHECK widenings, no destructive ops.
3. Schema mirror — `graphEdgeId` mapped to `graph_edge_id`.
4. Timeline — two new TimelineEventKind values + two new UNION branches.
5. Worker — `textKind` payload + shared `reconcile` branch + SIMILAR_TO promotion + `graph_edge_id` back-reference + shingle/Jaccard + confidence bands.
6. Search indexer — entity chunks land in projection.
7. Cross-evidence — service method shape + route registration.
8. Typed client — exported function + type + endpoint path.
9. UI — investigation page card + deep-link + `useTeamId`/no `window.confirm`.
10. Search disabled chip — operator-safe copy with no env-var leak.
11. GUARD — no v2 files in any tree, exactly one Phase 13 migration, no new worker processor file.
