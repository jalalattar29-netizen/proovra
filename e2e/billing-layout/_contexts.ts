/**
 * BILLING — every commercial context this product supports, rendered.
 *
 * WHAT THIS CLOSES
 * ---------------------------------------------------------------------------
 * `_fixtures.ts` models ONE account: a PERSONAL viewer on PRO, over their
 * evidence cap, with storage offers. It is the state in which the geometry the
 * layout gate measures is all on screen at once, and it stays exactly that.
 *
 * But it was also the ONLY rendered billing context in the repository. FREE,
 * pay-per-evidence, TEAM, an Enterprise organization, an Enterprise
 * organization mid-activation, and a member with no billing account at all had
 * no rendered coverage of any kind — including the one branch of the page that
 * suppresses every self-serve control.
 *
 * Each projection below is the shape the SERVER builds for that context, taken
 * from `buildPersonalProjection` and `buildOrganizationProjection`. No field is
 * invented for the UI: where the server omits something for a context (a price
 * on FREE, offers on a contract, seats on a single-occupant account), it is
 * omitted here too, because rendering a value the server never sends is how a
 * test comes to pass against a page nobody can reach.
 */

import type { Page } from "@playwright/test";

import { billingProjection, installBillingApi } from "./_fixtures";

export type BillingContext =
  | "free"
  | "pro"
  | "payg"
  | "team"
  | "enterprise-active"
  | "enterprise-pending-owner"
  | "enterprise-owner-invited"
  | "enterprise-suspended"
  | "enterprise-terminated"
  | "no-account";

type Json = Record<string, unknown>;

const PERSONAL_ACCOUNT = (capabilities: string[]): Json => ({
  type: "PERSONAL",
  id: "user-1",
  displayName: "Jamie Okonkwo",
  capabilities,
  billingOwnerMissing: false,
});

const FULL_PERSONAL = [
  "BILLING_ACCOUNT_VIEW",
  "BILLING_AMOUNT_VIEW",
  "BILLING_HISTORY_VIEW",
  "BILLING_MANAGE",
  "BILLING_CANCEL",
  "BILLING_ADDON_PURCHASE",
];

/** An Enterprise billing viewer: view, amounts, history. Never manage. */
const ORG_READONLY = [
  "BILLING_ACCOUNT_VIEW",
  "BILLING_AMOUNT_VIEW",
  "BILLING_HISTORY_VIEW",
];

const ORG_ACCOUNT: Json = {
  type: "ORGANIZATION",
  id: "org-1",
  displayName: "Meridian Legal",
  capabilities: ORG_READONLY,
  billingOwnerMissing: false,
};

const storageMeter = (usedLabel: string, limitLabel: string, percent: number): Json => ({
  state: "MEASURED",
  used: "16374572646",
  usedLabel,
  limit: "107374182400",
  limitLabel,
  baseLabel: limitLabel,
  recurringAddonBytes: "0",
  recurringAddonLabel: "0 B",
  legacyAddonBytes: "0",
  legacyAddonLabel: "0 B",
  usagePercent: percent,
  nearLimit: percent > 80,
  limitReached: false,
});

const NO_HISTORY: Json = { entries: [], hasMore: false };

/* ------------------------------------------------------------------ *
 * PERSONAL
 * ------------------------------------------------------------------ */

/** FREE: a real price of zero, an upgrade path, and no seats to speak of. */
function freeProjection(): Json {
  return {
    account: PERSONAL_ACCOUNT(FULL_PERSONAL),
    actionRequired: null,
    plan: {
      planKey: "FREE",
      accessKind: "FREE",
      displayName: "Free",
      model: "NONE",
      lifecycle: "ACTIVE",
      currency: "EUR",
      currentPeriodEndUtc: null,
      cancelAtPeriodEnd: false,
      billingOwnerMissing: false,
    },
    usage: {
      evidence: { state: "MEASURED", used: 2, limit: 3, window: "LIFETIME" },
      storage: storageMeter("240 MB", "1 GB", 24),
      // FREE does not include AI. The meter says so rather than showing 0 of 0.
      ai: { state: "NOT_INCLUDED" },
    },
    planOffers: [
      {
        planKey: "PRO",
        displayName: "Pro",
        priceCents: 1900,
        currency: "EUR",
        summary: "100 GB storage · unlimited records",
        action: "CHECKOUT",
        effect: "IMMEDIATE",
        actionLabel: "Subscribe to Pro",
        effectSummary:
          "You will be taken to your payment provider to subscribe to Pro.",
      },
    ],
    wallet: { availableCredits: 0, purchasedCredits: 0, consumedCredits: 0 },
    history: NO_HISTORY,
    // FREE cannot buy storage; the server says which tier unlocks it.
    // The server sends a finished SENTENCE here, not an enum: the card
    // renders `reason` verbatim, so a code would be printed to the customer.
    storageAddonsLocked: {
      reason: "Additional storage is available with Pro and Team.",
      unlockedByPlan: "PRO",
    },
    actions: {
      canStartCheckout: true,
      planManagement: { label: "Choose a plan", mode: "CHOOSE", enabled: true },
      canBuyEvidenceCredits: true,
      canBuyStorageAddon: false,
      canRequestCancellation: false,
      contactAccountManager: false,
      manageLabel: null,
    },
  };
}

