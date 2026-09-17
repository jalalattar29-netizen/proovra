/**
 * UC-2 — the mobile app's client for Android Direct Screen Capture.
 *
 * It reuses the SAME canonical direct-capture session the camera flow uses
 * (open → reserve → declare part digests → canonical presign/PUT), then seals
 * with a screen-capture manifest through `/screen-complete` — mirroring UC-1 web
 * capture. It creates NO second evidence path.
 *
 *   1. run the native bounded MediaProjection capture (consent + frames),
 *   2. open a session with mode DIRECT_SCREEN_CAPTURE_ANDROID,
 *   3. reserve ONE Evidence record,
 *   4. upload + declare each PNG frame (clientReportedSource SCREEN_FRAME),
 *   5. build the screen-capture manifest referencing the declared frame digests,
 *   6. upload + declare the manifest bytes (SCREEN_MANIFEST),
 *   7. seal through POST /screen-complete — the server recomputes every digest.
 *
 * The mode lives on the server-issued session; the app cannot self-assign it.
 * The server recomputes each frame's SHA-256 and refuses the record before
 * signing if any declared digest is wrong.
 */
import * as FileSystem from "expo-file-system";

import {
  openDirectCaptureSession,
  reserveDirectCaptureEvidence,
  uploadDirectCaptureItem,
  type DirectCaptureSession,
} from "./direct-capture";
import { apiFetch } from "./api";
import {
  requestConsentAndCapture,
  type ScreenCaptureOptions,
  type ScreenCaptureResult,
} from "../modules/proovra-screen-capture";

const SCREEN_MANIFEST_SCHEMA_VERSION = "PROOVRA_SCREEN_CAPTURE_MANIFEST_V1";

export type ScreenCaptureEvidence = {
  evidenceId: string;
  frameCount: number;
  stopReason: string;
};

function deriveCompleteness(capture: ScreenCaptureResult): "CAPTURED" | "PARTIAL" | "FAILED" {
  if (capture.frames.length === 0) return "FAILED";
  if (capture.stopReason === "USER_STOPPED" || capture.stopReason === "BOUNDS_REACHED") {
    return capture.limitations.length > 0 ? "PARTIAL" : "CAPTURED";
  }
  return "PARTIAL";
}

async function fileSizeBytes(uri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(uri, { size: true });
  return info.exists && typeof info.size === "number" ? info.size : 0;
}

/**
 * Run the full UC-2 screen-capture flow and return the sealed Evidence id. The
 * caller supplies the workspace/case context the reserve step needs.
 */
export async function captureScreenToEvidence(
  options: ScreenCaptureOptions = {},
): Promise<ScreenCaptureEvidence> {
  // 1. Native bounded capture (consent dialog + frames). Nothing has entered
  //    PROOVRA yet — this is purely on-device until we upload below.
  const capture = await requestConsentAndCapture(options);
  if (!capture.osConsentGranted || capture.frames.length === 0) {
    throw new Error("No screen frames were captured.");
  }

  // 2. Open the session for the UC-2 acquisition mode.
  const session: DirectCaptureSession = await openDirectCaptureSession("DIRECT_SCREEN_CAPTURE_ANDROID");

  // 3. Reserve one Evidence record for the whole session.
  const evidenceId = await reserveDirectCaptureEvidence(session, {
    type: "PHOTO",
    mimeType: "image/png",
    deviceTimeIso: capture.captureStartedAtUtc,
  });

  // 4. Upload + declare each frame; collect the declared digests for the manifest.
  const artifacts: Array<Record<string, unknown>> = [];
  for (let i = 0; i < capture.frames.length; i += 1) {
    const frame = capture.frames[i];
    const declared = await uploadDirectCaptureItem(session, evidenceId, {
      partIndex: i,
      uri: frame.uri,
      mimeType: "image/png",
      originalFilename: `screen-frame-${frame.frameIndex}.png`,
      source: "SCREEN_FRAME",
    });
    artifacts.push({
      role: "screen_frame",
      partIndex: i,
      frameIndex: frame.frameIndex,
      expectedSha256: declared.sha256Hex,
      sizeBytes: await fileSizeBytes(frame.uri),
      mediaType: "image/png",
      widthPx: frame.widthPx,
      heightPx: frame.heightPx,
      capturedAtOffsetMs: frame.capturedAtOffsetMs,
      completeness: "CAPTURED",
    });
  }

  // 5. Build the screen-capture manifest referencing the declared frames.
  const manifestPartIndex = capture.frames.length;
  const manifest = {
    schemaVersion: SCREEN_MANIFEST_SCHEMA_VERSION,
    captureSessionId: session.captureSessionId,
    captureStartedAtUtc: capture.captureStartedAtUtc,
    captureEndedAtUtc: capture.captureEndedAtUtc,
    device: capture.device,
    osConsentGranted: capture.osConsentGranted,
    artifacts,
    completeness: deriveCompleteness(capture),
    stopReason: capture.stopReason,
    limitations: capture.limitations,
    notes: [],
  };
  const manifestJson = JSON.stringify(manifest);

  // 6. Upload + declare the manifest bytes as the CAPTURE_MANIFEST part.
  const manifestUri = `${FileSystem.cacheDirectory}proovra-screen-manifest-${session.captureSessionId}.json`;
  await FileSystem.writeAsStringAsync(manifestUri, manifestJson);
  await uploadDirectCaptureItem(session, evidenceId, {
    partIndex: manifestPartIndex,
    uri: manifestUri,
    mimeType: "application/json",
    originalFilename: "screen-capture-manifest.json",
    source: "SCREEN_MANIFEST",
  });

  // 7. Seal. The server recomputes every frame + manifest digest and refuses the
  //    record before signing if any declared digest is wrong.
  const res = await apiFetch(
    `/v1/capture/direct-sessions/${session.captureSessionId}/screen-complete`,
    { method: "POST", body: JSON.stringify({ manifestJson }) },
  );
  const sealedId = res?.result?.evidenceId as string | undefined;
  if (!sealedId) throw new Error("Could not complete the screen capture.");

  return {
    evidenceId: sealedId,
    frameCount: capture.frames.length,
    stopReason: capture.stopReason,
  };
}
