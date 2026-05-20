import type {
  TrustDecision,
  TrustDecisionTone,
  TrustSignal,
  TrustSignalStatus,
  TrustDecisionVerdict,
  ReviewerArtifactRoleSource,
} from "@proovra/shared";

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
  duplicateDigest?: {
  groupId: string;
  groupNumber: number;
  groupSize: number;
  matchingFileNames: string[];
} | null;
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
  artifactRoleSource?: ReviewerArtifactRoleSource;
  checklistStepId?: string | null;
  checklistStepLabel?: string | null;
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
  mode:
    | "not_configured"
    | "pending_public_anchor"
    | "anchored"
    | "failed"
    | "off"
    | "ready"
    | "active";
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
  // Phase D Blocker 3 — per-artifact presence flags persisted on the
  // Evidence row when the verification package is generated. Pass through
  // so the report does NOT have to infer all artifacts are present from
  // the mere existence of a package record.
  verificationPackageMetadata?: {
    manifestPresent?: boolean;
    signedManifestPresent?: boolean;
    checksumIndexPresent?: boolean;
    offlineVerifierIncluded?: boolean;
    auditExportIncluded?: boolean;
    custodyExportIncluded?: boolean;
    accessExportIncluded?: boolean;
    packageVersion?: string;
    generatedAtUtc?: string;
    source?: string;
  } | null;
  latestReportVersion?: number | null;
  reviewReadyAtUtc?: string | null;
  reviewerSummaryVersion?: number | null;
  createdAtUtc?: string | null;
  capturedAtUtc: string | null;
  deviceTimeIso?: string | null;
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
  tsaInputDigestHex?: string | null;
  tsaInputKind?: string | null;
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
  /**
   * Phase 31.10 — OPTIONAL advisory media intelligence bundle.
   *
   * When omitted (the default for every existing caller), the
   * rendered report HTML is BYTE-IDENTICAL to the pre-Phase-31.10
   * output. The media intelligence section emits `""` and the
   * render pipeline filters it out before joining.
   *
   * When supplied, the bounded "Media Intelligence Observations"
   * section is appended between the Reviewer Verification
   * Workflow and the Legal Interpretation & Report Boundary
   * sections. The section is advisory only and carries an inline
   * disclaimer; the legal hierarchy is unchanged.
   *
   * Anti-leak: this input shape carries ONLY the bounded,
   * operator-safe fields. Storage keys, signed URLs, raw GPS,
   * private notes, multipart upload ids — none can be passed.
   */
  mediaIntelligence?: MediaIntelligenceReportInput | null;
};

// ===========================================================================
// Phase 31.10 — Media Intelligence Observations report input
// ===========================================================================

/**
 * Bounded report-side input for media intelligence. The caller
 * (services/api evidence/report route) projects from the canonical
 * media_intelligence_signals + evidence_part_exif_summaries +
 * derived_assets tables INTO this shape, applying every
 * anti-leak invariant. The report renderer never re-projects.
 */
export type MediaIntelligenceReportInput = {
  signals?: ReadonlyArray<MediaIntelligenceReportSignal>;
  /** Optional bounded derived-thumbnail data URLs. Each entry
   *  links to a material id; the renderer displays only thumbnails
   *  that fit a tiny size budget. Bytes themselves are inline data
   *  URLs already produced by the caller — the renderer never
   *  reaches out to S3. */
  derivedThumbnails?: ReadonlyArray<MediaIntelligenceReportThumbnail>;
  /** Optional bounded OCR / transcript availability per material.
   *  Provenance only — never carries the actual extracted prose. */
  ocrTranscript?: ReadonlyArray<MediaIntelligenceReportOcrTranscript>;
};

export type MediaIntelligenceReportSignal = {
  id: string;
  signalType: string;
  materialId: string | null;
  /** Bounded display label — typically the material's filename or
   *  the safe label projected by the caller. Bounded length. */
  materialLabel: string | null;
  severity: "INFO" | "REVIEW_RECOMMENDED" | "ATTENTION";
  confidence: "LOW" | "MEDIUM" | "HIGH";
  safeSummary: string;
  status: "PENDING" | "ACKNOWLEDGED" | "DISMISSED";
  createdAtUtc: string;
};

export type MediaIntelligenceReportThumbnail = {
  materialId: string;
  /** Inline data URL — `data:image/...;base64,...`. Bounded
   *  upstream so the report PDF stays compact. */
  dataUrl: string;
  /** Operator-readable kind: image_thumbnail / video_frame /
   *  audio_waveform / low_res_proxy. */
  assetKind: string;
};

export type MediaIntelligenceReportOcrTranscript = {
  materialId: string;
  ocrAvailable: boolean;
  transcriptAvailable: boolean;
  ocrIndexed: boolean;
  transcriptIndexed: boolean;
};

export type Tone = TrustDecisionTone;
export type ReportTrustVerdict = TrustDecisionVerdict;
export type ReportTrustLevel = TrustDecision["level"];
export type ReportTrustSignal = TrustSignal;
export type ReportTrustSignalStatus = TrustSignalStatus;
export type ReportTrustDecision = TrustDecision;

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
  trustDecision: ReportTrustDecision;
  anchorSummary: ReportAnchorSummary | null;
  verificationPackageIntegrity: {
  available: boolean;
  version: number | null;
  generatedAtUtc: string | null;
  // Phase D Blocker 3 — per-component flags can be:
  //   true  — present (verified from package metadata)
  //   false — explicitly absent OR no package generated
  //   null  — legacy package without per-component metadata; component
  //           presence is unknown to the report layer.
  // Renderers MUST NOT show null as success; conservative wording belongs
  // alongside componentPresenceNote.
  manifestPresent: boolean | null;
  signedManifestPresent: boolean | null;
  manifestDigestPresent: boolean | null;
  checksumIndexPresent: boolean | null;
  offlineVerifierIncluded: boolean | null;
  auditExportIncluded: boolean | null;
  custodyExportIncluded?: boolean | null;
  accessExportIncluded?: boolean | null;
  componentPresenceSource?:
    | "verification_package_metadata"
    | "legacy_inferred_unknown"
    | "not_generated";
  componentPresenceNote?: string;
};
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
  custodyCounts: {
  displayedForensicEvents: number;
  packageForensicEvents: number;
  accessEvents: number;
  totalPackageEvents: number;
  label: string;
};

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
    tsaInputDigestHex?: string | null;
    tsaInputKind?: string | null;
    otsHash: string | null;
    otsDetail: string | null;
    anchorHash: string | null;
    timestampDigestLabel?: string | null;
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

  /**
   * Phase 31.10 — OPTIONAL bounded media intelligence projection.
   * When `null`, the renderer emits NO new HTML. Same data shape
   * as `ReportV2Input.mediaIntelligence`; carried through from
   * `buildReportViewModel` verbatim.
   */
  mediaIntelligence: MediaIntelligenceReportInput | null;

  meta: {
    hasCoreCrypto: boolean;
    captureContext: {
      statusLabel: string;
      description: string;
      lat: string;
      lng: string;
      accuracyRadius: string;
      capturedAtLabel: string;
      sourceLabel: string;
      legalBoundary: string;
      mapPreviewDataUrl: string;
    } | null;
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
