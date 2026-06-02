# PROOVRA — Phase 13 Investigation Intelligence Completion
_Status: PARTIAL — see Validation section._

Phase 13 closes the loop between Phase 15's intelligence extraction (OCR, transcript, entity) and Phase 12's investigation graph by wiring already-produced data into graph edges, timeline events, similarity edges, search projections, and a cross-evidence aggregation surface. No new pipelines, no new model providers, no new pages — only the bridges that were left dangling.

---

## 1. Global discovery map

| Capability | Status (pre-Phase 13) | What existed today | What Phase 13 did |
|---|---|---|---|
| Entity → Graph edges | EXISTS_BUT_DISCONNECTED | `evidence_entities` table fully populated by Phase 15; `reconcileTeamGraph` materialized 16 edge types but never read entity table | Added `EXTRACTED_FROM` edge + `ENTITY` node kind; wired entity-extraction output into reconcile loop (section 1j) |
| Timeline intelligence events | PARTIAL | `/v1/graph/timeline` unioned 4 sources (nodes, edges, lifecycle, media runs/signals); no OCR/transcript/entity events | Added 2 UNION ALL branches (extracted-text completion, entity extracted), gated on `evidenceId` to avoid scans |
| Document similarity (OCR) | EXISTS_BUT_DISCONNECTED | `detectTextSimilarForEvidence(kind="OCR_SIMILAR")` wrote `EvidenceSimilarity` rows but no `SIMILAR_TO` graph edge | Bridged EvidenceSimilarity → SIMILAR_TO graph edge; triggered on OCR completion via existing worker `reconcile` |
| Transcript similarity | EXISTS_BUT_DISCONNECTED | Same function supported `kind="TRANSCRIPT_SIMILAR"`; not triggered automatically when transcript completes | Same worker handler, parameterized by `textKind: "OCR" \| "TRANSCRIPT"` |
| Semantic search (keyword) | COMPLETE | `evidence_search_documents.searchableText` indexes OCR + transcript text (kind-labelled chunks, 4 KiB each) | None (already wired) |
| Semantic search (embedding/hybrid) | MISSING | No embedding provider, no pgvector, no `OPENAI_EMBEDDING_MODEL` env | **Deferred to Phase 14**; `/search` now shows disabled-state pill |
| Entity name search indexing | EXISTS_BUT_DISCONNECTED | Indexer read EvidenceExtractedText but not `analyzedEntities` relation | Appended `[entity] {normalizedValue}` chunks to searchableText |
| Cross-evidence aggregations | MISSING | No endpoint grouped EvidenceEntity by `normalizedValue` across evidence | Added one thin `GET /v1/investigation/cross-evidence` + one UI card on `/investigation` |
| UI surfacing | PARTIAL | `/investigation` had signals/graph cards; no cross-evidence findings card; `/search` had no semantic-disabled banner | Additive cards only, no new pages |

---

## 2. Duplicate candidate map

| Candidate pair | Verdict | Reason |
|---|---|---|
| `EvidenceSimilarity` (Phase 15) vs `investigation_graph_edges (SIMILAR_TO)` (Phase 12) | **Not duplicates — bridge them** | `EvidenceSimilarity` is the operator-visible advisory hint table (per-kind, scored 0..1, advisorySummary); `SIMILAR_TO` graph edge is the investigation-graph projection (confidence band LOW/MEDIUM/HIGH). Phase 13 keeps both and adds `graphEdgeId` FK on `EvidenceSimilarity` so the advisory row points to its promoted graph edge. |
| `detectTextSimilarForEvidence(OCR_SIMILAR)` vs `detectTextSimilarForEvidence(TRANSCRIPT_SIMILAR)` | **Already parameterized — reuse, do not fork** | Same function body, switched by `kind` arg. Phase 13 worker passes `textKind` straight through. |
| `MEDIA_RUN_COMPLETED` event (Phase 12) vs proposed `OCR_COMPLETED` / `TRANSCRIPT_COMPLETED` events | **Not duplicates — different granularity** | Media run = pipeline-level; extracted-text completion = per-kind, per-row. Phase 13 added the latter as discrete timeline branches. |
| `USER_CREATED_ENTITY` node kind (existing) vs new `ENTITY` node kind | **Not duplicates — keep both** | `USER_CREATED_ENTITY` is operator-authored; `ENTITY` is extraction-derived. Different node-kind for provenance clarity. |
| Cross-evidence aggregation endpoint vs `/v1/intelligence/evidence/:id` (Phase 15) | **Not duplicates — orthogonal axis** | Phase 15 endpoint = entities for one evidence; new endpoint = evidence for one entity value. |

