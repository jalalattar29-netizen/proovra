// Pure type declarations extracted from page.tsx (P7 R5.1 decomposition).
// No runtime code — import-only.

export type VerifyTimelineEvent = {
  sequence?: number | null;
  eventType?: string | null;
  atUtc?: string | null;
  payloadSummary?: string | null;
  prevEventHash?: string | null;
  eventHash?: string | null;
  category?: "forensic" | "access" | null;
};

export type VerifyOverview = {
  recordStatus?: string | null;
  recordLifecycleStatus?: string | null;
  verificationStatus?: string | null;
  verificationStatusCode?: string | null;
  integrityHeadline?: string | null;
  evidenceTitle?: string | null;
  evidenceId?: string | null;
  evidenceType?: string | null;
  evidenceStructure?: string | null;
  itemCount?: number | null;
  captureMethod?: string | null;
  captureMethodCode?: string | null;
  mimeType?: string | null;
  submittedByEmail?: string | null;
  submittedByAuthProvider?: string | null;
  submittedByAuthProviderCode?: string | null;
  identityLevel?: string | null;
  identityLevelCode?: string | null;
  workspaceName?: string | null;
  organizationName?: string | null;
  organizationVerified?: boolean | null;
  createdAt?: string | null;
  capturedAtUtc?: string | null;
  uploadedAtUtc?: string | null;
  signedAtUtc?: string | null;
  recordedIntegrityVerifiedAtUtc?: string | null;
  lastVerifiedAtUtc?: string | null;
  lastVerifiedSource?: string | null;
  lastVerifiedSourceCode?: string | null;
  lastVerifiedAtUtcLabel?: string | null;
  lastPublicVerifyViewAtUtc?: string | null;
  lastPublicVerifyViewAtUtcLabel?: string | null;
  currentPublicVerifyViewAtUtc?: string | null;
  currentPublicVerifyViewAtUtcLabel?: string | null;
  reviewReadyAtUtc?: string | null;
  verificationPackageGeneratedAtUtc?: string | null;
  verificationPackageVersion?: number | null;
  reviewerSummaryVersion?: number | null;
  reportVersion?: number | null;
  reportGeneratedAtUtc?: string | null;
  timestampStatus?: string | null;
  otsStatus?: string | null;
  storageProtection?: string | null;
  chainOfCustodyPresent?: boolean | null;
  externalPublicationPresent?: boolean | null;
  externalPublicationProvider?: string | null;
  externalPublicationUrl?: string | null;
  externalPublicationAnchoredAtUtc?: string | null;
};

export type VerifyHumanSummary = {
  integrityStatus?: string | null;
  recordStatus?: string | null;
  verificationStatus?: string | null;
  summary?: string | null;
  whatIsVerified?: string | null;
  evidenceTitle?: string | null;
  evidenceId?: string | null;
  evidenceType?: string | null;
  evidenceStructure?: string | null;
  captureMethod?: string | null;
  fileType?: string | null;
  submittedBy?: string | null;
  authProvider?: string | null;
  identityLevel?: string | null;
  organization?: string | null;
  workspace?: string | null;
  organizationVerified?: boolean | null;
  createdAt?: string | null;
  capturedAtUtc?: string | null;
  uploadedAtUtc?: string | null;
  signedAtUtc?: string | null;
  recordedIntegrityVerifiedAtUtc?: string | null;
  lastVerifiedAtUtc?: string | null;
  lastVerifiedSource?: string | null;
  lastPublicVerifyViewAtUtc?: string | null;
  currentPublicVerifyViewAtUtc?: string | null;
  chainOfCustodyPresent?: boolean | null;
  reportVersion?: number | null;
  reportGeneratedAtUtc?: string | null;
  verificationPackageVersion?: number | null;
  verificationPackageGeneratedAtUtc?: string | null;
  reviewerSummaryVersion?: number | null;
  timestampStatus?: string | null;
  otsStatus?: string | null;
  storageProtection?: string | null;
  externalPublicationPresent?: boolean | null;
  externalPublicationProvider?: string | null;
  externalPublicationUrl?: string | null;
  externalPublicationAnchoredAtUtc?: string | null;
};

