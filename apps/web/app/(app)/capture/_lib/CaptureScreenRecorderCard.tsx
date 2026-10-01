"use client";

/**
 * Capture — browser screen recording card (getDisplayMedia).
 *
 * Presentation only; the behaviour is `useCaptureScreenRecorder`. The copy is
 * held to what the code proves: the browser asks for permission, the surface
 * is browser-reported, audio only if granted, no device/OS attestation, and
 * the recording is staged like any other file and sealed by the same Finish &
 * Sign path.
 */

import { MonitorUp, Pause, Play, Square, Trash2 } from "lucide-react";

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
  idle: "Ready",
  requesting: "Waiting for your browser's permission…",
  recording: "Recording",
  paused: "Paused",
  stopped: "Stopped — review and add to the session",
  adding: "Adding to the session…",
  failed: "Recording failed",
};

export function CaptureScreenRecorderCard({
  state,
  error,
  facts,
  hasRecording,
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
  return (
    <section
      className="capture-audio-card capture-screen-card"
      data-capture-screen-recorder
      data-screen-recorder-state={state}
      aria-labelledby="capture-screen-recorder-heading"
    >
      <div className="capture-panel-heading">
        <strong id="capture-screen-recorder-heading">Screen recording</strong>
        {!live && state !== "adding" ? (
          <button type="button" className="capture-text-button" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>

      <p className="capture-screen-card__state" role="status" aria-live="polite">
        {STATE_TEXT[state]}
      </p>

      {state === "unsupported" ? (
        <p>
          This browser does not support recording a screen from a web page. Use a desktop
          browser such as Chrome, Edge or Firefox, or upload an existing recording.
        </p>
      ) : (
        <ul className="capture-screen-card__limits" data-screen-recorder-limitations>
          <li>Your browser asks which screen, window or tab to share; nothing is recorded before you choose.</li>
          <li>The shared surface is what the browser reports. PROOVRA does not verify it.</li>
          <li>Audio is included only if you allow it in the browser&apos;s dialog.</li>
          <li>
            No device or operating-system attestation: this is a browser recording, uploaded and sealed like any
            other file in this session.
          </li>
        </ul>
      )}

      {live || state === "stopped" ? (
        <p className="capture-screen-card__facts" data-screen-recorder-facts>
          {screenRecordingSourceLabel(facts)}
        </p>
      ) : null}

      {offline ? (
        <p role="alert">You are offline. You can record, but adding and uploading need a connection.</p>
      ) : null}

      {error ? (
        <p role="alert" className="capture-error-text">
          {error}
        </p>
      ) : null}

      <div className="capture-upload-actions">
        {state === "idle" || state === "failed" ? (
          <button type="button" className="app-primary-action" onClick={onStart} disabled={disabled}>
            <MonitorUp size={16} aria-hidden="true" /> Choose what to record
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
        {live ? (
          <button type="button" className="app-secondary-action" onClick={onStop}>
            <Square size={16} aria-hidden="true" /> Stop
          </button>
        ) : null}
        {state === "stopped" && hasRecording ? (
          <button type="button" className="app-primary-action" onClick={onAdd} disabled={disabled || offline}>
            Add recording to session
          </button>
        ) : null}
        {live || state === "stopped" ? (
          <button type="button" className="app-secondary-action" onClick={onDiscard}>
            <Trash2 size={16} aria-hidden="true" /> Discard
          </button>
        ) : null}
      </div>
    </section>
  );
}

export default CaptureScreenRecorderCard;
