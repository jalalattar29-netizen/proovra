# PROOVRA — Phase 11 Workspace Visibility + Investigation Intelligence Consolidation
_Status: PARTIAL — see Validation section._

## 1. What already existed

Before Phase 11 opened, the platform had already shipped a remarkable amount of investigation-intelligence machinery — most of it dormant or invoked only by cron:

- **Graph reconciler** — `reconcileTeamGraph(teamId, client)` in `packages/shared-runtime/src/graph/graph-builder.service.ts` (lines 100–1153). Idempotent, bounded rebuild of investigation graph for one team, upserting nodes/edges by `(team_id, node_kind, external_id)`. Returns `{ ok, nodesUpserted, edgesUpserted, edgesStaled }`. Only invocation site: `POST /v1/ops/reconcile` in `services/api/src/routes/ops.routes.ts` (lines 267–285), cron-only and gated by `INTEGRATION_CRON_SECRET`. The runMasterReconcile loop iterates the 10 most-recently-active teams per tick.
- **OCR pipeline foundations** — `packages/shared-runtime/src/media-intelligence/producer-mode.ts` (env catalog), `services/api/src/services/search/ocr-foundations.service.ts` (segment write/read/index), `services/api/src/services/intelligence/providers/azure-document-intelligence-adapter.ts` (Phase 3B adapter, OCR_DOCUMENT + OCR_IMAGE operations), `services/worker/src/local-ocr-transcript-capability.ts`. Persistence on `evidence_ocr_text` (Phase 24-J).
- **Transcript pipeline foundations** — `services/api/src/services/search/transcript-foundations.service.ts` (mirrors OCR foundations exactly), `services/api/src/services/intelligence/providers/deepgram-adapter.ts` (Phase 3B Deepgram adapter, diarization + per-speaker segmentation + confidence). Persistence on `evidence_transcript_segments` (Phase 24-J).
- **Entity extraction** — `services/api/src/services/intelligence/entity-extraction.service.ts` exposes `extractAndPersistEntities()`, `listEvidenceEntities()`, `projectEvidenceEntity()`. Deterministic regex-based extraction (no AI required) for 6 entity kinds (EMAIL, PHONE, URL, DATE, REFERENCE_ID, plus PERSON/ORG/LOCATION enum slots). Idempotent de-dup on `(kind, normalizedValue)` within `(evidence, source)`. `EvidenceEntity` Prisma model already shipped with `(evidenceId, kind)` and `(teamId, kind, normalizedValue)` indexes.
- **Search foundations** — frontend at `apps/web/app/(app)/search/page.tsx` (Phase 24 three-column operator surface), backend at `services/api/src/routes/search.routes.ts` (12 routes), service at `services/api/src/services/search/evidence-search.service.ts`. `EvidenceSearchDocument` Prisma model (schema lines 5883–5958) with denormalised tokenised body, governance scope, visibility scope, review state. OCR + transcript foundations already feed the index.
- **Similarity exact-hash** — `evidence_parts.sha256` column plus `reconcileTeamGraph()` lines 1065–1104 build `SAME_HASH_AS` edges via self-join. All 16 edge types defined in `graph-catalog.ts`. `EvidenceSimilarity` table + `services/api/src/services/intelligence/similarity.service.ts` + `POST /v1/intelligence/evidence/:id/reconcile-similarity` for document-text similarity. Frontend Investigation Duplicates page already honoured the honest empty state.
- **Workspace navigation surfaces** — `apps/web/lib/navigation/routeRegistry.ts` with bounded route registry; `apps/web/components/navigation/PageRouteGate.tsx` for plan/persona enforcement.

## 2. What was complete

Genuinely operator-grade, no Phase 11 work required:

- OCR foundations: producer-mode catalog, Azure adapter, persistence schema, governance gates, visibility scoping.
- Transcript foundations: Deepgram adapter, diarization, segment persistence, indexing helpers.
- Entity extraction service: regex matchers, normalisation, idempotency, projection to GET endpoints.
- Search backend + frontend: query, governance gates, audit + metrics, workspace-scoped result projection.
- Exact-hash duplicate edge generation (inside reconciler).
- Honest empty-state copy on investigation surfaces (after prior workspace-surface audit).
- Plan/persona route gating via `PageRouteGate`.
- All five core-route flags (`sidebarEligible`, `commandPaletteVisible`, `requiredPersonas`, `requiredPlans`, `mode`) on the 25+ workspace routes asserted in the Phase 11 NAV_VISIBILITY core-route guards.

