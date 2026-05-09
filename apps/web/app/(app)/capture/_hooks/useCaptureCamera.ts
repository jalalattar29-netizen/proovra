import { MutableRefObject, useEffect, useRef, useState } from "react";

import type { CameraMode, FacingMode } from "../_lib/types";
import { normalizeClientMimeType } from "../_lib/file-utils";
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

type UseCaptureCameraParams = {
  addFilesToSessionRef: MutableRefObject<CaptureSessionAddFiles | null>;
  addToast: CaptureToast;
};

export function useCaptureCamera({
  addFilesToSessionRef,
  addToast,
}: UseCaptureCameraParams) {
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [facingMode, setFacingMode] = useState<FacingMode>("environment");
  const [cameraStarting, setCameraStarting] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [flashEnabled, setFlashEnabled] = useState(false);

  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  const stopMediaStream = () => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  };

  const attachStreamToPreview = async (stream: MediaStream) => {
    const video = videoPreviewRef.current;
    if (!video) return;

    video.srcObject = stream;

    await new Promise<void>((resolve) => {
      const onLoaded = () => {
        video.removeEventListener("loadedmetadata", onLoaded);
        resolve();
      };

      video.addEventListener("loadedmetadata", onLoaded);

      if (video.readyState >= 1) {
        video.removeEventListener("loadedmetadata", onLoaded);
        resolve();
      }
    });

    try {
      await video.play();
    } catch {
      // ignore autoplay issues
    }
  };

  const closeCamera = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }

    setIsRecording(false);
    setRecordingSeconds(0);
    stopMediaStream();
    mediaRecorderRef.current = null;

    const video = videoPreviewRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        // ignore
      }

      video.srcObject = null;
      video.load();
    }

    setCameraOpen(false);
    setCameraMode(null);
    setCameraError(null);
    setCameraStarting(false);
    setFlashEnabled(false);
  };

  useEffect(() => {
    if (cameraOpen) {
      document.body.classList.add("camera-open");
    } else {
      document.body.classList.remove("camera-open");
    }

    return () => {
      document.body.classList.remove("camera-open");
    };
  }, [cameraOpen]);

  useEffect(() => {
    if (!isRecording) {
      setRecordingSeconds(0);
      return;
    }

    const timer = window.setInterval(() => {
      setRecordingSeconds((prev) => prev + 1);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [isRecording]);

  useEffect(() => {
    return () => {
      stopMediaStream();
      document.body.classList.remove("camera-open");
    };
  }, []);

  const startCameraStream = async (
    mode: "PHOTO" | "VIDEO",
    nextFacingMode: FacingMode
  ) => {
    setCameraError(null);
    setCameraStarting(true);

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera is not supported in this browser.");
      setCameraStarting(false);
      return;
    }

    try {
      stopMediaStream();

      setCameraMode(mode);
      setCameraOpen(true);
      setFacingMode(nextFacingMode);

      const videoConstraints = {
        facingMode: { ideal: nextFacingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      } as const;

      let stream: MediaStream;
      let usedVideoOnlyFallback = false;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: mode === "VIDEO",
        });
      } catch (primaryError) {
        if (mode !== "VIDEO") throw primaryError;

        stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        });

        usedVideoOnlyFallback = true;
      }

      mediaStreamRef.current = stream;
      await attachStreamToPreview(stream);

      if (usedVideoOnlyFallback) {
        setCameraError(
          "Video recorder opened without microphone audio. Check microphone permissions if audio capture is required."
        );
      }
    } catch (err) {
      logCaptureClientError("web_capture_open_camera", err, {
        mode,
        facingMode: nextFacingMode,
      });

      setCameraError(
        describeMediaError(err, {
          permissionDenied:
            mode === "VIDEO"
              ? "Camera or microphone permission was denied. Allow device access to record video evidence."
              : "Camera permission was denied. Allow camera access to capture photo evidence.",
          notFound:
            mode === "VIDEO"
              ? "No camera device is available for video recording on this device."
              : "No camera device is available for photo capture on this device.",
          busy:
            mode === "VIDEO"
              ? "The camera or microphone is currently unavailable. Close other apps using them and try again."
              : "The camera is currently unavailable. Close other apps using it and try again.",
          constrained:
            mode === "VIDEO"
              ? "This browser could not satisfy the requested video recording settings. Try a different browser or device."
              : "This browser could not satisfy the requested camera settings. Try a different browser or device.",
          security:
            mode === "VIDEO"
              ? "Browser security settings blocked camera or microphone access."
              : "Browser security settings blocked camera access.",
          fallback:
            mode === "VIDEO" ? "Unable to open the video recorder." : "Unable to open the camera.",
        })
      );

      setCameraOpen(false);
    } finally {
      setCameraStarting(false);
    }
  };

  const openCamera = async (mode: "PHOTO" | "VIDEO") => {
    setCameraError(null);
    setIsRecording(false);
    setRecordingSeconds(0);
    await startCameraStream(mode, facingMode);
  };

  const handleFlipCamera = async () => {
    if (!cameraMode || cameraStarting || isRecording) return;

    const nextFacingMode: FacingMode =
      facingMode === "environment" ? "user" : "environment";

    await startCameraStream(cameraMode, nextFacingMode);
  };

  const handleToggleFlash = () => {
    const next = !flashEnabled;
    setFlashEnabled(next);

    addToast(
      next ? "Flash overlay enabled (visual preview only on web)" : "Flash overlay disabled",
      "info"
    );
  };

  const capturePhotoFromCamera = async () => {
    const video = videoPreviewRef.current;

    if (!video || !video.videoWidth || !video.videoHeight) {
      setCameraError("Camera preview is not ready yet.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setCameraError("Unable to capture image.");
      return;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.92);
    });

    if (!blob) {
      setCameraError("Failed to capture photo.");
      return;
    }

    const capturedFile = new File(
      [blob],
      `PROOVRA-CAPTURE-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`,
      {
        type: "image/jpeg",
        lastModified: Date.now(),
      }
    );

    try {
      await addFilesToSessionRef.current?.([capturedFile], {
        sessionEvidenceType: "PHOTO",
      });
    } catch {
      setCameraError("Failed to add the captured photo to this evidence session.");
    }
  };

  const startVideoRecording = () => {
    const stream = mediaStreamRef.current;

    if (!stream) {
      setCameraError("Camera stream is not available.");
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      setCameraError("Video recording is not supported in this browser.");
      return;
    }

    try {
      recordedChunksRef.current = [];
      setRecordingSeconds(0);

      const preferredMimeTypes = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
        "video/mp4",
      ];

      const mimeType =
        typeof MediaRecorder.isTypeSupported === "function"
          ? preferredMimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || ""
          : preferredMimeTypes[2] ?? "";

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const finalMimeType = normalizeClientMimeType(
          recorder.mimeType || "video/webm",
          "video/webm"
        );

        const blob = new Blob(recordedChunksRef.current, {
          type: finalMimeType,
        });

        if (blob.size === 0) {
          setCameraError("Recorded video is empty.");
          return;
        }

        const extension = finalMimeType.includes("mp4") ? "mp4" : "webm";

        const recordedFile = new File(
          [blob],
          `PROOVRA-VIDEO-CAPTURE-${new Date()
            .toISOString()
            .replace(/[:.]/g, "-")}.${extension}`,
          {
            type: finalMimeType,
            lastModified: Date.now(),
          }
        );

        try {
          await addFilesToSessionRef.current?.([recordedFile], {
            sessionEvidenceType: "VIDEO",
          });
        } catch {
          setCameraError("Failed to add the recorded video to this evidence session.");
        }

        setIsRecording(false);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setIsRecording(true);
      addToast("Recording started", "info");
    } catch (err) {
      logCaptureClientError("web_capture_start_recording", err, {
        cameraMode,
      });

      setCameraError(
        describeMediaError(err, {
          permissionDenied:
            "Camera or microphone permission was denied. Allow access to record video evidence.",
          notFound: "A camera device is not available for video recording.",
          busy:
            "The camera or microphone is currently unavailable. Close other apps using them and try again.",
          constrained:
            "This browser could not start the requested recording settings. Try a different browser or device.",
          security: "Browser security settings blocked video recording.",
          fallback: "Unable to start video recording.",
        })
      );
    }
  };

  const stopVideoRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    recorder.stop();
    addToast("Finishing video recording...", "info");
  };

  return {
    cameraError,
    cameraMode,
    cameraOpen,
    cameraStarting,
    capturePhotoFromCamera,
    closeCamera,
    facingMode,
    flashEnabled,
    handleFlipCamera,
    handleToggleFlash,
    isRecording,
    openCamera,
    recordingSeconds,
    startVideoRecording,
    stopVideoRecording,
    videoPreviewRef,
  };
}
