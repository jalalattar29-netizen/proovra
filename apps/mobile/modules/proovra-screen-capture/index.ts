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
 * It never captures outside the OS-authorised session and never bypasses
 * FLAG_SECURE. UC-AND-011: Android returns a secure window as BLACK pixels with
 * no error, so PROOVRA cannot detect it and does not claim to; a frame that
 * could not be read or written is reported as FRAME_CAPTURE_FAILED. It collects NO app inventory,
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
  | "SCREEN_CONTENT_CHANGED_DURING_CAPTURE"
  // UC-AND-011 — a frame read/write failed; never evidence of secure content.
  | "FRAME_CAPTURE_FAILED";

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

/**
 * What one Capture Frame request did. `frameIndex` is -1 for every status but
 * CAPTURED, so the status is what tells them apart:
 *  - CAPTURED  — a new frame was saved.
 *  - UNCHANGED — the screen produced no new image since the last frame (e.g. it
 *                did not change): nothing was saved; the UI should say so.
 *  - FAILED    — the image could not be read or written (FRAME_CAPTURE_FAILED).
 *  - STOPPED   — the session ended before the request was answered.
 * Absent on native builds before 2026-10-29 (read -1 there as "no frame").
 */
export type ScreenFrameStatus = "CAPTURED" | "UNCHANGED" | "FAILED" | "STOPPED";

export type ScreenFrameEvent = { frameIndex: number; frameCount: number; status?: ScreenFrameStatus };

type NativeEvents = {
  onScreenFrame: (e: ScreenFrameEvent) => void;
  onScreenCaptureStopped: (e: ScreenCaptureResult) => void;
};

