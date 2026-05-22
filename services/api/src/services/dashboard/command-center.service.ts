/**
 * Phase 32.8C (Full Rebuild) — Enterprise Evidence Operations Command Center.
 *
 * Read-only aggregator that powers `/v1/dashboard/command-center`.
 * The envelope is the canonical operator view of the workspace:
 * operational pressure, investigation pressure, reviewer
 * orchestration, evidence pipeline health, governance posture,
 * organizational intelligence, operational timeline, and audit
 * readiness.
 *
 * Hard rules:
 *   - READ ONLY. No `prisma.*.create / update / delete / upsert`.
 *   - NEVER emits an audit / analytics / security event. The
 *     existing audited endpoints remain the canonical signal for
 *     "the operator viewed evidence X".
 *   - Bounded queries. Every `findMany` carries `take`.
 *   - Per-section try/catch — partial failures degrade individual
 *     sections, never the whole envelope.
 *   - NEVER projects raw file content, signed URLs, storage keys,
 *     custody payloads, privileged legal text, or step-up secrets.
 *   - Personal vs team detection is heuristic (single ACTIVE
 *     member). Sections that require team semantics return
 *     `not_applicable` for personal workspaces.
 */

import { prisma } from "../../db.js";

// ---------------------------------------------------------------------------
// Public contract types
// ---------------------------------------------------------------------------

export type SectionStatus = "ok" | "degraded" | "unavailable" | "not_applicable";

export type WorkspaceScope = "PERSONAL" | "TEAM";

export type SeverityTone = "info" | "warning" | "high" | "critical";

/** Operational pressure item — what needs attention NOW. */
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

/** Case-operations row — investigation pressure per case. */
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

/** Reviewer orchestration — per-reviewer triage snapshot. */
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

/** Pipeline detail — every stage including report/package readiness. */
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

/** Timeline event — operational heartbeat. */
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

/** Audit-readiness counter — single dimension of organizational readiness. */
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

export type CommandCenterAttentionItem = OperationalPressureItem;

export type CommandCenterRecentEvidenceItem = {
  id: string;
  title: string;
  status: string;
  verificationStatus: string | null;
  createdAt: string;
  caseId: string | null;
};

export type CommandCenterIncidentItem = {
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
    // === Hero / overview ===
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
    // === 1. ACTIVE OPERATIONAL PRESSURE (the hero of the page) ===
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
    // === Legacy attention queue (kept for backward compat — same shape as
    //     operationalPressure.items) ===
    attentionQueue: {
      status: SectionStatus;
      items: CommandCenterAttentionItem[];
    };
    // === 2. INVESTIGATION & CASE OPERATIONS ===
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
    // === 3. REVIEWER ORCHESTRATION ===
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
    // === 4. EVIDENCE PIPELINE VISIBILITY ===
    pipelineDetail: {
      status: SectionStatus;
      data: PipelineDetail | null;
    };
    // === 5. GOVERNANCE & COMPLIANCE POSTURE ===
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
    // === 6. ORGANIZATIONAL INTELLIGENCE ===
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
    // === 7. OPERATIONAL TIMELINE ===
    timeline: {
      status: SectionStatus;
      items: TimelineEvent[];
    };
    // === 8. AUDIT READINESS ===
    auditReadiness: {
      status: SectionStatus;
      counters: AuditReadinessCounter[];
    };
    // === Recent evidence (for activity stream) ===
    recentEvidence: {
      status: SectionStatus;
      items: CommandCenterRecentEvidenceItem[];
    };
    // === Existing pipeline (5-stage summary) — preserved for back-compat ===
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
    // === Existing reviewerWorkload (preserved for back-compat) ===
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
    // === Operational incidents (workspace + global) ===
    incidents: {
      status: SectionStatus;
      items: CommandCenterIncidentItem[];
    };
  };
};

// ---------------------------------------------------------------------------
// Bounded limits
// ---------------------------------------------------------------------------

const PRESSURE_PER_KIND = 6;
const PRESSURE_TOTAL = 32;
const TOP_CASES_LIMIT = 8;
const TOP_REVIEWERS_LIMIT = 8;
const TIMELINE_LIMIT = 30;
const RECENT_EVIDENCE_LIMIT = 8;
const INCIDENTS_LIMIT = 10;
const STUCK_UPLOAD_HOURS = 4;
const STALLED_REVIEW_HOURS = 48;
const REVIEWER_INACTIVITY_HOURS = 72;
const UNSIGNED_EVIDENCE_AGE_DAYS = 7;
const RETRY_STORM_OCCURRENCE_THRESHOLD = 5;

const SEVERITY_RANK: Record<SeverityTone, number> = {
  critical: 4,
  high: 3,
  warning: 2,
  info: 1,
};

// ---------------------------------------------------------------------------
// Personal vs team detection
// ---------------------------------------------------------------------------

async function detectWorkspaceScope(teamId: string): Promise<{
  scope: WorkspaceScope;
  memberCount: number;
}> {
  const memberCount = await prisma.teamMember.count({
    where: { teamId, status: "ACTIVE" },
  });
  return {
    scope: memberCount <= 1 ? "PERSONAL" : "TEAM",
    memberCount,
  };
}

// ---------------------------------------------------------------------------
// Section: Operational pressure
// ---------------------------------------------------------------------------

