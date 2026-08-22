/**
 * THE NOTIFICATIONS TOOLBAR, IN A REAL BROWSER.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROJECT CAN AND CANNOT PROVE
 * ---------------------------------------------------------------------------
 * The API is intercepted here, so nothing below proves the SERVER filters or
 * orders correctly — that is proven against a real PostgreSQL 16 in
 * `services/api/test/inbox-archived-and-sort.integration.test.ts`, which
 * reproduces the reported Archived defect and then fails on it.
 *
 * What only a browser can answer is the other half, and it is the half that
 * was actually broken for the reader: does the page ASK for the right thing,
 * and does it render exactly what came back? The fixture is therefore a
 * faithful implementation of the same contract the integration suite pins — it
 * honours `filter`, `tone` and `sort` — so a page that sent the wrong
 * parameter, or ignored the response, fails here.
 *
 * Everything else in this file is geometry, cascade and keyboard behaviour,
 * which jsdom answers 0 to.
 */

import { expect, test, type Page } from "@playwright/test";

import { installApi, setDirection, VIEWPORTS } from "./_fixtures";

async function openNotifications(
  page: Page,
  opts: { archiveScenario?: boolean } = {},
): Promise<void> {
  await installApi(page, "personal-pro", { archiveScenario: true, ...opts });
  await page.goto("/notifications");
  await page.waitForSelector("[data-inbox-toolbar]", { timeout: 15_000 });
}

/** The item keys currently rendered, in DOM order. */
async function renderedKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("li[data-inbox-item-key]")).map(
      (el) => el.getAttribute("data-inbox-item-key") ?? "",
    ),
  );
}

// ===========================================================================
// §35 — THE ARCHIVED FILTER. Mandatory.
// ===========================================================================

test.describe("Archived returns archived notifications only", () => {
  test("3 active + 2 archived: Archived shows exactly the 2, and no active row", async ({
    page,
  }) => {
    await openNotifications(page);

    // Baseline: the active feed is the three non-archived items.
    const active = await renderedKeys(page);
    expect(active).toHaveLength(3);
    expect(active.every((k) => !k.includes("archived-"))).toBe(true);

    await page.click('[data-inbox-filter-chip="archived"]');
    await expect
      .poll(async () => (await renderedKeys(page)).length)
      .toBe(2);

    const archived = await renderedKeys(page);
    // Exactly two rows, both archived, zero active.
    expect(archived).toHaveLength(2);
    expect(archived.every((k) => k.includes("archived-"))).toBe(true);
    expect(archived.some((k) => k.includes("active-"))).toBe(false);

    // Including the read-but-active row, which is the precise shape of the
    // old defect: `isRead || archived` would have pulled it in here.
    expect(archived).not.toContain("tsa_failure:active-read-high");
  });

  test("switching back to All restores the active feed and excludes the archive", async ({
    page,
  }) => {
    await openNotifications(page);
    await page.click('[data-inbox-filter-chip="archived"]');
    await expect.poll(async () => (await renderedKeys(page)).length).toBe(2);

    await page.click('[data-inbox-filter-chip="all"]');
    await expect.poll(async () => (await renderedKeys(page)).length).toBe(3);

    const keys = await renderedKeys(page);
    // ALL means every NON-archived notification — archiving takes an item out
    // of the normal feed, which is the whole point of the action.
    expect(keys.every((k) => k.startsWith("tsa_failure:active-"))).toBe(true);
  });

  test("the request the page sends carries the canonical filter key", async ({
    page,
  }) => {
    // REGISTERED AFTER the fixture. Playwright runs the most recently added
    // handler first, so an observer installed before `installApi` would sit
    // behind the handler that fulfils the request and never see anything.
    await installApi(page, "personal-pro", { archiveScenario: true });
    const asked: string[] = [];
    await page.route("**/v1/me/inbox?*", (route) => {
      asked.push(new URL(route.request().url()).searchParams.get("filter") ?? "");
      return route.fallback();
    });
    await page.goto("/notifications");
    await page.waitForSelector("[data-inbox-toolbar]", { timeout: 15_000 });
    await page.click('[data-inbox-filter-chip="archived"]');
    await expect.poll(async () => (await renderedKeys(page)).length).toBe(2);
    expect(asked).toContain("archived");
    // The legacy spelling is a compatibility name on the wire, not something
    // this client emits.
    expect(asked).not.toContain("history");
  });

  test("Unread is disabled under Archived, because that view is always empty", async ({
    page,
  }) => {
    await openNotifications(page);
    const unread = page.locator('[data-inbox-filter-chip="unread"]');
    await expect(unread).toBeEnabled();

    await page.click('[data-inbox-filter-chip="archived"]');
    await expect(unread).toBeDisabled();
    // And it says why, rather than being inert with no explanation.
    await expect(unread).toHaveAttribute("title", /always marked read/i);
  });

  test("an empty archive reads as an empty ARCHIVE, not as a broken filter", async ({
    page,
  }) => {
    await installApi(page, "personal-pro", { emptyInbox: true });
    await page.goto("/notifications");
    await page.waitForSelector("[data-state='empty']", { timeout: 15_000 });
    // With nothing at all, the page says the reader is caught up.
    await expect(page.locator("[data-state='empty']")).toContainText(
      /all caught up/i,
    );
  });
});

