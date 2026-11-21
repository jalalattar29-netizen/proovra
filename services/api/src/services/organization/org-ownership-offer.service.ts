/**
 * NEW-RG-26-4 / owner decision E (DEC-18) — ORGANIZATION OWNERSHIP MOVES BY
 * OFFER, RECIPIENT ACCEPTANCE AND STEP-UP.
 *
 * `POST /v1/orgs/:id/transfer-ownership` used to make another member the
 * organization owner — and the owner of every organization workspace the
 * outgoing owner held, and the billing and contract owner — in one call. The
 * recipient learnt of it afterwards and never agreed to it.
 *
 * It now follows the workspace ownership-offer lifecycle (PRO-T1-06,
 * `workspace-lifecycle.service.ts`): the owner OFFERS (owner of record +
 * step-up, at the route); nothing moves until the named recipient ACCEPTS with
 * their own step-up. Same statuses, same seven-day expiry, same "a new offer
 * supersedes the previous one", same uniform not-found for anyone but the two
 * parties. Every act takes the organization owners' advisory lock
 * (`lockOrganizationOwnersTx`, the lock role changes and removals already
 * take), so exactly one of offer / accept / decline / cancel / supersede wins
 * and at most one offer per organization is PENDING.
 *
 * AT ACCEPTANCE everything is judged again, inside that lock:
 *   - the offerer must STILL be an ACTIVE organization owner (else the offer
 *     is marked SUPERSEDED and refused);
 *   - the recipient must STILL be an ACTIVE member whose access window is
 *     open, and not already the owner;
 *   - no organization closure may be open;
 *   - every organization workspace the offerer owns must take the new owner
 *     (seat / suspension; `transferOrganizationWorkspaceOwnersTx` rolls the
 *     whole acceptance back otherwise).
 *
 * THE PAYER DOES NOT MOVE (owner decision E). Organizational ownership is not
 * a payment agreement. `Organization.billingOwnerUserId`,
 * `Team.billingOwnerUserId` of the organization's workspaces and
 * `EnterpriseContract.contractOwnerUserId` keep the person they named before;
 * provider subscriptions (`Subscription.userId`) were never touched by this
 * path. The acceptance reports the billing owner that stays in force, so both
 * parties see it. There is no self-service billing-owner change for an
 * organization today: the contract owner is set when Enterprise provisioning
 * activates the contract.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { lockOrganizationOwnersTx, organizationMembershipGrantsAccess } from "../identity/org-membership-lifecycle.service.js";
import { updateOrganizationMembershipRole } from "../identity/membership-provisioning.service.js";
import { transferOrganizationWorkspaceOwnersTx } from "../workspace/workspace-lifecycle.service.js";
import { emitOrgAuditEvent } from "./org-audit.service.js";
import { ACTIVE_ORG_CLOSURE_STATUSES } from "./org-closure.service.js";

export const ORGANIZATION_OWNERSHIP_OFFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class OrganizationOwnershipOfferError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OrganizationOwnershipOfferError";
  }
}

export type OrganizationOwnershipOfferView = {
  id: string;
  organizationId: string;
  fromUserId: string;
  toUserId: string;
  status: string;
  createdAt: Date;
  expiresAtUtc: Date;
  decidedAtUtc: Date | null;
};

const OFFER_SELECT = {
  id: true,
  organizationId: true,
  fromUserId: true,
  toUserId: true,
  status: true,
  createdAt: true,
  expiresAtUtc: true,
  decidedAtUtc: true,
} as const;

const notFound = () =>
  new OrganizationOwnershipOfferError(404, "ownership_offer_not_found", "Ownership offer not found");

async function activeOwner(tx: Prisma.TransactionClient, organizationId: string, userId: string) {
  return tx.organizationMembership.findFirst({
    where: { organizationId, userId, role: "ORG_OWNER", status: "ACTIVE" },
    select: { id: true, validUntilUtc: true },
  });
}

/** The recipient as an eligible owner: an ACTIVE member with an open access window, not the owner. */
async function eligibleRecipient(tx: Prisma.TransactionClient, organizationId: string, userId: string) {
  const m = await tx.organizationMembership.findFirst({
    where: { organizationId, userId },
    select: { id: true, role: true, status: true, validUntilUtc: true },
  });
  if (!m) return { kind: "target_not_member" as const };
  // PROV-012 — neither a removed nor a suspended person (nor one whose access
  // window has closed) passes any organization check; ownership never lands there.
  if (!organizationMembershipGrantsAccess({ status: m.status, validUntilUtc: m.validUntilUtc })) {
    return { kind: "target_not_active" as const };
  }
  return { kind: "ok" as const, membership: m };
}

