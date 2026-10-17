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

/** Turn Archived on through the Filters panel — its only control now. */
async function enableArchived(page: Page): Promise<void> {
  await page.click('[data-action="toggle-advanced-filters"]');
  await page.click(
    '[data-inbox-filters-panel] [data-inbox-filter-chip="archived"]',
  );
  await page.click('[data-action="close-advanced-filters"]');
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

    await enableArchived(page);
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
    await enableArchived(page);
    await expect.poll(async () => (await renderedKeys(page)).length).toBe(2);

    // Removing the active-filter chip is the way back: the quick row no
    // longer carries Archived, so "All" cannot clear it — and should not, since
    // the primary view and the lifecycle are different axes now.
    await page.click('[data-inbox-remove-filter="archived"]');
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
      const u = new URL(route.request().url());
      asked.push(
        u.searchParams.get("lifecycle") ?? u.searchParams.get("filter") ?? "",
      );
      return route.fallback();
    });
    await page.goto("/notifications");
    await page.waitForSelector("[data-inbox-toolbar]", { timeout: 15_000 });
    await enableArchived(page);
    await expect.poll(async () => (await renderedKeys(page)).length).toBe(2);
    // The LIFECYCLE axis carries it now — its own parameter, so it composes
    // with a severity or a category instead of competing for the single
    // `filter` slot.
    expect(asked).toContain("archived");
    // Neither legacy single-slot spelling is emitted by this client.
    expect(asked).not.toContain("history");
  });

  test("Unread is disabled under Archived, because that view is always empty", async ({
    page,
  }) => {
    await openNotifications(page);
    const unread = page.locator(
      '[data-inbox-quick-filters] [data-inbox-filter-chip="unread"]',
    );
    await expect(unread).toBeEnabled();

    await enableArchived(page);
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
    // With nothing at all, the All view says so — scoped to the view, not a
    // global "caught up" panel keyed off the live total.
    const allEmpty = page.locator("[data-inbox-empty-view='all']");
    await expect(allEmpty).toContainText("No notifications yet");
    await expect(page.locator("[data-state='empty']")).not.toContainText(
      /all caught up/i,
    );

    // The same empty population, seen through the archive, is an empty
    // ARCHIVE: its own copy, and no "clear filters" — nothing is broken.
    await page.goto("/notifications?lifecycle=archived");
    const archiveEmpty = page.locator("[data-inbox-empty-view='archive']");
    await expect(archiveEmpty).toBeVisible({ timeout: 15_000 });
    await expect(archiveEmpty).toContainText("No archived notifications.");
    await expect(archiveEmpty).toContainText(
      "Archiving a notification files it here and takes it out of your active list.",
    );
    await expect(page.locator('[data-inbox-empty-reason="filters"]')).toHaveCount(0);
    await expect(page.locator('[data-action="clear-filter"]')).toHaveCount(0);
    // It takes the list's place.
    await expect(page.locator("[data-inbox-item]")).toHaveCount(0);
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
    // The read-state question, whole: All / Unread / Read. Read is the other
    // half of All — a read notification is found there, never lost.
    await expect(quick).toHaveCount(3);
    await expect(quick.nth(0)).toHaveText("All");
    // The Unread chip carries the server's unread total as an aria-hidden
    // badge (2 in this scenario); its NAME stays "Unread" and the count is
    // announced as its description instead.
    await expect(quick.nth(1)).toHaveAccessibleName("Unread");
    await expect(
      quick.nth(1).locator('[data-inbox-unread-count="2"]'),
    ).toHaveText("2");
    await expect(quick.nth(1)).toHaveAccessibleDescription("2 unread");
    await expect(quick.nth(2)).toHaveText("Read");
    // ARCHIVED IS NOT A FOURTH PILL. It is a status, and standing it beside
    // the read states implied they were alternatives when only those three
    // are. It lives in the Filters panel's Status group.
    await expect(
      page.locator(
        '[data-inbox-quick-filters] [data-inbox-filter-chip="archived"]',
      ),
    ).toHaveCount(0);
    await page.click('[data-action="toggle-advanced-filters"]');
    await expect(
      page.locator(
        '[data-inbox-filter-group="status"] [data-inbox-filter-chip="archived"]',
      ),
    ).toHaveCount(1);

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

    // A primary view is the page's own state, not an applied filter — it must
    // not inflate the badge.
    await page.click('[data-action="close-advanced-filters"]');
    await page.click('[data-inbox-remove-filter="integrity"]');
    await page.click(
      '[data-inbox-quick-filters] [data-inbox-filter-chip="unread"]',
    );
    await expect(trigger.locator(".ops-filters-count")).toHaveCount(0);
    // Archived DOES count — it is an applied filter like any other now.
    await enableArchived(page);
    await expect(trigger.locator(".ops-filters-count")).toHaveText("1");
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

test("the page reads title → read-state control → list, with no metric band", async ({
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
      // The six-card summary band that sat between the title and the toolbar
      // is gone (2026-10-17); the read-state control is the first thing after
      // the header.
      metrics: document.querySelectorAll(
        "[data-notifications-summary], [data-notifications-metric-grid], [data-notifications-metric]",
      ).length,
      quick: y("[data-inbox-quick-filters]"),
      toolbar: y("[data-inbox-toolbar]"),
      list: y("[data-inbox-items]"),
    };
  });
  expect(order.metrics).toBe(0);
  expect(order.title).toBeLessThan(order.toolbar);
  expect(order.toolbar).toBeLessThanOrEqual(order.quick);
  expect(order.quick).toBeLessThan(order.list);
});

