/**
 * SETTINGS — Privacy & data.
 *
 * WHAT WAS ACTUALLY WRONG.
 *   Cookie consent, policy acceptance, the personal data export and account
 *   closure were never deleted. `PrivacySection` was mounted under the pane
 *   `cases-evidence` — a WORKSPACE destination, offered only when `isOrg`.
 *   Every route behind those controls is `requireAuth` keyed by
 *   `getAuthUserId`, carrying the API's own
 *   `TENANT_SCOPE_EXCEPTION: account_tier_user_scoped`: there is no workspace
 *   dimension to gate on. So account-scoped privacy controls sat behind a
 *   workspace gate, and a personal space — the only scope they have — could
 *   not reach them at all.
 *
 * These pin the destination, the capabilities on it, and the two things a
 * screenshot cannot show: that the disclosure is closed until asked, and that
 * opening it does not write consent.
 */

import { expect, test } from "@playwright/test";

import { openSettings } from "./_fixtures";

const navIds = (page: import("@playwright/test").Page) =>
  page
    .locator("[data-settings-nav-item]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-settings-nav-item")));

test.describe("settings — the Privacy & data destination", () => {
  test("is offered in ACCOUNT, and the retired tabs stay retired", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal");

    const ids = await navIds(page);
    expect(ids).toContain("privacy");

    // It is an ACCOUNT control, not a workspace one — which is the whole
    // reason it was unreachable before.
    const group = await page
      .locator('[data-settings-nav-item="privacy"]')
      .evaluate((el) => el.closest("[data-settings-nav]")?.textContent ?? "");
    expect(group).toContain("Account");
    await expect(page.locator("[data-settings-nav]")).not.toContainText(
      "Cases & evidence",
    );

    // The IA decisions this restoration must not undo.
    for (const gone of ["profile", "preferences", "workspace", "billing"]) {
      expect(ids, `${gone} must not return`).not.toContain(gone);
    }
  });

  test("selecting it renders the four sections in order", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal");

    await page.locator('[data-settings-nav-item="privacy"]').click();
    await expect(page.locator('[data-settings-nav-item="privacy"]')).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator("h2").first()).toContainText("Privacy & data");

    const order = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-cc-privacy-cookies], [data-cc-privacy-policies], [data-cc-privacy-export], [data-cc-privacy-closure]",
        ),
      ).map((e) => e.getAttribute("data-cc-privacy-cookies") !== null
        ? "cookies"
        : e.getAttribute("data-cc-privacy-policies") !== null
          ? "policies"
          : e.getAttribute("data-cc-privacy-export") !== null
            ? "export"
            : "closure"),
    );
    expect(order).toEqual(["cookies", "policies", "export", "closure"]);
  });

  test("the pre-redesign hashes land here, not on Overview", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    // `#privacy` used to fall through to Overview because the pane it named
    // was not offered — a bookmark to a privacy control landed on a page with
    // none of them on it.
    //
    // `openSettings` installs the API and navigates; the rest of the hashes
    // reuse that installation, because registering it again would put its
    // broad host catch ABOVE the handlers it is meant to sit under.
    await openSettings(page, "personal", "#privacy");
    await expect(page.locator("[data-cc-privacy]")).toBeVisible();

    for (const hash of ["#cookies", "#consent", "#export", "#account", "#cases-evidence"]) {
      await page.goto(`/settings${hash}`);
      await page.waitForSelector("[data-settings-shell]");
      await expect(
        page.locator("[data-cc-privacy]"),
        `${hash} should land on Privacy & data`,
      ).toBeVisible();
    }
  });
});

test.describe("settings — privacy preferences", () => {
  test("states the recorded consent and hands off to the one consent manager", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#privacy");

    const card = page.locator("[data-cc-privacy-cookies]");
    await expect(card).toContainText("Privacy preferences");
    // Canonical values from `GET /v1/users/cookie-consent/latest`, not
    // invented categories.
    await expect(card).toContainText("v2026-04-06");
    await expect(card).toContainText("Necessary, Preferences, Analytics");
    await expect(card).not.toContainText("Marketing");

    // The action dispatches to the handler installed by `CookieConsentInit`
    // in the ROOT layout, which is what the public cookie banner opens too.
    // Settings does not carry a second cookie implementation, so what is
    // asserted is that the one event actually fires.
    await page.evaluate(() => {
      (window as unknown as { __seen: number }).__seen = 0;
      window.addEventListener("proovra:open-cookie-preferences", () => {
        (window as unknown as { __seen: number }).__seen += 1;
      });
    });
    await page.locator("[data-cc-privacy-manage-cookies]").click();
    expect(
      await page.evaluate(() => (window as unknown as { __seen: number }).__seen),
    ).toBe(1);
  });
});

