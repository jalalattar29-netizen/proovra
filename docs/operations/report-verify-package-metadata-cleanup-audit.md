# Report / Verify Page / Package Metadata Cleanup + EXIF / UA / IP Audit

**Date:** 2026-06-30
**Type:** Implementation (removal) + audit (EXIF / User-Agent / IP)
**Outcome:** Low-value "Media Intelligence / Advisory Observations" removed from all public-facing outputs. EXIF / User-Agent / IP audited against live code.

---

## Executive summary

The advisory "Media Intelligence Observations" layer (workspace/correlation observations such as duplicate/similar material, with no hashes or reviewer-actionable proof) has been **removed from the PDF report, the public Verify Page, and the default Verification Package**. The three deterministic `technical-metadata/*` files remain. The extraction pipeline, signal DB rows, and the section/builder modules are **left intact** (unwired, not deleted) — no destructive DB/job cleanup.

EXIF, User-Agent, and IP metadata were audited field-by-field against the real code. EXIF is **partial** (core camera/time/dimensions/orientation/software present; lens/ISO/exposure/aperture/shutter/white-balance/compression not extracted). User-Agent is **partial** (browser+version, OS+version, device class present; engine + platform-architecture missing; enum labels not humanised). IP is **masked-only** (no full IP stored anywhere; country-code enrichment exists; ASN/ISP/VPN/TOR/proxy/datacenter/Cloudflare-Ray **not implemented**).

---

## What was removed

| Surface | Removed | File |
|---|---|---|
| PDF Report | `renderMediaIntelligenceSection` unwired from the report body | `services/worker/src/report-v2/render-html.ts` |
| Public Verify Page | `verify-media-intelligence-advisory` JSX block deleted | `apps/web/app/verify/[token]/page.tsx` |
| Verification Package | `intelligence/advisory-signals.json` + deprecated `intelligence/media_intelligence.json` no longer emitted | `services/worker/src/verification-package-intelligence.ts` |

**No blank pages / spacing:** the report body is `.filter(Boolean).join("")`, so removing the section call leaves zero residual spacing. The verify block was a self-contained conditional; the page flows straight into the Technical Metadata cards.

**Left intact (non-destructive):** `report-v2/sections/media-intelligence.ts`, `buildMediaIntelligenceManifest` (now exported for unit tests + a possible future internal package mode), the `media_intelligence_signals` table, the analyzer/extraction jobs, and the API `mediaIntelligenceAdvisory` projection + response field. Only the public OUTPUT was removed.

## What remains (high-value forensic metadata)

- **PDF Report:** "Media Technical Summary" — Media facts + EXIF Summary + Capture Environment.
- **Verify Page:** "Technical Metadata" cards — Media / EXIF / Capture Environment.
- **Verification Package:** `technical-metadata/media-summary.json`, `technical-metadata/exif-summary.json`, `technical-metadata/capture-environment.json`.
- **Internal Evidence Detail:** Technical Metadata card (Media / EXIF / Capture Environment, incl. masked IP + UA hash internal-only).

---

## EXIF audit — **PARTIAL**

**Extracted (real):** `exif-extractor.service.ts` uses a deliberately narrow `exifr` pick list →
`exifPresent`, `dateTimeOriginalUtc`, `createDateUtc`, `dimensions {width,height}`, `cameraMake`, `cameraModel`, `orientation`, `software`, `hasGps` (boolean only). Raw EXIF + XMP/IPTC/ICC blocks are **intentionally discarded** (PII-leak prevention).

| Requested field | Status |
|---|---|
| Camera Make | ✅ present |
| Camera Model | ✅ present |
| Original Capture Time | ✅ present (`dateTimeOriginalUtc`) |
| Image Resolution | ✅ present (`dimensions`) |
| Orientation | ✅ extracted (stored; **not surfaced** in report/verify/internal) |
| Software Used | ✅ present |
| EXIF GPS presence | ✅ present (`hasGps` / `gpsPresent` boolean) |
| EXIF GPS value | ✅ correctly **never** emitted publicly (boolean only; raw GPS refused at extractor unless `allowRawGps` + policy) |
| Lens | ❌ not extracted |
| ISO | ❌ not extracted |
| Exposure | ❌ not extracted |
| Aperture | ❌ not extracted |
| Shutter Speed | ❌ not extracted |
| White Balance | ❌ not extracted |
| Compression | ❌ not extracted |

