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

  /*
   * WHAT CHANGED IN THE PRODUCT, AND WHO DECIDED IT.
   *
   * These five were asserted as "white-surfaced with PURPLE ink" — a local
   * Settings treatment. The day after this spec was written, 553dc2e5
   * (2026-08-31, "fix(web): match evidence secondary action states") moved
   * every one of them onto the product's canonical
   * `.app-secondary-action .app-secondary-action--lg`, and wrote down the
   * rest state it measured off the Evidence Library header:
   *
   *   "REST background rgba(255,255,255,0.9), ink rgb(52,64,84),
   *    border 1px solid rgba(124,58,237,0.24), 44px"
   *
   * The primitive states the rule — "Secondary action = light surface with
   * dark-neutral label text (§2)" — and keeps purple ink for a separate
   * `--accent` modifier these controls do not carry. c3a92a42 (2026-09-10)
   * removed the last local paint: "The control carries `.app-secondary-action`
   * now, so its surface, ink, border and radius come from the canonical
   * action". `apps/web/__tests__/settings-billing-canonical-actions.test.ts`
   * pins all of it at source level.
   *
   * So neutral ink is the decision, not a regression. The old check compared
   * colour channels ("more blue than green"); this one asserts the canonical
   * family EXACTLY, and that all five are the same paint — which is what "one
   * family" meant in the first place.
   */
  const CANONICAL_SECONDARY = {
    surface: "rgba(255, 255, 255, 0.9)",
    border: "rgba(124, 58, 237, 0.24)",
    borderWidth: "1px",
    height: "44px",
    radius: "10px",
  } as const;

  const readPaint = (
    page: import("@playwright/test").Page,
    selector: string,
  ) =>
    page.locator(selector).first().evaluate((el) => {
      const cs = getComputedStyle(el);
      // The token, resolved by the browser in this element's own context.
      const probe = document.createElement("span");
      probe.style.color = "var(--app-ink-label)";
      el.parentElement?.appendChild(probe);
      const inkLabel = getComputedStyle(probe).color;
      probe.remove();
      return {
        family: el.classList.contains("app-secondary-action"),
        large: el.classList.contains("app-secondary-action--lg"),
        // Any tone or fill modifier (--accent, --orange, --danger, --filled)
        // would make this a different member of the family.
        toned: Array.from(el.classList).filter(
          (c) =>
            c.startsWith("app-secondary-action--") &&
            c !== "app-secondary-action--lg",
        ),
        inkLabel,
        surface: cs.backgroundColor,
        ink: cs.color,
        border: cs.borderTopColor,
        borderWidth: cs.borderTopWidth,
        height: cs.height,
        radius: cs.borderTopLeftRadius,
      };
    });

  for (const [hash, selector] of SECONDARY) {
    test(`${selector} is the canonical secondary action: white surface, neutral label ink, lavender border`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 1200 });
      await openSettings(page, "personal", hash);

      const paint = await readPaint(page, selector);

      expect(paint.family, `${selector} carries .app-secondary-action`).toBe(true);
      expect(paint.large, `${selector} carries --lg`).toBe(true);
      expect(paint.toned, `${selector} carries no tone or fill modifier`).toEqual([]);

      // A light surface — not the dark ink these used to be on Overview.
      expect(paint.surface, `${selector} surface`).toBe(CANONICAL_SECONDARY.surface);
      // The ink IS the label token, and the token is the documented neutral.
      expect(paint.inkLabel, "--app-ink-label must resolve").toBe("rgb(52, 64, 84)");
      expect(paint.ink, `${selector} ink is --app-ink-label`).toBe(paint.inkLabel);
      // And the lavender hairline rather than a neutral one. Unchanged.
      expect(paint.border, `${selector} border`).toBe(CANONICAL_SECONDARY.border);
      expect(paint.borderWidth).toBe(CANONICAL_SECONDARY.borderWidth);
      expect(paint.height).toBe(CANONICAL_SECONDARY.height);
      expect(paint.radius).toBe(CANONICAL_SECONDARY.radius);
    });
  }

  test("all five resolve to one identical paint", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });

    const paints: Array<Awaited<ReturnType<typeof readPaint>>> = [];
    let opened: string | null = null;
    for (const [hash, selector] of SECONDARY) {
      if (opened !== hash) {
        await openSettings(page, "personal", hash);
        opened = hash;
      }
      paints.push(await readPaint(page, selector));
    }

    expect(paints).toHaveLength(5);
    // One family means one paint: every control equals the first, field for
    // field, so a sixth local treatment cannot hide behind a tolerance.
    for (const paint of paints) expect(paint).toEqual(paints[0]);
  });

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