test.describe("settings — policies & consent", () => {
  test("current status is listed per policy, in words as well as colour", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#privacy");

    for (const key of ["terms", "privacy", "cookies"]) {
      const row = page.locator(`[data-cc-legal-status-current-row="${key}"]`);
      await expect(row).toBeVisible();
      // Not colour-only: the state is a word on the row.
      await expect(row).toContainText("Up to date");
      await expect(row).toContainText("v2026-04-06");
    }

    // Green means up to date, and it is real green rather than the ink.
    const tone = await page
      .locator('[data-cc-legal-status-current-row="terms"]')
      .locator("text=Up to date")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    const [r, g, b] = (tone.match(/\d+/g) ?? []).map(Number);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  test("history is collapsed by default, opens on request, and is bounded", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#privacy");

    const toggle = page.locator("[data-cc-privacy-history-toggle]");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // THE POINT. This used to render every record it was given, always open,
    // under a status card that already answers "am I up to date?".
    await expect(page.locator("[data-cc-privacy-acceptance-row]")).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const rows = page.locator("[data-cc-privacy-acceptance-row]");
    expect(await rows.count()).toBeGreaterThan(0);
    expect(await rows.count()).toBeLessThanOrEqual(8);

    // Each record names its policy, what was done, the version and when.
    const first = rows.first();
    await expect(first).toContainText("Terms of Service");
    await expect(first).toContainText("Contract acceptance");
    await expect(first).toContainText("v2026-04-06");

    // Consent, contract acceptance and acknowledgement are legally distinct
    // and are never collapsed into one word.
    await expect(page.locator("[data-cc-privacy-acceptances]")).toContainText(
      "Acknowledgement",
    );
  });

  test("opening the history does not record consent", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });

    const writes: string[] = [];
    await page.route("**/v1/**", async (route) => {
      const req = route.request();
      if (req.method() !== "GET") writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
      await route.fallback();
    });
    await openSettings(page, "personal", "#privacy");

    await page.locator("[data-cc-privacy-history-toggle]").click();
    await expect(page.locator("[data-cc-privacy-acceptance-row]").first()).toBeVisible();

    // A record is written only by an explicit accept. Reading the list is not
    // one, and the copy on the surface says so.
    expect(
      writes.filter((w) => w.includes("legal-acceptance")),
      "viewing the history must not POST an acceptance",
    ).toEqual([]);
    await expect(page.locator("[data-cc-privacy-acceptances]")).toContainText(
      "viewing a policy is never recorded as consent",
    );
  });
});

