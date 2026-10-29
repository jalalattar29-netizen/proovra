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
  discardDirectCaptureSession,
  openDirectCaptureSession,
  reserveDirectCaptureEvidence,
  uploadDirectCaptureItem,
  type DirectCaptureSession,
} from "./direct-capture";
import {
  classifyCaptureError,
  DEFAULT_CAPTURE_RETRY,
  isSessionGone,
  localFileMissingError,
  retryCapture,
  type RetryPolicy,
} from "./capture/capture-retry";
import type { PendingScreenStaging } from "./capture/screen-staging-store";
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
  // A frame whose file is gone cannot be staged by any retry (terminal).
  if (!info.exists) throw localFileMissingError("A captured frame");
  return typeof info.size === "number" ? info.size : 0;
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
 * (possibly sensitive) must not outlive their purpose: they are deleted once
 * the staged session is committed to the canonical capture record, on the
 * user's explicit Discard, or after a TERMINAL staging refusal. AUD-005 — never
 * after a retryable failure: they may be the only copy.
 */
export async function discardScreenCaptureFiles(
  result: Pick<ScreenCaptureResult, "frames"> | null | undefined,
): Promise<void> {
  for (const f of result?.frames ?? []) await deleteLocalFileQuietly(f.uri);
}

/**
 * AUD-005 — a staging that could not finish. `retryable`: the failure was the
 * network, a timeout or a transient server answer — the session, the reserved
 * record, every confirmed frame and every local file are KEPT (`pending`), and
 * a Retry (now or after an app restart) resumes them. Not retryable: the
 * server refused the capture for good — the session was released and the
 * local frames deleted.
 */
