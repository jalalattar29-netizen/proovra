/**
 * UC-3 / UC-5 — PROOVRA CONTINUOUS Screen Capture manifest (the ONE bounded,
 * server-validated schema describing a continuous/streaming screen session that
 * PROOVRA's Android app recorded through MediaProjection consent, or that its
 * iOS app recorded through Apple's user-authorised system broadcast).
 *
 * It is the streaming sibling of the UC-2 frame manifest: a continuous session is
 * preserved as ordered ORIGINAL SEGMENTS (short recordings), never one giant blob
 * and never one Evidence per segment — the segments belong to ONE Evidence. It is
 * NOT an authority on trust: the server recomputes every segment's digest and the
 * existing completion pipeline establishes integrity.
 *
 * CONTINUITY IS STATED, NOT ASSUMED. `sessionCompleteness` distinguishes a
 * COMPLETE_SESSION from an INTERRUPTED_SESSION, `sequence` makes ordering explicit
 * (a gap is detectable), `recordedSegmentCount` says how many segments the
 * recorder produced (so a lost tail is detectable), and interruptions /
 * orientation changes / pauses / losses are recorded — so PROOVRA never claims
 * continuity across a break it knows about.
 *
 * PRIVACY (deliberate omissions): NO app inventory, notification contents,
 * clipboard, contacts or hardware identifiers — only the coarse display/OS/app
 * context and segment structure needed to interpret the recording.
 */

import { CAPTURE_LIMITS } from "./capture-limits.js";
import { CAPTURE_MANIFEST_FACTS_SCHEMA, type CaptureManifestFacts } from "./web-capture-manifest.js";

/**
 * V2 (UC-STR-002 / UC-IOS-001, 2026-09-30). V1 had no statement of how many
 * segments the recorder produced, so a manifest listing only the segments that
 * happened to upload sealed as COMPLETE_SESSION over a lost tail. V2 adds the
 * REQUIRED `recordedSegmentCount`, the head/tail coverage rule for a complete
 * session, explicit loss / pause / write-failure limitations, the UNKNOWN
 * termination, `partIndex === sequence`, and ONE device block for both
 * platforms (`validateContinuousDeviceBlock`). A V1 manifest is refused: no V1
 * client ever sealed a UC-5 session and UC-3 had not shipped to a store.
 */
export const SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION =
  "PROOVRA_SCREEN_CAPTURE_CONTINUOUS_MANIFEST_V2" as const;

export const SCREEN_CONTINUOUS_SESSION_COMPLETENESS = [
  "COMPLETE_SESSION",
  "INTERRUPTED_SESSION",
] as const;
export type ScreenContinuousSessionCompleteness =
  (typeof SCREEN_CONTINUOUS_SESSION_COMPLETENESS)[number];

/** A segment is a DIRECT recording chunk (an ORIGINAL part). */
export const SCREEN_CONTINUOUS_ARTIFACT_ROLES = ["screen_segment"] as const;
export type ScreenContinuousArtifactRole =
  (typeof SCREEN_CONTINUOUS_ARTIFACT_ROLES)[number];

export const SCREEN_CONTINUOUS_TERMINATION_REASONS = [
  "USER_STOPPED",
  "BOUNDS_REACHED",
  "INTERRUPTED",
  "PERMISSION_REVOKED",
  "ERROR",
  /**
   * UC-IOS-006 — the recorder's own summary is missing (extension killed,
   * jetsam, crash). Only ever INTERRUPTED, and only the times PROOVRA can read
   * from what was actually written are stated.
   */
  "UNKNOWN",
] as const;
export type ScreenContinuousTerminationReason =
  (typeof SCREEN_CONTINUOUS_TERMINATION_REASONS)[number];