test("the result count speaks about notifications, and about the archive", async ({
  page,
}) => {
  await openNotifications(page);
  const showing = page.locator("[data-inbox-showing-text]");
  await expect(showing).toContainText("notifications");
  await expect(showing).not.toContainText(" items");

  await enableArchived(page);
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
// §3–§8 — THE SEVERITY TONES, resolved from canonical tokens
//
// The six metric cards that used to carry these tones are gone (2026-10-17).
// Severity survives as ROW METADATA, so the same canonical mapping is now
// asserted where it is painted: each row's tone badge. And the control that
// replaced the cards — All / Unread / Read — is pinned for order and ink.
// ===========================================================================

test("the read-state control leads with All; row badges resolve the canonical tones", async ({
  page,
}) => {
  await openNotifications(page);
  expect(await page.locator("[data-notifications-metric]").count()).toBe(0);

  // ORDER — All is leftmost in LTR, and the row is the read-state question.
  const order = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll("[data-inbox-quick-filters] [data-inbox-filter-chip]"),
    )
      .map((el) => ({
        key: el.getAttribute("data-inbox-filter-chip"),
        left: el.getBoundingClientRect().left,
      }))
      .sort((a, b) => a.left - b.left)
      .map((c) => c.key),
  );
  expect(order).toEqual(["all", "unread", "read"]);

  // TONES — each severity badge wears its canonical token's value. The
  // mapping was corrected to the canonical semantics — critical is danger
  // (red), warning is the brand purple — in 2866f107 (2026-08-27) and
  // b83bf5e0 (2026-09-03); the rationale is recorded in notifications.css.
  const expected: Record<string, string> = {
    critical: "rgb(220,38,38)", // --error      #DC2626
    high: "rgb(234,88,12)", // --orange-500     #EA580C
    warning: "rgb(109,40,217)", // --accent-600 #6D28D9
    info: "rgb(100,116,139)", // --ops-tone-info #64748B
  };
  const badges = async () =>
    page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>("li[data-inbox-item-tone] [data-tone-chip]"),
      ).map((el) => ({
        tone: el.getAttribute("data-tone-chip"),
        text: el.textContent?.trim(),
        color: getComputedStyle(el).color.replace(/\s+/g, ""),
      })),
    );

  // Active: critical, high, warning. Archived: critical, info — so every
  // tone is measured on a real row.
  const seen = new Set<string>();
  for (const view of ["active", "archived"] as const) {
    if (view === "archived") {
      await enableArchived(page);
      await expect.poll(async () => (await renderedKeys(page)).length).toBe(2);
    }
    for (const b of await badges()) {
      expect(b.text, `${b.tone} label`).toBe(b.tone!.toUpperCase());
      expect(b.color, `${b.tone} badge colour`).toBe(expected[b.tone!]);
      seen.add(b.tone!);
    }
  }
  expect([...seen].sort()).toEqual(["critical", "high", "info", "warning"]);
});

test("no read-state chip is silver — its label is ink, not a hairline", async ({
  page,
}) => {
  await openNotifications(page);
  // The regression this replaced on the cards: `All` painted
  // `--border-strong`, a 14%-alpha hairline, so the leading label read as a
  // disabled control. The read-state chips must not repeat it, selected or
  // not.
  const colours = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-inbox-quick-filters] [data-inbox-filter-chip]:not(:disabled)",
      ),
    ).map((el) => getComputedStyle(el).color),
  );
  expect(colours).toHaveLength(3);
  for (const c of colours) expect(c).not.toMatch(/rgba\([^)]*,\s*0?\.\d+\)/);
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

// ===========================================================================
// §4 / §13–§17 — what the list is NOT any more
// ===========================================================================

test("the two bulk-read buttons are gone, in every view", async ({ page }) => {
  await openNotifications(page);
  for (const view of ["active", "archived"] as const) {
    if (view === "archived") await enableArchived(page);
    // They were noise on a personal feed, and in the Archived view — where
    // every row is read by definition — they offered to do nothing.
    await expect(
      page.locator('[data-action="mark-all-read"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-action="mark-category-read"]'),
    ).toHaveCount(0);
    await expect(page.locator("[data-inbox-bulk-actions]")).toHaveCount(0);
    await expect(page.getByText("Mark all as read")).toHaveCount(0);
  }
});

