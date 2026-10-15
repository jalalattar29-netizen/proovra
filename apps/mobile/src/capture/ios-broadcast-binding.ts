/**
 * AUD-006 — which iOS broadcast recording a capture session may use.
 *
 * Each broadcast writes into its own spool namespace (recordingId). The app
 * binds a recordingId BEFORE it shows Apple's picker; only the broadcast that
 * adopted that binding is "ours". These PURE decisions are what the continuous
 * screen applies, so a broadcast started from Control Center, a recording
 * left over from an earlier session, or a live broadcast of another recording
 * is never attached to — or uploaded into — the persisted capture session.
 *
 * Android has no recording namespaces (one MediaProjection recorder): every
 * decision here is a pass-through there.
 */
import type {
  ScreenContinuousStartedEvent,
  ScreenContinuousState,
  ScreenSegment,
} from "../../modules/proovra-screen-capture";

type Os = string;

/** The started event opens a session only for the recording this screen prepared, adopted from its binding. */
export function acceptsBroadcastStart(
  os: Os,
  preparedRecordingId: string | null,
  event: Pick<ScreenContinuousStartedEvent, "recordingId" | "binding"> | null | undefined,
): boolean {
  if (os !== "ios") return true;
  return (
    !!preparedRecordingId &&
    !!event &&
    event.recordingId === preparedRecordingId &&
    event.binding === "BOUND"
  );
}

/** A segment is uploaded into the session only when it belongs to the session's recording. */
export function segmentBelongsToRecording(
  os: Os,
  recordingId: string | null,
  segment: Pick<ScreenSegment, "recordingId">,
): boolean {
  if (os !== "ios") return true;
  return !!recordingId && segment.recordingId === recordingId;
}

export type IosReattachRefusal =
  /** The persisted session predates recording ids: nothing proves which broadcast is its own. */
  | "NO_RECORDING_ID"
  /** Its recording is no longer on this device. */
  | "RECORDING_MISSING"
  /** The native state describes another recording. */
  | "RECORDING_MISMATCH"
  /** The recording was not adopted from PROOVRA's binding (e.g. Control Center). */
  | "RECORDING_UNBOUND"
  /** The recording is bound to a different capture session. */
  | "SESSION_MISMATCH";

export type IosReattachDecision =
  | { kind: "reattach" }
  | { kind: "ended" }
  | { kind: "refuse"; reason: IosReattachRefusal };

/**
 * A remounted screen holds a persisted live session. It may REATTACH (the
 * recording is running), RECOVER it as ended, or must REFUSE — never attach
 * another recording's broadcast or upload its segments into this session.
 * `native` is the state of the persisted recordingId (getScreenContinuousState(recordingId)).
 */
export function decideIosReattach(
  live: { recordingId?: string | null; captureSessionId: string },
  native: ScreenContinuousState,
): IosReattachDecision {
  if (!live.recordingId) return { kind: "refuse", reason: "NO_RECORDING_ID" };
  if (!native.recordingId || native.binding === "NONE") return { kind: "refuse", reason: "RECORDING_MISSING" };
  if (native.recordingId !== live.recordingId) return { kind: "refuse", reason: "RECORDING_MISMATCH" };
  if (native.binding !== "BOUND") return { kind: "refuse", reason: "RECORDING_UNBOUND" };
  if (native.captureSessionId && native.captureSessionId !== live.captureSessionId) {
    return { kind: "refuse", reason: "SESSION_MISMATCH" };
  }
  return native.active && !native.stale ? { kind: "reattach" } : { kind: "ended" };
}
