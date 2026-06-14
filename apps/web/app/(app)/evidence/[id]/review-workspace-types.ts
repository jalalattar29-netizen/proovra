import type { EvidenceIntelligence, TrustDecision } from "@proovra/shared";
import type {
  EvidenceAnnotation,
  EvidenceAiCategorization,
  EvidenceComparisonResponse,
  EvidenceContentItem,
  EvidenceContentSummary,
  EvidencePart,
  EvidenceRecord,
  EvidenceDuplicatesResponse,
  LegalNote,
  ReviewerComment,
  StorageProtectionSummary,
} from "../lib/evidence-library-types";

export type ReviewerAlert = {
  severity: "info" | "warning" | "danger";
  label: string;
  detail: string;
};

export type WorkspaceCapabilitySnapshot = {
  workspaceType: "PERSONAL" | "TEAM";
  workspaceName: string;
  plan: string;
  effectivePlan?: string | null;
  reportsIncluded: boolean;
  verificationPackageIncluded: boolean;
  publicVerifyIncluded: boolean;
  billingStatus: string | null;
  storageUsedLabel: string | null;
  storageLimitLabel: string | null;
  storageRemainingLabel: string | null;
  seatsIncluded: number | null;
  seatsUsed: number | null;
  seatsRemaining: number | null;
  overSeatLimit: boolean | null;
  // Phase DISCUSSION-CAPABILITY-FIX — backend-computed capability
  // flags that gate the Discussion tab on Evidence Detail. The
  // frontend MUST consume these directly and must NOT infer
  // visibility from workspaceType, teamId, or active member counts.
  // See services/api/src/routes/evidence.routes.ts
  // `computeDiscussionCapability` for the source-of-truth rule.
  discussionEnabled: boolean;
  discussionReadOnly: boolean;
};

export type ClientSignalCollectionState =
  | "NOT_COLLECTED"
  | "COLLECTED_FALSE"
  | "DETECTED"
  | "UNAVAILABLE";

export type PublicVerificationDetailState =
  | "NOT_INCLUDED"
  | "NOT_CONFIGURED"
  | "CONFIGURED_NOT_PUBLISHED"
  | "PUBLISHED"
  | "SUSPENDED"
  | "UNPUBLISHED"
  | "UNKNOWN_ERROR";

export type SourceContext = {
  sourceType: "native_capture" | "imported_upload" | "folder_upload" | "unknown";
  captureMethod: string | null;
  captureMethodLabel: string;
  importedUpload: boolean;
  nativeCapture: boolean;
  folderUpload: boolean;
  deviceTimeIso: string | null;
  capturedAtUtc: string | null;
  uploadedAtUtc: string | null;
  createdAt: string;
  locationIncluded: boolean;
  sourceLabels: string[];
  clientSignalsSummary: {
    screenshotLike: boolean;
    screenshotLikeStatus: ClientSignalCollectionState;
    genericMime: boolean;
    oldLastModified: boolean;
    folderPathPresent: boolean;
    folderPathStatus: ClientSignalCollectionState;
    duplicateSignals: string[];
  };
  metadataAvailability: {
    nativeMetadataRecorded: boolean;
    captureLocationRecorded: boolean;
    clientSignalsRecorded: boolean;
  };
  limitations: string[];
};

export type ReviewDecision = {
  status: string;
  label: string;
  summary: string;
  issues: string[];
  nextActions: string[];
};

export type ReviewWorkspaceEvidenceContentItem = EvidenceContentItem & {
  privateNote?: string | null;
};