export type VerifyCaptureContext = {
  statusLabel?: string | null;
  description?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracyMeters?: number | null;
  capturedAtUtc?: string | null;
  deviceTimeIso?: string | null;
  source?: string | null;
  externalMapUrl?: string | null;
  legalBoundary?: string | null;
} | null;

export type VerifyReviewTrail = {
  forensicEventCount?: number | null;
  accessEventCount?: number | null;
  forensicCustodyEvents?: VerifyTimelineEvent[] | null;
  accessCustodyEvents?: VerifyTimelineEvent[] | null;
};

export type VerifyTechnicalMaterials = {
  fileSha256?: string | null;
  fingerprintHash?: string | null;
  signatureBase64?: string | null;
  publicKeyPem?: string | null;
  signingKeyId?: string | null;
  signingKeyVersion?: number | null;
  tsaInputDigestHex?: string | null;
  tsaInputKind?: string | null;
  legacyMode?: boolean | null;
  otsProofPresent?: boolean | null;
};

export type VerifyStorageProtection = {
  immutable?: boolean | null;
  mode?: string | null;
  retainUntil?: string | null;
  legalHold?: string | null;
  region?: string | null;
  verified?: boolean | null;
} | null;

export type VerifyTsa = {
  status?: string | null;
  provider?: string | null;
  tokenBase64?: string | null;
  messageImprint?: string | null;
  inputDigestHex?: string | null;
  inputKind?: string | null;
  legacyMode?: boolean | null;
  url?: string | null;
  serialNumber?: string | null;
  genTimeUtc?: string | null;
  hashAlgorithm?: string | null;
  failureReason?: string | null;
  digestMatchesTimestampInput?: boolean | null;
  digestMatchesFileHash?: boolean | null;
  timestampedDigestLabel?: string | null;
  timestampedDigestNote?: string | null;
  digestCheckConclusive?: boolean | null;
  timestampAvailable?: boolean | null;
} | null;

export type VerifyOts = {
  status?: string | null;
  hash?: string | null;
  calendar?: string | null;
  bitcoinTxid?: string | null;
  anchoredAtUtc?: string | null;
  upgradedAtUtc?: string | null;
  failureReason?: string | null;
  proofPresent?: boolean | null;
  hashMatchesFingerprintHash?: boolean | null;
  proofBase64?: string | null;
} | null;

export type VerifyStorageAndTimestamping = {
  storage?: VerifyStorageProtection;
  tsa?: VerifyTsa;
  ots?: VerifyOts;
};

export type VerifyLimitations = {
  short?: string | null;
  detailed?: string | null;
};

export type VerifyIdentity = {
  submittedByEmail?: string | null;
  submittedByAuthProvider?: string | null;
  submittedByAuthProviderLabel?: string | null;
  submittedByUserId?: string | null;
  identityLevel?: string | null;
  identityLevelLabel?: string | null;
  workspaceName?: string | null;
  organizationName?: string | null;
  organizationVerified?: boolean | null;
} | null;

export type VerifyAnchor = {
  mode?: string | null;
  provider?: string | null;
  publicBaseUrl?: string | null;
  configured?: boolean | null;
  published?: boolean | null;
  anchorHash?: string | null;
  receiptId?: string | null;
  transactionId?: string | null;
  publicUrl?: string | null;
  anchoredAtUtc?: string | null;
} | null;

export type VerifyEvidenceAssetKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "other";

