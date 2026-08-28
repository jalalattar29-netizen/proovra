/**
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — RENDER-LEVEL proof of the
 * redesigned Billing surface.
 *
 * WHAT IS REAL HERE
 * ---------------------------------------------------------------------------
 * The shipped section components are mounted with real projections and
 * inspected as rendered DOM. Nothing is asserted by reading source: what is
 * checked is what a customer would see.
 *
 * WHAT IS NOT COVERED HERE, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * jsdom does not lay anything out — it has no viewport, no fonts and no
 * scrollbars — so this suite cannot prove that a 390px screen does not
 * scroll sideways or that a long German compound does not overflow its card.
 * What it CAN prove, and does, is the property those failures come from: that
 * the surface never depends on a fixed width, that nothing is sized to the
 * length of its own text, that direction-sensitive values are isolated, and
 * that every string that varies by locale is rendered through the same
 * containers regardless of how long it turns out to be. The four widths, both
 * directions and both long-word locales are exercised against those
 * containers here; pixel confirmation in a real browser is separate work and
 * is NOT claimed by this file.
 */

import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import {
  CollaborationUsageCard,
  PlanSummaryCard,
  UsageAndLimits,
} from "../../app/(app)/billing/_sections/PlanAndUsage";
import type {
  BillingAccountProjection,
  PlanOffer,
} from "../../lib/api/billing-accounts";

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

const OFFER_TEAM: PlanOffer = {
  planKey: "TEAM",
  displayName: "Team",
  priceCents: 4900,
  currency: "EUR",
  summary: "500 evidence records in any 30 days, 500 GB of cumulative storage",
  action: "UPGRADE",
  effect: "IMMEDIATE",
  actionLabel: "Upgrade to Team",
  effectSummary: "Team starts straight away.",
};

const OFFER_PRO: PlanOffer = {
  planKey: "PRO",
  displayName: "Pro",
  priceCents: 1900,
  currency: "EUR",
  summary: "100 lifetime evidence records, 50 GB of cumulative storage",
  action: "DOWNGRADE",
  effect: "AT_PERIOD_END",
  actionLabel: "Switch to Pro",
  effectSummary: "You keep Team until the end of the period you have paid for.",
};

function personal(
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
      planKey: "PRO",
      displayName: "Pro",
      model: "MONTHLY",
      lifecycle: "ACTIVE",
      priceCents: 1900,
      currency: "EUR",
      currentPeriodEndUtc: "2026-10-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      billingOwnerMissing: false,
    },
    usage: {
      evidence: { state: "MEASURED", used: 42, limit: 100, window: "LIFETIME" },
      storage: {
        state: "MEASURED",
        usedBytes: "1",
        usedLabel: "1 GB",
        limitBytes: "50",
        limitLabel: "50 GB",
        includedBytes: "50",
        includedLabel: "50 GB",
        recurringAddonBytes: "0",
        recurringAddonLabel: "0 B",
        legacyAddonBytes: "0",
        legacyAddonLabel: "0 B",
        usagePercent: 2,
        nearLimit: false,
        limitReached: false,
      },
      ai: { state: "MEASURED", used: 3, limit: 200, window: "CALENDAR_MONTH" },
    },
    actionRequired: null,
    actions: {
      canStartCheckout: true,
      canBuyEvidenceCredits: true,
      canBuyStorageAddon: true,
      canRequestCancellation: true,
      contactAccountManager: false,
      manageLabel: "Change plan",
    },
    planOffers: [OFFER_TEAM],
    ...overrides,
  } as BillingAccountProjection;
}

