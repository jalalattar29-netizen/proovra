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

export async function evaluateAccountClosurePreflight(
  userId: string,
): Promise<{ blockers: AccountClosureBlocker[] }> {
  const blockers: AccountClosureBlocker[] = [];

  const [ownedOrgMemberships, ownedTeams, activeHoldCount, activeSubCount] =
    await Promise.all([
      prisma.organizationMembership.findMany({
        where: { userId, role: "ORG_OWNER" },
        select: { organizationId: true },
      }),
      prisma.team.findMany({
        where: { ownerUserId: userId },
        select: { id: true },
      }),
      prisma.evidenceLegalHold.count({
        where: { status: "ACTIVE", team: { ownerUserId: userId } },
      }),
      prisma.subscription.count({
        where: { userId, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
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

  if (activeSubCount > 0) {
    blockers.push({
      code: "BILLING_SUBSCRIPTION_ACTIVE",
      message:
        "You have an active subscription. Cancel it before closing your account.",
      count: activeSubCount,
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
      prisma.evidenceLegalHold.count({
        where: { status: "ACTIVE", team: { organizationId: orgId } },
      }),
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
      prisma.evidenceLegalHold.count({
        where: { teamId, status: "ACTIVE" },
      }),
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
