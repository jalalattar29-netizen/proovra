/**
 * RG-04 (PRO-AI1C-01 / PRO-AI1-01 / PRO-W2-01 / PRO-W2-02 / PRO-W2-03) —
 * THE worker's one semantic-egress decision.
 *
 * "May this workspace's evidence-derived text leave the platform for the
 * embedding vendor?" is ONE rule. The API answers it with
 * `evaluateSemanticEgress` (workspace-ai-policy.service.ts): the canonical
 * `evaluateWorkspaceAiPolicy(SEMANTIC_SEARCH, DERIVED_CONTENT)` with
 * `embeddingsAllowed` folded into `decideAiPolicy` and the per-capability plan
 * eligibility + commercial lifecycle as `planAllowed`. This host may not
 * import API source, so the same inputs are read and decided HERE, once, and
 * every worker path that can cause an embedding call (mi-embed, the
 * search-index safety net, the stranded-chunk reconciler) asks this module.
 *
 * Fail closed: a read failure THROWS. Callers on a queue let it propagate so
 * BullMQ retries; callers that only enqueue treat a throw as "not now".
 */
import { planIncludesAiCapability, type PlanType } from "@proovra/shared-billing";
import { readCommercialLifecycle } from "@proovra/shared-runtime";

import { prisma } from "./db.js";
import { getTeamWorkspaceScope, workspaceContractWithheld } from "./workspace-billing.js";

export type SemanticEgressDenial =
  | "GLOBAL_DISABLED"
  | "WORKSPACE_DISABLED"
  | "FEATURE_DISABLED"
  | "EMBEDDINGS_NOT_ALLOWED"
  | "DATA_CLASS_NOT_ALLOWED"
  | "PLAN_NOT_ENTITLED"
  | "COMMERCIAL_LIFECYCLE_RESTRICTED"
  | "CONTRACT_WITHHELD";

export type SemanticEgressDecision =
  | { allowed: true; denial: null }
  | { allowed: false; denial: SemanticEgressDenial };

/**
 * The policy half — pure, so its parity with the API's `decideAiPolicy`
 * (steps 1, 3, 4, 4b and the DERIVED_CONTENT data-class rule) is testable
 * without a database. A missing row is the API's safe default: semantic off.
 */
export function decideSemanticEgressPolicy(input: {
  globalEnabled: boolean;
  policy: {
    aiEnabled: boolean;
    semanticSearchEnabled: boolean;
    embeddingsAllowed: boolean;
    contentIntelligenceEnabled: boolean;
  } | null;
}): SemanticEgressDecision {
  if (!input.globalEnabled) return { allowed: false, denial: "GLOBAL_DISABLED" };
  const p = input.policy;
  if (!p) return { allowed: false, denial: "FEATURE_DISABLED" };
  if (!p.aiEnabled) return { allowed: false, denial: "WORKSPACE_DISABLED" };
  if (!p.semanticSearchEnabled) return { allowed: false, denial: "FEATURE_DISABLED" };
  if (!p.embeddingsAllowed) return { allowed: false, denial: "EMBEDDINGS_NOT_ALLOWED" };
  // Chunk text is DERIVED_CONTENT (OCR / transcript / extracted text).
  if (!p.contentIntelligenceEnabled) return { allowed: false, denial: "DATA_CLASS_NOT_ALLOWED" };
  return { allowed: true, denial: null };
}

/**
 * The full decision for a workspace: policy row, then the commercial verdict
 * (plan makes SEMANTIC_SEARCH eligible, lifecycle allows paid operations, an
 * Enterprise workspace has an ACTIVE contract). Throws on any read failure.
 */
