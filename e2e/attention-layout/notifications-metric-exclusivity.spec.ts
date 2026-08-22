/**
 * THE SIX METRIC CARDS ARE ONE CONTROL.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * The cards wrote to two independent pieces of state: `Unread` set the filter,
 * the four severities set the tone. Selecting `Unread` and then `High` left
 * BOTH applied, so the page asked the server for unread-AND-high — an
 * intersection the reader never requested. It usually returned nothing, and
 * the only escape was to click the previously-selected card a second time to
 * clear it before the new one would do anything.
 *
 * The six are ALTERNATIVES. They are now one value, so two of them cannot be
 * selected at once — not because the UI is careful, but because the state
 * cannot represent it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ASSERTED
 * ---------------------------------------------------------------------------
 * The scenario is the one from the brief — Unread 0, High 26, Info 2, All 28 —
 * and it is walked in a real browser, clicking real cards, with the fixture
 * honouring the same four query axes the API does. A page that sent both
 * `readState=unread` and `tone=high` would return zero rows here and fail.
 */

import { expect, test, type Page } from "@playwright/test";

import { installApi, setDirection, VIEWPORTS } from "./_fixtures";

async function openMetrics(page: Page): Promise<void> {
  await installApi(page, "personal-pro", { metricScenario: true });
  await page.goto("/notifications");
  await page.waitForSelector("[data-notifications-summary]", {
    timeout: 15_000,
  });
}

async function rowCount(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelectorAll("li[data-inbox-item-key]").length,
  );
}

/** Every card's key → whether it is currently selected. */
async function selection(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => {
    const out: Record<string, boolean> = {};
    for (const el of Array.from(
      document.querySelectorAll("[data-notifications-metric]"),
    )) {
      out[el.getAttribute("data-notifications-metric")!] =
        el.getAttribute("aria-pressed") === "true";
    }
    return out;
  });
}

function selectedKeys(sel: Record<string, boolean>): string[] {
  return Object.entries(sel)
    .filter(([, on]) => on)
    .map(([k]) => k);
}

// ===========================================================================
// §3J — the mandatory regression scenario
// ===========================================================================

test("Unread(0) → High(26) → Info(2) → All(28), with no manual clearing", async ({
  page,
}) => {
  await openMetrics(page);

  // 2. All is selected on arrival.
  expect(selectedKeys(await selection(page))).toEqual(["all"]);
  await expect.poll(() => rowCount(page)).toBe(28);

  // 3. Click Unread → 4. a zero-result state.
  await page.click('[data-notifications-metric="unread"]');
  await expect.poll(() => rowCount(page)).toBe(0);
  expect(selectedKeys(await selection(page))).toEqual(["unread"]);
  // The zero-result view is a clean state, not an error.
  await expect(page.locator("[data-state='filter-empty']")).toBeVisible();

  // 5. WITHOUT clearing anything, click High → 6. 26 rows.
  await page.click('[data-notifications-metric="high"]');
  await expect.poll(() => rowCount(page)).toBe(26);

  // 7 + 8. Unread released, High selected — automatically.
  const afterHigh = await selection(page);
  expect(afterHigh.unread).toBe(false);
  expect(afterHigh.high).toBe(true);
  expect(selectedKeys(afterHigh)).toEqual(["high"]);

  // 9 + 10. Info, immediately.
  await page.click('[data-notifications-metric="info"]');
  await expect.poll(() => rowCount(page)).toBe(2);
  expect(selectedKeys(await selection(page))).toEqual(["info"]);

  // 11 + 12. Back to All.
  await page.click('[data-notifications-metric="all"]');
  await expect.poll(() => rowCount(page)).toBe(28);
  expect(selectedKeys(await selection(page))).toEqual(["all"]);
});

