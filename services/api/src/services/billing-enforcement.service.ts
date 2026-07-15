import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import { consumeCredits } from "./billing.service.js";
import { getPlanCapabilities } from "./plan-catalog.service.js";
import {
  getPersonalWorkspaceScope,
  getTeamWorkspaceScope,
  type WorkspaceScope,
} from "./workspace-billing.service.js";
import {
  assertWorkspaceStorageAvailable,
  getWorkspaceUsage,
} from "./workspace-usage.service.js";
import { isInternalUnlimitedTester } from "./internal-testers.js";

type EntitlementWriter = Pick<prismaPkg.Prisma.TransactionClient, "entitlement">;

/**
 * Canonical entry point used by routes to build a WorkspaceScope for the
 * authenticated requester. `params.ownerUserId` MUST be the requester's
 * userId (sourced from `getAuthUserId(req)` against the verified JWT in
 * `middleware/auth.ts`) — NEVER from a request body, header, or query
 * string. The requester's email is looked up server-side from the
 * `users` table and attached to `scope.authenticatedUserEmail`, which
 * the internal-tester bypass helper (`services/internal-testers.ts`)
 * reads to short-circuit limit assertions for a tiny QA allow-list.
 */
export async function resolveWorkspaceScopeForUser(params: {
  ownerUserId: string;
  teamId?: string | null;
}): Promise<WorkspaceScope> {
  const [scope, requesterUser] = await Promise.all([
    params.teamId
      ? getTeamWorkspaceScope(params.teamId)
      : getPersonalWorkspaceScope(params.ownerUserId),
    prisma.user.findUnique({
      where: { id: params.ownerUserId },
      select: { email: true },
    }),
  ]);

  return {
    ...scope,
    authenticatedUserEmail: requesterUser?.email ?? null,
  };
}

/**
 * INTERNAL TESTING BYPASS — single chokepoint.
 *
 * Returns `true` when the scope's authenticated requester is on the
 * internal-tester allow-list (`services/internal-testers.ts`). Every
 * `assertWorkspaceAllows*` / `consumeWorkspaceCompletionCredits` entry
 * point in this file calls this FIRST and early-returns when true, so
 * customer billing logic, plan capabilities, and limit errors remain
 * intact for everyone else. `scope.authenticatedUserEmail` is populated
 * server-side by `resolveWorkspaceScopeForUser` above — clients cannot
 * influence the value.
 */
