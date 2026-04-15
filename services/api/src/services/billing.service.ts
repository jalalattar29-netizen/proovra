import { prisma } from "../db.js";
import * as prismaPkg from "@prisma/client";
import { getPlanCapabilities } from "./plan-catalog.service.js";
import { writeAnalyticsEvent } from "./analytics-event.service.js";

async function trackBillingEvent(params: {
  eventType: string;
  userId: string;
  teamId?: string | null;
  plan?: prismaPkg.PlanType | null;
  provider?: prismaPkg.PaymentProvider | null;
  paymentStatus?: prismaPkg.PaymentStatus | null;
  subscriptionStatus?: prismaPkg.SubscriptionStatus | null;
  metadata?: Record<string, unknown>;
}) {
  try {
    await writeAnalyticsEvent({
      eventType: params.eventType,
      userId: params.userId,
      entityType: params.teamId ? "team_billing" : "personal_billing",
      entityId: params.teamId ?? params.userId,
      sessionId: `system_${params.eventType}_${params.teamId ?? params.userId}`,
      visitorId: `system_billing_${params.userId}`,
      path: params.teamId ? "/billing/team" : "/billing",
      skipSessionUpsert: true,
      metadata: {
        teamId: params.teamId ?? null,
        plan: params.plan ?? null,
        provider: params.provider ?? null,
        paymentStatus: params.paymentStatus ?? null,
        subscriptionStatus: params.subscriptionStatus ?? null,
        ...(params.metadata ?? {}),
      },
    });
  } catch {
    // analytics must never block billing flows
  }
}

export async function ensureEntitlement(userId: string) {
  const existing = await prisma.entitlement.findFirst({
    where: { userId, active: true },
    orderBy: { createdAt: "desc" },
  });

  if (existing) {
    return existing;
  }

  const created = await prisma.entitlement.create({
    data: {
      userId,
      plan: prismaPkg.PlanType.FREE,
      credits: 0,
      teamSeats: 0,
      active: true,
    },
  });

  await trackBillingEvent({
    eventType: "billing_plan_changed",
    userId,
    plan: created.plan,
    metadata: {
      reason: "entitlement_initialized",
      credits: created.credits,
      teamSeats: created.teamSeats,
    },
  });

  return created;
}

export async function getActiveEntitlement(userId: string) {
  return ensureEntitlement(userId);
}

export async function setPersonalPlan(
  userId: string,
  plan: prismaPkg.PlanType
) {
  if (plan === prismaPkg.PlanType.TEAM) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "TEAM is not a valid personal plan"
    );
    err.statusCode = 409;
    err.code = "TEAM_NOT_ALLOWED_FOR_PERSONAL_WORKSPACE";
    throw err;
  }

  await ensureEntitlement(userId);

  await prisma.entitlement.updateMany({
    where: {
      userId,
      active: true,
    },
    data: {
      plan,
      teamSeats: 0,
    },
  });

  const next = await ensureEntitlement(userId);

  await trackBillingEvent({
    eventType: "billing_plan_changed",
    userId,
    plan,
    metadata: {
      workspaceType: "PERSONAL",
      credits: next.credits ?? 0,
      teamSeats: next.teamSeats ?? 0,
    },
  });

  return next;
}

