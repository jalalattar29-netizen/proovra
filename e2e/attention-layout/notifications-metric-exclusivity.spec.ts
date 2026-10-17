/**
 * THE READ-STATE CONTROL IS ONE CONTROL.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FILE WAS BORN FROM
 * ---------------------------------------------------------------------------
 * The six metric cards wrote to two independent pieces of state: `Unread` set
 * the filter, the four severities set the tone. Selecting `Unread` and then
 * `High` left BOTH applied, so the page asked the server for unread-AND-high —
 * an intersection the reader never requested. It usually returned nothing,
 * and the only escape was to click the previously-selected card a second time
 * to clear it before the new one would do anything.
 *
 * The fix made the primary view ONE value. Then (2026-10-17) the cards
 * themselves were removed: Notifications is an inbox, not a dashboard. What
 * remains is ONE read-state control — All / Unread / Read — plus the four
 * severities as deep-link views (`?view=high`). Both still write the same
 * single value, so the property this file guards is unchanged: two views can
 * never be selected at once, on screen, on the wire, or in the URL.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ASSERTED
 * ---------------------------------------------------------------------------
 * The scenario is the one from the original brief — Unread 0, High 26, Info 2,
 * All 28 — walked in a real browser, clicking the real chips, with the fixture
 * honouring the same query axes the API does. A page that sent both
 * `readState=unread` and `tone=high` would return zero rows here and fail.
 *
 * Tests whose sole subject was the cards' own counts (a zero-count card's
 * visuals, the cards' basis excluding their own axes, sorting/paging never
 * moving a card) went with the cards. The one count that survives — the
 * server's Unread total on the Unread chip — inherits the "sorting and paging
 * never change it" guarantee below.
 */

import { expect, test, type Page } from "@playwright/test";

import { installApi, setDirection, VIEWPORTS } from "./_fixtures";

const QUICK = "[data-inbox-quick-filters] [data-inbox-filter-chip]";

async function openReadState(page: Page, path = "/notifications"): Promise<void> {
  await installApi(page, "personal-pro", { metricScenario: true });
  await page.goto(path);
  await page.waitForSelector("[data-inbox-quick-filters]", {
    timeout: 15_000,
  });
}

async function rowCount(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelectorAll("li[data-inbox-item-key]").length,
  );
}

/** Every read-state chip's key → whether it is currently selected. */
async function selection(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate((sel) => {
    const out: Record<string, boolean> = {};
    for (const el of Array.from(document.querySelectorAll(sel))) {
      out[el.getAttribute("data-inbox-filter-chip")!] =
        el.getAttribute("aria-pressed") === "true";
    }
    return out;
  }, QUICK);
}

function selectedKeys(sel: Record<string, boolean>): string[] {
  return Object.entries(sel)
    .filter(([, on]) => on)
    .map(([k]) => k);
}

/** One read-state chip, by view key. */
const chip = (key: string) =>
  `[data-inbox-quick-filters] [data-inbox-filter-chip="${key}"]`;

// ===========================================================================
// THE CARDS ARE GONE — and nothing that looked like them came back.
// ===========================================================================

test("no metric card, summary band or metric grid renders anywhere", async ({
  page,
}) => {
  await openReadState(page);
  await expect.poll(() => rowCount(page)).toBe(28);
  expect(await page.locator("[data-notifications-metric]").count()).toBe(0);
  expect(await page.locator("[data-notifications-summary]").count()).toBe(0);
  expect(await page.locator("[data-notifications-metric-grid]").count()).toBe(0);
  expect(await page.locator(".app-metric-card").count()).toBe(0);
  // The read-state control is the one control: exactly three chips.
  await expect(page.locator(QUICK)).toHaveCount(3);
});

// ===========================================================================
// §3J — the mandatory regression scenario, over the read-state control
// ===========================================================================

