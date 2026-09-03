import { prisma } from "../../db.js";

/**
 * Platform Control Center — Cost Dashboard aggregate (item G).
 *
 * READ-ONLY aggregation over EXISTING provider-cost models. This service
 * touches NO metering / budget-enforcement / entitlement logic. It reads and
 * projects, over a bounded window (default 30d):
 *   - ProviderUsageEvent   → total estimated cost + per-provider breakdown
 *                            (cost + units + operation count) + top operations.
 *   - ProviderBudget       → soft / hard limits + state (budget posture).
 *   - ProviderBudgetAlert  → recent threshold breaches.
 *   - SemanticUsageDaily   → embeddings / semantic spend (eurSpentMicros).
 *   - EntitlementUsage     → entitlement consumption per key.
 *
 * HONESTY CONTRACT:
 *   - All costs are ESTIMATED — sourced from
 *     `ProviderUsageEvent.estimatedCostUsdMicros`, which is an estimate at
 *     metering time, NOT a billed invoice amount. The response labels this
 *     explicitly (`estimated: true`).
 *   - Provider costs are USD micros. Semantic/embeddings spend is EUR micros
 *     (`SemanticUsageDaily.eurSpentMicros`) — a DIFFERENT currency — so it is
 *     returned under its own EUR-labelled block and NEVER summed into the USD
 *     total.
 *   - Cost categories that are NOT metered by any model in this window
 *     (storage bytes $, bandwidth/egress, Cloudflare/Vercel infra, email,
 *     SMS) are returned as explicit `notConnected: true` entries with a
 *     reason. NO number is invented for them.
 *   - Empty tables collapse to honest zeros / nulls, never errors.
 *   - NO API keys, secrets, tokens, or env values are ever read or returned.
 *     Only aggregate cost/usage counters + coarse identifiers are projected.
 */

const MICROS_PER_UNIT = 1_000_000;

function microsToUsd(micros: bigint | number | null | undefined): number {
  if (micros == null) return 0;
  const n = typeof micros === "bigint" ? Number(micros) : micros;
  if (!Number.isFinite(n)) return 0;
  return n / MICROS_PER_UNIT;
}

function bigToNumber(value: bigint | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "bigint" ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}

export type ProviderCost = {
  provider: string;
  costUsdMicros: number;
  costUsd: number;
  units: number;
  operationCount: number;
};

export type TopOperation = {
  provider: string;
  operation: string;
  costUsdMicros: number;
  costUsd: number;
  units: number;
  count: number;
};

export type BudgetPosture = {
  id: string;
  provider: string | null;
  scope: string;
  period: string;
  state: string;
  softLimitUsdMicros: number;
  softLimitUsd: number;
  hardLimitUsdMicros: number;
  hardLimitUsd: number;
  atRisk: boolean;
  recentAlerts: Array<{
    threshold: string;
    consumedUsdMicros: number;
    consumedUsd: number;
    occurredAtUtc: string;
  }>;
};

export type EntitlementConsumption = {
  key: string;
  consumed: number;
  periodStartUtc: string | null;
};

export type NotConnectedCategory = {
  category: string;
  notConnected: true;
  reason: string;
};

export type CostDashboard = {
  windowDays: number;
  windowStartUtc: string;
  windowEndUtc: string;
  estimated: true;
  currency: "USD";
  totals: {
    estimatedCostUsdMicros: number;
    estimatedCostUsd: number;
    providerCount: number;
    eventCount: number;
    budgetsAtRisk: number;
  };
  perProvider: ProviderCost[];
  topOperations: TopOperation[];
  budgets: BudgetPosture[];
  semanticSpend: {
    currency: "EUR";
    note: string;
    eurSpentMicros: number;
    eurSpent: number;
    chunksEmbedded: number;
    tokensConsumed: number;
    dayCount: number;
    connected: boolean;
  };
  entitlements: EntitlementConsumption[];
  /** The row cap the entitlement rows were read under. */
  entitlementsCap: number;
  notConnectedCategories: NotConnectedCategory[];
};

/**
 * The entitlement-usage row cap.
 *
 * Named so it can travel to the surface. As a bare 200 it could not, and the
 * page showed the newest 200 period rows as the whole consumption picture.
 */
const ENTITLEMENT_ROW_CAP = 200;

