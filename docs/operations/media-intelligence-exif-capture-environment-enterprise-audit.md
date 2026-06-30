# PROOVRA Enterprise Audit — Real Media Intelligence, EXIF Summary, and Capture Environment

**Audit date:** 2026-06-30  
**Status:** AUDIT ONLY — no code changes made  
**Auditor:** Claude Sonnet 4.6 (automated codebase audit)

---

## Executive Summary

PROOVRA currently conflates three conceptually distinct metadata layers under names that overlap or mislead:

| Layer | Correct Meaning | Current State |
|---|---|---|
| **Media Technical Metadata** | Deterministic file-level technical facts (MIME, dimensions, codec, EXIF) | Partially stored in schema; never surfaced as a coherent artifact |
| **EXIF Summary** | Reviewer-facing summary of camera/device metadata embedded in the file | Extracted by service; stored in bounded form; absent from package and report |
| **Capture Environment** | Browser, OS, IP, timezone, locale, UA recorded at PROOVRA upload time | Scattered across `CustodyEvent`, `CaptureTrustEventRecord`, and auth models; not consolidated; not in package |

The current label "Media Intelligence" refers to **advisory signals** about the file — observations like `EXIF_MISSING`, `DUPLICATE_HASH_MATCH`, `CLIENT_SERVER_TIME_GAP`. This is neither raw technical metadata nor EXIF. It is a *signal layer* derived from technical metadata, not the metadata itself.

**Top-line verdict:**  
- Media Intelligence should **not** be renamed — it should be **split**: the signal layer keeps the name, the underlying technical metadata layer is added as a new artifact.  
- The Verify Page "Capture Trust" section is **not wrong** — it describes capture-time integrity primitives — but it is **unlabeled as such**, causing reviewers to read it as current preservation state.  
- The Verification Package **lacks three files** it should contain: `technical-metadata/media-metadata-raw.json`, `technical-metadata/exif-summary.json`, `technical-metadata/capture-environment.json`.  
- IP address and full user-agent are captured in multiple models but **no privacy-safe consolidation** exists for reporting or package output.

**Total findings: 28**  
**Critical (P0): 6 | High (P1): 8 | Medium (P2): 9 | Low/Advisory (P3): 5**

---

## 1. Current-State Findings

### 1.1 Where Things Live Today

#### Media Technical Metadata (file-level facts)

| Field | Model | Column | Notes |
|---|---|---|---|
| MIME type | `Evidence` | `mimeType` | VARCHAR 128 |
| File size | `Evidence` | `sizeBytes` | BigInt |
| SHA-256 | `Evidence` | `fileSha256` | VARCHAR 64 |
| Duration (video/audio) | `Evidence` | `durationSec` | Float |
| Part MIME type | `EvidencePart` | `mimeType` | Per-part |
| Part size | `EvidencePart` | `sizeBytes` | Per-part |
| Part SHA-256 | `EvidencePart` | `sha256` | Per-part |
| Part duration | `EvidencePart` | `durationMs` | Per-part |
| Perceptual hashes | `EvidencePart` | `perceptualPhash`, `perceptualDhash` | Phase 12 |
| Client signals | `EvidencePart` | `clientSignals` (JSON) | Unvalidated client hints |

**What is absent from the schema:**
- Image width, height, color space
- Video codec, audio codec, frame rate, bitrate, stream count
- EXIF GPS coordinates as media metadata (stored separately on Evidence as lat/lng but tied to location feature, not EXIF)
- Camera make/model, original capture date from EXIF
- Software/editor tag from EXIF
- Orientation, compression, thumbnail presence
- PDF page count, producer, PDF metadata
- Structural parse result or parse success flag
- Metadata completeness status (Present / Partial / Missing / Conflict)

#### EXIF Data

- **`services/api/src/services/media-intelligence/exif-extractor.service.ts`** — extracts EXIF from uploaded files; detects EXIF presence and timestamp mismatch vs server time.
- **`services/api/src/services/media-intelligence/exif-summary.service.ts`** — persists a bounded summary to the database (not raw EXIF bytes).
- The raw EXIF is **not stored** anywhere and is **not in the Verification Package**.
- The bounded EXIF summary is **not surfaced** in the PDF report or the Verify Page.
- EXIF signals (`EXIF_MISSING`, `EXIF_TIMESTAMP_MISMATCH`) feed into `media_intelligence_signals` but the underlying EXIF data that drove those signals is discarded after extraction.

#### Capture Environment

| Field | Where Stored | Privacy State |
|---|---|---|
| IP address | `CustodyEvent.ipAddress`, `CaptureTrustEventRecord.ip`, `IntakeLinkSubmission.submitterIpHash` | Raw in custody events; hashed only in IntakeLinkSubmission |
| User-Agent | `CustodyEvent.userAgent`, `CaptureTrustEventRecord.userAgent`, multiple auth models | Raw VARCHAR(512); no parsed form |
| Device time | `Evidence.deviceTimeIso` | VARCHAR(64), client-supplied |
| GPS at upload | `Evidence.lat/lng/accuracyMeters/locationSource` | Raw float; masked in verify page |
| Capture method | `Evidence.captureMethod` (enum) | Present |
| Identity level | `Evidence.identityLevelSnapshot` (enum) | Present |
| Submitted-by email | `Evidence.submittedByEmail` | Masked on public verify |
| Auth provider | `Evidence.submittedByAuthProvider` | Present |

**What is absent:**
- Parsed browser name/version (only raw UA stored)
- Parsed OS name/version
- Device class (desktop/mobile/tablet)
- Timezone and locale from client
- Capture session duration
- Network context beyond IP
- Device attestation result summary in a reportable field
- A single consolidated `capture_environment` JSON artifact per evidence

#### Verification Package Contents (current)

Confirmed from `services/worker/src/verification-package.ts`:

| File | Status |
|---|---|
| `fingerprint.json` | Present, correct |
| `signature.txt` | Present, correct |
| `timestamp.tsr` | Present (conditional) |
| `opentimestamps-proof.ots` | Present (conditional) |
| `opentimestamps.json` | Present (conditional) |
| `custody.json` | Present |
| `forensic-custody.json` | Present |
| `access-activity.json` | Present |
| `anchor.json` | Present (conditional) |
| `capture-context.json` | Present — GPS/time only; not capture environment |
| `integrity-summary.json` | Present |
| `trust-decision.json` | Present |
| `case-metadata.json` | Present |
| `intelligence/media_intelligence.json` | Present — signals, NOT technical metadata |
| `intelligence/derived_assets_manifest.json` | Present |
| Raw EXIF data | **Missing** |
| Full media technical metadata | **Missing** |
| Capture environment (browser/OS/UA) | **Missing** |
| EXIF summary (reviewer-facing) | **Missing** |
| Parser report | **Missing** |

---

### 1.2 What Is Missing

