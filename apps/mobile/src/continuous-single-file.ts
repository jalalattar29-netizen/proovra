/**
 * PRODUCT DECISION 1 (2026-10-29) — ONE Start→Stop screen recording is ONE
 * complete video file, on iOS and Android.
 *
 * A new native build stops with `layout: "SINGLE_FILE"` (wire contract B): one
 * finalized MP4, its size/duration/canvas, the orientation timeline, pauses,
 * dropped frames, the audio tracks ACTUALLY written, and whether the writer
 * finished it. No segment events are emitted. An older build omits `layout`
 * and keeps the legacy segmented path (continuous-capture.ts), which stays
 * supported.
 *
 * This module is PURE (no React Native, no Expo, no I/O): it reads the native
 * result defensively and builds the contract-A manifest the server validates
 * (`validateScreenContinuousManifest`). Staging — the upload of part 0 and the
 * manifest as part 1 — lives in continuous-capture.ts beside the segmented
 * staging it parallels.
 *
 * HONESTY. A file the writer could not finish (`finalized: false`) is stated as
 * an INTERRUPTED recording, never as complete; a recording that reached a
 * limit says so; a silent file says no audio was captured.
 */
import {
  SCREEN_CONTINUOUS_LIMITATION_CODES,
  SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
  SCREEN_CONTINUOUS_STREAM_BOUNDS,
  SCREEN_CONTINUOUS_TERMINATION_REASONS,
  validateContinuousDeviceBlock,
  type ScreenContinuousManifest,
  type ScreenContinuousLimitationCode,
  type ScreenContinuousTerminationReason,
} from "@proovra/shared";

export type SingleFileAudioTrack = "APP" | "MICROPHONE";
export type SingleFileOrientationChange = {
  atOffsetMs: number;
  orientation: "portrait" | "landscape";
  widthPx?: number;
  heightPx?: number;
};
export type SingleFilePause = { startOffsetMs: number; endOffsetMs: number };

/** The contract-B fields of a single-file stop result, read defensively. */
export type SingleFileRecording = {
  layout: "SINGLE_FILE";
  recordingUri: string | null;
  recordingSizeBytes: number | null;
  recordingDurationMs: number | null;
  widthPx: number | null;
  heightPx: number | null;
  orientationTimeline: SingleFileOrientationChange[];
  pauses: SingleFilePause[];
  /** Null when the platform cannot count it (Android): never claimed as 0. */
  droppedFrameCount: number | null;
  /** iOS: audio buffers the writer refused (null when not reported). */
  droppedAudioBufferCount: number | null;
  audioTracks: SingleFileAudioTrack[];
  finalized: boolean;
};

/** The legacy result fields this module also reads (both layouts carry them). */
export type ContinuousResultBase = {
  osConsentGranted: boolean;
  captureStartedAtUtc: string;
  captureEndedAtUtc: string;
  device: unknown;
  totalDurationMs: number;
  sessionCompleteness: string;
  terminationReason: string;
  limitations: string[];
};

const nonNegInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
const posInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null;

/**
 * The single-file facts of a native stop result, or null for a legacy
 * (segmented) build. Detection is the explicit `layout` field — never a guess
 * from which other fields happen to be present.
 */
export function readSingleFileRecording(result: unknown): SingleFileRecording | null {
  const r = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  if (!r || r.layout !== "SINGLE_FILE") return null;
  const timeline = Array.isArray(r.orientationTimeline)
    ? r.orientationTimeline
        .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : null))
        .filter((e): e is Record<string, unknown> => !!e && (e.orientation === "portrait" || e.orientation === "landscape") && nonNegInt(e.atOffsetMs) !== null)
        .map((e) => ({
          atOffsetMs: nonNegInt(e.atOffsetMs) as number,
          orientation: e.orientation as "portrait" | "landscape",
          ...(posInt(e.widthPx) ? { widthPx: posInt(e.widthPx) as number } : {}),
          ...(posInt(e.heightPx) ? { heightPx: posInt(e.heightPx) as number } : {}),
        }))
    : [];
  const pauses = Array.isArray(r.pauses)
    ? r.pauses
        .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>) : null))
        .filter((p): p is Record<string, unknown> => !!p)
        .map((p) => ({ startOffsetMs: nonNegInt(p.startOffsetMs), endOffsetMs: nonNegInt(p.endOffsetMs) }))
        .filter((p): p is SingleFilePause => p.startOffsetMs !== null && p.endOffsetMs !== null && p.endOffsetMs > p.startOffsetMs)
    : [];
  const tracks = Array.isArray(r.audioTracks)
    ? [...new Set(r.audioTracks.filter((t): t is SingleFileAudioTrack => t === "APP" || t === "MICROPHONE"))]
    : [];
  return {
    layout: "SINGLE_FILE",
    recordingUri: typeof r.recordingUri === "string" && r.recordingUri ? r.recordingUri : null,
    recordingSizeBytes: nonNegInt(r.recordingSizeBytes),
    recordingDurationMs: nonNegInt(r.recordingDurationMs),
    widthPx: posInt(r.widthPx),
    heightPx: posInt(r.heightPx),
    orientationTimeline: timeline,
    pauses,
    droppedFrameCount: nonNegInt(r.droppedFrameCount),
    droppedAudioBufferCount: nonNegInt(r.droppedAudioBufferCount),
    audioTracks: tracks,
    // Absent is NOT finalized: a file is only presented as whole when the
    // writer said it finished it.
    finalized: r.finalized === true,
  };
}

