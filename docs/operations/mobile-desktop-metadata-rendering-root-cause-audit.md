# Mobile Intake & Desktop Capture — Metadata Rendering Root-Cause Audit

**Date:** 2026-06-30
**Type:** AUDIT ONLY (no code/UI/test/migration changes)
**Method:** The two PDFs' observed values (provided) were each traced through the deterministic code pipeline to the exact stage that produced them. Live production DB rows were not queried from this environment; every conclusion below is grounded in the code path that generates the value, which is the deterministic source of truth for "why it rendered this way." Where a fact can only be confirmed from the actual stored record, it is flagged as **[needs record]**.

---

## 1. Executive summary

Both reports are mostly **correct-but-mispresented**, with **one genuinely wrong value** (desktop masked IP) and **one expectation mismatch** (mobile GPS). The five headline observations resolve as follows:

| Observation | Verdict | One-line root cause |
|---|---|---|
| Mobile "EXIF GPS: Not present" | **Correct** | The row reflects the *file's embedded* EXIF GPS only; the Samsung file has none (location tagging off). Any *submission* geolocation is captured separately and is not — by design — shown in this EXIF row. |
| Desktop "Masked IP: 172.18.x.x" | **Wrong** | Fastify `trustProxy` is **not enabled** (server.ts:477), so `req.ip` returns the Docker bridge gateway, not the real client. |
| Desktop "OS: Windows 10/11" | **Correct but generic** | The classic User-Agent string is identical (`Windows NT 10.0`) for Win10 and Win11; the parser cannot distinguish them and no UA Client Hints are collected. |
| Media "Primary Media Type: Mixed" | **Correct** | The evidence has parts of more than one media kind; `primaryMediaTypeLabel` returns "Mixed" by design. |
| Media "Metadata: Partial" + "Resolution: 1735×913" | **Correct logic, misleading UX** | "Partial" = some parts have metadata, some don't. Resolution is **the first part's** dimensions (`perPart[0]`), not the largest/representative — arbitrary for mixed evidence. |

**The two things to fix first:** (1) wire real-client-IP extraction (or hide private-range IPs), and (2) replace "Mixed + one arbitrary resolution" with a media-composition line. Everything else is wording/labeling.

---

## 2. Mobile intake evidence trace

**Path:** intake link → `apps/web/app/intake/[token]/page.tsx` → `POST /v1/external-intake/:token/sessions/:sid/parts` → `addExternalEvidencePart` → `createEvidence` → worker `extract_technical_metadata` (exifr) → `evidence_parts.technical_metadata` → `deriveExifSummary` → PDF EXIF Summary block.

| EXIF field | Origin | Why it appeared |
|---|---|---|
| Camera (samsung Galaxy S25 FE) | **Embedded EXIF** (`Make`/`Model`) | File carried Make/Model; extractor requests them; `formatCameraLabel` joined them. |
| Original Capture Time | **Embedded EXIF** (`DateTimeOriginal`) | Present in file. |
| ISO / Aperture / Exposure / Shutter / White balance | **Embedded EXIF** (newly-added pick: `ISO`/`FNumber`/`ExposureTime`/`ShutterSpeedValue`/`WhiteBalance`) | Samsung camera wrote them; the recent rich-EXIF work now reads + formats them. |
| Software (S731BXXS7BZF3) | **Embedded EXIF** (`Software`) | Raw Samsung **firmware build id** from the file — correct value, cryptic form. |
| Resolution | **Embedded EXIF / sharp header** | Pixel dimensions. |
| **EXIF GPS: Not present** | **Embedded EXIF GPS absence** | See §4. |

**Capture/intake context (separate from EXIF):**
- Upload source = `INTAKE_LINK` → humanized "Intake Link Submission" (capture-environment).
- Timezone/locale → from the intake client (`captureTimezone`/`captureLocale`, wired in external-intake parts body).
- **Browser geolocation** → the intake page *can* call `navigator.geolocation.getCurrentPosition` (page.tsx:369) and POST `location:{latitude,longitude,accuracy}`; the backend accepts it (external-intake.routes.ts:99, :876) and stores it on `evidence.lat/lng` with `locationSource = INTAKE_LINK_GEOLOCATION`. **This is NOT the EXIF GPS row** and is not surfaced in the technical-metadata EXIF block.

---

## 3. Desktop capture evidence trace

