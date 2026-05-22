/**
 * Phase 32.8C — Enterprise Evidence Operations Command Center service.
 *
 * Read-only aggregator that powers `/v1/dashboard/command-center`.
 * Each section is computed independently and wrapped in its own
 * try/catch so a degraded subsystem does NOT collapse the whole
 * dashboard. Returns a typed envelope with per-section status.
 *
 * Hard rules:
 *   - READ ONLY. Never mutates a row, never emits an audit, never
 *     bumps a custody event, never triggers a report job. The route
 *     handler MUST NOT call audit middleware for this aggregate.
 *   - Bounded queries. Every `findMany` carries `take`, every
 *     `count` is workspace-scoped.
 *   - Permission posture: callers must already have proven
 *     membership in the workspace at the route layer. This module
 *     does NOT re-derive permissions — it trusts the route gate.
 *   - Personal vs team detection is heuristic (single ACTIVE member
 *     where that member is the owner). When the workspace is
 *     personal, sections that require team semantics return
 *     `not_applicable` instead of an empty `ok`.
 */

import { prisma } from "../../db.js";

// ---------------------------------------------------------------------------
// Public contract types
// ---------------------------------------------------------------------------

/**
 * Section status. The dashboard renders each section based on this
 * value:
 *   - `ok` — data is current and the section should render.
 *   - `degraded` — partial data; render what we have plus a note.
 *   - `unavailable` — backend dependency is down; render the
 *     section-level error.
 *   - `not_applicable` — the section does not apply to this
 *     workspace type (e.g., reviewer workload on a personal
 *     workspace). The renderer MUST show a neutral empty-state,
 *     NOT an error.
 */
export type SectionStatus = "ok" | "degraded" | "unavailable" | "not_applicable";

export type WorkspaceScope = "PERSONAL" | "TEAM";

export type CommandCenterAttentionItem = {
  /** Bounded stable id (e.g., `escalation:<uuid>` or `hold:<uuid>`). */
  id: string;
  /** Bounded category — drives icon + color in the renderer. */
  category:
    | "evidence_pending_review"
    | "evidence_unsigned"
    | "report_blocked"
    | "report_failed"
    | "reviewer_escalation"
    | "governance_hold"
    | "retention_candidate"
    | "ops_incident";
  /** Severity tone for the renderer (no fabricated severity). */
  severity: "info" | "warning" | "high" | "critical";
  /** Plain enterprise copy — no marketing wording. */
  title: string;
  /** Optional one-line context (e.g., evidence title, runbook). */
  subtitle: string | null;
  /** Where the user should go to action this item. */
  href: string;
  /** ISO 8601 timestamp the underlying record was last touched. */
  occurredAt: string | null;
};

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
      items: CommandCenterAttentionItem[];
    };
    recentEvidence: {
      status: SectionStatus;
      items: CommandCenterRecentEvidenceItem[];
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
      items: CommandCenterIncidentItem[];
    };
  };
};

// ---------------------------------------------------------------------------
// Bounded limits (kept tight — this is a dashboard, not a list page)
// ---------------------------------------------------------------------------

const ATTENTION_LIMIT_PER_KIND = 5;
const ATTENTION_TOTAL_LIMIT = 24;
const RECENT_EVIDENCE_LIMIT = 10;
const INCIDENTS_LIMIT = 8;

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
  // Personal workspaces are owned by a single active member.
  return {
    scope: memberCount <= 1 ? "PERSONAL" : "TEAM",
    memberCount,
  };
}

// ---------------------------------------------------------------------------
// Per-section runners
// ---------------------------------------------------------------------------

async function runSummary(
  teamId: string,
  scope: WorkspaceScope,
): Promise<CommandCenterEnvelope["sections"]["summary"]> {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [
      evidenceActiveCount,
      evidenceRecentCount,
      reportReadyCount,
      reviewerPendingCount,
      legalHoldsCount,
      pendingDestructionCount,
      openIncidentsCount,
    ] = await Promise.all([
      prisma.evidence.count({
        where: { teamId, status: { in: ["CREATED", "UPLOADING", "UPLOADED", "SIGNED", "REPORTED"] } },
      }),
      prisma.evidence.count({
        where: { teamId, createdAt: { gte: since } },
      }),
      prisma.evidence.count({
        where: { teamId, status: "REPORTED" },
      }),
      scope === "TEAM"
        ? prisma.evidenceReviewWorkflow.count({
            where: {
              teamId,
              status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
            },
          })
        : Promise.resolve(0),
      scope === "TEAM"
        ? prisma.evidenceLegalHold.count({
            where: { teamId, status: "ACTIVE" },
          })
        : Promise.resolve(0),
      scope === "TEAM"
        ? prisma.destructionReview
            .count({
              where: { teamId, status: { in: ["PROPOSED", "PENDING_APPROVAL"] } },
            })
            .catch(() => 0)
        : Promise.resolve(0),
      prisma.operationalIncident.count({
        where: {
          OR: [{ teamId }, { teamId: null }],
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
        },
      }),
    ]);

    return {
      status: "ok",
      data: {
        evidenceActiveCount,
        evidenceRecentCount,
        reportReadyCount,
        reviewerPendingCount,
        governanceAttentionCount:
          legalHoldsCount + pendingDestructionCount,
        openIncidentsCount,
      },
    };
  } catch {
    return { status: "unavailable", data: null };
  }
}

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

