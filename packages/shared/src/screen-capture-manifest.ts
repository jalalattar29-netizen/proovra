/**
 * UC-2 — PROOVRA Android Direct Screen Capture manifest (the ONE bounded,
 * server-validated schema describing what PROOVRA's Android app captured through
 * Android's MediaProjection consent).
 *
 * It mirrors the UC-1 web-capture manifest by intent: it is NOT an authority on
 * trust. It records the FACTS of a bounded screen-capture session — the session
 * binding, the device/display context, the captured frames and their expected
 * digests, any completeness limitations, and why capture stopped. It cannot
 * declare itself verified/authentic; the server recomputes every frame's digest
 * and the existing completion pipeline establishes integrity.
 *
 * The manifest is persisted as the `CAPTURE_MANIFEST` EvidencePart of the one
 * Evidence record the session creates. It is validated on ingest against the
 * bounds below; a malformed or oversized manifest is refused before any seal.
 *
 * PRIVACY (deliberate omissions): NO installed-app inventory, NO notification
 * contents, NO clipboard, NO contacts, NO IMEI/serial/advertising id — only the
 * coarse display/OS/app context needed to describe the capture. This module is
 * transport-neutral and dependency-free so the mobile app, the API and the
 * worker share ONE schema.
 */

export const SCREEN_CAPTURE_MANIFEST_SCHEMA_VERSION = "PROOVRA_SCREEN_CAPTURE_MANIFEST_V1" as const;

export const SCREEN_CAPTURE_COMPLETENESS = [
  "CAPTURED",
  "PARTIAL",
  "BLOCKED",
  "FAILED",
] as const;
export type ScreenCaptureCompleteness = (typeof SCREEN_CAPTURE_COMPLETENESS)[number];

/**
 * The role of a captured artifact. `screen_frame` is a DIRECT MediaProjection
 * frame (an ORIGINAL part). The manifest itself is the CAPTURE_MANIFEST part and
 * is not listed as an artifact of itself. UC-2 is bounded frames — a continuous
 * screen recording (video) is UC-3 and is deliberately absent here.
 */
export const SCREEN_CAPTURE_ARTIFACT_ROLES = ["screen_frame"] as const;
export type ScreenCaptureArtifactRole = (typeof SCREEN_CAPTURE_ARTIFACT_ROLES)[number];

export const SCREEN_CAPTURE_LIMITATION_CODES = [
  /** A FLAG_SECURE window was on screen; its region was blank/omitted by the OS. */
  "SECURE_CONTENT_OMITTED",
  /** The device orientation changed during the session. */
  "ORIENTATION_CHANGED_DURING_CAPTURE",
  /** The session hit the bounded frame/time ceiling and stopped. */
  "CAPTURE_BOUNDS_EXCEEDED",
  /** The OS revoked the projection, or the user/app interrupted the session. */
  "CAPTURE_INTERRUPTED",
  /** Content on screen may have changed between frames. */
  "SCREEN_CONTENT_CHANGED_DURING_CAPTURE",
] as const;
export type ScreenCaptureLimitationCode = (typeof SCREEN_CAPTURE_LIMITATION_CODES)[number];

export const SCREEN_CAPTURE_STOP_REASONS = [
  "USER_STOPPED",
  "BOUNDS_REACHED",
  "INTERRUPTED",
  "PERMISSION_REVOKED",
  "ERROR",
] as const;
export type ScreenCaptureStopReason = (typeof SCREEN_CAPTURE_STOP_REASONS)[number];

/** Bounds. Enforced by the validator; the app must not exceed them. */
export const SCREEN_CAPTURE_MANIFEST_BOUNDS = {
  /** UC-2 is a SHORT bounded session — a small frame ceiling, never continuous. */
  maxFrames: 60,
  maxStringLen: 256,
  maxNotes: 32,
  maxNoteLen: 300,
  maxLimitations: 32,
  maxSizeBytes: 128 * 1024, // serialized manifest ceiling
} as const;

export type ScreenCaptureArtifactDescriptor = {
  role: ScreenCaptureArtifactRole;
  /** 0-based index within this capture (ties the manifest to the uploaded part). */
  partIndex: number;
  /** Ordered frame position within the session. */
  frameIndex: number;
  /** SHA-256 (lowercase hex) the client computed; the server recomputes it. */
  expectedSha256: string;
  sizeBytes: number;
  mediaType: string;
  widthPx: number;
  heightPx: number;
  /** Milliseconds after captureStartedAtUtc this frame was produced. */
  capturedAtOffsetMs: number;
  completeness: ScreenCaptureCompleteness;
};

