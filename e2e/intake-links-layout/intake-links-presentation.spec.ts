/**
 * CODE-ONLY PRESENTATION PROOF — /intake-links.
 *
 * Class names prove nothing on their own: a class can exist and resolve to
 * nothing, and the cascade can hand a token to one surface and not to another.
 * Every assertion here reads a COMPUTED value out of the real production
 * bundle, through the real stylesheet order, in a real engine.
 *
 * Screenshots are deliberately absent. This answers "is the redesigned
 * presentation the one actually painting", never "does it look right".
 */

import { expect, test, type Page } from "@playwright/test";

import {
  LONG,
  ROWS,
  openIntakeLinks,
  openWizard,
  type IntakeContext,
} from "./_fixtures";

const CONTEXTS: IntakeContext[] = [
  "personal",
  "organization",
  "enterprise",
  "admin",
];

/** Resolve a computed property for one selector, in the page. */
async function computed(
  page: Page,
  selector: string,
  prop: string,
): Promise<string> {
  return page.evaluate(
    ([sel, p]) => {
      const el = document.querySelector(sel as string);
      if (!el) return "<missing>";
      return getComputedStyle(el).getPropertyValue(p as string).trim();
    },
    [selector, prop],
  );
}

/** Parse `rgb(r, g, b)` / `rgba(...)` into a comparable triple. */
function rgb(value: string): [number, number, number] | null {
  const m = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Relative luminance, for a real contrast computation. */
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: string, b: string): number {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return 0;
  const l1 = luminance(x);
  const l2 = luminance(y);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// ===========================================================================
// The canonical shell is mounted, and the old one is not
// ===========================================================================

test.describe("the canonical shell is the one that renders", () => {
  for (const context of CONTEXTS) {
    test(`${context}: PageShell geometry, not the retired 920px column`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openIntakeLinks(page, context);

      const shell = page.locator("[data-ui-page-shell]");
      await expect(shell).toHaveCount(1);

      const geometry = await page.evaluate(() => {
        const el = document.querySelector(
          "[data-ui-page-shell]",
        ) as HTMLElement;
        const cs = getComputedStyle(el);
        const root = getComputedStyle(document.documentElement);
        return {
          maxWidth: cs.maxWidth,
          width: el.getBoundingClientRect().width,
          pageMaxToken: root.getPropertyValue("--page-max-w").trim(),
        };
      });

      // The token resolves — the shell is clamped by the design system, not by
      // a number a page invented for itself.
      expect(geometry.pageMaxToken).toBe("1360px");
      expect(geometry.maxWidth).toBe("1360px");
      // The defect this redesign exists to remove: the old page clamped itself
      // to 920px and rendered a nine-column table into 872px of it.
      expect(geometry.maxWidth).not.toBe("920px");
      expect(geometry.width).toBeGreaterThan(1000);
    });
  }

  test("no retired implementation, control or class survives in the DOM", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");

    const found = await page.evaluate(() => {
      const root = document.querySelector(
        '[data-testid="intake-links-page"]',
      ) as HTMLElement;
      const bad: Record<string, number> = {};
      const count = (label: string, sel: string) => {
        const n = root.querySelectorAll(sel).length;
        if (n > 0) bad[label] = n;
      };
      // Retired controls.
      count("native select", "select");
      count("native optgroup", "optgroup");
      // Retired families. A hidden legacy node counts too — `querySelectorAll`
      // does not care whether it is displayed.
      for (const cls of [
        "cases-panel",
        "cases-empty",
        "cases-form-input",
        "ec-section",
        "ec-summary-tile",
      ]) {
        count(cls, `.${cls}`);
      }
      // Retired probes from the deleted operations console.
      count("legacy lifecycle chip", "[data-intake-links-row-lifecycle-chip]");
      count("legacy kpi strip", "ul[data-intake-links-kpis] > li > button.kpi");
      return bad;
    });
    expect(found).toEqual({});
  });

  test("checkbox and radio presentation is the redesigned one, not the browser default", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");
    await openWizard(page);

    const radio = await page.evaluate(() => {
      const el = document.querySelector(
        ".ilk-choice__input",
      ) as HTMLInputElement;
      const cs = getComputedStyle(el);
      return {
        appearance: cs.appearance || cs.webkitAppearance,
        width: cs.width,
        borderRadius: cs.borderRadius,
      };
    });
    // `appearance: none` is what removes the OS control; without it every
    // other declaration is decoration on top of a native widget.
    expect(radio.appearance).toBe("none");
    expect(radio.width).toBe("18px");

    // Step 3 owns the accepted-file-type checkboxes.
    await page.click("[data-intake-link-wizard-next]");
    await page.click('[data-intake-link-delivery-method-input="MANUAL"]');
    await page.click("[data-intake-link-wizard-next]");
    const checkbox = await page.evaluate(() => {
      const el = document.querySelector(".app-checkbox") as HTMLInputElement;
      const cs = getComputedStyle(el);
      return {
        appearance: cs.appearance || cs.webkitAppearance,
        width: cs.width,
        background: cs.backgroundColor,
        checked: el.checked,
      };
    });
    expect(checkbox.appearance).toBe("none");
    expect(checkbox.width).toBe("18px");
    // A checked canonical checkbox paints the indigo selection colour.
    if (checkbox.checked) {
      expect(rgb(checkbox.background)).toEqual([109, 40, 217]);
    }
  });
});

