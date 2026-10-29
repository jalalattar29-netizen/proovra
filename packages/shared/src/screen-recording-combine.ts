/**
 * 2026-10-29 — THE combined screen recording (a DERIVED, explicitly labelled
 * review copy of a legacy SEGMENTED continuous screen recording).
 *
 * A continuous screen recording sealed before single-file recording shipped is
 * preserved as N ORIGINAL `segment-<n>.mp4` parts plus the continuity manifest
 * (artifactClass CAPTURE_MANIFEST). Those parts, their digests, signatures,
 * custody and fingerprint are the evidence and are never touched. What a person
 * wants to watch is ONE video, so PROOVRA derives one: the segments, verified
 * against their sealed digests, joined in sequence into one MP4 — remuxed when
 * every segment shares one encoding, transcoded onto one letterboxed canvas
 * when they do not. Real gaps stay gaps (no invented frames, no closed time),
 * are listed in the lineage with their cause and are marked in the file as
 * chapters, so a player or the UI can say "No recording: X s".
 *
 * This module is the pure, shared half: identifiers, bounds, the lineage shape
 * the worker records and every surface reads back, the readiness vocabulary
 * and the download name. Nothing here reads a database, storage or a clock.
 */

/** The derived-asset kind (evidence_part_derived_assets.asset_kind). */
export const SCREEN_RECORDING_COMBINED_ASSET_KIND = "screen_recording_combined" as const;

/** The transformation identifier recorded on the derived row. */
export const SCREEN_RECORDING_COMBINE_TRANSFORMATION = "screen-recording-combine/v1" as const;

/** The media-intelligence run kind that produces it (rides the existing queue). */
export const SCREEN_RECORDING_COMBINE_RUN_KIND = "combine_screen_recording" as const;

/** The producer identity written to `engine_version`. */
export const SCREEN_RECORDING_COMBINE_ENGINE_VERSION = "screen-recording-combine-v1" as const;

/**
 * The acquisition modes whose records may carry a segmented continuous
 * recording. Only these are ever considered; a record of any other mode is
 * NOT_APPLICABLE without reading a byte.
 */
export const SCREEN_RECORDING_COMBINE_ACQUISITION_MODES = [
  "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
  "DIRECT_SCREEN_CAPTURE_IOS",
] as const;

/**
 * Resource bounds. `maxSourceBytes` is the continuous-session ceiling
 * (CAPTURE_LIMITS.maxContinuousSessionBytes, 512 MiB); the output may exceed
 * the sources by the container/transcode overhead, never more than
 * `maxOutputBytes`. The database CHECK on `evidence_part_derived_assets.size_bytes`
 * admits exactly `maxOutputBytes` (migration 20281029000000).
 */
export const SCREEN_RECORDING_COMBINE_BOUNDS = {
  maxSourceBytes: 512 * 1024 * 1024,
  maxOutputBytes: 640 * 1024 * 1024,
  /** Free temp space required, as a multiple of the source bytes (sources + intermediates + output). */
  tempSpaceFactor: 3,
  /** The whole job's wall-clock budget — ENFORCED (every ffmpeg spawn gets the remainder). */
  jobTimeoutMs: 15 * 60 * 1000,
  /** One probe / packet count / parameter-set read. */
  probeTimeoutMs: 60 * 1000,
  /** Attempts before the run is terminally FAILED (below the run tracker's ceiling). */
  maxAttempts: 3,
  /** A timeline gap at least this long is LISTED (every gap is preserved in time regardless). */
  reportGapMinMs: 500,
  /** Largest canvas side a transcode will produce; larger sources are scaled down to fit (never cropped). */
  maxCanvasSidePx: 4096,
  /** Multipart upload part size (S3 minimum is 5 MiB except the last part). */
  uploadPartBytes: 16 * 1024 * 1024,
} as const;

export const SCREEN_RECORDING_COMBINE_MODES = ["REMUX", "TRANSCODE"] as const;
export type ScreenRecordingCombineMode = (typeof SCREEN_RECORDING_COMBINE_MODES)[number];

export const SCREEN_RECORDING_COMBINE_COMPLETENESS = ["COMPLETE", "PARTIAL"] as const;
export type ScreenRecordingCombineCompleteness = (typeof SCREEN_RECORDING_COMBINE_COMPLETENESS)[number];