// ===========================================================================
// §36 — SORTING
// ===========================================================================

test.describe("Sorting", () => {
  const EXPECTED: Record<string, string[]> = {
    // occurredAt: active-unread-critical 11:00, active-read-high 10:00,
    //             active-unread-warning 09:00
    "Newest first": [
      "tsa_failure:active-unread-critical",
      "tsa_failure:active-read-high",
      "tsa_failure:active-unread-warning",
    ],
    "Oldest first": [
      "tsa_failure:active-unread-warning",
      "tsa_failure:active-read-high",
      "tsa_failure:active-unread-critical",
    ],
    "Unread first": [
      "tsa_failure:active-unread-critical",
      "tsa_failure:active-unread-warning",
      "tsa_failure:active-read-high",
    ],
    "Highest severity": [
      "tsa_failure:active-unread-critical",
      "tsa_failure:active-read-high",
      "tsa_failure:active-unread-warning",
    ],
  };

  for (const [label, order] of Object.entries(EXPECTED)) {
    test(`"${label}" reorders the list deterministically`, async ({ page }) => {
      await openNotifications(page);
      await page.click("#inbox-sort-label + * button, .ops-sort__control button");
      await page.click(`role=option[name="${label}"]`);
      await expect.poll(async () => (await renderedKeys(page)).join(",")).toBe(
        order.join(","),
      );
    });
  }

  test("the ordering is requested from the SERVER, not applied in the browser", async ({
    page,
  }) => {
    await installApi(page, "personal-pro", { archiveScenario: true });
    const sorts: string[] = [];
    await page.route("**/v1/me/inbox?*", (route) => {
      sorts.push(new URL(route.request().url()).searchParams.get("sort") ?? "");
      return route.fallback();
    });
    await page.goto("/notifications");
    await page.waitForSelector("[data-inbox-toolbar]", { timeout: 15_000 });
    // The default is sent explicitly — the API's own default is the Operations
    // Center's `priority` ordering, so omitting it would render a list that
    // did not match the control.
    expect(sorts).toContain("newest");

    await page.click(".ops-sort__control button");
    await page.click('role=option[name="Oldest first"]');
    await expect.poll(() => sorts).toContain("oldest");
  });

  test("changing sort resets paging rather than paging into the middle", async ({
    page,
  }) => {
    await installApi(page, "personal-pro", { archiveScenario: true });
    const cursors: Array<string | null> = [];
    await page.route("**/v1/me/inbox?*", (route) => {
      cursors.push(new URL(route.request().url()).searchParams.get("cursor"));
      return route.fallback();
    });
    await page.goto("/notifications");
    await page.waitForSelector("[data-inbox-toolbar]", { timeout: 15_000 });
    await page.click(".ops-sort__control button");
    await page.click('role=option[name="Oldest first"]');
    await expect.poll(async () => (await renderedKeys(page)).length).toBe(3);
    // Every request made after a sort change starts from the beginning.
    expect(cursors.every((c) => c === null)).toBe(true);
  });
});