test("exactly one card is selected after every possible transition", async ({
  page,
}) => {
  await openMetrics(page);
  const keys = ["all", "unread", "critical", "high", "warning", "info"];
  // Every ordered pair, including a card following itself — a second click on
  // the active card must NOT clear it, because `All` already means "cleared"
  // and a seventh state meaning the same thing is one state too many.
  for (const from of keys) {
    for (const to of keys) {
      await page.click(`[data-notifications-metric="${from}"]`);
      await page.click(`[data-notifications-metric="${to}"]`);
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
  await page.goto("/notifications");
  await page.waitForSelector("[data-notifications-summary]");

  await page.click('[data-notifications-metric="unread"]');
  await expect.poll(() => rowCount(page)).toBe(0);
  await page.click('[data-notifications-metric="high"]');
  await expect.poll(() => rowCount(page)).toBe(26);

  // THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG: no single request
  // ever carried both axes. A cosmetic-only fix — one selected card, two
  // parameters still on the wire — fails here.
  for (const req of sent) {
    expect(
      req.readState !== null && req.tone !== null,
      `sent readState=${req.readState} AND tone=${req.tone}`,
    ).toBe(false);
  }
  // And the last request asked for High alone.
  const last = sent[sent.length - 1]!;
  expect(last.tone).toBe("high");
  expect(last.readState).toBeNull();
});

test("the URL carries ONE primary-view parameter, replaced on each switch", async ({
  page,
}) => {
  await openMetrics(page);

  await page.click('[data-notifications-metric="unread"]');
  await expect.poll(() => rowCount(page)).toBe(0);
  await expect
    .poll(() => new URL(page.url()).searchParams.getAll("view"))
    .toEqual(["unread"]);

  await page.click('[data-notifications-metric="high"]');
  await expect.poll(() => rowCount(page)).toBe(26);
  const params = new URL(page.url()).searchParams;
  // Replaced, not appended — and no conflicting second narrowing beside it.
  expect(params.getAll("view")).toEqual(["high"]);
  expect(params.get("readState")).toBeNull();
  expect(params.get("tone")).toBeNull();
});

// ===========================================================================
// §3L / §3M — what must SURVIVE a view switch
// ===========================================================================

test("sort survives a metric switch; only the cursor resets", async ({
  page,
}) => {
  await installApi(page, "personal-pro", { metricScenario: true });
  const cursors: Array<string | null> = [];
  await page.route("**/v1/me/inbox?*", (route) => {
    cursors.push(new URL(route.request().url()).searchParams.get("cursor"));
    return route.fallback();
  });
  await page.goto("/notifications");
  await page.waitForSelector("[data-notifications-summary]");

  await page.click(".ops-sort__control button");
  await page.click('role=option[name="Oldest first"]');
  await expect.poll(() => rowCount(page)).toBe(28);

  const renderedIds = async () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll("li[data-inbox-item-key]")).map(
        (el) => el.getAttribute("data-inbox-item-key") ?? "",
      ),
    );

  await page.click('[data-notifications-metric="high"]');
  await expect.poll(() => rowCount(page)).toBe(26);

  // The control still reads Oldest first…
  await expect(page.locator(".ops-sort__control")).toContainText(
    "Oldest first",
  );
  // …and the rows are GENUINELY oldest-first, not merely labelled so. The
  // fixture stamps item N at (base minus N minutes), so the HIGHEST index is
  // the oldest: high-25 leads under Oldest first and high-0 is last.
  // Asserting both endpoints proves the ordering survived the view switch
  // rather than silently reverting to the newest-first default.
  const after = await renderedIds();
  expect(after[0]).toBe("tsa_failure:metric-high-25");
  expect(after[after.length - 1]).toBe("tsa_failure:metric-high-0");
  // Every request started from the beginning.
  expect(cursors.every((c) => c === null)).toBe(true);
});

test("an advanced filter survives a metric switch", async ({ page }) => {
  await openMetrics(page);
  await page.click('[data-action="toggle-advanced-filters"]');
  await page.click(
    '[data-inbox-filters-panel] [data-inbox-filter-chip="integrity"]',
  );
  await page.click('[data-action="close-advanced-filters"]');
  await expect(
    page.locator('[data-inbox-remove-filter="integrity"]'),
  ).toHaveCount(1);

  await page.click('[data-notifications-metric="high"]');
  await expect.poll(async () => selectedKeys(await selection(page))).toEqual([
    "high",
  ]);
  // Only the PRIMARY view was replaced.
  await expect(
    page.locator('[data-inbox-remove-filter="integrity"]'),
  ).toHaveCount(1);
});

