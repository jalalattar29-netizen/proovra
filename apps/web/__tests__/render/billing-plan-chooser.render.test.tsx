/**
 * BILLING SURFACE CORRECTION — RENDER-LEVEL proof of the plan chooser, the
 * payment rows and the canonical primary action.
 *
 * WHAT THIS EXISTS TO STOP HAPPENING AGAIN
 * ---------------------------------------------------------------------------
 * On a FREE account the page offered "Subscribe to Pro" and "Subscribe to
 * Team". Both opened the same drawer; inside it, both tiers were inert `<div>`
 * boxes with nothing to click; and "Continue to payment" posted
 * `planOffers[0]?.planKey ?? "PRO"` — the first offer in the server's ladder,
 * which is PRO for every FREE account. A customer who pressed "Subscribe to
 * Team" and paid was subscribed to Pro.
 *
 * The three properties below are what make that unrepeatable, and each is
 * asserted against the rendered DOM and the actual request body rather than
 * against source text:
 *
 *   1. the button pressed decides the plan the drawer OPENS on
 *   2. the choice inside the drawer decides the plan that is CHECKED OUT
 *   3. one press produces at most one checkout
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { CheckoutDrawer } from "../../app/(app)/billing/_sections/CheckoutDrawer";
import { BillingHistorySection } from "../../app/(app)/billing/_sections/StorageAndHistory";
import { BillingOverview } from "../../app/(app)/billing/_sections/BillingOverview";
import type {
  BillingAccountProjection,
  BillingHistoryEntry,
  PlanOffer,
} from "../../lib/api/billing-accounts";

// ---------------------------------------------------------------------------
// A FREE personal account, offered both tiers — the exact state in question.
// ---------------------------------------------------------------------------

const OFFER_PRO: PlanOffer = {
  planKey: "PRO",
  displayName: "Pro",
  priceCents: 1900,
  currency: "EUR",
  summary: "100 lifetime evidence records, 50 GB of cumulative storage",
  action: "CHECKOUT",
  effect: "IMMEDIATE",
  actionLabel: "Subscribe to Pro",
  effectSummary: "Pro starts straight away.",
};

const OFFER_TEAM: PlanOffer = {
  planKey: "TEAM",
  displayName: "Team",
  priceCents: 4900,
  currency: "EUR",
  summary: "500 evidence records in any 30 days, 500 GB of cumulative storage",
  action: "CHECKOUT",
  effect: "IMMEDIATE",
  actionLabel: "Subscribe to Team",
  effectSummary: "Team starts straight away.",
};

function freeAccount(
  overrides: Partial<BillingAccountProjection> = {},
): BillingAccountProjection {
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
        "BILLING_CANCEL",
        "BILLING_ADDON_PURCHASE",
      ],
      billingOwnerMissing: false,
    },
    plan: {
      planKey: "FREE",
      accessKind: "FREE",
      displayName: "Free",
      model: "FREE",
      lifecycle: "INACTIVE",
      currency: "EUR",
      currentPeriodEndUtc: null,
      cancelAtPeriodEnd: false,
      billingOwnerMissing: false,
    },
    usage: {
      evidence: { state: "MEASURED", used: 1, limit: 3, window: "LIFETIME" },
      storage: { state: "UNAVAILABLE", reason: "Not measured in this fixture." },
      ai: { state: "NOT_INCLUDED" },
    },
    planOffers: [OFFER_PRO, OFFER_TEAM],
    actions: {
      canStartCheckout: true,
      // FREE has no subscription, so the ONE action is the chooser.
      planManagement: { label: "Choose a plan", mode: "CHOOSE", enabled: true },
      canBuyEvidenceCredits: true,
      canBuyStorageAddon: false,
      canRequestCancellation: false,
      contactAccountManager: false,
      manageLabel: null,
    },
    ...overrides,
  } as BillingAccountProjection;
}

const noop = () => {};

/**
 * The drawer's primary action.
 *
 * Found by its attribute rather than its words, because the words are now the
 * point of a separate assertion: the CTA says "Continue with Pro" or "Continue
 * with Team", so the one place a customer could catch a wrong selection says
 * which plan they are about to pay for.
 */
const continueButton = () =>
  document.querySelector<HTMLButtonElement>("[data-billing-checkout-continue]")!;

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ session: { url: "https://checkout.example/session" } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. The button that was pressed decides which plan the page asks for
// ===========================================================================

