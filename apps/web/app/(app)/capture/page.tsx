"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getReviewerEvidenceCategories,
  getReviewerEvidenceTypeLabel,
} from "@proovra/shared";
import { Button, Card, useToast } from "../../../components/ui";
import { ApiError, apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type EvidenceType = "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";
type CameraMode = "PHOTO" | "VIDEO" | null;
type FacingMode = "user" | "environment";
type AudioRecorderState =
  | "idle"
  | "recording"
  | "stopped"
  | "preview_ready"
  | "uploading"
  | "failed";

type SessionItem = {
  id: string;
  file: File;
  previewUrl: string | null;
  mimeType: string;
  relativePath: string | null;
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

const GENERIC_EVIDENCE_UPLOAD_ACCEPT =
  "image/*,video/*,audio/*,application/pdf,text/*,application/json,application/xml,text/xml,application/zip,application/x-zip-compressed,application/octet-stream,.bin,.csv,.log,.txt,.rtf,.doc,.docx,.xls,.xlsx,.eml,.msg,.zip,.json,.xml";

function normalizeClientMimeType(
  mimeType: string | null | undefined,
  fallback = "application/octet-stream"
): string {
  const raw = String(mimeType ?? "").trim().toLowerCase();
  if (!raw) return fallback;

  const base = raw.split(";")[0]?.trim() ?? "";
  if (!base) return fallback;
  if (base.length > 128) return fallback;
  if (/[\r\n]/.test(base)) return fallback;
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(base)) {
    return fallback;
  }

  return base;
}

function inferEvidenceTypeFromMimeType(mimeType: string | null | undefined): EvidenceType {
  const mime = normalizeClientMimeType(mimeType, "");

  if (mime.startsWith("image/")) return "PHOTO";
  if (mime.startsWith("video/")) return "VIDEO";
  if (mime.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}

function deriveBatchEvidenceType(files: File[]): EvidenceType {
  const kinds = new Set(
    files.map((file) => inferEvidenceTypeFromMimeType(file.type))
  );

  if (kinds.size === 1) {
    return Array.from(kinds)[0] ?? "DOCUMENT";
  }

  return "DOCUMENT";
}

function deriveSessionItemTypeLabel(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "Image";
  if (mimeType.startsWith("video/")) return "Video";
  if (mimeType.startsWith("audio/")) return "Audio";
  if (mimeType === "application/pdf") return "PDF";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml"
  ) {
    return "Document";
  }
  return "File";
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function buildAudioRecordingFileName(extension: string): string {
  return `proovra-audio-recording-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.${extension}`;
}

function pickSupportedAudioMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") {
    return null;
  }

  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];

  for (const candidate of candidates) {
    if (typeof MediaRecorder.isTypeSupported !== "function") {
      return candidate;
    }
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return "";
}

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

function describeMediaError(
  error: unknown,
  messages: {
    permissionDenied: string;
    notFound: string;
    busy: string;
    constrained: string;
    security: string;
    fallback: string;
  }
): string {
  if (!(error instanceof DOMException)) {
    return error instanceof Error && error.message
      ? `${messages.fallback} (${error.message})`
      : messages.fallback;
  }

  switch (error.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return messages.permissionDenied;
    case "NotFoundError":
    case "DevicesNotFoundError":
      return messages.notFound;
    case "NotReadableError":
    case "TrackStartError":
      return messages.busy;
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return messages.constrained;
    case "SecurityError":
      return messages.security;
    default:
      return `${messages.fallback} (${error.name})`;
  }
}

function logCaptureClientError(
  feature: string,
  error: unknown,
  extra?: Record<string, unknown>
) {
  console.error(`[capture] ${feature}`, error, extra ?? {});
  captureException(error, { feature, ...(extra ?? {}) });
}

  type FileSystemEntryLike = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
};

type FileSystemFileEntryLike = FileSystemEntryLike & {
  file: (success: (file: File) => void, error?: (error: unknown) => void) => void;
};

type FileSystemDirectoryEntryLike = FileSystemEntryLike & {
  createReader: () => {
    readEntries: (
      success: (entries: FileSystemEntryLike[]) => void,
      error?: (error: unknown) => void
    ) => void;
  };
};

async function readAllDirectoryEntries(
  directoryEntry: FileSystemDirectoryEntryLike
): Promise<FileSystemEntryLike[]> {
  const reader = directoryEntry.createReader();
  const entries: FileSystemEntryLike[] = [];

  let keepReading = true;

  while (keepReading) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });

    if (!batch.length) {
      keepReading = false;
    } else {
      entries.push(...batch);
    }
  }

  return entries;
}

async function fileFromEntry(
  fileEntry: FileSystemFileEntryLike,
  relativePath: string
): Promise<File> {
  const file = await new Promise<File>((resolve, reject) => {
    fileEntry.file(resolve, reject);
  });

  Object.defineProperty(file, "webkitRelativePath", {
    value: relativePath,
    configurable: true,
  });

  return file;
}

async function collectFilesFromEntry(
  entry: FileSystemEntryLike,
  parentPath = ""
): Promise<File[]> {
  const currentPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;

  if (entry.isFile) {
    return [
      await fileFromEntry(entry as FileSystemFileEntryLike, currentPath),
    ];
  }

  if (entry.isDirectory) {
    const children = await readAllDirectoryEntries(
      entry as FileSystemDirectoryEntryLike
    );

    const nestedFiles = await Promise.all(
      children.map((child) => collectFilesFromEntry(child, currentPath))
    );

    return nestedFiles.flat();
  }

  return [];
}

