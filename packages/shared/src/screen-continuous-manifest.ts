/**
 * UC-3 — PROOVRA Android CONTINUOUS Screen Capture manifest (the ONE bounded,
 * server-validated schema describing a continuous/streaming screen session that
 * PROOVRA's Android app recorded through MediaProjection consent).
 *
 * It is the streaming sibling of the UC-2 frame manifest: a continuous session is
 * preserved as ordered ORIGINAL SEGMENTS (short recordings), never one giant blob
 * and never one Evidence per segment — the segments belong to ONE Evidence. It is
 * NOT an authority on trust: the server recomputes every segment's digest and the
 * existing completion pipeline establishes integrity.
 *
 * CONTINUITY IS STATED, NOT ASSUMED. `sessionCompleteness` distinguishes a
 * COMPLETE_SESSION from an INTERRUPTED_SESSION, `sequence` makes ordering explicit
 * (a gap is detectable), and interruptions/orientation changes are recorded — so
 * PROOVRA never claims continuity across a break it knows about.
 *
 * PRIVACY (deliberate omissions): NO app inventory, notification contents,
 * clipboard, contacts or hardware identifiers — only the coarse display/OS/app
 * context and segment structure needed to interpret the recording.
 */

export const SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION =
  "PROOVRA_SCREEN_CAPTURE_CONTINUOUS_MANIFEST_V1" as const;

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
] as const;
export type ScreenContinuousTerminationReason =
  (typeof SCREEN_CONTINUOUS_TERMINATION_REASONS)[number];

export const SCREEN_CONTINUOUS_LIMITATION_CODES = [
  "SECURE_CONTENT_OMITTED",
  "ORIENTATION_CHANGED_DURING_CAPTURE",
  "SESSION_BOUNDS_REACHED",
  "CAPTURE_INTERRUPTED",
  "SEGMENT_UPLOAD_BACKPRESSURE",
] as const;
export type ScreenContinuousLimitationCode =
  (typeof SCREEN_CONTINUOUS_LIMITATION_CODES)[number];

/** Bounds — enforced by the validator; the app must not exceed them. */
export const SCREEN_CONTINUOUS_MANIFEST_BOUNDS = {
  /** A bounded session: a ceiling on segments (never unlimited recording). */
  maxSegments: 600,
  maxStringLen: 256,
  maxNotes: 64,
  maxNoteLen: 300,
  maxLimitations: 64,
  maxSizeBytes: 512 * 1024, // serialized manifest ceiling
} as const;

/**
 * THE canonical continuous-capture resource bounds (technical safety limits — NOT
 * commercial entitlements). One authority shared by the JS binding (segment/session
 * clamps), the streaming client (retry/backoff, backpressure) and — by value, since
 * a Kotlin service cannot import TS — the native recorder. The native
 * `ContinuousScreenCaptureService` MUST keep its `BITRATE`, `FRAME_RATE` and
 * `MAX_SEGMENT_BYTES` in agreement with `videoBitrateBps`, `videoFrameRate` and
 * `maxSegmentBytes` here.
 *
 * `maxSessionBytes` is the ceiling a whole continuous session may occupy across all
 * ORIGINAL segments. It is deliberately set BELOW the canonical total-evidence cap
 * `MAX_EVIDENCE_SIZE_MB` (default 1 GiB) that `completeEvidence` enforces fail-closed
 * for every ingest path — including continuous-complete → completeDirectCapture →
 * completeEvidence — with headroom for the in-flight backlog and the manifest, so a
 * sealed continuous session is always UNDER that cap and therefore always
 * packageable, reportable and destroyable: every ORIGINAL segment participates, and
 * the Report/Verification-Package worker (which buffers evidence bytes, bounded by
 * that same cap) never sees a UC-3 payload larger than any other sealed evidence.
 */
export const SCREEN_CONTINUOUS_STREAM_BOUNDS = {
  /** Per-segment recording duration window (ms). */
  minSegmentMs: 2000,
  maxSegmentMs: 30000,
  /** Ceiling on segment count for one bounded session. */
  maxSegments: 600,
  /**
   * Max total wall-clock duration of one session (ms). Kept safely BELOW the
   * default capture-session TTL (1 h) so recording always stops with margin to
   * drain uploads and finalize before the server-issued session expires — an
   * expired session cannot seal (it flips to INTERRUPTED), and this bound keeps a
   * long or low-motion session (which may accrue bytes slowly) from ever reaching
   * that. Enforced natively (by value) as `MAX_SESSION_MS`.
   */
  maxSessionMs: 50 * 60 * 1000,
  /** Native encoder settings (kept in sync with the Kotlin service by value). */
  videoBitrateBps: 6_000_000,
  videoFrameRate: 12,
  /** Per-segment byte ceiling (native setMaxFileSize → rollover; defence in depth). */
  maxSegmentBytes: 64 * 1024 * 1024,
  /**
   * Whole-session byte ceiling across all ORIGINAL segments. Kept at or below the
   * downstream total-evidence memory ceiling so a session never becomes
   * un-packageable/un-reportable. At the default 6 Mbps this is ~11 min of capture.
   */
  maxSessionBytes: 512 * 1024 * 1024,
  /** Streaming upload discipline (bounded backlog, no unbounded RAM/disk). */
  uploadConcurrency: 1,
  uploadRetries: 2,
  retryBackoffMs: 500,
  /**
   * Backpressure: the maximum number of recorded-but-not-yet-uploaded segments the
   * client tolerates before it triggers a CONTROLLED stop (no silent drop; the
   * already-recorded segments still upload and seal contiguously).
   */
  maxPendingSegments: 8,
} as const;