// ===========================================================================
// KPI anatomy and the mandated tone mapping — resolved, not asserted by class
// ===========================================================================

test.describe("KPI cards resolve the mandated tones", () => {
  const EXPECTED: Array<[string, [number, number, number], string]> = [
    // key, resolved rail colour, label
    ["total", [100, 116, 139], "Total links"],
    ["active", [109, 40, 217], "Active"],
    ["submitted", [37, 99, 235], "Submitted"],
    ["opened", [22, 122, 91], "Opened"],
    ["failedDelivery", [201, 54, 62], "Failed delivery"],
    ["archived", [100, 116, 139], "Archived"],
    ["revokedOrExpired", [201, 54, 62], "Revoked or expired"],
  ];

  test("each card's tone variable resolves to the canonical semantic colour", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");

    for (const [key, expectedRgb, label] of EXPECTED) {
      const measured = await page.evaluate((k) => {
        const el = document.querySelector(
          `[data-intake-links-kpi="${k}"]`,
        ) as HTMLElement;
        if (!el) return null;
        const cs = getComputedStyle(el);
        const rail = getComputedStyle(el, "::before");
        return {
          // The custom property the card declares, resolved by the cascade.
          tone: cs.getPropertyValue("--ilk-tone").trim(),
          railBackground: rail.backgroundColor,
          railWidth: rail.width,
          label: (
            el.querySelector(".ilk-kpi__label") as HTMLElement
          )?.textContent?.trim(),
          valueFontSize: getComputedStyle(
            el.querySelector(".ilk-kpi__value") as HTMLElement,
          ).fontSize,
          labelFontSize: getComputedStyle(
            el.querySelector(".ilk-kpi__label") as HTMLElement,
          ).fontSize,
        };
      }, key);

      expect(measured, `no KPI card for ${key}`).not.toBeNull();
      expect(measured!.label).toBe(label);
      // The rail really paints the tone — the variable is not merely declared.
      expect(rgb(measured!.railBackground), `${key} rail`).toEqual(expectedRgb);
      expect(measured!.railWidth).toBe("3px");
      // Value and label occupy DISTINCT typographic tiers.
      expect(parseFloat(measured!.valueFontSize)).toBeGreaterThan(
        parseFloat(measured!.labelFontSize) + 6,
      );
    }
  });

  test("the number is painted in its own card's tone", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");

    const cards = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-intake-links-kpi]"),
      ).map((el) => {
        const rail = getComputedStyle(el, "::before").backgroundColor;
        const value = el.querySelector(".ilk-kpi__value") as HTMLElement;
        const label = el.querySelector(".ilk-kpi__label") as HTMLElement;
        const meta = el.querySelector(".ilk-kpi__meta") as HTMLElement;
        const surface = getComputedStyle(el).backgroundColor;
        return {
          key: el.getAttribute("data-intake-links-kpi"),
          rail,
          surface,
          valueColor: getComputedStyle(value).color,
          labelColor: getComputedStyle(label).color,
          metaColor: meta ? getComputedStyle(meta).color : null,
          valueText: value.textContent?.trim() ?? "",
        };
      }),
    );
    expect(cards.length).toBe(7);

    for (const c of cards) {
      // ONE tone per card: the rail and the number resolve the same custom
      // property, so a card can never disagree with its own number.
      expect(rgb(c.valueColor), `${c.key} number`).toEqual(rgb(c.rail));
      // …and the number is still a number.
      expect(c.valueText).toMatch(/^\d+$/);
      // The supporting copy stays neutral — the card is toned, not shouted.
      expect(rgb(c.metaColor!), `${c.key} note`).not.toEqual(rgb(c.rail));
      expect(rgb(c.labelColor), `${c.key} label`).not.toEqual(rgb(c.rail));
      // A toned number is still readable on the card it sits on.
      expect(
        contrast(c.valueColor, c.surface),
        `${c.key} number contrast`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    // The card surfaces stay restrained: no card is filled with its tone.
    for (const c of cards) {
      expect(rgb(c.surface), `${c.key} surface`).not.toEqual(rgb(c.rail));
    }
  });

  test("cards in a row are equal height and none is painted as focused", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");

    const rows = await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll<HTMLElement>(".ilk-kpi"),
      );
      const byTop: Record<number, number[]> = {};
      for (const c of cards) {
        const r = c.getBoundingClientRect();
        (byTop[Math.round(r.top)] ||= []).push(Math.round(r.height));
      }
      return Object.values(byTop);
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const heights of rows) {
      expect(new Set(heights).size).toBe(1);
    }

    // Only the KPI whose filter is in force is pressed, and the unselected
    // cards carry no focus-looking border.
    const borders = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".ilk-kpi")).map((c) => ({
        pressed: c.getAttribute("aria-pressed"),
        borderColor: getComputedStyle(c).borderTopColor,
      })),
    );
    expect(borders.filter((b) => b.pressed === "true").length).toBe(1);
    for (const b of borders.filter((x) => x.pressed === "false")) {
      // The old surface painted `#1e40af` on Total. Nothing may resolve to a
      // saturated blue on an unselected card.
      const c = rgb(b.borderColor);
      expect(c && c[2] > 150 && c[2] - c[0] > 60).toBeFalsy();
    }
  });
});