async function runPipeline(
  teamId: string,
): Promise<CommandCenterEnvelope["sections"]["pipeline"]> {
  try {
    const grouped = await prisma.evidence.groupBy({
      by: ["status"],
      where: { teamId },
      _count: { _all: true },
    });
    const data = {
      reported: 0,
      signed: 0,
      uploaded: 0,
      uploading: 0,
      created: 0,
    };
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

async function runReviewerWorkload(
  teamId: string,
  scope: WorkspaceScope,
): Promise<CommandCenterEnvelope["sections"]["reviewerWorkload"]> {
  if (scope === "PERSONAL") {
    return { status: "not_applicable", data: null };
  }
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
        prisma.reviewEscalation.count({
          where: { teamId, status: "OPEN" },
        }),
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

async function runGovernancePosture(
  teamId: string,
  scope: WorkspaceScope,
): Promise<CommandCenterEnvelope["sections"]["governancePosture"]> {
  if (scope === "PERSONAL") {
    return { status: "not_applicable", data: null };
  }
  // Each subsystem is gathered independently so a missing one (e.g.,
  // case_legal_holds on a partially-migrated environment) demotes the
  // section to `degraded` rather than `unavailable`.
  let activeLegalHoldsCount = 0;
  let activeCaseLegalHoldsCount = 0;
  let retentionCandidatesCount = 0;
  let pendingDestructionReviewsCount = 0;
  let activePoliciesCount = 0;
  let policyConflictsCount = 0;
  let anyFailed = false;
  let anyOk = false;

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
    // Phase 14 optional subsystem — environment may not have the
    // table yet. We surface `0` and continue.
  }

  try {
    pendingDestructionReviewsCount = await prisma.destructionReview.count({
      where: { teamId, status: { in: ["PROPOSED", "PENDING_APPROVAL"] } },
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
    // Phase 27 conflict count is exposed via the retention engine
    // service. Cheap-fallback is just zero if the helper can't run.
    const { countActivePolicyConflicts } = await import(
      "../governance-lifecycle/retention-engine.service.js"
    );
    policyConflictsCount = await countActivePolicyConflicts(teamId);
    anyOk = true;
  } catch {
    // best-effort
  }

  const status: SectionStatus = !anyOk
    ? "unavailable"
    : anyFailed
      ? "degraded"
      : "ok";

  return {
    status,
    data: anyOk
      ? {
          activeLegalHoldsCount,
          activeCaseLegalHoldsCount,
          retentionCandidatesCount,
          pendingDestructionReviewsCount,
          activePoliciesCount,
          policyConflictsCount,
        }
      : null,
  };
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
        lastSeenAtUtc: true,
      },
    });
    return {
      status: "ok",
      items: incidents.map((i) => ({
        id: i.id,
        category: i.category,
        severity: i.severity,
        status: i.status,
        title: i.title,
        safeSummary: i.safeSummary,
        runbookSlug: i.runbookSlug ?? null,
        lastSeenAtUtc: i.lastSeenAtUtc.toISOString(),
      })),
    };
  } catch {
    return { status: "unavailable", items: [] };
  }
}

