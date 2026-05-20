/**
 * Phase 31 — Media intelligence signal catalog + safe wording.
 *
 * Bounded vocabulary + bounded operator-facing labels for every
 * signal type. The wording is the legal contract: it MUST stay
 * advisory, MUST NOT claim truth/authenticity/admissibility, and
 * MUST NOT describe manipulation as fact.
 *
 * Allowed wording verbs: "observed", "may indicate", "review
 * recommended", "advisory", "candidate", "appears to".
 *
 * Forbidden wording (enforced by source-contract test): "tampered",
 * "tampering", "forged", "forgery", "fake", "authentic",
 * "manipulated", "doctored", "admissible", "proof of", "confirms",
 * "proves", "demonstrates that", "verified as real", "identity
 * confirmed".
 *
 * Pure module. No DB / no fetch / no side effects. Safe to import
 * from tests + the analyzer + any future report-v2 wiring.
 */

// =============================================================================
// Bounded catalogs
// =============================================================================

export const MEDIA_INTELLIGENCE_SIGNAL_TYPES = [
  "EXIF_MISSING",
  "EXIF_TIMESTAMP_MISMATCH",
  "CLIENT_SERVER_TIME_GAP",
  "MIME_EXTENSION_MISMATCH",
  "CODEC_CONTAINER_OBSERVATION",
  "SCREENSHOT_LIKE_FILENAME",
  "DUPLICATE_HASH_MATCH",
  "SIMILAR_FILE_CANDIDATE",
  "POSSIBLE_DERIVATIVE_FILE",
  "TRANSCODING_LINEAGE_CANDIDATE",
  "AUDIO_METADATA_OBSERVATION",
  "VIDEO_DURATION_OBSERVATION",
  "FRAME_EXTRACTION_AVAILABLE",
  "THUMBNAIL_AVAILABLE",
  "OCR_AVAILABLE",
  "TRANSCRIPT_AVAILABLE",
  // Phase 31.8 — device + dimensions observation surfaced by the
  // real EXIF extractor. NEVER classifies the device; only reports
  // which bounded metadata fields were recorded.
  "DEVICE_METADATA_OBSERVATION",
  // Phase 31.20 — indexing-completion markers. Distinct from the
  // _AVAILABLE pair so ops can see whether the search projection
  // has caught up with the source rows in evidence_ocr_text /
  // evidence_transcript_segments.
  "OCR_INDEXED",
  "TRANSCRIPT_INDEXED",
] as const;

export type MediaIntelligenceSignalType =
  (typeof MEDIA_INTELLIGENCE_SIGNAL_TYPES)[number];

export const MEDIA_INTELLIGENCE_SEVERITIES = [
  "INFO",
  "REVIEW_RECOMMENDED",
  "ATTENTION",
] as const;

export type MediaIntelligenceSeverity =
  (typeof MEDIA_INTELLIGENCE_SEVERITIES)[number];

export const MEDIA_INTELLIGENCE_CONFIDENCES = [
  "LOW",
  "MEDIUM",
  "HIGH",
] as const;

export type MediaIntelligenceConfidence =
  (typeof MEDIA_INTELLIGENCE_CONFIDENCES)[number];

export const MEDIA_INTELLIGENCE_STATUSES = [
  "PENDING",
  "ACKNOWLEDGED",
  "DISMISSED",
] as const;

export type MediaIntelligenceStatus =
  (typeof MEDIA_INTELLIGENCE_STATUSES)[number];

// =============================================================================
// Signal metadata catalog
// =============================================================================

export type SignalMetadata = {
  /** Default severity when the analyzer emits this signal. Callers
   *  may override based on context — but only within the bounded
   *  catalog. */
  defaultSeverity: MediaIntelligenceSeverity;
  /** Default confidence. */
  defaultConfidence: MediaIntelligenceConfidence;
  /** Operator-facing display label. Used as the column header /
   *  pill label in the UI. Bounded — never includes evidence-
   *  specific data. */
  displayLabel: string;
  /** Whether this signal type is currently implemented by the
   *  Phase 31 deterministic analyzer. Catalog-only entries return
   *  false; the read API surfaces them as known categories the
   *  future async worker will fill in. */
  implemented: boolean;
};

export const SIGNAL_METADATA: Readonly<
  Record<MediaIntelligenceSignalType, SignalMetadata>
