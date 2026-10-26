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

import { resolveWorkspaceCommercialContext } from "../billing/workspace-seats.service.js";
import {
  resolveEffectiveCollaborationMemberLimit,
  resolveEffectiveCollaborationTeamLimit,
  resolveEnterpriseContractLimits,
  type EnterpriseContractLimits,
} from "../billing/enterprise-contract-limits.js";
import { prisma as defaultPrisma } from "../../db.js";
import { effectiveGroupMemberWhere } from "./effective-membership.js";
import { COMMERCIAL_GRACE_PERIOD_DAYS } from "../billing/commercial-context.service.js";
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
): Promise<{
  plan: PlanType;
  workspaceId: string;
  ownerUserId: string;
  contractLimits: EnterpriseContractLimits;
}> {
  const row = await client.collaborationTeam.findUnique({
    where: { id: teamId },
    select: { workspace: { select: { id: true, ownerUserId: true } } },
  });
  if (!row) {
    throwBillingError({
      code: "TEAM_LIMIT_REACHED",
      message: "Collaboration team not found.",
      details: { teamId },
    });
  }
  // CT-09 — the ONE workspace subject every collaboration gate resolves.
  const ctx = await resolveWorkspaceCommercialContext(row.workspace);
  return {
    plan: ctx.scope.plan,
    workspaceId: row.workspace.id,
    ownerUserId: row.workspace.ownerUserId,
    contractLimits: resolveEnterpriseContractLimits(ctx.enterpriseContract),
  };
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
      "The workspace owner's current plan does not include Collaboration Teams. Existing groups remain readable; upgrading restores adding members and invitations.",
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
    select: { id: true, ownerUserId: true },
  });
  if (!workspace) {
    throwBillingError({
      code: "TEAM_LIMIT_REACHED",
      message: "Workspace not found.",
      details: { workspaceId: input.workspaceId },
    });
  }

  // CT-09 — the ONE workspace subject every collaboration gate resolves.
  const ctx = await resolveWorkspaceCommercialContext(workspace);
  const plan = ctx.scope.plan;

  // WCR-07 — CONTRACT FIRST. `resolveEffectiveCollaborationTeamLimit` returns
  // the contracted number when an ACTIVE Enterprise contract states one and the
  // catalog default otherwise, so an Enterprise workspace stops being governed
  // by a flat 1000 that nobody agreed to. The contract PROJECTION is not read
  // directly: `resolveEnterpriseContractLimits` is the one place that fails
  // closed on DRAFT / SUSPENDED / TERMINATED status.
  const maxCollaborationTeamsPerWorkspace = Math.max(
    0,
    resolveEffectiveCollaborationTeamLimit({
      plan,
      contract: resolveEnterpriseContractLimits(ctx.enterpriseContract),
    }),
  );

  const workspaceTeamCount = await client.collaborationTeam.count({
    where: {
      workspaceId: input.workspaceId,
      status: "ACTIVE",
      archivedAtUtc: null,
    },
  });

  if (plan === "ENTERPRISE" && maxCollaborationTeamsPerWorkspace <= 0) {
    throwBillingError({
      code: "ENTERPRISE_CONTRACT_REQUIRED",
      message:
        "This organization's contract does not configure Collaboration Teams yet. Ask your organization administrator to complete the contract.",
      details: { plan, workspaceId: input.workspaceId },
    });
  }
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
 * Where a group member occupies a place: an EFFECTIVE member (ACTIVE in the
 * group and in the workspace — WCR-11, so a group is never "full" of leavers)
 * who is not the workspace owner.
 */
function capacityMemberWhere(workspaceId: string, ownerUserId: string) {
  return {
    ...effectiveGroupMemberWhere(workspaceId),
    userId: { not: ownerUserId },
  };
}

export type CollaborationTeamMemberCapacity = {
  plan: PlanType;
  /** The most accepted NON-OWNER members this group may hold. */
  maxAcceptedMembers: number;
  currentMemberCount: number;
  seatRemaining: number;
};

/**
 * THE collaboration capacity rule (members audit ENT-04, owner decision
 * 2026-10-25), stated once for the pre-flight check and the locked one.
 *
 * Each ACTIVE Collaboration Team may hold up to
 * `maxAcceptedMembersPerCollaborationTeam` accepted members other than the
 * workspace owner — PRO 5, TEAM 10, an Enterprise contract whatever it states.
 * Nothing is pooled across groups and nothing is reconciled to a workspace
 * seat count: there is no workspace-wide cap. A plan with no Collaboration
 * Teams locks all group growth (data stays readable).
 *
 * `addingUserIds`, when given, is the people about to be added; the owner and
 * anyone already an effective member consume nothing, so re-adding them is
 * never refused for capacity.
 */
