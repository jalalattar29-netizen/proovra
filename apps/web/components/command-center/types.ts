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

/**
 * Phase 32.8C+++++++ — operational health diagnostic shape.
 * The dashboard uses this to render the correct severity per subsystem
 * (STALE/DEGRADED = amber, UNAVAILABLE/FAILED = red).
 */
export type OpsHealthStatus =
  | "HEALTHY"
  | "STALE"
  | "DEGRADED"
  | "PARTIAL"
  | "UNAVAILABLE"
  | "FAILED"
  | "DISCONNECTED";

export type OpsHealthSeverity =
  | "info"
  | "amber"
  | "warning"
  | "high"
  | "critical"
  | "muted";

export type OpsHealthState = {
  status: OpsHealthStatus;
  severity: OpsHealthSeverity;
  reason: string;
  recoverable: boolean;
  lastSuccessfulRunAt: string | null;
  retrying: boolean;
  degradedSince: string | null;
  canonicalSourceHealthy: boolean;
};

/**
 * @deprecated PHASE 3 — Inline `"PERSONAL" | "TEAM"` declaration.
 *   Prefer the canonical `WorkspaceScope` from
 *   `apps/web/lib/platform-context/types.ts`, or — for new code that
 *   speaks in the Target Domain Blueprint vocabulary — the
 *   `TargetWorkspaceKind` re-exported from `@proovra/shared`. This is
 *   one of 9 parallel `WorkspaceScope` declarations; Phase 3 retains
 *   them to avoid a cascading import refactor but new code MUST
 *   consume the canonical type.
 *   See docs/architecture/domain-debt-register.md (DBT-WS-04).
 */
export type WorkspaceScope = "PERSONAL" | "TEAM";

export type SeverityTone = "info" | "warning" | "high" | "critical";

export type ReasonCode =
  | "REVIEW_OVERDUE"
  | "REVIEW_DUE_SOON"
  | "REVIEW_UNASSIGNED"
  | "REVIEW_STALLED"
  | "REVIEWER_INACTIVE"
  | "REVIEWER_OVERLOADED"
  | "CASE_AT_RISK"
  | "CASE_EVIDENCE_GAP"
  | "EVIDENCE_STUCK_UPLOAD"
  | "EVIDENCE_UNSIGNED_TOO_LONG"
  | "EVIDENCE_NO_CASE"
  | "REPORT_MISSING"
  | "REPORT_FAILED"
  | "PACKAGE_MISSING"
  | "PACKAGE_FAILED"
  | "PACKAGE_BLOCKED_BY_GOVERNANCE"
  | "EXPORT_BLOCKED_BY_GOVERNANCE"
  | "GOVERNANCE_CONFLICT"
  | "LEGAL_HOLD_ACTIVE"
  | "RETENTION_REVIEW_DUE"
  | "DESTRUCTION_REVIEW_PENDING"
  | "QUEUE_CONGESTION"
  | "RETRY_STORM"
  | "OPERATIONAL_INCIDENT"
  | "INTEGRITY_REVIEW_REQUIRED"
  | "INTEGRITY_FAILED"
  | "CUSTODY_GAP"
  | "ACCESS_ANOMALY";

export type OperationalDomain =
  | "review_ops"
  | "evidence_pipeline"
  | "reports"
  | "packages"
  | "governance"
  | "custody_integrity"
  | "security_access"
  | "operational_health"
  | "case_ops";

export type AffectedEntityType =
  | "evidence"
  | "review_workflow"
  | "escalation"
  | "case"
  | "case_hold"
  | "evidence_hold"
  | "incident"
  | "destruction_review"
  | "policy"
  | "security_event";

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
  // Phase 32.8C+ routing metadata
  reasonCode: ReasonCode;
  affectedDomain: OperationalDomain;
  affectedEntityType: AffectedEntityType;
  affectedEntityId: string | null;
  operationalExplanation: string;
  recommendedAction: string;
  primaryRoute: string;
  secondaryRoute: string | null;
  ageMs: number | null;
  sourceTable: string;
  // Phase 32.8C++ action-routing permission metadata
  requiredPermission: string | null;
  requiredRoles: string[];
  canCurrentUserAct: boolean;
  safeActionLabel: string;
  escalationPath: string | null;
};

