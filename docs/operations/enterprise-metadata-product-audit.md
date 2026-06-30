# Enterprise Metadata Product Audit — Technical Metadata / EXIF / Capture Environment / Network

**Date:** 2026-06-30
**Type:** AUDIT ONLY (no code, tests, migrations, or UI changed)
**Scope:** PDF Report, Public Verify Page, Verification Package, Internal Evidence Detail, and the desktop / mobile / intake / citizen / API capture paths.

---

## 1. Executive summary

The deterministic technical-metadata layer (Media facts + EXIF summary + Capture Environment) is **functionally shipped and privacy-safe**, but it is **not yet enterprise-grade in presentation or breadth**. The pipeline is correct and clean; the gaps are (a) **breadth** — several EXIF and UA fields are extracted-but-thin or not extracted; (b) **presentation** — internal enum constants are shown to reviewers, Browser/OS is compressed into one row, and there is no Network block; and (c) **enrichment** — no IP geo/ASN/threat enrichment exists.

**Is it enterprise-ready? Partially.** It is safe to ship and useful, but a forensic/legal reviewer would find it "competent but not polished": readable camera/time/resolution + browser/OS/timezone, marred by `WEB_APP`-style labels and a missing Network section. Closing ~6 small items (enum humanization, UA engine/platform, separate report rows, masked-IP+country Network block, richer package EXIF) would move it from ~6/10 to ~8.5/10 without adding pages.

**Critically — distinguish the two "missing" causes:** the recent test evidence was a desktop/Downloads upload, so **camera EXIF + GPS + mobile fields are naturally absent** (the file has none). That is *not* an implementation gap. The real implementation gaps are: enum labels, UA engine/platform, network metadata, and richer package EXIF.

---

## 2. Desktop upload vs mobile / intake / citizen / API

| Path | Should appear | Currently appears | Naturally missing (file/source) | Implementation gap |
|---|---|---|---|---|
| **Desktop web (Downloads)** | Browser/OS/device/timezone/locale; EXIF only if the file kept it | Browser+OS (combined), device, timezone, uploadSource=`WEB_APP`, captureMethod=`UPLOAD`; EXIF present only if file has it | Camera make/model, GPS, mobile fields, ISO/exposure (download-stripped or never present) | Engine, platform, locale-in-PDF, network block; enum labels raw |
| **Mobile browser** | deviceClass=MOBILE, OS=Android/iOS, browser=Chrome/Safari, tz/locale, EXIF if original camera file | Same shape as desktop; deviceClass/OS derive correctly from UA when present | EXIF may be browser/picker-stripped on upload | Engine/platform; no mobile-specific capture-method label |
| **Intake-link** | uploadSource="Intake Link Submission", tz/locale from contributor browser, browser/OS/device | uploadSource=`INTAKE_LINK`, captureMethod=`INTAKE_LINK`, tz/locale (client now sends them), browser/OS/device | EXIF depends on file | Enum not humanized |
| **Citizen / mobile signed** | partial capture env; tz may be null | captureMethod=`MOBILE`, uploadSource=`MOBILE_APP`; **timezone null** (signed payload not extended), locale via Accept-Language | — | Timezone (only via signed-payload v2 — do NOT break signature validation; defer) |
| **API / programmatic** | uploadSource="API Submission" if a reliable API marker exists | uploadSource=`WEB_APP` (no API-key marker on `/v1/evidence`; documented TODO) | — | API identity marker — **do not invent**; future only if an API product exists |

**Rule of thumb for the auditor:** if `captureEnvironment` is populated (browser/OS/timezone present) but EXIF is empty, the file lacked EXIF — that is correct behavior, not a bug.

---

## 3. Full metadata field matrix

Legend: ✅ yes · ❌ no · ⚠️ partial · **PKG** package · **INT** internal · **PUB** public.