// ===========================================================================
// §1 / §25 — a zero count is a fact, not a disabled control
// ===========================================================================

test("a zero-count card is visually identical to a populated one", async ({
  page,
}) => {
  await openMetrics(page);
  const measured = await page.evaluate(() => {
    const pick = (k: string) =>
      document.querySelector(
        `[data-notifications-metric="${k}"]`,
      ) as HTMLElement;
    const shape = (el: HTMLElement) => {
      const cs = getComputedStyle(el);
      const value = el.querySelector(
        ".app-metric-card__value",
      ) as HTMLElement;
      const label = el.querySelector(
        ".app-metric-card__label",
      ) as HTMLElement;
      const meta = el.querySelector(".app-metric-card__meta") as HTMLElement;
      const rail = getComputedStyle(el, "::before");
      return {
        opacity: cs.opacity,
        background: cs.backgroundColor,
        border: cs.borderTopColor,
        shadow: cs.boxShadow,
        radius: cs.borderTopLeftRadius,
        height: Math.round(el.getBoundingClientRect().height),
        railBg: rail.backgroundColor,
        railOpacity: rail.opacity,
        valueOpacity: getComputedStyle(value).opacity,
        labelColor: getComputedStyle(label).color,
        metaColor: getComputedStyle(meta).color,
        disabled: (el as HTMLButtonElement).disabled,
      };
    };
    // `critical` and `warning` are 0 here; `high` is 26.
    return {
      zeroA: shape(pick("critical")),
      zeroB: shape(pick("warning")),
      populated: shape(pick("high")),
      // The tone must still be the card's own canonical colour, not a muted
      // one — a faded accent would be de-emphasis by another name.
      zeroTone: getComputedStyle(pick("critical"))
        .getPropertyValue("--app-metric-tone")
        .trim(),
      zeroValueColor: getComputedStyle(
        pick("critical").querySelector(".app-metric-card__value") as HTMLElement,
      ).color,
    };
  });

  for (const zero of [measured.zeroA, measured.zeroB]) {
    expect(zero.opacity).toBe("1");
    expect(zero.valueOpacity).toBe("1");
    expect(zero.railOpacity).toBe(measured.populated.railOpacity);
    expect(zero.background).toBe(measured.populated.background);
    expect(zero.border).toBe(measured.populated.border);
    expect(zero.shadow).toBe(measured.populated.shadow);
    expect(zero.radius).toBe(measured.populated.radius);
    expect(zero.height).toBe(measured.populated.height);
    expect(zero.labelColor).toBe(measured.populated.labelColor);
    expect(zero.metaColor).toBe(measured.populated.metaColor);
    // A zero card is a live control, not an inert one.
    expect(zero.disabled).toBe(false);
  }
  // Critical keeps the canonical blue at zero.
  expect(measured.zeroTone.toLowerCase()).toBe("#2563eb");
  expect(measured.zeroValueColor).toBe("rgb(37, 99, 235)");
});

test("a zero-count card is still clickable, and leads somewhere", async ({
  page,
}) => {
  await openMetrics(page);
  await page.click('[data-notifications-metric="critical"]');
  await expect.poll(() => rowCount(page)).toBe(0);
  expect(selectedKeys(await selection(page))).toEqual(["critical"]);
  // And out again, in one click.
  await page.click('[data-notifications-metric="info"]');
  await expect.poll(() => rowCount(page)).toBe(2);
});

// ===========================================================================
// §3H / §27 — selection semantics and accessibility
// ===========================================================================

