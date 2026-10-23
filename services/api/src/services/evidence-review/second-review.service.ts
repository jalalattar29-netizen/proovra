import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Derive whether a workflow currently requires a second review.
 * Triggers (computed live — no stored column):
 *   - workflow.status === ESCALATED
 *   - an open escalation on the workflow
 *   - an ACTIVE legal hold on the underlying evidence
 *   - at least one redaction-required visibility decision
 */
export async function requiresSecondReview(
  input: { workflowId: string; teamId: string; evidenceId: string },
  client: Db = defaultPrisma,
): Promise<{ required: boolean; reason: string | null }> {
  const [wf, openEsc, holdCount, redactionCount] = await Promise.all([
    client.evidenceReviewWorkflow.findUnique({
      where: { id: input.workflowId },
      select: { status: true },
    }),
    client.reviewEscalation.findFirst({
      where: {
        teamId: input.teamId,
        workflowId: input.workflowId,
        status: { in: ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] },
      },
      select: { id: true },
    }),
    client.evidenceLegalHold.count({
      where: {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        status: "ACTIVE",
      },
    }),
    client.evidenceWorkflowVisibilityDecision.count({
      where: { evidenceId: input.evidenceId, requiresRedaction: true },
    }),
  ]);
  if (wf?.status === "ESCALATED")
    return { required: true, reason: "workflow_escalated" };
  if (openEsc) return { required: true, reason: "open_escalation" };
  if (holdCount > 0) return { required: true, reason: "active_legal_hold" };
  if (redactionCount > 0)
    return { required: true, reason: "redaction_required" };
  return { required: false, reason: null };
}
