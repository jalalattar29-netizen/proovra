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
 *     (PRO and above have a positive `maxCollaborationTeamsPerWorkspace`);
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
// BILLING COMMERCIAL CORRECTNESS (2026-08-27) — reads the canonical capability
// record directly. The `getCollaborationTeamPlanLimits` adapter was DELETED:
// it projected the OWNED-WORKSPACE cap (`maxOwnedTeams`) into a field called
// `maxTeams` that this module then enforced over `CollaborationTeam` rows, so
// one integer capped two unrelated tables.
import { getPlanCapabilities } from "@proovra/shared-billing";

import { resolveWorkspaceSeatState } from "../billing/workspace-seats.service.js";
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
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — `resolveUserPlan` was DELETED.
 *
 * It read the ACTOR'S ACCOUNT entitlement, and its only remaining caller was
 * `assertCanCreateCollaborationTeam`. That guard's subject was wrong: a
 * Collaboration Team lives inside a WORKSPACE, so its capacity belongs to that
 * workspace's own commercial state, not to whoever happens to own it. A team
 * inside an unsubscribed Owned Workspace was being gated on its owner's
 * Personal PRO — a plan the workspace does not hold.
 *
 * Every guard in this module now resolves the workspace subject through the
 * canonical envelope, so there is no account-plan reader left to keep.
 */

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
): Promise<{ plan: PlanType; workspaceId: string }> {
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
  // The caller needs BOTH halves of this lookup: the plan to decide the
  // entitlement, and the workspace id to count the seats that entitlement
  // buys. Returning them together keeps it to one read of one row.
  return { plan: ctx.scope.plan, workspaceId: row.workspace.id };
}

// =============================================================================
// 0b. Teams-feature eligibility (commercial contract, 2026-07-14)
// =============================================================================

/** Lowest self-service plan whose contract includes Teams — derived
 *  from the canonical limits so pricing/UI never hardcode it. */
