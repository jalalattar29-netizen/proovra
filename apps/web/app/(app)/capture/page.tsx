"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, useToast } from "../../../components/ui";
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

type ChecklistStep = {
  id: string;
  title: string;
  description: string;
  purposeLabel: string;
  required: boolean;
  acceptedKinds?: EvidenceType[];
};

type CollectionPlanTemplate = {
  id: string;
  name: string;
  description: string;
  locationRequirement: "optional" | "recommended" | "required";
  steps: ChecklistStep[];
};

type SessionItemClientSignals = {
  preliminaryClientSha256Base64?: string;
  captureTimeUtc: string;
  browserMediaCaptureAvailable: boolean;
  folderPathPresent: boolean;
  locationIncluded: boolean;
  duplicateStatus?: "none" | "warning" | "duplicate";
  screenshotLike?: boolean;
  genericMime?: boolean;
  oldLastModified?: boolean;
};

type SessionTimelineEvent = {
  id: string;
  atUtc: string;
  title: string;
  detail: string;
  tone: "info" | "warning" | "danger";
};

type SessionItem = {
  id: string;
  file: File;
  previewUrl: string | null;
  mimeType: string;
  relativePath: string | null;
  uploadProgress: number;
  uploading: boolean;
  error?: string | null;
  role?: string;
  checklistStepId?: string | null;
  privateNote?: string;
  sourceLabel?: string;
  clientSignals?: SessionItemClientSignals;
};

const COLLECTION_PLAN_TEMPLATES: CollectionPlanTemplate[] = [
  {
    id: "general-evidence-record",
    name: "General Evidence Record",
    description: "Balanced intake for primary evidence and supporting context.",
    locationRequirement: "recommended",
    steps: [
      {
        id: "primary_evidence",
        title: "Primary evidence file",
        description: "Upload the principal evidence item that establishes the record.",
        purposeLabel: "Primary evidence",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
      },
      {
        id: "supporting_context",
        title: "Supporting context",
        description: "Add supplemental evidence or context files that support the main record.",
        purposeLabel: "Supporting context",
        required: false,
        acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
      },
      {
        id: "optional_statement",
        title: "Optional statement",
        description: "Add an optional audio or video statement for additional context.",
        purposeLabel: "Optional statement",
        required: false,
        acceptedKinds: ["AUDIO", "VIDEO"],
      },
    ],
  },
  {
    id: "insurance-claim",
    name: "Insurance Claim",
    description: "Capture damage, policy documentation, and ownership context.",
    locationRequirement: "recommended",
    steps: [
      {
        id: "overview_media",
        title: "Overview photo/video",
        description: "Capture a high-level image or video overview of the insured loss.",
        purposeLabel: "Overview media",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        id: "damage_close_up",
        title: "Damage close-up",
        description: "Capture close-up evidence of damage or loss.",
        purposeLabel: "Damage close-up",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        id: "ownership_document",
        title: "Ownership or policy document",
        description: "Upload documentation that proves ownership or policy coverage.",
        purposeLabel: "Ownership or policy document",
        required: true,
        acceptedKinds: ["DOCUMENT"],
      },
      {
        id: "optional_audio",
        title: "Optional audio statement",
        description: "Add an optional audio statement describing the incident.",
        purposeLabel: "Optional audio statement",
        required: false,
        acceptedKinds: ["AUDIO"],
      },
    ],
  },
  {
    id: "legal-matter",
    name: "Legal Matter",
    description: "Collect primary documents, supporting exhibits, and source notes.",
    locationRequirement: "optional",
    steps: [
      {
        id: "primary_media",
        title: "Primary document/media",
        description: "Upload the main document or media item that is being preserved.",
        purposeLabel: "Primary document/media",
        required: true,
        acceptedKinds: ["DOCUMENT", "PHOTO", "VIDEO", "AUDIO"],
      },
      {
        id: "supporting_exhibit",
        title: "Supporting exhibit",
        description: "Attach supporting exhibits or evidence items.",
        purposeLabel: "Supporting exhibit",
        required: false,
        acceptedKinds: ["DOCUMENT", "PHOTO", "VIDEO", "AUDIO"],
      },
      {
        id: "source_context",
        title: "Source/context note",
        description: "Provide a source or context note for the evidence.",
        purposeLabel: "Source/context note",
        required: false,
        acceptedKinds: ["DOCUMENT"],
      },
      {
        id: "optional_timeline",
        title: "Optional timeline evidence",
        description: "Attach timeline evidence such as logs or recordings.",
        purposeLabel: "Optional timeline evidence",
        required: false,
        acceptedKinds: ["DOCUMENT", "PHOTO", "VIDEO", "AUDIO"],
      },
    ],
  },
  {
    id: "incident-investigation",
    name: "Incident / Investigation",
    description: "Capture scene overview, close-up detail, and witness media.",
    locationRequirement: "required",
    steps: [
      {
        id: "scene_overview",
        title: "Scene overview",
        description: "Capture an overview image or video of the incident scene.",
        purposeLabel: "Scene overview",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        id: "close_up_detail",
        title: "Close-up detail",
        description: "Capture close-up detail of the relevant evidence.",
        purposeLabel: "Close-up detail",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        id: "witness_statement",
        title: "Witness/media statement",
        description: "Add a witness statement or media statement for context.",
        purposeLabel: "Witness/media statement",
        required: false,
        acceptedKinds: ["AUDIO", "VIDEO", "DOCUMENT"],
      },
      {
        id: "supporting_file",
        title: "Supporting file/log",
        description: "Attach supporting files such as logs, extracts, or reports.",
        purposeLabel: "Supporting file/log",
        required: false,
        acceptedKinds: ["DOCUMENT", "PHOTO", "VIDEO", "AUDIO"],
      },
    ],
  },
  {
    id: "compliance-audit",
    name: "Compliance Audit",
    description: "Collect policy, audit evidence, and supporting records for review.",
    locationRequirement: "recommended",
    steps: [
      {
        id: "policy_document",
        title: "Policy / compliance document",
        description: "Upload the policy, audit document, or compliance file being preserved.",
        purposeLabel: "Policy / compliance document",
        required: true,
        acceptedKinds: ["DOCUMENT"],
      },
      {
        id: "screenshot_export",
        title: "Export / supporting evidence",
        description: "Upload the export, screenshot, or supporting evidence file for the compliance record.",
        purposeLabel: "Export / supporting evidence",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO", "DOCUMENT"],
      },
      {
        id: "supporting_evidence",
        title: "Supporting evidence",
        description: "Add any additional supporting evidence for the audit record.",
        purposeLabel: "Supporting evidence",
        required: false,
        acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
      },
      {
        id: "reviewer_context",
        title: "Reviewer context note",
        description: "Provide an internal note for reviewer context and intake rationale.",
        purposeLabel: "Reviewer context note",
        required: false,
        acceptedKinds: ["DOCUMENT"],
      },
    ],
  },
  {
    id: "journalism-field-capture",
    name: "Journalism / Field Capture",
    description: "Collect primary media, scene context, and source-safe notes.",
    locationRequirement: "recommended",
    steps: [
      {
        id: "primary_media",
        title: "Primary media",
        description: "Upload the primary media item for the field report.",
        purposeLabel: "Primary media",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        id: "scene_context",
        title: "Scene/context capture",
        description: "Capture scene context to support the primary media.",
        purposeLabel: "Scene/context capture",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        id: "source_safe_note",
        title: "Source-safe note",
        description: "Add an optional source-safe note for the evidence record.",
        purposeLabel: "Source-safe note",
        required: false,
        acceptedKinds: ["DOCUMENT"],
      },
      {
        id: "supporting_document",
        title: "Supporting document",
        description: "Attach any supporting documents or transcripts.",
        purposeLabel: "Supporting document",
        required: false,
        acceptedKinds: ["DOCUMENT"],
      },
    ],
  },
];

