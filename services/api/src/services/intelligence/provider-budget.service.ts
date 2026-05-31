/**
 * PROOVRA Phase 3B — Provider budget service.
 *
 * Bounded persistence + enforcement layer for provider spend. The
 * adapter dispatch consults `decideBudgetGate` BEFORE issuing a
 * paid provider call; if the bounded period spend exceeds the hard
 * limit the gate returns BLOCK and the orchestrator records a
 * `PROVIDER_CALL_REFUSED_BUDGET` activity instead of paying out.
 *
 * Phase 3B Enterprise Closure additions:
 *   * `decideBudgetGate` now correctly honours `scopeTargetId` for
 *     CASE / PROJECT / TEAM-target budgets — the prior implementation
 *     filtered only by team + provider, which caused per-case +
 *     per-project budgets to compare against team-wide spend.
 *   * Every soft / hard / block decision emits an
 *     IntelligenceActivityEvent (BUDGET_SOFT_LIMIT_REACHED /
 *     BUDGET_HARD_LIMIT_REACHED / BUDGET_BLOCKED) so the audit
 *     centre + executive trends can see breach history.
 *   * `listBudgetSpend` returns a per-scope spend projection with
 *     projected burn-rate, remaining budget and threshold status.
 *   * `listBudgetBreaches` returns the federated breach history.
 *
 * Hard rules:
 *   * Workspace-anchored at every entry point.
 *   * Bounded scope (`WORKSPACE` / `TEAM` / `CASE` / `PROJECT` /
 *     `PROVIDER`) — multiple budgets may apply; the strictest
 *     decision wins (BLOCK > WARN > ALLOW).
 *   * Soft limit = WARN. Hard limit = BLOCK.
 *   * Alerts are append-only — every soft or hard hit writes one
 *     row to `provider_budget_alerts` for the audit centre.
 */

import type { PrismaClient } from "@prisma/client";
import {
  PROVIDER_BUDGET_DECISIONS,
  PROVIDER_BUDGET_PERIODS,
  PROVIDER_BUDGET_SCOPES,
  type BudgetBreachProjection,
  type BudgetBreachRow,
  type BudgetSpendProjection,
  type BudgetSpendRow,
  type ExecutiveMetricsRange,
  type MediaIntelligenceProvider,
  type ProviderBudgetDecision,
  type ProviderBudgetGateInput,
  type ProviderBudgetGateResult,
  type ProviderBudgetPeriod,
  type ProviderBudgetScope,
  rangeWindowMs,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitLifecycleEvent } from "./intelligence-activity.service.js";

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export type CreateBudgetInput = {
  prisma?: PrismaClient;
  teamId: string;
  scope: ProviderBudgetScope;
  scopeTargetId: string | null;
  provider: MediaIntelligenceProvider | null;
  period: ProviderBudgetPeriod;
  softLimitUsdMicros: number;
  hardLimitUsdMicros: number;
  createdByUserId: string;
};

export type CreateBudgetResult =
  | { ok: true; budgetId: string }
  | { ok: false; denial: "POLICY_REJECTED" };

export async function createBudget(
  input: CreateBudgetInput,
): Promise<CreateBudgetResult> {
  if (!(PROVIDER_BUDGET_SCOPES as ReadonlyArray<string>).includes(input.scope)) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (!(PROVIDER_BUDGET_PERIODS as ReadonlyArray<string>).includes(input.period)) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (input.softLimitUsdMicros <= 0 || input.hardLimitUsdMicros <= 0) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (input.softLimitUsdMicros > input.hardLimitUsdMicros) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (input.scope === "PROVIDER" && !input.provider) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  // CASE + PROJECT budgets MUST carry a scopeTargetId — otherwise the
  // enforcement gate cannot know which case / project to constrain.
  if ((input.scope === "CASE" || input.scope === "PROJECT") && !input.scopeTargetId) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const created = await prisma.providerBudget.create({
    data: {
      teamId: input.teamId,
      scope: input.scope,
      scopeTargetId: input.scopeTargetId,
      provider: input.provider,
      period: input.period,
      softLimitUsdMicros: BigInt(Math.round(input.softLimitUsdMicros)),
      hardLimitUsdMicros: BigInt(Math.round(input.hardLimitUsdMicros)),
      createdByUserId: input.createdByUserId,
    },
    select: { id: true },
  });
  await emitLifecycleEvent({
    prisma,
    teamId: input.teamId,
    code: "BUDGET_CREATED",
    actorUserId: input.createdByUserId,
    budgetId: created.id,
    provider: input.provider,
    reason: `scope=${input.scope}; period=${input.period}`,
  });
  return { ok: true, budgetId: created.id };
}

