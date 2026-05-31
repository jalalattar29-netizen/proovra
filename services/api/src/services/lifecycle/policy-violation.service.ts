/**
 * PROOVRA Phase 4B Final Closure C7 — Policy Violation read service.
 *
 * Surfaces persisted POLICY_VIOLATION_* events from the bounded
 * intelligence_activity_events stream. Every code is a member of
 * INTELLIGENCE_LIFECYCLE_CODES so the emitter never silently drops them.
 *
 * Hard rules:
 *   * Workspace-anchored on teamId.
 *   * Bounded codes only — never persist or return raw user input.
 *   * Payload chips bounded to <200 chars via the emitter.
 *   * Cap at 200 rows per list call.
 */

import type { PrismaClient } from "@prisma/client";
import type { IntelligenceLifecycleCode } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

// ---------------------------------------------------------------------------
// Bounded vocabulary of POLICY_VIOLATION_* codes
// ---------------------------------------------------------------------------

export const POLICY_VIOLATION_CODES = [
  "POLICY_VIOLATION_ENTITLEMENT",
  "POLICY_VIOLATION_LEGAL_HOLD",
  "POLICY_VIOLATION_RETENTION",
  "POLICY_VIOLATION_QUOTA",
] as const satisfies ReadonlyArray<IntelligenceLifecycleCode>;

export type PolicyViolationCode = (typeof POLICY_VIOLATION_CODES)[number];

// ---------------------------------------------------------------------------
// Projection shape
// ---------------------------------------------------------------------------

export type PolicyViolationProjection = {
  id: string;
  teamId: string;
  code: PolicyViolationCode;
  reason: string | null;
  evidenceId: string | null;
  caseId: string | null;
  targetType: string | null;
  targetId: string | null;
  actorUserId: string | null;
  occurredAtUtc: string;
};

// ---------------------------------------------------------------------------
// listPolicyViolations
// ---------------------------------------------------------------------------

export async function listPolicyViolations(input: {
  prisma?: PrismaClient;
  teamId: string;
  kind?: PolicyViolationCode;
  since?: Date;
  limit?: number;
}): Promise<ReadonlyArray<PolicyViolationProjection>> {
  const db = input.prisma ?? defaultPrisma;
  const cap = Math.min(input.limit ?? 200, 200);
  const since = input.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const codes: ReadonlyArray<string> = input.kind
    ? [input.kind]
    : POLICY_VIOLATION_CODES;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (db as any).intelligenceActivityEvent.findMany({
    where: {
      teamId: input.teamId,
      code: { in: codes as string[] },
      occurredAtUtc: { gte: since },
    },
    orderBy: { occurredAtUtc: "desc" },
    take: cap,
    select: {
      id: true,
      teamId: true,
      code: true,
      reason: true,
      evidenceId: true,
      caseId: true,
      targetType: true,
      targetId: true,
      actorUserId: true,
      occurredAtUtc: true,
    },
  });

  return rows.map((r: (typeof rows)[number]) => ({
    id: r.id,
    teamId: r.teamId,
    code: r.code as PolicyViolationCode,
    reason: r.reason,
    evidenceId: r.evidenceId,
    caseId: r.caseId,
    targetType: r.targetType,
    targetId: r.targetId,
    actorUserId: r.actorUserId,
    occurredAtUtc: r.occurredAtUtc.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// countPolicyViolations
// ---------------------------------------------------------------------------

export type PolicyViolationCounts = {
  total: number;
  byKind: Partial<Record<PolicyViolationCode, number>>;
};

export async function countPolicyViolations(input: {
  prisma?: PrismaClient;
  teamId: string;
  since?: Date;
}): Promise<PolicyViolationCounts> {
  const db = input.prisma ?? defaultPrisma;
  const since = input.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const groups = await (db as any).intelligenceActivityEvent
    .groupBy({
      by: ["code"],
      where: {
        teamId: input.teamId,
        code: { in: POLICY_VIOLATION_CODES as unknown as string[] },
        occurredAtUtc: { gte: since },
      },
      _count: { _all: true },
    })
    .catch(() => [] as Array<{ code: string; _count: { _all: number } }>);

  const byKind: Partial<Record<PolicyViolationCode, number>> = {};
  let total = 0;
  for (const g of groups) {
    const code = g.code as PolicyViolationCode;
    byKind[code] = g._count._all;
    total += g._count._all;
  }

  return { total, byKind };
}
