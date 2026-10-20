import type { OtsAnchoringView, TrustDecision, TrustSignal } from "@proovra/shared";
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
  /** ET-PKG-06 — RECORDED at sealing, or OBSERVED on the stored object. */
  source?: "RECORDED" | "OBSERVED" | null;
  expired?: boolean | null;
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
  /** (2026-10-20, AUD-17) VALIDATED_TOKEN | CLAIMED_BY_UNVALIDATED_TOKEN | null. */
  tokenClaimsBasis?: string | null;
  hashAlgorithm?: string | null;
  failureReason?: string | null;
  digestMatchesTimestampInput?: boolean | null;
  digestMatchesFileHash?: boolean | null;
  timestampedDigestLabel?: string | null;
  timestampedDigestNote?: string | null;
  digestCheckConclusive?: boolean | null;
  timestampAvailable?: boolean | null;
} | null;

/**
 * `storageAndTimestamping.ots` (2026-10-13): exactly the server's
 * OtsAnchoringView plus operational siblings. Read it ONLY through
 * `readOtsAnchoringView` — the state is the server's, never re-derived here.
 */
export type VerifyOts = (Partial<OtsAnchoringView> & {
  calendar?: string | null;
  proofPresent?: boolean | null;
  lastUpdatedAtUtc?: string | null;
  recheckAvailable?: boolean | null;
}) | null;

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
  configured?: boolean | null;
  anchorHash?: string | null;
  transactionId?: string | null;
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
  | "failed"
  | "not_applicable";

export type TrustDecisionTone = "success" | "warning" | "danger" | "neutral";

/**
 * A trust signal and the record's signal summary, in the 2026-10-08
 * score-free shape (@proovra/shared TrustSignal / TrustDecision). There is no
 * score, weighted point, verdict, reliance level or confidence label: any such
 * field an older API still sends is dropped by readStoredTrustDecision before
 * the page sees the object.
 */
export type VerifyTrustSignal = TrustSignal;
export type VerifyTrustDecision = TrustDecision;

/** The server's verification-status vocabulary (packages/shared VERIFICATION_STATUSES). */
export type VerifyStatusCode = "VERIFIED" | "FAILED" | "NOT_CHECKED" | "NOT_APPLICABLE" | "UNAVAILABLE";

/**
 * THE package card's facts, exactly as the API sent them
 * (resolvePackageSealCheck). The card prints sealCheck / sealStatement /
 * completenessCheck / completenessStatement verbatim — the same authority the
 * matrix's package_signature / package_completeness rows print.
 */
export type VerificationPackageIntegrity = {
  available: boolean;
  /** The matrix's package_signature status — the card never contradicts it. */
  sealCheck?: VerifyStatusCode;
  sealStatement?: string | null;
  sealQualifiers?: string[] | null;
  completenessCheck?: VerifyStatusCode;
  completenessStatement?: string | null;
  version: string | number | null;
  generatedAtUtc: string | null;
  packageType?: string | null;
  manifestPresent: boolean;
  signedManifestPresent: boolean;
  manifestDigestPresent: boolean;
  checksumIndexPresent: boolean;
  auditExportIncluded: boolean;
  custodyExportIncluded: boolean;
  accessExportIncluded: boolean;
  /** ET-PKG-05 — format 5 with a verified seal; a legacy package is not sealed. */
  packageFormatVersion?: number | null;
  sealed?: boolean;
};

// PHASE 12 — VerifyLifecycleTransparency REMOVED: the /public/verify/:id/lifecycle
// endpoint never existed server-side (Phase-4B I3 shipped frontend-only; the
// fetch failed silently on every load). The panel returns WITH its backend in
// the lifecycle-truth program (P5–P11).
export type VerifySnapshotSection = {
  source?:
    | "REPORT_SNAPSHOT"
    | "VERIFICATION_PACKAGE_SNAPSHOT"
    | "LIVE_SHARED_FALLBACK"
    | "UNAVAILABLE"
    | null;
  generatedAtUtc?: string | null;
  reportVersion?: number | null;
  packageVersion?: number | null;
  /** Read ONLY through readStoredTrustDecision: an old snapshot may carry a score. */
  trustDecisionSnapshot?: unknown;
  /** The Bitcoin anchoring state at generation (an OtsState); unknown reads as Unavailable. */
  otsStatusAtGeneration?: string | null;
  /** The OpenTimestamps verification key at generation (an OtsVerificationKey). */
  otsVerificationAtGeneration?: string | null;
  reportSignature?: {
    status?: string | null;
    signedAtUtc?: string | null;
  } | null;
  verificationPackageSignature?: {
    manifestPresent?: boolean | null;
    manifestSigned?: boolean | null;
    packageType?: string | null;
  } | null;
} | null;

/**
 * The live anchoring section's operational facts. Its Bitcoin anchoring state,
 * block height, txid and recording time are read from the current
 * `storageAndTimestamping.ots` view, never from these fields.
 */