export type VerifyEvidenceAsset = {
  id: string;
  index: number;
  label: string;
  originalFileName?: string | null;
  mimeType?: string | null;
  kind: VerifyEvidenceAssetKind;
  sizeBytes?: string | null;
  durationMs?: number | null;
  sha256?: string | null;
  isPrimary: boolean;
  artifactRole?: "primary_evidence" | "supporting_evidence" | "attachment" | null;
  artifactRoleLabel?: string | null;
  artifactRoleSource?: string | null;
  checklistStepId?: string | null;
  checklistStepLabel?: string | null;
  sourceLabel?: string | null;
  previewable: boolean;
  downloadable: boolean;
  viewUrl?: string | null;
  displaySizeLabel?: string | null;
  previewRole?:
    | "primary_preview"
    | "secondary_preview"
    | "download_only"
    | "metadata_only";
  originalPreservationNote?: string | null;
  reviewerRepresentationLabel?: string | null;
  reviewerRepresentationNote?: string | null;
  verificationMaterialsNote?: string | null;
  previewDataUrl?: string | null;
  previewTextExcerpt?: string | null;
  previewCaption?: string | null;
};

export type VerifyEvidenceContentSummary = {
  structure?: "single" | "multipart";
  itemCount?: number;
  primaryKind?: VerifyEvidenceAssetKind | null;
  totalSizeDisplay?: string | null;
  imageCount?: number;
  videoCount?: number;
  audioCount?: number;
  pdfCount?: number;
  textCount?: number;
  otherCount?: number;
} | null;

export type VerifyPreviewPolicy = {
  contentVisible?: boolean;
  previewEnabled?: boolean;
  downloadableFromVerify?: boolean;
  rationale?: string | null;
  privacyNotice?: string | null;
} | null;

export type VerifyContentAccessPolicy = {
  mode?: "metadata_only" | "preview_only" | "full_access";
  allowContentView?: boolean;
  allowDownload?: boolean;
} | null;

export type VerifyContentExposureDecision = {
  mode?: "metadata_only" | "preview_only" | "full_access";
  allowContentView?: boolean;
  allowDownload?: boolean;
  rationale?: string | null;
} | null;

export type TimelineItem = {
  sequence?: number | null;
  eventType: string;
  atUtc: string | null;
  payloadSummary: string | null;
  prevEventHash?: string | null;
  eventHash?: string | null;
  category?: "forensic" | "access" | null;
};

export type ToastFn = (
  message: string,
  type: "success" | "info" | "error" | "warning",
  duration?: number
) => void;

export type StorageProtection = {
  immutable: boolean | null;
  mode: string | null;
  retainUntil: string | null;
  legalHold: string | null;
  region: string | null;
  verified: boolean | null;
};

export type OtsDetails = {
  status: string | null;
  hash: string | null;
  calendar: string | null;
  bitcoinTxid: string | null;
  anchoredAtUtc: string | null;
  upgradedAtUtc: string | null;
  failureReason: string | null;
  proofBase64: string | null;
  proofPresent: boolean | null;
  hashMatchesFingerprintHash: boolean | null;
};

export type TechnicalTabId =
  | "record"
  | "integrity"
  | "package"
  | "full-custody"
  | "access";

export type TrustSignalStatus =
  | "passed"
  | "partial"
  | "pending"
  | "missing"
  | "failed";

export type TrustDecisionTone = "success" | "warning" | "danger" | "neutral";

export type VerifyTrustSignal = {
  key:
    | "core_integrity"
    | "signature"
    | "trusted_timestamp"
    | "public_anchoring"
    | "immutable_storage"
    | "custody_chain"
    | "identity"
    | "verification_package";
  label: string;
  status: TrustSignalStatus;
  tone: TrustDecisionTone;
  points: number;
  maxPoints: number;
  summary: string;
  detail: string;
};

