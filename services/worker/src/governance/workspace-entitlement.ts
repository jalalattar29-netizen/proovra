/**
 * RG-13 (WS-ENT, 2026-11-18) — the packaging entitlement, as this host's
 * sweeps ask it.
 *
 * The DECISION is the shared one (`resolveWorkerFeatureEntitlement`,
 * @proovra/shared-runtime), the same rule the API's `resolveEntitlement`
 * applies. This module only reads the one fact the shared decision needs from
 * this host: the workspace's Enterprise standing (its effective plan, from the
 * same per-host scope reader the storage gate uses, and its contract status).
 *
 * FAIL CLOSED everywhere: a workspace that cannot be read, an Enterprise
 * workspace without a readable ACTIVE contract, or a grant read that fails all
 * answer "not entitled". The sweeps that ask (archive-tier auto-transition,
 * lifecycle webhook dispatch) then do nothing for that workspace this tick,
 * which is reversible: the next tick asks again.
 */

import type { EntitlementStanding, WorkerFeatureEntitlementKey } from "@proovra/shared-runtime";
import { resolveWorkerFeatureEntitlement } from "@proovra/shared-runtime";

import { prisma } from "../db.js";
import { getTeamWorkspaceScope } from "../workspace-billing.js";

/**
 * Whether a contract's end date may take effect is behind the automatic
 * plan-lowering switch on the API (`contractTermHasEnded`); the same variable
 * is read here so the two hosts cannot disagree about one date.
 */
function contractTermEnded(endsAtUtc: Date | null, now: Date): boolean {
  return (
    process.env.BILLING_AUTO_PLAN_LOWERING === "on" &&
    endsAtUtc !== null &&
    endsAtUtc.getTime() <= now.getTime()
  );
}

export async function workerEnterpriseStanding(
  teamId: string,
  now: Date = new Date(),
): Promise<EntitlementStanding> {
  const scope = await getTeamWorkspaceScope(teamId);
  if (scope.plan !== "ENTERPRISE") return "NOT_ENTERPRISE";
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { organizationId: true },
  });
  if (!team?.organizationId) return "CONTRACT_LAPSED";
  const contract = await prisma.enterpriseContract.findUnique({
    where: { organizationId: team.organizationId },
    select: { status: true, endsAtUtc: true },
  });
  return contract && contract.status === "ACTIVE" && !contractTermEnded(contract.endsAtUtc, now)
    ? "CONTRACT_ACTIVE"
    : "CONTRACT_LAPSED";
}

export async function workerFeatureEntitled(
  teamId: string,
  key: WorkerFeatureEntitlementKey,
): Promise<boolean> {
  try {
    const standing = await workerEnterpriseStanding(teamId);
    return await resolveWorkerFeatureEntitlement(prisma, { teamId, key, standing });
  } catch {
    return false;
  }
}
