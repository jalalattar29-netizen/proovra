/**
 * Lifecycle Phase 5 (2026-07-17) — canonical account-lifecycle preflight.
 *
 * ONE place that answers "what stops this account from closing right
 * now?" with STABLE machine codes + human messages. Used by BOTH the
 * request route (so the user sees blockers before anything is created)
 * and the closure worker (re-checked at execution time so a blocker
 * acquired during the cooling-off window stops execution — the request
 * moves to BLOCKED, never to PROCESSING).
 *
 * Blocker semantics (each is a real product rule, not decoration):
 *   - ORGANIZATION_OWNERSHIP_TRANSFER_REQUIRED — the caller is ORG_OWNER
 *     of an organization that has OTHER members. Ownership must be
 *     transferred first (a solo implicit personal organization does NOT
 *     block; it is archived together with the account).
 *   - WORKSPACE_MEMBERS_ACTIVE — the caller owns a workspace (Team row)
 *     that still has OTHER ACTIVE members. Collaborators would be
 *     stranded; the owner must remove them or transfer the workspace.
 *   - LEGAL_HOLD_ACTIVE — a workspace the caller owns carries an ACTIVE
 *     evidence legal hold. Custodial accountability cannot be dissolved
 *     while a hold is in force.
 *   - BILLING_SUBSCRIPTION_ACTIVE — the caller has an active/trialing/
 *     past-due subscription. It must be cancelled first so closure never
 *     silently abandons a billing relationship.
 *
 * Closure is UNIVERSAL — no plan/entitlement is consulted anywhere here;
 * blockers protect other people and legal duties, never revenue.
 */

import { prisma } from "../../db.js";

export type AccountClosureBlockerCode =
  | "ORGANIZATION_OWNERSHIP_TRANSFER_REQUIRED"
  | "WORKSPACE_MEMBERS_ACTIVE"
  | "LEGAL_HOLD_ACTIVE"
  | "BILLING_SUBSCRIPTION_ACTIVE";

export type AccountClosureBlocker = {
  code: AccountClosureBlockerCode;
  message: string;
  count: number;
};

/**
 * PHASE 12B CLUSTER 8 — ACTIVE hold count across ALL THREE legal-hold stores,
 * for ANY scope (evidence / case / workspace).
 *
 * The canonical table is the authority, but until the backfill migration is
 * applied a hold can still live only in `case_legal_holds` or `legal_holds`.
 * Account and workspace closure is irreversible, so this count must see every
 * store — under-counting here would dissolve custodial accountability while a
 * hold is in force.
 *
 * Degrades to 0 ONLY for a genuinely-absent legacy relation; any other error
 * propagates, because "we could not check" must never read as "no holds".
 */
async function countActiveHoldsAllStores(scope: {
  teamId?: string;
  team?: { ownerUserId?: string; organizationId?: string };
}): Promise<number> {
  const teamFilter = scope.teamId
    ? { teamId: scope.teamId }
    : { team: scope.team };

  // PHASE 12 POINT 3 — canonical-only. This previously summed the canonical
  // table with counts from `case_legal_holds` and `legal_holds`. The backfill
  // (20271107000000) copied every row of both stores into the canonical table
  // with a deterministic (source_store, source_row_id) key, so adding the
  // legacy counts on top now DOUBLE-COUNTS every converted hold — and the
  // queries throw outright once 20271108000000 drops those tables. One count
  // over the one authority is both correct and drop-safe.
  return prisma.evidenceLegalHold.count({
    where: { status: "ACTIVE", ...teamFilter },
  });
}

