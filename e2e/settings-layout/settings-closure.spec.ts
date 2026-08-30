/**
 * SETTINGS — the closure pass.
 *
 * The redesign gave Settings a shell. This pins what the closure did to what
 * is INSIDE it: one destination per subject, one visual contract, and no
 * surface that cannot do what it appears to offer.
 */

import { expect, test } from "@playwright/test";

import { installSettingsApi, openSettings } from "./_fixtures";

const navIds = (page: import("@playwright/test").Page) =>
  page
    .locator("[data-settings-nav-item]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-settings-nav-item")));

const rgb = (value: string) =>
  ((value.match(/\d+/g) ?? []).slice(0, 3).map(Number) as [number, number, number]);

test.describe("settings — the personal map is short on purpose", () => {
  test("a personal space offers exactly Overview, Security, Notifications", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "personal");

    // Profile & preferences was a second page for the same subject; General
    // held one sentence about AI assistance and a link to pricing; Billing &
    // plan restated four facts and linked to the page that owns them.
    expect(await navIds(page)).toEqual(["overview", "security", "notifications"]);
  });

  test("the retired destinations still resolve rather than 404", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Installed ONCE: Playwright gives precedence to the last registered
    // route, so re-installing per hash would put the broad host catch above
    // the envelope handler.
    await installSettingsApi(page, "personal");
    for (const hash of ["#profile", "#preferences", "#workspace", "#billing"]) {
      await page.goto(`/settings${hash}`);
      await page.waitForSelector("[data-settings-shell]");
      await expect(
        page.locator('[data-settings-pane="overview"]'),
        `${hash} should land on Overview`,
      ).toBeVisible();
    }
  });

  test("no Need help card — support lives in the app shell", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "personal");
    await expect(page.locator("[data-settings-help]")).toHaveCount(0);
    await expect(page.locator("[data-settings-support-action]")).toHaveCount(0);
    await expect(page.locator("[data-settings-nav]")).not.toContainText("Need help");
  });
});

test.describe("settings — Overview absorbed the account", () => {
  test("it carries the identity and the preferences, not a second nav", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "personal");

    // The identity block and the preference controls that were the only
    // unique content on the retired Profile page.
    await expect(page.locator("[data-settings-identity]")).toBeVisible();
    await expect(page.locator("[data-cc-profile-edit]")).toBeVisible();
    await expect(page.locator("[data-settings-preferences]")).toBeVisible();
    await expect(page.locator("[data-settings-preferences] select")).toBeVisible();

    // The Account / Workspace / System card grids duplicated the rail. One
    // local navigation authority.
    await expect(page.locator("[data-settings-group]")).toHaveCount(0);
  });

  test("Edit profile and Review security are dark ink with white labels", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "personal");

    for (const sel of ["[data-cc-profile-edit]", '[data-settings-open="security"]']) {
      const paint = await page.locator(sel).first().evaluate((el) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, fg: cs.color };
      });
      expect(Math.max(...rgb(paint.bg)), `${sel} must be dark ink`).toBeLessThan(80);
      expect(rgb(paint.fg).every((c) => c > 240), `${sel} label must be white`).toBe(
        true,
      );
    }
  });

  test("Activity states real sign-ins, or says plainly that it has none", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "personal");

    const card = page.locator('[data-settings-summary="activity"]');
    await expect(card).toBeVisible();

    const list = page.locator("[data-settings-recent-signins] li");
    if ((await list.count()) > 0) {
      // At most three, and each one carries what the session route actually
      // projects: a device and a time. `uaPreview` and `countryCode` were
      // being fetched and discarded, which is why this card could only ever
      // say "Not available".
      expect(await list.count()).toBeLessThanOrEqual(3);
      await expect(list.first()).toContainText(/\d/);
    } else {
      await expect(card).toContainText("No recent sign-in activity available");
    }
  });
});

