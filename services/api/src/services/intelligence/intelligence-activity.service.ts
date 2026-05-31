/**
 * PROOVRA Phase 3B Enterprise Closure — lifecycle event emitter.
 *
 * Single canonical write path for every record / correction /
 * budget / provider lifecycle event. Closes the audit gap where
 * `MEDIA_INTELLIGENCE_ACTIVITY_CODES` enum codes were defined but
 * never written as discrete events.
 *
 * Hard rules:
 *   * Workspace-anchored.
 *   * Bounded code vocabulary from `INTELLIGENCE_LIFECYCLE_CODES`.
 *   * NEVER raw payloads — bounded reason + ids only.
 *   * Append-only — there is no update / delete path.
 *   * `emit` MUST be tolerant of failure — lifecycle audit must
 *     never break the calling operational path.
 */

import type { PrismaClient } from "@prisma/client";
import {
  INTELLIGENCE_LIFECYCLE_CODES,
  classifyLifecycleCategory,
  type IntelligenceLifecycleCategory,
  type IntelligenceLifecycleCode,
  type MediaIntelligenceProvider,
  type ProviderAdapterOperation,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

export type EmitLifecycleEventInput = {
  prisma?: PrismaClient;
  teamId: string;
  code: IntelligenceLifecycleCode;
  actorUserId?: string | null;
  recordId?: string | null;
  correctionId?: string | null;
  budgetId?: string | null;
  evidenceId?: string | null;
  caseId?: string | null;
  projectId?: string | null;
  provider?: MediaIntelligenceProvider | null;
  operation?: ProviderAdapterOperation | null;
  failureReason?: string | null;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  targetType?: string | null;
  targetId?: string | null;
};

/**
 * Emit a single lifecycle event. Silently swallows persistence
 * failures so the calling operational write is never blocked by the
 * audit log itself. The single canonical write path means the audit
 * federator can answer "did this lifecycle transition happen?" by
 * reading one table.
 */
export async function emitLifecycleEvent(
  input: EmitLifecycleEventInput,
): Promise<{ ok: boolean; id?: string }> {
  if (!(INTELLIGENCE_LIFECYCLE_CODES as ReadonlyArray<string>).includes(input.code)) {
    return { ok: false };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const category: IntelligenceLifecycleCategory = classifyLifecycleCategory(input.code);
  try {
    const row = await prisma.intelligenceActivityEvent.create({
      data: {
        teamId: input.teamId,
        category,
        code: input.code,
        actorUserId: input.actorUserId ?? null,
        recordId: input.recordId ?? null,
        correctionId: input.correctionId ?? null,
        budgetId: input.budgetId ?? null,
        evidenceId: input.evidenceId ?? null,
        caseId: input.caseId ?? null,
        projectId: input.projectId ?? null,
        provider: input.provider ?? null,
        operation: input.operation ?? null,
        failureReason: input.failureReason?.slice(0, 200) ?? null,
        reason: input.reason?.slice(0, 200) ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        payload: (input.payload ?? null) as never,
      },
      select: { id: true },
    });
    return { ok: true, id: row.id };
  } catch {
    return { ok: false };
  }
}

/**
 * Bounded read path the audit federator + verification-package
 * manifest writer use. Pure projection — no PII expansion.
 */
export async function listLifecycleEvents(input: {
  prisma?: PrismaClient;
  teamId: string;
  category?: IntelligenceLifecycleCategory;
  code?: IntelligenceLifecycleCode;
  recordId?: string;
  correctionId?: string;
  budgetId?: string;
  evidenceId?: string;
  caseId?: string;
  projectId?: string;
  sinceUtc?: Date;
  limit?: number;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  const since = input.sinceUtc ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const limit = Math.min(input.limit ?? 200, 500);
  return prisma.intelligenceActivityEvent.findMany({
    where: {
      teamId: input.teamId,
      occurredAtUtc: { gte: since },
      ...(input.category ? { category: input.category } : {}),
      ...(input.code ? { code: input.code } : {}),
      ...(input.recordId ? { recordId: input.recordId } : {}),
      ...(input.correctionId ? { correctionId: input.correctionId } : {}),
      ...(input.budgetId ? { budgetId: input.budgetId } : {}),
      ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
      ...(input.caseId ? { caseId: input.caseId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
    orderBy: { occurredAtUtc: "desc" },
    take: limit,
  });
}

export async function countLifecycleEvents(input: {
  prisma?: PrismaClient;
  teamId: string;
  code: IntelligenceLifecycleCode;
  sinceUtc?: Date;
  untilUtc?: Date;
}): Promise<number> {
  const prisma = input.prisma ?? defaultPrisma;
  const since = input.sinceUtc ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const until = input.untilUtc;
  return prisma.intelligenceActivityEvent.count({
    where: {
      teamId: input.teamId,
      code: input.code,
      occurredAtUtc: { gte: since, ...(until ? { lt: until } : {}) },
    },
  });
}