test("All(28) → Unread(0) → Read(28) → All(28), with no manual clearing", async ({
  page,
}) => {
  await openReadState(page);

  // All is selected on arrival.
  expect(selectedKeys(await selection(page))).toEqual(["all"]);
  await expect.poll(() => rowCount(page)).toBe(28);

  // Unread at ZERO is still a live control, not a disabled one.
  await expect(page.locator(chip("unread"))).toBeEnabled();
  await page.click(chip("unread"));
  await expect.poll(() => rowCount(page)).toBe(0);
  expect(selectedKeys(await selection(page))).toEqual(["unread"]);
  // The zero-result view is a clean, view-scoped state, not an error — and it
  // stands in place of the list.
  const empty = page.locator("[data-state='empty'][data-inbox-empty-view='unread']");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("You’re all caught up");
  await expect(empty).toContainText("There are no unread notifications.");
  await expect(page.locator("[data-inbox-item]")).toHaveCount(0);

  // WITHOUT clearing anything, Read → 28 rows; Unread released automatically.
  await page.click(chip("read"));
  await expect.poll(() => rowCount(page)).toBe(28);
  const afterRead = await selection(page);
  expect(afterRead.unread).toBe(false);
  expect(selectedKeys(afterRead)).toEqual(["read"]);
  await expect(page.locator("[data-state='empty']")).toHaveCount(0);

  // Back to All.
  await page.click(chip("all"));
  await expect.poll(() => rowCount(page)).toBe(28);
  expect(selectedKeys(await selection(page))).toEqual(["all"]);
});

test("a deep-linked severity view is replaced by All in one click", async ({
  page,
}) => {
  // Severity survives only as a deep link. While it is the view, it IS the
  // single selection — none of the three read-state chips is lit beside it.
  await openReadState(page, "/notifications?view=high");
  await expect.poll(() => rowCount(page)).toBe(26);
  expect(selectedKeys(await selection(page))).toEqual([]);
  await expect(page.locator("[data-inbox-showing-text]")).toContainText(
    /high notifications/i,
  );
  // Every row it shows really is High, and says so in text.
  const tones = await page.evaluate(() =>
    Array.from(document.querySelectorAll("li[data-inbox-item-tone]")).map(
      (li) => li.getAttribute("data-inbox-item-tone"),
    ),
  );
  expect(new Set(tones)).toEqual(new Set(["high"]));

  await page.click(chip("all"));
  await expect.poll(() => rowCount(page)).toBe(28);
  expect(selectedKeys(await selection(page))).toEqual(["all"]);
});

test("exactly one chip is selected after every possible transition", async ({
  page,
}) => {
  await openReadState(page);
  const keys = ["all", "unread", "read"];
  // Every ordered pair, including a chip following itself — a second click on
  // the active chip must NOT clear it, because `All` already means "cleared"
  // and a fourth state meaning the same thing is one state too many.
  for (const from of keys) {
    for (const to of keys) {
      await page.click(chip(from));
      await page.click(chip(to));
      const sel = await selection(page);
      expect(selectedKeys(sel), `${from} → ${to}`).toEqual([to]);
    }
  }
});

// ===========================================================================
// §3K — the WIRE, not just the styling
// ===========================================================================

