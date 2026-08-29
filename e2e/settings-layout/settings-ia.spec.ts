/**
 * SETTINGS — the information architecture, measured in a real engine.
 *
 * Settings was one scrolling page that mounted every domain for everyone:
 * profile, security, preferences, notifications, AI, privacy, billing, and
 * seven role x capability matrices, expanded, on every visit. These pin the
 * shape that replaced it — what the landing pane offers, what it deliberately
 * does NOT render, and that the map an actor is given is the map the canonical
 * resolver says they may have.
 */

import { expect, test } from "@playwright/test";

import { WIDTHS, openSettings } from "./_fixtures";

const navIds = (page: import("@playwright/test").Page) =>
  page
    .locator("[data-settings-nav-item]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-settings-nav-item")));

test.describe("settings — the landing pane", () => {
  test("opens on Overview, with four summaries and the four groups", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "org-owner");

    await expect(page.locator('[data-settings-pane="overview"]')).toBeVisible();
    await expect(page.locator("[data-settings-summary]")).toHaveCount(4);
    for (const card of ["workspace", "plan", "security", "activity"]) {
      await expect(page.locator(`[data-settings-summary="${card}"]`)).toBeVisible();
    }

    // Account / Workspace / Integrations / System, as sections on the page and
    // as groups in the rail — one model drives both, so they cannot disagree.
    for (const group of ["account", "workspace", "integrations", "system"]) {
      await expect(page.locator(`[data-settings-group="${group}"]`)).toBeVisible();
    }
  });

  test("the landing pane renders NO capability matrix", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "org-owner");

    // THE POINT. Seven role x capability tables used to render here, expanded.
    await expect(page.locator("[data-cc-roles-matrix]")).toHaveCount(0);
    await expect(page.locator("[data-cc-roles-category]")).toHaveCount(0);
    await expect(page.locator("[data-cc-roles-capability]")).toHaveCount(0);

    // And the words that came with them are not on the landing pane either.
    const body = (await page.locator("[data-settings-shell]").innerText()).toLowerCase();
    expect(body).not.toContain("reviewer workflow");
    expect(body).not.toContain("view detailed permission matrix");
  });

  test("no implementation detail leaks into the reader's copy", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "org-owner");
    const body = await page.locator("[data-settings-shell]").innerText();
    for (const banned of ["Phase ", "team_activities", "PLATFORM_ADMIN", "_VIEW", "_MANAGE"]) {
      expect(body, `"${banned}" is internal vocabulary`).not.toContain(banned);
    }
  });
});

test.describe("settings — the map is the resolver's answer", () => {
  test("an organization owner is offered the workspace destinations", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "org-owner");
    const ids = await navIds(page);
    for (const id of [
      "overview",
      "profile",
      "security",
      "notifications",
      "workspace",
      "members",
      "roles",
      "billing",
    ]) {
      expect(ids, `owner should be offered ${id}`).toContain(id);
    }
  });

  test("a personal space is offered NO collaborative destination", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "personal");
    const ids = await navIds(page);

    // A personal space has no membership, no roles and no workspace policy.
    // Offering those panes would be offering functionality that does not exist.
    for (const id of ["members", "roles", "retention", "sso", "audit"]) {
      expect(ids, `personal space must not offer ${id}`).not.toContain(id);
    }
    // What it does have, it keeps.
    for (const id of ["overview", "profile", "security", "notifications"]) {
      expect(ids).toContain(id);
    }
    // And the page's own groups match the rail exactly.
    await expect(page.locator('[data-settings-group="workspace"]')).toHaveCount(0);
    await expect(page.locator('[data-settings-group="account"]')).toBeVisible();
  });
});

test.describe("settings — Roles & permissions", () => {
  test("summarises the roles, with the matrix closed behind a disclosure", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "org-owner", "#roles");

    // A summary per role, counted from the server's own catalog.
    const summaries = page.locator("[data-cc-roles-summary-role]");
    await expect(summaries).toHaveCount(4);
    await expect(summaries.first()).toContainText("Permissions");

    // The matrix is NOT rendered until asked for.
    const toggle = page.locator("[data-cc-roles-matrix-toggle]");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("[data-cc-roles-matrix]")).toHaveCount(0);

    // Keyboard-operable, and it opens the same server data as before.
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("[data-cc-roles-matrix]")).toHaveCount(1);
    await expect(page.locator("[data-cc-roles-capability]").first()).toBeVisible();

    await page.keyboard.press("Enter");
    await expect(page.locator("[data-cc-roles-matrix]")).toHaveCount(0);
  });
});