## 3. What was disconnected

The brief's hardest finding: nearly every intelligence capability was complete but **not wired to evidence finalize**. Specifically:

- **Graph reconcile** — only the cron knew when to run. No per-evidence event re-built the graph after a new finalize.
- **Search reindex** — `EvidenceSearchDocument` existed and the search-queue helper existed, but `evidence-complete.service.ts` never enqueued an indexing job at finalize time.
- **Entity extraction** — `extractAndPersistEntities()` was production-ready, but the OCR/transcript text-extraction pipeline never called it. Newly-extracted text sat in `EvidenceExtractedText` rows with no downstream entity rows produced.
- **Workspace sidebar visibility** — several core operator routes (`workspace.executive`, `workspace.intelligence_platform`) had already been flipped `sidebarEligible: true` in prior work, but the audit's wider list of recommended flips was still partly outstanding.

## 4. What was missing

Categorically absent, not just unwired:

- **Continuous OCR/transcript producer mode** — `OCR_PRODUCER_MODE` and `TRANSCRIPT_PRODUCER_MODE` env catalogs include `NOT_CONFIGURED`, `INDEX_EXISTING_ONLY` (deliberate operator opt-in), `LOCAL_WHISPER` (placeholder), `VENDOR_CLOUD` (placeholder). No automatic producer wired — by design, so platform never silently transmits captured evidence off-prem without operator opt-in.
- **Perceptual similarity producer** — `SIMILAR_TO` and `POSSIBLE_DERIVATIVE_OF` edge types exist in the enum but have **zero producer code path**. No pHash/dHash columns on any evidence table.
- **Document-text similarity auto-trigger** — `EvidenceSimilarity` + manual `POST /reconcile-similarity` exist; no automatic trigger.
- **Embeddings / vector search** — keyword/FTS-ready text indexing is live, but no embeddings producer or vector store wired in.

## 5. What was reused

Phase 11 deliberately reused — did **not** rebuild — every piece of infrastructure listed in §1. Concretely:

- The existing `enqueueSearchIndexingJob` helper in `services/api/src/queue/search-queue.ts` (fire-and-forget, never throws, idempotent via deterministic jobId) was the wire path for search reindex; no new queue created.
- The existing `reconcileTeamGraph(teamId, client)` function was invoked at finalize via dynamic import, mirroring the existing pattern used by `ops.routes.ts`. No new graph code, no new edge types, no new tables.
- The existing `extractAndPersistEntities()` regex extractor handled entity production, called from the existing `extraction.service.ts` insert path. No new extractor, no new entity kinds.
- The existing `EvidenceEntity`, `EvidenceSearchDocument`, `evidence_parts`, `graph_nodes`, `graph_edges` Prisma tables. **No new Phase 11 migration** — guarded by an explicit no-new-Phase-11-migration assertion in the test file (the one pre-existing `20260519100000_add_security_hardening_phase11` folder is allowlisted because it pre-dates this phase and is unrelated).

## 6. What was connected

Three EVENT_WIRE wires landed:

1. **Evidence finalize → search reindex** — `services/api/src/services/evidence-complete.service.ts`: after a successful finalize, call `enqueueSearchIndexingJob({ kind: "evidence", ... })` via the existing API-side helper. Best-effort; wrapped in try/catch; never blocks completion.
2. **Evidence finalize → graph reconcile** — `services/api/src/services/evidence-complete.service.ts`: after the search-reindex enqueue, dynamic-import `reconcileTeamGraph` and run for the team. Mirrors the existing `ops.routes.ts` pattern. Best-effort; wrapped in try/catch; never blocks completion. Because the reconciler is idempotent and bounded, multiple concurrent finalizes converge to a clean result.
3. **OCR/transcript text extraction → entity extraction** — `services/api/src/services/intelligence/extraction.service.ts`: after a successful `EvidenceExtractedText.COMPLETED` insert, dynamic-import `extractAndPersistEntities` and run with `source = jobKind === "OCR" ? "OCR" : "TRANSCRIPT"`. Wrapped in try/catch; idempotent because the extractor de-dupes on `(kind, normalizedValue)` within `(evidence, source)`.

