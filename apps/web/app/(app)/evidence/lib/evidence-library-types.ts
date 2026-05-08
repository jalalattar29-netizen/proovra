import type { EvidenceIntelligence } from "@proovra/shared";
import type {
  BillingOverviewResponse,
  PersonalWorkspaceSummary,
  TeamWorkspaceSummary,
} from "../../../../components/billing/types";

export type EvidenceListScope = "active" | "archived" | "deleted" | "locked";

export type StorageProtectionSummary = {
  immutable: boolean;
  mode: string | null;
  retainUntil: string | null;
  legalHold: string | null;
  region: string | null;
  verified: boolean;
} | null;

export type AnchorSummary = {
  mode: "off" | "ready" | "active";
  provider: string | null;
  publicBaseUrl: string | null;
  configured: boolean;
  published: boolean;
  anchorHash: string | null;
  receiptId: string | null;
  transactionId: string | null;
  publicUrl: string | null;
  anchoredAtUtc: string | null;
};

export type EvidenceListItem = {
  id: string;
  title: string;
  type: string;
  mimeType: string | null;
  primaryKind?: string | null;
  previewable?: boolean;
  status: string;
  statusLabel?: string;
  verificationStatus: string | null;
  verificationStatusLabel?: string;
  captureMethod: string | null;
  captureMethodLabel?: string;
  identityLevel: string | null;
  identityLevelLabel?: string;
  submittedByEmail: string | null;
  latestReportVersion: number | null;
  originalFileName: string | null;
  displayFileName: string | null;
  reviewReadyAtUtc: string | null;
  createdAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
  deleteScheduledForUtc: string | null;
  caseId: string | null;
  teamId: string | null;
  ownerUserId: string;
  itemCount: number;
  storage: StorageProtectionSummary;
  displaySubtitle: string;
};

export type EvidenceListResponse = {
  scope?: EvidenceListScope;
  items?: EvidenceListItem[];
};

export type CaseOption = {
  id: string;
  name: string;
  ownerUserId?: string;
  teamId?: string | null;
};

export type CasesListResponse = {
  items?: CaseOption[];
};

export type EvidenceContentItem = {
  id: string;
  index: number;
  label: string;
  originalFileName?: string | null;
  mimeType?: string | null;
  kind: "image" | "video" | "audio" | "pdf" | "text" | "other";
  sizeBytes?: string | null;
  durationMs?: number | null;
  sha256?: string | null;
  isPrimary: boolean;
  previewable: boolean;
  downloadable: boolean;
  viewUrl?: string | null;
  displaySizeLabel?: string | null;
  previewRole?: "primary_preview" | "secondary_preview" | "download_only" | "metadata_only";
};

export type EvidenceContentSummary = {
  structure: "single" | "multipart";
  itemCount: number;
  previewableItemCount: number;
  downloadableItemCount: number;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  pdfCount: number;
  textCount: number;
  otherCount: number;
  primaryKind: "image" | "video" | "audio" | "pdf" | "text" | "other" | null;
  primaryMimeType: string | null;
  totalSizeBytes: string | null;
  totalSizeDisplay: string | null;
};

export type EvidenceRecord = {
  id: string;
  title: string;
  originalFileName: string | null;
  displayFileName: string | null;
  displayTitle?: string | null;
  displaySubtitle?: string | null;
  displayDescription?: string | null;
  internalNotes: string | null;
  intakePlanJson: Record<string, unknown> | null;
  type: string;
  status: string;
  verificationStatus: string | null;
  captureMethod: string | null;
  identityLevelSnapshot: string | null;
  submittedByEmail: string | null;
  submittedByAuthProvider: string | null;
  createdByUserId: string | null;
  uploadedByUserId: string | null;
  workspaceNameSnapshot: string | null;
  organizationNameSnapshot: string | null;
  organizationVerifiedSnapshot: boolean | null;
  recordedIntegrityVerifiedAtUtc: string | null;
  lastVerifiedAtUtc: string | null;
  lastVerifiedSource: string | null;
  verificationPackageGeneratedAtUtc: string | null;
  verificationPackageVersion: number | null;
  latestReportVersion: number | null;
  reviewReadyAtUtc: string | null;
  reviewerSummaryVersion: number | null;
  createdAt: string;
  uploadedAtUtc: string | null;
  signedAtUtc: string | null;
  capturedAtUtc: string | null;
  reportGeneratedAtUtc: string | null;
  deviceTimeIso: string | null;
  lat: number | null;
  lng: number | null;
  accuracyMeters: number | null;
  mimeType: string | null;
  storageRegion: string | null;
  storageObjectLockMode: string | null;
  storageObjectLockRetainUntilUtc: string | null;
  storageObjectLockLegalHoldStatus: string | null;
  sizeBytes: string | null;
  fileSha256: string | null;
  fingerprintHash: string | null;
  signatureBase64: string | null;
  signingKeyId: string | null;
  signingKeyVersion: number | null;
  retentionUntilUtc: string | null;
  lockedAt: string | null;
  archivedAt: string | null;
  caseId: string | null;
  teamId: string | null;
  deletedAt: string | null;
  deleteScheduledForUtc: string | null;
  itemCount: number;
  storage: StorageProtectionSummary;
  anchor: AnchorSummary | null;
  contentAccessPolicy?: {
    mode?: "metadata_only" | "preview_only" | "full_access";
    allowContentView?: boolean;
    allowDownload?: boolean;
  } | null;
  contentCompositionSummary?: string | null;
  primaryContentLabel?: string | null;
  defaultPreviewItemId?: string | null;
  contentSummary?: EvidenceContentSummary | null;
  contentItems?: EvidenceContentItem[] | null;
  primaryContentItem?: EvidenceContentItem | null;
  previewPolicy?: {
    contentVisible?: boolean;
    previewEnabled?: boolean;
    downloadableFromVerify?: boolean;
    rationale?: string | null;
    privacyNotice?: string | null;
  } | null;
  evidenceIntelligence?: EvidenceIntelligence | null;
};