export type VerifyTrustDecision = {
  verdict:
    | "STRONGLY_VERIFIED"
    | "VERIFIED"
    | "PARTIALLY_VERIFIED"
    | "REVIEW_REQUIRED";
  verdictLabel: string;
  shortLabel: string;
  score: number;
  scoreLabel: string;
  tone: TrustDecisionTone;
  presentationState?:
    | "VERIFIED_FINALIZED"
    | "VERIFIED_PENDING_PUBLICATION"
    | "VERIFIED_WITH_DEGRADED_SIGNALS"
    | "PARTIALLY_VERIFIED"
    | "FAILED_VERIFICATION"
    | "REVIEW_REQUIRED";
  presentationTone?: TrustDecisionTone;
  publicationState?:
    | "finalized"
    | "pending"
    | "degraded"
    | "unavailable"
    | "failed";
  confidenceLabel?: string;
  publicationStatusLabel?: string;
  relianceLevel: "high" | "medium" | "limited" | "low";
  degradedButUsable: boolean;
  summary: string;
  primaryReason: string;
  reviewerAction: string;
  passedSignals: number;
  degradedSignals: number;
  failedSignals: number;
  signals: VerifyTrustSignal[];
};

export type VerificationVerdict = {
  status:
    | "verified"
    | "review_required"
    | "partial"
    | "unavailable";
  title: string;
  label: string;
  riskLevel: "Low" | "Medium" | "High" | "Unknown";
  actionRequired: string;
  legalStatement: string;
  reviewerSummary: string;
  confidenceScore: number;
  tone: "success" | "warning" | "danger" | "neutral";
};

export type VerificationSignalInput = {
  trustDecision?: VerifyTrustDecision | null;
  overallIntegrity: boolean | null;
  verificationStatus?: string | null;
  canonicalHashMatches: boolean | null;
  signatureValid: boolean | null;
  custodyChainValid: boolean | null;
  timestampDigestMatches: boolean | null;
  otsHashMatches: boolean | null;
  tsaStatus?: string | null;
  storageVerified: boolean | null;
  immutableStorage: boolean | null;
  externalPublicationPresent: boolean | null;
};

export type VerificationPackageIntegrity = {
  available: boolean;
  version: string | null;
  generatedAtUtc: string | null;
  packageType?: string | null;
  manifestPresent: boolean;
  signedManifestPresent: boolean;
  manifestDigestPresent: boolean;
  checksumIndexPresent: boolean;
  offlineVerifierIncluded: boolean;
  auditExportIncluded: boolean;
  custodyExportIncluded: boolean;
  accessExportIncluded: boolean;
};

export type VerifyLifecycleTransparency = {
  schemaVersion: string;
  generatedAtUtc: string;
  evidenceId: string;
  retention: { policyName: string; years: number } | null;
  legalHold: { kind: string; state: string } | null;
  archive: { currentTier: string } | null;
  transfer: { state: string; toOrganizationSlug: string } | null;
  destruction: {
    state: string;
    certifiedAtUtc: string | null;
    certificateHashPrefix: string | null;
  } | null;
};

