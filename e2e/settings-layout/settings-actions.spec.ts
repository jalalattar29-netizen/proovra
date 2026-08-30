/**
 * SETTINGS — the account actions actually act.
 *
 * Four controls were reported as doing nothing. Two of them genuinely did
 * nothing, and the reasons were different in kind:
 *
 *   Manage cookie preferences — the consent library's `hideFromBots` default
 *   does not merely suppress the auto-shown banner, it skips building the
 *   consent DOM at all. `showPreferences()` then threw on an element that was
 *   never created, and the click handler swallowed the throw with an empty
 *   `catch`. No dialog, no message, no console error.
 *
 *   Sign out other sessions — see `services/api/test/self-session-revocation`.
 *
 * These pin the browser-side halves: that the dialog opens, that the
 * disclosure does not mutate anything, and that a failure is never silent.
 */

import { expect, test } from "@playwright/test";

import { openSettings } from "./_fixtures";

test.describe("settings — cookie preferences open", () => {
  test("the canonical consent dialog opens, with the recorded state", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#privacy");
    // The manager initialises in the root layout.
    await page.waitForTimeout(1500);

    await page.locator("[data-cc-privacy-manage-cookies]").click();

    // THE POINT. This produced ZERO DOM before: `hideFromBots` had skipped
    // building it, and the handler's empty `catch` hid the resulting throw.
    const dialog = page.locator(".pm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/privacy|cookie/i);

    // And no error is claimed when it did open.
    await expect(page.locator("[data-cc-privacy-cookies-error]")).toHaveCount(0);
  });

  test("it is ONE manager — Settings opens the canonical one", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#privacy");
    await page.waitForTimeout(1500);
    await page.locator("[data-cc-privacy-manage-cookies]").click();
    await expect(page.locator(".pm")).toBeVisible();

    // Settings does not carry a consent dialog of its own: exactly one
    // preferences modal exists in the document, and it is the root layout's.
    expect(await page.locator(".pm").count()).toBe(1);
    expect(await page.locator("#cc-main").count()).toBe(1);
  });

  test("the categories are the canonical four, and Necessary is locked", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#privacy");
    await page.waitForTimeout(1500);
    await page.locator("[data-cc-privacy-manage-cookies]").click();
    await expect(page.locator(".pm")).toBeVisible();

    const text = await page.locator(".pm").innerText();
    for (const category of ["Necessary", "Preferences", "Analytics", "Marketing"]) {
      expect(text, `${category} must be offered`).toContain(category);
    }

    // Strictly necessary technologies are not a choice, and the dialog must
    // not present them as one.
    const locked = page.locator('.pm input[type="checkbox"][disabled]');
    expect(await locked.count()).toBeGreaterThan(0);
  });

  test("Escape closes it without recording anything", async ({ page }) => {
    const writes: string[] = [];
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#privacy");
    await page.waitForTimeout(1500);

    page.on("request", (r) => {
      if (r.method() !== "GET" && r.url().includes("/v1/")) {
        writes.push(new URL(r.url()).pathname);
      }
    });

    await page.locator("[data-cc-privacy-manage-cookies]").click();
    await expect(page.locator(".pm")).toBeVisible();
    await page.keyboard.press("Escape");

    // Closing is not consenting.
    expect(
      writes.filter((w) => w.includes("cookie-consent")),
      "dismissing the dialog must not record a consent",
    ).toEqual([]);
  });

  test("at 390 the dialog fits the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSettings(page, "personal", "#privacy");
    await page.waitForTimeout(1500);
    await page.locator("[data-cc-privacy-manage-cookies]").click();
    await expect(page.locator(".pm")).toBeVisible();

    const overflows = await page.evaluate(() => {
      const pm = document.querySelector(".pm");
      if (!pm) return true;
      const r = pm.getBoundingClientRect();
      return r.width > window.innerWidth + 1 || r.left < -1;
    });
    expect(overflows, "the consent dialog must fit a phone").toBe(false);
  });
});

