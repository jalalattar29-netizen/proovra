# PROOVRA — Phase 15 Privacy-Safe Semantic Search Completion
_Status: PARTIAL — see Validation section._

## 1. Preflight summary

Phase 15 began with a comprehensive preflight verification that mapped every load-bearing surface to a Reuse / Extend / Build decision. Eight questions were resolved against the live codebase:

| # | Question | Current state | Decision |
|---|---|---|---|
| 1 | Does `/search` page exist as canonical Global Intelligence Search? | YES: `apps/web/app/(app)/search/page.tsx` — 3-column UI with filters, results, inspector | Reuse — extend with mode selector chip |
| 2 | Does `/v1/search` API exist as primary keyword search backend? | YES: `services/api/src/routes/search.routes.ts` — GET/POST with `evidence-search.service.ts` | Reuse — extend with mode + semantic params |
| 3 | Does `evidence_search_documents` table store indexed content? | YES: Prisma model with `(teamId, documentType, sourceId)` indices; `buildEvidenceProjection` populates | Reuse — no schema change needed |
| 4 | Does `EvidenceSemanticChunk` schema exist? | YES: Prisma model with `embedding` (Bytes), `embeddingProvider`, `embeddingModel`, `embeddingDimensions` columns | Reuse — forward-compatible; existing migration `20260524100000_add_intelligence_phase15` |
| 5 | Does `semantic.service.ts` stub exist with EmbeddingProvider interface? | YES: full contract with `indexEvidenceText()`, `searchSemantic()`, `setEmbeddingProvider()` | Reuse — ready for provider binding |
| 6 | What chunk size does semantic.service.ts use? | 1500 bytes; simple index-based chunking | Accept as-is for Phase 15 |
| 7 | Does semantic.service.ts implement a ranker (cosine similarity)? | YES: cosine similarity over `Float32Array` embeddings | Reuse — integrate into hybrid ranker Stage 2 |
| 8 | Is there a pgvector migration or vector DB integration? | NO: only `Bytes` column in-process | Build — additive `vector(1536)` sibling column gated behind pgvector availability |

The preflight confirmed there was **no greenfield Search v2** to build; everything was an additive extension of the existing Phase 13 Global Intelligence Search.

## 2. Vector storage decision

**Chosen: pgvector sibling column `embedding_vector vector(1536)` on `EvidenceSemanticChunk`, sitting next to the existing `embedding Bytes` column.**

Rationale:
- Re-uses the existing Postgres deployment — no new infra (Pinecone, Weaviate, Qdrant) to operate, no new credentials to manage, no new region pinning to argue about.
- Additive: the `Bytes` column stays as-is, so the existing `semantic.service.ts` cosine-similarity code path keeps working when pgvector is unavailable.
- Privilege-guarded: `CREATE EXTENSION IF NOT EXISTS vector` is wrapped in a `DO $$ ... END $$` block with `pg_extension` and `information_schema` checks so the migration is a no-op on hosts where the extension isn't installed.
- ivfflat index keeps query cost bounded as the chunk table grows.

