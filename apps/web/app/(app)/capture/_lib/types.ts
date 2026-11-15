export type EvidenceType = "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";

export type CameraMode = "PHOTO" | "VIDEO" | null;

export type FacingMode = "user" | "environment";

export type AudioRecorderState =
  | "idle"
  | "recording"
  | "stopped"
  | "preview_ready"
  | "uploading"
  | "failed";

export type BillingWallLike = {
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

export type ChecklistStep = {
  id: string;
  title: string;
  description: string;
  purposeLabel: string;
  required: boolean;
  acceptedKinds?: EvidenceType[];
};

export type CollectionPlanTemplate = {
  id: string;
  name: string;
  description: string;
  locationRequirement: "optional" | "recommended" | "required";
  steps: ChecklistStep[];
};

export type SessionItemClientSignals = {
  clientHintSha256Base64?: string;
  captureTimeUtc: string;
  browserMediaCaptureAvailable: boolean;
  folderPathPresent: boolean;
  locationIncluded: boolean;
  duplicateStatus?: "none" | "warning" | "duplicate";
  screenshotLike?: boolean;
  genericMime?: boolean;
  oldLastModified?: boolean;
  /**
   * F-P1-09 parity — a video recorded WITHOUT audio because the microphone
   * permission was denied (the native contract: `audioTracks: []` +
   * `audioNotCapturedReason`). Absent for every other item.
   */
  audioTracks?: string[];
  audioNotCapturedReason?: "MICROPHONE_PERMISSION_DENIED";
};

/** F-P1-09 — the part signals of a video recorded after the microphone was refused (as native). */
export const VIDEO_WITHOUT_MICROPHONE_SIGNALS = {
  audioTracks: [] as string[],
  audioNotCapturedReason: "MICROPHONE_PERMISSION_DENIED" as const,
};

export type SessionTimelineEvent = {
  id: string;
  atUtc: string;
  title: string;
  detail: string;
  tone: "info" | "warning" | "danger";
};

export type SessionItem = {
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

export type ItemQualityStatus = {
  tone: "success" | "warning" | "danger";
  label: string;
  detail: string;
};

export type ChecklistStepStatus = {
  label: string;
  tone: "success" | "warning";
  title: string;
  description: string;
};