type NativeModuleType = {
  isSupported(): boolean;
  getState(): ScreenCaptureState;
  startCapture(options: { maxFrames: number }): Promise<ScreenCaptureStarted>;
  captureFrame(): Promise<ScreenFrameEvent>;
  stopCapture(): Promise<ScreenCaptureResult>;
  getRecoveredScreenCapture?(): ScreenCaptureResult | null;
  clearScreenCaptureLedger?(): Promise<void>;
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

/**
 * Capture ONE frame now (same authority as the notification's Capture Frame).
 * `status` says whether a frame was saved (see ScreenFrameStatus).
 */
export async function captureScreenFrame(): Promise<ScreenFrameEvent> {
  if (Platform.OS !== "android") throw new Error("Android only.");
  return nativeModule().captureFrame();
}

/** Stop the session, release native resources, and return all captured frames. */
export async function stopScreenCapture(): Promise<ScreenCaptureResult> {
  if (Platform.OS !== "android") throw new Error("Android only.");
  return nativeModule().stopCapture();
}

/**
 * AUD-37 (2026-10-20) — a capture a process death interrupted: INTERRUPTED,
 * with every frame written before the death. Null when there is none (or on a
 * native build without the ledger).
 */
export function getRecoveredScreenCapture(): ScreenCaptureResult | null {
  if (Platform.OS !== "android") return null;
  try {
    const mod = nativeModule();
    if (typeof mod.getRecoveredScreenCapture !== "function") return null;
    const r = mod.getRecoveredScreenCapture();
    return r && typeof r === "object" && Array.isArray(r.frames) && r.frames.length > 0 ? r : null;
  } catch {
    return null;
  }
}

/** AUD-37 — the recovered capture was staged or discarded: the native ledger goes. */
export async function clearScreenCaptureLedger(): Promise<void> {
  if (Platform.OS !== "android") return;
  const mod = nativeModule();
  if (typeof mod.clearScreenCaptureLedger === "function") await mod.clearScreenCaptureLedger();
}

export function addScreenFrameListener(cb: NativeEvents["onScreenFrame"]): Subscription {
  return emitter().addListener("onScreenFrame", cb as never) as Subscription;
}
export function addScreenStoppedListener(cb: NativeEvents["onScreenCaptureStopped"]): Subscription {
  return emitter().addListener("onScreenCaptureStopped", cb as never) as Subscription;
}

// ===========================================================================
// UC-3 / UC-5 — CONTINUOUS screen recording.
//
// Unlike the deliberate-frame mode, continuous capture RECORDS from consent until
// Stop. Wire contract B (2026-10-29): ONE Start→Stop recording is ONE video file.
// New native builds (`layout: "SINGLE_FILE"` in the stop result):
//   - Android: ONE MediaRecorder for the whole session; iOS: ONE AVAssetWriter
//     writing a fragmented MP4 (a fragment every ~2 s, so an interrupted file
//     stays playable up to its last fragment).
//   - emit NO `onScreenSegment` events for new recordings; the stop result (and
//     `onScreenContinuousStopped`) carries the one file: `recordingUri`, its size,
//     duration and canvas, `orientationTimeline`, `pauses`, `droppedFrameCount`,
//     `audioTracks` and `finalized`. `finalized: false` means the writer could not
//     finish the file — it must never be presented as complete.
//   - a session bound (duration / bytes / free space) STOPS the recording with
//     BOUNDS_REACHED; it is never split.
//   - audio: iOS writes app audio and the microphone (the user's choice in Apple's
//     broadcast picker) only when ReplayKit delivers them; Android records the
//     microphone only with `startContinuousCapture({ microphone: true })` after
//     the user's in-app consent AND the RECORD_AUDIO runtime grant, and never
//     other apps' audio. `audioTracks` states what was actually written.
// Older native builds omit `layout` and stream bounded ORIGINAL SEGMENTS through
// `onScreenSegment`; the legacy segment types and calls below stay so those paths
// (and recordings they left on a device) still compile and recover.
// `getContinuousState` lets the UI reconnect after an app switch.
// ===========================================================================

export type ScreenContinuousStopReason =
  | "USER_STOPPED"
  | "BOUNDS_REACHED"
  | "INTERRUPTED"
  | "PERMISSION_REVOKED"
  | "ERROR"
  // UC-IOS-006 — the recorder's summary is missing (extension killed).
  | "UNKNOWN";

export type ScreenSegment = {
  /**
   * AUD-006 — iOS: the broadcast recording (spool namespace) this segment
   * belongs to. A segment of another recording is never uploaded into a session.
   */
  recordingId?: string;
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
  /** Null while the OS has not yet started recording (iOS: picker shown). */
  captureStartedAtUtc: string | null;
  segmentMs: number;
  maxSegments: number;
  /**
   * UC-IOS-005 — iOS resolves when Apple's broadcast picker is PRESENTED, which
   * is not consent and not a start. True means: wait for
   * `onScreenContinuousStarted` (the extension's broadcastStarted) before
   * treating the session as recording; the user may still cancel the picker.
   */
  awaitingSystemStart?: boolean;
  /**
   * AUD-006 — iOS: the recording the app bound BEFORE showing the picker. Only
   * a broadcast that adopted this binding is this recording.
   */
  recordingId?: string;
  /** Android, new builds: the recorder writes ONE file. */
  layout?: ScreenContinuousLayout;
  /** Android, new builds: the microphone was asked for (`audioTracks` in the result says if it was written). */
  microphoneRequested?: boolean;
};

/** AUD-006 — iOS: how a broadcast recording is bound. */
export type ScreenContinuousBinding = "BOUND" | "UNBOUND" | "NONE";

/**
 * UC-IOS-005 — the OS actually began recording. AUD-006 — on iOS it names the
 * recording and its binding: a broadcast started from Control Center is
 * UNBOUND and never opens a capture session.
 */
export type ScreenContinuousStartedEvent = {
  captureStartedAtUtc: string;
  recordingId?: string;
  binding?: ScreenContinuousBinding;
  appRequested?: boolean;
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

/** Wire contract A/B — the recording layout. Absent on legacy native builds ⇒ segmented. */
export type ScreenContinuousLayout = "SINGLE_FILE";

/** Wire contract A — one orientation of the recorded display (first entry = the initial one). */
export type ScreenContinuousOrientationEntry = {
  atOffsetMs: number;
  orientation: "portrait" | "landscape";
  widthPx?: number;
  heightPx?: number;
};

/** Wire contract A — wall time with no frames (iOS broadcast pause), on the session timeline. */
export type ScreenContinuousPause = { startOffsetMs: number; endOffsetMs: number };

/** Wire contract A — an audio track ACTUALLY written to the file. */
export type ScreenContinuousAudioTrack = "APP" | "MICROPHONE";

export type ScreenContinuousResult = {
  /** AUD-006 — iOS: the recording this result belongs to (null: none ever started). */
  recordingId?: string | null;
  osConsentGranted: boolean;
  captureStartedAtUtc: string;
  captureEndedAtUtc: string;
  device: ScreenContinuousDevice;
  totalDurationMs: number;
  segmentCount: number;
  sessionCompleteness: "COMPLETE_SESSION" | "INTERRUPTED_SESSION";
  terminationReason: ScreenContinuousStopReason;
  /**
   * AUD-029 — Android: the STABLE code of what failed (RECORDER_ERROR_<what>,
   * ENCODER_UNSUPPORTED_SIZE, SEGMENT_START_FAILED); null/absent on a clean end.
   */
  terminationDetail?: string | null;
  limitations: string[];
  // ---- Wire contract B — the ONE recording (new native builds; legacy builds omit all) ----
  /** "SINGLE_FILE" on new builds; absent ⇒ a legacy SEGMENTED recording (use the segment events). */
  layout?: ScreenContinuousLayout;
  /**
   * file:// URI of the ONE recording. Null when no usable file exists. Android
   * states it only for a file MediaRecorder finalised (an unfinalised MP4 is not
   * playable). iOS also states it when the extension was killed (`finalized:
   * false`): its fragmented MP4 plays up to the last fragment, but it is NOT a
   * complete recording and must never be presented as one.
   */
  recordingUri?: string | null;
  recordingSizeBytes?: number | null;
  /** The recording's own duration; null when the writer never finished the file. */
  recordingDurationMs?: number | null;
  /** The encoded canvas (fixed for the whole file). */
  widthPx?: number | null;
  heightPx?: number | null;
  orientationTimeline?: ScreenContinuousOrientationEntry[];
  /** iOS broadcast pauses (the gap stays in the file); always [] on Android. */
  pauses?: ScreenContinuousPause[];
  /**
   * Frames the writer refused (iOS: counted, never hidden — FRAMES_DROPPED when
   * > 0). Absent on Android: MediaRecorder exposes no such count, and PROOVRA
   * never claims a 0 it cannot observe.
   */
  droppedFrameCount?: number;
  /** iOS: audio buffers the writer refused (counted, never hidden). */
  droppedAudioBufferCount?: number;
  /** Tracks ACTUALLY written ([] ⇒ silent, with AUDIO_NOT_CAPTURED). */
  audioTracks?: ScreenContinuousAudioTrack[];
  /** False ⇒ the writer could not finish the file (crash/kill/error): never complete. */
  finalized?: boolean;
};

export type ScreenContinuousState = {
  active: boolean;
  segmentCount: number;
  /**
   * UC-IOS-006 — iOS only: the container says "active" but the extension has
   * written nothing for longer than a few segment intervals (it was killed).
   */
  stale?: boolean;
  /** AUD-006 — iOS only: whose recording this state describes. */
  recordingId?: string | null;
  binding?: ScreenContinuousBinding;
  appRequested?: boolean;
  /** The capture session the app recorded on this recording, if any. */
  captureSessionId?: string | null;
  /** The broadcast running right now — possibly ANOTHER recording. */
  liveRecordingId?: string | null;
};

/** AUD-006 — iOS: a recording on this device, listed for explicit recovery or discard. */
export type ScreenContinuousRecording = {
  recordingId: string;
  binding: Exclude<ScreenContinuousBinding, "NONE">;
  appRequested: boolean;
  captureSessionId: string | null;
  createdAtUtc: string;
  segmentCount: number;
  /** "SINGLE_FILE": the broadcast wrote (or is writing) ONE recording file. */
  layout?: "SINGLE_FILE" | "SEGMENTED";
  /** The broadcast's recording.mp4 exists (layout SINGLE_FILE). */
  hasRecordingFile?: boolean;
  active: boolean;
  stale: boolean;
  /** result.json exists (the extension finished; not the same as the file being finalized). */
  finalized: boolean;
};

export type ScreenContinuousOptions = {
  /** LEGACY (segmenting native builds): per-segment duration ms. New builds record one file. */
  segmentMs?: number;
  /** LEGACY (segmenting native builds): ceiling on segments. */
  maxSegments?: number;
  /**
   * Android: record the MICROPHONE into the file. Pass true ONLY after the user
   * chose it in PROOVRA AND the RECORD_AUDIO runtime permission was granted —
   * native rejects with MICROPHONE_PERMISSION_REQUIRED otherwise (it never asks
   * for the permission itself). iOS ignores it: the user turns the microphone
   * on or off in Apple's broadcast picker, which is the consent there.
   */
  microphone?: boolean;
};

/**
 * AUD-004 — one segment as the durable native ledger holds it: where it is,
 * and whether PROOVRA confirmed it (UPLOADED, with the digest it accepted).
 */
export type ScreenLedgerSegment = ScreenSegment & {
  sizeBytes: number;
  sha256Hex: string | null;
  uploadState: "RECORDED" | "UPLOADED";
};

/**
 * AUD-004 — the durable record of a continuous recording, which survives a JS
 * reload and a process death. `outcome` is the session result read from the
 * ledger alone: INTERRUPTED (CAPTURE_INTERRUPTED, interruption PROCESS_DEATH)
 * unless the recorder itself recorded a clean, complete finish.
 */
export type ScreenContinuousLedger = {
  recordingId: string;
  captureSessionId: string | null;
  evidenceId: string | null;
  ownerUserId: string | null;
  state: "RECORDING" | "FINISHED" | "INTERRUPTED";
  /** "SINGLE_FILE" for a one-file recording; null for a legacy segmented ledger. */
  layout?: "SINGLE_FILE" | null;
  active: boolean;
  interruption: "PROCESS_DEATH" | null;
  outcome: ScreenContinuousResult & { interruption?: string | null };
  segments: ScreenLedgerSegment[];
};

/** A STREAMING digest of one file, computed natively (wire: hashFile). */
export type NativeFileDigest = { sha256Hex: string; md5Base64: string; sizeBytes: number };

type FileDigestNativeModule = {
  /** Absent on native builds before 2026-10-29. */
  hashFile?(uri: string): Promise<NativeFileDigest>;
};

/**
 * True when this native build can hash a file in STREAMING chunks (iOS and
 * Android builds from 2026-10-29). Older binaries lack it: the caller falls
 * back to its JS path.
 */
export function isNativeFileHashAvailable(): boolean {
  if (Platform.OS !== "android" && Platform.OS !== "ios") return false;
  try {
    return typeof (nativeModule() as unknown as FileDigestNativeModule).hashFile === "function";
  } catch {
    return false;
  }
}

/**
 * SHA-256 (hex) + MD5 (base64) + size of a file:// URI, read natively in 1 MiB
 * chunks off the JS/main thread — memory stays at one chunk whatever the file
 * size (a single-file recording is up to 512 MB). Rejects FILE_NOT_FOUND for a
 * missing file, HASH_FAILED for an unreadable one, UNSUPPORTED on an older binary.
 */
export async function hashFileNative(uri: string): Promise<NativeFileDigest> {
  const mod = nativeModule() as unknown as FileDigestNativeModule;
  if (!isNativeFileHashAvailable() || typeof mod.hashFile !== "function") {
    throw new Error("UNSUPPORTED: this app build has no native file digest.");
  }
  return mod.hashFile(uri);
}

type ContinuousNativeModule = {
  isContinuousSupported(): boolean;
  /** AUD-006 — iOS takes the recordingId (null: the focused/live one); Android takes none. */
  getContinuousState(recordingId?: string | null): ScreenContinuousState;
  /**
   * UC-AND-004 / UC-IOS-010 — every segment the recorder has FINALISED in the
   * current (or last, if not yet cleared) session, so a relaunched UI can
   * resume uploading instead of orphaning a live recording.
   */
  getContinuousSegments(recordingId?: string | null): ScreenSegment[];
  /** UC-IOS-010 / UC-AND-004 — explicitly discard a leftover recording's local spool. */
  discardContinuousSpool(recordingId?: string | null): Promise<void>;
  /** AUD-004 (Android) — the durable recording ledger; absent on platforms without one. */
  getContinuousLedger?(): ScreenContinuousLedger | null;
  markContinuousSegmentUploaded?(o: { captureSessionId: string; sequence: number; sha256Hex: string; sizeBytes: number }): Promise<boolean>;
  commitContinuousSpool?(o: { captureSessionId: string }): Promise<boolean>;
  startContinuousCapture(options: { segmentMs: number; maxSegments: number; microphone: boolean }): Promise<ScreenContinuousStarted>;
  stopContinuousCapture(recordingId?: string | null): Promise<ScreenContinuousResult>;
};

/** AUD-006 — methods only the iOS Swift module exposes; every call is iOS-gated. */
type IosBroadcastNativeModule = {
  listContinuousRecordings(): ScreenContinuousRecording[];
  /** AUD-006 — the Swift AsyncFunction: bind ONE broadcast recording to a capture session. */
  bindContinuousSession(recordingId: string, captureSessionId: string): Promise<{ recordingId: string; captureSessionId: string }>;
};

/** AUD-004 — methods only the Android Kotlin module exposes (the durable ledger bind). */
type AndroidLedgerNativeModule = {
  bindContinuousSession?(o: { captureSessionId: string; evidenceId: string; ownerUserId: string | null }): Promise<boolean>;
};

function continuousModule(): ContinuousNativeModule {
  return nativeModule() as unknown as ContinuousNativeModule;
}
function androidLedgerModule(): AndroidLedgerNativeModule {
  return nativeModule() as unknown as AndroidLedgerNativeModule;
}
function iosBroadcastModule(): IosBroadcastNativeModule {
  return nativeModule() as unknown as IosBroadcastNativeModule;
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

/**
 * AUD-006 — on iOS every continuous call names ONE recording (the Swift
 * functions take a recordingId, null meaning the focused/live one); the
 * Android module takes no argument and is called exactly as before.
 */
export function getScreenContinuousState(recordingId?: string | null): ScreenContinuousState {
  if (!isContinuousScreenPlatform()) return { active: false, segmentCount: 0 };
  try {
    if (Platform.OS === "ios") return continuousModule().getContinuousState(recordingId ?? null);
    return continuousModule().getContinuousState();
  } catch {
    return { active: false, segmentCount: 0 };
  }
}

const DEFAULT_SEGMENT_MS = SCREEN_CONTINUOUS_STREAM_BOUNDS.defaultSegmentMs;
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
    // Explicit only: anything but `true` records no microphone.
    microphone: options.microphone === true,
  });
}

