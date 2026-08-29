/**
 * BILLING PLAN SELECTION — the FREE checkout, the drawer hierarchy, the merged
 * Evidence card and the FREE storage destination.
 *
 * WHAT THIS EXISTS TO STOP HAPPENING AGAIN
 * ---------------------------------------------------------------------------
 * A FREE customer was shown "Upgrade to Pro — your provider charges the
 * difference for the rest of this period", offered an "End subscription" for a
 * subscription that did not exist, and — on pressing the action — told "You
 * will move to Pro at the end of this billing period" without ever seeing a
 * payment method. Beside that, the page carried the credit balance twice under
 * two headings with the purchase attached to the second one, and a Storage card
 * whose "Choose a plan" button did not say that a plan is what it opens.
 *
 * These are behaviour tests over the shipped components and the real request
 * bodies, not a scan of source text.
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
import { ManagePlanDrawer } from "../../app/(app)/billing/_sections/ManagePlanDrawer";
import {
  BillingOverview,
  EvidenceDetailCard,
} from "../../app/(app)/billing/_sections/BillingOverview";
import { StorageAddonsSection } from "../../app/(app)/billing/_sections/StorageAndHistory";
import type {
  BillingAccountProjection,
  PlanOffer,
} from "../../lib/api/billing-accounts";

const noop = () => {};

const CHECKOUT_PRO: PlanOffer = {
  planKey: "PRO",
  displayName: "Pro",
  priceCents: 1900,
  currency: "USD",
  summary: "100 lifetime evidence records · 100 GB storage · 100 AI operations/month",
  action: "CHECKOUT",
  effect: "IMMEDIATE",
  actionLabel: "Subscribe to Pro",
  effectSummary: "You will be taken to your payment provider to subscribe to Pro.",
};

const CHECKOUT_TEAM: PlanOffer = {
  ...CHECKOUT_PRO,
  planKey: "TEAM",
  displayName: "Team",
  priceCents: 7900,
  summary: "500 evidence records per 30 days · 500 GB storage · 500 AI operations/month",
  actionLabel: "Subscribe to Team",
  effectSummary: "You will be taken to your payment provider to subscribe to Team.",
};

const MOVE_TEAM: PlanOffer = {
  ...CHECKOUT_TEAM,
  action: "UPGRADE",
  effect: "IMMEDIATE",
  actionLabel: "Move to Team",
  effectSummary: "More capacity for evidence, storage and collaboration.",
};

const MOVE_PRO: PlanOffer = {
  ...CHECKOUT_PRO,
  action: "DOWNGRADE",
  effect: "AT_PERIOD_END",
  actionLabel: "Move to Pro",
  effectSummary: "Lower limits than you have now. Nothing you have recorded is deleted.",
};

function free(over: Partial<BillingAccountProjection> = {}): BillingAccountProjection {
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
        used: "0",
        usedLabel: "0 B",
        limit: "262144000",
        limitLabel: "250 MB",
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
    planOffers: [CHECKOUT_PRO, CHECKOUT_TEAM],
    wallet: {
      availableCredits: 0,
      purchasedCredits: 0,
      consumedCredits: 0,
      hasLedgerHistory: false,
      creditsPerPurchase: 1,
      unitPriceCents: 500,
      currency: "USD",
    },
    evidenceAdmission: {
      recordsHeld: 0,
      planIncludedLifetime: 3,
      effectiveLifetimeCap: 3,
      capSource: "PLAN",
      overCap: false,
      planCapacityRemaining: 3,
      creditsAvailable: 0,
      next: { allowed: true, funding: "PLAN" },
    },
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
      priceCents: planKey === "PRO" ? 1900 : 7900,
      currentPeriodEndUtc: "2026-12-01T00:00:00.000Z",
      paymentProviderLabel: "Card",
    },
    planOffers: offers,
    storageAddonsLocked: undefined,
    actions: {
      ...base.actions,
      planManagement: { label: "Manage plan", mode: "MANAGE", enabled: true },
      canBuyStorageAddon: true,
      canRequestCancellation: true,
    },
    ...over,
  } as unknown as BillingAccountProjection;
}

const continueButton = () =>
  document.querySelector<HTMLButtonElement>("[data-billing-checkout-continue]")!;

const mountChooser = (projection = free()) =>
  render(
    <CheckoutDrawer
      open
      intent={{ kind: "PLAN" }}
      projection={projection}
      onClose={noop}
      onCompleted={noop}
      onError={noop}
    />,
  );

const mountManage = (projection: BillingAccountProjection) =>
  render(
    <ManagePlanDrawer
      open
      projection={projection}
      onClose={noop}
      onChangePlan={noop}
      onCancel={noop}
      changeBusyPlan={null}
      cancelBusy={false}
    />,
  );

beforeEach(() => {
  document.documentElement.dir = "ltr";
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ session: { url: "https://checkout.example/s" } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. FREE is a PURCHASE, and nothing in it belongs to a subscription
// ===========================================================================

describe("the FREE plan chooser", () => {
  it("says none of the words that belong to an existing subscription", () => {
    const { container } = mountChooser();
    const text = container.textContent ?? "";

    // Every one of these was on the FREE drawer, and every one is false there.
    expect(text).not.toMatch(/End subscription/i);
    expect(text).not.toMatch(/Cancel subscription/i);
    expect(text).not.toMatch(/end of (this|your) billing period/i);
    expect(text).not.toMatch(/charges the difference/i);
    expect(text).not.toMatch(/prorat/i);
    expect(text).not.toMatch(/remaining period/i);
    expect(text).not.toMatch(/\bUpgrade\b/);
  });

  it("has no cancellation control at all", () => {
    const { container } = mountChooser();
    expect(container.querySelector("[data-billing-manage-cancel]")).toBeNull();
  });

  it("asks for a payment method BEFORE anything can be committed", () => {
    mountChooser();
    /*
     * BILLING UI REFINEMENT (2026-09-01) — the options are named by their
     * ACCESSIBLE name, which is no longer the visible text.
     *
     * The visible content is a brand mark; the name is a real label that says
     * what the option IS. "Credit or debit card" rather than "Visa or
     * Mastercard", because the marks beside it are the two most recognisable
     * and not a claim about which networks the provider accepts.
     */
    expect(screen.getByRole("radio", { name: "Credit or debit card" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "PayPal" })).toBeTruthy();
  });

  it("does NOT expand a summary panel when a tier is selected", async () => {
    /*
     * BILLING UI REFINEMENT (2026-09-01) — this asserted the panel EXISTED.
     *
     * It restated the selected plan, the cadence, the total and a cancellation
     * sentence directly under the card that already showed all of it, so
     * choosing a tier made the drawer grow by a block that told the customer
     * nothing new — and on a phone it pushed the payment selector and the
     * button below the fold.
     */
    const user = userEvent.setup();
    const { container } = mountChooser();

    await user.click(screen.getByRole("radio", { name: /Pro/ }));

    expect(container.querySelector("[data-billing-plan-summary]")).toBeNull();
    // And none of what it said reappeared somewhere else.
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/Selected plan/i);
    expect(text).not.toMatch(/\bTotal\b/);
  });

  it("keeps the selected plan unmistakable, and states its price once", async () => {
    const user = userEvent.setup();
    const { container } = mountChooser();

    await user.click(screen.getByRole("radio", { name: /Pro/ }));

    const option = container.querySelector('[data-billing-plan-option="PRO"]')!;
    expect(option.getAttribute("data-billing-plan-selected")).toBe("true");
    // The card carries the whole decision: name, what it includes, and cost.
    expect(option.textContent).toMatch(/Pro/);
    expect(option.textContent).toMatch(/100 lifetime evidence records/);
    expect(option.querySelector('[data-billing-plan-price="PRO"]')!.textContent).toMatch(
      /19/,
    );

    // The chosen price appears exactly ONCE in the drawer's plan content.
    const prices = (container.textContent ?? "").match(/\$19\.00/g) ?? [];
    expect(prices).toHaveLength(1);

    // And the payment selector and the CTA are both still reachable.
    expect(container.querySelector("[data-billing-payment-choice]")).not.toBeNull();
    expect(continueButton()).not.toBeNull();
  });

  it("states the recurring nature ONCE for the section, not per tier", async () => {
    const { container } = mountChooser();
    const terms = container.querySelectorAll("[data-billing-plan-terms]");
    expect(terms).toHaveLength(1);
    expect(terms[0]!.textContent).toMatch(/billed monthly/i);
  });

  it("names the PLAN it is about to buy", async () => {
    // The summary that used to restate the selection is gone, so the button is
    // once more the last place a wrong tier can be caught — and the tier is
    // the thing that would be wrong.
    const user = userEvent.setup();
    mountChooser();

    await user.click(screen.getByRole("radio", { name: /Pro/ }));
    expect(continueButton().textContent).toBe("Continue with Pro");

    await user.click(screen.getByRole("radio", { name: /Team/ }));
    expect(continueButton().textContent).toBe("Continue with Team");
  });

  it("cannot continue until a plan is chosen", () => {
    mountChooser();
    expect(continueButton().disabled).toBe(true);
  });
});