export const SCREEN_CONTINUOUS_LIMITATION_CODES = [
  "SECURE_CONTENT_OMITTED",
  "ORIENTATION_CHANGED_DURING_CAPTURE",
  "SESSION_BOUNDS_REACHED",
  "CAPTURE_INTERRUPTED",
  "SEGMENT_UPLOAD_BACKPRESSURE",
  /**
   * UC-STR-002 — the device recorded segments that never reached PROOVRA (their
   * upload or declaration failed for good). The sealed record holds fewer
   * segments than were recorded; `recordedSegmentCount` says how many.
   */
  "SEGMENT_UPLOAD_LOST",
  /**
   * UC-AND-007 / UC-IOS-007 — the recorder could not finalise a segment file
   * (encoder stop failed, writer failed, storage full). That stretch of the
   * recording is not in the record.
   */
  "SEGMENT_WRITE_FAILED",
  /** UC-IOS-009 — the system paused the broadcast; the paused interval is not recorded. */
  "BROADCAST_PAUSED",
] as const;
export type ScreenContinuousLimitationCode =
  (typeof SCREEN_CONTINUOUS_LIMITATION_CODES)[number];

/**
 * Limitations that say the recording is NOT a complete, gap-free whole. A
 * manifest carrying any of them cannot claim COMPLETE_SESSION (a conflicting
 * terminal state).
 */
export const SCREEN_CONTINUOUS_INCOMPLETE_LIMITATIONS: ReadonlyArray<ScreenContinuousLimitationCode> = [
  "CAPTURE_INTERRUPTED",
  "SEGMENT_UPLOAD_LOST",
  "SEGMENT_WRITE_FAILED",
  "BROADCAST_PAUSED",
];

/** Bounds — enforced by the validator; the app must not exceed them. */
export const SCREEN_CONTINUOUS_MANIFEST_BOUNDS = {
  /**
   * A bounded session: a ceiling on segments (never unlimited recording).
   * UC-STR-001 — THE capture limit, so the segments plus the manifest part fit
   * the record's part-index ceiling (MAX_EVIDENCE_PARTS).
   */
  maxSegments: CAPTURE_LIMITS.maxContinuousSegments,
  maxStringLen: 256,
  maxNotes: 64,
  maxNoteLen: 300,
  maxLimitations: 64,
  maxSizeBytes: 512 * 1024, // serialized manifest ceiling
  /**
   * ET-DC-09 — continuity tolerances. A rolling recorder restarts its encoder
   * between segments (and on rotation), so consecutive segments may be a
   * little apart; more than `maxGapMs` apart is a gap, which only an
   * INTERRUPTED session may carry. `timingSlackMs` absorbs clock rounding
   * between the recorder and the wall clock; `clockSkewMs` bounds how far the
   * device clock may disagree with the server's session window.
   * UC-STR-002 — `maxGapMs` is also the head/tail tolerance: a complete
   * session's first segment starts within it of 0 and its last segment ends
   * within it of `totalDurationMs`.
   */
  maxGapMs: 3000,
  maxOverlapMs: 1000,
  timingSlackMs: 5000,
  clockSkewMs: 5 * 60 * 1000,
} as const;

/** ET-DC-09 — the terminations that END a complete session (the recorder's own rule). */
export const SCREEN_CONTINUOUS_COMPLETE_TERMINATIONS = ["USER_STOPPED", "BOUNDS_REACHED"] as const;

/**
 * ET-DC-09 — how a sealed continuous session's completeness travels downstream.
 * The sealed session's status is BOUND whatever the manifest said, so the
 * completeness is recorded on the session's end reason at seal.
 */
export const CONTINUOUS_INCOMPLETE_END_REASON = "CONTINUOUS_INTERRUPTED_SESSION";
export const CONTINUOUS_COMPLETE_END_REASON = "CONTINUOUS_COMPLETE_SESSION";
export function continuousEndReasonFor(completeness: ScreenContinuousSessionCompleteness): string {
  return completeness === "COMPLETE_SESSION" ? CONTINUOUS_COMPLETE_END_REASON : CONTINUOUS_INCOMPLETE_END_REASON;
}

/**
 * ET-DC-09 — THE reading of a capture session's acquisition completeness, for
 * everything downstream of the seal: an INTERRUPTED session, or a sealed one
 * whose manifest said it was interrupted, is not a complete acquisition. No
 * session (not a direct capture) reads as complete.
 */
