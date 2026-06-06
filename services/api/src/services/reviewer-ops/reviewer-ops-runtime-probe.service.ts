import type { PrismaClient } from "@prisma/client";
import { DISAGREEMENT_STATES, REVIEW_ESCALATION_STATUSES } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  countPendingQcSamples,
  getQcAccuracy7d,
} from "../reviewer-workspace/qc-sample.service.js";

const WORKFLOW_STATUS_KEYS = [
  "NOT_STARTED",
  "IN_REVIEW",
  "NEEDS_INFO",
  "READY_FOR_EXTERNAL_REVIEW",
  "ESCALATED",
  "APPROVED_INTERNAL",
  "REJECTED_INSUFFICIENT",
  "RESPONSE_RECEIVED",
  "REOPENED",
  "QUEUED",
  "ASSIGNED",
  "CLOSED",
] as const;

const REMINDER_STATUSES = ["SCHEDULED", "DELIVERED", "FAILED", "SUPPRESSED"] as const;
const CODING_SCHEMA_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;

type WorkflowStatusKey = (typeof WORKFLOW_STATUS_KEYS)[number];
type ReminderStatusKey = (typeof REMINDER_STATUSES)[number];
type CodingSchemaStatusKey = (typeof CODING_SCHEMA_STATUSES)[number];
type DisagreementState = (typeof DISAGREEMENT_STATES)[number];

type EnvLike = Record<string, string | undefined>;

function envBoolean(env: EnvLike, key: string, defaultWhenUnset: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === null || raw === "") return defaultWhenUnset;
  return new Set(["1", "true", "TRUE", "yes", "YES", "on", "ON"]).has(raw);
}

function initializeStatusMap<Keys extends readonly string[]>(keys: Keys) {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<Keys[number], number>;
}

export type ReviewerOpsRuntimeProbe = {
  teamId: string;
  workflowCounts: {
    total: number;
    byStatus: Record<WorkflowStatusKey, number>;
    queueCounts: {
      assigned: number;
      queued: number;
      inProgress: number;
      escalated: number;
      completed: number;
      readyForExternalReview: number;
    };
    schemaBinding: {
      withSchema: number;
      withoutSchema: number;
    };
  };
  decisionCounts: { total: number };
  disagreementCounts: {
    total: number;
    byState: Record<DisagreementState, number>;
  };
  qcSampleCounts: {
    pending: number;
    rendered7d: number;
    failureRate7dPct: number;
  };
  escalationCounts: {
    total: number;
    byStatus: Record<typeof REVIEW_ESCALATION_STATUSES[number], number>;
  };
  reminderCounts: {
    total: number;
    byStatus: Record<ReminderStatusKey, number>;
  };
  schemaCounts: {
    total: number;
    byStatus: Record<CodingSchemaStatusKey, number>;
  };
  sla: {
    workspacePolicyConfigured: boolean;
    workspacePolicyFlags: {
      requireStepUpForApprove: boolean;
      requireStepUpForReject: boolean;
      requireStepUpForEscalationResolve: boolean;
      requireStepUpForBulk: boolean;
      reviewerInactivityHours: number | null;
    };
  };
  metrics: {
    throughput7d: number;
    approvalRate7dPct: number;
    escalationRate7dPct: number;
    disagreementRate7dPct: number;
    qcFailureRate7dPct: number;
    avgReviewDurationMs7d: number;
  };
  reconciliation: {
    enabled: boolean;
  };
};