export type SectionMeta = {
  status: SectionStatus;
  warnings: string[];
  unsupportedSignals: string[];
  sourceSummary: string[];
};

export type InvestigationRiskLevel =
  | "CRITICAL"
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "NONE";

export type InvestigationRiskItem = {
  caseId: string;
  caseName: string;
  riskLevel: InvestigationRiskLevel;
  riskScore: number;
  reasonCodes: string[];
  recommendedAction: string;
  evidenceCount: number;
  overdueReviewCount: number;
  openEscalationsCount: number;
  hasActiveLegalHold: boolean;
  lastActivityAtUtc: string | null;
  href: string;
};

export type CrossCaseSignal = {
  kind:
    | "evidence_in_multiple_cases"
    | "reviewer_overload_multi_case"
    | "governance_block_multi_case";
  affectedCount: number;
  description: string;
  href: string;
};

export type WorkloadHealth = "HEALTHY" | "WATCH" | "DEGRADED" | "CRITICAL";

export type WorkloadEngineRow = {
  userId: string;
  displayName: string | null;
  email: string | null;
  assignedCount: number;
  overdueCount: number;
  dueSoonCount: number;
  saturationScore: number;
  bottleneck: boolean;
  lastActionAtUtc: string | null;
  inactive: boolean;
};

export type QueueCongestionItem = {
  queueId:
    | "review_queue"
    | "report_queue_pending"
    | "package_queue_pending"
    | "destruction_review_queue"
    | "escalation_queue";
  label: string;
  depth: number;
  oldestAgeMs: number | null;
  severity: SeverityTone;
  source: string;
};

export type IntegrityAnomalyItem = {
  evidenceId: string;
  title: string;
  reasonCode:
    | "INTEGRITY_REVIEW_REQUIRED"
    | "INTEGRITY_FAILED"
    | "REPORT_BUT_NO_PACKAGE"
    | "PACKAGE_BUT_NO_REPORT"
    | "PACKAGE_BLOCKED";
  severity: SeverityTone;
  detectedAt: string;
  href: string;
};

export type SecurityAnomalyItem = {
  eventId: string;
  eventType: string;
  severity: SeverityTone;
  detectedAt: string;
  userId: string | null;
  source: string;
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
  /** Phase 32.8C control plane — assignment + acknowledgment fields. */
  assignedOperatorUserId: string | null;
  assignedAtUtc: string | null;
  acknowledgedByUserId: string | null;
  acknowledgedAtUtc: string | null;
};

export type IncidentCorrelationItem = {
  id: string;
  correlationType: string;
  severity: string;
  rootOperationalCause: string;
  operationalSummary: string;
  recommendedAction: string;
  confidence: string;
  linkedIncidentIds: string[];
  firstDetectedAtUtc: string;
  lastDetectedAtUtc: string;
};

export type OperationalWorkflowAction = {
  actionType: string;
  permissionRequired: string;
  requiredRoles: string[];
  safeActionLabel: string;
  route: string | null;
};

export type OperationalWorkflowItem = {
  id: string;
  workflowType: string;
  status: string;
  severity: string;
  priority: string;
  title: string;
  safeSummary: string;
  sourceIncidentId: string | null;
  sourceCorrelationId: string | null;
  caseId: string | null;
  evidenceId: string | null;
  queueName: string | null;
  assignedOwnerUserId: string | null;
  assignedAtUtc: string | null;
  escalationLevel: number;
  retryCount: number;
  dueAtUtc: string | null;
  mitigationSummary: string | null;
  resolutionSummary: string | null;
  lastFailureCode: string | null;
  nextRetryAtUtc: string | null;
  createdAt: string;
  updatedAt: string;
  actions: OperationalWorkflowAction[];
};