### A) EXIF
| Field | Extracted | Stored | Location | Pkg | PDF | Verify | Internal | Public-safe | Pkg-only | Missing: desktop-likely | Missing: impl | UX | Recommendation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Camera Make | ✅ | ✅ | EvidencePart.technicalMetadata | exif-summary | ✅ | ✅ | ✅ | ✅ | no | yes (this file) | — | good | keep |
| Camera Model | ✅ | ✅ | same | ✅ | ✅ | ✅ | ✅ | ✅ | no | yes | — | good | keep |
| Lens | ❌ | ❌ | — | — | — | — | — | ✅ | PKG | — | ✅ | n/a | add to package EXIF |
| ISO | ❌ | ❌ | — | — | — | — | — | ✅ | PKG | — | ✅ | n/a | add to package EXIF |
| Exposure | ❌ | ❌ | — | — | — | — | — | ✅ | PKG | — | ✅ | n/a | add to package EXIF |
| Aperture | ❌ | ❌ | — | — | — | — | — | ✅ | PKG | — | ✅ | n/a | add to package EXIF |
| Shutter Speed | ❌ | ❌ | — | — | — | — | — | ✅ | PKG | — | ✅ | n/a | add to package EXIF |
| White Balance | ❌ | ❌ | — | — | — | — | — | ✅ | PKG | — | ✅ | n/a | add (low priority) |
| Orientation | ✅ | ✅ | technicalMetadata | ⚠️(raw) | ❌ | ❌ | ❌ | ✅ | — | — | display | weak | **captured, not displayed** — surface in package/internal |
| Software Used | ✅ | ✅ | technicalMetadata | exif-summary | ✅ | ✅ | ✅ | ✅ | no | yes | — | good | keep (good "edited?" signal) |
| Original Capture Time | ✅ | ✅ | technicalMetadata | exif-summary | ✅ | ✅ | ✅ | ✅ | no | yes | — | good | keep |
| Image Resolution | ✅ | ✅ | technicalMetadata | media-summary | ✅ | ✅ | ✅ | ✅ | no | no | — | good | keep |
| Compression | ❌ | ❌ | — | — | — | — | — | ✅ | PKG | — | ✅ | n/a | add to package EXIF |
| EXIF GPS present | ✅ | ✅ | technicalMetadata | exif-summary | ✅ | ✅ | ✅ | ✅ | no | yes | — | good | keep |
| EXIF GPS coords | ⚠️ (refused by default) | ❌ | — | ❌ | ❌ | ❌ | ❌ | **never public** | INT/PKG-gated | yes | by design | good | keep withheld; package-internal only behind policy |
| Edited/software indicator | ⚠️ (via `software` tag only) | ✅ | technicalMetadata | exif-summary | ✅ | ✅ | ✅ | ✅ | — | — | thin | good-enough; could add explicit "edited" heuristic later |

### B) User-Agent / Capture Environment
| Field | Extracted | Stored | Location | Pkg | PDF | Verify | Internal | Public-safe | Notes / Recommendation |
|---|---|---|---|---|---|---|---|---|---|
| Browser name | ✅ | ✅ | Evidence.captureEnvironment | capture-environment | ✅(combined) | ✅(combined) | ✅ | ✅ | split into own row (impl gap: display) |
| Browser version | ✅ | ✅ | same | ✅ | ⚠️(in browserOs) | ⚠️ | ✅ | ✅ | surface explicitly |
| OS name | ✅ | ✅ | same | ✅ | ✅(combined) | ✅(combined) | ✅ | ✅ | split into own row |
| OS version | ✅ | ✅ | same | ✅ | ⚠️ | ⚠️ | ✅ | ✅ | surface explicitly |
| Device class | ✅ | ✅ | same | ✅ | ✅ | ✅ | ✅ | ✅ | keep |
| Browser engine | ❌ | ❌ | — | — | — | — | — | ✅ | **impl gap** — add Blink/WebKit/Gecko |
| Platform / arch | ❌ | ❌ | — | — | — | — | — | ✅ | **impl gap** — add Windows x64 / macOS / Android / iOS |
| Locale | ✅ | ✅ | same | ✅ | ❌ | ❌ | ✅ | ✅ | **captured, not displayed** in PDF/Verify |
| Timezone | ✅ | ✅ | same | ✅ | ✅ | ✅ | ✅ | ✅ | keep |
| Capture method | ✅ | ✅(enum) | same | ✅(enum) | ✅(**enum**) | ❌ | ✅(enum) | ✅ | **humanize** (Secure Browser Capture, etc.) |
| Upload source | ✅ | ✅(enum) | same | ✅(enum) | ✅(**enum**) | ✅(**enum**) | ✅(enum) | ✅ | **humanize** (PROOVRA Web Application, etc.) |
| User-Agent hash | ✅ | ✅ | same | ✅ | ❌ | ❌ | ✅ | ✅ | correct (internal/package only) |
| Raw User-Agent | ❌ (hashed) | ❌ | — | ❌ | ❌ | ❌ | ❌ | n/a | correct — never stored |