**Path:** web app capture → `POST /v1/evidence` → `recordCaptureEnvironment` (`buildCaptureEnvironment(parseUserAgent(req.headers["user-agent"]), maskIp(req.ip), …)`) → `evidence.capture_environment` → `verify-projection`/`report bridge` → PDF Capture Environment + Network.

| Field | Source | Accurate? |
|---|---|---|
| Submitted through: PROOVRA Web Application | route literal `WEB_APP` → `humanizeUploadSource` | ✅ |
| Capture Method: Secure Browser Capture | `SECURE_CAPTURE` (a captureSessionId was present) → humanized | ✅ |
| Browser: Chrome 149 | **parsed from UA** (`Chrome/149…`) | ✅ |
| Operating System: Windows 10/11 | **parsed from UA** (`Windows NT 10.0` → mapped "10/11") | ✅ but generic — see §6 |
| Device: Desktop | UA heuristics | ✅ |
| Engine: Blink | derived from browser family | ✅ |
| Platform: Windows x64 | UA (`Win64; x64`) | ✅ |
| Timezone: Europe/Berlin | **client JS** (`Intl…timeZone`) | ✅ |
| Locale: de-DE | **client JS** (`navigator.language`) | ✅ |
| **Masked IP: 172.18.x.x** | **server `req.ip`** masked | ❌ infra IP — see §5 |

---

## 4. GPS root-cause investigation (mobile)

The two GPS concepts are kept strictly separate by the code, and the report's EXIF row only ever reflects (A):

**A) EXIF GPS inside the image file**
- Did the file contain `GPSLatitude/GPSLongitude`? **[needs record]** — but the displayed `gpsPresent:false` means the extractor found none.
- Does the parser request GPS tags? **Yes** — `exif-extractor.service.ts` picks `GPSLatitude/GPSLongitude/Refs/latitude/longitude`.
- Does it strip exact coordinates but keep presence? **Yes by design** — raw GPS is refused (`allowRawGps:false`); only `hasGps` boolean is stored.
- Does `technical_metadata` store presence only? **Yes** (`gpsPresent`).
- Does the report show presence only? **Yes** ("Present (coordinates withheld) / Not present").
- Package? Presence flag only (`exif-summary.json gpsPresent`); no coordinates.

**B) Browser geolocation / intake submission location**
- Does the intake page request geolocation? **Yes, on explicit user action** (page.tsx:361-376 — never silent).
- Did the user grant it? **[needs record]** (`evidence.lat/lng` non-null + `locationSource = INTAKE_LINK_GEOLOCATION` would confirm).
- Does the frontend send lat/lng/accuracy? **Yes** (`location:{latitude,longitude,accuracy}`).
- Does the backend accept + store it? **Yes** (external-intake.routes.ts:99/876 → `evidence.lat/lng`).
- Does the report distinguish it from EXIF GPS? **Yes — they are different fields and the EXIF row never shows submission location.** Submission location surfaces (if at all) in the *capture context* / map-preview path, not the technical-metadata EXIF block.

**C) Mobile OS/camera privacy**
- Samsung/Android default to **location tagging OFF** for the camera; such files carry full camera EXIF (ISO/aperture/etc.) but **no GPS** — exactly the pattern observed.

**Final mobile GPS conclusion:** **GPS absent because the uploaded file lacks EXIF GPS** (Samsung location-tagging off) — the value is correct. The parser *does* read GPS; nothing was dropped; privacy only withholds *coordinates*, never the presence flag. If the user expected to *see* a location, that would be the **browser/intake submission geolocation**, which is a separate datum (stored on `evidence.lat/lng`) and is intentionally **not** shown in the EXIF section. Whether it was actually captured for this record is **[needs record]**.

---

## 5. IP / proxy root-cause investigation (desktop)

**Why 172.18.x.x:** `172.16.0.0–172.31.255.255` is the Docker default bridge range. The capture-environment writer uses `rawIp: req.ip`. Fastify's `req.ip` equals the immediate TCP peer **unless `trustProxy` is configured** — and the Fastify constructor (`server.ts:477-500`) sets **no `trustProxy`**. Behind the reverse proxy (Caddy/Nginx → app container), the immediate peer is the Docker bridge gateway → `req.ip` = `172.18.x.x` → masked to `172.18.x.x`.