export async function listBudgets(input: {
  prisma?: PrismaClient;
  teamId: string;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  const budgets = await prisma.providerBudget.findMany({
    where: { teamId: input.teamId },
    orderBy: { createdAt: "desc" },
  });
  const out = [] as Array<{
    id: string;
    scope: ProviderBudgetScope;
    scopeTargetId: string | null;
    provider: MediaIntelligenceProvider | null;
    period: ProviderBudgetPeriod;
    softLimitUsdMicros: number;
    hardLimitUsdMicros: number;
    consumedUsdMicrosThisPeriod: number;
    state: "ACTIVE" | "EXHAUSTED" | "DISABLED";
    createdByUserId: string;
    createdAtUtc: string;
  }>;
  for (const b of budgets) {
    const since = periodStart(b.period as ProviderBudgetPeriod);
    const consumed = await sumConsumed({
      prisma,
      teamId: input.teamId,
      scope: b.scope as ProviderBudgetScope,
      scopeTargetId: b.scopeTargetId,
      provider: b.provider as MediaIntelligenceProvider | null,
      sinceUtc: since,
    });
    const hard = Number(b.hardLimitUsdMicros);
    out.push({
      id: b.id,
      scope: b.scope as ProviderBudgetScope,
      scopeTargetId: b.scopeTargetId,
      provider: b.provider as MediaIntelligenceProvider | null,
      period: b.period as ProviderBudgetPeriod,
      softLimitUsdMicros: Number(b.softLimitUsdMicros),
      hardLimitUsdMicros: hard,
      consumedUsdMicrosThisPeriod: consumed,
      state:
        b.state === "DISABLED"
          ? "DISABLED"
          : consumed >= hard
          ? "EXHAUSTED"
          : "ACTIVE",
      createdByUserId: b.createdByUserId,
      createdAtUtc: b.createdAt.toISOString(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gate — adapters call this before any paid provider invocation.
// ---------------------------------------------------------------------------

/**
 * Phase 3B Closure: the gate now passes the candidate operation's
 * caseId + projectId so the per-scope consumption can be filtered
 * by the matching scopeTargetId.
 */
export type ScopedBudgetGateInput = ProviderBudgetGateInput & {
  caseId?: string | null;
  projectId?: string | null;
};

export async function decideBudgetGate(
  input: ScopedBudgetGateInput,
  prismaClient: PrismaClient = defaultPrisma,
): Promise<ProviderBudgetGateResult> {
  // NOTE: Entitlement gates (FEATURE_INTELLIGENCE / QUOTA_AI_OPERATIONS_PER_MONTH)
  // are enforced one layer up in `runIntelligenceCall` (media-intelligence.service.ts)
  // so the budget engine remains a pure spend-decider. Mixing entitlement
  // logic into the budget engine breaks scoped-budget tests that legitimately
  // stub only the budget tables.
  const budgets = await prismaClient.providerBudget.findMany({
    where: {
      teamId: input.teamId,
      state: "ACTIVE",
      OR: [{ provider: input.provider }, { provider: null }],
    },
  });
  if (budgets.length === 0) {
    return { decision: "ALLOW", reason: null, budgetId: null };
  }
  let strictest: ProviderBudgetDecision = "ALLOW";
  let strictestReason: string | null = null;
  let strictestBudgetId: string | null = null;
  for (const b of budgets) {
    // Filter budgets that don't apply to the candidate operation.
    const scope = b.scope as ProviderBudgetScope;
    if (scope === "CASE" && b.scopeTargetId && b.scopeTargetId !== (input.caseId ?? null)) {
      continue;
    }
    if (scope === "PROJECT" && b.scopeTargetId && b.scopeTargetId !== (input.projectId ?? null)) {
      continue;
    }
    if (scope === "PROVIDER" && b.provider && b.provider !== input.provider) {
      continue;
    }
    const since = periodStart(b.period as ProviderBudgetPeriod);
    const consumed = await sumConsumed({
      prisma: prismaClient,
      teamId: input.teamId,
      scope,
      scopeTargetId: b.scopeTargetId,
      provider: b.provider as MediaIntelligenceProvider | null,
      sinceUtc: since,
    });
    const next = consumed + input.estimatedCostUsdMicros;
    const hard = Number(b.hardLimitUsdMicros);
    const soft = Number(b.softLimitUsdMicros);
    if (next > hard) {
      await prismaClient.providerBudgetAlert.create({
        data: {
          teamId: input.teamId,
          budgetId: b.id,
          threshold: "HARD",
          consumedUsdMicros: BigInt(Math.round(consumed)),
        },
      });
      await emitLifecycleEvent({
        prisma: prismaClient,
        teamId: input.teamId,
        code: "BUDGET_HARD_LIMIT_REACHED",
        budgetId: b.id,
        provider: input.provider,
        caseId: input.caseId ?? null,
        projectId: input.projectId ?? null,
        reason: `consumed=${consumed}; next=${next}; hard=${hard}`,
      });
      await emitLifecycleEvent({
        prisma: prismaClient,
        teamId: input.teamId,
        code: "BUDGET_BLOCKED",
        budgetId: b.id,
        provider: input.provider,
        caseId: input.caseId ?? null,
        projectId: input.projectId ?? null,
        reason: `scope=${scope}; period=${b.period}`,
      });
      strictest = "BLOCK";
      strictestReason = `budget_hard_limit_${b.period}_exceeded`;
      strictestBudgetId = b.id;
      break;
    }
    if (next > soft && strictest === "ALLOW") {
      await prismaClient.providerBudgetAlert.create({
        data: {
          teamId: input.teamId,
          budgetId: b.id,
          threshold: "SOFT",
          consumedUsdMicros: BigInt(Math.round(consumed)),
        },
      });
      await emitLifecycleEvent({
        prisma: prismaClient,
        teamId: input.teamId,
        code: "BUDGET_SOFT_LIMIT_REACHED",
        budgetId: b.id,
        provider: input.provider,
        caseId: input.caseId ?? null,
        projectId: input.projectId ?? null,
        reason: `consumed=${consumed}; next=${next}; soft=${soft}`,
      });
      strictest = "WARN";
      strictestReason = `budget_soft_limit_${b.period}_exceeded`;
      strictestBudgetId = b.id;
    }
  }
  return {
    decision: strictest,
    reason: strictestReason,
    budgetId: strictestBudgetId,
  };
}

// ---------------------------------------------------------------------------
// Read paths — breach history + spend-by-scope.
// ---------------------------------------------------------------------------

export async function listBudgetBreaches(input: {
  prisma?: PrismaClient;
  teamId: string;
  range: ExecutiveMetricsRange;
}): Promise<BudgetBreachProjection> {
  const prisma = input.prisma ?? defaultPrisma;
  const since = new Date(Date.now() - rangeWindowMs(input.range));
  const alerts = await prisma.providerBudgetAlert.findMany({
    where: { teamId: input.teamId, occurredAtUtc: { gte: since } },
    orderBy: { occurredAtUtc: "desc" },
    include: { budget: true },
    take: 500,
  });
  const rows: BudgetBreachRow[] = alerts.map((a: (typeof alerts)[number]) => ({
    id: a.id,
    budgetId: a.budgetId,
    threshold: a.threshold as "SOFT" | "HARD",
    consumedUsdMicros: Number(a.consumedUsdMicros),
    occurredAtUtc: a.occurredAtUtc.toISOString(),
    budgetScope: a.budget.scope as ProviderBudgetScope,
    budgetScopeTargetId: a.budget.scopeTargetId,
    budgetPeriod: a.budget.period as ProviderBudgetPeriod,
    budgetProvider: a.budget.provider as MediaIntelligenceProvider | null,
    softLimitUsdMicros: Number(a.budget.softLimitUsdMicros),
    hardLimitUsdMicros: Number(a.budget.hardLimitUsdMicros),
  }));
  const softBreaches = rows.filter((r) => r.threshold === "SOFT").length;
  const hardBreaches = rows.filter((r) => r.threshold === "HARD").length;
  return {
    generatedAtUtc: new Date().toISOString(),
    teamId: input.teamId,
    range: input.range,
    totalBreaches: rows.length,
    softBreaches,
    hardBreaches,
    rows,
  };
}

export async function listBudgetSpend(input: {
  prisma?: PrismaClient;
  teamId: string;
}): Promise<BudgetSpendProjection> {
  const prisma = input.prisma ?? defaultPrisma;
  const budgets = await prisma.providerBudget.findMany({
    where: { teamId: input.teamId },
    orderBy: { createdAt: "desc" },
  });
  const rows: BudgetSpendRow[] = [];
  for (const b of budgets) {
    const periodStartDate = periodStart(b.period as ProviderBudgetPeriod);
    const consumed = await sumConsumed({
      prisma,
      teamId: input.teamId,
      scope: b.scope as ProviderBudgetScope,
      scopeTargetId: b.scopeTargetId,
      provider: b.provider as MediaIntelligenceProvider | null,
      sinceUtc: periodStartDate,
    });
    const periodEnd = periodEndDate(b.period as ProviderBudgetPeriod, periodStartDate);
    const elapsedMs = Date.now() - periodStartDate.getTime();
    const totalMs = periodEnd.getTime() - periodStartDate.getTime();
    const proportionElapsed = totalMs > 0 ? elapsedMs / totalMs : 1;
    const projected =
      proportionElapsed > 0 ? Math.round(consumed / proportionElapsed) : consumed;
    const hard = Number(b.hardLimitUsdMicros);
    const soft = Number(b.softLimitUsdMicros);
    const threshold: BudgetSpendRow["thresholdStatus"] =
      consumed >= hard
        ? "EXHAUSTED"
        : projected > hard
        ? "BLOCK"
        : projected > soft
        ? "WARN"
        : "OK";
    rows.push({
      budgetId: b.id,
      scope: b.scope as ProviderBudgetScope,
      scopeTargetId: b.scopeTargetId,
      provider: b.provider as MediaIntelligenceProvider | null,
      period: b.period as ProviderBudgetPeriod,
      softLimitUsdMicros: soft,
      hardLimitUsdMicros: hard,
      consumedUsdMicrosThisPeriod: consumed,
      remainingUsdMicros: Math.max(hard - consumed, 0),
      projectedSpendUsdMicros: projected,
      thresholdStatus: threshold,
    });
  }
  return {
    generatedAtUtc: new Date().toISOString(),
    teamId: input.teamId,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Helpers — scoped consumption + period boundaries.
// ---------------------------------------------------------------------------

/**
 * Phase 3B Closure — honour scopeTargetId for CASE / PROJECT
 * budgets. Prior to closure this filtered only by team + provider,
 * which caused per-case + per-project budgets to compare against
 * team-wide spend (silent over-spend).
 */
async function sumConsumed(input: {
  prisma: PrismaClient;
  teamId: string;
  scope: ProviderBudgetScope;
  scopeTargetId: string | null;
  provider: MediaIntelligenceProvider | null;
  sinceUtc: Date;
}): Promise<number> {
  const sum = await input.prisma.providerUsageEvent.aggregate({
    where: {
      teamId: input.teamId,
      occurredAtUtc: { gte: input.sinceUtc },
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.scope === "CASE" && input.scopeTargetId
        ? { caseId: input.scopeTargetId }
        : {}),
      ...(input.scope === "PROJECT" && input.scopeTargetId
        ? { projectId: input.scopeTargetId }
        : {}),
      decision: { not: "BLOCK" },
    },
    _sum: { estimatedCostUsdMicros: true },
  });
  return Number(sum._sum.estimatedCostUsdMicros ?? 0n);
}

function periodStart(period: ProviderBudgetPeriod): Date {
  const now = new Date();
  switch (period) {
    case "DAILY":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case "WEEKLY": {
      const d = new Date(now);
      d.setDate(now.getDate() - now.getDay());
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case "MONTHLY":
      return new Date(now.getFullYear(), now.getMonth(), 1);
    case "QUARTERLY": {
      const q = Math.floor(now.getMonth() / 3);
      return new Date(now.getFullYear(), q * 3, 1);
    }
    case "ANNUAL":
      return new Date(now.getFullYear(), 0, 1);
  }
}

function periodEndDate(period: ProviderBudgetPeriod, start: Date): Date {
  switch (period) {
    case "DAILY":
      return new Date(start.getTime() + 24 * 60 * 60 * 1000);
    case "WEEKLY":
      return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
    case "MONTHLY":
      return new Date(start.getFullYear(), start.getMonth() + 1, 1);
    case "QUARTERLY":
      return new Date(start.getFullYear(), start.getMonth() + 3, 1);
    case "ANNUAL":
      return new Date(start.getFullYear() + 1, 0, 1);
  }
}

// Bounded re-export so the orchestrator can pass the new shape.
export type { ProviderBudgetGateResult };
// Keep the decisions enum reachable for downstream tests.
void PROVIDER_BUDGET_DECISIONS;
