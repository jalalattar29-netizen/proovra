/**
 * UC-3 / UC-5 — the mobile app's client for CONTINUOUS Screen Capture, shared by
 * Android (MediaProjection) and iOS (Apple system broadcast).
 *
 * The native recording is SEGMENTED and STREAMING: each finalized segment fires an
 * event, and this client uploads it through the SAME canonical direct-capture
 * session (open → reserve → declare digest → presign/PUT) WHILE recording
 * continues — bounded by the on-disk segment ceiling, never buffering the whole
 * session in RAM. On Stop the client drains any pending uploads, builds the
 * continuity manifest referencing the declared segments, uploads it, and seals ONE
 * Evidence through /continuous-complete. Server recomputes every segment digest.
 *
 * The PROOVRA session is opened at START (so segments upload during recording);
 * the bounded session (<= maxSegments * segmentMs) fits inside the capture-session
 * TTL. It creates NO second evidence path.
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
import { apiFetch } from "./api";
import type {
  ScreenContinuousResult,
  ScreenSegment,
} from "../modules/proovra-screen-capture";

export const SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION =
  "PROOVRA_SCREEN_CAPTURE_CONTINUOUS_MANIFEST_V1";

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

export type ContinuousCaptureEvidence = {
  evidenceId: string;
  segmentCount: number;
  sessionCompleteness: string;
};

/** PURE: map native limitation-ish reason to the manifest session-completeness. */
export function deriveSessionCompleteness(
  result: Pick<ScreenContinuousResult, "sessionCompleteness" | "segmentCount">,
): "COMPLETE_SESSION" | "INTERRUPTED_SESSION" {
  if (result.segmentCount <= 0) return "INTERRUPTED_SESSION";
  return result.sessionCompleteness === "COMPLETE_SESSION" ? "COMPLETE_SESSION" : "INTERRUPTED_SESSION";
}

/** PURE: build the continuity manifest. Unit-tested — no device needed. */
export function buildContinuousManifest(
  sessionId: string,
  result: ScreenContinuousResult,
  segments: DeclaredSegment[],
) {
  const ordered = [...segments].sort((a, b) => a.sequence - b.sequence);
  return {
    schemaVersion: SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
    captureSessionId: sessionId,
    captureStartedAtUtc: result.captureStartedAtUtc,
    captureEndedAtUtc: result.captureEndedAtUtc,
    device: result.device,
    osConsentGranted: result.osConsentGranted,
    totalDurationMs: result.totalDurationMs,
    segments: ordered.map((s) => ({
      role: "screen_segment",
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
    sessionCompleteness: deriveSessionCompleteness(result),
    terminationReason: result.terminationReason,
    limitations: result.limitations,
    notes: [],
  };
}

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
export async function beginContinuousSession(): Promise<{ session: DirectCaptureSession; evidenceId: string }> {
  // The server-issued session carries the platform-correct canonical mode:
  // iOS (UC-5, Apple system broadcast) vs Android (UC-3, MediaProjection). Both
  // seal through the ONE canonical continuous pipeline; the server is authoritative.
  const mode =
    Platform.OS === "ios" ? "DIRECT_SCREEN_CAPTURE_IOS" : "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS";
  const session = await openDirectCaptureSession(mode);
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
 * Seal the continuous session: build + upload the continuity manifest, then
 * complete. Called after Stop and after all segments have been declared.
 */
export async function finalizeContinuousCapture(
  session: DirectCaptureSession,
  evidenceId: string,
  result: ScreenContinuousResult,
  declared: DeclaredSegment[],
): Promise<ContinuousCaptureEvidence> {
  if (declared.length === 0) throw new Error("No screen segments were captured.");

  const manifestPartIndex = declared.length;
  const manifest = buildContinuousManifest(session.captureSessionId, result, declared);
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

  const res = await apiFetch(
    `/v1/capture/direct-sessions/${session.captureSessionId}/continuous-complete`,
    { method: "POST", body: JSON.stringify({ manifestJson }) },
  );
  const sealedId = res?.result?.evidenceId as string | undefined;
  if (!sealedId) throw new Error("Could not complete the continuous capture.");

  // Sealed and server-verified — the local manifest temp file is no longer needed.
  await deleteLocalFileQuietly(manifestUri);

  return {
    evidenceId: sealedId,
    segmentCount: declared.length,
    sessionCompleteness: manifest.sessionCompleteness,
  };
}
