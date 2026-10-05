/**
 * INTERNAL PLAN GRANT — the ONE reader of an account's active grant.
 *
 * Every plan resolution that answers for a PERSONAL subject — the API's two
 * workspace-scope builders and the worker's per-evidence resolution — calls
 * this, so API, worker, web and mobile cannot disagree about whether a grant is
 * in force. "In force" means: not revoked, and either no expiry or an expiry in
 * the future. An expired-but-unrevoked row is ignored here (the plan falls back
 * immediately); the write authority closes it (reason EXPIRED) on the next
 * apply/revoke/expiry sweep so the audit trail records when it lapsed.
 *
 * The writer lives in services/api (internal-plan-grant.service.ts); this module
 * never writes.
 */
import type { PrismaClient } from "@prisma/client";

/** The plan values a grant may carry. TEAM only (DB CHECK as well). */
export const GRANTABLE_INTERNAL_PLANS = ["TEAM"] as const;
export type GrantableInternalPlan = (typeof GRANTABLE_INTERNAL_PLANS)[number];

export type ActiveInternalPlanGrant = {
  id: string;
  plan: GrantableInternalPlan;
  source: "INTERNAL_TEST";
  expiresAtUtc: Date | null;
};

type PlanGrantReader = Pick<PrismaClient, "planGrant">;

/** The active, unexpired grant for this account, or null. Never throws for "none". */
export async function readActiveInternalPlanGrant(
  client: PlanGrantReader,
  userId: string,
  now: Date = new Date(),
): Promise<ActiveInternalPlanGrant | null> {
  const row = await client.planGrant.findFirst({
    where: {
      userId,
      revokedAtUtc: null,
      OR: [{ expiresAtUtc: null }, { expiresAtUtc: { gt: now } }],
    },
    orderBy: { grantedAtUtc: "desc" },
    select: { id: true, plan: true, source: true, expiresAtUtc: true },
  });
  if (!row) return null;
  if (!(GRANTABLE_INTERNAL_PLANS as readonly string[]).includes(row.plan)) return null;
  return {
    id: row.id,
    plan: row.plan as GrantableInternalPlan,
    source: row.source as "INTERNAL_TEST",
    expiresAtUtc: row.expiresAtUtc,
  };
}

/**
 * Does a granted plan cover `plan`? Commercial order FREE < PAYG < PRO < TEAM <
 * ENTERPRISE (the same order as shared-billing PLAN_RANK; this package does not
 * depend on shared-billing, and only TEAM is ever granted).
 */
const COVER_ORDER: Readonly<Record<string, number>> = Object.freeze({
  FREE: 0,
  PAYG: 1,
  PRO: 2,
  TEAM: 3,
  ENTERPRISE: 4,
});
export function internalGrantCoversPlan(grantPlan: string, plan: string): boolean {
  const g = COVER_ORDER[grantPlan];
  const p = COVER_ORDER[plan];
  return g !== undefined && p !== undefined && g >= p;
}
