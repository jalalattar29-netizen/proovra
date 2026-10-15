/**
 * UC-2 — the pure state machine behind the Direct Screen Capture screen.
 *
 * Extracted from the React screen so the phase transitions are deterministic and
 * unit-testable WITHOUT a device: intro → active (user triggers frames) → review
 * → uploading → success, with error branches that only ever expose safe actions.
 * The reducer is TOTAL (an unexpected event leaves the state unchanged), so the
 * UI can never fall into an ambiguous or hidden capture state.
 */

export type ScreenFlowState =
  | { phase: "intro" }
  | { phase: "active"; frameCount: number }
  | { phase: "review"; frameCount: number; stopReason: string }
  | { phase: "uploading"; frameCount: number }
  /**
   * AUD-005 — staging stopped on a RETRYABLE failure (network, timeout, a
   * transient server answer). The frames, the session and every confirmed
   * upload are kept on this device; Retry resumes them, Discard releases them.
   */
  | { phase: "pending"; frameCount: number; message: string }
  | { phase: "success"; evidenceId: string; frameCount: number }
  | { phase: "error"; message: string; recoverable: boolean };

export type ScreenFlowEvent =
  | { type: "STARTED" } // Android consent granted; session active
  | { type: "FRAME"; frameCount: number } // a frame was captured
  | { type: "STOPPED"; frameCount: number; stopReason: string }
  | { type: "FINALIZE" } // user asked to seal
  | { type: "FINALIZED"; evidenceId: string }
  | { type: "FAIL"; message: string; recoverable?: boolean }
  /** AUD-005 — a retryable staging failure: the capture is kept for Retry. */
  | { type: "STAGE_PENDING"; frameCount: number; message: string }
  /** AUD-005 — a staging persisted before an app restart is offered again. */
  | { type: "RESUME_PENDING"; frameCount: number; message: string }
  | { type: "RESET" }; // start over from intro

export const INITIAL_SCREEN_FLOW: ScreenFlowState = { phase: "intro" };

export function screenFlowReducer(
  state: ScreenFlowState,
  event: ScreenFlowEvent,
): ScreenFlowState {
  switch (event.type) {
    case "RESET":
      return { phase: "intro" };

    case "FAIL":
      // A failure from ANY phase is safe to surface; recoverable defaults true.
      return { phase: "error", message: event.message, recoverable: event.recoverable ?? true };

    case "STARTED":
      // Only from intro. Consent granted → empty active session.
      return state.phase === "intro" ? { phase: "active", frameCount: 0 } : state;

    case "FRAME":
      // Only while active; ignore a stray -1 (no image available).
      if (state.phase !== "active") return state;
      return { phase: "active", frameCount: Math.max(state.frameCount, event.frameCount) };

    case "STOPPED":
      if (state.phase !== "active") return state;
      if (event.frameCount <= 0) {
        return {
          phase: "error",
          message: "No frames were captured. Show the content on screen, then Capture Frame.",
          recoverable: true,
        };
      }
      return { phase: "review", frameCount: event.frameCount, stopReason: event.stopReason };

    case "FINALIZE":
      return state.phase === "review" || state.phase === "pending"
        ? { phase: "uploading", frameCount: state.frameCount }
        : state;

    case "STAGE_PENDING":
      return state.phase === "uploading"
        ? { phase: "pending", frameCount: event.frameCount, message: event.message }
        : state;

    case "RESUME_PENDING":
      return state.phase === "intro"
        ? { phase: "pending", frameCount: event.frameCount, message: event.message }
        : state;

    case "FINALIZED":
      return state.phase === "uploading"
        ? { phase: "success", evidenceId: event.evidenceId, frameCount: state.frameCount }
        : state;

    default:
      return state;
  }
}
