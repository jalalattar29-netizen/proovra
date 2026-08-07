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
  type CollaborationTeamBillingErrorCode,
} from "@proovra/shared";
// §9.6 corrected — the limits adapter lives in the canonical billing package.
import { getCollaborationTeamPlanLimits } from "@proovra/shared-billing";

import { prisma as defaultPrisma } from "../../db.js";
import {
  resolveCommercialContext,
  COMMERCIAL_GRACE_PERIOD_DAYS,
} from "../billing/commercial-context.service.js";
// §9.4/§9.7 — workspace-subject plan via the canonical envelope.

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
// PHASE 9 STEP 5 — the grace window is no longer defined here; it is the ONE
// canonical policy in commercial-context.service. These re-exports preserve
// the public constant names for any external importer but carry no
// independent value (single source of truth).
export const SUBSCRIPTION_GRACE_PERIOD_DAYS = COMMERCIAL_GRACE_PERIOD_DAYS;
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
 * the same `Entitlement` table that `ensureEntitlement` and the legacy
 * personal-scope adapter read from, so the two surfaces
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
 * PHASE 9 §9.4 corrected (2026-07-22) — SUBJECT-CORRECT plan resolution for
 * EXISTING-team operations (member adds / invites). The commercial subject
 * is the PARENT WORKSPACE, not the owner's account: the plan comes from the
 * workspace's own effective scope (canonical subject-aware policy — PERSONAL
 * workspaces resolve the personal entitlement, OWNED workspaces their own
 * commercial state, ORGANIZATION workspaces their contract coverage). The
 * owner-account plan is used ONLY for the creation-allowance guard
 * (`assertCanCreateCollaborationTeam` — an ACCOUNT/PERSONAL decision).
 */
async function resolveCollaborationTeamWorkspacePlan(
  client: PrismaClient,
  teamId: string,
): Promise<PlanType> {
  const row = await client.collaborationTeam.findUnique({
    where: { id: teamId },
    select: {
      workspace: { select: { id: true, ownerUserId: true, isPersonal: true } },
    },
  });
  if (!row) {
    throwBillingError({
      code: "TEAM_LIMIT_REACHED",
      message: "Collaboration team not found.",
      details: { teamId },
    });
  }
  // §9.7 — canonical envelope with the subject the persisted discriminator
  // names: a collaboration team hosted in the owner's PERSONAL space belongs
  // to the PERSONAL_ACCOUNT subject; otherwise the WORKSPACE aggregate.
  const ctx = row.workspace.isPersonal
    ? await resolveCommercialContext({
        type: "PERSONAL_ACCOUNT",
        userId: row.workspace.ownerUserId,
      })
    : await resolveCommercialContext({
        type: "WORKSPACE",
        teamId: row.workspace.id,
        requesterUserId: row.workspace.ownerUserId,
      });
  return ctx.scope.plan;
}

// =============================================================================
// 0b. Teams-feature eligibility (commercial contract, 2026-07-14)
// =============================================================================

/** Lowest self-service plan whose contract includes Teams — derived
 *  from the canonical limits so pricing/UI never hardcode it. */
export function lowestPlanWithTeams(): PlanType {
  for (const p of ["PRO", "TEAM", "ENTERPRISE"] as const) {
    if (getCollaborationTeamPlanLimits(p).maxTeams > 0) return p as PlanType;
  }
  return "ENTERPRISE" as PlanType;
}

function planDisplayName(plan: PlanType): string {
  return plan === "PAYG"
    ? "Pay-Per-Evidence"
    : plan.charAt(0) + plan.slice(1).toLowerCase();
}

/**
 * Grandfathered-team growth lock. Existing Teams owned by accounts
 * whose CURRENT plan includes zero Teams stay readable (data is never
 * deleted or hidden), but every membership-growth path — member adds,
 * every invite channel, and invite ACCEPTANCE — is locked with one
 * stable code until the owner upgrades.
 */
