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
 *     owner is not counted against it either. An Enterprise contract that is
 *     absent, not ACTIVE, or ACTIVE with no positive seat count admits nobody
 *     new. Zero is not "unlimited", and neither is silence (BILLING-011).
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
// THE SEAT CLAIM — the one way a person starts occupying a seat
// =============================================================================

/**
 * The seat lock could not be taken. Nothing has been refused: the transaction
 * rolls back and `withSeatClaimRetry` runs it again. If contention outlasts the
 * retry this reaches the caller as retryable, never as "the workspace is full".
 */
export class WorkspaceSeatContendedError extends Error {
  readonly code = "WORKSPACE_SEAT_CONTENTION";
  readonly statusCode = 409;
  constructor() {
    super("Too many people are joining this workspace at once. Try again in a moment.");
    this.name = "WorkspaceSeatContendedError";
  }
}

const SEAT_CLAIM_ATTEMPTS = 25;

/**
 * Run a whole transaction, again, for as long as it loses the seat lock.
 *
 * The retry has to sit outside the transaction. Inside one, the work already
 * done (a user row, an identity mapping, a claimed invitation) would commit on
 * the way out if the callback returned, and only a throw rolls it back. The
 * jitter matters: without it a burst re-collides on the same schedule.
 */
export async function withSeatClaimRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < SEAT_CLAIM_ATTEMPTS; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof WorkspaceSeatContendedError)) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 40 + Math.floor(Math.random() * 120)));
  }
  throw new WorkspaceSeatContendedError();
}

/**
 * Take the seat lock of several workspaces, in one global order so two
 * acceptances taking the same pair cannot deadlock. TRY, never wait: a blocking
 * lock parks a pooled connection for its whole wait, so a burst empties the pool
 * doing nothing. Must run on a transaction client; the lock lasts until commit.
 */
export async function lockWorkspaceSeatsTx(
  tx: PrismaClient,
  workspaceIds: ReadonlyArray<string>,
): Promise<void> {
  for (const workspaceId of Array.from(new Set(workspaceIds)).sort()) {
    const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtext(${`workspace-seat:${workspaceId}`})) AS locked
    `;
    if (!locked) throw new WorkspaceSeatContendedError();
  }
}

/**
 * A single administrator's act may wait for the lock, but never without bound:
 * past five seconds it is refused as contention rather than holding a connection.
 */
async function waitForWorkspaceSeatLockTx(tx: PrismaClient, workspaceId: string): Promise<void> {
  await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
  try {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`workspace-seat:${workspaceId}`}))`;
  } catch (err) {
    const pgCode = (err as { meta?: { code?: string } })?.meta?.code;
    if (pgCode === "55P03" || /lock timeout/i.test(String((err as Error)?.message))) {
      throw new WorkspaceSeatContendedError();
    }
    throw err;
  }
  await tx.$executeRaw`SET LOCAL lock_timeout = 0`;
}

export type WorkspaceSeatRefusal =
  | "enterprise_contract_required"
  | "workspace_members_not_included"
  | "workspace_seat_limit_reached";

export type WorkspaceSeatClaim =
  /** The workspace owner: never counted, never refused. */
  | { outcome: "OWNER" }
  /** Already an ACTIVE member. Repeating a grant consumes nothing. */
  | { outcome: "HELD" }
  /** A seat is free and this transaction may now write the ACTIVE row. */
  | { outcome: "CLAIMED"; seats: WorkspaceSeatState }
  | { outcome: "REFUSED"; reason: WorkspaceSeatRefusal; seats: WorkspaceSeatState };

function refusalFor(seats: WorkspaceSeatState): WorkspaceSeatRefusal {
  if (!seats.featureIncluded) {
    return seats.plan === "ENTERPRISE"
      ? "enterprise_contract_required"
      : "workspace_members_not_included";
  }
  return "workspace_seat_limit_reached";
}