describe("the plan action on a FREE account", () => {
  it("is exactly ONE button, and it says Choose a plan", async () => {
    /*
     * What this replaces: two buttons, "Subscribe to Pro" and "Subscribe to
     * Team", side by side on the card — both opening the same drawer, which
     * then could not tell which had been pressed and checked out PRO either
     * way. One button now opens the chooser, and the choice is made inside it
     * where it can be seen and changed.
     */
    const user = userEvent.setup();
    let opened = 0;

    const { container } = render(
      <BillingOverview
        projection={freeAccount()}
        onManagePlan={() => {
          opened += 1;
        }}
        changeBusyPlan={null}
      />,
    );

    const actions = Array.from(
      container.querySelectorAll<HTMLElement>("[data-billing-plan-management]"),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]!.textContent).toBe("Choose a plan");
    expect(actions[0]!.getAttribute("data-billing-plan-management")).toBe("CHOOSE");

    // And the words that used to be there are gone from the card entirely.
    expect(container.textContent).not.toMatch(/Subscribe to (Pro|Team)/);

    await user.click(actions[0]!);
    expect(opened).toBe(1);
  });

  it("offers no enabled action to a viewer who may not manage billing", () => {
    const { container } = render(
      <BillingOverview
        projection={freeAccount({
          actions: {
            ...freeAccount().actions,
            planManagement: { label: "View plan", mode: "CHOOSE", enabled: false },
          },
        })}
        onManagePlan={noop}
        changeBusyPlan={null}
      />,
    );

    const action = container.querySelector<HTMLButtonElement>(
      "[data-billing-plan-management]",
    );
    expect(action).not.toBeNull();
    expect(action!.disabled).toBe(true);
  });
});

// ===========================================================================
// 2. The drawer opens on that plan, and the choice inside it is real
// ===========================================================================