/** PAY-PER-EVIDENCE: a credit wallet, and no subscription controls. */
function paygProjection(): Json {
  return {
    account: PERSONAL_ACCOUNT(FULL_PERSONAL),
    actionRequired: null,
    plan: {
      planKey: "PAYG",
      accessKind: "CREDIT",
      displayName: "Pay per evidence",
      model: "CREDIT",
      lifecycle: "ACTIVE",
      currency: "EUR",
      // A credit account has no billing cycle: there is nothing to renew.
      currentPeriodEndUtc: null,
      cancelAtPeriodEnd: false,
      billingOwnerMissing: false,
    },
    usage: {
      evidence: { state: "MEASURED", used: 41, limit: 3, window: "LIFETIME" },
      storage: storageMeter("3.1 GB", "10 GB", 31),
      ai: { state: "NOT_INCLUDED" },
    },
    planOffers: [],
    wallet: { availableCredits: 12, purchasedCredits: 50, consumedCredits: 38 },
    history: NO_HISTORY,
    actions: {
      canStartCheckout: true,
      planManagement: { label: "View access details", mode: "EXPLAIN", enabled: true },
      canBuyEvidenceCredits: true,
      canBuyStorageAddon: true,
      // Nothing recurring exists, so there is nothing to cancel.
      canRequestCancellation: false,
      contactAccountManager: false,
      manageLabel: null,
    },
  };
}

/** TEAM: the top self-serve tier — seats, and a real subscription. */
function teamProjection(): Json {
  return {
    account: PERSONAL_ACCOUNT(FULL_PERSONAL),
    actionRequired: null,
    plan: {
      planKey: "TEAM",
      accessKind: "SUBSCRIPTION",
      displayName: "Team",
      model: "MONTHLY",
      lifecycle: "ACTIVE",
      currency: "EUR",
      priceCents: 7900,
      currentPeriodEndUtc: "2026-12-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      billingOwnerMissing: false,
      paymentProviderLabel: "Card",
    },
    usage: {
      evidence: { state: "MEASURED", used: 812, limit: 5000, window: "ROLLING_30_DAYS" },
      storage: storageMeter("612 GB", "1 TB", 61),
      ai: { state: "MEASURED", used: 240, limit: 2000, window: "CALENDAR_MONTH" },
    },
    collaboration: { seats: { used: 7, limit: 25, pendingInvites: 2 } },
    planOffers: [],
    wallet: { availableCredits: 0, purchasedCredits: 0, consumedCredits: 0 },
    history: NO_HISTORY,
    actions: {
      canStartCheckout: true,
      planManagement: { label: "Manage plan", mode: "CHOOSE", enabled: true },
      canBuyEvidenceCredits: false,
      canBuyStorageAddon: true,
      canRequestCancellation: true,
      contactAccountManager: false,
      manageLabel: "Manage plan",
    },
  };
}

/* ------------------------------------------------------------------ *
 * ORGANIZATION — contract-managed
 * ------------------------------------------------------------------ */

/**
 * The per-state notice `contractStateNotice` builds. Every non-ACTIVE status
 * used to share one sentence; an agreement mid-activation, a suspended one and
 * an ENDED one are three different situations with three different next steps.
 */
const CONTRACT_NOTICE: Record<string, Json | null> = {
  ACTIVE: null,
  PENDING_ACTIVATION: {
    severity: "WARNING",
    title: "Activation in progress",
    messages: [
      "This organization's agreement is signed and waiting for activation to finish. Contracted allowances apply once it is active.",
    ],
    reassurance: null,
  },
  SUSPENDED: {
    severity: "CRITICAL",
    title: "Agreement suspended",
    messages: [
      "This organization's agreement is suspended. Contracted allowances do not apply while it is, and your account manager can explain why and what is needed to resume it.",
    ],
    reassurance: null,
  },
  TERMINATED: {
    severity: "CRITICAL",
    title: "Agreement ended",
    messages: [
      "This organization's agreement has ended. The terms below are the record of what it covered, not allowances that still apply. Your account manager can discuss a new agreement.",
    ],
    reassurance: null,
  },
};