// ===========================================================================
// §10–§14 — THE TOOLBAR ITSELF
// ===========================================================================

test.describe("The filter toolbar is compact, not a wall of pills", () => {
  test("exactly three quick filters are permanently visible", async ({
    page,
  }) => {
    await openNotifications(page);
    const quick = page.locator("[data-inbox-quick-filters] button");
    await expect(quick).toHaveCount(3);
    await expect(quick.nth(0)).toHaveText("All");
    await expect(quick.nth(1)).toHaveText("Unread");
    await expect(quick.nth(2)).toHaveText("Archived");

    // And the old permanent overflow row is gone entirely.
    await expect(page.locator("[data-inbox-secondary-filters]")).toHaveCount(0);
    await expect(
      page.locator('[data-action="toggle-more-filters"]'),
    ).toHaveCount(0);
  });

  test("advanced filters live in a grouped panel behind one control", async ({
    page,
  }) => {
    await openNotifications(page);
    await expect(page.locator("[data-inbox-filters-panel]")).toHaveCount(0);

    await page.click('[data-action="toggle-advanced-filters"]');
    const panel = page.locator("[data-inbox-filters-panel]");
    await expect(panel).toBeVisible();

    // Grouped, with headings — not one undifferentiated list.
    const groups = panel.locator("[data-inbox-filter-group]");
    expect(await groups.count()).toBeGreaterThan(1);
    for (const heading of await panel
      .locator(".ops-filters-group__label")
      .allTextContents()) {
      expect(heading.trim().length).toBeGreaterThan(0);
    }
  });

  test("the Filters control carries a count, and Clear filters clears it", async ({
    page,
  }) => {
    await openNotifications(page);
    const trigger = page.locator('[data-action="toggle-advanced-filters"]');
    await expect(trigger.locator(".ops-filters-count")).toHaveCount(0);

    await trigger.click();
    await page.click('[data-inbox-filters-panel] [data-inbox-filter-chip="integrity"]');
    await expect(trigger.locator(".ops-filters-count")).toHaveText("1");

    // A quick filter is the page's own state, not an applied filter — it must
    // not inflate the badge.
    await page.click('[data-action="close-advanced-filters"]');
    await page.click('[data-inbox-filter-chip="unread"]');
    await expect(trigger.locator(".ops-filters-count")).toHaveCount(0);
  });

  test("active filters surface as removable chips, not as a permanent row", async ({
    page,
  }) => {
    await openNotifications(page);
    await expect(page.locator("[data-inbox-active-filters]")).toHaveCount(0);

    await page.click('[data-action="toggle-advanced-filters"]');
    await page.click('[data-inbox-filters-panel] [data-inbox-filter-chip="integrity"]');
    await page.click('[data-action="close-advanced-filters"]');

    const chips = page.locator("[data-inbox-active-filters] .ops-active-chip");
    await expect(chips).toHaveCount(1);

    // Each remove control names the filter it removes.
    const remove = page.locator('[data-action="remove-filter"]').first();
    await expect(remove).toHaveAttribute("aria-label", /Remove .+ filter/);
    await remove.click();
    await expect(page.locator("[data-inbox-active-filters]")).toHaveCount(0);
  });

  test("Escape closes the panel and returns focus to the control that opened it", async ({
    page,
  }) => {
    await openNotifications(page);
    await page.click('[data-action="toggle-advanced-filters"]');
    await expect(page.locator("[data-inbox-filters-panel]")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("[data-inbox-filters-panel]")).toHaveCount(0);
    const focused = await page.evaluate(() =>
      document.activeElement?.getAttribute("data-action"),
    );
    expect(focused).toBe("toggle-advanced-filters");
  });

  test("the whole toolbar is reachable by keyboard alone", async ({ page }) => {
    await openNotifications(page);
    const reached = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll(
          "[data-inbox-toolbar] button, [data-inbox-toolbar] [role='combobox']",
        ),
      ) as HTMLElement[];
      return nodes.every((n) => {
        n.focus();
        return document.activeElement === n || n.contains(document.activeElement);
      });
    });
    expect(reached).toBe(true);
  });
});

