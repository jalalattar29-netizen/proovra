/**
 * PRO-N1-01 (WS-BILL, 2026-11-18) — THE question closure asks of billing:
 * "is a provider billing relationship still open for this payer or for a
 * workspace this closure closes?"
 *
 * It is NOT the entitlement question. `resolveCommercialContext(...).lifecycle
 * .paidActive` answers "is this subject paying for access right now", and it
 * short-circuits a FREE entitlement, reads two live rows as CANCELLED and a
 * PAST_DUE row beyond grace as not paid. Every one of those can still be
 * charged by the provider (renewal, dunning retry, a duplicate awaiting its
 * cancel). Closure anonymises the payer irreversibly, so it must judge the
 * RELATIONSHIP: every base subscription row and every recurring storage add-on
 * the provider may still bill, keyed by purchaser AND by the workspaces being
 * closed (a transferred workspace's subscription belongs to its previous owner
 * as purchaser but closes with the new owner's account).
 *
 * Each relationship is either
 *   RENEWING   nothing has stopped it: closure must not proceed (blocker);
 *   STOPPING   the provider confirmed the end (cancel-at-period-end, a PayPal
 *              cancel awaiting its event, a confirmed dependent add-on cancel,
 *              a superseded duplicate PROOVRA is cancelling) but the row is
 *              still live: closure may be SCHEDULED and completes only once the
 *              row has ended (DEC-21).
 *
 * Pure reads; no provider call. Used by account closure and workspace closure,
 * so both closures share one billing predicate.
 */

import type * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";

const LIVE_SUBSCRIPTION_STATUSES = ["ACTIVE", "TRIALING", "PAST_DUE"] as const;
const LIVE_ADDON_STATUSES = ["PENDING", "ACTIVE", "PAST_DUE"] as const;

export type OpenProviderRelationship = {
  kind: "SUBSCRIPTION" | "STORAGE_ADDON";
  id: string;
  state: "RENEWING" | "STOPPING";
  /** When billing/access ends, where the provider named it. */
  endsAtUtc: Date | null;
};

export type OpenRelationshipClient = Pick<
  typeof prisma,
  "subscription" | "workspaceStorageAddon"
>;

export async function listOpenProviderRelationships(
  input: {
    /** The payer whose purchases are judged (account closure). */
    userId?: string | null;
    /** Workspaces being closed: their subscriptions and add-ons, whoever bought them. */
    teamIds?: readonly string[];
  },
  client: OpenRelationshipClient = prisma,
): Promise<OpenProviderRelationship[]> {
  const teamIds = [...new Set(input.teamIds ?? [])];
  const subjectOr = <T extends "userId" | "ownerUserId">(userKey: T) => [
    ...(input.userId ? [{ [userKey]: input.userId } as Record<T, string>] : []),
    ...(teamIds.length > 0 ? [{ teamId: { in: teamIds } }] : []),
  ];
  const subOr = subjectOr("userId");
  const addonOr = subjectOr("ownerUserId");
  if (subOr.length === 0) return [];

  const [subs, addons] = await Promise.all([
    client.subscription.findMany({
      where: { status: { in: [...LIVE_SUBSCRIPTION_STATUSES] }, OR: subOr as prismaPkg.Prisma.SubscriptionWhereInput[] },
      select: {
        id: true,
        cancelAtPeriodEnd: true,
        canceledAtUtc: true,
        currentPeriodEnd: true,
        supersededBySubscriptionId: true,
      },
    }),
    client.workspaceStorageAddon.findMany({
      where: {
        status: { in: [...LIVE_ADDON_STATUSES] },
        billingCycle: "MONTHLY",
        externalSubscriptionId: { not: null },
        OR: addonOr as prismaPkg.Prisma.WorkspaceStorageAddonWhereInput[],
      },
      select: {
        id: true,
        canceledAtUtc: true,
        currentPeriodEnd: true,
        dependentCancellationState: true,
      },
    }),
  ]);

  return [
    ...subs.map<OpenProviderRelationship>((s) => ({
      kind: "SUBSCRIPTION",
      id: s.id,
      state:
        s.cancelAtPeriodEnd || s.canceledAtUtc !== null || s.supersededBySubscriptionId !== null
          ? "STOPPING"
          : "RENEWING",
      endsAtUtc: s.currentPeriodEnd,
    })),
    ...addons.map<OpenProviderRelationship>((a) => ({
      kind: "STORAGE_ADDON",
      id: a.id,
      state: a.canceledAtUtc !== null || a.dependentCancellationState === "CONFIRMED" ? "STOPPING" : "RENEWING",
      endsAtUtc: a.currentPeriodEnd,
    })),
  ];
}