export function lowestPlanWithTeams(): PlanType {
  for (const p of ["PRO", "TEAM", "ENTERPRISE"] as const) {
    if (getPlanCapabilities(p).maxCollaborationTeamsPerWorkspace > 0) {
      return p as PlanType;
    }
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
  if (getPlanCapabilities(plan).maxCollaborationTeamsPerWorkspace > 0) return;
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
 * Reads `PlanCapabilities.maxCollaborationTeamsPerWorkspace` and counts
 * non-archived `CollaborationTeam` rows whose parent workspace is
 * owned by `ownerUserId`. Throws `TEAM_LIMIT_REACHED` (HTTP 409) when
 * at-cap.
 *
 * Replaces the inline check at collaboration-team.service.ts:327-337
 * so the assertion is reusable from routes and webhook downgrade flows.
 */
/**
 * The SAME capacity refusal, re-evaluated inside the creating transaction and
 * serialised per workspace.
 *
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `assertCanCreateCollaborationTeam`
 * is a COUNT followed, some milliseconds later, by an unrelated INSERT. Two
 * requests arriving together both counted `limit - 1`, both passed, and both
 * created: a PRO workspace allowed two Collaboration Teams ended up with
 * three. No unique constraint could have caught it, because "at most N rows
 * for this workspace" is not expressible as one.
 *
 * Measured, not theorised — the Point-7 concurrency scenario produced exactly
 * three teams against a limit of two, against live PostgreSQL, the first time
 * it was pointed at this path.
 *
 * `pg_advisory_xact_lock` is the repository's canonical serialisation
 * primitive for this shape: transaction-scoped, released on commit or
 * rollback, and effective across API instances rather than merely across one
 * process's event loop. The key is the WORKSPACE, because the cap is per
 * workspace — two workspaces creating teams at the same moment must not queue
 * behind each other.
 *
 * It lives HERE, beside the pre-flight guard, so there is ONE statement of
 * what "too many Teams" means and one error shape for it. A caller cannot tell
 * which of the two refused, and does not need to: the answer is identical and
 * the customer's next step is the same either way.
 */
export async function lockAndAssertCollaborationTeamCapacity(
  tx: Pick<PrismaClient, "$executeRaw" | "collaborationTeam">,
  input: {
    workspaceId: string;
    plan: PlanType;
    maxCollaborationTeamsPerWorkspace: number;
  },
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`collaboration-team-create:${input.workspaceId}`}))`;

  const workspaceTeamCount = await tx.collaborationTeam.count({
    where: {
      workspaceId: input.workspaceId,
      status: "ACTIVE",
      archivedAtUtc: null,
    },
  });

  if (workspaceTeamCount >= input.maxCollaborationTeamsPerWorkspace) {
    throwBillingError({
      code: "TEAM_LIMIT_REACHED",
      message: `This workspace's ${planDisplayName(input.plan)} plan includes up to ${
        input.maxCollaborationTeamsPerWorkspace
      } Team${input.maxCollaborationTeamsPerWorkspace === 1 ? "" : "s"}. Upgrade to create another Team.`,
      details: {
        plan: input.plan,
        maxCollaborationTeamsPerWorkspace: input.maxCollaborationTeamsPerWorkspace,
        workspaceTeamCount,
        workspaceId: input.workspaceId,
      },
    });
  }
}

export async function assertCanCreateCollaborationTeam(
  input: { workspaceId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<{
  plan: PlanType;
  maxCollaborationTeamsPerWorkspace: number;
  workspaceTeamCount: number;
}> {
  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — SUBJECT AND CAP BOTH FIXED.
  //
  // This used to resolve the ACTOR'S ACCOUNT plan and count every
  // CollaborationTeam across every workspace that account owns, against
  // `maxOwnedTeams` — the OWNED-WORKSPACE cap. Three things were wrong:
  //
  //   * the cap belonged to a different entity (Team rows, not
  //     CollaborationTeam rows), so a PRO account silently received 2 owned
  //     workspaces AND 2 collaboration teams from one published "Up to 2";
  //   * the plan subject was the account, not the workspace, so a
  //     collaboration team inside an unsubscribed Owned Workspace was gated on
  //     its owner's Personal PRO — a plan that workspace does not hold;
  //   * the count spanned workspaces, so filling one workspace's teams blocked
  //     creation in a different workspace.
  //
  // The subject is the WORKSPACE the team is being created in, and the cap is
  // `maxCollaborationTeamsPerWorkspace`.
  const workspace = await client.team.findUnique({
    where: { id: input.workspaceId },
    select: { id: true, ownerUserId: true, isPersonal: true },
  });
  if (!workspace) {
    throwBillingError({
      code: "TEAM_LIMIT_REACHED",
      message: "Workspace not found.",
      details: { workspaceId: input.workspaceId },
    });
  }

  const ctx = workspace.isPersonal
    ? await resolveCommercialContext({
        type: "PERSONAL_ACCOUNT",
        userId: workspace.ownerUserId,
      })
    : await resolveCommercialContext({
        type: "WORKSPACE",
        teamId: workspace.id,
        requesterUserId: workspace.ownerUserId,
      });
  const plan = ctx.scope.plan;

  const maxCollaborationTeamsPerWorkspace = Math.max(
    0,
    getPlanCapabilities(plan).maxCollaborationTeamsPerWorkspace,
  );

  const workspaceTeamCount = await client.collaborationTeam.count({
    where: {
      workspaceId: input.workspaceId,
      status: "ACTIVE",
      archivedAtUtc: null,
    },
  });

  if (maxCollaborationTeamsPerWorkspace <= 0) {
    // Commercial contract: FREE includes ZERO Collaboration Teams. This is a
    // plan feature, not capacity — 402 with the lowest plan that includes
    // them so the UI can render the upgrade target without hardcoding it.
    throwBillingError({
      code: "TEAM_PLAN_REQUIRED",
      message: "Teams are available on Pro, Team, and Enterprise plans.",
      details: {
        plan,
        maxCollaborationTeamsPerWorkspace,
        workspaceTeamCount,
        workspaceId: input.workspaceId,
        requiredPlan: lowestPlanWithTeams(),
      },
    });
  }

  if (workspaceTeamCount >= maxCollaborationTeamsPerWorkspace) {
    throwBillingError({
      code: "TEAM_LIMIT_REACHED",
      message: `This workspace's ${planDisplayName(plan)} plan includes up to ${maxCollaborationTeamsPerWorkspace} Team${maxCollaborationTeamsPerWorkspace === 1 ? "" : "s"}. Upgrade to create another Team.`,
      details: {
        plan,
        maxCollaborationTeamsPerWorkspace,
        workspaceTeamCount,
        workspaceId: input.workspaceId,
        limit: maxCollaborationTeamsPerWorkspace,
        usage: workspaceTeamCount,
      },
    });
  }

  return { plan, maxCollaborationTeamsPerWorkspace, workspaceTeamCount };
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
 * Reads `PlanCapabilities.maxAcceptedMembersPerCollaborationTeam`,
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
  maxAcceptedMembers: number;
  currentMemberCount: number;
  seatRemaining: number;
}> {
  const safeAdding = Math.max(1, Math.floor(addingCount));
  // §9.4 corrected — existing-team member limits are a WORKSPACE-subject
  // decision (the parent workspace's own effective plan), never the owner's
  // account plan.
  const { plan, workspaceId } = await resolveCollaborationTeamWorkspacePlan(
    client,
    teamId,
  );
  // Commercial contract: a plan with ZERO Teams locks ALL membership
  // growth on grandfathered Teams (adds, every invite channel, and
  // acceptance) — data stays readable, growth requires an upgrade.
  assertTeamsFeatureIncluded(plan);

  /**
   * A GROUP IS NOT A SEAT POOL.
   *
   * This used to read `maxAcceptedMembersPerCollaborationTeam` as an
   * independent commercial quota, so a workspace with room could still be told
   * "this team has reached its member limit" — a second billing authority over
   * a second membership table, charging a shape of usage nobody sells.
   *
   * The commercial boundary is the set of distinct ACTIVE WORKSPACE
   * memberships. Assigning someone who is already in the workspace to a group
   * consumes nothing, and the same person in five groups is still one seat. So
   * the effective ceiling on a group is simply how many authorized people the
   * workspace has: a group may contain every one of them, and cannot contain
   * anyone else, because `addExistingMember` refuses a non-member.
   *
   * The catalog field survives as the SAFETY ceiling for one group — an
   * operational bound, reconciled to the seat entitlement rather than
   * contradicting it — and the workspace seat count is the real limit.
   */
  const workspaceSeats = await resolveWorkspaceSeatState(workspaceId, client);
  const maxAcceptedMembers = Math.max(
    0,
    Math.min(
      Math.max(workspaceSeats.limit, workspaceSeats.used),
      getPlanCapabilities(plan).maxAcceptedMembersPerCollaborationTeam,
    ),
  );

  const currentMemberCount = await client.collaborationTeamMember.count({
    where: { teamId, status: "ACTIVE" },
  });

  const seatRemaining = Math.max(0, maxAcceptedMembers - currentMemberCount);

  if (maxAcceptedMembers <= 0) {
    throwBillingError({
      code: "TEAM_MEMBER_LIMIT_REACHED",
      message: `Plan ${plan} does not include collaboration team membership.`,
      details: {
        plan,
        teamId,
        maxAcceptedMembers,
        currentMemberCount,
        addingCount: safeAdding,
      },
    });
  }

  if (currentMemberCount + safeAdding > maxAcceptedMembers) {
    throwBillingError({
      code: "TEAM_MEMBER_LIMIT_REACHED",
      message: `A team can hold everyone in this workspace. This workspace has ${maxAcceptedMembers} seats on plan ${plan}.`,
      details: {
        plan,
        teamId,
        maxAcceptedMembers,
        currentMemberCount,
        addingCount: safeAdding,
        seatRemaining,
      },
    });
  }

  return { plan, maxAcceptedMembers, currentMemberCount, seatRemaining };
}

