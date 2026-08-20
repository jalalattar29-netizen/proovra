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
      const life = row.querySelector(
        "[data-intake-links-row-link-state]",
      ) as HTMLElement;
      const act = row.querySelector(
        "[data-intake-links-row-session-state]",
      ) as HTMLElement;
      const del = row.querySelector(
        "[data-intake-links-row-delivery]",
      ) as HTMLElement;
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

    const tones = await page.evaluate(() => {
      const out: Record<string, { tone: string; color: string; text: string }> =
        {};
      for (const el of Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-intake-links-row-link-state]",
        ),
      )) {
        const state = el.getAttribute("data-intake-links-row-link-state")!;
        if (out[state]) continue;
        out[state] = {
          tone: el.getAttribute("data-tone") ?? "",
          color: getComputedStyle(el).color,
          text: el.textContent?.trim() ?? "",
        };
      }
      return out;
    });

    // Every state present in the fixture resolves its mandated tone AND keeps
    // a text label — status is never carried by colour alone.
    expect(tones.ARCHIVED.tone).toBe("slate");
    expect(tones.REVOKED.tone).toBe("red");
    expect(tones.REVOKED.text).toBe("Link disabled");
    expect(tones.EXPIRED.tone).toBe("slate");
    expect(tones.ACTIVE.tone).toBe("indigo");
    for (const v of Object.values(tones)) {
      expect(v.text.length).toBeGreaterThan(0);
      expect(rgb(v.color)).not.toBeNull();
    }
    // The red tone really resolves red, not an inherited ink.
    expect(rgb(tones.REVOKED.color)).toEqual([178, 52, 66]);
  });

  test("expiry uses danger ink only when the link has actually expired", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntakeLinks(page, "organization");
    const inks = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '.ilk-records--wide [data-intake-links-row-expires]',
        ),
      ).map((el) => ({
        state: el.getAttribute("data-intake-links-row-expires"),
        color: getComputedStyle(el).color,
      })),
    );
    const expired = inks.filter((i) => i.state === "expired");
    const ok = inks.filter((i) => i.state === "ok");
    expect(expired.length).toBeGreaterThan(0);
    expect(ok.length).toBeGreaterThan(0);
    for (const e of expired) expect(rgb(e.color)).toEqual([201, 54, 62]);
    for (const o of ok) expect(rgb(o.color)).not.toEqual([201, 54, 62]);
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