async function assertNoOpenClosure(tx: Prisma.TransactionClient, organizationId: string) {
  const open = await tx.organizationClosureRequest.findFirst({
    where: { organizationId, status: { in: [...ACTIVE_ORG_CLOSURE_STATUSES] } },
    select: { id: true },
  });
  if (open) {
    throw new OrganizationOwnershipOfferError(
      409,
      "closure_in_progress",
      "A closure request for this organization is open; cancel it before transferring ownership",
    );
  }
}

/** The owner OFFERS ownership to an ACTIVE member. Nothing moves yet. */
export async function offerOrganizationOwnership(input: {
  organizationId: string;
  actorUserId: string;
  newOwnerUserId: string;
  correlationId?: string | null;
}): Promise<OrganizationOwnershipOfferView> {
  const { organizationId, actorUserId, newOwnerUserId } = input;
  if (newOwnerUserId === actorUserId) {
    throw new OrganizationOwnershipOfferError(400, "transfer_to_self", "You already own this organization");
  }
  return prisma.$transaction(async (tx) => {
    await lockOrganizationOwnersTx(tx, organizationId);
    // PHASE 13 §1.4 (NEW-024) — status-aware: a suspended or revoked owner
    // offers nothing (the step-up is a second factor, not a lifecycle check).
    const owner = await activeOwner(tx, organizationId, actorUserId);
    if (!owner || !organizationMembershipGrantsAccess({ status: "ACTIVE", validUntilUtc: owner.validUntilUtc })) {
      throw new OrganizationOwnershipOfferError(403, "owner_required", "Only the organization owner can transfer ownership");
    }
    const target = await eligibleRecipient(tx, organizationId, newOwnerUserId);
    if (target.kind === "target_not_member") {
      throw new OrganizationOwnershipOfferError(404, "target_not_member", "The selected person is not a member");
    }
    if (target.kind === "target_not_active") {
      throw new OrganizationOwnershipOfferError(409, "OWNER_TARGET_NOT_ACTIVE", "Only an active member can become the owner.");
    }
    await assertNoOpenClosure(tx, organizationId);

    const now = new Date();
    const superseded = await tx.organizationOwnershipOffer.findMany({
      where: { organizationId, status: "PENDING" },
      select: { id: true },
    });
    if (superseded.length > 0) {
      await tx.organizationOwnershipOffer.updateMany({
        where: { id: { in: superseded.map((o) => o.id) } },
        data: { status: "SUPERSEDED", decidedAtUtc: now },
      });
    }
    const offer = await tx.organizationOwnershipOffer.create({
      data: {
        organizationId,
        fromUserId: actorUserId,
        toUserId: newOwnerUserId,
        status: "PENDING",
        expiresAtUtc: new Date(now.getTime() + ORGANIZATION_OWNERSHIP_OFFER_TTL_MS),
      },
      select: OFFER_SELECT,
    });
    await emitOrgAuditEvent(tx, {
      organizationId,
      actorUserId,
      eventType: "ORG_OWNERSHIP_OFFERED",
      targetType: "organization_membership",
      targetId: target.membership.id,
      metadata: {
        offerId: offer.id,
        fromUserId: actorUserId,
        toUserId: newOwnerUserId,
        supersededOfferIds: superseded.map((o) => o.id),
        expiresAtUtc: offer.expiresAtUtc.toISOString(),
      },
    });
    return offer;
  });
}

