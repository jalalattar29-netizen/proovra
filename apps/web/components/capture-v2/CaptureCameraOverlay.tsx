import type { RefObject } from "react";

import type { CameraMode, FacingMode } from "../../app/(app)/capture/_lib/types";

type Props = {
  cameraOpen: boolean;
  flashEnabled: boolean;
  cameraMode: CameraMode;
  isRecording: boolean;
  recordingSeconds: number;
  facingMode: FacingMode;
  busy: boolean;
  cameraStarting: boolean;
  cameraError: string | null;
  sessionItemsCount: number;
  videoPreviewRef: RefObject<HTMLVideoElement | null>;
  closeCamera: () => void;
  handleToggleFlash: () => void;
  handleFlipCamera: () => void;
  capturePhotoFromCamera: () => void;
  startVideoRecording: () => void;
  stopVideoRecording: () => void;
  formatRecordingTime: (seconds: number) => string;
};

export function CaptureCameraOverlay({
  cameraOpen,
  flashEnabled,
  cameraMode,
  isRecording,
  recordingSeconds,
  facingMode,
  busy,
  cameraStarting,
  cameraError,
  sessionItemsCount,
  videoPreviewRef,
  closeCamera,
  handleToggleFlash,
  handleFlipCamera,
  capturePhotoFromCamera,
  startVideoRecording,
  stopVideoRecording,
  formatRecordingTime,
}: Props) {
  if (!cameraOpen) return null;

  return (
    <div className={`camera-overlay ${flashEnabled ? "camera-overlay-flash" : ""}`}>
      <video
        ref={videoPreviewRef as RefObject<HTMLVideoElement>}
        autoPlay
        muted={cameraMode !== "VIDEO" || !isRecording}
        playsInline
        className="camera-preview"
      />

      <div className="camera-topbar">
        <button
          type="button"
          className="camera-icon-btn"
          onClick={closeCamera}
          disabled={busy || cameraStarting}
        >
          Close
        </button>

        <div className="camera-topbar-title-group">
          <div className="camera-title">
            {cameraMode === "PHOTO" ? "Capture Photo" : "Record Video"}
          </div>

          {cameraMode === "VIDEO" && isRecording ? (
            <div className="camera-recording-indicator">
              <span className="camera-recording-dot" />
              REC {formatRecordingTime(recordingSeconds)}
            </div>
          ) : (
            <div className="camera-subtitle">
              {facingMode === "environment" ? "Rear camera" : "Front camera"}
            </div>
          )}
        </div>

        <div className="camera-topbar-group camera-topbar-group-right">
          {cameraMode === "PHOTO" ? (
            <button
              type="button"
              className={`camera-icon-btn ${flashEnabled ? "active" : ""}`}
              onClick={handleToggleFlash}
              disabled={busy || cameraStarting}
            >
              Flash
            </button>
          ) : null}

          <button
            type="button"
            className="camera-icon-btn"
            onClick={handleFlipCamera}
            disabled={busy || cameraStarting || isRecording}
          >
            Flip
          </button>
        </div>
      </div>

      <div className="camera-added-pill">{sessionItemsCount} added</div>

      <div className="camera-bottombar">
        <div className="camera-bottombar-meta">
          {cameraError ? (
            <div className="camera-inline-error">{cameraError}</div>
          ) : cameraMode === "PHOTO" ? (
            <div className="camera-helper-text">
              Capture repeatedly to add multiple photos into one evidence record.
            </div>
          ) : !isRecording ? (
            <div className="camera-helper-text">
              Record a clip, it will be auto-added to the same evidence session.
            </div>
          ) : (
            <div className="camera-helper-text">
              Recording… {formatRecordingTime(recordingSeconds)}
            </div>
          )}
        </div>

        <div className="camera-bottombar-actions">
          {cameraMode === "PHOTO" ? (
            <button
              type="button"
              className="camera-capture-btn"
              onClick={capturePhotoFromCamera}
              disabled={busy || cameraStarting}
            >
              Add to Evidence Session
            </button>
          ) : !isRecording ? (
            <button
              type="button"
              className="camera-capture-btn"
              onClick={startVideoRecording}
              disabled={busy || cameraStarting}
            >
              Record
            </button>
          ) : (
            <button
              type="button"
              className="camera-capture-btn danger"
              onClick={stopVideoRecording}
              disabled={busy}
            >
              Stop & Add
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
