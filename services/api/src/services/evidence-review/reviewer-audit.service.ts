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
export async function appendReviewerAuditEvent(params: {
  evidenceId: string;
  actorUserId?: string | null;
  eventType: prismaPkg.EvidenceReviewerAuditEventType;
  metadata?: Prisma.InputJsonValue | null;
}) {
  const status =
    params.eventType === prismaPkg.EvidenceReviewerAuditEventType.WORKFLOW_UPDATED &&
    params.metadata &&
    typeof params.metadata === "object" &&
    !Array.isArray(params.metadata)
      ? ((params.metadata as Record<string, unknown>).status ?? null)
      : null;
  return prisma.$transaction(async (tx) => {
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
