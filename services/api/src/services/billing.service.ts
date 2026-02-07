import { prisma } from "../db.js";
import * as prismaPkg from "@prisma/client";

export async function ensureEntitlement(userId: string) {
  const entitlement = await prisma.entitlement.findFirst({
    where: { userId, active: true }
  });
  if (entitlement) return entitlement;
  return prisma.entitlement.create({
    data: {
      userId,
      plan: prismaPkg.PlanType.FREE,
      credits: 0,
      teamSeats: 0,
      active: true
    }
  });
}

export async function setPlan(userId: string, plan: prismaPkg.PlanType) {
  await prisma.entitlement.updateMany({
    where: { userId, active: true },
    data: { plan }
  });
}

export async function setTeamSeats(userId: string, seats: number) {
  await prisma.entitlement.updateMany({
    where: { userId, active: true },
    data: { teamSeats: seats }
  });
}

export async function addCredits(userId: string, credits: number) {
  await prisma.entitlement.updateMany({
    where: { userId, active: true },
    data: { credits: { increment: credits } }
  });
}

export async function recordPayment(params: {
  userId: string;
  provider: prismaPkg.PaymentProvider;
  providerPaymentId: string;
  amountCents: number;
  currency: string;
  status: prismaPkg.PaymentStatus;
}) {
  return prisma.payment.upsert({
    where: {
      provider_providerPaymentId: {
        provider: params.provider,
        providerPaymentId: params.providerPaymentId
      }
    },
    update: { status: params.status },
    create: params
  });
}

export async function upsertSubscription(params: {
  userId: string;
  provider: prismaPkg.PaymentProvider;
  providerSubId: string;
  status: prismaPkg.SubscriptionStatus;
  plan: prismaPkg.PlanType;
  currentPeriodEnd?: Date | null;
}) {
  return prisma.subscription.upsert({
    where: {
      provider_providerSubId: {
        provider: params.provider,
        providerSubId: params.providerSubId
      }
    },
    update: {
      status: params.status,
      plan: params.plan,
      currentPeriodEnd: params.currentPeriodEnd ?? null
    },
    create: {
      userId: params.userId,
      provider: params.provider,
      providerSubId: params.providerSubId,
      status: params.status,
      plan: params.plan,
      currentPeriodEnd: params.currentPeriodEnd ?? null
    }
  });
}
