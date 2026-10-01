/**
 * UC-2 — the mobile app's client for Android Direct Screen Capture.
 *
 * The native capture is USER-DRIVEN (start → the user triggers each frame from
 * the notification or the in-app button → stop). Only AFTER the user stops does
 * this client STAGE the frames through the SAME canonical direct-capture
 * session the camera flow uses: open → reserve → declare part digests →
 * canonical presign/PUT. The server recomputes every frame's SHA-256.
 *
 * IT DOES NOT SEAL. Completion is the canonical Finish & Sign in Capture
 * (F-08): this module used to call the completion route itself, which gave the
 * product two endings — one for screen recordings and one for everything else.
 * The manifest it builds travels with the session and is handed to
 * `screen-complete` by `completeAcquisition` when the operator finishes.
 *
 * The PROOVRA session is opened at stage time, so a slow capture cannot expire
 * it, and a discard before finalize releases the reservation.
 */
import * as FileSystem from "expo-file-system";

import {
  openDirectCaptureSession,
  sealDirectCapture,
  reserveDirectCaptureEvidence,
  uploadDirectCaptureItem,
  type DirectCaptureSession,
} from "./direct-capture";
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

/**
 * A screen capture that has been acquired and uploaded, but NOT sealed.
 *
 * The session and its reserved record exist; the parts are at storage with
 * their digests declared. What has not happened is the completion — that is
 * the canonical Finish & Sign, and until it runs there is no signed Evidence
 * and a discard releases everything.
 */
export interface StagedScreenCapture {
  session: DirectCaptureSession;
  evidenceId: string;
  /** Handed to `screen-complete` at finalize. */
  manifestJson: string;
  frameCount: number;
  sizeBytes: number;
  stopReason: string;
}

async function fileSizeBytes(uri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(uri, { size: true });
  return info.exists && typeof info.size === "number" ? info.size : 0;
}

async function deleteLocalFileQuietly(uri: string | null | undefined): Promise<void> {
  if (!uri) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Disk hygiene only; the OS reclaims the app cache under pressure.
  }
}

/**
 * UC-AND-010 — the full-resolution screenshots of whatever the user captured
 * (possibly sensitive) must not outlive their purpose. Each frame file is
 * deleted as soon as its bytes are durably at storage, the manifest file after
 * its upload, and every remaining file on Discard / Try Again / a failed stage.
 */
export async function discardScreenCaptureFiles(
  result: Pick<ScreenCaptureResult, "frames"> | null | undefined,
): Promise<void> {
  for (const f of result?.frames ?? []) await deleteLocalFileQuietly(f.uri);
}

/**
 * Stage a completed native capture into the canonical Capture lifecycle.
 *
 * This used to be `finalizeScreenCapture` and it SEALED — acquire, upload,
 * complete, Evidence — which is exactly what made this surface a second
 * product ending. It now stops one step short.
 *
 * What it returns is a session whose frames and manifest are uploaded and
 * verified-in-place, ready for the ONE finalization. The canonical Capture
 * surface resumes it, shows it beside anything else staged, and seals it at
 * Finish & Sign through `completeAcquisition`. Nothing is signed here, and a
 * discard before that point releases the reservation and commits nothing.
 */
export async function stageScreenCapture(
  result: ScreenCaptureResult,
  /**
   * ET-DC-08 — the ACTIVE workspace, as /capture passes it. Omitted, the
   * server files the capture in the personal workspace, misfiling team work
   * and refusing an identity that has no personal space.
   */
  options: { teamId?: string | null } = {},
): Promise<StagedScreenCapture> {
  if (result.frames.length === 0) {
    throw new Error("No screen frames were captured.");
  }

  const session: DirectCaptureSession = await openDirectCaptureSession("DIRECT_SCREEN_CAPTURE_ANDROID", {
    teamId: options.teamId ?? null,
  });

  // Everything after the reservation goes through the ONE rule: seal, or
  // release. A failure between reserving the record and completing it used to
  // leave a custody-logged empty record in the owner's library, and nothing
  // in the product ever removed it.
  try {
  return await sealDirectCapture(session, async () => {
  const evidenceId = await reserveDirectCaptureEvidence(session, {
    type: "PHOTO",
    mimeType: "image/png",
    deviceTimeIso: result.captureStartedAtUtc,
  });

  const declared: Array<{ partIndex: number; frameIndex: number; sha256Hex: string; sizeBytes: number; widthPx: number; heightPx: number; capturedAtOffsetMs: number }> = [];
  for (let i = 0; i < result.frames.length; i += 1) {
    const frame = result.frames[i];
    // Measured BEFORE the upload: the file is deleted once its PUT succeeds.
    const sizeBytes = await fileSizeBytes(frame.uri);
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
      sizeBytes,
      widthPx: frame.widthPx,
      heightPx: frame.heightPx,
      capturedAtOffsetMs: frame.capturedAtOffsetMs,
    });
    // UC-AND-010 — the bytes are at storage; drop the on-device screenshot.
    await deleteLocalFileQuietly(frame.uri);
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
  await deleteLocalFileQuietly(manifestUri);

  // The manifest travels with the session rather than being sent now: the
  // canonical finalize hands it to `screen-complete` when the operator
  // finishes. Sending it here would be the seal this function no longer does.
  return {
    session,
    evidenceId,
    manifestJson,
    frameCount: result.frames.length,
    sizeBytes: declared.reduce((total, d) => total + d.sizeBytes, 0),
    stopReason: result.stopReason,
  };
  });
  } catch (err) {
    // The session was released by sealDirectCapture; nothing may stay behind.
    await discardScreenCaptureFiles(result);
    throw err;
  }
}