async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items ?? []);

  if (!items.length) {
    return Array.from(dataTransfer.files ?? []);
  }

  const entryFiles: File[] = [];

  for (const item of items) {
    const maybeEntry =
      "webkitGetAsEntry" in item
        ? (item as DataTransferItem & {
            webkitGetAsEntry?: () => FileSystemEntryLike | null;
          }).webkitGetAsEntry?.()
        : null;

    if (maybeEntry) {
      entryFiles.push(...(await collectFilesFromEntry(maybeEntry)));
      continue;
    }

    const file = item.getAsFile();
    if (file) entryFiles.push(file);
  }

  return entryFiles.length ? entryFiles : Array.from(dataTransfer.files ?? []);
}

export default function CapturePage() {
  const router = useRouter();
  const { addToast } = useToast();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useLocation, setUseLocation] = useState(false);
  const [progress, setProgress] = useState<number>(0);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState(() => new Date());
    const [internalNotes, setInternalNotes] = useState("");

  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [facingMode, setFacingMode] = useState<FacingMode>("environment");
  const [cameraStarting, setCameraStarting] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [flashEnabled, setFlashEnabled] = useState(false);
  const [audioRecorderOpen, setAudioRecorderOpen] = useState(false);
  const [audioRecorderState, setAudioRecorderState] =
    useState<AudioRecorderState>("idle");
  const [audioRecorderError, setAudioRecorderError] = useState<string | null>(null);
  const [audioRecordingSeconds, setAudioRecordingSeconds] = useState(0);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);
  const [audioPreviewFile, setAudioPreviewFile] = useState<File | null>(null);

  const [sessionItems, setSessionItems] = useState<SessionItem[]>([]);
  const [locationPermissionDenied, setLocationPermissionDenied] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioPreviewUrlRef = useRef<string | null>(null);
  const sessionItemsRef = useRef<SessionItem[]>([]);

  useEffect(() => {
    sessionItemsRef.current = sessionItems;
  }, [sessionItems]);

  useEffect(() => {
    audioPreviewUrlRef.current = audioPreviewUrl;
  }, [audioPreviewUrl]);

  useEffect(() => {
    const folderInput = folderInputRef.current;
    if (!folderInput) return;

    folderInput.setAttribute("webkitdirectory", "");
    folderInput.setAttribute("directory", "");
  }, []);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pollReport = async (evidenceId: string): Promise<boolean> => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await apiFetch(`/v1/evidence/${evidenceId}/report/latest`, { method: "GET" });
      return true;
    } catch {
      await sleep(2000);
    }
  }

  return false;
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

  const stopAudioStream = () => {
    audioStreamRef.current?.getTracks().forEach((track) => track.stop());
    audioStreamRef.current = null;
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

  const clearAudioPreview = () => {
    if (audioPreviewUrl) {
      URL.revokeObjectURL(audioPreviewUrl);
    }
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
      stopAudioStream();
      revokeAllPreviews();
      if (audioPreviewUrlRef.current) {
        URL.revokeObjectURL(audioPreviewUrlRef.current);
      }
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

  const addFilesToSession = async (
    files: File[],
    options?: { sessionEvidenceType?: EvidenceType }
  ) => {
    if (!files.length) return;

    setError(null);
    setSessionStatus(null);

    try {
const nextItems: SessionItem[] = files.map((nextFile) => {
  const normalizedMimeType = normalizeClientMimeType(nextFile.type);
  const canPreview =
    normalizedMimeType.startsWith("image/") ||
    normalizedMimeType.startsWith("video/") ||
    normalizedMimeType.startsWith("audio/");

  const relativePath =
    typeof (nextFile as File & { webkitRelativePath?: string }).webkitRelativePath ===
      "string" &&
    (nextFile as File & { webkitRelativePath?: string }).webkitRelativePath
      ? (nextFile as File & { webkitRelativePath?: string }).webkitRelativePath ?? null
      : null;

  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    file: nextFile,
    previewUrl: canPreview ? URL.createObjectURL(nextFile) : null,
    mimeType: normalizedMimeType,
    relativePath,
    uploadProgress: 0,
    uploading: false,
    error: null,
  };
});

if (sessionItemsRef.current.length === 0) {
  setSessionStartedAt(new Date());
}

setSessionItems((prev) => [...prev, ...nextItems]);
      addToast(
        `${files.length} item${files.length > 1 ? "s" : ""} added to session`,
        "success"
      );
    } catch (err) {
logCaptureClientError("web_capture_add_to_session", err, {
  sessionEvidenceType: options?.sessionEvidenceType ?? null,
  fileCount: files.length,
});
      const storageMessage = buildStorageLimitMessage(err);
      const message =
        storageMessage ||
        (err instanceof Error ? err.message : "Failed to add items to session");
      setError(message);
      addToast(message, "error");
      throw err;
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
    setSessionItems([]);
    setSessionStatus(null);
    setProgress(0);
    setError(null);
    setBusy(false);
    setInternalNotes("");
    setLocationPermissionDenied(false);
    setSessionStartedAt(new Date());
    closeCamera();
    resetAudioRecorderState();
  };

  const finalizeSession = async () => {
    const items = sessionItemsRef.current;

    if (items.length === 0) {
      addToast("No items in session", "error");
      return;
    }

    setBusy(true);
    setError(null);
    setSessionStatus("Creating evidence record...");
    setProgress(0);

    try {
      const files = items.map((item) => item.file);
      const rootType = deriveBatchEvidenceType(files);
      const primaryFile = files[0];
      if (!primaryFile) {
        throw new Error("No evidence items are available to finalize.");
      }

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

      const primaryMimeType = normalizeClientMimeType(primaryFile.type);
      const primaryIntegrity = await computeIntegrityFromBlob(primaryFile);
      const created = await apiFetch("/v1/evidence", {
        method: "POST",
        body: JSON.stringify({
          type: rootType,
          mimeType: primaryMimeType,
          internalNotes: internalNotes.trim() || undefined,
          originalFileName: items[0]?.relativePath || primaryFile.name,
          captureFileName: primaryFile.name,
          deviceTimeIso: new Date().toISOString(),
          gps,
          checksumSha256Base64: primaryIntegrity.checksumSha256Base64,
          contentMd5Base64: primaryIntegrity.contentMd5Base64,
        }),
      });

      const evidenceId = created.id as string;
      setSessionStatus("Uploading preserved evidence items...");

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
    mimeType: normalizeClientMimeType(item.mimeType),
    originalFileName: item.relativePath || item.file.name,
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
          xhr.setRequestHeader(
            "content-type",
            normalizeClientMimeType(item.mimeType)
          );
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

      setSessionStatus("Finalizing signed record...");
      setProgress(95);

      await apiFetch(`/v1/evidence/${evidenceId}/complete`, {
        method: "POST",
        body: JSON.stringify({}),
      });

setSessionStatus("Generating verification artifacts...");
const reportReady = await pollReport(evidenceId);

setProgress(100);

if (reportReady) {
  addToast("Evidence record created successfully!", "success");
} else {
  addToast(
    "Evidence record created. Verification artifacts are still generating.",
    "warning"
  );
}

resetCaptureState();
router.push(`/evidence/${evidenceId}`);
    } catch (err) {
      logCaptureClientError("web_capture_finalize_session", err, {
        itemCount: items.length,
      });

      const storageMessage = buildStorageLimitMessage(err);
      const baseMsg =
        storageMessage ||
        (err instanceof Error ? err.message : "Evidence intake failed");

      const reqId = (err as { requestId?: string }).requestId;
      const msg =
        reqId && typeof baseMsg === "string" && !baseMsg.includes("requestId:")
          ? `${baseMsg} (requestId: ${reqId})`
          : baseMsg;

      setError(msg);
      addToast(msg, "error");

      if (storageMessage) {
        setSessionStatus("Storage limit reached");
      }
    } finally {
      setBusy(false);
      setSessionStatus((current) =>
        current === "Storage limit reached" ? current : null
      );
    }
  };

  const openFilePicker = () => {
    if (busy) return;
    setError(null);
    if (!fileInputRef.current) {
      const pickerError = new Error("Evidence file input is unavailable");
      logCaptureClientError("web_capture_open_file_picker", pickerError, {});
      setError("File picker is unavailable in this browser session.");
      return;
    }
    fileInputRef.current?.click();
  };

  const openFolderPicker = () => {
    if (busy) return;
    setError(null);
    if (!folderInputRef.current) {
      const pickerError = new Error("Evidence folder input is unavailable");
      logCaptureClientError("web_capture_open_folder_picker", pickerError, {});
      setError("Folder picker is unavailable in this browser session.");
      return;
    }
    folderInputRef.current.click();
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
        if (mode !== "VIDEO") {
          throw primaryError;
        }

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
            mode === "VIDEO"
              ? "Unable to open the video recorder."
              : "Unable to open the camera.",
        })
      );
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
    resetAudioRecorderState();
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

