/**
 * UC-3 / UC-5 — THE continuity-manifest builder (pure: no React Native, no
 * Expo, no I/O), shared by the continuous-capture client and by the contract
 * tests that feed it the EXACT native results (the Swift broadcast result map,
 * the Kotlin service outcome) and hand what it builds to the server validator
 * and to a real seal.
 *
 * It is the CLIENT HALF of UC-STR-002: completeness is not taken from the
 * recorder alone. The recorder says how many segments it produced
 * (`segmentCount`); only the segments that were declared to PROOVRA can be
 * sealed. When fewer were declared than recorded — a lost tail or a lost
 * middle segment — the manifest is INTERRUPTED_SESSION with SEGMENT_UPLOAD_LOST
 * and states `recordedSegmentCount`, instead of sealing the uploaded prefix as
 * "Complete — no known interruption". The manifest part goes AFTER every
 * declared segment (max partIndex + 1), never at `declared.length`, which
 * collided with a declared segment whenever a middle one was lost.
 *
 * It is ALSO the client half of UC-IOS-001: the native device block is checked
 * against THE device contract (`validateContinuousDeviceBlock`) before a
 * manifest is built, so a malformed native summary fails here with the same
 * specific error the server would give, not after an hour of uploads.
 */
import {
  SCREEN_CONTINUOUS_INCOMPLETE_LIMITATIONS,
  SCREEN_CONTINUOUS_LIMITATION_CODES,
  SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
  SCREEN_CONTINUOUS_TERMINATION_REASONS,
  validateContinuousDeviceBlock,
  type ScreenContinuousManifest,
  type ScreenContinuousLimitationCode,
  type ScreenContinuousTerminationReason,
} from "@proovra/shared";

export { SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION };

/**
 * The native recorder's session summary (Kotlin service outcome / Swift
 * ProovraBroadcastResult.toJsMap), structurally. Declared HERE rather than
 * imported from the native binding so this module stays free of React Native
 * and Expo types: the API test suite imports it to seal a real session from the
 * exact Swift fixture, and must not pull the React Native globals into the API
 * program. modules/proovra-screen-capture's ScreenContinuousResult is
 * assignable to it.
 */
export type ScreenContinuousResult = {
  osConsentGranted: boolean;
  captureStartedAtUtc: string;
  captureEndedAtUtc: string;
  /** Checked against THE device contract before use (validateContinuousDeviceBlock). */
  device: unknown;
  totalDurationMs: number;
  segmentCount: number;
  sessionCompleteness: string;
  terminationReason: string;
  limitations: string[];
};

export type DeclaredSegment = {
  partIndex: number;
  sequence: number;
  sha256Hex: string;
  sizeBytes: number;
  startedAtOffsetMs: number;
  durationMs: number;
  widthPx: number;
  heightPx: number;
  orientation: "portrait" | "landscape";
};

/** Thrown when the native summary cannot describe a sealable session. */
export class ContinuousManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContinuousManifestError";
  }
}

/** PURE: the recorder's own completeness claim (before upload-side reconciliation). */
export function deriveSessionCompleteness(
  result: Pick<ScreenContinuousResult, "sessionCompleteness" | "segmentCount">,
): "COMPLETE_SESSION" | "INTERRUPTED_SESSION" {
  if (result.segmentCount <= 0) return "INTERRUPTED_SESSION";
  return result.sessionCompleteness === "COMPLETE_SESSION" ? "COMPLETE_SESSION" : "INTERRUPTED_SESSION";
}

export type ContinuousReconciliation = {
  /** Segments the recorder produced (never fewer than the highest sequence + 1). */
  recordedSegmentCount: number;
  /** Recorded sequences that were never declared to PROOVRA. */
  missingSequences: number[];
  sessionCompleteness: "COMPLETE_SESSION" | "INTERRUPTED_SESSION";
  limitations: ScreenContinuousLimitationCode[];
  /** Where the manifest part goes: after every declared segment. */
  manifestPartIndex: number;
};

/**
 * PURE — reconcile what was RECORDED with what was DECLARED (UC-STR-002).
 * Honest completeness: COMPLETE only when the recorder ended cleanly, every
 * recorded segment was declared, and no limitation says otherwise.
 */
