/**
 * UC-2 — PROOVRA Android Direct Screen Capture native module (JS binding).
 *
 * A thin, typed JS surface over the Android MediaProjection native module. It is
 * Android-only; on any other platform every call rejects. The native side:
 *   1. requests Android's MediaProjection consent (a system dialog — nothing is
 *      captured before the user grants it),
 *   2. runs a bounded foreground-service capture (a small number of frames — this
 *      is UC-2's SHORT session, never continuous recording, which is UC-3),
 *   3. writes each frame as a PNG in the app's cache and returns file:// URIs
 *      plus coarse display/device context and any limitations,
 *   4. stops promptly on the notification's Stop action, on `stop()`, or when the
 *      frame/time bound is reached, and reports why it stopped.
 *
 * It never captures outside the OS-authorised session, never bypasses FLAG_SECURE
 * (secure windows come back blank and are reported), and collects NO app
 * inventory, notifications, clipboard, contacts or hardware identifiers.
 */
import { Platform } from "react-native";
import { requireNativeModule } from "expo-modules-core";

export type ScreenCaptureStopReason =
  | "USER_STOPPED"
  | "BOUNDS_REACHED"
  | "INTERRUPTED"
  | "PERMISSION_REVOKED"
  | "ERROR";

export type ScreenCaptureLimitationCode =
  | "SECURE_CONTENT_OMITTED"
  | "ORIENTATION_CHANGED_DURING_CAPTURE"
  | "CAPTURE_BOUNDS_EXCEEDED"
  | "CAPTURE_INTERRUPTED"
  | "SCREEN_CONTENT_CHANGED_DURING_CAPTURE";

export type ScreenCaptureFrame = {
  /** file:// URI of the PNG frame in the app cache. */
  uri: string;
  frameIndex: number;
  widthPx: number;
  heightPx: number;
  /** ms after captureStartedAtUtc. */
  capturedAtOffsetMs: number;
};

export type ScreenCaptureResult = {
  /** True only after the OS consent dialog was granted. */
  osConsentGranted: boolean;
  captureStartedAtUtc: string;
  captureEndedAtUtc: string;
  device: {
    platform: "android";
    osVersion: string;
    model: string;
    appVersion: string;
    screenW: number;
    screenH: number;
    densityDpi: number;
    orientation: "portrait" | "landscape";
  };
  frames: ScreenCaptureFrame[];
  stopReason: ScreenCaptureStopReason;
  limitations: ScreenCaptureLimitationCode[];
};

export type ScreenCaptureOptions = {
  /** Hard ceiling on frames (native clamps to a safe max; UC-2 is a short session). */
  maxFrames?: number;
  /** Delay between frames in ms. */
  intervalMs?: number;
};

type NativeModule = {
  isSupported(): boolean;
  /** Requests consent, runs the bounded capture, resolves when the session ends. */
  requestConsentAndCapture(options: {
    maxFrames: number;
    intervalMs: number;
  }): Promise<ScreenCaptureResult>;
  /** Stops an in-flight capture promptly (idempotent). */
  stop(): Promise<void>;
};

let cached: NativeModule | undefined;
function nativeModule(): NativeModule {
  const mod = cached ?? requireNativeModule<NativeModule>("ProovraScreenCapture");
  cached = mod;
  return mod;
}

export function isScreenCaptureSupported(): boolean {
  if (Platform.OS !== "android") return false;
  try {
    return nativeModule().isSupported();
  } catch {
    return false;
  }
}

const DEFAULT_MAX_FRAMES = 8;
const DEFAULT_INTERVAL_MS = 750;

/**
 * Request Android consent and run a bounded screen capture. Resolves with the
 * captured frames + context when the session ends (user stop, bound reached, or
 * interruption). Rejects if consent is denied or the platform is not Android.
 */
export async function requestConsentAndCapture(
  options: ScreenCaptureOptions = {},
): Promise<ScreenCaptureResult> {
  if (Platform.OS !== "android") {
    throw new Error("Direct Screen Capture is available on Android only.");
  }
  return nativeModule().requestConsentAndCapture({
    maxFrames: Math.max(1, Math.min(options.maxFrames ?? DEFAULT_MAX_FRAMES, 60)),
    intervalMs: Math.max(200, options.intervalMs ?? DEFAULT_INTERVAL_MS),
  });
}

export async function stopScreenCapture(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await nativeModule().stop();
  } catch {
    /* nothing in flight */
  }
}