// ===========================================================================
// §29–§30 — HIERARCHY AND RESULT COUNT
// ===========================================================================

test("the page reads title → metrics → toolbar → list, in that order", async ({
  page,
}) => {
  await openNotifications(page);
  const order = await page.evaluate(() => {
    const y = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top) : Number.NaN;
    };
    return {
      title: y("[data-notifications-title]"),
      metrics: y("[data-notifications-summary]"),
      toolbar: y("[data-inbox-toolbar]"),
      list: y("[data-inbox-items]"),
    };
  });
  expect(order.title).toBeLessThan(order.metrics);
  expect(order.metrics).toBeLessThan(order.toolbar);
  expect(order.toolbar).toBeLessThan(order.list);
});

test("the result count speaks about notifications, and about the archive", async ({
  page,
}) => {
  await openNotifications(page);
  const showing = page.locator("[data-inbox-showing-text]");
  await expect(showing).toContainText("notifications");
  await expect(showing).not.toContainText(" items");

  await page.click('[data-inbox-filter-chip="archived"]');
  await expect.poll(async () => (await renderedKeys(page)).length).toBe(2);
  await expect(showing).toContainText(/archived notifications/i);
});

// ===========================================================================
// §1 — THE TITLE ICON
// ===========================================================================

test("the title icon is the Cases primitive, decorative, and beside the title", async ({
  page,
}) => {
  await openNotifications(page);
  const measured = await page.evaluate(() => {
    const icon = document.querySelector(".app-title-icon") as HTMLElement | null;
    const title = document.querySelector(
      "[data-notifications-title]",
    ) as HTMLElement | null;
    if (!icon || !title) return null;
    const ic = icon.getBoundingClientRect();
    const tc = title.getBoundingClientRect();
    const cs = getComputedStyle(icon);
    return {
      hidden: icon.getAttribute("aria-hidden"),
      hasGlyph: Boolean(icon.querySelector("svg")),
      width: Math.round(ic.width),
      height: Math.round(ic.height),
      radius: cs.borderTopLeftRadius,
      // The three properties that make this the CASES surface rather than a
      // rounded box of the same size: the two-stop gradient, the violet
      // hairline, and the inner top highlight. All three are the values the
      // /cases title has shipped with, lifted into the primitive unchanged.
      background: cs.backgroundImage,
      border: cs.borderTopColor + " " + cs.borderTopWidth,
      inset: cs.boxShadow,
      // Vertically centred on the heading — a title glyph, not a button
      // parked above or below the words.
      centreDelta: Math.abs(
        ic.top + ic.height / 2 - (tc.top + tc.height / 2),
      ),
      // And it sits on the inline-start side, touching the title.
      gap: Math.round(tc.left - ic.right),
    };
  });
  expect(measured, "no title icon rendered").not.toBeNull();
  expect(measured!.hidden).toBe("true");
  expect(measured!.hasGlyph).toBe(true);
  expect(measured!.width).toBe(42);
  expect(measured!.height).toBe(42);
  expect(measured!.radius).toBe("12px");
  expect(measured!.centreDelta).toBeLessThanOrEqual(2);
  expect(measured!.gap).toBe(12);
  expect(measured!.background).toBe(
    "linear-gradient(145deg, rgba(91, 79, 233, 0.1), rgba(73, 184, 255, 0.08))",
  );
  expect(measured!.border).toBe("rgba(91, 79, 233, 0.16) 1px");
  expect(measured!.inset).toBe("rgba(255, 255, 255, 0.8) 0px 1px 0px 0px inset");
});

// ===========================================================================
// §3–§8 — THE METRIC TONES, resolved from canonical tokens
// ===========================================================================