function shouldBypassForInternalTester(scope: WorkspaceScope): boolean {
  return isInternalUnlimitedTester(scope.authenticatedUserEmail);
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Pricing-hardening evidence-creation gate.
 *
 * Enforcement matrix (canonical source: PLAN_CAPABILITIES):
 *
 *   FREE        — lifetime cap (3). Legacy override honoured if set.
 *   PAYG        — no record cap. Credit-bound.
 *   PRO         — lifetime cap (100). Legacy override honoured if set.
 *   TEAM        — rolling 30-day cap (500) measured against the team's
 *                 non-deleted Evidence.createdAt history. No lifetime cap.
 *   ENTERPRISE  — no record cap (custom; Sales-provisioned).
 *
 * The legacy override is sourced from `Entitlement.legacyRecordCapOverride`
 * and projected onto `scope.legacyRecordCapOverride` by
 * `workspace-billing.service`. When set on a PRO account it replaces the
 * lifetime cap, grandfathering accounts that already exceeded 100 records
 * at migration time. New creation is blocked above the override, never
 * below; existing records remain accessible.
 */
export async function assertWorkspaceAllowsEvidenceCreation(
  scope: WorkspaceScope
) {
  // Internal testing bypass — see services/internal-testers.ts.
  if (shouldBypassForInternalTester(scope)) return;
  const caps = getPlanCapabilities(scope.plan);

  if (scope.workspaceType === "TEAM" && !caps.allowsTeamWorkspace) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Current plan does not include team workspace evidence creation"
    );
    err.statusCode = 409;
    err.code = "TEAM_PLAN_REQUIRED";
    throw err;
  }

  if (scope.workspaceType === "TEAM") {
    // Rolling 30-day cap on TEAM workspaces. ENTERPRISE workspaces have
    // null monthly cap and skip the count. The team's `evidence_team_id_created_at_idx`
    // compound index covers this query.
    const monthlyCap = caps.maxEvidenceRecordsPerMonth;
    if (monthlyCap === null || monthlyCap <= 0) {
      return;
    }

    if (!scope.teamId) {
      // Defence-in-depth: TEAM scope without teamId is a schema
      // violation; refuse rather than silently allowing.
      const err: Error & { statusCode?: number; code?: string } = new Error(
        "TEAM scope missing teamId"
      );
      err.statusCode = 409;
      err.code = "TEAM_PLAN_REQUIRED";
      throw err;
    }

    const since = new Date(Date.now() - THIRTY_DAYS_MS);
    const monthlyCount = await prisma.evidence.count({
      where: {
        teamId: scope.teamId,
        deletedAt: null,
        createdAt: { gte: since },
      },
    });

    if (monthlyCount >= monthlyCap) {
      const err: Error & { statusCode?: number; code?: string } = new Error(
        "Team monthly evidence-record limit reached"
      );
      err.statusCode = 409;
      err.code = "EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED";
      throw err;
    }

    return;
  }

  // PERSONAL scope below.
  //
  // Phase HOME-DATA-OWNERSHIP — personal records are no longer
  // `teamId NULL`-only: new captures stamp the owner's personal Team
  // id, and the backfill migrates legacy NULL rows to it. Count both
  // shapes so plan limits survive the migration. (Evidence has no
  // `team` relation field, so the personal team id is resolved first.)
  const personalTeam = await prisma.team.findFirst({
    where: { ownerUserId: scope.ownerUserId, isPersonal: true },
    select: { id: true },
  });
  const evidenceCount = await prisma.evidence.count({
    where: {
      ownerUserId: scope.ownerUserId,
      deletedAt: null,
      OR: [
        { teamId: null },
        ...(personalTeam ? [{ teamId: personalTeam.id }] : []),
      ],
    },
  });

  // Effective lifetime cap: legacy override if set, else plan default.
  const planLifetimeCap = caps.maxEvidenceRecords;
  const effectiveLifetimeCap =
    scope.legacyRecordCapOverride !== null &&
    scope.legacyRecordCapOverride !== undefined
      ? scope.legacyRecordCapOverride
      : planLifetimeCap;

  const creditsRequired = caps.paygCreditsRequiredPerCompletion ?? 0;
  const availableCredits = scope.credits ?? 0;

  // No lifetime cap => either credit-bound (PAYG) or uncapped (ENTERPRISE).
  if (effectiveLifetimeCap === null) {
    if (creditsRequired > 0) {
      if (availableCredits < creditsRequired) {
        const err: Error & { statusCode?: number; code?: string } = new Error(
          "Insufficient credits"
        );
        err.statusCode = 402;
        err.code = "INSUFFICIENT_CREDITS";
        throw err;
      }
    }
    return;
  }

  // Lifetime cap path (FREE 3, PRO 100, or legacy override).
  if (evidenceCount < effectiveLifetimeCap) {
    return;
  }

  if (creditsRequired > 0) {
    if (availableCredits < creditsRequired) {
      const err: Error & { statusCode?: number; code?: string } = new Error(
        "Insufficient credits"
      );
      err.statusCode = 402;
      err.code = "INSUFFICIENT_CREDITS";
      throw err;
    }
    return;
  }

  // Cap reached. Distinguish FREE for backcompat code consumers while
  // emitting the new canonical code for everyone else.
  const isFree = scope.plan === prismaPkg.PlanType.FREE;
  const err: Error & { statusCode?: number; code?: string } = new Error(
    isFree
      ? "Free evidence limit reached"
      : "Evidence record limit reached for current plan"
  );
  err.statusCode = 409;
  err.code = isFree ? "FREE_LIMIT_REACHED" : "EVIDENCE_RECORD_LIMIT_REACHED";
  throw err;
}

