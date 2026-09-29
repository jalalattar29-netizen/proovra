/**
 * PROOVRA Phase 3A — Redaction activity emitter.
 *
 * Bounded append-only activity log keyed by `projectId` (and
 * optionally `versionId`). Every redaction action — region added,
 * detection accepted, version approved, derivative rendered — flows
 * through here.
 *
 * Hard rules:
 *   * Bounded code (REDACTION_ACTIVITY_CODES).
 *   * NEVER persists PII; bounded payload only.
 *   * NEVER a parallel audit system — emits through the existing
 *     redaction_activity table.
 *   * ET-CUS-12 (2026-09-29): a MATERIAL step (REDACTION_CUSTODY_MATERIAL_CODES)
 *     is also appended to the evidence record's custody chain, in the same
 *     transaction as its activity row. The comment here used to claim that
 *     "downstream replicators" mirrored activity into an audit chain; none
 *     existed, and no released redaction ever reached custody.
 */

import type { PrismaClient } from "@prisma/client";

import * as prismaPkg from "@prisma/client";
import {
  REDACTION_ACTIVITY_CODES,
  REDACTION_CUSTODY_MATERIAL_CODES,
  type RedactionActivityCode,
} from "@proovra/shared";
import { appendCustodyEventTx } from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";

export type EmitRedactionActivityInput = {
  prisma?: PrismaClient;
  teamId: string;
  projectId: string;
  versionId?: string | null;
  code: RedactionActivityCode;
  actorUserId?: string | null;
  payload?: Record<string, unknown>;
};

export async function emitRedactionActivity(
  input: EmitRedactionActivityInput,
): Promise<{ id: string }> {
  if (
    !(REDACTION_ACTIVITY_CODES as ReadonlyArray<string>).includes(input.code)
  ) {
    throw new Error(`redaction-activity: unknown code "${input.code}"`);
  }
  const prisma = input.prisma ?? defaultPrisma;
  const write = async (db: PrismaClient) => {
    const row = await db.redactionActivity.create({
      data: {
        teamId: input.teamId,
        projectId: input.projectId,
        versionId: input.versionId ?? null,
        code: input.code,
        actorUserId: input.actorUserId ?? null,
        payload: (input.payload ?? null) as never,
      },
      select: { id: true },
    });
    if (REDACTION_CUSTODY_MATERIAL_CODES.includes(input.code)) {
      const project = await db.redactionProject.findUnique({
        where: { id: input.projectId },
        select: { evidenceId: true },
      });
      if (project?.evidenceId) {
        await appendCustodyEventTx(db as unknown as prismaPkg.Prisma.TransactionClient, {
          evidenceId: project.evidenceId,
          eventType: prismaPkg.CustodyEventType.REDACTION_RECORDED,
          payload: {
            code: input.code,
            projectId: input.projectId,
            versionId: input.versionId ?? null,
            actorUserId: input.actorUserId ?? null,
          },
        });
      }
    }
    return row;
  };
  const row =
    "$transaction" in prisma && typeof prisma.$transaction === "function"
      ? await prisma.$transaction((tx) => write(tx as unknown as PrismaClient))
      : await write(prisma);
  return { id: row.id };
}

export type ListRedactionActivityInput = {
  prisma?: PrismaClient;
  teamId: string;
  projectId: string;
  versionId?: string | null;
  limit?: number;
};

export async function listRedactionActivity(input: ListRedactionActivityInput) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.redactionActivity.findMany({
    where: {
      teamId: input.teamId,
      projectId: input.projectId,
      ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
    },
    orderBy: { occurredAtUtc: "desc" },
    take: Math.min(input.limit ?? 200, 500),
    select: {
      id: true,
      code: true,
      versionId: true,
      actorUserId: true,
      payload: true,
      occurredAtUtc: true,
    },
  });
}
