/**
 * Phase A7 — Durable AI usage/budget ledger.
 *
 * reserve → provider call → reconcile (or release on failure).
 *
 * The ledger store is injectable so the reservation logic is behaviorally
 * testable in-memory; the Prisma store implements it with atomic
 * upsert-increment + a unique requestId (idempotent, multi-replica-safe,
 * restart-safe). Once wired, this — not the in-process AiCostGuard — is the
 * budget AUTHORITY; the in-memory guard remains only as a burst heuristic.
 */
import { prisma } from "../../db.js";
import { resolveWorkspaceAiPolicy } from "./workspace-ai-policy.service.js";

export type LedgerReserveInput = {
  workspaceId: string;
  userId: string;
  feature: string;
  provider: string;
  model: string;
  requestId: string;
  estimatedCostUsdMicros: bigint;
};

export type LedgerDecision =
  | { allowed: true; reservationId: string }
  | { allowed: false; code: "DAILY_OP_LIMIT" | "MONTHLY_OP_LIMIT" | "DAILY_COST_LIMIT" | "MONTHLY_COST_LIMIT" | "DUPLICATE_REQUEST" };

export type LedgerStore = {
  /** Returns null if the requestId already exists (idempotent duplicate). */
  createReservation: (input: LedgerReserveInput) => Promise<string | null>;
  getDailyUsage: (workspaceId: string, dayUtc: string) => Promise<{ operations: number; costUsdMicros: bigint }>;
  getMonthlyUsage: (workspaceId: string, monthUtc: string) => Promise<{ operations: number; costUsdMicros: bigint }>;
  incrementRollups: (workspaceId: string, dayUtc: string, monthUtc: string, costUsdMicros: bigint) => Promise<void>;
  markCompleted: (reservationId: string, actualCostUsdMicros: bigint | null) => Promise<void>;
  markFailed: (reservationId: string) => Promise<void>;
};

export function dayUtcOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}
export function monthUtcOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

export type LedgerLimits = {
  dailyOperationLimit: number | null;
  monthlyOperationLimit: number | null;
  dailyCostLimitUsdMicros: bigint | null;
  monthlyCostLimitUsdMicros: bigint | null;
};

/**
 * Atomic-ish reserve: idempotency first (unique requestId), then limit checks
 * against the durable rollups, then rollup increment. A concurrent duplicate
 * requestId collapses at the unique index (multi-replica safe).
 */
export async function reserveAiBudget(
  store: LedgerStore,
  limits: LedgerLimits,
  input: LedgerReserveInput,
  now: Date,
): Promise<LedgerDecision> {
  const day = dayUtcOf(now);
  const month = monthUtcOf(now);

  const daily = await store.getDailyUsage(input.workspaceId, day);
  const monthly = await store.getMonthlyUsage(input.workspaceId, month);

  if (limits.dailyOperationLimit != null && daily.operations >= limits.dailyOperationLimit) {
    return { allowed: false, code: "DAILY_OP_LIMIT" };
  }
  if (limits.monthlyOperationLimit != null && monthly.operations >= limits.monthlyOperationLimit) {
    return { allowed: false, code: "MONTHLY_OP_LIMIT" };
  }
  if (
    limits.dailyCostLimitUsdMicros != null &&
    daily.costUsdMicros + input.estimatedCostUsdMicros > limits.dailyCostLimitUsdMicros
  ) {
    return { allowed: false, code: "DAILY_COST_LIMIT" };
  }
  if (
    limits.monthlyCostLimitUsdMicros != null &&
    monthly.costUsdMicros + input.estimatedCostUsdMicros > limits.monthlyCostLimitUsdMicros
  ) {
    return { allowed: false, code: "MONTHLY_COST_LIMIT" };
  }

  const reservationId = await store.createReservation(input);
  if (reservationId === null) return { allowed: false, code: "DUPLICATE_REQUEST" };
  await store.incrementRollups(input.workspaceId, day, month, input.estimatedCostUsdMicros);
  return { allowed: true, reservationId };
}

/** Reconcile after a successful provider call (records actual cost). */
export async function reconcileAiUsage(
  store: LedgerStore,
  reservationId: string,
  actualCostUsdMicros: bigint | null,
): Promise<void> {
  await store.markCompleted(reservationId, actualCostUsdMicros);
}

/** Release after a failed provider call (reservation marked failed). */
export async function releaseAiReservation(
  store: LedgerStore,
  reservationId: string,
): Promise<void> {
  await store.markFailed(reservationId);
}

/** Threshold alert helper: returns crossed thresholds (50/75/90/100). */
export function crossedThresholds(
  before: bigint,
  after: bigint,
  limit: bigint | null,
): number[] {
  if (limit === null || limit <= 0n) return [];
  const out: number[] = [];
  for (const pct of [50, 75, 90, 100]) {
    const mark = (limit * BigInt(pct)) / 100n;
    if (before < mark && after >= mark) out.push(pct);
  }
  return out;
}