/**
 * Why there is no picture for a stretch of the combined timeline.
 *   SEGMENT_MISSING   — the manifest's sequence skips a segment (lost upload / write failure).
 *   TIMELINE_GAP      — consecutive segments, but the recorder's own offsets leave time unrecorded
 *                       (encoder restart, broadcast pause, interruption).
 *   TAIL_MISSING      — the recorder reported more segments than the record holds after the last one.
 *   HEAD_MISSING      — the first held segment does not start the session.
 */
export const SCREEN_RECORDING_GAP_CAUSES = [
  "SEGMENT_MISSING",
  "TIMELINE_GAP",
  "TAIL_MISSING",
  "HEAD_MISSING",
] as const;
export type ScreenRecordingGapCause = (typeof SCREEN_RECORDING_GAP_CAUSES)[number];

/** One stretch with no recording, on the COMBINED file's timeline (ms from its first frame). */
export type ScreenRecordingGap = {
  /** Where on the combined timeline the gap starts (null when it lies outside it: head/tail). */
  atMs: number | null;
  /** How long nothing was recorded, when the manifest states it (null: unknown, e.g. a lost tail). */
  durationMs: number | null;
  cause: ScreenRecordingGapCause;
  /** The sequences the record does not hold for this gap (empty for a pure timeline gap). */
  missingSequences: number[];
  /** Manifest limitation codes in effect for the session (verbatim, client-reported). */
  limitations: string[];
};

/** One ORIGINAL segment the combined file was built from. */
export type ScreenRecordingCombineSource = {
  partIndex: number;
  sequence: number;
  /** The sealed digest — equal to EvidencePart.sha256 and the manifest's expectedSha256. */
  sha256: string;
  sizeBytes: number;
  /** The exact object version read (null on unversioned storage). */
  versionId: string | null;
  /** Client-reported, from the manifest. */
  startedAtOffsetMs: number;
  durationMs: number;
  /** Where this segment's first frame sits in the combined file. */
  combinedStartMs: number;
  /** The packets PROOVRA read from it (frame count conservation is checked on the output). */
  videoPackets: number;
  widthPx: number;
  heightPx: number;
  videoCodec: string;
  hasAudio: boolean;
};

/**
 * THE lineage (`generation_parameters` of the derived row). Everything a
 * reviewer needs to explain and reproduce the derivation.
 */
export type ScreenRecordingCombineLineage = {
  schema: "PROOVRA_SCREEN_RECORDING_COMBINE_V1";
  transformation: typeof SCREEN_RECORDING_COMBINE_TRANSFORMATION;
  generation: number;
  tools: { ffmpeg: string | null };
  mode: ScreenRecordingCombineMode;
  /** Why the mode was chosen (one compatible group ⇒ REMUX). */
  modeReason: string;
  canvas: { widthPx: number; heightPx: number; letterboxed: boolean };
  encoder: Record<string, string | number> | null;
  manifest: { partIndex: number; sha256: string; schemaVersion: string; recordedSegmentCount: number | null };
  sources: ScreenRecordingCombineSource[];
  /** sha256 of the canonical JSON of [{partIndex, sha256}] in sequence order. */
  sourceSetSha256: string;
  gaps: ScreenRecordingGap[];
  completeness: ScreenRecordingCombineCompleteness;
  /** Manifest limitations copied verbatim, plus the combine's own (prefixed COMBINE_). */
  limitations: string[];
  output: { durationMs: number | null; videoPackets: number; chapters: number };
  statement: string;
};

export const SCREEN_RECORDING_COMBINE_STATEMENT =
  "DERIVED review copy. PROOVRA joined the original recorded segments in sequence; the originals, their fingerprints and the sealed record are unchanged and remain the evidence. Periods with no recording are kept as gaps, never filled.";

/** sha256 input for `sourceSetSha256`: canonical JSON of [{partIndex, sha256}] in the given order. */
export function screenRecordingSourceSetCanonical(
  sources: ReadonlyArray<{ partIndex: number; sha256: string }>,
): string {
  return JSON.stringify(sources.map((s) => ({ partIndex: s.partIndex, sha256: s.sha256.toLowerCase() })));
}

// ---------------------------------------------------------------------------
// Generations — every request after a settled run is a new generation.
// ---------------------------------------------------------------------------

export function screenRecordingCombinedVariantKey(generation: number): string {
  return `combined-v${Math.max(1, Math.trunc(generation))}`;
}

/** Generation 1 uses the queue's default key (`<kind>:<evidenceId>`); later ones add `:g<n>`. */
export function screenRecordingCombineIdempotencyKey(evidenceId: string, generation: number): string {
  const base = `${SCREEN_RECORDING_COMBINE_RUN_KIND}:${evidenceId}`;
  return generation <= 1 ? base : `${base}:g${Math.trunc(generation)}`;
}