### C) Network / IP
| Field | Extracted | Stored | Location | Pkg | PDF | Verify | Internal | Public-safe | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Masked IP | ✅ | ✅ | captureEnvironment | capture-environment | ❌ | ❌ | ✅ | ✅ | **not in PDF/Verify** — add masked IP to PDF Network block |
| Full IP | ❌ | ❌ (consumed→masked) | — | ❌ | ❌ | ❌ | ❌ | **never public** | correct; package-internal only if ever added |
| Country | ⚠️ (geo svc exists) | ⚠️ (HMAC-keyed cache, not on evidence) | geoIntelligenceLookup | ❌ | ❌ | ❌ | ❌ | ✅ | **not wired** into captureEnvironment |
| Region | ❌ | ❌ | — | — | — | — | — | ✅ | impl gap |
| City | ❌ | ❌ | — | — | — | — | — | ⚠️ | do not collect (privacy) — country/region only |
| ASN | ❌ | ❌ | — | — | — | — | — | PKG | impl gap (package/internal only) |
| ISP / Org | ❌ | ❌ | — | — | — | — | — | PKG | impl gap (package/internal only) |
| Network type | ❌ | ❌ | — | — | — | — | — | ✅ | impl gap (Residential/Business/Mobile/Datacenter) |
| VPN / TOR / Proxy / Datacenter | ❌ | ❌ | — | — | — | — | — | PKG | impl gap; package/internal; public only if reviewer-safe |
| Cloudflare Ray ID | ❌ | ❌ | — | — | — | — | — | PKG | not captured |
| Source IP header used | ❌ (req.ip only) | ❌ | — | — | — | — | — | PKG | record CF-Connecting-IP / X-Forwarded-For / req.ip |

### D) Media Technical
| Field | Extracted | Stored | Pkg | PDF | Verify | Internal | Notes |
|---|---|---|---|---|---|---|---|
| MIME type | ✅ | ✅ | media-summary | ⚠️(in summary) | ⚠️ | ✅ | keep |
| File extension | ⚠️ (from filename) | ✅ (originalFileName) | ⚠️ | ❌ | ❌ | ⚠️ | minor |
| File size | ✅ | ✅ | media-summary | ❌ | ❌ | ⚠️ | surface in summary line |
| Image width/height | ✅ | ✅ | media-summary | ✅(resolution) | ✅ | ✅ | keep |
| Video duration | ✅ (ffprobe) | ✅ | media-summary | ✅ | ✅ | ✅ | keep |
| Video codec | ✅ (ffprobe) | ✅ | media-summary | ⚠️ | ⚠️ | ✅ | surface |
| Audio codec | ✅ (ffprobe) | ✅ | media-summary | ❌ | ❌ | ✅ | package/internal |
| Frame rate | ✅ (ffprobe) | ✅ | media-summary | ❌ | ❌ | ✅ | package/internal |
| PDF page count | ✅ (pdfjs) | ✅ | media-summary | ✅ | ✅ | ✅ | keep |
| Parser status | ✅ | ✅ | media-summary | ✅(metadataStatus) | ✅ | ✅ | keep |
| Unsupported/failed reason | ✅ (parseResult) | ✅ | media-summary | ⚠️ | ⚠️ | ✅ | surface reason text |

---

## 4. PDF Report audit (forensic reviewer lens)

- **Placement:** ✅ correct — "Media Technical Summary" sits after the Forensic Integrity Statement, before the legal hierarchy. Compact (one section), not newspaper-like.
- **EXIF visibility:** ✅ EXIF is its own labelled sub-block (not buried), but **thin** (camera/time/GPS-present/resolution/software only).
- **Enum labels:** ❌ **shows `WEB_APP` / `SECURE_CAPTURE` / `INTAKE_LINK` raw** — this is the single most "un-enterprise" defect a reviewer sees.
- **Browser/OS compression:** ⚠️ Browser+OS are one row ("Chrome on Windows"). Engine + platform absent. Should be **separate rows**: Browser, OS, Device, Engine, Platform.
- **Network:** ❌ **entirely missing** — no masked IP, no country/region/network-type.
- **Missing-state wording:** ✅ "Not available" / "Not present" / "coordinates withheld" are clear and legal-safe.
- **Privacy:** ✅ no raw IP, no raw UA, no GPS coordinates.
- **Desktop-upload limitation explanation:** ❌ the report does **not** explain that a downloaded/desktop image legitimately lacks camera EXIF — a one-line note would prevent reviewers misreading "missing" as "suspicious."