- trustProxy enabled? **No.**
- Are CF/XFF headers available? **Yes** — the app already reads `cf-ipcountry`/`cf-region`/`cf-ray` in `buildGeoContext` (server.ts:262-275), proving Cloudflare headers reach the app. But the **capture IP path does not read `CF-Connecting-IP` / `X-Forwarded-For`.**
- Does it validate a trusted-proxy chain? **No.**
- Country wiring: the writer calls `lookupCountryCode(req.ip)` on the **Docker IP**, which can never resolve a real country — yet `cf-ipcountry` is *already present* in the request and unused for capture environment.
- Does Docker/Hetzner preserve client IP? Only if the proxy forwards `X-Forwarded-For`/`CF-Connecting-IP` **and** Fastify is told to trust it.

**Conclusion:** the masked IP is **wrong** (infra IP, not the client). It should not appear; private RFC1918 ranges (`10.*`, `172.16–31.*`, `192.168.*`) should be suppressed and shown as "Network context unavailable" until real-client-IP extraction is wired (`trustProxy` + `CF-Connecting-IP`/`X-Forwarded-For`). Country should come from the already-present `cf-ipcountry` header.

---

## 6. OS / User-Agent root-cause investigation (desktop)

**Why "Windows 10/11":** `parseUserAgent` maps `Windows NT 10.0` → "10/11". Microsoft **froze the classic UA token at `Windows NT 10.0` for both Windows 10 and 11**, so the legacy UA genuinely cannot distinguish them.
- Frontend collects `navigator.userAgentData` / `platformVersion`? **No.**
- Backend receives `Sec-CH-UA-Platform-Version`? **No** (not requested/forwarded).
- Distinguishing rule: Client Hints `platformVersion` major ≥ 13 ⇒ Windows 11; 1–12 ⇒ Windows 10. Not available here.
- Should the report say "Windows"? **Yes** — showing "Windows 10/11" is honest but reads as uncertainty. Display **"Windows"** unless Client Hints prove the version.

---

## 7. Media summary root-cause investigation (desktop)

- **Primary Media Type = Mixed:** `primaryMediaTypeLabel(parts)` returns "Mixed" when `new Set(parts.map(p=>p.mediaKind)).size > 1`. The evidence has ≥2 distinct kinds (e.g. image + PDF, or image + "other"). **[needs record]** for the exact kinds.
- **Metadata = Partial:** `aggregateMetadataStatus`: all `PRESENT` → "Complete"; all `MISSING/UNKNOWN` → "Missing/Unavailable"; **otherwise "Partial."** So some parts have metadata, some don't (e.g. a camera image PRESENT + a screenshot/text MISSING).
- **Resolution = 1735×913 (or 4000×3000):** `resolutionSummary` uses **`primary = perPart[0]`** — the part at `part_index = 0`. It is the **first uploaded part's** dimensions, not the largest or "representative" one. For mixed evidence this is arbitrary and misleading (1735×913 is likely a screenshot, while the 4000×3000 camera photo is a later part).
- **Recommendation:** for multipart/mixed evidence, show **composition** ("Images: X · Videos: Y · PDFs: Z") instead of "Mixed", and **hide the single resolution** (or label it "Primary part: 1735×913") rather than implying it represents the whole record.

---

## 8. Report UX root-cause investigation

All four blocks are produced by `report-v2/sections/technical-summary.ts` via `renderCompactKeyValueList` (label/value rows) inside `renderPageSection`. It already uses `metadataRows()` smart-filtering + humanized labels. It is **clean and compact but table-flat** — no grouping/emphasis, and a few values are raw-but-cryptic.

| Value | Verdict | Action |
|---|---|---|
| "Primary Media Type: Mixed" | misleading for multipart | **replace** with composition counts |
| "Metadata: Partial" | technically true, vague | **replace** with coverage ("Metadata for 1 of 3 files") |
| "Resolution: 1735×913" | arbitrary (first part) | **hide for mixed**, or label "Primary part" |
| "EXIF GPS: Not present" | correct | **keep** |
| "Software: S731BXXS7BZF3" | correct, cryptic build id | **move to package only** (or label "Firmware build"); hide cryptic id in PDF |
| "Operating System: Windows 10/11" | correct, generic | **rename** to "Windows" unless Client Hints |
| "Masked IP: 172.18.x.x" | wrong (infra IP) | **hide** private ranges → "Network context unavailable"; needs IP-pipeline fix first |

---

## 9. Verify / package / internal consistency matrix

