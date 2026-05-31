/**
 * PROOVRA Phase 3B — Provider usage event recorder.
 *
 * Single canonical write path for every paid provider call. The
 * provider adapter handshake produces an `IntelligenceProviderUsage`
 * row; this service persists it into `provider_usage_events` so the
 * cost dashboard + budget enforcement + audit centre all see one
 * authoritative source of truth.
 *
 * Hard rules:
 *   * Workspace-anchored.
 *   * Bounded operation / unit / decision vocabulary from
 *     `@proovra/shared/media-intelligence-platform.ts`.
 *   * NEVER persists raw provider payloads.
 */

import type { PrismaClient } from "@prisma/client";
import {
  PROVIDER_ADAPTER_OPERATIONS,
  PROVIDER_BUDGET_DECISIONS,
  PROVIDER_COST_UNITS,
  type MediaIntelligenceProvider,
  type ProviderAdapterOperation,
  type ProviderBudgetDecision,
  type ProviderCostUnit,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

export type RecordProviderUsageInput = {
  prisma?: PrismaClient;
  teamId: string;
  provider: MediaIntelligenceProvider;
  operation: ProviderAdapterOperation;
  unit: ProviderCostUnit;
  units: number;
  estimatedCostUsdMicros: number;
  decision: ProviderBudgetDecision;
  evidenceId?: string | null;
  caseId?: string | null;
  projectId?: string | null;
  initiatedByUserId?: string | null;
  failureReason?: string | null;
};

export async function recordProviderUsage(
  input: RecordProviderUsageInput,
): Promise<{ id: string }> {
  if (!(PROVIDER_ADAPTER_OPERATIONS as ReadonlyArray<string>).includes(input.operation)) {
    throw new Error(`provider-usage: unknown operation ${input.operation}`);
  }
  if (!(PROVIDER_COST_UNITS as ReadonlyArray<string>).includes(input.unit)) {
    throw new Error(`provider-usage: unknown unit ${input.unit}`);
  }
  if (!(PROVIDER_BUDGET_DECISIONS as ReadonlyArray<string>).includes(input.decision)) {
    throw new Error(`provider-usage: unknown decision ${input.decision}`);
  }
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.providerUsageEvent.create({
    data: {
      teamId: input.teamId,
      provider: input.provider,
      operation: input.operation,
      unit: input.unit,
      units: input.units,
      estimatedCostUsdMicros: BigInt(Math.round(input.estimatedCostUsdMicros)),
      decision: input.decision,
      evidenceId: input.evidenceId ?? null,
      caseId: input.caseId ?? null,
      projectId: input.projectId ?? null,
      initiatedByUserId: input.initiatedByUserId ?? null,
      failureReason: input.failureReason?.slice(0, 120) ?? null,
    },
    select: { id: true },
  });
  return { id: row.id };
}

export async function summariseProviderUsage(input: {
  prisma?: PrismaClient;
  teamId: string;
  sinceUtc?: Date;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  const since = input.sinceUtc ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await prisma.providerUsageEvent.groupBy({
    by: ["provider", "operation", "unit"],
    where: { teamId: input.teamId, occurredAtUtc: { gte: since } },
    _sum: { units: true, estimatedCostUsdMicros: true },
    _count: { _all: true },
  });
  return rows.map((r: (typeof rows)[number]) => ({
    provider: r.provider,
    operation: r.operation,
    unit: r.unit,
    callCount: r._count._all,
    units: r._sum.units ?? 0,
    estimatedCostUsdMicros: Number(r._sum.estimatedCostUsdMicros ?? 0n),
  }));
}

export async function listRecentUsage(input: {
  prisma?: PrismaClient;
  teamId: string;
  limit?: number;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.providerUsageEvent.findMany({
    where: { teamId: input.teamId },
    orderBy: { occurredAtUtc: "desc" },
    take: Math.min(input.limit ?? 100, 500),
  });
}
