# Enterprise Evidence Enrichment Cleanup Plan

**Date:** 2026-06-30
**Type:** Plan (implementation follows in the same change)
**Goal:** Replace the broad, partly-duplicative "Media & Capture Metadata" layer with a narrow, high-value **device/camera enrichment** that lives inside existing surfaces — and keep only deep, non-duplicative technical files in the verification package.

---

## 1. What the previous metadata work added, and what is duplicate

| Added artifact | Keep / Remove | Reason |
|---|---|---|
| PDF global section "Media & Capture Metadata" (`report-v2/sections/technical-summary.ts`) — **Media** block (Mixed / Files analysed / Metadata status / Resolution) | **Remove those rows** | Duplicates evidence type, item count, structure, gallery per-item size/format/SHA. "Mixed" + one arbitrary resolution is misleading. |
| same section — **Network** block (masked IP / country / region / type) | **Remove from PDF** | Not reviewer-useful; masked IP is currently the infra IP; IP belongs to package/internal at most. |
| same section — **EXIF GPS** row | **Remove from PDF/Verify** | Location already lives in Capture Context / map preview. No double exposure. |
| same section — **Capture Environment** (browser/OS/engine/platform/timezone/locale) | **Slim → "Capture Device"** | Keep device/OS + minimal desktop context; drop engine/platform/locale from the public PDF (raw → package). |
| same section — **EXIF Summary** (camera/lens/iso/aperture/exposure/shutter/WB/orientation) | **Keep → "Camera Metadata"** | This is the genuinely new, high-value enrichment. Drop resolution (gallery) + GPS (capture context). |
| Public Verify cards: Media / EXIF / Capture Environment / Network (`VerifyTechnicalMetadataSection.tsx`) | **Replace with one small "Capture Device" card** | Media/network duplicate trust/preview; keep device + camera only. |
| Package `technical-metadata/media-summary.json` | **Remove** | Duplicates manifest/checksums/gallery (mediaKind/mime/size/sha256/dimensions). |
| Package `technical-metadata/network-summary.json` | **Remove (default)** | Private/duplicative; no expert value without full enrichment. |
| Package `technical-metadata/exif-summary.json` | **Rename → `exif-details.json`** | Keep deep EXIF; add `source`/`extractedAt`/`partId`/`fieldsPresent`/`fieldsOmittedReason`. |
| Package `technical-metadata/capture-environment.json` | **Keep (source-tagged)** | Expert capture context; not in manifest. |
| (new) Package `technical-metadata/device-enrichment.json` | **Add** | Concise device/OS/camera roll-up with source + confidence. |

**Parsers / stored data: KEEP unchanged.** `exif-extractor.service.ts`, `parseUserAgent`, `buildCaptureEnvironment`, the worker `extract_technical_metadata` job, `EvidencePart.technicalMetadata`, `Evidence.captureEnvironment`, the capture-environment writer, and `display-helpers` all stay. This is a **presentation/packaging** cleanup, not a data rollback. No migration.

## 2. Useful data already extracted / stored (reuse, don't re-derive)

- **Per-part EXIF** in `EvidencePart.technicalMetadata`: cameraMake/Model, lensModel, iso, aperture, exposureTime, shutterSpeed, whiteBalance, orientation, originalCaptureTime, gpsPresent, software (raw build id).
- **Capture environment** in `Evidence.captureEnvironment`: uploadSource, captureMethod, browser/OS (+versions), deviceClass, engine, platform, timezone, locale, userAgentHash, ipAddressMasked, country/region/networkType.
- **Location** (separate, already shown): `Evidence.lat/lng` + Capture Context / map preview.

## 3. Placement of each useful field

| Field | PDF | Verify | Package | Internal |
|---|---|---|---|---|
| Captured with (device = EXIF camera make+model) | ✅ Capture Device | ✅ Capture Device card | ✅ device-enrichment | ✅ |
| OS (capture-env osName, exact when known) | ✅ | ✅ | ✅ capture-environment | ✅ |
| Camera make/model | ✅ Camera Metadata | ✅ | ✅ exif-details | ✅ |
| Original capture time | ✅ | ✅ (if present) | ✅ | ✅ |
| Lens / ISO / Aperture / Shutter / Exposure / WB / Orientation | ✅ Camera Metadata (only present rows) | ❌ (too technical) | ✅ exif-details | ✅ |
| Resolution | ❌ (gallery has it) | ❌ | ✅ exif-details | ✅ |
| EXIF GPS presence | ❌ (Capture Context owns location) | ❌ | ✅ exif-details (`gpsPresent` only) | ✅ |
| Browser / engine / platform / timezone / locale | desktop: Browser+OS+Timezone only | ❌ | ✅ capture-environment | ✅ |
| Software / firmware build id (raw) | ❌ (or labeled) | ❌ | ✅ exif-details (`software`) | ✅ |
| Masked IP / UA hash / network / country | ❌ | ❌ | ✅ capture-environment (masked only) | ✅ |

## 4. Must NOT appear publicly (PDF + Verify)
Full IP, raw User-Agent, UA hash, ASN, ISP, Cloudflare Ray ID, internal/Docker IP, raw firmware build id (unlabeled), exact EXIF GPS coordinates, and any "Mixed / Files analysed / Metadata Partial / global Resolution" rows.

## 5. Exact files to edit
- `services/worker/src/report-v2/sections/technical-summary.ts` — reframe to "Capture Device & Camera Metadata"; drop Media/Network/GPS/resolution; only meaningful rows.
- `services/worker/src/report-technical-summary-bridge.ts` — keep device + camera + slim capture-env; can drop network/primaryMedia from the *rendered* payload (leave structurally for compat or trim).
- `services/worker/src/verification-package-technical-metadata.ts` — remove media-summary + network-summary; rename exif-summary→exif-details (source-tagged); add device-enrichment.json; keep capture-environment.json.
- `apps/web/components/verify-v2/VerifyTechnicalMetadataSection.tsx` — single "Capture Device" card (device/OS/camera/capture time).
- `apps/web/app/verify/[token]/page.tsx` — state type follows component type (no structural change).
- `services/api/src/services/technical-metadata/verify-projection.service.ts` — trim the public projection to device/OS/camera/capture-time (drop media/network/engine/platform/IP for public; internal may keep more).
- Tests: `services/worker/test/report-media-intelligence.test.ts`, `services/worker/test/technical-metadata.test.ts`, `services/api/test/technical-metadata-verify-projection.test.ts`.
- Internal card (`EvidenceTechnicalMetadataCard.tsx`): unchanged (authenticated full view is the right place for fuller detail).

## 6. Test plan
- Worker: PDF section renders **Camera Metadata** (camera/iso/aperture) only when EXIF present; renders **nothing camera** for non-EXIF; **no** "Mixed/Files analysed/Metadata/Resolution/Network/EXIF GPS" strings; humanized capture method/source; no raw UA/IP/GPS coords.
- Worker package: emits `exif-details.json` + `capture-environment.json` + `device-enrichment.json`; does **not** emit `media-summary.json` or `network-summary.json`; exif-details carries `source/extractedAt/fieldsPresent`; no full IP / raw UA.
- API: public projection has device/OS/camera/capture-time only; no IP/UA/engine/platform/network publicly.
- Privacy: no full IP / raw UA / GPS coords anywhere public.
- Acceptance: desktop (no EXIF) shows no camera rows; mobile (EXIF) shows camera rows; empty rows hidden.

**Acceptance gates:** api/worker/web typecheck, worker + api test suites, web build. No change to crypto/custody/OTS/timestamp/anchoring/gallery/identity behavior.
