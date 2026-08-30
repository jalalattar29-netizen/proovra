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
  test("a personal space offers exactly Overview, Security, Notifications, Privacy & data", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "personal");

    // Profile & preferences was a second page for the same subject; General
    // held one sentence about AI assistance and a link to pricing; Billing &
    // plan restated four facts and linked to the page that owns them. None of
    // them come back.
    //
    // Privacy & data is the one addition, and it is not a fourth tab for the
    // sake of it: cookie consent, policy acceptance, the personal data export
    // and account closure are account-scoped controls that had no reachable
    // destination at all — see `settings-privacy.spec.ts`.
    expect(await navIds(page)).toEqual([
      "overview",
      "security",
      "notifications",
      "privacy",
    ]);
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
    // The preference control is the canonical listbox, not a native select.
    await expect(
      page.locator('[data-settings-preferences] [role="combobox"]').first(),
    ).toBeVisible();

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

test.describe("settings — the Security destination", () => {
  /**
   * WHAT THIS REPLACES.
   *   Before the pane redesign, Settings was one scrolling console and a
   *   destination was a DOM anchor. `__tests__/phase-7c-internal-ux` pinned
   *   `id="security"` in the page source, which proved the attribute existed
   *   and nothing else — a regex over source cannot tell you that selecting
   *   Security renders Security. The anchor went with the scroll it served.
   *   What it stood for is asserted here instead, as behaviour, in a real
   *   engine: the destination is offered, choosing it switches the pane,
   *   the map marks it as current, and the canonical surface mounts.
   */
  test("is offered, selects, marks itself current, and mounts", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal");

    // Offered.
    const item = page.locator('[data-settings-nav-item="security"]');
    await expect(item).toBeVisible();

    // Not yet rendered — one pane at a time, so this is absence, not hiding.
    await expect(page.locator("[data-cc-login-methods-card]")).toHaveCount(0);

    await item.click();

    // The map marks exactly one destination current, and it is this one.
    await expect(item).toHaveAttribute("aria-current", "page");
    await expect(
      page.locator('[data-settings-nav-item][aria-current="page"]'),
    ).toHaveCount(1);

    // The heading is the pane's, and the landing pane is gone rather than
    // scrolled past.
    await expect(page.locator("h2").first()).toContainText("Security");
    await expect(page.locator('[data-settings-pane="overview"]')).toHaveCount(0);

    // And the canonical surface mounted — `PersonalSecuritySections`, not a
    // Settings-local copy of it.
    await expect(page.locator("[data-cc-login-methods-card]")).toBeVisible();
    await expect(page.locator("[data-cc-session-row]").first()).toBeVisible();
  });

  test("the pre-pane deep link still lands on Security", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    // THE POINT OF THE OLD ANCHOR. Other surfaces link to `/settings#security`
    // and must keep arriving at personal security — by pane resolution now
    // rather than by scrolling to an element id.
    await openSettings(page, "personal", "#security");

    await expect(page.locator("h2").first()).toContainText("Security");
    await expect(
      page.locator('[data-settings-nav-item="security"]'),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.locator("[data-cc-login-methods-card]")).toBeVisible();
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
  test("every Settings selector is the canonical listbox, not a native select", async ({
    page,
  }) => {
    // THE DECISION. A native <select> can be styled closed and not open: the
    // option list is drawn by the OS. Settings was the last authenticated
    // surface still on native selects while 24 others already used the
    // canonical AppListbox, so the product's own menu appeared everywhere
    // except here. Asserted as an ABSENCE plus a presence, because a partial
    // migration is the failure mode that looks fine in a screenshot.
    for (const hash of ["", "#notifications"]) {
      await page.setViewportSize({ width: 1440, height: 1200 });
      await openSettings(page, "personal", hash);
      expect(
        await page.locator(".set-main select, .set-nav select").count(),
        `${hash || "#overview"} still has a native select`,
      ).toBe(0);
    }

    await openSettings(page, "personal");
    const trigger = page
      .locator('[data-cc-preferences-locale-select] [role="combobox"]')
      .first();
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    const height = await trigger.evaluate(
      (el) => el.getBoundingClientRect().height,
    );
    expect(height, "a real target").toBeGreaterThanOrEqual(38);
  });

  test("the open menu is the product's surface, and selecting commits", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "personal");

    const trigger = page
      .locator('[data-cc-preferences-locale-select] [role="combobox"]')
      .first();
    await trigger.click();

    const popup = page.locator('[role="listbox"]');
    await expect(popup).toBeVisible();

    // The menu is ours: an opaque product surface with a real border and a
    // shadow, not a transparent list inheriting the page.
    const paint = await popup.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        bg: cs.backgroundColor,
        border: cs.borderTopWidth,
        shadow: cs.boxShadow,
        radius: cs.borderTopLeftRadius,
      };
    });
    expect(paint.bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(paint.border).not.toBe("0px");
    expect(paint.shadow).not.toBe("none");
    expect(parseFloat(paint.radius)).toBeGreaterThan(0);

    // It is not clipped by the panel it opens inside.
    const clipped = await popup.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.bottom > window.innerHeight + 1 ||
        r.right > window.innerWidth + 1 ||
        r.left < -1
      );
    });
    expect(clipped, "the menu is clipped or off-screen").toBe(false);

    // The selected option is marked for a screen reader, not only painted.
    await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveCount(
      1,
    );
  });

  test("checkboxes and radios are drawn by us, and check purple", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#notifications");

    // NOT `accent-color`. That only re-tints the platform control, so the box
    // keeps the host OS shape, size and focus ring and Settings still reads as
    // three different products. These are real inputs — same element, same
    // keyboard behaviour, same ARIA — with the box itself drawn in CSS.
    const box = page.locator('.set-main input[type="checkbox"]:checked').first();
    await expect(box).toBeVisible();

    const paint = await box.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        appearance: cs.appearance,
        bg: cs.backgroundColor,
        size: Math.round(el.getBoundingClientRect().width),
        tick: getComputedStyle(el, "::before").content,
      };
    });
    expect(paint.appearance, "the platform control is replaced").toBe("none");
    expect(
      paint.size,
      "a real target, not the 13px platform default",
    ).toBeGreaterThanOrEqual(16);
    expect(paint.tick, "the tick is drawn, not the platform glyph").not.toBe("none");

    // Checked is the product violet: markedly more blue than green, with real
    // red in it — the browser's default blue has almost none.
    const fill = rgb(paint.bg);
    expect(fill[2]).toBeGreaterThan(fill[1]);
    expect(fill[0], "purple, not blue").toBeGreaterThan(80);

    // The radio is the same control, drawn round.
    const radio = page.locator('.set-main input[type="radio"]').first();
    if ((await radio.count()) > 0) {
      const r = await radio.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { appearance: cs.appearance, radius: cs.borderTopLeftRadius };
      });
      expect(r.appearance).toBe("none");
      expect(r.radius, "a radio is round").toBe("50%");
    }
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
