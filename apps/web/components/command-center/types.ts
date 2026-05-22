/**
 * Phase 32.8C (Full Rebuild) — Command Center frontend types.
 *
 * Mirrors the envelope returned by `/v1/dashboard/command-center`.
 * The frontend never invents fields the backend does not provide.
 */

export type SectionStatus =
  | "ok"
  | "degraded"
  | "unavailable"
  | "not_applicable";

export type WorkspaceScope = "PERSONAL" | "TEAM";

export type SeverityTone = "info" | "warning" | "high" | "critical";

export type OperationalPressureItem = {
  id: string;
  category:
    | "overdue_review"
    | "stalled_review"
    | "unassigned_review"
    | "open_escalation"
    | "stuck_upload"
    | "missing_report"
    | "missing_package"
    | "failed_report"
    | "failed_package"
    | "retry_storm"
    | "governance_conflict"
    | "policy_conflict"
    | "evidence_no_case"
    | "unsigned_evidence_old"
    | "blocked_export"
    | "operational_incident";
  severity: SeverityTone;
  title: string;
  subtitle: string | null;
  href: string;
  occurredAt: string | null;
};

export type CaseOperationsItem = {
  caseId: string;
  caseName: string;
  evidenceCount: number;
  unreviewedCount: number;
  overdueReviewCount: number;
  openEscalationsCount: number;
  hasActiveLegalHold: boolean;
  lastActivityAtUtc: string | null;
};

export type ReviewerOrchestrationRow = {
  userId: string;
  displayName: string | null;
  email: string | null;
  assignedCount: number;
  overdueCount: number;
  dueSoonCount: number;
  lastActionAtUtc: string | null;
  inactive: boolean;
};

export type PipelineDetail = {
  evidence: {
    created: number;
    uploading: number;
    uploaded: number;
    signed: number;
    reported: number;
    stuckUploading: number;
  };
  reports: {
    ready: number;
    queued: number;
    failed: number;
    missingFromSigned: number;
  };
  packages: {
    ready: number;
    queued: number;
    blocked: number;
    failed: number;
    missingFromReported: number;
  };
  publicVerify: {
    published: number;
    unpublished: number;
    suspended: number;
  };
};

export type TimelineEvent = {
  id: string;
  kind:
    | "evidence_finalized"
    | "report_generated"
    | "package_generated"
    | "lifecycle_transition"
    | "hold_placed"
    | "hold_released"
    | "destruction_review"
    | "escalation_opened"
    | "incident_opened"
    | "workspace_activity";
  occurredAt: string;
  label: string;
  subtitle: string | null;
  href: string | null;
  severity: SeverityTone;
};

export type AuditReadinessCounter = {
  key:
    | "unsigned_evidence_old"
    | "incomplete_custody_chains"
    | "missing_reports"
    | "failed_packages"
    | "pending_governance_reviews"
    | "unresolved_escalations"
    | "evidence_pending_reviewer_signoff"
    | "blocked_exports";
  label: string;
  value: number;
  severity: SeverityTone;
};

export type AttentionItem = OperationalPressureItem;

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
  occurrenceCount: number;
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
        operationalPressureCount: number;
        auditReadinessFlags: number;
      } | null;
    };
    operationalPressure: {
      status: SectionStatus;
      items: OperationalPressureItem[];
      counts: {
        critical: number;
        high: number;
        warning: number;
        info: number;
      };
    };
    attentionQueue: {
      status: SectionStatus;
      items: AttentionItem[];
    };
    caseOperations: {
      status: SectionStatus;
      data: {
        activeCasesCount: number;
        casesWithEvidenceGapsCount: number;
        unreviewedEvidenceCount: number;
        unlinkedEvidenceCount: number;
        topCases: CaseOperationsItem[];
      } | null;
    };
    reviewerOrchestration: {
      status: SectionStatus;
      data: {
        queueDepth: number;
        overdueCount: number;
        dueSoonCount: number;
        unassignedCount: number;
        openEscalationsCount: number;
        completedLast7dCount: number;
        completedPrev7dCount: number;
        inactiveReviewerCount: number;
        topReviewers: ReviewerOrchestrationRow[];
      } | null;
    };
    pipelineDetail: {
      status: SectionStatus;
      data: PipelineDetail | null;
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
        blockedExportsCount: number;
        recentLifecycleEventsCount: number;
      } | null;
    };
    organizationalIntelligence: {
      status: SectionStatus;
      data: {
        evidenceCreatedLast24h: number;
        evidenceCreatedLast7d: number;
        evidenceFinalizedLast7d: number;
        reportsGeneratedLast7d: number;
        packagesGeneratedLast7d: number;
        activityLast7d: number;
      } | null;
    };
    timeline: {
      status: SectionStatus;
      items: TimelineEvent[];
    };
    auditReadiness: {
      status: SectionStatus;
      counters: AuditReadinessCounter[];
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
    incidents: {
      status: SectionStatus;
      items: IncidentItem[];
    };
  };
};
