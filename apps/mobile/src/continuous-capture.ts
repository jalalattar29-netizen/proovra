/**
 * UC-3 / UC-5 — the mobile app's client for CONTINUOUS Screen Capture, shared by
 * Android (MediaProjection) and iOS (Apple system broadcast).
 *
 * The native recording is SEGMENTED and STREAMING: each finalized segment fires an
 * event, and this client uploads it through the SAME canonical direct-capture
 * session (open → reserve → declare digest → presign/PUT) WHILE recording
 * continues — bounded by the on-disk segment ceiling, never buffering the whole
 * session in RAM. On Stop the client drains any pending uploads, builds the
 * continuity manifest referencing the declared segments, and uploads it. The
 * server recomputes every segment digest.
 *
 * IT DOES NOT SEAL. Completion is the canonical Finish & Sign in Capture
 * (F-08): this module used to call `continuous-complete` itself, which gave the
 * product two endings. The manifest travels with the session and is handed to
 * that route by `completeAcquisition` when the operator finishes.
 *
 * The PROOVRA session is opened at START, and that is the one thing here that
 * genuinely cannot move: streaming exists so segments upload WHILE recording,
 * and a session opened at finalize could not receive them. The reservation it
 * implies is released by a discard, so an abandoned recording leaves nothing.
 * The bounded session (<= maxSegments * segmentMs) fits inside the
 * capture-session TTL.
 */
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system";

import { SCREEN_CONTINUOUS_STREAM_BOUNDS } from "@proovra/shared";

import {
  openDirectCaptureSession,
  reserveDirectCaptureEvidence,
  uploadDirectCaptureItem,
  type DirectCaptureSession,
} from "./direct-capture";
import { buildContinuousManifest, reconcileContinuousUploads, type DeclaredSegment } from "./continuous-manifest";
import type {
  ScreenContinuousResult,
  ScreenSegment,
} from "../modules/proovra-screen-capture";

/**
 * T-18 / RC-18 — what this screen's controls may CLAIM.
 *
 * The review control used to be labelled "Finish & Sign" and its copy said it
 * "seals these segments", while this module stages and Capture seals. The
 * canonical "Finish & Sign" (capture.tsx) is the ONE control with that name.
 */
export const CONTINUOUS_REVIEW_COPY = {
  action: "Continue to Finish & Sign",
  explainer:
    "Continue stages these segments and opens Capture, where Finish & Sign seals them into one evidence record. PROOVRA verifies every segment's integrity on the server and records whether the session was complete or interrupted. It does not claim continuity across any known gap.",
  staging: (n: number) => `Staging ${n} segment(s) for Finish & Sign in Capture`,
  staged: "Recording staged",
} as const;

/** The three steps between Stop and Capture, each with its own honest failure. */
export type ContinuousStageStep = "drain" | "stage" | "handoff";

/**
 * UC-STR-001 — a staging failure KEEPS the session: its segments are at storage
 * and declared. The user retries (Continue) or discards; nothing here claims the
 * record was released.
 */
export const CONTINUOUS_STAGE_FAILURE: Record<ContinuousStageStep, string> = {
  drain:
    "Some recorded segments had not finished uploading. Your uploaded segments are kept — tap Continue to retry, or Discard.",
  stage:
    "The recording's continuity manifest could not be staged yet. Your uploaded segments are kept — tap Continue to retry, or Discard.",
  handoff:
    "The recording was staged but could not be handed to Capture on this device. Open Capture: if it does not offer this recording, tap Continue to stage it again.",
};

/** UC-IOS-005 — how long Apple's picker may stay up before PROOVRA gives up waiting. */
export const BROADCAST_START_TIMEOUT_MS = 120_000;

/**
 * UC-IOS-011 — platform-true copy. Android talks about its notification and
 * restrictions; iOS about Apple's picker, the status-bar indicator / Control
 * Center, and uploads that happen when the user returns to PROOVRA.
 */