> = {
  EXIF_MISSING: {
    defaultSeverity: "INFO",
    defaultConfidence: "MEDIUM",
    displayLabel: "EXIF metadata not observed",
    implemented: true,
  },
  EXIF_TIMESTAMP_MISMATCH: {
    defaultSeverity: "REVIEW_RECOMMENDED",
    defaultConfidence: "LOW",
    displayLabel: "EXIF timestamp differs from capture metadata",
    // Phase 31.8 — implemented via the real exifr-backed extractor
    // (`exif-extractor.service.ts`) + worker job (`extract_exif`).
    // The analyzer reads the persisted bounded summary and emits
    // this signal when DateTimeOriginal disagrees with the server
    // upload time by ≥ 1 hour.
    implemented: true,
  },
  CLIENT_SERVER_TIME_GAP: {
    defaultSeverity: "INFO",
    defaultConfidence: "MEDIUM",
    displayLabel: "Client-observed time differs from server receipt time",
    implemented: true,
  },
  MIME_EXTENSION_MISMATCH: {
    defaultSeverity: "REVIEW_RECOMMENDED",
    defaultConfidence: "MEDIUM",
    displayLabel: "File extension does not match observed MIME type",
    implemented: true,
  },
  CODEC_CONTAINER_OBSERVATION: {
    defaultSeverity: "INFO",
    defaultConfidence: "LOW",
    displayLabel: "Codec or container observation available",
    implemented: false, // requires ffprobe — deferred
  },
  SCREENSHOT_LIKE_FILENAME: {
    defaultSeverity: "INFO",
    defaultConfidence: "MEDIUM",
    displayLabel: "Filename suggests screenshot capture",
    implemented: true,
  },
  DUPLICATE_HASH_MATCH: {
    defaultSeverity: "REVIEW_RECOMMENDED",
    defaultConfidence: "HIGH",
    displayLabel: "Exact byte-identical material observed in workspace",
    implemented: true,
  },
  SIMILAR_FILE_CANDIDATE: {
    defaultSeverity: "INFO",
    defaultConfidence: "LOW",
    displayLabel: "Candidate similar file",
    // Phase 31.5 — implemented via deterministic same-filename+size
    // heuristic. Perceptual hashing remains deferred.
    implemented: true,
  },
  POSSIBLE_DERIVATIVE_FILE: {
    defaultSeverity: "INFO",
    defaultConfidence: "LOW",
    displayLabel: "Candidate derivative file",
    implemented: false,
  },
  TRANSCODING_LINEAGE_CANDIDATE: {
    defaultSeverity: "INFO",
    defaultConfidence: "LOW",
    displayLabel: "Candidate transcoded lineage",
    implemented: false,
  },
  AUDIO_METADATA_OBSERVATION: {
    defaultSeverity: "INFO",
    defaultConfidence: "MEDIUM",
    displayLabel: "Audio material observation available",
    // Phase 31.5 — implemented via MIME-family detection (no
    // ffprobe required). Codec-level observations stay deferred.
    implemented: true,
  },
  VIDEO_DURATION_OBSERVATION: {
    defaultSeverity: "INFO",
    defaultConfidence: "MEDIUM",
    displayLabel: "Video duration observation available",
    // Phase 31.5 — implemented via existing clientSignals.durationMs.
    // Server-side ffprobe verification remains deferred.
    implemented: true,
  },
  FRAME_EXTRACTION_AVAILABLE: {
    defaultSeverity: "INFO",
    defaultConfidence: "HIGH",
    displayLabel: "Representative frame available",
    implemented: false,
  },
  THUMBNAIL_AVAILABLE: {
    defaultSeverity: "INFO",
    defaultConfidence: "HIGH",
    displayLabel: "Thumbnail available",
    implemented: false,
  },
  OCR_AVAILABLE: {
    defaultSeverity: "INFO",
    defaultConfidence: "HIGH",
    displayLabel: "OCR text available",
    implemented: true,
  },
  TRANSCRIPT_AVAILABLE: {
    defaultSeverity: "INFO",
    defaultConfidence: "HIGH",
    displayLabel: "Transcript available",
    implemented: true,
  },
  DEVICE_METADATA_OBSERVATION: {
    defaultSeverity: "INFO",
    defaultConfidence: "MEDIUM",
    displayLabel: "Device metadata observed",
    // Phase 31.8 — implemented via the real EXIF extractor. Reports
    // the bounded device fields the extractor recorded (camera make/
    // model/software/dimensions). NEVER classifies the device; the
    // signal is informational.
    implemented: true,
  },
  // Phase 31.20 — indexing-completion markers. Emitted by the OCR/
  // transcript indexing producer when at least one row with
  // `indexed_at_utc IS NOT NULL` exists for the evidence.
  OCR_INDEXED: {
    defaultSeverity: "INFO",
    defaultConfidence: "HIGH",
    displayLabel: "OCR text indexed for search",
    implemented: true,
  },
  TRANSCRIPT_INDEXED: {
    defaultSeverity: "INFO",
    defaultConfidence: "HIGH",
    displayLabel: "Transcript indexed for search",
    implemented: true,
  },
};

