# PROOVRA Technical Metadata — Final Integration Audit

**Audit date:** 2026-06-30
**Type:** Audit only — no code changed
**Scope:** Media Technical Summary, EXIF Summary, Capture Environment across Report, Verify Page, Verification Package, Internal UI; plus the Advisory Observations rename and ffprobe production readiness.

---

## Executive Summary

The three enterprise metadata layers are **implemented end-to-end and verified against the live code**. Storage, extraction, projections, package files, PDF report, public verify page, and internal evidence UI are all present, privacy-safe, and graceful-degrading. The Advisory Observations rename and the report-section wiring bug are fixed. ffprobe is installed in the worker image with a working capability fallback.

**Verdict: the implementation is complete and production-quality for the web-capture path.** The audit found **7 issues**, none of them blocking: 1 medium (capture-environment is only collected on the web `POST /v1/evidence` path), and 6 low/informational (backfill, UI discoverability, ffprobe rebuild timing, no aggregate stats yet, minor polish). No privacy leaks, no crashes, no missing report/verify/package outputs.

**Issues found: 7 (0 critical / 1 medium / 6 low-or-info).**

---

## What Was Added

| Layer | Storage | Extraction | Report | Verify Page | Package | Internal UI |
|---|---|---|---|---|---|---|
| Media Technical Summary | `EvidencePart.technicalMetadata` (canonical, per-part) + `Evidence.technicalMetadata` (single-file mirror) | worker `extract_technical_metadata` job → image/video/pdf parsers | "Media Technical Summary" section | "Technical Metadata" → Media card | `technical-metadata/media-summary.json` | Technical Appendix card → Media block |
| EXIF Summary | derived from `technicalMetadata` | derived (exifr) | EXIF sub-block (when applicable) | EXIF card (when applicable) | `technical-metadata/exif-summary.json` (when applicable) | EXIF block (when applicable) |
| Capture Environment | `Evidence.captureEnvironment` (privacy-safe) | `buildCaptureEnvironment` at create | Capture Environment sub-block | Capture Environment card | `technical-metadata/capture-environment.json` | Capture Environment block |

### Where each layer is stored
- **Media technical metadata** — `evidence_parts.technical_metadata` (JSONB, per-part = canonical); mirrored to `evidence.technical_metadata` for single-part convenience. Parser provenance in `technical_meta_parsed_at` / `technical_meta_parser`.
- **EXIF summary** — not separately stored; derived deterministically from `technicalMetadata` via `deriveExifSummary`. (The legacy `evidence_part_exif_summaries` table also still exists from the earlier EXIF pipeline.)
- **Capture environment** — `evidence.capture_environment` (JSONB), privacy-safe shape only (masked IP + UA hash + parsed browser/OS/device/timezone/locale).

### Migration
`20270907000000_technical_metadata_capture_environment` — additive, `ADD COLUMN IF NOT EXISTS`, all nullable, no backfill, no FK/enum/destructive changes. ✅

### Tests added
- `services/worker/test/technical-metadata.test.ts` — parsers, capture-env privacy, GPS-boolean, advisory rename, report byte-neutrality, ffprobe capability, video graceful-degrade.
- `services/api/test/technical-metadata-verify-projection.test.ts` — public-vs-internal privacy boundary.
- `services/worker/test/report-media-intelligence.test.ts` — coexistence of Technical Summary vs Advisory Observations + ordering + byte-neutrality.

---

## 1. PDF Report Audit