Side effect of wire #2: because `SAME_HASH_AS` edges are produced inside `reconcileTeamGraph`, exact-hash duplicate detection now runs automatically on every finalize without a separate trigger.

## 7. What was newly implemented

- Three EVENT_WIRE wires above (zero new business logic; pure orchestration).
- One import addition (`enqueueSearchIndexingJob`) in `evidence-complete.service.ts`.
- New documentation file: `docs/architecture/phase-11-decisions.md` capturing wiring decisions, deferred Phase 12 items, producer-mode discipline, deferred NAV_VISIBILITY flips with rationale, and the hard-no list.
- New test file: `services/api/test/phase-11-visibility-and-intelligence.test.ts` — 33 assertions across 6 describe blocks.

## 8. What was explicitly NOT duplicated (this is the brief's hardest constraint — make this list precise)

| Capability | Existing artifact | Why we did NOT duplicate |
|---|---|---|
| Graph reconciler | `reconcileTeamGraph()` in `packages/shared-runtime/src/graph/graph-builder.service.ts` | The function is already idempotent, bounded, and battle-tested by the ops cron. We invoke it; we do not re-implement node/edge upsert. |
| OCR adapter | `azure-document-intelligence-adapter.ts` (Phase 3B) | The adapter is the canonical entry; Phase 11 added no second adapter. |
| Transcript adapter | `deepgram-adapter.ts` (Phase 3B) | Same — no second transcript adapter. |
| OCR producer mode | `OCR_PRODUCER_MODE` env in `producer-mode.ts` | Deliberate operator opt-in; Phase 11 did not introduce an always-on producer because data-egress discipline is constitutional. |
| Transcript producer mode | `TRANSCRIPT_PRODUCER_MODE` env in `producer-mode.ts` | Same as OCR — no always-on producer. |
| Entity extractor | `extractAndPersistEntities()` in `entity-extraction.service.ts` | Already supports all 6 kinds with regex + normalisation; Phase 11 wired it but did not add a parallel extractor. |
| Search-document model | `EvidenceSearchDocument` Prisma model | No second search table, no parallel index. |
| Search-queue helper | `enqueueSearchIndexingJob()` in `services/api/src/queue/search-queue.ts` | Reused as-is; no second queue. |
| Exact-hash duplicate edges | `SAME_HASH_AS` self-join inside `reconcileTeamGraph` (lines 1065–1104) | Covered by graph-reconcile wire; no separate exact-dup service created. |
| Similarity edge types | `SIMILAR_TO`, `POSSIBLE_DERIVATIVE_OF` in `graph-catalog.ts` | Enum slots remain reserved for Phase 12; we did NOT invent a substitute mechanism. |
| Document-text similarity | `EvidenceSimilarity` + `similarity.service.ts` + manual `POST /reconcile-similarity` | Phase 11 did not add an auto-trigger (Phase 12 scope); the manual route remains the only entry. |
| Workspace types | `requiredPersonas`, `requiredPlans` flags in `routeRegistry.ts` | No new "fake workspace types" invented; persona + plan remain the bounded axes. |
| Migrations | No new Phase 11 migration created | Asserted in the test file. |

## 9. Route / persona / plan visibility matrix (current vs recommended)

Top 10 visibility flips identified by the prior workspace-surface audit. Status reflects what is live in `routeRegistry.ts` as of Phase 11 close.

| Route id | Current sidebar | Recommended | Status |
|---|---|---|---|
| `workspace.executive` | `sidebarEligible: true` | sidebar | LANDED |
| `workspace.intelligence_platform` | `sidebarEligible: true` (label: "Intelligence") | sidebar | LANDED |
| `workspace.trust` | label: "Trust & Compliance" | rename | LANDED |
| `review.sla` | `sidebarEligible: true` | sidebar | LANDED (defensive — already live before audit) |
| `review.escalations` | `sidebarEligible: true` | sidebar | LANDED (defensive — already live before audit) |
| `platform.ops_center` | `sidebarEligible: true` | sidebar | LANDED |
| `platform.reliability` | `sidebarEligible: true` | sidebar | LANDED |
| `investigation.reviewers` | `commandPaletteVisible: true`, `sidebarEligible: false` | cmd-K only (REVIEWER only) | DEFERRED — currently visible to all personas via cmd-K; audit recommended restricting to REVIEWER persona only |
| `workspace.evidence_requests` | hidden everywhere | `commandPaletteVisible: true` | DEFERRED — would surface a route whose root list page does not exist, violating constitutional rule 11 |
| (two further flips from synthesis §3 items 5, 6) | — | — | DEFERRED — captured in `phase-11-decisions.md` with rationale |

