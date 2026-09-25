/**
 * UC-2 — PROOVRA Android Direct Screen Capture native module (JS binding).
 *
 * A thin, typed, EVENT-DRIVEN surface over the Android MediaProjection native
 * module. Android-only; on any other platform every call rejects. The user, not a
 * timer, decides when a frame is taken — so they can leave PROOVRA, display the
 * target content in another app, and trigger "Capture Frame" from the ongoing
 * capture NOTIFICATION (or, while PROOVRA is foreground, from the in-app button).
 * The notification and in-app actions invoke the SAME native authority.
 *
 * Flow:
 *   startCapture()   → Android consent dialog; on grant the session is ACTIVE and
 *                      a foreground-service notification with Capture Frame + Stop
 *                      actions appears. Nothing is captured yet.
 *   captureFrame()   → capture ONE frame now (same as the notification action).
 *   stopCapture()    → stop, release native resources, resolve with all frames.
 *   getState()       → { active, frameCount } for reconnect after an app switch.
 *   events           → onScreenFrame / onScreenCaptureStopped for live UI state.
 *
 * It never captures outside the OS-authorised session, never bypasses FLAG_SECURE
 * (secure windows come back blank and are reported), collects NO app inventory,
 * notifications, clipboard, contacts or hardware identifiers, and uses NO overlay
 * / draw-over-other-apps or Accessibility permission.
 */
import { Platform } from "react-native";
import { EventEmitter, requireNativeModule } from "expo";
import { SCREEN_CONTINUOUS_STREAM_BOUNDS } from "@proovra/shared";

type Subscription = { remove: () => void };

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
  uri: string;
  frameIndex: number;
  widthPx: number;
  heightPx: number;
  capturedAtOffsetMs: number;
};

export type ScreenCaptureDevice = {
  platform: "android";
  osVersion: string;
  model: string;
  appVersion: string;
  screenW: number;
  screenH: number;
  densityDpi: number;
  orientation: "portrait" | "landscape";
};

export type ScreenCaptureStarted = {
  osConsentGranted: boolean;
  captureStartedAtUtc: string;
  maxFrames: number;
};

export type ScreenCaptureResult = {
  osConsentGranted: boolean;
  captureStartedAtUtc: string;
  captureEndedAtUtc: string;
  device: ScreenCaptureDevice;
  frames: ScreenCaptureFrame[];
  stopReason: ScreenCaptureStopReason;
  limitations: ScreenCaptureLimitationCode[];
};

export type ScreenCaptureState = { active: boolean; frameCount: number };

export type ScreenCaptureOptions = {
  /** Hard ceiling on frames (native clamps to 60). UC-2 is a short session. */
  maxFrames?: number;
};

type NativeEvents = {
  onScreenFrame: (e: { frameIndex: number; frameCount: number }) => void;
  onScreenCaptureStopped: (e: ScreenCaptureResult) => void;
};

type NativeModuleType = {
  isSupported(): boolean;
  getState(): ScreenCaptureState;
  startCapture(options: { maxFrames: number }): Promise<ScreenCaptureStarted>;
  captureFrame(): Promise<{ frameIndex: number; frameCount: number }>;
  stopCapture(): Promise<ScreenCaptureResult>;
};

let cachedModule: NativeModuleType | undefined;
let cachedEmitter: InstanceType<typeof EventEmitter> | undefined;

function nativeModule(): NativeModuleType {
  const mod = cachedModule ?? requireNativeModule<NativeModuleType>("ProovraScreenCapture");
  cachedModule = mod;
  return mod;
}
function emitter(): InstanceType<typeof EventEmitter> {
  const em = cachedEmitter ?? new EventEmitter(nativeModule() as never);
  cachedEmitter = em;
  return em;
}

export function isScreenCaptureSupported(): boolean {
  if (Platform.OS !== "android") return false;
  try {
    return nativeModule().isSupported();
  } catch {
    return false;
  }
}

export function getScreenCaptureState(): ScreenCaptureState {
  if (Platform.OS !== "android") return { active: false, frameCount: 0 };
  try {
    return nativeModule().getState();
  } catch {
    return { active: false, frameCount: 0 };
  }
}

const DEFAULT_MAX_FRAMES = 20;

/** Request Android consent and START an active (but empty) capture session. */
export async function startScreenCapture(options: ScreenCaptureOptions = {}): Promise<ScreenCaptureStarted> {
  if (Platform.OS !== "android") {
    throw new Error("Direct Screen Capture is available on Android only.");
  }
  return nativeModule().startCapture({
    maxFrames: Math.max(1, Math.min(options.maxFrames ?? DEFAULT_MAX_FRAMES, 60)),
  });
}

/** Capture ONE frame now (same authority as the notification's Capture Frame). */
export async function captureScreenFrame(): Promise<{ frameIndex: number; frameCount: number }> {
  if (Platform.OS !== "android") throw new Error("Android only.");
  return nativeModule().captureFrame();
}

/** Stop the session, release native resources, and return all captured frames. */
export async function stopScreenCapture(): Promise<ScreenCaptureResult> {
  if (Platform.OS !== "android") throw new Error("Android only.");
  return nativeModule().stopCapture();
}

export function addScreenFrameListener(cb: NativeEvents["onScreenFrame"]): Subscription {
  return emitter().addListener("onScreenFrame", cb as never) as Subscription;
}
export function addScreenStoppedListener(cb: NativeEvents["onScreenCaptureStopped"]): Subscription {
  return emitter().addListener("onScreenCaptureStopped", cb as never) as Subscription;
}