export function reconcileContinuousUploads(
  result: Pick<ScreenContinuousResult, "sessionCompleteness" | "segmentCount" | "limitations" | "terminationReason">,
  declared: ReadonlyArray<Pick<DeclaredSegment, "sequence" | "partIndex">>,
  extraLimitations: ReadonlyArray<string> = [],
): ContinuousReconciliation {
  const maxSeq = declared.reduce((m, d) => Math.max(m, d.sequence), -1);
  const maxPart = declared.reduce((m, d) => Math.max(m, d.partIndex), -1);
  const recorded = Math.max(Number.isInteger(result.segmentCount) ? result.segmentCount : 0, maxSeq + 1);
  const have = new Set(declared.map((d) => d.sequence));
  const missing: number[] = [];
  for (let i = 0; i < recorded; i += 1) if (!have.has(i)) missing.push(i);

  const known = new Set<string>(SCREEN_CONTINUOUS_LIMITATION_CODES);
  const limitations = new Set<ScreenContinuousLimitationCode>();
  for (const l of [...(result.limitations ?? []), ...extraLimitations]) {
    if (known.has(l)) limitations.add(l as ScreenContinuousLimitationCode);
  }
  if (missing.length > 0) limitations.add("SEGMENT_UPLOAD_LOST");

  let completeness = deriveSessionCompleteness({ sessionCompleteness: result.sessionCompleteness, segmentCount: recorded });
  if (missing.length > 0) completeness = "INTERRUPTED_SESSION";
  if ([...limitations].some((l) => SCREEN_CONTINUOUS_INCOMPLETE_LIMITATIONS.includes(l))) {
    completeness = "INTERRUPTED_SESSION";
  }
  const termination = result.terminationReason;
  if (termination !== "USER_STOPPED" && termination !== "BOUNDS_REACHED") completeness = "INTERRUPTED_SESSION";

  return {
    recordedSegmentCount: recorded,
    missingSequences: missing,
    sessionCompleteness: completeness,
    limitations: [...limitations],
    manifestPartIndex: maxPart + 1,
  };
}

/**
 * PURE: build the continuity manifest (V2). Throws ContinuousManifestError
 * when the native device block breaks THE device contract.
 */
export function buildContinuousManifest(
  sessionId: string,
  result: ScreenContinuousResult,
  segments: DeclaredSegment[],
  extraLimitations: ReadonlyArray<string> = [],
): ScreenContinuousManifest {
  const device = validateContinuousDeviceBlock(result.device);
  if (!device.ok) throw new ContinuousManifestError(device.error);
  const ordered = [...segments].sort((a, b) => a.sequence - b.sequence);
  const r = reconcileContinuousUploads(result, ordered, extraLimitations);
  const termination = (SCREEN_CONTINUOUS_TERMINATION_REASONS as ReadonlyArray<string>).includes(result.terminationReason)
    ? (result.terminationReason as ScreenContinuousTerminationReason)
    : "UNKNOWN";
  return {
    schemaVersion: SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
    captureSessionId: sessionId,
    captureStartedAtUtc: result.captureStartedAtUtc,
    captureEndedAtUtc: result.captureEndedAtUtc,
    // A copy: the manifest never aliases the native result it was built from.
    device: { ...device.device },
    osConsentGranted: result.osConsentGranted,
    totalDurationMs: result.totalDurationMs,
    recordedSegmentCount: r.recordedSegmentCount,
    segments: ordered.map((s) => ({
      role: "screen_segment" as const,
      partIndex: s.partIndex,
      sequence: s.sequence,
      expectedSha256: s.sha256Hex,
      sizeBytes: s.sizeBytes,
      mediaType: "video/mp4",
      startedAtOffsetMs: s.startedAtOffsetMs,
      durationMs: s.durationMs,
      widthPx: s.widthPx,
      heightPx: s.heightPx,
      orientation: s.orientation,
    })),
    sessionCompleteness: r.sessionCompleteness,
    terminationReason: termination,
    limitations: r.limitations,
    notes: [],
  };
}