async function runOperationalPressure(
  teamId: string,
  scope: WorkspaceScope,
): Promise<CommandCenterEnvelope["sections"]["operationalPressure"]> {
  const now = new Date();
  const stuckUploadCutoff = new Date(
    Date.now() - STUCK_UPLOAD_HOURS * 60 * 60 * 1000,
  );
  const stalledReviewCutoff = new Date(
    Date.now() - STALLED_REVIEW_HOURS * 60 * 60 * 1000,
  );
  const unsignedAgeCutoff = new Date(
    Date.now() - UNSIGNED_EVIDENCE_AGE_DAYS * 24 * 60 * 60 * 1000,
  );

  const collected: OperationalPressureItem[] = [];
  let anyOk = false;
  let anyFailed = false;

  const pushKindResults = (
    items: OperationalPressureItem[],
    sliced: number = PRESSURE_PER_KIND,
  ) => {
    for (const item of items.slice(0, sliced)) collected.push(item);
  };

  // Overdue reviews (team only) — workflows past dueAt that are still open.
  if (scope === "TEAM") {
    try {
      const rows = await prisma.evidenceReviewWorkflow.findMany({
        where: {
          teamId,
          status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
          dueAt: { lt: now },
        },
        orderBy: [{ priority: "desc" }, { dueAt: "asc" }],
        take: PRESSURE_PER_KIND,
        select: {
          id: true,
          evidenceId: true,
          status: true,
          priority: true,
          dueAt: true,
        },
      });
      anyOk = true;
      pushKindResults(
        rows.map((r) => ({
          id: `overdue_review:${r.id}`,
          category: "overdue_review",
          severity: (r.priority === "URGENT"
            ? "critical"
            : r.priority === "HIGH"
              ? "high"
              : "warning") as SeverityTone,
          title: `Overdue review — ${r.status}`,
          subtitle: r.dueAt
            ? `Due ${r.dueAt.toISOString().slice(0, 10)} · ${r.priority}`
            : null,
          href: `/evidence/${r.evidenceId}`,
          occurredAt: r.dueAt?.toISOString() ?? null,
        })),
      );
    } catch {
      anyFailed = true;
    }
  }

  // Stalled review workflows (IN_REVIEW / NEEDS_INFO not touched in N hours)
  if (scope === "TEAM") {
    try {
      const rows = await prisma.evidenceReviewWorkflow.findMany({
        where: {
          teamId,
          status: { in: ["IN_REVIEW", "NEEDS_INFO"] },
          updatedAt: { lt: stalledReviewCutoff },
        },
        orderBy: { updatedAt: "asc" },
        take: PRESSURE_PER_KIND,
        select: {
          id: true,
          evidenceId: true,
          status: true,
          updatedAt: true,
        },
      });
      anyOk = true;
      pushKindResults(
        rows.map((r) => ({
          id: `stalled_review:${r.id}`,
          category: "stalled_review",
          severity: "warning",
          title: `Stalled review — no progress in ${STALLED_REVIEW_HOURS}h`,
          subtitle: `${r.status} · last touched ${r.updatedAt.toISOString().slice(0, 10)}`,
          href: `/evidence/${r.evidenceId}`,
          occurredAt: r.updatedAt.toISOString(),
        })),
      );
    } catch {
      anyFailed = true;
    }
  }

  // Unassigned review workflows (queued for > N hours)
  if (scope === "TEAM") {
    try {
      const queuedTooLong = await prisma.evidenceReviewWorkflow.findMany({
        where: {
          teamId,
          status: "QUEUED",
          createdAt: { lt: stalledReviewCutoff },
        },
        orderBy: { createdAt: "asc" },
        take: PRESSURE_PER_KIND,
        select: { id: true, evidenceId: true, createdAt: true },
      });
      anyOk = true;
      pushKindResults(
        queuedTooLong.map((r) => ({
          id: `unassigned_review:${r.id}`,
          category: "unassigned_review",
          severity: "warning",
          title: `Unassigned review — queued > ${STALLED_REVIEW_HOURS}h`,
          subtitle: `Queued ${r.createdAt.toISOString().slice(0, 10)}`,
          href: "/reviewer-ops",
          occurredAt: r.createdAt.toISOString(),
        })),
      );
    } catch {
      anyFailed = true;
    }
  }

  // Open escalations (CRITICAL/HIGH first)
  if (scope === "TEAM") {
    try {
      const rows = await prisma.reviewEscalation.findMany({
        where: { teamId, status: "OPEN" },
        orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
        take: PRESSURE_PER_KIND,
        select: {
          id: true,
          severity: true,
          reason: true,
          workflowId: true,
          evidenceId: true,
          createdAt: true,
        },
      });
      anyOk = true;
      pushKindResults(
        rows.map((r) => ({
          id: `escalation:${r.id}`,
          category: "open_escalation",
          severity: (r.severity === "CRITICAL"
            ? "critical"
            : r.severity === "HIGH"
              ? "high"
              : "warning") as SeverityTone,
          title: humanize(String(r.reason)) || "Reviewer escalation",
          subtitle: `Workflow ${r.workflowId.slice(0, 8)}`,
          href: "/reviewer-ops/escalations",
          occurredAt: r.createdAt.toISOString(),
        })),
      );
    } catch {
      anyFailed = true;
    }
  }

  // Stuck uploads — UPLOADING > N hours
  try {
    const rows = await prisma.evidence.findMany({
      where: {
        teamId,
        status: "UPLOADING",
        updatedAt: { lt: stuckUploadCutoff },
      },
      orderBy: { updatedAt: "asc" },
      take: PRESSURE_PER_KIND,
      select: { id: true, title: true, updatedAt: true },
    });
    anyOk = true;
    pushKindResults(
      rows.map((r) => ({
        id: `stuck_upload:${r.id}`,
        category: "stuck_upload",
        severity: "warning",
        title: `Upload stalled — ${r.title ?? "Untitled"}`,
        subtitle: `No progress in ${STUCK_UPLOAD_HOURS}h+`,
        href: `/evidence/${r.id}`,
        occurredAt: r.updatedAt.toISOString(),
      })),
    );
  } catch {
    anyFailed = true;
  }

  // Missing reports — evidence in SIGNED with no Report row.
  try {
    const rows = await prisma.evidence.findMany({
      where: {
        teamId,
        status: "SIGNED",
        reports: { none: {} },
      },
      orderBy: { updatedAt: "asc" },
      take: PRESSURE_PER_KIND,
      select: { id: true, title: true, updatedAt: true },
    });
    anyOk = true;
    pushKindResults(
      rows.map((r) => ({
        id: `missing_report:${r.id}`,
        category: "missing_report",
        severity: "warning",
        title: `Report not generated — ${r.title ?? "Untitled"}`,
        subtitle: "Evidence finalized · report pipeline pending",
        href: `/evidence/${r.id}`,
        occurredAt: r.updatedAt.toISOString(),
      })),
    );
  } catch {
    anyFailed = true;
  }

  // Missing packages — evidence in REPORTED with no VerificationPackage.
  try {
    const rows = await prisma.evidence.findMany({
      where: {
        teamId,
        status: "REPORTED",
        verificationPackages: { none: {} },
      },
      orderBy: { updatedAt: "asc" },
      take: PRESSURE_PER_KIND,
      select: { id: true, title: true, updatedAt: true },
    });
    anyOk = true;
    pushKindResults(
      rows.map((r) => ({
        id: `missing_package:${r.id}`,
        category: "missing_package",
        severity: "warning",
        title: `Verification package not generated — ${r.title ?? "Untitled"}`,
        subtitle: "Report ready · package pipeline pending",
        href: `/evidence/${r.id}`,
        occurredAt: r.updatedAt.toISOString(),
      })),
    );
  } catch {
    anyFailed = true;
  }

  // Failed report / package jobs — via operational incidents
  try {
    const incidents = await prisma.operationalIncident.findMany({
      where: {
        OR: [{ teamId }, { teamId: null }],
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        category: { in: ["REPORT", "PACKAGE"] },
      },
      orderBy: [{ severity: "desc" }, { lastSeenAtUtc: "desc" }],
      take: PRESSURE_PER_KIND,
      select: {
        id: true,
        category: true,
        severity: true,
        title: true,
        runbookSlug: true,
        relatedEvidenceId: true,
        lastSeenAtUtc: true,
      },
    });
    anyOk = true;
    pushKindResults(
      incidents.map((i) => ({
        id: `failed_${String(i.category).toLowerCase()}:${i.id}`,
        category: i.category === "REPORT" ? "failed_report" : "failed_package",
        severity: (i.severity === "CRITICAL"
          ? "critical"
          : i.severity === "HIGH"
            ? "high"
            : "warning") as SeverityTone,
        title: i.title,
        subtitle: i.runbookSlug ? `Runbook · ${i.runbookSlug}` : null,
        href: i.relatedEvidenceId
          ? `/evidence/${i.relatedEvidenceId}`
          : i.runbookSlug
            ? `/ops/runbooks#${i.runbookSlug}`
            : "/ops/observability",
        occurredAt: i.lastSeenAtUtc.toISOString(),
      })),
    );
  } catch {
    anyFailed = true;
  }

  // Retry storms — operational incidents with high occurrence count
  try {
    const incidents = await prisma.operationalIncident.findMany({
      where: {
        OR: [{ teamId }, { teamId: null }],
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        occurrenceCount: { gte: RETRY_STORM_OCCURRENCE_THRESHOLD },
      },
      orderBy: { occurrenceCount: "desc" },
      take: PRESSURE_PER_KIND,
      select: {
        id: true,
        title: true,
        category: true,
        severity: true,
        occurrenceCount: true,
        runbookSlug: true,
        lastSeenAtUtc: true,
      },
    });
    anyOk = true;
    pushKindResults(
      incidents.map((i) => ({
        id: `retry_storm:${i.id}`,
        category: "retry_storm",
        severity: (i.severity === "CRITICAL" ? "critical" : "high") as SeverityTone,
        title: `Retry storm · ${i.category}`,
        subtitle: `${i.occurrenceCount} occurrences · ${i.title}`,
        href: i.runbookSlug
          ? `/ops/runbooks#${i.runbookSlug}`
          : "/ops/observability",
        occurredAt: i.lastSeenAtUtc.toISOString(),
      })),
    );
  } catch {
    anyFailed = true;
  }

  // Governance conflicts (policy conflicts)
  if (scope === "TEAM") {
    try {
      const { countActivePolicyConflicts } = await import(
        "../governance-lifecycle/retention-engine.service.js"
      );
      const conflicts = await countActivePolicyConflicts(teamId);
      anyOk = true;
      if (conflicts > 0) {
        collected.push({
          id: `policy_conflict:${teamId}`,
          category: "policy_conflict",
          severity: "high",
          title: `${conflicts} active policy conflict${conflicts === 1 ? "" : "s"}`,
          subtitle: "Retention policy overlap detected",
          href: "/governance/policy",
          occurredAt: null,
        });
      }
    } catch {
      // best-effort
    }
  }

  // Blocked exports — evidence with verificationPackageMetadata.blocked === true
  if (scope === "TEAM") {
    try {
      const sample = await prisma.evidence.findMany({
        where: {
          teamId,
          status: { in: ["SIGNED", "REPORTED"] },
        },
        take: 200,
        select: {
          id: true,
          title: true,
          updatedAt: true,
          verificationPackageMetadata: true,
        },
      });
      anyOk = true;
      const blocked: OperationalPressureItem[] = [];
      for (const row of sample) {
        const meta = row.verificationPackageMetadata as Record<
          string,
          unknown
        > | null;
        if (meta && meta.blocked === true) {
          blocked.push({
            id: `blocked_export:${row.id}`,
            category: "blocked_export",
            severity: "high",
            title: `Export blocked by governance — ${row.title ?? "Untitled"}`,
            subtitle:
              typeof meta.reason === "string"
                ? String(meta.reason).slice(0, 120)
                : "Governance gate denied package",
            href: `/evidence/${row.id}`,
            occurredAt: row.updatedAt.toISOString(),
          });
          if (blocked.length >= PRESSURE_PER_KIND) break;
        }
      }
      pushKindResults(blocked);
    } catch {
      anyFailed = true;
    }
  }

  // Evidence without case linkage (team only)
  if (scope === "TEAM") {
    try {
      const rows = await prisma.evidence.findMany({
        where: { teamId, caseId: null },
        orderBy: { createdAt: "desc" },
        take: PRESSURE_PER_KIND,
        select: { id: true, title: true, createdAt: true },
      });
      anyOk = true;
      pushKindResults(
        rows.map((r) => ({
          id: `evidence_no_case:${r.id}`,
          category: "evidence_no_case",
          severity: "info",
          title: `Evidence without case — ${r.title ?? "Untitled"}`,
          subtitle: `Captured ${r.createdAt.toISOString().slice(0, 10)}`,
          href: `/evidence/${r.id}`,
          occurredAt: r.createdAt.toISOString(),
        })),
        Math.min(PRESSURE_PER_KIND, 4),
      );
    } catch {
      anyFailed = true;
    }
  }

  // Unsigned evidence > 7 days old
  try {
    const rows = await prisma.evidence.findMany({
      where: {
        teamId,
        status: { in: ["CREATED", "UPLOADING", "UPLOADED"] },
        createdAt: { lt: unsignedAgeCutoff },
      },
      orderBy: { createdAt: "asc" },
      take: PRESSURE_PER_KIND,
      select: { id: true, title: true, createdAt: true, status: true },
    });
    anyOk = true;
    pushKindResults(
      rows.map((r) => ({
        id: `unsigned_old:${r.id}`,
        category: "unsigned_evidence_old",
        severity: "warning",
        title: `Unsigned evidence > ${UNSIGNED_EVIDENCE_AGE_DAYS}d — ${r.title ?? "Untitled"}`,
        subtitle: `${r.status} · captured ${r.createdAt.toISOString().slice(0, 10)}`,
        href: `/evidence/${r.id}`,
        occurredAt: r.createdAt.toISOString(),
      })),
      Math.min(PRESSURE_PER_KIND, 4),
    );
  } catch {
    anyFailed = true;
  }

  // Operational incidents (CRITICAL severity, non-report/package categories
  // — those are handled above)
  try {
    const rows = await prisma.operationalIncident.findMany({
      where: {
        OR: [{ teamId }, { teamId: null }],
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        severity: { in: ["HIGH", "CRITICAL"] },
        category: {
          notIn: ["REPORT", "PACKAGE"],
        },
      },
      orderBy: [{ severity: "desc" }, { lastSeenAtUtc: "desc" }],
      take: PRESSURE_PER_KIND,
      select: {
        id: true,
        title: true,
        category: true,
        severity: true,
        runbookSlug: true,
        lastSeenAtUtc: true,
      },
    });
    anyOk = true;
    pushKindResults(
      rows.map((r) => ({
        id: `incident:${r.id}`,
        category: "operational_incident",
        severity: (r.severity === "CRITICAL" ? "critical" : "high") as SeverityTone,
        title: r.title,
        subtitle: `${r.category}${r.runbookSlug ? ` · ${r.runbookSlug}` : ""}`,
        href: r.runbookSlug
          ? `/ops/runbooks#${r.runbookSlug}`
          : "/ops/observability",
        occurredAt: r.lastSeenAtUtc.toISOString(),
      })),
    );
  } catch {
    anyFailed = true;
  }

  // Sort + cap
  collected.sort((a, b) => {
    const d = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (d !== 0) return d;
    if (a.occurredAt && b.occurredAt)
      return b.occurredAt.localeCompare(a.occurredAt);
    if (a.occurredAt) return -1;
    if (b.occurredAt) return 1;
    return 0;
  });
  const items = collected.slice(0, PRESSURE_TOTAL);

  const counts = {
    critical: items.filter((i) => i.severity === "critical").length,
    high: items.filter((i) => i.severity === "high").length,
    warning: items.filter((i) => i.severity === "warning").length,
    info: items.filter((i) => i.severity === "info").length,
  };

  const status: SectionStatus = !anyOk
    ? "unavailable"
    : anyFailed
      ? "degraded"
      : "ok";

  return { status, items, counts };
}