Postponed alternatives: external vector DB (rejected for Phase 15 — adds tenancy/residency surface area), in-memory FAISS (rejected — process restarts wipe the index, doesn't survive worker pool).

## 3. Provider decision

**Chosen: pluggable `EmbeddingProvider` interface with three concrete implementations, defaulting to `DisabledEmbeddingProvider`.**

- `DisabledEmbeddingProvider` — the default. `embedText()` throws a typed `EMBEDDINGS_DISABLED` error. Phase 15 ships with this wired by default so a fresh environment never silently embeds anything.
- `LocalDeterministicEmbeddingProvider` — for tests and offline dev. Produces deterministic 1536-dim vectors from a hashed token bag. No outbound network.
- `OpenAIEmbeddingProviderStub` — gated behind `SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND=true`. If the flag is false (default), the stub throws `OUTBOUND_DISABLED` before any HTTP call is constructed. This is the privacy seatbelt the user explicitly required.

The provider is bound at startup via `setEmbeddingProvider(...)` in `semantic.service.ts` based on `SEMANTIC_EMBEDDINGS_PROVIDER` env. No provider auto-discovery, no implicit fallback to outbound services.

## 4. Migration summary (file path + safety gate verdict)

**File:** `D:/digital-witness/services/api/prisma/migrations/20270701000000_phase15_semantic_search/migration.sql`

**Safety gate verdict: PASS — additive-only, Phase O compliant.**

- Every statement nested in `DO $$ ... END $$` blocks with explicit guards.
- `CREATE EXTENSION IF NOT EXISTS vector` runs only if the current role has CREATE privilege on the database; otherwise logs and continues.
- `ALTER TABLE evidence_semantic_chunks ADD COLUMN IF NOT EXISTS embedding_vector vector(1536)` runs only if the `vector` type exists in `pg_type` and the column does not already exist in `information_schema.columns`.
- ivfflat index creation wrapped in the same guard pattern.
- Zero `DROP`, zero `ALTER ... DROP COLUMN`, zero `NOT NULL` additions on populated columns.
- The pre-existing `embedding Bytes` column is untouched, so a rollback to the prior migration leaves the table queryable.

## 5. Chunking implementation

Phase 15 accepted the pre-existing chunking algorithm in `semantic.service.ts` (1500-byte fixed-width index splits) as-is. No boundary-aware splitter was introduced in this phase — that work is explicitly deferred to Phase 16 (see §15). The chunker is invoked from the worker's `media-intelligence.processor.ts` per evidence item, wrapped in a try/catch so a chunking failure never aborts the broader intelligence pipeline.

Chunks are persisted with `evidenceId`, `workspaceId`, `chunkIndex`, the chunk text, and the embedding (both `embedding Bytes` and, when pgvector is available, `embedding_vector vector(1536)`). The `embeddingProvider`, `embeddingModel`, and `embeddingDimensions` columns are populated from the resolved provider so operators can later identify and re-embed obsolete vectors.

## 6. Embedding job implementation

Embedding is triggered from the worker's `media-intelligence.processor.ts` after evidence text extraction completes.

- Bounded: each chunk's `embedText()` call sits in its own try/catch. On failure, `logEmbeddingFailure({ chunkId, evidenceId, workspaceId, status, errorCode })` is called — note the absence of raw text, prompts, or vector contents in the log payload.
- When the provider is `DisabledEmbeddingProvider`, the failure is silent (status `EMBEDDINGS_DISABLED`) and the evidence item still completes intelligence processing.
- When `SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND=false` and the provider would otherwise reach outbound, the stub throws `OUTBOUND_DISABLED` before any network construction — the worker logs the failure and moves on.
- No retry loop, no exponential backoff into a hot embedding API — Phase 15 intentionally keeps embedding side-effect-free and non-blocking.

## 7. Hybrid ranker implementation

The hybrid ranker lives inside the existing `evidence-search.service.ts` `executeSearch` path. **Critical property: the semantic re-rank operates ONLY on the rows that the keyword path already returned through governance / visibility / legal-hold gates.** This means semantic mode cannot bypass workspace ACLs, can't surface legally-held evidence, and can't leak across workspace boundaries — because the candidate set is already filtered by the trusted keyword pipeline.

Scoring:
- `keywordScore` — preserved from the existing BM25-style projection.
- `semanticScore` — cosine similarity from `searchSemantic()` on the gated candidate set.
- Final score: `SEMANTIC_HYBRID_KEYWORD_WEIGHT * keywordScore + SEMANTIC_HYBRID_SEMANTIC_WEIGHT * semanticScore` (defaults 0.6 / 0.4).
- `matchReasons` — operator-readable strings ("Matched title", "Matched summary", "Workflow-linked", "Semantically similar") attached to each row so reviewers see *why* a row scored.

Failure path: if the semantic provider throws for any reason, the ranker silently degrades to pure keyword and stamps `fallbackReason: "PROVIDER_UNAVAILABLE"` on the response envelope.

## 8. API changes (request + response shape)

**Endpoint reused: `GET/POST /v1/search`** (no new routes; `/v1/intelligence/search` ALIAS_FORWARD preserved).

Request additions (all optional, backward-compatible):
- `mode`: `"keyword" | "hybrid" | "semantic"` — defaults to `"keyword"` when omitted, so legacy clients see no behaviour change.

Response envelope additions (optional fields):
- `modeUsed`: the mode actually executed (may differ from requested if fallback kicked in).
- `semanticAvailable`: boolean — whether the server's semantic provider is reachable right now.
- `fallbackReason`: string code (e.g. `PROVIDER_UNAVAILABLE`, `SEMANTIC_DISABLED`, `OUTBOUND_DISABLED`) — present only when `modeUsed` is downgraded from the requested mode.

Per-row additions:
- `score` — the blended final score.
- `semanticScore` — the cosine component (present only when semantic ran).
- `matchReasons: string[]` — operator-readable reasons array.

## 9. UI changes (mode selector + status chip + match reasons + inspector)

**File reused: `D:/digital-witness/apps/web/app/(app)/search/page.tsx`** — additions only; no replacement, no new route.

- **Mode selector** — three-way segmented control (Keyword / Hybrid / Semantic) added to the filter rail. Pre-Phase-15 saved views (which lack `mode`) default to hybrid when semantic is on and keyword when it isn't, *without mutating the saved view*.
- **`SemanticStatusChip`** — replaces the static Phase 13 chip with four bounded states:
  - `disabled` — preserves Phase 13 wording when no one has asked for semantic.
  - `blocked` — admin sees a `Link` to the workspace settings hint; non-admins see neutral copy.
  - `degraded` — semantic was requested but fell back to keyword; shows the `fallbackReason`.
  - `active` — semantic ran end-to-end; surfaces the `modeUsed` value.
- **Match reasons** — rendered inline on each result row from `matchReasons.map(...)` so reviewers see provenance per row.
- **Inspector** — the right-rail inspector picks up `semanticScore` and renders it alongside the existing keyword score so an operator can spot a row that ranked only because of the semantic component.
- **Admin gating** — `isAdmin` derived from `useActiveSpace()` (org OWNER/ADMIN or any personal space owner) gates the "Enable semantic search" admin hint.

## 10. Privacy policy summary

**Full policy:** [`D:/digital-witness/docs/architecture/phase-15-semantic-policy.md`](./phase-15-semantic-policy.md)

TL;DR:
- **No raw evidence text leaves the API process unless `SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND=true` is explicitly set per environment.** The stub provider throws `OUTBOUND_DISABLED` before any HTTP request is constructed.
- **No raw text, no prompts, and no vector contents are ever logged.** `logEmbeddingFailure` is bounded to `{ chunkId, evidenceId, workspaceId, status, errorCode }`; audit calls were verified to contain no chunk payloads.
- **Semantic re-rank never bypasses governance.** The hybrid ranker only re-orders rows that the keyword path already filtered through workspace ACLs, visibility rules, and legal-hold gates — semantic cannot widen the candidate set.

## 11. Billing / feature flag decision

No billing surface was added in Phase 15. The feature is gated by a single hard flag rather than per-tenant entitlement:

- `SEMANTIC_SEARCH_ENABLED` (default `false`) — master kill switch. When false, the mode selector still renders but the chip shows `disabled` and the API ignores the `mode` param.
- `SEMANTIC_EMBEDDINGS_PROVIDER` (default `disabled`) — provider binding.
- `SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND` (default `false`) — privacy seatbelt; orthogonal to the master switch.
- `SEMANTIC_EMBEDDING_MODEL`, `SEMANTIC_EMBEDDING_DIMENSIONS` (default `1536`) — provider-specific knobs.
- `SEMANTIC_HYBRID_KEYWORD_WEIGHT` (default `0.6`), `SEMANTIC_HYBRID_SEMANTIC_WEIGHT` (default `0.4`) — ranker tuning.

Per-tenant entitlement / metered billing is deferred to a later phase once usage signal is available.

## 12. Tests added

**File:** `D:/digital-witness/services/api/test/phase-15-semantic-search.test.ts` — **28 assertions, 28 passing, exit 0, 378 ms.**

Coverage:
- **Backend (15):** schema model presence, pgvector migration + Phase O DO/EXECUTE guards + `information_schema` column guards, embedding-provider interface + env defaults, hybrid ranker fields (`matchReasons` / `modeUsed` / `semanticScore` / `keywordScore`), `/v1/search` mode param + `semanticAvailable` / `fallbackReason` response, worker try/catch around `embedText`, `/v1/intelligence/search` ALIAS_FORWARD preserved, no raw text leaking into audit/log calls.
- **Frontend (9):** mode selector (Keyword / Hybrid / Semantic), `SemanticStatusChip` with bounded wordings, `matchReasons.map`, admin-only enable hint, saved-view backward-compat, response-envelope safe defaults.
- **Bounded guards (4):** no new search page, no Search v2 module, no raw chunk text in log calls, outbound disabled by default.

One assertion (#2) was tightened from `/phase15|semantic/i` to `/phase15[_-]?semantic|semantic[_-]?search/i` so it pins the dedicated Phase 15 migration (`20270701000000_phase15_semantic_search`) and no longer also matches the unrelated legacy `20260524100000_add_intelligence_phase15` migration. No production code changed for this fix.

## 13. Validation matrix

| # | Command | Exit | Summary |
|---|---|---|---|
| 1 | `services/api` `tsc --noEmit` | 0 | TypeScript compilation clean |
| 2 | `apps/web` `tsc --noEmit` | 0 | TypeScript compilation clean |
| 3 | `services/api` vitest `phase-15-semantic-search` | 0 | 28 passed / 0 failed (1 file) |
| 4 | `services/api` vitest full suite | **1** | 13229 passed / **4 failed** / 56 skipped (293 files) |
| 5 | `services/worker` vitest | 0 | 559 passed / 0 failed (23 files) |
| 6 | `pnpm --filter @proovra/shared test` | 0 | 703 passed / 0 failed |

**Totals: 14,519 passing, 4 failing, 57 skipped.**

**Failing tests (all in cmd 4):**
1. `test/phase-13-intelligence-chain.test.ts` — Phase 13 EMPTY_STATE_COPY semantic-search disabled pill (expects the old static chip; Phase 15 replaced it with `SemanticStatusChip`).
2. `test/phase-13-intelligence-completion.test.ts` — Phase 13 S4.13 semantic-search disabled pill (same root cause as #1).
3. `test/phase-32-7-2-security-event-mapping-drift.test.ts` — no new Phase 32.7.2-attributable migration (pre-existing drift, not caused by Phase 15).
4. `test/phase-o-live-schema-repair.test.ts` — `fieldToSqlType` returns concrete type for every scalar field (likely tripped by the new `Unsupported("vector(1536)")` column on `EvidenceSemanticChunk`).

**Verdict: PHASE_15_VALIDATION_FAILED** — Phase 15's own suite is green, but two Phase 13 chip-attribute tests and two pre-existing schema-attribution tests need follow-up before the suite is fully green.

## 14. Remaining debt

1. **Phase 13 chip-attribute tests (#1, #2 above)** — update the two Phase 13 tests to read the new `data-semantic-search-status` attribute on `SemanticStatusChip` instead of asserting the old static-pill text. These are assertion-side updates only; no production change needed.
2. **`phase-o-live-schema-repair` `fieldToSqlType` (#4)** — teach `fieldToSqlType` to recognise `Unsupported("vector(...)")` and return a concrete SQL type, or whitelist the `embedding_vector` column.
3. **`phase-32-7-2-security-event-mapping-drift` (#3)** — pre-existing drift unrelated to Phase 15; flag for the Phase 32 owner.
4. **Boundary-aware chunker** — current 1500-byte index split can cut mid-sentence. Defer to Phase 16.
5. **Real outbound provider** — `OpenAIEmbeddingProviderStub` is a stub that throws when outbound is enabled; wiring the actual HTTP call (with retries, rate limits, key rotation) is a separate piece of work.
6. **Per-tenant entitlement / metered billing** — deferred until usage signal exists.

## 15. Phase 16 recommendation

Phase 16 should focus on three things, in priority order:

1. **Close the four failing tests above** before any new feature work — get the suite green so Phase 15 is uncontested.
2. **Boundary-aware chunking** — sentence- or paragraph-aware splitter to improve recall on short queries against long documents. Re-embedding cost is bounded because the chunk table already tracks `embeddingProvider` / `embeddingModel` for selective re-indexing.
3. **First real outbound provider behind the existing seatbelt** — implement the actual OpenAI (or chosen vendor) call inside `OpenAIEmbeddingProviderStub`, with rate-limiting, key rotation, and a per-workspace opt-in surface in admin settings. The privacy seatbelt (`SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND`) stays as the master kill switch.

Explicitly out of scope for Phase 16: a "Search v2" page, an external vector DB migration, or any change to the `/v1/search` URL.

## 16. Sign-off — confirmation block

- No Search v2 — **✓**
- No new search page — **✓**
- Semantic flag works (`SEMANTIC_SEARCH_ENABLED`) — **✓**
- Keyword fallback works — **✓**
- No raw text logged — **✓**
- Outbound disabled unless explicitly enabled — **✓**
- All tests pass — **✗** (4 failures: 2 Phase 13 chip-attribute tests, 1 Phase O `fieldToSqlType`, 1 pre-existing Phase 32.7.2 drift — see §13 / §14)