/** UC-AND-004 / UC-IOS-010 — the finalised segments the recorder holds on disk. */
export function getContinuousSegments(recordingId?: string | null): ScreenSegment[] {
  if (!isContinuousScreenPlatform()) return [];
  try {
    const out =
      Platform.OS === "ios"
        ? continuousModule().getContinuousSegments(recordingId ?? null)
        : continuousModule().getContinuousSegments();
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

/** UC-IOS-010 / UC-AND-004 — the user's explicit discard of a leftover recording's files. */
export async function discardContinuousSpool(recordingId?: string | null): Promise<void> {
  if (!isContinuousScreenPlatform()) return;
  if (Platform.OS === "ios") {
    await continuousModule().discardContinuousSpool(recordingId ?? null);
    return;
  }
  await continuousModule().discardContinuousSpool();
}

/** AUD-004 — the durable ledger, or null (no recording, or a platform without one). */
export function getContinuousLedger(): ScreenContinuousLedger | null {
  if (Platform.OS !== "android") return null;
  try {
    const mod = continuousModule();
    if (typeof mod.getContinuousLedger !== "function") return null;
    const l = mod.getContinuousLedger();
    return l && typeof l === "object" && Array.isArray(l.segments) ? l : null;
  } catch {
    return null;
  }
}

/**
 * AUD-004 — PROOVRA confirmed a segment. `null`: the platform keeps no ledger
 * (the caller manages the file itself); `false`: the ledger refused (another
 * session) and the file is kept; `true`: recorded, and native released the
 * now-redundant local copy.
 */
export async function markContinuousSegmentUploaded(o: {
  captureSessionId: string;
  sequence: number;
  sha256Hex: string;
  sizeBytes: number;
}): Promise<boolean | null> {
  if (Platform.OS !== "android") return null;
  const mod = continuousModule();
  if (typeof mod.markContinuousSegmentUploaded !== "function") return null;
  return mod.markContinuousSegmentUploaded(o);
}

/**
 * AUD-004 — the bound session is staged: release its spool. `null` where the
 * platform keeps no ledger; `false` (nothing deleted) unless the ledger is
 * bound to exactly this session.
 */
export async function commitContinuousSpool(o: { captureSessionId: string }): Promise<boolean | null> {
  if (Platform.OS !== "android") return null;
  const mod = continuousModule();
  if (typeof mod.commitContinuousSpool !== "function") return null;
  return mod.commitContinuousSpool(o);
}

export async function stopContinuousCapture(recordingId?: string | null): Promise<ScreenContinuousResult> {
  if (!isContinuousScreenPlatform()) throw new Error("Android/iOS only.");
  if (Platform.OS === "ios") return continuousModule().stopContinuousCapture(recordingId ?? null);
  return continuousModule().stopContinuousCapture();
}

/** AUD-006 — iOS: every broadcast recording on this device (empty elsewhere). */
export function listContinuousRecordings(): ScreenContinuousRecording[] {
  if (Platform.OS !== "ios") return [];
  try {
    const out = iosBroadcastModule().listContinuousRecordings();
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

/**
 * Bind the native recording to the PROOVRA session opened for it — ONE JS
 * entry point over the two platform-native binds:
 *  - Android (AUD-004): the durable ledger records captureSessionId/evidenceId/
 *    owner. REJECTS (BINDING_MISMATCH) when the recording already belongs to
 *    another session — never merged.
 *  - iOS (AUD-006): records the capture session on the broadcast recording the
 *    app bound (`recordingId` is required). REJECTS (BINDING_REFUSED) for a
 *    recording PROOVRA did not request or one that belongs to another session.
 * Resolves true once bound; false where the platform keeps no binding (or, on
 * iOS, no recordingId is known).
 */
export async function bindContinuousSession(o: {
  captureSessionId: string;
  evidenceId: string;
  ownerUserId: string | null;
  recordingId?: string | null;
}): Promise<boolean> {
  if (Platform.OS === "android") {
    const mod = androidLedgerModule();
    if (typeof mod.bindContinuousSession !== "function") return false;
    return mod.bindContinuousSession({
      captureSessionId: o.captureSessionId,
      evidenceId: o.evidenceId,
      ownerUserId: o.ownerUserId,
    });
  }
  if (Platform.OS !== "ios") return false;
  if (!o.recordingId) return false;
  await iosBroadcastModule().bindContinuousSession(o.recordingId, o.captureSessionId);
  return true;
}

/** LEGACY: only segmenting native builds emit it; new builds return ONE file in the stop result. */
export function addScreenSegmentListener(cb: (seg: ScreenSegment) => void): Subscription {
  return emitter().addListener("onScreenSegment", cb as never) as Subscription;
}
export function addContinuousStoppedListener(cb: (r: ScreenContinuousResult) => void): Subscription {
  return emitter().addListener("onScreenContinuousStopped", cb as never) as Subscription;
}
/** UC-IOS-005 — fired when the OS broadcast actually starts (iOS). */
export function addContinuousStartedListener(cb: (e: ScreenContinuousStartedEvent) => void): Subscription {
  return emitter().addListener("onScreenContinuousStarted", cb as never) as Subscription;
}