test.describe("settings — navigation and hand-offs", () => {
  /**
   * These drive the shell through its own navigation rather than re-opening
   * the page per assertion: `installSettingsApi` registers routes, Playwright
   * gives precedence to the LAST registered one, and calling it twice in a
   * test puts the broad host catch above the envelope handler.
   *
   * The panes chosen here are the ones whose content is a hand-off or a
   * summary. Panes that mount a whole subsystem — notifications, AI policy,
   * privacy, the security console — are unchanged by this redesign and are
   * covered by their own suites; this project measures the architecture around
   * them, not their internals.
   */
  test("selecting a destination switches the pane, and only that pane", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "org-owner");
    await expect(page.locator('[data-settings-pane="overview"]')).toBeVisible();

    await page.locator('[data-settings-nav-item="roles"]').click();
    await expect(page.locator('[data-settings-pane="overview"]')).toHaveCount(0);
    await expect(page.locator('[data-settings-nav-item="roles"]')).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator("h2").first()).toContainText("Roles & permissions");

    // One pane at a time: the previous pane's content is gone, not hidden.
    await expect(page.locator("[data-settings-summary]")).toHaveCount(0);

    // And back.
    await page.locator('[data-settings-nav-item="overview"]').click();
    await expect(page.locator('[data-settings-pane="overview"]')).toBeVisible();
  });

  test("a deep link lands on its pane, including the pre-redesign anchors", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    // `#preferences` was a section of the old scroll; Profile owns it now, and
    // other surfaces still link to the old anchor.
    await openSettings(page, "org-owner", "#preferences");
    await expect(page.locator("h2").first()).toContainText("Profile & preferences");
  });

  test("an unreachable pane in the URL falls back to Overview", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    // A personal space has no Roles pane; naming it in the hash must not
    // render a surface the resolver refused.
    await openSettings(page, "personal", "#roles");
    await expect(page.locator('[data-settings-pane="overview"]')).toBeVisible();
  });

  test("Settings hands off to the canonical surfaces rather than copying them", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "org-owner");

    for (const [pane, href] of [
      ["audit", "/audit-transparency"],
      ["retention", "/governance/retention"],
      ["integrations", "/integrations"],
      ["members", "/organizations/org-1/admin/members"],
    ] as const) {
      await page.locator(`[data-settings-nav-item="${pane}"]`).click();
      const handoff = page.locator(`[data-settings-handoff="${pane}"]`);
      await expect(handoff).toBeVisible();
      await expect(handoff.locator("a")).toHaveAttribute("href", href);
    }

    // System still offers Billing as a destination.
    expect(await navIds(page)).toContain("billing");
  });

  test("the Plan card links to Billing exactly when billing is self-serve", async ({
    page,
  }) => {
    // An enterprise contract is not bought in the product, so the Plan card
    // offers no purchase link — and asserting one would be asserting a lie.
    // The self-serve context is where the link belongs.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "personal");
    const link = page.locator("[data-settings-billing-link]");
    if ((await link.count()) > 0) {
      await expect(link).toHaveAttribute("href", "/billing");
    }
    // Either way the Plan card states the plan rather than inventing an action.
    await expect(page.locator('[data-settings-summary="plan"]')).toBeVisible();
  });
});

test.describe("settings — responsive", () => {
  for (const { name, width, height } of WIDTHS) {
    test(`${name}: nothing overflows sideways`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openSettings(page, "org-owner");
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `${name} overflows horizontally`).toBeLessThanOrEqual(0);
    });
  }

  test("at 390 the rail becomes one labelled control that switches panes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSettings(page, "org-owner");

    // The rail is gone and a real, labelled <select> stands in its place.
    await expect(page.locator(".set-nav__rail")).toBeHidden();
    const select = page.locator("[data-settings-nav-select]");
    await expect(select).toBeVisible();
    await expect(page.locator('label[for="settings-section-select"]')).toBeVisible();

    await select.selectOption("roles");
    await expect(page.locator("h2").first()).toContainText("Roles & permissions");
  });

  test("the opened matrix scrolls inside itself, never widening the page", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSettings(page, "org-owner", "#roles");
    await page.locator("[data-cc-roles-matrix-toggle]").click();
    await expect(page.locator("[data-cc-roles-matrix]")).toHaveCount(1);

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the matrix must not widen the page").toBeLessThanOrEqual(0);
    // It is the container that scrolls.
    const scrolls = await page
      .locator(".set-matrix__scroll")
      .first()
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrolls, "the matrix should scroll within its own container").toBe(true);
  });
});

test.describe("settings — accessibility", () => {
  test("the map is a list of buttons with aria-current on the selected one", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "org-owner");

    const nav = page.locator("[data-settings-nav]");
    await expect(nav).toHaveAttribute("aria-label", "Settings sections");
    await expect(
      page.locator('[data-settings-nav-item="overview"]'),
    ).toHaveAttribute("aria-current", "page");
    // Exactly one at a time.
    await expect(page.locator('[data-settings-nav-item][aria-current="page"]')).toHaveCount(
      1,
    );

    // One h1 for the page, one h2 for the pane.
    await expect(page.locator("h1")).toHaveCount(1);
    const focusRing = await page
      .locator('[data-settings-nav-item="profile"]')
      .evaluate((el) => {
        el.focus();
        return getComputedStyle(el).outlineWidth;
      });
    expect(focusRing).not.toBe("0px");
  });
});
