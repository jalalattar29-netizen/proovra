/**
 * PRO-C1-07 — A RECORDING IS ALWAYS STAGEABLE.
 *
 * The browser recorders (camera, audio, screen) grew in memory without bound,
 * and the staging limits (MAX_SINGLE_FILE_BYTES per file, MAX_SESSION_BYTES per
 * session) were applied only after Stop: a long recording could never be added
 * and was lost. Each recorder now knows its byte budget when it starts —
 * refuses to start when the session has no room — and stops itself just before
 * the budget, so what it produces always fits the session it is added to.
 */
import { MAX_SESSION_BYTES, MAX_SINGLE_FILE_BYTES } from "./templates";

/** The recorder stops this far below its budget: one more chunk must still fit. */
export const RECORDING_STOP_MARGIN_BYTES = 8 * 1024 * 1024;

/** PURE — the most a new recording may hold, given what is already staged. */
export function recordingByteBudget(stagedBytes: number): number {
  const room = MAX_SESSION_BYTES - Math.max(0, stagedBytes);
  return Math.max(0, Math.min(MAX_SINGLE_FILE_BYTES, room));
}

/** PURE — has a recording of `recordedBytes` reached its budget? */
export function recordingReachedBudget(recordedBytes: number, budget: number): boolean {
  return recordedBytes >= Math.max(0, budget - RECORDING_STOP_MARGIN_BYTES);
}

/** PURE — may a recording start at all (room for more than the stop margin)? */
export function recordingCanStart(budget: number): boolean {
  return budget > RECORDING_STOP_MARGIN_BYTES;
}

function mb(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}

export function recordingNoRoomMessage(): string {
  return `This capture session is full (${mb(MAX_SESSION_BYTES)} per session). Finish or remove staged items before recording.`;
}

export function recordingStoppedAtLimitMessage(budget: number): string {
  return `Recording stopped at the ${mb(budget)} limit so it can be added to this session. Start another recording to continue.`;
}