export async function buildReviewerOpsRuntimeProbe(input: {
  teamId: string;
  prisma?: PrismaClient;
  env?: EnvLike;
}): Promise<ReviewerOpsRuntimeProbe> {
  const prisma = input.prisma ?? defaultPrisma;
  const teamId = input.teamId;
  const env = input.env ?? process.env;
  const sinceWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    workflowStatuses,
    escalationStatuses,
    reminderStatuses,
    disagreementStatuses,
    schemaStatuses,
    decisionCount,
    disagreementCount,
    qcPendingCounts,
    qcAccuracy,
    reviewDecisions7d,
    qcSamples7d,
    completedWorkflows7d,
    escalated7d,
    workspacePolicyRow,
    workflowsWithSchemaCount,
  ] = await Promise.all([
    prisma.evidenceReviewWorkflow.groupBy({
      by: ["status"],
      where: { teamId },
      _count: { _all: true },
    }),
    prisma.reviewEscalation.groupBy({
      by: ["status"],
      where: { teamId },
      _count: { _all: true },
    }),
    prisma.reviewerOpsReminder.groupBy({
      by: ["status"],
      where: { teamId },
      _count: { _all: true },
    }),
    prisma.reviewerDisagreement.groupBy({
      by: ["state"],
      where: { teamId },
      _count: { _all: true },
    }),
    prisma.codingSchema.groupBy({
      by: ["status"],
      where: { teamId },
      _count: { _all: true },
    }),
    prisma.workflowReviewDecision.count({ where: { teamId } }),
    prisma.reviewerDisagreement.count({ where: { teamId } }),
    countPendingQcSamples({ teamId, prisma }),
    getQcAccuracy7d({ teamId, prisma }),
    prisma.workflowReviewDecision.findMany({
      where: { teamId, decidedAt: { gte: sinceWeek } },
      select: { decision: true, workflowId: true },
      take: 10_000,
    }),
    prisma.qcSample.findMany({
      where: {
        teamId,
        state: "VERDICT_RENDERED",
        renderedAtUtc: { gte: sinceWeek },
      },
      select: { verdict: true },
      take: 5_000,
    }),
    prisma.evidenceReviewWorkflow.findMany({
      where: { teamId, completedAtUtc: { gte: sinceWeek } },
      select: {
        assignedAtUtc: true,
        lastReviewedAt: true,
        completedAtUtc: true,
      },
      take: 5_000,
    }),
    prisma.evidenceReviewWorkflow.count({
      where: { teamId, escalatedAtUtc: { gte: sinceWeek } },
    }),
    prisma.workspaceGovernancePolicy.findUnique({
      where: { teamId },
      select: {
        defaultAssignmentDueHours: true,
        defaultFirstResponseDueHours: true,
        defaultCompletionDueHours: true,
        defaultEscalationDueHours: true,
        defaultDueSoonHours: true,
        requireStepUpForApprove: true,
        requireStepUpForReject: true,
        requireStepUpForEscalationResolve: true,
        requireStepUpForBulk: true,
        reviewerInactivityHours: true,
      },
    }),
    prisma.evidenceReviewWorkflow.count({
      where: { teamId, codingSchemaId: { not: null } },
    }),
  ]);

  const workflowCountsByStatus = initializeStatusMap(WORKFLOW_STATUS_KEYS);
  let workflowTotal = 0;
  for (const row of workflowStatuses) {
    const status = row.status as WorkflowStatusKey;
    workflowCountsByStatus[status] = row._count._all ?? 0;
    workflowTotal += row._count._all ?? 0;
  }

  const escalationCountsByStatus = initializeStatusMap(REVIEW_ESCALATION_STATUSES);
  let escalationTotal = 0;
  for (const row of escalationStatuses) {
    const status = row.status as typeof REVIEW_ESCALATION_STATUSES[number];
    escalationCountsByStatus[status] = row._count._all ?? 0;
    escalationTotal += row._count._all ?? 0;
  }

  const reminderCountsByStatus = initializeStatusMap(REMINDER_STATUSES);
  let reminderTotal = 0;
  for (const row of reminderStatuses) {
    const status = row.status as ReminderStatusKey;
    reminderCountsByStatus[status] = row._count._all ?? 0;
    reminderTotal += row._count._all ?? 0;
  }

  const disagreementCountsByState = initializeStatusMap(DISAGREEMENT_STATES);
  for (const row of disagreementStatuses) {
    const state = row.state as DisagreementState;
    disagreementCountsByState[state] = row._count._all ?? 0;
  }

  const schemaCountsByStatus = initializeStatusMap(CODING_SCHEMA_STATUSES);
  let schemaTotal = 0;
  for (const row of schemaStatuses) {
    const status = row.status as CodingSchemaStatusKey;
    schemaCountsByStatus[status] = row._count._all ?? 0;
    schemaTotal += row._count._all ?? 0;
  }

  const total7d = reviewDecisions7d.length;
  const approved7d = reviewDecisions7d.filter((decision) => decision.decision === "APPROVE").length;
  const failureCount7d = qcSamples7d.filter((sample) => sample.verdict === "FAIL").length;
  const durationMs: number[] = [];
  for (const workflow of completedWorkflows7d) {
    const start = workflow.assignedAtUtc ?? workflow.lastReviewedAt;
    const end = workflow.completedAtUtc;
    if (start && end) {
      const delta = end.getTime() - start.getTime();
      if (Number.isFinite(delta) && delta > 0) {
        durationMs.push(delta);
      }
    }
  }

  return {
    teamId,
    workflowCounts: {
      total: workflowTotal,
      byStatus: workflowCountsByStatus,
      queueCounts: {
        assigned: workflowCountsByStatus.ASSIGNED,
        queued: workflowCountsByStatus.QUEUED,
        inProgress: workflowCountsByStatus.IN_REVIEW,
        escalated: workflowCountsByStatus.ESCALATED,
        completed:
          workflowCountsByStatus.APPROVED_INTERNAL +
          workflowCountsByStatus.REJECTED_INSUFFICIENT +
          workflowCountsByStatus.CLOSED,
        readyForExternalReview: workflowCountsByStatus.READY_FOR_EXTERNAL_REVIEW,
      },
      schemaBinding: {
        withSchema: workflowsWithSchemaCount,
        withoutSchema: workflowTotal - workflowsWithSchemaCount,
      },
    },
    decisionCounts: { total: decisionCount },
    disagreementCounts: {
      total: disagreementCount,
      byState: disagreementCountsByState,
    },
    qcSampleCounts: {
      pending: qcPendingCounts.pendingCount,
      rendered7d: qcAccuracy.rendered,
      failureRate7dPct: qcAccuracy.failureRatePct,
    },
    escalationCounts: {
      total: escalationTotal,
      byStatus: escalationCountsByStatus,
    },
    reminderCounts: {
      total: reminderTotal,
      byStatus: reminderCountsByStatus,
    },
    schemaCounts: {
      total: schemaTotal,
      byStatus: schemaCountsByStatus,
    },
    sla: {
      workspacePolicyConfigured: workspacePolicyRow !== null,
      workspacePolicyFlags: {
        requireStepUpForApprove: workspacePolicyRow?.requireStepUpForApprove ?? false,
        requireStepUpForReject: workspacePolicyRow?.requireStepUpForReject ?? false,
        requireStepUpForEscalationResolve:
          workspacePolicyRow?.requireStepUpForEscalationResolve ?? false,
        requireStepUpForBulk: workspacePolicyRow?.requireStepUpForBulk ?? false,
        reviewerInactivityHours: workspacePolicyRow?.reviewerInactivityHours ?? null,
      },
    },
    metrics: {
      throughput7d: total7d,
      approvalRate7dPct: total7d === 0 ? 0 : Math.round((approved7d * 100) / total7d),
      escalationRate7dPct:
        total7d === 0 ? 0 : Math.round((escalated7d * 100) / total7d),
      disagreementRate7dPct:
        total7d === 0 ? 0 : Math.round((disagreementCount * 100) / total7d),
      qcFailureRate7dPct:
        qcSamples7d.length === 0
          ? 0
          : Math.round((failureCount7d * 100) / qcSamples7d.length),
      avgReviewDurationMs7d:
        durationMs.length > 0
          ? Math.round(durationMs.reduce((acc, value) => acc + value, 0) / durationMs.length)
          : 0,
    },
    reconciliation: {
      enabled: envBoolean(env, "REVIEWER_OPS_RECONCILIATION_ENABLED", true),
    },
  };
}