export async function activateTeamPlan(params: {
  teamId: string;
  ownerUserId: string;
  plan: prismaPkg.PlanType;
  status?: prismaPkg.TeamBillingStatus;
}) {
  if (params.plan !== prismaPkg.PlanType.TEAM) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Only TEAM can activate a team workspace plan"
    );
    err.statusCode = 409;
    err.code = "INVALID_TEAM_PLAN";
    throw err;
  }

  const team = await prisma.team.findUnique({
    where: { id: params.teamId },
    select: {
      id: true,
      ownerUserId: true,
      _count: { select: { members: true } },
    },
  });

  if (!team) {
    const err: Error & { statusCode?: number } = new Error("Team not found");
    err.statusCode = 404;
    throw err;
  }

  if (team.ownerUserId !== params.ownerUserId) {
    const err: Error & { statusCode?: number } = new Error(
      "Only the team owner can manage this team billing"
    );
    err.statusCode = 403;
    throw err;
  }

  const caps = getPlanCapabilities(prismaPkg.PlanType.TEAM);
  const includedSeats = caps.includedSeats;
  const overSeatLimit = team._count.members > includedSeats;

  const updated = await prisma.team.update({
    where: { id: params.teamId },
    data: {
      billingOwnerUserId: params.ownerUserId,
      billingPlan: prismaPkg.PlanType.TEAM,
      billingStatus: params.status ?? prismaPkg.TeamBillingStatus.ACTIVE,
      includedSeats,
      overSeatLimit,
      billingActivatedAt: new Date(),
      billingCanceledAt: null,
    },
  });

  await trackBillingEvent({
    eventType: "team_plan_activated",
    userId: params.ownerUserId,
    teamId: params.teamId,
    plan: prismaPkg.PlanType.TEAM,
    metadata: {
      billingStatus: updated.billingStatus,
      includedSeats,
      memberCount: team._count.members,
      overSeatLimit,
    },
  });

  if (overSeatLimit) {
    await trackBillingEvent({
      eventType: "team_seat_limit_reached",
      userId: params.ownerUserId,
      teamId: params.teamId,
      plan: prismaPkg.PlanType.TEAM,
      metadata: {
        memberCount: team._count.members,
        includedSeats,
      },
    });
  }

  return updated;
}

export async function cancelTeamPlan(params: {
  teamId: string;
  ownerUserId: string;
}) {
  const team = await prisma.team.findUnique({
    where: { id: params.teamId },
    select: {
      id: true,
      ownerUserId: true,
    },
  });

  if (!team) {
    const err: Error & { statusCode?: number } = new Error("Team not found");
    err.statusCode = 404;
    throw err;
  }

  if (team.ownerUserId !== params.ownerUserId) {
    const err: Error & { statusCode?: number } = new Error(
      "Only the team owner can manage this team billing"
    );
    err.statusCode = 403;
    throw err;
  }

  const memberCount = await prisma.teamMember.count({
    where: { teamId: params.teamId },
  });

  const updated = await prisma.team.update({
    where: { id: params.teamId },
    data: {
      billingOwnerUserId: null,
      billingPlan: prismaPkg.PlanType.FREE,
      billingStatus: prismaPkg.TeamBillingStatus.CANCELED,
      includedSeats: 0,
      overSeatLimit: memberCount > 0,
      billingCanceledAt: new Date(),
    },
  });

  await trackBillingEvent({
    eventType: "team_plan_canceled",
    userId: params.ownerUserId,
    teamId: params.teamId,
    plan: prismaPkg.PlanType.FREE,
    metadata: {
      memberCount,
      overSeatLimit: updated.overSeatLimit,
      billingStatus: updated.billingStatus,
    },
  });

  return updated;
}

export async function addCredits(userId: string, credits: number) {
  const ensured = await ensureEntitlement(userId);
  const increment = Math.max(0, credits);

  const updated = await prisma.entitlement.update({
    where: { id: ensured.id },
    data: {
      credits: { increment },
    },
  });

  await trackBillingEvent({
    eventType: "billing_credits_added",
    userId,
    plan: updated.plan,
    metadata: {
      delta: increment,
      balance: updated.credits ?? 0,
    },
  });

  return updated;
}

export async function consumeCredits(userId: string, credits: number) {
  const ensured = await ensureEntitlement(userId);

  if ((ensured.credits ?? 0) < credits) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Insufficient credits"
    );
    err.statusCode = 402;
    err.code = "INSUFFICIENT_CREDITS";
    throw err;
  }

  const updated = await prisma.entitlement.update({
    where: { id: ensured.id },
    data: {
      credits: { decrement: credits },
    },
  });

  await trackBillingEvent({
    eventType: "billing_credits_consumed",
    userId,
    plan: updated.plan,
    metadata: {
      delta: credits,
      balance: updated.credits ?? 0,
    },
  });

  return updated;
}