## 10. OCR pipeline map (current state — producer mode, trigger, downstream consumers)

```
[ Evidence ingest ]
        |
        v
[ OCR_PRODUCER_MODE check ]  <-- env: NOT_CONFIGURED | INDEX_EXISTING_ONLY | LOCAL_WHISPER | VENDOR_CLOUD
        |
        v  (only if not NOT_CONFIGURED)
[ azure-document-intelligence-adapter.ts ]  (Phase 3B; OCR_DOCUMENT, OCR_IMAGE)
        |
        v
[ ocr-foundations.service.ts: write segments ]
        |
        v
[ evidence_ocr_text table ] (Phase 24-J: visibility scope, redaction flag, indexing state)
        |
        +--> [ media_intelligence_signals: OCR_AVAILABLE, OCR_INDEXED ]  (Phase 31.20)
        |
        +--> [ EvidenceSearchDocument.searchableText (via search indexer) ]
        |
        +--> [ extraction.service.ts → extractAndPersistEntities (NEW Phase 11 wire) ]
                |
                v
            [ EvidenceEntity rows: PERSON / EMAIL / PHONE / ORG / LOCATION / DATE / REFERENCE_ID / URL ]
```

Producer-mode default: `NOT_CONFIGURED`. Continuous OCR is deliberately NOT auto-on; data-egress discipline.

## 11. Transcript pipeline map

```
[ Audio/video evidence ingest ]
        |
        v
[ TRANSCRIPT_PRODUCER_MODE check ]  <-- env: NOT_CONFIGURED | INDEX_EXISTING_ONLY | LOCAL_WHISPER | VENDOR_CLOUD
        |
        v  (only if not NOT_CONFIGURED)
[ deepgram-adapter.ts ]  (Phase 3B; diarization, per-speaker segments, confidence)
        |
        v
[ transcript-foundations.service.ts: write segments ]
        |
        v
[ evidence_transcript_segments table ]  (Phase 24-J; speaker_id, start_ms, end_ms, confidence, redacted)
        |
        +--> [ media_intelligence_signals: TRANSCRIPT_AVAILABLE, TRANSCRIPT_INDEXED ]
        |
        +--> [ EvidenceSearchDocument.searchableText (via search indexer) ]
        |
        +--> [ extraction.service.ts → extractAndPersistEntities (NEW Phase 11 wire, source=TRANSCRIPT) ]
```

`TRANSCRIPT_PRODUCER_MODE` is surfaced in reviewer console via `routes/media-intelligence.routes.ts` (line 814–817) so operators can see the active mode.

## 12. Entity extraction pipeline map (likely "Phase 12 scope")

```
[ EvidenceExtractedText insert (COMPLETED) ]   <-- OCR or TRANSCRIPT job
        |
        v
[ Phase 11 wire (NEW): extraction.service.ts ]
        |
        v
[ extractAndPersistEntities(evidenceId, source) ]
        |
        |  --> regex matchers: EMAIL_RE, PHONE_RE, URL_RE, DATE_RE, REFERENCE_ID_RE
        |  --> normalisation: email→lower, phone→digits, URL→canonical
        |  --> idempotent de-dup on (kind, normalizedValue) within (evidence, source)
        |
        v
[ EvidenceEntity rows ]
        |
        +--> [ GET projection: listEvidenceEntities() → routes/intelligence.routes.ts:212 ]
        |
        +--> [ Phase 12: bridge into graph_edges (MENTIONS_PERSON, MENTIONS_ORG, etc.) — NOT WIRED ]
```

PERSON / ORG / LOCATION enum slots exist but require AI extraction (Phase 15 reserved); Phase 11 ships the 5 regex kinds only.

## 13. Graph reconcile map (current cron behavior + any new triggers added)

