/**
 * Phase 32.8D — Cases experience frontend types.
 *
 * Mirrors the envelopes returned by:
 *   - GET /v1/cases/summary
 *   - GET /v1/cases/:id/workspace
 */

export type SectionStatus = "ok" | "degraded" | "unavailable" | "not_applicable";

export type CaseScope = "PERSONAL" | "TEAM";

// =============================================================================
// Phase 32.8D — Matter Workspace frontend types.
// Mirrors the backend MatterWorkspaceEnvelope + MatterQueueEnvelope shapes.
// =============================================================================

export type MatterRiskLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type MatterRiskReasonCode =
  | "EVIDENCE_GAP"
  | "INCIDENT_OPEN"
  | "WORKFLOW_OVERDUE"
  | "WORKFLOW_ACTIVE"
  | "INTEGRITY_FAILED"
  | "INTEGRITY_REVIEW_REQUIRED"
  | "GOVERNANCE_BLOCKER"
  | "LEGAL_HOLD_ACTIVE"
  | "REVIEWER_OVERLOAD"
  | "AUDIT_GAP"
  | "PACKAGE_MISSING"
  | "REPORT_MISSING"
  | "CUSTODY_CONCERN";

export type MatterRiskComputation = {
  riskScore: number;
  riskLevel: MatterRiskLevel;
  evidenceGapCount: number;
  openIncidentCount: number;
  activeWorkflowCount: number;
  overdueWorkflowCount: number;
  governanceBlockerCount: number;
  reviewerPressureScore: number;
  auditReadinessScore: number;
  custodyConcernCount: number;
  integrityConcernCount: number;
  packageReportGapCount: number;
  reasonCodes: MatterRiskReasonCode[];
  recommendedAction: string;
};

export type MatterQueueItem = {
  id: string;
  name: string;
  referenceNumber: string | null;
  status: string;
  priority: string;
  ownerUserId: string;
  teamId: string | null;
  createdAt: string;
  updatedAt: string;
  linkedEvidenceCount: number;
  activeAssignmentCount: number;
  openIncidentCount: number;
  activeWorkflowCount: number;
  overdueWorkflowCount: number;
  governanceBlockerCount: number;
  activeLegalHoldCount: number;
  evidenceGapCount: number;
  riskScore: number | null;
  riskLevel: string | null;
  riskReasonCodes: string[];
  recommendedAction: string | null;
  latestActivityAtUtc: string;
};

export type MatterQueueEnvelope = {
  generatedAt: string;
  workspace: { teamId: string; role: string };
  items: MatterQueueItem[];
  total: number;
};