// ===========================================================================
// Row anatomy: three regions, canonical badges, real tones
// ===========================================================================

test.describe("records surface anatomy", () => {
  test("lifecycle, activity and delivery are three separate painted regions", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");

    const measured = await page.evaluate(() => {
      const row = document.querySelector(
        '[data-intake-links-row-id="r-archived-submitted"]',
      ) as HTMLElement;
      // The probe sits ON the badge in the Lifecycle column and on the <dd>
      // that wraps it in Delivery & activity — read the badge either way, so
      // the boxes compared are the painted ones.
      const badge = (sel: string) => {
        const holder = row.querySelector(sel) as HTMLElement;
        return holder.classList.contains("app-status-badge")
          ? holder
          : (holder.querySelector(".app-status-badge") as HTMLElement);
      };
      const life = badge("[data-intake-links-row-link-state]");
      const act = badge("[data-intake-links-row-session-state]");
      const del = badge("[data-intake-links-row-delivery]");
      const box = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      return {
        lifecycle: { ...box(life), text: life.textContent?.trim() },
        activity: { ...box(act), text: act.textContent?.trim() },
        delivery: { ...box(del), text: del.textContent?.trim() },
        sameCell: life.closest("td") === act.closest("td"),
        lifecycleBg: getComputedStyle(life).backgroundColor,
        activityBg: getComputedStyle(act).backgroundColor,
      };
    });

    expect(measured.lifecycle.text).toBe("Archived");
    expect(measured.activity.text).toBe("Submitted");
    expect(measured.delivery.text).toBe("Queued with provider");
    expect(measured.sameCell).toBe(false);

    // Painted boxes do not intersect — the concatenation defect cannot recur.
    const intersects =
      measured.lifecycle.left < measured.activity.right - 0.5 &&
      measured.activity.left < measured.lifecycle.right - 0.5 &&
      measured.lifecycle.top < measured.activity.bottom - 0.5 &&
      measured.activity.top < measured.lifecycle.bottom - 0.5;
    expect(intersects).toBe(false);

    // The two chips are visually distinguishable, and both resolve a real
    // badge surface rather than inheriting the row background.
    expect(measured.lifecycleBg).not.toBe(measured.activityBg);
    expect(rgb(measured.lifecycleBg)).not.toBeNull();
  });

  test("badge tones resolve to the canonical semantic palette", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");

    const read = (attr: string) =>
      page.evaluate((a) => {
        const out: Record<
          string,
          {
            tone: string;
            fill: string;
            color: string;
            background: string;
            text: string;
            radius: string;
            height: number;
            lineHeight: number;
            lines: number;
            width: number;
            cellWidth: number;
          }
        > = {};
        for (const holder of Array.from(
          document.querySelectorAll<HTMLElement>(
            `.ilk-records--wide [${a}]`,
          ),
        )) {
          const state = holder.getAttribute(a)!;
          if (out[state]) continue;
          const el = holder.classList.contains("app-status-badge")
            ? holder
            : (holder.querySelector(".app-status-badge") as HTMLElement);
          if (!el) continue;
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          out[state] = {
            tone: el.getAttribute("data-tone") ?? "",
            fill: el.getAttribute("data-fill") ?? "",
            color: cs.color,
            background: cs.backgroundColor,
            text: el.textContent?.trim() ?? "",
            radius: cs.borderTopLeftRadius,
            height: Math.round(r.height),
            lineHeight: parseFloat(cs.lineHeight),
            lines: Math.max(
              1,
              Math.round(
                (r.height -
                  parseFloat(cs.paddingTop) -
                  parseFloat(cs.paddingBottom)) /
                  parseFloat(cs.lineHeight),
              ),
            ),
            width: Math.round(r.width),
            cellWidth: Math.round(
              (el.closest("td") as HTMLElement).getBoundingClientRect().width,
            ),
          };
        }
        return out;
      }, attr);

    const life = await read("data-intake-links-row-link-state");
    const activity = await read("data-intake-links-row-session-state");

    // ONE map, and these are the corrections it now carries: Expired reads as
    // information rather than as a second neutral, Submitted as a completed
    // outcome, and a link nobody has opened as the shared attention orange.
    const MANDATED: Array<
      [Record<string, { tone: string; text: string }>, string, string, string]
    > = [
      [life, "EXPIRED", "blue", "Expired"],
      [life, "REVOKED", "red", "Link disabled"],
      [life, "ARCHIVED", "slate", "Archived"],
      [life, "ACTIVE", "indigo", "Active"],
      [activity, "SUBMITTED", "green", "Submitted"],
      [activity, "NO_ACTIVITY", "orange", "Not opened"],
      [activity, "OPENED", "green", "Opened"],
    ];
    for (const [group, state, tone, text] of MANDATED) {
      expect(group[state], `${state} absent from the fixture`).toBeTruthy();
      expect(group[state].tone, state).toBe(tone);
      // Colour never carries the state alone.
      expect(group[state].text, state).toBe(text);
    }

    // The tone tokens really paint. These are the resolved values of
    // `--info`, `--error`, `--ink-secondary`, `--accent-600`, `--success-ink`
    // and `--orange-fill` — read out of the engine, not asserted from names.
    const FILL: Record<string, [number, number, number]> = {
      blue: [37, 99, 235],
      red: [220, 38, 38],
      slate: [71, 85, 105],
      indigo: [109, 40, 217],
      green: [22, 122, 91],
      orange: [249, 115, 22],
    };
    const all = { ...life, ...activity };
    for (const [state, v] of Object.entries(all)) {
      // The compact filled rectangle, identically for every state.
      expect(v.fill, state).toBe("solid");
      expect(v.radius, state).toBe("4px");
      expect(rgb(v.color), `${state} ink`).toEqual([255, 255, 255]);
      const expected = FILL[v.tone];
      expect(expected, `${state} has an unmapped tone ${v.tone}`).toBeTruthy();
      expect(rgb(v.background), `${state} fill`).toEqual(expected);
      // Content-width, never a stretched slab.
      expect(v.width, state).toBeLessThan(v.cellWidth);
    }
    // Stable height: the badge is sized by its own padding and line-height, so
    // every state that fits one line measures exactly the same. (Inside this
    // table a long phrase is deliberately allowed to wrap rather than overflow
    // its column, so a two-line badge is taller by whole line-heights — that is
    // the wrapping, not the treatment, and it is measured as such below.)
    const oneLine = Object.values(all).filter((v) => v.lines === 1);
    expect(oneLine.length).toBeGreaterThan(2);
    expect(new Set(oneLine.map((v) => v.height)).size).toBe(1);
    const unit = oneLine[0]!;
    for (const v of Object.values(all)) {
      expect(
        Math.abs(v.height - (unit.height + (v.lines - 1) * unit.lineHeight)),
        `${v.text} is not a whole number of lines tall`,
      ).toBeLessThanOrEqual(1.5);
    }
  });

  test("the filled badges keep readable ink, and the one exception is measured", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");

    const measured = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '.ilk-records--wide .app-status-badge[data-fill="solid"]',
        ),
      ).map((el) => {
        const cs = getComputedStyle(el);
        return {
          tone: el.getAttribute("data-tone") ?? "",
          color: cs.color,
          background: cs.backgroundColor,
        };
      }),
    );
    expect(measured.length).toBeGreaterThan(0);

    const byTone = new Map<string, number>();
    for (const m of measured) {
      byTone.set(m.tone, contrast(m.color, m.background));
    }

    // Every tone this surface uses clears AA for its own ink…
    for (const [tone, ratio] of byTone) {
      if (tone === "orange") continue;
      expect(ratio, `${tone} contrast`).toBeGreaterThanOrEqual(4.5);
    }
    // …except the shared attention orange, which is the exact treatment the
    // redesigned Search classification labels wear (`--orange-fill` with white
    // ink). It is pinned here so the number is a measured fact rather than an
    // assumption, and so changing the shared token cannot pass unnoticed. It
    // does NOT carry meaning alone: the badge always states "Not opened", and
    // the same fact is available in the Activity filter and the drawer.
    const orange = byTone.get("orange");
    expect(orange, "no orange badge in the fixture").toBeTruthy();
    expect(orange!).toBeGreaterThan(2.5);
    expect(orange!).toBeLessThan(3.2);
  });

  test("expiry prints a date, and never the lifecycle word", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");
    const cells = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          ".ilk-records--wide [data-intake-links-row-expires]",
        ),
      ).map((el) => {
        const date = el.querySelector(
          "[data-intake-links-row-expiry-date]",
        ) as HTMLElement;
        const hidden = el.querySelector(".app-visually-hidden") as HTMLElement;
        const hiddenCs = getComputedStyle(hidden);
        return {
          state: el.getAttribute("data-intake-links-row-expires"),
          visible: date.textContent?.trim() ?? "",
          color: getComputedStyle(date).color,
          // The date never wraps or fragments — it is one unbroken run.
          whiteSpace: getComputedStyle(date).whiteSpace,
          lines: Math.round(
            date.getBoundingClientRect().height /
              parseFloat(getComputedStyle(date).lineHeight),
          ),
          fits:
            date.getBoundingClientRect().width <=
            (el.closest("td") as HTMLElement).getBoundingClientRect().width + 1,
          // Assistive text is present but takes no space.
          atText: hidden.textContent ?? "",
          atWidth: Math.round(hidden.getBoundingClientRect().width),
          atPosition: hiddenCs.position,
          title: el.getAttribute("title") ?? "",
        };
      }),
    );

    const expired = cells.filter((c) => c.state === "expired");
    const ok = cells.filter((c) => c.state === "ok");
    expect(expired.length).toBeGreaterThan(0);
    expect(ok.length).toBeGreaterThan(0);

    for (const c of cells) {
      // A real formatted date, and nothing else.
      expect(c.visible).toMatch(/\d{1,2}\s+\w{3}\s+\d{4}/);
      expect(c.visible).not.toMatch(/Expired|Expires/);
      expect(c.whiteSpace).toBe("nowrap");
      expect(c.lines).toBe(1);
      expect(c.fits).toBe(true);
      // The full local timestamp is still one hover away.
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.atWidth).toBeLessThanOrEqual(1);
      expect(c.atPosition).toBe("absolute");
    }
    for (const c of expired) {
      // The word moved to assistive text; the ink is no longer danger red.
      expect(c.atText).toContain("Expired on");
      expect(rgb(c.color)).not.toEqual([201, 54, 62]);
      expect(rgb(c.color)).not.toEqual([220, 38, 38]);
    }
    for (const c of ok) expect(c.atText).toContain("Expires on");

    // Expired links say so exactly once per row, in the Lifecycle column.
    const stated = await page.evaluate(() => {
      const row = document.querySelector(
        '.ilk-records--wide [data-intake-links-row-id="r-expired"]',
      ) as HTMLElement;
      const badge = row.querySelector(
        "[data-intake-links-row-link-state]",
      ) as HTMLElement;
      // VISIBLE text only. The expiry cell's assistive prefix says "Expired on"
      // on purpose — that is the relationship the sighted reader gets from the
      // two cells being side by side.
      const visible = row.cloneNode(true) as HTMLElement;
      for (const hidden of Array.from(
        visible.querySelectorAll(".app-visually-hidden"),
      )) {
        hidden.remove();
      }
      return {
        count: (visible.textContent ?? "").split("Expired").length - 1,
        column: (badge.closest("td") as HTMLElement).getAttribute("data-col"),
      };
    });
    expect(stated.count).toBe(1);
    expect(stated.column).toBe("lifecycle");
  });

  test("row actions are a menu on the canonical overlay, never a selector", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");

    const trigger = page
      .locator(".ilk-records--wide [data-intake-links-row-menu-trigger]")
      .first();
    await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await trigger.click();
    await page.waitForSelector('[role="menu"]');

    const menu = await page.evaluate(() => {
      const m = document.querySelector('[role="menu"]') as HTMLElement;
      const overlay = m.closest(".app-anchored-overlay") as HTMLElement;
      const cs = getComputedStyle(overlay);
      return {
        portaled: overlay.parentElement === document.body,
        position: cs.position,
        zIndex: cs.zIndex,
        insideTable: Boolean(m.closest("table")),
        items: m.querySelectorAll('[role="menuitem"]').length,
      };
    });
    // Escaping the table is the whole reason the canonical overlay exists.
    expect(menu.portaled).toBe(true);
    expect(menu.position).toBe("fixed");
    expect(Number(menu.zIndex)).toBeGreaterThan(1000);
    expect(menu.insideTable).toBe(false);
    expect(menu.items).toBeGreaterThan(1);
  });
});

