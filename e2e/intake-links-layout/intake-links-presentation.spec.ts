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
  GERMAN_ROWS,
  LONG,
  ROWS,
  openIntakeLinks,
  openWizard,
  setDirection,
  type IntakeContext,
  DELIVERY_MATRIX_ROWS,
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

/**
 * The canonical `--ilk-tone-*` inks, as the browser reports them.
 *
 * Listed as VALUES rather than read from the custom properties at run time on
 * purpose: reading the token would make the assertion tautological (whatever
 * the page paints is whatever the page declared). These are the six the design
 * system owns, so a page-invented literal fails even if someone also adds it
 * to this route's stylesheet.
 *
 *   slate  #64748b   indigo #6d28d9   blue  #2563eb
 *   green  #167a5b   amber  #a86612   red   #c9363e
 *   orange #c2410c   (--orange-ink, the readable classification orange)
 */
const CANONICAL_TONE_INKS = [
  "rgb(100, 116, 139)",
  "rgb(109, 40, 217)",
  "rgb(37, 99, 235)",
  "rgb(22, 122, 91)",
  "rgb(168, 102, 18)",
  "rgb(201, 54, 62)",
  "rgb(194, 65, 12)",
];

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
      const box = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      const life = row.querySelector(
        "[data-intake-links-row-link-state]",
      ) as HTMLElement;
      const act = row.querySelector(
        "[data-intake-links-row-session-state]",
      ) as HTMLElement;
      const del = row.querySelector(
        "[data-intake-links-row-delivery]",
      ) as HTMLElement;
      return {
        lifecycle: { ...box(life), text: life.textContent?.trim() },
        activity: { ...box(act), text: act.textContent?.trim() },
        delivery: { ...box(del), text: del.textContent?.trim() },
        sameCell: life.closest("td") === act.closest("td"),
        lifecycleBg: getComputedStyle(life).backgroundColor,
        activityBg: getComputedStyle(act).backgroundColor,
        deliveryBg: getComputedStyle(del).backgroundColor,
      };
    });

    expect(measured.lifecycle.text).toBe("Archived");
    expect(measured.activity.text).toBe("Submitted");
    // "Queued with provider" said the same thing twice under a column already
    // headed Delivery. The wire value is still QUEUED; only the sentence a
    // person reads got shorter.
    expect(measured.delivery.text).toBe("With provider");
    expect(measured.sameCell).toBe(false);

    // Painted boxes do not intersect — the concatenation defect cannot recur.
    const intersects =
      measured.lifecycle.left < measured.activity.right - 0.5 &&
      measured.activity.left < measured.lifecycle.right - 0.5 &&
      measured.lifecycle.top < measured.activity.bottom - 0.5 &&
      measured.activity.top < measured.lifecycle.bottom - 0.5;
    expect(intersects).toBe(false);

    // EXACTLY ONE FILLED SURFACE in the row: the lifecycle chip.
    //
    // The other two are now bare text on the row's own ground — no fill, no
    // border, no capsule. That is what keeps the filled chip reading as THE
    // state of the link, rather than as one of three competing boxes; and it
    // is a stricter rule than the one it replaces, which allowed those two a
    // neutral bordered surface of their own.
    expect(rgb(measured.lifecycleBg)).not.toBeNull();
    expect(measured.activityBg).toBe("rgba(0, 0, 0, 0)");
    expect(measured.deliveryBg).toBe("rgba(0, 0, 0, 0)");
  });

  test("Delivery & activity is TONED TEXT — no fill, no chip, no capsule", async ({
    page,
  }) => {
    for (const width of [1440, 1280, 1024, 940]) {
      await page.setViewportSize({ width, height: 900 });
      await openIntakeLinks(page, "organization");

      const measured = await page.evaluate(() => {
        const cells = Array.from(
          document.querySelectorAll<HTMLElement>(".ilk-records--wide .ilk-status"),
        );
        return cells.map((cell) => {
          const value = cell.querySelector(".ilk-status__value") as HTMLElement;
          const key = cell.querySelector(".ilk-status__key") as HTMLElement;
          const cs = getComputedStyle(value);
          return {
            badges: cell.querySelectorAll(".app-status-badge").length,
            // The BADGE tone attributes must stay absent from this column…
            badgeToned: cell.querySelectorAll("[data-tone], [data-fill]").length,
            // …and the two values must each carry the text tone.
            toned: cell.querySelectorAll("[data-ilk-tone]").length,
            lifecycle: cell.querySelectorAll("[data-intake-links-row-link-state]")
              .length,
            keys: Array.from(cell.querySelectorAll(".ilk-status__key")).map((k) =>
              k.textContent?.trim(),
            ),
            valueColor: cs.color,
            valueBackground: cs.backgroundColor,
            valueRadius: cs.borderTopLeftRadius,
            valueShadow: cs.boxShadow,
            valueTextShadow: cs.textShadow,
            valueBorder: cs.borderTopColor,
            valueBorderWidth: cs.borderTopWidth,
            valuePadding: cs.paddingTop,
            valueTexts: Array.from(
              cell.querySelectorAll(".ilk-status__value"),
            ).map((v) => v.textContent?.trim()),
            valueWhiteSpace: cs.whiteSpace,
            valueWidth: value.getBoundingClientRect().width,
            cellWidth: cell.getBoundingClientRect().width,
            usesSharedAuthority: value.classList.contains("app-fact-value"),
            radiusToken: getComputedStyle(document.documentElement)
              .getPropertyValue("--radius-sm")
              .trim(),
            keyColor: getComputedStyle(key).color,
          };
        });
      });

      expect(measured.length, `${width}px`).toBeGreaterThan(0);
      for (const cell of measured) {
        // WHAT CHANGED, AND WHY.
        //
        // These values used to sit on `.app-fact-value` — a bordered, tinted,
        // padded inline surface. One per line, two lines per row, every row:
        // because each capsule sizes to its own words, the column became a
        // ragged stack of boxes of six different widths, and it read as the
        // busiest thing in the table while carrying two of its quietest facts.
        //
        // The state is now the TEXT. The rule this test enforces flipped from
        // "no tone" to "tone, and NOTHING ELSE" — which is the stricter of the
        // two, because a capsule can hide a lot inside its border.

        // 1. No capsule, in any form.
        expect(cell.badges, `${width}px: a badge survived`).toBe(0);
        expect(cell.badgeToned, `${width}px: a badge tone survived`).toBe(0);
        expect(
          cell.usesSharedAuthority,
          `${width}px: the bordered fact surface came back`,
        ).toBe(false);
        expect(cell.valueBackground, `${width}px`).toBe("rgba(0, 0, 0, 0)");
        // `border: 0` leaves `border-top-color` resolving to `currentColor`,
        // so the WIDTH is the thing that proves there is no border.
        expect(cell.valueBorderWidth, `${width}px: a border survived`).toBe("0px");
        expect(cell.valueShadow, `${width}px`).toBe("none");
        expect(cell.valueTextShadow, `${width}px`).toBe("none");
        expect(cell.valueRadius, `${width}px`).toBe("0px");
        expect(cell.valuePadding, `${width}px`).toBe("0px");
        // Content-width, not cell-width — nothing paints a column.
        expect(cell.valueWidth, `${width}px`).toBeLessThan(cell.cellWidth);
        // One line, always: a state phrase split in two reads as two states.
        expect(cell.valueWhiteSpace, `${width}px`).toBe("nowrap");
        // 2. Lifecycle is still absent from this column.
        expect(cell.lifecycle, `${width}px: lifecycle came back`).toBe(0);
        // 3. Both labelled facts survive.
        expect(cell.keys, `${width}px`).toEqual(["Delivery", "Activity"]);
        // 4. THE VALUE IS TONED, and the tone is a CANONICAL token — never a
        //    literal this page invented. The key stays the quiet half.
        expect(cell.toned, `${width}px: the value carries no tone`).toBe(2);
        expect(
          CANONICAL_TONE_INKS,
          `${width}px value ink ${cell.valueColor}`,
        ).toContain(cell.valueColor);
        expect(cell.valueColor, `${width}px`).not.toBe(cell.keyColor);
        // 5. AND THE WORD IS ALWAYS THERE. Colour is never the only cue.
        expect(cell.valueTexts.every((t) => (t ?? "").length > 0)).toBe(true);
      }
    }
  });

  test("the card renders the same two facts with the same TONED treatment", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openIntakeLinks(page, "organization");

    const measured = await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll<HTMLElement>("[data-intake-links-card]"),
      );
      return cards.map((card) => {
        const facts = card.querySelector(".ilk-card__facts") as HTMLElement;
        const del = facts.querySelector(
          "[data-intake-links-row-delivery]",
        ) as HTMLElement;
        const act = facts.querySelector(
          "[data-intake-links-row-session-state]",
        ) as HTMLElement;
        const life = card.querySelector(
          "[data-intake-links-row-link-state]",
        ) as HTMLElement;
        return {
          factBadges: facts.querySelectorAll(".app-status-badge").length,
          deliveryColor: getComputedStyle(del).color,
          activityColor: getComputedStyle(act).color,
          deliveryBg: getComputedStyle(del).backgroundColor,
          activityBg: getComputedStyle(act).backgroundColor,
          deliveryShadow: getComputedStyle(del).boxShadow,
          activityShadow: getComputedStyle(act).boxShadow,
          // EXACTLY the authority the table cell uses — one class, two
          // renderers, so the card cannot drift into a second design.
          deliverySharedAuthority: del.classList.contains("ilk-state-text"),
          activitySharedAuthority: act.classList.contains("ilk-state-text"),
          deliveryText: del.textContent?.trim() ?? "",
          activityText: act.textContent?.trim() ?? "",
          // The card's ONE fill is the lifecycle chip, in the card head.
          lifecycleFill: life.getAttribute("data-fill"),
          lifecycleBg: getComputedStyle(life).backgroundColor,
          lifecycleInFacts: Boolean(
            facts.querySelector("[data-intake-links-row-link-state]"),
          ),
        };
      });
    });

    expect(measured.length).toBeGreaterThan(0);
    for (const card of measured) {
      expect(card.factBadges).toBe(0);
      // EXACTLY the table cell's authority — one class, two renderers, so the
      // card cannot drift into a second design. The class changed with the
      // treatment; that it is SHARED has not.
      expect(card.deliverySharedAuthority).toBe(true);
      expect(card.activitySharedAuthority).toBe(true);
      // Toned text, from the canonical palette, on no surface at all.
      expect(CANONICAL_TONE_INKS).toContain(card.deliveryColor);
      expect(CANONICAL_TONE_INKS).toContain(card.activityColor);
      expect(card.deliveryBg).toBe("rgba(0, 0, 0, 0)");
      expect(card.activityBg).toBe("rgba(0, 0, 0, 0)");
      expect(card.deliveryShadow).toBe("none");
      expect(card.activityShadow).toBe("none");
      // The WORD is always present, so colour is never the only cue.
      expect(card.deliveryText.length).toBeGreaterThan(0);
      expect(card.activityText.length).toBeGreaterThan(0);
      // Lifecycle keeps its independent semantic treatment.
      // The card head carries the same lifecycle treatment as the table: solid
      // for the exceptions, the soft canonical green for the ordinary Active.
      expect(["solid", "soft"]).toContain(card.lifecycleFill);
      expect(rgb(card.lifecycleBg)).not.toBeNull();
      expect(card.lifecycleInFacts).toBe(false);
    }
  });

  test("Link disabled is one unbroken line at every table width", async ({
    page,
  }) => {
    for (const width of [1440, 1280, 1024, 940]) {
      await page.setViewportSize({ width, height: 900 });
      await openIntakeLinks(page, "organization");

      const measured = await page.evaluate(() => {
        const badge = document.querySelector(
          '.ilk-records--wide [data-intake-links-row-link-state="REVOKED"]',
        ) as HTMLElement;
        if (!badge) return null;
        const cs = getComputedStyle(badge);
        const cell = badge.closest("td") as HTMLElement;
        const cellRect = cell.getBoundingClientRect();
        const rect = badge.getBoundingClientRect();
        // The next cell in the row, so a widened column cannot be proven by
        // painting over its neighbour.
        const next = cell.nextElementSibling as HTMLElement | null;
        const nextRect = next?.getBoundingClientRect() ?? null;
        return {
          text: badge.textContent?.trim(),
          whiteSpace: cs.whiteSpace,
          fontSize: parseFloat(cs.fontSize),
          lineHeight: parseFloat(cs.lineHeight),
          // Content height only: padding and border are the chip, not the
          // text, and counting them as text is how a one-line chip reads as
          // two.
          lines: Math.round(
            (rect.height -
              parseFloat(cs.paddingTop) -
              parseFloat(cs.paddingBottom) -
              parseFloat(cs.borderTopWidth) -
              parseFloat(cs.borderBottomWidth)) /
              parseFloat(cs.lineHeight),
          ),
          height: rect.height,
          width: rect.width,
          cellWidth: cellRect.width,
          overflowsCell: rect.right > cellRect.right + 1,
          collides: nextRect ? rect.right > nextRect.left + 0.5 : false,
        };
      });

      expect(measured, `${width}px: no revoked row`).not.toBeNull();
      const m = measured!;
      // The complete label, unabbreviated.
      expect(m.text, `${width}px`).toBe("Link disabled");
      // ONE line: exactly one line-height of content, and nowrap is why.
      expect(m.whiteSpace, `${width}px`).toBe("nowrap");
      expect(m.lines, `${width}px: ${m.height}px is more than one line`).toBe(1);
      // Readable, not shrunk into illegibility.
      expect(m.fontSize, `${width}px`).toBeGreaterThanOrEqual(11);
      // Inside its own cell, and clear of the next one.
      expect(m.overflowsCell, `${width}px: escapes its cell`).toBe(false);
      expect(m.collides, `${width}px: collides with the next column`).toBe(false);
      // The column is sized to the chip, not inflated well past it.
      expect(m.cellWidth - m.width, `${width}px: column is over-wide`).toBeLessThan(
        60,
      );
    }
  });

  test("Link disabled stays whole in the card, at the narrowest width", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openIntakeLinks(page, "organization");
    const measured = await page.evaluate(() => {
      const badge = document.querySelector(
        '.ilk-records--narrow [data-intake-links-row-link-state="REVOKED"]',
      ) as HTMLElement;
      const head = badge.closest(".ilk-card__head") as HTMLElement;
      const r = badge.getBoundingClientRect();
      const h = head.getBoundingClientRect();
      const cs = getComputedStyle(badge);
      return {
        text: badge.textContent?.trim(),
        lines: Math.round(
          (r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) /
            parseFloat(cs.lineHeight),
        ),
        contained: r.right <= h.right + 1 && r.left >= h.left - 1,
        clipped: badge.scrollWidth > badge.clientWidth + 1,
        documentOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    });
    // Space permits one line at 390px, and the text is never cut off.
    expect(measured.text).toBe("Link disabled");
    expect(measured.lines).toBe(1);
    expect(measured.contained).toBe(true);
    expect(measured.clipped).toBe(false);
    expect(measured.documentOverflow).toBe(0);
  });

  test("lifecycle keeps its own semantic palette, and it is the only one", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");

    const measured = await page.evaluate(() => {
      const out: Record<
        string,
        { tone: string; fill: string; color: string; background: string; text: string }
      > = {};
      for (const el of Array.from(
        document.querySelectorAll<HTMLElement>(
          ".ilk-records--wide [data-intake-links-row-link-state]",
        ),
      )) {
        const state = el.getAttribute("data-intake-links-row-link-state")!;
        if (out[state]) continue;
        const cs = getComputedStyle(el);
        out[state] = {
          tone: el.getAttribute("data-tone") ?? "",
          fill: el.getAttribute("data-fill") ?? "",
          color: cs.color,
          background: cs.backgroundColor,
          text: el.textContent?.trim() ?? "",
        };
      }
      return {
        states: out,
        // Every remaining badge in the records surface is a lifecycle badge.
        totalBadges: document.querySelectorAll(
          ".ilk-records--wide .app-status-badge",
        ).length,
        lifecycleBadges: document.querySelectorAll(
          ".ilk-records--wide [data-intake-links-row-link-state]",
        ).length,
      };
    });

    const FILL: Record<string, [number, number, number]> = {
      blue: [37, 99, 235],
      red: [220, 38, 38],
      slate: [71, 85, 105],
      green: [22, 122, 91],
    };
    // ONE STRUCTURE for the whole column: every state is the same filled badge
    // with white text, and only the semantic colour varies.
    //
    // ACTIVE was INDIGO — the product's brand accent standing in for a state,
    // saying "this is ours" where the column needed "this is healthy". It then
    // briefly took the SOFT variant, on the reasoning that the ordinary case
    // should be quieter than the exceptions. Beside three solid chips that
    // read as a different KIND of thing rather than a different state, so it
    // is back to the shared treatment in the canonical green. White on
    // #167A5B measures 5.29:1, so the badge holds WCAG AA.
    const MANDATED: Array<[string, string, string]> = [
      ["EXPIRED", "blue", "Expired"],
      ["REVOKED", "red", "Link disabled"],
      ["ARCHIVED", "slate", "Archived"],
      ["ACTIVE", "green", "Active"],
    ];
    for (const [state, tone, text] of MANDATED) {
      const v = measured.states[state];
      expect(v, `${state} absent from the fixture`).toBeTruthy();
      expect(v.tone, state).toBe(tone);
      expect(v.fill, state).toBe("solid");
      expect(v.text, state).toBe(text);
      expect(rgb(v.background), `${state} fill`).toEqual(FILL[tone]);
      expect(rgb(v.color), `${state} ink`).toEqual([255, 255, 255]);
    }
    expect(measured.totalBadges).toBe(measured.lifecycleBadges);
    expect(measured.lifecycleBadges).toBeGreaterThan(0);
  });

  test("the lifecycle fill keeps readable ink, and the one exception is measured", async ({
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

    // Every tone this surface now spends clears AA for its own ink.
    for (const [tone, ratio] of byTone) {
      if (tone === "orange") continue;
      expect(ratio, `${tone} contrast`).toBeGreaterThanOrEqual(4.5);
    }
    // The shared attention orange — the exact treatment the Search
    // classification labels wear (`--orange-fill` with white ink) — measures
    // BELOW AA and is recorded as measured rather than presented as a pass.
    // Moving Delivery and Activity to neutral text removed the only place this
    // surface spent it, so it is asserted as ABSENT here rather than allowed:
    // if it returns, the exception has to be re-argued.
    expect(byTone.has("orange"), "the sub-AA orange came back").toBe(false);
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

// ===========================================================================
// DELIVERY & ACTIVITY — the refined presentation, at every supported width
//
// The column carries two labelled facts on a shared neutral surface. Three
// things have to hold together, and each of them is a different failure:
//   * the WORDING is the vocabulary's, not a renderer's;
//   * the KEY and its VALUE stay on one visual line;
//   * neither escapes its cell, in either direction, at any supported width.
// ===========================================================================

test.describe("Delivery & activity presentation holds at every supported width", () => {
  /** Every width the surface supports, table and card alike. */
  const ALL_WIDTHS = [1440, 1280, 1024, 940, 901, 768, 430, 390];

  for (const direction of ["ltr", "rtl"] as const) {
    test(`${direction}: nothing clips, overlaps or overflows at any width`, async ({
      page,
    }) => {
      for (const width of ALL_WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await openIntakeLinks(page, "organization");
        await setDirection(page, direction);

        const problems = await page.evaluate(() => {
          const bad: string[] = [];
          const doc = document.documentElement;
          if (doc.scrollWidth - doc.clientWidth > 0) bad.push("page scrolls sideways");

          const values = Array.from(
            // The status VALUES, wherever they render — table cell or card.
            // They stopped being `.app-fact-value` capsules and became toned
            // text; what this matrix protects is unchanged, so it follows the
            // element rather than the old class name.
            document.querySelectorAll<HTMLElement>(".ilk-state-text"),
          ).filter((v) => v.offsetParent !== null);
          if (values.length === 0) bad.push("no status value rendered");

          for (const v of values) {
            const vb = v.getBoundingClientRect();
            // Inside its own cell/card, with a pixel of tolerance for
            // sub-pixel layout.
            const host = (v.closest("td") ?? v.closest(".ilk-card__facts")) as HTMLElement;
            const hb = host.getBoundingClientRect();
            if (vb.left < hb.left - 1 || vb.right > hb.right + 1) {
              bad.push(`value escapes its cell: ${v.textContent}`);
            }
            // ONE LINE. A surface taller than ~1.8 line-heights has wrapped.
            const lh = parseFloat(getComputedStyle(v).lineHeight) || 18;
            if (vb.height > lh * 1.8) bad.push(`value wrapped: ${v.textContent}`);
          }
          return bad;
        });
        expect(problems, `${direction} @ ${width}px`).toEqual([]);
      }
    });
  }

  test("`With provider` is one unbroken line wherever it is shown", async ({
    page,
  }) => {
    for (const width of ALL_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      // The default fixture already carries a QUEUED row; overriding the
      // built rows would only invent a shape the API never sends.
      await openIntakeLinks(page, "organization");

      const measured = await page.evaluate(() => {
        const v = Array.from(
          document.querySelectorAll<HTMLElement>(".ilk-state-text"),
        ).find((el) => el.offsetParent !== null && el.textContent?.trim() === "With provider");
        if (!v) return null;
        const cs = getComputedStyle(v);
        const rect = v.getBoundingClientRect();
        return {
          text: v.textContent?.trim(),
          whiteSpace: cs.whiteSpace,
          height: rect.height,
          lineHeight: parseFloat(cs.lineHeight) || 18,
          // Not truncated at any supported width: the surface is wide enough
          // for the whole phrase.
          truncated: v.scrollWidth > v.clientWidth + 1,
          // The full technical meaning stays reachable.
          title: v.getAttribute("title") ?? "",
        };
      });

      expect(measured, `${width}px: no "With provider" value`).not.toBeNull();
      expect(measured!.text, `${width}px`).toBe("With provider");
      expect(measured!.whiteSpace, `${width}px`).toBe("nowrap");
      expect(measured!.height, `${width}px wrapped`).toBeLessThan(
        measured!.lineHeight * 1.8,
      );
      expect(measured!.truncated, `${width}px truncated`).toBe(false);
      // The word that was removed is not lost — it is in the description.
      expect(measured!.title, `${width}px`).toMatch(/[Qq]ueued/);
      // …and the retired wording is nowhere on the page.
      expect(await page.content()).not.toContain("Queued with provider");
    }
  });

  test("a doubled text scale keeps both facts on their own lines", async ({
    page,
  }) => {
    // The value surface is sized in `ch` and `rem`, so a doubled root font
    // must widen it with the text rather than breaking it out of the cell.
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await openIntakeLinks(page, "organization");
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "32px";
      });
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => r(null))),
      );

      const problems = await page.evaluate(() => {
        const bad: string[] = [];
        const doc = document.documentElement;
        if (doc.scrollWidth - doc.clientWidth > 0) bad.push("page scrolls sideways");
        for (const v of Array.from(
          document.querySelectorAll<HTMLElement>(".ilk-state-text"),
        ).filter((el) => el.offsetParent !== null)) {
          const host = (v.closest("td") ?? v.closest(".ilk-card__facts")) as HTMLElement;
          const hb = host.getBoundingClientRect();
          const vb = v.getBoundingClientRect();
          if (vb.right > hb.right + 1 || vb.left < hb.left - 1) {
            bad.push(`escapes at 2x: ${v.textContent}`);
          }
        }
        return bad;
      });
      expect(problems, `${width}px @ 2x text`).toEqual([]);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "";
      });
    }
  });

  test("a long translated value stays inside its column and keeps its full text", async ({
    page,
  }) => {
    // German runs roughly twice the English length here. It may truncate — the
    // surface never wraps — but it must not escape, and the whole string has to
    // remain reachable through the accessible description.
    await page.setViewportSize({ width: 1024, height: 900 });
    await openIntakeLinks(page, "organization", { rows: GERMAN_ROWS });

    const measured = await page.evaluate(() => {
      const values = Array.from(
        document.querySelectorAll<HTMLElement>(".ilk-state-text"),
      ).filter((v) => v.offsetParent !== null);
      return values.map((v) => {
        const host = v.closest("td") as HTMLElement;
        const hb = host.getBoundingClientRect();
        const vb = v.getBoundingClientRect();
        const lh = parseFloat(getComputedStyle(v).lineHeight) || 18;
        return {
          escapes: vb.right > hb.right + 1 || vb.left < hb.left - 1,
          wrapped: vb.height > lh * 1.8,
          hasDescription: (v.getAttribute("title") ?? "").length > 0,
          overflowStrategy: getComputedStyle(v).textOverflow,
        };
      });
    });

    expect(measured.length).toBeGreaterThan(0);
    for (const v of measured) {
      expect(v.escapes).toBe(false);
      expect(v.wrapped).toBe(false);
      expect(v.hasDescription).toBe(true);
      expect(v.overflowStrategy).toBe("ellipsis");
    }
    const pageOverflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth - doc.clientWidth;
    });
    expect(pageOverflow).toBe(0);
  });
});

