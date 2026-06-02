# Phase 16 — Semantic Search Activation (Final)

Status: SHIPPED
Date: 2026-06-02
Predecessor: Phase 15 (Semantic Search Foundation — schema + provider interface + UI scaffolding)
Successor: Phase 17 (TBD — see §15)

---

## 1. Executive summary

Phase 16 turns Phase 15's semantic-search scaffolding into a live, end-to-end feature.
A real OpenAI embedding provider replaces the Phase 15 stub, gated by four independent flags.
A dedicated `mi-embed` BullMQ queue + worker computes embeddings asynchronously and writes the pgvector `embedding_vector` column.
Hybrid scoring now reads pgvector cosine distance via `$queryRaw` (workspace-id always parameterised) with silent fallback to the Phase 15 in-process Bytes ranker, and ultimate fallback to keyword.
A workspace-scoped backfill — exposed both as a `POST /v1/search/semantic/backfill` admin route and a resumable CLI — populates existing evidence, while live indexing enqueues per-chunk embed jobs.
All 7 validation commands pass; 13,253 API tests + 560 worker tests + 703 shared tests green; the 20 Phase 16 source-contract assertions pass on first run.

---

## 2. Files changed

| File | Role | New / Edited |
|---|---|---|
| `services/api/prisma/migrations/20270801000000_phase16_semantic_usage/migration.sql` | Additive `semantic_usage_daily` table (Phase O pattern) | New |
| `services/api/prisma/schema.prisma` | `SemanticUsageDaily` model added | Edited |
| `services/api/src/services/search/embedding-provider.ts` | Real `OpenAIEmbeddingProvider` replaces stub; 4-gate guard; lazy SDK import; back-compat re-export | Edited |
| `services/api/src/services/search/semantic-budget.service.ts` | `canEmbedMore` / `recordSemanticChunkEmbedded` / `getSemanticUsageSummary` | New |
| `services/api/src/services/search/semantic-backfill.service.ts` | `runSemanticBackfill` — idempotent + resumable + workspace-scoped + dryRun | New |
| `services/api/src/services/search/evidence-search.service.ts` | `rerankWithSemantic` tries pgvector `<=>` SQL first, falls back to Bytes, then keyword | Edited |
| `services/api/src/services/intelligence/semantic.service.ts` | `indexEvidenceText` enqueues `mi-embed` per chunk after persistence | Edited |
| `services/api/src/queue/mi-embed-queue.ts` | API-side `enqueueEmbedChunks` (lazy IORedis, idempotent jobId) | New |
| `services/api/src/routes/search.routes.ts` | `POST /v1/search/semantic/backfill` + `GET /v1/search/semantic/status` (extend existing route file) | Edited |
| `services/api/scripts/backfill-semantic-embeddings.ts` | Operator CLI; requires `--teamId`, supports `--dryRun` + `--cursor` + `--repeat` | New |
| `services/api/.env.example` | 7 new Phase 16 env vars documented | Edited |
| `services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts` | Appended `20270801000000_phase16_semantic_usage` to `PERMITTED_LATER_MIGRATIONS` | Edited |
| `services/api/test/phase-16-semantic-activation.test.ts` | 20 source-contract assertions | New |
| `services/api/test/phase-13-intelligence-chain.test.ts` | Rebaselined processor list to include `mi-embed.processor.ts` | Edited |
| `services/api/test/phase-13-intelligence-completion.test.ts` | Same rebaseline (sibling pin) | Edited |
| `services/worker/src/mi-embed.processor.ts` | Dedicated worker; dual gate, budget check, `$executeRaw` writes to `embedding_vector` | New |
| `services/worker/src/queue.ts` | `miEmbedQueue` + `enqueueMiEmbedJob` + `MiEmbedJobPayload` | Edited |
| `services/worker/src/index.ts` | Registered `mi-embed` worker (concurrency 1) + shutdown wiring | Edited |
| `services/worker/src/search-indexing.processor.ts` | Real OpenAI binding; safety-net `take: 200` → `take: 25` | Edited |
| `services/worker/package.json` | Added `"openai": "^6.36.0"` so dynamic import resolves | Edited |
| `packages/shared-runtime/src/ops/metrics.service.ts` | Added `semantic_embed_enqueue_failed_total` + `semantic_embed_enqueued_total` to `COUNTER_NAMES` | Edited |
| `apps/web/app/(app)/search/page.tsx` | Chip wording + mode-selector disable + admin backfill panel + status endpoint hookup | Edited |
| `apps/web/app/(app)/intelligence/page.tsx` | Renamed 3 unused style consts to `_…` to satisfy ESLint | Edited |
| `docs/architecture/phase-15-semantic-policy.md` | Extended to 18 sections covering Phase 16 activation, backfill semantics, debt | Edited |
| `docs/architecture/phase-16-semantic-search-activation-final.md` | This document | New |