export type ScreenContinuousSegmentDescriptor = {
  role: ScreenContinuousArtifactRole;
  /** 0-based index within this capture (ties the manifest to the uploaded part). */
  partIndex: number;
  /** Explicit ordering (0-based, contiguous). A gap here is detectable. */
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

export type ScreenContinuousManifest = {
  schemaVersion: typeof SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION;
  captureSessionId: string;
  captureStartedAtUtc: string;
  captureEndedAtUtc: string;
  device: {
    /**
     * THE DEVICE THAT RECORDED IT, WHICH IS NOT ALWAYS AN ANDROID ONE.
     *
     * UC-5 (Apple system broadcast) is an ordered-segment continuous session
     * with this identical manifest and seals through the same pipeline —
     * `continuous-capture.service.ts` admits DIRECT_SCREEN_CAPTURE_IOS
     * explicitly. This field said "android" only, so the iOS broadcast
     * extension's own honest `"platform": "ios"`
     * (ProovraBroadcastShared.swift:59) was refused as an invalid manifest and
     * a UC-5 session could not be sealed at all. The alternative — an iOS app
     * claiming to be Android to get past a validator — is a false statement
     * about the device on a record whose entire purpose is provenance.
     *
     * UC-2's frame manifest stays Android-only, because THAT capture path is.
     */
    platform: "android" | "ios";
    osVersion: string;
    model: string;
    appVersion: string;
    screenW: number;
    screenH: number;
    densityDpi: number;
    orientation: "portrait" | "landscape";
  };
  osConsentGranted: boolean;
  totalDurationMs: number;
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

/**
 * THE server-side validator. Strict and bounded: it never trusts the client's
 * shape, requires contiguous 0-based sequence numbers (so a missing segment is
 * refused, not silently accepted as continuous), and rejects duplicates.
 */
export function validateScreenContinuousManifest(
  input: unknown,
  opts: { expectedSessionId?: string } = {},
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
  const device = m.device as Record<string, unknown> | undefined;
  if (!device || typeof device !== "object") return { ok: false, error: "missing device" };
  if (device.platform !== "android" && device.platform !== "ios") {
    return { ok: false, error: "invalid device.platform" };
  }
  for (const k of ["osVersion", "model", "appVersion"] as const) {
    if (!isBoundedString(device[k], B.maxStringLen)) return { ok: false, error: `invalid device.${k}` };
  }
  for (const k of ["screenW", "screenH", "densityDpi"] as const) {
    if (!isNonNegInt(device[k])) return { ok: false, error: `invalid device.${k}` };
  }
  if (device.orientation !== "portrait" && device.orientation !== "landscape") {
    return { ok: false, error: "invalid device.orientation" };
  }
  if (typeof m.osConsentGranted !== "boolean") return { ok: false, error: "invalid osConsentGranted" };
  if (!isNonNegInt(m.totalDurationMs)) return { ok: false, error: "invalid totalDurationMs" };
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
  const sequences: number[] = [];
  const orientations = new Set<string>();
  for (const s of m.segments as unknown[]) {
    if (typeof s !== "object" || s === null) return { ok: false, error: "a segment is not an object" };
    const seg = s as Record<string, unknown>;
    if (!(SCREEN_CONTINUOUS_ARTIFACT_ROLES as ReadonlyArray<unknown>).includes(seg.role)) {
      return { ok: false, error: "invalid segment.role" };
    }
    if (!isNonNegInt(seg.partIndex)) return { ok: false, error: "invalid segment.partIndex" };
    if (seenParts.has(seg.partIndex as number)) return { ok: false, error: "duplicate segment.partIndex" };
    seenParts.add(seg.partIndex as number);
    if (!isNonNegInt(seg.sequence)) return { ok: false, error: "invalid segment.sequence" };
    sequences.push(seg.sequence as number);
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
  // Ordering MUST be explicit and contiguous 0..N-1: a gap means a missing
  // segment, which cannot be presented as a continuous whole.
  const sorted = [...sequences].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i] !== i) {
      return { ok: false, error: "segment sequence numbers are not contiguous from 0" };
    }
  }
  // Orientation transitions must be RECORDED, not silent: if the segments span both
  // orientations, the session experienced a display transition, so the manifest must
  // carry ORIENTATION_CHANGED_DURING_CAPTURE. A transition that changed the segment
  // geometry but was not flagged would misrepresent a continuous session.
  if (orientations.size > 1 && !(m.limitations as string[]).includes("ORIENTATION_CHANGED_DURING_CAPTURE")) {
    return { ok: false, error: "orientation transition across segments is not recorded in limitations" };
  }
  return { ok: true, manifest: input as ScreenContinuousManifest };
}