test("metric cards lead with All and resolve the canonical tones", async ({
  page,
}) => {
  await openNotifications(page);
  const cards = await page.evaluate(() => {
    const norm = (v: string) => v.replace(/\s+/g, "").toLowerCase();
    return Array.from(
      document.querySelectorAll("[data-notifications-metric]"),
    ).map((el) => {
      const cs = getComputedStyle(el as HTMLElement);
      const value = el.querySelector(
        ".app-metric-card__value",
      ) as HTMLElement | null;
      return {
        key: el.getAttribute("data-notifications-metric"),
        tone: norm(cs.getPropertyValue("--app-metric-tone")),
        valueColor: value ? norm(getComputedStyle(value).color) : "",
      };
    });
  });

  // ORDER — All is leftmost in LTR.
  expect(cards.map((c) => c.key)).toEqual([
    "all",
    "unread",
    "critical",
    "high",
    "warning",
    "info",
  ]);

  // TONES — each is the canonical token's value, and the number wears it.
  const expected: Record<string, string> = {
    all: "#0f172a", // --ink-primary   : the darkest neutral
    unread: "#6d28d9", // --accent-600 : brand purple
    critical: "#2563eb", // --info     : canonical blue
    high: "#ea580c", // --orange-500   : standard orange
    warning: "#dc2626", // --error    : canonical red
    info: "#475569", // --ink-secondary: neutral informational
  };
  const rgb: Record<string, string> = {
    "#0f172a": "rgb(15,23,42)",
    "#6d28d9": "rgb(109,40,217)",
    "#2563eb": "rgb(37,99,235)",
    "#ea580c": "rgb(234,88,12)",
    "#dc2626": "rgb(220,38,38)",
    "#475569": "rgb(71,85,105)",
  };
  for (const card of cards) {
    const want = expected[card.key!]!;
    expect(card.tone, `${card.key} tone`).toBe(want);
    expect(card.valueColor, `${card.key} number colour`).toBe(rgb[want]);
  }
});

test("no metric tone is silver — All is ink, not a hairline", async ({
  page,
}) => {
  await openNotifications(page);
  // The regression this replaces: `All` painted `--border-strong`, a
  // 14%-alpha hairline, so the leading number read as a disabled control.
  const alpha = await page.evaluate(() => {
    const el = document.querySelector(
      '[data-notifications-metric="all"] .app-metric-card__value',
    ) as HTMLElement | null;
    return el ? getComputedStyle(el).color : "";
  });
  expect(alpha).not.toMatch(/rgba\([^)]*,\s*0?\.\d+\)/);
});

// ===========================================================================
// §25 / §34 — RESPONSIVE + RTL
// ===========================================================================

for (const vp of VIEWPORTS) {
  for (const dir of ["ltr", "rtl"] as const) {
    test(`toolbar survives ${vp.name} / ${dir} without sideways scroll`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openNotifications(page);
      await setDirection(page, dir);

      const measured = await page.evaluate(() => {
        const doc = document.documentElement;
        const quick = document.querySelector(
          "[data-inbox-quick-filters]",
        ) as HTMLElement | null;
        const controls = document.querySelector(
          ".ops-toolbar__controls",
        ) as HTMLElement | null;
        return {
          overflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
          quickVisible: quick ? quick.getBoundingClientRect().height > 0 : false,
          controlsVisible: controls
            ? controls.getBoundingClientRect().height > 0
            : false,
        };
      });
      expect(measured.overflow, "horizontal page overflow").toBeLessThanOrEqual(1);
      expect(measured.quickVisible).toBe(true);
      expect(measured.controlsVisible).toBe(true);
    });
  }
}

test("in RTL the title icon leads on the right", async ({ page }) => {
  await openNotifications(page);
  await setDirection(page, "rtl");
  const flipped = await page.evaluate(() => {
    const icon = document.querySelector(".app-title-icon")!.getBoundingClientRect();
    const title = document
      .querySelector("[data-notifications-title]")!
      .getBoundingClientRect();
    return icon.left > title.left;
  });
  expect(flipped).toBe(true);
});