// ===========================================================================
// UC-3 — CONTINUOUS (streaming) screen capture.
//
// Unlike the deliberate-frame mode, continuous capture RECORDS from consent until
// Stop, splitting the recording into bounded ORIGINAL SEGMENTS (short mp4s) via
// MediaRecorder. Each finalized segment fires `onScreenSegment` so the client can
// upload it WHILE recording continues (bounded streaming), and `getContinuousState`
// lets the UI reconnect after an app switch. Screen-only (no microphone/audio).
// ===========================================================================

export type ScreenContinuousStopReason =
  | "USER_STOPPED"
  | "BOUNDS_REACHED"
  | "INTERRUPTED"
  | "PERMISSION_REVOKED"
  | "ERROR";

export type ScreenSegment = {
  uri: string;
  sequence: number;
  startedAtOffsetMs: number;
  durationMs: number;
  widthPx: number;
  heightPx: number;
  orientation: "portrait" | "landscape";
};

export type ScreenContinuousStarted = {
  osConsentGranted: boolean;
  captureStartedAtUtc: string;
  segmentMs: number;
  maxSegments: number;
};

/**
 * The device that recorded a CONTINUOUS session, which is not always Android.
 *
 * `ScreenCaptureDevice` is pinned to `platform: "android"` and is right to
 * be: the deliberate-frame API above is Android-only. The continuous API is
 * shared with UC-5, where the iOS broadcast extension reports its own honest
 * `"ios"` (ProovraBroadcastShared.swift:59) — so the frame type was stating
 * something about an iOS session that was not true, and the manifest built
 * from it could not be validated by a server that also read "android" only.
 */
export type ScreenContinuousDevice = Omit<ScreenCaptureDevice, "platform"> & {
  platform: "android" | "ios";
};

export type ScreenContinuousResult = {
  osConsentGranted: boolean;
  captureStartedAtUtc: string;
  captureEndedAtUtc: string;
  device: ScreenContinuousDevice;
  totalDurationMs: number;
  segmentCount: number;
  sessionCompleteness: "COMPLETE_SESSION" | "INTERRUPTED_SESSION";
  terminationReason: ScreenContinuousStopReason;
  limitations: string[];
};

export type ScreenContinuousState = { active: boolean; segmentCount: number };

export type ScreenContinuousOptions = {
  /** Per-segment duration ms (native clamps to a safe range). */
  segmentMs?: number;
  /** Hard ceiling on segments (bounded session; native clamps to 600). */
  maxSegments?: number;
};

type ContinuousNativeModule = {
  isContinuousSupported(): boolean;
  getContinuousState(): ScreenContinuousState;
  startContinuousCapture(options: { segmentMs: number; maxSegments: number }): Promise<ScreenContinuousStarted>;
  stopContinuousCapture(): Promise<ScreenContinuousResult>;
};

function continuousModule(): ContinuousNativeModule {
  return nativeModule() as unknown as ContinuousNativeModule;
}

// Continuous screen capture is the shared surface for BOTH Android MediaProjection
// (UC-3) and iOS system broadcast (UC-5). The deliberate-frame API above stays
// Android-only. `isContinuousScreenPlatform` is the ONE platform gate for it.
function isContinuousScreenPlatform(): boolean {
  return Platform.OS === "android" || Platform.OS === "ios";
}

export function isScreenContinuousSupported(): boolean {
  if (!isContinuousScreenPlatform()) return false;
  try {
    return continuousModule().isContinuousSupported();
  } catch {
    return false;
  }
}

export function getScreenContinuousState(): ScreenContinuousState {
  if (!isContinuousScreenPlatform()) return { active: false, segmentCount: 0 };
  try {
    return continuousModule().getContinuousState();
  } catch {
    return { active: false, segmentCount: 0 };
  }
}

const DEFAULT_SEGMENT_MS = 6000;
const DEFAULT_MAX_SEGMENTS = SCREEN_CONTINUOUS_STREAM_BOUNDS.maxSegments;

export async function startContinuousCapture(
  options: ScreenContinuousOptions = {},
): Promise<ScreenContinuousStarted> {
  if (!isContinuousScreenPlatform())
    throw new Error("Continuous Screen Capture is available on Android and iOS only.");
  const B = SCREEN_CONTINUOUS_STREAM_BOUNDS;
  return continuousModule().startContinuousCapture({
    segmentMs: Math.max(B.minSegmentMs, Math.min(options.segmentMs ?? DEFAULT_SEGMENT_MS, B.maxSegmentMs)),
    maxSegments: Math.max(1, Math.min(options.maxSegments ?? DEFAULT_MAX_SEGMENTS, B.maxSegments)),
  });
}

export async function stopContinuousCapture(): Promise<ScreenContinuousResult> {
  if (!isContinuousScreenPlatform()) throw new Error("Android/iOS only.");
  return continuousModule().stopContinuousCapture();
}

export function addScreenSegmentListener(cb: (seg: ScreenSegment) => void): Subscription {
  return emitter().addListener("onScreenSegment", cb as never) as Subscription;
}
export function addContinuousStoppedListener(cb: (r: ScreenContinuousResult) => void): Subscription {
  return emitter().addListener("onScreenContinuousStopped", cb as never) as Subscription;
}