| Check | Result |
|---|---|
| Media Technical Summary appears in correct location | ✅ `render-html.ts` order: Forensic Integrity Statement → **Media Technical Summary** → **Media Intelligence Observations** → … → Legal Interpretation |
| EXIF Summary only when applicable | ✅ EXIF sub-block renders only when `ts.exif` present (`technical-summary.ts`) |
| Capture Environment appears compactly | ✅ Compact key-value sub-block |
| Advisory Observations separate from Media Technical Summary | ✅ Two distinct sections, distinct CSS classes (`technical-summary-section` vs `media-intelligence-section`), Technical Summary first |
| No raw EXIF dump | ✅ Only the bounded summary subset |
| No raw IP | ✅ Capture Environment block has no IP field in the report projection |
| No raw User-Agent | ✅ Not rendered |
| No exact EXIF GPS coordinates | ✅ Rendered as "Present (coordinates withheld)" / "Not present" |
| Compact, not newspaper-like | ✅ One section, three short sub-blocks |
| Enterprise section order | ✅ Technical facts sit with integrity context, before advisory/legal |
| Legally-safe, reviewer-friendly labels | ✅ EXIF capture time explicitly labelled "file-embedded", distinct from PROOVRA timestamps; advisory disclaimer intact |
| Byte-neutral when absent | ✅ Returns `""` when `vm.technicalSummary` is null |

**No report gaps.**

## 2. Public Verify Page Audit

| Check | Result |
|---|---|
| Technical Metadata below trust decision/preview | ✅ Trust verdict + signal breakdown + capture context render first; Technical Metadata section (`data-testid="verify-technical-metadata"`) appears after, not above |
| Media / EXIF / Capture Environment cards readable | ✅ Three cards, EXIF only when applicable |
| Capture Trust wording no longer contradicts anchoring | ✅ "Capture integrity at submission" heading + human sentences clarifying RFC3161/OTS are applied by PROOVRA post-submission, not the capture client |
| Advisory Observations not mislabeled as technical metadata | ✅ Kicker renamed to "Advisory observations"; separate from Technical Metadata cards |
| No internal constants as main user-facing text | ✅ Human-readable labels and sentences |
| No raw IP / UA / precise GPS | ✅ Public projection (`internal:false`) omits even masked IP / UA hash; GPS is boolean |
| Enterprise UX, not debug | ✅ Card layout, "Not available" fallbacks, no raw JSON |

**No verify-page gaps.**

## 3. Verification Package Audit

| Check | Result |
|---|---|
| `technical-metadata/media-summary.json` | ✅ Always emitted; **per-part** array (`parts.map`) — multipart-correct |
| `technical-metadata/exif-summary.json` | ✅ Only when at least one part has applicable EXIF |
| `technical-metadata/capture-environment.json` | ✅ Always emitted; `recorded` flag + nulls when absent |
| `intelligence/advisory-signals.json` | ✅ Canonical advisory file |
| Deprecated `media_intelligence.json` alias | ✅ Present, clearly labelled (`deprecated:true`, `renamedTo`, explanatory `note`) |
| Manifest/checksums include new files | ✅ Appended **before** the `package-checksums.json` index |
| Stable JSON structure | ✅ `schemaVersion` + `schema` discriminators on each file |
| Per-part for multipart | ✅ `media-summary.parts[]` and `exif-summary.parts[]` are per-part |
| Graceful degradation | ✅ Builder returns `[]` on error; package generation continues |
| No raw IP/UA/GPS by default | ✅ Masked IP + UA hash only; GPS boolean |
| Advisory separated from deterministic metadata | ✅ `intelligence/` vs `technical-metadata/` directories |

**No package gaps.**

## 4. Internal Evidence Detail UI Audit

| Check | Result |
|---|---|
| Technical Metadata in authenticated evidence UI | ✅ `EvidenceTechnicalMetadataCard` mounted in `EvidenceTechnicalAppendixTab.tsx` |
| Correct location | ✅ Technical Appendix tab, collapsed `<details>`, below the trust-decision summary (never above primary preview/actions) |
| Media / EXIF / Capture Environment compact | ✅ Three blocks via `KeyValueGrid` |
| Multipart doesn't break layout | ✅ Aggregate media summary; compact grids (no per-part explosion in the card) |
| Unavailable handled gracefully | ✅ `na()` → "Not available"; empty/error states render a neutral line |
| No raw sensitive data | ✅ Internal card shows **masked IP** + **UA hash** labels only (never raw); fetched from `internal:true` projection |