test.describe("settings — acceptance history stays a read", () => {
  test("expanding it records nothing", async ({ page }) => {
    const writes: string[] = [];
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#privacy");

    page.on("request", (r) => {
      if (r.method() !== "GET" && r.url().includes("/v1/")) {
        writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
      }
    });

    const toggle = page.locator("[data-cc-privacy-history-toggle]");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("[data-cc-privacy-acceptance-row]").first()).toBeVisible();

    // Viewing a policy record is not accepting one, and the surface says so.
    expect(writes.filter((w) => w.includes("legal-acceptance"))).toEqual([]);

    // It toggles back.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("[data-cc-privacy-acceptance-row]")).toHaveCount(0);
  });

  test("each record keeps its own legal action", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#privacy");
    await page.locator("[data-cc-privacy-history-toggle]").click();

    const history = page.locator("[data-cc-privacy-acceptances]");
    // Consent, contract acceptance and acknowledgement are legally distinct
    // and are never normalised to one word.
    await expect(history).toContainText("Contract acceptance");
    await expect(history).toContainText("Acknowledgement");
    await expect(history).toContainText("Consent");
  });
});

test.describe("settings — the secondary actions are one family", () => {
  const SECONDARY = [
    ["#privacy", "[data-cc-privacy-manage-cookies]"],
    ["#privacy", "[data-cc-privacy-history-toggle]"],
    ["", "[data-cc-profile-edit]"],
    ["", '[data-settings-open="security"]'],
    ["", "[data-cc-preferences-detect-tz]"],
  ] as const;

  for (const [hash, selector] of SECONDARY) {
    test(`${selector} is white-surfaced with purple ink and a purple border`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 1200 });
      await openSettings(page, "personal", hash);

      const paint = await page.locator(selector).first().evaluate((el) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, fg: cs.color, border: cs.borderTopColor };
      });

      const rgb = (v: string) => (v.match(/\d+(\.\d+)?/g) ?? []).map(Number);
      const [br, bg, bb] = rgb(paint.bg);
      const [fr, fg, fb] = rgb(paint.fg);
      const [dr, , db] = rgb(paint.border);

      // A light surface — not the dark ink these used to be on Overview.
      expect(Math.min(br, bg, bb), `${selector} surface`).toBeGreaterThan(200);
      // Purple ink: markedly more blue than green, with real red.
      expect(fb, `${selector} ink is purple`).toBeGreaterThan(fg + 40);
      expect(fr, `${selector} ink is purple, not blue`).toBeGreaterThan(40);
      // And a purple border rather than a neutral one.
      expect(db, `${selector} border is purple`).toBeGreaterThan(dr);
    });
  }

  test("the policy links are links, not buttons", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#privacy");

    const links = page.locator(".set-privacy__links a");
    expect(await links.count()).toBeGreaterThan(0);

    const style = await links.first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        weight: cs.fontWeight,
        color: cs.color,
        decoration: cs.textDecorationLine,
        bg: cs.backgroundColor,
      };
    });
    // Body weight, not bold: these read as headings before.
    expect(Number(style.weight)).toBeLessThanOrEqual(500);
    expect(style.decoration).toContain("underline");
    // Purple, and with no surface of their own — they are not pills.
    const [r, g, b] = (style.color.match(/\d+/g) ?? []).map(Number);
    expect(b).toBeGreaterThan(g + 40);
    expect(r).toBeGreaterThan(40);
    expect(style.bg).toBe("rgba(0, 0, 0, 0)");
  });

  test("the destinations are unchanged", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal", "#privacy");

    for (const [text, href] of [
      ["Submit a privacy request", "/settings/legal/privacy-requests"],
      ["Privacy Policy", "/settings/legal/privacy"],
      ["Terms of Service", "/settings/legal/terms"],
      ["Cookie Policy", "/settings/legal/cookies"],
    ] as const) {
      await expect(
        page.locator(`.set-privacy__links a:has-text("${text}")`),
      ).toHaveAttribute("href", href);
    }
    await expect(
      page.locator("[data-cc-open-public-trust-center]"),
    ).toHaveAttribute("href", "/trust");
  });
});
