import * as prismaPkg from "@prisma/client";
import {
  PLAN_CAPABILITIES,
  formatBytesHuman,
} from "@proovra/shared-billing";
import { listStorageAddonDefinitions } from "./billing.service.js";

export type BillingCurrency = "USD" | "EUR";

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function normalizeBillingCurrency(
  value?: string | null
): BillingCurrency {
  return String(value ?? "").trim().toUpperCase() === "EUR" ? "EUR" : "USD";
}

export function resolveCheckoutCurrency(params: {
  requestedCurrency?: string | null;
}): BillingCurrency {
  return normalizeBillingCurrency(params.requestedCurrency);
}

export function getPlanPriceCents(
  plan: prismaPkg.PlanType,
  currency: BillingCurrency
): number {
  if (plan === prismaPkg.PlanType.PAYG) {
    return currency === "EUR"
      ? readInt("BILLING_PAYG_PRICE_CENTS_EUR", 500)
      : readInt("BILLING_PAYG_PRICE_CENTS_USD", 500);
  }

  if (plan === prismaPkg.PlanType.PRO) {
    return currency === "EUR"
      ? readInt("BILLING_PRO_PRICE_CENTS_EUR", 1900)
      : readInt("BILLING_PRO_PRICE_CENTS_USD", 1900);
  }

  if (plan === prismaPkg.PlanType.TEAM) {
    return currency === "EUR"
      ? readInt("BILLING_TEAM_PRICE_CENTS_EUR", 7900)
      : readInt("BILLING_TEAM_PRICE_CENTS_USD", 7900);
  }

  return 0;
}

export function getStripePlanPriceId(
  plan: prismaPkg.PlanType,
  currency: BillingCurrency
): string | null {
  if (plan === prismaPkg.PlanType.PAYG) {
    return currency === "EUR"
      ? process.env.STRIPE_PAYG_PRICE_ID_EUR?.trim() || null
      : process.env.STRIPE_PAYG_PRICE_ID_USD?.trim() || null;
  }

  if (plan === prismaPkg.PlanType.PRO) {
    return currency === "EUR"
      ? process.env.STRIPE_PRO_PRICE_ID_EUR?.trim() || null
      : process.env.STRIPE_PRO_PRICE_ID_USD?.trim() || null;
  }

  if (plan === prismaPkg.PlanType.TEAM) {
    return currency === "EUR"
      ? process.env.STRIPE_TEAM_PRICE_ID_EUR?.trim() || null
      : process.env.STRIPE_TEAM_PRICE_ID_USD?.trim() || null;
  }

  return null;
}

export function getStorageAddonPriceCents(params: {
  addonKey: prismaPkg.StorageAddonKey;
  currency: BillingCurrency;
}): number {
  const key = `BILLING_STORAGE_${params.addonKey}_${params.currency}_PRICE_CENTS`;
  const fallback =
    listStorageAddonDefinitions().find((item) => item.key === params.addonKey)
      ?.priceCents ?? 0;

  return readInt(key, fallback);
}

export function getStorageAddonCurrency(params: {
  requestedCurrency?: string | null;
}): BillingCurrency {
  return resolveCheckoutCurrency({
    requestedCurrency: params.requestedCurrency,
  });
}

export function getStripeStorageAddonPriceId(params: {
  addonKey: prismaPkg.StorageAddonKey;
  billingCycle: prismaPkg.StorageAddonBillingCycle;
  currency: BillingCurrency;
}): string | null {
  if (params.billingCycle !== prismaPkg.StorageAddonBillingCycle.ONE_TIME) {
    return null;
  }

  const envKey = `STRIPE_STORAGE_${params.addonKey}_ONE_TIME_${params.currency}_PRICE_ID`;
  return process.env[envKey]?.trim() || null;
}