// ===========================================================================
// Wizard anatomy
// ===========================================================================

test.describe("wizard anatomy", () => {
  test("head, stepper, single scrolling body and a footer that stays put", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");
    await openWizard(page);

    const shape = await page.evaluate(() => {
      const dlg = document.querySelector(
        '[data-testid="intake-link-create-wizard"]',
      ) as HTMLElement;
      const scrollers = Array.from(dlg.querySelectorAll<HTMLElement>("*")).filter(
        (el) => {
          const cs = getComputedStyle(el);
          const scrollable =
            cs.overflowY === "auto" || cs.overflowY === "scroll";
          return scrollable && el.scrollHeight > el.clientHeight + 1;
        },
      );
      const head = dlg.querySelector(".app-dialog__head") as HTMLElement;
      const foot = dlg.querySelector(".app-dialog__footer") as HTMLElement;
      const body = dlg.querySelector(".app-dialog__body") as HTMLElement;
      return {
        hasHead: Boolean(head),
        hasStepper: Boolean(dlg.querySelector("[data-intake-link-stepper]")),
        steps: dlg.querySelectorAll("[data-intake-link-step]").length,
        scrollerClasses: scrollers.map((s) => s.className),
        headSticksAbove: head.getBoundingClientRect().top <= body.getBoundingClientRect().top,
        footSticksBelow:
          foot.getBoundingClientRect().bottom >=
          body.getBoundingClientRect().bottom,
        dialogFits:
          dlg.getBoundingClientRect().height <=
          document.documentElement.clientHeight + 1,
      };
    });

    expect(shape.hasHead).toBe(true);
    expect(shape.hasStepper).toBe(true);
    expect(shape.steps).toBe(4);
    // AT MOST one scrolling region, and if there is one it is the body. Two
    // would be the double-scroll trap; zero simply means this step fits.
    expect(shape.scrollerClasses.length).toBeLessThanOrEqual(1);
    for (const c of shape.scrollerClasses) {
      expect(c).toContain("app-dialog__body");
    }
    expect(shape.headSticksAbove).toBe(true);
    expect(shape.footSticksBelow).toBe(true);
    expect(shape.dialogFits).toBe(true);
  });

  test("file types render as selectable chips, not uppercase enum words", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");
    await openWizard(page);
    await page.click("[data-intake-link-wizard-next]");
    await page.click('[data-intake-link-delivery-method-input="MANUAL"]');
    await page.click("[data-intake-link-wizard-next]");

    const chips = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-intake-link-accepted-kind]"),
      ).map((el) => {
        const cs = getComputedStyle(el);
        const input = el.querySelector("input") as HTMLInputElement;
        const r = el.getBoundingClientRect();
        return {
          label: (el.querySelector(".ilk-kind__label") as HTMLElement)
            ?.textContent,
          borderRadius: cs.borderRadius,
          minHeight: r.height,
          checked: input.checked,
          borderColor: cs.borderColor,
          hasIcon: Boolean(el.querySelector("svg")),
        };
      }),
    );

    expect(chips.map((c) => c.label)).toEqual([
      "Photos",
      "Videos",
      "Audio",
      "Documents",
    ]);
    for (const c of chips) {
      expect(parseFloat(c.borderRadius)).toBeGreaterThan(6);
      // A real target, not a 13px native box with a word beside it.
      expect(c.minHeight).toBeGreaterThanOrEqual(44);
      expect(c.hasIcon).toBe(true);
    }
    // A selected chip paints its selection; an unselected one does not.
    const selected = chips.filter((c) => c.checked);
    const unselected = chips.filter((c) => !c.checked);
    expect(selected.length).toBeGreaterThan(0);
    if (unselected.length > 0) {
      expect(selected[0].borderColor).not.toBe(unselected[0].borderColor);
    }
  });

  test("the message preview is a read-only region carrying the placeholder", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");
    await openWizard(page);
    await page.click("[data-intake-link-wizard-next]");
    await page.click('[data-intake-link-delivery-method-input="SMS"]');
    await page.fill("[data-intake-link-phone]", "+14155550123");
    await page.click("[data-intake-link-wizard-next]");
    await page.click("[data-intake-link-wizard-next]");

    const preview = await page.evaluate(() => {
      const studio = document.querySelector(
        '[data-intake-link-preview-studio="true"]',
      ) as HTMLElement;
      const body = studio.querySelector(
        '[data-intake-link-preview-body="true"]',
      ) as HTMLElement;
      const cs = getComputedStyle(body);
      const r = body.getBoundingClientRect();
      const sr = studio.getBoundingClientRect();
      return {
        tag: body.tagName,
        editable: body.isContentEditable,
        inputs: studio.querySelectorAll("input, textarea").length,
        whiteSpace: cs.whiteSpace,
        unicodeBidi: cs.unicodeBidi,
        overflowX: body.scrollWidth - body.clientWidth,
        containedInStudio: r.right <= sr.right + 1 && r.left >= sr.left - 1,
        text: body.textContent ?? "",
      };
    });

    expect(preview.tag).toBe("PRE");
    expect(preview.editable).toBe(false);
    expect(preview.inputs).toBe(0);
    expect(preview.whiteSpace).toBe("pre-wrap");
    expect(preview.unicodeBidi).toBe("plaintext");
    expect(preview.overflowX).toBe(0);
    expect(preview.containedInStudio).toBe(true);
    expect(preview.text).toContain("[secure-link]");
  });
});