export async function recordPayment(params: {
  userId: string;
  provider: prismaPkg.PaymentProvider;
  providerPaymentId: string;
  amountCents: number;
  currency: string;
  status: prismaPkg.PaymentStatus;
  teamId?: string | null;
}) {
  const payment = await prisma.payment.upsert({
    where: {
      provider_providerPaymentId: {
        provider: params.provider,
        providerPaymentId: params.providerPaymentId,
      },
    },
    update: {
      status: params.status,
      amountCents: params.amountCents,
      currency: params.currency,
      teamId: params.teamId ?? null,
    },
    create: {
      userId: params.userId,
      provider: params.provider,
      providerPaymentId: params.providerPaymentId,
      amountCents: params.amountCents,
      currency: params.currency,
      status: params.status,
      teamId: params.teamId ?? null,
    },
  });

  await trackBillingEvent({
    eventType:
      params.status === prismaPkg.PaymentStatus.SUCCEEDED
        ? "billing_payment_succeeded"
        : params.status === prismaPkg.PaymentStatus.FAILED
          ? "billing_payment_failed"
          : params.status === prismaPkg.PaymentStatus.REFUNDED
            ? "billing_payment_refunded"
            : "billing_checkout_completed",
    userId: params.userId,
    teamId: params.teamId ?? null,
    provider: params.provider,
    paymentStatus: params.status,
    metadata: {
      paymentId: params.providerPaymentId,
      amountCents: params.amountCents,
      currency: params.currency,
    },
  });

  return payment;
}

export async function upsertSubscription(params: {
  userId: string;
  provider: prismaPkg.PaymentProvider;
  providerSubId: string;
  status: prismaPkg.SubscriptionStatus;
  plan: prismaPkg.PlanType;
  currentPeriodEnd?: Date | null;
  teamId?: string | null;
}) {
  const existing = await prisma.subscription.findUnique({
    where: {
      provider_providerSubId: {
        provider: params.provider,
        providerSubId: params.providerSubId,
      },
    },
    select: {
      id: true,
      status: true,
      plan: true,
      teamId: true,
    },
  });

  const subscription = await prisma.subscription.upsert({
    where: {
      provider_providerSubId: {
        provider: params.provider,
        providerSubId: params.providerSubId,
      },
    },
    update: {
      status: params.status,
      plan: params.plan,
      currentPeriodEnd: params.currentPeriodEnd ?? null,
      teamId: params.teamId ?? null,
    },
    create: {
      userId: params.userId,
      provider: params.provider,
      providerSubId: params.providerSubId,
      status: params.status,
      plan: params.plan,
      currentPeriodEnd: params.currentPeriodEnd ?? null,
      teamId: params.teamId ?? null,
    },
  });

  await trackBillingEvent({
    eventType:
      params.status === prismaPkg.SubscriptionStatus.CANCELED
        ? "billing_subscription_canceled"
        : existing
          ? "billing_subscription_updated"
          : "billing_subscription_created",
    userId: params.userId,
    teamId: params.teamId ?? null,
    plan: params.plan,
    provider: params.provider,
    subscriptionStatus: params.status,
    metadata: {
      providerSubId: params.providerSubId,
      currentPeriodEnd: params.currentPeriodEnd
        ? params.currentPeriodEnd.toISOString()
        : null,
      previousStatus: existing?.status ?? null,
      previousPlan: existing?.plan ?? null,
    },
  });

  return subscription;
}

export async function syncTeamBillingSnapshot(params: {
  teamId: string;
  ownerUserId: string;
  plan: prismaPkg.PlanType;
  status: prismaPkg.TeamBillingStatus;
}) {
  if (params.plan === prismaPkg.PlanType.TEAM) {
    return activateTeamPlan({
      teamId: params.teamId,
      ownerUserId: params.ownerUserId,
      plan: prismaPkg.PlanType.TEAM,
      status: params.status,
    });
  }

  return cancelTeamPlan({
    teamId: params.teamId,
    ownerUserId: params.ownerUserId,
  });
}

export async function refreshTeamSeatState(teamId: string) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      ownerUserId: true,
      billingPlan: true,
      includedSeats: true,
      _count: {
        select: { members: true },
      },
    },
  });

  if (!team) return null;

  const overSeatLimit =
    team.includedSeats > 0 ? team._count.members > team.includedSeats : false;

  const updated = await prisma.team.update({
    where: { id: teamId },
    data: {
      overSeatLimit,
    },
  });

  if (overSeatLimit) {
    await trackBillingEvent({
      eventType: "team_seat_limit_reached",
      userId: team.ownerUserId,
      teamId,
      plan: team.billingPlan,
      metadata: {
        memberCount: team._count.members,
        includedSeats: team.includedSeats,
      },
    });
  }

  return updated;
}

export async function markTeamBillingCanceled(
  teamId: string,
  ownerUserId: string
) {
  return cancelTeamPlan({
    teamId,
    ownerUserId,
  });
}