/**
 * Phase 32.8E — Reviewer Command frontend types.
 *
 * Mirrors the envelope returned by `/v1/reviewer-ops/command`.
 */

export type SectionStatus = "ok" | "degraded" | "unavailable" | "not_applicable";

export type ReviewerCommandEnvelope = {
  generatedAt: string;
  workspace: {
    id: string;
    role: string;
    scope: "PERSONAL" | "TEAM";
  };
  sections: {
    summary: {
      status: SectionStatus;
      data: {
        assignedToMe: number;
        unassigned: number;
        dueSoon: number;
        overdue: number;
        openEscalations: number;
        inReview: number;
      } | null;
    };
    queuePeek: {
      status: SectionStatus;
      items: Array<{
        workflowId: string;
        evidenceId: string;
        status: string;
        priority: string;
        assignedToUserId: string | null;
        dueAt: string | null;
        slaTone: "ok" | "due_soon" | "overdue";
      }>;
    };
    escalations: {
      status: SectionStatus;
      items: Array<{
        id: string;
        workflowId: string;
        evidenceId: string | null;
        severity: string;
        reason: string;
        status: string;
        createdAt: string;
      }>;
    };
    workload: {
      status: SectionStatus;
      reviewers: Array<{
        userId: string;
        displayName: string | null;
        email: string | null;
        assignedCount: number;
        overdueCount: number;
      }>;
    };
    workflowPolicy: {
      status: SectionStatus;
      data: {
        slaPolicySource: "workspace_row" | "default";
        defaultReviewDueHours: number | null;
        defaultFirstResponseDueHours: number | null;
        requireStepUpForApprove: boolean;
        requireStepUpForReject: boolean;
        requireStepUpForBulk: boolean;
        reviewerInactivityHours: number | null;
      } | null;
    };
    reconciliationHealth: {
      status: SectionStatus;
      data: {
        lastWorkflowUpdateAtUtc: string | null;
        oldestQueuedAtUtc: string | null;
      } | null;
    };
  };
};