// ===========================================================================
// The global primitive this redesign added
// ===========================================================================

test.describe("the added success-alert primitive", () => {
  test("resolves a distinct, readable success surface", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");

    const measured = await page.evaluate(() => {
      // Mount the three alert variants side by side, in the real cascade, and
      // read what each resolves to.
      const host = document.createElement("div");
      host.innerHTML = `
        <p class="app-alert" id="a-base">base</p>
        <p class="app-alert app-alert--ok" id="a-ok">ok</p>
        <p class="app-alert app-alert--warn" id="a-warn">warn</p>
        <p class="app-alert app-alert--danger" id="a-danger">danger</p>`;
      document.body.appendChild(host);
      const read = (id: string) => {
        const el = document.getElementById(id) as HTMLElement;
        const cs = getComputedStyle(el);
        return { color: cs.color, background: cs.backgroundColor };
      };
      const out = {
        base: read("a-base"),
        ok: read("a-ok"),
        warn: read("a-warn"),
        danger: read("a-danger"),
      };
      host.remove();
      return out;
    });

    // It resolves at all — a class that exists only in a stylesheet nobody
    // ships is not a primitive.
    expect(rgb(measured.ok.color)).toEqual([22, 122, 91]);
    // …and it is distinct from every sibling tone, so a success can never be
    // mistaken for a caution, a failure, or a neutral hint.
    for (const other of ["base", "warn", "danger"] as const) {
      expect(measured.ok.color).not.toBe(measured[other].color);
      expect(measured.ok.background).not.toBe(measured[other].background);
    }
    // Readable: real contrast, computed, not assumed.
    expect(contrast(measured.ok.color, measured.ok.background)).toBeGreaterThan(
      4.5,
    );
  });
});