export type PreservationMatrix = {
  verificationStatus: string | null;
  verificationStatusLabel: string;
  recordedIntegrityVerifiedAtUtc: string | null;
  sha256Recorded: boolean;
  fingerprintHashRecorded: boolean;
  signature: {
    recorded: boolean;
    valid: boolean;
    keyId: string | null;
    keyVersion: number | null;
  };
  tsa: {
    status: string | null;
    provider: string | null;
    timestampAvailable: boolean;
    digestMatchesTimestampInput: boolean | null;
    digestCheckConclusive: boolean;
    genTimeUtc: string | null;
    failureReason: string | null;
    timestampedDigestLabel: string;
  };
  ots: {
    status: string | null;
    effectiveStatus: string | null;
    proofPresent: boolean;
    hashMatches: boolean | null;
    anchoredAtUtc: string | null;
    upgradedAtUtc: string | null;
    lastUpdatedAtUtc: string | null;
    calendar: string | null;
    bitcoinTxid: string | null;
    failureReason: string | null;
    pendingReason: string | null;
  };
  custodyChain: {
    valid: boolean;
    mode: string;
    reason: string | null;
  };
  storage: StorageProtectionSummary;
  anchor: EvidenceRecord["anchor"];
  report: {
    available: boolean;
    version: number | null;
    generatedAtUtc: string | null;
    reviewerSummaryVersion: number | null;
    verificationPackageVersion: number | null;
    pending: boolean;
    pdfSignature: {
      status:
        | "SIGNED"
        | "UNSIGNED_OPT_OUT"
        | "SIGNING_UNAVAILABLE"
        | "SIGNING_FAILED"
        | "NOT_APPLICABLE";
      signedAtUtc: string | null;
      signerKeyId: string | null;
      warning: string | null;
    } | null;
  };
  verificationPackage: {
    available: boolean;
    version: number | null;
    generatedAtUtc: string | null;
    packageType: string | null;
    pending: boolean;
    unavailable: boolean;
    unavailableReason: string | null;
    blocked: boolean;
    blockedOutcome: string | null;
    blockedReason: string | null;
    blockedAtUtc: string | null;
    manifestSignature: {
      status: "SIGNED" | "UNSIGNED" | "NOT_APPLICABLE";
      signerKeyId: string | null;
    } | null;
    manifestPresent: boolean;
    signedManifestPresent: boolean;
    manifestDigestPresent: boolean;
    checksumIndexPresent: boolean;
    offlineVerifierIncluded: boolean;
    auditExportIncluded: boolean;
    custodyExportIncluded: boolean;
    accessExportIncluded: boolean;
  };
};

export type TimelineEvent = {
  sequence: number;
  atUtc: string;
  eventType: string;
  payloadSummary: string;
  prevEventHash: string | null;
  eventHash: string | null;
  category: "forensic" | "access";
};