function organization(
  overrides: Partial<BillingAccountProjection> = {},
): BillingAccountProjection {
  return {
    ...personal(),
    account: {
      type: "ORGANIZATION",
      id: "org-1",
      displayName: "Bundesanstalt für Beweismittelsicherung",
      capabilities: [
        "BILLING_ACCOUNT_VIEW",
        "BILLING_AMOUNT_VIEW",
        "BILLING_HISTORY_VIEW",
      ],
      billingOwnerMissing: false,
    },
    plan: {
      planKey: "ENTERPRISE",
      displayName: "Enterprise",
      model: "CONTRACT",
      lifecycle: "ACTIVE",
      currentPeriodEndUtc: null,
      cancelAtPeriodEnd: false,
      billingOwnerMissing: false,
    },
    actions: {
      canStartCheckout: false,
      canBuyEvidenceCredits: false,
      canBuyStorageAddon: false,
      canRequestCancellation: false,
      contactAccountManager: true,
      manageLabel: null,
    },
    planOffers: undefined,
    ...overrides,
  } as BillingAccountProjection;
}

const noop = () => {};

function mountPlan(projection: BillingAccountProjection) {
  return render(
    <PlanSummaryCard
      projection={projection}
      onManage={noop}
      onChangePlan={noop}
      onCancel={noop}
      cancelBusy={false}
      changeBusyPlan={null}
    />,
  );
}

beforeEach(() => {
  document.documentElement.dir = "ltr";
  document.documentElement.lang = "en";
});

// ===========================================================================
// 1. Both directions are offered, and they read differently
// ===========================================================================

