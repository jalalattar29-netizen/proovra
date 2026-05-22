/**
 * Phase 32.8D — Cases experience frontend types.
 *
 * Mirrors the envelopes returned by:
 *   - GET /v1/cases/summary
 *   - GET /v1/cases/:id/workspace
 */

export type SectionStatus = "ok" | "degraded" | "unavailable" | "not_applicable";

export type CaseScope = "PERSONAL" | "TEAM";

export type CaseSummaryItem = {
  id: string;
  name: string;
  scope: CaseScope;
  ownerUserId: string;
  teamId: string | null;
  createdAt: string;
  updatedAt: string;
  linkedEvidenceCount: number;
  hasActiveLegalHold: boolean;
  lastActivityAtUtc: string | null;
  pendingReviewCount: number;
};

export type CasesSummaryEnvelope = {
  generatedAt: string;
  workspace: {
    id: string;
    role: string;
    scope: CaseScope;
    memberCount: number;
  };
  sections: {
    summary: {
      status: SectionStatus;
      data: {
        totalCases: number;
        casesWithEvidence: number;
        casesWithActiveHolds: number;
        casesWithPendingReview: number;
      } | null;
    };
    cases: {
      status: SectionStatus;
      items: CaseSummaryItem[];
    };
  };
};

export type CaseWorkspaceEnvelope = {
  generatedAt: string;
  case: {
    id: string;
    name: string;
    scope: CaseScope;
    ownerUserId: string;
    teamId: string | null;
    createdAt: string;
    updatedAt: string;
    accessCount: number;
  };
  viewer: {
    userId: string;
    role: string;
    canManage: boolean;
  };
  sections: {
    overview: {
      status: SectionStatus;
      data: {
        linkedEvidenceCount: number;
        recentlyLinkedCount: number;
        activeCaseHoldsCount: number;
        affectedEvidenceHoldsCount: number;
        pendingReviewCount: number;
        openEscalationsCount: number;
      } | null;
    };
    evidence: {
      status: SectionStatus;
      items: Array<{
        id: string;
        title: string;
        type: string;
        status: string;
        verificationStatus: string | null;
        createdAt: string;
        reportReady: boolean;
        packageReady: boolean;
      }>;
    };
    preservation: {
      status: SectionStatus;
      data: {
        caseHolds: Array<{
          id: string;
          title: string;
          status: string;
          placedAtUtc: string;
          releasedAtUtc: string | null;
        }>;
        evidenceHolds: Array<{
          id: string;
          evidenceId: string;
          status: string;
          createdAt: string;
        }>;
      } | null;
    };
    reviewCoordination: {
      status: SectionStatus;
      data: {
        queuedCount: number;
        assignedCount: number;
        inReviewCount: number;
        needsInfoCount: number;
        overdueCount: number;
        openEscalationsCount: number;
      } | null;
    };
    timeline: {
      status: SectionStatus;
      items: Array<{
        id: string;
        kind:
          | "case_created"
          | "case_updated"
          | "evidence_linked"
          | "legal_hold_placed"
          | "legal_hold_released";
        occurredAt: string;
        label: string;
        subtitle: string | null;
        href: string | null;
      }>;
    };
    activity: {
      status: SectionStatus;
      items: Array<{
        id: string;
        eventType: string;
        actorUserId: string | null;
        createdAt: string;
        metadata: Record<string, unknown> | null;
      }>;
    };
  };
};