// ===========================================================================
// THE KPI CARD IS THE SHARED PRIMITIVE, NOT A PRIVATE COPY
//
// Notifications reuses this card. "The same as Intake Links" only means
// something if Intake Links itself consumes the shared primitive — otherwise
// the two are merely two copies that happen to agree today.
// ===========================================================================

test("the KPI card resolves the canonical metric-card primitive", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openIntakeLinks(page, "organization");

  const measured = await page.evaluate(() => {
    // An UNPRESSED card: the selected one resolves the primitive's
    // `[aria-pressed="true"]` rule, so comparing it against a bare probe would
    // be comparing two different states of the same primitive.
    const real = document.querySelector(
      '.ilk-kpi[aria-pressed="false"]',
    ) as HTMLElement | null;
    if (!real) return null;

    // A bare probe carrying ONLY the primitive's class, measured in the same
    // document. If the two resolve identically, this card IS the primitive.
    const probe = document.createElement("button");
    probe.className = "app-metric-card";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    document.body.appendChild(probe);
    const p = getComputedStyle(probe);
    const reference = {
      radius: p.borderTopLeftRadius,
      paddingTop: p.paddingTop,
      paddingInlineStart: p.paddingInlineStart,
      shadow: p.boxShadow,
      background: p.backgroundColor,
      display: p.display,
    };
    probe.remove();

    const cs = getComputedStyle(real);
    return {
      shared: real.classList.contains("app-metric-card"),
      reference,
      resolved: {
        radius: cs.borderTopLeftRadius,
        paddingTop: cs.paddingTop,
        paddingInlineStart: cs.paddingInlineStart,
        shadow: cs.boxShadow,
        background: cs.backgroundColor,
        display: cs.display,
      },
      // The route resolves the tone; the primitive only paints it.
      tone: cs.getPropertyValue("--app-metric-tone").trim(),
      hasValue: Boolean(real.querySelector(".app-metric-card__value")),
      hasLabel: Boolean(real.querySelector(".app-metric-card__label")),
    };
  });

  expect(measured, "no KPI card rendered").not.toBeNull();
  expect(measured!.shared).toBe(true);
  expect(measured!.resolved).toEqual(measured!.reference);
  expect(measured!.hasValue).toBe(true);
  expect(measured!.hasLabel).toBe(true);
  expect(measured!.tone.length).toBeGreaterThan(0);
});

