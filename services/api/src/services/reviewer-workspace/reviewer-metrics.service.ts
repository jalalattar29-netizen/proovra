/**
 * PROOVRA Phase 2A — Reviewer metrics aggregator.
 *
 *   getReviewerMetrics7d   — bounded 7-day metric ribbon for a reviewer
 *   getReviewerMetricsTeam — workspace-wide aggregate
 *
 * Bounded metrics:
 *   * throughput7d            — count of workflows the reviewer closed
 *                               in the last 7 days
 *   * approvalRate7dPct       — % of those closures that were
 *                               APPROVED_INTERNAL
 *   * escalationRate7dPct     — % of those closures that escalated
 *   * avgReviewDurationMs7d   — average duration from review start →
 *                               close
 *
 * Hard rules:
 *   * Reads only — no mutations.
 *   * Workspace-anchored.
 *   * NEVER asserts authenticity / admissibility — only operational
 *     metrics about reviewer activity.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export type ReviewerMetrics7d = {
  throughput7d: number;
  approvalRate7dPct: number;
  escalationRate7dPct: number;
  avgReviewDurationMs7d: number;
};

export async function getReviewerMetrics7d(input: {
  prisma?: PrismaClient;
  teamId: string;
  userId: string;
}): Promise<ReviewerMetrics7d> {
  const prisma = input.prisma ?? defaultPrisma;
  const since = new Date(Date.now() - SEVEN_DAYS_MS);
  // We compute throughput from WorkflowReviewDecision rows (one per
  // decision) authored by the user — bounded to last 7 days. Decisions
  // carry the canonical stage + bounded kind.
  const decisions = await prisma.workflowReviewDecision.findMany({
    where: {
      teamId: input.teamId,
      reviewerUserId: input.userId,
      decidedAt: { gte: since },
    },
    select: { decision: true, decidedAt: true, workflowId: true },
    take: 5_000,
  });
  if (decisions.length === 0) {
    return {
      throughput7d: 0,
      approvalRate7dPct: 0,
      escalationRate7dPct: 0,
      avgReviewDurationMs7d: 0,
    };
  }
  const approved = decisions.filter((d) => d.decision === "APPROVE").length;
  // Escalations in the canonical workflow model are NOT a decision
  // kind — they are a workflow `ESCALATED` status transition. Count
  // workflows the user escalated in the same window.
  const escalated = await prisma.evidenceReviewWorkflow.count({
    where: {
      teamId: input.teamId,
      escalatedByUserId: input.userId,
      escalatedAtUtc: { gte: since },
    },
  });

  // Average review duration — read workflow start + completion times.
  const workflowIds = Array.from(
    new Set(decisions.map((d) => d.workflowId)),
  );
  const workflows = await prisma.evidenceReviewWorkflow.findMany({
    where: { id: { in: workflowIds }, teamId: input.teamId },
    select: { id: true, lastReviewedAt: true, completedAtUtc: true, assignedAtUtc: true },
  });
  const durations: number[] = [];
  for (const w of workflows) {
    const start = w.assignedAtUtc ?? w.lastReviewedAt;
    const end = w.completedAtUtc;
    if (start && end) {
      const d = end.getTime() - start.getTime();
      if (Number.isFinite(d) && d > 0) durations.push(d);
    }
  }
  const avg =
    durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

  return {
    throughput7d: decisions.length,
    approvalRate7dPct: Math.round((approved * 100) / decisions.length),
    escalationRate7dPct: Math.round((escalated * 100) / decisions.length),
    avgReviewDurationMs7d: avg,
  };
}

export async function getReviewerMetricsTeam(input: {
  prisma?: PrismaClient;
  teamId: string;
}): Promise<{
  throughput7d: number;
  approvalRate7dPct: number;
  escalationRate7dPct: number;
  disagreementRate7dPct: number;
  qcFailureRate7dPct: number;
  avgReviewDurationMs7d: number;
}> {
  const prisma = input.prisma ?? defaultPrisma;
  const since = new Date(Date.now() - SEVEN_DAYS_MS);
  const [decisions, disagreements, qc, workflows] = await Promise.all([
    prisma.workflowReviewDecision.findMany({
      where: { teamId: input.teamId, decidedAt: { gte: since } },
      select: { decision: true, workflowId: true },
      take: 10_000,
    }),
    prisma.reviewerDisagreement.count({
      where: { teamId: input.teamId, filedAtUtc: { gte: since } },
    }),
    prisma.qcSample.findMany({
      where: {
        teamId: input.teamId,
        state: "VERDICT_RENDERED",
        renderedAtUtc: { gte: since },
      },
      select: { verdict: true },
      take: 5_000,
    }),
    prisma.evidenceReviewWorkflow.findMany({
      where: {
        teamId: input.teamId,
        completedAtUtc: { gte: since },
      },
      select: { lastReviewedAt: true, completedAtUtc: true, assignedAtUtc: true },
      take: 5_000,
    }),
  ]);
  const total = decisions.length;
  const approved = decisions.filter((d) => d.decision === "APPROVE").length;
  // Escalation count is on the workflow itself, not in the decision
  // table — count workflows that entered ESCALATED in the window.
  const escalated = await prisma.evidenceReviewWorkflow.count({
    where: {
      teamId: input.teamId,
      escalatedAtUtc: { gte: since },
    },
  });
  const qcFails = qc.filter((q) => q.verdict === "FAIL").length;

  const durations: number[] = [];
  for (const w of workflows) {
    const start = w.assignedAtUtc ?? w.lastReviewedAt;
    const end = w.completedAtUtc;
    if (start && end) {
      const d = end.getTime() - start.getTime();
      if (Number.isFinite(d) && d > 0) durations.push(d);
    }
  }
  const avg =
    durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

  return {
    throughput7d: total,
    approvalRate7dPct: total === 0 ? 0 : Math.round((approved * 100) / total),
    escalationRate7dPct:
      total === 0 ? 0 : Math.round((escalated * 100) / total),
    disagreementRate7dPct:
      total === 0 ? 0 : Math.round((disagreements * 100) / total),
    qcFailureRate7dPct:
      qc.length === 0 ? 0 : Math.round((qcFails * 100) / qc.length),
    avgReviewDurationMs7d: avg,
  };
}
