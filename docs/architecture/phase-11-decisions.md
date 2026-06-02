# Phase 11 decisions — Intelligence wiring & visibility

> Owner: Phase 11 (connect + relabel pass).
> Date: 2026-06-02.

## 1. Verdict

Phase 11 is a **connect-only** pass. All five major intelligence
capabilities (graph reconcile, OCR foundations, transcription
foundations, entity extraction, search) and all three similarity
layers already have correct, production-grade implementations in the
codebase. The discovery audit
(`docs/architecture/investigation-suite-audit.md`,
`docs/architecture/workspace-surface-audit.md`,
`docs/architecture/phase-7-closure-audit.md`) confirmed:

- services exist
- Prisma models exist
- routes exist
- governance gates exist
- previous workspace-surface visibility fixes have already landed

The only genuinely missing work is event-trigger wiring at finalize
time. Building a v2 of any of the existing layers would violate the
do-not-duplicate rule.

## 2. What was wired in Phase 11

Three EVENT_WIRE fan-outs were added to existing producers. All three
are idempotent, swallow their own errors, and never block the parent
flow:

| Trigger point | Fan-out target | Mechanism |
|---|---|---|
| `evidence-complete.service.ts` after finalize | Discovery search reindex | `enqueueSearchIndexingJob` (existing API queue helper) |
| `evidence-complete.service.ts` after finalize | Investigation graph reconcile | Dynamic import of `reconcileTeamGraph` (mirrors existing `ops.routes.ts` pattern) |
| `extraction.service.ts` after a successful `EvidenceExtractedText.COMPLETED` write | Entity extraction | Dynamic import of `extractAndPersistEntities`, source mapped from `jobKind` (OCR → OCR, TRANSCRIPT → TRANSCRIPT) |

No new queues, no new worker files, no new Prisma models, no new
producer modes flipped, no billing or SSO changes.

## 3. Deferred to Phase 12 (deliberate gaps)

These items have working foundations but no continuous producer. They
will be activated when the operator-side configuration story is ready.
Building them in Phase 11 would create parallel layers next to the
existing INDEX_EXISTING_ONLY infrastructure.

1. **Continuous OCR producer activation** — local Tesseract or vendor
   cloud adapter wired to evidence finalize for image/PDF MIME types.
   Foundation already present (`ocr-foundations.service.ts`, Azure
   adapter, `evidence_ocr_text` table). Producer mode flip requires
   explicit deployment verification.
2. **Continuous transcription producer activation** — Deepgram adapter
   invoked from the `wire_ocr_transcript` job processor on audio/video
   evidence. Foundation already present
   (`transcript-foundations.service.ts`, Deepgram adapter with
   diarization, `evidence_transcript_segments` table).
3. **Perceptual similarity producer** — pHash/dHash worker that
   materialises `SIMILAR_TO` graph edges. Enum types are already
   defined; UI surfaces an honest empty state today.
4. **Document-text similarity auto-trigger** — invoke
   `detectTextSimilarForEvidence` on text-extraction completion and
   bridge `EvidenceSimilarity` rows to graph
   `POSSIBLE_DERIVATIVE_OF` edges. Manual reconcile route remains
   today.
5. **Semantic / embedding search** — pgvector column on
   `EvidenceSearchDocument` plus an embedding provider plus an
   `executeSemanticSearch()` planner.
6. **Entity-extraction → graph reconciliation** — ENTITY node type
   plus MENTIONS / HAS_ENTITY edges plus cross-evidence entity
   resolution. Today entities exist as rows alongside evidence but
   are not promoted into the graph.
7. **OPENAI_ENTITY_EXTRACTION adapter** — registered but inert today.
8. **Confidence-score upgrade** — populate `EvidenceEntity.confidence`
   and map similarity scores into graph edge confidence bands.

## 4. Producer-mode discipline

`OCR_PRODUCER_MODE` and `TRANSCRIPT_PRODUCER_MODE` defaults remain
`NOT_CONFIGURED` / `INDEX_EXISTING_ONLY`. Phase 11 does NOT flip
either default. Any flip must come with explicit deployment
verification, a billing-impact review (vendor cost exposure), and an
on-call dashboard. This discipline keeps the platform truthful about
which signals are derived live vs. which are indexed-only.

## 5. Navigation visibility — deferred flips

Three NAV_VISIBILITY flips in the Phase 11 synthesis were
intentionally NOT applied in this pass:

- `workspace.evidence_requests.commandPaletteVisible = true` — would
  surface a route whose root list page does not exist; would lead the
  operator to a 404 (constitutional rule 11). The detail page remains
  reachable from `MatterWorkspace`. Re-enable when the root list
  ships.
- `investigation.reviewers` cmd-K capability scope — the route
  registry today exposes only boolean visibility flips
  (`sidebarEligible` / `commandPaletteVisible` / `allToolsVisible`).
  Per-entry capability-scoped cmd-K visibility requires a new
  registry field; Phase 11 forbids registry schema changes. Backend
  REVIEWER_OPS_VIEW gating remains the authority.
- `sidebarHideUntilSeeded` on the four investigation sub-routes
  (`hub` / `graph` / `duplicates` / `timeline`) — requires a new
  registry field. Same reason as above. The pages themselves already
  carry honest empty states.

These three items are documented here so a future phase can either
ship the missing primitives (root list page, registry field) or
revisit the design.

## 6. Hard-no list

- No OCR v2, transcript v2, graph-reconcile v2, search v2,
  similarity v2, or entity-extraction v2 services.
- No new Prisma models, migrations, or schema columns.
- No new worker files.
- No flipping `OCR_PRODUCER_MODE` or `TRANSCRIPT_PRODUCER_MODE` from
  `NOT_CONFIGURED` without explicit deployment verification.
- No hiding Capture, Evidence, Cases, Search, Home, Billing,
  Settings.
- No billing / SSO / SCIM / Team-model / Workspace-kind changes.
- No deleting routes.
- No bridging `EvidenceSimilarity` to graph edges this phase.
- No ENTITY node types added to graph this phase.
- No semantic / embedding search introduction.
