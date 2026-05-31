/**
 * PROOVRA Phase 2B — External decision service.
 *
 * Records bounded external reviewer decisions and feeds them into the
 * existing internal reviewer workflow:
 *
 *   * One decision per (grantId, workflowId) — re-submission replaces
 *     the value AND emits an activity row noting the replace.
 *   * Bounded rationale (≤ 600 chars).
 *   * Emits DECISION_SUBMITTED.
 *   * NEVER mutates the internal `WorkflowReviewDecision` table —
 *     external decisions are a separate audit-of-record.
 */

import type { PrismaClient } from "@prisma/client";
import {
  EXTERNAL_DECISION_VERDICTS,
  type ExternalDecisionVerdict,
  type ExternalPortalDenialReason,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitPortalActivity } from "./portal-activity.service.js";

export type SubmitExternalDecisionInput = {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  workflowId: string;
  reviewerEmail: string;
  reviewerDisplay: string | null;
  verdict: ExternalDecisionVerdict;
  rationale?: string;
};

export async function submitExternalDecision(
  input: SubmitExternalDecisionInput,
): Promise<
  | { ok: true; decisionId: string; replaced: boolean }
  | { ok: false; denial: ExternalPortalDenialReason }
> {
  if (
    !(EXTERNAL_DECISION_VERDICTS as ReadonlyArray<string>).includes(input.verdict)
  ) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (
    input.verdict !== "APPROVE" &&
    (!input.rationale || input.rationale.length === 0)
  ) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (input.rationale && input.rationale.length > 600) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const existing = await prisma.externalReviewDecision.findUnique({
    where: {
      external_review_decision_grant_workflow_uniq: {
        grantId: input.grantId,
        workflowId: input.workflowId,
      },
    },
    select: { id: true },
  });
  if (existing) {
    await prisma.externalReviewDecision.update({
      where: { id: existing.id },
      data: {
        verdict: input.verdict,
        rationale: input.rationale ?? null,
        reviewerEmail: input.reviewerEmail,
        reviewerDisplay: input.reviewerDisplay,
        submittedAtUtc: new Date(),
      },
    });
    await emitPortalActivity({
      prisma,
      teamId: input.teamId,
      grantId: input.grantId,
      code: "DECISION_SUBMITTED",
      payload: {
        workflowId: input.workflowId,
        verdict: input.verdict,
        replaced: true,
      },
    });
    return { ok: true, decisionId: existing.id, replaced: true };
  }
  const created = await prisma.externalReviewDecision.create({
    data: {
      teamId: input.teamId,
      grantId: input.grantId,
      workflowId: input.workflowId,
      verdict: input.verdict,
      rationale: input.rationale ?? null,
      reviewerEmail: input.reviewerEmail,
      reviewerDisplay: input.reviewerDisplay,
    },
    select: { id: true },
  });
  await emitPortalActivity({
    prisma,
    teamId: input.teamId,
    grantId: input.grantId,
    code: "DECISION_SUBMITTED",
    payload: {
      workflowId: input.workflowId,
      verdict: input.verdict,
      replaced: false,
    },
  });
  return { ok: true, decisionId: created.id, replaced: false };
}

export async function listExternalDecisionsForWorkflow(input: {
  prisma?: PrismaClient;
  teamId: string;
  workflowId: string;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.externalReviewDecision.findMany({
    where: { teamId: input.teamId, workflowId: input.workflowId },
    orderBy: { submittedAtUtc: "desc" },
    take: 50,
  });
}