export async function workspaceSemanticEgressAllowed(
  teamId: string,
): Promise<SemanticEgressDecision> {
  const policyRow = await prisma.workspaceAiPolicy.findUnique({
    where: { teamId },
    select: {
      aiEnabled: true,
      semanticSearchEnabled: true,
      embeddingsAllowed: true,
      contentIntelligenceEnabled: true,
    },
  });
  const policy = decideSemanticEgressPolicy({
    globalEnabled: process.env.SEMANTIC_SEARCH_ENABLED === "true",
    policy: policyRow,
  });
  if (!policy.allowed) return policy;

  const scope = await getTeamWorkspaceScope(teamId);
  const plan = String(scope.plan) as PlanType;
  if (!planIncludesAiCapability(plan, "SEMANTIC_SEARCH")) {
    return { allowed: false, denial: "PLAN_NOT_ENTITLED" };
  }
  const lifecycle = await readCommercialLifecycle(
    prisma,
    scope.billingShape === "SINGLE_OCCUPANT" || !scope.teamId
      ? { kind: "PERSONAL", ownerUserId: scope.ownerUserId, plan }
      : { kind: "WORKSPACE", teamId: scope.teamId, plan },
  );
  if (!lifecycle.mutationsAllowed) {
    return { allowed: false, denial: "COMMERCIAL_LIFECYCLE_RESTRICTED" };
  }
  if (await workspaceContractWithheld(teamId)) {
    return { allowed: false, denial: "CONTRACT_WITHHELD" };
  }
  return { allowed: true, denial: null };
}

// --------------------------------------------------------------------------
// Spend caps — the worker's mirror of the API's semantic-budget.service.
// --------------------------------------------------------------------------

function dailyChunkCap(): number {
  const raw = process.env.SEMANTIC_MAX_CHUNKS_PER_WORKSPACE_PER_DAY;
  const v = raw ? Number.parseInt(raw, 10) : 5_000;
  return Number.isFinite(v) && v >= 0 ? v : 5_000;
}

function monthlyBudgetEur(): number {
  const raw = process.env.SEMANTIC_MONTHLY_BUDGET_EUR;
  const v = raw ? Number.parseFloat(raw) : 100;
  return Number.isFinite(v) && v >= 0 ? v : 100;
}

function dateUtcMidnight(): Date {
  const at = new Date();
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function firstOfMonthUtc(): Date {
  const at = new Date();
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/**
 * PRO-W2-02 — an unreadable usage row is NOT permission to spend: a read
 * failure refuses (`USAGE_UNREADABLE`) instead of lifting the caps.
 */
export async function canEmbedMore(
  workspaceId: string,
  additional: number,
): Promise<{
  allowed: boolean;
  reason: "DAILY_CAP" | "MONTHLY_BUDGET" | "USAGE_UNREADABLE" | null;
}> {
  const dailyCap = dailyChunkCap();
  const monthlyCap = monthlyBudgetEur();
  if (dailyCap <= 0 && monthlyCap <= 0) return { allowed: true, reason: null };
  try {
    const today = dateUtcMidnight();
    const monthStart = firstOfMonthUtc();
    const [todayRow, monthRows] = await Promise.all([
      prisma.semanticUsageDaily.findUnique({
        where: { workspaceId_dateUtc: { workspaceId, dateUtc: today } },
        select: { chunksEmbedded: true, eurSpentMicros: true },
      }),
      prisma.semanticUsageDaily.findMany({
        where: { workspaceId, dateUtc: { gte: monthStart } },
        select: { chunksEmbedded: true, eurSpentMicros: true },
      }),
    ]);
    const todayChunks = todayRow?.chunksEmbedded ?? 0;
    const monthMicros = monthRows.reduce((acc, r) => acc + (r.eurSpentMicros ?? 0n), 0n);
    const monthEur = Number(monthMicros) / 1_000_000;
    if (dailyCap > 0 && todayChunks + additional > dailyCap) {
      return { allowed: false, reason: "DAILY_CAP" };
    }
    if (monthlyCap > 0 && monthEur >= monthlyCap) {
      return { allowed: false, reason: "MONTHLY_BUDGET" };
    }
    return { allowed: true, reason: null };
  } catch {
    return { allowed: false, reason: "USAGE_UNREADABLE" };
  }
}
