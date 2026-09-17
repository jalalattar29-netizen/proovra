/**
 * UC-3 — the pure state machine behind the Continuous Screen Capture screen.
 *
 * intro → active (recording; segments captured + uploaded stream in) → review
 * (stopped, session summary) → finalizing → success, with safe-only error
 * branches. TOTAL: an unexpected event leaves the state unchanged, so the UI never
 * falls into a hidden/ambiguous recording state, and a session never appears
 * successful without an explicit finalize.
 */

export type ContinuousFlowState =
  | { phase: "intro" }
  | { phase: "active"; captured: number; uploaded: number }
  | { phase: "review"; captured: number; uploaded: number; completeness: string; stopReason: string }
  | { phase: "finalizing"; captured: number }
  | { phase: "success"; evidenceId: string; segmentCount: number; completeness: string }
  | { phase: "error"; message: string; recoverable: boolean };

export type ContinuousFlowEvent =
  | { type: "STARTED" }
  | { type: "SEGMENT_CAPTURED"; captured: number }
  | { type: "SEGMENT_UPLOADED"; uploaded: number }
  | { type: "STOPPED"; captured: number; uploaded: number; completeness: string; stopReason: string }
  | { type: "FINALIZE" }
  | { type: "FINALIZED"; evidenceId: string; segmentCount: number; completeness: string }
  | { type: "FAIL"; message: string; recoverable?: boolean }
  | { type: "RESET" };

export const INITIAL_CONTINUOUS_FLOW: ContinuousFlowState = { phase: "intro" };

export function continuousFlowReducer(
  state: ContinuousFlowState,
  event: ContinuousFlowEvent,
): ContinuousFlowState {
  switch (event.type) {
    case "RESET":
      return { phase: "intro" };
    case "FAIL":
      return { phase: "error", message: event.message, recoverable: event.recoverable ?? true };
    case "STARTED":
      return state.phase === "intro" ? { phase: "active", captured: 0, uploaded: 0 } : state;
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
      return { phase: "finalizing", captured: state.captured };
    case "FINALIZED":
      return state.phase === "finalizing"
        ? { phase: "success", evidenceId: event.evidenceId, segmentCount: event.segmentCount, completeness: event.completeness }
        : state;
    default:
      return state;
  }
}