// ===========================================================================
// MANUAL vs NOT SENT — four states that must not collapse into each other
// ===========================================================================

test.describe("delivery semantics", () => {
  /** The rendered Delivery value + its tone, per row id. */
  async function deliveryByRow(page: Page) {
    return page.evaluate(() =>
      Object.fromEntries(
        Array.from(
          document.querySelectorAll<HTMLElement>(
            ".ilk-records--wide [data-intake-links-row-id]",
          ),
        ).map((row) => {
          const v = row.querySelector(
            "[data-intake-links-row-delivery]",
          ) as HTMLElement;
          return [
            row.getAttribute("data-intake-links-row-id"),
            {
              state: v.getAttribute("data-intake-links-row-delivery"),
              text: v.textContent?.trim() ?? "",
              tone: v.getAttribute("data-ilk-tone"),
              color: getComputedStyle(v).color,
              background: getComputedStyle(v).backgroundColor,
              title: v.getAttribute("title") ?? "",
            },
          ];
        }),
      ),
    );
  }

  test("a manually-shared link says Manual, and a provider one never does", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization", {
      rows: DELIVERY_MATRIX_ROWS as unknown as ReadonlyArray<unknown>,
    });
    const rows = (await deliveryByRow(page)) as Record<
      string,
      {
        state: string;
        text: string;
        tone: string;
        color: string;
        background: string;
        title: string;
      }
    >;

    // CASE A — no delivery record at all. Nothing was ever meant to be sent,
    // so "Not sent" reported a failure that did not happen.
    expect(rows["d-manual"].state).toBe("MANUAL");
    expect(rows["d-manual"].text).toBe("Manual");
    // Purple — the one tone in this palette that carries no severity, because
    // manual distribution is neither good news nor bad.
    expect(rows["d-manual"].tone).toBe("indigo");
    expect(rows["d-manual"].color).toBe("rgb(109, 40, 217)");
    // TEXT ONLY. No capsule came back with it.
    expect(rows["d-manual"].background).toBe("rgba(0, 0, 0, 0)");
    // The word states the fact; colour is supplementary.
    expect(rows["d-manual"].title).toMatch(/shared manually/i);

    // CASE B — a REAL provider record whose status is not a recognised send.
    // The manual rule keys on record EXISTENCE, so it cannot claim this one.
    expect(rows["d-not-sent"].state).toBe("NOT_SENT");
    expect(rows["d-not-sent"].text).toBe("Not sent");
    expect(rows["d-not-sent"].tone).toBe("red");

    // CASE C — the provider is holding it.
    expect(rows["d-provider"].state).toBe("QUEUED");
    expect(rows["d-provider"].text).toBe("With provider");
    expect(rows["d-provider"].tone).toBe("green");

    // CASE D — it failed.
    expect(rows["d-failed"].state).toBe("FAILED");
    expect(rows["d-failed"].text).toBe("Failed");
    expect(rows["d-failed"].tone).toBe("red");

    // Four rows, four distinct states — nothing collapsed.
    const states = Object.values(rows).map((r) => r.state);
    expect(new Set(states).size).toBe(4);
  });

  test("the delivery filter labels its manual option to match the rows", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization", {
      rows: DELIVERY_MATRIX_ROWS as unknown as ReadonlyArray<unknown>,
    });
    // The dropdown and the row must never disagree about one population, and
    // `NONE` selects exactly the rows that render "Manual".
    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll("option")).map((o) =>
        o.textContent?.trim(),
      ),
    );
    if (labels.length > 0) {
      expect(labels).toContain("Manual");
      expect(labels).not.toContain("Not sent");
    }
  });
});