// ===========================================================================
// Long values are held by the layout, in every context
// ===========================================================================

test.describe("long values stay inside their surfaces", () => {
  for (const context of CONTEXTS) {
    test(`${context}: the long-text row is whole and contained`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openIntakeLinks(page, context, {
        workspaceName: LONG.workspace,
        rows: ROWS,
      });

      const measured = await page.evaluate(() => {
        const row = document.querySelector(
          '.ilk-records--wide [data-intake-links-row-id="r-long"]',
        ) as HTMLElement;
        const escapes: string[] = [];
        for (const td of Array.from(row.querySelectorAll("td"))) {
          const tr = td.getBoundingClientRect();
          for (const el of Array.from(td.querySelectorAll<HTMLElement>("*"))) {
            const cs = getComputedStyle(el);
            if (cs.display === "none") continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            if (r.right > tr.right + 1 || r.left < tr.left - 1) {
              escapes.push(
                `${td.getAttribute("data-col")}: ${(el.textContent ?? "").slice(0, 30)}`,
              );
            }
          }
        }
        return {
          escapes,
          docOverflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
          titleWhole: (row.textContent ?? "").includes("NB-2026-08-14-0097"),
        };
      });

      expect(measured.escapes).toEqual([]);
      expect(measured.docOverflow).toBe(0);
      // Contained, not truncated away: the identifying tail is still present.
      expect(measured.titleWhole).toBe(true);
    });
  }
});