async function evaluateCollaborationTeamMemberCapacity(
  client: Pick<PrismaClient, "collaborationTeam" | "collaborationTeamMember">,
  teamId: string,
  input: {
    addingCount: number;
    addingUserIds?: readonly string[];
    /** Refuse a group that ALREADY holds more than the capacity (reopen). */
    requireWithinCapacity?: boolean;
  },
): Promise<CollaborationTeamMemberCapacity> {
  const { plan, workspaceId, ownerUserId, contractLimits } =
    await resolveCollaborationTeamWorkspacePlan(client as PrismaClient, teamId);
  assertTeamsFeatureIncluded(plan);

  const maxAcceptedMembers = Math.max(
    0,
    resolveEffectiveCollaborationMemberLimit({ plan, contract: contractLimits }),
  );
  if (plan === "ENTERPRISE" && maxAcceptedMembers <= 0) {
    throwBillingError({
      code: "ENTERPRISE_CONTRACT_REQUIRED",
      message:
        "This organization's contract does not configure Collaboration Team membership yet. Ask your organization administrator to complete the contract.",
      details: { plan, teamId },
    });
  }
  const where = capacityMemberWhere(workspaceId, ownerUserId);
  const currentMemberCount = await client.collaborationTeamMember.count({
    where: { teamId, ...where },
  });

  let adding = Math.max(0, Math.floor(input.addingCount));
  if (input.addingUserIds) {
    const candidates = [...new Set(input.addingUserIds)].filter((id) => id !== ownerUserId);
    const already = candidates.length
      ? await client.collaborationTeamMember.count({
          where: { teamId, ...where, userId: { in: candidates } },
        })
      : 0;
    adding = candidates.length - already;
  }
  const seatRemaining = Math.max(0, maxAcceptedMembers - currentMemberCount);

  if (input.requireWithinCapacity && currentMemberCount > maxAcceptedMembers) {
    throwBillingError({
      code: "TEAM_MEMBER_LIMIT_REACHED",
      message: `This Collaboration Team has ${currentMemberCount} members and the ${planDisplayName(plan)} plan allows up to ${maxAcceptedMembers} per Team, not counting the workspace owner. Remove members before reopening it.`,
      details: {
        plan,
        teamId,
        maxAcceptedMembers,
        currentMemberCount,
        limit: maxAcceptedMembers,
        usage: currentMemberCount,
      },
    });
  }

  if (adding > 0 && maxAcceptedMembers <= 0) {
    throwBillingError({
      code: "TEAM_MEMBER_LIMIT_REACHED",
      message: `The ${planDisplayName(plan)} plan does not include Collaboration Team members.`,
      details: { plan, teamId, maxAcceptedMembers, currentMemberCount, addingCount: adding },
    });
  }
  if (adding > 0 && currentMemberCount + adding > maxAcceptedMembers) {
    throwBillingError({
      code: "TEAM_MEMBER_LIMIT_REACHED",
      message: `This Collaboration Team can hold up to ${maxAcceptedMembers} members on the ${planDisplayName(plan)} plan, not counting the workspace owner.`,
      details: {
        plan,
        teamId,
        maxAcceptedMembers,
        currentMemberCount,
        addingCount: adding,
        seatRemaining,
        limit: maxAcceptedMembers,
        usage: currentMemberCount,
      },
    });
  }
  return { plan, maxAcceptedMembers, currentMemberCount, seatRemaining };
}

/**
 * THE per-group membership lock. Every writer that changes who is in a group,
 * or in what role, takes it on its own transaction: capacity (who may join)
 * and leadership (who may leave a LEAD's place) are both "count, then write"
 * decisions that READ COMMITTED alone cannot serialise.
 */
