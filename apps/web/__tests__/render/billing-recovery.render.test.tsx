/**
 * BILLING REMEDIATION (2026-10-30, AUD-16 to AUD-19) — what a customer can do
 * from inside a refused or unfinished purchase, and what they are told.
 *
 * WHAT THIS EXISTS TO STOP HAPPENING AGAIN
 * ---------------------------------------------------------------------------
 * The PayPal recovery panel was unreachable because a refresh unmounted the
 * drawer that held it. Refusal codes read "Please review your input". A refused
 * storage purchase had no way forward, an approved attempt read "waiting for your
 * approval", and a Stripe return was read by nothing at all.
 *
 * These are behaviour tests over the shipped page, drawers and request bodies.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: vi.fn() }));

let search = "";
const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => "/billing",
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context", () => {
  const stamp = () => 0;
  const isStale = () => false;
  return { useTenantGuard: () => ({ stamp, isStale }) };
});

import BillingPage from "../../app/(app)/billing/page";
import { CheckoutDrawer } from "../../app/(app)/billing/_sections/CheckoutDrawer";
import { ManagePlanDrawer } from "../../app/(app)/billing/_sections/ManagePlanDrawer";
import { StorageAddonsSection } from "../../app/(app)/billing/_sections/StorageAndHistory";
import {
  describeAttemptAbandon,
  describeAttemptRecheck,
  describeBillingError,
  describeReconciliation,
  describeResume,
  downgradeAddonNote,
} from "../../app/(app)/billing/_sections/billingMessages";
import { summarizeStorageAddons } from "../../app/(app)/billing/_sections/format";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import { ToastProvider } from "../../components/ui-legacy";
import type {
  ActiveStorageAddon,
  BillingAccountProjection,
  CheckoutAttemptResult,
  PlanOffer,
  ReconciliationResult,
} from "../../lib/api/billing-accounts";

const noop = () => {};

const refusal = (statusCode: number, code: string, details: Record<string, unknown> = {}, requestId = "req-123") =>
  Object.assign(new Error(code), { statusCode, code, details, requestId });

const OFFER_50 = {
  key: "PERSONAL_50_GB",
  label: "+50 GB",
  storageBytes: "53687091200",
  storageLabel: "50 GB",
  priceCents: 900,
  currency: "USD",
  billingCycle: "MONTHLY",
  checkoutAvailability: { stripe: true, paypal: true },
};
const OFFER_10 = {
  ...OFFER_50,
  key: "PERSONAL_10_GB",
  label: "+10 GB",
  storageLabel: "10 GB",
  priceCents: 300,
};

const CHECKOUT_PRO: PlanOffer = {
  planKey: "PRO",
  displayName: "Pro",
  priceCents: 1900,
  currency: "USD",
  summary: "100 lifetime evidence records",
  action: "CHECKOUT",
  effect: "IMMEDIATE",
  actionLabel: "Subscribe to Pro",
  effectSummary: "You will be taken to your payment provider to subscribe to Pro.",
};
const MOVE_TEAM: PlanOffer = {
  ...CHECKOUT_PRO,
  planKey: "TEAM",
  displayName: "Team",
  action: "UPGRADE",
  actionLabel: "Move to Team",
  effectSummary: "More capacity for evidence, storage and collaboration.",
};
const MOVE_PRO: PlanOffer = {
  ...CHECKOUT_PRO,
  action: "DOWNGRADE",
  effect: "AT_PERIOD_END",
  actionLabel: "Move to Pro",
  effectSummary: "Lower limits than you have now.",
};

function addon(over: Partial<ActiveStorageAddon> = {}): ActiveStorageAddon {
  return {
    id: "addon-1",
    addonKey: "PERSONAL_50_GB",
    label: "+50 GB",
    storageLabel: "50 GB",
    status: "ACTIVE",
    billingCycle: "MONTHLY",
    legacyOneTime: false,
    endsWithPlan: false,
    canCancel: true,
    canRecheck: false,
    canAbandon: false,
    attemptReference: "a",
    paymentProvider: "PAYPAL",
    providerReference: null,
    createdAtUtc: "2026-10-01T00:00:00.000Z",
    activatedAtUtc: "2026-10-01T00:00:00.000Z",
    currentPeriodEndUtc: "2026-11-01T00:00:00.000Z",
    priceCents: 900,
    currency: "USD",
    ...over,
  };
}

function free(over: Partial<BillingAccountProjection> = {}): BillingAccountProjection {
  return {
    account: {
      type: "PERSONAL",
      id: "user-1",
      displayName: "Jamie Okonkwo",
      capabilities: ["BILLING_ACCOUNT_VIEW", "BILLING_AMOUNT_VIEW", "BILLING_HISTORY_VIEW", "BILLING_MANAGE"],
      billingOwnerMissing: false,
    },
    plan: {
      planKey: "FREE",
      accessKind: "FREE",
      displayName: "Free",
      model: "FREE",
      lifecycle: "INACTIVE",
      currency: "USD",
      currentPeriodEndUtc: null,
      cancelAtPeriodEnd: false,
      billingOwnerMissing: false,
    },
    usage: {
      evidence: { state: "MEASURED", used: 0, limit: 3, window: "LIFETIME" },
      storage: {
        state: "MEASURED",
        usedBytes: "0",
        usedLabel: "0 B",
        limitBytes: "53950000000",
        limitLabel: "50.25 GB",
        baseBytes: "262144000",
        baseLabel: "250 MB",
        recurringAddonBytes: "0",
        recurringAddonLabel: "0 B",
        legacyAddonBytes: "0",
        legacyAddonLabel: "0 B",
        usagePercent: 0,
        nearLimit: false,
        limitReached: false,
      },
      ai: { state: "NOT_INCLUDED" },
    },
    planOffers: [CHECKOUT_PRO],
    actionRequired: null,
    storageAddons: { offers: [OFFER_10, OFFER_50], active: [] },
    actions: {
      canStartCheckout: true,
      planManagement: { label: "Choose a plan", mode: "CHOOSE", enabled: true },
      canBuyEvidenceCredits: false,
      canBuyStorageAddon: true,
      canRequestCancellation: false,
      contactAccountManager: false,
      manageLabel: null,
    },
    ...over,
  } as unknown as BillingAccountProjection;
}

function paid(
  planKey: "PRO" | "TEAM",
  offers: PlanOffer[],
  over: Partial<BillingAccountProjection> = {},
): BillingAccountProjection {
  const base = free();
  return {
    ...base,
    plan: {
      ...base.plan,
      planKey,
      accessKind: "SUBSCRIPTION",
      displayName: planKey === "PRO" ? "Pro" : "Team",
      model: "MONTHLY",
      lifecycle: "ACTIVE",
      priceCents: 1900,
      currentPeriodEndUtc: "2026-12-01T00:00:00.000Z",
      paymentProviderLabel: "Card",
    },
    planOffers: offers,
    actions: {
      ...base.actions,
      planManagement: { label: "Manage plan", mode: "MANAGE", enabled: true },
      canRequestCancellation: true,
    },
    ...over,
  } as unknown as BillingAccountProjection;
}

const attemptResult = (over: Partial<CheckoutAttemptResult>): CheckoutAttemptResult => ({
  attemptId: "attempt-1",
  product: "STORAGE",
  createdAtUtc: "2026-10-29T00:00:00.000Z",
  provider: "PAYPAL",
  providerBound: true,
  previousStatus: "PENDING",
  currentStatus: "PENDING",
  outcome: "STILL_PENDING",
  locallyAbandoned: false,
  ...over,
});

const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const continueButton = () => q<HTMLButtonElement>("[data-billing-checkout-continue]")!;

beforeEach(() => {
  apiFetch.mockReset();
  router.replace.mockReset();
  search = "";
});

// ---------------------------------------------------------------------------
// The whole page, over a routed API
// ---------------------------------------------------------------------------

type Routes = {
  projection: () => BillingAccountProjection | Promise<BillingAccountProjection>;
  history?: () => unknown;
  post?: (path: string, body: unknown) => unknown;
};

function serve(routes: Routes) {
  apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      return routes.post?.(path, init.body ? JSON.parse(init.body) : undefined);
    }
    if (path === "/v1/billing/accounts") {
      const { account } = await routes.projection();
      return { accounts: [account] };
    }
    if (path.endsWith("/history")) return routes.history?.() ?? { items: [], activity: [] };
    if (path.startsWith("/v1/billing/accounts/")) return routes.projection();
    throw new Error(`Unrouted ${path}`);
  });
}

const projectionReads = () =>
  apiFetch.mock.calls.filter(
    ([path, init]) =>
      !init &&
      String(path).startsWith("/v1/billing/accounts/") &&
      !String(path).endsWith("/history"),
  ).length;

const mountPage = async () => {
  const view = render(
    <ToastProvider>
      <ConfirmActionProvider>
        <BillingPage />
      </ConfirmActionProvider>
    </ToastProvider>,
  );
  await waitFor(() => expect(q("[data-billing-layout]")).not.toBeNull());
  return view;
};

async function refusedPayPalPlanCheckout(user: ReturnType<typeof userEvent.setup>) {
  await user.click(q("[data-billing-plan-management]")!);
  await user.click(within(q("[data-billing-plan-option='PRO']")!).getByRole("radio"));
  await user.click(within(q("[data-billing-provider-option='PAYPAL']")!).getByRole("radio"));
  await user.click(continueButton());
}

describe("AUD-16: the PayPal recovery panel survives the refresh", () => {
  it("keeps the drawer and the panel mounted while Billing re-reads the account", async () => {
    const user = userEvent.setup();
    let release: (p: BillingAccountProjection) => void = noop;
    let hold = false;
    serve({
      projection: () =>
        hold ? new Promise<BillingAccountProjection>((resolve) => (release = resolve)) : free(),
      post: (path) => {
        if (path === "/v1/billing/checkout/paypal") {
          hold = true;
          throw refusal(409, "PAYPAL_APPROVAL_PENDING", { plan: "PRO", retry: "RESOLVE_PENDING_CHECKOUT" });
        }
        return { outcome: "STILL_PENDING", warning: "PayPal shows that checkout as approved and being processed." };
      },
    });
    await mountPage();
    const reads = projectionReads();

    await refusedPayPalPlanCheckout(user);

    // The refresh the refusal triggered is still in flight.
    await waitFor(() => expect(projectionReads()).toBe(reads + 1));
    const panel = await screen.findByRole("button", { name: "Re-check pending approval" });
    expect(q("[data-testid='billing-checkout-drawer'], [data-billing-paypal-pending-resolution]")).not.toBeNull();

    await act(async () => release(free()));
    expect(q("[data-billing-paypal-pending-resolution]")).not.toBeNull();

    // And it is usable, which is the point of keeping it.
    await user.click(panel);
    await waitFor(() =>
      expect(apiFetch.mock.calls.some(([path]) => path === "/v1/billing/checkout/paypal/pending/resolve")).toBe(true),
    );
    expect(await screen.findByText(/approved and being processed/)).toBeTruthy();
  });

  it("tells the customer what the refusal means, and gives the support reference", async () => {
    const user = userEvent.setup();
    serve({
      projection: free,
      post: () => {
        throw refusal(409, "PAYPAL_DIFFERENT_PLAN_PENDING", { pendingPlan: "PRO", retry: "RESOLVE_PENDING_CHECKOUT" });
      },
    });
    await mountPage();
    await refusedPayPalPlanCheckout(user);

    expect(await screen.findByText(/different plan is already open/)).toBeTruthy();
    expect(screen.queryByText(/review your input/i)).toBeNull();
    expect(document.body.textContent).toContain("req-123");
    expect(document.body.textContent).not.toContain("PAYPAL_DIFFERENT_PLAN_PENDING");
  });

  it("a failed re-read leaves the open drawer where it is", async () => {
    const user = userEvent.setup();
    let failing = false;
    serve({
      projection: () => {
        if (failing) throw refusal(503, "UPSTREAM");
        return free();
      },
      post: () => {
        failing = true;
        throw refusal(409, "PAYPAL_APPROVAL_PENDING", { plan: "PRO" });
      },
    });
    await mountPage();
    await refusedPayPalPlanCheckout(user);

    expect(await screen.findByText(/could not refresh Billing/)).toBeTruthy();
    expect(q("[data-billing-paypal-pending-resolution]")).not.toBeNull();
    expect(q("[data-billing-error]")).toBeNull();
  });
});

describe("a provider that gave no answer", () => {
  it("never says nothing changed about a plan change", async () => {
    const user = userEvent.setup();
    serve({
      projection: () => paid("PRO", [MOVE_TEAM]),
      post: () => {
        throw refusal(502, "PLAN_CHANGE_OUTCOME_UNKNOWN");
      },
    });
    await mountPage();
    await user.click(q("[data-billing-plan-management]")!);
    await user.click(q("[data-billing-manage-offer='TEAM']")!);
    const dialog = await screen.findByRole("dialog", { name: /Move to Team\?/ });
    await user.click(within(dialog).getByRole("button", { name: "Move to Team" }));

    const toast = await screen.findByText(/cannot say yet whether this plan change went through/);
    expect(toast.textContent).toMatch(/Check Billing in a few minutes before trying again/);
    expect(document.body.textContent).not.toMatch(/has not changed|nothing changed|nothing has changed/i);
  });

  it("does not follow an approval link that is not PayPal's own page", async () => {
    const user = userEvent.setup();
    serve({
      projection: () => paid("PRO", [MOVE_TEAM]),
      post: () => ({ outcome: "UPGRADE", plan: "TEAM", approvalUrl: "https://paypal.com.evil.example/approve" }),
    });
    await mountPage();
    await user.click(q("[data-billing-plan-management]")!);
    await user.click(q("[data-billing-manage-offer='TEAM']")!);
    const dialog = await screen.findByRole("dialog", { name: /Move to Team\?/ });
    await user.click(within(dialog).getByRole("button", { name: "Move to Team" }));

    expect(await screen.findByText(/could not open PayPal's approval page/)).toBeTruthy();
    expect(window.location.href).not.toContain("evil");
  });
});

describe("AUD-19: the Stripe return", () => {
  it("says the customer is back, claims no settlement, and clears the URL", async () => {
    const user = userEvent.setup();
    search = "success=1&kind=storage-addon";
    serve({ projection: free });
    await mountPage();

    const notice = await waitFor(() => q("[data-billing-return-notice]")!);
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toMatch(/Waiting for Stripe to confirm/);
    expect(notice.textContent).toMatch(/only after Stripe confirms/);
    expect(notice.textContent).not.toMatch(/thank you|payment received|is active|was charged/i);
    expect(router.replace).toHaveBeenCalledWith("/billing", { scroll: false });

    await user.click(q("[data-billing-return-dismiss]")!);
    expect(q("[data-billing-return-notice]")).toBeNull();
  });

  it("a canceled return makes no claim about money", async () => {
    search = "canceled=1";
    serve({ projection: free });
    await mountPage();
    const notice = await waitFor(() => q("[data-billing-return-notice]")!);
    expect(notice.textContent).toMatch(/left Stripe checkout before finishing/);
    expect(notice.textContent).not.toMatch(/charged/i);
  });
});

describe("AUD-18: an approved attempt in Billing activity", () => {
  const row = {
    id: "attempt-1",
    product: "STORAGE",
    description: "+50 GB storage add-on",
    providerLabel: "PayPal",
    createdAtUtc: "2026-10-29T00:00:00.000Z",
    state: "AWAITING_APPROVAL",
    statusLabel: "Waiting for approval",
    explanation: "Waiting for you to approve it at PayPal. Nothing is charged until you do.",
    recurring: true,
    lastCheckedAtUtc: null,
    actions: { canRecheck: true, canAbandon: true },
  };

  it("reads as activating after the check, and no longer offers Abandon", async () => {
    const user = userEvent.setup();
    serve({
      projection: free,
      history: () => ({ items: [], activity: [row] }),
      post: () => attemptResult({ waitingFor: "ACTIVATION" }),
    });
    await mountPage();
    await screen.findByText("Waiting for approval");
    expect(q("[data-billing-activity-abandon]")).not.toBeNull();

    await user.click(q("[data-billing-activity-recheck]")!);

    await waitFor(() => expect(q("[data-billing-activity-status]")!.textContent).toBe("Activating"));
    expect(q("[data-billing-activity-explanation]")!.textContent).toMatch(/You approved this at PayPal/);
    expect(q("[data-billing-activity-explanation]")!.textContent).not.toMatch(/waiting for you/i);
    expect(q("[data-billing-activity-abandon]")).toBeNull();
  });
});

describe("a managed identity's personal account", () => {
  const managed = () =>
    paid("PRO", [], {
      account: {
        type: "PERSONAL",
        id: "user-1",
        displayName: "Jamie Okonkwo",
        capabilities: ["BILLING_ACCOUNT_VIEW", "BILLING_AMOUNT_VIEW", "BILLING_HISTORY_VIEW", "BILLING_CANCEL"],
        billingOwnerMissing: false,
      },
      planOffers: undefined,
      storageAddons: { offers: [], active: [] },
      actions: {
        canStartCheckout: false,
        planManagement: { label: "View plan", mode: "MANAGE", enabled: false },
        canBuyEvidenceCredits: false,
        canBuyStorageAddon: false,
        canRequestCancellation: true,
        contactAccountManager: false,
        manageLabel: null,
      },
    });

  it("can reach Cancel, and is offered nothing to buy or change", async () => {
    const user = userEvent.setup();
    serve({ projection: managed });
    await mountPage();
    expect(q("[data-billing-manage-storage]")).toBeNull();

    await user.click(q("[data-billing-plan-management]")!);

    expect(q("[data-billing-manage-cancel]")).not.toBeNull();
    expect(q("[data-billing-manage-offer]")).toBeNull();
    // The server refuses both of these without BILLING_MANAGE.
    expect(q("[data-billing-recheck]")).toBeNull();
  });

  it("is not offered a restart the server would refuse", async () => {
    const user = userEvent.setup();
    serve({
      projection: () => {
        const base = managed();
        return { ...base, plan: { ...base.plan, cancelAtPeriodEnd: true } };
      },
    });
    await mountPage();
    await user.click(q("[data-billing-plan-management]")!);
    expect(q("[data-billing-manage-cancelling]")).not.toBeNull();
    expect(q("[data-billing-manage-resume]")).toBeNull();
  });

  it("still cannot act on an account with nothing to cancel", async () => {
    serve({
      projection: () => ({
        ...managed(),
        actions: { ...managed().actions, canRequestCancellation: false },
      }),
    });
    await mountPage();
    expect(q<HTMLButtonElement>("[data-billing-plan-management]")!.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The storage drawer
// ---------------------------------------------------------------------------

function mountStorage(projection = free()) {
  const onCompleted = vi.fn();
  const onError = vi.fn();
  render(
    <CheckoutDrawer
      open
      intent={{ kind: "STORAGE", addonKey: "PERSONAL_50_GB" }}
      projection={projection}
      onClose={noop}
      onCompleted={onCompleted}
      onError={onError}
    />,
  );
  return { onCompleted, onError };
}

const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as { body: string }).body));

describe("AUD-18: a storage purchase the server refused", () => {
  const pending = {
    addonKey: "PERSONAL_50_GB",
    activeCount: 0,
    pendingProvider: "PAYPAL",
    attemptId: "attempt-1",
    createdAtUtc: "2026-10-29T00:00:00.000Z",
    retry: "RECONCILE_STORAGE_ATTEMPT",
  };

  async function refused(details: Record<string, unknown> = pending, code = "STORAGE_PURCHASE_PENDING") {
    const user = userEvent.setup();
    apiFetch.mockRejectedValueOnce(refusal(409, code, details));
    const handles = mountStorage();
    await user.click(continueButton());
    await waitFor(() => expect(q("[data-billing-storage-recovery]")).not.toBeNull());
    return { user, ...handles };
  }

  it("offers Check status and Abandon in place, and stops a second purchase", async () => {
    const { onError } = await refused();
    expect(onError).not.toHaveBeenCalled();
    expect(q("[data-billing-storage-recovery]")!.textContent).toMatch(/already open with PayPal/);
    expect(q("[data-billing-storage-recovery]")!.textContent).not.toMatch(/waiting for your approval/i);
    expect(q("[data-billing-storage-recovery-check]")).not.toBeNull();
    expect(q("[data-billing-storage-recovery-abandon]")).not.toBeNull();
    expect(q("[data-billing-storage-recovery-resume]")).toBeNull();
    expect(continueButton().disabled).toBe(true);
    expect(document.activeElement).toBe(q("[data-billing-storage-recovery]"));
  });

  it("the attempt id PayPal's own gate names works the same way", async () => {
    const { user } = await refused(
      { attemptId: "attempt-1", addonKey: "PERSONAL_50_GB", createdAtUtc: pending.createdAtUtc, providerBound: true, retry: "RECONCILE_STORAGE_ATTEMPT" },
      "PAYPAL_STORAGE_APPROVAL_PENDING",
    );
    apiFetch.mockResolvedValueOnce(attemptResult({ waitingFor: "APPROVAL" }));
    await user.click(q("[data-billing-storage-recovery-check]")!);
    await waitFor(() =>
      expect(q("[data-billing-storage-recovery-notice]")!.textContent).toMatch(/still shows this waiting for your approval/),
    );
    expect(apiFetch.mock.calls.at(-1)![0]).toBe(
      "/v1/billing/accounts/PERSONAL/user-1/checkout-attempts/attempt-1/recheck",
    );
  });

  it("offers Continue at PayPal only when the check returned PayPal's own link", async () => {
    const { user } = await refused();
    apiFetch.mockResolvedValueOnce(
      attemptResult({ waitingFor: "APPROVAL", resumeUrl: "https://www.paypal.com/webapps/billing/subscriptions?ba_token=BA-1" }),
    );
    await user.click(q("[data-billing-storage-recovery-check]")!);
    const link = await waitFor(() => q<HTMLAnchorElement>("[data-billing-storage-recovery-resume]")!);
    expect(link.textContent).toBe("Continue at PayPal");
    expect(link.getAttribute("href")).toContain("www.paypal.com");

    apiFetch.mockResolvedValueOnce(attemptResult({ waitingFor: "APPROVAL", resumeUrl: "https://evil.example/approve" }));
    await user.click(q("[data-billing-storage-recovery-check]")!);
    await waitFor(() => expect(q("[data-billing-storage-recovery-resume]")).toBeNull());
  });

  it("an approved attempt says so, and stops offering Abandon", async () => {
    const { user } = await refused();
    apiFetch.mockResolvedValueOnce(attemptResult({ waitingFor: "ACTIVATION" }));
    await user.click(q("[data-billing-storage-recovery-check]")!);
    await waitFor(() =>
      expect(q("[data-billing-storage-recovery-notice]")!.textContent).toMatch(/You approved this at PayPal/),
    );
    expect(q("[data-billing-storage-recovery-notice]")!.textContent).not.toMatch(/waiting for your approval/i);
    expect(q("[data-billing-storage-recovery-abandon]")).toBeNull();
    expect(continueButton().disabled).toBe(true);
  });

  it("a finished attempt frees the purchase, and reports what happened", async () => {
    const { user, onCompleted } = await refused();
    apiFetch.mockResolvedValueOnce(attemptResult({ outcome: "UPDATED", currentStatus: "FAILED" }));
    await user.click(q("[data-billing-storage-recovery-check]")!);
    await waitFor(() =>
      expect(q("[data-billing-storage-recovery-notice]")!.textContent).toMatch(/failed, so nothing was added/),
    );
    expect(q("[data-billing-storage-recovery-check]")).toBeNull();
    expect(continueButton().disabled).toBe(false);
    expect(onCompleted).toHaveBeenCalled();
  });

  it("abandons in two steps, with the server's own warning between them", async () => {
    const { user } = await refused();
    apiFetch.mockResolvedValueOnce({
      attemptId: "attempt-1",
      outcome: "ABANDON_CONFIRMATION_REQUIRED",
      warning: "Abandoning does not cancel anything at PayPal.",
      cancelsAtProvider: false,
    });
    await user.click(q("[data-billing-storage-recovery-abandon]")!);
    await screen.findByText("Abandoning does not cancel anything at PayPal.");
    expect(bodyOf(apiFetch.mock.calls.at(-1)!)).toEqual({ confirmed: false });

    // Keeping it asks nothing further.
    await user.click(q("[data-billing-storage-abandon-keep]")!);
    expect(q("[data-billing-storage-abandon-confirm]")).toBeNull();

    apiFetch.mockResolvedValueOnce({
      attemptId: "attempt-1",
      outcome: "ABANDON_CONFIRMATION_REQUIRED",
      warning: "Abandoning does not cancel anything at PayPal.",
      cancelsAtProvider: false,
    });
    await user.click(q("[data-billing-storage-recovery-abandon]")!);
    apiFetch.mockResolvedValueOnce({ attemptId: "attempt-1", outcome: "ABANDONED", cancelsAtProvider: false });
    await user.click(await waitFor(() => q("[data-billing-storage-abandon-confirmed]")!));

    await waitFor(() =>
      expect(q("[data-billing-storage-recovery-notice]")!.textContent).toMatch(/did not cancel anything at the payment provider/),
    );
    expect(bodyOf(apiFetch.mock.calls.at(-1)!)).toEqual({ confirmed: true });
    expect(q("[data-billing-storage-recovery-notice]")!.textContent).not.toMatch(/nothing was (cancelled or )?charged/i);
    expect(continueButton().disabled).toBe(false);
  });

  it("a failed check shows the support reference inside the panel", async () => {
    const { user } = await refused();
    apiFetch.mockRejectedValueOnce(refusal(429, "RATE_LIMIT_EXCEEDED"));
    await user.click(q("[data-billing-storage-recovery-check]")!);
    await waitFor(() =>
      expect(q("[data-billing-storage-recovery-notice]")!.textContent).toMatch(/tried several times/),
    );
    expect(within(q("[data-billing-storage-recovery]")!).getByText("req-123")).toBeTruthy();
  });

  it("choosing another size or method drops a refusal that no longer applies", async () => {
    const { user } = await refused();
    await user.click(within(q("[data-billing-addon-option='PERSONAL_10_GB']")!).getByRole("radio"));
    expect(q("[data-billing-storage-recovery]")).toBeNull();
    expect(continueButton().disabled).toBe(false);
  });
});

describe("stacking: another recurring charge for a size already held", () => {
  const holding = () =>
    free({
      storageAddons: {
        offers: [OFFER_10, OFFER_50],
        active: [
          addon({ id: "a1" }),
          addon({ id: "a2" }),
          addon({ id: "a3", addonKey: "PERSONAL_10_GB", storageLabel: "10 GB", priceCents: 300 }),
          addon({ id: "p1", status: "PENDING", activatedAtUtc: null }),
        ],
      },
    } as Partial<BillingAccountProjection>);

  it("shows capacity, each size, what is unfinished and the monthly total", () => {
    mountStorage(holding());
    const held = q("[data-billing-storage-holdings]")!;
    expect(q("[data-billing-storage-capacity]")!.textContent).toBe("50.25 GB");
    expect(q("[data-billing-storage-holding='PERSONAL_50_GB']")!.textContent).toMatch(/50 GB × 2/);
    expect(q("[data-billing-storage-holding='PERSONAL_50_GB']")!.textContent).toMatch(/1 not completed/);
    expect(q("[data-billing-storage-holding='PERSONAL_50_GB']")!.textContent).toMatch(/\$18\.00/);
    expect(held.querySelector("[data-billing-storage-commitment]")!.textContent).toMatch(/\$21\.00.*month/);
  });

  it("warns as soon as a held size is selected, before anything is pressed", () => {
    mountStorage(holding());
    const warning = q("[data-billing-storage-stack-warning]")!;
    expect(warning.parentElement!.getAttribute("role")).toBe("status");
    expect(warning.textContent).toMatch(/already pay for 2 of this size/);
    expect(warning.textContent).toMatch(/another recurring charge of \$9\.00 per month/);
    expect(warning.textContent).toMatch(/A purchase of this size has not completed yet/);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("a size the account does not hold carries no warning", async () => {
    const user = userEvent.setup();
    mountStorage(free());
    await user.click(within(q("[data-billing-addon-option='PERSONAL_10_GB']")!).getByRole("radio"));
    expect(q("[data-billing-storage-stack-warning]")).toBeNull();
    expect(q("[data-billing-storage-holdings]")).toBeNull();
  });

  it("buys again only on the deliberate second press, which the server can see", async () => {
    const user = userEvent.setup();
    apiFetch.mockRejectedValueOnce(
      refusal(409, "STORAGE_ADDON_ALREADY_HELD", { addonKey: "PERSONAL_50_GB", activeCount: 2, retry: "CONFIRM_ADDITIONAL" }),
    );
    const { onError } = mountStorage(holding());
    await user.click(continueButton());

    const prompt = await waitFor(() => q("[data-billing-storage-additional]")!);
    expect(onError).not.toHaveBeenCalled();
    expect(prompt.textContent).toMatch(/already have 2 of this size/);
    expect(prompt.textContent).toMatch(/separate recurring charge of \$9\.00 per month/);
    expect(bodyOf(apiFetch.mock.calls[0]!).confirmAdditional).toBeUndefined();
    expect(continueButton().disabled).toBe(true);

    apiFetch.mockResolvedValueOnce({ outcome: "NO_CHANGE" });
    await user.click(q("[data-billing-storage-confirm-additional]")!);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch.mock.calls[1]![0]).toBe("/v1/billing/storage-addons/checkout/stripe");
    expect(bodyOf(apiFetch.mock.calls[1]!)).toMatchObject({ addonKey: "PERSONAL_50_GB", confirmAdditional: true });
  });

  it("Not now sends nothing", async () => {
    const user = userEvent.setup();
    apiFetch.mockRejectedValueOnce(
      refusal(409, "STORAGE_ADDON_ALREADY_HELD", { activeCount: 1, retry: "CONFIRM_ADDITIONAL" }),
    );
    mountStorage(holding());
    await user.click(continueButton());
    await waitFor(() => expect(q("[data-billing-storage-additional]")).not.toBeNull());
    await user.click(q("[data-billing-storage-decline-additional]")!);
    expect(q("[data-billing-storage-additional]")).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("does not add up amounts a viewer may not see", () => {
    const summary = summarizeStorageAddons([addon({ priceCents: undefined }), addon({ id: "a2" })]);
    expect(summary.monthlyTotals).toBeNull();
    expect(summary.skus[0]).toMatchObject({ activeCount: 2, monthlyCents: null });
  });

  it("a grandfathered purchase is capacity, never a recurring charge", () => {
    const summary = summarizeStorageAddons([addon({ legacyOneTime: true }), addon({ id: "a2" })]);
    expect(summary.skus[0]!.activeCount).toBe(2);
    expect(summary.monthlyTotals).toHaveLength(1);
    expect(summary.monthlyTotals![0]).toContain("9.00");
  });

  it("the Storage card states the monthly total and names what is unfinished", () => {
    render(
      <StorageAddonsSection
        projection={holding()}
        onManageStorage={noop}
        onChoosePlan={noop}
        onCancelAddon={noop}
        cancelBusyId={null}
      />,
    );
    expect(q("[data-billing-storage-commitment]")!.textContent).toMatch(/\$21\.00/);
    expect(q("[data-billing-storage-open-attempts]")!.textContent).toMatch(/1 storage purchase \(50 GB\)/);
  });
});

describe("offer availability", () => {
  const withOffer = (availability: { stripe: boolean; paypal: boolean }) =>
    free({
      storageAddons: { offers: [OFFER_10, { ...OFFER_50, checkoutAvailability: availability }], active: [] },
    } as Partial<BillingAccountProjection>);

  it("moves to the provider that can sell the size, and says why", async () => {
    const user = userEvent.setup();
    apiFetch.mockResolvedValue({ outcome: "NO_CHANGE" });
    mountStorage(withOffer({ stripe: false, paypal: true }));

    const card = within(q("[data-billing-provider-option='STRIPE']")!).getByRole<HTMLInputElement>("radio");
    const paypal = within(q("[data-billing-provider-option='PAYPAL']")!).getByRole<HTMLInputElement>("radio");
    expect(card.disabled).toBe(true);
    expect(paypal.checked).toBe(true);
    expect(q("[data-billing-provider-note]")!.textContent).toBe(
      "Card payment is not available for this size right now. You can pay with PayPal.",
    );
    expect(q("[data-billing-addon-availability='PERSONAL_50_GB']")!.textContent).toBe("PayPal only right now");

    await user.click(continueButton());
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(apiFetch.mock.calls[0]![0]).toBe("/v1/billing/storage-addons/checkout/paypal");
  });

  it("returns to the customer's own choice on a size both providers sell", async () => {
    const user = userEvent.setup();
    mountStorage(withOffer({ stripe: false, paypal: true }));
    await user.click(within(q("[data-billing-addon-option='PERSONAL_10_GB']")!).getByRole("radio"));
    expect(within(q("[data-billing-provider-option='STRIPE']")!).getByRole<HTMLInputElement>("radio").checked).toBe(true);
    expect(q("[data-billing-provider-note]")).toBeNull();
  });

  it("shows but will not sell a size no provider can, and keeps the others", () => {
    mountStorage(withOffer({ stripe: false, paypal: false }));
    expect(q("[data-billing-addon-option='PERSONAL_50_GB']")).not.toBeNull();
    expect(q("[data-billing-addon-option='PERSONAL_10_GB']")).not.toBeNull();
    expect(q("[data-billing-addon-availability='PERSONAL_50_GB']")!.textContent).toBe("Not available to buy right now");
    expect(within(q("[data-billing-addon-option='PERSONAL_50_GB']")!).getByRole<HTMLInputElement>("radio").disabled).toBe(true);
    expect(continueButton().disabled).toBe(true);
    expect(q("[data-billing-provider-note]")!.textContent).toMatch(/cannot be bought right now/);
  });

  it("an API that omits the field leaves both providers on offer", () => {
    const { checkoutAvailability: _dropped, ...older } = OFFER_50;
    mountStorage(free({ storageAddons: { offers: [older], active: [] } } as unknown as Partial<BillingAccountProjection>));
    expect(within(q("[data-billing-provider-option='STRIPE']")!).getByRole<HTMLInputElement>("radio").disabled).toBe(false);
    expect(q("[data-billing-provider-note]")).toBeNull();
  });
});

describe("the plan drawer and what add-ons do", () => {
  const team = (active: ActiveStorageAddon[]) =>
    paid("TEAM", [MOVE_PRO], {
      storageAddons: { offers: [], active },
    } as Partial<BillingAccountProjection>);
  const teamAddon = addon({ addonKey: "TEAM_100_GB", storageLabel: "100 GB", endsWithPlan: true });

  it("says a Team-size add-on stops renewing after moving to Pro, and when", () => {
    render(
      <ManagePlanDrawer
        open
        projection={team([teamAddon, addon({ id: "kept" })])}
        onClose={noop}
        onChangePlan={noop}
        onCancel={noop}
        changeBusyPlan={null}
        cancelBusy={false}
      />,
    );
    const note = q("[data-billing-manage-addon-note='PRO']")!;
    expect(note.textContent).toMatch(/Pro does not include your Team-size storage add-on \(100 GB\)/);
    expect(note.textContent).toMatch(/stays until its paid date and then stops renewing/);
    expect(note.textContent).not.toMatch(/50 GB/);
  });

  it("says nothing when there is no such add-on, or the move is not down from Team", () => {
    expect(downgradeAddonNote(team([addon()]), MOVE_PRO)).toBeNull();
    expect(downgradeAddonNote(paid("PRO", [MOVE_TEAM], { storageAddons: { offers: [], active: [teamAddon] } } as Partial<BillingAccountProjection>), MOVE_TEAM)).toBeNull();
  });

  it("after Resume, says which add-ons still end when the count identifies them", () => {
    const notice = describeResume(
      { result: "RESUMED", provider: "STRIPE", currentPeriodEnd: null, dependentAddonsStillEnding: 1 },
      team([teamAddon]),
    );
    expect(notice.message).toBe(
      "Subscription restarted. 1 storage add-on (100 GB) set to end will still end. Add storage again if you want to keep that capacity.",
    );
    expect(notice.tone).toBe("info");
  });

  it("after Resume, gives only the count when it cannot tell which", () => {
    const notice = describeResume(
      { result: "RESUMED", provider: "STRIPE", currentPeriodEnd: null, dependentAddonsStillEnding: 1 },
      team([teamAddon, addon({ id: "b", addonKey: "TEAM_1_TB", storageLabel: "1 TB", endsWithPlan: true })]),
    );
    expect(notice.message).toContain("1 storage add-on set to end will still end");
    expect(notice.message).not.toMatch(/100 GB|1 TB/);
  });

  it("a clean Resume is the only success", () => {
    const clean = { result: "RESUMED", provider: "STRIPE", currentPeriodEnd: null, dependentAddonsStillEnding: 0 } as const;
    expect(describeResume(clean, team([])).tone).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// The sentences
// ---------------------------------------------------------------------------

describe("AUD-17: every refusal says what it means", () => {
  const FALLBACK = { message: "We could not start checkout." };
  const CODES: Array<[string, number, RegExp]> = [
    ["PAYPAL_APPROVAL_PENDING", 409, /checkout for this plan is already open/],
    ["PAYPAL_DIFFERENT_PLAN_PENDING", 409, /different plan is already open/],
    ["PLAN_CHECKOUT_ALREADY_OPEN", 409, /already open/],
    ["CHECKOUT_IN_PROGRESS", 409, /already starting/],
    ["STORAGE_ADDON_ALREADY_HELD", 409, /already pay for/],
    ["STORAGE_PURCHASE_PENDING", 409, /other payment method/],
    ["PAYPAL_STORAGE_APPROVAL_PENDING", 409, /already open/],
    ["STORAGE_ADDON_PREREQUISITE_ENDING", 409, /Restart your plan first/],
    ["STORAGE_ADDON_NOT_OFFERED", 400, /not available on your current plan/],
    ["CHECKOUT_TARGET_NOT_SUPPORTED", 400, /Personal Workspace/],
    ["RATE_LIMIT_EXCEEDED", 429, /several times/],
  ];

  it.each(CODES)("%s", (code, status, sentence) => {
    const notice = describeBillingError(refusal(status, code), FALLBACK);
    expect(notice.message).toMatch(sentence);
    expect(notice.message).not.toMatch(/review your input/i);
    expect(notice.message).not.toContain(code);
    expect(notice.supportReference).toBe("req-123");
  });

  it("a PRO buyer is not told they are already on the plan they are buying", () => {
    const notice = describeBillingError(refusal(409, "SUBSCRIPTION_ALREADY_ACTIVE", { requestedPlan: "TEAM" }), FALLBACK);
    expect(notice.message).toMatch(/Use Manage plan to change it/);
    expect(notice.message).not.toMatch(/already on this plan/);
  });

  it.each(["PLAN_CHANGE_OUTCOME_UNKNOWN", "PROVIDER_CANCELLATION_OUTCOME_UNKNOWN"])(
    "%s tells the customer to check before retrying, and never that nothing changed",
    (code) => {
      const notice = describeBillingError(refusal(502, code), FALLBACK);
      expect(notice.message).toMatch(/Check Billing in a few minutes before trying again/);
      expect(notice.message).not.toMatch(/nothing (has )?changed/i);
    },
  );

  it("a lost answer to an action that may have landed is not called nothing", () => {
    const fallback = { message: "We could not confirm this. Check Billing.", unknownOutcome: true };
    expect(describeBillingError(Object.assign(new TypeError("fetch failed"), { code: "NETWORK_ERROR" }), fallback).message).toBe(fallback.message);
    expect(describeBillingError(refusal(500, "INTERNAL_ERROR"), fallback).message).toBe(fallback.message);
  });

  it("a 409 with no copy of its own is the account's state, not bad input", () => {
    const notice = describeBillingError(refusal(409, "SOMETHING_NEW"), FALLBACK);
    expect(notice.message).toMatch(/already in progress/);
    expect(notice.message).not.toMatch(/review your input/i);
  });

  it("a code worded by the server by case uses the server's sentence, and only ever that", () => {
    const worded = Object.assign(refusal(409, "PLAN_CHANGE_NOT_AVAILABLE"), {
      message: "We do not yet have a renewal date for your subscription. Please try again shortly.",
    });
    expect(describeBillingError(worded, FALLBACK).message).toBe(worded.message);
    const synthetic = Object.assign(refusal(409, "PLAN_CHANGE_NOT_AVAILABLE"), { message: "HTTP 409: API error" });
    expect(describeBillingError(synthetic, FALLBACK).message).toMatch(/not available right now/);
  });
});

describe("AUD-19: claims the server cannot back", () => {
  const summary = (attempts: CheckoutAttemptResult[], attemptsUpdated = 0): ReconciliationResult => ({
    outcome: "UPDATED",
    checked: true,
    summary: {
      checked: attempts.length,
      creditsRestored: 0,
      paymentsRecorded: 0,
      subscriptionsUpdated: 0,
      pending: 0,
      actionRequired: 0,
      unavailable: 0,
      discrepancies: 0,
      attemptsUpdated,
      attempts,
    },
  });

  it("the account re-check does not say nothing was charged", () => {
    const message = describeReconciliation(summary([attemptResult({ outcome: "NO_CHANGE" })])).message;
    expect(message).not.toMatch(/Nothing was charged/);
  });

  it("a local 24-hour close is not reported as the provider's answer", () => {
    const closed = attemptResult({ outcome: "UPDATED", currentStatus: "ABANDONED" });
    const notice = describeReconciliation(summary([closed], 1));
    expect(notice.message).not.toMatch(/updated from what the provider confirmed/);
    expect(notice.message).toMatch(/PROOVRA closed it here\. PayPal did not confirm this/);

    const single = describeAttemptRecheck(closed);
    expect(single.message).not.toMatch(/provider confirmed/i);
    expect(single.message).toMatch(/PayPal did not confirm this/);
  });

  it("a real provider update beside a local close is still counted as one", () => {
    const notice = describeReconciliation(
      summary(
        [
          attemptResult({ outcome: "UPDATED", currentStatus: "ABANDONED" }),
          attemptResult({ outcome: "UPDATED", currentStatus: "ACTIVE", attemptId: "attempt-2" }),
        ],
        2,
      ),
    );
    expect(notice.message).toMatch(/1 record was updated from what the provider confirmed/);
  });

  it("each answer to Check status is its own sentence", () => {
    const say = (over: Partial<CheckoutAttemptResult>) => describeAttemptRecheck(attemptResult(over)).message;
    const answers = [
      say({ waitingFor: "APPROVAL" }),
      say({ waitingFor: "ACTIVATION" }),
      say({ outcome: "UPDATED", currentStatus: "ACTIVE" }),
      say({ outcome: "UPDATED", currentStatus: "FAILED" }),
      say({ outcome: "PROVIDER_UNAVAILABLE" }),
    ];
    expect(new Set(answers).size).toBe(answers.length);
    expect(say({ waitingFor: "ACTIVATION" })).not.toMatch(/waiting for your approval/i);
  });

  it("abandoning locally says what PROOVRA did, and speaks for no provider", () => {
    const message = describeAttemptAbandon({ attemptId: "a", outcome: "ABANDONED", cancelsAtProvider: false }).message;
    expect(message).toMatch(/did not cancel anything at the payment provider/);
    expect(message).not.toMatch(/charged/i);
  });
});