export async function assertWorkspaceAllowsStorageGrowth(params: {
  scope: WorkspaceScope;
  incomingBytes?: bigint | number | null;
}) {
  // Internal testing bypass — see services/internal-testers.ts.
  if (shouldBypassForInternalTester(params.scope)) return;
  return assertWorkspaceStorageAvailable(params);
}

export async function assertWorkspaceAllowsReport(scope: WorkspaceScope) {
  // Internal testing bypass — see services/internal-testers.ts.
  if (shouldBypassForInternalTester(scope)) return;
  const caps = getPlanCapabilities(scope.plan);

  if (!caps.reportsIncluded) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Report generation is not included in the current plan"
    );
    err.statusCode = 409;
    err.code = "REPORT_NOT_INCLUDED";
    throw err;
  }
}

/**
 * Secure-intake plan gate (Teams Entitlement Alignment follow-up,
 * 2026-07-15). Intake links + submission requests are excluded from
 * FREE per the published Pricing contract (`intakeIncluded`). This
 * enforces the commercial contract at the CREATION boundary — before
 * any WorkflowIntakeLink / EvidenceRequest row is written — so the
 * `intake_*` Operations Center sources are structurally impossible for
 * plans that exclude intake, not merely hidden in the UI. Same shape
 * as the report/package guards (409 + stable code).
 */
export async function assertWorkspaceAllowsIntake(scope: WorkspaceScope) {
  if (shouldBypassForInternalTester(scope)) return;
  const caps = getPlanCapabilities(scope.plan);

  if (!caps.intakeIncluded) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Secure intake (intake links and submission requests) is not included in the current plan"
    );
    err.statusCode = 409;
    err.code = "INTAKE_NOT_INCLUDED";
    throw err;
  }
}

export async function assertWorkspaceAllowsVerificationPackage(
  scope: WorkspaceScope
) {
  // Internal testing bypass — see services/internal-testers.ts.
  if (shouldBypassForInternalTester(scope)) return;
  const caps = getPlanCapabilities(scope.plan);

  if (!caps.verificationPackageIncluded) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Verification package is not included in the current plan"
    );
    err.statusCode = 409;
    err.code = "VERIFICATION_PACKAGE_NOT_INCLUDED";
    throw err;
  }
}

export async function assertWorkspaceAllowsReportStorage(params: {
  scope: WorkspaceScope;
  incomingBytes?: bigint | number | null;
}) {
  // Internal testing bypass — see services/internal-testers.ts.
  if (shouldBypassForInternalTester(params.scope)) return;
  await assertWorkspaceAllowsReport(params.scope);
  return assertWorkspaceStorageAvailable({
    scope: params.scope,
    incomingBytes: params.incomingBytes ?? 0n,
  });
}

export async function assertWorkspaceAllowsVerificationPackageStorage(params: {
  scope: WorkspaceScope;
  incomingBytes?: bigint | number | null;
}) {
  // Internal testing bypass — see services/internal-testers.ts.
  if (shouldBypassForInternalTester(params.scope)) return;
  await assertWorkspaceAllowsVerificationPackage(params.scope);
  return assertWorkspaceStorageAvailable({
    scope: params.scope,
    incomingBytes: params.incomingBytes ?? 0n,
  });
}

export async function getWorkspaceAvailableStorageBytes(
  scope: WorkspaceScope
): Promise<bigint> {
  const usage = await getWorkspaceUsage(scope);
  return usage.storageBytesRemaining;
}