**Storage:** per-part, as fields inside `EvidencePart.technicalMetadata` (JSON), mirrored to `Evidence.technicalMetadata` for single-file. There is also a legacy `evidence_part_exif_summaries` table. **Per-part: yes.**

**Display:** PDF + Verify + Internal show camera / original capture time / GPS-present / resolution / software / metadata status. `orientation` is stored but not displayed.

**Upload-path effects:** EXIF availability depends on the file's embedded metadata, not the ingest path. Desktop "Downloads" images frequently lack camera EXIF (stripped by messaging apps / social platforms / screenshots). Screenshots and generated images have no camera EXIF → correctly handled as `metadataStatus: MISSING` / "No embedded EXIF metadata detected". **Verdict: graceful.**

## User-Agent / Capture Environment audit — **PARTIAL**

`parseUserAgent` (dependency-free) detects:

| Field | Status |
|---|---|
| Browser family | ✅ (Chrome/Edge/Firefox/Safari/Opera/Samsung) |
| Browser version | ✅ |
| OS family | ✅ (Windows/macOS/iOS/Android/Linux) |
| OS version | ✅ (Windows NT mapped to "10/11" etc.) |
| Device class | ✅ (DESKTOP/MOBILE/TABLET/SERVER/UNKNOWN) |
| Engine (Blink/WebKit/Gecko) | ❌ not detected |
| Platform / architecture (x64/ARM) | ❌ not detected |

**Enum labels:** `captureMethod` / `uploadSource` are stored AND displayed as raw enums (`WEB_APP`, `SECURE_CAPTURE`, `INTAKE_LINK`, `MOBILE_APP`, `API`). There is **no humanisation layer** — the requested mappings (`WEB_APP → PROOVRA Web Application`, etc.) are **not implemented** anywhere (report bridge, verify projection, internal card all pass the raw enum through). **Gap.**

**Timezone/locale:** intake-link now includes them (client sends `Intl` timezone + `navigator.language`; server stores them). Citizen/mobile still has a **timezone limitation** (the signed citizen payload is not modified; timezone is null, locale derives from Accept-Language). Old evidence degrades gracefully ("Not available").

**Privacy:** raw User-Agent is **never** stored (only `userAgentHash`). Report + Verify Page show parsed browser/OS/device only — never the hash or raw UA. Internal card shows the UA hash (internal-only). **Compliant.**

## IP / Network audit — **MASKED-ONLY; enrichment MOSTLY MISSING**

| Field | Status |
|---|---|
| Masked IP | ✅ stored (`ipAddressMasked`, e.g. `203.0.x.x`); internal-only display |
| Full IP | ✅ correctly **never stored** in `captureEnvironment` (consumed by `maskIp`, then forgotten) |
| Country | ⚠️ partial — `geo-intelligence.service.ts` resolves **country code only**, keyed by HMAC(IP); not wired into `captureEnvironment` |
| Region | ❌ not implemented (explicitly country-only) |
| ASN | ❌ not implemented |
| ISP / Organization | ❌ not implemented |
| VPN detected | ❌ not implemented |
| TOR detected | ❌ not implemented |
| Proxy detected | ❌ not implemented |
| Datacenter detected | ❌ not implemented |
| Cloudflare Ray ID | ❌ not captured |
| Network type (Residential/Business/Mobile/Datacenter) | ❌ not implemented |
| Source header (CF-Connecting-IP / X-Forwarded-For / req.ip) | ⚠️ `req.ip` only (Fastify) — header source not recorded |

**Package leak check:** the package `capture-environment.json` emits `ipAddressMasked` + `userAgentHash` only. **No full IP, no raw UA anywhere in the package.** There is **no** `network-summary.json` today.

**GDPR:** raw IP and raw UA are personal data and are never persisted in the reportable/package shapes — only a masked IP + a UA hash. GPS coordinates are never public. **Compliant by construction.**

---

## Output placement (current state)

**A) PDF Report** — Media Technical Summary (media facts), EXIF Summary (when present), Capture Environment (uploadSource/captureMethod raw-enum, browserOs, deviceClass, timezone). No Network block. Media Intelligence Observations **removed**.

**B) Public Verify Page** — Technical Metadata cards: Media, EXIF (GPS as "Present (coordinates withheld)"), Capture Environment (uploadSource raw-enum, browser+OS, deviceClass, timezone). No Network block. Advisory/Media Intelligence **removed**.

**C) Verification Package** — `technical-metadata/media-summary.json`, `exif-summary.json`, `capture-environment.json` (masked IP + UA hash). No `network-summary.json`. No `advisory-signals.json` / `media_intelligence.json` by default.

