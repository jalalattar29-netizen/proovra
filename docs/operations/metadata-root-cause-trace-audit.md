# Metadata Root-Cause Trace Audit (End-to-End)

**Date:** 2026-06-30
**Type:** AUDIT ONLY — no code/schema/test/migration changes
**Method:** Per-field lifecycle trace from capture → parser → store → projection → render, with the exact file + stage where each field stops.

---

## 1. Executive summary

The technical-metadata pipeline is architecturally sound and privacy-correct, but a forensic trace reveals **four distinct break classes**, each with a precise location:

1. **Parser never requests the field** (the field dies at extraction). Affects all "rich EXIF" (Lens, ISO, Aperture, Exposure, Shutter, White Balance, Compression) — the `exifr` `pick:[...]` list in `exif-extractor.service.ts` (lines 149–164) simply does not include them, and `parseUserAgent` never computes Engine/Platform/Architecture.
2. **Extracted + stored, but the projection drops it** (the field dies at projection). Affects **Orientation** (extracted into `ExifSafeSummary`/`TechnicalMetadata`, but `deriveExifSummary` omits it) and **Frame Rate / Audio Codec / Bitrate / Container** (parsed by ffprobe into `TechnicalMetadata`, but `toPerPartMediaSummary` omits them).
3. **Stored but display omits it** (the field dies at render). Affects **Masked IP** and **Locale** (in `captureEnvironment`, surfaced internally, but the PDF/Verify renderers don't print them), and the combined **Browser/OS** row.
4. **Not collected at all** (no pipeline exists). Affects all **Network enrichment** (Country/Region/ASN/ISP/Network-type/VPN/TOR/Proxy/Datacenter/Cloudflare-Ray/Source-header). A country-only geo service exists (`geo-intelligence.service.ts`) but is **never wired** into `captureEnvironment`.

A fifth, non-defect class is **"correctly absent from the source file"** — camera EXIF + GPS on the recent desktop/Downloads upload. The pipeline is correct; the file had nothing to extract.

**Bottom line:** very few fields are "wrong." Most missing values stop at exactly one of two narrow choke points — the `exifr` pick list and two projection functions (`deriveExifSummary`, `toPerPartMediaSummary`) — plus the entirely-unbuilt network layer. Fixing those three code locations (plus humanizing two enums) closes ~80% of the gap.

---

## 2. End-to-end metadata trace

Canonical pipeline (every field follows this spine):

```
Upload (req headers / file bytes)
  → Parser:
       image  : exif-extractor.service.ts (exifr)  +  image-parser.ts (sharp dims/colorspace)
       video  : video-parser.ts (ffprobe)
       pdf    : pdf-parser.ts (pdfjs)
       capture: capture-environment.ts (parseUserAgent / maskIp / hashUserAgent)
  → Normalize: projections.ts imageMetadataFromExif() → TechnicalMetadata
  → Persist: evidence_parts.technical_metadata (JSONB)  /  evidence.capture_environment (JSONB)
  → Model: EvidencePart.technicalMetadata : Json?   /   Evidence.captureEnvironment : Json?
  → Projection:
       package : verification-package-technical-metadata.ts  (deriveExifSummary, toPerPartMediaSummary)
       verify  : verify-projection.service.ts
       report  : report-technical-summary-bridge.ts
  → Render:
       PDF     : report-v2/sections/technical-summary.ts
       Verify  : VerifyTechnicalMetadataSection.tsx
       Internal: EvidenceTechnicalMetadataCard.tsx
```

### A. EXIF — per-field trace

**Camera Make / Camera Model** — origin: file EXIF (`Make`/`Model`). Parser: `exif-extractor.service.ts` ✅ requests them (pick list 156–157). Stored: `ExifSafeSummary.cameraMake/Model` → `TechnicalMetadata.cameraMake/Model` → `evidence_parts.technical_metadata`. Projection: ✅ `deriveExifSummary` → package/verify/report/internal all receive it. **Status: pipeline COMPLETE.** Missing on the test file **only because the desktop/Downloads upload had no EXIF** (root cause = source file, implementation correct).

**Original Capture Time** — origin: `DateTimeOriginal`/`CreateDate`. Parser ✅ (pick 150). Stored `originalCaptureTime`. Projection ✅. **COMPLETE; absent only when the file lacks EXIF.**

**Image Resolution (width/height)** — two sources: `ExifImageWidth/Height` (exifr) AND `sharp.metadata()` (`image-parser.ts` augments dims when EXIF lacks them). Stored `widthPx/heightPx`. Projection ✅ (`resolution` in EXIF summary; width/height in media-summary). **COMPLETE — works even with no EXIF** (sharp reads pixel dims from the image header). This is why resolution shows even on stripped images.

**Software** — origin: `Software` tag. Parser ✅ (pick 159). Projection ✅ (`softwareTag`). **COMPLETE; present only if the file carries it.** (This is the de-facto "edited by" signal.)

**Orientation** — origin: `Orientation` tag. Parser ✅ requests it (pick 158), stores `ExifSafeSummary.orientation` → `TechnicalMetadata.orientation`. **BREAK at projection:** `deriveExifSummary` (projections.ts) does **not** include `orientation` in the `ExifSummary` shape. → `exif-summary.json`, verify EXIF card, PDF EXIF block, internal EXIF block all never receive it. **Root cause: extracted + stored, projection omits it.** (Class 2.)

**EXIF GPS Presence** — origin: `GPSLatitude/Longitude`. Parser ✅ computes `hasGps` boolean (pick 160–163). Stored `gpsPresent`. Projection ✅. Rendered as "Present (coordinates withheld) / Not present." **COMPLETE.**

**EXIF GPS Coordinates** — origin: same tags. Parser **deliberately refuses** raw coordinates unless `allowRawGps:true` AND a policy layer approves (default = refuse; rounded to 5dp if ever allowed). Never persisted (no column). **Root cause: enterprise/privacy design decision — intentionally not extracted/stored/displayed.** Correct. (Class: privacy by design.)

**Lens / ISO / Aperture / Exposure / Shutter Speed / White Balance / Compression** — origin: file EXIF (`LensModel`, `ISO`, `FNumber`, `ExposureTime`, `ShutterSpeedValue`, `WhiteBalance`, `Compression`). Parser: `exif-extractor.service.ts` **never requests them** — the `exifr` `pick:[...]` array (lines 149–164) is intentionally narrow (PII-minimisation) and contains only DateTimeOriginal/CreateDate/dims/Make/Model/Orientation/Software/GPS. **BREAK at extraction: the pipeline stops inside `exif-extractor.service.ts`; nothing downstream can ever store, project, or display these.** (Class 1 — parser never requests.) Not a desktop/file issue — even a full-EXIF camera image would lose them here.

### B. Capture Environment — per-field trace

**Browser name / Browser version** — origin: `User-Agent` header. Parser: `parseUserAgent` (capture-environment.ts) ✅ regex-detects family + version. Stored `browserName/browserVersion` in `evidence.capture_environment`. Projection ✅ (all surfaces). **Render note:** PDF/Verify **combine** them into one "Browser / OS" row → version is technically present but visually buried (Class 3 display).

**Operating System / OS version** — origin: UA. Parser ✅. Stored `osName/osVersion`. Same **combined-row** display issue.

**Device Class** — origin: UA heuristics. Parser ✅ (DESKTOP/MOBILE/TABLET/SERVER/UNKNOWN). Projection ✅. Displayed ✅. **COMPLETE.**

**Browser Engine (Blink/WebKit/Gecko)** — origin: UA. Parser: `parseUserAgent` **never computes engine**; `ParsedUserAgent`/`CaptureEnvironment` have **no `engine` field**. **BREAK at extraction + type.** (Class 1/4.)

**Platform / Architecture (Windows x64/macOS/Android/iOS)** — origin: UA. Parser **never computes platform/arch**; no field in `CaptureEnvironment`. **BREAK at extraction + type.** (`osName` is the closest proxy but is not the platform/arch string.)

**Locale** — origin: client (`captureTimezone`/`captureLocale` body) or `Accept-Language`. Captured ✅ (evidence.routes.ts + writer), stored `captureEnvironment.locale`. Package ✅ (`capture-environment.json` line 164), internal card ✅. **BREAK at render for public:** PDF (`technical-summary.ts`) and Verify (`VerifyTechnicalMetadataSection.tsx`) **do not print `locale`.** (Class 3 — stored, display omits.)

**Timezone** — origin: client `Intl` / body. Captured ✅, stored, projected ✅, displayed ✅ (PDF "Timezone at submission", Verify, internal). **COMPLETE** (null for citizen/mobile signed path — see §4).

**Upload Source** — origin: route (`WEB_APP`/`INTAKE_LINK`/`MOBILE_APP`/`API`). Stored as **raw enum**. Projection ✅, displayed ✅ — but **as the raw enum string**. **BREAK at presentation: no humanization layer exists** (no `humanizeUploadSource`). (Class 3 — displayed poorly.)

**Capture Method** — origin: route (`SECURE_CAPTURE`/`UPLOAD`/`INTAKE_LINK`/`MOBILE`). Same **raw-enum display** defect.

**User-Agent Hash** — origin: SHA-256 of raw UA (`hashUserAgent`). Stored `userAgentHash`. Package ✅, internal ✅. **Intentionally NOT** in PDF/Verify (public). **COMPLETE by design.**

**Raw User-Agent** — **never stored** (hashed and discarded in `buildCaptureEnvironment`). Correct privacy design.

### C. Network — per-field trace

**Masked IP** — origin: `req.ip` → `maskIp()` (capture-environment.ts) → `ipAddressMasked`. Stored ✅, package ✅, internal card ✅. **BREAK at render for PDF/Verify:** neither prints it (there is **no Network block** in `technical-summary.ts` or `VerifyTechnicalMetadataSection.tsx`). (Class 3.)

**Full IP** — `req.ip` is consumed by `maskIp` and **immediately discarded**; never persisted. **Root cause: privacy design — intentionally not stored.** Correct.

**Country / Region** — a country-only service exists: `services/api/src/services/access-control/geo-intelligence.service.ts` (HMAC(IP)-keyed cache, country code only, region explicitly excluded). **BREAK: it is never called from the evidence ingest path / `buildCaptureEnvironment`** — country is computed for access-control, not attached to `captureEnvironment`. Region: **not implemented at all.** (Class 4 — not collected for evidence.)

**ASN / ISP / Network Type / VPN / Proxy / TOR / Datacenter / Cloudflare Ray ID / Source Header** — **no enrichment pipeline exists anywhere.** `req.ip` is the only network input; CF-Connecting-IP / X-Forwarded-For are not read or recorded. **Root cause: feature not built (Class 4).** Not faked anywhere — correctly absent.

### D. Media Technical — per-field trace

**MIME** — origin: upload + parser confirm. Parser ✅ (`mimeType` on every `TechnicalMetadata`). Stored ✅. Projection ✅ (`toPerPartMediaSummary`). **COMPLETE.**

**Size** — origin: `evidence_parts.size_bytes`. Projection ✅ (`sizeBytes` in media-summary). **Stored + in package**; PDF/Verify show it only inside the summary line, not as its own field. Minor.

**Width / Height** — image: exifr/sharp; video: ffprobe. Stored `widthPx/heightPx`. Projection ✅. **COMPLETE.**

**Duration** — video/audio: ffprobe `durationMs`. Stored ✅. Projection ✅ (media-summary `durationMs`; report resolutionSummary). **COMPLETE.**

**Codec (video)** — ffprobe `videoCodec`. Stored ✅. Projection: `toPerPartMediaSummary` sets `codec = videoCodec ?? audioCodec`. **Partially surfaced** (single combined `codec` field).

**Audio Codec** — ffprobe `audioCodec`. Stored in `TechnicalMetadata`. **BREAK at projection:** `toPerPartMediaSummary` only emits the combined `codec` (prefers video), so a video's **separate audio codec is dropped** from `media-summary.json`. (Class 2.)

**Frame Rate** — ffprobe `frameRate`. Stored in `TechnicalMetadata`. **BREAK at projection:** `toPerPartMediaSummary` does **not** include `frameRate`. → never in package/verify/report. (Class 2.) Same for **bitrate**, **container**, **streamCount** (stored, projection omits).

**PDF Page Count** — pdfjs `pageCount`. Stored ✅. Projection ✅ (`pageCount`). Displayed ✅. **COMPLETE.**

**Parse Status** — every parser sets `parseResult` (OK/FAILED/UNSUPPORTED) + `metadataStatus`. Stored ✅. Projection ✅. Displayed ✅ ("Metadata status"). **COMPLETE.**

**Parse Failure Reason** — `parseResult: FAILED/UNSUPPORTED` is stored, but the **human reason** (e.g. "ffprobe unavailable", "corrupt header") is only logged, not persisted into `technicalMetadata`. **BREAK: reason not stored** (only the status enum). Minor (Class 1 — not captured into the record).

---

## 3. Root-cause analysis (by break class)

| Class | Where the pipeline stops | Fields | Single fix location |
|---|---|---|---|
| **1. Parser never requests** | `exif-extractor.service.ts` pick list; `parseUserAgent` | Lens, ISO, Aperture, Exposure, Shutter, White Balance, Compression; Engine, Platform/Arch; Parse-failure-reason | Extend pick list / parseUserAgent |
| **2. Extracted+stored, projection drops** | `projections.ts` (`deriveExifSummary`, `toPerPartMediaSummary`) | Orientation; Audio Codec, Frame Rate, Bitrate, Container, Stream count | Add fields to the two projection functions |
| **3. Stored, render omits / poor** | `technical-summary.ts`, `VerifyTechnicalMetadataSection.tsx` | Masked IP, Locale (omitted); Browser/OS combined; raw enum labels | Add rows + humanize |
| **4. Not collected (no pipeline)** | n/a — no code | Country/Region (geo exists, unwired), ASN, ISP, Network type, VPN/TOR/Proxy/Datacenter, CF-Ray, Source header | New (gated) enrichment + wire geo |
| **5. Correctly absent (source file)** | n/a — correct | Camera Make/Model, GPS, capture time on the desktop test upload | None — implementation correct |
| **Privacy by design** | extractor / writer | Raw GPS coords, Full IP, Raw UA | None — keep |

---

## 4. Desktop vs Mobile analysis (per missing value)

| Field | Missing because… |
|---|---|
| Camera Make/Model | **Source file** — desktop/Downloads image had no EXIF (download/screenshot/generated/stripped). Pipeline correct. |
| Original Capture Time | **Source file** — same. |
| EXIF GPS presence/coords | **Source file** (no GPS) + **privacy design** (coords never shown). |
| Software tag | **Source file** — present only if the editor wrote it. |
| Image Resolution | **NOT missing** — sharp reads pixel dims from the header even with zero EXIF. |
| Lens/ISO/Aperture/Exposure/Shutter/WB/Compression | **Implementation** — parser never requests them (would be missing even for a full-EXIF DSLR file). |
| Orientation | **Implementation** — extracted but projection drops it. |
| Browser/OS/Device/Timezone/Locale | **NOT missing** — captured for any web/intake upload (desktop or mobile). |
| Browser Engine / Platform | **Implementation** — never parsed. |
| Timezone (citizen/mobile signed) | **Implementation** (signed payload not extended) — defer; do not break signature validation. |
| Upload source = WEB_APP for API | **Implementation/Design** — no API identity marker; do not invent. |
| Masked IP (in PDF/Verify) | **Implementation** — stored, render omits. |
| Country/Region/ASN/ISP/threat | **Implementation** — enrichment not built. |
| Audio codec / frame rate | **Implementation** — ffprobe extracts, projection drops (and only present for video/audio files). |

---

## 5. Report audit (judge / lawyer / investigator readability)

| Block | Understandable by | Verdict |
|---|---|---|
| Media Technical Summary header | All roles | ✅ clear |
| EXIF: Camera / Capture time / GPS / Resolution / Software | All roles | ✅ clear ("coordinates withheld" reads well) |
| EXIF: Metadata status PRESENT/PARTIAL/MISSING | Forensic examiner; **partially** others | ⚠️ add one-line plain note: *"Embedded camera metadata is absent for downloaded/screenshotted/generated files — expected, not an integrity concern."* |
| Capture Environment: "Submitted via: WEB_APP" | **Developers only** | ❌ raw enum — judge/lawyer will not parse `WEB_APP`. **Must humanize.** |
| Capture Environment: "Capture method: UPLOAD/SECURE_CAPTURE" | **Developers only** | ❌ raw enum. **Must humanize.** |
| "Browser / OS: Chrome on Windows" | All roles | ⚠️ readable but coarse — split into Browser / OS / Device / Engine / Platform. |
| Network | n/a | ❌ **absent** — a forensic examiner expects at least masked IP + country. |

**Rewrites:** `WEB_APP → "PROOVRA Web Application"`, `SECURE_CAPTURE → "Secure Browser Capture"`, `INTAKE_LINK → "Intake Link Submission"`, `MOBILE_APP → "Mobile Capture"`, `API → "API Submission"`, `UPLOAD → "Direct Upload"`.

## 6. Verify page audit

| Value | Useful? | Issue |
|---|---|---|
| Media card (type/files/resolution/status) | ✅ | none |
| EXIF card (camera/time/GPS-present/resolution/software) | ✅ | orientation missing (projection) |
| Capture Environment (uploadSource raw enum) | ⚠️ | `WEB_APP` is too technical → humanize |
| Browser/OS combined | ⚠️ | acceptable for public; could split |
| Masked IP / Locale | — | **omitted** — acceptable publicly; Country (only) is the one optional add |
| Capture Integrity | ✅ | correctly advanced-gated; no terse "absent" |
| Placement | ✅ | below trust decision + preview |

**Recommendation:** humanize enums; optionally add **Country** only; keep masked IP / UA hash / threat data out of the public page.

## 7. Verification Package audit (generated JSON)

| File | Status | Finding |
|---|---|---|
| `media-summary.json` | **incomplete** | per-part has mediaKind/mime/size/sha256/width/height/durationMs/`codec`(combined)/pageCount/metadataStatus/parseResult. **Missing (stored upstream): audioCodec, frameRate, bitrate, container, streamCount** — dropped by `toPerPartMediaSummary`. |
| `exif-summary.json` | **incomplete** | filename/exifPresent/cameraMake/cameraModel/camera/originalCaptureTime/gpsPresent/resolution/softwareTag/metadataStatus. **Missing: orientation (stored, projection drops); lens/ISO/aperture/exposure/shutter/WB/compression (never extracted).** No redundant fields. (Note: `cameraMake`+`cameraModel`+`camera` is mild redundancy — acceptable.) |
| `capture-environment.json` | **complete-for-what-exists** | captureMethod/uploadSource (raw enums)/browser/OS/device/timezone/locale/userAgentHash/ipAddressMasked/attestation. **Missing: engine, platform (never parsed).** No full IP / raw UA — correct. |
| `network-summary.json` | **absent** | does not exist — recommend (package-internal). |
| `package-checksums.json` | **correct** | technical-metadata files appended before the checksum index → covered. |
| `manifest`/`package-manifest.json` | **correct** | unaffected; no leakage. |
| advisory-signals.json / media_intelligence.json | **correctly removed** | no workspace/correlation leak remains. |

## 8. Internal Evidence Detail audit

- **Location:** Technical Appendix tab, collapsed card → `EvidenceTechnicalMetadataCard.tsx`. Shows Media / EXIF / Capture Environment incl. **masked IP + UA hash + locale** (internal-only). ✅ correct home for **full** detail.
- **Gap:** the card is **buried** — no compact summary on the **Overview** tab or **Case drawer**. Routine reviewers must expand the appendix.
- **Recommendation:** Technical Appendix = full card (keep). Overview tab = compact read-only badge (camera + capture time + "EXIF present" + browser/OS). Case drawer = same compact badge. Do **not** duplicate the full card in multiple places.

## 9. Display quality audit (score per surface)

| Surface | Displayed? | Enterprise quality | Score |
|---|---|---|---|
| PDF EXIF | yes (thin) | good wording, missing orientation + rich fields | 6/10 |
| PDF Capture Environment | yes | raw enums, combined Browser/OS, no engine/platform/locale | 5/10 |
| PDF Network | **no** | absent | 2/10 |
| Verify EXIF | yes | good | 7/10 |
| Verify Capture Environment | yes | raw enum | 6/10 |
| Package media/exif/capture | yes | privacy-safe, but incomplete projections | 7/10 |
| Internal card | yes | full, but buried | 7/10 |

## 10. UX audit (block rewrites)

**Current PDF Capture Environment:**
```
Submitted via: WEB_APP
Capture method: UPLOAD
Browser / OS: Chrome on Windows
Device class: DESKTOP
Timezone at submission: Europe/Berlin
```
**Should be:**
```
Submitted through: PROOVRA Web Application
Capture method:    Direct Upload
Browser:           Google Chrome 138
Operating system:  Windows 11
Device:            Desktop
Engine:            Blink
Platform:          Windows x64
Timezone:          Europe/Berlin
Locale:            de-DE
```
(Plus a Network block: `Masked IP: 91.42.x.x · Country: Germany · Region: NRW · Network type: Residential`.)

---

## 11. Root-cause matrix

| Field | Current status | Root cause | Broken stage | Fix required | Priority |
|---|---|---|---|---|---|
| Lens / ISO / Aperture / Exposure / Shutter / WB / Compression | Missing | Parser never requests them from exifr | `exif-extractor.service.ts` pick list (149–164) | Add to pick list + map into ExifSummary (package-only) | P2 |
| Orientation | Missing in output | Extracted + stored; projection omits | `projections.ts` `deriveExifSummary` | Add `orientation` to ExifSummary | P2 |
| Camera Make/Model, Capture Time, GPS | Missing on test file | Source file (desktop/Downloads) had no EXIF | n/a — pipeline complete | None (add report note) | P3 (note only) |
| EXIF GPS coordinates | Withheld | Privacy design (refused at extractor) | by design | None | — |
| Browser Engine | Missing | `parseUserAgent` never computes; no field | `capture-environment.ts` + type | Add engine detection | P1 |
| Platform / Architecture | Missing | Never computed; no field | `capture-environment.ts` + type | Add platform detection | P1 |
| Locale (public) | Stored, not shown | Render omits | `technical-summary.ts`, `VerifyTechnicalMetadataSection.tsx` | Add row | P2 |
| Upload Source / Capture Method | Raw enum shown | No humanization layer | all three renderers | Add `humanize*()` | **P1** |
| Browser/OS (PDF/Verify) | Combined row | Renderer compresses | `technical-summary.ts` | Split into rows | P1 |
| Masked IP (PDF/Verify) | Stored, not shown | No Network block in renderers | renderers | Add Network block (masked only) | P1 |
| Audio Codec / Frame Rate / Bitrate / Container | Stored, not projected | `toPerPartMediaSummary` omits | `projections.ts` | Add to per-part summary | P2 |
| Parse failure reason | Status only | Reason logged, not persisted | parsers / job | Store bounded reason | P3 |
| Country / Region | Not collected for evidence | geo service exists but unwired; region not built | ingest + `buildCaptureEnvironment` | Wire country + add region | P2 |
| ASN / ISP / Network type | Not collected | No enrichment pipeline | n/a | Build (package-internal, gated) | P3 |
| VPN / TOR / Proxy / Datacenter | Not collected | No enrichment pipeline | n/a | Build (package-internal, gated) | P3 |
| Cloudflare Ray ID / Source header | Not captured | `req.ip` only; headers unread | ingest | Capture header + ray id | P3 |
| Full IP | Not stored | Privacy design | by design | None | — |
| Raw User-Agent | Not stored | Privacy design | by design | None | — |
| MIME / Size / Width / Height / Duration / Page count / Parse status | Present | Pipeline complete | n/a | None | — |

---

## 12. Prioritized fixes

**P1 (presentation — small, high reviewer value):**
1. Humanize `uploadSource` + `captureMethod` enums (PDF + Verify + Internal).
2. Split PDF Capture Environment into Browser / OS / Device / Engine / Platform / Timezone / Locale rows.
3. Add UA Engine + Platform detection to `parseUserAgent` + `CaptureEnvironment`.
4. Add a PDF (and optional Verify) **Network block** (masked IP + country + region + network-type) — never full IP.

**P2 (breadth — projection + parser):**
5. Surface **Orientation** (fix `deriveExifSummary`) and **frame rate / audio codec / bitrate / container** (fix `toPerPartMediaSummary`) — these are already extracted/stored.
6. Extend the `exifr` pick list (Lens/ISO/Aperture/Exposure/Shutter/WB/Compression) → `exif-summary.json` **package-only**.
7. Wire country (+region) from `geo-intelligence` into `captureEnvironment`; add `technical-metadata/network-summary.json` (package-internal).
8. Add the desktop-upload EXIF limitation note to the report.

**P3 (later / optional):**
9. Persist parse-failure reason text into `technicalMetadata`.
10. IP threat enrichment (ASN/ISP/VPN/TOR/proxy/datacenter, CF-Ray, source header) — package-internal, privacy-gated.
11. Overview/Case-drawer compact badge.

## 13. Items that should NOT be implemented
- ❌ Full IP anywhere public (PDF/Verify) — ever.
- ❌ Raw User-Agent storage — keep hashing.
- ❌ Precise EXIF GPS coordinates in public output.
- ❌ City-level geolocation (region is the privacy floor).
- ❌ Inventing an API upload-source marker (no API identity exists).
- ❌ Breaking the citizen signed payload to add timezone (defer to a signed v2 only if truly needed).
- ❌ Re-adding advisory/correlation sections.
- ❌ Metadata dashboard statistics (only an Ops parser-health tile is justified).

## 14. Exact implementation order
1. **Humanize enums** (pure helper in shared-runtime + apply in 3 renderers) — zero risk, immediate UX win.
2. **Split PDF capture rows + add Locale row** — render-only.
3. **UA engine + platform** (parser + additive JSON field; no migration — lives in the JSON column).
4. **Network block** (masked IP + wire geo country/region) + `network-summary.json` (package-internal).
5. **Projection breadth**: orientation + frame rate / audio codec / bitrate (already stored).
6. **Rich package EXIF** (extend pick list; package-only).
7. **Report desktop-limitation note.**
8. (Optional, later) parse-failure reason, IP threat enrichment, overview badge.

---

## 15. Exact next implementation prompt

> **TASK: Metadata presentation + breadth — humanize enums, split rows, UA engine/platform, network block, surface already-stored fields, richer package EXIF. Audit-driven; root causes identified in metadata-root-cause-trace-audit.md.**
> Public outputs stay compact and privacy-safe: never full IP, never raw UA, never GPS coordinates. Do not reintroduce advisory sections. No schema migration needed (new fields live inside the existing JSON columns).
>
> 1. **Humanize labels.** Add pure `humanizeUploadSource()` / `humanizeCaptureMethod()` to `packages/shared-runtime/src/technical-metadata/` (WEB_APP→"PROOVRA Web Application", SECURE_CAPTURE→"Secure Browser Capture", INTAKE_LINK→"Intake Link Submission", MOBILE_APP→"Mobile Capture", API→"API Submission", UPLOAD→"Direct Upload", UNKNOWN→"Unknown"). Apply in `report-technical-summary-bridge.ts`, `verify-projection.service.ts`, `EvidenceTechnicalMetadataCard.tsx`. Tests.
> 2. **UA engine + platform.** Extend `parseUserAgent` to return `engine` (Blink/WebKit/Gecko) and `platform` (Windows x64/macOS/Android/iOS). Add to `CaptureEnvironment` (additive JSON). Surface in package `capture-environment.json`, internal card, and the PDF capture rows. Unit tests for Chrome/Win, Safari/iOS, Firefox/Android, Edge.
> 3. **Split PDF capture rows + Locale.** In `report-v2/sections/technical-summary.ts`, render Submitted-through / Capture-method (humanized) / Browser / OS / Device / Engine / Platform / Timezone / Locale as separate rows; drop the combined "browserOs". Keep ≤ one page. Snapshot test.
> 4. **Network block.** At ingest, call the existing country geo (+ add region) and store `country`/`region`/`networkType` (default "Unknown") into `captureEnvironment`. Add a compact PDF "Network" block (Masked IP, Country, Region, Network type) and an optional Verify Country line. Add `technical-metadata/network-summary.json` (package): masked IP + country + region + network-type; leave full-IP/ASN/ISP/VPN/proxy/datacenter/CF-Ray/source-header for a future gated internal mode (do not implement now). Tests assert no full IP / raw UA in any public output.
> 5. **Surface already-stored media + EXIF fields.** Add `orientation` to `deriveExifSummary` (→ exif-summary.json + internal); add `frameRate`, `audioCodec`, `bitrate`, `container` to `toPerPartMediaSummary` (→ media-summary.json). No new extraction needed — these are already in `technicalMetadata`. Tests.
> 6. **Rich package EXIF.** Extend the `exifr` pick list in `exif-extractor.service.ts` (LensModel, ISO, FNumber, ExposureTime, ShutterSpeedValue, WhiteBalance, Compression); map into `ExifSafeSummary`/`TechnicalMetadata`; add them to `exif-summary.json` **only** (keep public PDF/Verify EXIF summary unchanged). GPS stays boolean in public. Fixtures: one full-EXIF camera image, one no-EXIF image.
> 7. **Report desktop-limitation note.** One neutral sentence in the EXIF sub-block when EXIF is absent.
>
> Validate: `pnpm --filter proovra-api run typecheck`, `pnpm --filter proovra-worker run typecheck`, `pnpm --filter proovra-web run typecheck`, `pnpm --filter proovra-web build`, focused report/verify/package/technical-metadata/privacy tests, then full api + worker suites.
