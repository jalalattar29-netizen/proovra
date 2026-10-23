import type { Prisma } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import { prisma } from "../../db.js";
import { appendCustodyEventTx } from "@proovra/shared-runtime";

/**
 * ET-CUS-12 (2026-09-29): a review workflow DECISION — an update that sets a
 * status — is also appended to the record's custody chain as
 * REVIEW_DECISION_RECORDED, in the same transaction. Comments, notes,
 * assignments and priorities stay in the reviewer audit log only.
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

/**
 * The same write inside the CALLER'S transaction — so a review status change
 * and its custody entry commit together or not at all, and a replay that
 * changed nothing records nothing (2026-10-23).
 */
export async function appendReviewerAuditEventTx(tx: Prisma.TransactionClient, params: ReviewerAuditEventParams) {
  const status =
    params.eventType === prismaPkg.EvidenceReviewerAuditEventType.WORKFLOW_UPDATED &&
    params.metadata &&
    typeof params.metadata === "object" &&
    !Array.isArray(params.metadata)
      ? ((params.metadata as Record<string, unknown>).status ?? null)
      : null;
  {
    const row = await tx.evidenceReviewerAuditEvent.create({
      data: {
        evidenceId: params.evidenceId,
        actorUserId: params.actorUserId ?? null,
        eventType: params.eventType,
        metadata: params.metadata ?? undefined,
      },
    });
    if (typeof status === "string" && status.length > 0) {
      await appendCustodyEventTx(tx, {
        evidenceId: params.evidenceId,
        eventType: prismaPkg.CustodyEventType.REVIEW_DECISION_RECORDED,
        payload: { status, actorUserId: params.actorUserId ?? null },
      });
    }
    return row;
  }
}

/** ET-CUS-12 — a review STATUS CHANGE, on the custody chain, in `tx`. */
export function recordReviewStatusOnCustodyTx(
  tx: Prisma.TransactionClient,
  input: { evidenceId: string; actorUserId: string | null; status: string; decision: string },
) {
  return appendReviewerAuditEventTx(tx, {
    evidenceId: input.evidenceId,
    actorUserId: input.actorUserId,
    eventType: prismaPkg.EvidenceReviewerAuditEventType.WORKFLOW_UPDATED,
    metadata: { status: input.status, decision: input.decision },
  });
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