| Metadata group | PDF Report | Public Verify | Package JSON | Internal Detail | Consistent? |
|---|---|---|---|---|---|
| EXIF camera/time/rich | shown (rich) | shown (rich) | `exif-summary.json` (rich) | shown (rich) | ✅ |
| EXIF GPS | presence only | presence only | presence only | presence only | ✅ |
| Capture env (browser/OS/engine/platform/tz/locale) | shown (humanized) | shown (humanized) | raw enums in `capture-environment.json` | shown (humanized) | ⚠️ package keeps raw enum (acceptable for technical JSON) |
| Masked IP | shown (infra IP) | **not shown** | `capture-environment.json` + `network-summary.json` | shown | ⚠️ **report shows a value Verify hides** — and it's the wrong value |
| Country/region/network type | "Network" block | **Country only (if any)** | `network-summary.json` | shown | ✅ (geo currently null → blocks often absent) |
| Software build id | shown | shown | shown | shown | ⚠️ cryptic everywhere; should be package/internal only in raw form |
| Submission geolocation (lat/lng) | **not in tech-metadata section** | not in tech-metadata | not in tech-metadata | not in tech-metadata | ✅ separate from EXIF (lives in capture-context) |

**Key inconsistency:** the **masked IP appears in the PDF but is deliberately hidden on the public Verify page** — and the PDF's value is the infra IP. This is the sharpest report/verify divergence.

---

## 10. Root-cause matrix

| Issue | Surface | M/D/Both | Observed | Expected | Root cause | Broken stage | Fix type | Priority | Recommended action |
|---|---|---|---|---|---|---|---|---|---|
| EXIF GPS "Not present" | EXIF | Mobile | Not present | (correct) | File has no EXIF GPS (Samsung location off); coords withheld by design | none (correct) | none | P4 | Keep; optionally add a "Submission location" line sourced from `evidence.lat/lng` (separate from EXIF) |
| Masked IP 172.18.x.x | Network | Desktop | 172.18.x.x | real client IP or "unavailable" | `trustProxy` not set → `req.ip` = Docker bridge; CF-Connecting-IP/XFF unread | ingest (`server.ts` Fastify config + `capture-environment-writer`) | data pipeline + display | **P0/P1** | Enable trustProxy + read CF-Connecting-IP/XFF; meanwhile hide RFC1918 ranges |
| OS "Windows 10/11" | Capture Env | Desktop | Windows 10/11 | "Windows" (or exact via Client Hints) | UA token frozen at NT 10.0; no Client Hints collected | parser + frontend | display (+ optional data) | P2 | Render "Windows" when version unprovable; optionally collect `Sec-CH-UA-Platform-Version` |
| "Mixed" | Media | Desktop | Mixed | "Images: X · PDFs: Z …" | `primaryMediaTypeLabel` returns Mixed for >1 kind | projection/render | display | P2 | Show composition counts for multipart |
| "Partial" | Media | Desktop | Partial | "Metadata for N of M files" | `aggregateMetadataStatus` ternary | render | display | P3 | Reword as coverage count |
| Resolution ambiguous | Media | Desktop | 1735×913 | per-part or hidden | `resolutionSummary` uses `perPart[0]` | projection (`projections.ts`) | display | P2 | Hide for mixed, or label "Primary part" / list per image |
| Software build id | EXIF | Both | S731BXXS7BZF3 | "Firmware build" / package-only | raw EXIF `Software` shown verbatim | render | display | P3 | Keep raw in package; in PDF label or omit cryptic build ids |
| Report table-heavy/basic | All | Both | flat KV rows | grouped enterprise cards | `renderCompactKeyValueList` flat layout | render | display | P3 | Light visual grouping (no new data) |
| Report/Verify IP divergence | Network | Desktop | PDF shows, Verify hides | consistent | masked IP in PDF but not Verify; value also wrong | render policy | display | P1 | Hide masked IP in PDF too (until real IP), matching Verify |
| Empty/irrelevant hiding | All | Both | already hidden | — | `metadataRows` works | none | none | — | Keep; extend to suppress private-range IP + cryptic software |

---

## 11. Prioritized fix plan

**A) Data correctness fixes**
1. **Real client IP (P0/P1).** Enable Fastify `trustProxy` (trust the known proxy hops only) and read `CF-Connecting-IP` → `X-Forwarded-For[0]` → `req.ip` via a single `getClientIp(req)` helper; pass that to `recordCaptureEnvironment`. Files: `services/api/src/server.ts`, a new `getClientIp` util, `capture-environment-writer.ts`, all three ingest routes. **Risk: medium** (trustProxy misconfig can spoof IPs — trust only the real hop count). **Separate phase.**
2. **Country from CF header (P2).** Use `cf-ipcountry` (+ `cf-region`) already on the request instead of `lookupCountryCode(req.ip)`. Files: `capture-environment-writer.ts`. **Risk: low.**
3. **Optional UA Client Hints (P2, later).** Collect `navigator.userAgentData.getHighEntropyValues(["platformVersion"])` client-side, forward, and use to set exact Windows 11/10. Files: capture client + `parseUserAgent`. **Risk: low; separate phase.**
4. **GPS source separation (P3).** Optionally add a clearly-labeled "Submission location (browser)" line from `evidence.lat/lng` (`locationSource`), distinct from EXIF GPS. Files: report bridge + section. **Risk: low.**