test("switching views replaces the query axis instead of stacking one", async ({
  page,
}) => {
  await installApi(page, "personal-pro", { metricScenario: true });
  const sent: Array<{ readState: string | null; tone: string | null }> = [];
  await page.route("**/v1/me/inbox?*", (route) => {
    const u = new URL(route.request().url());
    sent.push({
      readState: u.searchParams.get("readState"),
      tone: u.searchParams.get("tone"),
    });
    return route.fallback();
  });
  await page.goto("/notifications?view=high");
  await page.waitForSelector("[data-inbox-quick-filters]");
  await expect.poll(() => rowCount(page)).toBe(26);
  // The severity deep link asked for High alone.
  expect(sent[sent.length - 1]).toEqual({ readState: null, tone: "high" });

  await page.click(chip("unread"));
  await expect.poll(() => rowCount(page)).toBe(0);
  // High → Unread REPLACED the tone axis with the read-state axis.
  expect(sent[sent.length - 1]).toEqual({ readState: "unread", tone: null });

  await page.click(chip("read"));
  await expect.poll(() => rowCount(page)).toBe(28);
  expect(sent[sent.length - 1]).toEqual({ readState: "read", tone: null });

  await page.click(chip("all"));
  await expect.poll(() => rowCount(page)).toBe(28);
  // All is the absence of both.
  expect(sent[sent.length - 1]).toEqual({ readState: null, tone: null });

  // THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG: no single request
  // ever carried both axes. A cosmetic-only fix — one selected chip, two
  // parameters still on the wire — fails here.
  for (const req of sent) {
    expect(
      req.readState !== null && req.tone !== null,
      `sent readState=${req.readState} AND tone=${req.tone}`,
    ).toBe(false);
    if (req.readState !== null) expect(["unread", "read"]).toContain(req.readState);
  }
});

test("the URL carries ONE primary-view parameter, replaced on each switch", async ({
  page,
}) => {
  await openReadState(page, "/notifications?view=high");
  await expect.poll(() => rowCount(page)).toBe(26);
  expect(new URL(page.url()).searchParams.getAll("view")).toEqual(["high"]);

  await page.click(chip("unread"));
  await expect.poll(() => rowCount(page)).toBe(0);
  await expect
    .poll(() => new URL(page.url()).searchParams.getAll("view"))
    .toEqual(["unread"]);

  await page.click(chip("read"));
  await expect.poll(() => rowCount(page)).toBe(28);
  await expect
    .poll(() => new URL(page.url()).searchParams.getAll("view"))
    .toEqual(["read"]);
  const params = new URL(page.url()).searchParams;
  // Replaced, not appended — and no conflicting second narrowing beside it.
  expect(params.get("readState")).toBeNull();
  expect(params.get("tone")).toBeNull();

  // All is the default, so it writes no view at all.
  await page.click(chip("all"));
  await expect
    .poll(() => new URL(page.url()).searchParams.getAll("view"))
    .toEqual([]);
});

// ===========================================================================
// §3L / §3M — what must SURVIVE a view switch
// ===========================================================================

test("sort survives a view switch; only the cursor resets", async ({ page }) => {
  await installApi(page, "personal-pro", { metricScenario: true });
  const cursors: Array<string | null> = [];
  await page.route("**/v1/me/inbox?*", (route) => {
    cursors.push(new URL(route.request().url()).searchParams.get("cursor"));
    return route.fallback();
  });
  await page.goto("/notifications?view=high");
  await page.waitForSelector("[data-inbox-quick-filters]");

  await page.click(".ops-sort__control button");
  await page.click('role=option[name="Oldest first"]');
  await expect.poll(() => rowCount(page)).toBe(26);

  const renderedIds = async () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll("li[data-inbox-item-key]")).map(
        (el) => el.getAttribute("data-inbox-item-key") ?? "",
      ),
    );

  // Severity view → Read: the view is replaced, the sort is not.
  await page.click(chip("read"));
  await expect.poll(() => rowCount(page)).toBe(28);

  // The control still reads Oldest first, and the URL still carries it…
  await expect(page.locator(".ops-sort__control")).toContainText(
    "Oldest first",
  );
  expect(new URL(page.url()).searchParams.get("sort")).toBe("oldest");
  // …and the rows are GENUINELY oldest-first, not merely labelled so. The
  // fixture stamps item N at (base minus N minutes), so the HIGHEST index is
  // the oldest: info-101 leads under Oldest first and high-0 is last.
  // Asserting both endpoints proves the ordering survived the view switch
  // rather than silently reverting to the newest-first default.
  const after = await renderedIds();
  expect(after[0]).toBe("tsa_failure:metric-info-101");
  expect(after[after.length - 1]).toBe("tsa_failure:metric-high-0");

  // And once more back to All.
  await page.click(chip("all"));
  await expect.poll(() => rowCount(page)).toBe(28);
  await expect(page.locator(".ops-sort__control")).toContainText(
    "Oldest first",
  );
  // Every request started from the beginning.
  expect(cursors.every((c) => c === null)).toBe(true);
});