export function captureSessionAcquisitionComplete(
  session: { status: string; endReason: string | null } | null | undefined,
): boolean {
  if (!session) return true;
  return session.status !== "INTERRUPTED" && session.endReason !== CONTINUOUS_INCOMPLETE_END_REASON;
}

/**
 * THE canonical continuous-capture resource bounds (technical safety limits — NOT
 * commercial entitlements). Every value is read from THE capture limits
 * (`capture-limits.ts`), shared by the JS binding (segment/session clamps), the
 * streaming client (retry/backoff, backpressure), the manifest validator and —
 * by value, since native code cannot import TS — the Kotlin and Swift recorders
 * (`apps/mobile/test/capture-limits-native-sync.test.mjs` parses them).
 *
 * `maxSessionBytes` is the ceiling a whole continuous session may occupy across all
 * ORIGINAL segments. It is deliberately set BELOW the canonical total-evidence cap
 * `MAX_EVIDENCE_SIZE_MB` (default 1 GiB) that `completeEvidence` enforces fail-closed
 * for every ingest path, with headroom for the in-flight backlog and the manifest,
 * so a sealed continuous session is always packageable, reportable and destroyable.
 */
export const SCREEN_CONTINUOUS_STREAM_BOUNDS = {
  /** Per-segment recording duration window (ms). */
  minSegmentMs: CAPTURE_LIMITS.minContinuousSegmentMs,
  maxSegmentMs: CAPTURE_LIMITS.maxContinuousSegmentMs,
  defaultSegmentMs: CAPTURE_LIMITS.defaultContinuousSegmentMs,
  /**
   * Ceiling on segment count for one bounded session. UC-STR-001 — THE capture
   * limit (MAX_EVIDENCE_PARTS - 1: one part is the continuity manifest). It was
   * 600 against a 200-part record, so segment 200 could never be declared and
   * the whole recording was discarded at staging.
   */
  maxSegments: CAPTURE_LIMITS.maxContinuousSegments,
  /**
   * Max total wall-clock duration of one session (ms). Kept safely BELOW the
   * default capture-session TTL (1 h). Enforced natively (by value) as
   * `MAX_SESSION_MS`. Whichever of this, `maxSegments` and `maxSessionBytes` is
   * reached first ends the session with SESSION_BOUNDS_REACHED.
   */
  maxSessionMs: CAPTURE_LIMITS.maxContinuousSessionMs,
  /** Native encoder settings (kept in sync with the Kotlin service by value). */
  videoBitrateBps: 6_000_000,
  videoFrameRate: 12,
  /** Per-segment byte ceiling (native setMaxFileSize → rollover; defence in depth). */
  maxSegmentBytes: CAPTURE_LIMITS.maxContinuousSegmentBytes,
  /** Whole-session byte ceiling across all ORIGINAL segments. */
  maxSessionBytes: CAPTURE_LIMITS.maxContinuousSessionBytes,
  /** Streaming upload discipline (bounded backlog, no unbounded RAM/disk). */
  uploadConcurrency: 1,
  uploadRetries: 2,
  retryBackoffMs: 500,
  /**
   * Backpressure (Android): the maximum number of recorded-but-not-yet-uploaded
   * segments the client tolerates before it triggers a CONTROLLED stop. iOS does
   * not apply it: the host app is suspended while the user is in another app, so
   * the App Group container is the durable spool (UC-IOS-003).
   */
  maxPendingSegments: 8,
} as const;

export type ScreenContinuousSegmentDescriptor = {
  role: ScreenContinuousArtifactRole;
  /** The record part holding this segment. V2: always equal to `sequence`. */
  partIndex: number;
  /** Explicit ordering (0-based). A gap here is detectable. */
  sequence: number;
  /** SHA-256 (lowercase hex) the client computed; the server recomputes it. */
  expectedSha256: string;
  sizeBytes: number;
  mediaType: string;
  /** ms after captureStartedAtUtc that this segment began. */
  startedAtOffsetMs: number;
  durationMs: number;
  widthPx: number;
  heightPx: number;
  orientation: "portrait" | "landscape";
};

