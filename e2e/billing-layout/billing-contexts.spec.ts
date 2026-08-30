/**
 * BILLING — what each commercial context is offered, and what it is not.
 *
 * The other spec in this project measures geometry on ONE account. This one
 * measures the thing an audit found unmeasured: that the page tells each payer
 * the truth about their own arrangement, and never offers an act the product
 * cannot honour for them.
 *
 * The absences matter more than the presences here. A self-serve control on a
 * contract-managed account is not a dead button — it reaches a real endpoint —
 * it is an invitation to do something the agreement does not permit, and it is
 * exactly the failure that looks fine in a screenshot.
 */

import { expect, test } from "@playwright/test";

import { openBillingAs, type BillingContext } from "./_contexts";

const SELF_SERVE_HOOKS = [
  "[data-billing-view-pricing]",
  "[data-billing-buy-credits]",
  "[data-billing-manage-storage]",
  "[data-billing-storage-upgrade]",
  "[data-billing-start-subscription]",
  "[data-billing-recheck]",
];

test.describe("billing — Personal FREE", () => {
  test("states a real zero, offers the upgrade, and invents no seats", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openBillingAs(page, "free");

    await expect(page.locator("[data-billing-plan-name]")).toContainText("Free");
    // A price of zero is a FACT, and FREE is the one plan that states it.
    await expect(page.locator("[data-billing-overview]")).toContainText("0");
    // Self-serve pricing is relevant here, so it is offered.
    await expect(page.locator("[data-billing-view-pricing]")).toBeVisible();

    // No collaboration seats on a single-occupant account: "0 of 0" would read
    // as a limit rather than as absence.
    await expect(page.locator("[data-billing-seats]")).toHaveCount(0);
  });
});

test.describe("billing — Pay per evidence", () => {
  test("shows the wallet and offers credits, not a subscription", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openBillingAs(page, "payg");

    await expect(page.locator("[data-billing-plan-name]")).toContainText(
      "Pay per evidence",
    );
    // The balance is the commercial fact of this arrangement.
    await expect(page.locator("[data-billing-page]")).toContainText("12");

    // Nothing recurring exists, so nothing offers to cancel one.
    await expect(page.locator("[data-billing-cancel]")).toHaveCount(0);
  });
});

test.describe("billing — Team", () => {
  test("shows seats and a subscription, and no contract content", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openBillingAs(page, "team");

    await expect(page.locator("[data-billing-plan-name]")).toContainText("Team");
    // Seats are what distinguishes this tier commercially.
    await expect(page.locator("[data-billing-page]")).toContainText("7");
    await expect(page.locator("[data-billing-page]")).toContainText("25");

    // TEAM is a self-serve tier of a personal account, NOT an organization
    // under an agreement. No contract card may appear.
    await expect(page.locator("[data-billing-contract]")).toHaveCount(0);
    await expect(page.locator("[data-billing-page]")).not.toContainText(
      "account manager",
    );
  });
});

test.describe("billing — Enterprise, contract active", () => {
  test("is governed by an agreement and offers no self-serve act", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openBillingAs(page, "enterprise-active");

    await expect(page.locator("[data-billing-plan-name]")).toContainText(
      "Enterprise",
    );
    await expect(page.locator("[data-billing-contract]")).toBeVisible();
    // The terms, from the contract record.
    await expect(page.locator("[data-billing-contract]")).toContainText("120");
    await expect(page.locator("[data-billing-contract]")).toContainText("1024 GB");
    await expect(page.locator("[data-billing-contract]")).toContainText(
      "eu-central-1",
    );

    // What it IS offered: the agreement, and the person who can change it.
    await expect(page.locator("[data-billing-plan-management]")).toContainText(
      "View agreement",
    );
    await expect(page.locator("[data-billing-support-action]")).toContainText(
      "account manager",
    );

    // THE POINT. Every self-serve control is absent — including the pricing
    // link and the provider re-check, which were unconditional until the
    // context audit.
    for (const hook of SELF_SERVE_HOOKS) {
      await expect(page.locator(hook), `${hook} must not be offered`).toHaveCount(
        0,
      );
    }
    // And the history says what it is, rather than promising to check a
    // payment provider that does not exist for this account.
    await expect(page.locator("[data-billing-history]")).not.toContainText(
      "Checks your payment provider",
    );
  });

  test("an activated agreement says so, in green", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openBillingAs(page, "enterprise-active");

    const activation = page.locator(
      '[data-billing-contract-activation="ACTIVATED"]',
    );
    await expect(activation).toBeVisible();
    await expect(activation).toContainText("Activated");
    // Never the raw enum.
    await expect(activation).not.toContainText("ACTIVATED ");

    const colour = await activation
      .locator("text=Activated")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    const [r, g, b] = (colour.match(/\d+/g) ?? []).map(Number);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });
});