test("an advanced filter survives a view switch", async ({ page }) => {
  await openReadState(page);
  await page.click('[data-action="toggle-advanced-filters"]');
  await page.click(
    '[data-inbox-filters-panel] [data-inbox-filter-chip="integrity"]',
  );
  await page.click('[data-action="close-advanced-filters"]');
  await expect(
    page.locator('[data-inbox-remove-filter="integrity"]'),
  ).toHaveCount(1);

  for (const key of ["read", "unread", "all"]) {
    await page.click(chip(key));
    await expect
      .poll(async () => selectedKeys(await selection(page)))
      .toEqual([key]);
    // Only the PRIMARY view was replaced.
    await expect(
      page.locator('[data-inbox-remove-filter="integrity"]'),
    ).toHaveCount(1);
    expect(new URL(page.url()).searchParams.get("filter")).toBe("integrity");
  }
});

// ===========================================================================
// §3H / §27 — selection semantics and accessibility
// ===========================================================================

test("selection is announced, keyboard reachable and not colour-only", async ({
  page,
}) => {
  await openReadState(page);
  const probe = await page.evaluate((sel) => {
    const el = document.querySelector(
      `${sel}[data-inbox-filter-chip="all"]`,
    ) as HTMLElement;
    el.focus();
    const focused = document.activeElement === el;
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      pressed: el.getAttribute("aria-pressed"),
      focused,
      label: el.textContent?.trim(),
      background: cs.backgroundColor,
    };
  }, "[data-inbox-quick-filters] ");
  expect(probe.tag).toBe("BUTTON");
  expect(probe.pressed).toBe("true");
  expect(probe.focused).toBe(true);
  // Selection is carried by a real attribute AND a surface change, never by
  // hue alone — and every chip names its view in words.
  expect(probe.label).toBe("All");

  // KEYBOARD ALONE: Tab to the next chip and activate it with Space.
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("data-inbox-filter-chip"),
    ),
  ).toBe("unread");
  await page.keyboard.press("Space");
  await expect(page.locator(chip("unread"))).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(chip("all"))).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // The unselected chips paint a different surface, so "which is selected" is
  // legible without reading colour. Polled, because the surface change is a
  // CSS transition: the selected style moves to Unread and settles there.
  const bg = (sel: string) =>
    page.evaluate(
      (s) =>
        getComputedStyle(document.querySelector(s) as HTMLElement)
          .backgroundColor,
      sel,
    );
  await expect.poll(() => bg(chip("unread"))).toBe(probe.background);
  await expect.poll(() => bg(chip("all"))).not.toBe(probe.background);
});