**Minor:** the card is inside the collapsed Technical Appendix tab — discoverable but somewhat buried for routine review (see Issue #3).

## 5. Should these appear as internal statistics?

**Recommendation: a small, targeted footprint — not a broad rollout.**

| Surface | Recommendation | Rationale |
|---|---|---|
| Evidence Detail | ✅ **Yes (already done)** | The per-record card is the right primary home |
| Ops / Reliability page | ✅ **Yes (small)** | A single reliability tile is genuinely useful: `parseResult` distribution (OK / FAILED / UNSUPPORTED) and `ffprobeAvailable` from the `worker.media_tooling.capability` log. This catches "video silently UNSUPPORTED in prod" — the exact failure mode the feature guards against |
| Workspace Dashboard | ⚠️ **Optional / later** | "EXIF present vs missing", "capture environment captured %" are mildly interesting but not decision-driving; risk of dashboard bloat. Defer unless a customer asks |
| Evidence list filters | ❌ **No (not now)** | Filtering evidence by "EXIF present" or "parse failed" is a niche forensic query; adds index + UI cost for low value. Reconsider only if reviewers request it |
| Report / Package only | ❌ Insufficient alone | Per-record output is necessary but not a substitute for an Ops reliability signal |

**Net:** keep Evidence Detail (done) + add one Ops/Reliability tile (parse-result counts + ffprobe availability). Skip dashboard stats and list filters for now.

## 6. ffprobe / Parser Audit

| Check | Result |
|---|---|
| ffprobe in Dockerfile | ✅ Alpine `ffmpeg` package in worker runner stage (ships `ffmpeg` + `ffprobe`) |
| Capability detection works | ✅ `detectFfmpegCapability` + system-PATH `ffprobe` fallback in the ffmpeg-static branch |
| Video parser returns metadata when ffprobe exists | ✅ ffprobe JSON → codec/duration/dimensions/frame rate/bitrate/streamCount |
| Graceful degradation when ffprobe missing | ✅ Returns `parseResult: "UNSUPPORTED"` |
| Evidence completion never fails on parsing | ✅ Extraction is a best-effort post-finalization job; never throws to BullMQ; no completion gate |
| FAILED/UNSUPPORTED stored correctly | ✅ Written into `technical_metadata.parseResult`; reflected in `metadataStatus` aggregation |
| Startup diagnostic | ✅ `worker.media_tooling.capability` logs `ffprobeAvailable` |

**Note (Issue #4):** the Dockerfile change takes effect only after the worker GHCR image is rebuilt by CI. Until then, prod still degrades to UNSUPPORTED for video.

## 7. Privacy / GDPR Audit

| Check | Result |
|---|---|
| Raw IP not exposed publicly | ✅ `maskIp` → "203.0.x.x"; public projection omits even the masked value |
| Raw User-Agent not exposed publicly | ✅ `hashUserAgent` → "sha256:…"; public projection omits even the hash |
| EXIF GPS coordinates not exposed publicly | ✅ `gpsPresent` boolean only, everywhere |
| Hashes / masked values used | ✅ UA hash + masked IP are the only network/UA fields persisted |
| PDF + Verify Page safe | ✅ No raw IP/UA/GPS in either |
| Package no leak by default | ✅ `capture-environment.json` carries masked IP + UA hash only |
| Internal vs public boundary | ✅ Masked IP + UA hash visible **only** to authenticated workspace users via `internal:true`; never on the public page |

**No privacy leaks.** Tests assert no raw IP/UA strings and no coordinate-like decimals in any serialized output.

## 8. Backward Compatibility Audit

| Check | Result |
|---|---|
| Old evidence without metadata renders report/verify/package | ✅ All projections return null/`[]`; sections emit nothing or "Not available" |
| Old evidence shows "Not available" gracefully | ✅ Verify page gates `{technicalMetadata ? …}`; internal card + report degrade |
| Multipart works | ✅ Per-part arrays |
| Single-file works | ✅ Mirror onto `Evidence.technicalMetadata` |
| Images / videos / PDFs / unsupported | ✅ Dispatcher routes by MIME; unsupported → `UNSUPPORTED` |
| Report generation doesn't crash | ✅ Bridge returns null on any error |
| Package generation doesn't crash | ✅ Builder try/catch → `[]` |

**No compatibility regressions.** Note: existing evidence stays "Not available" until re-finalized (Issue #2 — no backfill).

## 9. Tests Audit

Coverage confirmed for: parser success / failure / unsupported; capture-environment privacy (no raw IP/UA leak; masked IP; UA hash); GPS-boolean-only; package advisory rename (`advisory-signals.json` + deprecated alias); report byte-neutrality + section coexistence + ordering + safe wording; ffprobe capability detection; video-parser graceful-degrade; public-vs-internal projection privacy boundary; OTS wiring source-contract (fixed).

**Gap:** no automated test for the **internal evidence card React render** (web runner only executes logic `.test.ts`, not `.tsx`). The card is covered indirectly by the API projection test + typecheck + production build. Low risk.

---

## Issues Found

| # | Sev | Issue | Location | Impact |
|---|---|---|---|---|
| 1 | **Medium** | Capture environment collected **only** on web `POST /v1/evidence`. Intake-link, citizen-capture/mobile, and API ingest paths do not populate `captureEnvironment` | `evidence.routes.ts:4756` only | Those records show "No capture environment recorded" — graceful but incomplete coverage |
| 2 | Low | No backfill for pre-existing evidence | n/a | Old records show "Not available" until re-finalized |
| 3 | Low | Internal Technical Metadata card is nested in the collapsed Technical Appendix tab | `EvidenceTechnicalAppendixTab.tsx` | Discoverable but buried for routine review |
| 4 | Info | ffprobe availability requires worker image rebuild | `Dockerfile` | Prod video parsing degrades to UNSUPPORTED until CI rebuild |
| 5 | Low | No Ops/Reliability tile for parse-result distribution / ffprobe availability | n/a | Silent UNSUPPORTED rates are observable only in logs |
| 6 | Low | No automated React-render test for the internal card | web `__tests__` | Covered by API test + build only |
| 7 | Info | Legacy `evidence_part_exif_summaries` table now overlaps with `technicalMetadata` EXIF | schema | Two EXIF sources coexist; not harmful, slight redundancy |

---

## Must-Fix Items
**None.** No blocking or correctness/privacy defects. The feature is safe to ship as-is for the web-capture path.

## Should-Fix (Recommended, small)
1. **Issue #1** — populate `captureEnvironment` on intake-link + citizen-capture ingest (reuse `buildCaptureEnvironment` with that path's UA/IP/source). This is the one gap with real user-visible impact.
2. **Issue #4** — confirm the worker image is rebuilt + verify `ffprobeAvailable:true` in prod logs.

## Nice-to-Have
- Issue #5 — one Ops/Reliability tile (parse-result counts + ffprobe availability).
- Issue #2 — a one-off backfill job for technical metadata on existing evidence.
- Issue #3 — surface a compact Media/EXIF summary line on the Evidence Overview tab (not just inside the appendix).
- Issue #6 — a React-render test for the internal card.
- Issue #7 — converge the two EXIF sources over time.

## Final Recommendation

**Ship.** The integration is complete, privacy-safe, backward-compatible, and well-tested across report, verify page, package, and internal UI. The only meaningfully incomplete surface is **capture-environment collection on non-web ingest paths (Issue #1)** — a small, well-scoped follow-up. Pair it with a prod ffprobe confirmation (Issue #4) and optionally one Ops reliability tile (Issue #5). Everything else is polish.