## 5. Public Verify Page audit

- **Position:** ✅ Technical Metadata cards are below the trust decision + evidence preview.
- **Reviewer-useful only:** ✅ Media / EXIF / Capture Environment; no debug JSON.
- **Enum labels:** ❌ uploadSource shown raw (`WEB_APP`).
- **Missing-field wording:** ✅ "Not available" everywhere.
- **Capture Integrity:** ✅ correctly advanced-gated — full panel only on a positive capture-side signal, else a reassuring Advanced accordion; no terse "RFC3161 absent."
- **Advisory removed:** ✅ Media Intelligence / Advisory Observations fully removed.
- **Network on Verify?** **Recommendation: minimal or none.** If shown, **only masked IP + country/region** — never ASN/ISP/threat flags publicly. Given the public page is anonymous, the safest enterprise choice is **country only (optional)** and keep masked IP + network-type to the package/internal. Reason: showing a masked IP publicly invites "is this my IP?" confusion and minor fingerprinting with little reviewer value.

**Final visibility recommendation (Verify):** public = Media + EXIF summary + Capture Environment (humanized) + optional Country; Advanced = nothing extra needed; omit entirely = masked IP, UA hash, ASN/ISP/threat.

## 6. Verification Package audit

- `media-summary.json`: ⚠️ **adequate but thin in display** — has per-part mediaKind/mime/size/sha256/dimensions/duration/codec/pageCount/metadataStatus/parseResult. Codec/frameRate/audioCodec are stored in `technicalMetadata` but the summary projection surfaces a subset. Good enough; could expose codec/frameRate explicitly.
- `exif-summary.json`: ⚠️ contains only the **extracted** subset (camera/time/GPS-present/resolution/software/orientation-status). It does **not** contain lens/ISO/exposure/aperture/shutter/WB/compression **because they are not extracted** — *missing because no parser path exists*, not faked.
- `capture-environment.json`: ✅ parsed UA (browser/OS/device/tz/locale) + **masked IP + UA hash** only. No engine/platform (not extracted).
- `network-summary.json`: ❌ **does not exist.** Recommendation: **add (package-internal)** with masked IP + country + region + network-type, and gate full-IP/ASN/ISP/VPN/proxy/datacenter/Cloudflare-Ray behind an explicit internal/full mode.
- Full IP: ✅ **intentionally absent** (missing by design).
- ASN/ISP/VPN/TOR/proxy: ❌ **missing because no enrichment exists** (not faked).
- Cloudflare Ray ID / source header: ❌ not captured.
- advisory-signals.json / media_intelligence.json: ✅ **removed from default package**.
- Workspace/correlation leaks: ✅ none remain (the duplicate/similar signals are no longer emitted; the restricted-type filter + removal both apply).
- Manifest/checksums: ✅ the technical-metadata files are appended before the checksum index, so `package-checksums.json` covers them.

## 7. Internal Evidence Detail audit

- **Visible:** ✅ in the Technical Appendix tab (collapsed card), showing Media / EXIF / Capture Environment incl. **masked IP + UA hash + locale** (internal-only). ✅ correct place for *full* detail.
- **Compact summary near preview?** ⚠️ Recommended: a small read-only summary line/badge on the Evidence **Overview** tab (camera + capture time + "EXIF present") so routine reviewers don't have to open the appendix. The card is currently somewhat buried.
- **Case Evidence drawer/preview:** ❌ does not show it; ⚠️ recommend a compact badge only (not the full card).
- **Multipart:** ✅ aggregate media summary; EXIF from first applicable part — layout holds.
- **Old evidence:** ✅ "Not available" gracefully.
- **Internal > public:** ✅ correct — internal sees masked IP + UA hash; public does not.

## 8. Privacy / GDPR audit

✅ Strong posture: raw IP never stored (masked only), raw UA never stored (hashed), EXIF GPS coordinates never public (boolean only, refused at extractor by default). Masked IP + UA hash are internal/package only. Country-code geo is HMAC-keyed (no raw IP retained). Intake third-party uploads get the same protections. **No GDPR red flags.** The only forward-looking caution: if IP enrichment (ASN/ISP/threat) is added, keep it package-internal + privacy-reviewed, and document a retention policy for any new network fields.

---

## 9. Product placement decision matrix

