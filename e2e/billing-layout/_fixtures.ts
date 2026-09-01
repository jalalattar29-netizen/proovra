/**
 * Billing layout gate — fixtures.
 *
 * Same contract as the other `*-layout` projects here: the API is intercepted
 * and only the web tier is real. What this project measures — whether the two
 * allowance cards land their actions on one baseline, whether a status column
 * is words or capsules, and what colour a purchase button actually paints — are
 * cascade and geometry facts. None of them lives in a database, and the render
 * tests run in jsdom, which applies no stylesheet and reports no layout.
 *
 * The projection below is the shape `GET /v1/billing/accounts` returns, modelled
 * on a PRO account that is over its evidence cap and has storage offers, because
 * that is the state in which every surface this project checks is on screen at
 * once.
 */

import type { Page } from "@playwright/test";

import { envelopeFor } from "../attention-layout/_fixtures";

/** The billing route gate needs the billing capabilities, and only those. */
function billingEnvelope(): Record<string, unknown> {
  const base = envelopeFor("team-admin") as Record<string, unknown>;
  return {
    ...base,
    capabilities: {
      ...(base.capabilities as Record<string, boolean>),
      // The route gate itself (routeRegistry `account.billing`).
      ACCOUNT_BILLING_VIEW: true,
      BILLING_ACCOUNT_VIEW: true,
      BILLING_AMOUNT_VIEW: true,
      BILLING_HISTORY_VIEW: true,
      BILLING_MANAGE: true,
    },
  };
}

const PLAN_OFFER_TEAM = {
  planKey: "TEAM",
  displayName: "Team",
  priceCents: 7900,
  currency: "EUR",
  summary: "Unlimited seats · 1 TB storage",
  action: "CHECKOUT",
  effect: "IMMEDIATE",
  actionLabel: "Subscribe to Team",
  effectSummary: "You will be taken to your payment provider to subscribe to Team.",
};

export function billingProjection(): Record<string, any> {
  return {
    account: {
      type: "PERSONAL",
      id: "user-1",
      displayName: "Jamie Okonkwo",
      capabilities: [
        "BILLING_ACCOUNT_VIEW",
        "BILLING_AMOUNT_VIEW",
        "BILLING_HISTORY_VIEW",
        "BILLING_MANAGE",
      ],
      billingOwnerMissing: false,
    },
    plan: {
      planKey: "PRO",
      accessKind: "GRANT",
      displayName: "Pro",
      model: "MONTHLY",
      lifecycle: "ACTIVE",
      currency: "EUR",
      priceCents: 1900,
      currentPeriodEndUtc: "2026-12-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      billingOwnerMissing: false,
      paymentProviderLabel: "Card",
    },
    usage: {
      evidence: { state: "MEASURED", used: 176, limit: 127, window: "LIFETIME" },
      storage: {
        state: "MEASURED",
        used: "16374572646",
        usedLabel: "15.25 GB",
        limit: "107374182400",
        limitLabel: "100 GB",
        baseLabel: "100 GB",
        recurringAddonBytes: "0",
        recurringAddonLabel: "0 B",
        legacyAddonBytes: "0",
        legacyAddonLabel: "0 B",
        usagePercent: 15,
        nearLimit: false,
        limitReached: false,
      },
      ai: { state: "NOT_INCLUDED" },
    },
    // A PERSONAL account reports its collaboration-team allowance, which is
    // what `PlanCapabilitiesCard` renders. Without it the card returns null and
    // its row measured zero wide, so the width this project is here to check
    // could not be observed at all.
    collaboration: { collaborationTeams: { used: 1, limit: 3 } },
    planOffers: [PLAN_OFFER_TEAM],
    wallet: {
      availableCredits: 0,
      purchasedCredits: 0,
      consumedCredits: 0,
      hasLedgerHistory: false,
      creditsPerPurchase: 1,
      unitPriceCents: 500,
      currency: "EUR",
    },
    evidenceAdmission: {
      recordsHeld: 176,
      planIncludedLifetime: 100,
      effectiveLifetimeCap: 127,
      capSource: "AGREEMENT",
      overCap: true,
      planCapacityRemaining: 0,
      creditsAvailable: 0,
      next: { allowed: false, funding: "CREDITS" },
    },
    storageAddons: {
      active: [],
      offers: [
        {
          sku: "STORAGE_100GB",
          label: "100 GB",
          priceCents: 900,
          currency: "EUR",
          bytes: "107374182400",
        },
      ],
    },
    history: {
      entries: [
        {
          id: "pay-1",
          kind: "SUBSCRIPTION",
          description: "Pro — monthly",
          occurredAtUtc: "2026-08-01T09:15:00.000Z",
          amountCents: 200,
          currency: "EUR",
          status: "ABANDONED",
          providerLabel: "Card",
          resumeUrl: null,
        },
        {
          id: "pay-2",
          kind: "SUBSCRIPTION",
          description: "Pro — monthly",
          occurredAtUtc: "2026-07-01T09:15:00.000Z",
          amountCents: 200,
          currency: "USD",
          status: "PENDING",
          providerLabel: "Card",
          resumeUrl: null,
        },
        {
          id: "pay-3",
          kind: "CREDITS",
          description: "Evidence credits",
          occurredAtUtc: "2026-06-01T09:15:00.000Z",
          amountCents: 500,
          currency: "EUR",
          status: "SUCCEEDED",
          providerLabel: "Card",
          resumeUrl: null,
        },
        {
          id: "pay-4",
          kind: "CREDITS",
          description: "Evidence credits",
          occurredAtUtc: "2026-05-01T09:15:00.000Z",
          amountCents: 500,
          currency: "EUR",
          status: "FAILED",
          providerLabel: "Card",
          resumeUrl: null,
        },
      ],
      hasMore: false,
    },
    actions: {
      canStartCheckout: true,
      planManagement: { label: "View access details", mode: "EXPLAIN", enabled: true },
      secondaryPlanAction: { planKey: "TEAM", label: "Start Team subscription" },
      canBuyEvidenceCredits: true,
      canBuyStorageAddon: true,
      canRequestCancellation: false,
      contactAccountManager: false,
      manageLabel: null,
    },
  };
}

