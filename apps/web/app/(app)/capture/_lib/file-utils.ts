import type {
  ChecklistStep,
  ChecklistStepStatus,
  CollectionPlanTemplate,
  EvidenceType,
  ItemQualityStatus,
  SessionItem,
  SessionItemClientSignals,
} from "./types";
import {
  MAX_SESSION_BYTES,
  MAX_SESSION_FILES,
  MAX_SINGLE_FILE_BYTES,
} from "./templates";

export function normalizeClientMimeType(
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

export function inferEvidenceTypeFromMimeType(
  mimeType: string | null | undefined
): EvidenceType {
  const mime = normalizeClientMimeType(mimeType, "");

  if (mime.startsWith("image/")) return "PHOTO";
  if (mime.startsWith("video/")) return "VIDEO";
  if (mime.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}

export function deriveBatchEvidenceType(files: File[]): EvidenceType {
  const kinds = new Set(files.map((file) => inferEvidenceTypeFromMimeType(file.type)));

  if (kinds.size === 1) {
    return Array.from(kinds)[0] ?? "DOCUMENT";
  }

  return "DOCUMENT";
}

export function isScreenshotLikeFileName(fileName: string): boolean {
  return /screenshot|screen shot|bildschirmfoto|screen-recording|screenrecording|screencap/i.test(
    fileName
  );
}

export function buildSessionItemSignals(
  file: File,
  relativePath: string | null,
  existingItems: SessionItem[]
): SessionItemClientSignals {
  const now = Date.now();
  const folderPathPresent = Boolean(relativePath);
  const mimeType = normalizeClientMimeType(file.type);
  const duplicateMatch = existingItems.some(
    (existing) =>
      existing.file.name === file.name &&
      existing.file.size === file.size &&
      existing.file.lastModified === file.lastModified
  );

  return {
    captureTimeUtc: new Date().toISOString(),
    browserMediaCaptureAvailable: typeof MediaRecorder !== "undefined",
    folderPathPresent,
    locationIncluded: false,
    duplicateStatus: duplicateMatch ? "duplicate" : "none",
    screenshotLike: isScreenshotLikeFileName(file.name),
    genericMime: mimeType === "application/octet-stream" || mimeType === "",
    oldLastModified: now - file.lastModified > 30 * 24 * 60 * 60 * 1000,
  };
}

export function deriveSessionItemTypeLabel(mimeType: string): string {
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

export function formatEvidenceTypeLabel(kind: EvidenceType): string {
  switch (kind) {
    case "PHOTO":
      return "Photo";
    case "VIDEO":
      return "Video";
    case "AUDIO":
      return "Audio";
    case "DOCUMENT":
    default:
      return "Document";
  }
}

export function getStepRequirementLabel(step: ChecklistStep): string {
  return step.required ? "Required" : "Optional";
}

export function getChecklistStepById(
  plan: CollectionPlanTemplate | undefined,
  stepId: string | null | undefined
): ChecklistStep | null {
  if (!plan || !stepId) return null;
  return plan.steps.find((step) => step.id === stepId) ?? null;
}

export function getChecklistStepStatus(params: {
  item: SessionItem;
  plan: CollectionPlanTemplate | undefined;
}): ChecklistStepStatus {
  const step = getChecklistStepById(params.plan, params.item.checklistStepId);

  if (!step) {
    return {
      label: "Unassigned",
      tone: "warning",
      title: "No collection step selected",
      description:
        "Assign this material to a collection plan step so reviewers understand why it was collected.",
    };
  }

  return {
    label: step.required ? "Requirement met" : "Optional context mapped",
    tone: "success",
    title: step.title,
    description: step.description,
  };
}

export function getItemQualityStatus(params: {
  item: SessionItem;
  step: ChecklistStep | null;
}): ItemQualityStatus {
  const { item, step } = params;

if (!step) {
  return {
    tone: "warning",
    label: "",
    detail: "",
  };
}

  const itemKind = inferEvidenceTypeFromMimeType(item.mimeType);

  if (step.acceptedKinds?.length && !step.acceptedKinds.includes(itemKind)) {
    return {
      tone: "danger",
      label: "Invalid file type",
      detail: `${formatEvidenceTypeLabel(itemKind)} does not match this requirement.`,
    };
  }

  if (
    step.id.includes("close_up") ||
    step.id.includes("damage_close_up") ||
    step.id.includes("close-up")
  ) {
    if (!item.mimeType.startsWith("image/") && !item.mimeType.startsWith("video/")) {
      return {
        tone: "danger",
        label: "Close-up requirement not satisfied (metadata-based)",
        detail:
          "This metadata-based check only verifies file type. It does not visually confirm close-up quality.",
      };
    }
  }

  if (item.clientSignals?.genericMime) {
    return {
      tone: "warning",
      label: "Review file type",
      detail: "The browser reported a generic MIME type. Review before signing.",
    };
  }

  if (item.clientSignals?.duplicateStatus === "duplicate") {
    return {
      tone: "warning",
      label: "Duplicate signal",
      detail: "This file appears similar to another staged item.",
    };
  }

  return {
    tone: "success",
    label: "Matches selected requirement",
    detail:
      "The item metadata matches the selected intake requirement. This is not a factual, visual, or legal validation.",
  };
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function roundGpsCoordinate(value: number, precision = 3): number {
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}

export function validateIncomingFiles(
  incomingFiles: File[],
  existingItems: SessionItem[]
): string | null {
  if (incomingFiles.length === 0) return null;

  if (existingItems.length + incomingFiles.length > MAX_SESSION_FILES) {
    return `Too many files. Add up to ${MAX_SESSION_FILES} items per evidence session.`;
  }

  const tooLarge = incomingFiles.find((file) => file.size > MAX_SINGLE_FILE_BYTES);
  if (tooLarge) {
    return `${tooLarge.name} is too large. Maximum single file size is ${formatFileSize(
      MAX_SINGLE_FILE_BYTES
    )}.`;
  }

  const existingBytes = existingItems.reduce((sum, item) => sum + item.file.size, 0);
  const incomingBytes = incomingFiles.reduce((sum, file) => sum + file.size, 0);

  if (existingBytes + incomingBytes > MAX_SESSION_BYTES) {
    return `Session is too large. Maximum staged session size is ${formatFileSize(
      MAX_SESSION_BYTES
    )}.`;
  }

  return null;
}

export function buildAudioRecordingFileName(extension: string): string {
  return `proovra-audio-recording-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.${extension}`;
}

export function pickSupportedAudioMimeType(): string | null {
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