test.describe("settings — Security is a page, not a dump", () => {
  test("three sessions and three events by default, each with a disclosure", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#security");

    const rows = page.locator("[data-cc-session-row]");
    await expect(rows).toHaveCount(3);
    const toggle = page.locator("[data-cc-sessions-toggle]");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    expect(await rows.count()).toBeGreaterThan(3);

    // Security activity: three, then "View more".
    await expect(page.locator("[data-cc-security-event-row]")).toHaveCount(3);
    await expect(page.locator("[data-cc-security-events-more]")).toBeVisible();
  });

  test("the enrolment form for the security device is NOT shown without a workspace", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#security");

    // AUDIT: `enroll/start` and `enroll/verify` both take a `teamId` in a
    // STRICT schema, and `useTeamId()` is null in a personal space — so the
    // form rendered permanently disabled under "Open a workspace before
    // enrolling a device". A dead control on a security page is worse than no
    // control.
    await expect(page.locator("[data-contact-factor-blocked]")).toHaveCount(0);
    await expect(page.locator("[data-contact-factor-send]")).toHaveCount(0);
  });

  test("sign-in methods say they are methods for ONE account", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#security");

    // AUDIT: account linking is real — one account can hold password, Google
    // and Apple, with server-side token verification, a DB-unique provider
    // subject, step-up on every mutation and last-method protection. So the
    // feature stays and the copy stops implying a second account.
    const card = page.locator("[data-cc-login-methods-card]");
    await expect(card).toContainText("Sign-in methods");
    await expect(card).toContainText("same PROOVRA account");
    await expect(card).not.toContainText("Login methods");
  });

  test("no grey slab: the sections sit on the page background", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#security");

    const cards = page.locator(".set-main .ui-card");
    expect(await cards.count()).toBeGreaterThan(0);
    for (let i = 0; i < (await cards.count()); i++) {
      const bg = await cards.nth(i).evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      // Translucent white, not the muted slab the admin variant paints.
      expect(bg, "a Security section is still a grey slab").not.toBe(
        "rgb(241, 244, 249)",
      );
    }
  });
});

test.describe("settings — one form contract", () => {
  test("selects are the product's own control, not the browser's", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "personal");
    const select = page.locator("[data-settings-preferences] select").first();
    const style = await select.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        appearance: cs.appearance,
        radius: cs.borderTopLeftRadius,
        image: cs.backgroundImage,
        height: el.getBoundingClientRect().height,
      };
    });
    expect(style.appearance).toBe("none");
    expect(style.radius).toBe("10px");
    expect(style.image, "the chevron is ours").toContain("svg");
    expect(style.height).toBeGreaterThanOrEqual(38);
  });

  test("checkboxes and radios are purple, never the browser blue", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#notifications");
    const box = page.locator('.set-main input[type="checkbox"]').first();
    await expect(box).toBeVisible();
    const accent = rgb(
      await box.evaluate((el) => getComputedStyle(el).accentColor),
    );
    // Violet has markedly more blue than green, and real red — the browser's
    // default blue has almost no red at all.
    expect(accent[2]).toBeGreaterThan(accent[1]);
    expect(accent[0], "purple, not blue").toBeGreaterThan(80);
  });

  test("the messaging contact says it is a delivery address", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#notifications");

    // AUDIT: this is `/v1/communications/verify/*` plus a durable channel
    // preference — where evidence requests and reminders are SENT. It is not
    // MFA, not recovery and not step-up. Both it and the security device ask
    // for a phone and send a code, so each has to say which it is.
    const card = page.locator("[data-contact-verification-card]");
    await expect(card).toContainText("Messaging contact");
    await expect(card).toContainText("not used for signing in");
  });
});

test.describe("settings — responsive", () => {
  test("390 keeps one column, a real selector, and no sideways scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSettings(page, "personal", "#security");

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.locator("[data-settings-nav-select]")).toBeVisible();
    // The latest-three default is what keeps this width usable at all.
    await expect(page.locator("[data-cc-session-row]")).toHaveCount(3);
  });
});