/** The pending offer of an organization, for its offerer or its named recipient only. */
export async function readPendingOrganizationOwnershipOffer(input: {
  organizationId: string;
  userId: string;
}): Promise<OrganizationOwnershipOfferView | null> {
  const offer = await prisma.organizationOwnershipOffer.findFirst({
    where: { organizationId: input.organizationId, status: "PENDING", expiresAtUtc: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: OFFER_SELECT,
  });
  if (!offer) return null;
  return offer.fromUserId === input.userId || offer.toUserId === input.userId ? offer : null;
}

export type OrganizationOwnershipAcceptance = {
  organizationId: string;
  fromUserId: string;
  toUserId: string;
  workspaceIds: string[];
  /** Always false: the payer never moves with ownership (decision E). */
  billingOwnerTransferred: false;
  contractOwnerTransferred: false;
  /** The billing owner that stays in force after the acceptance. */
  billingOwnerUserId: string | null;
};

/**
 * The named recipient ACCEPTS (the route has verified their step-up). Every
 * authority and eligibility question is asked again, under the owners' lock.
 */
export async function acceptOrganizationOwnershipOffer(input: {
  organizationId: string;
  offerId: string;
  actorUserId: string;
  correlationId?: string | null;
}): Promise<OrganizationOwnershipAcceptance> {
  const { organizationId, actorUserId } = input;
  return prisma.$transaction(async (tx) => {
    await lockOrganizationOwnersTx(tx, organizationId);
    const offer = await tx.organizationOwnershipOffer.findFirst({
      where: { id: input.offerId, organizationId },
      select: OFFER_SELECT,
    });
    // Not an oracle: anyone other than the recipient is told "not found".
    if (!offer || offer.toUserId !== actorUserId) throw notFound();
    if (offer.status !== "PENDING") {
      throw new OrganizationOwnershipOfferError(409, "ownership_offer_not_pending", "This ownership offer is no longer open");
    }
    if (offer.expiresAtUtc.getTime() <= Date.now()) {
      await tx.organizationOwnershipOffer.updateMany({
        where: { id: offer.id, status: "PENDING" },
        data: { status: "EXPIRED", decidedAtUtc: new Date() },
      });
      throw new OrganizationOwnershipOfferError(410, "ownership_offer_expired", "This ownership offer has expired");
    }

    // The offerer's authority, now. An offer is the owner's act; someone who
    // has since lost ownership (or been suspended) cannot have it completed.
    const owner = await activeOwner(tx, organizationId, offer.fromUserId);
    if (!owner || !organizationMembershipGrantsAccess({ status: "ACTIVE", validUntilUtc: owner.validUntilUtc })) {
      await tx.organizationOwnershipOffer.update({
        where: { id: offer.id },
        data: { status: "SUPERSEDED", decidedAtUtc: new Date() },
      });
      return { kind: "offerer_not_owner" as const };
    }
    // The recipient's eligibility, now. The offer stays PENDING: the offerer
    // may cancel it, and a restored member may still accept before expiry.
    const target = await eligibleRecipient(tx, organizationId, actorUserId);
    if (target.kind !== "ok") {
      throw new OrganizationOwnershipOfferError(409, "OWNER_TARGET_NOT_ACTIVE", "Only an active member can become the owner.");
    }
    await assertNoOpenClosure(tx, organizationId);

    // PROV-011 — the workspace owners move with the organization owner, in this
    // transaction (a workspace with no seat throws and rolls everything back).
    // The billing owner of each workspace does NOT move (decision E).
    const workspaces = await transferOrganizationWorkspaceOwnersTx(tx, {
      organizationId,
      fromUserId: offer.fromUserId,
      toUserId: actorUserId,
      actorUserId,
    });
    // Atomic swap — never zero owners, never two.
    await updateOrganizationMembershipRole(tx as never, {
      organizationMembershipId: target.membership.id,
      role: "ORG_OWNER",
      actorUserId,
    });
    await updateOrganizationMembershipRole(tx as never, {
      organizationMembershipId: owner.id,
      role: "ORG_ADMIN",
      actorUserId,
    });
    await tx.organizationOwnershipOffer.update({
      where: { id: offer.id },
      data: { status: "ACCEPTED", decidedAtUtc: new Date() },
    });

    const org = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { billingOwnerUserId: true },
    });
    const billingOwnerUserId = org?.billingOwnerUserId ?? null;

    await emitOrgAuditEvent(tx, {
      organizationId,
      actorUserId,
      eventType: "ORG_OWNERSHIP_TRANSFERRED",
      targetType: "organization_membership",
      targetId: target.membership.id,
      metadata: {
        offerId: offer.id,
        fromUserId: offer.fromUserId,
        toUserId: actorUserId,
        previousTargetRole: target.membership.role,
        billingOwnerTransferred: false,
        contractOwnerTransferred: false,
        billingOwnerUserId,
        workspacesTransferred: workspaces.workspaceIds,
      },
    });
    for (const [party, role] of [
      [offer.fromUserId, "previous_owner"],
      [actorUserId, "new_owner"],
    ] as const) {
      await emitTenantAudit(
        {
          action: "identity.organization_ownership_transferred",
          outcome: "success",
          sourceApp: "API",
          actorUserId: party,
          organizationId,
          resourceType: "organization",
          resourceId: organizationId,
          correlationId: input.correlationId ?? null,
          causationId: offer.id,
          metadata: { role, offerId: offer.id, billingOwnerTransferred: false },
        },
        tx as never,
      );
    }
    return {
      kind: "ok" as const,
      value: {
        organizationId,
        fromUserId: offer.fromUserId,
        toUserId: actorUserId,
        workspaceIds: workspaces.workspaceIds,
        billingOwnerTransferred: false as const,
        contractOwnerTransferred: false as const,
        billingOwnerUserId,
      },
    };
  }).then((r) => {
    // The SUPERSEDED write must commit, so the refusal is raised after the
    // transaction rather than inside it (which would roll it back).
    if (r.kind === "offerer_not_owner") {
      throw new OrganizationOwnershipOfferError(
        409,
        "ownership_offer_offerer_not_owner",
        "The person who offered ownership no longer owns this organization",
      );
    }
    return r.value;
  });
}

