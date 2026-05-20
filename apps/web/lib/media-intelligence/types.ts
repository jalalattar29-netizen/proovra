/**
 * Phase 31.6 — Client-side media intelligence types.
 *
 * Mirrors the bounded vocabularies + response shape from the
 * server-side route `/v1/evidence/:evidenceId/media-intelligence`.
 * Pure module — no React, no fetch. Safe to import anywhere.
 *
 * Hard rules:
 *   * Bounded enums for signalType / severity / confidence / status
 *     match the server CHECK constraints exactly.
 *   * NEVER carries storage internals (no storage_key / storageBucket
 *     / multipart_upload_id / signed URLs / raw GPS / private notes).
 *     The server projection already strips these; the client type
 *     intentionally has no fields for them.
 */

export const CLIENT_SIGNAL_TYPES = [
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
  // Phase 31.8 — real EXIF parser observation.
  "DEVICE_METADATA_OBSERVATION",
] as const;

export type ClientSignalType = (typeof CLIENT_SIGNAL_TYPES)[number];

export const CLIENT_SEVERITIES = [
  "INFO",
  "REVIEW_RECOMMENDED",
  "ATTENTION",
] as const;
export type ClientSeverity = (typeof CLIENT_SEVERITIES)[number];

export const CLIENT_CONFIDENCES = ["LOW", "MEDIUM", "HIGH"] as const;
export type ClientConfidence = (typeof CLIENT_CONFIDENCES)[number];

export const CLIENT_STATUSES = [
  "PENDING",
  "ACKNOWLEDGED",
  "DISMISSED",
] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export type MediaIntelligenceSignal = {
  id: string;
  signalType: ClientSignalType;
  materialId: string | null;
  severity: ClientSeverity;
  confidence: ClientConfidence;
  safeSummary: string;
  status: ClientStatus;
  createdAtUtc: string;
  updatedAtUtc: string;
  acknowledgedAtUtc: string | null;
};

export type MediaIntelligenceCatalogEntry = {
  signalType: ClientSignalType;
  displayLabel: string;
  implemented: boolean;
};

export type MediaIntelligenceResponse = {
  evidenceId: string;
  signals: ReadonlyArray<MediaIntelligenceSignal>;
  catalog: ReadonlyArray<MediaIntelligenceCatalogEntry>;
};

// =============================================================================
// Display helpers
// =============================================================================

/** Bounded, advisory-only severity label set. NEVER uses
 *  "WARNING" / "CRITICAL" / "ALERT" — keeps the tone advisory. */
export function severityLabel(s: ClientSeverity): string {
  switch (s) {
    case "INFO":
      return "Observation";
    case "REVIEW_RECOMMENDED":
      return "Review recommended";
    case "ATTENTION":
      return "Needs attention";
  }
}

export function statusLabel(s: ClientStatus): string {
  switch (s) {
    case "PENDING":
      return "Open";
    case "ACKNOWLEDGED":
      return "Acknowledged";
    case "DISMISSED":
      return "Dismissed";
  }
}

export function confidenceLabel(c: ClientConfidence): string {
  switch (c) {
    case "LOW":
      return "Low confidence";
    case "MEDIUM":
      return "Medium confidence";
    case "HIGH":
      return "High confidence";
  }
}

/** Sort comparator — ATTENTION first, then REVIEW_RECOMMENDED,
 *  then INFO. Within a severity, newest first. */
export function compareSignalsForDisplay(
  a: MediaIntelligenceSignal,
  b: MediaIntelligenceSignal,
): number {
  const sevRank: Record<ClientSeverity, number> = {
    ATTENTION: 0,
    REVIEW_RECOMMENDED: 1,
    INFO: 2,
  };
  const sevDelta = sevRank[a.severity] - sevRank[b.severity];
  if (sevDelta !== 0) return sevDelta;
  return b.createdAtUtc.localeCompare(a.createdAtUtc);
}
