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
import { EventEmitter, requireNativeModule } from "expo-modules-core";

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