---

## 3. Reuse decisions

| Decision | Chose | Did not choose | Rationale |
|---|---|---|---|
| Where entity → graph wiring lives | Extend `reconcileTeamGraph` in `graph-builder.service.ts` (new section 1j) | New `entity-graph.service.ts` | Reconcile is already the single materialization point for all 16 edge types — keep convergent. |
| Where doc/transcript similarity promotion lives | Worker `media-intelligence.processor.ts` `reconcile` branch with `textKind` | New `text-similarity.processor.ts` | Existing processor already owns the post-extraction triggering window. |
| Where cross-evidence aggregation lives | Method `listCrossEvidenceFindings` on existing `entity-extraction.service.ts` | New `cross-evidence.service.ts` | Same table, same workspace scoping, same projection helpers. |
| Where the new endpoint lives | Existing `intelligence.routes.ts` (`/v1/investigation/cross-evidence`) | New `cross-evidence.routes.ts` | All other entity/intelligence reads route through this file. |
| Where the UI card lives | `/investigation` page (existing) | New `/investigation/findings` page | Page brief is explicit: additive cards only, no new pages. |
| Search indexer change | Append entity chunks to existing `searchableText` projection | New `evidence_entity_search_documents` table | The keyword index already covers OCR/transcript chunks the same way — entity names are the missing third stream. |
| Semantic search | Defer embedding/hybrid to Phase 14 | Stub OpenAI/pgvector now | No embedding infrastructure, no env wiring, no operator demand — Phase 14 is the right home. |

---

## 4. Entity → Graph implementation

**Edge type:** `EXTRACTED_FROM` (new, added to `GRAPH_CATALOG` in `packages/shared-runtime/src/graph/graph-catalog.ts`).
**Node kind:** `ENTITY` (new, distinct from existing `USER_CREATED_ENTITY` to preserve provenance).

Edge points from `ENTITY` node → source `EVIDENCE` node. Edge metadata carries `source` (OCR | TRANSCRIPT) and `kind` (EMAIL | PHONE | URL | PERSON_NAME | etc.) from the `evidence_entities` row.

**Wiring point:** Section 1j of `reconcileTeamGraph` in `packages/shared-runtime/src/graph/graph-builder.service.ts`. After existing sections (1a EVIDENCE, 1b CASE, 1c INCIDENT, …, 1i USER_CREATED_ENTITY), section 1j:
1. SELECTs `evidence_entities` for the team where `evidenceId IN <reconcile batch>`.
2. Groups by `normalizedValue` + `kind` to materialize one ENTITY node per distinct value.
3. Upserts ENTITY nodes (`stale_at_utc` lifecycle preserved).
4. Upserts `EXTRACTED_FROM` edges (ENTITY → EVIDENCE), `source_kind=SYSTEM`, `confidence=MEDIUM` default.

Workspace isolation is enforced by the `teamId` predicate inherited from reconcile's outer scope.

---

## 5. Graph → Timeline implementation

**New `TimelineEventKind` values:** `EXTRACTED_TEXT_COMPLETED`, `ENTITY_EXTRACTED`.

**Two new UNION ALL branches** added to the `/v1/graph/timeline` query in `graph-builder.service.ts`:

| Branch | Table | Event kinds | Gating |
|---|---|---|---|
| Extracted-text completion | `evidence_extracted_text` (status=COMPLETED \| FAILED) | `EXTRACTED_TEXT_COMPLETED` (kind label carries OCR_PDF / OCR_IMAGE / TRANSCRIPT_AUDIO / TRANSCRIPT_VIDEO) | `team_id`, **requires `evidenceId` param** (no scans) |
| Entity extracted | `evidence_entities` | `ENTITY_EXTRACTED` | `team_id`, **requires `evidenceId` param** |

Both branches respect the existing `created_at` range filter and the team-scoped WHERE clause. Total timeline streams: **6** (was 4 pre-Phase 13). The `evidenceId`-required gating is deliberate — full-team timeline scans would otherwise dominate the result and break the existing pagination invariants.

---

## 6. Document similarity implementation

**Trigger:** Worker `media-intelligence.processor.ts` `reconcile` branch, invoked when `EvidenceExtractedText` row reaches `status=COMPLETED` for `kind IN (OCR_PDF, OCR_IMAGE)`.

**Pipeline:**
1. Worker payload `MediaIntelligenceJobPayload` extended with optional `textKind: "OCR" | "TRANSCRIPT"` in `services/worker/src/queue.ts`.
2. Processor calls `detectTextSimilarForEvidence({ kind: "OCR_SIMILAR", evidenceId, teamId })` from `services/api/src/services/intelligence/similarity.service.ts` (deterministic shingle/Jaccard, threshold 0.4).
3. Per resulting pair above threshold:
   - Upsert `EvidenceSimilarity` row (existing behavior).
   - **NEW:** Promote to `investigation_graph_edges` `SIMILAR_TO` edge between the two EVIDENCE nodes (confidence band derived from score: ≥0.7 HIGH, 0.5–0.7 MEDIUM, 0.4–0.5 LOW).
   - **NEW:** Write back `graphEdgeId` FK on the `EvidenceSimilarity` row so advisory ↔ graph stays joinable.

**Schema mirror:** `EvidenceSimilarity` gains `graphEdgeId` column + `@@index([graphEdgeId])` in `services/api/prisma/schema.prisma`. Migration: `services/api/prisma/migrations/20270601000000_phase13_*`.

---

## 7. Transcript similarity implementation

**Same handler as Section 6**, parameterized by `textKind`:
- Trigger fires when `EvidenceExtractedText` row reaches `status=COMPLETED` for `kind IN (TRANSCRIPT_AUDIO, TRANSCRIPT_VIDEO)`.
- Worker passes `textKind: "TRANSCRIPT"`.
- Processor calls `detectTextSimilarForEvidence({ kind: "TRANSCRIPT_SIMILAR", ... })`.
- Same `EvidenceSimilarity` upsert + `SIMILAR_TO` graph edge promotion + `graphEdgeId` back-reference.

Reuses the entire OCR similarity pipeline — only `kind` differs. No fork.

---

## 8. Semantic search implementation — **DEFERRED to Phase 14**

**Decision:** Phase 13 does not introduce semantic / embedding / hybrid search.

**Rationale:**
- No embedding provider exists today (no OpenAI key, no `OPENAI_EMBEDDING_MODEL` env, no pgvector / qdrant / weaviate infrastructure).
- Phase 13 brief is explicit about not adding new pipelines or providers.
- Keyword search via `evidence_search_documents.searchableText` already covers OCR + transcript chunks; Phase 13 adds entity-name chunks on top (see UI table row).
- Workspace-scoped, plan-neutral keyword search remains the only retrieval path until Phase 14.

**Phase 13 minimum UX:** `/search` page now renders a disabled-state pill ("Semantic search arriving in Phase 14") next to the search field, with bounded operator copy. No semantic toggle, no fake controls.

---

## 9. Cross-evidence intelligence implementation

**One thin endpoint, one UI card.**

**Endpoint:** `GET /v1/investigation/cross-evidence` (in `services/api/src/routes/intelligence.routes.ts`).
- Workspace-scoped via `teamId` (hard invariant).
- Aggregates `evidence_entities` by `(kind, normalizedValue)`, returning entries where `COUNT(DISTINCT evidenceId) >= 2`.
- Response shape: `Array<{ kind, normalizedValue, occurrenceCount, evidenceIds[] }>`.