1. **`technical-metadata/media-metadata-raw.json`** — full deterministic technical facts about the file (dimensions, codec, EXIF fields, etc.)
2. **`technical-metadata/media-metadata-summary.json`** — reviewer-facing summary version
3. **`technical-metadata/exif-summary.json`** — the bounded EXIF summary already extracted by `exif-summary.service.ts` but not included
4. **`technical-metadata/exif-raw.json`** — full raw EXIF fields (package-only)
5. **`technical-metadata/capture-environment.json`** — browser, OS, UA, timezone, locale, capture method
6. **`technical-metadata/parser-report.json`** — structural parse result and metadata completeness verdict
7. A parsed user-agent record stored at upload time
8. Browser/OS/timezone/locale captured and persisted at evidence creation

---

### 1.3 What Is Mislabeled

#### Finding F-001 (P0): `intelligence/media_intelligence.json` is a signal file, not technical metadata

**Location:** `services/worker/src/verification-package-intelligence.ts`

The file named `media_intelligence.json` contains the bounded list of advisory signals from the `media_intelligence_signals` table. These signals include:
- `EXIF_MISSING` — a technical observation
- `DUPLICATE_HASH_MATCH` — workspace correlation finding
- `SIMILAR_FILE_CANDIDATE` — workspace correlation finding
- `CLIENT_SERVER_TIME_GAP` — a capture trust observation
- `MIME_EXTENSION_MISMATCH` — a technical observation

A reviewer opening this file to understand the media's technical properties finds workspace correlation notices instead. The file should be renamed `advisory-signals.json` or kept as-is with the package gaining a separate true technical metadata file.

#### Finding F-002 (P0): Verify Page "Capture Trust" section is mislabeled as current preservation state

**Location:** `services/api/src/services/capture-trust/verify-trust-projection.service.ts`, lines 61–66

The `VerifyTrustProjection` type returned to the Verify Page contains:
```
timeAnchors: {
  rfc3161Applied: boolean;   // ← at CAPTURE time
  otsApplied: boolean;       // ← at CAPTURE time
  otsConfirmations: number | null;
};
countersigned: boolean;       // ← server countersign at CAPTURE time
```

These fields describe what integrity primitives were applied **at the moment of capture/upload** via the capture trust pipeline (device registration, citizen capture, intake links). They come from `CaptureTrustEventRecord`, not from the current OTS/RFC3161 preservation state of the evidence.

The main Verify Page separately surfaces `otsStatus`, `tsaStatus`, `anchorStatus` — the current preservation state. A reviewer reading the Capture Trust section sees `RFC3161 absent` / `OpenTimestamps absent` / `Server-countersigned: no` alongside a main page that says `Bitcoin anchoring verified`. This is because:

- The main page: "Was the file anchored during PROOVRA's preservation pipeline?" → **Yes**
- The capture trust section: "Did the capture *app* apply RFC3161/OTS at the instant of capture?" → **No** (because OTS is applied post-upload by the worker, not by the capture app)

The section is **technically correct** but the **framing is wrong**. Without a label clarifying that this section describes **original capture-time integrity** (not current preservation status), reviewers read it as contradicting the main trust verdict.

#### Finding F-003 (P1): EXIF signals exist but EXIF data does not persist

`exif-extractor.service.ts` reads EXIF at upload time. `exif-summary.service.ts` stores a bounded summary. However:
- The bounded summary field/table is not audited here for exact schema — it may be stored in a `media_intelligence_signals` technical_details_json column only
- Raw EXIF is discarded after signal generation
- No dedicated EXIF storage table or field exists in the Prisma schema
- EXIF signals (`EXIF_MISSING`, `EXIF_TIMESTAMP_MISMATCH`) appear in the advisory signal stream but the underlying camera/device metadata that drove them cannot be recovered

#### Finding F-004 (P1): Capture Environment has no consolidated model

Browser name, OS, device class, timezone, and locale are **never stored** as parsed, structured data. Only the raw user-agent string appears in `CustodyEvent.userAgent` and `CaptureTrustEventRecord.userAgent`. These records are:
- Not designed for reporting
- Not included in the Verification Package
- Not surfaced in the PDF report
- Joined to evidence only via the custody chain, requiring non-trivial traversal

#### Finding F-005 (P1): `capture-context.json` in package contains GPS/location only

The file is named `capture-context.json` but contains only `lat`, `lng`, `accuracyMeters`, `locationSource`. It does not contain browser, OS, UA, timezone, locale, or capture method. The name implies broader capture context than it contains.

#### Finding F-006 (P1): No image dimensions, video codec, or structural parse result stored anywhere

The Prisma schema for `Evidence` and `EvidencePart` contains only `mimeType`, `sizeBytes`, `durationMs`, `sha256`. There is no:
- Image width/height
- Color space
- Video codec (H.264, H.265, VP9, AV1)
- Audio codec
- Frame rate
- Bitrate
- Stream count
- Container format
- Structural parse success/failure
- Metadata completeness verdict

These cannot be recovered post-upload because the original file bytes are in object storage and not routinely read again after the upload hash is verified.

---

### 1.4 Where Concepts Are Currently Mixed