const ROLE_SUGGESTIONS = [
  "Primary evidence",
  "Supporting document",
  "Scene overview",
  "Damage close-up",
  "Identity / ownership proof",
  "System log / export",
  "Witness or audio statement",
  "Other",
];

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

function isScreenshotLikeFileName(fileName: string): boolean {
  return /screenshot|screen shot|bildschirmfoto|screen-recording|screenrecording|screencap/i.test(
    fileName
  );
}

function buildSessionItemSignals(
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

function formatEvidenceTypeLabel(kind: EvidenceType): string {
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

function getStepRequirementLabel(step: ChecklistStep): string {
  return step.required ? "Required" : "Optional";
}

function getChecklistStepById(
  plan: CollectionPlanTemplate | undefined,
  stepId: string | null | undefined
): ChecklistStep | null {
  if (!plan || !stepId) return null;
  return plan.steps.find((step) => step.id === stepId) ?? null;
}

function getChecklistStepStatus(params: {
  item: SessionItem;
  plan: CollectionPlanTemplate | undefined;
}) {
  const step = getChecklistStepById(params.plan, params.item.checklistStepId);

  if (!step) {
    return {
      label: "Unassigned",
      tone: "warning" as const,
      title: "No collection step selected",
      description:
        "Assign this material to a collection plan step so reviewers understand why it was collected.",
    };
  }

  return {
    label: step.required ? "Requirement met" : "Optional context mapped",
    tone: "success" as const,
    title: step.title,
    description: step.description,
  };
}

function getItemQualityStatus(params: {
  item: SessionItem;
  step: ChecklistStep | null;
}) {
  const { item, step } = params;

  if (!step) {
    return {
      tone: "warning" as const,
      label: "Needs mapping",
      detail: "This item is not mapped to a collection requirement.",
    };
  }

  const itemKind = inferEvidenceTypeFromMimeType(item.mimeType);

  if (step.acceptedKinds?.length && !step.acceptedKinds.includes(itemKind)) {
    return {
      tone: "danger" as const,
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
        tone: "danger" as const,
        label: "Not valid close-up",
        detail: "Close-up requirements must be mapped to a photo or video item.",
      };
    }
  }

  if (item.clientSignals?.genericMime) {
    return {
      tone: "warning" as const,
      label: "Review file type",
      detail: "The browser reported a generic MIME type. Review before signing.",
    };
  }

  if (item.clientSignals?.duplicateStatus === "duplicate") {
    return {
      tone: "warning" as const,
      label: "Duplicate signal",
      detail: "This file appears similar to another staged item.",
    };
  }

  return {
    tone: "success" as const,
    label: "Validated",
    detail: "The item matches the selected intake requirement.",
  };
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
const [, setSessionTimeline] = useState<SessionTimelineEvent[]>([]);
  const [collectionPlanId, setCollectionPlanId] = useState("general-evidence-record");
  const [planMode, setPlanMode] = useState<"FLEXIBLE" | "CHECKLIST_REQUIRED">("FLEXIBLE");
  const [duplicateWarningAcknowledged] = useState(false);
const [, setLocationAccuracyMeters] = useState<number | null>(null);
  const [locationPermissionDenied, setLocationPermissionDenied] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);

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

  const recordTimelineEvent = (
    event: Omit<SessionTimelineEvent, "id" | "atUtc">
  ) => {
    setSessionTimeline((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        atUtc: new Date().toISOString(),
        ...event,
      },
      ...prev,
    ]);
  };

  const updateSessionItem = (
    itemId: string,
    updates: Partial<Pick<SessionItem, "role" | "privateNote" | "checklistStepId" | "sourceLabel">>
  ) => {
    setSessionItems((prev) =>
      prev.map((item) =>
        item.id === itemId ? { ...item, ...updates } : item
      )
    );
  };

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
      const existingItems = sessionItemsRef.current;
      const existingRequiredChecklistIds = new Set(
        existingItems
          .map((item) => item.checklistStepId)
          .filter(Boolean) as string[]
      );
      const unmappedRequiredSteps =
        planMode === "CHECKLIST_REQUIRED" && selectedCollectionPlan
          ? selectedCollectionPlan.steps.filter(
              (step) => step.required && !existingRequiredChecklistIds.has(step.id)
            )
          : [];
      let availableRequiredSteps = [...unmappedRequiredSteps];

      const assignChecklistStepId = (mimeType: string): string | null => {
        if (availableRequiredSteps.length === 0) return null;

        const fileKind = inferEvidenceTypeFromMimeType(mimeType);
        const compatibleSteps = availableRequiredSteps.filter(
          (step) =>
            !step.acceptedKinds || step.acceptedKinds.includes(fileKind)
        );

        const chosenStep =
          compatibleSteps.length === 1
            ? compatibleSteps[0]
            : availableRequiredSteps.length === 1
            ? availableRequiredSteps[0]
            : null;

        if (!chosenStep) return null;

        availableRequiredSteps = availableRequiredSteps.filter(
          (step) => step.id !== chosenStep.id
        );
        return chosenStep.id;
      };

      const nextItems: SessionItem[] = await Promise.all(
        files.map(async (nextFile) => {
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

          const signals = buildSessionItemSignals(
            nextFile,
            relativePath,
            existingItems
          );

          try {
            const integrity = await computeIntegrityFromBlob(nextFile);
            signals.preliminaryClientSha256Base64 = integrity.checksumSha256Base64;
          } catch {
            // Compute final integrity during evidence finalization.
          }

          return {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            file: nextFile,
            previewUrl: canPreview ? URL.createObjectURL(nextFile) : null,
            mimeType: normalizedMimeType,
            relativePath,
            uploadProgress: 0,
            uploading: false,
            error: null,
            checklistStepId: assignChecklistStepId(normalizedMimeType),
            clientSignals: signals,
          };
        })
      );

      if (sessionItemsRef.current.length === 0) {
        setSessionStartedAt(new Date());
      }

      setSessionItems((prev) => [...prev, ...nextItems]);
      const timelineTitle = options?.sessionEvidenceType
        ? `${options.sessionEvidenceType} captured`
        : "Materials staged";
      const timelineDetail = options?.sessionEvidenceType
        ? `A ${options.sessionEvidenceType.toLowerCase()} item was added to the session.`
        : `${files.length} item${files.length > 1 ? "s" : ""} added to this session.`;
      recordTimelineEvent({
        title: timelineTitle,
        detail: timelineDetail,
        tone: "info",
      });
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
    recordTimelineEvent({
      title: "Finalization started",
      detail: "Finish & Sign process started for the current session.",
      tone: "info",
    });

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
    gps = await new Promise<{
      lat: number;
      lng: number;
      accuracyMeters?: number;
    }>((resolve, reject) => {
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
    });

    setLocationAccuracyMeters(gps.accuracyMeters ?? null);

    setLocationPermissionDenied(false);

    recordTimelineEvent({
      title: "Location recorded",
      detail: "Device-reported GPS metadata was attached to the evidence record.",
      tone: "info",
    });
  } catch {
    setLocationAccuracyMeters(null);

    setLocationPermissionDenied(true);

    recordTimelineEvent({
      title: "Location unavailable",
      detail: "The browser denied or failed to provide device location metadata.",
      tone: "warning",
    });

    addToast("Location unavailable. Continuing without GPS.", "warning");
  }
}

      const primaryMimeType = normalizeClientMimeType(primaryFile.type);
      const primaryIntegrity = await computeIntegrityFromBlob(primaryFile);
      const selectedPlan = COLLECTION_PLAN_TEMPLATES.find(
        (plan) => plan.id === collectionPlanId
      );
      const intakePlanJson = selectedPlan
        ? {
            templateId: selectedPlan.id,
            templateName: selectedPlan.name,
            mode: planMode,
            locationRequirement: selectedPlan.locationRequirement,
requiredSteps: selectedPlan.steps
  .filter((step) => step.required)
  .map((step) => ({
    id: step.id,
    title: step.title,
    description: step.description,
    purposeLabel: step.purposeLabel,
    acceptedKinds: step.acceptedKinds,
  })),
optionalSteps: selectedPlan.steps
  .filter((step) => !step.required)
  .map((step) => ({
    id: step.id,
    title: step.title,
    description: step.description,
    purposeLabel: step.purposeLabel,
    acceptedKinds: step.acceptedKinds,
  })),
              createdAt: new Date().toISOString(),
            deviceTimeIso: new Date().toISOString(),
          }
        : undefined;

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
          intakePlanJson,
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
    privateRole: item.role?.trim() || undefined,
    privateNote: item.privateNote?.trim() || undefined,
    checklistStepId: item.checklistStepId || undefined,
    sourceLabel: item.sourceLabel?.trim() || undefined,
    clientSignals: item.clientSignals,
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

  fileInputRef.current.value = "";
  fileInputRef.current.click();
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

  const selectedCollectionPlan = useMemo(
    () => COLLECTION_PLAN_TEMPLATES.find((plan) => plan.id === collectionPlanId),
    [collectionPlanId]
  );

  useEffect(() => {
  const validStepIds = new Set(
    selectedCollectionPlan?.steps.map((step) => step.id) ?? []
  );

  setSessionItems((prev) =>
    prev.map((item) =>
      item.checklistStepId && !validStepIds.has(item.checklistStepId)
        ? { ...item, checklistStepId: null }
        : item
    )
  );
}, [selectedCollectionPlan?.id]);

  const checklistStepItemMap = useMemo(() => {
    const map = new Map<string, SessionItem[]>();
    sessionItems.forEach((item) => {
      if (!item.checklistStepId) return;
      const existing = map.get(item.checklistStepId) ?? [];
      map.set(item.checklistStepId, [...existing, item]);
    });
    return map;
  }, [sessionItems]);

  const checklistValidation = useMemo(() => {
    const requiredSteps = selectedCollectionPlan?.steps.filter((step) => step.required) ?? [];
    const mappedRequiredStepIds = new Set(
      sessionItems.map((item) => item.checklistStepId).filter(Boolean) as string[]
    );
    const missingRequiredSteps = requiredSteps.filter(
      (step) => !mappedRequiredStepIds.has(step.id)
    );

    return {
      requiredSteps,
      missingRequiredSteps,
      isComplete: requiredSteps.length === 0 || missingRequiredSteps.length === 0,
      mappedRequiredStepIds,
    };
  }, [selectedCollectionPlan, sessionItems]);

  const sessionDuplicateSignals = useMemo(
    () =>
      sessionItems.some((item) => item.clientSignals?.duplicateStatus === "duplicate"),
    [sessionItems]
  );