| Field | Report PUB | Verify PUB | Package | Internal | Ops only | Don't collect | Future |
|---|---|---|---|---|---|---|---|
| Camera Make/Model | ✅ | ✅ | ✅ | ✅ | | | |
| Original Capture Time | ✅ | ✅ | ✅ | ✅ | | | |
| Resolution / dimensions | ✅ | ✅ | ✅ | ✅ | | | |
| Software tag | ✅ | ✅ | ✅ | ✅ | | | |
| Orientation | | | ✅ | ✅ | | | |
| Lens/ISO/Exposure/Aperture/Shutter/WB/Compression | | | ✅ | ✅ | | | ✅ |
| EXIF GPS present | ✅ | ✅ | ✅ | ✅ | | | |
| EXIF GPS coordinates | | | (gated) | (gated) | | mostly | ✅ |
| Browser/OS/Device | ✅ | ✅ | ✅ | ✅ | | | |
| Browser version / OS version | ✅ | ✅ | ✅ | ✅ | | | |
| Engine / Platform | ✅ | ✅ | ✅ | ✅ | | | ✅ |
| Locale | ✅ | optional | ✅ | ✅ | | | |
| Timezone | ✅ | ✅ | ✅ | ✅ | | | |
| Capture method / Upload source (humanized) | ✅ | ✅ | ✅ | ✅ | | | |
| UA hash | | | ✅ | ✅ | | | |
| Raw UA | | | | | | ✅ | |
| Masked IP | optional | optional | ✅ | ✅ | | | |
| Full IP | | | (gated internal) | (gated internal) | | | ✅ |
| Country / Region | optional | optional | ✅ | ✅ | | | ✅ |
| Network type | optional | | ✅ | ✅ | | | ✅ |
| ASN / ISP | | | ✅ | ✅ | | | ✅ |
| VPN / TOR / Proxy / Datacenter | | reviewer-safe only | ✅ | ✅ | | | ✅ |
| Cloudflare Ray ID / source header | | | ✅ | ✅ | | | ✅ |
| Parser health (OK/FAILED/UNSUPPORTED counts) | | | | | ✅ | | |

---

## 10. UX scoring

| Area | Score | Good | Weak | Must-fix | Optional |
|---|---|---|---|---|---|
| PDF Technical Metadata section | **6/10** | placement, compactness, privacy | enum labels, no network | humanize enums | desktop-limitation note |
| PDF EXIF Summary | **6/10** | own block, clear withheld-GPS | thin fields, orientation hidden | — | richer package EXIF |
| PDF Capture Environment | **5/10** | tz + device present | raw enums, Browser/OS combined, no engine/platform/locale | humanize + split rows | engine/platform |
| PDF Network Metadata | **2/10** | privacy-safe by absence | does not exist | add masked IP + country block | network type |
| Public Verify Technical Metadata | **7/10** | position, gating, advisory removed | raw enum, no network | humanize enums | optional country |
| Verification Package technical metadata | **7/10** | clean, per-part, privacy-safe, no leaks | thin EXIF, no network-summary | — | network-summary.json + richer EXIF |
| Internal Evidence Detail | **7/10** | full detail incl. masked IP/UA hash | buried in appendix | — | overview badge |
| Privacy / GDPR posture | **9/10** | no raw IP/UA/GPS; hashes/masks | — | — | retention policy for future net fields |
| Enterprise readiness (overall) | **6.5/10** | safe, correct, clean pipeline | presentation polish + network breadth | enum humanize, UA engine/platform, report rows, network block | EXIF breadth, IP enrichment |

---

## 11. Must-fix (small, high reviewer value)
1. **Humanize enums** everywhere (PDF + Verify + Internal): `WEB_APP → PROOVRA Web Application`, `SECURE_CAPTURE → Secure Browser Capture`, `INTAKE_LINK → Intake Link Submission`, `MOBILE_APP → Mobile Capture`, `API → API Submission`.
2. **Split Capture Environment rows** in the PDF: Browser, OS, Device, Engine, Platform, Timezone, Locale (instead of "Chrome on Windows").
3. **Add UA engine + platform** detection to `parseUserAgent` (Blink/WebKit/Gecko; Windows x64/macOS/Android/iOS).
4. **Add a PDF Network block** (masked IP + country + region + network-type) — never full IP.

