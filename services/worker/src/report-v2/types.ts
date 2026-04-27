export type ReportArtifactMode = "external" | "internal";
export type PresentationMode = "simple" | "medium" | "heavy";
export type ReportVariant = "compact" | "balanced" | "full";

export type ReportEvidenceAssetKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "other";

export type ReportEvidenceAsset = {
  id: string;
  index: number;
  label: string;
  originalFileName: string | null;
  mimeType: string | null;
  kind: ReportEvidenceAssetKind;
  sizeBytes: string | null;
  durationMs: number | null;
  sha256: string | null;
  isPrimary: boolean;
  previewable: boolean;
  downloadable: boolean;
  viewUrl: string | null;
  displaySizeLabel: string | null;
  previewRole?:
    | "primary_preview"
    | "secondary_preview"
    | "download_only"
    | "metadata_only";
  embedPreference?:
    | "image"
    | "pdf_first_page"
    | "audio_placeholder"
    | "video_placeholder"
    | "text_excerpt"
    | "metadata_only";
  artifactRole?: "primary_evidence" | "supporting_evidence" | "attachment";
  originalPreservationNote?: string | null;
  reviewerRepresentationLabel?: string | null;
  reviewerRepresentationNote?: string | null;
  verificationMaterialsNote?: string | null;
  previewDataUrl?: string | null;
  previewTextExcerpt?: string | null;
  previewCaption?: string | null;
};

export type PreviewRenderKind =
  | "image"
  | "document"
  | "text"
  | "video"
  | "audio"
  | "placeholder";

export type PresentationEvidenceItem = {
  asset: ReportEvidenceAsset;
  previewRenderKind: PreviewRenderKind;
  hasRenderablePreview: boolean;
  prominent: boolean;
};

export type ReportEvidenceContentSummary = {
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
  primaryKind: ReportEvidenceAssetKind | null;
  primaryMimeType: string | null;
  totalSizeBytes: string | null;
  totalSizeDisplay: string | null;
};

export type ReportPreviewPolicy = {
  contentVisible: boolean;
  previewEnabled: boolean;
  downloadableFromVerify: boolean;
  rationale: string;
  privacyNotice: string;
};

export type ReportReviewGuidance = {
  reviewerWorkflow: string[];
  contentReviewNote: string;
  legalAssessmentNote: string;
  integrityAssessmentNote: string;
  multipartReviewNote: string;
};

export type ReportLegalLimitations = {
  short: string;
  detailed: string;
};

