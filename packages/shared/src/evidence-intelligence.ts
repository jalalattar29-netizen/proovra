export type EvidenceReviewDecisionStatus =
  | "READY_FOR_EXTERNAL_REVIEW"
  | "NEEDS_ATTENTION"
  | "RESTRICTED";

export type EvidenceReviewDecisionTone =
  | "success"
  | "warning"
  | "danger"
  | "neutral";

export type EvidenceReviewDecision = {
  status: EvidenceReviewDecisionStatus;
  label: string;
  summary: string;
  reasons: string[];
  nextActions: string[];
  tone: EvidenceReviewDecisionTone;
};

export type EvidenceVerificationProof = {
  hashMatch: "MATCH" | "MISMATCH" | "NOT_CHECKED" | "UNKNOWN";
  sha256Recorded: boolean;
  signatureStatus: "APPLIED" | "MISSING" | "UNKNOWN";
  tsaStatus: "RECORDED" | "PENDING" | "FAILED" | "UNKNOWN";
  otsStatus: "ANCHORED" | "PENDING" | "FAILED" | "DISABLED" | "UNKNOWN";
};

export type EvidenceArtifactSummary = {
  available: boolean;
  label: string;
  version: string | null;
  generatedAtUtc: string | null;
  generatedByLabel: string;
  downloadCount: number | null;
  lastDownloadedAtUtc: string | null;
  offlineVerificationIncluded: boolean | null;
};

export type EvidenceArtifactCollection = {
  report: EvidenceArtifactSummary;
  verificationPackage: EvidenceArtifactSummary;
  verificationProofArtifacts: EvidenceArtifactSummary;
};

export type EvidenceAccessActivityRecentEvent = {
  eventType: string;
  label: string;
  timestampUtc: string;
  actorLabel: string;
  source: "USER" | "SYSTEM" | "PUBLIC_VERIFY" | "API" | "UNKNOWN";
  tone: "success" | "warning" | "danger" | "neutral";
  description: string;
};

export type EvidenceAccessActivitySummary = {
  publicVerifyViews: number | null;
  reportDownloads: number | null;
  verificationPackageDownloads: number | null;
  originalDownloads: number | null;
  lastViewedAtUtc: string | null;
  lastDownloadedAtUtc: string | null;
  recentEvents: EvidenceAccessActivityRecentEvent[];
};

export type EvidenceReviewerAlert = {
  severity: "info" | "warning" | "danger";
  label: string;
  detail: string;
};

export type EvidenceLibraryIntelligenceSummary = {
  label: string;
  score: number | null;
  description: string;
};

export function buildEvidenceLibraryIntelligenceSummary(score: number | null): EvidenceLibraryIntelligenceSummary {
  const normalizedScore = score === null ? null : Math.max(0, Math.min(100, score));
  const description =
    normalizedScore === null
      ? "Scored from custody integrity, artifact availability, and verification readiness."
      : normalizedScore >= 80
        ? "High confidence for review."
        : normalizedScore >= 50
          ? "Moderate confidence; review gaps remain."
          : "Additional validation is recommended.";

  return {
    label: "Evidence readiness score",
    score: normalizedScore,
    description,
  };
}

export type EvidenceIntelligencePreservationSummary = {
  locked: boolean;
  archived: boolean;
  deleted: boolean;
  deleteScheduledForUtc: string | null;
  retentionUntilUtc: string | null;
  storageProtection:
    | {
        immutable: boolean;
        mode: string | null;
        retainUntil: string | null;
        legalHold: string | null;
        region: string | null;
        verified: boolean;
      }
    | null;
  publicVerificationEnabled: boolean;
  publicVerificationActive: boolean;
};

export type EvidenceIntelligenceProvenanceSummary = {
  captureMethod: string | null;
  identityLevelSnapshot: string | null;
  submittedByEmail: string | null;
  submittedByAuthProvider: string | null;
  createdByUserId: string | null;
  uploadedByUserId: string | null;
  workspaceName: string | null;
  organizationName: string | null;
  organizationVerified: boolean | null;
};

export type EvidenceIntelligenceCustodySummary = {
  createdAt: string;
  uploadedAtUtc: string | null;
  lastAccessedAtUtc: string | null;
  lastVerifiedAtUtc: string | null;
  recordedIntegrityVerifiedAtUtc: string | null;
  firstEventAtUtc: string | null;
  latestEventAtUtc: string | null;
};

export type EvidenceIntelligenceAnchorSummary = {
  provider: string | null;
  mode: string;
  configured: boolean;
  anchorHash: string | null;
  anchoredAtUtc: string | null;
};

export type EvidenceIntelligenceEventSummary = {
  total: number;
  access: number;
  forensic: number;
  chainIntegrity: {
    valid: boolean;
    mode: string;
    reason: string | null;
  };
};

export type EvidenceIntelligence = {
  recordId: string;
  status: {
    evidence: string;
    verificationStatus: string | null;
    signedAtUtc: string | null;
    reportReady: boolean;
    verificationPackageReady: boolean;
  };
  preservation: EvidenceIntelligencePreservationSummary;
  provenance: EvidenceIntelligenceProvenanceSummary;
  custody: EvidenceIntelligenceCustodySummary;
  events: EvidenceIntelligenceEventSummary;
  anchor: EvidenceIntelligenceAnchorSummary;
  reviewerDecision: EvidenceReviewDecision;
  verificationProof: EvidenceVerificationProof;
  accessActivity: EvidenceAccessActivitySummary;
  reviewerAlerts: EvidenceReviewerAlert[];
  custodyTimeline: EvidenceAccessActivityRecentEvent[];
  artifacts: EvidenceArtifactCollection;
  librarySummary: EvidenceLibraryIntelligenceSummary;
};