export const CONTINUOUS_PLATFORM_COPY = {
  android: {
    consent: "Android will ask you to allow screen capture.",
    protectedContent: "Protected content may be unavailable because of Android restrictions.",
    control: "You control it: stop the recording at any time from the capture notification, or here.",
    active:
      "Leave PROOVRA and open what you want to record. Segments upload in the background. Tap Stop from the notification, or here, when you are done.",
  },
  ios: {
    consent:
      "Apple will show its system broadcast picker — tap Start Broadcast to begin. Nothing is recorded until you do.",
    protectedContent:
      "Protected (DRM) content, such as some video streams, appears black: Apple does not let any app record it.",
    control:
      "You control it: stop from the red status-bar recording indicator or Control Center, or here in PROOVRA.",
    active:
      "Leave PROOVRA and open what you want to record. iOS pauses PROOVRA while you are in other apps, so segments are kept on this device and upload when you return to PROOVRA. Stop from the status-bar indicator or Control Center, or here.",
  },
} as const;

/** UC-PROV-010 — the device's own report, in neutral wording (never a verification). */
export const CONTINUOUS_COMPLETENESS_LABEL = {
  complete: "Reported complete by this device — no known interruption",
  interrupted: "Interrupted — the device reported a break, or segments did not reach PROOVRA",
} as const;



/** The draft item's size is the sum of the declared (server-verified) segment sizes — never a hard-coded 0. */
export function continuousSessionBytes(declared: ReadonlyArray<{ sizeBytes: number }>): number {
  return declared.reduce((sum, d) => sum + (Number.isFinite(d.sizeBytes) && d.sizeBytes > 0 ? d.sizeBytes : 0), 0);
}

// The manifest contract (V2) and its builder live in ONE pure module, shared
// with the native-fixture contract tests and the API seal test.
export {
  SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
  buildContinuousManifest,
  deriveSessionCompleteness,
  reconcileContinuousUploads,
  ContinuousManifestError,
  type DeclaredSegment,
} from "./continuous-manifest";

export interface StagedContinuousCapture {
  /** Handed to `continuous-complete` at finalize. */
  manifestJson: string;
  /** Segments in the record (declared). */
  segmentCount: number;
  /** Segments the recorder produced (UC-STR-002). */
  recordedSegmentCount: number;
  sessionCompleteness: string;
}

export type ContinuousCaptureEvidence = {
  evidenceId: string;
  segmentCount: number;
  sessionCompleteness: string;
};

async function fileSizeBytes(uri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(uri, { size: true });
  return info.exists && typeof info.size === "number" ? info.size : 0;
}

/**
 * Delete a local temp file, ignoring absence. Called ONLY after a segment's bytes
 * are durably in storage (PUT succeeded) — the local mp4 is then no longer the only
 * copy, and completion re-hashes from storage, never from the device. Bounds
 * on-disk accumulation during a long session.
 */
async function deleteLocalFileQuietly(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // A temp file we cannot delete is a P3 disk-hygiene issue, never a
    // correctness one; the OS reclaims the app cache under pressure.
  }
}

/**
 * Best-effort cleanup of any continuous-capture temp files left for THIS session in
 * the app cache (segments + the manifest). Called on Discard (pre-finalize) and
 * after a successful seal. Session-scoped by the `startedAtMs`-derived name prefix
 * the native service uses, so it never touches another session's or another
 * feature's files.
 */
export async function cleanupContinuousTempFiles(
  segments: Array<Pick<ScreenSegment, "uri">>,
  manifestUri?: string,
): Promise<void> {
  for (const s of segments) await deleteLocalFileQuietly(s.uri);
  if (manifestUri) await deleteLocalFileQuietly(manifestUri);
}

/** Open the PROOVRA session + reserve ONE Evidence for the whole session. */
export async function beginContinuousSession(
  /** ET-DC-08 — the ACTIVE workspace, as /capture passes it (see stageScreenCapture). */
  options: { teamId?: string | null } = {},
): Promise<{ session: DirectCaptureSession; evidenceId: string }> {
  // The server-issued session carries the platform-correct canonical mode:
  // iOS (UC-5, Apple system broadcast) vs Android (UC-3, MediaProjection). Both
  // seal through the ONE canonical continuous pipeline; the server is authoritative.
  const mode =
    Platform.OS === "ios" ? "DIRECT_SCREEN_CAPTURE_IOS" : "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS";
  const session = await openDirectCaptureSession(mode, { teamId: options.teamId ?? null });
  const evidenceId = await reserveDirectCaptureEvidence(session, {
    type: "VIDEO",
    mimeType: "video/mp4",
    deviceTimeIso: new Date().toISOString(),
  });
  return { session, evidenceId };
}

/**
 * Upload + declare ONE segment (partIndex = segment sequence). Returns the
 * declared metadata for the manifest. Bounded retry on transient failure.
 */