export async function evaluateAccountClosurePreflight(
  userId: string,
): Promise<{ blockers: AccountClosureBlocker[] }> {
  const blockers: AccountClosureBlocker[] = [];

  const [ownedOrgMemberships, ownedTeams, activeHoldCount, activeSubs] =
    await Promise.all([
      prisma.organizationMembership.findMany({
        where: { userId, role: "ORG_OWNER" },
        select: { organizationId: true },
      }),
      prisma.team.findMany({
        where: { ownerUserId: userId },
        select: { id: true },
      }),
      // PHASE 12B CLUSTER 8 — count ACTIVE holds of EVERY scope across ALL
      // stores. Closing an account is irreversible, so a hold sitting in a
      // not-yet-converted legacy store has to block it too.
      countActiveHoldsAllStores({ team: { ownerUserId: userId } }),
      // The subscriptions themselves, not just a count: one that is already
      // CANCELLING (cancelAtPeriodEnd) needs different words from one that is
      // not. Telling somebody to cancel a subscription they have already
      // cancelled is the most frustrating kind of wrong.
      prisma.subscription.findMany({
        where: { userId, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
        select: { cancelAtPeriodEnd: true, currentPeriodEnd: true },
      }),
    ]);

  // ORG_OWNER of an org with other members → transfer required. A solo
  // implicit personal org (the caller is its only member) never blocks.
  if (ownedOrgMemberships.length > 0) {
    const orgIds = ownedOrgMemberships.map((m) => m.organizationId);
    const withOthers = await prisma.organizationMembership.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: orgIds }, userId: { not: userId } },
      _count: { id: true },
    });
    if (withOthers.length > 0) {
      blockers.push({
        code: "ORGANIZATION_OWNERSHIP_TRANSFER_REQUIRED",
        message:
          "You own an organization that still has other members. Transfer ownership before closing your account.",
        count: withOthers.length,
      });
    }
  }

  // Owned workspaces that still have OTHER ACTIVE members.
  if (ownedTeams.length > 0) {
    const teamIds = ownedTeams.map((t) => t.id);
    const withMembers = await prisma.teamMember.groupBy({
      by: ["teamId"],
      where: {
        teamId: { in: teamIds },
        userId: { not: userId },
        status: "ACTIVE",
      },
      _count: { id: true },
    });
    if (withMembers.length > 0) {
      blockers.push({
        code: "WORKSPACE_MEMBERS_ACTIVE",
        message:
          "A workspace you own still has other active members. Remove them or transfer the workspace first.",
        count: withMembers.length,
      });
    }
  }

  if (activeHoldCount > 0) {
    blockers.push({
      code: "LEGAL_HOLD_ACTIVE",
      message:
        "Evidence in a workspace you own is under an active legal hold. The hold must be released before closure.",
      count: activeHoldCount,
    });
  }

  if (activeSubs.length > 0) {
    // Access runs to the end of the paid period, so a cancelled subscription
    // still blocks closure — but the person has nothing left to do except
    // wait, and the message says which case they are in.
    const allCancelling = activeSubs.every((s) => s.cancelAtPeriodEnd);
    const endsAt = activeSubs
      .map((s) => s.currentPeriodEnd)
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    blockers.push({
      code: "BILLING_SUBSCRIPTION_ACTIVE",
      message: allCancelling
        ? endsAt
          ? `Your subscription is already cancelled and ends on ${endsAt.toISOString().slice(0, 10)}. You can close your account after that.`
          : "Your subscription is already cancelled and ends at the end of the paid period. You can close your account after that."
        : "You have an active subscription. Cancel it before closing your account.",
      count: activeSubs.length,
    });
  }

  return { blockers };
}

// -----------------------------------------------------------------------------
// Lifecycle Phase 6 — organization closure preflight.
// -----------------------------------------------------------------------------

export type OrganizationClosureBlockerCode =
  | "ORG_MEMBERS_ACTIVE"
  | "LEGAL_HOLD_ACTIVE"
  | "BILLING_CONTRACT_ACTIVE"
  | "PERSONAL_WORKSPACE_ORGANIZATION";

export type OrganizationClosureBlocker = {
  code: OrganizationClosureBlockerCode;
  message: string;
  count: number;
};

/**
 * What stops this ORGANIZATION from closing right now?
 *
 *   - ORG_MEMBERS_ACTIVE — memberships besides the owner still exist.
 *     People are never silently stranded: remove or off-board them first.
 *   - LEGAL_HOLD_ACTIVE — an ACTIVE evidence legal hold on any workspace
 *     bound to the org. Custodial accountability survives closure intent.
 *   - BILLING_CONTRACT_ACTIVE — a workspace bound to the org has an
 *     active/past-due billing relationship (including the sales-led
 *     ENTERPRISE contract). It must be settled through billing first —
 *     closure never silently abandons a contract.
 *   - PERSONAL_WORKSPACE_ORGANIZATION — the org contains a personal
 *     workspace (it is an implicit personal org). Those close through
 *     ACCOUNT closure, never through organization closure.
 */