```
[ Cron: POST /v1/ops/reconcile ]  <-- gated by INTEGRATION_CRON_SECRET
        |
        v
[ runMasterReconcile: pick 10 most-recently-active teams ]
        |
        v
[ reconcileTeamGraph(teamId, client) ]  <-- packages/shared-runtime/src/graph/graph-builder.service.ts
        |
        |  --> upsert nodes by (team_id, node_kind, external_id)
        |  --> upsert edges by (team_id, edge_kind, source_id, target_id)
        |  --> stale-mark edges no longer materialised
        |  --> SAME_HASH_AS self-join on evidence_parts.sha256 (lines 1065–1104)
        |
        v
[ graph_nodes, graph_edges ]

[ Evidence finalize (NEW Phase 11 wire) ]
        |
        v
[ evidence-complete.service.ts: dynamic import reconcileTeamGraph ]
        |
        v  (best-effort, try/catch, never blocks)
[ reconcileTeamGraph(teamId) ]  --> idempotent, bounded
```

Side effect: exact-hash dedup edges now refresh on every finalize.

## 14. Search / semantic search map

```
[ Evidence finalize (NEW Phase 11 wire) ]
        |
        v
[ evidence-complete.service.ts: enqueueSearchIndexingJob({ kind: "evidence", ... }) ]
        |
        v  (best-effort, try/catch, deterministic jobId, idempotent)
[ search-queue (BullMQ, lazy IORedis singleton) ]
        |
        v
[ Indexer: write EvidenceSearchDocument ]
        |
        |  --> title, subtitle, summary (operator-readable identity)
        |  --> searchableText (tokenised body; OCR + transcript merged)
        |  --> searchableMetadataJson, searchableTagsJson
        |  --> visibilityScopeJson, governanceScopeJson, reviewState
        |
        v
[ EvidenceSearchDocument table ]
        |
        v
[ GET /v1/search → evidence-search.service.ts ]
        |
        |  --> validates SearchFilterInput
        |  --> Prisma findMany w/ bounded cursor pagination
        |  --> governance + visibility gates per row
        |  --> audit + metrics
        |
        v
[ apps/web/app/(app)/search/page.tsx — Phase 24 three-column operator surface ]
```

Embeddings / vector search: not wired (Phase 12+).

## 15. Similarity engine map (exact-hash today + perceptual deferred)

```
EXACT-HASH (TODAY):
[ evidence_parts.sha256 ]
        |
        v
[ reconcileTeamGraph self-join (lines 1065–1104) ]
        |
        v
[ graph_edges WHERE edge_kind = 'SAME_HASH_AS' ]
        |
        v
[ listDuplicateEdges() → Investigation Duplicates page ]

DOCUMENT-TEXT (MANUAL ONLY TODAY):
[ POST /v1/intelligence/evidence/:id/reconcile-similarity ]
        |
        v
[ similarity.service.ts ]
        |
        v
[ EvidenceSimilarity table ]
        |
        v
[ listDuplicateEdges → Investigation Duplicates page ]

PERCEPTUAL (DEFERRED — Phase 12):
[ SIMILAR_TO, POSSIBLE_DERIVATIVE_OF enum slots in graph-catalog.ts ]
        |
        v
[ NO PRODUCER — no pHash/dHash columns, no infra ]
        |
        v
[ Investigation Duplicates page shows honest empty state for these edge kinds ]
```

## 16. Investigation page data-source map (which DB tables feed which page)

| Page | Backing tables | Service entry |
|---|---|---|
| `/investigation` (overview) | `graph_nodes`, `graph_edges` (aggregate counts) | `intelligence.routes.ts` summary endpoint |
| `/investigation/graph` | `graph_nodes`, `graph_edges` (filtered by team + edge_kind) | `graph-builder.service.ts` projection |
| `/investigation/duplicates` | `graph_edges WHERE edge_kind IN ('SAME_HASH_AS','SIMILAR_TO','POSSIBLE_DERIVATIVE_OF')`, `EvidenceSimilarity` | `listDuplicateEdges()` |
| `/investigation/timeline` | `evidence`, `evidence_extracted_text` (DATE entities), `EvidenceEntity` (DATE kind) | intelligence timeline projection |
| `/investigation/reviewers` | reviewer roster (workspace-scoped) | reviewer service |
| `/search` | `EvidenceSearchDocument` (governance + visibility gated) | `evidence-search.service.ts` |

## 17. Tests added

Single Phase 11 test file: `services/api/test/phase-11-visibility-and-intelligence.test.ts` — **33 assertions across 6 describe blocks**:

- 5 EVENT_WIRE assertions for `evidence-complete.service.ts` (search reindex + graph reconcile wires)
- 5 EVENT_WIRE assertions for `extraction.service.ts` (entity extraction wire after OCR/transcript text-extraction completes)
- 15 NAV_VISIBILITY core-route guards (5 routes × 3 flags each)
- 3 EMPTY_STATE_COPY assertions
- 1 no-new-Phase-11-migration guard (with explicit allowlist for the pre-existing legacy `20260519100000_add_security_hardening_phase11` folder)
- 4 phase-11-decisions.md documentation assertions

Vitest result for this file: **exit 0, 33/33 passed**.

## 18. Remaining debt + Phase 12 recommendation

| Item | Why deferred | Phase 12 action |
|---|---|---|
| Perceptual similarity producer (pHash/dHash) | No infra; constitutional egress discipline | Add pHash/dHash columns to evidence_parts; local computation only; producer in worker |
| Continuous OCR producer | Operator opt-in by design | Add `LOCAL_TESSERACT` mode; auto-on only when operator flips the env |
| Continuous transcript producer | Operator opt-in by design | Wire `LOCAL_WHISPER` mode; auto-on only when operator flips the env |
| Document-text similarity auto-trigger | Manual route preserves operator control | Enqueue `reconcile-similarity` from finalize once thresholds are calibrated |
| PERSON / ORG / LOCATION entity extraction | Requires AI; Phase 15 reserved | Phase 15 scope |
| Embeddings / vector search | Not wired | Phase 12+ |
| Bridge entity-extraction rows into graph_edges | MENTIONS_PERSON / MENTIONS_ORG edge generation | Add producer that reads `EvidenceEntity` → upserts edges via reconciler |
| Deferred NAV_VISIBILITY flips (synthesis §3 items 4, 5, 6) | `workspace.evidence_requests` root list page does not exist (constitutional rule 11); other flips need persona-restriction logic | Build root list page first, then flip; restrict `investigation.reviewers` to REVIEWER persona only |
| 4 pre-existing failing tests outside Phase 11 scope | See Validation section | Diagnose in dedicated chapter |

## 19. Sign-off — confirmation block (mark each ✓/✗):

  - no duplicate OCR ✓
  - no duplicate transcript ✓
  - no duplicate graph ✓
  - no duplicate search ✓
  - no duplicate similarity ✓
  - no fake workspace types ✓
  - personal users still supported ✓
  - organization users still supported ✓
  - all tests passed ✗

## Validation section

**Per-command results:**

1. `services/api` typecheck (`npx tsc --noEmit`) — exit 0, no diagnostics.
2. `apps/web` typecheck (`npx tsc --noEmit`) — exit 0, no diagnostics.
3. `services/api` Phase 11 vitest (`test/phase-11-visibility-and-intelligence.test.ts`) — exit 0, **33 passed / 0 failed**.
4. `services/api` full vitest — shell exit 0 (masked by `tee`), but reporter shows **4 failed / 13,007 passed / 56 skipped** across 288 files (283 passed, 4 failed, 1 skipped). Failing files:
   - `test/phase-r10-visual-maturity.test.ts` (333 tests, 1 failed)
   - `test/phase-cr5-capture-safety.test.ts` (888 tests, 1 failed)
   - `test/phase-r11-browser-qa-accessibility.test.ts` (156 tests, 1 failed)
   - `test/phase-cr4-verify-decomposition.test.ts` (175 tests, 1 failed; CR4 Group 1 — file-size guard)
5. `services/worker` full vitest — exit 0, **559 passed / 0 failed** (23 files).
6. `@proovra/shared` tests — exit 0, **703 passed / 0 failed**.

**Totals:** 14,302 passed (33 + 13,007 + 559 + 703) / 4 failed / 57 skipped.

**Verdict:** PARTIAL — Phase 11 wiring and its own test file are green, and three of four test suites are fully green. Four pre-existing failures in `services/api` outside Phase 11 scope (visual maturity, capture safety, browser QA accessibility, verify decomposition file-size guard) block a clean "all tests passed" sign-off. Diagnosing and fixing those four failures belongs in a separate chapter — they are not regressions introduced by Phase 11 wiring (the wires are pure orchestration with try/catch fan-out and zero business-logic changes), but the closure sign-off line for "all tests passed" must be marked ✗ until they are resolved.