export class ScreenStagingError extends Error {
  readonly retryable: boolean;
  readonly pending: PendingScreenStaging | null;
  readonly code: string | undefined;
  constructor(cause: unknown, retryable: boolean, pending: PendingScreenStaging | null) {
    super(cause instanceof Error && cause.message ? cause.message : "The screen capture could not be staged.");
    this.name = "ScreenStagingError";
    this.retryable = retryable;
    this.pending = pending;
    const code = (cause as { code?: unknown } | null)?.code;
    this.code = typeof code === "string" ? code : undefined;
  }
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
 *
 * AUD-005 — it is DURABLE and RETRYABLE. Its progress is handed to `persist`
 * as it happens (the screen keeps it in screen-staging-store), so `pending`
 * resumes the SAME session: the open, the reservation and every confirmed
 * frame are not repeated, and a re-sent frame is idempotent on the server
 * (same index + digest). Every request is time-bounded and retried with
 * backoff when the failure is retryable. NO local frame is deleted here: the
 * caller deletes them once the staged session is committed to the canonical
 * record (or on the user's explicit discard). Only a TERMINAL refusal releases
 * the session and deletes the frames.
 */
export async function stageScreenCapture(
  result: ScreenCaptureResult,
  options: {
    /**
     * ET-DC-08 — the ACTIVE workspace, as /capture passes it. Omitted, the
     * server files the capture in the personal workspace, misfiling team work
     * and refusing an identity that has no personal space.
     */
    teamId?: string | null;
    /**
     * Decision 2 — the location read BEFORE the capture started (Android's
     * consent), or why there is none, or NOT_REQUESTED. It goes into the
     * reservation as acquired; a retry reuses the persisted value.
     */
    location?: PendingScreenStaging["location"];
    /** A staging persisted by an earlier attempt (Retry, or an app restart). */
    pending?: PendingScreenStaging | null;
    /** Durable progress: called before the first request and after every step. */
    persist?: (pending: PendingScreenStaging) => Promise<void>;
    retry?: Partial<RetryPolicy>;
    timeouts?: { requestMs?: number; putMs?: number };
  } = {},
): Promise<StagedScreenCapture> {
  if (result.frames.length === 0) {
    throw new Error("No screen frames were captured.");
  }
  const policy: RetryPolicy = { ...DEFAULT_CAPTURE_RETRY, ...options.retry };
  let state: PendingScreenStaging = options.pending ?? {
    result: result as unknown as PendingScreenStaging["result"],
    teamId: options.teamId ?? null,
    location: options.location ?? null,
    session: null,
    evidenceId: null,
    declared: [],
    manifest: null,
    updatedAtIso: new Date().toISOString(),
  };
  const save = async (next: Partial<PendingScreenStaging>) => {
    state = { ...state, ...next, updatedAtIso: new Date().toISOString() };
    await options.persist?.(state);
  };
  const frames = state.result.frames;
  // The frames are recorded as pending BEFORE any network: a crash from here
  // on leaves a resumable staging, never silently lost screenshots.
  await save({});

  const run = async (): Promise<StagedScreenCapture> => {
    let session = state.session;
    if (!session) {
      const opened = await retryCapture(
        () => openDirectCaptureSession("DIRECT_SCREEN_CAPTURE_ANDROID", { teamId: state.teamId }),
        policy,
      );
      session = opened;
      await save({ session: opened });
    }
    let evidenceId = state.evidenceId;
    if (!evidenceId) {
      const s = session;
      evidenceId = await retryCapture(
        () =>
          reserveDirectCaptureEvidence(s, {
            type: "PHOTO",
            mimeType: "image/png",
            deviceTimeIso: state.result.captureStartedAtUtc,
            ...(state.location?.gps ? { gps: state.location.gps } : {}),
            ...(!state.location?.gps && state.location?.locationRequestOutcome
              ? { locationRequestOutcome: state.location.locationRequestOutcome }
              : {}),
          }),
        policy,
      );
      await save({ evidenceId });
    }

    for (let i = 0; i < frames.length; i += 1) {
      if (state.declared.some((d) => d.partIndex === i)) continue;
      const frame = frames[i];
      const sizeBytes = await fileSizeBytes(frame.uri);
      const s = session;
      const ev = evidenceId;
      const up = await retryCapture(
        () =>
          uploadDirectCaptureItem(
            s,
            ev,
            {
              partIndex: i,
              uri: frame.uri,
              mimeType: "image/png",
              originalFilename: `screen-frame-${frame.frameIndex}.png`,
              source: "SCREEN_FRAME",
            },
            options.timeouts,
          ),
        policy,
      );
      await save({
        declared: [
          ...state.declared,
          {
            partIndex: i,
            frameIndex: frame.frameIndex,
            sha256Hex: up.sha256Hex,
            sizeBytes,
            widthPx: frame.widthPx,
            heightPx: frame.heightPx,
            capturedAtOffsetMs: frame.capturedAtOffsetMs,
          },
        ].sort((a, b) => a.partIndex - b.partIndex),
      });
    }

    // The manifest is FIXED before its first upload, so a retry declares the
    // same bytes at the same part (idempotent) rather than a second manifest.
    let manifest = state.manifest;
    if (!manifest) {
      const built = buildScreenManifest(session.captureSessionId, state.result as unknown as ScreenCaptureResult, state.declared);
      manifest = { manifestJson: JSON.stringify(built), manifestPartIndex: frames.length };
      await save({ manifest });
    }
    const fixed = manifest;
    const manifestUri = `${FileSystem.cacheDirectory}proovra-screen-manifest-${session.captureSessionId}.json`;
    await FileSystem.writeAsStringAsync(manifestUri, fixed.manifestJson);
    const s = session;
    const ev = evidenceId;
    await retryCapture(
      () =>
        uploadDirectCaptureItem(
          s,
          ev,
          {
            partIndex: fixed.manifestPartIndex,
            uri: manifestUri,
            mimeType: "application/json",
            originalFilename: "screen-capture-manifest.json",
            source: "SCREEN_MANIFEST",
          },
          options.timeouts,
        ),
      policy,
    );
    await deleteLocalFileQuietly(manifestUri);

    // The manifest travels with the session rather than being sent now: the
    // canonical finalize hands it to `screen-complete` when the operator
    // finishes. Sending it here would be the seal this function no longer does.
    return {
      session,
      evidenceId,
      manifestJson: fixed.manifestJson,
      frameCount: frames.length,
      sizeBytes: state.declared.reduce((total, d) => total + d.sizeBytes, 0),
      stopReason: state.result.stopReason,
    };
  };

  let sessionRestarts = 0;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (state.session && sessionRestarts < 1 && (isSessionGone(err) || code === "SESSION_ALREADY_RESERVED")) {
        // The server closed THIS session (expired, reaped) or a reservation's
        // answer was lost: the frames are still here, so stage them into a new
        // session once. The old one is released.
        sessionRestarts += 1;
        await discardDirectCaptureSession(state.session).catch(() => undefined);
        await save({ session: null, evidenceId: null, declared: [], manifest: null });
        continue;
      }
      if (classifyCaptureError(err) === "RETRYABLE") {
        // Network, timeout, 5xx/429: nothing is released and nothing deleted.
        throw new ScreenStagingError(err, true, state);
      }
      // A refusal no retry can change: release the reservation (never leave a
      // custody-logged empty record) and delete the frames (UC-AND-010).
      if (state.session) await discardDirectCaptureSession(state.session).catch(() => undefined);
      await discardScreenCaptureFiles(state.result);
      throw new ScreenStagingError(err, false, null);
    }
  }
}