/**
 * THE seat claim. Invitation acceptance (workspace and organization), SSO and
 * SAML JIT, SCIM create, reactivation and group projection, and an
 * administrator's reinstatement all pass through here, under one lock, so they
 * serialise against each other rather than only against themselves.
 *
 * There is no seat counter to keep in step. `used` is counted from the ACTIVE
 * rows on `tx` under the lock, so a suspension, removal or departure frees a
 * seat by being what it is, and a retry cannot take a second one: a repeat
 * answers HELD. Suspended and revoked members hold nothing; an account's own
 * closure ends its memberships, so a closed person cannot hold a seat either.
 *
 * The answer is good only until this transaction ends, and the caller writes
 * the ACTIVE row in that same transaction.
 */
export async function claimWorkspaceSeatTx(
  tx: PrismaClient,
  input: { workspaceId: string; userId: string; wait?: "TRY" | "BOUNDED" },
): Promise<WorkspaceSeatClaim> {
  const workspace = await tx.team.findUnique({
    where: { id: input.workspaceId },
    select: { ownerUserId: true },
  });
  if (workspace?.ownerUserId === input.userId) return { outcome: "OWNER" };

  if (input.wait === "BOUNDED") await waitForWorkspaceSeatLockTx(tx, input.workspaceId);
  else await lockWorkspaceSeatsTx(tx, [input.workspaceId]);

  // Read under the lock: a member who became ACTIVE while this waited holds a seat.
  const membership = await tx.teamMember.findUnique({
    where: { teamId_userId: { teamId: input.workspaceId, userId: input.userId } },
    select: { status: true },
  });
  if (membership?.status === "ACTIVE") return { outcome: "HELD" };

  const seats = await resolveWorkspaceSeatState(input.workspaceId, tx);
  if (!workspaceSeatsAdmit(seats)) {
    return { outcome: "REFUSED", reason: refusalFor(seats), seats };
  }
  return { outcome: "CLAIMED", seats };
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
export type WorkspaceCollaborationLimits = {
  maxCollaborationTeamsPerWorkspace: number;
  maxAcceptedMembersPerCollaborationTeam: number;
  maxAdditionalWorkspaceMembers: number | null;
  maxPendingInvitesPerTeam: number;
  maxInvitesPer24h: number;
};

/**
 * The same limits, PURE: a plan and the status-checked contract limits in,
 * the numbers out — the seat ceiling from `resolveWorkspaceMemberCeiling`,
 * the collaboration limits from the contract-first resolvers, the invitation
 * ceilings from `invitationCeilingsFor`. Both the seat-state path and the
 * hot boot-path projection call this, so they cannot disagree.
 */
export function collaborationLimitsFor(input: {
  plan: PlanType;
  contractLimits: EnterpriseContractLimits;
}): WorkspaceCollaborationLimits {
  const { plan, contractLimits } = input;
  const ceiling = resolveWorkspaceMemberCeiling({
    plan,
    contractSeats:
      contractLimits.contractGovernsCapability && contractLimits.seats !== null
        ? contractLimits.seats
        : null,
    contractGoverns: contractLimits.contractGovernsCapability,
  });
  const ceilings = invitationCeilingsFor({
    plan,
    used: 0,
    limit: ceiling.limit,
    remaining: ceiling.limit,
    featureIncluded: ceiling.included,
    overLimit: false,
    source: ceiling.source,
    contractLimits,
  });
  return {
    maxCollaborationTeamsPerWorkspace: Math.max(0, resolveEffectiveCollaborationTeamLimit({ plan, contract: contractLimits })),
    maxAcceptedMembersPerCollaborationTeam: Math.max(0, resolveEffectiveCollaborationMemberLimit({ plan, contract: contractLimits })),
    maxAdditionalWorkspaceMembers: ceiling.included ? ceiling.limit : 0,
    maxPendingInvitesPerTeam: ceilings.maxPending,
    maxInvitesPer24h: ceilings.maxPer24h,
  };
}

export async function resolveWorkspaceCollaborationLimits(
  workspaceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<WorkspaceCollaborationLimits> {
  const seats = await resolveWorkspaceSeatState(workspaceId, client);
  return collaborationLimitsFor({ plan: seats.plan, contractLimits: seats.contractLimits });
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