// ---------------------------------------------------------------------------
// Section: Case operations
// ---------------------------------------------------------------------------

async function runCaseOperations(
  teamId: string,
  scope: WorkspaceScope,
): Promise<CommandCenterEnvelope["sections"]["caseOperations"]> {
  try {
    const now = new Date();
    const activeCasesCount = await prisma.case.count({ where: { teamId } });
    const evidenceWithCase = await prisma.evidence.groupBy({
      by: ["caseId"],
      where: { teamId, caseId: { not: null } },
      _count: { _all: true },
      orderBy: { caseId: "asc" },
      take: 1000,
    });
    const casesWithEvidenceCount = evidenceWithCase.length;
    const casesWithEvidenceGapsCount = Math.max(
      0,
      activeCasesCount - casesWithEvidenceCount,
    );
    const unlinkedEvidenceCount = await prisma.evidence.count({
      where: { teamId, caseId: null },
    });

    let unreviewedEvidenceCount = 0;
    if (scope === "TEAM") {
      unreviewedEvidenceCount = await prisma.evidence.count({
        where: {
          teamId,
          status: { in: ["UPLOADED", "SIGNED"] },
          reviewWorkflow: null,
        },
      });
    }

    // Top cases by overdue review pressure + recent activity.
    const recentCases = await prisma.case.findMany({
      where: { teamId },
      orderBy: { updatedAt: "desc" },
      take: TOP_CASES_LIMIT,
      select: {
        id: true,
        name: true,
        updatedAt: true,
      },
    });
    const caseIds = recentCases.map((c) => c.id);
    const [evidenceCounts, holdsByCase, reviewByCase] = await Promise.all([
      prisma.evidence.groupBy({
        by: ["caseId"],
        where: { caseId: { in: caseIds } },
        _count: { _all: true },
      }),
      prisma.caseLegalHold
        .findMany({
          where: { caseId: { in: caseIds }, status: "ACTIVE" },
          select: { caseId: true },
          take: caseIds.length * 4,
        })
        .catch(() => []),
      scope === "TEAM"
        ? prisma.evidenceReviewWorkflow.findMany({
            where: {
              teamId,
              evidence: { caseId: { in: caseIds } },
              status: {
                in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"],
              },
            },
            select: {
              dueAt: true,
              evidence: { select: { caseId: true } },
            },
            take: 500,
          })
        : Promise.resolve([]),
    ]);
    const reviewByCaseMap = new Map<
      string,
      { open: number; overdue: number }
    >();
    for (const r of reviewByCase) {
      const cid = r.evidence?.caseId;
      if (!cid) continue;
      const entry = reviewByCaseMap.get(cid) ?? { open: 0, overdue: 0 };
      entry.open += 1;
      if (r.dueAt && r.dueAt.getTime() < now.getTime()) entry.overdue += 1;
      reviewByCaseMap.set(cid, entry);
    }
    const evidenceCountMap = new Map<string, number>();
    for (const e of evidenceCounts) {
      if (e.caseId) evidenceCountMap.set(e.caseId, e._count._all);
    }
    const holdsSet = new Set<string>();
    for (const h of holdsByCase) holdsSet.add(h.caseId);

    let openEscalationsByCase = new Map<string, number>();
    if (scope === "TEAM") {
      try {
        const escalations = await prisma.reviewEscalation.findMany({
          where: {
            teamId,
            status: "OPEN",
            workflow: { evidence: { caseId: { in: caseIds } } },
          },
          select: { workflow: { select: { evidence: { select: { caseId: true } } } } },
          take: 200,
        });
        for (const e of escalations) {
          const cid = e.workflow?.evidence?.caseId;
          if (!cid) continue;
          openEscalationsByCase.set(
            cid,
            (openEscalationsByCase.get(cid) ?? 0) + 1,
          );
        }
      } catch {
        openEscalationsByCase = new Map();
      }
    }

    const topCases: CaseOperationsItem[] = recentCases.map((c) => ({
      caseId: c.id,
      caseName: c.name,
      evidenceCount: evidenceCountMap.get(c.id) ?? 0,
      unreviewedCount: 0, // populated lazily — keeps query bounded
      overdueReviewCount: reviewByCaseMap.get(c.id)?.overdue ?? 0,
      openEscalationsCount: openEscalationsByCase.get(c.id) ?? 0,
      hasActiveLegalHold: holdsSet.has(c.id),
      lastActivityAtUtc: c.updatedAt.toISOString(),
    }));

    return {
      status: "ok",
      data: {
        activeCasesCount,
        casesWithEvidenceGapsCount,
        unreviewedEvidenceCount,
        unlinkedEvidenceCount,
        topCases,
      },
    };
  } catch {
    return { status: "unavailable", data: null };
  }
}

