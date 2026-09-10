import * as prismaPkg from "@prisma/client";
import {
  EVIDENCE_CREDIT_PRODUCT,
  PLAN_CAPABILITIES,
  formatBytesHuman,
  resolveEvidenceOutputEntitlements,
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

/**
 * =============================================================================
 * P1-2 CLOSURE (2026-09-10) — THE TYPE PARAMETER IS THE GATE.
 * =============================================================================
 * This accepted `"PAYG"`, and `buildPricingCatalogResponse` used it to publish
 * `PLAN_CAPABILITIES.PAYG` as the Pay-per-evidence column. That row carries its
 * own instruction, in `packages/shared-billing/src/plan-catalog.ts`:
 *
 *     "GRANDFATHER-RESOLUTION ROW ONLY. NOT A SELLABLE PLAN. […] Nothing may
 *      advertise these values: Pricing and Billing render
 *      EVIDENCE_CREDIT_PRODUCT, never this row."
 *
 * The instruction was written and the projection was not changed to match, so
 * the public Pricing comparison table advertised 5 GB of storage and 50 AI
 * operations a month to Pay-per-evidence buyers. No write path assigns
 * `entitlements.plan = 'PAYG'`, so a real credit buyer holds FREE's 250 MB and
 * 10 operations. Two published entitlements that could not be obtained.
 *
 * Narrowing the parameter to the three SELLABLE subscription plans makes the
 * defect unrepresentable rather than merely fixed: `projectPublishedPlan("PAYG")`
 * is now a compile error, and the credit column is assembled from the credit
 * product plus the entitlements a buyer actually holds (see
 * `projectEvidenceCreditOffer`).
 */
function projectPublishedPlan<P extends "FREE" | "PRO" | "TEAM">(
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
    maxCollaborationTeamsPerWorkspace: caps.maxCollaborationTeamsPerWorkspace,
    maxAcceptedMembersPerCollaborationTeam:
      caps.maxAcceptedMembersPerCollaborationTeam,
    maxWorkspaceSeats: caps.maxWorkspaceSeats,
    enterpriseFeatures: caps.enterpriseFeatures,
  };
}

/**
 * THE PAY-PER-EVIDENCE COLUMN, BUILT FROM WHAT A BUYER ACTUALLY RECEIVES.
 *
 * P1-2 CLOSURE (2026-09-10). Three sources, and deliberately not a plan row:
 *
 *   EVIDENCE_CREDIT_PRODUCT   the price, the grant, and the fact credits do
 *                             not expire — the product being sold.
 *   PLAN_CAPABILITIES.FREE    the SUBSCRIPTION entitlements the buyer keeps,
 *                             because buying a credit does not change the
 *                             account's plan. This is the honest answer to
 *                             "how much storage do I get", and it is FREE's.
 *   the record-level grant    what one funded record earns, resolved through
 *                             the ONE authority (`resolveEvidenceOutputEntitlements`
 *                             with `funding: "EVIDENCE_CREDIT"`), never
 *                             restated as literals here.
 *
 * `plan: "FREE"` is stated explicitly and is the point of the whole shape:
 * there is no PAYG subscription tier, and a surface reading this object can
 * see that the underlying plan is FREE rather than inferring it.
 */
function projectEvidenceCreditOffer(currency: BillingCurrency) {
  const free = PLAN_CAPABILITIES.FREE;
  const perRecord = resolveEvidenceOutputEntitlements({
    plan: "FREE",
    funding: "EVIDENCE_CREDIT",
  });

  return {
    productKey: EVIDENCE_CREDIT_PRODUCT.productKey,
    displayName: EVIDENCE_CREDIT_PRODUCT.displayName,
    pricingModel: "PER_CREDIT" as const,
    unitPriceCents: getEvidenceCreditPriceCents(currency),
    creditsGrantedPerPurchase: EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase,
    creditsRequiredPerCompletion: EVIDENCE_CREDIT_PRODUCT.creditsPerCompletion,
    creditsExpire: EVIDENCE_CREDIT_PRODUCT.creditsExpire,

    /**
     * THE UNDERLYING SUBSCRIPTION. A credit buyer is a FREE account holding a
     * wallet; nothing about the plan changes when a credit is purchased.
     */
    plan: "FREE" as const,
    requiresSubscription: false,

    /**
     * What ONE credit-funded record earns. Per RECORD, never per account —
     * which is the whole design of the product and the reason a plan row
     * could never express it.
     */
    perFundedRecord: {
      reportIncluded: perRecord.reportsIncluded,
      verificationPackageIncluded: perRecord.verificationPackageIncluded,
      publicVerifyIncluded: perRecord.publicVerifyIncluded,
    },

    /**
     * The SUBSCRIPTION-level entitlements, which stay FREE's. Published so the
     * Pricing table renders the true numbers in this column instead of a
     * plan's that nobody is on.
     */
    storageBytes: free.includedStorageBytes.toString(),
    storageLabel: formatBytesHuman(free.includedStorageBytes),
    aiAdvisoryMonthlyOperations: free.aiAdvisoryMonthlyOperations,
    intakeIncluded: true,
    casesIncluded: free.casesIncluded,

    /**
     * PRODUCT OPTION B (2026-09-10) — an evidence-credit customer may buy
     * storage add-ons even though their subscription is FREE.
     *
     * Published as a fact about the OFFER, resolved from the same canonical
     * capability the server enforces, so the page states it rather than
     * inferring it from a plan name.
     */
    storageAddonsPurchasable: true,
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
    payg: projectEvidenceCreditOffer(currency),
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