test("selection is announced, keyboard reachable and not colour-only", async ({
  page,
}) => {
  await openMetrics(page);
  const probe = await page.evaluate(() => {
    const el = document.querySelector(
      '[data-notifications-metric="all"]',
    ) as HTMLElement;
    el.focus();
    const focused = document.activeElement === el;
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      pressed: el.getAttribute("aria-pressed"),
      focused,
      // Selection is carried by a real attribute AND a surface change, never
      // by hue alone.
      describedBy: el.getAttribute("aria-describedby"),
      hasLabelText: Boolean(
        el.querySelector(".app-metric-card__label")?.textContent?.trim(),
      ),
      background: cs.backgroundColor,
    };
  });
  expect(probe.tag).toBe("BUTTON");
  expect(probe.pressed).toBe("true");
  expect(probe.focused).toBe(true);
  expect(probe.describedBy).toBeTruthy();
  expect(probe.hasLabelText).toBe(true);

  // The unselected cards paint a different surface, so "which is selected" is
  // legible without reading colour.
  const unselectedBg = await page.evaluate(
    () =>
      getComputedStyle(
        document.querySelector(
          '[data-notifications-metric="high"]',
        ) as HTMLElement,
      ).backgroundColor,
  );
  expect(unselectedBg).not.toBe(probe.background);
});

// ===========================================================================
// §23 — responsive + RTL over the new toolbar
// ===========================================================================

