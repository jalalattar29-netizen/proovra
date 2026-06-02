# Phase 12 — Productization Final

## What this phase delivered

Phase 11 wired the intelligence backbone end-to-end: evidence-complete
already triggers graph reconcile + search-index enqueue, and OCR /
transcript extraction already calls `extractAndPersistEntities` writing
to `evidence_entities`. The data has been **produced** in workspaces
since Phase 11.

Phase 12 closes the visibility gap. Every change below is **additive**.
No second OCR, transcript, entity, graph, timeline, or search layer was
introduced. No existing API route or table was renamed. No new page
was created. The single net-new capability — perceptual-similarity
foundation — is the one item the audit confirmed was genuinely missing.

## Section A — UI surfacing (read-only consumption of existing data)

1. **`apps/web/lib/api/intelligence.ts`** — new typed client wrapping
   the EXISTING `/v1/intelligence/evidence/:id` endpoint
   (`services/api/src/routes/intelligence.routes.ts`). Returns the
   bounded projection the backend has been emitting since Phase 11:
   `extractedTexts`, `entities`, `similarities`, `disclaimer`.

2. **`apps/web/components/intelligence/EntityChipGroup.tsx`** — display-
   only component. Groups extracted entities by kind (PERSON / LOCATION
   / ORG / DATE / URL / EMAIL / PHONE / OTHER), shows source badge
   (OCR / TRANSCRIPT), shows bounded confidence label. No mutations.
   Empty-state copy is operator-forward.

3. **Evidence detail page (`apps/web/app/(app)/evidence/[id]/page.tsx`)
   — Overview tab now mounts an "Intelligence" section** that reads
   the typed client and renders:
     - the entity chip group, and
     - a bounded summary tile per extracted-text record (kind,
       provider, status, word count, confidence — no raw text), and
     - the AI advisory disclaimer.

   The fetch is single-shot, soft-fails to empty state, and never
   blocks the rest of the page.

4. **Investigation overview page (`apps/web/app/(app)/investigation/
   page.tsx`)** — surfaces two additive sections that read the EXISTING
   `/v1/investigation/reviewers` endpoint:
     - **Reviewer activity** tiles (workflow totals, open escalations,
       active external-reviewer grants) with a deep-link to the
       existing reviewer console.
     - **Indexing progress** tiles (OCR + transcript availability vs.
       indexed counts).
   Both sections collapse to bounded empty copy when the endpoint
   denies access (anti-enumeration parity).

5. **Relationships page (`apps/web/app/(app)/investigation/
   relationships/page.tsx`)** — added an inline System-detected /
   Manually-recorded badge to the **NodeInspector** incident-edge list.
   The EdgeInspector already had this badge; the NodeInspector did
   not. No new badge style was introduced — re-uses the existing
   `sourceBadgeStyle()` helper.

## Section B — Perceptual-similarity foundation

This is the single net-new backend capability in Phase 12. The audit
confirmed it was the one missing piece in the otherwise wired
intelligence pipeline: the `SIMILAR_TO` edge type is in the catalog
+ CHECK constraint, but no code wrote it and no pHash column existed.

1. **Migration — `services/api/prisma/migrations/
   20260606120000_phase12_perceptual_foundation/migration.sql`**
   - Additive only. Adds two nullable `VARCHAR(16)` columns to
     `evidence_parts`: `perceptual_phash`, `perceptual_dhash`.
   - Both columns and both indexes are wrapped in `DO $$ … END $$`
     blocks guarded by `pg_tables` + `information_schema.columns`
     (Phase O pattern). The INDEX_COLUMN_RISK safety gate is honored
     via per-column existence guards.
   - The audit script (`scripts/full-migration-audit.mjs`) verdict for
     this migration is **SAFE — 0 findings, 0 critical, 0 high, 0
     medium**.

2. **Prisma schema (`services/api/prisma/schema.prisma`)** — added
   `perceptualPhash` and `perceptualDhash` String? fields (mapped to
   the new columns) plus two `@@index` entries. `prisma format`
   verified the schema.

3. **Reconciler block (`packages/shared-runtime/src/graph/
   graph-builder.service.ts`)** — extended `reconcileTeamGraph()`
   immediately after the SAME_HASH_AS block. Self-joins
   `evidence_parts` on Hamming distance (via Postgres bit XOR +
   string-replace popcount), upserts `SIMILAR_TO` edges:
     - distance ≤ 4 → MEDIUM confidence
     - distance 5–8 → LOW confidence
     - distance ≥ 9 → dropped (noise floor)
   Edge `safe_summary` is `"Visually similar material detected;
   operator review required."` Reuses the existing `upsertEdge()`
   helper and the existing `SIMILAR_TO` edge type from the catalog.
   Whole block is wrapped in `try / catch` so a missing
   `perceptual_phash` column on a partial-state database is a clean
   no-op.

4. **Worker handler (`services/worker/src/media-intelligence.
   processor.ts`)** — added a new `compute_perceptual_hashes` job
   branch that:
     - looks up image parts only (DB-side `mime_type ILIKE 'image/%'`
       filter)
     - downloads a bounded 5 MB byte range per part
     - derives an 8×8 grayscale matrix via the already-installed
       `sharp@^0.34.5` dependency
     - computes pHash (sign-vs-mean) + dHash (sign-vs-row-neighbour),
       each as a 16-hex-char 64-bit string
     - persists both values via UPDATE on `evidence_parts`
   The handler never throws to BullMQ on a structural error. Failures
   on persist (missing column) are logged once and the job returns
   success. The `MediaIntelligenceJobKind` union was extended with the
   new kind (`services/worker/src/queue.ts`).

## Section C — Validation results

- `prisma format --schema=prisma/schema.prisma` — formatted clean.
- `tsc --noEmit` (services/api) — passed with no errors.
- `tsc --noEmit` (apps/web) — passed with no errors.
- `node scripts/full-migration-audit.mjs` — Phase 12 migration
  audited as **SAFE** with 0 findings of any severity.
- No byte-pin test on `graph-builder.service.ts` or
  `media-intelligence.processor.ts` exists, so no byte-pin
  rebaseline was required.

## Section D — Deferred to Phase 13 (per audit Section 6)

- `POSSIBLE_DERIVATIVE_OF` edge inference (requires temporal + EXIF +
  lineage heuristics, not just Hamming distance)
- Vector / semantic search (pgvector or Qdrant decision gate)
- Entity-to-graph edge materialization (`DISCOVERED_IN` /
  `EXTRACTED_FROM` edge types)
- Moving graph reconcile from inline (~300 ms) to a deferred queue
- Inline search-index fallback when Redis is unavailable
- LEGAL_HOLD + USER_CREATED_ENTITY graph node materialization

## Section E — Constitutional compliance

- Workspace kinds unchanged (PERSONAL + ORGANIZATION only).
- Team / Reviewer / Workspace contracts unchanged.
- No second OCR, transcript, entity, graph, timeline, or search layer.
- No raw env-var names in any user UI literal.
- No `window.confirm` introduced.
- No `envelope.workspace.*` reads (the new fetches use the existing
  `useTeamId()` hook).
- No new BullMQ queue — perceptual-hash handler uses the existing
  `mediaIntelligenceQueue`.
- No billing changes, no plan-cap changes.
- No core route hidden, no nav reorganization.
- Total net-new files: 4 (one API client, one component, one migration,
  one doc). Total net-new code: well under the synthesis estimate.
