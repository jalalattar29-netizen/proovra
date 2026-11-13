/**
 * CAPTURE — the redesigned workflow, measured in a real engine.
 *
 * Source assertions already pin that the components exist and read the right
 * state. What they cannot answer is whether the RESULT is usable: whether a
 * 390px viewport scrolls sideways, whether the readiness sentence and the
 * button beneath it can show contradictory things at the same moment, and
 * whether the disclosure a keyboard user tabs to actually opens.
 */

import { expect, test } from "@playwright/test";

import { WIDTHS, openCapture } from "./_fixtures";

test.describe("capture — composition and hierarchy", () => {
  test("the page presents ONE workflow orientation and ONE ingestion surface", async ({
    page,
  }) => {
    await openCapture(page);

    // No stepper at all (2026-11-13): the compact header orients, and its
    // facts come from the session's own state.
    await expect(page.locator(".capture-enterprise-steps")).toHaveCount(0);
    await expect(page.locator("[data-capture-intake-rail]")).toHaveCount(0);
    await expect(page.locator("[data-capture-header]")).toHaveCount(1);

    // One drop zone, and it is not in the header.
    const heroBox = await page.locator("[data-capture-header]").boundingBox();
    const dropzones = page.locator("[data-capture-dropzone], .capture-dropzone");
    const count = await dropzones.count();
    if (count > 0 && heroBox) {
      const first = await dropzones.first().boundingBox();
      expect(
        first!.y,
        "the ingestion surface must sit below the hero, not inside it",
      ).toBeGreaterThan(heroBox.y + heroBox.height - 4);
    }
  });

  test("the trust strip states three items and claims nothing legal", async ({
    page,
  }) => {
    await openCapture(page);
    // Trust statements are explanatory copy, on demand in Help and guidance.
    await page.locator("[data-capture-guidance] > summary").click();
    const items = page.locator("[data-capture-trust-item]");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("Integrity by design");
    // UC-PROV-011 — bytes are uploaded over TLS to encrypted storage and hashed
    // server-side; they are not end-to-end encrypted, so the strip says what is true.
    await expect(items.nth(1)).toContainText("Encrypted in transit and at rest");
    await expect(items.nth(2)).toContainText("Verifiable audit trail");

    const body = (await page.locator("body").innerText()).toLowerCase();
    for (const banned of [
      "end-to-end protected",
      "end-to-end encrypted",
      "court-ready",
      "legally admissible",
      "court approved",
      "authenticity proven",
      "truth verified",
    ]) {
      expect(body, `the page must not claim "${banned}"`).not.toContain(banned);
    }
  });
});

test.describe("capture — readiness truth", () => {
  test("Final Readiness and Review & Sign never contradict each other", async ({
    page,
  }) => {
    await openCapture(page);

    const summary = page.locator("[data-capture-final-readiness]");
    await expect(summary).toHaveCount(1);

    const verdict = await summary.getAttribute("data-capture-final-readiness");
    const finalize = page.locator("[data-capture-finalize], button:has-text('Review & Sign')");
    await expect(finalize.first()).toHaveCount(1);
    const disabled = await finalize.first().isDisabled();

    // THE INVARIANT. "Ready" with a disabled button, or "Not ready" with an
    // enabled one, is the state this whole surface exists to make impossible.
    if (verdict === "ready") {
      expect(disabled, "Ready to finalize must not sit above a disabled button").toBe(
        false,
      );
    } else {
      expect(disabled, "Not ready to finalize must not sit above an enabled button").toBe(
        true,
      );
    }

    // The verdict is words, not only colour. A new draft states its next step
    // calmly instead of "Not ready" (2026-11-13); the button is still disabled.
    await expect(summary).toContainText(
      /Ready to finalize|Not ready to finalize|Add your first file to get started/,
    );
  });

  test("an empty session says why it cannot finalize, in words", async ({ page }) => {
    await openCapture(page);
    const summary = page.locator("[data-capture-final-readiness]");
    // A fresh session has no materials, so the authority refuses — and the
    // page states a reason rather than only greying the button.
    await expect(summary).toHaveAttribute("data-capture-final-readiness", "not_ready");
    const text = await summary.innerText();
    expect(text.trim().length).toBeGreaterThan("Not ready to finalize".length);
  });

  test("zero blockers and zero warnings occupy ONE compact row", async ({ page }) => {
    await openCapture(page);
    const signals = page.locator("[data-capture-signals]");
    await expect(signals).toHaveCount(1);

    const state = await signals.getAttribute("data-capture-signals");
    if (state === "empty") {
      // A new draft: one calm sentence, not a red blocker card.
      await expect(signals).toContainText("Add your first file to get started");
      await expect(page.locator('[data-capture-signal-group="blockers"]')).toHaveCount(0);
      const box = await signals.boundingBox();
      expect(box!.height, "the empty state must be one compact row").toBeLessThan(90);
    } else if (state === "clear") {
      await expect(signals).toContainText("No blockers");
      await expect(signals).toContainText("No warnings");
      const box = await signals.boundingBox();
      // One row, not two cards. Generous ceiling — this is a "did it collapse"
      // check, not a pixel pin.
      expect(box!.height, "the zero state must not be two stacked cards").toBeLessThan(
        90,
      );
    } else {
      // Issues present: each group renders expanded, with its count.
      const groups = page.locator("[data-capture-signal-group]");
      expect(await groups.count()).toBeGreaterThan(0);
      await expect(groups.first()).toBeVisible();
    }
  });
});

