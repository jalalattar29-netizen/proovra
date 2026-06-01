/**
 * PROOVRA Phase 10 — Canonical billing-guard helpers for the Collaboration
 * Team product.
 *
 * The /v1/collaboration-teams* HTTP surface MUST gate every mutation
 * through these helpers. Each guard mirrors the shape of the legacy
 * /v1/teams helpers (see discovery notes inline) but reads its limits
 * from the SAME canonical plan-constants source the legacy helpers read
 * from — `COLLABORATION_TEAM_PLAN_LIMITS` in @proovra/shared. No fork.
 *
 * Constitutional rules (Phase 10):
 *
 *   - The Collaboration Team is NOT a workspace. The error codes here
 *     intentionally do NOT reuse the legacy `TEAM_WORKSPACE_LIMIT_REACHED`
 *     vocabulary, because that belongs to the legacy /v1/teams workspace
 *     surface.
 *   - Personal users can own Collaboration Teams if their plan allows
 *     (FREE/PAYG/PRO have a positive `maxTeams`); the helper resolves
 *     the *owner's* plan via the entitlement table, never the legacy
 *     `Team.billingPlan` column.
 *   - Billing controls capacity, not the definition of Team — these
 *     helpers throw structured errors when at-cap; they do NOT mutate
 *     team rows or "downgrade" anything.
 *   - No payment-provider secrets ever transit this module.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  COLLABORATION_TEAM_BILLING_ERROR_HTTP_STATUS,
  COLLABORATION_TEAM_BILLING_UPGRADE_CTA,
  getCollaborationTeamPlanLimits,
  type CollaborationTeamBillingErrorCode,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

// =============================================================================
// PlanType + SubscriptionStatus surface
// =============================================================================
//
// We re-export the Prisma enums via local aliases so callers do not have
// to import `@prisma/client` twice. PlanType is the canonical billing
// dimension; SubscriptionStatus is the canonical subscription state. We
// keep an OPEN string union for SubscriptionStatus because the Prisma
// enum (ACTIVE / PAST_DUE / CANCELED / TRIALING) is a subset of the
// states the universal gate needs to evaluate (UNPAID,
// INCOMPLETE_EXPIRED can arrive from upstream provider webhooks).

export type PlanType = prismaPkg.PlanType;
export type SubscriptionStatus =
  | prismaPkg.SubscriptionStatus
  | "UNPAID"
  | "INCOMPLETE_EXPIRED"
  | "CANCELLED";

/**
 * Subscription grace window for PAST_DUE → still-allowed-to-write.
 *
 * Mirrors the legacy seat-state behaviour: a recently failed payment
 * does NOT block the operator from continuing to use Collaboration
 * Teams for 7 days, after which mutations are blocked until the
 * subscription returns to ACTIVE.
 */
export const SUBSCRIPTION_GRACE_PERIOD_DAYS = 7;
export const SUBSCRIPTION_GRACE_PERIOD_MS =
  SUBSCRIPTION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

// =============================================================================
// Error class
// =============================================================================

/**
 * Structured error thrown by every guard in this module. The shape
 * mirrors the legacy /v1/teams pattern: an Error with `.code`,
 * `.httpStatus`, `.details` (machine-readable context), and a
 * `.upgradeCta` pointing at the canonical billing surface.
 *
 * Mirrors:
 *   - legacy `assertUserCanCreateAnotherTeam` (services/api/src/routes/teams.routes.ts)
 *   - legacy `assertTeamSeatAvailable` (services/api/src/services/workspace-usage.service.ts)
 */
export class BillingLimitError extends Error {
  readonly code: CollaborationTeamBillingErrorCode;
  readonly httpStatus: 402 | 409 | 429;
  readonly upgradeCta: string;
  readonly details: Record<string, unknown>;

