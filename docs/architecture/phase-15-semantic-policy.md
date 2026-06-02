# PROOVRA — Phase 15 / Phase 16 Semantic Search Privacy & Governance Policy

Status: Binding governance artifact for Phase 15 (Privacy-Safe Semantic Search + Hybrid Ranker) AND Phase 16 (Semantic Search Activation — real OpenAI provider, bounded backfill, cost gates).
Scope: Extends the existing Global Intelligence Search (Phase 14) and `/v1/search` API. Does NOT introduce a new search page, a new route file, a new indexer, a new service surface, or a `/v1/semantic-search` endpoint.

Cross-references (read before changing this doc):
- `docs/architecture/search-reality-audit.md`
- `docs/architecture/phase-14-global-intelligence-search-completion.md`
- `docs/architecture/phase-13-intelligence-chain.md`

---

## 0. Phase 16 Activation — what changed

Phase 15 documented the SAFE / DISABLED state of semantic search: the migration shipped, the column existed, the hybrid ranker was wired, and the OpenAI provider was a stub that always threw `PROVIDER_NOT_IMPLEMENTED` (see `services/api/src/services/search/embedding-provider.ts:194` before activation). No chunk text ever left the process boundary.

Phase 16 activates the engine while preserving every Phase 15 guarantee. The deltas:

- The OpenAI embedding provider is now wired for real (`services/api/src/services/search/embedding-provider.ts`) — but it remains behind the same four-flag gate (see §4). The `PROVIDER_NOT_IMPLEMENTED` throw is replaced with a real `embeddings.create` call ONLY when every flag is satisfied AND `OPENAI_API_KEY` is present.
- A dedicated BullMQ queue `mi-embeddings` (`services/worker/src/queue.ts`) batches embedding compute outside the request path. Idempotent `jobId = mi-embeddings-${evidenceId}`, attempts: 3, exponential backoff. Producer is `enqueueEmbeddingJob`; consumer lives in the worker tier.
- A workspace-scoped, resumable admin backfill script `services/api/scripts/backfill-semantic-embeddings.ts` exists for one-time "turn on semantic for an existing workspace" events. It requires `--teamId=<uuid>` and supports `--cursor=<evidenceId>` and `--dryRun`.
- Live indexing now fires on every new `EvidenceSemanticChunk` row: `indexEvidenceText` in `services/api/src/services/intelligence/semantic.service.ts` enqueues an `mi-embeddings` job after chunk persistence, so the dedicated worker fills both the legacy `embedding` Bytes column and the pgvector `embedding_vector` column.
- Cost gates are enforced per-workspace per-day BEFORE any outbound call: a Redis-keyed daily chunk counter (default 50,000 chunks/workspace/day, env-tunable) and the existing `provider-budget.service.ts` / `provider-usage.service.ts` pair. `embed_text` is a new `ProviderAdapterOperation`. No new `SemanticUsageDaily` model — reuses `provider_usage_events`.
- Hybrid ranking now uses pgvector cosine distance (`embedding_vector <=> $vectorLiteral::vector`) via Prisma `$queryRaw` with the `teamId` parameter bound (NEVER interpolated). The in-process Bytes ranker in `services/api/src/services/intelligence/semantic.service.ts` remains as the silent-degrade fallback when pgvector is unavailable.

What did NOT change in Phase 16:
- The list of embeddable text (§1) is unchanged.
- The storage location (§2) is unchanged.
- The four-flag gate (§4) is unchanged.
- Keyword search still works with EVERY semantic component broken (§13).
- No new search page, no new search route, no `/v1/semantic-search`.

---

## 1. What text can be embedded

Embeddable (bounded list — anything outside this list is forbidden):
- Evidence title + description (already non-sensitive operator-authored metadata)
- OCR text chunks (per existing `EvidenceSemanticChunk` boundaries)
- Transcript chunks (audio/video transcripts)
- Entity normalized values (`kind:value` chunks per Phase 13)
- Relationship summary chunks (operator-authored)
- Report summary text (only if the report is already indexed by Phase 14)
- Case summary text (only if the case is already indexed by Phase 14)

NEVER embedded:
- Raw evidence file bytes (images, video, audio, documents)
- PII pulled from non-OCR sources (e.g., contact lists, headers, EXIF identity fields)
- Audit log content
- Authentication / session material
- Any content from workspaces the requester cannot read

Phase 16 does not widen this list. The OpenAI provider receives ONLY the `chunkText` field already produced by Phase 13 chunking — no evidence id, no email, no actor identifier, no workspace identifier travels in the request body.