export async function evaluateOrganizationClosurePreflight(
  orgId: string,
  ownerUserId: string,
): Promise<{ blockers: OrganizationClosureBlocker[] }> {
  const blockers: OrganizationClosureBlocker[] = [];

  const [otherMembers, activeHolds, billingTeams, personalTeams] =
    await Promise.all([
      prisma.organizationMembership.count({
        where: { organizationId: orgId, userId: { not: ownerUserId } },
      }),
      // PHASE 12B CLUSTER 8 — all scopes, all stores.
      countActiveHoldsAllStores({ team: { organizationId: orgId } }),
      prisma.team.count({
        where: {
          organizationId: orgId,
          billingStatus: { in: ["ACTIVE", "PAST_DUE"] },
        },
      }),
      prisma.team.count({
        where: { organizationId: orgId, isPersonal: true },
      }),
    ]);

  if (personalTeams > 0) {
    blockers.push({
      code: "PERSONAL_WORKSPACE_ORGANIZATION",
      message:
        "This organization contains a personal workspace. Personal workspaces close through account closure instead.",
      count: personalTeams,
    });
  }

  if (otherMembers > 0) {
    blockers.push({
      code: "ORG_MEMBERS_ACTIVE",
      message:
        "Other members still belong to this organization. Remove them before closing it.",
      count: otherMembers,
    });
  }

  if (activeHolds > 0) {
    blockers.push({
      code: "LEGAL_HOLD_ACTIVE",
      message:
        "Evidence in this organization's workspaces is under an active legal hold. Release it before closure.",
      count: activeHolds,
    });
  }

  if (billingTeams > 0) {
    blockers.push({
      code: "BILLING_CONTRACT_ACTIVE",
      message:
        "A workspace in this organization has an active billing relationship. Settle it with billing before closure.",
      count: billingTeams,
    });
  }

  return { blockers };
}

// -----------------------------------------------------------------------------
// Lifecycle Phase 7 — workspace closure preflight.
// -----------------------------------------------------------------------------

export type WorkspaceClosureBlockerCode =
  | "PERSONAL_WORKSPACE_NOT_CLOSABLE"
  | "LEGAL_HOLD_ACTIVE"
  | "BILLING_SUBSCRIPTION_ACTIVE"
  | "DESTRUCTION_REVIEW_PENDING";

export type WorkspaceClosureBlocker = {
  code: WorkspaceClosureBlockerCode;
  message: string;
  count: number;
};

/**
 * What stops this WORKSPACE from closing right now?
 *
 *   - PERSONAL_WORKSPACE_NOT_CLOSABLE — the bootstrap personal workspace
 *     (isPersonal) is the account's home; it closes only through ACCOUNT
 *     closure, never on its own.
 *   - LEGAL_HOLD_ACTIVE — an ACTIVE evidence legal hold on this
 *     workspace. Custodial accountability survives closure intent.
 *   - BILLING_SUBSCRIPTION_ACTIVE — the workspace has an active/past-due
 *     billing state or subscription. Cancel it first.
 *   - DESTRUCTION_REVIEW_PENDING — a governance destruction review for
 *     this workspace is still open; the destruction decision must land
 *     before the workspace goes dark.
 *
 * Members are deliberately NOT a blocker here: losing access is the
 * documented collaboration consequence of workspace closure (surfaced up
 * front in the UI and audited at execution). Evidence is untouched.
 */
export async function evaluateWorkspaceClosurePreflight(
  teamId: string,
): Promise<{ blockers: WorkspaceClosureBlocker[] }> {
  const blockers: WorkspaceClosureBlocker[] = [];

  const [team, activeHolds, activeSubs, pendingDestruction] =
    await Promise.all([
      prisma.team.findUnique({
        where: { id: teamId },
        select: { isPersonal: true, billingStatus: true },
      }),
      // PHASE 12B CLUSTER 8 — all scopes, all stores.
      countActiveHoldsAllStores({ teamId }),
      prisma.subscription.count({
        where: { teamId, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
      }),
      prisma.destructionReview.count({
        where: { teamId, status: "PENDING" },
      }),
    ]);

  if (team?.isPersonal) {
    blockers.push({
      code: "PERSONAL_WORKSPACE_NOT_CLOSABLE",
      message:
        "This is your personal workspace. It closes only together with your account (Settings → Privacy → Close account).",
      count: 1,
    });
  }

  if (activeHolds > 0) {
    blockers.push({
      code: "LEGAL_HOLD_ACTIVE",
      message:
        "Evidence in this workspace is under an active legal hold. Release it before closure.",
      count: activeHolds,
    });
  }

  const billingActive =
    team?.billingStatus === "ACTIVE" || team?.billingStatus === "PAST_DUE";
  if (billingActive || activeSubs > 0) {
    blockers.push({
      code: "BILLING_SUBSCRIPTION_ACTIVE",
      message:
        "This workspace has an active billing relationship. Cancel it before closure.",
      count: Math.max(activeSubs, 1),
    });
  }

  if (pendingDestruction > 0) {
    blockers.push({
      code: "DESTRUCTION_REVIEW_PENDING",
      message:
        "A destruction review for this workspace is still open. It must be decided before closure.",
      count: pendingDestruction,
    });
  }

  return { blockers };
}