export async function uploadContinuousSegment(
  session: DirectCaptureSession,
  evidenceId: string,
  seg: ScreenSegment,
  retries = SCREEN_CONTINUOUS_STREAM_BOUNDS.uploadRetries,
): Promise<DeclaredSegment> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      // Measure size BEFORE upload (we delete the local file right after a
      // durable PUT, so it may be gone afterwards).
      const sizeBytes = await fileSizeBytes(seg.uri);
      const up = await uploadDirectCaptureItem(session, evidenceId, {
        partIndex: seg.sequence,
        uri: seg.uri,
        mimeType: "video/mp4",
        originalFilename: `segment-${seg.sequence}.mp4`,
        source: "SCREEN_SEGMENT",
      });
      // Bytes are now durably in storage; drop the only-on-device copy so a long
      // session cannot accumulate unbounded temp mp4s. Completion re-hashes from
      // storage, never from this file.
      await deleteLocalFileQuietly(seg.uri);
      return {
        partIndex: seg.sequence,
        sequence: seg.sequence,
        sha256Hex: up.sha256Hex,
        sizeBytes,
        startedAtOffsetMs: seg.startedAtOffsetMs,
        durationMs: seg.durationMs,
        widthPx: seg.widthPx,
        heightPx: seg.heightPx,
        orientation: seg.orientation,
      };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, SCREEN_CONTINUOUS_STREAM_BOUNDS.retryBackoffMs * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("segment upload failed");
}

/**
 * PURE — the recorded segments this client saw but never declared (their
 * upload failed for good during recording). Finalize retries them from disk
 * before the manifest is built (UC-STR-002); whatever is still missing is
 * stated as SEGMENT_UPLOAD_LOST, never sealed over.
 */
export function undeclaredSegments<T extends Pick<ScreenSegment, "sequence">>(
  seen: ReadonlyArray<T>,
  declared: ReadonlyArray<Pick<DeclaredSegment, "sequence">>,
): T[] {
  const have = new Set(declared.map((d) => d.sequence));
  const out = new Map<number, T>();
  for (const s of seen) if (!have.has(s.sequence)) out.set(s.sequence, s);
  return [...out.values()].sort((a, b) => a.sequence - b.sequence);
}

/**
 * Stage the continuous session: build and upload the continuity manifest.
 *
 * This used to complete the session as well, which is what made this surface a
 * second product ending. The completion is now the canonical Finish & Sign,
 * which calls `continuous-complete` with the manifest returned here.
 *
 * Called after Stop, after the upload queue drained and undeclared segments
 * were retried. UC-STR-002 — the manifest states what was RECORDED as well as
 * what was declared: a shortfall makes it INTERRUPTED_SESSION with
 * SEGMENT_UPLOAD_LOST, and the manifest part goes after every declared
 * segment (max partIndex + 1), so a lost middle segment no longer collides.
 */
export async function stageContinuousCapture(
  session: DirectCaptureSession,
  evidenceId: string,
  result: ScreenContinuousResult,
  declared: DeclaredSegment[],
  extraLimitations: ReadonlyArray<string> = [],
): Promise<StagedContinuousCapture> {
  if (declared.length === 0) throw new Error("No screen segments were captured.");

  const { manifestPartIndex } = reconcileContinuousUploads(result, declared, extraLimitations);
  const manifest = buildContinuousManifest(session.captureSessionId, result, declared, extraLimitations);
  const manifestJson = JSON.stringify(manifest);
  const manifestUri = `${FileSystem.cacheDirectory}proovra-continuous-manifest-${session.captureSessionId}.json`;
  await FileSystem.writeAsStringAsync(manifestUri, manifestJson);
  await uploadDirectCaptureItem(session, evidenceId, {
    partIndex: manifestPartIndex,
    uri: manifestUri,
    mimeType: "application/json",
    originalFilename: "continuous-capture-manifest.json",
    source: "CONTINUOUS_MANIFEST",
  });

  // The manifest is uploaded as a part and ALSO returned: the part is what the
  // record carries, and the returned copy is what the canonical finalize hands
  // to `continuous-complete`. Sending it here would be the seal this function
  // no longer performs.
  await deleteLocalFileQuietly(manifestUri);

  return {
    manifestJson,
    segmentCount: declared.length,
    recordedSegmentCount: manifest.recordedSegmentCount,
    sessionCompleteness: manifest.sessionCompleteness,
  };
}