export function assertTeamsFeatureIncluded(plan: PlanType): void {
  const limits = getCollaborationTeamPlanLimits(plan);
  if (limits.maxTeams > 0) return;
  throwBillingError({
    code: "TEAM_INVITES_NOT_INCLUDED",
    message:
      "The Team owner's current plan does not include Teams. Existing data remains accessible; upgrading restores Team membership and invitations.",
    details: { plan, requiredPlan: lowestPlanWithTeams() },
  });
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
    // Commercial contract (2026-07-14): FREE and PAYG include ZERO
    // Teams. This is a plan feature, not capacity — 402 with the
    // lowest plan that includes Teams so the UI can render the
    // upgrade target without hardcoding it.
    throwBillingError({
      code: "TEAM_PLAN_REQUIRED",
      message: "Teams are available on Pro, Team, and Enterprise plans.",
      details: {
        plan,
        maxTeams,
        ownedTeamCount,
        ownerUserId,
        requiredPlan: lowestPlanWithTeams(),
      },
    });
  }

  if (ownedTeamCount >= maxTeams) {
    throwBillingError({
      code: "TEAM_LIMIT_REACHED",
      message: `Your ${planDisplayName(plan)} plan includes up to ${maxTeams} Team${maxTeams === 1 ? "" : "s"}. Upgrade to create another Team.`,
      details: { plan, maxTeams, ownedTeamCount, ownerUserId, limit: maxTeams, usage: ownedTeamCount },
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
  // §9.4 corrected — existing-team member limits are a WORKSPACE-subject
  // decision (the parent workspace's own effective plan), never the owner's
  // account plan.
  const plan = await resolveCollaborationTeamWorkspacePlan(client, teamId);
  // Commercial contract: a plan with ZERO Teams locks ALL membership
  // growth on grandfathered Teams (adds, every invite channel, and
  // acceptance) — data stays readable, growth requires an upgrade.
  assertTeamsFeatureIncluded(plan);
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
  channel: "EMAIL",
  client: PrismaClient = defaultPrisma,
): Promise<{
  plan: PlanType;
  channel: "EMAIL";
  pendingInvites: number;
  sentLast24h: number;
  maxPendingPerTeam: number;
  max24hRate: number;
}> {
  // §9.4 corrected — invite limits are a WORKSPACE-subject decision.
  const plan = await resolveCollaborationTeamWorkspacePlan(client, teamId);
  const limits = getCollaborationTeamPlanLimits(plan);

  // Invitations are EMAIL-ONLY (Teams Entitlement Alignment,
  // 2026-07-14): SMS invites and shareable invite links were never
  // published by Pricing/Billing and their code paths are deleted.
  // A plan with ZERO Teams cannot grow membership at all.
  assertTeamsFeatureIncluded(plan);

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
// 4. assertCanInviteCollaborationTeamGuest
// =============================================================================

/**
 * PHASE 12 POINT 4 PASS C0 — the ONE commercial authority for external
 * guest invitation (`POST /v1/collaboration-teams/:teamId/guests/invite`).
 *
 * Before this guard, `inviteGuest` resolved its own commercial state by
 * reading the raw `Team.billingPlan` COLUMN and passing it to
 * `canPlanOperateSharedWorkspace`. That was a second commercial authority, and it
 * disagreed with the canonical one in three ways that matter in
 * production:
 *
 *   - a PERSONAL workspace's subject is the OWNER'S ENTITLEMENT, never the
 *     `Team.billingPlan` column (the column is meaningless for that kind),
 *     so a paying user's personal-space team was judged on the wrong row;
 *   - an OWNED workspace carrying a legacy `billingPlan = "ENTERPRISE"`
 *     string is NOT enterprise-covered (`LEGACY_AMBIGUOUS_FAIL_CLOSED`),
 *     but the raw column read granted it guests;
 *   - a non-live `billingStatus` (SUSPENDED / CANCELLED organization or
 *     owned workspace) still presented its stale plan string, so a
 *     suspended Organization kept inviting external collaborators.
 *
 * This guard resolves the plan through `resolveCollaborationTeamWorkspacePlan`
 * — the SAME subject-correct path every member-invite channel already uses
 * (`resolveCommercialContext`: PERSONAL → owner entitlement, OWNED → its own
 * persisted commercial state with no owner-plan fallback, ORGANIZATION →
 * the organization contract, all with the live-status rule applied) — and
 * then applies the SAME catalog limits invitations use. Guests were the
 * only invitation channel with no capacity gate at all: a PRO workspace
 * could hold unbounded pending external grants.
 */
export async function assertCanInviteCollaborationTeamGuest(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<{
  plan: PlanType;
  pendingGuests: number;
  maxPendingPerTeam: number;
}> {
  const plan = await resolveCollaborationTeamWorkspacePlan(client, teamId);
  const limits = getCollaborationTeamPlanLimits(plan);

  // FREE / PAYG include zero Teams, so they include no external guests
  // either. PAYG is an operation entitlement, never a workspace plan.
  assertTeamsFeatureIncluded(plan);

  const pendingGuests = await client.collaborationTeamGuest.count({
    where: { teamId, status: "PENDING" },
  });

  if (pendingGuests >= limits.maxPendingInvitesPerTeam) {
    throwBillingError({
      code: "TEAM_INVITE_LIMIT_REACHED",
      message: `This team has reached its pending-invitation limit (${limits.maxPendingInvitesPerTeam}) on plan ${plan}.`,
      details: {
        plan,
        teamId,
        pendingGuests,
        maxPendingPerTeam: limits.maxPendingInvitesPerTeam,
      },
    });
  }

  return {
    plan,
    pendingGuests,
    maxPendingPerTeam: limits.maxPendingInvitesPerTeam,
  };
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
): Promise<{
  plan: PlanType;
  status: SubscriptionStatus;
  inGracePeriod: boolean;
}> {
  // PHASE 9 STEP 5 (2026-07-22) — THIN ADAPTER (zero independent decision).
  // The subscription-active + grace DECISION now lives in the ONE canonical
  // lifecycle policy (`resolveCommercialContext` → `lifecycle`, which itself
  // hosts the relocated corroboration + single bounded-grace rule). This
  // function no longer reads `Subscription.status` and no longer computes an
  // independent grace window; it only maps the canonical verdict to the
  // collaboration-team error contract. The production stale-row 402 invariant
  // is preserved by the resolver (see commercial-context.service
  // `resolvePaidLifecycle` + `production-subscription-gate-stale-row.test`).
  const ctx = await resolveCommercialContext({ ownerUserId: userId });
  const life = ctx.lifecycle;
  const status = (life.providerStatus ??
    (life.state === "CANCELLED" ? "CANCELLED" : "ACTIVE")) as SubscriptionStatus;

  if (!life.mutationsAllowed) {
    throwBillingError({
      code: "SUBSCRIPTION_INACTIVE",
      message: `Your subscription is ${status} and cannot be used for collaboration team mutations.`,
      details: {
        plan: ctx.plan,
        status,
        inGracePeriod: false,
        lifecycleState: life.state,
        gracePeriodDays: COMMERCIAL_GRACE_PERIOD_DAYS,
      },
    });
  }

  return {
    plan: ctx.plan,
    status,
    inGracePeriod: life.state === "GRACE",
  };
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