// ===========================================================================
// Wizard label ink — measured, not asserted from token names
// ===========================================================================

/**
 * The resolved value of `--app-ink-label` (#344054). Every visible label on
 * this surface must land on it, whichever element it happens to be.
 */
const LABEL_INK: [number, number, number] = [52, 64, 84];

/** Read every visible label in the wizard, with its painted ink and ground. */
async function readWizardLabels(page: Page) {
  return page.evaluate(() => {
    const dialog = document.querySelector(
      '[data-testid="intake-link-create-wizard"]',
    ) as HTMLElement;

    /** Walk up until something actually paints a background. */
    const ground = (el: HTMLElement): string => {
      let node: HTMLElement | null = el;
      while (node) {
        const bg = getComputedStyle(node).backgroundColor;
        const m = bg.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?/);
        if (m && (m[4] === undefined || Number(m[4]) > 0.6)) return bg;
        node = node.parentElement;
      }
      return "rgb(255, 255, 255)";
    };

    const selectors = [
      ["field label", ".app-dialog__body label.app-field-label"],
      ["group legend", ".ilk-fieldset__legend"],
      ["choice title", ".ilk-choice__title"],
      ["file type label", ".ilk-kind__label"],
      ["review group", ".ilk-review__title"],
      ["review fact", ".ilk-facts dt"],
      ["preview title", ".ilk-preview__title"],
      ["preview fact", ".ilk-preview__meta dt"],
    ] as const;

    const out: Array<{
      kind: string;
      text: string;
      color: string;
      background: string;
      fontSize: number;
      fontWeight: number;
    }> = [];
    for (const [kind, sel] of selectors) {
      for (const el of Array.from(dialog.querySelectorAll<HTMLElement>(sel))) {
        const cs = getComputedStyle(el);
        if (cs.display === "none") continue;
        out.push({
          kind,
          text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
          color: cs.color,
          background: ground(el),
          fontSize: parseFloat(cs.fontSize),
          fontWeight: Number(cs.fontWeight),
        });
      }
    }

    // The tiers a label must stay above.
    const help = dialog.querySelector(".app-field-help") as HTMLElement | null;
    const desc = dialog.querySelector(".ilk-choice__desc") as HTMLElement | null;
    return {
      labels: out,
      helpColor: help ? getComputedStyle(help).color : null,
      descColor: desc ? getComputedStyle(desc).color : null,
    };
  });
}

