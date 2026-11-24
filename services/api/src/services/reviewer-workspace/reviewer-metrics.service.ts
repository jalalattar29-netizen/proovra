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

/*
 * T-056 (stage C) — every rate is defined PER REVIEW (numerator and
 * denominator are both reviews), and a figure with no denominator is null
 * ("No data"), never 0 % or "0s":
 *   - throughput7d          reviews with at least one decision in the window
 *   - approvalRate7dPct     of those, reviews with an APPROVE decision
 *   - escalationRate7dPct   reviews escalated in the window (ANY path: a
 *                           ReviewEscalation raised by reviewer ops, the
 *                           Evidence page or the engine, or an ESCALATED
 *                           status from a first/second conflict) ÷ reviews
 *                           decided or escalated in the window
 *   - avgReviewDurationMs7d mean assignment→completion of reviews completed in
 *                           the window; null when none completed
 * Personal figures restrict every set to the reader's own acts (their
 * decisions, the escalations they raised).
 */

export type ReviewerMetrics7d = {
  /** unit: reviews */
  throughput7d: number;
  approvalRate7dPct: number | null;
  escalationRate7dPct: number | null;
  avgReviewDurationMs7d: number | null;
};

function pct(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator * 100) / denominator);
}

function meanDuration(
  rows: ReadonlyArray<{ assignedAtUtc: Date | null; lastReviewedAt: Date | null; completedAtUtc: Date | null }>,
): number | null {
  const durations: number[] = [];
  for (const w of rows) {
    const start = w.assignedAtUtc ?? w.lastReviewedAt;
    const end = w.completedAtUtc;
    if (start && end) {
      const d = end.getTime() - start.getTime();
      if (Number.isFinite(d) && d > 0) durations.push(d);
    }
  }
  return durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
}

/** Reviews escalated in the window by any path (optionally by one person). */
async function escalatedReviewIds(
  prisma: PrismaClient,
  input: { teamId: string; since: Date; byUserId?: string },
): Promise<Set<string>> {
  const [rows, statusEscalated] = await Promise.all([
    prisma.reviewEscalation.findMany({
      where: {
        teamId: input.teamId,
        createdAt: { gte: input.since },
        ...(input.byUserId ? { createdByUserId: input.byUserId } : {}),
      },
      select: { workflowId: true },
      take: 10_000,
    }),
    prisma.evidenceReviewWorkflow.findMany({
      where: {
        teamId: input.teamId,
        escalatedAtUtc: { gte: input.since },
        ...(input.byUserId ? { escalatedByUserId: input.byUserId } : {}),
      },
      select: { id: true },
      take: 10_000,
    }),
  ]);
  return new Set([...rows.map((r) => r.workflowId), ...statusEscalated.map((w) => w.id)]);
}

export async function getReviewerMetrics7d(input: {
  prisma?: PrismaClient;
  teamId: string;
  userId: string;
}): Promise<ReviewerMetrics7d> {
  const prisma = input.prisma ?? defaultPrisma;
  const since = new Date(Date.now() - SEVEN_DAYS_MS);
  const decisions = await prisma.workflowReviewDecision.findMany({
    where: {
      teamId: input.teamId,
      reviewerUserId: input.userId,
      decidedAt: { gte: since },
    },
    select: { decision: true, workflowId: true },
    take: 5_000,
  });
  const decided = new Set(decisions.map((d) => d.workflowId));
  const approved = new Set(decisions.filter((d) => d.decision === "APPROVE").map((d) => d.workflowId));
  const escalated = await escalatedReviewIds(prisma, { teamId: input.teamId, since, byUserId: input.userId });
  const touched = new Set([...decided, ...escalated]);
  const workflows =
    decided.size === 0
      ? []
      : await prisma.evidenceReviewWorkflow.findMany({
          where: { id: { in: [...decided] }, teamId: input.teamId, completedAtUtc: { gte: since } },
          select: { lastReviewedAt: true, completedAtUtc: true, assignedAtUtc: true },
        });
  return {
    throughput7d: decided.size,
    approvalRate7dPct: pct(approved.size, decided.size),
    escalationRate7dPct: pct(escalated.size, touched.size),
    avgReviewDurationMs7d: meanDuration(workflows),
  };
}

export async function getReviewerMetricsTeam(input: {
  prisma?: PrismaClient;
  teamId: string;
}): Promise<{
  throughput7d: number;
  approvalRate7dPct: number | null;
  escalationRate7dPct: number | null;
  disagreementRate7dPct: number | null;
  qcFailureRate7dPct: number | null;
  avgReviewDurationMs7d: number | null;
  /** T-056 — the unit behind every figure. */
  units: { throughput7d: "reviews"; rates: "percent of reviews"; qcFailureRate7dPct: "percent of QC samples" };
}> {
  const prisma = input.prisma ?? defaultPrisma;
  const since = new Date(Date.now() - SEVEN_DAYS_MS);
  const [decisions, disagreements, qc, workflows, escalated] = await Promise.all([
    prisma.workflowReviewDecision.findMany({
      where: { teamId: input.teamId, decidedAt: { gte: since } },
      select: { decision: true, workflowId: true },
      take: 10_000,
    }),
    prisma.reviewerDisagreement.findMany({
      where: { teamId: input.teamId, filedAtUtc: { gte: since } },
      select: { workflowId: true },
      take: 10_000,
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
    escalatedReviewIds(prisma, { teamId: input.teamId, since }),
  ]);
  const decided = new Set(decisions.map((d) => d.workflowId));
  const approved = new Set(decisions.filter((d) => d.decision === "APPROVE").map((d) => d.workflowId));
  const disputed = new Set(disagreements.map((d) => d.workflowId).filter((id) => decided.has(id)));
  const touched = new Set([...decided, ...escalated]);
  const qcFails = qc.filter((q) => q.verdict === "FAIL").length;
  return {
    throughput7d: decided.size,
    approvalRate7dPct: pct(approved.size, decided.size),
    escalationRate7dPct: pct(escalated.size, touched.size),
    disagreementRate7dPct: pct(disputed.size, decided.size),
    qcFailureRate7dPct: pct(qcFails, qc.length),
    avgReviewDurationMs7d: meanDuration(workflows),
    units: { throughput7d: "reviews", rates: "percent of reviews", qcFailureRate7dPct: "percent of QC samples" },
  };
}