export async function installBillingApi(page: Page): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  // Production-host seal, registered FIRST so the specific handlers below take
  // precedence: the bundle inlines NEXT_PUBLIC_API_BASE and it defaults to
  // production, so a probe without `/v1/` in it would otherwise leave here.
  await page.route("**/api.proovra.com/**", (route) =>
    route.fulfill(
      json({
        status: "HEALTHY",
        ranAtUtc: "2026-01-01T00:00:00.000Z",
        subsystems: [],
        incidents: [],
        escalations: [],
        items: [],
        data: null,
      }),
    ),
  );

  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/v1/platform/context")) {
      return route.fulfill(json(billingEnvelope()));
    }
    if (path.endsWith("/v1/billing/accounts")) {
      return route.fulfill(
        json({
          accounts: [
            {
              type: "PERSONAL",
              id: "user-1",
              displayName: "Jamie Okonkwo",
              capabilities: [
                "BILLING_ACCOUNT_VIEW",
                "BILLING_AMOUNT_VIEW",
                "BILLING_HISTORY_VIEW",
                "BILLING_MANAGE",
              ],
              billingOwnerMissing: false,
            },
          ],
        }),
      );
    }
    if (path.endsWith("/history")) {
      return route.fulfill(json({ items: billingProjection().history.entries }));
    }
    if (path.includes("/v1/billing/accounts/")) {
      return route.fulfill(json(billingProjection()));
    }
    if (path.endsWith("/v1/me/inbox/summary")) {
      return route.fulfill(json({ unread: 0, critical: 0, high: 0, total: 0, items: [] }));
    }
    return route.fulfill(
      json({
        items: [],
        data: null,
        entries: [],
        offers: [],
        active: [],
        subsystems: [],
        incidents: [],
        escalations: [],
      }),
    );
  });

  await page.route("**/auth/**", (route) =>
    route.fulfill(
      json({ user: { id: "user-1", email: "operator@example.invalid" } }),
    ),
  );
}

export async function openBilling(page: Page): Promise<void> {
  await installBillingApi(page);
  await page.goto("/billing");
  await page.waitForSelector("[data-billing-layout]", { timeout: 30_000 });
}

export const WIDTHS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "tablet-1024", width: 1024, height: 900 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "mobile-390", width: 390, height: 844 },
] as const;
