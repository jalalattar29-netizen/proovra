/**
 * Closure 2 ("sem" item 2) — WHO PAYS FOR AN ORGANIZATION, said explicitly.
 *
 * Decision E: an ownership transfer never moves a payment-provider agreement or
 * payment liability. `Organization.billingOwnerUserId`, `Team.billingOwnerUserId`,
 * `EnterpriseContract.contractOwnerUserId` and every `Subscription.userId` stay
 * as they were when ownership moves (NEW-RG-26-4, org-ownership-offer.service).
 * That left three things implicit, and this projection states them:
 *
 *   1. WHO the payer is and where they stand now — the owner, a member who is
 *      no longer the owner (the former owner after a transfer), or somebody who
 *      has left the organization.
 *   2. WHICH provider agreements bill the organization's workspaces, each with
 *      the person it bills (the purchaser) — the one person who can stop it.
 *      A provider subscription is cancelled from its purchaser's OWN Billing
 *      (`POST /v1/billing/subscription/cancel` acts only on the caller's own
 *      subscription), so the new owner holds no hidden liability and also
 *      cannot cancel the former owner's agreement.
 *   3. WHAT that means for closure: an organization closes only once those
 *      agreements have ended (BILLING_SUBSCRIPTION_ACTIVE, the PRO-N1-01
 *      predicate), so the owner is told who has to act.
 *
 * There is no self-service handover of a provider agreement or of the
 * Enterprise contract owner: a handover is the account manager's (sales-led
 * contract) or the payer cancelling and the new owner subscribing. The guidance
 * codes say so; nothing here writes.
 *
 * Read-only. No price, quota or entitlement is read or changed.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import {
  listOpenProviderRelationships,
  type OpenProviderRelationship,
} from "../billing/open-provider-relationships.service.js";

export type OrgPayerState =
  /** The person billed is the organization's current live owner. */
  | "PAYER_IS_OWNER"
  /** The person billed is still a member but no longer the owner (e.g. after a transfer). */
  | "PAYER_IS_MEMBER_NOT_OWNER"
  /** The person billed has left the organization (or was removed). */
  | "PAYER_LEFT_ORGANIZATION"
  /** No billing owner is recorded. */
  | "NO_PAYER";

export type OrgPayerGuidance =
  /** Ownership moved; payment liability did not (decision E). */
  | "PAYER_UNCHANGED_BY_OWNERSHIP_TRANSFER"
  /** A provider agreement is cancelled only by the person it bills, from their own Billing. */
  | "PAYER_CANCELS_IN_OWN_BILLING"
  /** Handing an agreement or the contract to someone else is arranged with the account manager. */
  | "HANDOVER_VIA_ACCOUNT_MANAGER"
  /** The viewer (an owner/administrator) is not the payer and cannot cancel it. */
  | "VIEWER_CANNOT_CANCEL_PAYER_AGREEMENT"
  /** The viewer is the payer: they keep paying until they cancel or hand over. */
  | "VIEWER_REMAINS_LIABLE_UNTIL_CANCELLED"
  /** Closure waits until every listed agreement has ended. */
  | "CLOSURE_WAITS_FOR_AGREEMENTS_TO_END";

export type OrgPayerAgreement = {
  kind: OpenProviderRelationship["kind"];
  id: string;
  state: OpenProviderRelationship["state"];
  endsAtUtc: string | null;
  payerUserId: string | null;
  payerDisplayName: string | null;
  payerIsViewer: boolean;
  payerIsBillingOwner: boolean;
};

export type OrgPayerProjection = {
  organizationId: string;
  billingOwner: {
    userId: string;
    displayName: string | null;
    membership: "OWNER" | "MEMBER" | "SUSPENDED" | "LEFT";
  } | null;
  contractOwnerUserId: string | null;
  viewerIsPayer: boolean;
  state: OrgPayerState;
  agreements: OrgPayerAgreement[];
  closure: { renewing: number; stopping: number; blockedByAgreements: boolean };
  guidance: OrgPayerGuidance[];
};

type Client = Pick<
  PrismaClient,
  "organization" | "organizationMembership" | "team" | "user" | "enterpriseContract" | "subscription" | "workspaceStorageAddon" | "billingCheckoutAttempt"
>;

/** The organization's workspaces whose provider agreements bill it. */
async function organizationWorkspaceIds(organizationId: string, client: Client): Promise<string[]> {
  return (
    await client.team.findMany({
      where: { organizationId, isPersonal: false, closedAtUtc: null },
      select: { id: true },
    })
  ).map((t) => t.id);
}

/**
 * The provider agreements billing this organization's workspaces, each with
 * the person it bills. A CHECKOUT_ATTEMPT is a payer's own pending purchase and
 * is not an organization agreement, so it is not listed here.
 */
export async function organizationProviderAgreements(
  organizationId: string,
  client: Client = defaultPrisma,
): Promise<OpenProviderRelationship[]> {
  const teamIds = await organizationWorkspaceIds(organizationId, client);
  if (teamIds.length === 0) return [];
  return (await listOpenProviderRelationships({ teamIds }, client)).filter((r) => r.kind !== "CHECKOUT_ATTEMPT");
}