function orgProjection(opts: {
  status: "ACTIVE" | "PENDING_ACTIVATION" | "SUSPENDED" | "TERMINATED";
  activationState: string | null;
}): Json {
  const contractActive = opts.status === "ACTIVE";
  return {
    account: ORG_ACCOUNT,
    // The server states WHICH inactive state, not merely that it is inactive.
    actionRequired: contractActive ? null : CONTRACT_NOTICE[opts.status],
    plan: {
      planKey: "ENTERPRISE",
      displayName: "Enterprise",
      model: "CONTRACT",
      accessKind: "CONTRACT",
      lifecycle: contractActive ? "ACTIVE" : "ACTION_REQUIRED",
      currentPeriodEndUtc: null,
      cancelAtPeriodEnd: false,
      billingOwnerMissing: false,
    },
    usage: {
      evidence: {
        state: "MEASURED",
        used: 1842,
        limit: 5000,
        window: "ROLLING_30_DAYS",
      },
      storage: storageMeter("384 GB", "1 TB", 37),
      // The agreement governs it without stating a number.
      ai: { state: "CONTRACT_MANAGED" },
    },
    collaboration: { seats: { used: 78, limit: 120, pendingInvites: 0 } },
    contract: {
      status: opts.status,
      activationState: opts.activationState,
      effectiveAtUtc: "2026-01-01T00:00:00.000Z",
      endsAtUtc: "2026-12-31T00:00:00.000Z",
      seatCount: 120,
      storageGb: 1024,
      region: "eu-central-1",
      derivedFromLegacyFallback: false,
    },
    history: NO_HISTORY,
    actions: {
      canStartCheckout: false,
      planManagement: {
        label: "View agreement",
        mode: "VIEW_AGREEMENT",
        enabled: true,
      },
      cancellationUnavailableReason: "NOT_AUTHORIZED",
      canBuyEvidenceCredits: false,
      canBuyStorageAddon: false,
      canRequestCancellation: false,
      contactAccountManager: true,
      manageLabel: null,
    },
  };
}

/* ------------------------------------------------------------------ */

export function projectionFor(context: BillingContext): Json | null {
  switch (context) {
    case "free":
      return freeProjection();
    case "pro":
      return billingProjection() as Json;
    case "payg":
      return paygProjection();
    case "team":
      return teamProjection();
    case "enterprise-active":
      return orgProjection({ status: "ACTIVE", activationState: "ACTIVATED" });
    case "enterprise-pending-owner":
      return orgProjection({
        status: "PENDING_ACTIVATION",
        activationState: "PENDING_OWNER",
      });
    case "enterprise-owner-invited":
      return orgProjection({
        status: "PENDING_ACTIVATION",
        activationState: "OWNER_INVITED",
      });
    case "enterprise-suspended":
      return orgProjection({ status: "SUSPENDED", activationState: "ACTIVATED" });
    case "enterprise-terminated":
      return orgProjection({ status: "TERMINATED", activationState: "ACTIVATED" });
    case "no-account":
      return null;
  }
}

function accountFor(context: BillingContext): Json | null {
  const projection = projectionFor(context);
  return projection ? (projection.account as Json) : null;
}

/**
 * Open `/billing` in one commercial context.
 *
 * Registered AFTER `installBillingApi`, because Playwright gives the LAST
 * registered route the win — an override installed first is shadowed by the
 * fixture's own broad handler.
 */
export async function openBillingAs(
  page: Page,
  context: BillingContext,
): Promise<void> {
  await installBillingApi(page);

  const account = accountFor(context);
  const projection = projectionFor(context);

  await page.route("**/v1/billing/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

    if (path.endsWith("/v1/billing/accounts")) {
      return route.fulfill(json({ accounts: account ? [account] : [] }));
    }
    if (path.includes("/history")) {
      return route.fulfill(json({ entries: [], hasMore: false }));
    }
    if (path.includes("/v1/billing/accounts/") && projection) {
      return route.fulfill(json(projection));
    }
    return route.fallback();
  });

  await page.goto("/billing");
  await page.waitForSelector("[data-billing-page]", { timeout: 30_000 });
}
