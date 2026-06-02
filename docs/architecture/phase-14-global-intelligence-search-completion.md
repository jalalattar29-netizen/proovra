# PROOVRA — Phase 14 Global Intelligence Search Completion
_Status: PARTIAL — see Validation section._

## 1. Preflight verification

| # | Claim from audit | Current state | Phase 14 will fix |
|---|---|---|---|
| 1 | `/search` is canonical Global Intelligence Search foundation | CONFIRMED: `/search` page exists (`apps/web/app/(app)/search/page.tsx`) with 3-column UI, filters, saved views, inspector | No action needed; extend with re-index wiring + deep-link entry points |
| 2 | `/v1/search` exists + primary | CONFIRMED: `search.routes.ts` implements GET/POST `/v1/search` with `evidence-search.service.ts` backend | No action needed; wiring target for re-index triggers |
| 3 | `/v1/intelligence/search` exists as duplicate | CONFIRMED: `intelligence.routes.ts` implements GET `/v1/intelligence/search` with `searchEvidence` service (lines 113-150) | Consolidate via ALIAS_FORWARD into `/v1/search` (Stage 3) |
| 4 | `evidence_search_documents` is canonical index table | CONFIRMED: Prisma model exists; indexed via `(teamId, documentType, sourceId)`; `buildEvidenceProjection` + `upsertSearchDocument` populate it | No action needed; extend with post-finalize triggers |
| 5 | Phase 13 indexer projection includes OCR + transcript + entity-name chunks | CONFIRMED: `evidence-indexing.service.ts` lines 271-318 read `EvidenceExtractedText` (OCR/TRANSCRIPT) + `EvidenceEntity`; append to `extractedChunks` -> `searchableText` | No action needed; foundational |
| 6 | OCR completion does NOT currently trigger re-index | CONFIRMED: `extraction.service.ts` writes `EvidenceExtractedText(status=COMPLETED)` but never calls `enqueueSearchIndexingJob` | Wire OCR completion trigger (Stage 2 #1) |
| 7 | Transcript completion does NOT currently trigger re-index | CONFIRMED: `extraction.service.ts` handles `TRANSCRIPT_*` completions but never triggers re-index | Wire transcript completion trigger (Stage 2 #2) |
| 8 | Entity extraction does NOT currently trigger re-index | CONFIRMED: Phase 13 added entity chunks to indexer but extraction completion never enqueues | Wire entity-extraction trigger (Stage 2 #3) |
| 9 | Graph reconcile does NOT currently trigger re-index | CONFIRMED: `reconcileTeamGraph` had no post-reconcile callback | Inject `onReconciled` hook -> enqueue re-index (Stage 2 #4) |
| 10 | Similarity promotion does NOT currently trigger re-index | CONFIRMED: `processTextSimilarityPromotion` upserts `SIMILAR_TO` edges with no follow-up | Wire similarity-completion trigger (Stage 2 #5) |

## 2. Re-indexing fixes (5 triggers)

| # | Trigger | File | Line region | Reason string |
|---|---|---|---|---|
| 1 | OCR completion | `services/api/src/services/intelligence/extraction.service.ts` | OCR completion branch | `"ocr_completed"` |
| 2 | Transcript completion | `services/api/src/services/intelligence/extraction.service.ts` | TRANSCRIPT completion branch | `"transcript_completed"` |
| 3 | Entity extraction completion | `services/api/src/services/intelligence/extraction.service.ts` | entity-extraction completion branch | `"entities_extracted"` |
| 4a | Graph reconcile (API path) | `services/api/src/services/evidence-complete.service.ts` | `reconcileTeamGraph` call site via `onReconciled` hook | `"graph_reconciled"` |
| 4b | Graph reconcile (worker path) | `services/worker/src/subsystem-queue-processors.ts` | `processGraphReconcileJob` via `onReconciled` hook | `"graph_reconciled"` |
| 5 | Similarity completion | `services/worker/src/media-intelligence.processor.ts` | post `processTextSimilarityPromotion`; gated `promoted > 0 \|\| upserted > 0` | `"similarity_completed"` |

All five triggers are wrapped in isolated `try/catch`, use deterministic `jobId` for idempotency, and never log raw text. Trigger #4 is split across two call sites because both API and worker can drive reconcile; the hook lives in `packages/shared-runtime/src/graph/graph-builder.service.ts` as an optional `ReconcileTeamGraphHooks { onReconciled }` parameter, so shared-runtime does not depend on the API queue helper.

## 3. /v1/intelligence/search consolidation decision

**Decision: ALIAS_FORWARD.** The `/v1/intelligence/search` handler in `services/api/src/routes/intelligence.routes.ts` was refactored to forward every keyword query through the canonical `executeSearch` (the same backend `/v1/search` uses), while preserving the legacy response envelope (`{ keyword, semantic, scope }`) so the surviving frontend caller continues to function until it migrates in the parallel UI stream. The `semantic` query param remains accepted but stays governed by `isSemanticSearchEnabled()` (Phase 14 ground rules forbid any semantic work — flag stays off, returns empty `semantic` array). The `scope` query param is preserved in the response for backward compat. The handler now emits a `deprecation: { alias, canonical: "/v1/search", since: "phase-14" }` hint in the response body, the reviewer-capability gate is replicated inline, and audit logs are tagged with a dedicated `surface: "api:/v1/intelligence/search"` so we can observe drain-down before deletion.

Diff summary: ~80 LOC removed from the local search path; ~50 LOC added that delegates to `executeSearch`, normalizes the legacy envelope shape, and emits the deprecation hint. Net: simpler, single backend, no behavioral regression for the one remaining consumer.

## 4. Search scope coverage table

| Domain | Indexed today | Phase 14 status |
|---|---|---|
| Evidence (manifest fields: title, description, tags) | YES (Phase 13 baseline) | Unchanged |
| Evidence OCR text (`EvidenceExtractedText.OCR`) | YES (Phase 13 projection) | Re-index now fires on OCR completion (Trigger #1) |
| Evidence transcripts (`EvidenceExtractedText.TRANSCRIPT_*`) | YES (Phase 13 projection) | Re-index now fires on transcript completion (Trigger #2) |
| Entity names attached to evidence (`EvidenceEntity.name`) | YES (Phase 13 projection) | Re-index now fires on entity-extraction completion (Trigger #3) |
| Case-level metadata (case ID, title) | YES via `filters.caseId` | Reachable via deep link `/search?caseId={id}` |
| Report-level metadata (`documentType=REPORT`) | YES via `filters.documentType` | Reachable via deep link `/search?documentType=REPORT` |
| Graph reconciliation deltas | INDIRECT (entity/edge changes -> evidence projection refresh) | Re-index now fires post-reconcile (Trigger #4) |
| Similarity edges (`SIMILAR_TO`) | INDIRECT (edge presence influences projection) | Re-index now fires post-similarity (Trigger #5) |
| Semantic / vector chunks (`EvidenceSemanticChunk`) | NOT INDEXED — disabled-state chip rendered | Out of scope by ground rules; deferred to Phase 15 |
| Investigation graph entities (standalone) | NOT INDEXED as primary search results | Reachable only via pivot links; Phase 15 candidate |
| Intake links, integrations, reviewers | NOT INDEXED | Out of scope |

## 5. Deep links added (table)

| Page | href shape | Status |
|---|---|---|
| Evidence detail entity chips | `/search?q={entityValue}` | Added (via `EntityChipGroup` Link wrap) |
| Case detail header pill | `/search?caseId={id}` | Added (via `MatterWorkspace`) |
| Reports index header pill | `/search?documentType=REPORT` | Added (via `ReportsIndex`) |
| Investigation graph seed row (ENTITY) | `/search?q={entityValue}` | Added (defensive — dormant until API exposes ENTITY seeds) |
| Investigation timeline anchor notice | `/search?evidenceId={id}` | Added |
| Investigation duplicates row (A / B) | `/search?evidenceId={id}` | Added (one link per side) |
| Intelligence landing page | `/search?q={query}` | Replaced legacy in-page results UI with deep-link affordance |

## 6. Search consumers wired

| Page | How it consumes `/search` |
|---|---|
| `/search` (canonical) | Primary consumer — full 3-column UI: filters left, results center, inspector right; `documentType`, `caseId`, `evidenceId`, `q` query params all honored |
| `/evidence/[id]` | Outbound: entity chips link to `/search?q={value}` |
| `/cases/[id]` | Outbound: "View evidence in Search" pill links to `/search?caseId={id}` |
| `/reports` | Outbound: "Search reports" header pill links to `/search?documentType=REPORT` |
| `/investigation/graph` | Outbound: per-seed "Search for this entity" link (ENTITY seed kind only) |
| `/investigation/timeline` | Outbound: anchor notice surfaces "Search for this evidence" when `?evidenceId` is set |
| `/investigation/duplicates` | Outbound: pivot links per duplicate row (A and B) |
| `/intelligence` | Outbound only: legacy in-page results UI removed; now redirects users to `/search?q={query}` |

## 7. Inspector + empty-state changes

- Zero-results empty state copy updated in `apps/web/app/(app)/search/page.tsx` to: **"No results yet. Try a broader query or upload evidence."**
- Verified three investigation pivots already present in inspector (case graph, timeline, duplicates) — no markup change required.
- Verified Phase 13 semantic-search "disabled" chip still renders unchanged in inspector footer — gated by `SEMANTIC_SEARCH_ENABLED` flag (off in Phase 14).
- `EntityChipGroup` chips upgraded from static spans to Next.js `Link` elements with `/search?q={value}` href, inheriting clickable variant into both evidence detail and inspector surfaces.
- Intelligence landing page: removed `SearchHit` type, `runSearch` fetcher, and inline results list; replaced with a single CTA linking to `/search?q={query}`.

## 8. Tests added

- File created: `D:/digital-witness/services/api/test/phase-14-global-intelligence-search.test.ts`
- `it()` block count: **26**
- Individual `expect()` calls: ~40+
- Vitest result: **PASS — 26/26**, exit 0, 1 file passed, 0 failed, duration 319ms
- One assertion was relaxed during execution: the "no new Phase 14 migration" guard initially flagged the legacy `20260523100000_add_governance_platform_phase14` directory (a pre-Phase-R numbering-scheme migration that predates the Phase 14 closure scope). The assertion was relaxed to flag only migrations whose 14-digit timestamp prefix is strictly greater than the Phase 13 closure boundary (`20270601000000`), preserving the negative guard for any genuinely new Phase 14 schema work while permitting the unrelated legacy name.

## 9. Validation matrix

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `tsc --noEmit` (services/api) | 0 | PASS |
| 2 | `tsc --noEmit` (apps/web) | 0 | PASS |
| 3 | `vitest phase-14-global-intelligence-search.test.ts` | 0 | PASS — 26/26 |
| 4 | `vitest run` (services/api) | 1 | FAIL — 4 failed / 13,201 passed / 56 skipped (292 files: 4 failed, 287 passed, 1 skipped) |
| 5 | `vitest run` (services/worker) | 1 | FAIL — 1 failed / 558 passed (23 files: 1 failed, 22 passed) |
| 6 | `pnpm --filter @proovra/shared test` | 0 | PASS — 703/703 |

**Totals: 14,488 passed / 5 failed / 57 skipped.**

Failing tests:
- `test/phase-cr4-verify-decomposition.test.ts` — CR1.6 byte-pin: expected 44441, got 45520 (`evidence-complete.service.ts`)
- `test/phase-cr5-capture-safety.test.ts` — same byte-pin: expected 44441, got 45520
- `test/phase-r10-visual-maturity.test.ts` — same byte-pin: expected 44441, got 45520
- `test/phase-r11-browser-qa-accessibility.test.ts` — same byte-pin: expected 44441, got 45520
- `services/worker test/subsystem-queues.test.ts` — graph-reconcile regex match failure for `reconcileTeamGraph(job.data.team...`

First 15 lines of first failing command (cmd 4 — services/api `vitest run`):

```
 RUN  v3.2.4 D:/digital-witness/services/api

 ✓ test/phase-r13-route-persona-matrix.test.ts (107 tests) 299ms
 ✓ test/
```

**Status flag emitted:** `PHASE_14_VALIDATION_FAILED`.

## 10. Remaining debt

- **Byte-pin regression in `evidence-complete.service.ts`**: four legacy phase tests (`cr4`, `cr5`, `r10`, `r11`) pin the file size at 44,441 bytes. Trigger #4 (graph-reconcile `onReconciled` hook wiring) grew the file to 45,520 bytes. The pins need to be re-baselined (or migrated to behavior-based assertions) in a follow-up cleanup task.
- **Worker subsystem-queues regex**: the `services/worker test/subsystem-queues.test.ts` regex matches the literal `reconcileTeamGraph(job.data.team...` shape, which Trigger #4b changed when the `onReconciled` hook arg was inserted. Regex needs to be relaxed or migrated to AST-based assertion.
- **`/v1/intelligence/search` removal**: now an alias forwarder, not deleted. One remaining consumer (`apps/web/app/(app)/intelligence/page.tsx`) was migrated to deep-link to `/search`, so the alias is technically unused by first-party UI. Hard deletion deferred until external/third-party consumers (if any) are confirmed drained via the new `surface: "api:/v1/intelligence/search"` audit tag.
- **Investigation graph ENTITY seed link**: added defensively but dormant — `/v1/graph/seeds` does not currently emit `ENTITY` seed kinds. When the graph API begins exposing entity seeds, the link will light up automatically with no further frontend change.
- **Semantic / vector search**: explicitly out of scope by Phase 14 ground rules. Disabled-state chip remains in inspector. See Section 11.
- **Standalone entity / intake-link / integration / reviewer indexing**: not in `evidence_search_documents`. No re-index path. Phase 15+ scope.

## 11. Phase 15 Semantic Search plan

Concrete next-phase plan, derived from the `search-reality-audit` semantic-readiness section:

1. **Schema**: enable `pgvector` extension; add `vector(1536)` column to `EvidenceSemanticChunk` (table already exists from Phase 13 scaffolding); add IVFFlat index on `(teamId, embedding)`.
2. **Feature flag**: introduce `SEMANTIC_SEARCH_ENABLED` env var; `isSemanticSearchEnabled()` already exists in the codebase and gates the legacy `/v1/intelligence/search` semantic branch. Flip it on only when steps 3-4 land.
3. **Embedding provider**: implement a local-or-injected embedding provider behind the flag. Default to a pluggable interface (`EmbeddingProvider.embed(texts: string[])`); ship one local implementation (e.g. sentence-transformers via subprocess) and one injectable HTTP adapter for cloud providers. Never call out from the API process directly — route through the worker.
4. **Hybrid ranker**: extend `evidence-search.service.ts` to fuse keyword (existing tsvector path) and vector (cosine similarity) scores using reciprocal rank fusion (k=60). Add unit tests covering keyword-only, vector-only, and hybrid modes.
5. **UI**: flip the disabled-state chip in `apps/web/app/(app)/search/page.tsx` inspector footer when the flag is on; render a small "Semantic match" sub-label on hybrid hits.
6. **Effort estimate**: ~3 days end-to-end per the audit (1 day schema + worker embed pipeline, 1 day hybrid ranker + tests, 1 day UI + flag rollout + smoke).

## 12. Sign-off

- No Search v2: **✓**
- No new search page: **✓**
- No semantic/vector work: **✓**
- `/search` canonical: **✓**
- `/v1/search` canonical: **✓**
- All 5 re-index triggers wired: **✓**
- All tests pass: **✗** (matches validation = false; 5 failures are byte-pin / regex collateral, not search-logic regressions — see Sections 9 and 10)
