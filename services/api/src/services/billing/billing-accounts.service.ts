/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — THE billing-account authority.
 *
 * The defect this closes
 * ---------------------------------------------------------------------------
 * `/billing` had no concept of a billing ACCOUNT. `readBillingOverview(userId)`
 * returned, in ONE flat response with ONE summary strip:
 *
 *   * the user's personal entitlement, credits, storage and subscription;
 *   * every workspace where `Team.ownerUserId === userId`, each with its OWN
 *     subscription, its OWN storage tenancy and potentially its OWN provider;
 *   * a `payments` array MERGING personal and every workspace payment into one
 *     list, distinguished only by a `teamId` the UI rendered as the words
 *     "Team payment" / "Personal payment".
 *
 * Those are separate payers. The header cards ("Workspaces: 3", "Payments: 12")
 * aggregated ACROSS them, so no number on the page belonged to any one account.
 *
 * Authorization was equally coarse. `ACCOUNT_BILLING_VIEW` is granted to every
 * authenticated user, and the actual gate was `Team.ownerUserId === you` — so a
 * Team-plan ADMINISTRATOR who is not the owner, an Organization billing admin,
 * and every member saw an empty or misleading page, while
 * `Team.billingOwnerUserId` was written and DISPLAYED but authorized nothing.
 *
 * The model
 * ---------------------------------------------------------------------------
 * A BILLING ACCOUNT is the thing that receives a bill. There are three kinds,
 * and every projection, every mutation and every payment row belongs to exactly
 * one of them:
 *
 *   PERSONAL      the user's own account. Plan from `Entitlement`; the
 *                 evidence-credit wallet hangs off it.
 *   WORKSPACE     one Owned Workspace with its own TEAM subscription.
 *   ORGANIZATION  one CUSTOMER organization under an Enterprise contract. Its
 *                 constituent workspaces do NOT each fabricate a contract.
 *
 * A Collaboration Team is NEVER a billing account. It is a grouping inside a
 * workspace; it owns no storage, no subscription and no payment history.
 *
 * Capability, not ownership
 * ---------------------------------------------------------------------------
 * Six independent capabilities, so "may see the plan" and "may see what it
 * costs" and "may cancel it" can be answered differently for one viewer on one
 * account. Hiding a button is not authorization: every route re-resolves these
 * for the subject it is about to act on.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { DomainError } from "../../errors.js";
import { checkOrgAccess } from "../organization/org-access.js";
import { assertPersonalSpaceAllowed } from "../identity/identity-mode.service.js";

/**
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — exactly TWO subjects.
 *
 * `WORKSPACE` was a third, and it was wrong. It expressed a model in which
 * TEAM belonged to a separate Owned Workspace with its own billing account,
 * which meant a customer upgrading from PRO to TEAM had to create a new
 * workspace and leave their evidence behind in the old one. The product has
 * exactly two context kinds, and the self-service progression FREE → PRO →
 * TEAM applies to the same Personal Workspace throughout.
 *
 * An internal `Team` row still carries tenancy, and an ORGANIZATION account
 * still resolves the workspaces beneath it — but neither is a billing subject
 * a customer can select, and neither appears on this union.
 */
export type BillingAccountType = "PERSONAL" | "ORGANIZATION";

/**
 * Granular billing capabilities.
 *
 * Deliberately six rather than one: a Team-plan administrator may legitimately
 * need to see WHICH plan governs the workspace they run without being shown
 * what the owner pays, and an Organization billing admin may read a contract
 * without being able to cancel it self-service. One `BILLING_VIEW` boolean
 * cannot express either.
 */
export type BillingCapability =
  /** See that this account exists, its plan/contract, and its usage. */
  | "BILLING_ACCOUNT_VIEW"
  /** See prices, amounts and renewal totals. */
  | "BILLING_AMOUNT_VIEW"
  /** See this account's payment history. */
  | "BILLING_HISTORY_VIEW"
  /** Start a checkout or change the plan for this account. */
  | "BILLING_MANAGE"
  /** Request cancellation of this account's subscription. */
  | "BILLING_CANCEL"
  /** Purchase a storage add-on for this account. */
  | "BILLING_ADDON_PURCHASE";

