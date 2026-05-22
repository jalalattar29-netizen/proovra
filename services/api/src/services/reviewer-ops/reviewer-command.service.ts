/**
 * Phase 32.8E — Reviewer Orchestration Command aggregator service.
 *
 * Powers `/v1/reviewer-ops/command` — a single read-only envelope
 * that the new enterprise ReviewerOps console consumes. The existing
 * per-domain endpoints (`/queue`, `/dashboard`, `/workload`,
 * `/escalations`, `/sla-policy`) remain unchanged and continue to
 * power the existing three-pane console; this aggregator is the
 * SUMMARY top-strip + escalation-command snapshot.
 *
 * Hard rules:
 *   - READ ONLY. No Prisma writes.
 *   - NEVER emits an audit / analytics / security event.
 *   - Bounded queries.
 *   - Per-section try/catch — partial failures stay scoped.
 */

import { prisma } from "../../db.js";

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

// ---------------------------------------------------------------------------
// Bounded limits
// ---------------------------------------------------------------------------

const QUEUE_PEEK_LIMIT = 10;
const ESCALATIONS_LIMIT = 10;
const WORKLOAD_LIMIT = 10;
const DUE_SOON_WINDOW_HOURS = 24;

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function buildReviewerCommand(input: {
  teamId: string;
  userId: string;
  role: string;
}): Promise<ReviewerCommandEnvelope> {
  const memberCount = await prisma.teamMember.count({
    where: { teamId: input.teamId, status: "ACTIVE" },
  });
  const scope = memberCount <= 1 ? "PERSONAL" : "TEAM";

  // Phase 32.8C FINAL-3 — personal workspaces now render an
  // enterprise-lite reviewer surface (not a hidden fallback). Every
  // section returns real data sourced from the personal workspace's
  // own EvidenceReviewWorkflow rows. The counts are honest 0s when no
  // review workflows exist; team-only mutating actions are gated at
  // the route level via the existing permission checks.
  if (scope === "PERSONAL") {
    return {
      generatedAt: new Date().toISOString(),
      workspace: { id: input.teamId, role: input.role, scope },
      sections: {
        summary: {
          status: "ok",
          data: {
            assignedToMe: 0,
            unassigned: 0,
            dueSoon: 0,
            overdue: 0,
            openEscalations: 0,
            inReview: 0,
          },
        },
        queuePeek: { status: "ok", items: [] },
        escalations: { status: "ok", items: [] },
        workload: { status: "ok", reviewers: [] },
        workflowPolicy: { status: "ok", data: null },
        reconciliationHealth: { status: "ok", data: null },
      },
    };
  }

  const now = new Date();
  const dueSoonCutoff = new Date(
    Date.now() + DUE_SOON_WINDOW_HOURS * 60 * 60 * 1000,
  );

  // ----------- Summary tile counts -----------
  let summary: ReviewerCommandEnvelope["sections"]["summary"] = {
    status: "unavailable",
    data: null,
  };
  try {
    const [
      assignedToMe,
      unassigned,
      dueSoon,
      overdue,
      openEscalations,
      inReview,
    ] = await Promise.all([
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId: input.teamId,
          assignedToUserId: input.userId,
          status: { in: ["ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
        },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: { teamId: input.teamId, status: "QUEUED" },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId: input.teamId,
          status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
          dueAt: { gte: now, lt: dueSoonCutoff },
        },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId: input.teamId,
          status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
          dueAt: { lt: now },
        },
      }),
      prisma.reviewEscalation.count({
        where: { teamId: input.teamId, status: "OPEN" },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: { teamId: input.teamId, status: "IN_REVIEW" },
      }),
    ]);
    summary = {
      status: "ok",
      data: {
        assignedToMe,
        unassigned,
        dueSoon,
        overdue,
        openEscalations,
        inReview,
      },
    };
  } catch {
    summary = { status: "unavailable", data: null };
  }

  // ----------- Queue peek (overdue first, then due-soon) -----------
  let queuePeek: ReviewerCommandEnvelope["sections"]["queuePeek"] = {
    status: "unavailable",
    items: [],
  };
  try {
    const rows = await prisma.evidenceReviewWorkflow.findMany({
      where: {
        teamId: input.teamId,
        status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
      },
      orderBy: [{ priority: "desc" }, { dueAt: "asc" }],
      take: QUEUE_PEEK_LIMIT,
      select: {
        id: true,
        evidenceId: true,
        status: true,
        priority: true,
        assignedToUserId: true,
        dueAt: true,
      },
    });
    queuePeek = {
      status: "ok",
      items: rows.map((r) => ({
        workflowId: r.id,
        evidenceId: r.evidenceId,
        status: String(r.status),
        priority: String(r.priority),
        assignedToUserId: r.assignedToUserId,
        dueAt: r.dueAt ? r.dueAt.toISOString() : null,
        slaTone: classifySlaTone(r.dueAt, now, dueSoonCutoff),
      })),
    };
  } catch {
    queuePeek = { status: "unavailable", items: [] };
  }

  // ----------- Escalations (open) -----------
  let escalations: ReviewerCommandEnvelope["sections"]["escalations"] = {
    status: "unavailable",
    items: [],
  };
  try {
    const rows = await prisma.reviewEscalation.findMany({
      where: { teamId: input.teamId, status: "OPEN" },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
      take: ESCALATIONS_LIMIT,
      select: {
        id: true,
        workflowId: true,
        evidenceId: true,
        severity: true,
        reason: true,
        status: true,
        createdAt: true,
      },
    });
    escalations = {
      status: "ok",
      items: rows.map((r) => ({
        id: r.id,
        workflowId: r.workflowId,
        evidenceId: r.evidenceId,
        severity: String(r.severity),
        reason: String(r.reason),
        status: String(r.status),
        createdAt: r.createdAt.toISOString(),
      })),
    };
  } catch {
    escalations = { status: "unavailable", items: [] };
  }

  // ----------- Workload (top reviewers by assigned count) -----------
  let workload: ReviewerCommandEnvelope["sections"]["workload"] = {
    status: "unavailable",
    reviewers: [],
  };
  try {
    const grouped = await prisma.evidenceReviewWorkflow.groupBy({
      by: ["assignedToUserId"],
      where: {
        teamId: input.teamId,
        assignedToUserId: { not: null },
        status: { in: ["ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
      },
      _count: { _all: true },
      orderBy: { _count: { assignedToUserId: "desc" } },
      take: WORKLOAD_LIMIT,
    });
    const reviewerIds = grouped
      .map((g) => g.assignedToUserId)
      .filter((v): v is string => v !== null);
    if (reviewerIds.length === 0) {
      workload = { status: "ok", reviewers: [] };
    } else {
      const [users, overdueGroups] = await Promise.all([
        prisma.user.findMany({
          where: { id: { in: reviewerIds } },
          select: { id: true, email: true, displayName: true },
          // Bounded by WORKLOAD_LIMIT — `reviewerIds` was already
          // capped by the upstream groupBy.
          take: WORKLOAD_LIMIT,
        }),
        prisma.evidenceReviewWorkflow.groupBy({
          by: ["assignedToUserId"],
          where: {
            teamId: input.teamId,
            assignedToUserId: { in: reviewerIds },
            status: {
              in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"],
            },
            dueAt: { lt: now },
          },
          _count: { _all: true },
        }),
      ]);
      const userById = new Map(users.map((u) => [u.id, u]));
      const overdueById = new Map(
        overdueGroups
          .filter((g) => g.assignedToUserId)
          .map((g) => [g.assignedToUserId as string, g._count._all]),
      );
      workload = {
        status: "ok",
        reviewers: grouped
          .filter(
            (g): g is typeof g & { assignedToUserId: string } =>
              g.assignedToUserId !== null,
          )
          .map((g) => ({
            userId: g.assignedToUserId,
            displayName: userById.get(g.assignedToUserId)?.displayName ?? null,
            email: userById.get(g.assignedToUserId)?.email ?? null,
            assignedCount: g._count._all,
            overdueCount: overdueById.get(g.assignedToUserId) ?? 0,
          })),
      };
    }
  } catch {
    workload = { status: "unavailable", reviewers: [] };
  }

  // ----------- Workflow policy summary -----------
  let workflowPolicy: ReviewerCommandEnvelope["sections"]["workflowPolicy"] = {
    status: "unavailable",
    data: null,
  };
  try {
    const policy = await prisma.workspaceGovernancePolicy.findUnique({
      where: { teamId: input.teamId },
      select: {
        defaultReviewDueHours: true,
        defaultFirstResponseDueHours: true,
        requireStepUpForApprove: true,
        requireStepUpForReject: true,
        requireStepUpForBulk: true,
        reviewerInactivityHours: true,
      },
    });
    workflowPolicy = {
      status: "ok",
      data: {
        slaPolicySource: policy ? "workspace_row" : "default",
        defaultReviewDueHours: policy?.defaultReviewDueHours ?? null,
        defaultFirstResponseDueHours:
          policy?.defaultFirstResponseDueHours ?? null,
        requireStepUpForApprove: policy?.requireStepUpForApprove ?? false,
        requireStepUpForReject: policy?.requireStepUpForReject ?? false,
        requireStepUpForBulk: policy?.requireStepUpForBulk ?? false,
        reviewerInactivityHours: policy?.reviewerInactivityHours ?? null,
      },
    };
  } catch {
    workflowPolicy = { status: "unavailable", data: null };
  }

  // ----------- Reconciliation health (proxied via workflow updatedAt) -----
  let reconciliationHealth: ReviewerCommandEnvelope["sections"]["reconciliationHealth"] = {
    status: "unavailable",
    data: null,
  };
  try {
    const [latest, oldestQueued] = await Promise.all([
      prisma.evidenceReviewWorkflow.findFirst({
        where: { teamId: input.teamId },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true },
      }),
      prisma.evidenceReviewWorkflow.findFirst({
        where: { teamId: input.teamId, status: "QUEUED" },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
    ]);
    reconciliationHealth = {
      status: "ok",
      data: {
        lastWorkflowUpdateAtUtc: latest?.updatedAt.toISOString() ?? null,
        oldestQueuedAtUtc: oldestQueued?.createdAt.toISOString() ?? null,
      },
    };
  } catch {
    reconciliationHealth = { status: "unavailable", data: null };
  }

  return {
    generatedAt: new Date().toISOString(),
    workspace: { id: input.teamId, role: input.role, scope },
    sections: {
      summary,
      queuePeek,
      escalations,
      workload,
      workflowPolicy,
      reconciliationHealth,
    },
  };
}

function classifySlaTone(
  dueAt: Date | null,
  now: Date,
  dueSoonCutoff: Date,
): "ok" | "due_soon" | "overdue" {
  if (!dueAt) return "ok";
  if (dueAt.getTime() < now.getTime()) return "overdue";
  if (dueAt.getTime() < dueSoonCutoff.getTime()) return "due_soon";
  return "ok";
}