test.describe("capture — disclosure and keyboard", () => {
  test("session activity is collapsed, and opens from the keyboard", async ({
    page,
  }) => {
    await openCapture(page);
    const toggle = page.locator("[data-capture-activity-toggle]");
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // The panel it controls is genuinely absent while collapsed.
    const panelId = await toggle.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    // [id="…"], not #…: React useId emits ":r1:", which is not a valid CSS
    // identifier, and the escape helper is a browser global absent from
    // this Node context.
    const panel = page.locator(`[id="${panelId}"]`);
    await expect(panel).toHaveCount(0);

    // Keyboard activation, not a click: this is the property a div would fail.
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toHaveCount(1);

    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("the toggle shows a visible focus ring", async ({ page }) => {
    await openCapture(page);
    const toggle = page.locator("[data-capture-activity-toggle]");
    await toggle.focus();
    const shadow = await toggle.evaluate(
      (el) => getComputedStyle(el).boxShadow,
    );
    expect(shadow).not.toBe("none");
  });
});

test.describe("capture — responsive", () => {
  for (const { name, width, height } of WIDTHS) {
    test(`${name}: the page does not scroll sideways`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openCapture(page);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `${name} overflows horizontally`).toBeLessThanOrEqual(0);
    });

    test(`${name}: no element overflows its own container`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openCapture(page);
      const strays = await page.evaluate(() => {
        const out: string[] = [];
        const docWidth = document.documentElement.clientWidth;
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
          // Inside an <svg>, geometry is clipped by the viewBox: a path can
          // report a box past the viewport while being invisible and unable to
          // widen the document. Only laid-out HTML boxes count. (Their
          // `className` is also an SVGAnimatedString, which is why the old
          // failure named "[object SVGAnimatedString]" instead of an element.)
          if (el.closest("svg")) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right > docWidth + 1) {
            const cls = typeof el.className === "string" ? el.className : "";
            out.push(
              `${el.tagName.toLowerCase()}.${cls} +${Math.round(
                r.right - docWidth,
              )}px`.slice(0, 110),
            );
          }
        }
        return out.slice(0, 5);
      });
      expect(strays, `${name}: ${strays.join(" | ")}`).toEqual([]);
    });
  }

  test("mobile keeps Final Readiness next to Review & Sign", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCapture(page);
    const summary = await page.locator("[data-capture-final-readiness]").boundingBox();
    const finalize = await page
      .locator("[data-capture-finalize], button:has-text('Review & Sign')")
      .first()
      .boundingBox();
    expect(summary).not.toBeNull();
    expect(finalize).not.toBeNull();
    // The verdict is read immediately before the action it governs; a screen
    // of other content between them is how an operator misses the reason.
    expect(finalize!.y - (summary!.y + summary!.height)).toBeLessThan(400);
  });

  test("at 1024 the rail band uses the full width, not the side column's cap", async ({
    page,
  }) => {
    // Below 1280px the rail stops being a column and becomes a band under the
    // content. It used to keep the column layout's 360px cap and still split
    // itself in two, giving 171px tracks in which the metadata values wrapped a
    // character at a time and Integrity preparation's labels ran through their
    // own values. Overlapping text does not overflow the document, so the sweep
    // above cannot see it — this measures the cause instead.
    await page.setViewportSize({ width: 1024, height: 900 });
    await openCapture(page);
    const rail = await page.locator(".capture-rail").first().boundingBox();
    const main = await page.locator(".capture-main-panel").first().boundingBox();
    expect(rail).not.toBeNull();
    expect(main).not.toBeNull();
    expect(
      rail!.width,
      "the band must be as wide as the content it sits under",
    ).toBeGreaterThan(main!.width * 0.9);
  });

  test("desktop gives the main column more room than the rail", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCapture(page);
    const main = await page.locator(".capture-main-panel").first().boundingBox();
    if (main) {
      expect(
        main.width,
        "the working column must dominate the viewport",
      ).toBeGreaterThan(1440 * 0.45);
    }
  });
});