**B) Product display fixes (safe, one-shot, no data changes)**
5. Hide RFC1918 / private masked IPs → "Network context unavailable" (PDF + internal). Files: `report-technical-summary-bridge.ts`, internal card, or a shared `isPrivateMaskedIp` helper.
6. Render "Windows" instead of "Windows 10/11" when version is the frozen 10.0 token. Files: render/projection (display-only).
7. Media composition counts instead of "Mixed"; hide/relabel resolution for multipart. Files: `projections.ts` (`primaryMediaTypeLabel` consumer) + report section + verify component.
8. Reword "Partial" → "Metadata for N of M files". Files: report section / projection.
9. Label or omit cryptic Software build ids in the public PDF.

**C) Package / internal-only fixes**
10. Keep the raw Software build id and full enums in the package/internal only; PDF/Verify show humanized/labeled forms. (Mostly already true; tighten Software.)
11. Keep masked IP / UA hash / network internals in package + internal only (already the policy — extend to never show the *private* masked IP publicly).

---

## 12. Exact next implementation prompt

> **TASK: Metadata correctness + presentation fixes — real client IP, private-IP suppression, Windows version, media composition, software/labels.**
> Audit-driven (see metadata-root-cause-trace-audit + this doc). No migration (capture env is a JSON column). Public outputs stay privacy-safe: never full IP, never raw UA, never EXIF GPS coordinates.
>
> 1. **Real client IP (separate, careful).** Add `getClientIp(req)` in `services/api/src/lib/` that returns the first of: `CF-Connecting-IP`, first hop of `X-Forwarded-For`, else `req.ip`. Enable Fastify `trustProxy` in `server.ts` scoped to the real proxy hop count (NOT `true`). Pass `getClientIp(req)` (not `req.ip`) into `recordCaptureEnvironment` in `evidence.routes.ts`, `citizen-capture.routes.ts`, `external-intake.routes.ts`. Tests: XFF/CF parsing, spoof-resistance.
> 2. **Country from CF header.** In `capture-environment-writer.ts`, prefer `cf-ipcountry` (and `cf-region`) from request headers over `lookupCountryCode(req.ip)`; keep the geo lookup as fallback. Pass region through.
> 3. **Suppress private masked IP.** Add `isPrivateMaskedIp()` (10./172.16-31./192.168./127./::1/fc00::) to display-helpers; in the report bridge + internal card + network-summary, when the masked IP is private, set it to null and render "Network context unavailable" instead of the value. Tests assert 172.18.x.x is suppressed.
> 4. **Windows version honesty.** In `parseUserAgent` (or a display helper), when OS is Windows and the only signal is `NT 10.0`, set `osVersion = null` and display "Windows" (drop "10/11"). Optional follow-up: collect `Sec-CH-UA-Platform-Version` client-side to recover exact 10 vs 11.
> 5. **Media composition + resolution.** Add `mediaComposition` (counts per kind) to the report/verify projections; render "Images: X · Videos: Y · PDFs: Z" instead of "Mixed" for multipart, and for mixed evidence hide the single resolution (or label "Primary part: WxH"). Reword "Partial" → "Metadata available for N of M files". Files: `projections.ts`, `report-technical-summary-bridge.ts`, `technical-summary.ts`, `verify-projection.service.ts`, `VerifyTechnicalMetadataSection.tsx`, internal card.
> 6. **Software build id.** Keep raw `softwareTag` in `exif-summary.json` (package) + internal; in PDF/Verify, label the row "Software / firmware build" and keep the value (it is the file's true software tag) — do not invent.
> Validate: `pnpm --filter proovra-api run typecheck`, `pnpm --filter proovra-worker run typecheck`, `pnpm --filter proovra-web run typecheck`, `pnpm --filter proovra-web build`, focused report/verify/package/capture-environment/privacy tests, then full api + worker suites. Privacy tests must assert: no full IP anywhere public, private masked IPs suppressed, no raw UA, no EXIF GPS coordinates.