test.describe("wizard label hierarchy is painted, not merely classed", () => {
  /** Drive the wizard into a branch and measure what that branch renders. */
  async function branch(
    page: Page,
    context: IntakeContext,
    steps: (p: Page) => Promise<void>,
  ) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, context);
    await openWizard(page);
    await steps(page);
    return readWizardLabels(page);
  }

  const BRANCHES: Array<[string, (p: Page) => Promise<void>]> = [
    ["step 1 — request", async () => {}],
    [
      "step 2 — email + custom sender",
      async (p) => {
        await p.click("[data-intake-link-wizard-next]");
        await p.click('[data-intake-link-delivery-method-input="EMAIL"]');
        await p.click('[data-intake-link-sender-card-input="CUSTOM"]');
      },
    ],
    [
      "step 2 — copy link",
      async (p) => {
        await p.click("[data-intake-link-wizard-next]");
        await p.click('[data-intake-link-delivery-method-input="MANUAL"]');
      },
    ],
    [
      "step 3 — rules, location required",
      async (p) => {
        await p.click("[data-intake-link-wizard-next]");
        await p.click('[data-intake-link-delivery-method-input="MANUAL"]');
        await p.click("[data-intake-link-wizard-next]");
        await p.click('[data-intake-link-location-card-input="REQUIRED"]');
      },
    ],
    [
      "step 4 — review with a message preview",
      async (p) => {
        await p.click("[data-intake-link-wizard-next]");
        await p.click('[data-intake-link-delivery-method-input="SMS"]');
        await p.fill("[data-intake-link-phone]", "+14155550123");
        await p.click("[data-intake-link-wizard-next]");
        await p.click("[data-intake-link-wizard-next]");
      },
    ],
  ];

  for (const [name, steps] of BRANCHES) {
    test(`${name}: every label resolves the label ink`, async ({ page }) => {
      const { labels, helpColor, descColor } = await branch(
        page,
        "organization",
        steps,
      );
      expect(labels.length, `${name} rendered no labels`).toBeGreaterThan(0);

      for (const l of labels) {
        // A label is either the label ink itself, or the HEADING ink — the
        // tier above it. What it may never be is the description ink, which
        // is what three of these had drifted onto.
        const c = rgb(l.color)!;
        const isLabelInk = c.every((v, i) => v === LABEL_INK[i]);
        const isHeadingInk = c[0] === 23 && c[1] === 32 && c[2] === 51;
        expect(
          isLabelInk || isHeadingInk,
          `${name} / ${l.kind} "${l.text}" resolved ${l.color}`,
        ).toBe(true);

        // Measured contrast against the ground it is actually painted on.
        expect(
          contrast(l.color, l.background),
          `${name} / ${l.kind} "${l.text}" contrast`,
        ).toBeGreaterThanOrEqual(7);

        // A label is never lighter than a normal weight.
        expect(l.fontWeight, `${name} / ${l.kind}`).toBeGreaterThanOrEqual(600);
      }

      // The tiers below stay below: helper and description copy are both
      // strictly lighter than the label ink they sit under.
      const labelLum = 0.2126 * LABEL_INK[0] + 0.7152 * LABEL_INK[1] + 0.0722 * LABEL_INK[2];
      for (const lower of [helpColor, descColor]) {
        if (!lower) continue;
        const c = rgb(lower)!;
        const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        expect(lum, `${name}: a lower tier is not lighter than the label`).toBeGreaterThan(
          labelLum,
        );
      }
    });
  }

  test("the label ink is the same in every workspace context", async ({
    page,
  }) => {
    const seen = new Set<string>();
    for (const context of CONTEXTS) {
      const { labels } = await branch(page, context, async (p) => {
        await p.click("[data-intake-link-wizard-next]");
        await p.click('[data-intake-link-delivery-method-input="EMAIL"]');
      });
      expect(labels.length, context).toBeGreaterThan(0);
      for (const l of labels) seen.add(l.color);
    }
    // At most two inks across every context: the label tier and the heading
    // tier above it. A third would mean a context resolves its own palette.
    expect(seen.size).toBeLessThanOrEqual(2);
  });

  test("the secure-link reveal keeps the same label ink", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");
    await openWizard(page);
    await page.click("[data-intake-link-wizard-next]");
    await page.click('[data-intake-link-delivery-method-input="MANUAL"]');
    await page.click("[data-intake-link-wizard-next]");
    await page.click("[data-intake-link-wizard-next]");
    await page.click("[data-intake-link-submit]");
    await page.waitForSelector('[data-testid="intake-link-created"]');

    const measured = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="intake-link-created"] label.app-field-label',
      ) as HTMLElement;
      return {
        text: el.textContent?.trim(),
        color: getComputedStyle(el).color,
        weight: Number(getComputedStyle(el).fontWeight),
      };
    });
    expect(measured.text).toBe("Secure link");
    expect(rgb(measured.color)).toEqual(LABEL_INK);
    expect(measured.weight).toBeGreaterThanOrEqual(600);
  });

  test("the lifecycle filter offers labels with no reserved description line", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");
    // Reached by its accessible name, which is the same handle assistive
    // technology uses — not by position in the toolbar.
    await page
      .getByRole("combobox", { name: "Filter by lifecycle" })
      .click();
    await page.waitForSelector('[role="listbox"]');

    const measured = await page.evaluate(() => {
      const list = document.querySelector('[role="listbox"]') as HTMLElement;
      const options = Array.from(
        list.querySelectorAll<HTMLElement>('[role="option"]'),
      );
      return {
        labels: options.map((o) => o.textContent?.trim()),
        descriptions: list.querySelectorAll(".app-listbox__option-desc").length,
        heights: options.map((o) =>
          Math.round(o.getBoundingClientRect().height),
        ),
      };
    });

    expect(measured.labels).toEqual([
      "Any lifecycle",
      "Active",
      "Archived",
      "Link disabled",
      "Expired",
    ]);
    // Not merely empty — absent. An empty description node would still
    // reserve its line, which is the blank space this correction removes.
    expect(measured.descriptions).toBe(0);
    // Every row is the same height, so nothing reserved space for a
    // description that is not there.
    expect(new Set(measured.heights).size).toBe(1);
  });
});