// =============================================================================
// 3. (RETIRED) assertCanInviteCollaborationTeamMember
// =============================================================================
//
// WORKSPACE AND COLLABORATION ARCHITECTURE CLOSURE (2026-09-06) — deleted with
// the writer it guarded, and replaced by an authority with the right subject.
//
// It enforced the catalog's `maxPendingInvitesPerTeam` and `maxInvitesPer24h`
// PER COLLABORATION TEAM. That is the wrong subject twice over: a workspace
// with five groups could hold five times the pending invitations the plan
// sells, and the invitation that actually grants tenancy — the WORKSPACE one —
// was gated by neither of them.
//
// `resolveWorkspaceInvitationAllowance` (services/billing/workspace-seats)
// answers the same two questions about the workspace, beside the seat state
// they are a claim on, and `createWorkspaceInvitation` enforces it. The
// numbers did not change; the subject did.

// =============================================================================
// 4. (RETIRED) assertCanInviteCollaborationTeamGuest
// =============================================================================
//
// WORKSPACE AND COLLABORATION ARCHITECTURE RECONCILIATION — deleted with the
// operation it guarded.
//
// "Guest invitation" wrote a `CollaborationTeamGuest` row and stopped: no
// email was ever sent, `acceptedUserId` / `acceptedAtUtc` were written by ZERO
// code paths, the status never left PENDING, and no read path anywhere
// consulted the table for access. The guard was therefore a commercial
// authority over a no-op — it decided who was allowed to be told something
// untrue. External reviewers are granted access by the external-review
// authority, where the grant is real, time-bounded and audited.
//
// `inviteGuest` now refuses with a typed 410 for every plan and every
// workspace kind, so there is nothing left to gate. Existing guest rows stay
// readable and revocable, which is why the model and `listGuests` remain.

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
