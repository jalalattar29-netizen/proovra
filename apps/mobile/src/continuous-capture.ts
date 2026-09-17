/**
 * UC-3 — the mobile app's client for Android CONTINUOUS Screen Capture.
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
import * as FileSystem from "expo-file-system";

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

/** Open the PROOVRA session + reserve ONE Evidence for the whole session. */
export async function beginContinuousSession(): Promise<{ session: DirectCaptureSession; evidenceId: string }> {
  const session = await openDirectCaptureSession("DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS");
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
  retries = 2,
): Promise<DeclaredSegment> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const up = await uploadDirectCaptureItem(session, evidenceId, {
        partIndex: seg.sequence,
        uri: seg.uri,
        mimeType: "video/mp4",
        originalFilename: `segment-${seg.sequence}.mp4`,
        source: "SCREEN_SEGMENT",
      });
      return {
        partIndex: seg.sequence,
        sequence: seg.sequence,
        sha256Hex: up.sha256Hex,
        sizeBytes: await fileSizeBytes(seg.uri),
        startedAtOffsetMs: seg.startedAtOffsetMs,
        durationMs: seg.durationMs,
        widthPx: seg.widthPx,
        heightPx: seg.heightPx,
        orientation: seg.orientation,
      };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
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

  return {
    evidenceId: sealedId,
    segmentCount: declared.length,
    sessionCompleteness: manifest.sessionCompleteness,
  };
}
