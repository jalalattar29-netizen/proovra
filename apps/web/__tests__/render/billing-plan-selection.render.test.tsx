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
import { EvidenceDetailCard } from "../../app/(app)/billing/_sections/BillingOverview";
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
    // Both providers, as real radios — a customer must be able to see and
    // change where they are about to be sent.
    expect(screen.getByRole("radio", { name: "Card" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "PayPal" })).toBeTruthy();
  });

  it("states the plan, the cadence and the total once a tier is selected", async () => {
    const user = userEvent.setup();
    const { container } = mountChooser();

    // Nothing to summarise before a choice exists — an empty summary is one
    // more heading to scroll past.
    expect(container.querySelector("[data-billing-plan-summary]")).toBeNull();

    await user.click(screen.getByRole("radio", { name: /Pro/ }));

    const summary = container.querySelector("[data-billing-plan-summary]");
    expect(summary).not.toBeNull();
    expect(
      summary!.querySelector("[data-billing-summary-plan]")!.textContent,
    ).toBe("Pro");
    expect(
      summary!.querySelector("[data-billing-summary-cadence]")!.textContent,
    ).toBe("Monthly");
    expect(
      summary!.querySelector("[data-billing-summary-total]")!.textContent,
    ).toMatch(/19/);
    // And it says what the customer is signing up to, in as many words.
    expect(summary!.textContent).toMatch(/creates a monthly subscription/i);
  });

  it("names the PROVIDER it is about to hand the customer to", async () => {
    const user = userEvent.setup();
    mountChooser();

    await user.click(screen.getByRole("radio", { name: /Pro/ }));
    expect(continueButton().textContent).toBe("Continue with Card");

    await user.click(screen.getByRole("radio", { name: "PayPal" }));
    expect(continueButton().textContent).toBe("Continue with PayPal");
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
    ["Card", "/v1/billing/checkout/stripe"],
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
    it(`renders the chooser and its summary in ${dir}`, async () => {
      document.documentElement.dir = dir;
      const user = userEvent.setup();
      const { container } = mountChooser();
      await user.click(screen.getByRole("radio", { name: /Team/ }));

      expect(container.querySelector("[data-billing-plan-summary]")).not.toBeNull();
      // Money and mixed number/label runs stay isolated so RTL cannot reorder
      // them into a different figure.
      expect(container.querySelectorAll("bdi").length).toBeGreaterThan(0);
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