// ===========================================================================
// 2. Continue goes to the NEW-SUBSCRIPTION checkout, never to plan-change
// ===========================================================================

describe("the FREE checkout request", () => {
  for (const [providerLabel, path] of [
    ["Credit or debit card", "/v1/billing/checkout/stripe"],
    ["PayPal", "/v1/billing/checkout/paypal"],
  ] as const) {
    for (const plan of ["PRO", "TEAM"] as const) {
      it(`sends ${plan} to ${path} when ${providerLabel} is selected`, async () => {
        const user = userEvent.setup();
        mountChooser();

        await user.click(
          screen.getByRole("radio", { name: plan === "PRO" ? /Pro/ : /Team/ }),
        );
        await user.click(screen.getByRole("radio", { name: providerLabel }));
        await user.click(continueButton());

        await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
        const [called, init] = apiFetch.mock.calls[0] as [string, { body: string }];

        // The CHECKOUT authority, never the paid plan-transition route.
        expect(called).toBe(path);
        expect(called).not.toBe("/v1/billing/subscription/plan");
        // The selection survives the press, in both directions.
        expect(JSON.parse(init.body)).toMatchObject({ plan, currency: "USD" });
      });
    }
  }

  it("carries nothing a browser could be wrong about", async () => {
    const user = userEvent.setup();
    mountChooser();
    await user.click(screen.getByRole("radio", { name: /Team/ }));
    await user.click(continueButton());

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const [, init] = apiFetch.mock.calls[0] as [string, { body: string }];
    // No price, no provider price/plan id, no amount.
    expect(Object.keys(JSON.parse(init.body)).sort()).toEqual(["currency", "plan"]);
  });

  it("hands the customer to the provider's own page and nowhere else", async () => {
    const user = userEvent.setup();
    apiFetch.mockResolvedValue({
      subscription: { links: [{ rel: "approve", href: "https://paypal.example/approve" }] },
    });

    const assigned: string[] = [];
    const original = Object.getOwnPropertyDescriptor(window, "location");
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        set href(value: string) {
          assigned.push(value);
        },
        get href() {
          return "http://localhost/billing";
        },
      },
    });

    try {
      mountChooser();
      await user.click(screen.getByRole("radio", { name: /Pro/ }));
      await user.click(screen.getByRole("radio", { name: "PayPal" }));
      await user.click(continueButton());
      await waitFor(() => expect(assigned).toEqual(["https://paypal.example/approve"]));
    } finally {
      if (original) Object.defineProperty(window, "location", original);
    }
  });
});

