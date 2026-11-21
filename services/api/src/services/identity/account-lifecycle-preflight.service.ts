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
 *   - LEGAL_HOLD_ACTIVE — a workspace the caller owns carries an ACTIVE
 *     evidence legal hold. Custodial accountability cannot be dissolved
 *     while a hold is in force.
 *   - BILLING_SUBSCRIPTION_ACTIVE / BILLING_ADDON_ACTIVE — a provider billing
 *     relationship (base subscription or recurring storage add-on, bought by
 *     the caller or billing a workspace this closure closes) still RENEWS. It
 *     must be cancelled first so closure never silently abandons a billing
 *     relationship (PRO-N1-01). One already cancelled but not yet ended does
 *     not block the request; it makes the closure SCHEDULED until it ends.
 *
 * Closure is UNIVERSAL — no plan/entitlement is consulted anywhere here;
 * blockers protect other people and legal duties, never revenue.
 *
 * MEMBERS AUDIT LIFE-13 (2026-10-26) — other members of a PERSONAL or OWNED
 * workspace the caller owns are NOT a blocker. Account closure closes those
 * workspaces through the ONE closure leg set (`closeWorkspacesTx`), which
 * revokes their memberships with reach ended and tells each of them
 * (WORKSPACE_CLOSED) — exactly the rule workspace closure already follows.
 * Forcing the owner to remove every collaborator by hand first was an
 * undesigned second path to the same end. It is a CONSEQUENCE, returned so the
 * person sees it before confirming: WORKSPACE_MEMBERS_LOSE_ACCESS.
 *
 * An ORGANIZATION workspace (or one whose kind cannot be proven) is different:
 * it ends through organization offboarding, never as a side effect of one
 * person's account closure. While it has other members it still blocks
 * (WORKSPACE_MEMBERS_ACTIVE), failing closed.
 *
 * MEMBERS LEDGER M9 (2026-10-28) — and once it is empty it STILL does not close
 * with the account. A solo first owner of an Enterprise customer Organization
 * passed every check above (no other members, no other org members) and the
 * closure legs then archived the CUSTOMER Organization and closed its
 * Organization Workspace — Organization offboarding, with its contract and
 * retention checks, reached as a side effect of one account. A live CUSTOMER
 * Organization the caller owns, or a live Organization Workspace they own,
 * blocks: ORGANIZATION_OFFBOARDING_REQUIRED. Implicit SYSTEM organizations
 * (the Personal container) are unchanged and still archive with the account.
 */

import { DESTRUCTION_REVIEW_AWAITING_DECISION } from "@proovra/shared";

import { prisma } from "../../db.js";
import { resolveWorkspaceKind } from "./workspace-kind.js";
import {
  closureWaitsForBillingMessage,
  judgeClosureBillingRelationships,
  type ClosureBillingPending,
} from "./account-closure-subscription-policy.js";
import { listOpenProviderRelationships } from "../billing/open-provider-relationships.service.js";

export {
  judgeClosureBillingRelationships,
  type ClosureBillingRelationship,
  type ClosureBillingPending,
} from "./account-closure-subscription-policy.js";

export type AccountClosureBlockerCode =
  | "ORGANIZATION_OWNERSHIP_TRANSFER_REQUIRED"
  | "WORKSPACE_MEMBERS_ACTIVE"
  | "ORGANIZATION_OFFBOARDING_REQUIRED"
  | "LEGAL_HOLD_ACTIVE"
  | "BILLING_SUBSCRIPTION_ACTIVE"
  /** PRO-N1-01 — a recurring storage add-on that still renews. */
  | "BILLING_ADDON_ACTIVE"
  /** Review G2 — billing of an owned workspace that another person pays. */
  | "BILLING_WORKSPACE_PAYER_ACTIVE"
  /** Review G1 — a checkout attempt still open at the provider. */
  | "BILLING_CHECKOUT_OPEN";

export type AccountClosureBlocker = {
  code: AccountClosureBlockerCode;
  message: string;
  count: number;
};