| Concept A | Concept B | Where Mixed | Impact |
|---|---|---|---|
| Original file EXIF capture time | PROOVRA upload timestamp | `Evidence.deviceTimeIso` vs `capturedAtUtc` — separate but not labeled in output | Reviewer confusion |
| Capture-time integrity (what the capture app did) | Preservation-time integrity (what PROOVRA's worker did) | Verify Page "Capture Trust" section | Reviewers read `RFC3161 absent` as a preservation failure |
| Technical file observations (EXIF_MISSING, MIME_EXTENSION_MISMATCH) | Workspace correlation findings (DUPLICATE_HASH_MATCH, SIMILAR_FILE_CANDIDATE) | `media_intelligence_signals` table + `media_intelligence.json` package file | Recipients of package see duplicate detection labeled as "media intelligence" |
| EXIF GPS (from inside the file) | Browser geolocation at upload (from the capture app) | Both stored on `Evidence.lat/lng` under the same fields via `locationSource` enum | Subtle — the locationSource enum disambiguates, but it's easy to miss |
| Signal observations (advisory) | Factual technical metadata (deterministic) | Not mixed yet — but the absence of the factual layer means the signal layer is the only thing reviewers see | Reviewers are making decisions on advisory signals instead of ground-truth metadata |

---

## 2. Required Target Architecture

### Layer 1 — Media Technical Metadata (deterministic, per file/part)

Generated by a file parser at upload-complete time. Read-only. Never AI-derived.

**Inputs:** The uploaded file bytes (re-read from object storage once at completion, or during the worker job).

**For images (JPEG, PNG, WEBP, HEIC, TIFF, etc.):**
- MIME type (confirmed from bytes, not extension)
- File size in bytes
- Image width, height
- Color space (sRGB, AdobeRGB, P3, unknown)
- EXIF presence: yes/no/partial
- Camera make (if EXIF present)
- Camera model (if EXIF present)
- Original capture date/time from EXIF (DateTimeOriginal)
- GPS in EXIF: yes/no (coordinates masked in public outputs)
- Software/editor tag (if present)
- Orientation (EXIF orientation value)
- Compression type
- Thumbnail presence
- Metadata status: PRESENT | PARTIAL | MISSING | CONFLICT

**For videos (MP4, MOV, AVI, MKV, WEBM, etc.):**
- MIME type / container format
- Duration (seconds, ms)
- Width, height
- Video codec
- Audio codec (or absent)
- Frame rate
- Bitrate (total, video, audio)
- Creation time from container metadata
- GPS/location in container metadata: yes/no
- Device/software tags from container
- Stream count
- Structural parse result

**For PDFs/documents:**
- MIME type
- Page count
- PDF producer, PDF creator
- Creation timestamp, modification timestamp
- Embedded metadata presence
- Encryption/signature presence
- Structural parse result

**Storage:** Per-part JSONB column `EvidencePart.technicalMetadata`. For single-file evidence, mirrors to a denormalized `Evidence.technicalMetadata` field.

### Layer 2 — EXIF Summary (reviewer-facing, derived from Layer 1)

A small, pre-computed subset of Layer 1 for display in reports and the Verify Page.

**Fields:**
- Camera Make
- Camera Model
- Original Capture Time (from EXIF, clearly labeled as file-embedded, not server time)
- EXIF GPS present: yes/no (never publish coordinates on public page)
- Resolution (width × height)
- Software/Editor tag (if present)
- Metadata status: PRESENT | PARTIAL | MISSING | CONFLICT

**Appearance:** Only when `mimeType` is image or video and EXIF data was found. Absent for PDFs, audio-only, and files with `EXIF_MISSING` signal.

**Storage:** Derived at report/package build time from `EvidencePart.technicalMetadata`. No separate DB field needed unless caching is required.

### Layer 3 — Capture Environment (recorded at upload time, per evidence/session)

Describes the environment in which the evidence entered PROOVRA.

**Fields to capture at evidence create / intake / upload time:**
- Browser name (parsed from UA)
- Browser version
- Operating system
- OS version
- Device class: DESKTOP | MOBILE | TABLET | SERVER | UNKNOWN
- Timezone (from `Intl.DateTimeFormat().resolvedOptions().timeZone` or from UA/Accept-Language)
- Locale (language tag, e.g. `en-GB`)
- Raw user-agent string (internal/restricted only)
- User-agent hash (SHA-256 of raw UA, safe for package)
- Capture method: SECURE_CAPTURE | UPLOAD | INTAKE_LINK | API | MOBILE_SDK | CITIZEN_CAPTURE
- Upload source: WEB_APP | MOBILE_APP | INTAKE_LINK | API
- IP address: raw in custody event only; hashed or masked in reportable outputs
- IP region/country (GeoIP lookup, anonymized)
- Device attestation attempted: yes/no
- Device attestation result if attempted

**Storage:** New `EvidenceCaptureEnvironment` table or JSONB on `Evidence`. See schema proposal in Section 6.

---

## 3. Audit Findings: Current Media Intelligence Problem (F-001 Extended)

### What `media_intelligence_signals` actually contains

From the SQL drift patch `2026-05-20-media-intelligence-signals.sql`, the `signal_type` enum is bounded to:

```
EXIF_MISSING               — technical observation
EXIF_TIMESTAMP_MISMATCH    — technical observation
CLIENT_SERVER_TIME_GAP     — capture trust observation
MIME_EXTENSION_MISMATCH    — technical observation
CODEC_CONTAINER_OBSERVATION — technical observation
SCREENSHOT_LIKE_FILENAME   — heuristic / advisory
DUPLICATE_HASH_MATCH       — workspace correlation
SIMILAR_FILE_CANDIDATE     — workspace correlation
POSSIBLE_DERIVATIVE_FILE   — workspace correlation
TRANSCODING_LINEAGE_CANDIDATE — workspace correlation
AUDIO_METADATA_OBSERVATION — technical observation
VIDEO_DURATION_OBSERVATION — technical observation
FRAME_EXTRACTION_AVAILABLE — derived asset notice
THUMBNAIL_AVAILABLE        — derived asset notice
OCR_AVAILABLE              — capability notice
TRANSCRIPT_AVAILABLE       — capability notice
```

This is a mix of four conceptually distinct categories in one table:
1. **Technical file observations** — EXIF_MISSING, MIME_EXTENSION_MISMATCH, CODEC_CONTAINER_OBSERVATION, etc.
2. **Workspace/corpus correlation** — DUPLICATE_HASH_MATCH, SIMILAR_FILE_CANDIDATE, POSSIBLE_DERIVATIVE_FILE, TRANSCODING_LINEAGE_CANDIDATE
3. **Capture trust observations** — CLIENT_SERVER_TIME_GAP
4. **Capability notices** — FRAME_EXTRACTION_AVAILABLE, THUMBNAIL_AVAILABLE, OCR_AVAILABLE, TRANSCRIPT_AVAILABLE

All four are currently written into a single `media_intelligence_signals` table and emitted into `intelligence/media_intelligence.json` in the Verification Package. This is the root cause of the package file appearing to contain "duplicate detection findings" — because it does.

### Which service writes it

`packages/shared-runtime/src/media-intelligence/analyzer.service.ts` — the `MediaIntelligenceAnalyzerService`. It emits `MIME_EXTENSION_MISMATCH`, `EXIF_MISSING`, `SCREENSHOT_LIKE_FILENAME`, `CLIENT_SERVER_TIME_GAP`, `DUPLICATE_HASH_MATCH`.

### Which service reads it

`services/api/src/services/media-intelligence/verify-projection.service.ts` — the `projectVerifyMediaIntelligence()` function. It counts non-dismissed signals and returns only a count + fixed disclaimer. It does **not** expose individual signal types to the Verify Page.

### Which builder includes it

`services/worker/src/verification-package-intelligence.ts` — the `buildIntelligencePackageManifests()` function. It serializes the bounded signal list into `intelligence/media_intelligence.json`.

### Is the name wrong?

The name "Media Intelligence" is **appropriate for the signal layer** (advisory observations about the media). The problem is that the file in the package is expected by recipients to be technical metadata, while it is actually advisory signals — and those signals include workspace correlation findings that have nothing to do with the file's own technical properties.

**Recommendation:** Keep the `media_intelligence_signals` table name. Rename the package file from `intelligence/media_intelligence.json` to `intelligence/advisory-signals.json`. Add a new `technical-metadata/` directory with true file metadata.

---

## 4. Audit Findings: Verify Page Capture Trust Problem (F-002 Extended)

### The exact data flow

1. `GET /public/verify/:id` calls `projectVerifyCaptureTrust()` from `verify-trust-projection.service.ts`
2. That function reads `CaptureTrustEventRecord` rows for this evidence
3. It builds a `VerifyTrustProjection` that includes `timeAnchors.rfc3161Applied`, `timeAnchors.otsApplied`, `countersigned`
4. These boolean fields describe whether the **capture-trust pipeline** applied those primitives **at the moment the file was ingested**
5. Separately, the same API endpoint returns `otsStatus`, `tsaStatus`, `anchorStatus` reflecting the **preservation pipeline** state
6. The Verify Page renders both sets of data — the preservation state at the top, the capture trust in a lower section
7. Because the capture app (citizen capture, intake link submission) does not apply RFC3161 or OTS at capture time (those run in the worker post-upload), the capture trust section shows `rfc3161Applied: false`, `otsApplied: false`, `countersigned: false`
8. A reviewer reads this as "this evidence has no timestamping" despite the main section showing anchoring as verified

### Root cause

The Verify Page renders the capture trust section **without a clear temporal label**. The fields mean "at capture time" but are displayed without that qualifier. The fix is presentational — the section needs a heading like "Original Capture Integrity (at time of submission)" and the `rfc3161Applied: false` value should be worded as "RFC3161 was not applied by the capture application — timestamping was applied by PROOVRA's preservation pipeline" rather than just "RFC3161 absent."

No data model changes needed. The wording and section framing need updating.

---

## 5. Proposed Schema / Data Model

### 5.1 New `EvidencePart.technicalMetadata` JSONB column

```prisma
model EvidencePart {
  // ... existing fields ...
  technicalMetadata   Json?   @map("technical_metadata")   // structured Layer 1 output
  technicalMetaParsedAt DateTime? @map("technical_meta_parsed_at") @db.Timestamptz(6)
  technicalMetaParser   String?   @map("technical_meta_parser") @db.VarChar(64) // e.g. "exiftool-12.x", "ffprobe-6.x"
}
```

For single-file evidence, also add a denormalized copy on `Evidence`:

```prisma
model Evidence {
  // ... existing fields ...
  technicalMetadata   Json?   @map("technical_metadata")
  technicalMetaParsedAt DateTime? @map("technical_meta_parsed_at") @db.Timestamptz(6)
}
```

**Placement:** Part-level (per-part). For single-file evidence this is the same as evidence-level. For multipart, each part gets its own technical metadata. A summary aggregate can be computed at report/package build time.

### 5.2 New `EvidenceCaptureEnvironment` table

```prisma
model EvidenceCaptureEnvironment {
  id          String    @id @default(uuid()) @db.Uuid
  evidenceId  String    @unique @map("evidence_id") @db.Uuid
  teamId      String    @map("team_id") @db.Uuid

  // Browser/OS — parsed at capture time from UA
  browserName    String?  @map("browser_name") @db.VarChar(64)
  browserVersion String?  @map("browser_version") @db.VarChar(32)
  osName         String?  @map("os_name") @db.VarChar(64)
  osVersion      String?  @map("os_version") @db.VarChar(32)
  deviceClass    String?  @map("device_class") @db.VarChar(20) // DESKTOP|MOBILE|TABLET|SERVER|UNKNOWN
  
  // Locale / timezone
  timezone  String?  @db.VarChar(64)   // IANA tz, e.g. "Europe/London"
  locale    String?  @db.VarChar(16)   // BCP-47, e.g. "en-GB"
  
  // Upload context
  captureMethod  String?  @map("capture_method") @db.VarChar(32)  // enum mirror
  uploadSource   String?  @map("upload_source") @db.VarChar(32)   // WEB_APP|MOBILE_APP|INTAKE_LINK|API|CITIZEN
  
  // Network — internal use only
  ipAddressRaw   String?  @map("ip_address_raw") @db.VarChar(45)  // RESTRICTED — never in public output
  ipAddressHash  String?  @map("ip_address_hash") @db.VarChar(64) // SHA-256, safe for package
  ipCountry      String?  @map("ip_country") @db.VarChar(2)       // ISO 3166-1 alpha-2
  ipRegion       String?  @map("ip_region") @db.VarChar(64)       // subdivision
  
  // UA — internal use only
  userAgentRaw   String?  @map("user_agent_raw") @db.VarChar(512) // RESTRICTED
  userAgentHash  String?  @map("user_agent_hash") @db.VarChar(64) // SHA-256, safe for package
  
  // Device attestation
  attestationAttempted Boolean  @default(false) @map("attestation_attempted")
  attestationResult    String?  @map("attestation_result") @db.VarChar(32)  // PASS|FAIL|NOT_ATTEMPTED

  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  evidence  Evidence  @relation(fields: [evidenceId], references: [id], onDelete: Cascade)
  team      Team      @relation(fields: [teamId], references: [id], onDelete: Cascade)

  @@map("evidence_capture_environments")
}
```

**Placement:** Evidence-level (one row per evidence). For multipart/intake scenarios, the capture environment is the same across all parts (same upload session).

### 5.3 No changes needed to existing `media_intelligence_signals` table

The signals table is correctly designed. The fix is in how the output is labeled and what new artifacts are added alongside it.

### 5.4 Consider adding `EvidencePart.exifSummary` (optional optimization)

If the EXIF summary needs to survive report regeneration without re-parsing the file, add:

```prisma
model EvidencePart {
  exifSummary       Json?    @map("exif_summary")   // bounded reviewer-facing subset
  exifSummaryParsedAt DateTime? @map("exif_summary_parsed_at") @db.Timestamptz(6)
}
```

Otherwise, derive the EXIF summary from `technicalMetadata` at build time.

---

## 6. Verification Package: Proposed New Files

The ZIP should gain a `technical-metadata/` directory. Existing `intelligence/` files remain but the package file `intelligence/media_intelligence.json` should be **renamed** to `intelligence/advisory-signals.json` (with a backward-compat alias or redirect period).

### New files

#### `technical-metadata/media-metadata-summary.json`

```json
{
  "schemaVersion": "1.0",
  "generatedAtUtc": "ISO-8601",
  "mimeType": "image/jpeg",
  "fileSizeBytes": 4234567,
  "mediaType": "IMAGE",
  "imageDimensions": { "widthPx": 4032, "heightPx": 3024 },
  "colorSpace": "sRGB",
  "exifPresent": true,
  "exifStatus": "PRESENT",
  "cameraModel": "iPhone 14 Pro",
  "cameraMake": "Apple",
  "originalCaptureTime": "2024-11-15T10:22:05Z",
  "gpsInExif": true,
  "softwareTag": null,
  "orientation": 1,
  "thumbnailPresent": true,
  "parserName": "exiftool-12.76",
  "parseResult": "OK"
}
```

- **Purpose:** Reviewer-readable summary of Layer 1 facts  
- **Source:** `EvidencePart.technicalMetadata`  
- **Sensitivity:** Public — no GPS coordinates, no raw UA, no IP  
- **Include:** Always (even if parse failed, include with `parseResult: "FAILED"`)

#### `technical-metadata/media-metadata-raw.json`

Full parser output including all extracted tags, codec details, stream info, container metadata, etc. The raw structured output of `exiftool`/`ffprobe`/PDF parser.

- **Purpose:** Forensic completeness, expert review  
- **Source:** Raw parser output, stripped of binary blobs  
- **Sensitivity:** Internal/restricted — may contain GPS coordinates from EXIF  
- **Include:** Always  
- **Note:** EXIF GPS coordinates appear here; the summary file omits them

#### `technical-metadata/exif-summary.json`

```json
{
  "schemaVersion": "1.0",
  "applicable": true,
  "cameraMake": "Apple",
  "cameraModel": "iPhone 14 Pro",
  "originalCaptureTime": "2024-11-15T10:22:05Z",
  "gpsPresent": true,
  "resolutionPx": "4032x3024",
  "softwareTag": null,
  "metadataStatus": "PRESENT"
}
```

- **Purpose:** Standardized EXIF summary for legal/forensic review  
- **Source:** Derived from `media-metadata-raw.json`  
- **Sensitivity:** Public (no GPS coordinates)  
- **Include:** Only when `applicable: true` (images/videos with EXIF)

#### `technical-metadata/exif-raw.json`

Complete raw EXIF fields as extracted by the parser. Contains GPS coordinates.

- **Purpose:** Full EXIF preservation for expert review  
- **Sensitivity:** **Restricted** — contains GPS if present; do not expose on public verify page  
- **Include:** Always for image/video; absent for PDFs/audio

#### `technical-metadata/capture-environment.json`

```json
{
  "schemaVersion": "1.0",
  "generatedAtUtc": "ISO-8601",
  "uploadSource": "WEB_APP",
  "captureMethod": "SECURE_CAPTURE",
  "browserName": "Chrome",
  "browserVersion": "120.0",
  "osName": "Windows",
  "osVersion": "11",
  "deviceClass": "DESKTOP",
  "timezone": "Europe/London",
  "locale": "en-GB",
  "ipCountry": "GB",
  "ipRegion": "England",
  "userAgentHash": "sha256:abc123...",
  "attestationAttempted": true,
  "attestationResult": "NOT_ATTEMPTED",
  "advisory": "Raw IP address and full user-agent are retained in restricted custody records and are not included in this package."
}
```

- **Purpose:** Capture environment facts for forensic provenance  
- **Sensitivity:** Semi-public — no raw IP, no raw UA, no GPS  
- **Include:** Always

#### `technical-metadata/parser-report.json`

```json
{
  "schemaVersion": "1.0",
  "parsedAtUtc": "ISO-8601",
  "parserName": "exiftool",
  "parserVersion": "12.76",
  "parseSuccess": true,
  "warnings": [],
  "metadataCompleteness": "PRESENT",
  "inconsistencies": []
}
```

- **Purpose:** Audit trail of the parsing process itself  
- **Sensitivity:** Public  
- **Include:** Always

#### `technical-metadata/README.md`

Human-readable explanation of what each file in this directory means, the difference between EXIF (file-embedded) and capture environment (PROOVRA-recorded), and privacy notes.

- **Sensitivity:** Public  
- **Include:** Always

---

## 7. PDF Report Integration Proposal

**Add one new compact section between "Forensic Integrity Statement" and "Advisory Observations":**

### Section: Media Technical Summary

```
MEDIA TECHNICAL SUMMARY

File type:       JPEG image
File size:       4.2 MB
Dimensions:      4032 × 3024 px
Colour space:    sRGB
Metadata:        EXIF present

EXIF SUMMARY (from file-embedded metadata)
Camera:          Apple iPhone 14 Pro
Captured:        15 November 2024, 10:22 UTC  ← from EXIF DateTimeOriginal
GPS in EXIF:     Yes (coordinates withheld from this report)
Software tag:    Not present
Metadata status: Complete

CAPTURE ENVIRONMENT (recorded by PROOVRA at submission)
Submitted via:   PROOVRA web application
Browser:         Chrome 120 / Windows 11
Device class:    Desktop
Timezone:        Europe/London
Capture method:  Secure capture
```

**Rules:**
- Do not dump raw EXIF
- Do not show full IP address
- Do not show full user-agent string
- Do not show GPS coordinates — say "Yes (coordinates withheld)" or "Not present"
- If EXIF is absent, show "Metadata: Not present in file"
- If parse failed, show "Technical metadata: Could not be extracted"
- Section is omitted entirely if all fields are null/unavailable
- EXIF Summary sub-section only appears for image/video

---

## 8. Verify Page Integration Proposal

### Current structure problem

The Verify Page currently has:
- Main trust verdict (correct, stays at top)
- Evidence preview (correct)
- Capture Trust section — `rfc3161Applied`, `otsApplied`, `countersigned` without temporal context
- Media Intelligence Advisory — observation count + disclaimer

### Proposed new structure

```
[TRUST VERDICT]  ← unchanged, stays first

[EVIDENCE PREVIEW] ← unchanged

[TECHNICAL DETAILS] ← new section, below preview
  Tabs: Media | EXIF | Capture Environment | Integrity Timeline

  Media tab:
    File type, size, dimensions (if image), duration (if video)
    Metadata status: PRESENT / PARTIAL / MISSING
    Parser result: OK / FAILED

  EXIF tab:
    Camera make/model
    Original capture time (labeled: "from file-embedded metadata")
    GPS present: yes/no (no coordinates)
    Software tag
    Metadata status
    Only shown for image/video; hidden for PDF/audio

  Capture Environment tab:
    Submitted via: Web app / Mobile / Intake link / API
    Browser & OS (parsed)
    Device class
    Timezone at submission
    Capture method

  Integrity Timeline tab:
    This is where the CURRENT "Capture Trust" section moves
    Timeline of events with clear temporal labels:
      "At submission: [what the capture app did]"
      "Post-submission (PROOVRA worker): [what PROOVRA did — OTS, TSA, Bitcoin]"
    Replaces: rfc3161Applied: false with "RFC3161 not applied by capture app"
    Adds: "Trusted timestamp applied by PROOVRA 2 minutes after submission"

[ADVISORY OBSERVATIONS] ← existing Media Intelligence advisory, renamed
  "N advisory observations generated — see Technical Details for context"
```

**Rules:**
- GPS coordinates never appear on the public Verify Page
- Raw IP never appears
- Raw user-agent never appears
- Capture Trust items labeled with "at submission" vs "post-submission" to prevent confusion
- Replace boolean `rfc3161Applied: false` with a human sentence
- Replace `countersigned: false` with "Server countersignature: not recorded at capture time"

---

## 9. Privacy and Legal Safety Recommendations

| Data Element | Public Verify Page | PDF Report | Verification Package | Internal App |
|---|---|---|---|---|
| EXIF GPS coordinates | Never | Never | `exif-raw.json` only (restricted) | Admin/owner only |
| Camera make/model | Yes | Yes | Yes (summary + raw) | Yes |
| Original EXIF capture time | Yes | Yes | Yes | Yes |
| IP address (raw) | Never | Never | Never | Internal audit only |
| IP address (hash) | No | No | `capture-environment.json` | Restricted |
| IP country/region | No | No | `capture-environment.json` | Yes |
| User-agent (raw) | Never | Never | Never | Internal audit only |
| User-agent (hash) | No | No | `capture-environment.json` | Restricted |
| Browser name/version | Yes | Yes | Yes | Yes |
| OS name/version | Yes | Yes | Yes | Yes |
| Submitter email | No | No | No | Owner/admin only |
| Submitter auth provider | No | No | No | Owner/admin only |
| Capture method | Yes | Yes | Yes | Yes |
| Timezone at submission | Yes | Yes | Yes | Yes |
| Locale | No | No | `capture-environment.json` | Yes |

**GDPR notes:**
- Raw IP address is personal data under GDPR. It must not appear in any externally shared artifact (package, report). Store with appropriate retention limits.
- User-agent can be quasi-identifying in combination. Same handling as IP.
- EXIF GPS coordinates pinpoint a location and are personal data when linked to a person. Never expose in public outputs. The `exif-raw.json` in the package is restricted.
- Intake-link submissions are from third parties. Their IP/UA must be treated with the same protections as internal users.
- For the Verification Package, which can be shared with courts/counsel, the recommended approach is to ship `capture-environment.json` with hashed/anonymized IP and UA, not raw values.

---

## 10. Internal App Integration Recommendations

| Surface | Recommended Change |
|---|---|
| **Evidence Detail page** | Add "Technical Metadata" tab alongside existing tabs; show media summary, EXIF summary, capture environment |
| **Capture page** | Optionally show user what metadata the browser reported at capture time (browser, timezone, GPS if granted) |
| **Intake link submission page** | No change to submitter-facing UI; capture environment recorded silently |
| **Reports page** | No change to report list; new section appears in PDF |
| **Verify page** | Add Technical Details section as described in Section 8 |
| **Team/Workspace settings** | Add "Technical Metadata" toggle: control whether EXIF GPS appears in package for team's evidence |
| **Privacy/Governance settings** | Add controls: IP retention period, UA retention period, whether capture environment appears in shareable package |

---

## 11. Enterprise Naming Recommendations

| Current Name | Problem | Recommended Name |
|---|---|---|
| "Media Intelligence" (section in report/package) | Correct for the signal layer — keep it | "Advisory Observations" in report; "advisory-signals.json" in package |
| `media_intelligence.json` (package file) | Recipients expect technical metadata, get signals + duplicate detection | Rename to `advisory-signals.json` |
| "Media Intelligence" (Verify Page section) | Shows observation count only — acceptable if renamed | "Advisory Observations" |
| "Capture Trust" (Verify Page section) | Not wrong, but temporal scope unclear | "Capture Integrity (at submission time)" |
| *(absent)* | No name for file technical facts | "Media Technical Metadata" or "Technical File Summary" |
| *(absent)* | No name for parsed browser/OS/UA context | "Capture Environment" |
| "EXIF Summary" | Clear and professional | Keep — "EXIF Summary (file-embedded metadata)" in public contexts |
| "Original Capture Provenance" | Not used yet | Use for the capture trust timeline section |
| "Current Preservation Verification" | Not used yet | Use for OTS/RFC3161/Bitcoin anchoring state |

---

## 12. Implementation Plan

### Phase A — Data Model (prerequisite)

**Files to change:**
- `services/api/prisma/schema.prisma` — add `EvidencePart.technicalMetadata`, `EvidencePart.technicalMetaParsedAt`, `EvidencePart.technicalMetaParser`, `Evidence.technicalMetadata`, new `EvidenceCaptureEnvironment` model, optionally `EvidencePart.exifSummary`
- New migration file in `services/api/prisma/migrations/`

**Risks:** Migration on large tables (`EvidencePart`) — must be additive-only (nullable columns). No backfill required at migration time.

**Tests to add:** Schema contract tests verifying new fields exist and are nullable.

**Acceptance criteria:** Migration runs cleanly; existing evidence records unaffected; new nullable columns present.

---

### Phase B — Parsers and Extraction Pipeline

**Files to change/create:**
- `services/worker/src/parsers/image-metadata-parser.ts` — ExifTool wrapper or `exifr` library integration; outputs `TechnicalMetadata` schema
- `services/worker/src/parsers/video-metadata-parser.ts` — ffprobe wrapper; outputs `TechnicalMetadata` schema
- `services/worker/src/parsers/pdf-metadata-parser.ts` — pdf-parse or pdfjs wrapper
- `services/worker/src/parsers/technical-metadata.schema.ts` — Zod schema for `TechnicalMetadata` type
- `services/worker/src/jobs/parse-technical-metadata.job.ts` — worker job triggered after `evidence-complete`; reads file from object storage, runs appropriate parser, writes to `EvidencePart.technicalMetadata`
- `services/api/src/services/capture-environment/capture-environment.service.ts` — UA parser service (using `ua-parser-js` or similar); writes `EvidenceCaptureEnvironment` row at evidence create

**Risks:**
- ExifTool/ffprobe are native binaries — must be bundled in Docker image or called via subprocess; potential timeout risk for large videos
- Re-reading file from object storage adds latency and S3 egress cost — batch with existing post-upload jobs
- UA parsing libraries may misclassify bots/automated uploaders

**Tests to add:**
- Unit tests for each parser with known-good test files (JPEG with EXIF, JPEG without, MP4, PDF)
- Unit tests for UA parsing service
- Integration test: upload evidence → job runs → `technicalMetadata` field populated

**Acceptance criteria:**
- Images: width, height, EXIF presence, camera make/model extracted for JPEG/PNG/HEIC test files
- Videos: duration, codec, frame rate extracted for MP4/MOV test files
- PDFs: page count, producer extracted for test PDF
- Files with no metadata: `exifStatus: "MISSING"` returned, no crash
- UA parsing: Chrome/Windows/Mac/iOS/Android correctly classified

---

### Phase C — Storage and Snapshots

**Files to change:**
- `services/api/src/routes/evidence.routes.ts` — capture `userAgent`, `timezone`, `locale`, `deviceClass` at `POST /v1/evidence` and write `EvidenceCaptureEnvironment`
- `services/api/src/routes/capture-trust.routes.ts` — same for capture trust ingest path
- `services/api/src/routes/citizen-capture.routes.ts` — same for citizen capture path
- `services/api/src/routes/intake-link.routes.ts` (if exists) — capture submitter UA/timezone for intake submissions

**Risks:**
- Client must send timezone and locale — requires frontend change to pass `Intl.DateTimeFormat().resolvedOptions().timeZone` in the create-evidence request body
- IP address capture: Fastify already provides `request.ip`; ensure the value is the real client IP behind any reverse proxy (check `trust proxy` setting)

**Tests to add:**
- Test that `EvidenceCaptureEnvironment` is created with correct fields when evidence is created
- Test that raw IP is not exposed in any serialized output from API routes

**Acceptance criteria:**
- `EvidenceCaptureEnvironment` row exists for all newly created evidence
- Parsed browser/OS/deviceClass populated for web-app uploads
- `ipAddressRaw` not serialized in any public-facing API response

---

### Phase D — Verification Package Files

**Files to change:**
- `services/worker/src/verification-package.ts` — add `technical-metadata/` directory generation; add 6 new files; rename `intelligence/media_intelligence.json` to `intelligence/advisory-signals.json` (keep old filename as alias or add README note about rename)
- `services/worker/src/verification-package-intelligence.ts` — update to write `advisory-signals.json`

**New builder functions needed:**
- `buildTechnicalMetadataSummary(evidence, parts)` → `technical-metadata/media-metadata-summary.json`
- `buildTechnicalMetadataRaw(evidence, parts)` → `technical-metadata/media-metadata-raw.json`
- `buildExifSummary(evidence, parts)` → `technical-metadata/exif-summary.json`
- `buildExifRaw(evidence, parts)` → `technical-metadata/exif-raw.json`
- `buildCaptureEnvironment(evidence)` → `technical-metadata/capture-environment.json`
- `buildParserReport(evidence, parts)` → `technical-metadata/parser-report.json`

**Risks:**
- Package size increase — 6 new files, but all small JSON; negligible
- Backward compatibility — `media_intelligence.json` consumers must be notified of rename; add a `technical-metadata/README.md` noting the advisory-signals.json filename

**Tests to add:**
- Snapshot test: package ZIP for a known evidence contains all 6 new files
- Test `exif-raw.json` is absent for audio-only evidence
- Test `capture-environment.json` excludes raw IP and raw UA

**Acceptance criteria:**
- All 6 new files present in package for a test image evidence
- `advisory-signals.json` present; `media_intelligence.json` deprecated with comment in README
- `exif-raw.json` absent for non-image/video evidence
- Package manifest SHA checksums include new files

---

### Phase E — PDF Report Integration

**Files to change:**
- `services/worker/src/report-v2/sections/technical-summary.ts` — new section file
- `services/worker/src/report-v2/index.ts` — import and insert new section after "Forensic Integrity Statement"
- `services/worker/src/report-v2/view-model.ts` — add `technicalSummary` and `captureEnvironment` fields to `ReportViewModel`
- `services/worker/src/report-v2/view-model-builder.ts` — populate new VM fields from `EvidencePart.technicalMetadata` and `EvidenceCaptureEnvironment`

**Risks:**
- PDF page count increase — one compact page per evidence; acceptable
- Font/layout: ensure narrow table layout for EXIF summary fits on page

**Tests to add:**
- Snapshot test: PDF rendered bytes contain "Media Technical Summary" text
- Test: EXIF summary section absent when `exifStatus: "MISSING"`

**Acceptance criteria:**
- PDF contains compact Technical Summary section
- EXIF sub-section appears for images with EXIF, absent for images without
- Capture Environment sub-section appears for all evidence
- No raw IP, no raw UA, no GPS coordinates in PDF

---

### Phase F — Verify Page Integration

**Files to change:**
- `services/api/src/routes/evidence.routes.ts` — `GET /public/verify/:id` response builder: add `technicalMetadataSummary` and `captureEnvironment` fields; update `captureTrust` field naming/framing
- `services/api/src/services/capture-trust/verify-trust-projection.service.ts` — add temporal context fields (`timeAnchorsContext: "AT_CAPTURE_TIME"`)
- `apps/web/app/verify/[token]/page.tsx` — add Technical Details section with tabs; update Capture Trust section heading and field labels
- `apps/web/app/verify/[token]/components/` — new `TechnicalDetails.tsx`, `ExifSummary.tsx`, `CaptureEnvironment.tsx` components

**Risks:**
- Frontend bundle size increase
- SEO impact if new content appears above the fold — keep trust verdict and preview above the fold, technical details below

**Tests to add:**
- E2E test: Verify Page renders "Technical Details" section for known evidence
- Unit test: `countersigned: false` renders as "Server countersignature: not recorded at capture time" (not "countersigned: false")
- Unit test: Capture Trust section heading is "Capture Integrity (at submission time)"

**Acceptance criteria:**
- Technical Details section visible on Verify Page
- Tabs: Media, EXIF, Capture Environment, Integrity Timeline
- Capture Trust temporal framing correct — no more "RFC3161 absent" without context
- GPS never appears on Verify Page
- Raw UA never appears on Verify Page

---

### Phase G — Internal App Surfaces and Tests

**Files to change:**
- `apps/web/app/evidence/[id]/` — Evidence Detail page: add Technical Metadata tab
- `apps/web/app/evidence/[id]/components/` — new `TechnicalMetadataTab.tsx`
- `services/api/src/routes/evidence.routes.ts` — internal `GET /v1/evidence/:id` response: include `technicalMetadata`, `captureEnvironment`

**Tests to add:**
- Integration test: `GET /v1/evidence/:id` returns `technicalMetadata` for image evidence
- Component test: Technical Metadata tab renders EXIF camera info

**Acceptance criteria:**
- Evidence Detail shows technical metadata for images, videos, PDFs
- Internal app shows capture environment with full browser/OS detail (but not raw IP in default view)
- Admin view can show raw IP with explicit permission gate

---

## 13. Exact Next Implementation Prompt (Phase B)

> **PROOVRA Phase B — Technical Metadata Parsers**
>
> Implement the technical metadata extraction pipeline. This is a new background worker job triggered after evidence upload completion.
>
> **Goal:** For every newly completed evidence, extract deterministic technical file metadata and store it in `EvidencePart.technicalMetadata` (JSONB). The Phase A migration adding this column has already run.
>
> **Schema already added (Phase A):**
> - `EvidencePart.technicalMetadata Json?` — structured output per part
> - `EvidencePart.technicalMetaParsedAt DateTime?`
> - `EvidencePart.technicalMetaParser String?`
> - `Evidence.technicalMetadata Json?` — denormalized summary for single-file evidence
>
> **Create these files:**
>
> 1. `packages/shared-runtime/src/technical-metadata/schema.ts`
>    — Zod schema defining `TechnicalMetadata` union type covering ImageMetadata, VideoMetadata, AudioMetadata, PdfMetadata, GenericMetadata. Include all fields listed in the audit (dimensions, codec, EXIF fields, etc.). Include `parseResult: "OK" | "FAILED" | "UNSUPPORTED"` and `parserName`, `parserVersion`.
>
> 2. `services/worker/src/parsers/image-metadata-parser.ts`
>    — Uses `exifr` (already a browser-safe EXIF library — verify it works in Node) or shells out to ExifTool if available. Extracts: MIME (confirmed), width, height, colorSpace, EXIF presence, cameraMake, cameraModel, originalCaptureTime (DateTimeOriginal), gpsPresent (boolean only — do not store coordinates in summary), softwareTag, orientation, thumbnailPresent, compressionType. Returns `ImageMetadata`.
>
> 3. `services/worker/src/parsers/video-metadata-parser.ts`
>    — Shells out to `ffprobe` (which must be available in the worker Docker image). Extracts: container format, duration, width, height, videoCodec, audioCodec, frameRate, bitrate, creationTime, gpsPresent, deviceTag, streamCount. Returns `VideoMetadata`.
>
> 4. `services/worker/src/parsers/pdf-metadata-parser.ts`
>    — Uses `pdf-parse` or similar. Extracts: pageCount, producer, creator, creationDate, modificationDate, encryptionPresent, signaturePresent. Returns `PdfMetadata`.
>
> 5. `services/worker/src/parsers/dispatch-parser.ts`
>    — Selects correct parser based on `mimeType`. Returns `TechnicalMetadata | null` for unsupported types.
>
> 6. `services/worker/src/jobs/parse-technical-metadata.job.ts`
>    — Bull/BullMQ job. Inputs: `evidenceId`. Reads `EvidencePart[]` for the evidence. For each part, downloads the file from object storage, runs `dispatch-parser`, writes result to `EvidencePart.technicalMetadata`. For single-part evidence, also writes to `Evidence.technicalMetadata`. Handles parse failures gracefully (writes `{ parseResult: "FAILED", error: "..." }` instead of crashing).
>
> **Enqueue the job:**
> In `services/api/src/routes/evidence.routes.ts` at `POST /v1/evidence/:id/complete`, after the existing evidence-complete jobs are enqueued, also enqueue `parse-technical-metadata` job for the evidence ID.
>
> **Tests:**
> - Unit tests for each parser with fixture files in `services/worker/src/parsers/__fixtures__/`: `test.jpg` (with EXIF), `no-exif.jpg`, `test.mp4`, `test.pdf`
> - Integration test for the job: mock object storage download, assert `EvidencePart.technicalMetadata` is written with correct shape
> - Test that `gpsPresent: true` is set when EXIF has GPS, but no coordinates appear in the output
> - Test that `parseResult: "FAILED"` is written when the file is corrupt/unreadable, not an exception
>
> **Do not change:** Any existing report builder, package builder, or verify page — those come in Phase D/E/F. This phase is storage only.

---

## Appendix: Finding Reference Table

| ID | Severity | Description | File / Location |
|---|---|---|---|
| F-001 | P0 | `media_intelligence.json` in package is signals, not technical metadata | `services/worker/src/verification-package-intelligence.ts` |
| F-002 | P0 | Verify Page Capture Trust section lacks temporal label — shows `rfc3161Applied: false` without "at capture time" context | `services/api/src/services/capture-trust/verify-trust-projection.service.ts:61–66` |
| F-003 | P0 | EXIF data discarded after signal generation; no raw EXIF stored; no EXIF in package | `services/api/src/services/media-intelligence/exif-extractor.service.ts` |
| F-004 | P0 | No image dimensions, video codec, or structural parse result in schema | `services/api/prisma/schema.prisma` — EvidencePart missing technicalMetadata |
| F-005 | P0 | No consolidated `EvidenceCaptureEnvironment` model | `services/api/prisma/schema.prisma` — missing table |
| F-006 | P0 | `capture-context.json` in package is GPS/time only; name implies broader capture context | `services/worker/src/verification-package.ts:3222–3230` |
| F-007 | P1 | Browser/OS/UA stored as raw string in custody/trust events, not as parsed structured data | `services/api/prisma/schema.prisma:565, 757, 2013` |
| F-008 | P1 | Timezone and locale never captured at upload time | evidence.routes.ts create endpoint |
| F-009 | P1 | EXIF summary service exists but output not included in package or report | `services/api/src/services/media-intelligence/exif-summary.service.ts` |
| F-010 | P1 | `DUPLICATE_HASH_MATCH` and `SIMILAR_FILE_CANDIDATE` signals mixed into `media_intelligence.json` | `packages/shared-runtime/src/media-intelligence/analyzer.service.ts` |
| F-011 | P1 | `EvidencePart.clientSignals` is unvalidated client-supplied JSON, not server-determined metadata | `schema.prisma:366` |
| F-012 | P1 | Raw IP address stored in multiple models with no consistent retention/masking policy | `CustodyEvent`, `CaptureTrustEventRecord`, `IntakeLinkSubmission` |
| F-013 | P1 | No `technical-metadata/` directory in Verification Package | `verification-package.ts` |
| F-014 | P1 | PDF report has no Media Technical Summary section | `report-v2/sections/` — section absent |
| F-015 | P2 | `MediaIntelligenceRecord` model (AI provider signals) is distinct from `media_intelligence_signals` table (deterministic signals) but both relate to "media intelligence" — naming confusion | `schema.prisma:10587–10620` |
| F-016 | P2 | `MediaIntelligenceEntity` linked to AI records; not related to technical metadata; naming overlaps with "media intelligence" label | `schema.prisma:10622–10640` |
| F-017 | P2 | `clientSignals` JSON field on EvidencePart could smuggle false technical metadata from a compromised client | `schema.prisma:366` |
| F-018 | P2 | Verify Page shows `observationCount` from advisory signals but no breakdown by category (technical vs workspace correlation) | `verify-projection.service.ts` |
| F-019 | P2 | EXIF GPS and upload GPS are the same fields (`Evidence.lat/lng`) — the `locationSource` enum disambiguates but this is subtle and easy to misuse in queries | `schema.prisma:76–103` |
| F-020 | P2 | No `parser-report.json` in package — recipients cannot verify that the technical metadata was successfully extracted vs defaulted | — |
| F-021 | P2 | Package `intelligence/media_intelligence.json` contains workspace signals (`DUPLICATE_HASH_MATCH`) that are only meaningful within the workspace context — including them in a package shared outside the workspace leaks internal corpus correlation data | `verification-package-intelligence.ts` |
| F-022 | P2 | Advisory observation count on Verify Page (`observationCount`) is capped at 99 — a large count is opaque to the reviewer | `verify-projection.service.ts` |
| F-023 | P2 | `capture-context.json` in package does not include capture method or upload source | `verification-package.ts:3222–3230` |
| F-024 | P2 | No EXIF raw file in package; forensic experts cannot independently verify the camera/device metadata | — |
| F-025 | P3 | Verify Page Capture Trust section uses boolean field names (`rfc3161Applied`, `countersigned`) in JSON that may be read by automated tools expecting plain-English values | `verify-trust-projection.service.ts:50–75` |
| F-026 | P3 | Package `README.txt` does not explain the difference between `capture-context.json` (GPS/time from the capture app) and EXIF metadata (from the file itself) | `verification-package.ts:3320–3346` |
| F-027 | P3 | No package file explains the advisory signal categories (technical vs workspace vs capability) | — |
| F-028 | P3 | PDF report `media-intelligence.ts` section renders up to 200 signals but cannot distinguish a technical observation from a workspace correlation finding — all are presented as one list | `report-v2/sections/media-intelligence.ts:42` |