describe("the checkout drawer", () => {
  const mountDrawer = (planKey: "PRO" | "TEAM") =>
    render(
      <CheckoutDrawer
        open
        intent={{ kind: "PLAN", planKey }}
        projection={freeAccount()}
        onClose={noop}
        onCompleted={noop}
        onError={noop}
      />,
    );

  it("opens with the pressed plan already selected", () => {
    mountDrawer("TEAM");
    const team = screen.getByRole("radio", { name: /Team/ });
    const pro = screen.getByRole("radio", { name: /Pro/ });
    expect((team as HTMLInputElement).checked).toBe(true);
    expect((pro as HTMLInputElement).checked).toBe(false);
  });

  it("offers the tiers as real radios in a labelled group", () => {
    const { container } = mountDrawer("PRO");
    // The tiers were `<div>`s. A screen reader had nothing to announce and a
    // keyboard had nothing to reach. (The drawer holds a second radiogroup for
    // the payment method, so this names the plan one rather than "the" one.)
    const group = container.querySelector("[data-billing-plan-choice]");
    expect(group).not.toBeNull();
    expect(group?.getAttribute("role")).toBe("radiogroup");
    expect(group?.getAttribute("aria-labelledby")).toBe("billing-plan-choice");
    expect(group?.querySelectorAll('input[type="radio"]')).toHaveLength(2);
  });

  it("checks out the plan the TEAM button opened it on", async () => {
    const user = userEvent.setup();
    mountDrawer("TEAM");

    await user.click(continueButton());

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const [path, init] = apiFetch.mock.calls[0] as [string, { body: string }];
    expect(path).toBe("/v1/billing/checkout/stripe");
    expect(JSON.parse(init.body)).toMatchObject({ plan: "TEAM" });
  });

  it("checks out the plan the PRO button opened it on", async () => {
    const user = userEvent.setup();
    mountDrawer("PRO");

    await user.click(continueButton());

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const [, init] = apiFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ plan: "PRO" });
  });

  it("checks out the plan the customer switched to inside the drawer", async () => {
    const user = userEvent.setup();
    mountDrawer("PRO");

    await user.click(screen.getByRole("radio", { name: /Team/ }));
    await user.click(continueButton());

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const [, init] = apiFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ plan: "TEAM" });
  });

  it("never sends a price, an amount or a provider id from the browser", async () => {
    const user = userEvent.setup();
    mountDrawer("TEAM");
    await user.click(continueButton());

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const [, init] = apiFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["currency", "plan"]);
  });

  it("one press produces one checkout", async () => {
    const user = userEvent.setup();
    // A request that never settles is what a slow provider looks like: the
    // button must be unusable for the whole of it.
    apiFetch.mockImplementation(() => new Promise(() => {}));
    mountDrawer("TEAM");

    const button = continueButton();
    await user.click(button);
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(true),
    );
    await user.click(button);
    await user.click(button);

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 3. Selection is not signalled by colour alone
// ===========================================================================

describe("the selected tier", () => {
  it("is legible to a screen reader and in monochrome", () => {
    render(
      <CheckoutDrawer
        open
        intent={{ kind: "PLAN", planKey: "TEAM" }}
        projection={freeAccount()}
        onClose={noop}
        onCompleted={noop}
        onError={noop}
      />,
    );

    const team = screen.getByRole("radio", { name: /Team/ }) as HTMLInputElement;
    // The radio itself carries the state — no colour required to read it.
    expect(team.checked).toBe(true);
    expect(team.getAttribute("name")).toBe("billing-plan");

    const option = team.closest("[data-billing-plan-option]");
    expect(option?.getAttribute("data-billing-plan-option")).toBe("TEAM");
    expect(option?.getAttribute("data-billing-plan-selected")).toBe("true");
  });
});

// ===========================================================================
// 4. A pending payment's own actions
// ===========================================================================

const pendingRow: BillingHistoryEntry = {
  id: "11111111-1111-4111-8111-111111111111",
  occurredAtUtc: "2026-03-04T10:00:00.000Z",
  description: "Evidence credit",
  status: "PENDING",
  amountCents: 500,
  currency: "USD",
  providerLabel: "Card",
  actions: { canRecheck: true, canCancel: true, canAbandon: false },
};

const settledRow: BillingHistoryEntry = {
  id: "22222222-2222-4222-8222-222222222222",
  occurredAtUtc: "2026-02-01T10:00:00.000Z",
  description: "Pro plan",
  status: "SUCCEEDED",
  amountCents: 1900,
  currency: "EUR",
  providerLabel: "PayPal",
  actions: { canRecheck: false, canCancel: false, canAbandon: false },
};

/**
 * A PayPal approval attempt from months ago.
 *
 * PayPal exposes no cancellation for an unapproved order, so the server offers
 * `canAbandon` in place of `canCancel` — the customer's own decision rather
 * than a claim about what PayPal did.
 */
const stalePayPalRow: BillingHistoryEntry = {
  id: "33333333-3333-4333-8333-333333333333",
  occurredAtUtc: "2026-03-11T10:00:00.000Z",
  description: "Pro plan",
  status: "PENDING",
  amountCents: 1900,
  currency: "EUR",
  providerLabel: "PayPal",
  actions: { canRecheck: true, canCancel: false, canAbandon: true },
};

function mountHistory(
  entries: BillingHistoryEntry[],
  over: {
    onRecheckPayment?: (e: BillingHistoryEntry) => void;
    onCancelPayment?: (e: BillingHistoryEntry) => void;
    onAbandonPayment?: (e: BillingHistoryEntry) => void;
    resumeUrls?: Record<string, string>;
  } = {},
) {
  return render(
    <BillingHistorySection
      entries={entries}
      state="READY"
      onRetry={noop}
      onRecheck={noop}
      recheckBusy={false}
      onRecheckPayment={over.onRecheckPayment ?? noop}
      onCancelPayment={over.onCancelPayment ?? noop}
      onAbandonPayment={over.onAbandonPayment ?? noop}
      rowBusyId={null}
      resumeUrls={over.resumeUrls ?? {}}
    />,
  );
}

describe("billing history rows", () => {
  it("says what was bought, not who the payer is", () => {
    const { container } = mountHistory([pendingRow, settledRow]);
    const text = container.textContent ?? "";
    // Every personal row used to read "Personal account", whatever it was for.
    expect(text).not.toMatch(/Personal account/);
    expect(text).toMatch(/Evidence credit/);
    expect(text).toMatch(/Pro plan/);
  });

  it("offers the server's actions on a pending row and none on a settled one", async () => {
    const user = userEvent.setup();
    const rechecked: string[] = [];
    const cancelled: string[] = [];
    mountHistory([pendingRow, settledRow], {
      onRecheckPayment: (e) => rechecked.push(e.id),
      onCancelPayment: (e) => cancelled.push(e.id),
    });

    expect(screen.getAllByRole("button", { name: "Re-check" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Cancel payment" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Re-check" }));
    await user.click(screen.getByRole("button", { name: "Cancel payment" }));

    expect(rechecked).toEqual([pendingRow.id]);
    expect(cancelled).toEqual([pendingRow.id]);
  });

  it("shows a resume link only once the provider has given one, and opens it safely", () => {
    const { container } = mountHistory([pendingRow], {
      resumeUrls: { [pendingRow.id]: "https://checkout.stripe.com/c/pay/live" },
    });

    const link = container.querySelector("[data-billing-payment-resume]");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");

    // And the row now says what it is actually waiting for.
    expect(container.textContent).toMatch(/Action needed/);
  });

  it("renders no resume link when the provider has not offered one", () => {
    const { container } = mountHistory([pendingRow]);
    expect(container.querySelector("[data-billing-payment-resume]")).toBeNull();
    expect(container.textContent).toMatch(/Pending/);
  });

  it("offers an honest abandon on a row the provider cannot be asked to stop", async () => {
    /*
     * THE defect this closes. A PayPal approval attempt from March sat at
     * "Pending" with one action — "Re-check" — that kept returning the same
     * answer, because PayPal has no operation that cancels an unapproved
     * order. The dishonest fix is a "Cancel payment" button claiming PayPal
     * stopped something; the honest one names whose decision it is.
     */
    const user = userEvent.setup();
    const abandoned: string[] = [];
    const { container } = mountHistory([stalePayPalRow], {
      onAbandonPayment: (e) => abandoned.push(e.id),
    });

    expect(screen.queryByRole("button", { name: "Cancel payment" })).toBeNull();
    const abandon = screen.getByRole("button", { name: "Abandon payment attempt" });
    expect(container.querySelector("[data-billing-payment-abandon]")).not.toBeNull();

    await user.click(abandon);
    expect(abandoned).toEqual([stalePayPalRow.id]);
  });

  it("never offers both stopping and abandoning on one row", () => {
    // A provider that can really be asked to stop should be asked. Offering
    // both would ask the customer to choose between a real cancellation and a
    // local note, which is not a choice anybody can make well.
    const { container } = mountHistory([pendingRow, stalePayPalRow]);
    for (const row of Array.from(
      container.querySelectorAll("[data-billing-history-row]"),
    )) {
      const hasCancel = row.querySelector("[data-billing-payment-cancel]");
      const hasAbandon = row.querySelector("[data-billing-payment-abandon]");
      expect(Boolean(hasCancel) && Boolean(hasAbandon)).toBe(false);
    }
  });

  it("is a real table with column headers, collapsible to cards", () => {
    const { container } = mountHistory([pendingRow, settledRow]);
    const table = container.querySelector("table.app-table");
    expect(table).not.toBeNull();
    // `data-responsive` is what makes the canonical table stack below 720px.
    expect(table?.hasAttribute("data-responsive")).toBe(true);
    // Every cell carries the label its stacked form shows.
    for (const cell of Array.from(container.querySelectorAll("tbody td"))) {
      expect(cell.hasAttribute("data-label")).toBe(true);
    }
  });
});

// ===========================================================================
// 5. The primary action is the canonical one
// ===========================================================================

describe("Billing's primary action", () => {
  it("is the shared Button, never a Billing-only gradient", () => {
    const { container } = render(
      <BillingOverview
        projection={freeAccount()}
        onManagePlan={noop}
        changeBusyPlan={null}
      />,
    );

    const offers = Array.from(
      container.querySelectorAll<HTMLElement>("[data-billing-plan-management]"),
    );
    expect(offers.length).toBe(1);

    for (const offer of offers) {
      // The deprecated coral gradient, in every form it was written in.
      const inline = offer.getAttribute("style") ?? "";
      expect(inline).not.toMatch(/linear-gradient/i);
      for (const dead of ["#e64880", "#ff6b6b", "#ff8a6a"]) {
        expect(inline.toLowerCase()).not.toContain(dead);
      }
      // It is the shared component, which resolves its colour from the token.
      expect(offer.tagName.toLowerCase()).toBe("button");
    }
  });
});