/** What the review states about a single-file recording (never "complete" when it is not). */
export type SingleFileOutcome = {
  kind: "COMPLETE" | "BOUNDS_REACHED" | "INTERRUPTED" | "NO_FILE";
  headline: string;
  detail: string;
};

export function singleFileOutcome(
  result: Pick<ContinuousResultBase, "terminationReason" | "sessionCompleteness">,
  rec: SingleFileRecording,
): SingleFileOutcome {
  if (!rec.recordingUri) {
    return {
      kind: "NO_FILE",
      headline: "The recording could not be saved",
      detail:
        "The device did not produce a recording file, so there is nothing to add as evidence. Discard it and record again.",
    };
  }
  if (!rec.finalized || !["USER_STOPPED", "BOUNDS_REACHED"].includes(result.terminationReason)) {
    return {
      kind: "INTERRUPTED",
      headline: "Recording interrupted",
      detail:
        "The recording was interrupted before the device could finish the file. What was written is kept and will be sealed as an interrupted recording — it is not presented as complete.",
    };
  }
  if (result.terminationReason === "BOUNDS_REACHED") {
    return {
      kind: "BOUNDS_REACHED",
      headline: "Recording stopped at its limit",
      detail: `The recording reached the limit of ${formatSingleFileLimits()} and stopped. Everything up to that point is in the one file; nothing after it was recorded.`,
    };
  }
  return {
    kind: "COMPLETE",
    headline: "Recording saved",
    detail: "One complete recording file, as reported by this device.",
  };
}

/** The limits shown BEFORE recording ("50 minutes or 512 MB"). */
export function formatSingleFileLimits(
  bounds: { maxSessionMs: number; maxSessionBytes: number } = SCREEN_CONTINUOUS_STREAM_BOUNDS,
): string {
  const minutes = Math.floor(bounds.maxSessionMs / 60_000);
  const mb = Math.floor(bounds.maxSessionBytes / (1024 * 1024));
  const size = mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
  return `${minutes} minutes or ${size}`;
}

/** The audio tracks written, in words (empty ⇒ a silent recording, said so). */
export function audioTracksLabel(tracks: readonly SingleFileAudioTrack[]): string {
  if (tracks.length === 0) return "No audio was recorded — this recording is silent.";
  const names = tracks.map((t) => (t === "MICROPHONE" ? "microphone" : "app audio"));
  return `Audio recorded: ${names.join(" and ")}.`;
}

/** The single file's filename (contract A: `screen-recording-<iso>.mp4`). */
export function singleFileName(captureStartedAtUtc: string): string {
  const iso = (captureStartedAtUtc || new Date(0).toISOString()).replace(/[:.]/g, "-");
  return `screen-recording-${iso}.mp4`;
}

/** Thrown when a single-file result cannot describe a sealable recording. */
export class SingleFileManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SingleFileManifestError";
  }
}

/**
 * PURE — the contract-A manifest of ONE recording file (part 0); the manifest
 * itself is part 1. Every fact that limits the record is named by a
 * limitation, as the server validator requires.
 */