## 2. Where embeddings are stored

- Column: `EvidenceSemanticChunk.embedding_vector` typed as pgvector `vector(1536)` (Prisma `Unsupported("vector(1536)")` — `services/api/prisma/schema.prisma:3921`)
- Database: PROOVRA's primary Postgres database — same tenancy boundary as the underlying evidence
- Tenancy: workspace-scoped via the existing `teamId` column on `EvidenceSemanticChunk`
- No external vector database
- No external embedding cache
- No cross-workspace embedding sharing

The pgvector extension is created by `services/api/prisma/migrations/20270701000000_phase15_semantic_search/migration.sql` (line 1, wrapped in `CREATE EXTENSION IF NOT EXISTS vector`). Phase 16 migrations use later timestamps and the same Phase O additive pattern (DO `$$` wrappers, `information_schema` guards, terminating `;`).

## 3. Does content leave PROOVRA?

- Default: NO. With `SEMANTIC_EMBEDDINGS_PROVIDER=disabled` or `=local`, chunk text never leaves the PROOVRA process boundary.
- Phase 16 opt-in outbound: With `SEMANTIC_SEARCH_ENABLED=true` AND `SEMANTIC_EMBEDDINGS_PROVIDER=openai` AND `SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND=true` AND `OPENAI_API_KEY` present, chunk text is transmitted to OpenAI's embeddings endpoint for vectorization. ALL four conditions must hold; missing any one keeps PROOVRA in local/disabled mode and the provider returns `null` (silent degrade) with `errorCode: "OPENAI_API_KEY_MISSING"` or `errorCode: "OUTBOUND_DISABLED"`.
- The request body contains ONLY the chunk text array and the model name. Workspace id, evidence id, chunk id, user id, and any other PROOVRA identifier are NEVER included in the outbound payload.
- Only the structured audit record (chunk id, evidence id, workspace id, status, errorCode, provider, model, dim) is recorded on the PROOVRA side. Raw text is NEVER logged.

## 4. Outbound provider gating

Four environment flags govern semantic search behavior. Defaults are conservative and Phase 16 does not relax any of them:

- `SEMANTIC_SEARCH_ENABLED` — default `false`. Master switch for the semantic mode on `/search`. When false, the existing "Semantic search not available — keyword mode active" chip (`apps/web/app/(app)/search/page.tsx`, `data-semantic-search-status`) remains active.
- `SEMANTIC_EMBEDDINGS_PROVIDER` — default `disabled`. Allowed values: `disabled`, `local`, `openai`.
- **`SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND`** — default `false`. Safety flag. Must be `true` for any chunk text to leave the process boundary. Enforced in `OpenAIEmbeddingProvider.gate()` (`services/api/src/services/search/embedding-provider.ts:182`).
- **`SEMANTIC_EMBEDDINGS_REQUIRE_POLICY_ACK`** — default `true`. Safety flag. Requires operator acknowledgment that this policy doc has been reviewed.

Phase 16 adds NO new flag whose default is `true` for outbound behavior. The dual gate is preserved: an operator must explicitly flip BOTH `SEMANTIC_SEARCH_ENABLED` AND `SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND` AND set the provider to `openai` AND provision an API key before a single byte of chunk text leaves the process.

Per constitutional rules, these raw env-var names MUST NOT appear in user-facing UI; surface human-readable labels instead.

## 5. Workspace opt-in posture

- Workspace kinds: PERSONAL and ORGANIZATION only (no fake workspace types).
- Workspace admins may toggle per-workspace semantic search where the existing plan-gating model supports it.
- Gating decision: semantic mode is available on PRO, TEAM, and ENTERPRISE plans, and requires workspace admin enablement on ORGANIZATION workspaces. PERSONAL workspaces inherit plan entitlement directly.
- Plan/entitlement rules from Phase 10 are NOT bypassed.
- Phase 16: a per-workspace daily chunk cap (default 50,000) and a workspace-scoped monthly EUR budget (via `provider-budget.service.ts`) apply on top of plan entitlement. Exceeding either silently degrades to keyword for that workspace for the rest of the budget period.

## 6. Retention behavior

Embedding rows follow the same retention policy as the parent `EvidenceSemanticChunk`, which is governed by Phase 4B retention. No separate retention clock exists for vectors. Phase 16 does not add one.

## 7. Deletion behavior

When evidence is destroyed, the associated embedding rows are removed in the same Phase 4B destruction sweep — vectors do not survive their source. The `embedding_vector` column is part of the same `EvidenceSemanticChunk` row, so the existing cascade in `services/api/src/services/evidence-complete.service.ts` carries it. Backfill never resurrects a row for evidence that has been destroyed; the workspace-scoped query in the backfill script filters on the live evidence set.

