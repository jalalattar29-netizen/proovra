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
import {
  activateTeamPlan,
  cancelTeamPlan,
  setPersonalPlan,
  upsertSubscription,
} from "../billing.service.js";

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

  if (params.plan === prismaPkg.PlanType.TEAM) {
    if (!params.teamId) return;

    if (params.status === prismaPkg.SubscriptionStatus.CANCELED) {
      await cancelTeamPlan({
        teamId: params.teamId,
        ownerUserId: params.userId,
      });
      return;
    }

    if (params.status === prismaPkg.SubscriptionStatus.ACTIVE) {
      await activateTeamPlan({
        teamId: params.teamId,
        ownerUserId: params.userId,
        plan: prismaPkg.PlanType.TEAM,
        status: prismaPkg.TeamBillingStatus.ACTIVE,
      });
      return;
    }

    if (params.status === prismaPkg.SubscriptionStatus.PAST_DUE) {
      const existingTeam = await prisma.team.findUnique({
        where: { id: params.teamId },
        select: {
          billingPlan: true,
          billingStatus: true,
        },
      });

      // PHASE 9 §12 — canonical commercial decision (no raw plan literals).
      const alreadyActivated = existingTeam
        ? isPaidTeamSubscriptionActive({
            billingPlan: existingTeam.billingPlan,
            billingStatus: existingTeam.billingStatus,
          })
        : false;

      if (alreadyActivated) {
        await activateTeamPlan({
          teamId: params.teamId,
          ownerUserId: params.userId,
          plan: prismaPkg.PlanType.TEAM,
          status: prismaPkg.TeamBillingStatus.PAST_DUE,
        });
      }

      return;
    }

    return;
  }

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
