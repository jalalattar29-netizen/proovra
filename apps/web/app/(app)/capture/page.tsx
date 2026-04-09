"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, useToast } from "../../../components/ui";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type EvidenceType = "PHOTO" | "VIDEO" | "DOCUMENT";
type CameraMode = "PHOTO" | "VIDEO" | null;
type FacingMode = "user" | "environment";

type SessionItem = {
  id: string;
  file: File;
  previewUrl: string | null;
  mimeType: string;
  uploadProgress: number;
  uploading: boolean;
  error?: string | null;
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function leftRotate(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

function md5ArrayBuffer(buffer: ArrayBuffer): ArrayBuffer {
  const input = new Uint8Array(buffer);
  const originalLength = input.length;
  const bitLength = originalLength * 8;

  const paddedLength = (((originalLength + 8) >> 6) + 1) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[originalLength] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(
    paddedLength - 4,
    Math.floor(bitLength / 0x100000000) >>> 0,
    true
  );

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  const k = new Array<number>(64)
    .fill(0)
    .map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const m = new Array<number>(16);
    for (let i = 0; i < 16; i += 1) {
      m[i] = view.getUint32(offset + i * 4, true);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i += 1) {
      let f = 0;
      let g = 0;

      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const tmp = d;
      d = c;
      c = b;

      const sum = (((a + f) >>> 0) + ((k[i] + m[g]) >>> 0)) >>> 0;
      b = (b + leftRotate(sum, s[i])) >>> 0;
      a = tmp;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new ArrayBuffer(16);
  const outView = new DataView(out);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

async function computeIntegrityFromBlob(blob: Blob): Promise<{
  checksumSha256Base64: string;
  contentMd5Base64: string;
}> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto API is not available in this browser");
  }

  const buffer = await blob.arrayBuffer();
  const sha256Digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  const md5Digest = md5ArrayBuffer(buffer);

  return {
    checksumSha256Base64: arrayBufferToBase64(sha256Digest),
    contentMd5Base64: arrayBufferToBase64(md5Digest),
  };
}

export default function CapturePage() {
  const { t } = useLocale();
  const router = useRouter();
  const { addToast } = useToast();

  const [type, setType] = useState<EvidenceType>("PHOTO");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useLocation, setUseLocation] = useState(false);
  const [progress, setProgress] = useState<number>(0);

  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [facingMode, setFacingMode] = useState<FacingMode>("environment");
  const [cameraStarting, setCameraStarting] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [flashEnabled, setFlashEnabled] = useState(false);

  const [sessionEvidenceId, setSessionEvidenceId] = useState<string | null>(null);
  const [sessionItems, setSessionItems] = useState<SessionItem[]>([]);
  const [sessionInfo, setSessionInfo] = useState<string | null>(null);
  const [sessionCreating, setSessionCreating] = useState(false);
  const [locationPermissionDenied, setLocationPermissionDenied] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const sessionItemsRef = useRef<SessionItem[]>([]);
  const sessionEvidenceIdRef = useRef<string | null>(null);

  useEffect(() => {
    sessionItemsRef.current = sessionItems;
  }, [sessionItems]);

  useEffect(() => {
    sessionEvidenceIdRef.current = sessionEvidenceId;
  }, [sessionEvidenceId]);

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

  const revokeItemPreview = (item: SessionItem) => {
    if (item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
  };

  const revokeAllPreviews = () => {
    sessionItemsRef.current.forEach(revokeItemPreview);
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
      revokeAllPreviews();
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

  const createEvidenceSessionIfNeeded = async (firstFile: File) => {
    if (sessionEvidenceIdRef.current) {
      return sessionEvidenceIdRef.current;
    }

    setSessionCreating(true);
    setSessionInfo("Creating evidence session...");
    setError(null);

    try {
      const deviceTimeIso = new Date().toISOString();
      let gps: { lat: number; lng: number; accuracyMeters?: number } | undefined;

      if (useLocation && typeof navigator !== "undefined" && navigator.geolocation) {
        try {
          gps = await new Promise<{ lat: number; lng: number; accuracyMeters?: number }>(
            (resolve, reject) => {
              navigator.geolocation.getCurrentPosition(
                (pos) =>
                  resolve({
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    accuracyMeters: pos.coords.accuracy,
                  }),
                (geoErr) => reject(geoErr),
                { enableHighAccuracy: true, timeout: 8000 }
              );
            }
          );
          setLocationPermissionDenied(false);
        } catch {
          setLocationPermissionDenied(true);
          addToast("Location unavailable. Continuing without GPS.", "warning");
        }
      }

      const integrity = await computeIntegrityFromBlob(firstFile);

      const created = await apiFetch("/v1/evidence", {
        method: "POST",
        body: JSON.stringify({
          type,
          mimeType: firstFile.type || "application/octet-stream",
          deviceTimeIso,
          gps,
          checksumSha256Base64: integrity.checksumSha256Base64,
          contentMd5Base64: integrity.contentMd5Base64,
        }),
      });

      setSessionEvidenceId(created.id);
      setSessionInfo(null);
      addToast("Evidence session created", "success");
      return created.id as string;
    } finally {
      setSessionCreating(false);
    }
  };

  const addFilesToSession = async (files: File[]) => {
    if (!files.length) return;

    setError(null);
    setSessionInfo(null);

    try {
      await createEvidenceSessionIfNeeded(files[0]);

      const nextItems: SessionItem[] = files.map((nextFile) => ({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        file: nextFile,
        previewUrl:
          nextFile.type.startsWith("image/") || nextFile.type.startsWith("video/")
            ? URL.createObjectURL(nextFile)
            : null,
        mimeType: nextFile.type || "application/octet-stream",
        uploadProgress: 0,
        uploading: false,
        error: null,
      }));

      setSessionItems((prev) => [...prev, ...nextItems]);
      addToast(
        `${files.length} item${files.length > 1 ? "s" : ""} added to session`,
        "success"
      );
    } catch (err) {
      captureException(err, { feature: "web_capture_add_to_session", type });
      const message = err instanceof Error ? err.message : "Failed to add items to session";
      setError(message);
      addToast(message, "error");
    }
  };

  const removeSessionItem = (itemId: string) => {
    setSessionItems((prev) => {
      const found = prev.find((item) => item.id === itemId);
      if (found) revokeItemPreview(found);
      return prev.filter((item) => item.id !== itemId);
    });
    addToast("Item removed from session", "info");
  };

  const resetCaptureState = () => {
    revokeAllPreviews();
    setSessionEvidenceId(null);
    setSessionItems([]);
    setSessionInfo(null);
    setProgress(0);
    setError(null);
    setBusy(false);
  };

  const finalizeSession = async () => {
    const evidenceId = sessionEvidenceIdRef.current;
    const items = sessionItemsRef.current;

    if (!evidenceId || items.length === 0) {
      addToast("No items in session", "error");
      return;
    }

    setBusy(true);
    setError(null);
    setSessionInfo("Uploading session...");
    setProgress(0);

    try {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];

        setSessionItems((prev) =>
          prev.map((current) =>
            current.id === item.id
              ? { ...current, uploading: true, uploadProgress: 1, error: null }
              : current
          )
        );

        const integrity = await computeIntegrityFromBlob(item.file);

        const part = await apiFetch(`/v1/evidence/${evidenceId}/parts`, {
          method: "POST",
          body: JSON.stringify({
            partIndex: index,
            mimeType: item.mimeType,
            checksumSha256Base64: integrity.checksumSha256Base64,
            contentMd5Base64: integrity.contentMd5Base64,
          }),
        });

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();

          xhr.upload.onprogress = (event) => {
            if (!event.lengthComputable) return;

            const itemPct = Math.max(
              1,
              Math.min(100, Math.round((event.loaded / event.total) * 100))
            );

            setSessionItems((prev) =>
              prev.map((current) =>
                current.id === item.id
                  ? { ...current, uploading: true, uploadProgress: itemPct, error: null }
                  : current
              )
            );

            const overall = Math.round(
              ((index + event.loaded / event.total) / items.length) * 90
            );
            setProgress(Math.max(1, Math.min(90, overall)));
          };

          xhr.onerror = () => reject(new Error("Upload failed"));
          xhr.onload = () => {
            if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
              resolve();
            } else {
              reject(new Error(`Upload failed (${xhr.status})`));
            }
          };

          xhr.open("PUT", part.upload.putUrl);
          xhr.setRequestHeader("content-type", item.mimeType || "application/octet-stream");
          xhr.setRequestHeader("x-amz-checksum-sha256", integrity.checksumSha256Base64);
          xhr.setRequestHeader("Content-MD5", integrity.contentMd5Base64);
          xhr.send(item.file);
        });

        setSessionItems((prev) =>
          prev.map((current) =>
            current.id === item.id
              ? { ...current, uploading: false, uploadProgress: 100, error: null }
              : current
          )
        );
      }

      setSessionInfo("Finalizing evidence...");
      setProgress(95);

      await apiFetch(`/v1/evidence/${evidenceId}/complete`, {
        method: "POST",
        body: JSON.stringify({}),
      });

      await pollReport(evidenceId);

      setProgress(100);
      addToast("Evidence captured successfully!", "success");

      resetCaptureState();
      router.push(`/evidence/${evidenceId}`);
    } catch (err) {
      captureException(err, {
        feature: "web_capture_finalize_session",
        evidenceId,
        itemCount: items.length,
      });

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
      setSessionInfo(null);
    }
  };

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

    await addFilesToSession([capturedFile]);
    addToast("Photo captured and added", "success");
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

      recorder.onstop = async () => {
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

        await addFilesToSession([recordedFile]);
        addToast("Video recorded and added", "success");
        setIsRecording(false);
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

  const handleDroppedFiles = async (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;

    const filtered = files.filter((nextFile) => {
      if (type === "PHOTO") return nextFile.type.startsWith("image/");
      if (type === "VIDEO") return nextFile.type.startsWith("video/");
      return true;
    });

    if (!filtered.length) {
      addToast("No matching files for the selected capture type", "warning");
      return;
    }

    await addFilesToSession(filtered);
  };

  const sessionCountLabel = useMemo(() => {
    const count = sessionItems.length;
    return `${count} item${count === 1 ? "" : "s"} added`;
  }, [sessionItems.length]);

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
                Capture multiple photos, videos, or files into one signed evidence session.
              </p>
            </div>

            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                justifyContent: "flex-end",
              }}
            >
              <span
                className="badge ready"
                style={{
                  background: "rgba(158,216,207,0.12)",
                  borderColor: "rgba(158,216,207,0.22)",
                  color: "#bfe8df",
                }}
              >
                {sessionCountLabel}
              </span>
              {sessionEvidenceId ? (
                <span
                  className="badge processing"
                  style={{
                    background: "rgba(214,184,157,0.12)",
                    borderColor: "rgba(214,184,157,0.22)",
                    color: "#e6c9ae",
                  }}
                >
                  Session active
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container">
          <Card className="app-card">
            <div style={{ display: "grid", gap: 18, padding: 2 }}>
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
                      setError(null);
                      setCameraError(null);
                      closeCamera();
                      if (fileInputRef.current) {
                        fileInputRef.current.value = "";
                      }
                    }}
                    style={{
                      borderRadius: 999,
                      padding: "10px 16px",
                      fontWeight: 700,
                      border:
                        type === item.value
                          ? "1px solid rgba(214,184,157,0.22)"
                          : "1px solid rgba(255,255,255,0.08)",
                      background:
                        type === item.value
                          ? "linear-gradient(180deg, rgba(214,184,157,0.14), rgba(214,184,157,0.08))"
                          : "rgba(255,255,255,0.04)",
                      color: type === item.value ? "#f3ddc6" : "rgba(246,252,255,0.84)",
                      boxShadow:
                        type === item.value ? "0 10px 24px rgba(0,0,0,0.16)" : "none",
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <input
                type="file"
                aria-label="Upload evidence files"
                multiple
                accept={
                  type === "PHOTO"
                    ? "image/*"
                    : type === "VIDEO"
                      ? "video/*"
                      : "application/pdf,.pdf,.doc,.docx,.txt,.rtf"
                }
                onChange={async (event) => {
                  await handleDroppedFiles(event.target.files);
                  if (fileInputRef.current) {
                    fileInputRef.current.value = "";
                  }
                }}
                ref={fileInputRef}
                style={{ display: "none" }}
              />

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Button variant="secondary" onClick={openFilePicker} disabled={busy || sessionCreating}>
                  {type === "PHOTO"
                    ? "Add Photos"
                    : type === "VIDEO"
                      ? "Add Videos"
                      : "Add Documents"}
                </Button>

                {type !== "DOCUMENT" ? (
                  <Button
                    variant="secondary"
                    onClick={() => openCamera(type === "PHOTO" ? "PHOTO" : "VIDEO")}
                    disabled={busy || sessionCreating}
                  >
                    {type === "PHOTO" ? "Open Camera" : "Open Video Recorder"}
                  </Button>
                ) : null}
              </div>

              <div
                className="drop-zone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={async (event) => {
                  event.preventDefault();
                  await handleDroppedFiles(event.dataTransfer.files);
                }}
                onClick={openFilePicker}
                style={{
                  borderRadius: 22,
                  border: "1px dashed rgba(214,184,157,0.18)",
                  background:
                    "linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.02))",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
                  padding: "30px 20px",
                }}
              >
                <div
                  className="drop-hint"
                  style={{
                    color: "rgba(246,252,255,0.82)",
                    fontWeight: 600,
                    fontSize: 15,
                  }}
                >
                  Drag &amp; drop or click to add{" "}
                  {type === "PHOTO"
                    ? "photos"
                    : type === "VIDEO"
                      ? "videos"
                      : "documents"}{" "}
                  to this evidence session
                </div>
              </div>

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  color: "rgba(246,252,255,0.84)",
                  fontSize: 14,
                }}
              >
                <input
                  type="checkbox"
                  checked={useLocation}
                  onChange={(event) => setUseLocation(event.target.checked)}
                  disabled={Boolean(sessionEvidenceId)}
                />
                Include location metadata on session creation
              </label>

              {locationPermissionDenied ? (
                <div
                  className="error-text"
                  style={{
                    padding: 12,
                    borderRadius: 14,
                    background: "rgba(127,29,29,0.16)",
                    border: "1px solid rgba(248,113,113,0.16)",
                  }}
                >
                  Location was not granted. The current session will continue without GPS metadata.
                </div>
              ) : null}

              {sessionItems.length > 0 ? (
                <div
                  className="capture-preview-card"
                  style={{
                    padding: 18,
                    borderRadius: 22,
                    background:
                      "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.025))",
                    border: "1px solid rgba(214,184,157,0.12)",
                    boxShadow: "0 18px 40px rgba(0,0,0,0.16)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                      marginBottom: 14,
                    }}
                  >
                    <div
                      className="capture-preview-title"
                      style={{
                        color: "rgba(246,252,255,0.96)",
                        fontWeight: 800,
                        fontSize: 16,
                      }}
                    >
                      Session items
                    </div>
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "7px 12px",
                        borderRadius: 999,
                        background: "rgba(214,184,157,0.12)",
                        border: "1px solid rgba(214,184,157,0.22)",
                        color: "#f0dbc6",
                        fontSize: 12,
                        fontWeight: 800,
                      }}
                    >
                      {sessionCountLabel}
                    </div>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                      gap: 12,
                    }}
                  >
                    {sessionItems.map((item, index) => (
                      <div
                        key={item.id}
                        style={{
                          borderRadius: 18,
                          overflow: "hidden",
                          background: "rgba(8, 18, 34, 0.88)",
                          border: "1px solid rgba(255,255,255,0.06)",
                          boxShadow: "0 14px 30px rgba(0,0,0,0.16)",
                        }}
                      >
                        <div
                          style={{
                            position: "relative",
                            aspectRatio: "1 / 1",
                            background: "rgba(3, 10, 24, 0.95)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <div
                            style={{
                              position: "absolute",
                              top: 8,
                              left: 8,
                              zIndex: 2,
                              minWidth: 28,
                              height: 28,
                              borderRadius: 999,
                              background: "rgba(2, 6, 23, 0.82)",
                              border: "1px solid rgba(214,184,157,0.25)",
                              color: "#f2e0cf",
                              display: "grid",
                              placeItems: "center",
                              fontSize: 12,
                              fontWeight: 800,
                              padding: "0 8px",
                            }}
                          >
                            {index + 1}
                          </div>

                          {!busy ? (
                            <button
                              type="button"
                              onClick={() => removeSessionItem(item.id)}
                              style={{
                                position: "absolute",
                                top: 8,
                                right: 8,
                                zIndex: 2,
                                width: 30,
                                height: 30,
                                borderRadius: 999,
                                border: "1px solid rgba(239, 68, 68, 0.35)",
                                background: "rgba(127, 29, 29, 0.78)",
                                color: "#fff",
                                cursor: "pointer",
                                fontWeight: 800,
                              }}
                            >
                              ×
                            </button>
                          ) : null}

                          {item.previewUrl && item.mimeType.startsWith("image/") ? (
                            <img
                              src={item.previewUrl}
                              alt={item.file.name}
                              style={{
                                width: "100%",
                                height: "100%",
                                objectFit: "cover",
                              }}
                            />
                          ) : item.previewUrl && item.mimeType.startsWith("video/") ? (
                            <video
                              src={item.previewUrl}
                              muted
                              playsInline
                              controls={false}
                              style={{
                                width: "100%",
                                height: "100%",
                                objectFit: "cover",
                              }}
                            />
                          ) : (
                            <div
                              style={{
                                padding: 16,
                                textAlign: "center",
                                color: "#cbd5e1",
                                fontSize: 13,
                                lineHeight: 1.5,
                              }}
                            >
                              Document
                            </div>
                          )}
                        </div>

                        <div style={{ padding: 12, display: "grid", gap: 8 }}>
                          <div
                            style={{
                              color: "#eef4f1",
                              fontSize: 13,
                              fontWeight: 700,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                            title={item.file.name}
                          >
                            {item.file.name}
                          </div>

                          <div style={{ fontSize: 12, color: "rgba(219,235,248,0.60)" }}>
                            {(item.file.size / 1024 / 1024).toFixed(2)} MB
                          </div>

                          <div
                            style={{
                              height: 8,
                              borderRadius: 999,
                              background: "rgba(148, 163, 184, 0.14)",
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                width: `${item.uploadProgress}%`,
                                height: "100%",
                                background: "linear-gradient(90deg, #22d3ee, #38bdf8)",
                                transition: "width 0.2s ease",
                              }}
                            />
                          </div>

                          <div style={{ fontSize: 12, color: "#cbd5e1" }}>
                            {item.uploading
                              ? `Uploading ${item.uploadProgress}%`
                              : item.uploadProgress === 100
                                ? "Uploaded"
                                : "Ready"}
                          </div>

                          {item.error ? <div className="error-text">{item.error}</div> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {sessionCreating || busy ? (
                <div
                  className="uploading-hint"
                  style={{
                    padding: 12,
                    borderRadius: 14,
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.06)",
                    color: "rgba(246,252,255,0.84)",
                  }}
                >
                  {busy ? `Uploading… ${progress}%` : "Preparing session..."}
                </div>
              ) : null}

              {sessionInfo ? (
                <div
                  className="uploading-hint"
                  style={{
                    padding: 12,
                    borderRadius: 14,
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.06)",
                    color: "rgba(246,252,255,0.84)",
                  }}
                >
                  {sessionInfo}
                </div>
              ) : null}

              {error ? (
                <div
                  className="error-text"
                  style={{
                    padding: 12,
                    borderRadius: 14,
                    background: "rgba(127,29,29,0.16)",
                    border: "1px solid rgba(248,113,113,0.16)",
                  }}
                >
                  {error}
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Button
                  onClick={finalizeSession}
                  disabled={busy || sessionCreating || sessionItems.length === 0}
                >
                  {busy ? "Capturing..." : "Finish & Sign"}
                </Button>

                <Button
                  variant="secondary"
                  onClick={resetCaptureState}
                  disabled={busy || sessionItems.length === 0}
                >
                  Clear Session
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
            muted={cameraMode !== "VIDEO" || !isRecording}
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
              <div className="camera-title">
                {cameraMode === "PHOTO" ? "Photo Camera" : "Video Recorder"}
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

          <div
            style={{
              position: "absolute",
              right: 20,
              bottom: 140,
              zIndex: 30,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 14px",
              borderRadius: 999,
              background: "rgba(2, 6, 23, 0.82)",
              border: "1px solid rgba(214,184,157,0.22)",
              color: "#f2e0cf",
              fontSize: 13,
              fontWeight: 800,
              backdropFilter: "blur(10px)",
            }}
          >
            {sessionItems.length} added
          </div>

          <div className="camera-bottombar">
            <div className="camera-bottombar-meta">
              {cameraError ? (
                <div className="camera-inline-error">{cameraError}</div>
              ) : cameraMode === "PHOTO" ? (
                <div className="camera-helper-text">
                  Capture repeatedly to add multiple photos into one evidence.
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
                  disabled={busy || cameraStarting || sessionCreating}
                >
                  Capture & Add
                </button>
              ) : !isRecording ? (
                <button
                  type="button"
                  className="camera-capture-btn"
                  onClick={startVideoRecording}
                  disabled={busy || cameraStarting || sessionCreating}
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
      ) : null}
    </div>
  );
}