export type VerifyResponse = {
  evidenceId?: string | null;
  mediaIntelligenceAdvisory?: {
    hasObservations: boolean;
    observationCount: number;
    advisory: string;
  } | null;
  tsaTokenBase64?: string | null;
  tsaMessageImprint?: string | null;
  id?: string | null;
  title?: string | null;
  status?: string | null;
  trustDecision?: VerifyTrustDecision | null;
  trustDecisionConsistency?: {
    source?: string | null;
    consistentWithSnapshot?: boolean | null;
    tone?: "neutral" | "info" | "warning" | "danger" | null;
    accessOnly?: boolean | null;
    integrityCritical?: boolean | null;
    reasons?:
      | Array<{
          code?: string | null;
          label?: string | null;
          detail?: string | null;
          tone?: "info" | "warning" | "danger" | null;
          integrityCritical?: boolean | null;
        }>
      | null;
  } | null;
  verificationStatus?: string | null;
  captureMethod?: string | null;
  identityLevelSnapshot?: string | null;
  verificationPackageIntegrity?: Partial<VerificationPackageIntegrity> | null;
  mimeType?: string | null;
  reportGeneratedAtUtc?: string | null;
  generatedAtUtc?: string | null;
  verifiedAtUtc?: string | null;
  verificationCheckedAtUtc?: string | null;
  reportVersion?: number | string | null;
  fileSha256?: string | null;
  fingerprintHash?: string | null;
  signatureBase64?: string | null;
  signingKeyId?: string | null;
  signingKeyVersion?: number | null;
  publicKeyPem?: string | null;
  tsaStatus?: string | null;
  tsaProvider?: string | null;
  tsaUrl?: string | null;
  tsaSerialNumber?: string | null;
  tsaGenTimeUtc?: string | null;
  tsaHashAlgorithm?: string | null;
  tsaFailureReason?: string | null;
  tsa?: VerifyTsa;
  timestamp?: VerifyTsa;
  otsStatus?: string | null;
  otsHash?: string | null;
  otsCalendar?: string | null;
  otsBitcoinTxid?: string | null;
  otsAnchoredAtUtc?: string | null;
  otsUpgradedAtUtc?: string | null;
  otsFailureReason?: string | null;
  otsProofBase64?: string | null;
  ots?: VerifyOts;
  storage?: VerifyStorageProtection;
  anchor?: VerifyAnchor;
  identity?: VerifyIdentity;
  integrityProof?: {
    canonicalHashMatches?: boolean;
    signatureValid?: boolean;
    custodyChainValid?: boolean;
    custodyChainMode?: string | null;
    custodyChainFailureReason?: string | null;
    timestampDigestMatches?: boolean | null;
    otsHashMatches?: boolean;
    overallIntegrity?: boolean;
    forensicEventCount?: number;
    accessEventCount?: number;
  } | null;
  verification?: {
    canonicalHashMatches?: boolean;
    signatureValid?: boolean;
    custodyChainValid?: boolean;
    custodyChainMode?: string | null;
    custodyChainFailureReason?: string | null;
    timestampDigestMatches?: boolean | null;
    otsHashMatches?: boolean;
    overallIntegrity?: boolean;
    forensicEventCount?: number;
    accessEventCount?: number;
  } | null;
  custodyEvents?: VerifyTimelineEvent[] | null;
  forensicCustodyEvents?: VerifyTimelineEvent[] | null;
  accessCustodyEvents?: VerifyTimelineEvent[] | null;
  custodyDisplayCounts?: {
    forensicAtReportGeneration?: number | null;
    currentForensicEvents?: number | null;
    currentForensic?: number | null;
    accessAfterReportGeneration?: number | null;
    currentAccessEvents?: number | null;
    totalDisplayedEvents?: number | null;
    totalDisplayedNow?: number | null;
    reportGeneratedAtUtc?: string | null;
  } | null;
  overview?: VerifyOverview | null;
  humanSummary?: VerifyHumanSummary | null;
  captureContext?: VerifyCaptureContext;
  reviewTrail?: VerifyReviewTrail | null;
  custodyLifecycle?: {
    forensicEventCount?: number | null;
    accessEventCount?: number | null;
    forensicEvents?: VerifyTimelineEvent[] | null;
    accessEvents?: VerifyTimelineEvent[] | null;
    chronologyNote?: string | null;
  } | null;
  technicalMaterials?: VerifyTechnicalMaterials | null;
  storageAndTimestamping?: VerifyStorageAndTimestamping | null;
  limitations?: VerifyLimitations | null;
  contentAccessPolicy?: VerifyContentAccessPolicy;
  contentExposureDecision?: VerifyContentExposureDecision;
  evidenceContent?: {
    summary?: VerifyEvidenceContentSummary;
    items?: VerifyEvidenceAsset[] | null;
    primaryItem?: VerifyEvidenceAsset | null;
    defaultPreviewItemId?: string | null;
    previewPolicy?: VerifyPreviewPolicy;
  } | null;
};
