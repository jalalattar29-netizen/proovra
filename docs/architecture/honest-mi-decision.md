# Honest-MI Decision (Phase G5.1)

**Status:** Decision **B-prime** — bounded honest scope, neither full removal nor full ship.

**Audience:** product engineers, ops leads, customer success, security/legal review.

**Authority:** This document is the source of truth for what PROOVRA does and
does NOT do with OCR / transcription / media intelligence. Every UI label,
runbook claim, demo deck, and marketing string must be consistent with this
decision. Discrepancies are bugs.

---

## 1. The decision in one paragraph

PROOVRA today **does not extract OCR text or audio/video transcripts from
uploaded evidence.** The platform ships a bounded read-only "media-intelligence
signal projection" subsystem that:

- Surfaces deterministic, heuristic signals about uploaded evidence (EXIF
  presence, asset kind, container/codec observations, etc.).
- Reads pre-indexed OCR/transcript rows **only if** they exist in the database
  (`evidence_ocr_text`, `evidence_transcript_segments`). In the current
  deployment these tables are not populated — no extraction job writes to them.
- Never makes legal, authenticity, admissibility, "tampered", "forged",
  "manipulated", or "proves" claims. The signal catalog's `safeSummary()` is
  source-contract tested.
- Renders an advisory-only operator panel on the evidence detail page. The
  panel is **bounded** — no extraction button can be wired to run today.

This is **not Option A** (ship a full OCR/transcript pipeline) and **not raw
Option B** (delete every byte). It is the honest middle path: a bounded
scaffold the platform can grow into when a real provider is procured, with
zero current UI implication of capability that doesn't exist.

---

## 2. Why neither pure option

### Why not Option A (ship)?

- No OCR provider is configured today (no AWS Textract, no Google Vision, no
  Tesseract worker, no Whisper, no provider-abstraction layer wired to a
  vendor).
- No per-workspace opt-in toggle exists for OCR/transcript consent.
- No per-tenant budget guard exists for vendor cost.
- No custody event types `OCR_COMPLETED` / `TRANSCRIPT_COMPLETED` are emitted
  by any pipeline.
- Shipping fake capability would violate every non-negotiable goal of G5.

### Why not raw Option B (delete everything)?

- The existing scaffold is **bounded, safe-worded, and read-only**. It does
  not lie; it surfaces deterministic signals that are operationally useful.
- The signal catalog's vocabulary discipline (no "tampered" / "authentic" /
  "admissible" / "proves" / "confirms") is itself a piece of governance
  infrastructure that future capability would inherit.
- Deleting 78 files in a deep-cleanup phase carries semantic-change risk
  that contradicts the G4 "no semantic changes" rule still in effect.
- The audit found zero UI surfaces that **claim extraction runs**. The risk
  is the UI implying capability, not the backend lying.

The right move is to lock the UI honesty contract + keep the backend as a
bounded scaffold + document the boundary so a future Option A is a
self-contained PR.

---

## 3. What is shipped today

| Surface | Status | Notes |
| --- | --- | --- |
| Backend MI service tree | ✅ Shipped | `services/api/src/services/media-intelligence/*` — bounded, safe-worded, deterministic. No vendor calls. |
| Signal catalog + safe wording | ✅ Shipped | `packages/shared-runtime/src/media-intelligence/signal-catalog.ts` — contract-tested vocabulary discipline. |
| MediaIntelligencePanel UI | ✅ Shipped | Operator panel on evidence detail. Renders heuristic signals + EXIF + asset-kind. NEVER offers extraction. |
| OCR/transcript indexer | ✅ Shipped, dormant | `INDEX_EXISTING_ONLY` mode. Reads pre-existing rows; never extracts. The source tables are unpopulated. |
| Custody events on completion (OCR_COMPLETED / TRANSCRIPT_COMPLETED) | ❌ Not shipped | No pipeline emits these today. |
| Per-workspace opt-in toggle | ❌ Not shipped | No consent flow. |
| Per-tenant budget guard | ❌ Not shipped | No vendor cost path. |
| Local Tesseract / Whisper extractor | ⛔ Stub only | `services/worker/src/local-ocr-transcript-capability.ts` — both probes return `{ ok: false, reason: "not_enabled" }`. |
| Vendor provider abstraction (Textract / Whisper / etc.) | ❌ Not shipped | No vendor SDK imported. |