test.describe("capture — the rail's dense surfaces", () => {
  test("Integrity preparation is a status list, not a table of cells", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCapture(page);
    // Integrity preparation now lives in the collapsed Session details.
    await page.locator("[data-capture-session-details] > summary").click();

    // It was `gap: 1px` over a tinted background with opaque white cells, so
    // the tint showed through every gap as a rule and each of the four
    // statuses sat in its own box.
    const list = page.locator(".capture-integrity-list");
    const shape = await list.evaluate((el) => {
      const cs = getComputedStyle(el);
      const row = el.querySelector("div")!;
      const rcs = getComputedStyle(row);
      return {
        listBg: cs.backgroundColor,
        gap: cs.gap,
        rowBg: rcs.backgroundColor,
        rowLeftBorder: rcs.borderLeftWidth,
        rowRightBorder: rcs.borderRightWidth,
      };
    });
    expect(shape.listBg, "the list must not paint a grid").toBe("rgba(0, 0, 0, 0)");
    expect(shape.gap, "a 1px gap IS the grid").not.toBe("1px");
    expect(shape.rowBg, "rows must not be opaque cells").toBe("rgba(0, 0, 0, 0)");
    expect(shape.rowLeftBorder, "no vertical rules").toBe("0px");
    expect(shape.rowRightBorder, "no vertical rules").toBe("0px");

    // Four rows, and every label and value readable.
    const rows = list.locator("> div");
    await expect(rows).toHaveCount(4);
    for (const label of ["Fingerprint", "Custody", "Package", "Location"]) {
      await expect(list).toContainText(label);
    }
  });

  test("the AI advisory CTA is dark ink, never the accent", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await openCapture(page);
    await page.locator(".capture-phase7-ai-toggle").click();

    const cta = page.locator(".capture-phase7-ai-body button").last();
    await expect(cta).toBeVisible();
    const paint = await cta.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, fg: cs.color };
    });
    const rgb = (v: string) =>
      ((v.match(/\d+/g) ?? []).slice(0, 3).map(Number) as [number, number, number]);
    expect(
      Math.max(...rgb(paint.bg)),
      "AI is advisory; Review & Sign owns the accent",
    ).toBeLessThan(80);
    expect(rgb(paint.fg).every((c) => c > 240)).toBe(true);

    // And the boundary statement is still there, in full.
    await expect(page.locator(".capture-ai-advisory-shell")).toContainText(
      /does not determine authenticity, truth, authorship, legal admissibility/i,
    );
  });
});

/*
 * F-29 (2026-10-29) — the desktop layout at 1181-1280px. A legacy
 * `@media (max-width: 1280px)` rule spanned the rail across `1 / -1` under the
 * two-column template, so on a 1280px laptop the rail fell BELOW the working
 * column and an empty 352px track sat beside it ("looks like a tablet"). The
 * 1024 test above and the overflow sweep could not see it: nothing overflowed.
 */
test.describe("capture — desktop keeps the rail beside the working column", () => {
  for (const width of [1440, 1280, 1200]) {
    test(`${width}: the rail is a side column, level with the working column`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openCapture(page);
      const main = await page.locator(".capture-main-panel").first().boundingBox();
      const rail = await page.locator(".capture-session-column").first().boundingBox();
      expect(main).not.toBeNull();
      expect(rail).not.toBeNull();
      expect(rail!.x, "the rail starts to the right of the working column").toBeGreaterThanOrEqual(main!.x + main!.width - 1);
      expect(Math.abs(rail!.y - main!.y), "the rail starts level with the working column").toBeLessThan(80);
    });
  }
});

