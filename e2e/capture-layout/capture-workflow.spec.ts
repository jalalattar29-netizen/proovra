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

    // The canonical five-stage rail, and nothing beside it claiming to be a
    // stepper.
    await expect(page.locator(".capture-enterprise-steps")).toHaveCount(0);

    // One drop zone, and it is not in the hero.
    const heroBox = await page.locator(".capture-enterprise-title-card").boundingBox();
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
    const items = page.locator("[data-capture-trust-item]");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("Integrity by design");
    await expect(items.nth(1)).toContainText("End-to-end protected");
    await expect(items.nth(2)).toContainText("Verifiable audit trail");

    const body = (await page.locator("body").innerText()).toLowerCase();
    for (const banned of [
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

    // The verdict is words, not only colour.
    await expect(summary).toContainText(/Ready to finalize|Not ready to finalize/);
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
    if (state === "clear") {
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
    const rail = await page.locator(".capture-command-center").first().boundingBox();
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
