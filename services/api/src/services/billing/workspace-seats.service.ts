/**
 * THE workspace member-ceiling resolver, and the ONE commercial subject every
 * collaboration gate resolves.
 *
 * =============================================================================
 * WHAT THE PRODUCT SELLS (members audit ENT-04 / ENT-05 / CT-09, 2026-10-25)
 * =============================================================================
 * Collaboration capacity is PER COLLABORATION TEAM: PRO sells 2 groups of up to
 * 5 accepted members, TEAM 5 groups of up to 10. The workspace owner never
 * consumes one of those places, pending invitations consume nothing, and an
 * archived group frees its slot. That rule lives in the plan catalog
 * (`maxAcceptedMembersPerCollaborationTeam`) and is enforced where a group
 * gains a member (`lockAndAssertCollaborationTeamMemberCapacity`).
 *
 * There is NO workspace-wide pool. This resolver used to enforce one — PRO 5,
 * TEAM 10, owner included — at invitation acceptance, which is how a TEAM
 * workspace with nine members was refused a tenth person who would have sat in
 * an empty group. What it answers now is narrower and true:
 *
 *   * does the plan admit anyone but the owner at all? (FREE and evidence
 *     credits do not — credits never grant collaboration);
 *   * does an ACTIVE Enterprise contract state a seat count that bounds the
 *     workspace as a whole? Only then is there a ceiling (`limit`), and the
 *     owner is not counted against it either.
 *
 * =============================================================================
 * WHAT IS COUNTED
 * =============================================================================
 * Distinct ACTIVE workspace memberships other than the owner's. SUSPENDED and
 * REVOKED memberships hold nothing; PENDING invitations hold nothing.
 *
 * =============================================================================
 * WHOSE PLAN
 * =============================================================================
 * The workspace's OWN commercial subject (`resolveWorkspaceCommercialContext`)
 * — the owner's entitlement for a Personal workspace, the contract for an
 * Organization one. Never the actor's personal plan. Every collaboration gate
 * resolves the subject through that one function (CT-09: the guards used to
 * resolve a Personal workspace as PERSONAL_ACCOUNT while this resolver used
 * WORKSPACE, so the two could read different plans for one workspace).
 */

