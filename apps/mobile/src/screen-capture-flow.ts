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
  | { phase: "success"; evidenceId: string; frameCount: number }
  | { phase: "error"; message: string; recoverable: boolean };

export type ScreenFlowEvent =
  | { type: "STARTED" } // Android consent granted; session active
  | { type: "FRAME"; frameCount: number } // a frame was captured
  | { type: "STOPPED"; frameCount: number; stopReason: string }
  | { type: "FINALIZE" } // user asked to seal
  | { type: "FINALIZED"; evidenceId: string }
  | { type: "FAIL"; message: string; recoverable?: boolean }
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
      return state.phase === "review" ? { phase: "uploading", frameCount: state.frameCount } : state;

    case "FINALIZED":
      return state.phase === "uploading"
        ? { phase: "success", evidenceId: event.evidenceId, frameCount: state.frameCount }
        : state;

    default:
      return state;
  }
}