export const ALL_BILLING_CAPABILITIES: readonly BillingCapability[] = [
  "BILLING_ACCOUNT_VIEW",
  "BILLING_AMOUNT_VIEW",
  "BILLING_HISTORY_VIEW",
  "BILLING_MANAGE",
  "BILLING_CANCEL",
  "BILLING_ADDON_PURCHASE",
];

/** Full financial control — the account's own payer. */
const OWNER_CAPABILITIES: readonly BillingCapability[] = ALL_BILLING_CAPABILITIES;

/*
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `OPERATIONAL_ADMIN_CAPABILITIES`
 * was DELETED with the subject it described.
 *
 * It gave a workspace ADMINISTRATOR who is not the billing owner a view-only
 * capability set on that workspace's billing account. No workspace is a
 * billing account, so nobody can hold a capability on one.
 */

/**
 * An Organization billing administrator. Enterprise is contract-managed, so
 * there is deliberately NO self-service manage/cancel/add-on here: those
 * changes route through the account manager, and offering a button the product
 * cannot honour is worse than offering none.
 */
const ORG_BILLING_ADMIN_CAPABILITIES: readonly BillingCapability[] = [
  "BILLING_ACCOUNT_VIEW",
  "BILLING_AMOUNT_VIEW",
  "BILLING_HISTORY_VIEW",
];

/**
 * A billing account the viewer may see, with the capabilities THEY hold on it.
 *
 * `id` is the stable subject id: the userId for PERSONAL, the teamId for
 * WORKSPACE, the organizationId for ORGANIZATION. It is never a Collaboration
 * Team id, and never a composite.
 */
export type BillingAccountRef = {
  type: BillingAccountType;
  id: string;
  displayName: string;
  capabilities: BillingCapability[];
  /**
   * True when this account has no assigned billing owner. The surface renders
   * an action-required state naming who can fix it — never a raw null and
   * never an internal id.
   */
  billingOwnerMissing: boolean;
};

function has(
  ref: Pick<BillingAccountRef, "capabilities">,
  capability: BillingCapability,
): boolean {
  return ref.capabilities.includes(capability);
}

/**
 * Enumerate every billing account this viewer may see.
 *
 * Ordering is stable and meaningful: PERSONAL first (it is the account every
 * user has), then workspaces by creation, then organizations. The selector
 * renders this order; it does not sort.
 */
export async function listBillingAccountsForViewer(
  viewerUserId: string,
): Promise<BillingAccountRef[]> {
  const accounts: BillingAccountRef[] = [];

  // ---- PERSONAL -----------------------------------------------------------
  // A managed enterprise identity has no personal space, so it has no personal
  // billing account either. `assertPersonalSpaceAllowed` is the canonical
  // decision; this mirrors it rather than re-deriving it from identity mode.
  let personalAllowed = true;
  try {
    await assertPersonalSpaceAllowed(viewerUserId);
  } catch {
    personalAllowed = false;
  }

  if (personalAllowed) {
    const user = await prisma.user.findUnique({
      where: { id: viewerUserId },
      select: { displayName: true, email: true },
    });
    accounts.push({
      type: "PERSONAL",
      id: viewerUserId,
      // Never the raw email as a title when a display name exists.
      displayName: user?.displayName?.trim() || "Personal",
      capabilities: [...OWNER_CAPABILITIES],
      billingOwnerMissing: false,
    });
  }

  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the WORKSPACE
  // enumeration was DELETED here.
  //
  // It listed every Owned Workspace the viewer owned or administered as its
  // own billing account, each with its own plan card, its own checkout target,
  // its own payment history and its own storage catalogue. That is the
  // obsolete model in its most visible form: a selector inviting a customer to
  // choose which of their workspaces to pay for, when there is one Personal
  // Workspace and TEAM is a tier of it.
  //
  // Owned Workspaces remain a TENANCY concept in the platform. They are not a
  // commercial subject, so they are not enumerated, not selectable, and not
  // billable on their own.

  // ---- ORGANIZATION -------------------------------------------------------
  // CUSTOMER organizations where the viewer holds ORG_BILLING_ADMIN or higher.
  // Membership alone is not enough: an Enterprise member sees no amounts, no
  // history and no contract.
  const orgMemberships = await prisma.organizationMembership.findMany({
    where: {
      userId: viewerUserId,
      organization: { kind: "CUSTOMER" },
    },
    select: { organizationId: true, organization: { select: { name: true, billingOwnerUserId: true } } },
  });

  for (const m of orgMemberships) {
    const access = await checkOrgAccess(prisma, {
      orgId: m.organizationId,
      userId: viewerUserId,
      minRole: "ORG_BILLING_ADMIN",
    });
    if (access.kind !== "ok") continue;

    accounts.push({
      type: "ORGANIZATION",
      id: m.organizationId,
      displayName: m.organization.name,
      capabilities: [...ORG_BILLING_ADMIN_CAPABILITIES],
      billingOwnerMissing: m.organization.billingOwnerUserId === null,
    });
  }

  return accounts;
}