test("the Unread count is announced as the chip's description, not its name", async ({
  page,
}) => {
  // The metric scenario has no unread rows (and so, correctly, no badge);
  // the archive scenario has two.
  await installApi(page, "personal-pro", { archiveScenario: true });
  await page.goto("/notifications");
  await page.waitForSelector("[data-inbox-quick-filters]", { timeout: 15_000 });

  const unread = page.locator(chip("unread"));
  await expect(unread.locator("[data-inbox-unread-count]")).toHaveAttribute(
    "data-inbox-unread-count",
    "2",
  );
  await expect(unread.locator("[data-inbox-unread-count]")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await expect(unread).toHaveAttribute("aria-describedby", "inbox-unread-count-desc");
  await expect(unread).toHaveAccessibleName("Unread");
  await expect(unread).toHaveAccessibleDescription("2 unread");
  // Only Unread carries a count.
  await expect(page.locator("[data-inbox-unread-count]")).toHaveCount(1);
});

// ===========================================================================
// §23 — responsive + RTL over the toolbar
// ===========================================================================

for (const vp of VIEWPORTS) {
  for (const dir of ["ltr", "rtl"] as const) {
    test(`read-state row and toolbar hold at ${vp.name} / ${dir}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openReadState(page);
      await setDirection(page, dir);
      const m = await page.evaluate(() => {
        const doc = document.documentElement;
        const cards = document.querySelectorAll("[data-notifications-metric]");
        const quick = document.querySelectorAll(
          "[data-inbox-quick-filters] button",
        );
        return {
          overflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
          cards: cards.length,
          quick: quick.length,
          // Every quick control is a real target, not a tiny pill.
          minQuickHeight: Math.min(
            ...Array.from(quick).map((b) =>
              Math.round(b.getBoundingClientRect().height),
            ),
          ),
        };
      });
      expect(m.overflow).toBeLessThanOrEqual(1);
      expect(m.cards).toBe(0);
      // All / Unread / Read.
      expect(m.quick).toBe(3);
      expect(m.minQuickHeight).toBeGreaterThanOrEqual(34);
    });
  }
}

// ===========================================================================
// THE ONE COUNT LEFT IS THE SERVER'S.
//
// The Unread badge reads the server's unread total for the population the
// reader is looking at (metricSummary, narrowed by the ADVANCED axes and not
// by the view itself) — never a count of the rows this page happens to hold.
// ===========================================================================

async function unreadBadge(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document
        .querySelector("[data-inbox-unread-count]")
        ?.getAttribute("data-inbox-unread-count") ?? null,
  );
}

test("sorting never changes the Unread badge", async ({ page }) => {
  await installApi(page, "personal-pro", { archiveScenario: true });
  await page.goto("/notifications");
  await page.waitForSelector("[data-inbox-quick-filters]", { timeout: 15_000 });
  await expect.poll(() => unreadBadge(page)).toBe("2");

  for (const label of ["Oldest first", "Unread first", "Highest severity", "Newest first"]) {
    await page.click(".ops-sort__control button");
    await page.click(`role=option[name="${label}"]`);
    await expect(page.locator(".ops-sort__control")).toContainText(label);
    await expect.poll(() => rowCount(page)).toBe(3);
    expect(await unreadBadge(page), label).toBe("2");
  }
});

test("paging and the view never change the Unread badge", async ({ page }) => {
  // The count comes from the server's full filtered population, not from the
  // rows loaded — and not from the view: selecting Unread or Read narrows the
  // list, never the badge.
  await installApi(page, "personal-pro", { archiveScenario: true });
  await page.goto("/notifications?pageSize=1");
  await page.waitForSelector("[data-inbox-quick-filters]", { timeout: 15_000 });
  await expect.poll(() => unreadBadge(page)).toBe("2");
  const shownUnread = await page.locator('li[data-inbox-item-read="false"]').count();
  expect(Number(await unreadBadge(page))).toBeGreaterThanOrEqual(shownUnread);

  for (const key of ["unread", "read", "all"]) {
    await page.click(chip(key));
    await expect
      .poll(async () => selectedKeys(await selection(page)))
      .toEqual([key]);
    expect(await unreadBadge(page), key).toBe("2");
  }
});

test("Archived re-describes the badge: nothing archived is unread", async ({
  page,
}) => {
  await installApi(page, "personal-pro", { archiveScenario: true });
  await page.goto("/notifications");
  await page.waitForSelector("[data-inbox-quick-filters]", { timeout: 15_000 });
  await expect.poll(() => unreadBadge(page)).toBe("2");

  await page.click('[data-action="toggle-advanced-filters"]');
  await page.click(
    '[data-inbox-filters-panel] [data-inbox-filter-chip="archived"]',
  );
  await page.click('[data-action="close-advanced-filters"]');

  // ARCHIVED: 2 rows, both read (archiving marks read). The badge describes
  // THOSE, so it is gone rather than still counting the active feed.
  await expect.poll(() => rowCount(page)).toBe(2);
  await expect.poll(() => unreadBadge(page)).toBeNull();
  await expect(page.locator("#inbox-unread-count-desc")).toHaveCount(0);
  await expect(page.locator(chip("unread"))).toBeDisabled();
});

// ===========================================================================
// THE EMPTY STATES — scoped to the view, in place of the list
// ===========================================================================

test("a filter that matches nothing gets a centred, actionable empty state", async ({
  page,
}) => {
  // Critical is 0 in this scenario, and a severity view is a filter.
  await openReadState(page, "/notifications?view=critical");
  await expect.poll(() => rowCount(page)).toBe(0);

  const empty = page.locator('[data-inbox-empty-reason="filters"]');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("No notifications match these filters.");
  await expect(empty).toContainText("Try changing or clearing the active filters.");
  // In the list's place — not a panel above results.
  await expect(page.locator("[data-inbox-items]")).toHaveCount(0);
  await expect(
    page.locator("[data-state='empty'][data-inbox-empty-view='filters']"),
  ).toHaveCount(1);

  const measured = await page.evaluate(() => {
    const el = document.querySelector(
      '[data-inbox-empty-reason="filters"]',
    ) as HTMLElement;
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const btn = el.querySelector('[data-action="clear-filter"]') as HTMLElement;
    const bs = getComputedStyle(btn);
    const bb = btn.getBoundingClientRect();
    const title = el.querySelector(".ops-empty__title") as HTMLElement;
    const tb = title.getBoundingClientRect();
    return {
      align: cs.alignItems,
      justify: cs.justifyContent,
      textAlign: cs.textAlign,
      minHeight: parseFloat(cs.minBlockSize || cs.minHeight),
      // The content sits in the MIDDLE of the surface, not against its edge.
      topGap: Math.round(tb.top - box.top),
      // The action is a real button: padding, border, radius — not a text link.
      btnTag: btn.tagName,
      btnText: btn.textContent?.trim(),
      btnPaddingX: parseFloat(bs.paddingLeft),
      btnBorderWidth: parseFloat(bs.borderTopWidth),
      btnRadius: parseFloat(bs.borderTopLeftRadius),
      btnHeight: Math.round(bb.height),
      btnCanonical: btn.classList.contains("app-secondary-action"),
      // Centred horizontally within the surface.
      centreDelta: Math.abs(
        bb.left + bb.width / 2 - (box.left + box.width / 2),
      ),
    };
  });

  expect(measured.align).toBe("center");
  expect(measured.justify).toBe("center");
  expect(measured.textAlign).toBe("center");
  expect(measured.minHeight).toBeGreaterThanOrEqual(160);
  expect(measured.topGap).toBeGreaterThanOrEqual(24);
  expect(measured.centreDelta).toBeLessThanOrEqual(1);

  // THE CANONICAL ACTION BUTTON, not the text link this used to be.
  expect(measured.btnTag).toBe("BUTTON");
  expect(measured.btnText).toBe("Clear filters");
  expect(measured.btnCanonical).toBe(true);
  expect(measured.btnPaddingX).toBeGreaterThanOrEqual(10);
  expect(measured.btnBorderWidth).toBeGreaterThan(0);
  expect(measured.btnRadius).toBeGreaterThan(0);
  expect(measured.btnHeight).toBeGreaterThanOrEqual(30);

  // Keyboard reachable…
  const focused = await page.evaluate(() => {
    const btn = document.querySelector(
      '[data-action="clear-filter"]',
    ) as HTMLElement;
    btn.focus();
    return document.activeElement === btn;
  });
  expect(focused).toBe(true);

  // …and it works: a severity view IS a filter, so clearing returns to All.
  await page.keyboard.press("Enter");
  await expect.poll(() => rowCount(page)).toBe(28);
  expect(selectedKeys(await selection(page))).toEqual(["all"]);
  expect(new URL(page.url()).searchParams.get("view")).toBeNull();
});

test("the empty states stay distinct, and each replaces the list", async ({
  page,
}) => {
  /** The one empty state on screen, its copy, its action and its geometry. */
  const readEmpty = async () =>
    page.evaluate(() => {
      const all = document.querySelectorAll("[data-state='empty']");
      const el = all[0] as HTMLElement | undefined;
      const inner = el?.querySelector(".ops-empty") as HTMLElement | null;
      return {
        count: all.length,
        view: el?.getAttribute("data-inbox-empty-view") ?? null,
        reason: inner?.getAttribute("data-inbox-empty-reason") ?? null,
        title: inner?.querySelector(".ops-empty__title")?.textContent?.trim() ?? "",
        body: inner?.querySelector(".ops-empty__body")?.textContent?.trim() ?? "",
        clear: inner?.querySelectorAll('[data-action="clear-filter"]').length ?? 0,
        rows: document.querySelectorAll("[data-inbox-item]").length,
        list: document.querySelectorAll("[data-inbox-items]").length,
        centred: inner
          ? getComputedStyle(inner).alignItems === "center" &&
            getComputedStyle(inner).textAlign === "center"
          : false,
      };
    });

  // 1. UNREAD, empty: the reader is caught up — no clear-filters action,
  //    because nothing is filtered.
  await openReadState(page);
  await page.click(chip("unread"));
  await expect.poll(async () => (await readEmpty()).view).toBe("unread");
  const unread = await readEmpty();

  // 2. A FILTER that legitimately matches nothing: `integrity` selects
  //    `ots_failure`, and every archive-scenario row is `tsa_failure`.
  await installApi(page, "personal-pro", { archiveScenario: true });
  await page.goto("/notifications");
  await page.waitForSelector("[data-inbox-toolbar]", { timeout: 15_000 });
  await page.click('[data-action="toggle-advanced-filters"]');
  await page.click(
    '[data-inbox-filters-panel] [data-inbox-filter-chip="integrity"]',
  );
  await page.click('[data-action="close-advanced-filters"]');
  await expect.poll(async () => (await readEmpty()).view).toBe("filters");
  const filters = await readEmpty();

  // 3. An empty ARCHIVE is not a broken filter.
  await installApi(page, "personal-pro", { emptyInbox: true });
  await page.goto("/notifications?lifecycle=archived");
  await expect.poll(async () => (await readEmpty()).view).toBe("archive");
  const archive = await readEmpty();

  // 4. And nothing at all is the All empty.
  await page.goto("/notifications");
  await expect.poll(async () => (await readEmpty()).view).toBe("all");
  const all = await readEmpty();

  expect(unread).toMatchObject({
    reason: "unread",
    title: "You’re all caught up",
    body: "There are no unread notifications.",
    clear: 0,
  });
  expect(filters).toMatchObject({
    reason: "filters",
    title: "No notifications match these filters.",
    body: "Try changing or clearing the active filters.",
    clear: 1,
  });
  expect(archive).toMatchObject({
    reason: "archive",
    title: "No archived notifications.",
    body: "Archiving a notification files it here and takes it out of your active list.",
    clear: 0,
  });
  expect(all).toMatchObject({
    reason: "all",
    title: "No notifications yet",
    body: "Updates relevant to this workspace will appear here.",
    clear: 0,
  });

  for (const s of [unread, filters, archive, all]) {
    // ONE empty state, IN PLACE of the list — never a panel beside rows.
    expect(s.count, s.view!).toBe(1);
    expect(s.rows, s.view!).toBe(0);
    expect(s.list, s.view!).toBe(0);
    expect(s.centred, s.view!).toBe(true);
    // The retired global copy is gone everywhere.
    expect(s.body).not.toMatch(/don.t have any notifications/i);
  }
  // Four views, four distinct titles.
  expect(new Set([unread, filters, archive, all].map((s) => s.title)).size).toBe(4);
  await expect(page.locator("[data-state='filter-empty']")).toHaveCount(0);
});
