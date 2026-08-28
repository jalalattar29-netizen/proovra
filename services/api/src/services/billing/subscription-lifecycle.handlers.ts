/**
 * BILLING RECONCILIATION (2026-08-27) — the shared subscription-lifecycle
 * handlers.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * `syncPlanForSubscription` and `storageAddonStatusFromSubscription` lived
 * inside `webhooks.routes.ts`. That was fine while a verified webhook was the
 * only way a provider fact could reach the domain. It is not fine now:
 * reconciliation learns the SAME facts by polling, and a second copy of "what
 * an ACTIVE TEAM subscription means" is exactly how the two paths come to
 * disagree about a customer's plan.
 *
 * The behaviour is moved, not rewritten. The webhook imports it from here and
 * calls it unchanged, so the verified path keeps its meaning and the polled
 * path cannot invent a different one.
 *
 * WHAT IS NOT HERE
 * ---------------------------------------------------------------------------
 * No provider parsing, no signature handling, no route concerns. This module
 * takes facts that have already been established — by a verified signature or
 * by an authenticated read we initiated — and applies the commercial
 * consequence.
 */

import * as prismaPkg from "@prisma/client";
import { isWorkspaceSubscriptionActive as isPaidTeamSubscriptionActive } from "@proovra/shared-billing";

import { prisma } from "../../db.js";
// BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `activateTeamPlan` and
// `cancelTeamPlan` are no longer imported. They write a WORKSPACE's commercial
// columns, and a self-service subscription no longer has a workspace to write.
// They remain in `billing.service` for the Enterprise provisioning path, which
// legitimately does set an organization workspace's plan.
import { setPersonalPlan, upsertSubscription } from "../billing.service.js";

/**
 * The add-on status a provider subscription status implies.
 *
 * Exhaustive over `SubscriptionStatus` on purpose: a new provider status added
 * to the enum should fail the build here rather than silently fall through to
 * "leave it active", which is the disposition that keeps an orphan charging.
 */
export function storageAddonStatusFromSubscription(
  status: prismaPkg.SubscriptionStatus,
): prismaPkg.WorkspaceStorageAddonStatus {
  switch (status) {
    case prismaPkg.SubscriptionStatus.ACTIVE:
      return prismaPkg.WorkspaceStorageAddonStatus.ACTIVE;
    case prismaPkg.SubscriptionStatus.TRIALING:
      return prismaPkg.WorkspaceStorageAddonStatus.PENDING;
    case prismaPkg.SubscriptionStatus.PAST_DUE:
      return prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE;
    case prismaPkg.SubscriptionStatus.CANCELED:
      return prismaPkg.WorkspaceStorageAddonStatus.CANCELED;
  }
}

/**
 * Apply ONE established subscription fact to the canonical plan state.
 *
 * Moved verbatim from `webhooks.routes.ts` so the verified and the polled path
 * share one implementation. The only addition is `providerStateAtUtc`, which
 * the ordering guard in the reconciliation service records after this returns.
 */
export async function syncPlanForSubscription(params: {
  userId: string;
  plan: prismaPkg.PlanType;
  teamId?: string | null;
  provider: prismaPkg.PaymentProvider;
  providerSubId: string;
  status: prismaPkg.SubscriptionStatus;
  currentPeriodEnd?: Date | null;
}) {
  await upsertSubscription({
    userId: params.userId,
    provider: params.provider,
    providerSubId: params.providerSubId,
    status: params.status,
    plan: params.plan,
    currentPeriodEnd: params.currentPeriodEnd ?? null,
    teamId: params.teamId ?? null,
  });

  // ===========================================================================
  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — TEAM is a PERSONAL tier.
  // ===========================================================================
  //
  // A whole branch stood here that treated a TEAM subscription as the
  // commercial state of a WORKSPACE: it called `activateTeamPlan` /
  // `cancelTeamPlan` against `params.teamId`, refusing to do anything at all
  // when there was no team id. That is the obsolete model at the point where
  // provider truth enters the system — a TEAM subscription that belonged to a
  // person could not be applied, because the handler had nowhere to put it.
  //
  // TEAM is now the higher tier of the same Personal Workspace, so PRO and
  // TEAM take exactly the same path below and differ only in which plan value
  // is written. There is no workspace to activate.
  //
  // A LEGACY row still carrying a `teamId` — written under the obsolete model,
  // for a workspace the customer really did pay for — is still applied to its
  // owner's personal entitlement rather than dropped. The paid right survives
  // the model change; only where it is recorded moves.

  if (params.status === prismaPkg.SubscriptionStatus.CANCELED) {
    await setPersonalPlan(params.userId, prismaPkg.PlanType.FREE);
    return;
  }

  if (params.status === prismaPkg.SubscriptionStatus.TRIALING) {
    return;
  }

  if (params.status === prismaPkg.SubscriptionStatus.ACTIVE) {
    await setPersonalPlan(params.userId, params.plan);
  }
}