const finishValidation = useMemo(() => {
  if (sessionItems.length === 0) {
    return {
      reason: "Add at least one material to finish.",
      missingStepTitles: [] as string[],
    };
  }

  if (
    planMode === "CHECKLIST_REQUIRED" &&
    checklistValidation.missingRequiredSteps.length > 0
  ) {
    return {
      reason: "Cannot finish yet",
      missingStepTitles: checklistValidation.missingRequiredSteps.map(
        (step) => step.title
      ),
    };
  }

  if (
    planMode === "CHECKLIST_REQUIRED" &&
    sessionDuplicateSignals &&
    !duplicateWarningAcknowledged
  ) {
    return {
      reason: "A duplicate intake signal is present. Acknowledge before finishing.",
      missingStepTitles: [] as string[],
    };
  }

  if (
    selectedCollectionPlan?.locationRequirement === "required" &&
    !useLocation
  ) {
    return {
      reason: "Location metadata is required by the selected plan.",
      missingStepTitles: [] as string[],
    };
  }

  return {
    reason: undefined,
    missingStepTitles: [] as string[],
  };
}, [
  sessionItems.length,
  planMode,
  checklistValidation.missingRequiredSteps,
  selectedCollectionPlan,
  useLocation,
]);

  const finishDisabled = busy || Boolean(finishValidation.reason);

  const totalStagedBytes = useMemo(
    () => sessionItems.reduce((sum, item) => sum + item.file.size, 0),
    [sessionItems]
  );

  const activeWorkflowStep = busy ? 3 : sessionItems.length > 0 ? 2 : 1;
  const completedRequiredCount =
  checklistValidation.requiredSteps.length -
  checklistValidation.missingRequiredSteps.length;