---

## 4. UI honesty contract

The following rules apply to **every operator-facing surface** in `apps/web`:

1. **No button or label may imply extraction runs today.** Forbidden phrases:
   - "Extract text"
   - "Run OCR"
   - "OCR this"
   - "Transcribe"
   - "Transcribe audio"
   - "Generate transcript"
   - "Index text"
   - "Index transcript"
2. **No empty-state copy may suggest pending extraction.** Forbidden phrases:
   - "Text will appear here after OCR completes"
   - "Transcript pending"
   - "Indexing in progress" (when no indexing pipeline is running)
3. **The MediaIntelligencePanel may render signals — but its top label must
   be operationally honest.** Allowed framing:
   - "Operational signals" / "Advisory signals" / "Evidence signals"
   - "These signals are deterministic heuristics. They are not legal or
     forensic findings."
4. **Marketing / pricing / onboarding pages may not list OCR or
   transcription as a feature.** If any tier copy currently lists OCR
   transcription as a benefit, it must be removed.
5. **Report PDF and Verification Package ZIP must not include OCR text or
   transcripts** until the extraction pipeline is real.
6. **Public verify must not reference OCR or transcript text.**

These rules are enforced by the G5 source-contract test
`phase-g5-honest-mi.test.ts` which fails CI if any forbidden phrase appears
in `apps/web/**`.

---

## 5. Decision trail

| Date | Phase | Decision | Owner |
| --- | --- | --- | --- |
| Phase 31.6 | MI subsystem shipped | Build bounded read-only signal projection with safe-word catalog. | Engineering |
| Phase 31.13 | Derived-assets viewer | Add thumbnail/preview rendering. Still no extraction. | Engineering |
| Phase G5.1 (this doc) | Honest-MI decision | Keep the bounded scaffold + lock UI honesty contract. Reject premature ship. | Platform |
| **Future Phase X** | Real OCR/transcript | When vendor procured + consent flow + budget guard ready, ship Option A as a self-contained PR. | Engineering + Legal + Security |

---

## 6. When Option A becomes available

When OCR/transcript extraction is genuinely shipped (future phase), this
document must be updated in the SAME PR. The Option A PR must include:

1. Vendor provider abstraction (Textract / Whisper / equivalent) — backend-only.
2. Per-workspace opt-in toggle (consent flow + audit emission).
3. Per-tenant budget guard with rejection signal.
4. Custody events: `OCR_COMPLETED`, `TRANSCRIPT_COMPLETED`,
   `MEDIA_INTELLIGENCE_FAILED`.
5. Tests for consent, budget, failure, custody, and privacy paths.
6. Report PDF + Verification Package ZIP inclusion ONLY with clear labelling
   ("Auto-generated OCR — operator review required; not a legal finding").
7. Retention/governance applies to generated text (Phase G1 hold + destruction
   semantics inherited automatically).
8. Failure never blocks the evidence core flow.
9. This decision doc updated from B-prime to A.

The UI honesty contract above continues to apply — even after Option A ships,
**no language may overclaim legal, forensic, or authenticity meaning**.

---

## 7. Reference

- Backend services: [services/api/src/services/media-intelligence/](../../services/api/src/services/media-intelligence/)
- Shared catalog: [packages/shared-runtime/src/media-intelligence/signal-catalog.ts](../../packages/shared-runtime/src/media-intelligence/signal-catalog.ts)
- Worker stub: [services/worker/src/local-ocr-transcript-capability.ts](../../services/worker/src/local-ocr-transcript-capability.ts)
- UI panel: [apps/web/components/media-intelligence/MediaIntelligencePanel.tsx](../../apps/web/components/media-intelligence/MediaIntelligencePanel.tsx)
- Source-contract test: [services/api/test/phase-g5-honest-mi.test.ts](../../services/api/test/phase-g5-honest-mi.test.ts)