export type ReviewWorkspaceResponse = {
  evidence: EvidenceRecord & {
    contentItems?: ReviewWorkspaceEvidenceContentItem[] | null;
    contentSummary?: EvidenceContentSummary | null;
    evidenceIntelligence?: EvidenceIntelligence | null;
  };
  workspaceCapabilitySnapshot: WorkspaceCapabilitySnapshot;
  sourceContext: SourceContext;
  reviewDecision: ReviewDecision;
  reviewerAlerts: ReviewerAlert[];
  custodyLifecycle: {
    forensicEventCount: number;
    accessEventCount: number;
    forensicEvents: TimelineEvent[];
    accessEvents: TimelineEvent[];
    chronologyNote: string;
  };
  custodyDisplayCounts: {
    forensicAtReportGeneration: number;
    currentForensicEvents: number;
    accessAfterReportGeneration: number;
    currentAccessEvents: number;
    reportGeneratedAtUtc: string | null;
  };
  sourceCaptureLocation: {
    statusLabel: string;
    description: string;
    lat: number | null;
    lng: number | null;
    accuracyMeters: number | null;
    capturedAtUtc: string;
    deviceTimeIso: string | null;
    source: string;
    externalMapUrl: string | null;
    legalBoundary: string;
  } | null;
  preservationMatrix: PreservationMatrix;
  relationships: {
    caseId: string | null;
    caseName: string | null;
    relatedEvidenceCount: number | null;
    multipart: boolean;
    itemCount: number;
    note: string | null;
    items: Array<{
      id: string;
      relationshipType: string;
      note: string | null;
      direction: "outbound" | "inbound";
      createdAt: string;
      updatedAt: string;
      linkedEvidence: {
        id: string;
        title: string;
        status: string;
        caseId: string | null;
        teamId: string | null;
      };
      createdBy: {
        id: string;
        email: string | null;
        displayName: string | null;
      } | null;
    }>;
  };
  reviewWorkflow: {
    available: boolean;
    id?: string;
    evidenceId?: string;
    workspaceType?: string;
    teamId?: string | null;
    status: string | null;
    priority: string | null;
    assignedTo:
      | {
          id: string;
          email: string | null;
          displayName: string | null;
        }
      | null;
    assignedBy?:
      | {
          id: string;
          email: string | null;
          displayName: string | null;
        }
      | null;
    dueAt: string | null;
    lastReviewedAt: string | null;
    closedAt?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
    note: string | null;
  };
  classification: {
    evidenceType: string;
    evidenceTypeLabel: string;
    captureMethod: string | null;
    captureMethodLabel: string;
    intakeTemplate: unknown;
    workspaceType: string;
    workspaceName: string;
    matterType: string | null;
  };
  integrityDrift: {
    available: boolean;
    reportGeneratedAtUtc: string | null;
    reportVersion: number | null;
    titleDiffersFromReportSnapshot: boolean;
    itemCountDiffersFromReportSnapshot: boolean;
    postReportForensicEvents: number;
    postReportAccessEvents: number;
    note: string;
  };
  snapshot: {
    reportGeneratedAtUtc: string | null;
    reportVersion: number | null;
    verificationPackageGeneratedAtUtc: string | null;
    verificationPackageVersion: number | null;
    currentStatus: string;
    statusAtReportGeneration: string | null;
    fixedArtifactNote: string;
  };
  publicVerificationSummary: {
    state: PublicVerificationDetailState;
    publicationState: string | null;
    enabled: boolean;
    configured: boolean;
    published: boolean;
    sharePath: string | null;
    publicUrl: string | null;
    routeAccessible: boolean;
    publicViewCount: number;
    authenticatedViewCount: number;
    lastPublicViewAt: string | null;
    reportDownloadCount: number;
    verificationPackageDownloadCount: number;
    analyticsAvailable: boolean;
    disabledReason: string | null;
  };
  artifactStatus: {
    evidenceId: string;
    status: string | null;
    finalized: boolean;
    report:
      | {
          available: true;
          version: number;
          generatedAtUtc: string;
          reviewerSummaryVersion: number | null;
          verificationPackageVersion: number | null;
          pending: false;
          pdfSignature: NonNullable<PreservationMatrix["report"]["pdfSignature"]>;
        }
      | {
          available: false;
          version: null;
          generatedAtUtc: null;
          reviewerSummaryVersion: null;
          verificationPackageVersion: null;
          pending: boolean;
          pdfSignature: null;
        };
    verificationPackage:
      | {
          available: true;
          version: number;
          generatedAtUtc: string;
          packageType: string | null;
          pending: false;
          unavailable: false;
          unavailableReason: null;
          blocked: false;
          blockedOutcome: null;
          blockedReason: null;
          blockedAtUtc: null;
          manifestSignature: NonNullable<
            PreservationMatrix["verificationPackage"]["manifestSignature"]
          >;
        }
      | {
          available: false;
          version: null;
          generatedAtUtc: null;
          packageType: null;
          pending: boolean;
          unavailable: boolean;
          unavailableReason: string | null;
          blocked: boolean;
          blockedOutcome: string | null;
          blockedReason: string | null;
          blockedAtUtc: string | null;
          manifestSignature: null;
        };
  };
  artifactVersions: {
    history?: {
      reports: Array<{
        id: string;
        version: number;
        generatedAtUtc: string;
        storageKey: string | null;
        sizeBytes: string | null;
        immutableRecorded: boolean;
        latest: boolean;
      }>;
      verificationPackages: Array<{
        id: string;
        version: number;
        generatedAtUtc: string;
        packageType: string | null;
        storageKey: string | null;
        sizeBytes: string | null;
        immutableRecorded: boolean;
        latest: boolean;
      }>;
    };
    latestReport: {
      available: boolean;
      version: number | null;
      generatedAtUtc: string | null;
    };
    latestVerificationPackage: {
      available: boolean;
      version: number | null;
      packageType: string | null;
      generatedAtUtc: string | null;
    };
    technicalMaterials: Record<string, unknown>;
    trustDecision: TrustDecision | null;
    trustDecisionConsistency: {
      source: string;
      consistentWithSnapshot: boolean | null;
      tone?: "neutral" | "info" | "warning" | "danger" | null;
      accessOnly?: boolean | null;
      integrityCritical?: boolean | null;
      reasons?: Array<{
        code?: string | null;
        label?: string | null;
        detail?: string | null;
        tone?: "info" | "warning" | "danger" | null;
        integrityCritical?: boolean | null;
      }>;
    };
  };
  governance?: {
    reviewerComments: ReviewGovernanceItem;
    legalNotes: ReviewGovernanceItem;
    annotations: ReviewGovernanceItem;
    aiCategorization: ReviewGovernanceItem;
  };
  reviewerAudit?: Array<{
    id: string;
    eventType: string;
    metadata: Record<string, unknown> | null;
    createdAt: string;
    actor:
      | {
          id: string;
          email: string | null;
          displayName: string | null;
        }
      | null;
  }>;
  parts: EvidencePart[];
  legalBoundary: string;
};

export type ReviewGovernanceItem = {
  label: string;
  publicVerifyIncluded: boolean;
  reportIncluded: boolean;
  verificationPackageIncluded: boolean;
  reviewerOnly: boolean;
};

export type LazyReviewData = {
  comments?: ReviewerComment[];
  legalNotes?: LegalNote[];
  annotations?: EvidenceAnnotation[];
  comparison?: EvidenceComparisonResponse | null;
  duplicates?: EvidenceDuplicatesResponse | null;
  aiCategorization?: EvidenceAiCategorization | null;
};