/** What closure WILL do to other people — shown, never blocking (LIFE-13). */
export type AccountClosureConsequence = {
  code:
    | "WORKSPACE_MEMBERS_LOSE_ACCESS"
    | "PUBLIC_VERIFICATION_REMAINS"
    | "RECORDS_NOT_IN_ACCOUNT_EXPORT"
    /** PRO-N1-01 / DEC-21 — closure is scheduled until cancelled billing ends. */
    | "CLOSURE_WAITS_FOR_BILLING_END";
  message: string;
  /**
   * WORKSPACE_MEMBERS_LOSE_ACCESS: other ACTIVE or SUSPENDED members across
   * the workspaces the caller owns. PUBLIC_VERIFICATION_REMAINS: records whose
   * public verification page stays available.
   */
  count: number;
};

/**
 * F-17 — WHAT CLOSURE DOES NOT TAKE DOWN.
 *
 * A record's canonical verification page (`pvr_` reference) and the links an
 * issued report or package carries are publication state, not the person's
 * (members audit SEC-08, owner decision 2026-10-25; creator-share-grants.ts):
 * an issued report's QR code keeps verifying after its creator leaves.
 * Closure therefore leaves them live — by policy — and the person has to be
 * told so BEFORE confirming, together with the control they already have:
 * withdrawing a record's verification page from that record
 * (POST /v1/evidence/:id/verification-access/withdraw, offered on the record's
 * "Manage verification page" panel).
 *
 * Counted for the GET preview only, never inside the closure transaction: it
 * informs, it never blocks.
 */
export async function publicVerificationKeptConsequence(
  userId: string,
  client: Pick<typeof prisma, "team" | "evidence"> = prisma,
): Promise<AccountClosureConsequence | null> {
  const owned = await client.team.findMany({ where: { ownerUserId: userId }, select: { id: true } });
  const teamIds = owned.map((t) => t.id);
  const count = await client.evidence.count({
    where: {
      verificationRef: { not: null },
      verificationAccessState: "AVAILABLE",
      OR: [{ ownerUserId: userId }, ...(teamIds.length > 0 ? [{ teamId: { in: teamIds } }] : [])],
    },
  });
  if (count === 0) return null;
  return {
    code: "PUBLIC_VERIFICATION_REMAINS",
    message:
      count === 1
        ? "Leaves 1 record\u2019s public verification page online: anyone with its verification reference, QR code or an issued report or package can still check it after your account closes. The page shows only the verification result, never your files or private details. To take it down first, open the record and use \u201cWithdraw page\u201d in its verification page settings."
        : `Leaves ${count} records\u2019 public verification pages online: anyone with a verification reference, QR code or an issued report or package can still check them after your account closes. The pages show only the verification result, never your files or private details. To take one down first, open the record and use \u201cWithdraw page\u201d in its verification page settings.`,
    count,
  };
}

/**
 * B1-F-015 (free-audit 0ea0) — THE ACCOUNT EXPORT IS NOT A RECORDS EXPORT.
 *
 * `buildAccountExportPackage` holds the person's profile, sign-in methods,
 * memberships and activity by design, never evidence files, reports or
 * verification packages. Closure is irreversible, so a person who owns records
 * is told at the decision point, together with where records are taken out
 * (each record's own downloads). Counted for the GET preview only; it informs,
 * it never blocks.
 */
export async function recordsNotInAccountExportConsequence(
  userId: string,
  client: Pick<typeof prisma, "evidence"> = prisma,
): Promise<AccountClosureConsequence | null> {
  const count = await client.evidence.count({
    where: { ownerUserId: userId, lifecycleState: { not: "DESTROYED" } },
  });
  if (count === 0) return null;
  return {
    code: "RECORDS_NOT_IN_ACCOUNT_EXPORT",
    message:
      count === 1
        ? "Does not hand you your record: the account data export holds your profile, sign-in methods, memberships and activity, not evidence files, reports or verification packages. To keep your record, open it and download its original, report or package before you close."
        : `Does not hand you your ${count} records: the account data export holds your profile, sign-in methods, memberships and activity, not evidence files, reports or verification packages. To keep a record, open it and download its original, report or package before you close.`,
    count,
  };
}

