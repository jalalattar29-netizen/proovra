/**
 * Phase 32.8C — Command Center frontend types.
 *
 * Mirrors the envelope returned by `/v1/dashboard/command-center`.
 * Kept narrow on purpose — the renderer should not invent fields
 * the backend does not provide.
 */

export type SectionStatus =
  | "ok"
  | "degraded"
  | "unavailable"
  | "not_applicable";

export type WorkspaceScope = "PERSONAL" | "TEAM";

export type AttentionItem = {
  id: string;
  category:
    | "evidence_pending_review"
    | "evidence_unsigned"
    | "report_blocked"
    | "report_failed"
    | "reviewer_escalation"
    | "governance_hold"
    | "retention_candidate"
    | "ops_incident";
  severity: "info" | "warning" | "high" | "critical";
  title: string;
  subtitle: string | null;
  href: string;
  occurredAt: string | null;
};

export type RecentEvidenceItem = {
  id: string;
  title: string;
  status: string;
  verificationStatus: string | null;
  createdAt: string;
  caseId: string | null;
};

export type IncidentItem = {
  id: string;
  category: string;
  severity: string;
  status: string;
  title: string;
  safeSummary: string;
  runbookSlug: string | null;
  lastSeenAtUtc: string;
};

export type CommandCenterEnvelope = {
  generatedAt: string;
  workspace: {
    id: string;
    role: string;
    scope: WorkspaceScope;
    memberCount: number;
  };
  sections: {
    summary: {
      status: SectionStatus;
      data: {
        evidenceActiveCount: number;
        evidenceRecentCount: number;
        reportReadyCount: number;
        reviewerPendingCount: number;
        governanceAttentionCount: number;
        openIncidentsCount: number;
      } | null;
    };
    attentionQueue: {
      status: SectionStatus;
      items: AttentionItem[];
    };
    recentEvidence: {
      status: SectionStatus;
      items: RecentEvidenceItem[];
    };
    pipeline: {
      status: SectionStatus;
      data: {
        reported: number;
        signed: number;
        uploaded: number;
        uploading: number;
        created: number;
      } | null;
    };
    reviewerWorkload: {
      status: SectionStatus;
      data: {
        queuedCount: number;
        assignedCount: number;
        inReviewCount: number;
        overdueCount: number;
        openEscalationsCount: number;
      } | null;
    };
    governancePosture: {
      status: SectionStatus;
      data: {
        activeLegalHoldsCount: number;
        activeCaseLegalHoldsCount: number;
        retentionCandidatesCount: number;
        pendingDestructionReviewsCount: number;
        activePoliciesCount: number;
        policyConflictsCount: number;
      } | null;
    };
    incidents: {
      status: SectionStatus;
      items: IncidentItem[];
    };
  };
};