export function buildSingleFileManifest(
  sessionId: string,
  result: ContinuousResultBase,
  rec: SingleFileRecording,
  declared: { sha256Hex: string; sizeBytes: number },
  extraLimitations: ReadonlyArray<string> = [],
): ScreenContinuousManifest {
  const device = validateContinuousDeviceBlock(result.device);
  if (!device.ok) throw new SingleFileManifestError(device.error);
  const initial =
    rec.orientationTimeline[0]?.orientation ??
    ((rec.widthPx ?? 0) >= (rec.heightPx ?? 1) ? "landscape" : "portrait");
  const durationMs = rec.recordingDurationMs ?? Math.max(0, Math.round(result.totalDurationMs || 0));

  const known = new Set<string>(SCREEN_CONTINUOUS_LIMITATION_CODES);
  const limitations = new Set<ScreenContinuousLimitationCode>();
  for (const l of [...(result.limitations ?? []), ...extraLimitations]) {
    // A file is whole or it is not: segment losses do not apply to one file.
    if (known.has(l) && l !== "SEGMENT_UPLOAD_LOST") limitations.add(l as ScreenContinuousLimitationCode);
  }
  if (!rec.finalized) limitations.add("CAPTURE_INTERRUPTED");
  if (rec.audioTracks.length === 0) limitations.add("AUDIO_NOT_CAPTURED" as ScreenContinuousLimitationCode);
  else limitations.delete("AUDIO_NOT_CAPTURED" as ScreenContinuousLimitationCode);
  if ((rec.droppedFrameCount ?? 0) > 0) limitations.add("FRAMES_DROPPED" as ScreenContinuousLimitationCode);
  else limitations.delete("FRAMES_DROPPED" as ScreenContinuousLimitationCode);
  if (rec.pauses.length > 0) limitations.add("BROADCAST_PAUSED");
  const orientations = new Set([initial, ...rec.orientationTimeline.map((o) => o.orientation)]);
  if (orientations.size > 1) limitations.add("ORIENTATION_CHANGED_DURING_CAPTURE");
  if (result.terminationReason === "BOUNDS_REACHED") limitations.add("SESSION_BOUNDS_REACHED");

  const termination = (SCREEN_CONTINUOUS_TERMINATION_REASONS as ReadonlyArray<string>).includes(result.terminationReason)
    ? (result.terminationReason as ScreenContinuousTerminationReason)
    : "UNKNOWN";
  const incomplete: ReadonlyArray<string> = ["CAPTURE_INTERRUPTED", "SEGMENT_WRITE_FAILED", "BROADCAST_PAUSED"];
  const complete =
    rec.finalized &&
    (termination === "USER_STOPPED" || termination === "BOUNDS_REACHED") &&
    result.sessionCompleteness === "COMPLETE_SESSION" &&
    ![...limitations].some((l) => incomplete.includes(l));

  const timeline =
    rec.orientationTimeline.length > 0
      ? rec.orientationTimeline
      : [{ atOffsetMs: 0, orientation: initial as "portrait" | "landscape" }];

  return {
    schemaVersion: SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
    captureSessionId: sessionId,
    captureStartedAtUtc: result.captureStartedAtUtc,
    captureEndedAtUtc: result.captureEndedAtUtc,
    device: { ...device.device },
    osConsentGranted: result.osConsentGranted,
    totalDurationMs: durationMs,
    recordedSegmentCount: 1,
    segments: [
      {
        role: "screen_recording",
        partIndex: 0,
        sequence: 0,
        expectedSha256: declared.sha256Hex,
        sizeBytes: declared.sizeBytes,
        mediaType: "video/mp4",
        startedAtOffsetMs: 0,
        durationMs,
        widthPx: rec.widthPx ?? 1,
        heightPx: rec.heightPx ?? 1,
        orientation: initial,
      },
    ],
    sessionCompleteness: complete ? "COMPLETE_SESSION" : "INTERRUPTED_SESSION",
    terminationReason: termination,
    limitations: [...limitations],
    notes: [],
    recordingLayout: "SINGLE_FILE",
    orientationTimeline: timeline,
    pauses: rec.pauses,
    // Absent when the platform cannot count it: an unobserved 0 is never stated.
    ...(rec.droppedFrameCount !== null ? { droppedFrameCount: rec.droppedFrameCount } : {}),
    audioTracks: rec.audioTracks,
  } as ScreenContinuousManifest;
}

/**
 * A PUT deadline that scales with the file: a fixed two minutes cannot carry a
 * 500 MB recording over a phone connection. Floor of the default request
 * deadline, then ~250 KB/s.
 */
export function singleFilePutTimeoutMs(sizeBytes: number | null, floorMs = 120_000): number {
  const bytes = typeof sizeBytes === "number" && sizeBytes > 0 ? sizeBytes : 0;
  return Math.max(floorMs, Math.ceil(bytes / (250 * 1024)) * 1000);
}