/** The connection the preflight reads on: the module client, or the closure's transaction. */
type PreflightClient = Pick<
  typeof prisma,
  | "organizationMembership"
  | "team"
  | "subscription"
  | "teamMember"
  | "evidenceLegalHold"
  | "workspaceStorageAddon"
  | "destructionReview"
  | "billingCheckoutAttempt"
>;

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
async function countActiveHoldsAllStores(
  scope: {
    teamId?: string;
    team?: { ownerUserId?: string; organizationId?: string };
  },
  client: PreflightClient = prisma,
): Promise<number> {
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
  return client.evidenceLegalHold.count({
    where: { status: "ACTIVE", ...teamFilter },
  });
}

export async function evaluateAccountClosurePreflight(
  userId: string,
  /**
   * AUD-0017 (TXP-025) — the closure execution re-judges INSIDE its
   * transaction, under the workspace locks; it passes that transaction so the
   * re-judgement reads on the connection it already holds (and under its
   * snapshot) instead of asking the pool for more.
   */
  client: PreflightClient = prisma,
): Promise<{
  blockers: AccountClosureBlocker[];
  consequences: AccountClosureConsequence[];
  /**
   * PRO-N1-01 / DEC-21 — cancelled billing relationships that have not ended
   * yet. Not a blocker: the request is SCHEDULED and completes only once this
   * is null.
   */
  billingPending: ClosureBillingPending | null;
}> {
  const blockers: AccountClosureBlocker[] = [];
  const consequences: AccountClosureConsequence[] = [];

  const [ownedOrgMemberships, ownedTeams, activeHoldCount] =
    await Promise.all([
      client.organizationMembership.findMany({
        where: { userId, role: "ORG_OWNER" },
        select: { organizationId: true, organization: { select: { kind: true, status: true } } },
      }),
      client.team.findMany({
        where: { ownerUserId: userId },
        select: {
          id: true,
          workspaceKind: true,
          isPersonal: true,
          billingPlan: true,
          closedAtUtc: true,
        },
      }),
      // PHASE 12B CLUSTER 8 — count ACTIVE holds of EVERY scope across ALL
      // stores. Closing an account is irreversible, so a hold sitting in a
      // not-yet-converted legacy store has to block it too.
      countActiveHoldsAllStores({ team: { ownerUserId: userId } }, client),
    ]);

  // ORG_OWNER of an org with other members → transfer required. A solo
  // implicit personal org (the caller is its only member) never blocks.
  if (ownedOrgMemberships.length > 0) {
    const orgIds = ownedOrgMemberships.map((m) => m.organizationId);
    const withOthers = await client.organizationMembership.groupBy({
      by: ["organizationId"],
      where: {
        organizationId: { in: orgIds },
        userId: { not: userId },
        status: { in: ["ACTIVE", "SUSPENDED"] },
      },
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

  // M9 — a live customer Organization, or a live Organization Workspace, ends
  // through Organization offboarding only.
  const liveCustomerOrgs = ownedOrgMemberships.filter(
    (m) => m.organization.kind === "CUSTOMER" && m.organization.status !== "ARCHIVED",
  ).length;
  const liveOrganizationWorkspaces = ownedTeams.filter(
    (t) =>
      t.closedAtUtc === null &&
      resolveWorkspaceKind({
        workspaceKind: t.workspaceKind,
        isPersonal: t.isPersonal,
        billingPlan: t.billingPlan,
        teamLoaded: true,
      }) === "ORGANIZATION",
  ).length;
  if (liveCustomerOrgs + liveOrganizationWorkspaces > 0) {
    blockers.push({
      code: "ORGANIZATION_OFFBOARDING_REQUIRED",
      message:
        "You own an organization or its workspace. Offboard the organization, or transfer its ownership, before closing your account.",
      count: liveCustomerOrgs + liveOrganizationWorkspaces,
    });
  }

  // Owned workspaces' other members (LIFE-13). A Personal or Owned workspace
  // closes with the account: its members losing access is a consequence the
  // person confirms. An Organization workspace — or one whose kind cannot be
  // proven — never closes as a side effect of one account: other members
  // there still block. The closure legs revoke ACTIVE and SUSPENDED
  // memberships alike, so both are counted.
  if (ownedTeams.length > 0) {
    const closesWithAccount = (t: (typeof ownedTeams)[number]) => {
      const kind = resolveWorkspaceKind({
        workspaceKind: t.workspaceKind,
        isPersonal: t.isPersonal,
        billingPlan: t.billingPlan,
        teamLoaded: true,
      });
      return kind === "PERSONAL" || kind === "OWNED";
    };
    const heldIds = ownedTeams.filter((t) => !closesWithAccount(t)).map((t) => t.id);
    if (heldIds.length > 0) {
      const withMembers = await client.teamMember.groupBy({
        by: ["teamId"],
        where: {
          teamId: { in: heldIds },
          userId: { not: userId },
          status: { in: ["ACTIVE", "SUSPENDED"] },
        },
        _count: { id: true },
      });
      if (withMembers.length > 0) {
        blockers.push({
          code: "WORKSPACE_MEMBERS_ACTIVE",
          message:
            "An organization workspace you own still has other members. Offboard the organization or transfer the workspace before closing your account.",
          count: withMembers.length,
        });
      }
    }
    const closingIds = ownedTeams.filter(closesWithAccount).map((t) => t.id);
    const others = closingIds.length > 0
      ? await client.teamMember.count({
          where: {
            teamId: { in: closingIds },
            userId: { not: userId },
            status: { in: ["ACTIVE", "SUSPENDED"] },
          },
        })
      : 0;
    if (others > 0) {
      consequences.push({
        code: "WORKSPACE_MEMBERS_LOSE_ACCESS",
        message:
          "Workspaces you own close with your account. Their other members lose access and are notified; evidence stays governed by retention and legal-hold rules.",
        count: others,
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

  // PRO-N1-01 — every provider relationship the closure would abandon: the
  // caller's own purchases (any subject) and whatever bills a workspace the
  // closure closes (a transferred workspace's subscription included), base
  // subscriptions and recurring storage add-ons alike. A renewing one blocks;
  // a confirmed-ending one makes the closure wait (DEC-21).
  const relationships = await listOpenProviderRelationships(
    { userId, teamIds: ownedTeams.filter((t) => t.closedAtUtc === null).map((t) => t.id) },
    client,
  );
  const billing = judgeClosureBillingRelationships(relationships);
  blockers.push(...billing.blockers);
  if (billing.pending && billing.blockers.length === 0) {
    consequences.push({
      code: "CLOSURE_WAITS_FOR_BILLING_END",
      message: closureWaitsForBillingMessage(billing.pending),
      count: billing.pending.count,
    });
  }
  return { blockers, consequences, billingPending: billing.pending };
}

// -----------------------------------------------------------------------------
// Lifecycle Phase 6 — organization closure preflight.
// -----------------------------------------------------------------------------

export type OrganizationClosureBlockerCode =
  | "ORG_MEMBERS_ACTIVE"
  | "LEGAL_HOLD_ACTIVE"
  | "BILLING_CONTRACT_ACTIVE"
  /** Review G3 — an open PROVIDER relationship bills one of its workspaces. */
  | "BILLING_SUBSCRIPTION_ACTIVE"
  | "PERSONAL_WORKSPACE_ORGANIZATION";

export type OrganizationClosureBlocker = {
  code: OrganizationClosureBlockerCode;
  message: string;
  count: number;
  /**
   * Closure 2 ("sem" item 2) — BILLING_SUBSCRIPTION_ACTIVE only: how many of
   * those agreements bill somebody other than the owner asking (typically the
   * former owner after an ownership transfer — decision E keeps them the
   * payer). Only that person can cancel them.
   */
  billedToOtherPayer?: number;
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
  /**
   * PRO-PSZ-01 — the closure execution re-judges INSIDE its transaction,
   * under the workspace locks, as account closure does.
   */
  client: PreflightClient = prisma,
): Promise<{ blockers: OrganizationClosureBlocker[] }> {
  const blockers: OrganizationClosureBlocker[] = [];

  const [otherMembers, activeHolds, billingTeams, personalTeams, orgTeams] =
    await Promise.all([
      // Removal keeps a REVOKED row, and someone who has left holds nothing.
      client.organizationMembership.count({
        where: {
          organizationId: orgId,
          userId: { not: ownerUserId },
          status: { in: ["ACTIVE", "SUSPENDED"] },
        },
      }),
      // PHASE 12B CLUSTER 8 — all scopes, all stores.
      countActiveHoldsAllStores({ team: { organizationId: orgId } }, client),
      client.team.count({
        where: {
          organizationId: orgId,
          billingStatus: { in: ["ACTIVE", "PAST_DUE"] },
        },
      }),
      client.team.count({
        where: { organizationId: orgId, isPersonal: true },
      }),
      client.team.findMany({
        where: { organizationId: orgId, closedAtUtc: null },
        select: { id: true },
      }),
    ]);
  // PRO-N1-01 (review G3) — the ONE billing predicate account and workspace
  // closure use: base subscriptions and recurring storage add-ons the PROVIDER
  // may still bill for a workspace this closure closes, whatever
  // `team.billingStatus` says. Closing them would abandon a live charge.
  const openRelationships =
    orgTeams.length > 0 ? await listOpenProviderRelationships({ teamIds: orgTeams.map((t) => t.id) }, client) : [];

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

  if (openRelationships.length > 0) {
    const billedToOtherPayer = openRelationships.filter(
      (r) => r.payerUserId !== null && r.payerUserId !== ownerUserId,
    ).length;
    blockers.push({
      code: "BILLING_SUBSCRIPTION_ACTIVE",
      message:
        billedToOtherPayer > 0
          ? "A workspace in this organization is still billed by a payment provider to another person (an ownership transfer does not move who pays). Only that person can cancel it, from their own Billing, and it must have ended before closure. The organization's Payment agreement panel names them."
          : "A workspace in this organization is still billed by a payment provider (a subscription or a storage add-on). The person who pays for it must cancel it in Billing, and it must have ended, before closure.",
      count: openRelationships.length,
      billedToOtherPayer,
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
  /** PRO-PSZ-01 — re-judged inside the closure transaction, under its lock. */
  client: PreflightClient = prisma,
): Promise<{ blockers: WorkspaceClosureBlocker[] }> {
  const blockers: WorkspaceClosureBlocker[] = [];

  const [team, activeHolds, openRelationships, pendingDestruction] =
    await Promise.all([
      client.team.findUnique({
        where: { id: teamId },
        select: { isPersonal: true, billingStatus: true },
      }),
      // PHASE 12B CLUSTER 8 — all scopes, all stores.
      countActiveHoldsAllStores({ teamId }, client),
      // PRO-N1-01 — the ONE billing predicate account closure also uses: base
      // subscriptions AND recurring storage add-ons billed to this workspace
      // (read on the preflight's own connection).
      listOpenProviderRelationships({ teamIds: [teamId] }, client),
      // PRO-T1C-06 — the canonical "awaiting a decision" set: a review being
      // decided (UNDER_REVIEW) is as open as one not yet picked up.
      client.destructionReview.count({
        where: { teamId, status: { in: [...DESTRUCTION_REVIEW_AWAITING_DECISION] } },
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
  const activeSubCount = openRelationships.length;
  if (billingActive || activeSubCount > 0) {
    blockers.push({
      code: "BILLING_SUBSCRIPTION_ACTIVE",
      message:
        "This workspace has an active billing relationship. Cancel it before closure.",
      count: Math.max(activeSubCount, 1),
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