test("no P1/P2 priority section heading survives on Notifications", async ({
  page,
}) => {
  await openNotifications(page);
  const found = await page.evaluate(() => {
    const body = document.body.textContent ?? "";
    return {
      sections: document.querySelectorAll("[data-inbox-priority-section]")
        .length,
      headers: document.querySelectorAll(".ops-priority-header").length,
      labels: document.querySelectorAll("[data-inbox-priority-label]").length,
      // The exact operational sentence the heading used to carry.
      tagline: body.includes("Operational failures and critical signals"),
      pTier: /\bP[1-5]\s*·/.test(body),
    };
  });
  expect(found.sections).toBe(0);
  expect(found.headers).toBe(0);
  expect(found.labels).toBe(0);
  expect(found.tagline).toBe(false);
  expect(found.pTier).toBe(false);

  // ROW-LEVEL severity remains — that is useful context, and it is what the
  // heading was a bad substitute for.
  await expect(page.locator("li[data-inbox-item-tone]").first()).toBeVisible();
  await expect(page.locator("[data-inbox-item-priority]").first()).toHaveAttribute(
    "data-inbox-item-priority",
    /P[1-5]/,
  );
});

test("the list is ONE flat stream, and sort decides its DOM order", async ({
  page,
}) => {
  await openNotifications(page);

  // One <ul>, and every row is a direct child of it — no per-priority
  // sub-lists, which is what made "Oldest first" only apply within a bucket.
  const shape = await page.evaluate(() => {
    const lists = document.querySelectorAll("[data-inbox-items] ul");
    const stream = document.querySelector("[data-inbox-stream]");
    const rows = Array.from(
      document.querySelectorAll("li[data-inbox-item-key]"),
    );
    return {
      lists: lists.length,
      allDirectChildren: rows.every((r) => r.parentElement === stream),
    };
  });
  expect(shape.lists).toBe(1);
  expect(shape.allDirectChildren).toBe(true);

  // And the ordering is the SERVER's, top to bottom, across tones. Newest
  // first puts the 11:00 critical above the 10:00 high above the 09:00
  // warning — an order a P1/P2 regrouping could not have produced.
  await expect.poll(async () => await renderedKeys(page)).toEqual([
    "tsa_failure:active-unread-critical",
    "tsa_failure:active-read-high",
    "tsa_failure:active-unread-warning",
  ]);

  await page.click(".ops-sort__control button");
  await page.click('role=option[name="Oldest first"]');
  await expect.poll(async () => await renderedKeys(page)).toEqual([
    "tsa_failure:active-unread-warning",
    "tsa_failure:active-read-high",
    "tsa_failure:active-unread-critical",
  ]);
});

// ===========================================================================
// §9–§12 — the result summary is a label, not a bar
// ===========================================================================

test("the result summary sizes to its content and is not a full-width slab", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openNotifications(page);
  const m = await page.evaluate(() => {
    const el = document.querySelector(
      "[data-inbox-pagination-summary]",
    ) as HTMLElement;
    const list = document.querySelector("[data-inbox-items]") as HTMLElement;
    const cs = getComputedStyle(el);
    return {
      width: Math.round(el.getBoundingClientRect().width),
      containerWidth: Math.round(
        (el.parentElement as HTMLElement).getBoundingClientRect().width,
      ),
      radius: parseFloat(cs.borderTopLeftRadius),
      role: el.getAttribute("role"),
      // Aligned with the list it introduces.
      inlineStartDelta: Math.abs(
        el.getBoundingClientRect().left - list.getBoundingClientRect().left,
      ),
    };
  });
  // Sized to its text, nowhere near the content column.
  expect(m.width).toBeLessThan(m.containerWidth * 0.5);
  // A label's radius, not a capsule's.
  expect(m.radius).toBeLessThanOrEqual(12);
  // It is a count, not a progress indicator.
  expect(m.role).not.toBe("progressbar");
  expect(m.inlineStartDelta).toBeLessThanOrEqual(1);
});

// ===========================================================================
// §22 — the shipped URL still works
// ===========================================================================

test("/notifications?filter=archived still selects the archive", async ({
  page,
}) => {
  await installApi(page, "personal-pro", { archiveScenario: true });
  await page.goto("/notifications?filter=archived");
  await page.waitForSelector("[data-inbox-toolbar]", { timeout: 15_000 });

  // Archived rows only…
  await expect.poll(async () => (await renderedKeys(page)).length).toBe(2);
  const keys = await renderedKeys(page);
  expect(keys.every((k) => k.includes("archived-"))).toBe(true);

  // …and the control reflects it, inside the panel where it now lives.
  await expect(
    page.locator('[data-inbox-remove-filter="archived"]'),
  ).toHaveCount(1);
  await page.click('[data-action="toggle-advanced-filters"]');
  await expect(
    page.locator(
      '[data-inbox-filter-group="status"] [data-inbox-filter-chip="archived"]',
    ),
  ).toHaveAttribute("aria-pressed", "true");
});
