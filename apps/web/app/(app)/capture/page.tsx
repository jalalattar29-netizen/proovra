"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, useToast } from "../../../components/ui";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type EvidenceType = "PHOTO" | "VIDEO" | "DOCUMENT";
type CameraMode = "PHOTO" | "VIDEO" | null;
type FacingMode = "user" | "environment";

export default function CapturePage() {
  const { t } = useLocale();
  const router = useRouter();
  const { addToast } = useToast();

  const [type, setType] = useState<EvidenceType>("PHOTO");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useLocation, setUseLocation] = useState(false);
  const [progress, setProgress] = useState<number>(0);

  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);
  const [capturedImageUrl, setCapturedImageUrl] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<FacingMode>("environment");
  const [cameraStarting, setCameraStarting] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [flashEnabled, setFlashEnabled] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordedObjectUrlRef = useRef<string | null>(null);
  const capturedImageObjectUrlRef = useRef<string | null>(null);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const pollReport = async (evidenceId: string) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await apiFetch(`/v1/evidence/${evidenceId}/report/latest`, { method: "GET" });
        return;
      } catch {
        await sleep(2000);
      }
    }
  };

  const formatRecordingTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0");
    const secs = (seconds % 60).toString().padStart(2, "0");
    return `${mins}:${secs}`;
  };

  const clearRecordedPreview = () => {
    if (recordedObjectUrlRef.current) {
      URL.revokeObjectURL(recordedObjectUrlRef.current);
      recordedObjectUrlRef.current = null;
    }
    setRecordedVideoUrl(null);
  };

  const clearCapturedImagePreview = () => {
    if (capturedImageObjectUrlRef.current) {
      URL.revokeObjectURL(capturedImageObjectUrlRef.current);
      capturedImageObjectUrlRef.current = null;
    }
    setCapturedImageUrl(null);
  };

  const clearAllGeneratedPreviews = () => {
    clearRecordedPreview();
    clearCapturedImagePreview();
  };

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
    return () => {
      stopMediaStream();
      clearAllGeneratedPreviews();
      if (typeof document !== "undefined") {
        document.body.classList.remove("camera-open");
      }
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;

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

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const startCameraStream = async (
    mode: "PHOTO" | "VIDEO",
    nextFacingMode: FacingMode
  ) => {
    setCameraError(null);
    setCameraStarting(true);

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera is not supported in this browser.");
      setCameraStarting(false);
      return;
    }

    try {
      stopMediaStream();

      setCameraMode(mode);
      setCameraOpen(true);
      setFacingMode(nextFacingMode);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: nextFacingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: mode === "VIDEO",
      });

      mediaStreamRef.current = stream;
      await attachStreamToPreview(stream);
    } catch (err) {
      captureException(err, {
        feature: "web_capture_open_camera",
        mode,
        facingMode: nextFacingMode,
      });
      setCameraError("Unable to access camera or microphone. Please check browser permissions.");
      setCameraOpen(false);
    } finally {
      setCameraStarting(false);
    }
  };

  const openCamera = async (mode: "PHOTO" | "VIDEO") => {
    setError(null);
    setCameraError(null);
    setIsRecording(false);
    setRecordingSeconds(0);
    clearAllGeneratedPreviews();
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
      next
        ? "Flash overlay enabled (visual preview only on web)"
        : "Flash overlay disabled",
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

    const capturedFile = new File([blob], `capture-${Date.now()}.jpg`, {
      type: "image/jpeg",
      lastModified: Date.now(),
    });

    clearCapturedImagePreview();
    const objectUrl = URL.createObjectURL(blob);
    capturedImageObjectUrlRef.current = objectUrl;
    setCapturedImageUrl(objectUrl);

    setFile(capturedFile);
    addToast("Photo captured successfully", "success");
    closeCamera();
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
        preferredMimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const finalMimeType = recorder.mimeType || "video/webm";
        const blob = new Blob(recordedChunksRef.current, { type: finalMimeType });

        if (blob.size === 0) {
          setCameraError("Recorded video is empty.");
          return;
        }

        const extension = finalMimeType.includes("mp4") ? "mp4" : "webm";
        const recordedFile = new File([blob], `capture-${Date.now()}.${extension}`, {
          type: finalMimeType,
          lastModified: Date.now(),
        });

        setFile(recordedFile);

        clearRecordedPreview();
        const objectUrl = URL.createObjectURL(blob);
        recordedObjectUrlRef.current = objectUrl;
        setRecordedVideoUrl(objectUrl);

        addToast("Video recorded successfully", "success");
        setIsRecording(false);
        closeCamera();
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setIsRecording(true);
      addToast("Recording started", "info");
    } catch (err) {
      captureException(err, { feature: "web_capture_start_recording" });
      setCameraError("Unable to start video recording.");
    }
  };

  const stopVideoRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    recorder.stop();
    addToast("Finishing video recording...", "info");
  };

  const handleRetake = async () => {
    setFile(null);
    setError(null);
    clearAllGeneratedPreviews();

    if (type === "DOCUMENT") {
      openFilePicker();
      return;
    }

    await openCamera(type === "PHOTO" ? "PHOTO" : "VIDEO");
  };

  const handleCapture = async () => {
    setError(null);

    if (!file) {
      addToast("Please select, capture, or record a file first", "error");
      return;
    }

    setBusy(true);

    const MAX_ATTEMPTS = 2;

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          addToast("Creating evidence record...", "info");

          const mimeType = file.type || "application/octet-stream";
          const deviceTimeIso = new Date().toISOString();
          let gps: { lat: number; lng: number; accuracyMeters?: number } | undefined;

          if (useLocation && typeof navigator !== "undefined" && navigator.geolocation) {
            addToast("Requesting location...", "info");
            gps = await new Promise((resolve, reject) => {
              navigator.geolocation.getCurrentPosition(
                (pos) =>
                  resolve({
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    accuracyMeters: pos.coords.accuracy,
                  }),
                (err) => reject(err),
                { enableHighAccuracy: true, timeout: 8000 }
              );
            });
          }

          const data = await apiFetch("/v1/evidence", {
            method: "POST",
            body: JSON.stringify({ type, mimeType, deviceTimeIso, gps }),
          });

          addToast("Uploading file...", "info");
          setProgress(0);

          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();

            xhr.upload.onprogress = (event) => {
              if (event.lengthComputable) {
                setProgress(Math.round((event.loaded / event.total) * 100));
              }
            };

            xhr.onerror = () => reject(new Error("Upload failed"));

            xhr.onload = () => {
              if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
                resolve();
              } else {
                reject(new Error(`Upload failed (${xhr.status})`));
              }
            };

            xhr.open("PUT", data.upload.putUrl);
            xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
            xhr.send(file);
          });

          addToast("Finalizing evidence...", "info");
          await apiFetch(`/v1/evidence/${data.id}/complete`, { method: "POST", body: "{}" });

          await pollReport(data.id);
          addToast("Evidence captured successfully!", "success");
          router.push(`/evidence/${data.id}`);
          return;
        } catch (err) {
          if (attempt === MAX_ATTEMPTS) throw err;
          addToast(`Upload failed, retrying (${attempt}/${MAX_ATTEMPTS})...`, "warning");
        }
      }
    } catch (err) {
      captureException(err, { feature: "web_capture" });

      const baseMsg = err instanceof Error ? err.message : "Capture failed";
      const reqId = (err as { requestId?: string }).requestId;

      const msg =
        reqId && typeof baseMsg === "string" && !baseMsg.includes("requestId:")
          ? `${baseMsg} (requestId: ${reqId})`
          : baseMsg;

      setError(msg);
      addToast(msg, "error");
    } finally {
      setBusy(false);
    }
  };

  const uploadLabel =
    type === "PHOTO"
      ? "Upload Photo"
      : type === "VIDEO"
        ? "Upload Video"
        : "Upload Document";

  const cameraLabel =
    type === "PHOTO"
      ? "Use Camera"
      : type === "VIDEO"
        ? "Record Video"
        : null;

  const cameraTitle =
    cameraMode === "PHOTO"
      ? "Photo Camera"
      : cameraMode === "VIDEO"
        ? "Video Recorder"
        : "Camera";

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title" style={{ marginBottom: 0 }}>
            <div>
              <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
                {t("capture")}
              </h1>
              <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
                Upload, capture, or record evidence and generate a signed report.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container">
          <Card>
            <div style={{ display: "grid", gap: 16 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {([
                  { label: t("photo"), value: "PHOTO" },
                  { label: t("video"), value: "VIDEO" },
                  { label: t("document"), value: "DOCUMENT" },
                ] as const).map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={`pill-button ${type === item.value ? "active" : ""}`}
                    onClick={() => {
                      setType(item.value);
                      setFile(null);
                      setError(null);
                      setCameraError(null);
                      clearAllGeneratedPreviews();
                      closeCamera();
                      if (fileInputRef.current) {
                        fileInputRef.current.value = "";
                      }
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <input
                type="file"
                aria-label="Upload evidence file"
                accept={
                  type === "PHOTO"
                    ? "image/*"
                    : type === "VIDEO"
                      ? "video/*"
                      : "application/pdf,.pdf,.doc,.docx,.txt,.rtf"
                }
                onChange={(event) => {
                  const nextFile = event.target.files?.[0] ?? null;
                  setFile(nextFile);
                  setError(null);
                  clearAllGeneratedPreviews();
                }}
                ref={fileInputRef}
                style={{ display: "none" }}
              />

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Button variant="secondary" onClick={openFilePicker} disabled={busy}>
                  {uploadLabel}
                </Button>

                {cameraLabel ? (
                  <Button
                    variant="secondary"
                    onClick={() => openCamera(type === "PHOTO" ? "PHOTO" : "VIDEO")}
                    disabled={busy}
                  >
                    {cameraLabel}
                  </Button>
                ) : null}
              </div>

              <div
                className="drop-zone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const dropped = event.dataTransfer.files?.[0] ?? null;
                  if (dropped) {
                    setFile(dropped);
                    setError(null);
                    clearAllGeneratedPreviews();
                  }
                }}
                onClick={openFilePicker}
              >
                {file ? (
                  <div>
                    <div style={{ fontWeight: 600 }}>{file.name}</div>
                    <div className="drop-meta">
                      {(file.size / 1024 / 1024).toFixed(2)} MB
                    </div>
                  </div>
                ) : (
                  <div className="drop-hint">
                    Drag &amp; drop or click to select {type === "DOCUMENT" ? "a document" : "a file"}
                  </div>
                )}
              </div>

              {capturedImageUrl && type === "PHOTO" ? (
                <div className="capture-preview-card">
                  <div className="capture-preview-title">Captured photo preview</div>
                  <img
                    src={capturedImageUrl}
                    alt="Captured evidence preview"
                    className="capture-preview-image"
                  />
                  <div className="capture-preview-actions">
                    <Button variant="secondary" onClick={handleRetake} disabled={busy}>
                      Retake
                    </Button>
                  </div>
                </div>
              ) : null}

              {recordedVideoUrl && type === "VIDEO" ? (
                <div className="capture-preview-card">
                  <div className="capture-preview-title">Recorded video preview</div>
                  <video
                    src={recordedVideoUrl}
                    controls
                    playsInline
                    className="capture-preview-video"
                  />
                  <div className="capture-preview-actions">
                    <Button variant="secondary" onClick={handleRetake} disabled={busy}>
                      Retake
                    </Button>
                  </div>
                </div>
              ) : null}

              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={useLocation}
                  onChange={(event) => setUseLocation(event.target.checked)}
                />
                Include location metadata (optional)
              </label>

              {busy ? <div className="uploading-hint">Uploading… {progress}%</div> : null}

              {error && <div className="error-text">{error}</div>}

              <div>
                <Button onClick={handleCapture} disabled={busy || !file}>
                  {busy ? "Capturing..." : "Capture & Sign"}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {cameraOpen ? (
        <div className={`camera-overlay ${flashEnabled ? "camera-overlay-flash" : ""}`}>
          <video
            ref={videoPreviewRef}
            autoPlay
            muted={cameraMode !== "VIDEO"}
            playsInline
            className="camera-preview"
          />

          <div className="camera-topbar">
            <div className="camera-topbar-group">
              <button
                type="button"
                className="camera-icon-btn"
                onClick={closeCamera}
                disabled={busy || cameraStarting}
              >
                Close
              </button>
            </div>

            <div className="camera-topbar-title-group">
              <div className="camera-title">{cameraTitle}</div>
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

          <div className="camera-bottombar">
            <div className="camera-bottombar-meta">
              {cameraError ? (
                <div className="camera-inline-error">{cameraError}</div>
              ) : cameraMode === "PHOTO" ? (
                <div className="camera-helper-text">
                  Align the evidence clearly, then capture.
                </div>
              ) : !isRecording ? (
                <div className="camera-helper-text">
                  Start recording when ready.
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
                  Capture
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
                  Stop
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}