/** The recipient declines, or the offerer withdraws, a pending offer. */
export async function settleOrganizationOwnershipOffer(input: {
  organizationId: string;
  offerId: string;
  actorUserId: string;
  outcome: "DECLINED" | "CANCELLED";
}): Promise<OrganizationOwnershipOfferView> {
  return prisma.$transaction(async (tx) => {
    await lockOrganizationOwnersTx(tx, input.organizationId);
    const offer = await tx.organizationOwnershipOffer.findFirst({
      where: { id: input.offerId, organizationId: input.organizationId },
      select: OFFER_SELECT,
    });
    const party = input.outcome === "DECLINED" ? offer?.toUserId : offer?.fromUserId;
    if (!offer || party !== input.actorUserId) throw notFound();
    if (offer.status !== "PENDING") {
      throw new OrganizationOwnershipOfferError(409, "ownership_offer_not_pending", "This ownership offer is no longer open");
    }
    const settled = await tx.organizationOwnershipOffer.update({
      where: { id: offer.id },
      data: { status: input.outcome, decidedAtUtc: new Date() },
      select: OFFER_SELECT,
    });
    await emitOrgAuditEvent(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      eventType: input.outcome === "DECLINED" ? "ORG_OWNERSHIP_OFFER_DECLINED" : "ORG_OWNERSHIP_OFFER_CANCELLED",
      targetType: "organization",
      targetId: input.organizationId,
      metadata: { offerId: offer.id, fromUserId: offer.fromUserId, toUserId: offer.toUserId },
    });
    return settled;
  });
}