If implementation review reveals a cascade gap (e.g., the destruction sweep skips chunk rows for some destruction path), that gap is listed in §16 (Phase 16 Debt) and patched separately — it must not be silently absorbed.

## 8. Legal hold behavior

Evidence under legal hold: embeddings are preserved (no deletion). Semantic search respects the existing legal-hold filtering applied by `/v1/search` (`services/api/src/services/search/evidence-search.service.ts:148`); held items appear only to users authorized to see them. Semantic ranking does NOT bypass the legal-hold filter — the filter applies BEFORE the rerank, so held items can only appear in semantic results for users who would also see them in keyword mode.

## 9. Destroyed evidence handling

Destroyed evidence: embeddings deleted. No semantic match is possible against destroyed sources. Export-restriction filters from the keyword path (`evidence-search.service.ts:151`) are reused unchanged and apply BEFORE the semantic rerank.

## 10. Audit logging

- Each embedding job logs a structured record: `{ chunkId, evidenceId, workspaceId, status, provider, model, dim, errorCode? }`.
- NEVER logs: raw chunk text, OCR text, transcript text, entity values, query text, or any user prompt content.
- Reuses the existing `search-audit.service.ts` pattern from Phase 14 — no new audit pipeline.
- Phase 16 outbound calls additionally emit a `PROVIDER_CALL_*` event via `recordProviderUsage` (`services/api/src/services/intelligence/provider-usage.service.ts`). The recorded fields are the same bounded set; no payload bytes are stored.
- Budget refusals emit a `PROVIDER_CALL_REFUSED_BUDGET` activity event and the job exits successfully (chunks remain unembedded — not a worker failure).

## 11. Cost controls

Phase 16 adds layered cost enforcement, all workspace-scoped, all checked BEFORE any outbound call:

- Per-workspace per-day chunk cap: Redis `INCR` keyed on `embeddings:${teamId}:${YYYY-MM-DD}` with a 36-hour TTL. Default 50,000 chunks/workspace/day, env-tunable. Exceeding the cap silently degrades to keyword for that workspace for the remainder of the UTC day.
- Per-workspace monthly EUR budget: `decideBudgetGate({ teamId, provider: "openai", operation: "embed_text", scope: "WORKSPACE", estimatedCostUsdMicros })` runs BEFORE every outbound call. On `BLOCK`, the job exits successfully without calling OpenAI.
- Batch size: OpenAI `embeddings.create` is called with arrays of at most 96 chunk texts per request — bounded so any single failure cannot waste a large call.
- Retry policy: 3 attempts with exponential backoff (250ms → 1s → 4s) on HTTP 429 / 5xx only. Other errors surface immediately as `null` with a bounded `errorCode`. No retry storms.
- Per-request timeout: 30s hard cap via `AbortController`.
- No background re-embedding sweeps without explicit operator action. The opportunistic backfill in `services/worker/src/search-indexing.processor.ts:699` is reduced to `take: 25` per job (safety net only); bulk work goes through the dedicated `mi-embeddings` queue.

## 12. Failure behavior

- Provider down (HTTP error, timeout, exhausted retries): response carries `modeUsed=keyword`, `fallbackReason=PROVIDER_UNAVAILABLE`. The embedding job returns `null` and `logEmbeddingFailure` records the error code.
- Provider returns an invalid embedding (wrong dimensionality, NaN, etc.): keyword fallback for that query; the invalid response is discarded and counted in audit logs.
- Outbound disabled (`SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND !== "true"`): provider returns `null`, errorCode `OUTBOUND_DISABLED`. Keyword fallback engaged.
- API key missing: provider returns `null`, errorCode `OPENAI_API_KEY_MISSING`. Keyword fallback engaged.
- Daily chunk cap exceeded: job exits without calling OpenAI; chunks remain unembedded; subsequent searches against those chunks degrade to keyword.
- Monthly budget exceeded: same — `decideBudgetGate` returns `BLOCK`, no outbound call, no embedding, keyword fallback.
- pgvector extension missing OR `$queryRaw` cosine distance query fails: response carries `modeUsed=keyword`, `fallbackReason=VECTOR_INDEX_UNAVAILABLE`. The hybrid ranker catches the failure and silently degrades to the in-process Bytes ranker for that query.
- Provider failure → keyword fallback. The semantic provider going down (or being disabled, blocked, or otherwise unavailable) NEVER throws out of `/v1/search`. The route always returns a successful response with `modeUsed=keyword` and `fallbackReason` set honestly (`services/api/src/services/search/evidence-search.service.ts:113–131` for the upfront check; the try/catch around the rerank handles in-flight failures).