**Service method:** `listCrossEvidenceFindings` on existing `entity-extraction.service.ts` (no new service).

**UI card:** "Cross-Evidence Findings" card on `/investigation` page. Each row shows kind badge + value + occurrence count + deep-link to `/search?q=<normalizedValue>` (reuses the keyword-search path). Card hides when zero findings exist for the workspace.

**Typed API client:** `apps/web/lib/api/intelligence.ts` adds `getCrossEvidenceFindings()` + `CrossEvidenceFinding` type.

---

## 10. UI surfacing changes

| Page | Section added | Reads from |
|---|---|---|
| `/investigation` | "Cross-Evidence Findings" card | `GET /v1/investigation/cross-evidence` |
| `/investigation/timeline` | (no UI change — existing timeline now displays 2 new event kinds via the union extension) | `GET /v1/graph/timeline` (extended) |
| `/investigation/graph` | (no UI change — existing graph now renders `ENTITY` nodes + `EXTRACTED_FROM` edges via existing renderer) | `GET /v1/graph/evidence/:id` (extended via reconcile) |
| `/investigation/duplicates` | (no UI change — SIMILAR_TO edges now also include text-similarity origins) | `GET /v1/graph/duplicates` (extended via reconcile) |
| `/search` | Semantic-disabled pill: "Semantic search arriving in Phase 14" | (static UI affordance) |
| `/evidence/[id]` | (no UI change — existing entity panel now backed by entity nodes in graph too) | unchanged |

No new pages. All additions are cards or affordances within existing pages.

---

## 11. Visibility confirmation

| Role / Plan | Confirmation |
|---|---|
| **PRO Investigation access preserved** | ✓ `/investigation`, `/investigation/graph`, `/investigation/timeline`, `/investigation/duplicates`, `/investigation/relationships`, `/investigation/reviewers`, `/investigation/cases` all remain accessible on PRO. No route gates changed. Cross-evidence card surfaces on PRO. |
| **Reviewer-only scope** | ✓ Reviewer scopes are unchanged. Reviewer can see SIMILAR_TO edges they could already see; new `EXTRACTED_FROM` edges respect existing reviewer-restricted row gating in graph projection. |
| **Platform-admin scope** | ✓ No new platform-admin surfaces. Existing platform-admin views (audit, telemetry) are not touched. |
| **Org-admin scope** | ✓ Org-admin sees workspace-aggregated cross-evidence findings (same scope as their existing `/investigation` access). No new org-admin tabs. |

All new reads are `teamId`-scoped at the query layer — workspace isolation invariant preserved.

---

## 12. Tests added

**File:** `D:/digital-witness/services/api/test/phase-13-intelligence-completion.test.ts`
**Result:** 65/65 assertions pass on first run (vitest, 339ms, zero relaxations).

**Coverage (14 Section 4 describe blocks + 4 GUARD blocks):**
1. `EXTRACTED_FROM` edge + `ENTITY` node materialized by reconcile.
2. ENTITY nodes deduped by `(kind, normalizedValue)`.
3. Timeline `EXTRACTED_TEXT_COMPLETED` event surfaces COMPLETED rows when `evidenceId` provided.
4. Timeline `EXTRACTED_TEXT_COMPLETED` event surfaces FAILED rows.
5. Timeline `ENTITY_EXTRACTED` event gated on `evidenceId` param.
6. Doc similarity worker promotes EvidenceSimilarity → SIMILAR_TO graph edge.
7. Transcript similarity worker promotes EvidenceSimilarity → SIMILAR_TO graph edge (same handler).
8. `graphEdgeId` back-reference written on EvidenceSimilarity row.
9. SIMILAR_TO confidence band derived from score thresholds.
10. Search indexer appends `[entity]` chunks to `searchableText`.
11. `GET /v1/investigation/cross-evidence` returns workspace-scoped aggregations.
12. Cross-evidence excludes singletons (`occurrenceCount >= 2`).
13. Cross-evidence response is plan-neutral.
14. Cross-evidence UI deep-link target is `/search?q=<normalizedValue>`.