export type MatterWorkspaceCaseHeader = {
  id: string;
  name: string;
  referenceNumber: string | null;
  description: string | null;
  status: string;
  priority: string;
  scope: CaseScope;
  ownerUserId: string;
  teamId: string | null;
  closedAtUtc: string | null;
  closureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MatterWorkspaceEnvelope = {
  generatedAt: string;
  case: MatterWorkspaceCaseHeader;
  viewer: {
    userId: string;
    role: string;
    /**
     * Phase 32.8D-frontend-closure-2 — per-case canonical
     * capability map. Backend computes these via the same helper
     * that backs route guards (`resolveCaseViewerCapabilities`), so
     * the frontend's button-disabled hint and the backend's 403
     * cannot drift.
     */
    canManage: boolean;
    canMutate: boolean;
    canAssign: boolean;
    canChangeStatus: boolean;
    canLinkEvidence: boolean;
    canUnlinkEvidence: boolean;
    canUnlinkLegacyEvidence: boolean;
    canComment: boolean;
    canResolveComment: boolean;
    disabledReasons: Partial<{
      assign: string;
      changeStatus: string;
      linkEvidence: string;
      unlinkEvidence: string;
      unlinkLegacyEvidence: string;
      comment: string;
      resolveComment: string;
    }>;
    activeAssignmentRoles: ReadonlyArray<string>;
  };
  risk: {
    status: SectionStatus;
    data: MatterRiskComputation | null;
    sampledAtUtc: string;
  };
  sections: {
    commandSummary: {
      status: SectionStatus;
      data: {
        linkedEvidenceCount: number;
        recentlyLinkedCount: number;
        activeCaseHoldsCount: number;
        affectedEvidenceHoldsCount: number;
        pendingReviewCount: number;
        openEscalationsCount: number;
        activeAssignmentCount: number;
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
        lifecycleState: string | null;
        createdAt: string;
        reportReady: boolean;
        packageReady: boolean;
        /**
         * Phase 32.8D-frontend-closure — canonical CaseEvidenceLink id.
         * Null when the evidence is attached via the legacy
         * Evidence.caseId column only. The Evidence Board renders a
         * disabled Unlink button in that case.
         */
        linkId: string | null;
        linkRole: string | null;
        linkSource: string | null;
      }>;
    };
    relationships: {
      status: SectionStatus;
      links: Array<{
        id: string;
        evidenceId: string;
        role: string;
        source: string;
        linkedAtUtc: string;
        reason: string | null;
      }>;
      relationships: Array<{
        id: string;
        sourceEvidenceId: string;
        targetEvidenceId: string;
        relationshipType: string;
        createdAt: string;
        note: string | null;
      }>;
      counts: {
        primary: number;
        supporting: number;
        related: number;
        duplicate: number;
        derived: number;
        context: number;
      };
    };
    workflows: {
      status: SectionStatus;
      items: Array<{
        id: string;
        workflowType: string;
        status: string;
        severity: string;
        priority: string;
        title: string;
        safeSummary: string;
        assignedOwnerUserId: string | null;
        escalationLevel: number;
        retryCount: number;
        dueAtUtc: string | null;
        nextRetryAtUtc: string | null;
        createdAt: string;
        updatedAt: string;
      }>;
    };
    incidentsAndCausality: {
      status: SectionStatus;
      incidents: Array<{
        id: string;
        title: string;
        category: string;
        severity: string;
        status: string;
        occurrenceCount: number;
        lastSeenAtUtc: string;
        safeSummary: string;
        relatedEvidenceId: string | null;
      }>;
      chains: Array<{
        id: string;
        chainKey: string;
        title: string;
        summary: string;
        rootCauseType: string;
        severity: string;
        status: string;
        linkedIncidentCount: number;
        linkedWorkflowCount: number;
        startAtUtc: string;
        lastSeenAtUtc: string;
      }>;
    };
    reviewerCoordination: {
      status: SectionStatus;
      data: {
        queuedCount: number;
        assignedCount: number;
        inReviewCount: number;
        needsInfoCount: number;
        overdueCount: number;
        openEscalationsCount: number;
        unresolvedReviewerCommentsCount: number;
        unresolvedAnnotationsCount: number;
      } | null;
      escalations: Array<{
        id: string;
        evidenceId: string;
        severity: string;
        status: string;
        createdAt: string;
      }>;
      reviewerCapacity: Array<{
        reviewerUserId: string;
        saturationLevel: string;
        assignedCount: number;
        overdueCount: number;
        capacityScore: number;
        sampledAtUtc: string;
      }>;
    };
    governance: {
      status: SectionStatus;
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
      governanceWorkflows: Array<{
        id: string;
        workflowType: string;
        status: string;
        severity: string;
        title: string;
        safeSummary: string;
        dueAtUtc: string | null;
      }>;
      auditReadinessScore: number | null;
      blockerCount: number;
    };
    custodyAndIntegrity: {
      status: SectionStatus;
      lifecycleStateCounts: Array<{ lifecycleState: string; count: number }>;
      verificationStatusCounts: Array<{
        verificationStatus: string;
        count: number;
      }>;
      integritySnapshots: Array<{
        evidenceId: string;
        overallStatus: string;
        tsaStatus: string | null;
        otsStatus: string | null;
        reasonCodes: string[];
        computedAtUtc: string;
        tsaParseStatus: string | null;
      }>;
      custodyEventTotals: { eventsLast30d: number };
    };
    timeline: {
      status: SectionStatus;
      items: Array<{
        id: string;
        family: string;
        eventType: string;
        severity: string;
        occurredAtUtc: string;
        summary: string;
        evidenceId: string | null;
        actorUserId: string | null;
        sourceTable: string;
        route: string | null;
      }>;
    };
    notes: {
      status: SectionStatus;
      caseComments: Array<{
        id: string;
        authorUserId: string;
        body: string;
        visibility: string;
        resolvedAtUtc: string | null;
        resolvedByUserId: string | null;
        createdAt: string;
      }>;
      unresolvedReviewerComments: Array<{
        id: string;
        evidenceId: string;
        createdAt: string;
      }>;
      unresolvedAnnotations: Array<{
        id: string;
        evidenceId: string;
        createdAt: string;
      }>;
    };
    deliverables: {
      status: SectionStatus;
      reports: Array<{
        id: string;
        evidenceId: string;
        version: number;
        generatedAtUtc: string | null;
      }>;
      packages: Array<{
        id: string;
        evidenceId: string;
        version: number;
        generatedAtUtc: string | null;
      }>;
      externalReviewLinks: Array<{
        id: string;
        evidenceId: string;
        viewerType: string;
        createdAt: string;
      }>;
      counts: {
        reportsReady: number;
        packagesReady: number;
        deliverablesPending: number;
      };
    };
  };
  assignments: Array<{
    id: string;
    assignedToUserId: string;
    assignedByUserId: string;
    role: string;
    status: string;
    assignedAtUtc: string;
    removedAtUtc: string | null;
    note: string | null;
  }>;
  statusHistory: Array<{
    id: string;
    fromStatus: string | null;
    toStatus: string;
    changedByUserId: string;
    reason: string | null;
    changedAtUtc: string;
  }>;
};

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