## 12. Should-fix
5. **Richer package EXIF** (lens/ISO/exposure/aperture/shutter/WB/compression) in `exif-summary.json` only — keep public summary compact.
6. **Wire country/region** from the existing geo service into `captureEnvironment`; add `technical-metadata/network-summary.json` (package-internal).
7. **Surface locale + orientation** (already captured) in package/internal.
8. **Desktop-upload limitation note** in the report ("Embedded camera metadata is absent for files that were downloaded, screenshotted, generated, or stripped by the source application — this is expected and is not an integrity concern.").

## 13. Nice-to-have
9. Compact EXIF/camera **badge on the Evidence Overview tab** (and Case drawer), full card stays in the appendix.
10. IP threat enrichment (ASN/ISP/VPN/TOR/proxy/datacenter, Cloudflare Ray ID, source header) — **package-internal only**, privacy-gated.
11. Ops/Reliability **parser-health tile** (OK/FAILED/UNSUPPORTED + ffprobe availability).
12. Explicit "edited" heuristic from the software tag.

## 14. What NOT to add
- ❌ Full IP in PDF or Verify (ever).
- ❌ Raw User-Agent anywhere (don't even store it).
- ❌ Precise EXIF GPS coordinates in any public output.
- ❌ City-level geolocation (region is the privacy floor).
- ❌ Workspace/correlation advisory sections (just removed — do not reintroduce).
- ❌ Dashboard statistics for metadata (no operational value; parser-health tile is the only justified aggregate).
- ❌ An invented API upload-source marker (no API identity exists yet).
- ❌ Breaking the citizen signed-payload to add timezone (defer to a signed-payload v2 only if a real need arises).

---

## 15. Next implementation prompt (exact)

> **TASK: Enterprise metadata presentation + Network block — humanize labels, split rows, add UA engine/platform, add masked-IP Network block, richer package EXIF.**
> Keep public outputs compact and privacy-safe. No full IP / raw UA / GPS coordinates in public. Do not reintroduce advisory sections.
>
> 1. **Humanize submission labels.** Add pure helpers `humanizeUploadSource()` / `humanizeCaptureMethod()` in `packages/shared-runtime/src/technical-metadata/` (WEB_APP→"PROOVRA Web Application", SECURE_CAPTURE→"Secure Browser Capture", INTAKE_LINK→"Intake Link Submission", MOBILE_APP→"Mobile Capture", API→"API Submission", UPLOAD→"Direct Upload", UNKNOWN→"Unknown"). Apply in `report-technical-summary-bridge.ts`, `verify-projection.service.ts`, and `EvidenceTechnicalMetadataCard.tsx`. Unit tests.
> 2. **UA engine + platform.** Extend `parseUserAgent` to return `engine` (Blink/WebKit/Gecko) and `platform` (Windows x64/macOS/Android/iOS). Add both to `CaptureEnvironment` (additive, nullable JSON — no migration needed since it's inside the JSON column). Surface in package + internal card; add to PDF/Verify capture rows. Tests for common UAs.
> 3. **Split PDF capture rows + add locale.** In `report-v2/sections/technical-summary.ts`, render Browser, OS, Device, Engine, Platform, Timezone, Locale as separate compact rows (drop the combined "browserOs"). Keep ≤ one page. Snapshot test.
> 4. **PDF + Verify Network block (masked IP + geo).** Wire the existing `geo-intelligence` country (and add region) into `captureEnvironment` at ingest. Add a compact "Network" block to the PDF (Masked IP, Country, Region, Network type) and an optional Country line on Verify. Never full IP. Add `technical-metadata/network-summary.json` (package; masked IP + country + region + network-type; full-IP/ASN/ISP/VPN gated behind a future internal mode, not implemented now). Tests assert no full IP / raw UA in public outputs.
> 5. **Richer package EXIF.** Extend the `exifr` pick list (ISO, ExposureTime, FNumber/Aperture, ShutterSpeedValue, LensModel, WhiteBalance, Compression) and add them to `exif-summary.json` only. Keep the public PDF/Verify EXIF summary unchanged. Surface `orientation`. GPS stays boolean in public. Tests with a real camera image fixture + a no-EXIF fixture.
> 6. **Report desktop-limitation note.** Add one neutral sentence to the EXIF sub-block when EXIF is absent: embedded camera metadata is expected to be absent for downloaded/screenshotted/generated/stripped files and is not an integrity concern.
>
> Validate: `pnpm --filter proovra-api run typecheck`, `pnpm --filter proovra-worker run typecheck`, `pnpm --filter proovra-web run typecheck`, `pnpm --filter proovra-web build`, plus focused report/verify/package/technical-metadata/privacy tests, then the full api + worker suites.