/** The relative luminance contrast of two `rgb()` colours (WCAG 2.x). */
function contrastRatio(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/*
 * F-25 (2026-10-29) — the browser screen-recording card reused the dropzone's
 * tile grid and the legacy audio-card class; their !important hover rules made
 * the primary "Choose what to record" button white-on-white on hover and
 * removed its focus ring. Measured from the real cascade, at rest and hovered.
 */
test.describe("capture — the screen recording card's actions", () => {
  test("Screen opens the browser chooser directly; the live card's Stop keeps a legible primary fill and a focus ring", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // A real MediaStream (canvas) stands in for the surface the user would
    // pick in the browser's chooser; MediaRecorder is the real one.
    await page.addInitScript(() => {
      (window as unknown as { __gdm: number }).__gdm = 0;
      navigator.mediaDevices.getDisplayMedia = async () => {
        (window as unknown as { __gdm: number }).__gdm += 1;
        const c = document.createElement("canvas");
        c.width = 160;
        c.height = 90;
        const ctx = c.getContext("2d")!;
        setInterval(() => {
          ctx.fillStyle = `hsl(${Date.now() % 360} 70% 50%)`;
          ctx.fillRect(0, 0, 160, 90);
        }, 60);
        return c.captureStream(15);
      };
    });
    await openCapture(page);
    await page.locator("[data-capture-add-action='screen']").click();
    // ONE click reached the chooser: no intermediate card to click through.
    await expect(page.locator("[data-capture-screen-recorder]")).toHaveAttribute("data-screen-recorder-state", "recording");
    await expect(page.getByText("Choose what to record")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __gdm: number }).__gdm)).toBe(1);

    const button = page.locator("[data-screen-recorder-stop]");
    await expect(button).toHaveText(/Stop recording/);
    const read = () =>
      button.evaluate((el) => {
        const s = getComputedStyle(el);
        return { image: s.backgroundImage, bg: s.backgroundColor, color: s.color, outline: s.outlineStyle, outlineWidth: s.outlineWidth };
      });
    const rest = await read();
    expect(rest.image, "the primary fill is the canonical gradient").toMatch(/gradient/);
    await button.hover();
    const hovered = await read();
    expect(hovered.image, "hover keeps the primary fill").toMatch(/gradient/);
    const stop = (hovered.image.match(/rgba?\([^)]+\)/) ?? ["rgb(124, 58, 237)"])[0];
    expect(contrastRatio(hovered.color, stop), "label contrast on hover").toBeGreaterThanOrEqual(4.5);
    await page.mouse.move(0, 0);
    await button.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const focused = await read();
    expect(focused.outline, "keyboard focus shows a ring").not.toBe("none");

    // Stopping produces exactly one staged recording, however often Add is pressed.
    await button.click();
    await page.getByRole("button", { name: "Add recording to session" }).dblclick();
    await expect(page.locator("[data-capture-staged-item]")).toHaveCount(1);
    await expect(page.locator(".capture-staged__name").first()).toHaveText(/^screen-recording-.*\.webm$/);
  });

  test("a cancelled chooser stages nothing and leaves the page as it was", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = () =>
        Promise.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
    });
    await openCapture(page);
    await page.locator("[data-capture-add-action='screen']").click();
    await expect(page.locator("[data-capture-screen-recorder]")).toContainText(/cancelled or not allowed/);
    await expect(page.locator("[data-capture-staged-item]")).toHaveCount(0);
    await page.getByRole("button", { name: "Close screen recording" }).click();
    await expect(page.locator("[data-capture-screen-recorder]")).toHaveCount(0);
  });
});

/*
 * 2026-11-13 — the staged list used to be eight fixed columns whose minimums
 * exceeded the working column once the rail took its share: Status and Actions
 * painted outside the card and "Preview" broke across two lines. The list now
 * sizes itself to its own width (a CSS container). Measured with a long name
 * and mixed types at the widths where the old table broke.
 */
test.describe("capture — staged evidence fits its card", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  for (const width of [1440, 1280, 1200, 1024, 768, 390, 375, 320]) {
    test(`${width}: every cell and action stays inside the list`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openCapture(page);
      await page.locator('input[type="file"][aria-label="Upload evidence files"]').setInputFiles([
        { name: "insurance-claim-2026-11-13-front-door-damage-north-facade-close-up-photo-final-v3.png", mimeType: "image/png", buffer: PNG },
        { name: "loss-context.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") },
        { name: "statement.m4a", mimeType: "audio/mp4", buffer: Buffer.from("a") },
      ]);
      await expect(page.locator("[data-capture-staged-item]")).toHaveCount(3);
      const strays = await page.evaluate(() => {
        const list = document.querySelector(".capture-staged__list")!.getBoundingClientRect();
        const out: string[] = [];
        for (const el of Array.from(
          document.querySelectorAll<HTMLElement>(".capture-staged__item > *, .capture-staged__action, .capture-staged__badge, .capture-staged__assign-trigger"),
        )) {
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          if (r.left < list.left - 1 || r.right > list.right + 1) out.push(el.className.slice(0, 60));
        }
        return out;
      });
      expect(strays).toEqual([]);
      const pageOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(pageOverflow).toBeLessThanOrEqual(0);
    });
  }
});
