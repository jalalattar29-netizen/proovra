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

  // ENTERPRISE is Custom — no published monthly price; FREE is 0.
  return 0;
}

/**
 * BILLING PRODUCTION CLOSURE (2026-08-27) — the evidence-credit PRODUCT price.
 *
 * Credits are a product, not a plan, and the modern checkout must not name a
 * plan to buy one. These two wrappers give the product its own price identity
 * while resolving through the SAME server-owned environment mapping the
 * one-time purchase has always used — the variable names are retained
 * deliberately, because renaming a configured Stripe price id in a code change
 * would take the product offline on every deployment that has one set.
 *
 * There is no second price authority here: both delegate.
 */
export function getEvidenceCreditPriceCents(currency: BillingCurrency): number {
  return getPlanPriceCents(prismaPkg.PlanType.PAYG, currency);
}

export function getStripeEvidenceCreditPriceId(
  currency: BillingCurrency,
): string | null {
  return getStripePlanPriceId(prismaPkg.PlanType.PAYG, currency);
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
  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the price id is per CYCLE.
  // This returned null for anything but ONE_TIME, so a recurring add-on could
  // never resolve a configured Stripe Price and would silently fall back to an
  // inline price with no recurring interval — a one-time charge wearing a
  // subscription's name.
  const envKey = `STRIPE_STORAGE_${params.addonKey}_${params.billingCycle}_${params.currency}_PRICE_ID`;
  return process.env[envKey]?.trim() || null;
}

function projectPublishedPlan<P extends "FREE" | "PAYG" | "PRO" | "TEAM">(
  plan: P,
  monthlyPriceCents: number,
) {
  const caps = PLAN_CAPABILITIES[plan];
  return {
    plan,
    displayName: caps.displayName,
    monthlyPriceCents,
    storageBytes: caps.includedStorageBytes.toString(),
    storageLabel: formatBytesHuman(caps.includedStorageBytes),
    reportsIncluded: caps.reportsIncluded,
    verificationPackageIncluded: caps.verificationPackageIncluded,
    publicVerifyIncluded: caps.publicVerifyIncluded,
    maxEvidenceRecords: caps.maxEvidenceRecords,
    maxEvidenceRecordsPerMonth: caps.maxEvidenceRecordsPerMonth,
    aiAdvisoryMonthlyOperations: caps.aiAdvisoryMonthlyOperations,
    seats: caps.includedSeats,
    billingShape: caps.billingShape,
    maxOwnedWorkspaces: caps.maxOwnedWorkspaces,
    maxCollaborationTeamsPerWorkspace: caps.maxCollaborationTeamsPerWorkspace,
    maxAcceptedMembersPerCollaborationTeam:
      caps.maxAcceptedMembersPerCollaborationTeam,
    maxWorkspaceSeats: caps.maxWorkspaceSeats,
    enterpriseFeatures: caps.enterpriseFeatures,
  };
}

export function buildPricingCatalogResponse(params: {
  currency: BillingCurrency;
}) {
  const currency = params.currency;

  const enterpriseCaps = PLAN_CAPABILITIES.ENTERPRISE;

  return {
    currency,
    free: projectPublishedPlan("FREE", 0),
    payg: {
      ...projectPublishedPlan(
        "PAYG",
        getPlanPriceCents(prismaPkg.PlanType.PAYG, currency),
      ),
      creditsRequiredPerCompletion:
        PLAN_CAPABILITIES.PAYG.paygCreditsRequiredPerCompletion,
    },
    pro: projectPublishedPlan(
      "PRO",
      getPlanPriceCents(prismaPkg.PlanType.PRO, currency),
    ),
    team: projectPublishedPlan(
      "TEAM",
      getPlanPriceCents(prismaPkg.PlanType.TEAM, currency),
    ),
    /**
     * Enterprise is Sales-provisioned (Custom). The marketing object
     * is published so the public Pricing page and in-app Billing UI
     * both source Enterprise capability copy from the same place. The
     * in-product entitlement check (`assertEnterpriseFeature`) uses
     * the boolean flags on `PLAN_CAPABILITIES.ENTERPRISE` server-side.
     */
    enterprise: {
      displayName: enterpriseCaps.displayName,
      pricingModel: "CUSTOM" as const,
      ctaLabel: "Contact Sales",
      ctaHref: "/contact-sales",
      summary:
        "Custom commercial terms for larger organizations that need procurement handling, governance review, rollout planning, or higher-volume evidence operations.",
      capabilities: [
        "Custom operational volume and onboarding scope",
        "Custom storage envelope and rollout planning",
        "SAML SSO and SCIM provisioning",
        "MFA enforcement, access reviews, session governance",
        "Legal hold and custom retention policies",
        "Organization audit logs",
        "Object Lock / immutable storage controls",
      ],
      operationalFit: [
        "Procurement and security review",
        "Retention and governance alignment",
        "Departmental or organization-wide rollout",
        "Higher-volume evidence operations",
      ],
      supportWindow:
        "Enterprise inquiries are typically reviewed within 4 business hours, depending on workflow clarity and commercial fit.",
      enterpriseFeatures: enterpriseCaps.enterpriseFeatures,
    },
    storageAddons: listStorageAddonDefinitions().map((item) => ({
      key: item.key,
      billingShape: item.billingShape,
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