export type VerifyLiveAnchoring = {
  lastUpdatedAtUtc?: string | null;
  hasAdvancedSinceSnapshot?: boolean | null;
  /** What advanced since the issued artifact (otsAdvanceSinceIssue); NONE / null: nothing. */
  advance?: "NONE" | "PENDING_SINCE_ISSUE" | "ATTESTATION_RECORDED_SINCE_ISSUE" | "CHAIN_VERIFIED_SINCE_ISSUE" | null;
  newerReportAvailable?: boolean | null;
  newerPackageAvailable?: boolean | null;
  autoRefreshRecommended?: boolean | null;
} | null;

/** THE record's facts (2026-10-18 contract): the page states them, never derives them. */
export type VerifyRecordFacts = {
  verificationReference?: string | null;
  recordKindLabel?: string | null;
  itemCount?: number | null;
  reportIssuedAtUtc?: string | null;
  reportVersion?: number | null;
  storedFileLastRecheckedAtUtc?: string | null;
  storedFileRecheck?: VerifyStatusCode | null;
  checkedAtUtc?: string | null;
  identity?: {
    disclosure?: "WITHHELD" | "SHOWN" | null;
    statement?: string | null;
    captureTime?: {
      basis?: string | null;
      basisLabel?: string | null;
      accountLabel?: string | null;
      workspaceTypeLabel?: string | null;
      organizationVerificationLabel?: string | null;
    } | null;
    atReportTime?: {
      reportVersion?: number | null;
      identityLevel?: string | null;
      authProvider?: string | null;
    } | null;
  } | null;
};

/** THE disclosure decision the API applied (vocabulary: @proovra/shared verification-disclosure). */
export type VerifyDisclosure = {
  mode?: "VERIFICATION_ONLY" | "CONTENT_PREVIEW" | null;
  recordedLocation?: boolean | null;
  source?: string | null;
  originalDownload?: boolean | null;
  withheldStatement?: string | null;
};

export type VerifyVersioning = {
  latestReportVersion?: number | null;
  latestReportGeneratedAtUtc?: string | null;
  verificationPackageVersion?: number | null;
  verificationPackageGeneratedAtUtc?: string | null;
  reviewerSummaryVersion?: number | null;
};

export type VerifyConsistencyReason = {
  code?: string | null;
  label?: string | null;
  detail?: string | null;
  tone?: "info" | "warning" | "danger" | null;
  integrityCritical?: boolean | null;
};

export type VerifyResponse = {
  recordFacts?: VerifyRecordFacts | null;
  disclosure?: VerifyDisclosure | null;
  versioning?: VerifyVersioning | null;
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
  /**
   * The raw wire value. Read ONLY through readStoredTrustDecision: an API
   * deployed before 2026-10-08 still sends score/verdict/reliance fields.
   */
  trustDecision?: unknown;
  /**
   * THE per-signal verification matrix (2026-10-08), read through
   * parseVerificationMatrix. Absent from an API deployed before it; the page
   * then derives the signal rows from the trust decision's own signals.
   */
  verificationMatrix?: unknown;
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
  verificationSnapshot?: VerifySnapshotSection;
  liveAnchoring?: VerifyLiveAnchoring;
  /**
   * Phase 2 canonical OutputContext shape. The public verify endpoint
   * is a PUBLIC_VERIFY_LIVE output; this carries the snapshot vs live
   * semantics that the hero card and live-delta affordances render.
   */
  outputContext?: {
    outputType:
      | "REPORT_SNAPSHOT"
      | "VERIFICATION_PACKAGE_SNAPSHOT"
      | "PUBLIC_VERIFY_LIVE"
      | "INTERNAL_OPERATIONAL_PROJECTION"
      | "OFFLINE_PACKAGE_REVIEW";
    isSnapshotOutput: boolean;
    isLiveOutput: boolean;
    snapshotGeneratedAtUtc?: string | null;
    liveObservedAtUtc?: string | null;
    liveDeltaMaterials?: ReadonlyArray<string>;
    legalBoundary?: string;
  } | null;
  /**
   * Phase 0 audit field — which artifact actually sourced the verdict.
   * Already emitted by services/api/src/routes/evidence.routes.ts.
   */
  trustDecisionSource?:
    | "LIVE_VERIFICATION"
    | "REPORT_SNAPSHOT"
    | "VERIFICATION_PACKAGE_SNAPSHOT"
    | "LIVE_SHARED_FALLBACK"
    | "UNAVAILABLE"
    | null;
  trustDecisionSnapshot?: {
    reportVersion?: number | null;
    reportGeneratedAtUtc?: string | null;
    verificationPackageVersion?: number | null;
    verificationPackageGeneratedAtUtc?: string | null;
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
    /** Access activity is aggregated by the API — never listed (2026-10-18). */
    accessActivity?: { count?: number | null; latestAtUtc?: string | null } | null;
    /** ET-CUS-13: the lists are the LATEST events; counts are whole-chain. */
    truncated?: boolean | null;
    displayLimit?: number | null;
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