**D) Internal Evidence Detail** — Technical Metadata card (Technical Appendix tab): Media, EXIF, Capture Environment incl. **masked IP + UA hash + locale** (internal-only). Old evidence → "Not available". Multipart → aggregate media summary; EXIF from first applicable part.

---

## Gaps / what should be added next (recommended, not done here)

1. **Enum → human labels** (small, high value): map `WEB_APP → PROOVRA Web Application`, `SECURE_CAPTURE → Secure Browser Capture`, `INTAKE_LINK → Intake Link Submission`, `MOBILE_APP → Mobile Capture`, `API → API Submission` in the shared projection so report/verify/internal all show readable submission text.
2. **UA engine + platform** (small): extend `parseUserAgent` to detect engine (Blink/WebKit/Gecko) and platform (Windows x64 / macOS / Android / iOS).
3. **EXIF richer fields** (medium): extend the `exifr` pick list with ISO/Exposure/Aperture/ShutterSpeed/WhiteBalance/Lens/Compression for the **package** (technical-reviewer JSON) only — keep the public summary compact. Surface `orientation` (already extracted).
4. **IP enrichment + `network-summary.json`** (larger, privacy-reviewed): masked IP + country + region + network-type for the public PDF "Network" block; full enrichment (ASN/ISP/VPN/TOR/proxy/datacenter/Cloudflare-Ray/full-IP) **package-internal only**, behind a privacy gate. Record the source header used.
5. **Citizen/mobile timezone** (small): pass a non-signed `captureTimezone` alongside the signed payload.

---

## Privacy confirmation
- No raw IP in public PDF, public Verify Page, or default Verification Package. ✅
- No raw User-Agent in public PDF or Verify Page; never persisted. ✅
- No precise EXIF GPS coordinates in any public output (boolean presence only). ✅

## Test results
- `prisma`/typecheck: api + worker + web **typecheck clean**.
- Worker suite: **737 passed** (report-MI removal, package-advisory removal, technical-metadata all updated and green).
- API suite: **16,797 passed**, 0 failed (phase-31-12 verify-MI removal updated).
- Web build: **success, 168/168 static pages** (verify page unused-state cleanup applied).

---

## Next implementation prompt (if EXIF/UA/IP improvements are wanted)

> **TASK: Enterprise metadata enrichment — human labels, UA engine/platform, richer package EXIF, optional IP enrichment.**
> Keep public outputs compact and privacy-safe; do not reintroduce advisory/correlation sections.
> 1. **Human submission labels.** In `packages/shared-runtime/src/technical-metadata/` add a pure `humanizeCaptureMethod()` / `humanizeUploadSource()` mapping (WEB_APP→"PROOVRA Web Application", SECURE_CAPTURE→"Secure Browser Capture", INTAKE_LINK→"Intake Link Submission", MOBILE_APP→"Mobile Capture", API→"API Submission"). Apply in `report-technical-summary-bridge.ts`, `verify-projection.service.ts`, and `EvidenceTechnicalMetadataCard.tsx`. Add tests.
> 2. **UA engine + platform.** Extend `parseUserAgent` to return `engine` (Blink/WebKit/Gecko) + `platform` (Windows x64/macOS/Android/iOS); add to `CaptureEnvironment`, surface in the package + internal card only. Unit tests for common UAs.
> 3. **Richer package EXIF.** Extend the `exifr` pick list (ISO/Exposure/Aperture/ShutterSpeed/WhiteBalance/Lens/Compression) and add them to `technical-metadata/exif-summary.json` (package/technical only) — keep the public PDF/Verify EXIF summary unchanged. Tests for a sample camera image. GPS stays boolean in public.
> 4. **IP enrichment (privacy-gated).** Wire `geo-intelligence` country into `captureEnvironment`; add a `technical-metadata/network-summary.json` (package-internal) with masked IP + country + region + network type, and gate full-IP/ASN/ISP/VPN/TOR/proxy/datacenter/Cloudflare-Ray behind an explicit internal/full package mode. Record the source header used (CF-Connecting-IP / X-Forwarded-For / req.ip). Never put full IP in public PDF/Verify. Tests assert no full IP / raw UA in public outputs.
> Validate: `pnpm --filter proovra-api run typecheck`, `pnpm --filter proovra-worker run typecheck`, `pnpm --filter proovra-web run typecheck`, `pnpm --filter proovra-web build`, plus focused report/verify/package/technical-metadata/privacy tests.