// ===========================================================================
// THE LIFECYCLE COLUMN HAS ONE STRUCTURE
// ===========================================================================

test("every lifecycle state is the same filled badge; only the colour differs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openIntakeLinks(page, "organization");

  const measured = await page.evaluate(() => {
    const out: Record<string, Record<string, string>> = {};
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>(
        ".ilk-records--wide [data-intake-links-row-link-state]",
      ),
    )) {
      const state = el.getAttribute("data-intake-links-row-link-state")!;
      if (out[state]) continue;
      const cs = getComputedStyle(el);
      out[state] = {
        fill: el.getAttribute("data-fill") ?? "",
        tone: el.getAttribute("data-tone") ?? "",
        color: cs.color,
        background: cs.backgroundColor,
        height: String(Math.round(el.getBoundingClientRect().height)),
        padding: `${cs.paddingTop}/${cs.paddingRight}`,
        radius: cs.borderTopLeftRadius,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        letterSpacing: cs.letterSpacing,
        display: cs.display,
        text: el.textContent?.trim() ?? "",
      };
    }
    return out;
  });

  const states = Object.keys(measured);
  expect(states.length).toBeGreaterThanOrEqual(3);

  // ONE STRUCTURE. Active briefly took the soft variant and read as a
  // different KIND of thing beside three solid chips — a hierarchy the
  // lifecycle does not have. Everything below must be identical across states.
  const structural = [
    "fill",
    "height",
    "padding",
    "radius",
    "fontSize",
    "fontWeight",
    "letterSpacing",
    "display",
  ] as const;
  const first = measured[states[0]!]!;
  for (const state of states) {
    for (const key of structural) {
      expect(measured[state]![key], `${state}.${key}`).toBe(first[key]);
    }
    // Filled, with white text — the shared treatment.
    expect(measured[state]!.fill, state).toBe("solid");
    expect(measured[state]!.color, state).toBe("rgb(255, 255, 255)");
    // And the word is always there, so the colour is never the only cue.
    expect(measured[state]!.text.length, state).toBeGreaterThan(0);
  }

  // ONLY the colour varies — and Active's is the canonical green.
  expect(measured.ACTIVE, "ACTIVE absent from the fixture").toBeTruthy();
  expect(measured.ACTIVE!.tone).toBe("green");
  expect(measured.ACTIVE!.text).toBe("Active");
  // `--success-ink` #167A5B. White on it measures 5.29:1 — WCAG AA holds.
  expect(measured.ACTIVE!.background).toBe("rgb(22, 122, 91)");
  // It is genuinely distinct from its neighbours.
  const backgrounds = states.map((k) => measured[k]!.background);
  expect(new Set(backgrounds).size).toBe(states.length);
});