export type EvidenceResponse = {
  evidence?: EvidenceRecord;
};

export type EvidencePart = {
  id: string;
  partIndex: number;
  originalFileName?: string | null;
  mimeType?: string | null;
  sizeBytes?: string | null;
  sha256?: string | null;
  durationMs?: number | null;
  privateRole?: string | null;
  privateNote?: string | null;
  checklistStepId?: string | null;
  sourceLabel?: string | null;
  clientSignals?: Record<string, unknown> | null;
  url?: string | null;
  publicUrl?: string | null;
  previewUrl?: string | null;
  kind?: "image" | "video" | "audio" | "pdf" | "text" | "other";
  previewable?: boolean;
  label?: string | null;
  displayName?: string | null;
  displaySizeLabel?: string | null;
  isPrimary?: boolean;
  storage?: StorageProtectionSummary;
  capturedAt?: string | null;
  createdAt?: string | null;
};

export type PartsResponse = {
  evidenceId?: string;
  multipart?: boolean;
  primary?: {
    bucket?: string | null;
    key?: string | null;
  } | null;
  parts?: EvidencePart[];
};

export type OriginalResponse = {
  evidenceId?: string;
  bucket?: string | null;
  key?: string | null;
  originalFileName?: string | null;
  displayName?: string | null;
  url?: string | null;
  publicUrl?: string | null;
  previewUrl?: string | null;
  mimeType?: string | null;
  kind?: "image" | "video" | "audio" | "pdf" | "text" | "other";
  previewable?: boolean;
  sizeBytes?: string | null;
  displaySizeLabel?: string | null;
  lastAccessedAtUtc?: string | null;
  storage?: StorageProtectionSummary;
};

export type ReportResponse = {
  evidenceId?: string;
  version?: number | null;
  url?: string | null;
  generatedAtUtc?: string | null;
};

export type VerificationPackageResponse = {
  evidenceId?: string;
  version?: number | null;
  packageType?: string | null;
  key?: string | null;
  url?: string | null;
  generatedAtUtc?: string | null;
  storage?: StorageProtectionSummary;
  trustDecision?: unknown;
};

export type WorkspaceCapabilitySnapshot = {
  workspaceType: "PERSONAL" | "TEAM";
  workspaceName: string;
  plan: string;
  reportsIncluded: boolean;
  verificationPackageIncluded: boolean;
  publicVerifyIncluded: boolean;
};

export type DetailWorkspaceState = {
  evidence: EvidenceRecord | null;
  parts: EvidencePart[];
  original: OriginalResponse | null;
  report: ReportResponse | null;
  verificationPackage: VerificationPackageResponse | null;
  capabilities: WorkspaceCapabilitySnapshot;
  caseName: string | null;
};

export type LibraryLoadState = {
  billingOverview: BillingOverviewResponse | null;
  personalWorkspace: PersonalWorkspaceSummary | null;
  teamWorkspaces: TeamWorkspaceSummary[];
  cases: CaseOption[];
  items: EvidenceListItem[];
};

export type ReviewAlertSeverity = "critical" | "operational" | "informational";

export type ReviewAlert = {
  severity: ReviewAlertSeverity;
  label: string;
  detail: string;
};
