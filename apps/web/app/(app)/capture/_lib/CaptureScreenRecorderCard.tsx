"use client";

/**
 * Capture — browser screen recording card (getDisplayMedia).
 *
 * Presentation only; the behaviour is `useCaptureScreenRecorder`. The copy is
 * held to what the code proves: the browser asks for permission, the surface
 * is browser-reported, audio only if granted, no device/OS attestation, and
 * the recording is staged like any other file and sealed by the same Finish &
 * Sign path.
 *
 * NO "READY" CARD. Screen in the add-evidence actions opens the browser's
 * chooser directly (one click, inside the user gesture). This card appears
 * only once there is something to show: the chooser is open, a recording is
 * live or waiting to be added, or the last attempt was cancelled or failed.
 * `shouldShowScreenRecorderCard` is that rule, so the page and the tests read
 * one definition.
 */

import { CircleHelp, MonitorUp, Pause, Play, Square, Trash2, X } from "lucide-react";

import type {
  ScreenRecorderState,
  ScreenRecordingFacts,
} from "../_hooks/useCaptureScreenRecorder";
import { screenRecordingSourceLabel } from "../_hooks/useCaptureScreenRecorder";

type Props = {
  state: ScreenRecorderState;
  error: string | null;
  facts: ScreenRecordingFacts;
  hasRecording: boolean;
  /** Recorded time excluding pauses. */
  elapsedMs?: number;
  disabled?: boolean;
  offline?: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onDiscard: () => void;
  onAdd: () => void;
  onClose: () => void;
};

const STATE_TEXT: Record<ScreenRecorderState, string> = {
  unsupported: "Not available in this browser",
  idle: "Nothing was recorded",
  requesting: "Choose a screen, window or tab in your browser's dialog…",
  recording: "Recording",
  paused: "Paused",
  stopped: "Recording stopped — add it to the session or discard it",
  adding: "Adding to the session…",
  failed: "Recording failed",
};

/** The one rule for whether the card is on screen. */
export function shouldShowScreenRecorderCard(state: ScreenRecorderState, error: string | null): boolean {
  if (state === "unsupported") return false;
  if (state === "idle") return Boolean(error);
  return true;
}

export function formatRecordedTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(total / 60).toString().padStart(2, "0");
  const secs = (total % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

/**
 * The limitations, on demand. A native `<details>` so it is keyboard- and
 * screen-reader-operable without any state of its own.
 */
export function CaptureScreenRecordingHelp({ className }: { className?: string }) {
  return (
    <details className={`capture-screen-help ${className ?? ""}`} data-capture-screen-help>
      <summary>
        <CircleHelp size={14} aria-hidden="true" />
        About screen recording
      </summary>
      <ul className="capture-screen-card__limits" data-screen-recorder-limitations>
        <li>Your browser asks which screen, window or tab to share; nothing is recorded before you choose.</li>
        <li>The shared surface is what the browser reports. PROOVRA does not verify it.</li>
        <li>Audio is included only if you allow it in the browser&apos;s dialog.</li>
        <li>
          No device or operating-system attestation: this is a browser recording, uploaded and sealed like any
          other file in this session.
        </li>
        <li>
          Screen recording is a video of what you share. It is not the PROOVRA browser extension&apos;s web page
          capture.
        </li>
      </ul>
    </details>
  );
}

export function CaptureScreenRecorderCard({
  state,
  error,
  facts,
  hasRecording,
  elapsedMs = 0,
  disabled,
  offline,
  onStart,
  onPause,
  onResume,
  onStop,
  onDiscard,
  onAdd,
  onClose,
}: Props) {
  const live = state === "recording" || state === "paused";
  const closable = !live && state !== "adding" && state !== "requesting";
  return (
    <section
      className={`capture-screen-card ${live ? "is-live" : ""}`}
      data-capture-screen-recorder
      data-screen-recorder-state={state}
      aria-labelledby="capture-screen-recorder-heading"
    >
      <div className="capture-screen-card__head">
        <strong id="capture-screen-recorder-heading">
          {live ? (
            <span className="capture-screen-card__live-dot" aria-hidden="true" />
          ) : (
            <MonitorUp size={16} aria-hidden="true" />
          )}
          Screen recording
        </strong>
        {live || state === "stopped" ? (
          <span className="capture-screen-card__time" data-screen-recorder-elapsed aria-label="Recorded time">
            {formatRecordedTime(elapsedMs)}
          </span>
        ) : null}
        {closable ? (
          <button
            type="button"
            className="capture-icon-button"
            onClick={onClose}
            aria-label="Close screen recording"
          >
            <X size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <p className="capture-screen-card__state" role="status" aria-live="polite">
        {state === "idle" && error ? error : STATE_TEXT[state]}
      </p>

      {live || state === "stopped" ? (
        <p className="capture-screen-card__facts" data-screen-recorder-facts>
          {screenRecordingSourceLabel(facts)}
        </p>
      ) : null}

      {offline ? (
        <p role="alert">You are offline. You can record, but adding and uploading need a connection.</p>
      ) : null}

      {error && state !== "idle" ? (
        <p role="alert" className="capture-error-text">
          {error}
        </p>
      ) : null}

      {/* Its OWN action row on the canonical action primitives. It used to reuse
          the dropzone's tile grid (.capture-upload-actions) and the legacy audio
          card class, whose !important tile/hover rules turned the primary button
          white-on-white on hover and removed its focus ring. */}
      <div className="capture-screen-card__actions">
        {/* The primary action of each state comes first: Stop while live, Add once stopped. */}
        {live ? (
          <button type="button" className="app-primary-action" onClick={onStop} data-screen-recorder-stop>
            <Square size={16} aria-hidden="true" /> Stop recording
          </button>
        ) : null}
        {state === "recording" ? (
          <button type="button" className="app-secondary-action" onClick={onPause}>
            <Pause size={16} aria-hidden="true" /> Pause
          </button>
        ) : null}
        {state === "paused" ? (
          <button type="button" className="app-secondary-action" onClick={onResume}>
            <Play size={16} aria-hidden="true" /> Resume
          </button>
        ) : null}
        {state === "stopped" && hasRecording ? (
          <button type="button" className="app-primary-action" onClick={onAdd} disabled={disabled || offline}>
            Add recording to session
          </button>
        ) : null}
        {/* Retry is a fresh click, so the browser receives a new user gesture. */}
        {(state === "idle" && error) || state === "failed" ? (
          <button type="button" className="app-secondary-action" onClick={onStart} disabled={disabled}>
            <MonitorUp size={16} aria-hidden="true" /> Try again
          </button>
        ) : null}
        {live || state === "stopped" ? (
          <button type="button" className="app-secondary-action app-secondary-action--danger" onClick={onDiscard}>
            <Trash2 size={16} aria-hidden="true" /> Discard
          </button>
        ) : null}
      </div>

      <CaptureScreenRecordingHelp />
    </section>
  );
}

export default CaptureScreenRecorderCard;