// ---------------------------------------------------------------------------
// Section: Reviewer orchestration
// ---------------------------------------------------------------------------

async function runReviewerOrchestration(
  teamId: string,
  scope: WorkspaceScope,
): Promise<CommandCenterEnvelope["sections"]["reviewerOrchestration"]> {
  if (scope === "PERSONAL") {
    return { status: "not_applicable", data: null };
  }
  try {
    const now = new Date();
    const dueSoonCutoff = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const last7dStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const prev7dStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const inactivityCutoff = new Date(
      Date.now() - REVIEWER_INACTIVITY_HOURS * 60 * 60 * 1000,
    );

    const [
      queueDepth,
      overdueCount,
      dueSoonCount,
      unassignedCount,
      openEscalationsCount,
      completedLast7dCount,
      completedPrev7dCount,
    ] = await Promise.all([
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId,
          status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
        },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId,
          status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
          dueAt: { lt: now },
        },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId,
          status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
          dueAt: { gte: now, lt: dueSoonCutoff },
        },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: { teamId, status: "QUEUED" },
      }),
      prisma.reviewEscalation.count({
        where: { teamId, status: "OPEN" },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId,
          status: "CLOSED",
          updatedAt: { gte: last7dStart },
        },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId,
          status: "CLOSED",
          updatedAt: { gte: prev7dStart, lt: last7dStart },
        },
      }),
    ]);

    // Top reviewers by load + inactivity flag
    const grouped = await prisma.evidenceReviewWorkflow.groupBy({
      by: ["assignedToUserId"],
      where: {
        teamId,
        assignedToUserId: { not: null },
        status: { in: ["ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
      },
      _count: { _all: true },
      orderBy: { _count: { assignedToUserId: "desc" } },
      take: TOP_REVIEWERS_LIMIT,
    });
    const reviewerIds = grouped
      .map((g) => g.assignedToUserId)
      .filter((v): v is string => v !== null);

    let topReviewers: ReviewerOrchestrationRow[] = [];
    let inactiveReviewerCount = 0;
    if (reviewerIds.length > 0) {
      const [users, overdueGroups, dueSoonGroups, lastActions] =
        await Promise.all([
          prisma.user.findMany({
            where: { id: { in: reviewerIds } },
            select: { id: true, email: true, displayName: true },
            take: TOP_REVIEWERS_LIMIT,
          }),
          prisma.evidenceReviewWorkflow.groupBy({
            by: ["assignedToUserId"],
            where: {
              teamId,
              assignedToUserId: { in: reviewerIds },
              status: {
                in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"],
              },
              dueAt: { lt: now },
            },
            _count: { _all: true },
          }),
          prisma.evidenceReviewWorkflow.groupBy({
            by: ["assignedToUserId"],
            where: {
              teamId,
              assignedToUserId: { in: reviewerIds },
              status: {
                in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"],
              },
              dueAt: { gte: now, lt: dueSoonCutoff },
            },
            _count: { _all: true },
          }),
          prisma.evidenceReviewWorkflow.groupBy({
            by: ["assignedToUserId"],
            where: {
              teamId,
              assignedToUserId: { in: reviewerIds },
              lastReviewedAt: { not: null },
            },
            _max: { lastReviewedAt: true },
          }),
        ]);
      const userById = new Map(users.map((u) => [u.id, u]));
      const overdueById = new Map(
        overdueGroups
          .filter((g) => g.assignedToUserId)
          .map((g) => [g.assignedToUserId as string, g._count._all]),
      );
      const dueSoonById = new Map(
        dueSoonGroups
          .filter((g) => g.assignedToUserId)
          .map((g) => [g.assignedToUserId as string, g._count._all]),
      );
      const lastActionById = new Map(
        lastActions
          .filter((g) => g.assignedToUserId && g._max.lastReviewedAt)
          .map((g) => [
            g.assignedToUserId as string,
            g._max.lastReviewedAt as Date,
          ]),
      );
      topReviewers = grouped
        .filter(
          (g): g is typeof g & { assignedToUserId: string } =>
            g.assignedToUserId !== null,
        )
        .map((g) => {
          const lastAction = lastActionById.get(g.assignedToUserId) ?? null;
          const inactive =
            lastAction === null ||
            lastAction.getTime() < inactivityCutoff.getTime();
          if (inactive) inactiveReviewerCount += 1;
          return {
            userId: g.assignedToUserId,
            displayName: userById.get(g.assignedToUserId)?.displayName ?? null,
            email: userById.get(g.assignedToUserId)?.email ?? null,
            assignedCount: g._count._all,
            overdueCount: overdueById.get(g.assignedToUserId) ?? 0,
            dueSoonCount: dueSoonById.get(g.assignedToUserId) ?? 0,
            lastActionAtUtc: lastAction ? lastAction.toISOString() : null,
            inactive,
          };
        });
    }

    return {
      status: "ok",
      data: {
        queueDepth,
        overdueCount,
        dueSoonCount,
        unassignedCount,
        openEscalationsCount,
        completedLast7dCount,
        completedPrev7dCount,
        inactiveReviewerCount,
        topReviewers,
      },
    };
  } catch {
    return { status: "unavailable", data: null };
  }
}

