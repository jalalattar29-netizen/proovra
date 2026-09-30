/**
 * What the popup SAYS about a capture — pure, so every sentence is tested.
 *
 * The rule (UC-EXT-005 / UC-EXT-008): a sentence may claim only what the
 * background proved. "Nothing was saved" is said only when the server provably
 * holds no sealed record; an unconfirmed seal says "check your Evidence
 * library"; an ended session says "sign in again". No sentence ever carries a
 * server message or an exception string.
 */
import { denialToMessage } from "./denial-copy.js";
import type { CaptureStatus } from "./capture-registry.js";

/** The one sentence shown when no written refusal copy applies. */
export const CAPTURE_FAILED =
  "The capture could not be completed. Nothing was saved. Please try again, or open PROOVRA if this keeps happening.";

export const CAPTURE_UNKNOWN =
  "The capture was interrupted before PROOVRA confirmed the result, so it may or may not have been saved. Check your Evidence library in PROOVRA before capturing again.";

export const CAPTURE_CANCELLED = "Capture cancelled. Nothing was saved.";

export const SESSION_ENDED = "Your PROOVRA sign-in has ended. Nothing was saved. Sign in again to capture.";

export const CAPTURE_SUCCEEDED = "Preserved. The record is in your PROOVRA workspace.";

export const CAPTURE_ALREADY_RUNNING = "A capture of this page is already in progress.";

const STEP_LABEL: Record<string, string> = {
  preparing: "Preparing",
  capturing: "Capturing",
  opening_session: "Opening a capture session",
  reserving: "Creating the record",
  uploading: "Uploading",
  sealing: "Sealing",
  discarding: "Discarding the incomplete record",
  done: "Finishing",
};

export function humanStep(step: string | null | undefined): string {
  return (step && STEP_LABEL[step]) || "Working";
}

export type StatusLine = { text: string; tone: "" | "ok" | "error"; signedOut: boolean };

/** PURE: the popup's status line for a capture status. */
export function statusLine(s: CaptureStatus | null): StatusLine | null {
  if (!s) return null;
  if (s.state === "RUNNING") {
    if (s.cancelRequested) return { text: "Cancelling…", tone: "", signedOut: false };
    return {
      text: `${humanStep(s.step)}${s.detail ? ` — ${s.detail}` : ""}…`,
      tone: "",
      signedOut: false,
    };
  }
  if (s.state === "SUCCEEDED") return { text: CAPTURE_SUCCEEDED, tone: "ok", signedOut: false };
  // FAILED
  if (s.outcome === "UNKNOWN") return { text: CAPTURE_UNKNOWN, tone: "error", signedOut: s.reason === "SIGNED_OUT" };
  if (s.reason === "SIGNED_OUT") return { text: SESSION_ENDED, tone: "error", signedOut: true };
  if (s.reason === "CANCELLED") return { text: CAPTURE_CANCELLED, tone: "", signedOut: false };
  // Capture is plan-blind: a server refusal is surfaced as the evidence
  // -creation / quota / entitlement reason it actually is. Unknown codes fall
  // back to the generic line — never the server's own message.
  return { text: denialToMessage(s.denial) ?? CAPTURE_FAILED, tone: "error", signedOut: false };
}