export async function consumeWorkspaceCompletionCredits(
  scope: WorkspaceScope,
  tx?: EntitlementWriter
) {
  // Internal testing bypass — see services/internal-testers.ts. Skips
  // credit deduction entirely for the allow-listed QA account so
  // completion flows are unmetered during development.
  if (shouldBypassForInternalTester(scope)) return;
  const caps = getPlanCapabilities(scope.plan);
  const required = caps.paygCreditsRequiredPerCompletion;

  if (required <= 0) {
    return;
  }

  if (!tx) {
    await consumeCredits(scope.ownerUserId, required);
    return;
  }

  const decremented = await tx.entitlement.updateMany({
    where: {
      userId: scope.ownerUserId,
      active: true,
      credits: { gte: required },
    },
    data: {
      credits: { decrement: required },
    },
  });

  if (decremented.count !== 1) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Insufficient credits"
    );
    err.statusCode = 402;
    err.code = "INSUFFICIENT_CREDITS";
    throw err;
  }
}

export async function getWorkspaceBillingSummary(scope: WorkspaceScope) {
  const caps = getPlanCapabilities(scope.plan);
  const usage = await getWorkspaceUsage(scope);

  return {
    scope,
    capabilities: caps,
    usage,
  };
}

// ────────────────────────────────────────────────────────────────────
// Plan-aware AI advisory monthly cap
// ────────────────────────────────────────────────────────────────────

const AI_USAGE_KEY = "ai_advisory_operations" as const;

function startOfCurrentMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Resolve the durable "owning" team id for AI usage accounting. Team
 * workspaces account on the team itself; personal workspaces account on
 * the user's personal Team row (which `ensurePersonalWorkspace` creates
 * for every authenticated user). Returns null if the personal team has
 * not been bootstrapped yet — in that case the cap cannot be enforced
 * durably and the caller must rely on in-memory abuse limits.
 */
async function resolveAiUsageTenantId(
  scope: WorkspaceScope,
): Promise<string | null> {
  if (scope.teamId) return scope.teamId;
  const personalTeam = await prisma.team.findFirst({
    where: { ownerUserId: scope.ownerUserId, isPersonal: true },
    select: { id: true },
  });
  return personalTeam?.id ?? null;
}

/**
 * Throws AI_MONTHLY_LIMIT_REACHED (429) when the active plan's monthly
 * AI advisory cap has been reached. Counts persistent usage out of
 * EntitlementUsage so the cap survives process restarts.
 *
 * `aiAdvisoryMonthlyOperations`:
 *   - 0   = AI disabled at this tier (FREE)
 *   - n>0 = monthly cap
 *   - null = custom / no cap (ENTERPRISE)
 */
export async function assertWorkspaceAllowsAiOperation(
  scope: WorkspaceScope,
): Promise<void> {
  // Internal testing bypass — see services/internal-testers.ts.
  if (shouldBypassForInternalTester(scope)) return;
  const caps = getPlanCapabilities(scope.plan);
  const cap = caps.aiAdvisoryMonthlyOperations;

  if (cap === null) return; // ENTERPRISE / custom — no monthly cap.
  if (cap <= 0) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "AI assistance is not included in the current plan",
    );
    err.statusCode = 402;
    err.code = "AI_MONTHLY_LIMIT_REACHED";
    throw err;
  }

  const tenantId = await resolveAiUsageTenantId(scope);
  if (!tenantId) {
    // Personal team hasn't been bootstrapped; allow with daily abuse
    // limits handled by AiCostGuard. New users hit this path at most
    // once before `ensurePersonalWorkspace` creates the team row.
    return;
  }

  const periodStartUtc = startOfCurrentMonthUtc();
  const usage = await prisma.entitlementUsage.findUnique({
    where: {
      teamId_key_periodStartUtc: {
        teamId: tenantId,
        key: AI_USAGE_KEY,
        periodStartUtc,
      },
    },
    select: { consumed: true },
  });

  const consumed = Number(usage?.consumed ?? 0n);
  if (consumed >= cap) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Monthly AI advisory limit reached for current plan",
    );
    err.statusCode = 429;
    err.code = "AI_MONTHLY_LIMIT_REACHED";
    throw err;
  }
}

/**
 * Idempotent upsert that increments the durable AI usage counter for
 * the current UTC month. Call ONLY after a successful AI operation; on
 * upstream failure the consumer's allowance is preserved.
 */