// Cost categories that no model in this window meters. Returned as honest
// not-connected entries so the UI states "no usage recorded" rather than a
// fabricated $0 that reads as "measured and free".
const UNMETERED_CATEGORIES: ReadonlyArray<{ category: string; reason: string }> = [
  {
    category: "Storage ($ for stored bytes)",
    reason:
      "No storage-cost meter exists. Object bytes are tracked for quota, but no per-byte dollar cost is recorded in any usage model.",
  },
  {
    category: "Bandwidth / egress",
    reason:
      "No egress-cost usage rows are recorded. Bandwidth cost is billed by the infrastructure provider outside this system.",
  },
  {
    category: "Cloudflare / Vercel infrastructure",
    reason:
      "Platform infrastructure spend is billed directly by the vendor and is not metered as ProviderUsageEvent rows.",
  },
  {
    category: "Email delivery",
    reason:
      "No email-cost usage rows are recorded. Transactional email cost is not metered in this system.",
  },
  {
    category: "SMS delivery",
    reason:
      "No SMS-cost usage rows are recorded. SMS cost is not metered in this system.",
  },
];

/**
 * Build the read-only cost dashboard over the given window.
 *
 * @param windowDays  Look-back window in days (bounded by the caller).
 */
export async function getCostDashboard(
  windowDays: number
): Promise<CostDashboard> {
  const now = new Date();
  const windowStart = new Date(
    now.getTime() - windowDays * 24 * 60 * 60 * 1000
  );

  const [
    providerGroups,
    operationGroups,
    eventTotal,
    budgets,
    recentAlerts,
    semanticAgg,
    semanticDayCount,
    entitlementRows,
  ] = await Promise.all([
    // Per-provider: cost + units + operation-event count.
    prisma.providerUsageEvent.groupBy({
      by: ["provider"],
      where: { occurredAtUtc: { gte: windowStart } },
      _sum: { estimatedCostUsdMicros: true, units: true },
      _count: { _all: true },
    }),
    // Per provider+operation: cost + units + count → top operations by cost.
    prisma.providerUsageEvent.groupBy({
      by: ["provider", "operation"],
      where: { occurredAtUtc: { gte: windowStart } },
      _sum: { estimatedCostUsdMicros: true, units: true },
      _count: { _all: true },
    }),
    prisma.providerUsageEvent.aggregate({
      where: { occurredAtUtc: { gte: windowStart } },
      _sum: { estimatedCostUsdMicros: true },
      _count: { _all: true },
    }),
    // Budget posture — active (non-archived) budgets only.
    prisma.providerBudget.findMany({
      where: { archivedAt: null },
      orderBy: [{ createdAt: "desc" }],
      take: 200,
      select: {
        id: true,
        provider: true,
        scope: true,
        period: true,
        state: true,
        softLimitUsdMicros: true,
        hardLimitUsdMicros: true,
      },
    }),
    // Recent alerts across all budgets in the window.
    prisma.providerBudgetAlert.findMany({
      where: { occurredAtUtc: { gte: windowStart } },
      orderBy: [{ occurredAtUtc: "desc" }],
      take: 200,
      select: {
        budgetId: true,
        threshold: true,
        consumedUsdMicros: true,
        occurredAtUtc: true,
      },
    }),
    // Embeddings / semantic spend — EUR micros (kept separate from USD total).
    prisma.semanticUsageDaily.aggregate({
      where: { dateUtc: { gte: windowStart } },
      _sum: {
        eurSpentMicros: true,
        chunksEmbedded: true,
        tokensConsumed: true,
      },
    }),
    prisma.semanticUsageDaily.count({
      where: { dateUtc: { gte: windowStart } },
    }),
    // Entitlement consumption per key (most-recent period rows).
    prisma.entitlementUsage.findMany({
      orderBy: [{ periodStartUtc: "desc" }],
      take: ENTITLEMENT_ROW_CAP,
      select: { key: true, consumed: true, periodStartUtc: true },
    }),
  ]);

  // ---- Per-provider breakdown (real) ------------------------------------
  const perProvider: ProviderCost[] = providerGroups
    .map((g) => {
      const micros = bigToNumber(g._sum.estimatedCostUsdMicros);
      return {
        provider: g.provider,
        costUsdMicros: micros,
        costUsd: microsToUsd(micros),
        units: g._sum.units ?? 0,
        operationCount: g._count._all,
      };
    })
    .sort((a, b) => b.costUsdMicros - a.costUsdMicros);

  // ---- Top operations by cost (real) ------------------------------------
  const topOperations: TopOperation[] = operationGroups
    .map((g) => {
      const micros = bigToNumber(g._sum.estimatedCostUsdMicros);
      return {
        provider: g.provider,
        operation: g.operation,
        costUsdMicros: micros,
        costUsd: microsToUsd(micros),
        units: g._sum.units ?? 0,
        count: g._count._all,
      };
    })
    .sort((a, b) => b.costUsdMicros - a.costUsdMicros)
    .slice(0, 25);

  // ---- Budget posture (real) --------------------------------------------
  const alertsByBudget = new Map<
    string,
    Array<{
      threshold: string;
      consumedUsdMicros: number;
      consumedUsd: number;
      occurredAtUtc: string;
    }>
  >();
  for (const a of recentAlerts) {
    const micros = bigToNumber(a.consumedUsdMicros);
    const list = alertsByBudget.get(a.budgetId) ?? [];
    list.push({
      threshold: a.threshold,
      consumedUsdMicros: micros,
      consumedUsd: microsToUsd(micros),
      occurredAtUtc: a.occurredAtUtc.toISOString(),
    });
    alertsByBudget.set(a.budgetId, list);
  }

  const budgetPosture: BudgetPosture[] = budgets.map((b) => {
    const budgetAlerts = alertsByBudget.get(b.id) ?? [];
    const soft = bigToNumber(b.softLimitUsdMicros);
    const hard = bigToNumber(b.hardLimitUsdMicros);
    // "At risk" = the budget has a recent alert in the window, or its state has
    // been driven to EXHAUSTED. Purely derived from real rows — no estimate.
    const stateUpper = String(b.state).toUpperCase();
    const atRisk = budgetAlerts.length > 0 || stateUpper === "EXHAUSTED";
    return {
      id: b.id,
      provider: b.provider,
      scope: b.scope,
      period: b.period,
      state: b.state,
      softLimitUsdMicros: soft,
      softLimitUsd: microsToUsd(soft),
      hardLimitUsdMicros: hard,
      hardLimitUsd: microsToUsd(hard),
      atRisk,
      recentAlerts: budgetAlerts.slice(0, 10),
    };
  });

  const budgetsAtRisk = budgetPosture.filter((b) => b.atRisk).length;

  // ---- Semantic / embeddings spend (real, EUR — kept separate) ----------
  const eurMicros = bigToNumber(semanticAgg._sum.eurSpentMicros);
  const semanticSpend = {
    currency: "EUR" as const,
    note:
      "Embeddings / semantic spend is recorded in EUR micros (SemanticUsageDaily.eurSpentMicros). It is a different currency from the USD provider costs above and is NOT summed into the USD total.",
    eurSpentMicros: eurMicros,
    eurSpent: microsToUsd(eurMicros),
    chunksEmbedded: bigToNumber(semanticAgg._sum.chunksEmbedded),
    tokensConsumed: bigToNumber(semanticAgg._sum.tokensConsumed),
    dayCount: semanticDayCount,
    connected: semanticDayCount > 0,
  };

  // ---- Entitlement consumption (real) -----------------------------------
  const entitlements: EntitlementConsumption[] = entitlementRows.map((e) => ({
    key: e.key,
    consumed: bigToNumber(e.consumed),
    periodStartUtc: e.periodStartUtc ? e.periodStartUtc.toISOString() : null,
  }));

  // ---- Not-connected categories (honest — no fabricated numbers) --------
  const notConnectedCategories: NotConnectedCategory[] =
    UNMETERED_CATEGORIES.map((c) => ({
      category: c.category,
      notConnected: true as const,
      reason: c.reason,
    }));

  // ---- Totals (USD only — semantic EUR excluded) ------------------------
  const totalMicros = bigToNumber(eventTotal._sum.estimatedCostUsdMicros);

  return {
    windowDays,
    windowStartUtc: windowStart.toISOString(),
    windowEndUtc: now.toISOString(),
    estimated: true,
    currency: "USD",
    totals: {
      estimatedCostUsdMicros: totalMicros,
      estimatedCostUsd: microsToUsd(totalMicros),
      providerCount: perProvider.length,
      eventCount: eventTotal._count._all,
      budgetsAtRisk,
    },
    entitlementsCap: ENTITLEMENT_ROW_CAP,
    perProvider,
    topOperations,
    budgets: budgetPosture,
    semanticSpend,
    entitlements,
    notConnectedCategories,
  };
}