test.describe("settings — your data", () => {
  test("the export states its real lifecycle and offers the real action", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#privacy");

    const card = page.locator("[data-cc-privacy-export]");
    await expect(card).toContainText("Your data");
    // The contents claimed are the sections `buildAccountExportPackage`
    // actually assembles — no generic GDPR promises.
    await expect(card).toContainText("profile, login methods, preferences");
    await expect(card).toContainText("Evidence and organization records are");

    // A READY package offers a download and NOT a second request: the API
    // refuses a concurrent export with `export_request_active`, so the UI
    // does not offer to start one.
    await expect(page.locator('[data-cc-export-row="READY"]')).toBeVisible();
    await expect(page.locator("[data-cc-export-download]")).toBeVisible();
    await expect(page.locator("[data-cc-export-request]")).toHaveCount(0);
  });

  test("requesting an export calls the canonical endpoint once", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#privacy");

    // Registered AFTER `openSettings`: Playwright gives the LAST registered
    // route the win, so an override installed first would be shadowed by the
    // fixture's own `**/v1/**` handler.
    const posts: string[] = [];
    await page.route("**/v1/identity/data-export", async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        // No active package, so the request action is the section's primary
        // act rather than a second job the API would refuse.
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: [] }),
        });
      }
      posts.push(`${method} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ request: { id: "ex-new", status: "REQUESTED" } }),
      });
    });

    await page.reload();
    await page.waitForSelector("[data-cc-privacy-export]");
    await expect(page.locator("[data-cc-privacy-export]")).toContainText(
      "No exports requested yet",
    );

    await page.locator("[data-cc-export-request]").click();
    await expect
      .poll(() => posts.length, { message: "the canonical POST must fire" })
      .toBe(1);
    expect(posts[0]).toBe("POST /v1/identity/data-export");
  });
});

test.describe("settings — danger zone", () => {
  test("closure states what it does, and does not overstate it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#privacy");

    const zone = page.locator("[data-cc-privacy-closure]");
    await expect(zone).toContainText("Close account");

    // THE SEMANTICS THAT MATTER FOR THIS PRODUCT. Closure anonymizes and
    // archives; `processAccountClosure` never hard-deletes evidence, and
    // saying otherwise here would be telling a custodian their record is
    // gone when it is not.
    await expect(zone).toContainText(
      "Evidence is never deleted by account closure",
    );
    await expect(zone).toContainText("retention and legal-hold rules");
    await expect(zone).toContainText("7-day cancellation window");
    // No promise the backend cannot keep.
    const words = (await zone.innerText()).toLowerCase();
    expect(words).not.toContain("delete all my data");
    expect(words).not.toContain("permanently delete");

    // It is visually separated rather than sitting among ordinary settings.
    const rail = await zone.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(rail).not.toBe("none");
  });

  test("an eligible account gets the destructive action, in white and red", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#privacy");

    const open = page.locator("[data-cc-closure-open]");
    await expect(open).toBeVisible();
    const paint = await open.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, fg: cs.color };
    });
    const fg = (paint.fg.match(/\d+/g) ?? []).map(Number);
    const bg = (paint.bg.match(/\d+/g) ?? []).map(Number);
    expect(fg[0], "the label is red").toBeGreaterThan(fg[1] + 60);
    expect(Math.min(...bg.slice(0, 3)), "on a white ground").toBeGreaterThan(230);
  });

  test("the safeguards survive: typed phrase, and nothing sent until it matches", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#privacy");

    await page.locator("[data-cc-closure-open]").click();
    const form = page.locator("[data-cc-closure-form]");
    await expect(form).toBeVisible();
    // The phrase is validated SERVER-side; the disabled submit is only the
    // first gate, and the step-up proof is verified in the same request.
    await expect(form).toContainText("close my account");

    const submit = page.locator("[data-cc-closure-submit]");
    await expect(submit).toBeDisabled();

    await page.locator("#closure-confirm").fill("close my accont");
    await expect(submit).toBeDisabled();

    await page.locator("#closure-confirm").fill("close my account");
    await expect(submit).toBeEnabled();
  });

  test("a blocker is named, explained, and given the canonical way out", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    // The org-owner fixture carries an active subscription.
    await openSettings(page, "org-owner", "#privacy");

    const blocker = page.locator(
      '[data-cc-closure-blocker="BILLING_SUBSCRIPTION_ACTIVE"]',
    );
    await expect(blocker).toBeVisible();
    await expect(blocker).toContainText("Cancel it before closing your account");

    // Never a disabled button with no reason next to it.
    const action = page.locator(
      '[data-cc-closure-blocker-action="BILLING_SUBSCRIPTION_ACTIVE"]',
    );
    await expect(action).toHaveAttribute("href", "/billing");
    await expect(action).toContainText("Go to Billing");

    const blocked = page.locator("[data-cc-closure-open-blocked]");
    await expect(blocked).toBeVisible();
    await expect(blocked).toBeDisabled();
    await expect(page.locator("[data-cc-privacy-closure]")).toContainText(
      "Resolve the items above to enable account closure",
    );
  });
});

test.describe("settings — Privacy & data responsive", () => {
  for (const [name, width, height] of [
    ["1440", 1440, 1000],
    ["1024", 1024, 900],
    ["768", 768, 900],
    ["390", 390, 844],
  ] as const) {
    test(`${name}: nothing overflows sideways`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openSettings(page, "personal", "#privacy");
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `${name} overflows horizontally`).toBeLessThanOrEqual(0);
    });
  }

  test("at 390 a history record stacks instead of compressing a table", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSettings(page, "personal", "#privacy");
    await page.locator("[data-cc-privacy-history-toggle]").click();

    const cols = await page
      .locator("[data-cc-privacy-acceptance-row]")
      .first()
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns);
    // One column: four columns of record do not fit this width.
    expect(cols.trim().split(/\s+/).length).toBe(1);
  });
});