export type OperationalCausalityChainItem = {
  id: string;
  chainKey: string;
  title: string;
  summary: string;
  rootCauseType: string;
  severity: string;
  status: string;
  linkedIncidentIds: string[];
  linkedWorkflowIds: string[];
  linkedCorrelationIds: string[];
  linkedCaseIds: string[];
  linkedEvidenceIds: string[];
  startAtUtc: string;
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
    /** Phase 32.8C FINAL-3 — reviewer capacity intelligence. */
    reviewerCapacity?: {
      meta: SectionMeta;
      reviewers: Array<{
        reviewerUserId: string;
        assignedCount: number;
        overdueCount: number;
        dueSoonCount: number;
        staleCount: number;
        completed7d: number;
        completed30d: number;
        saturationLevel: string;
        capacityScore: number;
        sampledAtUtc: string;
      }>;
      recommendations: Array<{
        id: string;
        sourceReviewerUserId: string | null;
        targetReviewerUserId: string | null;
        recommendationType: string;
        severity: string;
        reasonCode: string;
        explanation: string;
        status: string;
        createdAt: string;
      }>;
    };
    /** Phase 32.8C FINAL-3 — operational graph summary. */
    operationalGraph?: {
      meta: SectionMeta;
      data: {
        nodeCountsByType: Array<{ nodeType: string; count: number }>;
        edgeCountsByType: Array<{ edgeType: string; count: number }>;
        topRootCauses: Array<{
          nodeId: string;
          nodeType: string;
          entityId: string;
          label: string;
          severity: string;
          status: string;
          outDegree: number;
        }>;
        blastRadius: {
          impactedEvidenceCount: number;
          impactedCaseCount: number;
          impactedReviewerCount: number;
        };
      };
    };
    /** Phase 32.8C FINAL-3 — organizational health maturity board. */
    organizationalHealth?: {
      meta: SectionMeta;
      data: {
        healthScore: number | null;
        operationalMaturityScore: number | null;
        governanceMaturityScore: number | null;
        auditReadinessScore: number | null;
        reviewerMaturityScore: number | null;
        incidentFrequency7d: number | null;
        workflowCompletion7d: number | null;
        queueReliabilityScore: number | null;
        artifactReliabilityScore: number | null;
        sampledAtUtc: string | null;
      };
    };
    /** Phase 32.8C control plane — active incidents + correlations + workflows + causality chains. */
    incidents: {
      status: SectionStatus;
      items: IncidentItem[];
      correlations: IncidentCorrelationItem[];
      /** Phase 32.8C FINAL-2 — active operational workflows. */
      workflows: OperationalWorkflowItem[];
      /** Phase 32.8C FINAL-2 — root-cause causality chains. */
      causalityChains: OperationalCausalityChainItem[];
    };
    // Phase 32.8C+ intelligence-engine sections
    investigationIntelligence: {
      meta: SectionMeta;
      items: InvestigationRiskItem[];
      crossCaseSignals: CrossCaseSignal[];
    };
    routingQueue: {
      meta: SectionMeta;
      items: OperationalPressureItem[];
    };
    queueCongestion: {
      meta: SectionMeta;
      items: QueueCongestionItem[];
    };
    custodyIntegrityAnomalies: {
      meta: SectionMeta;
      items: IntegrityAnomalyItem[];
    };
    accessSecurityAnomalies: {
      meta: SectionMeta;
      items: SecurityAnomalyItem[];
    };
    workloadEngine: {
      meta: SectionMeta;
      health: WorkloadHealth;
      reviewers: WorkloadEngineRow[];
      saturationScore: number;
      bottlenecks: number;
    };
    timelineIntelligence: {
      status: SectionStatus;
      events: Array<
        TimelineEvent & {
          domain: OperationalDomain;
          operationalMeaning: string;
        }
      >;
      groupings: {
        byDomain: Record<OperationalDomain, number>;
        bySeverity: Record<SeverityTone, number>;
        byWindow: { last24h: number; last7d: number; last30d: number };
      };
    };
    pipelineIntelligence: {
      status: SectionStatus;
      data: PipelineDetail | null;
    };
    // Phase 32.8C++ deep operations intelligence
    relationshipIntelligence: {
      meta: SectionMeta;
      clusters: RelationshipCluster[];
    };
    crossCaseIntelligenceV2: {
      meta: SectionMeta;
      signals: CrossCaseSignalV2[];
    };
    reconstructedTimeline: {
      meta: SectionMeta;
      events: ReconstructedTimelineEvent[];
    };
    deepIntegrityWatch: {
      meta: SectionMeta;
      items: DeepIntegritySignal[];
    };
    accessSecurityClassifier: {
      meta: SectionMeta;
      anomalies: ClassifiedSecurityAnomaly[];
    };
    queueWorkerTelemetry: {
      meta: SectionMeta;
      data: QueueWorkerTelemetryData;
    };
    coordinationSignals: {
      meta: SectionMeta;
      signals: CoordinationSignal[];
      backlog: CoordinationBacklog;
    };
    predictiveRisk: {
      meta: SectionMeta;
      forecasts: PredictiveRiskForecast[];
    };
    organizationalIntelligenceV2: {
      meta: SectionMeta;
      data: OrgIntelligenceV2;
    };
  };
  /**
   * Phase 32.8C+++++++ — per-subsystem operational health.
   * Frontend uses this to render STALE/DEGRADED as AMBER and only
   * UNAVAILABLE/FAILED as RED — so alive-but-delayed subsystems
   * never appear as hard failures.
   */
  opsHealth?: {
    telemetry: OpsHealthState;
    reconcile: OpsHealthState;
    securityRollup: OpsHealthState;
  };
  /**
   * Phase 32.8C FINAL-3 — persona-aware capability matrix. Frontend
   * uses this to order sections + label/disable team-only actions.
   * The matrix never weakens auth; canonical gates live at routes.
   */
  capabilityMatrix?: {
    workspaceType: "PERSONAL" | "TEAM";
    role: string;
    persona: string;
    capabilities: {
      reviewerOpsRead: boolean;
      reviewerOpsAct: boolean;
      governanceRead: boolean;
      governanceAct: boolean;
      bulkActions: boolean;
      workflowActions: boolean;
      incidentActions: boolean;
      orgIntelligence: boolean;
      personaSwitching: boolean;
    };
    sectionOrder: string[];
  };
  unsupportedSignals: Array<{ signal: string; reason: string }>;
};