export async function resolveOrganizationPayerProjection(
  input: { organizationId: string; viewerUserId: string },
  client: Client = defaultPrisma,
): Promise<OrgPayerProjection> {
  const [org, contract, relationships] = await Promise.all([
    client.organization.findUnique({
      where: { id: input.organizationId },
      select: { billingOwnerUserId: true },
    }),
    client.enterpriseContract.findUnique({
      where: { organizationId: input.organizationId },
      select: { contractOwnerUserId: true },
    }),
    organizationProviderAgreements(input.organizationId, client),
  ]);
  const billingOwnerUserId = org?.billingOwnerUserId ?? null;
  const payerIds = [
    ...new Set(
      [billingOwnerUserId, ...relationships.map((r) => r.payerUserId)].filter((id): id is string => !!id),
    ),
  ];
  const [users, memberships] = await Promise.all([
    payerIds.length
      ? client.user.findMany({ where: { id: { in: payerIds } }, select: { id: true, displayName: true } })
      : Promise.resolve([] as Array<{ id: string; displayName: string | null }>),
    payerIds.length
      ? client.organizationMembership.findMany({
          where: { organizationId: input.organizationId, userId: { in: payerIds } },
          select: { userId: true, role: true, status: true },
        })
      : Promise.resolve([] as Array<{ userId: string; role: string; status: string }>),
  ]);
  const nameOf = new Map(users.map((u) => [u.id, u.displayName?.trim() || null]));
  const membershipOf = (userId: string): "OWNER" | "MEMBER" | "SUSPENDED" | "LEFT" => {
    const m = memberships.find((x) => x.userId === userId);
    if (!m || m.status === "REVOKED") return "LEFT";
    if (m.status === "SUSPENDED") return "SUSPENDED";
    return m.role === "ORG_OWNER" ? "OWNER" : "MEMBER";
  };

  const billingOwner = billingOwnerUserId
    ? { userId: billingOwnerUserId, displayName: nameOf.get(billingOwnerUserId) ?? null, membership: membershipOf(billingOwnerUserId) }
    : null;
  const state: OrgPayerState = !billingOwner
    ? "NO_PAYER"
    : billingOwner.membership === "OWNER"
      ? "PAYER_IS_OWNER"
      : billingOwner.membership === "LEFT"
        ? "PAYER_LEFT_ORGANIZATION"
        : "PAYER_IS_MEMBER_NOT_OWNER";

  const agreements: OrgPayerAgreement[] = relationships.map((r) => ({
    kind: r.kind,
    id: r.id,
    state: r.state,
    endsAtUtc: r.endsAtUtc?.toISOString() ?? null,
    payerUserId: r.payerUserId,
    payerDisplayName: r.payerUserId ? (nameOf.get(r.payerUserId) ?? null) : null,
    payerIsViewer: r.payerUserId === input.viewerUserId,
    payerIsBillingOwner: r.payerUserId !== null && r.payerUserId === billingOwnerUserId,
  }));
  const renewing = agreements.filter((a) => a.state === "RENEWING").length;
  const stopping = agreements.length - renewing;
  const viewerIsPayer =
    billingOwnerUserId === input.viewerUserId || agreements.some((a) => a.payerIsViewer);

  const guidance: OrgPayerGuidance[] = [];
  if (state === "PAYER_IS_MEMBER_NOT_OWNER" || state === "PAYER_LEFT_ORGANIZATION") {
    guidance.push("PAYER_UNCHANGED_BY_OWNERSHIP_TRANSFER", "HANDOVER_VIA_ACCOUNT_MANAGER");
  }
  if (renewing > 0) guidance.push("PAYER_CANCELS_IN_OWN_BILLING");
  if (agreements.some((a) => !a.payerIsViewer)) guidance.push("VIEWER_CANNOT_CANCEL_PAYER_AGREEMENT");
  if (viewerIsPayer && (renewing > 0 || state !== "PAYER_IS_OWNER")) guidance.push("VIEWER_REMAINS_LIABLE_UNTIL_CANCELLED");
  if (agreements.length > 0) guidance.push("CLOSURE_WAITS_FOR_AGREEMENTS_TO_END");

  return {
    organizationId: input.organizationId,
    billingOwner,
    contractOwnerUserId: contract?.contractOwnerUserId ?? null,
    viewerIsPayer,
    state,
    agreements,
    closure: { renewing, stopping, blockedByAgreements: agreements.length > 0 },
    guidance: [...new Set(guidance)],
  };
}

/**
 * What a person leaving the organization still pays for in it: provider
 * agreements on its workspaces that bill them and still RENEW, and whether
 * they are the recorded billing owner or contract owner. Leaving ends their
 * access, not their liability, so the leave route asks them to acknowledge
 * this first (closure 2, "sem" item 2).
 */
export async function payerObligationsOnLeave(
  input: { organizationId: string; userId: string },
  client: Client = defaultPrisma,
): Promise<{
  renewingAgreements: Array<{ kind: OpenProviderRelationship["kind"]; id: string; endsAtUtc: string | null }>;
  isBillingOwner: boolean;
  isContractOwner: boolean;
  any: boolean;
}> {
  const [org, contract, relationships] = await Promise.all([
    client.organization.findUnique({ where: { id: input.organizationId }, select: { billingOwnerUserId: true } }),
    client.enterpriseContract.findUnique({
      where: { organizationId: input.organizationId },
      select: { contractOwnerUserId: true },
    }),
    organizationProviderAgreements(input.organizationId, client),
  ]);
  const renewingAgreements = relationships
    .filter((r) => r.payerUserId === input.userId && r.state === "RENEWING")
    .map((r) => ({ kind: r.kind, id: r.id, endsAtUtc: r.endsAtUtc?.toISOString() ?? null }));
  const isBillingOwner = org?.billingOwnerUserId === input.userId;
  const isContractOwner = contract?.contractOwnerUserId === input.userId;
  return {
    renewingAgreements,
    isBillingOwner,
    isContractOwner,
    any: renewingAgreements.length > 0 || isBillingOwner || isContractOwner,
  };
}
