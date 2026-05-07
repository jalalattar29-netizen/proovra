import { Button } from "../ui";

type AudioRecorderState =
  | "idle"
  | "recording"
  | "stopped"
  | "preview_ready"
  | "uploading"
  | "failed";

type Props = {
  open: boolean;
  busy: boolean;
  audioRecorderState: AudioRecorderState;
  audioRecorderError: string | null;
  audioRecordingSeconds: number;
  audioPreviewUrl: string | null;
  formatRecordingTime: (seconds: number) => string;
  startAudioRecording: () => void;
  stopAudioRecording: () => void;
  discardAudioRecording: () => void;
  addAudioRecordingToSession: () => void;
  primaryButtonStyle: React.CSSProperties;
  secondaryButtonStyle: React.CSSProperties;
  tertiaryButtonStyle: React.CSSProperties;
};

export function CaptureAudioRecorder({
  open,
  busy,
  audioRecorderState,
  audioRecorderError,
  audioRecordingSeconds,
  audioPreviewUrl,
  formatRecordingTime,
  startAudioRecording,
  stopAudioRecording,
  discardAudioRecording,
  addAudioRecordingToSession,
  primaryButtonStyle,
  secondaryButtonStyle,
  tertiaryButtonStyle,
}: Props) {
  if (!open) return null;

  return (
    <div className="capture-audio-recorder">
      <div className="capture-audio-header">
        <strong>Audio Recorder</strong>

{audioRecorderState === "recording" ? (
  <span className="capture-card-muted">
    Recording · {formatRecordingTime(audioRecordingSeconds)}
  </span>
) : audioRecorderState === "preview_ready" ? (
  <span className="capture-card-muted">
    Preview ready
  </span>
) : null}
      </div>

      {audioPreviewUrl ? (
        <audio
          controls
          preload="metadata"
          src={audioPreviewUrl}
          style={{ width: "100%" }}
        >
          Your browser could not play this audio preview.
        </audio>
      ) : null}

      {audioRecorderError ? (
        <div className="capture-quality-danger capture-inline-alert">
          {audioRecorderError}
        </div>
      ) : null}

      <div className="capture-audio-actions">
        <Button
          variant="secondary"
          onClick={startAudioRecording}
          disabled={busy || audioRecorderState === "recording"}
          className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
          style={secondaryButtonStyle}
        >
          Start Recording
        </Button>

        <Button
          variant="secondary"
          onClick={stopAudioRecording}
          disabled={audioRecorderState !== "recording"}
          className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
          style={tertiaryButtonStyle}
        >
          Stop
        </Button>

        <Button
          variant="secondary"
          onClick={discardAudioRecording}
          disabled={
            audioRecorderState === "recording" ||
            audioRecorderState === "uploading"
          }
          className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
          style={tertiaryButtonStyle}
        >
          Discard
        </Button>

        <Button
          variant="primary"
          onClick={addAudioRecordingToSession}
          disabled={audioRecorderState !== "preview_ready"}
          className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
          style={primaryButtonStyle}
        >
          Add to Session
        </Button>
      </div>
    </div>
  );
}