  constructor(args: {
    code: CollaborationTeamBillingErrorCode;
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(args.message);
    this.name = "BillingLimitError";
    this.code = args.code;
    this.httpStatus = COLLABORATION_TEAM_BILLING_ERROR_HTTP_STATUS[args.code];
    this.upgradeCta = COLLABORATION_TEAM_BILLING_UPGRADE_CTA;
    this.details = args.details ?? {};
  }
}

function throwBillingError(args: {
  code: CollaborationTeamBillingErrorCode;
  message: string;
  details?: Record<string, unknown>;
}): never {
  throw new BillingLimitError(args);
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Resolve the canonical billing PlanType for a given user. Reads from
 * the same `Entitlement` table that `ensureEntitlement` / the legacy
 * `getPersonalWorkspaceScope` helper read from, so the two surfaces
 * never drift.
 */
async function resolveUserPlan(
  client: PrismaClient,
  userId: string,
): Promise<PlanType> {
  const entitlement = await client.entitlement.findFirst({
    where: { userId, active: true },
    orderBy: { createdAt: "desc" },
    select: { plan: true },
  });
  return entitlement?.plan ?? prismaPkg.PlanType.FREE;
}

/**
 * Resolve the owner of a Collaboration Team. The owner is the user
 * who created the parent workspace (`Team.ownerUserId`), which is the
 * billing-bearing identity. For PERSONAL workspaces the parent
 * `Team.ownerUserId` IS the user; for ORGANIZATION workspaces it is
 * the org's billing owner.
 */
async function resolveCollaborationTeamOwnerUserId(
  client: PrismaClient,
  teamId: string,
): Promise<string> {
  const row = await client.collaborationTeam.findUnique({
    where: { id: teamId },
    select: {
      workspace: { select: { ownerUserId: true } },
    },
  });
  if (!row) {
    throwBillingError({
      code: "TEAM_LIMIT_REACHED",
      message: "Collaboration team not found.",
      details: { teamId },
    });
  }
  return row.workspace.ownerUserId;
}

// =============================================================================
// 1. assertCanCreateCollaborationTeam
// =============================================================================

/**
 * Universal guard for POST /v1/collaboration-teams.
 *
 * Mirrors legacy: `assertUserCanCreateAnotherTeam` from
 * services/api/src/routes/teams.routes.ts (which gates the legacy
 * /v1/teams workspace endpoint on `caps.maxOwnedTeams`).
 *
 * Reads `COLLABORATION_TEAM_PLAN_LIMITS[plan].maxTeams` and counts
 * non-archived `CollaborationTeam` rows whose parent workspace is
 * owned by `ownerUserId`. Throws `TEAM_LIMIT_REACHED` (HTTP 409) when
 * at-cap.
 *
 * Replaces the inline check at collaboration-team.service.ts:327-337
 * so the assertion is reusable from routes and webhook downgrade flows.
 */
export async function assertCanCreateCollaborationTeam(
  ownerUserId: string,
  client: PrismaClient = defaultPrisma,
): Promise<{ plan: PlanType; maxTeams: number; ownedTeamCount: number }> {
  const plan = await resolveUserPlan(client, ownerUserId);
  const limits = getCollaborationTeamPlanLimits(plan);
  const maxTeams = Math.max(0, limits.maxTeams);

  // Count non-archived collaboration teams whose parent workspace is
  // owned by this user. The constitutional pattern is: the parent
  // `Team` row's ownerUserId carries billing identity.
  const ownedTeamCount = await client.collaborationTeam.count({
    where: {
      status: "ACTIVE",
      archivedAtUtc: null,
      workspace: { ownerUserId },
    },
  });

  if (maxTeams <= 0) {
    throwBillingError({
      code: "TEAM_LIMIT_REACHED",
      message: `Your current plan (${plan}) does not allow collaboration team creation.`,
      details: { plan, maxTeams, ownedTeamCount, ownerUserId },
    });
  }

  if (ownedTeamCount >= maxTeams) {
    throwBillingError({
      code: "TEAM_LIMIT_REACHED",
      message: `Plan ${plan} allows up to ${maxTeams} active collaboration team(s). Archive or upgrade to add more.`,
      details: { plan, maxTeams, ownedTeamCount, ownerUserId },
    });
  }

  return { plan, maxTeams, ownedTeamCount };
}

// =============================================================================
// 2. assertCollaborationTeamMemberLimit
// =============================================================================

/**
 * Pre-flight member-count gate. Used by:
 *   - POST /v1/collaboration-teams/:teamId/members
 *   - POST /v1/collaboration-teams/:teamId/invites/(email|sms|link)
 *   - POST /v1/collaboration-teams/invites/:token/accept
 *
 * Mirrors legacy: `getTeamMemberLimit` +
 * `assertTeamSeatAvailable` from
 * services/api/src/services/workspace-usage.service.ts.
 *
 * Reads `COLLABORATION_TEAM_PLAN_LIMITS[plan].maxMembersPerTeam`,
 * compares to the current ACTIVE member count + `addingCount`. Throws
 * `TEAM_MEMBER_LIMIT_REACHED` (HTTP 409) when adding would exceed
 * the per-team cap.
 *
 * Replaces the inline checks at
 * collaboration-team.service.ts:657-666 (addExistingMember) and
 * collaboration-team.service.ts:1260-1269 (acceptInvite).
 */
export async function assertCollaborationTeamMemberLimit(
  teamId: string,
  addingCount: number = 1,
  client: PrismaClient = defaultPrisma,
): Promise<{
  plan: PlanType;
  maxMembersPerTeam: number;
  currentMemberCount: number;
  seatRemaining: number;
}> {
  const safeAdding = Math.max(1, Math.floor(addingCount));
  const ownerUserId = await resolveCollaborationTeamOwnerUserId(client, teamId);
  const plan = await resolveUserPlan(client, ownerUserId);
  const limits = getCollaborationTeamPlanLimits(plan);
  const maxMembersPerTeam = Math.max(0, limits.maxMembersPerTeam);

  const currentMemberCount = await client.collaborationTeamMember.count({
    where: { teamId, status: "ACTIVE" },
  });

  const seatRemaining = Math.max(0, maxMembersPerTeam - currentMemberCount);

  if (maxMembersPerTeam <= 0) {
    throwBillingError({
      code: "TEAM_MEMBER_LIMIT_REACHED",
      message: `Plan ${plan} does not include collaboration team membership.`,
      details: {
        plan,
        teamId,
        maxMembersPerTeam,
        currentMemberCount,
        addingCount: safeAdding,
      },
    });
  }

  if (currentMemberCount + safeAdding > maxMembersPerTeam) {
    throwBillingError({
      code: "TEAM_MEMBER_LIMIT_REACHED",
      message: `This team has reached its member limit (${maxMembersPerTeam}) on plan ${plan}.`,
      details: {
        plan,
        teamId,
        maxMembersPerTeam,
        currentMemberCount,
        addingCount: safeAdding,
        seatRemaining,
      },
    });
  }

  return { plan, maxMembersPerTeam, currentMemberCount, seatRemaining };
}

// =============================================================================
// 3. assertCanInviteCollaborationTeamMember
// =============================================================================

/**
 * Canonical invite-gate. Replaces the three inline assertions in
 * `enforceInviteLimits` (collaboration-team.service.ts:904-1095).
 *
 * Channel-specific gates:
 *   - SMS requires `smsInvitesEnabled` (FREE → 402 SMS_INVITE_NOT_INCLUDED).
 *   - LINK requires `linkInvitesEnabled` (FREE → 402 LINK_INVITE_NOT_INCLUDED).
 *
 * Universal gates (apply to every channel):
 *   - pending invites for this team <= `maxPendingInvitesPerTeam`.
 *   - invites in the last 24h <= `maxInvitesPer24h`. (429)
 *
 * Returns the observed counters so callers can include them in
 * activity metadata for audit.
 */
export async function assertCanInviteCollaborationTeamMember(
  teamId: string,
  channel: "EMAIL" | "SMS" | "LINK",
  client: PrismaClient = defaultPrisma,
): Promise<{
  plan: PlanType;
  channel: "EMAIL" | "SMS" | "LINK";
  pendingInvites: number;
  sentLast24h: number;
  maxPendingPerTeam: number;
  max24hRate: number;
}> {
  const ownerUserId = await resolveCollaborationTeamOwnerUserId(client, teamId);
  const plan = await resolveUserPlan(client, ownerUserId);
  const limits = getCollaborationTeamPlanLimits(plan);

  // -------- channel gate --------
  if (channel === "SMS" && !limits.smsInvitesEnabled) {
    throwBillingError({
      code: "SMS_INVITE_NOT_INCLUDED",
      message: `Plan ${plan} does not include SMS invites.`,
      details: { plan, teamId, channel },
    });
  }
  if (channel === "LINK" && !limits.linkInvitesEnabled) {
    throwBillingError({
      code: "LINK_INVITE_NOT_INCLUDED",
      message: `Plan ${plan} does not include invite links.`,
      details: { plan, teamId, channel },
    });
  }

  // -------- pending-per-team gate --------
  const pendingInvites = await client.collaborationTeamInvite.count({
    where: { teamId, status: "PENDING" },
  });

  if (pendingInvites >= limits.maxPendingInvitesPerTeam) {
    throwBillingError({
      code: "TEAM_INVITE_LIMIT_REACHED",
      message: `This team has reached its pending-invite limit (${limits.maxPendingInvitesPerTeam}) on plan ${plan}.`,
      details: {
        plan,
        teamId,
        channel,
        pendingInvites,
        maxPendingPerTeam: limits.maxPendingInvitesPerTeam,
      },
    });
  }

  // -------- 24h rate gate (per team, all channels combined) --------
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sentLast24h = await client.collaborationTeamInvite.count({
    where: { teamId, createdAt: { gte: since } },
  });

  if (sentLast24h >= limits.maxInvitesPer24h) {
    throwBillingError({
      code: "TEAM_INVITE_LIMIT_REACHED",
      message: `This team has issued ${sentLast24h} invites in the last 24h. Plan ${plan} limit: ${limits.maxInvitesPer24h}.`,
      details: {
        plan,
        teamId,
        channel,
        sentLast24h,
        max24hRate: limits.maxInvitesPer24h,
      },
    });
  }

  return {
    plan,
    channel,
    pendingInvites,
    sentLast24h,
    maxPendingPerTeam: limits.maxPendingInvitesPerTeam,
    max24hRate: limits.maxInvitesPer24h,
  };
}

// =============================================================================
// 4. assertCanCreateGuest
// =============================================================================

/**
 * Plan-gates the /collaboration-teams/:teamId/collaboration guests
 * surface.
 *
 * The Phase 5/7 `COLLABORATION_TEAM_PLAN_LIMITS` does not (yet) expose
 * an explicit `guestsAllowed` or `maxGuests` field. The canonical
 * derivation rule (Phase 10):
 *
 *   - FREE / PAYG    → guests NOT allowed (gate at 402 GUEST_LIMIT_REACHED).
 *   - PRO / TEAM / ENTERPRISE → guests allowed; maxGuests derives from
 *     `maxMembersPerTeam` (guests count toward the same per-team cap).
 *
 * Note: per the Phase 10 plan, this helper lands canonical-first; the
 * /v1 guest mutation endpoint may not exist yet. Wiring will be added
 * by the route surface only when a guest mutation endpoint exists.
 */
export async function assertCanCreateGuest(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<{
  plan: PlanType;
  guestsAllowed: boolean;
  currentGuestCount: number;
  maxGuests: number;
}> {
  const ownerUserId = await resolveCollaborationTeamOwnerUserId(client, teamId);
  const plan = await resolveUserPlan(client, ownerUserId);
  const limits = getCollaborationTeamPlanLimits(plan);

  // Bounded plan-tier derivation. PRO+ unlocks the guest surface.
  const guestsAllowed =
    plan === prismaPkg.PlanType.PRO || plan === prismaPkg.PlanType.TEAM;
  const maxGuests = guestsAllowed ? limits.maxMembersPerTeam : 0;

  // Current guest count — non-revoked, non-expired rows count.
  const currentGuestCount = await client.collaborationTeamGuest.count({
    where: {
      teamId,
      status: { in: ["PENDING", "ACCEPTED"] },
    },
  });

  if (!guestsAllowed) {
    throwBillingError({
      code: "GUEST_LIMIT_REACHED",
      message: `Plan ${plan} does not include collaboration team guests.`,
      details: { plan, teamId, guestsAllowed, currentGuestCount, maxGuests },
    });
  }

  if (currentGuestCount >= maxGuests) {
    throwBillingError({
      code: "GUEST_LIMIT_REACHED",
      message: `This team has reached its guest limit (${maxGuests}) on plan ${plan}.`,
      details: { plan, teamId, guestsAllowed, currentGuestCount, maxGuests },
    });
  }

  return { plan, guestsAllowed, currentGuestCount, maxGuests };
}

// =============================================================================
// 5. assertSubscriptionActiveOrGraceAllowed
// =============================================================================

/**
 * Universal pre-mutation gate for all write endpoints on
 * /v1/collaboration-teams*. Allows:
 *
 *   - ACTIVE
 *   - TRIALING
 *   - PAST_DUE within `SUBSCRIPTION_GRACE_PERIOD_DAYS` of
 *     `currentPeriodEnd` (the legacy seat-state behaviour).
 *
 * Blocks:
 *
 *   - CANCELED / CANCELLED
 *   - UNPAID
 *   - INCOMPLETE_EXPIRED
 *   - PAST_DUE past the grace window.
 *
 * Users on the FREE entitlement (no subscription row) are still
 * allowed because FREE itself is a valid plan; the gate only blocks
 * paid plans whose payment has lapsed.
 *
 * Mirrors the legacy `activateTeamPlan`/`cancelTeamPlan` status flow
 * (services/api/src/services/billing.service.ts) + `refreshTeamSeatState`.
 */
export async function assertSubscriptionActiveOrGraceAllowed(
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<{
  plan: PlanType;
  status: SubscriptionStatus;
  inGracePeriod: boolean;
}> {
  const plan = await resolveUserPlan(client, userId);

  // FREE-tier users have no subscription row by design. Their writes
  // are gated by per-feature plan limits (maxTeams etc), not by
  // subscription state.
  if (plan === prismaPkg.PlanType.FREE) {
    return { plan, status: "ACTIVE", inGracePeriod: false };
  }

  // For paid plans, find the most recent subscription row for this user.
  const subscription = await client.subscription.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: {
      status: true,
      plan: true,
      currentPeriodEnd: true,
    },
  });

  // If no subscription row exists for a paid plan, fall through to
  // ACTIVE — the legacy code treats the entitlement table as
  // authoritative and tolerates webhook lag.
  if (!subscription) {
    return { plan, status: "ACTIVE", inGracePeriod: false };
  }

  const status = subscription.status as SubscriptionStatus;
  const now = Date.now();
  const periodEndMs = subscription.currentPeriodEnd?.getTime() ?? null;
  const inGracePeriod =
    status === prismaPkg.SubscriptionStatus.PAST_DUE &&
    periodEndMs !== null &&
    now - periodEndMs <= SUBSCRIPTION_GRACE_PERIOD_MS;

  // Bounded allow-list. Anything outside this set blocks the write.
  const allowed =
    status === prismaPkg.SubscriptionStatus.ACTIVE ||
    status === prismaPkg.SubscriptionStatus.TRIALING ||
    inGracePeriod;

  if (!allowed) {
    throwBillingError({
      code: "SUBSCRIPTION_INACTIVE",
      message: `Your subscription is ${status} and cannot be used for collaboration team mutations.`,
      details: {
        plan,
        status,
        inGracePeriod,
        currentPeriodEnd: subscription.currentPeriodEnd ?? null,
        gracePeriodDays: SUBSCRIPTION_GRACE_PERIOD_DAYS,
      },
    });
  }

  return { plan, status, inGracePeriod };
}

// =============================================================================
// Public re-exports
// =============================================================================
//
// Re-export the canonical error-code union from @proovra/shared so
// callers can import it from this module without a second dependency
// hop.
export type { CollaborationTeamBillingErrorCode } from "@proovra/shared";
export {
  COLLABORATION_TEAM_BILLING_ERROR_CODES,
  COLLABORATION_TEAM_BILLING_ERROR_HTTP_STATUS,
  COLLABORATION_TEAM_BILLING_UPGRADE_CTA,
  isCollaborationTeamBillingErrorCode,
} from "@proovra/shared";