// ---------------------------------------------------------------------------
// Phase 32.8C++ deep-intelligence shapes
// ---------------------------------------------------------------------------

export type Confidence = "direct" | "inferred" | "low" | "medium" | "high";

export type RelationshipCluster = {
  id: string;
  kind:
    | "duplicate_hash"
    | "same_intake_session"
    | "same_submitter"
    | "explicit_relationship"
    | "same_case";
  reasonCode: string;
  severity: SeverityTone;
  evidenceIds: string[];
  caseIds: string[];
  operationalExplanation: string;
  recommendedAction: string;
  route: string;
  confidence: Confidence;
};

export type CrossCaseSignalV2 = {
  id: string;
  signalType:
    | "shared_governance_block"
    | "shared_reviewer_overload"
    | "shared_failed_report_pattern"
    | "shared_failed_package_pattern"
    | "repeated_evidence_gaps"
    | "repeated_overdue_reviews"
    | "stale_with_active_hold";
  severity: SeverityTone;
  reasonCode: string;
  affectedCaseIds: string[];
  affectedEvidenceIds: string[];
  operationalMeaning: string;
  recommendedAction: string;
  route: string;
};

export type ReconstructedTimelineEvent = {
  id: string;
  type: string;
  family:
    | "evidence"
    | "report"
    | "package"
    | "governance"
    | "review"
    | "incident"
    | "audit"
    | "security";
  timestamp: string;
  severity: SeverityTone;
  actor: string | null;
  entityType: string | null;
  entityId: string | null;
  caseId: string | null;
  evidenceId: string | null;
  operationalMeaning: string;
  route: string | null;
  sourceTable: string;
  confidence: Confidence;
  safeToDisplay: boolean;
};

export type TsaTimestampIntelligence = {
  /** "PARSED" | "UNAVAILABLE" | "FAILED" — null when no snapshot row exists. */
  parseStatus: string | null;
  parseErrorCode: string | null;
  issuerCommonName: string | null;
  issuerOrganization: string | null;
  policyOid: string | null;
  parsedAtUtc: string | null;
};

