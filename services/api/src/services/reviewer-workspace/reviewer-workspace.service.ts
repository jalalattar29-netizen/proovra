/**
 * PROOVRA Phase 2A — Reviewer Workspace aggregator.
 *
 * Single read that returns the bounded `ReviewerWorkspaceProjection`
 * shape the workspace UI consumes. Composes:
 *
 *   * Reviewer role + capabilities (reviewer-roles.ts)
 *   * Queue counts per bounded state (EvidenceReviewWorkflow)
 *   * Disagreement counts (ReviewerDisagreement)
 *   * QC counts + 7-day accuracy (qc-sample.service.ts)
 *   * Metrics ribbon (reviewer-metrics-aggregator.service.ts)
 *
 * Hard rules:
 *   * Workspace-anchored: every count filters on teamId.
 *   * Bounded shape — no provider raw bytes, no operator-internal
 *     identifiers beyond what the UI needs.
 */

import type { PrismaClient } from "@prisma/client";
import {
  REVIEWER_WORKSPACE_SCHEMA_VERSION,
  type ReviewerWorkspaceProjection,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { hiddenWorkflowIdsInWorkspace } from "../access/record-reach.js";
import { evidenceVisibleThroughCasesWhere } from "../cases/case-visibility.js";
import { resolveReviewerRole } from "./reviewer-roles.js";
import { getQcAccuracy7d } from "./qc-sample.service.js";
import { getReviewerMetrics7d } from "./reviewer-metrics.service.js";
import {
  countQcSamplesAwaitingVerdict,
  countReviewFigures,
} from "../reviewer-ops/review-count-definitions.js";

/** How many assigned reviews are considered when picking the caller's next one (T-003). */
const ACTIVE_REVIEW_CANDIDATES = 25;

export type ProjectReviewerWorkspaceInput = {
  prisma?: PrismaClient;
  teamId: string;
  userId: string;
  workspaceRole: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null;
  isPlatformAdmin?: boolean;
  reviewerRoleOverride?: string | null;
};

export async function projectReviewerWorkspace(
  input: ProjectReviewerWorkspaceInput,
): Promise<ReviewerWorkspaceProjection | null> {
  const prisma = input.prisma ?? defaultPrisma;
  const roleResolution = resolveReviewerRole({
    workspaceRole: input.workspaceRole,
    isPlatformAdmin: input.isPlatformAdmin,
    reviewerRoleOverride: input.reviewerRoleOverride ?? null,
  });
  if (!roleResolution.role) return null;

  const sinceWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  // Counts the reader can act on: a closed record's review is not counted
  // (WORKFLOW-003). Disagreements and QC samples name a workflow, not a record.
  const evidence = evidenceVisibleThroughCasesWhere(input.userId);
  const closedWorkflowIds = await hiddenWorkflowIdsInWorkspace(input.teamId, input.userId, prisma);
  const notClosed = closedWorkflowIds.length > 0 ? { workflowId: { notIn: closedWorkflowIds } } : {};

  // T-053 (stage C) — the rail's figures are the shared count definitions, so
  // each one equals the Inbox slice it links to (MY_REVIEWS, UNASSIGNED,
  // ESCALATED, COMPLETED_RECENTLY) for the same reader.
  const [
    figures,
    qcRow,
    challengerActive,
    awaitingAdj,
    resolvedWeek,
    metrics,
    activeCandidates,
  ] = await Promise.all([
    countReviewFigures({ teamId: input.teamId, viewerUserId: input.userId }, prisma),
    getQcAccuracy7d({ prisma, teamId: input.teamId }),
    prisma.reviewerDisagreement.count({
      where: {
        teamId: input.teamId,
        ...notClosed,
        challengerUserId: input.userId,
        state: { in: ["FILED", "UNDER_SECOND_REVIEW", "UNDER_SUPERVISOR_REVIEW"] },
      },
    }),
    prisma.reviewerDisagreement.count({
      where: {
        teamId: input.teamId,
        ...notClosed,
        state: { in: ["UNDER_SECOND_REVIEW", "UNDER_SUPERVISOR_REVIEW"] },
      },
    }),
    prisma.reviewerDisagreement.count({
      where: {
        teamId: input.teamId,
        ...notClosed,
        resolvedAtUtc: { gte: sinceWeek },
      },
    }),
    getReviewerMetrics7d({ prisma, teamId: input.teamId, userId: input.userId }),
    prisma.evidenceReviewWorkflow.findMany({
      where: {
        teamId: input.teamId,
        evidence,
        assignedToUserId: input.userId,
        status: { in: ["ASSIGNED", "IN_REVIEW"] },
      },
      orderBy: [{ priority: "desc" }, { dueAt: "asc" }],
      take: ACTIVE_REVIEW_CANDIDATES,
      select: {
        id: true,
        evidenceId: true,
        codingSchemaId: true,
        codingSchemaVersion: true,
        decisionRound: true,
      },
    }),
  ]);
  // T-003 (Team remediation) — the caller's NEXT item is never a review whose
  // current round already holds the caller's own FIRST decision: it waits for
  // an independent second reviewer, and focus mode used to re-select it after
  // every first-of-two decision.
  const decidedByMe = activeCandidates.length
    ? await prisma.workflowReviewDecision.findMany({
        where: { workflowId: { in: activeCandidates.map((w) => w.id) }, reviewerUserId: input.userId, stage: "FIRST" },
        select: { workflowId: true, round: true },
      })
    : [];
  const activeRow =
    activeCandidates.find(
      (w) => !decidedByMe.some((d) => d.workflowId === w.id && d.round === w.decisionRound),
    ) ?? null;
  const activeReview = activeRow
    ? {
        id: activeRow.id,
        evidenceId: activeRow.evidenceId,
        codingSchemaId: activeRow.codingSchemaId,
        codingSchemaVersion: activeRow.codingSchemaVersion,
      }
    : null;

  // Pending QC samples — the ONE "awaiting verdict" definition (T-054).
  const pendingSamples = await countQcSamplesAwaitingVerdict(
    { teamId: input.teamId, viewerUserId: input.userId },
    prisma,
  );

  return {
    schemaVersion: REVIEWER_WORKSPACE_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    role: roleResolution.role,
    capabilities: roleResolution.capabilities,
    queues: {
      assigned: figures.myReviews,
      unassigned: figures.unassignedReviews,
      in_progress: figures.inProgressReviews,
      escalated: figures.escalatedReviews,
      qc: pendingSamples,
      completed: figures.completedReviews7d,
    },
    disagreements: {
      asChallenger: challengerActive,
      awaitingAdjudication: awaitingAdj,
      resolvedThisWeek: resolvedWeek,
    },
    qc: {
      pendingSamples,
      rendered7d: qcRow.rendered,
      failureRate7dPct: qcRow.failureRatePct,
    },
    metrics: {
      throughput7d: metrics.throughput7d,
      approvalRate7dPct: metrics.approvalRate7dPct,
      escalationRate7dPct: metrics.escalationRate7dPct,
      avgReviewDurationMs7d: metrics.avgReviewDurationMs7d,
    },
    activeReview: activeReview
      ? {
          workflowId: activeReview.id,
          evidenceId: activeReview.evidenceId,
          codingSchemaId: activeReview.codingSchemaId,
          codingSchemaVersion: activeReview.codingSchemaVersion,
        }
      : null,
  };
}