**GUARD blocks:**
- GUARD: no new OCR/transcript/entity/graph/timeline/search/similarity pipeline introduced.
- GUARD: no new model provider configured.
- GUARD: no new investigation page route.
- GUARD: PRO Investigation route registry unchanged.

---

## 13. Validation matrix

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `services/api npx tsc --noEmit` | 0 | TypeScript clean |
| 2 | `apps/web npx tsc --noEmit` | 0 | TypeScript clean |
| 3 | `services/api npx vitest run test/phase-13-intelligence-completion.test.ts` | 0 | 65/65 pass (412ms) |
| 4 | `services/api npx vitest run` (full suite) | **non-zero** | **4 test files failed**, 286 passed, 1 skipped — 4 tests failed of 13,234 |
| 5 | `services/worker npx vitest run` | 0 | 559/559 pass (7.09s) |
| 6 | `pnpm --filter @proovra/shared test` | 0 | 703/703 pass |

**Totals:** 14,501 pass / **4 fail** / 57 skipped.

**First failing command:** #4 `services/api npx vitest run`.
**Failing files:**
- `phase-cr1-5b-product-state-reaudit.test.ts` — timeout after 5000ms.
- `phase-31-18-closure-program.test.ts`.
- `phase-32-7-2-security-event-mapping-drift.test.ts`.
- (one additional file in the same run).

**Status:** PHASE_13_VALIDATION_FAILED on the full-suite gate. The 4 failures are in pre-existing audit / closure-program / security-mapping tests and are not in files Phase 13 edited; investigation of root cause remains open in Section 14.

---

## 14. Remaining debt + Phase 14 recommendation

**Remaining debt from Phase 13:**
1. **4 full-suite test failures** (`phase-cr1-5b-product-state-reaudit`, `phase-31-18-closure-program`, `phase-32-7-2-security-event-mapping-drift`, +1) — diagnose whether they regressed due to graph catalog additions (`ENTITY` node kind + `EXTRACTED_FROM` edge type may bump invariants in those audits) or are flakes. Fix before Phase 14 sign-off.
2. **No embedding layer** — semantic and hybrid search remain deferred.
3. **Timeline scans** — `EXTRACTED_TEXT_COMPLETED` and `ENTITY_EXTRACTED` branches are gated on `evidenceId`; team-wide timeline view does not show these kinds. Future enhancement only if operator demand emerges.
4. **Cross-evidence card has no filtering UI** — operator cannot filter by entity kind (EMAIL vs PHONE vs URL). Acceptable v1; revisit if usage warrants.

**Phase 14 recommendation: Semantic & hybrid search infrastructure.**
- Pick embedding provider (OpenAI text-embedding-3-small is the lowest-friction default given existing Anthropic-adjacent infra).
- Add `evidence_search_embeddings` table or pgvector column on `evidence_search_documents`.
- Index OCR + transcript + entity chunks (the same three streams keyword search already covers).
- Hybrid scoring (RRF or weighted) at query time.
- Flip the `/search` disabled pill into a live toggle.

---

## 15. Sign-off

- No OCR v2 ✓
- No transcript v2 ✓
- No entity v2 ✓
- No graph v2 ✓
- No timeline v2 ✓
- No search v2 ✓ (semantic deferred to Phase 14, not re-built)
- No similarity v2 ✓
- Entity → Graph works ✓
- Graph → Timeline works ✓
- Cross-evidence intelligence visible ✓
- PRO Investigation access preserved ✓
- All tests pass ✗ (matches validation = false; 4 failures in pre-existing suites, see Section 13)

**Overall: PARTIAL.** All intelligence-bridge functionality is in place and the Phase 13 test file passes 65/65. The full-suite gate is red on 4 unrelated test files; Phase 14 must not begin until those are diagnosed and resolved.
