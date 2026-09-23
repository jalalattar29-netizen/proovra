/**
 * DIRECT WEB CAPTURE CARD — the surface, the weights, and the honest state.
 *
 * WHAT THIS PINS
 * ---------------------------------------------------------------------------
 * The card asked for `--capture-border` and `--capture-surface`. Neither token
 * is declared anywhere: the capture page defines `--capture-card`,
 * `--capture-line`, `--capture-ink`, `--capture-muted` and the accent family,
 * and nothing else. Both properties therefore fell through to the rule's own
 * hard-coded fallbacks — `rgba(11, 46, 39, 0.14)` and `rgba(11, 46, 39, 0.03)`,
 * values from a retired green palette — so the card painted a dull grey-green
 * wash while every panel beside it paints `--cap-panel` with
 * `--capture-line` around it. The reported "unattractive silver" was not a
 * colour anybody chose; it was two undefined variables.
 *
 * A unit test cannot catch that. `var(--x, fallback)` resolves in the cascade,
 * at runtime, against the stylesheet order of the production bundle — which is
 * exactly what this project exists to measure. Every assertion below reads a
 * COMPUTED value from a real engine.
 *
 * The heading and the "Learn how Direct Web Capture works" link are also
 * asserted bold here, and the card's honest unavailable state is asserted with
 * them: a visual pass that let an install button appear for an unpublished
 * extension would be a worse regression than the silver ever was.
 */

import { expect, test, type Page } from "@playwright/test";

import { openCapture, WIDTHS } from "./_fixtures";

const CARD = "[data-capture-direct-web-capture]";
const TITLE = ".capture-direct-web__title";
const LEARN_MORE = "[data-capture-direct-web-learn-more]";

/** One computed property, from the real cascade. */
async function computed(page: Page, selector: string, prop: string): Promise<string> {
  return page.locator(selector).evaluate(
    (el, p) => getComputedStyle(el).getPropertyValue(p).trim(),
    prop,
  );
}

/** `rgb(r, g, b)` / `rgba(...)` → the three channels. */
function channels(color: string): [number, number, number] {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`not a resolvable colour: ${color}`);
  const parts = m[1].split(",").map((v) => Number.parseFloat(v.trim()));
  return [parts[0], parts[1], parts[2]];
}

test.describe("Direct Web Capture card", () => {
  test("the surface is the page's own card colour, not the retired green wash", async ({
    page,
  }) => {
    await openCapture(page);
    const card = page.locator(CARD);
    await expect(card).toBeVisible();

    const background = await computed(page, CARD, "background-color");
    const [r, g, b] = channels(background);

    // The retired fallback was `rgba(11, 46, 39, 0.03)`: a green-tinted grey
    // whose green channel sits above the other two. The page's own panel fill
    // is `--cap-panel` — white, deliberately translucent (§B1: "the
    // background is the dominant value and the border does the grouping").
    expect(
      r === 255 && g === 255 && b === 255,
      `the card should paint the page's --cap-panel (white); got ${background}`,
    ).toBe(true);
    expect(g).toBe(r);
    expect(b).toBe(r);
  });

  test("it sits on the same surface as the panels around it", async ({ page }) => {
    await openCapture(page);

    // `.capture-hero` is a sibling panel in the same column. "Integrates with
    // the page" is measurable: same surface colour, same border colour.
    const cardBg = await computed(page, CARD, "background-color");
    const panelBg = await computed(page, ".capture-hero", "background-color");
    expect(cardBg).toBe(panelBg);

    // Including the translucency and the absence of a shadow: §B1 made these
    // surfaces part of the page on purpose, and a card with a drop shadow
    // would be the one box floating above it.
    expect(await computed(page, CARD, "box-shadow")).toBe("none");

    // The border is the same ink, not merely a similar one.
    const cardBorder = await computed(page, CARD, "border-top-color");
    expect(cardBorder).toBe(await computed(page, ".capture-hero", "border-top-color"));

    // And it is not the retired green: `rgba(11, 46, 39, 0.14)` has its GREEN
    // channel above both others, which is what made the old card read as a
    // grey-green wash. `--capture-line` is a blue-leaning neutral ink.
    const [br, bg, bb] = channels(cardBorder);
    expect(bg > br && bg > bb, `the border is green-biased: ${cardBorder}`).toBe(false);
  });

  test("the heading is bold, and heavier than the body it introduces", async ({ page }) => {
    await openCapture(page);
    const titleWeight = Number(await computed(page, TITLE, "font-weight"));
    const bodyWeight = Number(await computed(page, ".capture-direct-web__body", "font-weight"));

    expect(titleWeight).toBeGreaterThanOrEqual(700);
    expect(titleWeight).toBeGreaterThan(bodyWeight);

    // It is a heading in the document, not a paragraph that looks like one.
    await expect(page.locator(`${CARD} h2#direct-web-capture-heading`)).toHaveText(
      "Direct Web Capture",
    );
  });

  test("the learn-more link is bold and still points at the disclosure page", async ({
    page,
  }) => {
    await openCapture(page);
    const link = page.locator(LEARN_MORE);
    await expect(link).toHaveText("Learn how Direct Web Capture works");
    expect(Number(await computed(page, LEARN_MORE, "font-weight"))).toBeGreaterThanOrEqual(700);

    // The destination is the authenticated disclosure page. It is NOT the
    // install target, and the card has no business sending anyone to a store
    // listing that does not exist.
    await expect(link).toHaveAttribute("href", "/settings/legal/direct-web-capture");
  });

  test("an unpublished extension offers no install control, at any width", async ({ page }) => {
    await openCapture(page);

    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w.width, height: w.height });
      await expect(page.locator(CARD), w.name).toBeVisible();

      // No install affordance while `NEXT_PUBLIC_EXTENSION_INSTALL_URL` is
      // unset — which is the repository's actual state, and the only thing
      // that may decide this claim. A card that builds is not a card that is
      // published.
      await expect(page.locator("[data-capture-direct-web-install]"), w.name).toHaveCount(0);

      // The card never overflows its column.
      const overflow = await page.locator(CARD).evaluate((el) => {
        const parent = el.parentElement;
        if (!parent) return 0;
        return Math.round(el.getBoundingClientRect().right - parent.getBoundingClientRect().right);
      });
      expect(overflow, `${w.name}: the card overflows its container`).toBeLessThanOrEqual(1);
    }
  });

  test("the availability line states the truth rather than a date nobody promised", async ({
    page,
  }) => {
    await openCapture(page);
    const line = page.locator("[data-capture-direct-web-availability]");
    await expect(line).toBeVisible();
    const text = (await line.textContent())?.toLowerCase() ?? "";
    expect(text.includes("coming soon"), "'coming soon' is a promise nobody made").toBe(false);
  });
});