/** Real Prisma-backed store (unique request_id → multi-replica idempotency). */
export function buildPrismaLedgerStore(): LedgerStore {
  return {
    async createReservation(input) {
      try {
        const row = await prisma.aiUsageEvent.create({
          data: {
            workspaceId: input.workspaceId,
            userId: input.userId,
            feature: input.feature,
            provider: input.provider,
            model: input.model,
            requestId: input.requestId,
            estimatedCostUsdMicros: input.estimatedCostUsdMicros,
            status: "reserved",
          },
        });
        return row.id;
      } catch {
        return null; // unique violation → duplicate
      }
    },
    async getDailyUsage(workspaceId, dayUtc) {
      const row = await prisma.aiUsageDaily.findUnique({
        where: { workspaceId_dayUtc: { workspaceId, dayUtc } },
      });
      return { operations: row?.operations ?? 0, costUsdMicros: row?.costUsdMicros ?? 0n };
    },
    async getMonthlyUsage(workspaceId, monthUtc) {
      const row = await prisma.aiUsageMonthly.findUnique({
        where: { workspaceId_monthUtc: { workspaceId, monthUtc } },
      });
      return { operations: row?.operations ?? 0, costUsdMicros: row?.costUsdMicros ?? 0n };
    },
    async incrementRollups(workspaceId, dayUtc, monthUtc, cost) {
      await prisma.$transaction([
        prisma.aiUsageDaily.upsert({
          where: { workspaceId_dayUtc: { workspaceId, dayUtc } },
          update: { operations: { increment: 1 }, costUsdMicros: { increment: cost } },
          create: { workspaceId, dayUtc, operations: 1, costUsdMicros: cost },
        }),
        prisma.aiUsageMonthly.upsert({
          where: { workspaceId_monthUtc: { workspaceId, monthUtc } },
          update: { operations: { increment: 1 }, costUsdMicros: { increment: cost } },
          create: { workspaceId, monthUtc, operations: 1, costUsdMicros: cost },
        }),
      ]);
    },
    async markCompleted(reservationId, actual) {
      await prisma.aiUsageEvent.update({
        where: { id: reservationId },
        data: { status: "completed", completedAt: new Date(), actualCostUsdMicros: actual },
      });
    },
    async markFailed(reservationId) {
      await prisma.aiUsageEvent.update({
        where: { id: reservationId },
        data: { status: "failed", failedAt: new Date() },
      });
    },
  };
}

/** Resolve per-workspace ledger limits from the A2 policy row. */
export async function resolveLedgerLimits(teamId: string | null): Promise<LedgerLimits> {
  if (!teamId) {
    return { dailyOperationLimit: null, monthlyOperationLimit: null, dailyCostLimitUsdMicros: null, monthlyCostLimitUsdMicros: null };
  }
  const policy = await resolveWorkspaceAiPolicy(teamId);
  void policy; // limits live on the row; read directly for bigint fields
  const row = await prisma.workspaceAiPolicy.findUnique({ where: { teamId } });
  return {
    dailyOperationLimit: row?.dailyOperationLimit ?? null,
    monthlyOperationLimit: row?.monthlyOperationLimit ?? null,
    dailyCostLimitUsdMicros: row?.dailyCostLimitUsdMicros ?? null,
    monthlyCostLimitUsdMicros: row?.monthlyCostLimitUsdMicros ?? null,
  };
}

/**
 * Guarded ledger wrapper for routes: durable-first; if the ledger tables are
 * unavailable (migration not applied), returns allowed with a null reservation
 * so advisory AI never hard-fails on ledger infrastructure. The A2 policy gate
 * and plan cap remain independently enforced.
 */
export async function tryReserveAiBudget(input: {
  teamId: string | null;
  userId: string;
  feature: string;
  model: string;
  requestId: string;
  estimatedCostUsdMicros: bigint;
}): Promise<{ decision: LedgerDecision | null; reservationId: string | null }> {
  if (!input.teamId) return { decision: null, reservationId: null };
  try {
    const store = buildPrismaLedgerStore();
    const limits = await resolveLedgerLimits(input.teamId);
    const decision = await reserveAiBudget(
      store,
      limits,
      {
        workspaceId: input.teamId,
        userId: input.userId,
        feature: input.feature,
        provider: "openai",
        model: input.model,
        requestId: input.requestId,
        estimatedCostUsdMicros: input.estimatedCostUsdMicros,
      },
      new Date(),
    );
    return { decision, reservationId: decision.allowed ? decision.reservationId : null };
  } catch {
    return { decision: null, reservationId: null };
  }
}