/**
 * UC-IOS-001 — THE device block, one contract for both platforms.
 *
 *   platform     "android" | "ios"
 *   osVersion    Build.VERSION.RELEASE | UIDevice.systemVersion
 *   model        coarse model (manufacturer + model | UIDevice.model)
 *   appVersion   versionName | CFBundleShortVersionString
 *   screenW/H    the display in NATIVE PIXELS at session start
 *                (DisplayMetrics real metrics | UIScreen.main.nativeBounds,
 *                expressed in the session-start orientation)
 *   densityDpi   Android: DisplayMetrics.densityDpi. iOS: UIScreen.main.scale
 *                x 160 — the Android-equivalent LOGICAL density, not the
 *                panel's physical PPI (iOS does not expose that).
 *   orientation  the session-start orientation; MUST agree with screenW/H.
 */
export type ScreenContinuousDevice = {
  platform: "android" | "ios";
  osVersion: string;
  model: string;
  appVersion: string;
  screenW: number;
  screenH: number;
  densityDpi: number;
  orientation: "portrait" | "landscape";
};

export type ScreenContinuousManifest = {
  schemaVersion: typeof SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION;
  captureSessionId: string;
  captureStartedAtUtc: string;
  captureEndedAtUtc: string;
  device: ScreenContinuousDevice;
  osConsentGranted: boolean;
  totalDurationMs: number;
  /**
   * UC-STR-002 — how many segments the RECORDER produced (not how many
   * uploaded). A session whose record holds fewer can only be INTERRUPTED with
   * SEGMENT_UPLOAD_LOST.
   */
  recordedSegmentCount: number;
  segments: ScreenContinuousSegmentDescriptor[];
  sessionCompleteness: ScreenContinuousSessionCompleteness;
  terminationReason: ScreenContinuousTerminationReason;
  limitations: ScreenContinuousLimitationCode[];
  notes: string[];
};

export type ScreenContinuousManifestValidation =
  | { ok: true; manifest: ScreenContinuousManifest }
  | { ok: false; error: string };

const HEX64 = /^[0-9a-f]{64}$/;

function isBoundedString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}
function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * UC-IOS-001 — THE device-block validator, used by the manifest validator and
 * by the mobile client before it ever builds a manifest, so a malformed native
 * summary is refused with the same specific error on both sides.
 */
export function validateContinuousDeviceBlock(
  device: unknown,
): { ok: true; device: ScreenContinuousDevice } | { ok: false; error: string } {
  if (!device || typeof device !== "object") return { ok: false, error: "missing device" };
  const d = device as Record<string, unknown>;
  if (d.platform !== "android" && d.platform !== "ios") {
    return { ok: false, error: "invalid device.platform" };
  }
  for (const k of ["osVersion", "model", "appVersion"] as const) {
    if (!isBoundedString(d[k], SCREEN_CONTINUOUS_MANIFEST_BOUNDS.maxStringLen)) {
      return { ok: false, error: `invalid device.${k}` };
    }
  }
  for (const k of ["screenW", "screenH", "densityDpi"] as const) {
    if (!isPositiveInt(d[k])) return { ok: false, error: `invalid device.${k}` };
  }
  if (d.orientation !== "portrait" && d.orientation !== "landscape") {
    return { ok: false, error: "invalid device.orientation" };
  }
  if (((d.screenW as number) >= (d.screenH as number)) !== (d.orientation === "landscape")) {
    return { ok: false, error: "device.orientation does not match its dimensions" };
  }
  return { ok: true, device: d as unknown as ScreenContinuousDevice };
}

/**
 * THE server-side validator. Strict and bounded: it never trusts the client's
 * shape, refuses duplicates, requires every segment to sit at the part index of
 * its sequence, and — for a COMPLETE session — requires the listed segments to
 * be exactly the recorded ones, contiguous from 0, covering the stated duration.
 */