export async function recordWorkspaceAiOperation(
  scope: WorkspaceScope,
): Promise<void> {
  const tenantId = await resolveAiUsageTenantId(scope);
  if (!tenantId) return;

  const periodStartUtc = startOfCurrentMonthUtc();
  await prisma.entitlementUsage.upsert({
    where: {
      teamId_key_periodStartUtc: {
        teamId: tenantId,
        key: AI_USAGE_KEY,
        periodStartUtc,
      },
    },
    create: {
      teamId: tenantId,
      key: AI_USAGE_KEY,
      periodStartUtc,
      consumed: 1n,
    },
    update: {
      consumed: { increment: 1n },
    },
  });
}

export async function getWorkspaceAiUsageThisMonth(
  scope: WorkspaceScope,
): Promise<{ consumed: number; cap: number | null }> {
  const caps = getPlanCapabilities(scope.plan);
  const cap = caps.aiAdvisoryMonthlyOperations;
  const tenantId = await resolveAiUsageTenantId(scope);
  if (!tenantId) return { consumed: 0, cap };

  const periodStartUtc = startOfCurrentMonthUtc();
  const usage = await prisma.entitlementUsage.findUnique({
    where: {
      teamId_key_periodStartUtc: {
        teamId: tenantId,
        key: AI_USAGE_KEY,
        periodStartUtc,
      },
    },
    select: { consumed: true },
  });

  return { consumed: Number(usage?.consumed ?? 0n), cap };
}

// ────────────────────────────────────────────────────────────────────
// Enterprise feature gate
// ────────────────────────────────────────────────────────────────────

import { planHasEnterpriseFeature } from "./plan-catalog.service.js";
import type { EnterpriseFeatureFlags } from "./plan-catalog.service.js";

/**
 * Throws ENTERPRISE_FEATURE_REQUIRED (402) when the active workspace
 * plan does not include the requested governance feature. Used by SSO/
 * SCIM, MFA admin, legal hold, retention policy, organization audit
 * log, and Object Lock routes.
 */
export function assertWorkspaceAllowsEnterpriseFeature(
  scope: WorkspaceScope,
  feature: keyof EnterpriseFeatureFlags,
): void {
  if (planHasEnterpriseFeature(scope.plan, feature)) return;
  const err: Error & { statusCode?: number; code?: string } = new Error(
    `Feature "${feature}" is included only on Enterprise plans`,
  );
  err.statusCode = 402;
  err.code = "ENTERPRISE_FEATURE_REQUIRED";
  throw err;
}

/**
 * Team-aware Enterprise-feature gate. Resolves the team's effective
 * plan (billingPlan when ACTIVE/PAST_DUE; otherwise the team owner's
 * Entitlement plan) and rejects if the plan does not include the
 * requested feature. Use this on team-scoped routes (retention
 * policies, legal hold, organization audit, etc.) where the gate
 * MUST follow the team's billing plan, not the caller's personal plan.
 */
export async function assertTeamAllowsEnterpriseFeature(
  teamId: string,
  feature: keyof EnterpriseFeatureFlags,
): Promise<void> {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { ownerUserId: true, billingPlan: true, billingStatus: true },
  });
  if (!team) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Team not found",
    );
    err.statusCode = 404;
    err.code = "TEAM_NOT_FOUND";
    throw err;
  }
  let effectivePlan: prismaPkg.PlanType = team.billingPlan;
  if (
    team.billingStatus !== prismaPkg.TeamBillingStatus.ACTIVE &&
    team.billingStatus !== prismaPkg.TeamBillingStatus.PAST_DUE
  ) {
    const ent = await prisma.entitlement.findFirst({
      where: { userId: team.ownerUserId, active: true },
      orderBy: { createdAt: "desc" },
      select: { plan: true },
    });
    effectivePlan = ent?.plan ?? prismaPkg.PlanType.FREE;
  }
  if (!planHasEnterpriseFeature(effectivePlan, feature)) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      `Feature "${feature}" is included only on Enterprise plans`,
    );
    err.statusCode = 402;
    err.code = "ENTERPRISE_FEATURE_REQUIRED";
    throw err;
  }
}