"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, useToast } from "../../../components/ui";
import { useLocale } from "../../providers";
import { ApiError, apiFetch } from "../../../lib/api";
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

type BillingWallLike = {
  type?: string;
  reason?: string | null;
  workspace?: {
    workspaceType?: string;
    plan?: string | null;
    storage?: {
      usedLabel?: string;
      limitLabel?: string;
      remainingLabel?: string;
    } | null;
  } | null;
  storageAddons?: unknown;
  suggestedActions?: string[];
  incomingBytes?: string | null;
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

function buildStorageLimitMessage(error: unknown): string | null {
  if (error instanceof ApiError) {
    if (
      error.code === "STORAGE_LIMIT_REACHED" ||
      (typeof error.message === "string" &&
        error.message.toLowerCase().includes("storage limit"))
    ) {
      const wall = error.details as BillingWallLike | undefined;
      const workspace = wall?.workspace;
      const storage = workspace?.storage;

      if (storage?.usedLabel && storage?.limitLabel) {
        return `Storage limit reached. Current usage: ${storage.usedLabel} / ${storage.limitLabel}.`;
      }

      return "Storage limit reached for this workspace. Please add storage or upgrade your plan.";
    }
  }

  const generic = error as { code?: string; message?: string; details?: unknown };
  if (generic?.code === "STORAGE_LIMIT_REACHED") {
    return "Storage limit reached for this workspace. Please add storage or upgrade your plan.";
  }

  return null;
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
    } catch (err) {
      const storageMessage = buildStorageLimitMessage(err);
      if (storageMessage) {
        setError(storageMessage);
        addToast(storageMessage, "error");
      }
      throw err;
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
      const storageMessage = buildStorageLimitMessage(err);
      const message =
        storageMessage ||
        (err instanceof Error ? err.message : "Failed to add items to session");
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
    setLocationPermissionDenied(false);
    closeCamera();
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

      const storageMessage = buildStorageLimitMessage(err);
      const baseMsg =
        storageMessage ||
        (err instanceof Error ? err.message : "Capture failed");

      const reqId = (err as { requestId?: string }).requestId;
      const msg =
        reqId && typeof baseMsg === "string" && !baseMsg.includes("requestId:")
          ? `${baseMsg} (requestId: ${reqId})`
          : baseMsg;

      setError(msg);
      addToast(msg, "error");

      if (storageMessage) {
        setSessionInfo("Storage limit reached");
      }
    } finally {
      setBusy(false);
      if (!error) {
        setSessionInfo(null);
      }
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

  const outerCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.16)",
        boxShadow:
          "0 18px 38px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.48)",
      }) as const,
    []
  );

  const primaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(78, 100, 112, 0.22)",
        color: "#eef3f4",
        background:
          "linear-gradient(180deg, rgba(67,91,102,0.97) 0%, rgba(33,52,60,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(25,39,46,0.18)",
        textShadow: "0 1px 0 rgba(0,0,0,0.18)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const secondaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(130, 142, 148, 0.16)",
        color: "#2f454b",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.92) 0%, rgba(242,245,246,0.98) 100%)",
        boxShadow:
          "0 10px 20px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.78)",
        textShadow: "0 1px 0 rgba(255,255,255,0.32)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const tertiaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(169, 154, 136, 0.18)",
        color: "#705f50",
        background:
          "linear-gradient(180deg, rgba(248,245,241,0.92) 0%, rgba(241,236,231,0.96) 100%)",
        boxShadow:
          "0 10px 20px rgba(92,69,50,0.04), inset 0 1px 0 rgba(255,255,255,0.78)",
        textShadow: "0 1px 0 rgba(255,255,255,0.30)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const softCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.10)",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.42), 0 12px 26px rgba(0,0,0,0.06)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }) as const,
    []
  );

  return (
    <div className="section app-section capture-page-shell">
      {/* نفس الستايل تبعك بدون تغيير منطقي */}
      <style jsx global>{`
        .capture-page-shell .capture-type-pill {
          transition: all 0.2s ease;
        }

        .capture-page-shell .capture-type-pill:hover {
          transform: translateY(-1px);
        }

        .capture-page-shell .capture-hero-side {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
          align-items: flex-start;
        }

        .capture-page-shell .capture-actions-row {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .capture-page-shell .capture-finish-row {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .capture-page-shell .capture-drop-zone {
          cursor: pointer;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
        }

        .capture-page-shell .capture-drop-zone:hover {
          transform: translateY(-1px);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.58),
            0 20px 42px rgba(0,0,0,0.06);
        }

        .capture-page-shell .camera-overlay-flash::after {
          content: "";
          position: absolute;
          inset: 0;
          background: rgba(255, 244, 214, 0.09);
          pointer-events: none;
        }

        .capture-page-shell .camera-overlay {
          position: fixed;
          inset: 0;
          z-index: 90;
          background: #081317;
        }

        .capture-page-shell .camera-preview {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
          background: #081317;
        }

        .capture-page-shell .camera-topbar {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          z-index: 30;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          padding: 18px 18px 0;
        }

        .capture-page-shell .camera-topbar-group {
          display: flex;
          gap: 10px;
          align-items: center;
        }

        .capture-page-shell .camera-topbar-group-right {
          justify-content: flex-end;
        }

        .capture-page-shell .camera-topbar-title-group {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          padding-top: 4px;
          text-align: center;
        }

        .capture-page-shell .camera-title {
          color: #eef3f1;
          font-size: 1rem;
          font-weight: 800;
          letter-spacing: -0.02em;
        }

        .capture-page-shell .camera-subtitle {
          color: rgba(226, 235, 232, 0.78);
          font-size: 0.82rem;
        }

        .capture-page-shell .camera-recording-indicator {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 7px 12px;
          border-radius: 999px;
          background: rgba(9, 21, 24, 0.76);
          border: 1px solid rgba(255,255,255,0.10);
          color: #fff1f1;
          font-size: 0.78rem;
          font-weight: 800;
          backdrop-filter: blur(10px);
        }

        .capture-page-shell .camera-recording-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: #ff6464;
          box-shadow: 0 0 0 6px rgba(255,100,100,0.16);
          display: inline-block;
        }

        .capture-page-shell .camera-icon-btn {
          min-height: 42px;
          padding: 0 14px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(9, 21, 24, 0.72);
          color: #eef3f1;
          font-size: 0.85rem;
          font-weight: 700;
          backdrop-filter: blur(10px);
          cursor: pointer;
        }

        .capture-page-shell .camera-icon-btn.active {
          border-color: rgba(214,184,157,0.22);
          color: #f2e0cf;
        }

        .capture-page-shell .camera-bottombar {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 30;
          padding: 0 18px 20px;
          display: grid;
          gap: 14px;
        }

        .capture-page-shell .camera-bottombar-meta {
          display: flex;
          justify-content: center;
        }

        .capture-page-shell .camera-helper-text,
        .capture-page-shell .camera-inline-error {
          max-width: min(720px, 100%);
          text-align: center;
          padding: 11px 14px;
          border-radius: 16px;
          background: rgba(9, 21, 24, 0.72);
          border: 1px solid rgba(255,255,255,0.10);
          color: rgba(236,243,241,0.88);
          font-size: 0.85rem;
          line-height: 1.55;
          backdrop-filter: blur(10px);
        }

        .capture-page-shell .camera-inline-error {
          color: #ffd5d5;
          border-color: rgba(255,109,109,0.18);
        }

        .capture-page-shell .camera-bottombar-actions {
          display: flex;
          justify-content: center;
        }

        .capture-page-shell .camera-capture-btn {
          min-width: 220px;
          min-height: 56px;
          padding: 0 24px;
          border-radius: 999px;
          border: 1px solid rgba(79,112,107,0.22);
          background: linear-gradient(
            180deg,
            rgba(58,92,95,0.96) 0%,
            rgba(20,38,42,0.98) 100%
          );
          color: #eef3f1;
          font-size: 0.96rem;
          font-weight: 800;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.08),
            0 16px 34px rgba(18,40,44,0.22);
          text-shadow: 0 1px 0 rgba(0,0,0,0.22);
          cursor: pointer;
        }

        .capture-page-shell .camera-capture-btn.danger {
          border-color: rgba(194,78,78,0.20);
          background: linear-gradient(
            180deg,
            rgba(164,84,84,0.94) 0%,
            rgba(130,62,62,0.98) 100%
          );
          color: #fff3f3;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.06),
            0 14px 28px rgba(90,18,18,0.14);
        }

        .capture-page-shell .capture-type-grid {
          width: 100%;
          max-width: 100%;
        }

        .capture-page-shell .capture-type-grid > * {
          width: 100%;
          min-width: 0;
        }

        .capture-page-shell .capture-type-pill {
          font-size: 13px !important;
          letter-spacing: 0 !important;
        }

        @media (max-width: 640px) {
          .capture-page-shell .capture-type-grid {
            gap: 8px !important;
          }

          .capture-page-shell .capture-type-pill {
            min-height: 42px !important;
            height: 42px !important;
            padding-left: 8px !important;
            padding-right: 8px !important;
            font-size: 12px !important;
          }
        }

        @media (max-width: 380px) {
          .capture-page-shell .capture-type-pill {
            font-size: 11px !important;
            padding-left: 6px !important;
            padding-right: 6px !important;
          }
        }

        @media (max-width: 900px) {
          .capture-page-shell .capture-hero-side {
            width: 100%;
            justify-content: flex-start;
          }
        }

        @media (max-width: 720px) {
          .capture-page-shell .capture-hero-side,
          .capture-page-shell .capture-actions-row,
          .capture-page-shell .capture-finish-row {
            width: 100%;
          }

          .capture-page-shell .capture-actions-row > *,
          .capture-page-shell .capture-finish-row > * {
            width: 100%;
          }

          .capture-page-shell .camera-topbar {
            padding: 14px 14px 0;
            grid-template-columns: 1fr;
          }

          .capture-page-shell .camera-topbar {
            display: grid;
            gap: 10px;
          }

          .capture-page-shell .camera-topbar-group,
          .capture-page-shell .camera-topbar-group-right,
          .capture-page-shell .camera-topbar-title-group {
            justify-content: center;
          }

          .capture-page-shell .camera-topbar-group,
          .capture-page-shell .camera-topbar-group-right {
            flex-wrap: wrap;
          }

          .capture-page-shell .camera-icon-btn {
            min-width: 96px;
          }

          .capture-page-shell .camera-capture-btn {
            width: 100%;
            min-width: 0;
          }
        }
      `}</style>

      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 780 }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.72rem",
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.10)",
                  background: "rgba(255,255,255,0.04)",
                  padding: "8px 16px",
                  fontSize: "0.68rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.28em",
                  color: "#afbbb7",
                  boxShadow: "0 10px 24px rgba(0,0,0,0.08)",
                  backdropFilter: "blur(10px)",
                  WebkitBackdropFilter: "blur(10px)",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "#b79d84",
                    opacity: 0.95,
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                {t("capture")}
              </div>

              <h1
                className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
                style={{ margin: "20px 0 0" }}
              >
                Capture signed evidence{" "}
                <span style={{ color: "#c3ebe2" }}>in one clean session</span>.
              </h1>

              <p
                style={{
                  marginTop: 20,
                  maxWidth: 720,
                  fontSize: "0.95rem",
                  lineHeight: 1.8,
                  letterSpacing: "-0.006em",
                  color: "#aab5b2",
                }}
              >
                Add multiple <span style={{ color: "#cfd8d5" }}>photos</span>,{" "}
                <span style={{ color: "#bbc7c3" }}>videos</span>, or{" "}
                <span style={{ color: "#d9ccbf" }}>documents</span> into one
                evidence record, then finalize and sign it as a single workflow.
              </p>
            </div>

            <div className="capture-hero-side">
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minHeight: 34,
                  padding: "7px 14px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  border: "1px solid rgba(158,216,207,0.20)",
                  background:
                    "linear-gradient(180deg, rgba(158,216,207,0.12) 0%, rgba(255,255,255,0.03) 100%)",
                  color: "#bfe8df",
                }}
              >
                {sessionCountLabel}
              </span>

              {sessionEvidenceId ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    minHeight: 34,
                    padding: "7px 14px",
                    borderRadius: 999,
                    fontSize: 12,
                    fontWeight: 800,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    border: "1px solid rgba(214,184,157,0.20)",
                    background:
                      "linear-gradient(180deg, rgba(183,157,132,0.12) 0%, rgba(255,255,255,0.03) 100%)",
                    color: "#dcc0a5",
                  }}
                >
                  Session active
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div
        className="app-body app-body-full pt-8 md:pt-10"
        style={{
          position: "relative",
          overflow: "hidden",
          background:
            "linear-gradient(180deg, rgba(239,241,238,0.96) 0%, rgba(234,237,234,0.98) 100%)",
        }}
      >
        <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
          <img
            src="/images/landing-network-bg.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-top opacity-[0.12] saturate-[0.55] brightness-[1.02] contrast-[0.94]"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.03)_22%,rgba(255,255,255,0.03)_78%,rgba(255,255,255,0.08)_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0.03)_12%,rgba(255,255,255,0.00)_24%,rgba(255,255,255,0.00)_76%,rgba(255,255,255,0.03)_88%,rgba(255,255,255,0.10)_100%)]" />
        </div>

        <div className="container relative z-10" style={{ paddingBottom: 72 }}>
          <Card
            className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
            style={outerCardStyle}
          >
            <div className="absolute inset-0">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="h-full w-full object-cover object-center"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

            <div className="relative z-10 p-6 md:p-7">
              <div style={{ display: "grid", gap: 18, padding: 2 }}>
                <div
                  className="capture-type-grid"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                    gap: 10,
                    alignItems: "stretch",
                  }}
                >
                  {([
                    { label: t("photo"), value: "PHOTO" },
                    { label: t("video"), value: "VIDEO" },
                    { label: t("document"), value: "DOCUMENT" },
                  ] as const).map((item) => {
                    const active = type === item.value;

                    return (
                      <button
                        key={item.value}
                        type="button"
                        className="capture-type-pill"
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
                          width: "100%",
                          minWidth: 0,
                          minHeight: 46,
                          height: 46,
                          padding: "0 12px",
                          borderRadius: 999,
                          fontWeight: 700,
                          fontSize: 13,
                          lineHeight: 1,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "clip",
                          textAlign: "center",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          border: active
                            ? "1px solid rgba(46,74,78,0.34)"
                            : "1px solid rgba(79,112,107,0.10)",
                          background: active
                            ? "linear-gradient(180deg, rgba(67,96,101,0.96) 0%, rgba(33,54,58,0.98) 100%)"
                            : "linear-gradient(180deg, rgba(250,251,249,0.86) 0%, rgba(241,244,241,0.98) 100%)",
                          color: active ? "#f3f7f5" : "#5d6d71",
                          boxShadow: active
                            ? "inset 0 1px 0 rgba(255,255,255,0.10), 0 8px 18px rgba(20,38,42,0.16)"
                            : "inset 0 1px 0 rgba(255,255,255,0.58)",
                          transition: "all 180ms ease",
                        }}
                      >
                        {item.label}
                      </button>
                    );
                  })}
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

                <div className="capture-actions-row">
                  <Button
                    variant="secondary"
                    onClick={openFilePicker}
                    disabled={busy || sessionCreating}
                    className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
                    style={secondaryButtonStyle}
                  >
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
                      className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
                      style={tertiaryButtonStyle}
                    >
                      {type === "PHOTO" ? "Open Camera" : "Open Video Recorder"}
                    </Button>
                  ) : null}

                  <Button
                    variant="secondary"
                    onClick={() => router.push("/billing")}
                    className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
                    style={tertiaryButtonStyle}
                  >
                    Open Billing
                  </Button>
                </div>

                <div
                  className="capture-drop-zone"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={async (event) => {
                    event.preventDefault();
                    await handleDroppedFiles(event.dataTransfer.files);
                  }}
                  onClick={openFilePicker}
                  style={{
                    borderRadius: 24,
                    border: "1px dashed rgba(183,157,132,0.18)",
                    background:
                      "linear-gradient(180deg, rgba(255,255,255,0.54), rgba(244,246,243,0.86))",
                    boxShadow:
                      "inset 0 1px 0 rgba(255,255,255,0.58), 0 18px 38px rgba(0,0,0,0.05)",
                    padding: "34px 22px",
                  }}
                >
                  <div
                    className="drop-hint"
                    style={{
                      color: "#23373b",
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
                    color: "#42565b",
                    fontSize: 14,
                    flexWrap: "wrap",
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
                      background: "rgba(255,243,243,0.90)",
                      border: "1px solid rgba(194,78,78,0.14)",
                      color: "#b42318",
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
                      borderRadius: 24,
                      ...softCardStyle,
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
                          color: "#21353a",
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
                          background:
                            "linear-gradient(180deg, rgba(214,184,157,0.12) 0%, rgba(255,255,255,0.56) 100%)",
                          border: "1px solid rgba(183,157,132,0.18)",
                          color: "#8a6e57",
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
                        gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
                        gap: 12,
                      }}
                    >
                      {sessionItems.map((item, index) => (
                        <div
                          key={item.id}
                          style={{
                            borderRadius: 18,
                            overflow: "hidden",
                            background:
                              "linear-gradient(180deg, rgba(255,255,255,0.66) 0%, rgba(243,245,242,0.94) 100%)",
                            border: "1px solid rgba(79,112,107,0.10)",
                            boxShadow:
                              "inset 0 1px 0 rgba(255,255,255,0.62), 0 12px 24px rgba(0,0,0,0.05)",
                          }}
                        >
                          <div
                            style={{
                              position: "relative",
                              aspectRatio: "1 / 1",
                              background: "rgba(232,236,233,0.92)",
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
                                background:
                                  "linear-gradient(180deg, rgba(58,92,95,0.92) 0%, rgba(20,38,42,0.96) 100%)",
                                border: "1px solid rgba(79,112,107,0.20)",
                                color: "#eef3f1",
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
                                  border: "1px solid rgba(194,78,78,0.20)",
                                  background:
                                    "linear-gradient(180deg, rgba(164,84,84,0.94) 0%, rgba(130,62,62,0.98) 100%)",
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
                                  color: "#55696d",
                                  fontSize: 13,
                                  lineHeight: 1.5,
                                  fontWeight: 600,
                                }}
                              >
                                Document
                              </div>
                            )}
                          </div>

                          <div style={{ padding: 12, display: "grid", gap: 8 }}>
                            <div
                              style={{
                                color: "#23373b",
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

                            <div style={{ fontSize: 12, color: "#6a777b" }}>
                              {(item.file.size / 1024 / 1024).toFixed(2)} MB
                            </div>

                            <div
                              style={{
                                height: 8,
                                borderRadius: 999,
                                background: "rgba(79,112,107,0.10)",
                                overflow: "hidden",
                              }}
                            >
                              <div
                                style={{
                                  width: `${item.uploadProgress}%`,
                                  height: "100%",
                                  background:
                                    "linear-gradient(90deg, rgba(45,91,89,0.92), rgba(191,232,223,0.86))",
                                  transition: "width 0.2s ease",
                                }}
                              />
                            </div>

                            <div style={{ fontSize: 12, color: "#55696d" }}>
                              {item.uploading
                                ? `Uploading ${item.uploadProgress}%`
                                : item.uploadProgress === 100
                                  ? "Uploaded"
                                  : "Ready"}
                            </div>

                            {item.error ? (
                              <div
                                style={{
                                  fontSize: 12,
                                  color: "#b42318",
                                  lineHeight: 1.5,
                                }}
                              >
                                {item.error}
                              </div>
                            ) : null}
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
                      background:
                        "linear-gradient(180deg, rgba(250,251,249,0.82) 0%, rgba(241,244,241,0.96) 100%)",
                      border: "1px solid rgba(79,112,107,0.10)",
                      color: "#42565b",
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
                      background:
                        "linear-gradient(180deg, rgba(250,251,249,0.82) 0%, rgba(241,244,241,0.96) 100%)",
                      border: "1px solid rgba(79,112,107,0.10)",
                      color: "#42565b",
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
                      background: "rgba(255,243,243,0.90)",
                      border: "1px solid rgba(194,78,78,0.14)",
                      color: "#b42318",
                    }}
                  >
                    {error}
                  </div>
                ) : null}

                <div className="capture-finish-row">
                  <Button
                    onClick={finalizeSession}
                    disabled={busy || sessionCreating || sessionItems.length === 0}
                    className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
                    style={primaryButtonStyle}
                  >
                    {busy ? "Capturing..." : "Finish & Sign"}
                  </Button>

                  <Button
                    variant="secondary"
                    onClick={resetCaptureState}
                    disabled={busy || sessionItems.length === 0}
                    className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
                    style={secondaryButtonStyle}
                  >
                    Clear Session
                  </Button>
                </div>
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