/**
 * Resolve ONE billing account for this viewer, or fail closed.
 *
 * THE authorization chokepoint. Every billing route that names a subject calls
 * this before touching anything, so a wrong-workspace or cross-organization id
 * is refused by the same rule everywhere rather than by whatever check the
 * route happened to carry.
 *
 * Fails CLOSED: an account the viewer cannot see is `404 BILLING_ACCOUNT_NOT_FOUND`,
 * deliberately indistinguishable from one that does not exist, so the endpoint
 * cannot be used to enumerate other tenants' workspaces.
 */
export async function resolveBillingAccountForViewer(input: {
  viewerUserId: string;
  type: BillingAccountType;
  id: string;
}): Promise<BillingAccountRef> {
  const accounts = await listBillingAccountsForViewer(input.viewerUserId);
  const found = accounts.find(
    (a) => a.type === input.type && a.id === input.id,
  );

  if (!found) {
    throw new DomainError("Billing account not found", {
      httpStatus: 404,
      publicCode: "BILLING_ACCOUNT_NOT_FOUND",
      publicMessage: "That billing account is not available to your account.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
    });
  }

  return found;
}

/**
 * Assert the viewer holds a capability on a billing account.
 *
 * Returns the resolved account so callers do not re-fetch it. Denials are
 * `403` with a stable code the client renders remediation from — never a
 * silent empty projection, which is how a missing capability comes to look
 * like "you have no billing history".
 */
export async function assertBillingCapability(input: {
  viewerUserId: string;
  type: BillingAccountType;
  id: string;
  capability: BillingCapability;
}): Promise<BillingAccountRef> {
  const account = await resolveBillingAccountForViewer(input);

  if (!has(account, input.capability)) {
    throw new DomainError(`Missing billing capability ${input.capability}`, {
      httpStatus: 403,
      publicCode: "BILLING_CAPABILITY_REQUIRED",
      publicMessage:
        "Billing for this account is managed by its billing owner. Ask them to make this change.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
      metadata: { capability: input.capability, accountType: input.type },
    });
  }

  return account;
}

/**
 * The Prisma `where` fragment selecting the payments that belong to ONE billing
 * account.
 *
 * Exported so the ledger read and any aggregate compose the SAME predicate.
 * The previous projection merged personal and every workspace payment into one
 * array and let the UI label them by `teamId`, which is how a page came to show
 * one payer's total next to another payer's plan.
 *
 * Ownership is DERIVED from `(userId, teamId)` rather than backfilled into a
 * new column: those two fields already determine the account without guessing,
 * and inventing an ownership column would mean writing a guess into history for
 * rows whose team has since been deleted.
 */
export function paymentWhereForAccount(input: {
  account: BillingAccountRef;
  /** Workspace ids under an ORGANIZATION account. */
  organizationWorkspaceIds?: readonly string[];
}): prismaPkg.Prisma.PaymentWhereInput {
  switch (input.account.type) {
    case "PERSONAL":
      // A personal payment carries no teamId. Nothing else may match.
      return { userId: input.account.id, teamId: null };

    case "ORGANIZATION": {
      const ids = input.organizationWorkspaceIds ?? [];
      // An organization with no workspaces must match NOTHING rather than
      // degrade to `teamId: { in: [] }` semantics a future Prisma version
      // could reinterpret.
      if (ids.length === 0) return { id: { in: [] } };
      return { teamId: { in: [...ids] } };
    }
  }
}

/** The non-personal workspace ids belonging to one CUSTOMER organization. */
export async function organizationWorkspaceIds(
  organizationId: string,
): Promise<string[]> {
  const rows = await prisma.team.findMany({
    where: { organizationId, isPersonal: false },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => r.id);
}