const capturedFile = new File(
  [blob],
  `PROOVRA-CAPTURE-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`,
  {
    type: "image/jpeg",
    lastModified: Date.now(),
  }
);

    try {
      await addFilesToSession([capturedFile], { sessionEvidenceType: "PHOTO" });
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
          ? preferredMimeTypes.find((candidate) =>
              MediaRecorder.isTypeSupported(candidate)
            ) || ""
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
        const blob = new Blob(recordedChunksRef.current, { type: finalMimeType });

        if (blob.size === 0) {
          setCameraError("Recorded video is empty.");
          return;
        }

        const extension = finalMimeType.includes("mp4") ? "mp4" : "webm";
const recordedFile = new File(
  [blob],
  `PROOVRA-VIDEO-CAPTURE-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`,
  {
    type: finalMimeType,
    lastModified: Date.now(),
  }
);

        try {
          await addFilesToSession([recordedFile], {
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

  const openAudioRecorder = () => {
    closeCamera();
    setError(null);
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

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
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
        const blob = new Blob(audioChunksRef.current, { type: finalMimeType });

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
          fallback:
            "Audio recording could not be started. Upload an audio file instead.",
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
      await addFilesToSession([audioPreviewFile], {
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

const handleDroppedFiles = async (fileList: FileList | File[] | null) => {
  const files = Array.from(fileList ?? []);
      if (!files.length) return;
    const batchType = deriveBatchEvidenceType(files);
    try {
      await addFilesToSession(files, { sessionEvidenceType: batchType });
    } catch (err) {
      logCaptureClientError("web_capture_handle_dropped_files", err, {
        fileCount: files.length,
      });
      throw err;
    }
  };

  const sessionCountLabel = useMemo(() => {
    const count = sessionItems.length;
    return `${count} item${count === 1 ? "" : "s"} added`;
  }, [sessionItems.length]);

  const sessionComposition = useMemo(() => {
    return sessionItems.reduce(
      (acc, item) => {
        const mimeType = item.mimeType;
        if (mimeType.startsWith("image/")) acc.imageCount += 1;
        else if (mimeType.startsWith("video/")) acc.videoCount += 1;
        else if (mimeType.startsWith("audio/")) acc.audioCount += 1;
        else if (mimeType === "application/pdf") acc.pdfCount += 1;
        else if (
          mimeType.startsWith("text/") ||
          mimeType === "application/json" ||
          mimeType === "application/xml"
        ) {
          acc.textCount += 1;
        } else {
          acc.otherCount += 1;
        }
        return acc;
      },
      {
        imageCount: 0,
        videoCount: 0,
        audioCount: 0,
        pdfCount: 0,
        textCount: 0,
        otherCount: 0,
      }
    );
  }, [sessionItems]);

  const reviewerClassificationPreview = useMemo(
    () =>
      getReviewerEvidenceTypeLabel({
        itemCount: sessionItems.length,
        structure: sessionItems.length > 1 ? "multipart" : "single",
        evidenceType:
          sessionItems.length === 1
            ? inferEvidenceTypeFromMimeType(sessionItems[0]?.mimeType)
            : "DOCUMENT",
        mimeType: sessionItems[0]?.mimeType ?? null,
        ...sessionComposition,
      }),
    [sessionComposition, sessionItems]
  );

  const reviewerCategoryPreview = useMemo(
    () =>
      getReviewerEvidenceCategories({
        itemCount: sessionItems.length,
        structure: sessionItems.length > 1 ? "multipart" : "single",
        ...sessionComposition,
      }),
    [sessionComposition, sessionItems.length]
  );

  const totalStagedBytes = useMemo(
    () => sessionItems.reduce((sum, item) => sum + item.file.size, 0),
    [sessionItems]
  );

  const folderPathsPresent = useMemo(
    () => sessionItems.some((item) => Boolean(item.relativePath)),
    [sessionItems]
  );

  const activeWorkflowStep = busy ? 3 : sessionItems.length > 0 ? 2 : 1;

  const outerCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(92,112,122,0.12)",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.985) 0%, rgba(249,251,252,0.985) 100%)",
        boxShadow: "0 28px 72px rgba(15,23,42,0.10)",
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
        border: "1px solid rgba(105,122,130,0.10)",
        background: "rgba(255,255,255,0.96)",
        boxShadow: "0 14px 34px rgba(15,23,42,0.05)",
      }) as const,
    []
  );

  const finishButtonStyle = useMemo(() => {
    if (busy) {
      return {
        ...primaryButtonStyle,
        opacity: 0.92,
      } as const;
    }

    if (sessionItems.length === 0) {
      return {
        borderColor: "rgba(148,163,184,0.18)",
        color: "#7a8892",
        background:
          "linear-gradient(180deg, rgba(233,237,241,0.96) 0%, rgba(223,229,234,0.98) 100%)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.60)",
        textShadow: "none",
        cursor: "not-allowed",
      } as const;
    }

    return {
      ...primaryButtonStyle,
      boxShadow:
        "inset 0 1px 0 rgba(255,255,255,0.10), 0 18px 40px rgba(17,34,43,0.22)",
    } as const;
  }, [busy, primaryButtonStyle, sessionItems.length]);

  return (
    <div className="section app-section capture-page-shell">
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

        .capture-page-shell .capture-main-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.35fr) minmax(340px, 420px);
          gap: 24px;
          align-items: start;
        }

        .capture-page-shell .capture-session-column {
          position: sticky;
          top: 24px;
        }

        .capture-page-shell .capture-finish-row {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .capture-page-shell .capture-drop-zone {
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
          .capture-page-shell .capture-main-grid {
            grid-template-columns: 1fr;
          }

          .capture-page-shell .capture-session-column {
            position: static;
            top: auto;
          }

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
                Create Evidence Record
              </div>

              <h1
                className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
                style={{ margin: "20px 0 0" }}
              >
                Create Evidence Record
              </h1>

              <p
                style={{
                  marginTop: 18,
                  maxWidth: 720,
                  fontSize: "0.92rem",
                  lineHeight: 1.7,
                  letterSpacing: "-0.006em",
                  color: "#aab5b2",
                }}
              >
                Stage materials locally, preserve cryptographic fingerprints, and
                generate reviewer-ready verification artifacts.
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

            </div>

            <div
              style={{
                marginTop: 22,
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 12,
              }}
            >
              {[
                ["1", "Add materials"],
                ["2", "Review session"],
                ["3", "Finish & sign"],
              ].map(([step, label]) => {
                const stepNumber = Number(step);
                const active = activeWorkflowStep === stepNumber;
                return (
                <div
                  key={step}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 14px",
                    borderRadius: 18,
                    border: active
                      ? "1px solid rgba(191,232,223,0.24)"
                      : "1px solid rgba(255,255,255,0.08)",
                    background: active
                      ? "linear-gradient(180deg, rgba(191,232,223,0.12) 0%, rgba(255,255,255,0.06) 100%)"
                      : "rgba(255,255,255,0.04)",
                    boxShadow: active
                      ? "0 14px 28px rgba(0,0,0,0.10)"
                      : "0 10px 24px rgba(0,0,0,0.06)",
                  }}
                >
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 999,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: active ? "#c3ebe2" : "rgba(195,235,226,0.14)",
                      color: active ? "#17323a" : "#c3ebe2",
                      fontSize: 12,
                      fontWeight: 800,
                      flexShrink: 0,
                    }}
                  >
                    {step}
                  </span>
                  <span
                    style={{
                      color: active ? "#eef8f5" : "#d9e2df",
                      fontSize: 13,
                      fontWeight: 700,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    {label}
                  </span>
                </div>
              )})}
            </div>
          </div>
        </div>
      </div>

      <div
        className="app-body app-body-full pt-8 md:pt-10"
        style={{
          background: "linear-gradient(180deg, #f5f7f8 0%, #eef2f4 100%)",
        }}
      >
        <div className="container" style={{ paddingBottom: 72, maxWidth: 1320 }}>
          <Card
            className="rounded-[32px] border bg-white p-0 shadow-none"
            style={outerCardStyle}
          >
            <div className="p-5 md:p-6">
              <div style={{ display: "grid", gap: 24 }}>
                <input
                  type="file"
                  aria-label="Upload evidence files"
                  multiple
                  accept={GENERIC_EVIDENCE_UPLOAD_ACCEPT}
                  onChange={async (event) => {
                    try {
                      await handleDroppedFiles(event.target.files);
                    } catch {
                      // handled in addFilesToSession/logCaptureClientError
                    }
                    if (fileInputRef.current) {
                      fileInputRef.current.value = "";
                    }
                  }}
                  ref={fileInputRef}
                  style={{ display: "none" }}
                />
                <input
                  type="file"
                  aria-label="Upload evidence folder"
                  multiple
                  onChange={async (event) => {
                    try {
                      await handleDroppedFiles(event.target.files);
                    } catch {
                      // handled in addFilesToSession/logCaptureClientError
                    }
                    if (folderInputRef.current) {
                      folderInputRef.current.value = "";
                    }
                  }}
                  ref={folderInputRef}
                  style={{ display: "none" }}
                />

                <div className="capture-main-grid">
                  <div style={{ display: "grid", gap: 20 }}>
                    <div
                      style={{
                        ...softCardStyle,
                        padding: 20,
                        borderRadius: 24,
                        display: "grid",
                        gap: 16,
                        borderTop: "4px solid #274b5a",
                        boxShadow: "0 18px 38px rgba(15,23,42,0.07)",
                      }}
                    >
                      <div style={{ display: "grid", gap: 6 }}>
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 800,
                            letterSpacing: "0.12em",
                            textTransform: "uppercase",
                            color: "#7e8d8f",
                          }}
                        >
                          Upload Evidence
                        </div>
                        <div
                          style={{
                            color: "#21353a",
                            fontWeight: 800,
                            fontSize: 16,
                            lineHeight: 1.55,
                          }}
                        >
                          Stage files or folders locally before signing this evidence
                          record.
                        </div>
                      </div>

                      <div className="capture-actions-row">
                        <Button
                          variant="secondary"
                          onClick={(event) => {
                            event.stopPropagation();
                            openFilePicker();
                          }}
                          disabled={busy}
                          className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
                          style={{
                            ...secondaryButtonStyle,
                            minWidth: 150,
                          }}
                        >
                          Upload Files
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={(event) => {
                            event.stopPropagation();
                            openFolderPicker();
                          }}
                          disabled={busy}
                          className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
                          style={{
                            ...tertiaryButtonStyle,
                            minWidth: 150,
                          }}
                        >
                          Upload Folder
                        </Button>
                      </div>

                      <div
                        className="capture-drop-zone"
                        onDragOver={(event) => event.preventDefault()}
onDrop={async (event) => {
  event.preventDefault();

  try {
    const files = await filesFromDataTransfer(event.dataTransfer);
    await handleDroppedFiles(files);
  } catch (err) {
    logCaptureClientError("web_capture_drop_files_or_folder", err, {});
    setError(
      err instanceof Error
        ? err.message
        : "Dropped files or folder could not be added."
    );
  }
}}
                        style={{
                          borderRadius: 22,
                          border: "1px dashed rgba(76,96,110,0.24)",
                          background:
                            "linear-gradient(180deg, rgba(246,249,251,0.98) 0%, rgba(251,252,253,1) 100%)",
                          padding: "34px 24px",
                          display: "grid",
                          gap: 12,
                          textAlign: "center",
                        }}
                      >
                        <div
                          style={{
                            width: 44,
                            height: 44,
                            margin: "0 auto",
                            borderRadius: 14,
                            display: "grid",
                            placeItems: "center",
                            background: "linear-gradient(180deg, rgba(39,75,90,0.10) 0%, rgba(201,79,79,0.08) 100%)",
                            border: "1px solid rgba(76,96,110,0.14)",
                            color: "#274b5a",
                            fontSize: 22,
                          }}
                        >
                          ⤴
                        </div>
                        <div
                          style={{
                            color: "#23373b",
                            fontWeight: 800,
                            fontSize: 16,
                          }}
                        >
Drop files or folders here.
                        </div>
                        <div
                          style={{
                            color: "#5b6d71",
                            fontSize: 13,
                            lineHeight: 1.6,
                          }}
                        >
                          Nothing is signed or submitted until you finish the evidence
                          record.
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        ...softCardStyle,
                        padding: 18,
                        borderRadius: 24,
                        display: "grid",
                        gap: 14,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                          flexWrap: "wrap",
                        }}
                      >
                        <div style={{ display: "grid", gap: 4 }}>
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 800,
                              letterSpacing: "0.12em",
                              textTransform: "uppercase",
                              color: "#7e8d8f",
                            }}
                          >
                            Capture Evidence
                          </div>
                          <div
                            style={{
                              color: "#21353a",
                              fontWeight: 700,
                              fontSize: 14,
                            }}
                          >
                            Capture directly from this device.
                          </div>
                        </div>
                      </div>

                      <div
                        className="capture-type-grid"
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                          gap: 12,
                        }}
                      >
                        {[
                          {
                            title: "Capture Photo",
                            note: "Photo",
                            onClick: () => openCamera("PHOTO"),
                            style: secondaryButtonStyle,
                          },
                          {
                            title: "Record Video",
                            note: "Video",
                            onClick: () => openCamera("VIDEO"),
                            style: secondaryButtonStyle,
                          },
                          {
                            title: "Record Audio",
                            note: "Audio",
                            onClick: openAudioRecorder,
                            style: tertiaryButtonStyle,
                          },
                        ].map((action) => (
                          <Button
                            key={action.title}
                            variant="secondary"
                            onClick={action.onClick}
                            disabled={busy}
                            className="capture-type-pill rounded-[18px] border px-4 py-4 text-left"
                            style={{
                              ...action.style,
                              minHeight: 74,
                              display: "grid",
                              justifyContent: "start",
                              alignContent: "center",
                              gap: 3,
                            }}
                          >
                            <span style={{ fontSize: 14, fontWeight: 700 }}>{action.title}</span>
                            <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.72 }}>
                              {action.note}
                            </span>
                          </Button>
                        ))}
                      </div>
                    </div>

                    {audioRecorderOpen ? (
                      <div
                        style={{
                          ...softCardStyle,
                          padding: 18,
                          borderRadius: 22,
                          display: "grid",
                          gap: 12,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 12,
                            flexWrap: "wrap",
                          }}
                        >
                          <div
                            style={{
                              color: "#21353a",
                              fontWeight: 800,
                              fontSize: 15,
                            }}
                          >
                            Audio Recorder
                          </div>
                          <div style={{ color: "#6a777b", fontSize: 12 }}>
                            {audioRecorderState === "recording"
                              ? `Recording · ${formatRecordingTime(audioRecordingSeconds)}`
                              : audioRecorderState === "preview_ready"
                                ? "Preview ready"
                                : "Ready"}
                          </div>
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
                          <div
                            style={{
                              padding: 12,
                              borderRadius: 14,
                              background: "rgba(255,243,243,0.90)",
                              border: "1px solid rgba(194,78,78,0.14)",
                              color: "#b42318",
                            }}
                          >
                            {audioRecorderError}
                          </div>
                        ) : null}

                        <div className="capture-actions-row">
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
                    ) : null}

                    <label
                      style={{
                        ...softCardStyle,
                        padding: "16px 18px",
                        borderRadius: 20,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 16,
                        cursor: busy ? "not-allowed" : "pointer",
                        opacity: busy ? 0.7 : 1,
                      }}
                    >
                      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
                        <div
                          style={{
                            color: "#21353a",
                            fontSize: 14,
                            fontWeight: 700,
                            letterSpacing: "-0.01em",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ color: "#c94f4f", fontSize: 14 }}>📍</span>
                            <span>Include capture location</span>
                          </div>
                        </div>
                        <div
                          style={{
                            color: "#5f6f73",
                            fontSize: 12,
                            lineHeight: 1.55,
                          }}
                        >
                          Attach device-reported location metadata to this evidence record.
                        </div>
                      </div>

                      <input
                        type="checkbox"
                        checked={useLocation}
                        onChange={(event) => setUseLocation(event.target.checked)}
                        disabled={busy}
                        style={{
                          width: 18,
                          height: 18,
                          accentColor: "#39565d",
                          cursor: busy ? "not-allowed" : "pointer",
                          flexShrink: 0,
                        }}
                      />
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
                        Location was not granted. The current session will continue without
                        GPS metadata.
                      </div>
                    ) : null}
                  </div>

                  <div className="capture-session-column">
                    <div
                      style={{
                        ...softCardStyle,
                        padding: 20,
                        borderRadius: 24,
                        display: "grid",
                        gap: 18,
                        borderTop: "4px solid #1f3c48",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          justifyContent: "space-between",
                          gap: 12,
                          flexWrap: "wrap",
                        }}
                      >
                        <div style={{ display: "grid", gap: 6 }}>
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 800,
                              letterSpacing: "0.12em",
                              textTransform: "uppercase",
                              color: "#7e8d8f",
                            }}
                          >
                            Evidence Session Review
                          </div>
                          <div
                            style={{
                              color: "#21353a",
                              fontWeight: 700,
                              fontSize: 15,
                              lineHeight: 1.5,
                            }}
                          >
                            Review staged materials, add private notes, and finish the signed
                            evidence record.
                          </div>
                        </div>

                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "7px 12px",
                            borderRadius: 999,
                            background:
                              sessionItems.length > 0
                                ? "linear-gradient(180deg, rgba(191,232,223,0.16) 0%, rgba(255,255,255,0.78) 100%)"
                                : "#f3f6f8",
                            border:
                              sessionItems.length > 0
                                ? "1px solid rgba(88,134,124,0.18)"
                                : "1px solid rgba(123,138,145,0.14)",
                            color: sessionItems.length > 0 ? "#274b5a" : "#4b6269",
                            fontSize: 12,
                            fontWeight: 800,
                          }}
                        >
                          {sessionItems.length > 0 ? "Ready for review" : "No materials staged"}
                        </div>
                      </div>

                      {sessionItems.length > 0 ? (
                        <div
                          style={{
                            display: "grid",
                            gap: 12,
                            maxHeight: 420,
                            overflowY: "auto",
                            paddingRight: 2,
                          }}
                        >
                          {sessionItems.map((item, index) => {
                            const statusLabel = item.error
                              ? "Failed"
                              : item.uploading
                                ? `Uploading ${item.uploadProgress}%`
                                : item.uploadProgress === 100
                                  ? "Uploaded"
                                  : "Ready";

                            return (
                              <div
                                key={item.id}
                                style={{
                                  borderRadius: 18,
                                  border: "1px solid rgba(105,122,130,0.10)",
                                  background: "#f9fbfc",
                                  padding: 12,
                                  display: "grid",
                                  gap: 10,
                                }}
                              >
                                <div
                                  style={{
                                    display: "grid",
                                    gridTemplateColumns: "72px minmax(0, 1fr)",
                                    gap: 12,
                                    alignItems: "start",
                                  }}
                                >
                                  <div
                                    style={{
                                      width: 72,
                                      height: 72,
                                      borderRadius: 14,
                                      overflow: "hidden",
                                      background: "#e8edf0",
                                      display: "grid",
                                      placeItems: "center",
                                      color: "#55696d",
                                      fontSize: 12,
                                      fontWeight: 700,
                                      textAlign: "center",
                                      padding: 8,
                                    }}
                                  >
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
                                    ) : item.mimeType.startsWith("audio/") ? (
                                      "Audio"
                                    ) : (
                                      deriveSessionItemTypeLabel(item.mimeType)
                                    )}
                                  </div>

                                  <div style={{ minWidth: 0, display: "grid", gap: 8 }}>
                                    <div
                                      style={{
                                        display: "flex",
                                        alignItems: "flex-start",
                                        justifyContent: "space-between",
                                        gap: 10,
                                      }}
                                    >
                                      <div style={{ minWidth: 0, display: "grid", gap: 4 }}>
                                        <div
                                          style={{
                                            color: "#7e8d8f",
                                            fontSize: 11,
                                            fontWeight: 800,
                                            textTransform: "uppercase",
                                            letterSpacing: "0.08em",
                                          }}
                                        >
                                          Item {index + 1}
                                        </div>
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
                                      </div>

                                      {!busy ? (
                                        <button
                                          type="button"
                                          onClick={() => removeSessionItem(item.id)}
                                          style={{
                                            border: "none",
                                            background: "transparent",
                                            color: "#6b7780",
                                            fontWeight: 600,
                                            cursor: "pointer",
                                            padding: 0,
                                            flexShrink: 0,
                                            fontSize: 12,
                                          }}
                                        >
                                          Remove
                                        </button>
                                      ) : null}
                                    </div>

                                    <div
                                      style={{
                                        display: "flex",
                                        flexWrap: "wrap",
                                        gap: 8,
                                        fontSize: 12,
                                        color: "#5f6f73",
                                      }}
                                    >
                                      <span>{deriveSessionItemTypeLabel(item.mimeType)}</span>
                                      <span>•</span>
                                      <span>{formatFileSize(item.file.size)}</span>
                                      <span>•</span>
                                      <span>{item.mimeType}</span>
                                    </div>

                                    {item.relativePath ? (
                                      <div
                                        style={{
                                          fontSize: 12,
                                          color: "#6a777b",
                                          whiteSpace: "nowrap",
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                        }}
                                        title={item.relativePath}
                                      >
                                        {item.relativePath}
                                      </div>
                                    ) : null}

                                    {item.mimeType.startsWith("audio/") && item.previewUrl ? (
                                      <audio
                                        controls
                                        preload="metadata"
                                        src={item.previewUrl}
                                        style={{ width: "100%" }}
                                      >
                                        Your browser could not play this audio preview.
                                      </audio>
                                    ) : null}

                                    <div
                                      style={{
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "space-between",
                                        gap: 10,
                                        flexWrap: "wrap",
                                      }}
                                    >
                                      <span
                                        style={{
                                          display: "inline-flex",
                                          alignItems: "center",
                                          minHeight: 26,
                                          padding: "0 10px",
                                          borderRadius: 999,
                                          background: item.error
                                            ? "rgba(194,78,78,0.10)"
                                            : item.uploadProgress === 100
                                              ? "rgba(78,167,116,0.10)"
                                              : "rgba(79,112,107,0.08)",
                                          color: item.error
                                            ? "#b42318"
                                            : item.uploadProgress === 100
                                              ? "#227447"
                                              : "#4b6269",
                                          fontSize: 12,
                                          fontWeight: 700,
                                        }}
                                      >
                                        {statusLabel}
                                      </span>

                                      {busy || item.uploadProgress > 0 ? (
                                        <div
                                          style={{
                                            width: 112,
                                            height: 7,
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
                                      ) : null}
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
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div
                          style={{
                            borderRadius: 18,
                            border: "1px dashed rgba(123,138,145,0.20)",
                            background: "#f9fbfc",
                            padding: 18,
                            color: "#5f6f73",
                            fontSize: 13,
                            lineHeight: 1.6,
                          }}
                        >
                          No materials are staged yet. Add captured or uploaded evidence on
                          the left, then review and sign the record from this panel.
                        </div>
                      )}

                      <div
                        style={{
                          display: "grid",
                          gap: 10,
                          paddingTop: 16,
                          borderTop: "1px solid rgba(105,122,130,0.10)",
                        }}
                      >
                        <div
                          style={{
                            color: "#21353a",
                            fontSize: 13,
                            fontWeight: 700,
                          }}
                        >
                          Private Internal Notes
                        </div>
                        <div
                          style={{
                            color: "#6b7780",
                            fontSize: 12,
                            lineHeight: 1.55,
                          }}
                        >
                          Visible only inside the authenticated app. Excluded from public
                          verification, reports, and verification packages.
                        </div>
                        <textarea
                          value={internalNotes}
                          onChange={(event) => setInternalNotes(event.target.value)}
                          maxLength={4000}
                          disabled={busy}
                          placeholder="Add investigator, legal, insurance, or internal review context."
                          style={{
                            minHeight: 96,
                            resize: "vertical",
                            borderRadius: 14,
                            border: "1px solid rgba(105,122,130,0.14)",
                            background: "#fbfcfd",
                            color: "#23373b",
                            padding: "12px 14px",
                            fontSize: 13,
                            lineHeight: 1.55,
                            outline: "none",
                          }}
                        />
                      </div>

                      <div
                        style={{
                          display: "grid",
                          gap: 10,
                          paddingTop: 16,
                          borderTop: "1px solid rgba(105,122,130,0.10)",
                        }}
                      >
                        <div
                          style={{
                            color: "#21353a",
                            fontSize: 13,
                            fontWeight: 700,
                          }}
                        >
                          Automatically Recorded
                        </div>

                        {[
                          ["Item count", String(sessionItems.length)],
                          ["Total staged size", formatFileSize(totalStagedBytes)],
                          ["Capture/upload time", sessionStartedAt.toLocaleString()],
                          ["Location metadata", useLocation ? "Included" : "Not included"],
                          ["Classification preview", reviewerClassificationPreview],
                          ["Folder paths", folderPathsPresent ? "Present" : "Not present"],
                        ].map(([label, value]) => (
                          <div
                            key={label}
                            style={{
                              display: "grid",
                              gridTemplateColumns: "minmax(0, 1fr) minmax(120px, auto)",
                              gap: 12,
                              alignItems: "flex-start",
                              fontSize: 12,
                              paddingBottom: 8,
                              borderBottom: "1px solid rgba(105,122,130,0.08)",
                            }}
                          >
                            <span style={{ color: "#7e8d8f", fontWeight: 700 }}>{label}</span>
                            <span
                              style={{
                                color: "#23373b",
                                fontWeight: 700,
                                textAlign: "right",
                              }}
                            >
                              {value}
                            </span>
                          </div>
                        ))}

                        {reviewerCategoryPreview.length > 0 ? (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                            {reviewerCategoryPreview.map((category) => (
                              <span
                                key={category}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  minHeight: 28,
                                  padding: "0 10px",
                                  borderRadius: 999,
                                  background: "#f3f6f8",
                                  border: "1px solid rgba(123,138,145,0.14)",
                                  color: "#4b6269",
                                  fontSize: 12,
                                  fontWeight: 700,
                                }}
                              >
                                {category}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>

                      {busy ? (
                        <div
                          className="uploading-hint"
                          style={{
                            padding: 12,
                            borderRadius: 14,
                            background: "#f7fafb",
                            border: "1px solid rgba(105,122,130,0.10)",
                            color: "#42565b",
                          }}
                        >
                          {`Finishing evidence session… ${progress}%`}
                        </div>
                      ) : null}

                      {sessionStatus ? (
                        <div
                          className="uploading-hint"
                          style={{
                            padding: 12,
                            borderRadius: 14,
                            background: "#f7fafb",
                            border: "1px solid rgba(105,122,130,0.10)",
                            color: "#42565b",
                          }}
                        >
                          {sessionStatus}
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

                      <div
                        style={{
                          display: "grid",
                          gap: 10,
                          paddingTop: 4,
                        }}
                      >
                        {sessionItems.length > 0 ? (
                          <div
                            style={{
                              color: "#5f6f73",
                              fontSize: 12,
                              lineHeight: 1.55,
                            }}
                          >
                            Creates the evidence record, uploads staged materials, signs
                            integrity data, and starts verification artifact generation.
                          </div>
                        ) : null}

                        <Button
                          onClick={finalizeSession}
                          disabled={busy || sessionItems.length === 0}
                          className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
                          style={finishButtonStyle}
                        >
                          {busy ? "Finishing…" : "Finish & Sign Evidence Record"}
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
      ) : null}
    </div>
  );
}
