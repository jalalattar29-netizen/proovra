/**
 * Phase 32.8E — Governance Control Plane frontend types.
 *
 * Mirrors the envelope returned by `/v1/governance/control-plane`.
 */

export type SectionStatus = "ok" | "degraded" | "unavailable" | "not_applicable";

export type GovernanceControlPlaneEnvelope = {
  generatedAt: string;
  workspace: {
    id: string;
    role: string;
    scope: "PERSONAL" | "TEAM";
  };
  sections: {
    posture: {
      status: SectionStatus;
      data: {
        policySource: "workspace_row" | "default";
        activeLegalHoldsCount: number;
        activeCaseLegalHoldsCount: number;
        retentionCandidatesCount: number;
        pendingDestructionReviewsCount: number;
        activePoliciesCount: number;
        policyConflictsCount: number;
        caseLegalHoldsEnabled: boolean;
      } | null;
    };
    preservation: {
      status: SectionStatus;
      data: {
        evidenceHolds: Array<{
          id: string;
          evidenceId: string;
          reason: string | null;
          status: string;
          placedAtUtc: string;
          releasedAtUtc: string | null;
        }>;
        caseHolds: Array<{
          id: string;
          caseId: string;
          title: string;
          status: string;
          placedAtUtc: string;
          releasedAtUtc: string | null;
        }>;
      } | null;
    };
    retention: {
      status: SectionStatus;
      data: {
        candidates: Array<{
          id: string;
          evidenceId: string;
          retentionUntilUtc: string | null;
          createdAt: string;
          status: string;
        }>;
        pendingDestructionReviews: Array<{
          id: string;
          evidenceId: string;
          status: string;
          createdAt: string;
        }>;
      } | null;
    };
    exportGovernance: {
      status: SectionStatus;
      data: {
        recentBlocks: Array<{
          evidenceId: string;
          reason: string;
          outcome: string | null;
          blockedAtUtc: string | null;
        }>;
        gateFlags: {
          allowReportDownload: boolean;
          allowPackageDownload: boolean;
          allowPublicVerify: boolean;
          allowOriginalDownload: boolean;
        };
      } | null;
    };
    policy: {
      status: SectionStatus;
      data: {
        source: "workspace_row" | "default";
        defaultRetentionDays: number | null;
        evidenceDeletionMode: string;
        requireLegalHoldApprovalForDeletion: boolean;
        requireReviewBeforeReport: boolean;
        requireReviewBeforePackage: boolean;
        requireReviewBeforePublicVerify: boolean;
      } | null;
    };
    incidents: {
      status: SectionStatus;
      items: Array<{
        id: string;
        category: string;
        severity: string;
        status: string;
        title: string;
        safeSummary: string;
        runbookSlug: string | null;
        lastSeenAtUtc: string;
      }>;
    };
  };
};