export type ReportAnchorSummary = {
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

export type ReportCertificationSnapshot = {
  declarationType?: string | null;
  status?: string | null;
  version?: number | null;
  requestedAtUtc?: string | null;
  attestedAtUtc?: string | null;
  attestorName?: string | null;
  attestorTitle?: string | null;
  attestorOrganization?: string | null;
  certificationHash?: string | null;
  revokedAtUtc?: string | null;
} | null;

export type ReportEvidence = {
  id: string;
  title?: string | null;
  type?: string | null;
  status: string;
  verificationStatus?: string | null;
  captureMethod?: string | null;
  identityLevelSnapshot?: string | null;
  submittedByEmail?: string | null;
  submittedByAuthProvider?: string | null;
  submittedByUserId?: string | null;
  createdByUserId?: string | null;
  uploadedByUserId?: string | null;
  lastAccessedByUserId?: string | null;
  lastAccessedAtUtc?: string | null;
  workspaceNameSnapshot?: string | null;
  organizationNameSnapshot?: string | null;
  organizationVerifiedSnapshot?: boolean | null;
  recordedIntegrityVerifiedAtUtc?: string | null;
  lastVerifiedAtUtc?: string | null;
  lastVerifiedSource?: string | null;
  verificationPackageGeneratedAtUtc?: string | null;
  verificationPackageVersion?: number | null;
  latestReportVersion?: number | null;
  reviewReadyAtUtc?: string | null;
  reviewerSummaryVersion?: number | null;
  capturedAtUtc: string | null;
  uploadedAtUtc: string | null;
  signedAtUtc: string | null;
  reportGeneratedAtUtc: string | null;
  mimeType: string | null;
  sizeBytes: string | null;
  durationSec?: string | null;
  storageBucket: string | null;
  storageKey: string | null;
  publicUrl: string | null;
  storageRegion?: string | null;
  storageImmutable?: boolean | null;
  storageObjectLockMode?: string | null;
  storageObjectLockRetainUntilUtc?: string | null;
  storageObjectLockLegalHoldStatus?: string | null;
  gps: {
    lat: string | null;
    lng: string | null;
    accuracyMeters: string | null;
  };
  evidenceStructure?: string | null;
  itemCount?: number | null;
  display?: {
    displayTitle: string;
    displayDescription: string | null;
  } | null;
  displayTitle?: string | null;
  displayDescription?: string | null;
  contentCompositionSummary?: string | null;
  primaryContentLabel?: string | null;
  contentSummary?: ReportEvidenceContentSummary | null;
  contentItems?: ReportEvidenceAsset[] | null;
  primaryContentItem?: ReportEvidenceAsset | null;
  defaultPreviewItemId?: string | null;
  previewPolicy?: ReportPreviewPolicy | null;
  reviewGuidance?: ReportReviewGuidance | null;
  limitations?: ReportLegalLimitations | null;
  contentAccessPolicy?: {
    mode?: string | null;
    allowContentView?: boolean;
    allowDownload?: boolean;
  } | null;
  fileSha256: string | null;
  fingerprintCanonicalJson: string | null;
  fingerprintHash: string | null;
  signatureBase64: string | null;
  signingKeyId: string | null;
  signingKeyVersion: number | null;
  publicKeyPem: string | null;
  tsaProvider: string | null;
  tsaUrl: string | null;
  tsaSerialNumber: string | null;
  tsaGenTimeUtc: string | null;
  tsaTokenBase64: string | null;
  tsaMessageImprint: string | null;
  tsaHashAlgorithm: string | null;
  tsaStatus: string | null;
  tsaFailureReason: string | null;
  otsProofBase64?: string | null;
  otsHash?: string | null;
  otsStatus?: string | null;
  otsCalendar?: string | null;
  otsBitcoinTxid?: string | null;
  otsAnchoredAtUtc?: string | null;
  otsUpgradedAtUtc?: string | null;
  otsFailureReason?: string | null;
  anchor?: ReportAnchorSummary | null;
  certifications?: {
    custodian?: ReportCertificationSnapshot;
    qualifiedPerson?: ReportCertificationSnapshot;
  } | null;
  anchorMode?: string | null;
  anchorProvider?: string | null;
  anchorHash?: string | null;
  anchorReceiptId?: string | null;
  anchorTransactionId?: string | null;
  anchorPublicUrl?: string | null;
  anchorAnchoredAtUtc?: string | null;
  embeddedPreviewsSnapshot?: Array<{
    id: string;
    previewDataUrl?: string | null;
    previewTextExcerpt?: string | null;
    previewCaption?: string | null;
  }> | null;
};

export type ReportCustodyEvent = {
  sequence: number;
  atUtc: string;
  eventType: string;
  payloadSummary: string;
  prevEventHash?: string | null;
  eventHash?: string | null;
  category?: "forensic" | "access";
};

export type ReportV2Input = {
  evidence: ReportEvidence;
  custodyEvents: ReportCustodyEvent[];
  version: number;
  generatedAtUtc: string;
  buildInfo?: string | null;
  verifyUrl?: string | null;
  downloadUrl?: string | null;
  externalMode?: boolean;
};

export type Tone = "neutral" | "success" | "warning" | "danger";

export type KeyValueRow = {
  label: string;
  value: string;
};

export type InfoCard = {
  label: string;
  value: string;
  tone?: Tone;
};

export type CalloutModel = {
  title: string;
  body: string;
  tone?: Tone;
};

export type InventoryRow = {
  indexLabel: string;
  fileName: string;
  displayLabel: string | null;
  kindLabel: string;
  formatAndSize: string;
  sha256: string;
  roleAndStatus: string;
};

export type TimelineRow = {
  sequence: string;
  atUtc: string;
  eventLabel: string;
  summary: string;
};

export type CustodyHashRow = {
  sequence: string;
  atUtc: string;
  eventLabel: string;
  prevEventHash: string;
  eventHash: string;
};

export type ReportPresentationDecisions = {
  showAllPreviewableItems: boolean;
  showSupportingPreviewCards: boolean;
  compactExecutiveSummary: boolean;
  compactLegalSection: boolean;
  compactForensicStatement: boolean;
  showHashChainDetailsInMainFlow: boolean;
  showEvidenceContentSection: boolean;
  showCertificationSection: boolean;
  appendixDepth: "compact" | "balanced" | "full";
};

export type ReportPresentationBuckets = {
  heroItem: PresentationEvidenceItem | null;
  primaryPreviewItems: PresentationEvidenceItem[];
  supportingPreviewItems: PresentationEvidenceItem[];
  metadataOnlyItems: PresentationEvidenceItem[];
};

export type ReportViewModel = {
  mode: ReportArtifactMode;
  presentationMode: PresentationMode;
  reportVariant: ReportVariant;
  generatedAtUtc: string;
  buildInfo: string | null;
  verifyUrl: string;
  technicalUrl: string;
  version: number;

  title: string;
  subtitle: string | null;

  evidenceReference: string;
  recordStatusLabel: string;
  verificationStatusLabel: string;
  integrityVerified: boolean;

  executiveConclusion: CalloutModel;
  legalLimitationShort: CalloutModel;
  reviewSequence: CalloutModel;
  mismatchSummary: CalloutModel;

  heroCards: InfoCard[];

  executiveRows: KeyValueRow[];
  verificationSummaryRows: KeyValueRow[];
  reviewReadinessRows: KeyValueRow[];
  contentSummaryRows: KeyValueRow[];

  reviewGuidance: ReportReviewGuidance;
  legalLimitations: ReportLegalLimitations;

  contentSummary: ReportEvidenceContentSummary;
  contentItems: ReportEvidenceAsset[];
  primaryContentItem: ReportEvidenceAsset | null;
  structureLabel: string;
  presentation: {
    decisions: ReportPresentationDecisions;
    buckets: ReportPresentationBuckets;
  };

  galleryEnabled: boolean;
  inventoryRows: InventoryRow[];

  certifications: {
    custodian: ReportCertificationSnapshot;
    qualifiedPerson: ReportCertificationSnapshot;
    hasAny: boolean;
  };

  certificationBlocks: Array<{
    kind: "custodian" | "qualified";
    callout: CalloutModel;
    rows: KeyValueRow[];
  }>;

  storageRows: KeyValueRow[];
  storageCallouts: CalloutModel[];

  forensicRows: TimelineRow[];
  accessRows: TimelineRow[];
  custodyHashRows: CustodyHashRow[];

  technicalIdentityRows: KeyValueRow[];
  technicalFingerprintNarrative: string;
  technicalAppendix: {
    fileSha256: string;
    fingerprintHash: string;
    signingKeyReference: string;
    signatureRows: KeyValueRow[];
    fingerprintRows: KeyValueRow[];
    timestampRows: KeyValueRow[];
    anchoringRows: KeyValueRow[];
    timestampStatusLabel: string;
    timestampStatusTone: Tone;
    otsStatusLabel: string;
    otsStatusTone: Tone;
    tsaMessageImprint: string | null;
    otsHash: string | null;
    otsDetail: string | null;
    anchorHash: string | null;
    timestampReferenceNote: string;
    signatureReferenceNote: string;
    anchoringReferenceNote: string;
  };

  forensicIntegrityStatement: {
    introLead: string;
    introBody: string;
    includedBulletItems: string[];
    reviewSteps: string[];
    note: string;
    legalNotice: CalloutModel;
    verificationLinkLabel: string;
    verificationLinkText: string;
  };

  qr: {
    publicEnabled: boolean;
    technicalEnabled: boolean;
    publicLabel: string;
    technicalLabel: string;
    publicDataUrl: string | null;
    technicalDataUrl: string | null;
  };

  meta: {
    hasCoreCrypto: boolean;
    previewPolicy: ReportPreviewPolicy;
    anchorSummary: ReportAnchorSummary | null;
    display: {
      displayTitle: string;
      displayDescription: string | null;
    };
    publicEvidenceTypeLabel: string;
    courtAppendixRows?: KeyValueRow[];
    reviewReadinessSummary: KeyValueRow[];
    timestampRows: KeyValueRow[];
    otsRows: KeyValueRow[];
    anchorRows: KeyValueRow[];
    signingKeyReference: string;
    fileSizeLabel: string;
    primaryHash: string;
    submittedByLabel: string;
    verificationPackageVersionLabel: string;
    reviewerSummaryVersionLabel: string;
    lastVerifiedSourceLabel: string;
    signingKeyLabel: string;
    tsaMessageImprint: string;
    otsHash: string;
    anchorHash: string;
  };
};