// =============================================================================
// Safe wording library
// =============================================================================
//
// Every operator-facing summary the analyzer emits comes from this
// library. The wording is deliberately conservative. Forbidden
// phrases ("tampered", "forged", "fake", "authentic", "admissible",
// "manipulated", "proof", "confirms", "demonstrates that") never
// appear here — source-contract test enforces this.

export type SafeWordingInput =
  | { type: "EXIF_MISSING" }
  | { type: "CLIENT_SERVER_TIME_GAP"; gapSeconds: number }
  | { type: "MIME_EXTENSION_MISMATCH"; extension: string; mimeType: string }
  | { type: "SCREENSHOT_LIKE_FILENAME" }
  | { type: "DUPLICATE_HASH_MATCH"; otherMaterialCount: number }
  | { type: "OCR_AVAILABLE" }
  | { type: "TRANSCRIPT_AVAILABLE" }
  // Phase 31.20 — indexing-completion safe wordings.
  | { type: "OCR_INDEXED"; chunkCount: number }
  | { type: "TRANSCRIPT_INDEXED"; segmentCount: number }
  // Phase 31.5 additions
  | { type: "VIDEO_DURATION_OBSERVATION"; durationSeconds: number }
  | { type: "AUDIO_METADATA_OBSERVATION"; family: string }
  | { type: "SIMILAR_FILE_CANDIDATE"; otherMaterialCount: number }
  // Phase 31.8 — real EXIF parser outputs.
  | { type: "EXIF_TIMESTAMP_MISMATCH"; gapSeconds: number }
  | {
      type: "DEVICE_METADATA_OBSERVATION";
      hasMake: boolean;
      hasModel: boolean;
      hasDimensions: boolean;
      hasSoftware: boolean;
    };

export function safeSummary(input: SafeWordingInput): string {
  switch (input.type) {
    case "EXIF_MISSING":
      return "No EXIF metadata was observed on this material. This is advisory only — absence of EXIF is not unusual and does not indicate anything specific about the source.";
    case "CLIENT_SERVER_TIME_GAP": {
      const minutes = Math.floor(input.gapSeconds / 60);
      return `Client-observed capture time and server receipt time differ by approximately ${minutes} minute(s). This is advisory only; clock skew on capturing devices is common.`;
    }
    case "MIME_EXTENSION_MISMATCH":
      return `Filename extension (.${truncate(input.extension, 16)}) does not match the observed MIME type (${truncate(input.mimeType, 60)}). Review recommended.`;
    case "SCREENSHOT_LIKE_FILENAME":
      return "Filename pattern suggests this material may have been produced via a screen capture tool. Advisory only.";
    case "DUPLICATE_HASH_MATCH":
      return `Byte-identical material was observed elsewhere in this workspace (${input.otherMaterialCount} other record(s)). Review recommended.`;
    case "OCR_AVAILABLE":
      return "OCR text extraction is available for this material.";
    case "TRANSCRIPT_AVAILABLE":
      return "Transcript extraction is available for this material.";
    case "VIDEO_DURATION_OBSERVATION": {
      const minutes = Math.floor(input.durationSeconds / 60);
      const seconds = Math.floor(input.durationSeconds % 60);
      return `Video duration observed: approximately ${minutes}m ${seconds}s. Advisory only.`;
    }
    case "AUDIO_METADATA_OBSERVATION":
      return `Audio material observed (${truncate(input.family, 32)}). Advisory only.`;
    case "SIMILAR_FILE_CANDIDATE":
      return `Candidate similar material observed in this workspace (${input.otherMaterialCount} other record(s)). Review recommended.`;
    case "EXIF_TIMESTAMP_MISMATCH": {
      const hours = Math.floor(input.gapSeconds / 3600);
      const minutes = Math.floor((input.gapSeconds % 3600) / 60);
      const label = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
      return `EXIF capture timestamp differs from server receipt time by approximately ${label}. Review recommended; device clock skew and timezone drift are common explanations.`;
    }
    case "DEVICE_METADATA_OBSERVATION": {
      const observed = [
        input.hasMake ? "device make" : null,
        input.hasModel ? "device model" : null,
        input.hasDimensions ? "image dimensions" : null,
        input.hasSoftware ? "software label" : null,
      ].filter((s): s is string => s != null);
      if (observed.length === 0) {
        return "Device metadata observation available. Advisory only.";
      }
      return `Device metadata recorded: ${observed.join(", ")}. Advisory only.`;
    }
    // Phase 31.20 — indexing-completion summaries. Bounded count
    // wording only; NEVER includes raw OCR / transcript text.
    case "OCR_INDEXED":
      return `OCR content indexed for search (${input.chunkCount} chunk(s)). Advisory only.`;
    case "TRANSCRIPT_INDEXED":
      return `Transcript content indexed for search (${input.segmentCount} segment(s)). Advisory only.`;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