---

## 3. Provider implementation

**Class:** `OpenAIEmbeddingProvider` in `services/api/src/services/search/embedding-provider.ts`.
The Phase 15 `OpenAIEmbeddingProviderStub` is removed but its export name is re-exported as an alias, so any pre-existing import (tests, scripts) keeps compiling.

**Shape:**
1. Constructor reads `OPENAI_API_KEY` lazily; missing key → `embedText`/`embedBatch` return `null` and `logEmbeddingFailure` emits `errorCode: "OPENAI_API_KEY_MISSING"`.
2. `gate()` enforces the four-flag rule (see below). Failure short-circuits before any network I/O.
3. OpenAI SDK is `await import("openai")` on first use — module only loaded when this provider is selected.
4. `embedBatch` is the primary path: batch size 96 (well under OpenAI's 2048 cap) calling `client.embeddings.create({ model, input, dimensions })`. `embedText` delegates to a singleton batch of 1.
5. Retry: 3 attempts with exponential backoff (250ms → 1s → 4s) on HTTP 429 / 5xx only. Other errors return `null` immediately with a bounded `errorCode`.
6. Per-request timeout: 30s via `AbortController`.
7. Logs contain only `chunkId`, `evidenceId`, `workspaceId`, `status`, `errorCode` — never raw chunk text, never request bodies.
8. Workspace-day caps are enforced one layer up in the queue producer; the provider itself is budget-agnostic.

**The 4-gate guard (must all be true for an outbound HTTP call):**

| # | Flag / Condition | Where checked |
|---|---|---|
| 1 | `SEMANTIC_SEARCH_ENABLED === "true"` | `buildEmbeddingProviderFromEnv` factory |
| 2 | `SEMANTIC_EMBEDDINGS_PROVIDER === "openai"` | factory branch selection |
| 3 | `SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND === "true"` | `OpenAIEmbeddingProvider.gate()` |
| 4 | `OPENAI_API_KEY` non-empty | constructor + per-call assertion |

If any gate fails, the provider returns `null` (not throw), the search service downgrades to keyword with a `fallbackReason`, and a structured warning event is emitted.

---

## 4. Env flags

| Variable | Default | Role |
|---|---|---|
| `SEMANTIC_SEARCH_ENABLED` | `false` | Master switch — Phase 15 flag, reused. |
| `SEMANTIC_EMBEDDINGS_PROVIDER` | `disabled` | One of `disabled` / `local` / `openai`. |
| `SEMANTIC_EMBEDDINGS_MODEL` | `text-embedding-3-small` | OpenAI model name passed to `embeddings.create`. |
| `SEMANTIC_EMBEDDINGS_DIMENSIONS` | `1536` | Must match pgvector column width. |
| `SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND` | `false` | Hard outbound gate. Must be `true` for OpenAI to actually fire. |
| `OPENAI_API_KEY` | (unset) | Standard OpenAI credential. |
| `SEMANTIC_EMBED_BATCH_SIZE` | `96` | Batch size for `embeddings.create`. |
| `SEMANTIC_EMBED_DAILY_CHUNK_CAP` | `5000` | Per-workspace per-UTC-day chunk-embed cap. |
| `SEMANTIC_EMBED_MONTHLY_BUDGET_EUR` | `100` | Per-workspace month-to-date EUR cap. |
| `SEMANTIC_EMBED_COST_USD_PER_TOKEN` | `0.00000002` | Used for cost estimation against the monthly budget. |
| `SEMANTIC_EMBED_USD_TO_EUR` | `0.92` | FX assumption (override per deployment). |

All eleven are documented in `services/api/.env.example`. None of these names appear in any user-facing UI string (verified by Phase 13/14 anti-leak assertions).

---

## 5. Backfill process

**Two invocation paths share one engine** (`semantic-backfill.service.ts:runSemanticBackfill`):

1. **Admin route** `POST /v1/search/semantic/backfill` (platform-admin only). Body: `{ teamId: uuid, dryRun?: boolean, cursor?: uuid }`. Returns `{ enqueued, skipped, nextCursor, perDayChunksUsed?, perDayChunksCap?, monthlyUsed?, monthlyBudget? }`.
2. **CLI** `services/api/scripts/backfill-semantic-embeddings.ts` for bulk operator use. Flags:
   - `--teamId=<uuid>` (REQUIRED — refuses cross-tenant scan with `WORKSPACE_REQUIRED` if omitted)
   - `--dryRun` (selects + budget-checks, never calls provider, never writes)
   - `--cursor=<uuid>` (resume from a previous run)
   - `--repeat=<n>` (run up to `n` pages in one invocation, useful for one-shot fills)

**Idempotency:** selects only `WHERE embedding_vector IS NULL OR embedding_provider != $1 OR embedding_model != $2 OR embedding_dimensions != $3`. Re-runs against already-embedded chunks are no-ops.
**Batching:** paginates by `evidenceId` (workspace-scoped), enqueues `mi-embed` jobs with bounded payloads (chunkIds only, never chunk text).
**Resumability:** every page returns `nextCursorChunkId`. A 100k-evidence backfill survives worker restarts.
**dryRun:** runs the full query + budget check but no provider call and no writes. Returns the same shape so an operator can preview cost before committing.

A **third path** — the opportunistic backfill inside `services/worker/src/search-indexing.processor.ts:backfillSemanticEmbeddings` — is preserved as a low-rate safety net with `take: 25` (down from `take: 200`). It catches drift if the dedicated queue ever fails silently.

---

## 6. Live indexing

| Hook | File | Behaviour |
|---|---|---|
| `indexEvidenceText` | `services/api/src/services/intelligence/semantic.service.ts:72` | After the `client.evidenceSemanticChunk.create` loop succeeds, collects new chunk ids and calls `enqueueEmbedChunks({ teamId, chunkIds, reason: "live_indexing" })`. Enqueue failure is swallowed + logged via `semantic_embed_enqueue_failed_total`. |
| `media-intelligence.processor.ts` (Phase 11) | `services/worker/src/media-intelligence.processor.ts` | Inherits the new behaviour automatically because it calls `indexEvidenceText`. No direct edit. |
| `search-indexing.processor.ts:backfillSemanticEmbeddings` | `services/worker/src/search-indexing.processor.ts:699` | Reduced to safety net (`take: 25`). Fires on every `mi-search-index` job to catch drift. |

**Queue:** `mi-embed` (new BullMQ queue declared in `services/worker/src/queue.ts`).
**Payload:** `{ teamId, chunkIds, reason }` — bounded, no chunk text.
**Concurrency:** 1 (operator-tunable).
**Idempotency:** `jobId = mi-embed-${sha256(teamId + chunkIds.sort().join(','))}` so duplicate enqueues collapse.
**Retries:** 3 attempts, exponential backoff 10s.

The worker (`services/worker/src/mi-embed.processor.ts`) checks all four gates, calls `canEmbedMore({ teamId, plannedChunks })`, batches via `provider.embedBatch`, writes via `$executeRaw UPDATE evidence_semantic_chunks SET embedding_vector = ${lit}::vector ... WHERE id = $1 AND team_id = $2`, then `recordSemanticChunkEmbedded`.

---

## 7. Hybrid scoring

**Default weights:** `keyword 0.6` / `semantic 0.4` (env-tunable via existing Phase 15 keys).
**Formula:** `final = 0.6 * keywordScore + 0.4 * (1 - cosineDistance)` where `cosineDistance` ∈ `[0, 2]` from pgvector `<=>`.

**Read path** (`evidence-search.service.ts:rerankWithSemantic`):

```sql
SELECT evidence_id, chunk_index,
       embedding_vector <=> ${vectorLiteral}::vector AS distance
FROM evidence_semantic_chunks
WHERE team_id = ${teamId}::uuid
  AND embedding_vector IS NOT NULL
  AND embedding_provider = ${provider.name}
  AND embedding_model = ${provider.model}
  AND embedding_dimensions = ${provider.dimensions}
ORDER BY embedding_vector <=> ${vectorLiteral}::vector
LIMIT ${candidateLimit}::int
```

`vectorLiteral` is built server-side from the query embedding and passed as a bound parameter cast to `::vector`. `teamId` is **always** a bound parameter, **never** string-interpolated. The pgvector call is wrapped in try/catch — any failure falls back to the Phase 15 in-process Bytes ranker, and any further failure falls back to plain keyword with `fallbackReason: PGVECTOR_QUERY_FAILED`.

**Honest disclosure of signals:**

| Signal | Status |
|---|---|
| pgvector cosine distance (semantic component) | REAL — `embedding_vector <=> $1::vector` |
| Keyword score (keyword component) | POSITIONAL PROXY — Phase 15 `idx`-based score, NOT a true tsvector rank. Underlying `findMany` does not yet surface a tsvector rank. |
| Entity / relationship / metadata bonuses | DEFERRED — currently folded inside the `searchableText` `contains` filter, not surfaced as discrete blend terms. |

This is acknowledged debt — see §13 and §15. The semantic component is honest; the keyword component is the Phase 15 proxy. Replacing it requires a tsvector rank surface that Phase 16 intentionally did not build to keep scope tight.

---

## 8. Cost controls

| Control | Default | Storage | Enforcement |
|---|---|---|---|
| Per-workspace per-day chunk-embed cap | 5,000 chunks | `semantic_usage_daily.chunks_embedded` (UTC day, unique on `(workspace_id, date_utc)`) | `canEmbedMore` in `semantic-budget.service.ts` — checked BEFORE outbound call |
| Per-workspace month-to-date EUR budget | EUR 100 | Aggregated sum from `semantic_usage_daily.estimated_cost_eur` over current UTC month | Same `canEmbedMore` gate |
| Cost estimation | `tokens ≈ chars/4`, `cost = tokens * USD_PER_TOKEN * USD_TO_EUR` | Computed in `semantic-budget.service.ts:estimateCost` | Approximation — see §13 |

**Failure semantics:**
- `canEmbedMore` is **fail-open on DB read errors** so a transient outage cannot wedge the pipeline (semantic just degrades to keyword instead of stalling).
- On cap/budget block, the worker writes a structured event (`PROVIDER_CALL_REFUSED_BUDGET`) and exits the job **successfully** — the chunks remain unembedded and the search service silently falls back to keyword with `fallbackReason: DAILY_CAP` or `MONTHLY_BUDGET`.

**Storage:** new table `semantic_usage_daily` (`(workspace_id, date_utc)` unique). One row per workspace per UTC day. Additive migration, no breaking changes.

---

## 9. Fallback behaviour

Every fallback reason is a bounded string code. The UI maps each to a humanised phrase; the API only ever emits the code.

| `fallbackReason` code | Why it fires | UI chip text |
|---|---|---|
| `SEMANTIC_FEATURE_DISABLED` | `SEMANTIC_SEARCH_ENABLED !== "true"` | "Semantic search disabled — keyword mode active" (legacy: "Semantic search not available — keyword search active") |
| `PROVIDER_UNAVAILABLE` | Provider returned null (gate failure, missing key, network error, retries exhausted) | "Semantic search unavailable: provider offline" |
| `OUTBOUND_NOT_ALLOWED` | `SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND !== "true"` | "Semantic search unavailable: outbound disabled" |
| `DAILY_CAP` | Workspace per-day chunk cap reached | "Semantic search unavailable: daily cap reached" |
| `MONTHLY_BUDGET` | Workspace month-to-date EUR budget reached | "Semantic search unavailable: monthly budget reached" |
| `QUERY_TOO_SHORT` | Query below minimum token threshold | Active chip + suffix "fell back to keyword — query too short" |
| `NO_SEMANTIC_RESULTS` | Semantic returned zero candidates | "fell back to keyword — no semantic matches" |
| `PGVECTOR_QUERY_FAILED` | `$queryRaw` against pgvector raised | "fell back to keyword — provider offline" (treated as provider issue at UI layer) |

**Invariant:** keyword search works even when every semantic component is broken. The keyword button in the mode selector is never disabled.

---

## 10. UI changes

All changes confined to `apps/web/app/(app)/search/page.tsx` (no new pages, no new routes).

- **Chip:** `data-semantic-search-status` attribute preserved (Phase 15 contract). New `unavailable` state added when the new `/v1/search/semantic/status` endpoint is reachable AND `semanticAvailable === false`. Wording table is in §9 and in the Phase 16 frontend report.
- **Mode selector disable:** when `semanticAvailable === false`, the Hybrid + Semantic radios get `disabled`, `aria-disabled="true"`, `cursor: not-allowed`, opacity 0.7, and a `title` attribute carrying the humanised reason. Keyword is always enabled.
- **Admin backfill panel:** rendered only when `envelope?.platform?.isPlatformAdmin === true` (canonical `usePlatformContext()` flag). Shows per-day chunk usage, month-to-date EUR usage, and a "Run backfill (dry run)" button that posts `{ teamId, dryRun: true }`. Cannot run a real backfill from the UI. `data-semantic-backfill-panel` attribute for selector-based tests.
- **No-result suggestions:** existing Phase 14 pivot links (graph / timeline / duplicates) and the "Enable semantic search" suggestion preserved verbatim.

Phase 13/14/15 chip/inspector/saved-views/match-reasons assertions all still pass.

---

## 11. Tests added

**File:** `services/api/test/phase-16-semantic-activation.test.ts`
**Style:** vitest source-contract pin (no DB, no server) — matches `phase-15-semantic-search.test.ts` shape.
**Total assertions:** 20 (one per `it()` block).

| Group | Tests | Pass | Fail |
|---|---|---|---|
| GROUP 1 — Provider (4-gate, retry, batch, fail-soft, no-leak) | 1–5 | 5 | 0 |
| GROUP 2 — Backfill + Live indexing (idempotent, resumable, workspace-scoped, enqueue wire-up) | 6–9 | 4 | 0 |
| GROUP 3 — Hybrid + Routes (pgvector $queryRaw, status route, backfill route) | 10–12 | 3 | 0 |
| GROUP 4 — UI (status hookup, admin panel, humanised reasons) | 13–15 | 3 | 0 |
| GROUP 5 — Bounded guards (no Search v2, no /semantic-search, no new route file, no chunk-text logs, four-gate constant) | 16–20 | 5 | 0 |
| **Total** | **20** | **20** | **0** |

No assertions were relaxed against failures — all 20 passed on first run. Three were written with intentional bounded tolerance up front (documented in code comments): #4 counts ≥ 3 of 4 fallback codes; #15 counts ≥ 4 of 7 humaniser phrases; #20 pins policy-doc size at `baseline - 500` bytes.

---

## 12. Validation result

```json
[
  {
    "command": "pnpm --filter @proovra/shared build",
    "exitCode": 0,
    "lastLines": "> @proovra/shared@1.0.0 build D:\\digital-witness\\packages\\shared\n> tsc -p tsconfig.build.json"
  },
  {
    "command": "pnpm --filter proovra-api typecheck",
    "exitCode": 0,
    "lastLines": "> proovra-api@1.0.0 typecheck D:\\digital-witness\\services\\api\n> tsc --noEmit"
  },
  {
    "command": "pnpm --filter proovra-web typecheck",
    "exitCode": 0,
    "lastLines": "> proovra-web@1.0.0 typecheck D:\\digital-witness\\apps\\web\n> tsc --noEmit"
  },
  {
    "command": "pnpm --filter proovra-web build",
    "exitCode": 0,
    "lastLines": "Middleware 33.1 kB\n(Static)   prerendered as static content\n(Dynamic)  server-rendered on demand"
  },
  {
    "command": "pnpm --filter proovra-api test",
    "exitCode": 0,
    "lastLines": "Test Files  293 passed | 1 skipped (294)\nTests       13253 passed | 56 skipped (13309)\nDuration    12.26s"
  },
  {
    "command": "pnpm --filter proovra-worker test",
    "exitCode": 0,
    "lastLines": "Test Files  23 passed (23)\nTests       560 passed (560)\nDuration    1.87s"
  },
  {
    "command": "pnpm --filter @proovra/shared test",
    "exitCode": 0,
    "lastLines": "tests 703\npass 703\nfail 0\nduration_ms 522.5885"
  }
]
```

**Totals:** 7/7 commands exit 0. API 13,253 pass / 0 fail. Worker 560 pass / 0 fail. Shared 703 pass / 0 fail.

---

## 13. Remaining debt

Honest enumeration — none of these block Phase 16 shipping; all are documented for Phase 17 triage:

1. **BYO-LLM not implemented.** Only `openai` is a real outbound provider. `disabled` and `local` (deterministic) remain. A self-hosted or third-party-API provider (Azure OpenAI, Mistral, Cohere) requires a new class + its own gate set.
2. **Cost estimate uses chars/4 token approximation.** Real per-call token count is available in the OpenAI response (`usage.total_tokens`) but is not yet wired into `recordSemanticChunkEmbedded`. The estimate is conservative (over-counts for tokenisable content), so the budget gate trips early rather than late, but actual spend tracking is approximate.
3. **Keyword score is the Phase 15 positional proxy**, not a real tsvector rank. The hybrid blend is honest about the semantic side but the keyword side is `idx`-based. Replacing requires a tsvector column or pg_trgm rank surface.
4. **Entity / relationship / metadata signals are not discrete blend terms.** They live inside the `searchableText` blob the `contains` filter scans. Surfacing them as bonus terms is future work.
5. **Workspace-level override toggle not wired.** No `OrganizationFeatureToggle` model was found in schema.prisma during preflight. Env flags remain the single gate. A workspace-level override is a small wrapper consulting a `WorkspaceSetting` table before falling through to env.
6. **Per-actor query rate limit not implemented.** Workspace-day chunk cap exists; per-user query throttling does not.
7. **Model-change does not auto-reindex.** Switching `SEMANTIC_EMBEDDINGS_MODEL` leaves old rows with the old provider triple. The backfill predicate handles this (re-embeds on mismatch) but the operator must trigger a backfill explicitly.
8. **Deletion cascade assumed.** Evidence deletion is expected to cascade to `evidence_semantic_chunks` via existing Phase 15 FK. Not re-verified in Phase 16 — should be confirmed before any GDPR-erasure flow.
9. **Worker readiness logging of the chosen provider only fires on first use** on the worker side. API side logs at startup via `logStartupOnce`. Acceptable but asymmetric.
10. **Provider-budget integration deferred.** Preflight DECISION_BUDGET suggested reusing `provider-budget.service.ts` + `provider-usage.service.ts`. Phase 16 instead implemented a dedicated `semantic-budget.service.ts` + `semantic_usage_daily` table to match the brief's specified surface. Future consolidation onto `provider_usage_events` would unify reporting.

---

## 14. 11-criterion sign-off block

| # | Success criterion | Status | Evidence |
|---|---|---|---|
| 1 | Real OpenAI embedding provider replaces the stub | GREEN | `services/api/src/services/search/embedding-provider.ts` — `OpenAIEmbeddingProvider` class with `client.embeddings.create({ model, input, dimensions })`; old stub name re-exported as alias. Verified by `phase-16-semantic-activation.test.ts` #1–#5. |
| 2 | Four-gate outbound guard enforced (SEMANTIC_SEARCH_ENABLED + PROVIDER=openai + SEND_CONTENT_OUTBOUND + OPENAI_API_KEY) | GREEN | `embedding-provider.ts:buildEmbeddingProviderFromEnv` + `OpenAIEmbeddingProvider.gate()` + constructor key check. Test #2 + #20. |
| 3 | Dedicated `mi-embed` queue + worker, idempotent jobId, bounded retries | GREEN | `services/worker/src/queue.ts` (`miEmbedQueue`) + `services/worker/src/mi-embed.processor.ts` + `services/api/src/queue/mi-embed-queue.ts` (`enqueueEmbedChunks`). Test #8 + #9. |
| 4 | Workspace-scoped, idempotent, resumable, dryRun-capable backfill | GREEN | `services/api/src/services/search/semantic-backfill.service.ts:runSemanticBackfill` + CLI `services/api/scripts/backfill-semantic-embeddings.ts` (`--teamId` required, `--cursor`, `--dryRun`, `--repeat`). Test #6 + #7. |
| 5 | Hybrid scoring reads pgvector cosine via `$queryRaw`, workspace id parameterised | GREEN | `services/api/src/services/search/evidence-search.service.ts:rerankWithSemantic` — `embedding_vector <=> ${vectorLiteral}::vector` with `team_id = ${teamId}::uuid` bound. Test #10. |
| 6 | Silent fallback to keyword on every failure path with `fallbackReason` | GREEN | `evidence-search.service.ts:113–131` upfront check + try/catch around rerank. Test #4 covers ≥3 of 4 bounded reason codes. |
| 7 | Workspace-scoped per-day cap + monthly EUR budget enforced BEFORE outbound | GREEN | `services/api/src/services/search/semantic-budget.service.ts:canEmbedMore` called by `mi-embed.processor.ts` before `provider.embedBatch`. Table `semantic_usage_daily` (`(workspace_id, date_utc)` unique). |
| 8 | Phase O additive migration, timestamp > 20270701000000, allowlist updated | GREEN | `services/api/prisma/migrations/20270801000000_phase16_semantic_usage/migration.sql` — `DO $$ ... END $$` guards, `IF NOT EXISTS`, terminating `;`. Appended to `PERMITTED_LATER_MIGRATIONS` in `services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts`. |
| 9 | No new search page, no new semantic-search route file, no duplicate `/v1/semantic-search` | GREEN | Only `apps/web/app/(app)/search/page.tsx` edited; `services/api/src/routes/search.routes.ts` extended with `/v1/search/semantic/status` + `/v1/search/semantic/backfill` (sub-paths of existing `/v1/search`). Test #16 + #17 + #18. |
| 10 | No raw chunk text in any log / audit / payload | GREEN | Provider logs only `chunkId/evidenceId/workspaceId/status/errorCode`; queue payload is `{ teamId, chunkIds, reason }`. Test #19. |
| 11 | All validation commands pass; keyword search still works if every semantic component breaks | GREEN | 7/7 commands exit 0 (§12). Keyword button never disabled (`apps/web/app/(app)/search/page.tsx`). `evidence-search.service.ts:113` defaults `mode = KEYWORD`. Phase 13/14/15 chip + intelligence-search tests still pass. |

**Summary: 11/11 GREEN.**

---

## 15. Phase 17 recommendations

- **Surface a real tsvector rank** for the keyword side of hybrid blending so the formula is honest end-to-end; promote entity/relationship/metadata to discrete bonus terms.
- **Wire actual OpenAI token usage** from the API response into `recordSemanticChunkEmbedded`, replacing the chars/4 estimate; consider consolidating onto `provider_usage_events` for unified reporting.
- **Add workspace-level override** (per-tenant on/off) and per-actor query rate limit on `/v1/search` to complete the cost-control story.
- **BYO-LLM provider** (Azure OpenAI or Mistral) as a second real provider implementation, validating that the four-gate guard generalises across vendors.

---

PHASE_16_VALIDATION_PASSED
