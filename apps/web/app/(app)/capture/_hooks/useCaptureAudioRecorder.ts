import { MutableRefObject, useEffect, useRef, useState } from "react";

import type { AudioRecorderState } from "../_lib/types";
import {
  buildAudioRecordingFileName,
  normalizeClientMimeType,
  pickSupportedAudioMimeType,
} from "../_lib/file-utils";
import {
  describeMediaError,
  logCaptureClientError,
} from "../_lib/capture-errors";
import type { CaptureSessionAddFiles } from "./useCaptureSessionOrchestration";

type CaptureToast = (
  message: string,
  tone: "success" | "error" | "info" | "warning",
  duration?: number
) => void;

type UseCaptureAudioRecorderParams = {
  addFilesToSessionRef: MutableRefObject<CaptureSessionAddFiles | null>;
  addToast: CaptureToast;
  closeCamera: () => void;
  onClearPageError: () => void;
};

export function useCaptureAudioRecorder({
  addFilesToSessionRef,
  addToast,
  closeCamera,
  onClearPageError,
}: UseCaptureAudioRecorderParams) {
  const [audioRecorderOpen, setAudioRecorderOpen] = useState(false);
  const [audioRecorderState, setAudioRecorderState] =
    useState<AudioRecorderState>("idle");
  const [audioRecorderError, setAudioRecorderError] = useState<string | null>(null);
  const [, setAudioRecordingSeconds] = useState(0);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);
  const [audioPreviewFile, setAudioPreviewFile] = useState<File | null>(null);

  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioPreviewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    audioPreviewUrlRef.current = audioPreviewUrl;
  }, [audioPreviewUrl]);

  const stopAudioStream = () => {
    audioStreamRef.current?.getTracks().forEach((track) => track.stop());
    audioStreamRef.current = null;
  };

  const clearAudioPreview = () => {
    if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
    setAudioPreviewUrl(null);
    setAudioPreviewFile(null);
  };

  const resetAudioRecorderState = () => {
    if (audioRecorderRef.current && audioRecorderRef.current.state !== "inactive") {
      audioRecorderRef.current.stop();
    }

    stopAudioStream();
    audioRecorderRef.current = null;
    audioChunksRef.current = [];
    clearAudioPreview();
    setAudioRecorderOpen(false);
    setAudioRecorderState("idle");
    setAudioRecorderError(null);
    setAudioRecordingSeconds(0);
  };

  useEffect(() => {
    if (audioRecorderState !== "recording") {
      setAudioRecordingSeconds(0);
      return;
    }

    const timer = window.setInterval(() => {
      setAudioRecordingSeconds((prev) => prev + 1);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [audioRecorderState]);

  useEffect(() => {
    return () => {
      stopAudioStream();

      if (audioPreviewUrlRef.current) {
        URL.revokeObjectURL(audioPreviewUrlRef.current);
      }
    };
  }, []);

  const openAudioRecorder = () => {
    closeCamera();
    onClearPageError();

    if (audioRecorderOpen && audioRecorderState !== "recording") {
      resetAudioRecorderState();
      return;
    }

    setAudioRecorderOpen(true);
    setAudioRecorderError(null);

    if (audioRecorderState === "failed") {
      setAudioRecorderState("idle");
    }
  };

  const startAudioRecording = async () => {
    setAudioRecorderOpen(true);
    setAudioRecorderError(null);
    clearAudioPreview();

    if (!navigator.mediaDevices?.getUserMedia) {
      setAudioRecorderState("failed");
      setAudioRecorderError(
        "Audio recording is not supported in this browser. Upload an audio file instead."
      );
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      setAudioRecorderState("failed");
      setAudioRecorderError(
        "Audio recording is not supported in this browser. Upload an audio file instead."
      );
      return;
    }

    try {
      const preferredMimeType = pickSupportedAudioMimeType();
      let stream: MediaStream;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      stopAudioStream();
      audioStreamRef.current = stream;
      audioChunksRef.current = [];

      const recorder =
        preferredMimeType !== null && preferredMimeType !== ""
          ? new MediaRecorder(stream, { mimeType: preferredMimeType })
          : new MediaRecorder(stream);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        logCaptureClientError("web_capture_audio_recorder_error", event, {
          state: recorder.state,
        });

        stopAudioStream();
        setAudioRecorderState("failed");
        setAudioRecorderError(
          "Audio recording could not be completed. No evidence record was created."
        );
      };

      recorder.onstop = () => {
        stopAudioStream();

        const finalMimeType = normalizeClientMimeType(
          recorder.mimeType || preferredMimeType || "audio/webm",
          "audio/webm"
        );

        const blob = new Blob(audioChunksRef.current, {
          type: finalMimeType,
        });

        if (!blob.size) {
          setAudioRecorderState("failed");
          setAudioRecorderError(
            "Audio recording could not be completed. No evidence record was created."
          );
          return;
        }

        const extension = finalMimeType.includes("ogg")
          ? "ogg"
          : finalMimeType.includes("mp4")
            ? "m4a"
            : "webm";

        const previewUrl = URL.createObjectURL(blob);
        const recordedFile = new File([blob], buildAudioRecordingFileName(extension), {
          type: finalMimeType,
          lastModified: Date.now(),
        });

        setAudioPreviewUrl(previewUrl);
        setAudioPreviewFile(recordedFile);
        setAudioRecorderState("preview_ready");
        addToast("Audio recording ready for review", "success");
      };

      audioRecorderRef.current = recorder;
      recorder.start(250);
      setAudioRecorderState("recording");
      addToast("Audio recording started", "info");
    } catch (err) {
      logCaptureClientError("web_capture_start_audio_recording", err, {});

      setAudioRecorderState("failed");
      setAudioRecorderError(
        describeMediaError(err, {
          permissionDenied:
            "Microphone permission was denied. Enable microphone access or upload an existing audio file.",
          notFound:
            "No microphone device is available in this browser. Upload an audio file instead.",
          busy:
            "The microphone is currently unavailable. Close other apps using it and try again.",
          constrained:
            "This browser could not satisfy the requested audio recording settings. Upload an audio file instead.",
          security:
            "Browser security settings blocked microphone access. Upload an audio file instead.",
          fallback: "Audio recording could not be started. Upload an audio file instead.",
        })
      );
    }
  };

  const stopAudioRecording = () => {
    const recorder = audioRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    recorder.stop();
    setAudioRecorderState("stopped");
    addToast("Finishing audio recording...", "info");
  };

  const discardAudioRecording = () => {
    resetAudioRecorderState();
    setAudioRecorderOpen(true);
    addToast("Audio recording discarded", "info");
  };

  const addAudioRecordingToSession = async () => {
    if (!audioPreviewFile) return;

    setAudioRecorderState("uploading");

    try {
      await addFilesToSessionRef.current?.([audioPreviewFile], {
        sessionEvidenceType: "AUDIO",
      });

      resetAudioRecorderState();
    } catch (err) {
      logCaptureClientError("web_capture_add_audio_to_session", err, {});
      setAudioRecorderState("failed");
      setAudioRecorderError(
        err instanceof Error
          ? err.message
          : "Audio recording could not be added to the evidence session."
      );
    }
  };

  return {
    addAudioRecordingToSession,
    audioPreviewFile,
    audioPreviewUrl,
    audioRecorderError,
    audioRecorderOpen,
    audioRecorderState,
    discardAudioRecording,
    openAudioRecorder,
    resetAudioRecorderState,
    startAudioRecording,
    stopAudioRecording,
  };
}