export function validateScreenContinuousManifest(
  input: unknown,
  opts: {
    expectedSessionId?: string;
    /** ET-DC-09 — the platform the server-issued session's mode implies. */
    expectedPlatform?: "android" | "ios";
    /** ET-DC-09 — the server's session window: opened at, and "now" at seal. */
    sessionWindow?: { openedAtMs: number; nowMs: number };
  } = {},
): ScreenContinuousManifestValidation {
  const B = SCREEN_CONTINUOUS_MANIFEST_BOUNDS;
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return { ok: false, error: "manifest is not serializable" };
  }
  if (serialized.length > B.maxSizeBytes) {
    return { ok: false, error: "manifest exceeds the size ceiling" };
  }
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "manifest must be an object" };
  }
  const m = input as Record<string, unknown>;
  if (m.schemaVersion !== SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION) {
    return { ok: false, error: "unknown manifest schemaVersion" };
  }
  if (!isBoundedString(m.captureSessionId, 64)) {
    return { ok: false, error: "invalid captureSessionId" };
  }
  if (opts.expectedSessionId && m.captureSessionId !== opts.expectedSessionId) {
    return { ok: false, error: "manifest captureSessionId does not match the session" };
  }
  if (!isBoundedString(m.captureStartedAtUtc, 40) || Number.isNaN(Date.parse(m.captureStartedAtUtc))) {
    return { ok: false, error: "invalid captureStartedAtUtc" };
  }
  if (!isBoundedString(m.captureEndedAtUtc, 40) || Number.isNaN(Date.parse(m.captureEndedAtUtc))) {
    return { ok: false, error: "invalid captureEndedAtUtc" };
  }
  const deviceCheck = validateContinuousDeviceBlock(m.device);
  if (!deviceCheck.ok) return deviceCheck;
  const device = deviceCheck.device;
  if (typeof m.osConsentGranted !== "boolean") return { ok: false, error: "invalid osConsentGranted" };
  if (!isNonNegInt(m.totalDurationMs)) return { ok: false, error: "invalid totalDurationMs" };
  if (!isNonNegInt(m.recordedSegmentCount) || m.recordedSegmentCount > B.maxSegments) {
    return { ok: false, error: "invalid recordedSegmentCount" };
  }
  if (!(SCREEN_CONTINUOUS_SESSION_COMPLETENESS as ReadonlyArray<unknown>).includes(m.sessionCompleteness)) {
    return { ok: false, error: "invalid sessionCompleteness" };
  }
  if (!(SCREEN_CONTINUOUS_TERMINATION_REASONS as ReadonlyArray<unknown>).includes(m.terminationReason)) {
    return { ok: false, error: "invalid terminationReason" };
  }
  if (!Array.isArray(m.limitations) || m.limitations.length > B.maxLimitations) {
    return { ok: false, error: "invalid limitations" };
  }
  for (const l of m.limitations) {
    if (!(SCREEN_CONTINUOUS_LIMITATION_CODES as ReadonlyArray<unknown>).includes(l)) {
      return { ok: false, error: `unknown limitation code: ${String(l).slice(0, 40)}` };
    }
  }
  const limitations = m.limitations as string[];
  if (!Array.isArray(m.notes) || m.notes.length > B.maxNotes) {
    return { ok: false, error: "invalid notes" };
  }
  for (const n of m.notes) {
    if (typeof n !== "string" || n.length > B.maxNoteLen) {
      return { ok: false, error: "a note is not a bounded string" };
    }
  }
  if (!Array.isArray(m.segments) || m.segments.length === 0 || m.segments.length > B.maxSegments) {
    return { ok: false, error: "invalid segments array" };
  }
  const seenParts = new Set<number>();
  const seenSequences = new Set<number>();
  const orientations = new Set<string>();
  for (const s of m.segments as unknown[]) {
    if (typeof s !== "object" || s === null) return { ok: false, error: "a segment is not an object" };
    const seg = s as Record<string, unknown>;
    if (!(SCREEN_CONTINUOUS_ARTIFACT_ROLES as ReadonlyArray<unknown>).includes(seg.role)) {
      return { ok: false, error: "invalid segment.role" };
    }
    if (!isNonNegInt(seg.partIndex)) return { ok: false, error: "invalid segment.partIndex" };
    if (seenParts.has(seg.partIndex)) return { ok: false, error: "duplicate segment.partIndex" };
    seenParts.add(seg.partIndex);
    if (!isNonNegInt(seg.sequence)) return { ok: false, error: "invalid segment.sequence" };
    if (seenSequences.has(seg.sequence)) return { ok: false, error: "duplicate segment.sequence" };
    seenSequences.add(seg.sequence);
    // V2 — a segment sits at the part index of its sequence, so "the declared
    // segment parts" and "the recorded sequence" are one ordering and the
    // server can see which recorded segment a missing part was.
    if (seg.partIndex !== seg.sequence) {
      return { ok: false, error: "segment.partIndex must equal segment.sequence" };
    }
    if (seg.sequence >= m.recordedSegmentCount) {
      return { ok: false, error: "a segment sequence is beyond recordedSegmentCount" };
    }
    if (typeof seg.expectedSha256 !== "string" || !HEX64.test(seg.expectedSha256)) {
      return { ok: false, error: "invalid segment.expectedSha256" };
    }
    if (!isNonNegInt(seg.sizeBytes)) return { ok: false, error: "invalid segment.sizeBytes" };
    if (!isNonNegInt(seg.startedAtOffsetMs) || !isNonNegInt(seg.durationMs)) {
      return { ok: false, error: "invalid segment timing" };
    }
    if (!isNonNegInt(seg.widthPx) || !isNonNegInt(seg.heightPx)) {
      return { ok: false, error: "invalid segment dimensions" };
    }
    if (seg.orientation !== "portrait" && seg.orientation !== "landscape") {
      return { ok: false, error: "invalid segment.orientation" };
    }
    // A segment's declared orientation MUST agree with its own pixel geometry —
    // a segment recorded after a rotation carries its true (new) geometry.
    const landscapeByDims = (seg.widthPx as number) >= (seg.heightPx as number);
    if (landscapeByDims !== (seg.orientation === "landscape")) {
      return { ok: false, error: "segment orientation does not match its dimensions" };
    }
    orientations.add(seg.orientation as string);
    if (!isBoundedString(seg.mediaType, 80)) return { ok: false, error: "invalid segment.mediaType" };
  }
  // Orientation transitions must be RECORDED, not silent.
  if (orientations.size > 1 && !limitations.includes("ORIENTATION_CHANGED_DURING_CAPTURE")) {
    return { ok: false, error: "orientation transition across segments is not recorded in limitations" };
  }

  const listed = (m.segments as ScreenContinuousSegmentDescriptor[]).length;
  const ordered = (m.segments as ScreenContinuousSegmentDescriptor[]).slice().sort((a, b) => a.sequence - b.sequence);
  const contiguous = ordered.every((s, i) => s.sequence === i);
  const recorded = m.recordedSegmentCount as number;
  // UC-STR-002 — a loss must be NAMED. A sequence gap, or fewer listed segments
  // than the recorder produced, is only honest as SEGMENT_UPLOAD_LOST.
  const lossStated = limitations.includes("SEGMENT_UPLOAD_LOST");
  if (!contiguous && !lossStated) {
    return { ok: false, error: "segment sequence numbers are not contiguous from 0" };
  }
  if (listed < recorded && !lossStated) {
    return { ok: false, error: "fewer segments than recordedSegmentCount without SEGMENT_UPLOAD_LOST" };
  }

  // ---- ET-DC-09 — continuity is checked, not taken on the client's word ----
  if (opts.expectedPlatform && device.platform !== opts.expectedPlatform) {
    return { ok: false, error: "device.platform does not match the session's capture mode" };
  }
  const startMs = Date.parse(m.captureStartedAtUtc as string);
  const endMs = Date.parse(m.captureEndedAtUtc as string);
  if (endMs < startMs) return { ok: false, error: "captureEndedAtUtc precedes captureStartedAtUtc" };
  if (opts.sessionWindow) {
    const { openedAtMs, nowMs } = opts.sessionWindow;
    if (startMs < openedAtMs - B.clockSkewMs || endMs > nowMs + B.clockSkewMs) {
      return { ok: false, error: "the capture window lies outside the server session" };
    }
  }
  let gapFound = false;
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    const between = cur.startedAtOffsetMs - (prev.startedAtOffsetMs + prev.durationMs);
    if (between < -B.maxOverlapMs) return { ok: false, error: "segments overlap" };
    if (between > B.maxGapMs) gapFound = true;
  }
  if (m.sessionCompleteness === "COMPLETE_SESSION") {
    // A COMPLETE session ended cleanly, holds exactly the recorded segments,
    // contiguous from 0, with no gap, covering its stated duration, and carries
    // no limitation that says otherwise.
    if (!(SCREEN_CONTINUOUS_COMPLETE_TERMINATIONS as ReadonlyArray<unknown>).includes(m.terminationReason)) {
      return { ok: false, error: "a complete session cannot have ended by interruption" };
    }
    for (const l of limitations) {
      if ((SCREEN_CONTINUOUS_INCOMPLETE_LIMITATIONS as ReadonlyArray<string>).includes(l)) {
        return { ok: false, error: `a complete session cannot carry ${l}` };
      }
    }
    if (!contiguous) return { ok: false, error: "segment sequence numbers are not contiguous from 0" };
    if (listed !== recorded) {
      return { ok: false, error: "a complete session must list every recorded segment (recordedSegmentCount)" };
    }
    if (gapFound) return { ok: false, error: "a gap between segments is not declared (session is not complete)" };
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    if (first.startedAtOffsetMs > B.maxGapMs) {
      return { ok: false, error: "the first segment does not start at the capture start (head gap)" };
    }
    if (last.startedAtOffsetMs + last.durationMs < (m.totalDurationMs as number) - B.maxGapMs) {
      return { ok: false, error: "the last segment ends before totalDurationMs (tail not covered)" };
    }
    const windowMs = endMs - startMs;
    if ((m.totalDurationMs as number) > windowMs + B.timingSlackMs) {
      return { ok: false, error: "totalDurationMs exceeds the capture window" };
    }
    for (const s of ordered) {
      if (s.startedAtOffsetMs + s.durationMs > windowMs + B.timingSlackMs) {
        return { ok: false, error: "a segment lies outside the capture window" };
      }
    }
  }
  return { ok: true, manifest: input as ScreenContinuousManifest };
}