// ---------------------------------------------------------------------------
// Section: Pipeline detail (granular)
// ---------------------------------------------------------------------------

async function runPipelineDetail(
  teamId: string,
): Promise<CommandCenterEnvelope["sections"]["pipelineDetail"]> {
  try {
    const stuckCutoff = new Date(
      Date.now() - STUCK_UPLOAD_HOURS * 60 * 60 * 1000,
    );
    const [grouped, stuckUploading, reportsReady, packagesReady, publicVerify] =
      await Promise.all([
        prisma.evidence.groupBy({
          by: ["status"],
          where: { teamId },
          _count: { _all: true },
        }),
        prisma.evidence.count({
          where: {
            teamId,
            status: "UPLOADING",
            updatedAt: { lt: stuckCutoff },
          },
        }),
        prisma.report.count({
          where: { evidence: { teamId } },
        }),
        prisma.verificationPackage.count({
          where: { evidence: { teamId } },
        }),
        prisma.evidence.groupBy({
          by: ["publicVerifyState"],
          where: { teamId },
          _count: { _all: true },
        }),
      ]);

    const stateCount = (s: string): number => {
      const row = grouped.find((g) => String(g.status) === s);
      return row ? row._count._all : 0;
    };
    const verifyCount = (s: string): number => {
      const row = publicVerify.find((g) => String(g.publicVerifyState) === s);
      return row ? row._count._all : 0;
    };

    const signed = stateCount("SIGNED");
    const reported = stateCount("REPORTED");
    const reportsQueued = Math.max(0, signed - reportsReady);
    const packagesQueued = Math.max(0, reported - packagesReady);

    // Failed report / package counts from open operational incidents.
    const [failedReports, failedPackages, blockedPackages] = await Promise.all([
      prisma.operationalIncident.count({
        where: {
          OR: [{ teamId }, { teamId: null }],
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
          category: "REPORT",
        },
      }),
      prisma.operationalIncident.count({
        where: {
          OR: [{ teamId }, { teamId: null }],
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
          category: "PACKAGE",
        },
      }),
      // Blocked packages — counted via JSON metadata flag.
      prisma.evidence
        .findMany({
          where: {
            teamId,
            status: { in: ["SIGNED", "REPORTED"] },
          },
          take: 500,
          select: { verificationPackageMetadata: true },
        })
        .then((rows) =>
          rows.reduce((n, r) => {
            const meta = r.verificationPackageMetadata as Record<
              string,
              unknown
            > | null;
            return meta && meta.blocked === true ? n + 1 : n;
          }, 0),
        )
        .catch(() => 0),
    ]);

    return {
      status: "ok",
      data: {
        evidence: {
          created: stateCount("CREATED"),
          uploading: stateCount("UPLOADING"),
          uploaded: stateCount("UPLOADED"),
          signed,
          reported,
          stuckUploading,
        },
        reports: {
          ready: reportsReady,
          queued: reportsQueued,
          failed: failedReports,
          missingFromSigned: reportsQueued,
        },
        packages: {
          ready: packagesReady,
          queued: packagesQueued,
          blocked: blockedPackages,
          failed: failedPackages,
          missingFromReported: packagesQueued,
        },
        publicVerify: {
          published: verifyCount("PUBLISHED"),
          unpublished: verifyCount("UNPUBLISHED"),
          suspended: verifyCount("SUSPENDED"),
        },
      },
    };
  } catch {
    return { status: "unavailable", data: null };
  }
}

// ---------------------------------------------------------------------------
// Section: Governance posture (extended)
// ---------------------------------------------------------------------------