export type ScreenCaptureManifest = {
  schemaVersion: typeof SCREEN_CAPTURE_MANIFEST_SCHEMA_VERSION;
  /** The server-issued capture session id this capture is bound to. */
  captureSessionId: string;
  captureStartedAtUtc: string;
  captureEndedAtUtc: string;
  device: {
    platform: "android";
    osVersion: string;
    /** Coarse device model (e.g. "Pixel 7"); NOT a hardware serial/IMEI. */
    model: string;
    appVersion: string;
    screenW: number;
    screenH: number;
    densityDpi: number;
    orientation: "portrait" | "landscape";
  };
  /** Android's MediaProjection consent was granted before any frame was taken. */
  osConsentGranted: boolean;
  artifacts: ScreenCaptureArtifactDescriptor[];
  completeness: ScreenCaptureCompleteness;
  stopReason: ScreenCaptureStopReason;
  limitations: ScreenCaptureLimitationCode[];
  notes: string[];
};

export type ScreenCaptureManifestValidation =
  | { ok: true; manifest: ScreenCaptureManifest }
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
 * shape. A caller passes untrusted JSON; a rejection names the first problem.
 */
export function validateScreenCaptureManifest(
  input: unknown,
  opts: { expectedSessionId?: string } = {},
): ScreenCaptureManifestValidation {
  const B = SCREEN_CAPTURE_MANIFEST_BOUNDS;
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
  if (m.schemaVersion !== SCREEN_CAPTURE_MANIFEST_SCHEMA_VERSION) {
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
  if (device.platform !== "android") return { ok: false, error: "invalid device.platform" };
  for (const k of ["osVersion", "model", "appVersion"] as const) {
    if (!isBoundedString(device[k], B.maxStringLen)) {
      return { ok: false, error: `invalid device.${k}` };
    }
  }
  for (const k of ["screenW", "screenH", "densityDpi"] as const) {
    if (!isNonNegInt(device[k])) return { ok: false, error: `invalid device.${k}` };
  }
  if (device.orientation !== "portrait" && device.orientation !== "landscape") {
    return { ok: false, error: "invalid device.orientation" };
  }
  if (typeof m.osConsentGranted !== "boolean") {
    return { ok: false, error: "invalid osConsentGranted" };
  }
  if (!(SCREEN_CAPTURE_COMPLETENESS as ReadonlyArray<unknown>).includes(m.completeness)) {
    return { ok: false, error: "invalid completeness" };
  }
  if (!(SCREEN_CAPTURE_STOP_REASONS as ReadonlyArray<unknown>).includes(m.stopReason)) {
    return { ok: false, error: "invalid stopReason" };
  }
  if (!Array.isArray(m.limitations) || m.limitations.length > B.maxLimitations) {
    return { ok: false, error: "invalid limitations" };
  }
  for (const l of m.limitations) {
    if (!(SCREEN_CAPTURE_LIMITATION_CODES as ReadonlyArray<unknown>).includes(l)) {
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
  if (!Array.isArray(m.artifacts) || m.artifacts.length === 0 || m.artifacts.length > B.maxFrames) {
    return { ok: false, error: "invalid artifacts array" };
  }
  const seenParts = new Set<number>();
  const seenFrames = new Set<number>();
  for (const a of m.artifacts as unknown[]) {
    if (typeof a !== "object" || a === null) return { ok: false, error: "an artifact is not an object" };
    const art = a as Record<string, unknown>;
    if (!(SCREEN_CAPTURE_ARTIFACT_ROLES as ReadonlyArray<unknown>).includes(art.role)) {
      return { ok: false, error: "invalid artifact.role" };
    }
    if (!isNonNegInt(art.partIndex)) return { ok: false, error: "invalid artifact.partIndex" };
    if (seenParts.has(art.partIndex as number)) {
      return { ok: false, error: "duplicate artifact.partIndex" };
    }
    seenParts.add(art.partIndex as number);
    if (!isNonNegInt(art.frameIndex)) return { ok: false, error: "invalid artifact.frameIndex" };
    if (seenFrames.has(art.frameIndex as number)) {
      return { ok: false, error: "duplicate artifact.frameIndex" };
    }
    seenFrames.add(art.frameIndex as number);
    if (typeof art.expectedSha256 !== "string" || !HEX64.test(art.expectedSha256)) {
      return { ok: false, error: "invalid artifact.expectedSha256" };
    }
    if (!isNonNegInt(art.sizeBytes)) return { ok: false, error: "invalid artifact.sizeBytes" };
    if (!isNonNegInt(art.widthPx) || !isNonNegInt(art.heightPx)) {
      return { ok: false, error: "invalid artifact dimensions" };
    }
    if (!isNonNegInt(art.capturedAtOffsetMs)) {
      return { ok: false, error: "invalid artifact.capturedAtOffsetMs" };
    }
    if (!isBoundedString(art.mediaType, 80)) {
      return { ok: false, error: "invalid artifact.mediaType" };
    }
    if (!(SCREEN_CAPTURE_COMPLETENESS as ReadonlyArray<unknown>).includes(art.completeness)) {
      return { ok: false, error: "invalid artifact.completeness" };
    }
  }
  return { ok: true, manifest: input as ScreenCaptureManifest };
}