export type DeepIntegritySignal = {
  evidenceId: string;
  title: string;
  reasonCode:
    | "INTEGRITY_REVIEW_REQUIRED"
    | "INTEGRITY_FAILED"
    | "TSA_UNAVAILABLE"
    | "OTS_UNAVAILABLE"
    | "OTS_FAILED"
    | "PACKAGE_BUT_NO_REPORT"
    | "REPORT_FINALIZED_NO_PACKAGE_AGED"
    | "PACKAGE_BLOCKED";
  severity: SeverityTone;
  detectedAt: string;
  sourceFields: string[];
  confidence: Confidence;
  explanation: string;
  recommendedAction: string;
  href: string;
  tsaTimestampIntelligence?: TsaTimestampIntelligence;
};

export type ClassifiedSecurityAnomaly = {
  category:
    | "repeated_failed_access"
    | "blocked_export_attempt"
    | "api_credential_change"
    | "webhook_failure_spike"
    | "admin_role_change"
    | "step_up_failed"
    | "permission_denied_burst"
    | "uncategorized";
  severity: SeverityTone;
  eventType: string;
  count: number;
  timeWindow: string;
  userId: string | null;
  firstSeen: string;
  lastSeen: string;
  explanation: string;
  recommendedAction: string;
  sourceTable: string;
};

export type QueueTelemetrySnapshotRow = {
  queueName: string;
  queueDomain: string;
  waitingCount: number;
  activeCount: number;
  delayedCount: number;
  failedCount: number;
  retryCount: number;
  stalledCount: number;
  sampledAtUtc: string;
  source: string;
};

export type WorkerTelemetryHeartbeat = {
  workerId: string;
  workerKind: string;
  status: string;
  heartbeatAtUtc: string;
  ageSeconds: number;
  lastErrorCode: string | null;
  processedCount: number | null;
  failedCount: number | null;
};

export type QueueWorkerTelemetryData = {
  reconcileLastRunAtUtc: string | null;
  reconcileFreshnessHours: number | null;
  reconcileHealth: "FRESH" | "STALE" | "UNAVAILABLE";
  reviewQueueDepth: number;
  reportQueuePending: number;
  packageQueuePending: number;
  oldestQueuedAgeHours: number | null;
  retryStormIncidents: number;
  /** Phase 32.8C+++++ — durable QueueTelemetrySnapshot rows. */
  queueSnapshots: QueueTelemetrySnapshotRow[];
  /** Phase 32.8C+++++ — durable WorkerTelemetrySnapshot rows. */
  workerHeartbeats: WorkerTelemetryHeartbeat[];
};

export type CoordinationSignal = {
  id: string;
  signalType:
    | "escalation_unassigned"
    | "annotation_requires_review"
    | "annotation_unresolved"
    | "reviewer_comment_unresolved"
    | "case_comment_unresolved"
    | "legal_note_pending"
    | "review_without_recent_activity";
  severity: SeverityTone;
  reasonCode: string;
  entityId: string;
  entityType: "escalation" | "evidence" | "review_workflow" | "case";
  detectedAt: string;
  explanation: string;
  route: string;
};

export type CoordinationBacklog = {
  caseCommentOpenCount: number;
  caseCommentResolvedCount: number;
  caseCommentStaleOpenCount: number;
  reviewerCommentOpenCount: number;
  annotationOpenCount: number;
};

export type PredictiveRiskForecast = {
  id: string;
  forecastType:
    | "sla_breach_imminent"
    | "reviewer_capacity_breach"
    | "report_pipeline_degradation"
    | "package_pipeline_degradation"
    | "governance_pressure_rising"
    | "audit_readiness_gap";
  severity: SeverityTone;
  reason: string;
  likelyImpact: string;
  recommendedAction: string;
  confidence: "low" | "medium" | "high";
  evidenceCount: number;
  caseCount: number;
};

export type OrgIntelligenceV2 = {
  orgHealth: "HEALTHY" | "WATCH" | "DEGRADED" | "CRITICAL";
  bottleneckDomains: Array<{
    domain: OperationalDomain;
    pressureItems: number;
  }>;
  topPressureSources: Array<{ sourceTable: string; itemCount: number }>;
  throughputWindows: {
    last24h: number;
    last7d: number;
    last30d: number;
  };
  recommendedActions: string[];
};
