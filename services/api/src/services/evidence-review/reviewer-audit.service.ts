import type { Prisma, PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import { REVIEW_EVENT_AUDIT_ACTIONS, type ReviewEventCode } from "@proovra/shared";
import { prisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";

/**
 * THE REVIEWER AUDIT LOG — internal Review activity only.
 *
 * REVIEW IS NOT FORENSIC CUSTODY (owner decision 2026-10-24). This used to
 * append every Review status change to the record's forensic custody chain as
 * REVIEW_DECISION_RECORDED `{ status, actorUserId }` (ET-CUS-12, 2026-09-29) —
 * where it counted as a reportable change, made the latest report stale and
 * was printed, with the internal actor id, in the next report and package.
 * Nothing here writes custody any more. Internal Review activity stays durable
 * in the Review workflow events, the decision rounds, the escalation records,
 * this reviewer audit log and the tenant audit (`recordReviewActivityTx`).
 */
type ReviewerAuditEventParams = {
  evidenceId: string;
  actorUserId?: string | null;
  eventType: prismaPkg.EvidenceReviewerAuditEventType;
  metadata?: Prisma.InputJsonValue | null;
};

export async function appendReviewerAuditEvent(params: ReviewerAuditEventParams) {
  return prisma.$transaction((tx) => appendReviewerAuditEventTx(tx, params));
}

/** The same reviewer-audit write inside the CALLER'S transaction. */
export async function appendReviewerAuditEventTx(tx: Prisma.TransactionClient, params: ReviewerAuditEventParams) {
  return tx.evidenceReviewerAuditEvent.create({
    data: {
      evidenceId: params.evidenceId,
      actorUserId: params.actorUserId ?? null,
      eventType: params.eventType,
      metadata: params.metadata ?? undefined,
    },
  });
}

/**
 * ONE internal Review activity, recorded where Review activity belongs: the
 * reviewer audit log and the tenant audit (the existing append-only platform
 * audit — no second audit chain), in the CALLER'S transaction so the activity
 * and its audit commit together or not at all. Never forensic custody.
 */
export async function recordReviewActivityTx(
  tx: Prisma.TransactionClient,
  input: {
    evidenceId: string;
    workflowId: string;
    teamId: string | null;
    actorUserId: string | null;
    code: ReviewEventCode;
    previousState?: string | null;
    resultingState?: string | null;
    /** The verdict kind, for a decision. */
    decision?: string | null;
  },
): Promise<void> {
  await appendReviewerAuditEventTx(tx, {
    evidenceId: input.evidenceId,
    actorUserId: input.actorUserId,
    eventType: prismaPkg.EvidenceReviewerAuditEventType.WORKFLOW_UPDATED,
    metadata: {
      event: input.code,
      ...(input.resultingState ? { state: input.resultingState } : {}),
      ...(input.decision ? { decision: input.decision } : {}),
    },
  });
  await emitTenantAudit(
    {
      action: REVIEW_EVENT_AUDIT_ACTIONS[input.code],
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      workspaceId: input.teamId,
      resourceType: "evidence_review_workflow",
      resourceId: input.workflowId,
      previousState: input.previousState ?? null,
      resultingState: input.resultingState ?? null,
      reasonCode: input.code,
      metadata: { evidenceId: input.evidenceId, ...(input.decision ? { decision: input.decision } : {}) },
    },
    tx as unknown as PrismaClient,
  );
}

export async function listReviewerAuditEvents(evidenceId: string) {
  return prisma.evidenceReviewerAuditEvent.findMany({
    where: { evidenceId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      eventType: true,
      metadata: true,
      createdAt: true,
      actor: {
        select: {
          id: true,
          email: true,
          displayName: true,
        },
      },
    },
  });
}
