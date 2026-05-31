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
 *     redaction_activity table; downstream replicators mirror into
 *     the platform audit chain when the project is bound to an
 *     evidence row.
 */

import type { PrismaClient } from "@prisma/client";

import {
  REDACTION_ACTIVITY_CODES,
  type RedactionActivityCode,
} from "@proovra/shared";

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
  const row = await prisma.redactionActivity.create({
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