// ===========================================================================
// 2b. ONE payment selector, for every purchase Billing makes
// ===========================================================================

describe("the payment-method selector", () => {
  const INTENTS = [
    { kind: "PLAN" as const, label: "subscription" },
    { kind: "CREDITS" as const, label: "evidence credits" },
    { kind: "STORAGE" as const, label: "storage add-on" },
  ];

  const withCatalogue = () =>
    paid("PRO", [MOVE_TEAM], {
      storageAddons: {
        offers: [
          {
            key: "PERSONAL_10_GB",
            label: "+10 GB",
            storageBytes: "10737418240",
            storageLabel: "10 GB",
            priceCents: 300,
            currency: "USD",
            billingCycle: "MONTHLY",
          },
        ],
        active: [],
      },
    } as never);

  for (const intent of INTENTS) {
    it(`is the SAME control for a ${intent.label} purchase`, () => {
      /*
       * The payment rows were written inline in the checkout drawer, so every
       * Billing purchase inherited whatever that drawer happened to do — and
       * improving them anywhere would have meant improving them three times.
       * There is one component; these are its three consumers.
       */
      const { container, unmount } = render(
        <CheckoutDrawer
          open
          intent={intent.kind === "PLAN" ? { kind: "PLAN" } : { kind: intent.kind }}
          projection={withCatalogue()}
          onClose={noop}
          onCompleted={noop}
          onError={noop}
        />,
      );

      const group = container.querySelector("[data-billing-payment-choice]");
      expect(group).not.toBeNull();
      expect(group!.getAttribute("role")).toBe("radiogroup");

      // Both canonical providers, as native radios.
      for (const provider of ["STRIPE", "PAYPAL"]) {
        const option = container.querySelector(
          `[data-billing-provider-option="${provider}"]`,
        );
        expect(option).not.toBeNull();
        expect(option!.querySelector('input[type="radio"]')).not.toBeNull();
      }

      // The marks are present and DECORATIVE in every flow.
      const marks = container.querySelectorAll(".bill-pay__mark");
      expect(marks.length).toBe(3);
      for (const mark of Array.from(marks)) {
        expect(mark.getAttribute("aria-hidden")).toBe("true");
      }

      unmount();
    });
  }

  it("names each option for a screen reader, and never by its marks", () => {
    const { container } = mountChooser();

    // The accessible name is a real label, not the brand glyphs.
    expect(screen.getByRole("radio", { name: "Credit or debit card" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "PayPal" })).toBeTruthy();
    // Nothing announces "Visa" or "Mastercard" — the marks are a signpost, and
    // naming two networks would claim a coverage this surface cannot promise.
    expect(screen.queryByRole("radio", { name: /Visa|Mastercard/i })).toBeNull();
    // And the marks the customer SEES are there.
    expect(container.querySelector('[data-mark="visa"]')).not.toBeNull();
    expect(container.querySelector('[data-mark="mastercard"]')).not.toBeNull();
    expect(container.querySelector('[data-mark="paypal"]')).not.toBeNull();
  });

  it("makes the WHOLE option the hit area, not just the radio", async () => {
    const user = userEvent.setup();
    const { container } = mountChooser();

    const paypalOption = container.querySelector<HTMLElement>(
      '[data-billing-provider-option="PAYPAL"]',
    )!;
    // Press the marks, which are the furthest thing from the radio circle.
    await user.click(paypalOption.querySelector(".bill-pay__marks")!);

    expect(
      (screen.getByRole("radio", { name: "PayPal" }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("still submits the canonical provider value it always did", async () => {
    const user = userEvent.setup();
    mountChooser();

    await user.click(screen.getByRole("radio", { name: /Pro/ }));
    await user.click(screen.getByRole("radio", { name: "Credit or debit card" }));
    await user.click(continueButton());
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect((apiFetch.mock.calls[0] as [string])[0]).toBe(
      "/v1/billing/checkout/stripe",
    );
  });

  it("keeps the two drawers' groups independent", () => {
    // Two mounted drawers sharing one radio-group name would let a selection
    // in one silently clear the other — which is what a fixed `name` would do.
    const a = render(
      <CheckoutDrawer
        open
        intent={{ kind: "PLAN" }}
        projection={free()}
        onClose={noop}
        onCompleted={noop}
        onError={noop}
      />,
    );
    const names = new Set(
      Array.from(a.container.querySelectorAll('input[name^="billing-payment-method"]')).map(
        (i) => (i as HTMLInputElement).name,
      ),
    );
    expect(names.size).toBe(1);
    expect([...names][0]).toContain("plan");
    a.unmount();
  });
});

// ===========================================================================
// 2c. A granted tier is truthful AND has a way out
// ===========================================================================

describe("a granted tier", () => {
  const granted = (planKey: "PRO" | "TEAM", secondary?: unknown) =>
    ({
      ...free(),
      plan: {
        ...free().plan,
        planKey,
        accessKind: "GRANTED",
        displayName: planKey === "PRO" ? "Pro" : "Team",
        model: "FREE",
        lifecycle: "ACTIVE",
      },
      planOffers: planKey === "PRO" ? [CHECKOUT_TEAM] : [],
      storageAddonsLocked: undefined,
      actions: {
        ...free().actions,
        planManagement: {
          label: "View access details",
          mode: "VIEW_ACCESS",
          enabled: true,
        },
        canRequestCancellation: false,
        ...(secondary ? { secondaryPlanAction: secondary } : {}),
      },
    }) as unknown as BillingAccountProjection;

  it("granted PRO offers a real path to TEAM, and it is a PURCHASE", async () => {
    /*
     * A manually granted tier is real access with no billing relationship, so
     * its first action correctly says "View access details" and buys nothing.
     * Truthful — and, on its own, a dead end: a granted PRO customer who
     * outgrew PRO had nowhere to go on this page.
     *
     * The way out is a NEW subscription checkout, never the plan-transition
     * route, because there is no provider subscription to transition.
     */
    const user = userEvent.setup();
    const started: Array<"PRO" | "TEAM"> = [];
    let managed = 0;

    const { container } = render(
      <BillingOverview
        projection={granted("PRO", {
          kind: "START_SUBSCRIPTION",
          planKey: "TEAM",
          label: "Start Team subscription",
        })}
        onManagePlan={() => {
          managed += 1;
        }}
        onStartSubscription={(planKey) => started.push(planKey)}
        changeBusyPlan={null}
      />,
    );

    // The truthful label survives beside it.
    expect(container.textContent).toMatch(
      /Granted access — no active billing subscription/,
    );
    const start = container.querySelector<HTMLButtonElement>(
      "[data-billing-start-subscription]",
    )!;
    expect(start.textContent).toBe("Start Team subscription");
    expect(start.getAttribute("data-billing-start-subscription")).toBe("TEAM");

    await user.click(start);
    expect(started).toEqual(["TEAM"]);
    // It is NOT the manage/transition surface.
    expect(managed).toBe(0);
  });

  it("granted TEAM offers no second action, because there is nothing above it", () => {
    const { container } = render(
      <BillingOverview
        projection={granted("TEAM")}
        onManagePlan={noop}
        onStartSubscription={noop}
        changeBusyPlan={null}
      />,
    );
    expect(container.querySelector("[data-billing-start-subscription]")).toBeNull();
    // And no meaningless "View plans" in its place.
    expect(container.textContent).not.toMatch(/View plans/);
  });

  it("neither granted tier is offered a cancellation", () => {
    for (const planKey of ["PRO", "TEAM"] as const) {
      const { container, unmount } = mountManage(granted(planKey));
      expect(container.querySelector("[data-billing-manage-cancel]")).toBeNull();
      expect(container.textContent).not.toMatch(/Cancel subscription/);
      unmount();
    }
  });
});

// ===========================================================================
// 2d. The metrics row, the status, and the page composition
// ===========================================================================

describe("the overview metrics", () => {
  it("gives AI operations a track even when it is Not included", () => {
    /*
     * "AI operations — Not included" had no track, so the three meters did not
     * line up and the row read as two measurements and a leftover. The absence
     * said nothing either: a metric with no track and one that failed to load
     * looked identical.
     */
    const { container } = render(
      <BillingOverview projection={free()} onManagePlan={noop} changeBusyPlan={null} />,
    );

    const ai = container.querySelector('[data-billing-metric="AI operations"]')!;
    expect(ai.textContent).toMatch(/Not included/);
    const track = ai.querySelector(".bill-metric__track")!;
    expect(track).not.toBeNull();
    // Decoration, not a progressbar: a progressbar with no value would be a
    // lie in the accessibility tree, so the WORDS carry the state.
    expect(track.getAttribute("data-billing-metric-track")).toBe("empty");
    expect(track.getAttribute("aria-hidden")).toBe("true");
    expect(track.getAttribute("role")).toBeNull();
    expect(track.querySelector(".bill-metric__fill")).toBeNull();

    // Every metric in the row has one, so the three align.
    const tracks = container.querySelectorAll(".bill-metric .bill-metric__track");
    expect(tracks.length).toBe(
      container.querySelectorAll("[data-billing-metric]").length,
    );
  });

  it("renders a real progressbar where there IS a measurement", () => {
    const { container } = render(
      <BillingOverview projection={free()} onManagePlan={noop} changeBusyPlan={null} />,
    );
    const storage = container.querySelector('[data-billing-metric="Storage"]')!;
    const bar = storage.querySelector('[role="progressbar"]')!;
    expect(bar).not.toBeNull();
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(bar.getAttribute("aria-label")).toMatch(/^Storage: /);
  });

  it("states the plan status as words, with no capsule", () => {
    const { container } = render(
      <BillingOverview
        projection={paid("PRO", [MOVE_TEAM])}
        onManagePlan={noop}
        changeBusyPlan={null}
      />,
    );
    const status = container.querySelector("[data-billing-plan-status]")!;
    expect(status).not.toBeNull();
    // The canonical no-capsule primitive, not a Billing-only pill.
    expect(status.className).toMatch(/\bapp-status-text\b/);
    expect(status.className).not.toMatch(/bill-overview__status/);
    // Tone is a reinforcement; the WORD is the signal.
    expect(status.textContent).toBeTruthy();
    expect(status.getAttribute("data-tone")).toBeTruthy();
  });
});

// ===========================================================================
// 3. A real subscription still manages, and says only what is known
// ===========================================================================

describe("managing a real subscription", () => {
  it("PRO offers the move up and a cancellation, in that order", () => {
    const { container } = mountManage(paid("PRO", [MOVE_TEAM]));
    expect(screen.getByRole("button", { name: "Move to Team" })).toBeTruthy();
    expect(container.querySelector("[data-billing-manage-cancel]")).not.toBeNull();
    // Heading is the verb the button uses. "End subscription" is gone.
    expect(container.textContent).toMatch(/Cancel subscription/);
    expect(container.textContent).not.toMatch(/End subscription/);
  });

  it("TEAM offers the move down and a cancellation", () => {
    const { container } = mountManage(paid("TEAM", [MOVE_PRO]));
    expect(screen.getByRole("button", { name: "Move to Pro" })).toBeTruthy();
    expect(container.querySelector("[data-billing-manage-cancel]")).not.toBeNull();
  });

  it("states the plan and its price as one line, not a four-row list", () => {
    const { container } = mountManage(paid("PRO", [MOVE_TEAM]));
    const lead = container.querySelector("[data-billing-manage-plan-name]");
    expect(lead!.textContent).toMatch(/^Pro · .*19/);
    expect(lead!.textContent).toMatch(/\/ month$/);
  });

  it("takes the TIMING from the server's effect, and claims no proration", () => {
    const immediate = mountManage(paid("PRO", [MOVE_TEAM]));
    expect(
      immediate.container.querySelector("[data-billing-manage-timing]")!.textContent,
    ).toBe("Starts immediately.");
    expect(immediate.container.textContent).not.toMatch(/charges the difference/i);
    immediate.unmount();

    const scheduled = mountManage(paid("TEAM", [MOVE_PRO]));
    expect(
      scheduled.container.querySelector("[data-billing-manage-timing]")!.textContent,
    ).toMatch(/^Takes effect on /);
  });

  it("gives the evidence reassurance ONCE, where the consequence is real", () => {
    const { container } = mountManage(paid("PRO", [MOVE_TEAM]));
    const all = container.textContent ?? "";
    const occurrences = all.match(/evidence and custody records remain available/gi) ?? [];
    expect(occurrences).toHaveLength(1);
    // And it is inside the cancellation copy, not under the purchase.
    expect(
      container.querySelector("[data-billing-manage-cancel-copy]")!.textContent,
    ).toMatch(/evidence and custody records remain available/i);
  });
});

// ===========================================================================
// 4. The drawer's button hierarchy, and its containment
// ===========================================================================

describe("the plan-drawer button hierarchy", () => {
  it("the primary plan action carries the drawer-scoped near-black class", async () => {
    const user = userEvent.setup();
    mountChooser();
    await user.click(screen.getByRole("radio", { name: /Pro/ }));
    expect(continueButton().className).toMatch(/\bbill-plan-action\b/);

    const manage = mountManage(paid("PRO", [MOVE_TEAM]));
    expect(
      screen.getByRole("button", { name: "Move to Team" }).className,
    ).toMatch(/\bbill-plan-action\b/);
    manage.unmount();
  });

  it("the cancellation entry point is the outlined variant, not the filled one", () => {
    const { container } = mountManage(paid("PRO", [MOVE_TEAM]));
    const cancel = container.querySelector<HTMLButtonElement>(
      "[data-billing-manage-cancel]",
    )!;
    expect(cancel.className).toMatch(/\bbill-cancel-action\b/);
    // NOT the solid destructive variant: that belongs to the confirmation.
    expect(cancel.className).not.toMatch(/\bbill-plan-action\b/);
  });

  it("both classes are reachable ONLY under the drawer's own scope", async () => {
    /*
     * The containment proof. Every rule is written as a descendant of
     * `.bill-drawer`, so no button anywhere else in PROOVRA — the header's
     * New Case, `.app-primary-action`, an Evidence action, the page's Storage
     * CTA, the auth email gradient — can be repainted by it.
     */
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    // Resolved from the runner's root rather than `import.meta.url`: the
    // render config runs in jsdom, where the module URL is not a file: URL.
    const css = await fs.readFile(
      path.join(process.cwd(), "app", "(app)", "billing", "billing.css"),
      "utf8",
    );

    const rules = css
      .split("\n")
      .filter((l) => /bill-plan-action|bill-cancel-action/.test(l) && l.includes("{"));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule).toMatch(/\.bill-drawer\s/);
    }

    // And no RULE in this file selects the global primary action. Comments
    // are stripped first, because naming what a file must not reach is how
    // the containment stays explained.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(withoutComments).not.toMatch(/\.app-primary-action/);
    // Nor any button primitive at the top level of this file.
    expect(withoutComments).not.toMatch(/^\s*\.ui-button/m);
  });

  it("the drawer panel carries the scope class the rules depend on", () => {
    const { container } = mountChooser();
    const panel = container.querySelector('[role="dialog"]');
    expect(panel!.className).toMatch(/\bbill-drawer\b/);
  });
});

// ===========================================================================
// 5. ONE Evidence card, with the balance and the purchase in it
// ===========================================================================

describe("the Evidence card", () => {
  it("carries the balance and exactly one purchase action", () => {
    const { container } = render(
      <EvidenceDetailCard projection={free()} onBuyCredits={noop} onChoosePlan={noop} />,
    );

    expect(container.querySelector("[data-billing-credit-balance]")!.textContent).toBe(
      "0",
    );
    const buys = container.querySelectorAll("[data-billing-buy-credits]");
    expect(buys).toHaveLength(1);
    expect(buys[0]!.textContent).toBe("Buy credits");
  });

  it("keeps the balance for a rolling-window plan, which has no admission", () => {
    // TEAM's allowance is a 30-day window and carries no admission
    // projection. The card this replaces returned null there, so the balance
    // was only ever shown by the second card — deleting that card without
    // widening this one would have deleted the number with it.
    const team = paid("TEAM", [MOVE_PRO], {
      usage: {
        ...free().usage,
        evidence: { state: "MEASURED", used: 120, limit: 500, window: "ROLLING_30_DAYS" },
      },
      evidenceAdmission: undefined,
      wallet: { ...free().wallet!, availableCredits: 3 },
    } as never);

    const { container } = render(
      <EvidenceDetailCard projection={team} onBuyCredits={noop} onChoosePlan={noop} />,
    );
    expect(container.textContent).toMatch(/120 of 500/);
    expect(container.querySelector("[data-billing-evidence-window]")!.textContent).toMatch(
      /Rolling 30-day window/,
    );
    expect(container.querySelector("[data-billing-credit-balance]")!.textContent).toBe(
      "3",
    );
  });

  it("says the main number once and does not repeat itself", () => {
    const { container } = render(
      <EvidenceDetailCard projection={free()} onBuyCredits={noop} onChoosePlan={noop} />,
    );
    const text = container.textContent ?? "";
    // The deleted card's sentences, which said nothing this one does not.
    expect(text).not.toMatch(/Credits do not expire/);
    expect(text).not.toMatch(/Record more evidence without changing your plan/);
    // One heading, not two.
    expect(container.querySelectorAll("h3")).toHaveLength(1);
    expect(container.querySelector("h3")!.textContent).toBe("Evidence");
  });

  it("offers no purchase to a viewer the server did not authorize", () => {
    const projection = free({
      actions: { ...free().actions, canBuyEvidenceCredits: false },
    } as never);
    const { container } = render(
      <EvidenceDetailCard projection={projection} onChoosePlan={noop} />,
    );
    expect(container.querySelector("[data-billing-buy-credits]")).toBeNull();
  });
});

// ===========================================================================
// 6. FREE storage says what the button will actually do
// ===========================================================================

describe("the FREE storage card", () => {
  it("says how much is used, which plans include more, and opens the chooser", async () => {
    const user = userEvent.setup();
    let chose = 0;
    let managed = 0;

    const { container } = render(
      <StorageAddonsSection
        projection={free()}
        onManageStorage={() => {
          managed += 1;
        }}
        onChoosePlan={() => {
          chose += 1;
        }}
        onCancelAddon={noop}
        cancelBusyId={null}
      />,
    );

    expect(container.textContent).toMatch(/0 B of 250 MB used/);
    expect(container.textContent).toMatch(
      /Additional storage is available with Pro and Team\./,
    );

    const cta = container.querySelector<HTMLButtonElement>(
      "[data-billing-storage-upgrade]",
    )!;
    expect(cta.textContent).toBe("View plans");
    // The labels that would describe a destination this button does not have.
    expect(container.textContent).not.toMatch(/Add storage/);
    expect(container.textContent).not.toMatch(/Manage storage/);

    await user.click(cta);
    expect(chose).toBe(1);
    // It must NEVER open the capacity catalogue: FREE cannot buy from it.
    expect(managed).toBe(0);
  });

  it("shows no capacity options to an account that cannot buy them", () => {
    const { container } = render(
      <StorageAddonsSection
        projection={free()}
        onManageStorage={noop}
        onChoosePlan={noop}
        onCancelAddon={noop}
        cancelBusyId={null}
      />,
    );
    expect(container.querySelector("[data-billing-addon-option]")).toBeNull();
  });

  it("a PRO subscriber opens the real storage selection instead", async () => {
    const user = userEvent.setup();
    let chose = 0;
    let managed = 0;

    const pro = paid("PRO", [MOVE_TEAM], {
      storageAddons: {
        offers: [
          {
            key: "PERSONAL_10_GB",
            label: "+10 GB",
            storageBytes: "10737418240",
            storageLabel: "10 GB",
            priceCents: 300,
            currency: "USD",
            billingCycle: "MONTHLY",
          },
        ],
        active: [],
      },
    } as never);

    const { container } = render(
      <StorageAddonsSection
        projection={pro}
        onManageStorage={() => {
          managed += 1;
        }}
        onChoosePlan={() => {
          chose += 1;
        }}
        onCancelAddon={noop}
        cancelBusyId={null}
      />,
    );

    expect(container.querySelector("[data-billing-storage-upgrade]")).toBeNull();
    const manage = container.querySelector<HTMLButtonElement>(
      "[data-billing-manage-storage]",
    );
    expect(manage).not.toBeNull();
    await user.click(manage!);
    expect(managed).toBe(1);
    // A real subscriber is never sent back to the plan chooser.
    expect(chose).toBe(0);
  });
});

// ===========================================================================
// 7. Direction and touch targets survive all of it
// ===========================================================================

describe("direction and reach", () => {
  for (const dir of ["ltr", "rtl"] as const) {
    it(`renders the chooser, its marks and its CTA in ${dir}`, async () => {
      document.documentElement.dir = dir;
      const user = userEvent.setup();
      const { container } = mountChooser();
      await user.click(screen.getByRole("radio", { name: /Team/ }));

      // Money and mixed number/label runs stay isolated so RTL cannot reorder
      // them into a different figure.
      expect(container.querySelectorAll("bdi").length).toBeGreaterThan(0);
      // The payment marks compose in both directions rather than being
      // positioned by a physical property that only works in one.
      expect(container.querySelectorAll(".bill-pay__mark").length).toBe(3);
      expect(continueButton().textContent).toBe("Continue with Team");
    });
  }

  it("every drawer action is a real focusable button", () => {
    const { container } = mountManage(paid("PRO", [MOVE_TEAM]));
    for (const sel of ["[data-billing-manage-offer]", "[data-billing-manage-cancel]"]) {
      const el = container.querySelector(sel)!;
      expect(el.tagName.toLowerCase()).toBe("button");
      expect(el.hasAttribute("disabled")).toBe(false);
    }
  });
});