export function buildPricingCatalogResponse(params: {
  currency: BillingCurrency;
}) {
  const currency = params.currency;

  return {
    currency,
    free: {
      plan: "FREE" as const,
      displayName: PLAN_CAPABILITIES.FREE.displayName,
      monthlyPriceCents: 0,
      storageBytes: PLAN_CAPABILITIES.FREE.includedStorageBytes.toString(),
      storageLabel: formatBytesHuman(PLAN_CAPABILITIES.FREE.includedStorageBytes),
      reportsIncluded: PLAN_CAPABILITIES.FREE.reportsIncluded,
      verificationPackageIncluded:
        PLAN_CAPABILITIES.FREE.verificationPackageIncluded,
      publicVerifyIncluded: PLAN_CAPABILITIES.FREE.publicVerifyIncluded,
      maxEvidenceRecords: PLAN_CAPABILITIES.FREE.maxEvidenceRecords,
      seats: PLAN_CAPABILITIES.FREE.includedSeats,
      workspaceType: PLAN_CAPABILITIES.FREE.workspaceType,
    },
    payg: {
      plan: "PAYG" as const,
      displayName: PLAN_CAPABILITIES.PAYG.displayName,
      monthlyPriceCents: getPlanPriceCents(prismaPkg.PlanType.PAYG, currency),
      storageBytes: PLAN_CAPABILITIES.PAYG.includedStorageBytes.toString(),
      storageLabel: formatBytesHuman(PLAN_CAPABILITIES.PAYG.includedStorageBytes),
      reportsIncluded: PLAN_CAPABILITIES.PAYG.reportsIncluded,
      verificationPackageIncluded:
        PLAN_CAPABILITIES.PAYG.verificationPackageIncluded,
      publicVerifyIncluded: PLAN_CAPABILITIES.PAYG.publicVerifyIncluded,
      creditsRequiredPerCompletion:
        PLAN_CAPABILITIES.PAYG.paygCreditsRequiredPerCompletion,
      seats: PLAN_CAPABILITIES.PAYG.includedSeats,
      workspaceType: PLAN_CAPABILITIES.PAYG.workspaceType,
    },
    pro: {
      plan: "PRO" as const,
      displayName: PLAN_CAPABILITIES.PRO.displayName,
      monthlyPriceCents: getPlanPriceCents(prismaPkg.PlanType.PRO, currency),
      storageBytes: PLAN_CAPABILITIES.PRO.includedStorageBytes.toString(),
      storageLabel: formatBytesHuman(PLAN_CAPABILITIES.PRO.includedStorageBytes),
      reportsIncluded: PLAN_CAPABILITIES.PRO.reportsIncluded,
      verificationPackageIncluded:
        PLAN_CAPABILITIES.PRO.verificationPackageIncluded,
      publicVerifyIncluded: PLAN_CAPABILITIES.PRO.publicVerifyIncluded,
      seats: PLAN_CAPABILITIES.PRO.includedSeats,
      workspaceType: PLAN_CAPABILITIES.PRO.workspaceType,
    },
    team: {
      plan: "TEAM" as const,
      displayName: PLAN_CAPABILITIES.TEAM.displayName,
      monthlyPriceCents: getPlanPriceCents(prismaPkg.PlanType.TEAM, currency),
      storageBytes: PLAN_CAPABILITIES.TEAM.includedStorageBytes.toString(),
      storageLabel: formatBytesHuman(PLAN_CAPABILITIES.TEAM.includedStorageBytes),
      reportsIncluded: PLAN_CAPABILITIES.TEAM.reportsIncluded,
      verificationPackageIncluded:
        PLAN_CAPABILITIES.TEAM.verificationPackageIncluded,
      publicVerifyIncluded: PLAN_CAPABILITIES.TEAM.publicVerifyIncluded,
      seats: PLAN_CAPABILITIES.TEAM.includedSeats,
      workspaceType: PLAN_CAPABILITIES.TEAM.workspaceType,
    },
    storageAddons: listStorageAddonDefinitions().map((item) => ({
      key: item.key,
      workspaceType: item.workspaceType,
      label: item.label,
      storageBytes: Number(item.storageBytes),
      priceCents: getStorageAddonPriceCents({
        addonKey: item.key,
        currency,
      }),
      currency,
      billingCycle: "ONE_TIME" as const,
    })),
  };
}