async function runGovernancePosture(
  teamId: string,
  scope: WorkspaceScope,
): Promise<CommandCenterEnvelope["sections"]["governancePosture"]> {
  if (scope === "PERSONAL") {
    return { status: "not_applicable", data: null };
  }
  let anyOk = false;
  let anyFailed = false;
  let activeLegalHoldsCount = 0;
  let activeCaseLegalHoldsCount = 0;
  let retentionCandidatesCount = 0;
  let pendingDestructionReviewsCount = 0;
  let activePoliciesCount = 0;
  let policyConflictsCount = 0;
  let blockedExportsCount = 0;
  let recentLifecycleEventsCount = 0;

  try {
    activeLegalHoldsCount = await prisma.evidenceLegalHold.count({
      where: { teamId, status: "ACTIVE" },
    });
    anyOk = true;
  } catch {
    anyFailed = true;
  }

  try {
    activeCaseLegalHoldsCount = await prisma.caseLegalHold.count({
      where: { teamId, status: "ACTIVE" },
    });
    anyOk = true;
  } catch {
    /* optional subsystem */
  }

  try {
    pendingDestructionReviewsCount = await prisma.destructionReview.count({
      where: {
        teamId,
        status: { in: ["PROPOSED", "PENDING_APPROVAL"] },
      },
    });
    retentionCandidatesCount = await prisma.destructionReview.count({
      where: { teamId, status: "PROPOSED" },
    });
    anyOk = true;
  } catch {
    anyFailed = true;
  }

  try {
    activePoliciesCount = await prisma.evidenceRetentionPolicy.count({
      where: { teamId, status: "ACTIVE" },
    });
    anyOk = true;
  } catch {
    anyFailed = true;
  }

  try {
    const { countActivePolicyConflicts } = await import(
      "../governance-lifecycle/retention-engine.service.js"
    );
    policyConflictsCount = await countActivePolicyConflicts(teamId);
    anyOk = true;
  } catch {
    /* best-effort */
  }

  try {
    const sample = await prisma.evidence.findMany({
      where: {
        teamId,
        status: { in: ["SIGNED", "REPORTED"] },
      },
      take: 500,
      select: { verificationPackageMetadata: true },
    });
    for (const row of sample) {
      const meta = row.verificationPackageMetadata as Record<
        string,
        unknown
      > | null;
      if (meta && meta.blocked === true) blockedExportsCount += 1;
    }
    anyOk = true;
  } catch {
    /* best-effort */
  }

  try {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    recentLifecycleEventsCount = await prisma.evidenceLifecycleEvent.count({
      where: { teamId, createdAt: { gte: since7d } },
    });
    anyOk = true;
  } catch {
    /* best-effort */
  }

  return {
    status: !anyOk ? "unavailable" : anyFailed ? "degraded" : "ok",
    data: anyOk
      ? {
          activeLegalHoldsCount,
          activeCaseLegalHoldsCount,
          retentionCandidatesCount,
          pendingDestructionReviewsCount,
          activePoliciesCount,
          policyConflictsCount,
          blockedExportsCount,
          recentLifecycleEventsCount,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Section: Organizational intelligence
// ---------------------------------------------------------------------------

async function runOrganizationalIntelligence(
  teamId: string,
): Promise<CommandCenterEnvelope["sections"]["organizationalIntelligence"]> {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      evidenceCreatedLast24h,
      evidenceCreatedLast7d,
      evidenceFinalizedLast7d,
      reportsGeneratedLast7d,
      packagesGeneratedLast7d,
      activityLast7d,
    ] = await Promise.all([
      prisma.evidence.count({
        where: { teamId, createdAt: { gte: since24h } },
      }),
      prisma.evidence.count({
        where: { teamId, createdAt: { gte: since7d } },
      }),
      prisma.evidence.count({
        where: {
          teamId,
          status: { in: ["SIGNED", "REPORTED"] },
          updatedAt: { gte: since7d },
        },
      }),
      prisma.report.count({
        where: {
          evidence: { teamId },
          generatedAtUtc: { gte: since7d },
        },
      }),
      prisma.verificationPackage.count({
        where: {
          evidence: { teamId },
          generatedAtUtc: { gte: since7d },
        },
      }),
      prisma.teamActivity
        .count({ where: { teamId, createdAt: { gte: since7d } } })
        .catch(() => 0),
    ]);

    return {
      status: "ok",
      data: {
        evidenceCreatedLast24h,
        evidenceCreatedLast7d,
        evidenceFinalizedLast7d,
        reportsGeneratedLast7d,
        packagesGeneratedLast7d,
        activityLast7d,
      },
    };
  } catch {
    return { status: "unavailable", data: null };
  }
}

// ---------------------------------------------------------------------------
// Section: Operational timeline (union of real events)
// ---------------------------------------------------------------------------

async function runTimeline(
  teamId: string,
): Promise<CommandCenterEnvelope["sections"]["timeline"]> {
  const items: TimelineEvent[] = [];
  let anyOk = false;
  let anyFailed = false;
  const since14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  // Evidence finalized (status changed to SIGNED/REPORTED — proxied by updatedAt)
  try {
    const rows = await prisma.evidence.findMany({
      where: {
        teamId,
        status: { in: ["SIGNED", "REPORTED"] },
        updatedAt: { gte: since14d },
      },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: { id: true, title: true, status: true, updatedAt: true },
    });
    anyOk = true;
    for (const r of rows) {
      items.push({
        id: `evidence_finalized:${r.id}:${r.updatedAt.getTime()}`,
        kind: "evidence_finalized",
        occurredAt: r.updatedAt.toISOString(),
        label: `Evidence ${r.status.toLowerCase()} — ${r.title ?? "Untitled"}`,
        subtitle: null,
        href: `/evidence/${r.id}`,
        severity: "info",
      });
    }
  } catch {
    anyFailed = true;
  }

  // Reports generated
  try {
    const rows = await prisma.report.findMany({
      where: {
        evidence: { teamId },
        generatedAtUtc: { gte: since14d },
      },
      orderBy: { generatedAtUtc: "desc" },
      take: 10,
      select: {
        id: true,
        evidenceId: true,
        version: true,
        generatedAtUtc: true,
      },
    });
    anyOk = true;
    for (const r of rows) {
      items.push({
        id: `report:${r.id}`,
        kind: "report_generated",
        occurredAt: r.generatedAtUtc.toISOString(),
        label: `Report generated · v${r.version}`,
        subtitle: null,
        href: `/evidence/${r.evidenceId}`,
        severity: "info",
      });
    }
  } catch {
    anyFailed = true;
  }

  // Verification packages
  try {
    const rows = await prisma.verificationPackage.findMany({
      where: {
        evidence: { teamId },
        generatedAtUtc: { gte: since14d },
      },
      orderBy: { generatedAtUtc: "desc" },
      take: 10,
      select: {
        id: true,
        evidenceId: true,
        version: true,
        generatedAtUtc: true,
      },
    });
    anyOk = true;
    for (const r of rows) {
      items.push({
        id: `package:${r.id}`,
        kind: "package_generated",
        occurredAt: r.generatedAtUtc.toISOString(),
        label: `Verification package generated · v${r.version}`,
        subtitle: null,
        href: `/evidence/${r.evidenceId}`,
        severity: "info",
      });
    }
  } catch {
    anyFailed = true;
  }

  // Lifecycle events
  try {
    const rows = await prisma.evidenceLifecycleEvent.findMany({
      where: { teamId, createdAt: { gte: since14d } },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: {
        id: true,
        eventType: true,
        summary: true,
        toState: true,
        evidenceId: true,
        createdAt: true,
      },
    });
    anyOk = true;
    for (const r of rows) {
      const isHold = r.eventType.startsWith("hold_");
      const isDestruction = r.eventType.includes("destruction");
      items.push({
        id: `lifecycle:${r.id}`,
        kind: isHold
          ? r.eventType === "hold_placed"
            ? "hold_placed"
            : "hold_released"
          : isDestruction
            ? "destruction_review"
            : "lifecycle_transition",
        occurredAt: r.createdAt.toISOString(),
        label: r.summary.slice(0, 140),
        subtitle: `→ ${r.toState}`,
        href: `/evidence/${r.evidenceId}`,
        severity: isHold || isDestruction ? "warning" : "info",
      });
    }
  } catch {
    /* lifecycle events optional */
  }

  // Escalations
  try {
    const rows = await prisma.reviewEscalation.findMany({
      where: { teamId, createdAt: { gte: since14d } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        severity: true,
        reason: true,
        workflowId: true,
        createdAt: true,
      },
    });
    anyOk = true;
    for (const r of rows) {
      items.push({
        id: `escalation_event:${r.id}`,
        kind: "escalation_opened",
        occurredAt: r.createdAt.toISOString(),
        label: `Escalation opened — ${humanize(String(r.reason))}`,
        subtitle: `Workflow ${r.workflowId.slice(0, 8)}`,
        href: "/reviewer-ops/escalations",
        severity: (r.severity === "CRITICAL"
          ? "critical"
          : r.severity === "HIGH"
            ? "high"
            : "warning") as SeverityTone,
      });
    }
  } catch {
    /* best-effort */
  }

  // Incidents
  try {
    const rows = await prisma.operationalIncident.findMany({
      where: {
        OR: [{ teamId }, { teamId: null }],
        firstSeenAtUtc: { gte: since14d },
      },
      orderBy: { firstSeenAtUtc: "desc" },
      take: 10,
      select: {
        id: true,
        title: true,
        category: true,
        severity: true,
        runbookSlug: true,
        firstSeenAtUtc: true,
      },
    });
    anyOk = true;
    for (const r of rows) {
      items.push({
        id: `incident_event:${r.id}`,
        kind: "incident_opened",
        occurredAt: r.firstSeenAtUtc.toISOString(),
        label: `Incident opened — ${r.title}`,
        subtitle: r.category,
        href: r.runbookSlug
          ? `/ops/runbooks#${r.runbookSlug}`
          : "/ops/observability",
        severity: (r.severity === "CRITICAL"
          ? "critical"
          : r.severity === "HIGH"
            ? "high"
            : "warning") as SeverityTone,
      });
    }
  } catch {
    anyFailed = true;
  }

  // Sort + cap
  items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  return {
    status: !anyOk ? "unavailable" : anyFailed ? "degraded" : "ok",
    items: items.slice(0, TIMELINE_LIMIT),
  };
}

// ---------------------------------------------------------------------------
// Section: Audit readiness
// ---------------------------------------------------------------------------

async function runAuditReadiness(
  teamId: string,
  scope: WorkspaceScope,
): Promise<CommandCenterEnvelope["sections"]["auditReadiness"]> {
  try {
    const unsignedAgeCutoff = new Date(
      Date.now() - UNSIGNED_EVIDENCE_AGE_DAYS * 24 * 60 * 60 * 1000,
    );
    const counters: AuditReadinessCounter[] = [];

    const unsignedOld = await prisma.evidence.count({
      where: {
        teamId,
        status: { in: ["CREATED", "UPLOADING", "UPLOADED"] },
        createdAt: { lt: unsignedAgeCutoff },
      },
    });
    counters.push({
      key: "unsigned_evidence_old",
      label: "Unsigned evidence > 7 days",
      value: unsignedOld,
      severity: unsignedOld > 0 ? "warning" : "info",
    });

    const missingReports = await prisma.evidence.count({
      where: { teamId, status: "SIGNED", reports: { none: {} } },
    });
    counters.push({
      key: "missing_reports",
      label: "Signed evidence without report",
      value: missingReports,
      severity: missingReports > 0 ? "warning" : "info",
    });

    const failedPackages = await prisma.operationalIncident.count({
      where: {
        OR: [{ teamId }, { teamId: null }],
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        category: "PACKAGE",
      },
    });
    counters.push({
      key: "failed_packages",
      label: "Failed package generations",
      value: failedPackages,
      severity: failedPackages > 0 ? "high" : "info",
    });

    if (scope === "TEAM") {
      const pendingGovReviews = await prisma.destructionReview
        .count({
          where: {
            teamId,
            status: { in: ["PROPOSED", "PENDING_APPROVAL"] },
          },
        })
        .catch(() => 0);
      counters.push({
        key: "pending_governance_reviews",
        label: "Pending destruction reviews",
        value: pendingGovReviews,
        severity: pendingGovReviews > 0 ? "warning" : "info",
      });

      const unresolvedEscalations = await prisma.reviewEscalation
        .count({ where: { teamId, status: "OPEN" } })
        .catch(() => 0);
      counters.push({
        key: "unresolved_escalations",
        label: "Unresolved reviewer escalations",
        value: unresolvedEscalations,
        severity: unresolvedEscalations > 0 ? "high" : "info",
      });

      const pendingReviewerSignoff = await prisma.evidenceReviewWorkflow.count({
        where: {
          teamId,
          status: { in: ["IN_REVIEW", "NEEDS_INFO"] },
        },
      });
      counters.push({
        key: "evidence_pending_reviewer_signoff",
        label: "Evidence pending reviewer signoff",
        value: pendingReviewerSignoff,
        severity: pendingReviewerSignoff > 0 ? "warning" : "info",
      });
    }

    // Blocked exports
    let blockedExportsCount = 0;
    try {
      const sample = await prisma.evidence.findMany({
        where: { teamId, status: { in: ["SIGNED", "REPORTED"] } },
        take: 500,
        select: { verificationPackageMetadata: true },
      });
      for (const row of sample) {
        const meta = row.verificationPackageMetadata as Record<
          string,
          unknown
        > | null;
        if (meta && meta.blocked === true) blockedExportsCount += 1;
      }
    } catch {
      /* best-effort */
    }
    counters.push({
      key: "blocked_exports",
      label: "Exports blocked by governance",
      value: blockedExportsCount,
      severity: blockedExportsCount > 0 ? "high" : "info",
    });

    return { status: "ok", counters };
  } catch {
    return { status: "unavailable", counters: [] };
  }
}

// ---------------------------------------------------------------------------
// Smaller legacy/auxiliary sections (preserved)
// ---------------------------------------------------------------------------

async function runRecentEvidence(
  teamId: string,
): Promise<CommandCenterEnvelope["sections"]["recentEvidence"]> {
  try {
    const items = await prisma.evidence.findMany({
      where: { teamId },
      orderBy: { createdAt: "desc" },
      take: RECENT_EVIDENCE_LIMIT,
      select: {
        id: true,
        title: true,
        status: true,
        verificationStatus: true,
        createdAt: true,
        caseId: true,
      },
    });
    return {
      status: "ok",
      items: items.map((e) => ({
        id: e.id,
        title: e.title ?? "Untitled evidence",
        status: e.status,
        verificationStatus: e.verificationStatus ?? null,
        createdAt: e.createdAt.toISOString(),
        caseId: e.caseId ?? null,
      })),
    };
  } catch {
    return { status: "unavailable", items: [] };
  }
}

async function runIncidents(
  teamId: string,
): Promise<CommandCenterEnvelope["sections"]["incidents"]> {
  try {
    const incidents = await prisma.operationalIncident.findMany({
      where: {
        OR: [{ teamId }, { teamId: null }],
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
      },
      orderBy: [{ severity: "desc" }, { lastSeenAtUtc: "desc" }],
      take: INCIDENTS_LIMIT,
      select: {
        id: true,
        category: true,
        severity: true,
        status: true,
        title: true,
        safeSummary: true,
        runbookSlug: true,
        occurrenceCount: true,
        lastSeenAtUtc: true,
      },
    });
    return {
      status: "ok",
      items: incidents.map((i) => ({
        id: i.id,
        category: String(i.category),
        severity: String(i.severity),
        status: String(i.status),
        title: i.title,
        safeSummary: i.safeSummary,
        runbookSlug: i.runbookSlug ?? null,
        occurrenceCount: i.occurrenceCount,
        lastSeenAtUtc: i.lastSeenAtUtc.toISOString(),
      })),
    };
  } catch {
    return { status: "unavailable", items: [] };
  }
}

async function runLegacyPipelineSummary(
  teamId: string,
): Promise<CommandCenterEnvelope["sections"]["pipeline"]> {
  try {
    const grouped = await prisma.evidence.groupBy({
      by: ["status"],
      where: { teamId },
      _count: { _all: true },
    });
    const data = { reported: 0, signed: 0, uploaded: 0, uploading: 0, created: 0 };
    for (const row of grouped) {
      switch (row.status) {
        case "REPORTED":
          data.reported = row._count._all;
          break;
        case "SIGNED":
          data.signed = row._count._all;
          break;
        case "UPLOADED":
          data.uploaded = row._count._all;
          break;
        case "UPLOADING":
          data.uploading = row._count._all;
          break;
        case "CREATED":
          data.created = row._count._all;
          break;
      }
    }
    return { status: "ok", data };
  } catch {
    return { status: "unavailable", data: null };
  }
}

async function runLegacyReviewerWorkload(
  teamId: string,
  scope: WorkspaceScope,
): Promise<CommandCenterEnvelope["sections"]["reviewerWorkload"]> {
  if (scope === "PERSONAL") return { status: "not_applicable", data: null };
  try {
    const now = new Date();
    const [queuedCount, assignedCount, inReviewCount, overdueCount, openEscalationsCount] =
      await Promise.all([
        prisma.evidenceReviewWorkflow.count({
          where: { teamId, status: "QUEUED" },
        }),
        prisma.evidenceReviewWorkflow.count({
          where: { teamId, status: "ASSIGNED" },
        }),
        prisma.evidenceReviewWorkflow.count({
          where: { teamId, status: "IN_REVIEW" },
        }),
        prisma.evidenceReviewWorkflow.count({
          where: {
            teamId,
            status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
            dueAt: { lt: now },
          },
        }),
        prisma.reviewEscalation.count({ where: { teamId, status: "OPEN" } }),
      ]);
    return {
      status: "ok",
      data: {
        queuedCount,
        assignedCount,
        inReviewCount,
        overdueCount,
        openEscalationsCount,
      },
    };
  } catch {
    return { status: "unavailable", data: null };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanize(s: string): string {
  return s
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function buildCommandCenter(input: {
  teamId: string;
  role: string;
}): Promise<CommandCenterEnvelope> {
  const { scope, memberCount } = await detectWorkspaceScope(input.teamId);

  const [
    pressure,
    caseOps,
    reviewerOrch,
    pipelineDetail,
    governance,
    organizational,
    timeline,
    auditReadiness,
    recentEvidence,
    incidents,
    legacyPipeline,
    legacyReviewer,
  ] = await Promise.all([
    runOperationalPressure(input.teamId, scope),
    runCaseOperations(input.teamId, scope),
    runReviewerOrchestration(input.teamId, scope),
    runPipelineDetail(input.teamId),
    runGovernancePosture(input.teamId, scope),
    runOrganizationalIntelligence(input.teamId),
    runTimeline(input.teamId),
    runAuditReadiness(input.teamId, scope),
    runRecentEvidence(input.teamId),
    runIncidents(input.teamId),
    runLegacyPipelineSummary(input.teamId),
    runLegacyReviewerWorkload(input.teamId, scope),
  ]);

  // Compose summary from real sections (no fake metrics).
  const summary: CommandCenterEnvelope["sections"]["summary"] = {
    status: "ok",
    data: {
      evidenceActiveCount:
        (pipelineDetail.data?.evidence.uploaded ?? 0) +
        (pipelineDetail.data?.evidence.uploading ?? 0) +
        (pipelineDetail.data?.evidence.signed ?? 0) +
        (pipelineDetail.data?.evidence.reported ?? 0) +
        (pipelineDetail.data?.evidence.created ?? 0),
      evidenceRecentCount: organizational.data?.evidenceCreatedLast7d ?? 0,
      reportReadyCount: pipelineDetail.data?.reports.ready ?? 0,
      reviewerPendingCount: reviewerOrch.data?.queueDepth ?? 0,
      governanceAttentionCount:
        (governance.data?.activeLegalHoldsCount ?? 0) +
        (governance.data?.pendingDestructionReviewsCount ?? 0) +
        (governance.data?.blockedExportsCount ?? 0),
      openIncidentsCount: incidents.items.length,
      operationalPressureCount: pressure.items.length,
      auditReadinessFlags: auditReadiness.counters.filter(
        (c) => c.severity !== "info" && c.value > 0,
      ).length,
    },
  };

  return {
    generatedAt: new Date().toISOString(),
    workspace: { id: input.teamId, role: input.role, scope, memberCount },
    sections: {
      summary,
      operationalPressure: pressure,
      attentionQueue: { status: pressure.status, items: pressure.items },
      caseOperations: caseOps,
      reviewerOrchestration: reviewerOrch,
      pipelineDetail,
      governancePosture: governance,
      organizationalIntelligence: organizational,
      timeline,
      auditReadiness,
      recentEvidence,
      pipeline: legacyPipeline,
      reviewerWorkload: legacyReviewer,
      incidents,
    },
  };
}