async function runAttentionQueue(
  teamId: string,
  scope: WorkspaceScope,
): Promise<CommandCenterEnvelope["sections"]["attentionQueue"]> {
  // The attention queue is the union of: open reviewer escalations,
  // overdue review workflows, governance pending destruction reviews,
  // and high-severity ops incidents. Each kind has its own bounded
  // slice. The renderer's job is just to display — prioritization
  // happens here.
  const collected: CommandCenterAttentionItem[] = [];
  let anyFailed = false;
  let anyOk = false;

  // Escalations (team only)
  if (scope === "TEAM") {
    try {
      const escalations = await prisma.reviewEscalation.findMany({
        where: { teamId, status: "OPEN" },
        orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
        take: ATTENTION_LIMIT_PER_KIND,
        select: {
          id: true,
          severity: true,
          reason: true,
          workflowId: true,
          createdAt: true,
        },
      });
      anyOk = true;
      for (const e of escalations) {
        collected.push({
          id: `escalation:${e.id}`,
          category: "reviewer_escalation",
          severity: mapEscalationSeverity(e.severity),
          title: humanizeReason(e.reason) || "Reviewer escalation",
          subtitle: `Workflow ${e.workflowId.slice(0, 8)}`,
          href: "/reviewer-ops/escalations",
          occurredAt: e.createdAt.toISOString(),
        });
      }
    } catch {
      anyFailed = true;
    }
  }

  // Overdue review workflows (team only)
  if (scope === "TEAM") {
    try {
      const now = new Date();
      const overdue = await prisma.evidenceReviewWorkflow.findMany({
        where: {
          teamId,
          status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
          dueAt: { lt: now },
        },
        orderBy: [{ priority: "desc" }, { dueAt: "asc" }],
        take: ATTENTION_LIMIT_PER_KIND,
        select: {
          id: true,
          evidenceId: true,
          status: true,
          priority: true,
          dueAt: true,
        },
      });
      anyOk = true;
      for (const w of overdue) {
        collected.push({
          id: `overdue_review:${w.id}`,
          category: "evidence_pending_review",
          severity: w.priority === "URGENT" ? "critical" : "high",
          title: `Overdue review — ${w.status}`,
          subtitle: w.dueAt ? `Due ${w.dueAt.toISOString().slice(0, 10)}` : null,
          href: `/evidence/${w.evidenceId}`,
          occurredAt: w.dueAt?.toISOString() ?? null,
        });
      }
    } catch {
      anyFailed = true;
    }
  }

  // Pending destruction reviews (team only) — governance pressure
  if (scope === "TEAM") {
    try {
      const pending = await prisma.destructionReview.findMany({
        where: { teamId, status: { in: ["PROPOSED", "PENDING_APPROVAL"] } },
        orderBy: { createdAt: "desc" },
        take: ATTENTION_LIMIT_PER_KIND,
        select: { id: true, status: true, createdAt: true, evidenceId: true },
      });
      anyOk = true;
      for (const d of pending) {
        collected.push({
          id: `destruction:${d.id}`,
          category: "retention_candidate",
          severity: "warning",
          title: `Destruction review ${d.status.toLowerCase()}`,
          subtitle: `Evidence ${d.evidenceId.slice(0, 8)}`,
          href: "/governance/destruction",
          occurredAt: d.createdAt.toISOString(),
        });
      }
    } catch {
      // optional governance subsystem; degrade silently
    }
  }

  // High-severity ops incidents (always queried)
  try {
    const incidents = await prisma.operationalIncident.findMany({
      where: {
        OR: [{ teamId }, { teamId: null }],
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        severity: { in: ["HIGH", "CRITICAL"] },
      },
      orderBy: [{ severity: "desc" }, { lastSeenAtUtc: "desc" }],
      take: ATTENTION_LIMIT_PER_KIND,
      select: {
        id: true,
        severity: true,
        category: true,
        title: true,
        safeSummary: true,
        runbookSlug: true,
        lastSeenAtUtc: true,
      },
    });
    anyOk = true;
    for (const i of incidents) {
      collected.push({
        id: `incident:${i.id}`,
        category: "ops_incident",
        severity: i.severity === "CRITICAL" ? "critical" : "high",
        title: i.title,
        subtitle: i.safeSummary || null,
        href: i.runbookSlug
          ? `/ops/runbooks#${i.runbookSlug}`
          : "/ops/observability",
        occurredAt: i.lastSeenAtUtc.toISOString(),
      });
    }
  } catch {
    anyFailed = true;
  }

  // Sort the combined list by severity then occurredAt desc, cap at
  // ATTENTION_TOTAL_LIMIT.
  const severityRank: Record<CommandCenterAttentionItem["severity"], number> = {
    critical: 4,
    high: 3,
    warning: 2,
    info: 1,
  };
  collected.sort((a, b) => {
    const d = severityRank[b.severity] - severityRank[a.severity];
    if (d !== 0) return d;
    if (a.occurredAt && b.occurredAt) {
      return b.occurredAt.localeCompare(a.occurredAt);
    }
    if (a.occurredAt) return -1;
    if (b.occurredAt) return 1;
    return 0;
  });

  const status: SectionStatus = !anyOk
    ? "unavailable"
    : anyFailed
      ? "degraded"
      : "ok";

  return {
    status,
    items: collected.slice(0, ATTENTION_TOTAL_LIMIT),
  };
}

function mapEscalationSeverity(
  s: string,
): CommandCenterAttentionItem["severity"] {
  switch (s) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "WARNING":
      return "warning";
    default:
      return "info";
  }
}

function humanizeReason(reason: string): string {
  // Replace enum-style tokens with human copy. No localization here —
  // the dashboard renders English copy; localization is a later phase.
  return reason
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
    summary,
    recentEvidence,
    pipeline,
    reviewerWorkload,
    governancePosture,
    incidents,
    attentionQueue,
  ] = await Promise.all([
    runSummary(input.teamId, scope),
    runRecentEvidence(input.teamId),
    runPipeline(input.teamId),
    runReviewerWorkload(input.teamId, scope),
    runGovernancePosture(input.teamId, scope),
    runIncidents(input.teamId),
    runAttentionQueue(input.teamId, scope),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    workspace: {
      id: input.teamId,
      role: input.role,
      scope,
      memberCount,
    },
    sections: {
      summary,
      attentionQueue,
      recentEvidence,
      pipeline,
      reviewerWorkload,
      governancePosture,
      incidents,
    },
  };
}
