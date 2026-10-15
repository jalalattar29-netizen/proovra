/**
 * UC-3 / UC-5 — the pure state machine behind the Continuous Screen Capture screen.
 *
 * intro → [awaiting: iOS picker shown, waiting for the OS to start] → active
 * (recording; segments captured + uploaded stream in) → review (stopped, session
 * summary) → finalizing → success, with safe-only error branches. TOTAL: an
 * unexpected event leaves the state unchanged, so the UI never falls into a
 * hidden/ambiguous recording state, and a session never appears successful
 * without an explicit finalize.
 */

export type ContinuousReviewState = {
  phase: "review";
  captured: number;
  uploaded: number;
  completeness: string;
  stopReason: string;
  /** Set when staging failed but the session is kept (retryable). */
  notice?: string | null;
};

export type ContinuousFlowState =
  | { phase: "intro" }
  /** UC-IOS-005 — Apple's picker is up; nothing records until the user taps Start Broadcast. */
  | { phase: "awaiting" }
  | { phase: "active"; captured: number; uploaded: number }
  | ContinuousReviewState
  | { phase: "finalizing"; captured: number; review?: ContinuousReviewState }
  | { phase: "success"; evidenceId: string; segmentCount: number; completeness: string }
  | { phase: "error"; message: string; recoverable: boolean };

export type ContinuousFlowEvent =
  | { type: "AWAITING_SYSTEM_START" }
  | { type: "STARTED" }
  | { type: "SEGMENT_CAPTURED"; captured: number }
  | { type: "SEGMENT_UPLOADED"; uploaded: number }
  | { type: "STOPPED"; captured: number; uploaded: number; completeness: string; stopReason: string }
  | { type: "FINALIZE" }
  | { type: "STAGE_FAILED"; message: string }
  | { type: "FINALIZED"; evidenceId: string; segmentCount: number; completeness: string }
  | { type: "FAIL"; message: string; recoverable?: boolean }
  | { type: "RESET" };

export const INITIAL_CONTINUOUS_FLOW: ContinuousFlowState = { phase: "intro" };

/** PURE: recorded-but-not-yet-uploaded segment backlog (never negative). */
export function pendingBacklog(captured: number, uploaded: number): number {
  return Math.max(0, captured - uploaded);
}

/**
 * UC-IOS-003 — backpressure is an ANDROID rule. On iOS the host app is
 * suspended while the user is in another app, so segments necessarily pile up
 * in the App Group container (the durable spool, bounded by the session's own
 * segment/byte limits) and arrive in a burst on return; stopping for that
 * backlog ended every recording longer than ~48 s spent outside PROOVRA.
 */
export function backpressureApplies(platformOS: string): boolean {
  return platformOS === "android";
}

/**
 * PURE: the backpressure decision. When the recorded-but-unuploaded backlog reaches
 * the bound, the client must trigger a CONTROLLED stop — bounding RAM/disk/in-flight
 * uploads without silently dropping any segment. Never on iOS (see above).
 */
export function shouldStopForBackpressure(
  captured: number,
  uploaded: number,
  maxPending: number,
  platformOS: string = "android",
): boolean {
  if (!backpressureApplies(platformOS)) return false;
  return pendingBacklog(captured, uploaded) >= maxPending;
}

export function continuousFlowReducer(
  state: ContinuousFlowState,
  event: ContinuousFlowEvent,
): ContinuousFlowState {
  switch (event.type) {
    case "RESET":
      return { phase: "intro" };
    case "FAIL":
      return { phase: "error", message: event.message, recoverable: event.recoverable ?? true };
    case "AWAITING_SYSTEM_START":
      return state.phase === "intro" ? { phase: "awaiting" } : state;
    case "STARTED":
      return state.phase === "intro" || state.phase === "awaiting" ? { phase: "active", captured: 0, uploaded: 0 } : state;
    case "SEGMENT_CAPTURED":
      if (state.phase !== "active") return state;
      return { phase: "active", captured: Math.max(state.captured, event.captured), uploaded: state.uploaded };
    case "SEGMENT_UPLOADED":
      if (state.phase !== "active") return state;
      return { phase: "active", captured: state.captured, uploaded: Math.max(state.uploaded, event.uploaded) };
    case "STOPPED":
      // Only a live session can be stopped into review; ignore stray stop echoes.
      if (state.phase !== "active") return state;
      return {
        phase: "review",
        captured: event.captured,
        uploaded: event.uploaded,
        completeness: event.completeness,
        stopReason: event.stopReason,
      };
    case "FINALIZE":
      if (state.phase !== "review") return state;
      if (state.captured <= 0) {
        return {
          phase: "error",
          message: "No screen segments were recorded. Start again and let it record before stopping.",
          recoverable: true,
        };
      }
      return { phase: "finalizing", captured: state.captured, review: { ...state, notice: null } };
    case "STAGE_FAILED":
      // UC-STR-001 — a staging failure KEEPS the session (its segments are at
      // storage, declared and verified): back to review with the reason, where
      // Continue retries and Discard releases.
      if (state.phase !== "finalizing") return state;
      return state.review
        ? { ...state.review, notice: event.message }
        : { phase: "review", captured: state.captured, uploaded: state.captured, completeness: "INTERRUPTED_SESSION", stopReason: "", notice: event.message };
    case "FINALIZED":
      return state.phase === "finalizing"
        ? { phase: "success", evidenceId: event.evidenceId, segmentCount: event.segmentCount, completeness: event.completeness }
        : state;
    default:
      return state;
  }
}

/**
 * How long Stop / Finalize waits for the bounded upload queue before it
 * proceeds without what is still pending. Each request is itself bounded
 * (capture-retry.ts), so this is the ceiling on a whole backlog, not on one
 * stalled request.
 */
export const CONTINUOUS_DRAIN_DEADLINE_MS = 120_000;

export type DrainOutcome =
  /** Queue empty and no upload in flight. */
  | "DRAINED"
  /** The session is gone: nothing can upload any more (the old loop spun forever). */
  | "NO_SESSION"
  /**
   * The deadline passed with uploads still pending. They stay recoverable on
   * disk (the native ledger holds them); the manifest states them as lost
   * only if they are still undeclared after finalize's own retry.
   */
  | "DEADLINE";

/**
 * Wait until the upload queue is drained — bounded. The previous loop
 * (`while (queue || workers) sleep(100)`) never ended when the session ref was
 * cleared (pump() then returns without taking anything) or when an upload
 * hung, so Stop and Finalize could wait forever.
 */
export async function drainUploadQueue(io: {
  pending: () => number;
  inFlight: () => number;
  hasSession: () => boolean;
  pump: () => void;
  deadlineMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<DrainOutcome> {
  // Monotonic (AUD-018): a wall-clock change cannot stretch or end the wait.
  const now =
    io.now ??
    (() => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now()));
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = io.pollMs ?? 100;
  const startedAt = now();
  io.pump();
  while (io.pending() > 0 || io.inFlight() > 0) {
    if (!io.hasSession()) return "NO_SESSION";
    if (now() - startedAt >= io.deadlineMs) return "DEADLINE";
    await sleep(pollMs);
  }
  return "DRAINED";
}
