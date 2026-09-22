/**
 * UC-2 — the mobile app's client for Android Direct Screen Capture.
 *
 * The native capture is USER-DRIVEN (start → the user triggers each frame from the
 * notification or the in-app button → stop). Only AFTER the user stops does this
 * client seal the frames into ONE Evidence record through the SAME canonical
 * direct-capture session the camera flow uses (open → reserve → declare part
 * digests → canonical presign/PUT → screen-complete). It creates NO second
 * evidence path; the PROOVRA session is opened at finalize (so a slow capture
 * cannot expire it), and the server recomputes every frame's SHA-256.
 */
import * as FileSystem from "expo-file-system";

import {
  openDirectCaptureSession,
  sealDirectCapture,
  reserveDirectCaptureEvidence,
  uploadDirectCaptureItem,
  type DirectCaptureSession,
} from "./direct-capture";
import { apiFetch } from "./api";
import type { ScreenCaptureResult } from "../modules/proovra-screen-capture";

export const SCREEN_MANIFEST_SCHEMA_VERSION = "PROOVRA_SCREEN_CAPTURE_MANIFEST_V1";

export type ScreenCaptureEvidence = {
  evidenceId: string;
  frameCount: number;
  stopReason: string;
};

/** PURE: derive the manifest completeness from the native result. Unit-tested. */
export function deriveScreenCompleteness(
  result: Pick<ScreenCaptureResult, "frames" | "stopReason" | "limitations">,
): "CAPTURED" | "PARTIAL" | "FAILED" {
  if (result.frames.length === 0) return "FAILED";
  if (result.stopReason === "USER_STOPPED" || result.stopReason === "BOUNDS_REACHED") {
    return result.limitations.length > 0 ? "PARTIAL" : "CAPTURED";
  }
  return "PARTIAL";
}

/**
 * PURE: build the screen-capture manifest from the native result + the declared
 * frame digests/sizes. Unit-tested so the manifest shape stays correct without a
 * device.
 */
export function buildScreenManifest(
  sessionId: string,
  result: ScreenCaptureResult,
  frames: Array<{ partIndex: number; frameIndex: number; sha256Hex: string; sizeBytes: number; widthPx: number; heightPx: number; capturedAtOffsetMs: number }>,
) {
  return {
    schemaVersion: SCREEN_MANIFEST_SCHEMA_VERSION,
    captureSessionId: sessionId,
    captureStartedAtUtc: result.captureStartedAtUtc,
    captureEndedAtUtc: result.captureEndedAtUtc,
    device: result.device,
    osConsentGranted: result.osConsentGranted,
    artifacts: frames.map((f) => ({
      role: "screen_frame",
      partIndex: f.partIndex,
      frameIndex: f.frameIndex,
      expectedSha256: f.sha256Hex,
      sizeBytes: f.sizeBytes,
      mediaType: "image/png",
      widthPx: f.widthPx,
      heightPx: f.heightPx,
      capturedAtOffsetMs: f.capturedAtOffsetMs,
      completeness: "CAPTURED",
    })),
    completeness: deriveScreenCompleteness(result),
    stopReason: result.stopReason,
    limitations: result.limitations,
    notes: [],
  };
}

async function fileSizeBytes(uri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(uri, { size: true });
  return info.exists && typeof info.size === "number" ? info.size : 0;
}

/**
 * Seal a completed native capture into ONE canonical Evidence record. Called
 * AFTER the user stops the native session, from the review screen's Finalize.
 */
export async function finalizeScreenCapture(result: ScreenCaptureResult): Promise<ScreenCaptureEvidence> {
  if (result.frames.length === 0) {
    throw new Error("No screen frames were captured.");
  }

  const session: DirectCaptureSession = await openDirectCaptureSession("DIRECT_SCREEN_CAPTURE_ANDROID");

  // Everything after the reservation goes through the ONE rule: seal, or
  // release. A failure between reserving the record and completing it used to
  // leave a custody-logged empty record in the owner's library, and nothing
  // in the product ever removed it.
  return sealDirectCapture(session, async () => {
  const evidenceId = await reserveDirectCaptureEvidence(session, {
    type: "PHOTO",
    mimeType: "image/png",
    deviceTimeIso: result.captureStartedAtUtc,
  });

  const declared: Array<{ partIndex: number; frameIndex: number; sha256Hex: string; sizeBytes: number; widthPx: number; heightPx: number; capturedAtOffsetMs: number }> = [];
  for (let i = 0; i < result.frames.length; i += 1) {
    const frame = result.frames[i];
    const up = await uploadDirectCaptureItem(session, evidenceId, {
      partIndex: i,
      uri: frame.uri,
      mimeType: "image/png",
      originalFilename: `screen-frame-${frame.frameIndex}.png`,
      source: "SCREEN_FRAME",
    });
    declared.push({
      partIndex: i,
      frameIndex: frame.frameIndex,
      sha256Hex: up.sha256Hex,
      sizeBytes: await fileSizeBytes(frame.uri),
      widthPx: frame.widthPx,
      heightPx: frame.heightPx,
      capturedAtOffsetMs: frame.capturedAtOffsetMs,
    });
  }

  const manifestPartIndex = result.frames.length;
  const manifest = buildScreenManifest(session.captureSessionId, result, declared);
  const manifestJson = JSON.stringify(manifest);
  const manifestUri = `${FileSystem.cacheDirectory}proovra-screen-manifest-${session.captureSessionId}.json`;
  await FileSystem.writeAsStringAsync(manifestUri, manifestJson);
  await uploadDirectCaptureItem(session, evidenceId, {
    partIndex: manifestPartIndex,
    uri: manifestUri,
    mimeType: "application/json",
    originalFilename: "screen-capture-manifest.json",
    source: "SCREEN_MANIFEST",
  });

  const res = await apiFetch(
    `/v1/capture/direct-sessions/${session.captureSessionId}/screen-complete`,
    { method: "POST", body: JSON.stringify({ manifestJson }) },
  );
  const sealedId = res?.result?.evidenceId as string | undefined;
  if (!sealedId) throw new Error("Could not complete the screen capture.");

  return { evidenceId: sealedId, frameCount: result.frames.length, stopReason: result.stopReason };
  });
}