test.describe("billing — Enterprise, mid-activation", () => {
  for (const [context, hook, words] of [
    ["enterprise-pending-owner", "PENDING_OWNER", "Owner setup required"],
    ["enterprise-owner-invited", "OWNER_INVITED", "Owner invitation pending"],
  ] as const) {
    test(`${hook} explains itself rather than saying only "action required"`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 1200 });
      await openBillingAs(page, context as BillingContext);

      const activation = page.locator(
        `[data-billing-contract-activation="${hook}"]`,
      );
      await expect(activation).toBeVisible();
      await expect(activation).toContainText(words);
      // One sentence explaining what is being waited for. "Owner setup
      // required" alone tells an administrator a state, not what to do about
      // it or who is expected to act.
      await expect(activation).toContainText(
        hook === "PENDING_OWNER"
          ? "waiting for an organization owner to complete activation"
          : "has been invited and has not completed setup",
      );
      // Waiting is not failing: an outstanding invitation must not be painted
      // as an error and send an administrator to support.
      const colour = await activation
        .locator(`text=${words}`)
        .first()
        .evaluate((el) => getComputedStyle(el).color);
      const [r, g, b] = (colour.match(/\d+/g) ?? []).map(Number);
      expect(r, "amber, not red").toBeGreaterThan(b);
      expect(g, "amber, not red").toBeGreaterThan(b);

      // Still contract-managed: no self-serve escape hatch appears because
      // activation is incomplete.
      for (const selector of SELF_SERVE_HOOKS) {
        await expect(page.locator(selector)).toHaveCount(0);
      }
    });
  }

  test("a suspended agreement says SUSPENDED, and that allowances lapse", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openBillingAs(page, "enterprise-suspended");

    // Not the generic "not currently active" every inactive state used to
    // share. A suspension is a live commercial problem with its own remedy.
    await expect(page.locator("[data-billing-page]")).toContainText(
      "Agreement suspended",
    );
    await expect(page.locator("[data-billing-page]")).toContainText(
      "Contracted allowances do not apply",
    );
    await expect(
      page.locator('[data-billing-contract-status="SUSPENDED"]'),
    ).toContainText("Suspended");

    // Still no self-serve remedy: the product cannot honour one.
    for (const selector of SELF_SERVE_HOOKS) {
      await expect(page.locator(selector)).toHaveCount(0);
    }
    await expect(page.locator("[data-billing-support-action]")).toBeVisible();
  });

  test("an ended agreement is not described in the present tense", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openBillingAs(page, "enterprise-terminated");

    await expect(page.locator("[data-billing-page]")).toContainText(
      "Agreement ended",
    );
    await expect(
      page.locator('[data-billing-contract-status="TERMINATED"]'),
    ).toContainText("Ended");

    // THE POINT. The contract row still carries seats, storage and a term
    // date, and printing them under "Contracted seats" / "Term ends" reads as
    // allowances that still apply. The server already refuses to let them
    // govern anything — `contractGovernsCapability` is false for every
    // non-ACTIVE status — and the card now says the same thing in the words a
    // reader actually looks at.
    const contract = page.locator("[data-billing-contract]");
    await expect(contract).toContainText("Term ended");
    await expect(contract).toContainText("Seats covered");
    await expect(contract).toContainText("Storage covered");
    await expect(contract).not.toContainText("Contracted seats");
    await expect(contract).not.toContainText("Term ends");

    // No renewal, no self-service, no invented remedy.
    for (const selector of SELF_SERVE_HOOKS) {
      await expect(page.locator(selector)).toHaveCount(0);
    }
    const words = (await page.locator("[data-billing-page]").innerText()).toLowerCase();
    expect(words).not.toContain("renew now");
    expect(words).not.toContain("reactivate");
  });

  test("an ACTIVE agreement reads as active, and states its status", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openBillingAs(page, "enterprise-active");

    await expect(
      page.locator('[data-billing-contract-status="ACTIVE"]'),
    ).toContainText("Active");
    // The live terms are described as terms that apply.
    const contract = page.locator("[data-billing-contract]");
    await expect(contract).toContainText("Contracted seats");
    await expect(contract).toContainText("Term ends");
  });
});

test.describe("billing — an actor with no billing account", () => {
  test("is told plainly, and offered nothing to buy", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openBillingAs(page, "no-account");

    await expect(page.locator("[data-billing-no-accounts]")).toBeVisible();
    await expect(page.locator("[data-billing-no-accounts]")).toContainText(
      "managed",
    );

    // THE POINT. This state used to carry a "View pricing" link in its header:
    // an organization member who cannot see billing was invited to compare
    // self-serve tiers they cannot buy.
    for (const selector of SELF_SERVE_HOOKS) {
      await expect(page.locator(selector), `${selector} must be absent`).toHaveCount(
        0,
      );
    }
    // And no contract metadata leaks to someone without authority over it.
    await expect(page.locator("[data-billing-contract]")).toHaveCount(0);
  });
});

test.describe("billing — responsive across contexts", () => {
  const CONTEXTS: BillingContext[] = [
    "free",
    "payg",
    "team",
    "enterprise-active",
    "enterprise-pending-owner",
    "enterprise-terminated",
    "no-account",
  ];

  for (const context of CONTEXTS) {
    for (const [label, width, height] of [
      ["1440", 1440, 1000],
      ["390", 390, 844],
    ] as const) {
      test(`${context} at ${label}: nothing overflows sideways`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await openBillingAs(page, context);
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(overflow, `${context} @ ${label}`).toBeLessThanOrEqual(0);
      });
    }
  }
});
