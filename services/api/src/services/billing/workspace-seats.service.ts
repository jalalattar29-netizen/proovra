/**
 * THE ONE effective-workspace-seat resolver.
 *
 * =============================================================================
 * WHY THERE CAN ONLY BE ONE
 * =============================================================================
 * There were two, and they disagreed about the same workspace:
 *
 *   `getEffectiveSeatLimit`        (@proovra/shared-billing) returned 0 for any
 *                                  non-SHARED billing shape, with the comment
 *                                  "a single-occupant workspace has no seats to
 *                                  sell";
 *   `resolveEffectiveContractSeats` (enterprise-contract-limits) returned
 *                                  `max(maxWorkspaceSeats, includedSeats,
 *                                  persistedSeats)` and never looked at the
 *                                  shape at all.
 *
 * The first is what `workspace-billing.service` wrote onto `scope.teamSeats`.
 * The second is what `getWorkspaceUsage` and `assertTeamSeatAvailable` — the
 * ENFORCEMENT path — then computed, and because it takes a `max()` over the
 * catalog it discarded the deliberate 0 it had just been handed. So the
 * projection said one thing and the gate did another, on the same workspace, in
 * the same request.
 *
 * =============================================================================
 * WHAT A SEAT IS
 * =============================================================================
 * A seat is one DISTINCT ACTIVE workspace membership, and the owner holds one.
 *
 * That is the whole rule. In particular a Collaboration Team is NOT a seat
 * pool: a person assigned to five groups in a workspace consumes exactly one
 * seat, because they are one person with one membership. The old
 * `maxAcceptedMembersPerCollaborationTeam` behaved like a second commercial
 * quota over a second membership table, which is how a workspace could be told
 * it was "at capacity for your plan" on a group of five while the workspace
 * itself had room.
 *
 * SUSPENDED and REVOKED memberships hold no seat — they are denied access, and
 * charging for denied access is not a thing.
 *
 * PENDING invitations hold no seat either. They CLAIM one at acceptance, under
 * a per-workspace advisory lock, which is the only moment the arithmetic has to
 * be true (`workspace-invitation.service`).
 *
 * =============================================================================
 * WHERE THE NUMBER COMES FROM
 * =============================================================================
 * `PlanCapabilities.maxWorkspaceSeats`, resolved for the workspace's OWN
 * commercial subject — the owner's entitlement for a Personal workspace, the
 * contract for an Organization one. Never the actor's personal plan: an
 * invited user on FREE participates in a TEAM workspace on that workspace's
 * entitlement, and their own Personal Space stays FREE.
 *
 * An Enterprise contract seat count overrides the catalog. Nothing else does.
 */

import type { PlanType, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { getPlanCapabilities } from "@proovra/shared-billing";
import { resolveCommercialContext } from "./commercial-context.service.js";
import {
  resolveEffectiveContractSeats,
  resolveEnterpriseContractLimits,
} from "./enterprise-contract-limits.js";

export type WorkspaceSeatState = {
  plan: PlanType;
  /** Distinct ACTIVE workspace memberships, including the owner's. */
  used: number;
  /** Effective seat ceiling for this workspace. */
  limit: number;
  remaining: number;
  /** False when the plan sells no additional members at all. */
  featureIncluded: boolean;
  /** True when usage already exceeds the ceiling — a downgrade, not a bug. */
  overLimit: boolean;
  source: "PLAN_CATALOG" | "ENTERPRISE_CONTRACT";
};

/**
 * Resolve seats for one workspace.
 *
 * Accepts a transaction client so a caller holding the per-workspace advisory
 * lock counts under the SAME snapshot it will write in — counting on the
 * default client from inside a transaction is how a serialised check stops
 * being serialised.
 */
export async function resolveWorkspaceSeatState(
  workspaceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<WorkspaceSeatState> {
  const workspace = await client.team.findUnique({
    where: { id: workspaceId },
    select: { id: true, ownerUserId: true, includedSeats: true },
  });
  if (!workspace) {
    return {
      plan: "FREE" as PlanType,
      used: 0,
      limit: 0,
      remaining: 0,
      featureIncluded: false,
      overLimit: false,
      source: "PLAN_CATALOG",
    };
  }

  // The workspace's own commercial subject. `WORKSPACE` lets the canonical
  // resolver classify the kind and pick the right payer; it is the same call
  // every other commercial gate on this surface makes.
  const ctx = await resolveCommercialContext({
    type: "WORKSPACE",
    teamId: workspaceId,
    requesterUserId: workspace.ownerUserId,
  });

  const plan = ctx.plan;
  const catalogLimit = getPlanCapabilities(plan).maxWorkspaceSeats;
  // The contract PROJECTION is not the limits object: a DRAFT, SUSPENDED or
  // TERMINATED contract must not raise a ceiling, and
  // `resolveEnterpriseContractLimits` is the one place that fails closed on
  // status. Reading `seatCount` off the projection directly would grant a
  // terminated organization its contracted seats.
  const contractLimits = resolveEnterpriseContractLimits(ctx.enterpriseContract);
  const contractSeats = contractLimits.contractGovernsCapability
    ? resolveEffectiveContractSeats({
        plan,
        contract: contractLimits,
        persistedSeats: workspace.includedSeats ?? 0,
      })
    : null;
  const limit = contractSeats ?? catalogLimit;

  const used = await client.teamMember.count({
    where: { teamId: workspaceId, status: "ACTIVE" },
  });

  return {
    plan,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    // Every plan seats its owner. "Not included" means the plan sells no
    // ADDITIONAL members, which is a different sentence from "you have no
    // workspace" and the UI has to be able to say the right one.
    featureIncluded: limit > 1,
    overLimit: used > limit,
    source: contractSeats !== null ? "ENTERPRISE_CONTRACT" : "PLAN_CATALOG",
  };
}