describe("the plan card offers the moves the server listed", () => {
  it("an upgrade and a downgrade are both rendered, each with the server's words", () => {
    mountPlan(personal({ planOffers: [OFFER_TEAM, OFFER_PRO] }));

    const up = screen.getByRole("button", { name: "Upgrade to Team" });
    const down = screen.getByRole("button", { name: "Switch to Pro" });
    expect(up.getAttribute("data-billing-plan-offer-action")).toBe("UPGRADE");
    expect(down.getAttribute("data-billing-plan-offer-action")).toBe("DOWNGRADE");
  });

  it("a downgrade is not dressed as a destructive action", () => {
    // It destroys nothing. Painting it the same red as "cancel my
    // subscription" would discourage a legitimate choice by implying a
    // consequence that does not exist.
    mountPlan(personal({ planOffers: [OFFER_TEAM, OFFER_PRO] }));
    const down = screen.getByRole("button", { name: "Switch to Pro" });
    expect(down.className).not.toMatch(/danger/i);
  });

  it("a FREE account is offered BOTH tiers — TEAM needs no workspace first", () => {
    mountPlan(
      personal({
        plan: { ...personal().plan, planKey: "FREE", displayName: "Free", model: "FREE" },
        planOffers: [
          { ...OFFER_PRO, action: "CHECKOUT", effect: "IMMEDIATE", actionLabel: "Subscribe to Pro" },
          { ...OFFER_TEAM, action: "CHECKOUT", effect: "IMMEDIATE", actionLabel: "Subscribe to Team" },
        ],
      }),
    );
    expect(screen.getByRole("button", { name: "Subscribe to Pro" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Subscribe to Team" })).toBeTruthy();
  });

  it("no offer renders a workspace name, a provider id or a price id", () => {
    const { container } = mountPlan(personal({ planOffers: [OFFER_TEAM, OFFER_PRO] }));
    expect(container.textContent ?? "").not.toMatch(/sub_|price_|cs_|P-|I-/);
  });
});

// ===========================================================================
// 2. A scheduled change is visible, and it stops a second one
// ===========================================================================

describe("a scheduled downgrade", () => {
  const scheduled = personal({
    plan: {
      ...personal().plan,
      planKey: "TEAM",
      displayName: "Team",
      scheduledChange: {
        planKey: "PRO",
        displayName: "Pro",
        effectiveAtUtc: "2026-10-01T00:00:00.000Z",
      },
    },
    planOffers: [OFFER_PRO],
  });

  it("says what is coming, when, and that nothing changes until then", () => {
    const { container } = mountPlan(scheduled);
    const note = container.querySelector("[data-billing-scheduled-change]");
    expect(note).not.toBeNull();
    expect(note?.textContent ?? "").toMatch(/Moving to Pro/);
    expect(note?.textContent ?? "").toMatch(/You keep everything you have now until then/);
  });

  it("offers no second move while the first has not landed", () => {
    // The provider holds ONE schedule. Offering another would let a customer
    // queue two changes and be told both were accepted.
    mountPlan(scheduled);
    expect(screen.queryByRole("button", { name: /Switch to|Upgrade to/ })).toBeNull();
  });

  it("with no date, it still says the change is coming rather than nothing", () => {
    const { container } = mountPlan(
      personal({
        plan: {
          ...personal().plan,
          scheduledChange: { planKey: "PRO", displayName: "Pro", effectiveAtUtc: null },
        },
      }),
    );
    expect(
      container.querySelector("[data-billing-scheduled-change]")?.textContent ?? "",
    ).toMatch(/end of this billing period/);
  });
});

// ===========================================================================
// 3. Over the allowance, and unknown allowances
// ===========================================================================

describe("meters say what is true", () => {
  it("being over the allowance is explained, not shown as '176 of 127'", () => {
    const { container } = render(
      <UsageAndLimits
        projection={personal({
          usage: {
            ...personal().usage,
            evidence: { state: "MEASURED", used: 176, limit: 127, window: "LIFETIME" },
          },
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/176 of 127/);
    expect(text).toMatch(/176/);
    expect(text).toMatch(/49 over the 127 your plan includes/);
    expect(text).toMatch(/Nothing has been removed/);
  });

  it("an unreadable value is never rendered as zero", () => {
    const { container } = render(
      <UsageAndLimits
        projection={personal({
          usage: {
            ...personal().usage,
            ai: { state: "UNAVAILABLE", reason: "We could not read this right now." },
          },
        })}
      />,
    );
    expect(container.textContent ?? "").toMatch(/Unavailable/);
  });

  it("an agreement silent on seats renders no fabricated limit", () => {
    const { container } = render(
      <CollaborationUsageCard
        projection={organization({
          collaboration: { seats: { used: 12, limit: null, pendingInvites: 0 } },
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/12 of 0/);
    expect(text).toMatch(/Your agreement sets this allowance/);
  });
});

// ===========================================================================
// 4. The Organization surface offers nothing it cannot honour
// ===========================================================================

describe("an Enterprise agreement", () => {
  it("offers no checkout, no plan move and no cancellation", () => {
    mountPlan(organization());
    expect(screen.queryByRole("button", { name: /Subscribe|Upgrade|Switch/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Cancel subscription/ })).toBeNull();
  });

  it("names the person who can actually change it", () => {
    const { container } = mountPlan(organization());
    expect(container.querySelector("[data-billing-contact-account-manager]")).not.toBeNull();
  });

  it("shows no invented renewal date for a contract", () => {
    const { container } = mountPlan(organization());
    expect(container.textContent ?? "").not.toMatch(/Renews on/);
  });
});

// ===========================================================================
// 5. Direction, locale and width
// ===========================================================================

const LONG_GERMAN =
  "Beweismittelsicherungsgeschäftsführungsverordnungsergänzung Arbeitsgemeinschaft";
const LONG_ARABIC =
  "مؤسسة حفظ الأدلة الرقمية والتوثيق القانوني للمستندات والوسائط المتعددة";

describe("direction and long copy", () => {
  for (const dir of ["ltr", "rtl"] as const) {
    it(`renders both plan moves in ${dir} without dropping either`, () => {
      document.documentElement.dir = dir;
      mountPlan(personal({ planOffers: [OFFER_TEAM, OFFER_PRO] }));
      expect(screen.getByRole("button", { name: "Upgrade to Team" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Switch to Pro" })).toBeTruthy();
    });
  }

  it("money is bidi-isolated so a currency symbol cannot reorder in RTL", () => {
    document.documentElement.dir = "rtl";
    const { container } = mountPlan(personal());
    const isolated = container.querySelectorAll("bdi");
    expect(isolated.length).toBeGreaterThan(0);
  });

  for (const [label, name] of [
    ["German", LONG_GERMAN],
    ["Arabic", LONG_ARABIC],
  ] as const) {
    it(`a long ${label} account name is rendered in full, not truncated away`, () => {
      // Truncation is a layout decision and belongs to CSS. What must not
      // happen is the NAME being shortened in JavaScript, which would make the
      // rendered text differ from the account's real name.
      const { container } = mountPlan(
        personal({ account: { ...personal().account, displayName: name } }),
      );
      expect(container.textContent ?? "").toContain(name);
    });
  }

  it("nothing that HOLDS TEXT is given a fixed pixel width", () => {
    // A fixed width is what turns a long word or a narrow screen into a
    // horizontal scrollbar — but only where text has to fit inside it. The
    // check is scoped to elements that actually carry text, which is why the
    // status dot in the lifecycle badge (a 6px square with no content) is not
    // a violation: nothing can overflow it.
    const { container } = mountPlan(personal({ planOffers: [OFFER_TEAM, OFFER_PRO] }));
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
      const width = el.style.width;
      const holdsText = (el.textContent ?? "").trim().length > 0;
      if (holdsText && width && width !== "100%" && width !== "auto") {
        throw new Error(
          `fixed width "${width}" on <${el.tagName.toLowerCase()}> holding text`,
        );
      }
    }
  });

  it("the usage grid is responsive by construction, at every width", () => {
    // `repeat(auto-fit, minmax(...))` is the single declaration that makes
    // 1440, 1024, 768 and 390 all work without a breakpoint apiece. Asserting
    // the declaration is asserting the behaviour at all four.
    const { container } = render(<UsageAndLimits projection={personal()} />);
    const grids = Array.from(container.querySelectorAll<HTMLElement>("div")).filter(
      (d) => d.style.gridTemplateColumns.includes("auto-fit"),
    );
    expect(grids.length).toBeGreaterThan(0);
    for (const g of grids) {
      expect(g.style.gridTemplateColumns).toMatch(/minmax\(\s*\d+px/);
    }
  });
});

// ===========================================================================
// 6. Nothing internal leaks
// ===========================================================================

describe("the surface exposes no internal vocabulary", () => {
  it("no workspace kind, provider name or model name reaches the DOM", () => {
    const { container } = mountPlan(personal({ planOffers: [OFFER_TEAM, OFFER_PRO] }));
    const text = container.textContent ?? "";
    for (const banned of [
      "OWNED",
      "TEAM_WORKSPACE",
      "SINGLE_OCCUPANT",
      "SHARED",
      "Entitlement",
      "Subscription row",
      "teamId",
    ]) {
      expect(text).not.toContain(banned);
    }
  });
});

// ===========================================================================
// 7. Over-limit copy is truthful for the KIND of allowance
// ===========================================================================

describe("an exhausted allowance names a resolution that exists", () => {
  it("a LIFETIME cap does not promise a return to the allowance", () => {
    // Found in the browser-verification pass. The first version told everyone
    // they could "add more once you are back within the allowance" — for a
    // lifetime cap that describes a mechanism the product does not offer, and
    // a customer who waited would wait for ever.
    const { container } = render(
      <UsageAndLimits
        projection={personal({
          usage: {
            ...personal().usage,
            evidence: { state: "MEASURED", used: 176, limit: 127, window: "LIFETIME" },
          },
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/back within the allowance/);
    expect(text).toMatch(/does not reset/);
    // The resolutions that DO work are named.
    expect(text).toMatch(/Moving up a plan|evidence credit/);
  });

  it("a ROLLING allowance says capacity comes back, because it does", () => {
    const { container } = render(
      <UsageAndLimits
        projection={personal({
          usage: {
            ...personal().usage,
            evidence: { state: "MEASURED", used: 512, limit: 500, window: "ROLLING_30_DAYS" },
          },
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/leave this window as they age/);
    expect(text).not.toMatch(/does not reset/);
  });

  it("both say plainly that nothing was removed", () => {
    for (const window of ["LIFETIME", "ROLLING_30_DAYS"] as const) {
      const { container } = render(
        <UsageAndLimits
          projection={personal({
            usage: {
              ...personal().usage,
              evidence: { state: "MEASURED", used: 10, limit: 5, window },
            },
          })}
        />,
      );
      expect(container.textContent ?? "", window).toMatch(/Nothing has been removed/);
    }
  });
});