const requiredProgressPercent =
  checklistValidation.requiredSteps.length > 0
    ? Math.round(
        (completedRequiredCount / checklistValidation.requiredSteps.length) * 100
      )
    : 100;

const currentSessionId = useMemo(() => {
  const date = sessionStartedAt;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `CAP-${y}-${m}-${d}`;
}, [sessionStartedAt]);

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

  const finishButtonStyle = useMemo(() => {
    if (busy) {
      return {
        ...primaryButtonStyle,
        opacity: 0.92,
      } as const;
    }

    if (finishDisabled) {
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
  }, [busy, primaryButtonStyle, finishDisabled]);

return (
  <div className="section app-section capture-page-shell capture-enterprise-page">
    <style jsx global>{`
      body.camera-open {
        overflow: hidden;
      }

      .capture-enterprise-page {
        background: linear-gradient(180deg, #f4f6f5 0%, #edf1f0 100%);
      }

      .capture-enterprise-shell {
        width: 100%;
        max-width: 1480px;
        margin: 0 auto;
        padding: 38px 24px 112px;
      }

      .capture-enterprise-top {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(280px, 420px);
        gap: 24px;
        align-items: stretch;
        margin-bottom: 22px;
      }

      .capture-enterprise-title-card,
      .capture-enterprise-security-card,
      .capture-enterprise-card {
        border: 1px solid rgba(36, 55, 59, 0.10);
        background: rgba(255,255,255,0.92);
        box-shadow: 0 22px 54px rgba(15,23,42,0.08);
        border-radius: 28px;
      }

      .capture-enterprise-title-card {
        padding: 28px;
        display: grid;
        gap: 14px;
      }

      .capture-enterprise-eyebrow {
        width: fit-content;
        display: inline-flex;
        align-items: center;
        gap: 9px;
        border-radius: 999px;
        padding: 7px 12px;
        background: rgba(58,93,97,0.07);
        border: 1px solid rgba(58,93,97,0.12);
        color: #3a5d61;
        font-size: 11px;
        font-weight: 900;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }

      .capture-enterprise-title {
        margin: 0;
        color: #12252a;
        font-size: clamp(2.1rem, 3.2vw, 4rem);
        line-height: 0.98;
        letter-spacing: -0.055em;
        font-weight: 650;
      }

      .capture-enterprise-subtitle {
        max-width: 760px;
        color: #5b6b6f;
        font-size: 0.98rem;
        line-height: 1.75;
        margin: 0;
      }

      .capture-enterprise-security-card {
        position: relative;
        overflow: hidden;
        padding: 24px;
        color: #dce4e0;
        background: transparent;
      }

      .capture-enterprise-security-card::before {
        content: "";
        position: absolute;
        inset: 0;
        background-image: url("/images/site-velvet-bg.webp.png");
        background-size: cover;
        background-position: center;
        transform: scale(1.1);
      }

      .capture-enterprise-security-card::after {
        content: "";
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at 18% 14%, rgba(158,216,207,0.07), transparent 28%),
          linear-gradient(180deg, rgba(8,20,24,0.82), rgba(7,18,22,0.94));
      }

      .capture-enterprise-security-card > * {
        position: relative;
        z-index: 1;
      }

      .capture-enterprise-steps {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
        margin-bottom: 22px;
      }

      .capture-enterprise-step {
        border-radius: 22px;
        padding: 16px;
        background: rgba(255,255,255,0.86);
        border: 1px solid rgba(36,55,59,0.09);
        box-shadow: 0 14px 34px rgba(15,23,42,0.06);
        display: flex;
        gap: 12px;
        align-items: center;
      }

      .capture-enterprise-step.active {
        border-color: rgba(58,93,97,0.22);
        background: linear-gradient(180deg, rgba(237,248,246,0.96), rgba(255,255,255,0.92));
      }

      .capture-enterprise-step-number {
        width: 34px;
        height: 34px;
        border-radius: 999px;
        display: grid;
        place-items: center;
        font-weight: 900;
        color: #3a5d61;
        background: rgba(58,93,97,0.09);
        flex-shrink: 0;
      }

      .capture-enterprise-step.active .capture-enterprise-step-number {
        background: #3a5d61;
        color: #f4f7f6;
      }

      .capture-enterprise-grid {
        display: grid;
        grid-template-columns: 290px minmax(0, 1fr) 360px;
        gap: 18px;
        align-items: start;
      }

      .capture-enterprise-card {
        padding: 18px;
      }

      .capture-section-label {
        font-size: 11px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        color: #7d8b8e;
        margin-bottom: 8px;
      }

      .capture-card-title {
        color: #1c3035;
        font-size: 15px;
        font-weight: 850;
        line-height: 1.4;
      }

      .capture-card-muted {
        color: #607074;
        font-size: 12px;
        line-height: 1.6;
      }

      .capture-method-button {
        width: 100%;
        border: 1px solid rgba(36,55,59,0.10);
        background: rgba(249,251,250,0.9);
        border-radius: 18px;
        padding: 14px;
        text-align: left;
        cursor: pointer;
        display: grid;
        gap: 5px;
      }

      .capture-method-button.active {
        border-color: rgba(58,93,97,0.26);
        background: rgba(237,248,246,0.95);
        box-shadow: inset 0 0 0 1px rgba(58,93,97,0.04);
      }

      .capture-requirement-row {
        display: grid;
        grid-template-columns: 36px 46px minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        padding: 14px;
        border-radius: 18px;
        border: 1px solid rgba(36,55,59,0.08);
        background: rgba(255,255,255,0.92);
      }

      .capture-requirement-index {
        width: 32px;
        height: 32px;
        border-radius: 999px;
        display: grid;
        place-items: center;
        font-size: 13px;
        font-weight: 900;
        color: #3a5d61;
        background: rgba(58,93,97,0.08);
      }

      .capture-requirement-icon {
        width: 42px;
        height: 42px;
        border-radius: 14px;
        display: grid;
        place-items: center;
        background: rgba(183,157,132,0.12);
        color: #8f745c;
        font-size: 18px;
      }

      .capture-requirement-status {
        font-size: 12px;
        font-weight: 850;
        white-space: nowrap;
      }

      .capture-status-met {
        color: #227447;
      }

      .capture-status-missing {
        color: #b42318;
      }

      .capture-drop-zone-enterprise {
        border-radius: 24px;
        border: 1px dashed rgba(58,93,97,0.24);
        background:
          linear-gradient(180deg, rgba(250,252,252,0.98), rgba(244,248,247,0.98));
        padding: 24px;
        display: grid;
        gap: 14px;
        text-align: center;
      }

      .capture-session-list {
        display: grid;
        gap: 12px;
        max-height: 430px;
        overflow-y: auto;
        padding-right: 2px;
      }

      .capture-session-item {
        border-radius: 20px;
        border: 1px solid rgba(36,55,59,0.09);
        background: #f9fbfa;
        padding: 12px;
        display: grid;
        gap: 10px;
      }

      .capture-bottom-bar {
        position: sticky;
        bottom: 0;
        z-index: 30;
        margin-top: 22px;
        border-radius: 24px;
        overflow: hidden;
        border: 1px solid rgba(183,157,132,0.18);
        box-shadow: 0 -12px 40px rgba(15,23,42,0.12);
      }

      .capture-bottom-bar-inner {
        position: relative;
        padding: 16px;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        gap: 14px;
        align-items: center;
        color: #dce4e0;
        background: transparent;
      }

      .capture-bottom-bar-inner::before {
        content: "";
        position: absolute;
        inset: 0;
        background-image: url("/images/site-velvet-bg.webp.png");
        background-size: cover;
        background-position: center;
        transform: scale(1.08);
      }

      .capture-bottom-bar-inner::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(180deg, rgba(8,20,24,0.86), rgba(7,18,22,0.96));
      }

      .capture-bottom-bar-inner > * {
        position: relative;
        z-index: 1;
      }

      .capture-quality-success {
        color: #227447;
        background: rgba(236,253,245,0.95);
        border: 1px solid rgba(34,116,71,0.14);
      }

      .capture-quality-warning {
        color: #8c4d2e;
        background: rgba(255,247,237,0.95);
        border: 1px solid rgba(234,150,60,0.18);
      }

      .capture-quality-danger {
        color: #b42318;
        background: rgba(255,241,241,0.96);
        border: 1px solid rgba(180,35,24,0.15);
      }

      @media (max-width: 1180px) {
        .capture-enterprise-grid {
          grid-template-columns: 1fr;
        }

        .capture-session-column {
          position: static !important;
        }
      }

      @media (max-width: 900px) {
        .capture-enterprise-top {
          grid-template-columns: 1fr;
        }

        .capture-enterprise-steps {
          grid-template-columns: 1fr 1fr;
        }

        .capture-bottom-bar-inner {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 640px) {
        .capture-enterprise-shell {
          padding: 24px 14px 96px;
        }

        .capture-enterprise-steps {
          grid-template-columns: 1fr;
        }

        .capture-requirement-row {
          grid-template-columns: 32px minmax(0, 1fr);
        }

        .capture-requirement-icon,
        .capture-requirement-status {
          display: none;
        }
      }
    `}</style>

    <div className="capture-enterprise-shell">
      <input
        type="file"
        aria-label="Upload evidence files"
        multiple
        accept={GENERIC_EVIDENCE_UPLOAD_ACCEPT}
        onChange={async (event) => {
          const input = event.currentTarget;
          const files = input.files;

          try {
            await handleDroppedFiles(files);
} catch (err) {
  logCaptureClientError("web_capture_file_input_change", err, {});
} finally {
              input.value = "";
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
          const input = event.currentTarget;
          const files = input.files;

          try {
            await handleDroppedFiles(files);
} catch (err) {
  logCaptureClientError("web_capture_folder_input_change", err, {});
} finally {
              input.value = "";
          }
        }}
        ref={folderInputRef}
        style={{ display: "none" }}
      />

      <datalist id="role-suggestions">
        {ROLE_SUGGESTIONS.map((role) => (
          <option key={role} value={role} />
        ))}
      </datalist>

      <div className="capture-enterprise-top">
        <div className="capture-enterprise-title-card">
          <div className="capture-enterprise-eyebrow">
            <span>●</span>
            Evidence intake workspace
          </div>

          <h1 className="capture-enterprise-title">Capture Evidence</h1>

          <p className="capture-enterprise-subtitle">
            Collect, organize, fingerprint, and preserve evidence with guided
            requirements, local review, device capture, and a reviewer-ready
            audit trail.
          </p>
        </div>

        <div className="capture-enterprise-security-card">
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 18,
                display: "grid",
                placeItems: "center",
                background: "rgba(158,216,207,0.12)",
                border: "1px solid rgba(158,216,207,0.18)",
                fontSize: 24,
              }}
            >
              ◈
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ fontWeight: 850, color: "#edf4f1" }}>
                End-to-end protected intake
              </div>
              <div style={{ color: "rgba(211,223,220,0.78)", fontSize: 13, lineHeight: 1.65 }}>
                Client-side fingerprints, encrypted storage workflow, structured
                custody context, and verification artifacts after signing.
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="capture-enterprise-steps">
        {[
          ["1", "Select method", "Choose how to collect"],
          ["2", "Configure", "Template & requirements"],
          ["3", "Capture", "Upload or record evidence"],
          ["4", "Review & sign", "Verify and finalize"],
        ].map(([step, title, detail], index) => {
          const active = activeWorkflowStep === Math.min(index + 1, 3);
          return (
            <div
              key={step}
              className={`capture-enterprise-step ${active ? "active" : ""}`}
            >
              <div className="capture-enterprise-step-number">{step}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 850, color: "#1c3035" }}>
                  {title}
                </div>
                <div className="capture-card-muted">{detail}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="capture-enterprise-grid">
        <aside className="capture-enterprise-card" style={{ display: "grid", gap: 16 }}>
          <div>
            <div className="capture-section-label">Collection method</div>
            <div className="capture-card-title">Choose intake structure</div>
          </div>

          <button
            type="button"
            className={`capture-method-button ${
              planMode === "CHECKLIST_REQUIRED" ? "active" : ""
            }`}
            onClick={() => setPlanMode("CHECKLIST_REQUIRED")}
            disabled={busy}
          >
            <strong style={{ color: "#1c3035" }}>Guided checklist</strong>
            <span className="capture-card-muted">
              Structured requirements for claims, investigations, legal, and compliance.
            </span>
          </button>

          <button
            type="button"
            className={`capture-method-button ${
              planMode === "FLEXIBLE" ? "active" : ""
            }`}
            onClick={() => setPlanMode("FLEXIBLE")}
            disabled={busy}
          >
            <strong style={{ color: "#1c3035" }}>Flexible intake</strong>
            <span className="capture-card-muted">
              Upload any materials without blocking completion.
            </span>
          </button>

          <div
            style={{
              padding: 14,
              borderRadius: 18,
              background: "rgba(58,93,97,0.06)",
              border: "1px solid rgba(58,93,97,0.10)",
              display: "grid",
              gap: 8,
            }}
          >
            <div className="capture-card-title">Why guided intake?</div>
            {[
              "Reduces missing evidence",
              "Maps each item to reviewer purpose",
              "Improves claim and legal readiness",
              "Creates clearer audit context",
            ].map((text) => (
              <div key={text} className="capture-card-muted">
                ✓ {text}
              </div>
            ))}
          </div>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: 14,
              borderRadius: 18,
              background: "rgba(255,255,255,0.78)",
              border: "1px solid rgba(36,55,59,0.09)",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            <span>
              <span style={{ display: "block", fontWeight: 850, color: "#1c3035" }}>
                Include location
              </span>
              <span className="capture-card-muted">
                Device-reported GPS metadata.
              </span>
            </span>
            <input
              type="checkbox"
              checked={useLocation}
              onChange={(event) => setUseLocation(event.target.checked)}
              disabled={busy}
              style={{ width: 18, height: 18, accentColor: "#3a5d61" }}
            />
          </label>
        </aside>

        <main className="capture-enterprise-card" style={{ display: "grid", gap: 18 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 14,
              flexWrap: "wrap",
              alignItems: "flex-start",
            }}
          >
            <div>
              <div className="capture-section-label">Requirements</div>
              <div className="capture-card-title">
                {selectedCollectionPlan?.name ?? "Evidence intake"}
              </div>
              <div className="capture-card-muted">
                {selectedCollectionPlan?.description}
              </div>
            </div>

            <select
              value={collectionPlanId}
              onChange={(event) => setCollectionPlanId(event.target.value)}
              disabled={busy}
              style={{
                minHeight: 42,
                borderRadius: 14,
                border: "1px solid rgba(36,55,59,0.12)",
                background: "#fbfcfd",
                color: "#23373b",
                padding: "10px 12px",
                fontSize: 13,
                outline: "none",
                minWidth: 230,
              }}
            >
              {COLLECTION_PLAN_TEMPLATES.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </select>
          </div>

          {selectedCollectionPlan ? (
            <div style={{ display: "grid", gap: 10 }}>
              {selectedCollectionPlan.steps.map((step, index) => {
                const mapped = checklistStepItemMap.has(step.id);
                const required = step.required;

                return (
                  <div key={step.id} className="capture-requirement-row">
                    <div className="capture-requirement-index">{index + 1}</div>
                    <div className="capture-requirement-icon">
                      {step.acceptedKinds?.includes("DOCUMENT")
                        ? "□"
                        : step.acceptedKinds?.includes("AUDIO")
                          ? "◌"
                          : "▣"}
                    </div>

                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <strong style={{ color: "#1c3035", fontSize: 13 }}>
                          {step.title}
                        </strong>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 850,
                            color: required ? "#b42318" : "#8f745c",
                          }}
                        >
                          {required ? "Required" : "Optional"}
                        </span>
                      </div>
                      <div className="capture-card-muted">{step.description}</div>
                      <div className="capture-card-muted">
                        Accepted:{" "}
                        {step.acceptedKinds?.map(formatEvidenceTypeLabel).join(", ")}
                      </div>
                    </div>

                    <div
                      className={`capture-requirement-status ${
                        mapped ? "capture-status-met" : required ? "capture-status-missing" : ""
                      }`}
                    >
                      {mapped ? "Added" : required ? "Not added" : "Optional"}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          <div
            className="capture-drop-zone-enterprise"
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
          >
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <Button
                variant="secondary"
                onClick={(event) => {
                  event.stopPropagation();
                  openFilePicker();
                }}
                disabled={busy}
                className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
                style={secondaryButtonStyle}
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
                style={tertiaryButtonStyle}
              >
                Upload Folder
              </Button>

              <Button
                variant="secondary"
                onClick={() => openCamera("PHOTO")}
                disabled={busy}
                className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
                style={secondaryButtonStyle}
              >
                Capture Photo
              </Button>

              <Button
                variant="secondary"
                onClick={() => openCamera("VIDEO")}
                disabled={busy}
                className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
                style={secondaryButtonStyle}
              >
                Record Video
              </Button>

              <Button
                variant="secondary"
                onClick={openAudioRecorder}
                disabled={busy}
                className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
                style={tertiaryButtonStyle}
              >
                Record Audio
              </Button>
            </div>

            <div style={{ fontWeight: 850, color: "#1c3035" }}>
              Drag & drop files here or choose a capture method
            </div>

            <div className="capture-card-muted">
              Nothing is signed or submitted until you finish the evidence record.
            </div>
          </div>

          {audioRecorderOpen ? (
            <div
              style={{
                borderRadius: 20,
                border: "1px solid rgba(36,55,59,0.10)",
                background: "#f9fbfa",
                padding: 16,
                display: "grid",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <strong style={{ color: "#1c3035" }}>Audio Recorder</strong>
                <span className="capture-card-muted">
                  {audioRecorderState === "recording"
                    ? `Recording · ${formatRecordingTime(audioRecordingSeconds)}`
                    : audioRecorderState === "preview_ready"
                      ? "Preview ready"
                      : "Ready"}
                </span>
              </div>

              {audioPreviewUrl ? (
                <audio controls preload="metadata" src={audioPreviewUrl} style={{ width: "100%" }}>
                  Your browser could not play this audio preview.
                </audio>
              ) : null}

              {audioRecorderError ? (
                <div className="capture-quality-danger" style={{ padding: 12, borderRadius: 14 }}>
                  {audioRecorderError}
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
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
                  disabled={audioRecorderState === "recording" || audioRecorderState === "uploading"}
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
        </main>

        <aside className="capture-session-column" style={{ position: "sticky", top: 24 }}>
          <div className="capture-enterprise-card" style={{ display: "grid", gap: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div className="capture-section-label">Session overview</div>
                <div className="capture-card-title">{sessionCountLabel}</div>
              </div>
              <button
                type="button"
                onClick={resetCaptureState}
                disabled={busy || sessionItems.length === 0}
                style={{
                  border: "1px solid rgba(36,55,59,0.10)",
                  background: "#fff",
                  borderRadius: 999,
                  padding: "8px 12px",
                  fontSize: 12,
                  fontWeight: 850,
                  color: "#3a5d61",
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                New Session
              </button>
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              {[
                ["Session ID", currentSessionId],
                ["Template", selectedCollectionPlan?.name ?? "General"],
                ["Status", busy ? "Finalizing" : sessionItems.length ? "In Progress" : "Draft"],
                [
                  "Required Steps",
                  `${completedRequiredCount} of ${checklistValidation.requiredSteps.length} completed`,
                ],
                ["Total Items", String(sessionItems.length)],
                ["Total Size", formatFileSize(totalStagedBytes)],
              ].map(([label, value]) => (
                <div
                  key={label}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) auto",
                    gap: 10,
                    padding: "8px 0",
                    borderBottom: "1px solid rgba(36,55,59,0.07)",
                    fontSize: 12,
                  }}
                >
                  <span style={{ color: "#6b7780", fontWeight: 750 }}>{label}</span>
                  <strong style={{ color: "#1c3035", textAlign: "right" }}>{value}</strong>
                </div>
              ))}

              <div style={{ height: 8, borderRadius: 999, background: "rgba(58,93,97,0.10)", overflow: "hidden" }}>
                <div
                  style={{
                    width: `${requiredProgressPercent}%`,
                    height: "100%",
                    borderRadius: 999,
                    background: "linear-gradient(90deg, #3a5d61, #8dd8d4)",
                  }}
                />
              </div>
            </div>

            <div
              style={{
                borderRadius: 18,
                border: "1px solid rgba(36,55,59,0.09)",
                background: "#f9fbfa",
                overflow: "hidden",
              }}
            >
              <button
                type="button"
                onClick={() => setAiPanelOpen((prev) => !prev)}
                style={{
                  width: "100%",
                  border: "none",
                  background: "transparent",
                  padding: 14,
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  cursor: "pointer",
                  color: "#1c3035",
                  fontWeight: 850,
                }}
              >
                <span>Intake quality assistant</span>
                <span>{aiPanelOpen ? "−" : "+"}</span>
              </button>

              {aiPanelOpen ? (
                <div
                  style={{
                    padding: "0 14px 14px",
                    display: "grid",
                    gap: 8,
                    color: "#607074",
                    fontSize: 12,
                    lineHeight: 1.6,
                  }}
                >
                  <div>Checks file type, mapping, duplicate signals, and required-step coverage.</div>
                  <div>AI visual validation can be added later as a separate backend review layer.</div>
                </div>
              ) : null}
            </div>

            {sessionItems.length > 0 ? (
              <div className="capture-session-list">
                {sessionItems.map((item, index) => {
                  const mappedStep = getChecklistStepById(
                    selectedCollectionPlan,
                    item.checklistStepId
                  );

                  const requirementStatus = getChecklistStepStatus({
                    item,
                    plan: selectedCollectionPlan,
                  });

                  const qualityStatus = getItemQualityStatus({
                    item,
                    step: mappedStep,
                  });

                  const statusLabel = item.error
                    ? "Failed"
                    : item.uploading
                      ? `Uploading ${item.uploadProgress}%`
                      : item.uploadProgress === 100
                        ? "Uploaded"
                        : "Ready";

                  return (
                    <div key={item.id} className="capture-session-item">
                      <div style={{ display: "grid", gridTemplateColumns: "58px minmax(0,1fr)", gap: 12 }}>
                        <div
                          style={{
                            width: 58,
                            height: 58,
                            borderRadius: 16,
                            overflow: "hidden",
                            background: "#e8edf0",
                            display: "grid",
                            placeItems: "center",
                            color: "#55696d",
                            fontSize: 11,
                            fontWeight: 850,
                          }}
                        >
                          {item.previewUrl && item.mimeType.startsWith("image/") ? (
                            <img
                              src={item.previewUrl}
                              alt={item.file.name}
                              style={{ width: "100%", height: "100%", objectFit: "cover" }}
                            />
                          ) : item.previewUrl && item.mimeType.startsWith("video/") ? (
                            <video
                              src={item.previewUrl}
                              muted
                              playsInline
                              controls={false}
                              style={{ width: "100%", height: "100%", objectFit: "cover" }}
                            />
                          ) : item.mimeType.startsWith("audio/") ? (
                            "Audio"
                          ) : (
                            deriveSessionItemTypeLabel(item.mimeType)
                          )}
                        </div>

                        <div style={{ minWidth: 0, display: "grid", gap: 7 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 10, fontWeight: 900, color: "#7d8b8e", textTransform: "uppercase" }}>
                                Item {index + 1}
                              </div>
                              <div
                                title={item.file.name}
                                style={{
                                  color: "#1c3035",
                                  fontSize: 13,
                                  fontWeight: 850,
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
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
                                  fontSize: 12,
                                  fontWeight: 750,
                                  cursor: "pointer",
                                }}
                              >
                                Remove
                              </button>
                            ) : null}
                          </div>

                          <div className="capture-card-muted">
                            {deriveSessionItemTypeLabel(item.mimeType)} • {formatFileSize(item.file.size)}
                          </div>

                          <select
                            value={item.checklistStepId ?? ""}
                            onChange={(event) =>
                              updateSessionItem(item.id, {
                                checklistStepId: event.target.value || null,
                              })
                            }
                            disabled={busy}
                            style={{
                              width: "100%",
                              minHeight: 36,
                              borderRadius: 12,
                              border: "1px solid rgba(36,55,59,0.12)",
                              background: "#fff",
                              color: "#23373b",
                              padding: "8px 10px",
                              fontSize: 12,
                              outline: "none",
                            }}
                          >
                            <option value="">
                              {planMode === "CHECKLIST_REQUIRED"
                                ? "Map to required collection step"
                                : "Map to collection step"}
                            </option>
                            {selectedCollectionPlan?.steps.map((step) => (
                              <option key={step.id} value={step.id}>
                                {getStepRequirementLabel(step)}: {step.title} — {step.purposeLabel}
                              </option>
                            ))}
                          </select>

                          <div
                            className={
                              qualityStatus.tone === "success"
                                ? "capture-quality-success"
                                : qualityStatus.tone === "danger"
                                  ? "capture-quality-danger"
                                  : "capture-quality-warning"
                            }
                            style={{ padding: "9px 10px", borderRadius: 12, fontSize: 12, lineHeight: 1.45 }}
                          >
                            <strong>{qualityStatus.label}</strong>
                            <div>{qualityStatus.detail}</div>
                          </div>

                          <textarea
                            value={item.privateNote ?? ""}
                            onChange={(event) =>
                              updateSessionItem(item.id, {
                                privateNote: event.target.value,
                              })
                            }
                            disabled={busy}
                            placeholder="Private item note"
                            maxLength={1000}
                            style={{
                              width: "100%",
                              minHeight: 64,
                              borderRadius: 12,
                              border: "1px solid rgba(36,55,59,0.12)",
                              background: "#fff",
                              color: "#23373b",
                              padding: "9px 10px",
                              fontSize: 12,
                              lineHeight: 1.5,
                              outline: "none",
                              resize: "vertical",
                            }}
                          />

                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: 850,
                                color: item.error ? "#b42318" : "#3a5d61",
                              }}
                            >
                              {statusLabel}
                            </span>
                            <span className="capture-card-muted">
                              {requirementStatus.label}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="capture-card-muted">
                Added materials will appear here for mapping, notes, and quality review.
              </div>
            )}

            <div style={{ display: "grid", gap: 10 }}>
              <div className="capture-card-title">Private Internal Notes</div>
              <div className="capture-card-muted">
                Visible only inside the authenticated app. Excluded from public verification,
                reports, and verification packages.
              </div>
              <textarea
                value={internalNotes}
                onChange={(event) => setInternalNotes(event.target.value)}
                maxLength={4000}
                disabled={busy}
                placeholder="Add investigator, legal, insurance, or internal review context."
                style={{
                  minHeight: 92,
                  resize: "vertical",
                  borderRadius: 14,
                  border: "1px solid rgba(36,55,59,0.12)",
                  background: "#fbfcfd",
                  color: "#23373b",
                  padding: "12px 14px",
                  fontSize: 13,
                  lineHeight: 1.55,
                  outline: "none",
                }}
              />
            </div>

            {error ? (
              <div className="capture-quality-danger" style={{ padding: 12, borderRadius: 14 }}>
                {error}
              </div>
            ) : null}

            {locationPermissionDenied ? (
              <div className="capture-quality-warning" style={{ padding: 12, borderRadius: 14 }}>
                Location was not granted. The current session will continue without GPS metadata.
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      <div className="capture-bottom-bar">
        <div className="capture-bottom-bar-inner">
          <div>
            <div style={{ fontSize: 13, fontWeight: 850 }}>
              {finishValidation.reason ?? "Ready to finish and sign"}
            </div>
            <div style={{ color: "rgba(211,223,220,0.72)", fontSize: 12, marginTop: 4 }}>
              {busy
                ? `Finishing evidence session… ${progress}%`
                : sessionStatus ??
                  "Creates the evidence record, uploads staged materials, signs integrity data, and starts verification artifact generation."}
            </div>
            {finishValidation.missingStepTitles.length > 0 ? (
              <div style={{ color: "#e6c9ae", fontSize: 12, marginTop: 8 }}>
                Missing: {finishValidation.missingStepTitles.join(", ")}
              </div>
            ) : null}
          </div>

          <Button
            variant="secondary"
            onClick={resetCaptureState}
            disabled={busy || sessionItems.length === 0}
            className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
            style={{
              borderColor: "rgba(248,113,113,0.24)",
              color: "#fecaca",
              background: "rgba(127,29,29,0.16)",
            }}
          >
            Clear Session
          </Button>

          <Button
            onClick={finalizeSession}
            disabled={finishDisabled}
            className="rounded-[999px] border px-6 py-3 text-[0.95rem] font-medium"
            style={finishButtonStyle}
          >
            {busy ? "Finishing…" : "Review & Sign"}
          </Button>
        </div>
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