export async function lockCollaborationTeamMembership(
  tx: Pick<PrismaClient, "$executeRaw">,
  teamId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`collaboration-team-members:${teamId}`}))`;
}

/**
 * Pre-flight form of the rule, for surfaces that want the refusal before they
 * open a transaction. It is NOT sufficient on its own: every writer re-asks
 * under the per-group lock (`lockAndAssertCollaborationTeamMemberCapacity`).
 */
export async function assertCollaborationTeamMemberLimit(
  teamId: string,
  addingCount: number = 1,
  client: PrismaClient = defaultPrisma,
): Promise<CollaborationTeamMemberCapacity> {
  return evaluateCollaborationTeamMemberCapacity(client, teamId, {
    addingCount: Math.max(1, Math.floor(addingCount)),
  });
}

/**
 * The SAME rule, serialised per group, inside the writing transaction (members
 * audit CT-02 / CT-03).
 *
 * A count taken before an unrelated INSERT lets two concurrent adds both see
 * `limit - 1` and both succeed, and a reinstatement that never asked at all
 * walked straight past the cap. Every writer that makes someone an effective
 * group member — add, bulk add, reinstate — calls this on its own `tx` before
 * it writes, so "at most N" holds whatever arrives together.
 */
export async function lockAndAssertCollaborationTeamMemberCapacity(
  tx: Pick<PrismaClient, "$executeRaw" | "collaborationTeam" | "collaborationTeamMember">,
  input: {
    teamId: string;
    addingUserIds: readonly string[];
    /**
     * Reopening an archived group adds nobody but returns its members to
     * current access, so it must fit the capacity as it stands now — after a
     * downgrade it may not.
     */
    requireWithinCapacity?: boolean;
  },
): Promise<CollaborationTeamMemberCapacity> {
  await lockCollaborationTeamMembership(tx, input.teamId);
  return evaluateCollaborationTeamMemberCapacity(tx, input.teamId, {
    addingCount: input.addingUserIds.length,
    addingUserIds: input.addingUserIds,
    requireWithinCapacity: input.requireWithinCapacity,
  });
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
 * /v1/collaboration-teams*. Allows ACTIVE, TRIALING, and PAST_DUE inside the
 * canonical grace window. Blocks CANCELLED, UNPAID, INCOMPLETE_EXPIRED and
 * PAST_DUE past grace. FREE is a valid plan and is allowed; the gate blocks
 * paid plans whose payment has lapsed.
 *
 * =============================================================================
 * WCR-04 (2026-09-07) — THE SUBJECT IS THE WORKSPACE, NOT THE ACTOR
 * =============================================================================
 * This took a `userId` and resolved `{ ownerUserId: userId }`, which with no
 * `teamId` resolves the ACTOR'S OWN PERSONAL SPACE. Six collaboration
 * mutations therefore asked "is this person's personal subscription in good
 * standing?" before letting them act inside a workspace that is not theirs.
 *
 * Two things were wrong with that, in opposite directions:
 *
 *   - an invited ADMIN of a fully-paid TEAM workspace, whose own personal
 *     subscription had lapsed, was refused work in a workspace that had paid
 *     for it;
 *   - `resolveCollaborationEntitlement` reports `mutationsAllowed` from the
 *     WORKSPACE lifecycle, so the projection the browser renders and the gate
 *     the server enforces answered differently about the same request.
 *
 * Every other guard in this module already resolves the workspace subject
 * (`resolveCollaborationTeamWorkspacePlan`, `assertCanCreateCollaborationTeam`).
 * This one now does too, through the same discriminated envelope: a PERSONAL
 * workspace resolves its owner's entitlement, anything else resolves the
 * workspace aggregate. The actor's own plan is never consulted for an
 * operation inside a workspace.
 */
export async function assertSubscriptionActiveOrGraceAllowed(
  input: { workspaceId: string },
  client: PrismaClient = defaultPrisma,
): Promise<{
  plan: PlanType;
  status: SubscriptionStatus;
  inGracePeriod: boolean;
}> {
  // PHASE 9 STEP 5 (2026-07-22) — THIN ADAPTER (zero independent decision).
  // The subscription-active + grace DECISION lives in the ONE canonical
  // lifecycle policy (`resolveCommercialContext` → `lifecycle`). This function
  // computes no grace window of its own; it maps the canonical verdict to the
  // collaboration-team error contract.
  const workspace = await client.team.findUnique({
    where: { id: input.workspaceId },
    select: { id: true, ownerUserId: true },
  });
  if (!workspace) {
    throwBillingError({
      code: "SUBSCRIPTION_INACTIVE",
      message: "Workspace not found.",
      details: { workspaceId: input.workspaceId },
    });
  }
  const ctx = await resolveWorkspaceCommercialContext(workspace);
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