import type { PlanType, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import {
  getPlanCapabilities,
  resolveWorkspaceMemberCeiling,
} from "@proovra/shared-billing";
import {
  resolveCommercialContext,
  type CommercialContext,
} from "./commercial-context.service.js";
import {
  NO_CONTRACT_LIMITS,
  resolveEffectiveCollaborationMemberLimit,
  resolveEffectiveCollaborationTeamLimit,
  resolveEnterpriseContractLimits,
  type EnterpriseContractLimits,
} from "./enterprise-contract-limits.js";

/**
 * The commercial context of ONE workspace, resolved for the workspace itself.
 * `WORKSPACE` lets the canonical resolver classify the kind and pick the right
 * payer; every collaboration gate calls this rather than choosing a subject.
 */
export async function resolveWorkspaceCommercialContext(
  workspace: { id: string; ownerUserId: string },
): Promise<CommercialContext> {
  return resolveCommercialContext({
    type: "WORKSPACE",
    teamId: workspace.id,
    requesterUserId: workspace.ownerUserId,
  });
}

/** Where a workspace member is counted: ACTIVE, and not the owner. */
export function nonOwnerActiveMemberWhere(workspace: { id: string; ownerUserId: string }) {
  return {
    teamId: workspace.id,
    status: "ACTIVE" as const,
    userId: { not: workspace.ownerUserId },
  };
}

export type WorkspaceSeatState = {
  plan: PlanType;
  /** Distinct ACTIVE workspace memberships, the owner's EXCLUDED. */
  used: number;
  /**
   * The most non-owner members the workspace may hold, or `null` when nothing
   * bounds the workspace as a whole (every self-serve plan that includes
   * collaboration — the per-team capacity is then the limit).
   */
  limit: number | null;
  remaining: number | null;
  /** False when the plan admits nobody but the owner. */
  featureIncluded: boolean;
  /** True when usage already exceeds a contract ceiling — a downgrade, not a bug. */
  overLimit: boolean;
  source: "PLAN_CATALOG" | "ENTERPRISE_CONTRACT";
  /**
   * WCR-07 — the status-checked contract limits this resolution was computed
   * from, carried out so callers that need ANOTHER contract dimension
   * (collaboration group count, per-group membership) do not re-resolve the
   * commercial context to get at it.
   */
  contractLimits: EnterpriseContractLimits;
};

/** True when the workspace may admit `adding` more non-owner members. */
export function workspaceSeatsAdmit(seats: WorkspaceSeatState, adding = 1): boolean {
  if (!seats.featureIncluded) return false;
  return seats.limit === null || seats.used + adding <= seats.limit;
}

/**
 * Resolve the member ceiling for one workspace.
 *
 * Accepts a transaction client so a caller holding the per-workspace advisory
 * lock counts under the SAME snapshot it will write in.
 */
export async function resolveWorkspaceSeatState(
  workspaceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<WorkspaceSeatState> {
  const workspace = await client.team.findUnique({
    where: { id: workspaceId },
    select: { id: true, ownerUserId: true },
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
      contractLimits: NO_CONTRACT_LIMITS,
    };
  }

  const ctx = await resolveWorkspaceCommercialContext(workspace);
  const plan = ctx.plan;
  // The contract PROJECTION is not the limits object: a DRAFT, SUSPENDED or
  // TERMINATED contract must not raise a ceiling, and
  // `resolveEnterpriseContractLimits` is the one place that fails closed on
  // status.
  const contractLimits = resolveEnterpriseContractLimits(ctx.enterpriseContract);
  const ceiling = resolveWorkspaceMemberCeiling({
    plan,
    contractSeats:
      contractLimits.contractGovernsCapability && contractLimits.seats !== null
        ? contractLimits.seats
        : null,
    contractGoverns: contractLimits.contractGovernsCapability,
  });

  // `status: "ACTIVE"` is already in the shared predicate; it is restated in
  // the query so the authorization-authority check can see it at the call site.
  const used = await client.teamMember.count({
    where: { ...nonOwnerActiveMemberWhere(workspace), status: "ACTIVE" },
  });

  return {
    plan,
    used,
    limit: ceiling.limit,
    remaining: ceiling.limit === null ? null : Math.max(0, ceiling.limit - used),
    featureIncluded: ceiling.included,
    overLimit: ceiling.limit !== null && used > ceiling.limit,
    source: ceiling.source,
    contractLimits,
  };
}

// =============================================================================
// Invitation allowance — the WORKSPACE-scoped pending / rate authority
// =============================================================================

export type WorkspaceInvitationAllowance = {
  plan: PlanType;
  /** Live (un-accepted, un-revoked, un-expired) invitations right now. */
  pending: number;
  maxPending: number;
  /** Invitations CREATED in the trailing 24 hours, resends included. */
  sentLast24h: number;
  maxPer24h: number;
  /** False when the plan sells no additional members at all. */
  featureIncluded: boolean;
  source: "PLAN_CATALOG" | "ENTERPRISE_CONTRACT";
};

/**
 * How many more people this WORKSPACE may invite, right now.
 *
 * WHY IT LIVES BESIDE THE SEAT AUTHORITY, AND WHY IT IS WORKSPACE-SCOPED.
 *
 * The catalog has carried `maxPendingInvitesPerTeam` and `maxInvitesPer24h`
 * since the collaboration-team work, and `assertCanInviteCollaborationTeamMember`
 * enforced them PER GROUP. That is the wrong subject twice over: a workspace
 * with five groups could hold five times the pending invitations the plan
 * sells, and the invitation that actually grants tenancy — the WORKSPACE one —
 * was gated by neither of them. An operator could therefore mint unbounded
 * pending workspace invitations on any plan that includes members at all.
 *
 * The subject is the workspace, for the same reason the seat is: an invitation
 * is a claim on a seat that has not been taken yet. Counting them per group
 * would let the same allowance be spent several times over, which is precisely
 * what "a group is not a seat pool" rules out.
 *
 * Expired invitations are deliberately NOT counted as pending. They cannot be
 * accepted, so holding an allowance against them would punish an operator for
 * invitations nobody answered rather than for outstanding claims on seats.
 * The 24-hour count is the opposite: it counts what was SENT, expiry and
 * revocation included, because it is an abuse rate limit rather than a
 * capacity measure — revoking a burst must not buy another burst.
 */
export function invitationCeilingsFor(seats: WorkspaceSeatState): {
  maxPending: number;
  maxPer24h: number;
} {
  const caps = getPlanCapabilities(seats.plan);
  const contractGoverned = seats.source === "ENTERPRISE_CONTRACT" && seats.limit !== null;
  return {
    maxPending: contractGoverned
      ? Math.max(0, seats.limit ?? 0)
      : caps.maxPendingInvitesPerTeam,
    maxPer24h: contractGoverned
      ? Math.max(0, seats.limit ?? 0) * 4
      : caps.maxInvitesPer24h,
  };
}

/**
 * THE COLLABORATION LIMITS A SURFACE MAY RENDER (members ledger M4/C8).
 *
 * The platform envelope projected these from the bare catalog row, so a
 * SUSPENDED or TERMINATED Enterprise contract kept "Collaboration Teams: 1000"
 * in navigation and on the page while every create answered
 * ENTERPRISE_CONTRACT_REQUIRED. These are the numbers the gates enforce —
 * `resolveEffectiveCollaboration*Limit` over the status-checked contract
 * projection this seat state already carries, and the invitation ceilings
 * above — resolved once, so a projection cannot disagree with a refusal.
 */
export async function resolveWorkspaceCollaborationLimits(
  workspaceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<{
  maxCollaborationTeamsPerWorkspace: number;
  maxAcceptedMembersPerCollaborationTeam: number;
  maxAdditionalWorkspaceMembers: number | null;
  maxPendingInvitesPerTeam: number;
  maxInvitesPer24h: number;
}> {
  const seats = await resolveWorkspaceSeatState(workspaceId, client);
  const teams = resolveEffectiveCollaborationTeamLimit({
    plan: seats.plan,
    contract: seats.contractLimits,
  });
  const members = resolveEffectiveCollaborationMemberLimit({
    plan: seats.plan,
    contract: seats.contractLimits,
  });
  const ceilings = invitationCeilingsFor(seats);
  return {
    maxCollaborationTeamsPerWorkspace: Math.max(0, teams),
    maxAcceptedMembersPerCollaborationTeam: Math.max(0, members),
    maxAdditionalWorkspaceMembers: seats.featureIncluded ? seats.limit : 0,
    maxPendingInvitesPerTeam: ceilings.maxPending,
    maxInvitesPer24h: ceilings.maxPer24h,
  };
}

export async function resolveWorkspaceInvitationAllowance(
  workspaceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<WorkspaceInvitationAllowance> {
  const seats = await resolveWorkspaceSeatState(workspaceId, client);

  const now = new Date();
  const [pending, sentLast24h] = await Promise.all([
    client.teamInvite.count({
      where: {
        teamId: workspaceId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
    }),
    client.teamInvite.count({
      where: {
        teamId: workspaceId,
        createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      },
    }),
  ]);

  /**
   * ENTERPRISE IS CONTRACT-DRIVEN, AND A CONTRACT THAT SELLS SEATS SELLS THE
   * INVITATIONS THAT FILL THEM.
   *
   * The catalog's ENTERPRISE row is a placeholder ceiling, not the sold
   * number. Where the contract governs the seat limit it governs this too:
   * the pending ceiling follows the seats it can possibly fill, and the daily
   * rate follows the same multiple of it the self-serve plans use, so a
   * contracted organization is never told it may hold more pending
   * invitations than it has seats to give.
   */
  const { maxPending, maxPer24h } = invitationCeilingsFor(seats);

  return {
    plan: seats.plan,
    pending,
    maxPending,
    sentLast24h,
    maxPer24h,
    featureIncluded: seats.featureIncluded,
    source: seats.source,
  };
}