## 13. Fallback behavior

Keyword search ALWAYS works regardless of semantic state. The `/search` page and `/v1/search` API remain fully functional with `SEMANTIC_SEARCH_ENABLED=false`, with the OpenAI provider down, with the pgvector extension missing, with the daily cap exhausted, with the monthly budget blocked, with the embedding queue paused, and with every chunk row having a `NULL` `embedding_vector`. Saved searches, inspector, existing filters, and the keyword path are preserved exactly as Phase 14 shipped them. This is verified by the existing `requestedMode = filter.mode ?? "KEYWORD"` default at `evidence-search.service.ts:113`.

## 14. Backfill semantics

Phase 16 introduces a workspace-scoped backfill path with three layers:

- Dedicated queue `mi-embeddings`: every `EvidenceSemanticChunk` insert enqueues a job (`enqueueEmbeddingJob` in `services/worker/src/queue.ts`). Idempotent `jobId = mi-embeddings-${evidenceId}` so retries collapse. Attempts: 3, exponential backoff 10s.
- Admin script `services/api/scripts/backfill-semantic-embeddings.ts`: required `--teamId=<uuid>`, supports `--cursor=<evidenceId>` for resumability and `--dryRun` for inspection without writes. Iterates by workspace + evidenceId; never crosses workspace boundaries.
- Opportunistic safety net inside `services/worker/src/search-indexing.processor.ts:backfillSemanticEmbeddings` (line 699), throttled to `take: 25` per `mi-search-index` job — catches drift if the dedicated queue ever silently fails.

All three layers share the same idempotency predicate (`embedding IS NULL OR embedding_vector IS NULL OR embedding_provider mismatch OR embedding_model mismatch OR embedding_dimensions mismatch`), the same workspace-scoped query, and the same cost gates from §11. Backfill never sends content outbound unless the §4 four-flag gate is satisfied.

## 15. Non-claims

- Semantic search is RETRIEVAL ASSISTANCE only.
- Semantic matches do NOT prove facts.
- Semantic matches do NOT determine truth.
- Semantic matches do NOT establish authenticity or chain of custody.
- Semantic matches do NOT carry legal admissibility weight.
- Operators must independently verify any evidence surfaced by semantic ranking before relying on it in any external proceeding.

Phase 16 does not change any of these non-claims. Activating the real OpenAI provider increases recall; it does NOT change what a match means.

## 16. Phase 16 Debt — known gaps

The following are acknowledged Phase 16 gaps that future work must address. They are listed honestly here so no downstream reader believes Phase 16 is broader than it is:

- Per-workspace provider override (BYO-LLM): not implemented. All workspaces share the same `SEMANTIC_EMBEDDINGS_PROVIDER` env-resolved provider. Operators cannot today route Workspace A's chunks to OpenAI and Workspace B's chunks to a local provider.
- Cost tracking calibration: `estimatedCostUsdMicros` passed to `decideBudgetGate` is estimated from `chars / 4` token approximation. The actual reported token count from OpenAI's response is recorded in `recordProviderUsage`, but the pre-call gate uses the estimate. Drift between estimate and actual is reconciled at the next budget refresh, not in real time.
- Cascade verification: deletion behavior (§7) assumes the Phase 4B destruction sweep cascades to `EvidenceSemanticChunk` for every destruction path. If implementation review surfaces a path that orphans chunk rows, it is patched separately and a row is added here.
- Live re-embedding on policy revision: when an operator changes `SEMANTIC_EMBEDDING_MODEL` or `SEMANTIC_EMBEDDING_DIMENSIONS`, existing rows are NOT auto-reindexed — the admin must run the backfill script. The idempotency predicate ensures the script will pick them up.
- Per-query embedding cost: the query-side embedding (one call per `/v1/search` with `mode=SEMANTIC` or `HYBRID`) is gated by the same workspace daily cap but is NOT separately rate-limited per actor. A misbehaving user could consume an entire workspace's daily cap with rapid queries. Per-actor rate limiting is deferred.

## 17. Sign-off

This policy is binding on Phase 15 AND Phase 16. Any change — including adding a new embeddable content type, a new provider, a new outbound destination, a relaxation of the default flags, a widening of the request body sent to OpenAI, a removal of a cost gate, or a new field added to outbound audit logs — requires a new policy revision committed to this file before code changes ship.