for (const vp of VIEWPORTS) {
  for (const dir of ["ltr", "rtl"] as const) {
    test(`metric row and toolbar hold at ${vp.name} / ${dir}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openMetrics(page);
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
      expect(m.cards).toBe(6);
      expect(m.quick).toBe(2);
      expect(m.minQuickHeight).toBeGreaterThanOrEqual(34);
    });
  }
}

// ===========================================================================
// THE CARDS DESCRIBE THE POPULATION THE READER IS LOOKING AT.
//
// They used to read `scopeSummary`, which is deliberately filter-INDEPENDENT
// (it drives the filter-chip reveal and must not shrink when a filter narrows).
// So selecting Archived showed the ACTIVE severity distribution above a list
// of archived rows: All said 3 while the list held 2, and High counted rows
// that were nowhere on screen.
// ===========================================================================

/** Every card's key → its rendered count. */
async function counts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const out: Record<string, number> = {};
    for (const el of Array.from(
      document.querySelectorAll("[data-notifications-metric]"),
    )) {
      out[el.getAttribute("data-notifications-metric")!] = Number(
        el.querySelector(".app-metric-card__value")?.textContent?.trim() ?? "-1",
      );
    }
    return out;
  });
}

test("Archived redistributes every card to the archived population", async ({
  page,
}) => {
  await installApi(page, "personal-pro", { archiveScenario: true });
  await page.goto("/notifications");
  await page.waitForSelector("[data-notifications-summary]", {
    timeout: 15_000,
  });

  // ACTIVE: 3 rows — 1 critical, 1 high, 1 warning; 2 of them unread.
  await expect.poll(() => counts(page)).toEqual({
    all: 3,
    unread: 2,
    critical: 1,
    high: 1,
    warning: 1,
    info: 0,
  });

  await page.click('[data-action="toggle-advanced-filters"]');
  await page.click(
    '[data-inbox-filters-panel] [data-inbox-filter-chip="archived"]',
  );
  await page.click('[data-action="close-advanced-filters"]');

  // ARCHIVED: 2 rows — 1 critical, 1 info; both read (archiving marks read).
  // Every card now describes THOSE two, and the total matches the list.
  await expect.poll(() => counts(page)).toEqual({
    all: 2,
    unread: 0,
    critical: 1,
    high: 0,
    warning: 0,
    info: 1,
  });
  await expect.poll(() => rowCount(page)).toBe(2);
});

test("the cards' own axes are excluded from their own basis", async ({
  page,
}) => {
  // This is the property that keeps the row usable as a set of alternatives.
  // If the tone were part of the basis, picking High would make High read its
  // own count and every other card read 0 — so the row would stop telling you
  // what is waiting behind the cards you did not pick.
  await openMetrics(page);
  const before = await counts(page);
  expect(before).toEqual({
    all: 28,
    unread: 0,
    critical: 0,
    high: 26,
    warning: 0,
    info: 2,
  });

  await page.click('[data-notifications-metric="high"]');
  await expect.poll(() => rowCount(page)).toBe(26);
  // Unchanged: the list narrowed, the basis did not.
  expect(await counts(page)).toEqual(before);

  await page.click('[data-notifications-metric="info"]');
  await expect.poll(() => rowCount(page)).toBe(2);
  expect(await counts(page)).toEqual(before);
});

test("sorting never changes a card count", async ({ page }) => {
  await openMetrics(page);
  const before = await counts(page);

  for (const label of ["Oldest first", "Unread first", "Highest severity"]) {
    await page.click(".ops-sort__control button");
    await page.click(`role=option[name="${label}"]`);
    await expect.poll(() => rowCount(page)).toBe(28);
    expect(await counts(page), label).toEqual(before);
  }
});

test("paging never changes a card count", async ({ page }) => {
  // The counts come from the server's full filtered population, not from the
  // rows this page happens to hold.
  await installApi(page, "personal-pro", { archiveScenario: true });
  await page.goto("/notifications?pageSize=1");
  await page.waitForSelector("[data-notifications-summary]", {
    timeout: 15_000,
  });
  const shown = await rowCount(page);
  const c = await counts(page);
  expect(c.all).toBeGreaterThanOrEqual(shown);
  expect(c.all).toBe(3);
});

// ===========================================================================
// THE FILTERED EMPTY STATE
// ===========================================================================

test("a filter that matches nothing gets a centred, actionable empty state", async ({
  page,
}) => {
  await openMetrics(page);
  await page.click('[data-notifications-metric="critical"]');
  await expect.poll(() => rowCount(page)).toBe(0);

  const empty = page.locator('[data-inbox-empty-reason="filters"]');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("No notifications match these filters.");
  await expect(empty).toContainText("Try changing or clearing");

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
  expect(measured.btnCanonical).toBe(true);
  expect(measured.btnPaddingX).toBeGreaterThanOrEqual(10);
  expect(measured.btnBorderWidth).toBeGreaterThan(0);
  expect(measured.btnRadius).toBeGreaterThan(0);
  expect(measured.btnHeight).toBeGreaterThanOrEqual(30);

  // Keyboard reachable, with a visible focus ring, and it works.
  const focused = await page.evaluate(() => {
    const btn = document.querySelector(
      '[data-action="clear-filter"]',
    ) as HTMLElement;
    btn.focus();
    return document.activeElement === btn;
  });
  expect(focused).toBe(true);
});

test("the three empty states stay distinct", async ({ page }) => {
  // An empty archive is not a broken filter, and neither is an empty inbox.
  await installApi(page, "personal-pro", { archiveScenario: true });
  await page.goto("/notifications");
  await page.waitForSelector("[data-inbox-toolbar]", { timeout: 15_000 });

  // `integrity` selects `ots_failure`; every fixture row is `tsa_failure`,
  // so this is a filter that legitimately matches nothing.
  await page.click('[data-action="toggle-advanced-filters"]');
  await page.click(
    '[data-inbox-filters-panel] [data-inbox-filter-chip="integrity"]',
  );
  await page.click('[data-action="close-advanced-filters"]');
  await expect.poll(() => rowCount(page)).toBe(0);
  await expect(
    page.locator('[data-inbox-empty-reason="filters"]'),
  ).toBeVisible();

  // Nothing at all reads as "caught up", with no clear-filters action.
  await installApi(page, "personal-pro", { emptyInbox: true });
  await page.goto("/notifications");
  await page.waitForSelector("[data-state='empty']", { timeout: 15_000 });
  await expect(page.locator("[data-state='empty']")).toContainText(
    /all caught up/i,
  );
  await expect(page.locator('[data-action="clear-filter"]')).toHaveCount(0);
});