/** UC-PROV-003 — the persisted facts of a VALIDATED continuity manifest. */
export function continuousCaptureManifestFacts(
  m: ScreenContinuousManifest,
  ref: { manifestSha256: string; manifestPartIndex: number },
): CaptureManifestFacts {
  return {
    schema: CAPTURE_MANIFEST_FACTS_SCHEMA,
    kind: "SCREEN_CONTINUOUS",
    reportedBy: "CAPTURE_CLIENT",
    manifestSchemaVersion: m.schemaVersion,
    manifestSha256: ref.manifestSha256,
    manifestPartIndex: ref.manifestPartIndex,
    clientCaptureWindow: { startedAtUtc: m.captureStartedAtUtc, endedAtUtc: m.captureEndedAtUtc },
    completeness: m.sessionCompleteness,
    reportedComplete: m.sessionCompleteness === "COMPLETE_SESSION",
    limitations: [...m.limitations],
    client: {
      kind: "MOBILE_APP",
      appVersion: m.device.appVersion,
      platform: m.device.platform,
      osVersion: m.device.osVersion,
      model: m.device.model,
      browserName: null,
      browserVersion: null,
    },
    web: null,
    screen: {
      endReason: m.terminationReason,
      artifactCount: m.segments.length,
      recordedSegmentCount: m.recordedSegmentCount,
      totalDurationMs: m.totalDurationMs,
    },
  };
}