export function parseScreenRecordingCombineGeneration(idempotencyKey: string | null | undefined): number | null {
  if (!idempotencyKey || !idempotencyKey.startsWith(`${SCREEN_RECORDING_COMBINE_RUN_KIND}:`)) return null;
  const m = /:g(\d{1,6})$/.exec(idempotencyKey);
  return m ? Math.max(1, Number(m[1])) : 1;
}

// ---------------------------------------------------------------------------
// Readiness — what a surface says.
// ---------------------------------------------------------------------------

export const SCREEN_RECORDING_COMBINE_STATES = [
  "NOT_APPLICABLE",
  "NOT_STARTED",
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "UNSUPPORTED",
] as const;
export type ScreenRecordingCombineState = (typeof SCREEN_RECORDING_COMBINE_STATES)[number];

export const SCREEN_RECORDING_COMBINE_COPY = {
  preparing: "Preparing combined video",
  unavailable: "Combined video unavailable — original segments remain available",
  notStarted: "A combined video has not been prepared yet",
  downloadCombined: "Download combined recording (derived)",
  downloadRecording: "Download recording",
  originals: "Original technical files",
  derivedLabel: "DERIVED — combined from the original segments",
  partial: "Some of the recording is missing; the gaps are marked",
} as const;

/** The UI headline for a state. */
export function screenRecordingCombineHeadline(state: ScreenRecordingCombineState): string | null {
  switch (state) {
    case "PENDING":
    case "PROCESSING":
      return SCREEN_RECORDING_COMBINE_COPY.preparing;
    case "FAILED":
    case "UNSUPPORTED":
      return SCREEN_RECORDING_COMBINE_COPY.unavailable;
    case "NOT_STARTED":
      return SCREEN_RECORDING_COMBINE_COPY.notStarted;
    default:
      return null;
  }
}

/** "No recording: 4.2 s" — the marker text for one gap. */
export function screenRecordingGapLabel(gap: Pick<ScreenRecordingGap, "durationMs" | "cause">): string {
  if (gap.durationMs == null) {
    return gap.cause === "TAIL_MISSING" ? "No recording: end of session missing" : "No recording: duration unknown";
  }
  return `No recording: ${(gap.durationMs / 1000).toFixed(1)} s`;
}

/**
 * The download name: `<evidenceId8>-DERIVED-combined-recording-v<gen>.mp4`.
 * Built only from a UUID prefix and an integer, so it is header-safe by construction.
 */
export function screenRecordingCombinedFilename(evidenceId: string, generation: number): string {
  const id8 = evidenceId.replace(/[^0-9a-fA-F]/g, "").slice(0, 8).toLowerCase() || "evidence";
  return `${id8}-DERIVED-combined-recording-v${Math.max(1, Math.trunc(generation))}.mp4`;
}

/**
 * Tolerant reader of a stored lineage: null unless it is this schema. Only the
 * fields a surface renders are normalised; unknown values never throw.
 */
export function readScreenRecordingCombineLineage(input: unknown): ScreenRecordingCombineLineage | null {
  if (!input || typeof input !== "object") return null;
  const l = input as Record<string, unknown>;
  if (l["schema"] !== "PROOVRA_SCREEN_RECORDING_COMBINE_V1") return null;
  if (!Array.isArray(l["sources"]) || !Array.isArray(l["gaps"])) return null;
  const gaps: ScreenRecordingGap[] = [];
  for (const raw of l["gaps"] as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const g = raw as Record<string, unknown>;
    if (!(SCREEN_RECORDING_GAP_CAUSES as ReadonlyArray<unknown>).includes(g["cause"])) continue;
    gaps.push({
      atMs: typeof g["atMs"] === "number" && Number.isFinite(g["atMs"]) ? (g["atMs"] as number) : null,
      durationMs:
        typeof g["durationMs"] === "number" && Number.isFinite(g["durationMs"]) ? (g["durationMs"] as number) : null,
      cause: g["cause"] as ScreenRecordingGapCause,
      missingSequences: Array.isArray(g["missingSequences"])
        ? (g["missingSequences"] as unknown[]).filter((n): n is number => Number.isInteger(n))
        : [],
      limitations: Array.isArray(g["limitations"])
        ? (g["limitations"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
    });
  }
  return { ...(l as unknown as ScreenRecordingCombineLineage), gaps };
}
