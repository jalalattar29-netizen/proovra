/**
 * BROWSER VERIFICATION — "Manage verification page" and "Secure reviewer
 * shares" on Evidence Detail (disclosure model 2026-10-18; ET-PKG-07).
 *
 * The Artifacts tab hosts ONE control for the record's permanent verification
 * page (its reference, access and what it discloses) and, directly below it,
 * the reviewer shares. These are cascade, geometry and keyboard questions a
 * source guard cannot answer:
 *
 *   1. The share create form labels its four fields with `.app-field-label`,
 *      the ONE field-label authority. `apps/web/__tests__/app-field-label-
 *      authority` records the panel as a consumer; this measures what that
 *      class actually paints HERE, under the Evidence Detail route stylesheet.
 *   2. At 390 px the disclosure segmented control, the share rows and their
 *      actions stay inside the page.
 *   3. The disclosure radiogroup is keyboard operable in a real browser.
 *
 * The API is intercepted (see `_fixtures`): the fixture record's page is
 * available and discloses "Verification only"; it has one active reviewer
 * share and a legacy record-id link still inside its transition period.
 */

import { expect, test, type Page } from "@playwright/test";

import { DIRECTIONS, EVIDENCE_ID, installApi, setDirection } from "./_fixtures";

/** The resolved value of `--app-ink-label` (#344054). */
const LABEL_INK = "rgb(52, 64, 84)";

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 844 };

const PAGE_PANEL = '[data-evidence-section="verification-page"]';
const SHARES_PANEL = '[data-evidence-section="reviewer-shares"]';

async function openControls(page: Page): Promise<void> {
  await installApi(page, "organization");
  await page.goto(`/evidence/${EVIDENCE_ID}?tab=artifacts`);
  await page.waitForSelector(`${PAGE_PANEL} [role="radiogroup"]`, { timeout: 30_000 });
  await page.waitForSelector(`${SHARES_PANEL} [data-verification-link-form]`, { timeout: 30_000 });
}

async function readLabels(page: Page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-verification-link-form] .app-field-label"),
    ).map((el) => {
      const cs = getComputedStyle(el);
      return {
        text: (el.textContent ?? "").trim(),
        color: cs.color,
        weight: Number(cs.fontWeight),
        size: parseFloat(cs.fontSize),
        transform: cs.textTransform,
        inlineStyle: el.getAttribute("style"),
        width: el.getBoundingClientRect().width,
        htmlFor: el.getAttribute("for"),
      };
    }),
  );
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

test.describe("verification page controls", () => {
  for (const dir of DIRECTIONS) {
    test(`${dir} @ 1440: the share form's labels are the one label tier`, async ({ page }) => {
      await page.setViewportSize(WIDE);
      await openControls(page);
      await setDirection(page, dir);

      const labels = await readLabels(page);
      expect(labels.length).toBe(4);
      for (const l of labels) {
        expect(l.color, `"${l.text}" colour`).toBe(LABEL_INK);
        expect(l.weight, `"${l.text}" weight`).toBe(600);
        expect(l.size, `"${l.text}" size`).toBeCloseTo(12.5, 1);
        expect(l.transform, `"${l.text}" case`).toBe("none");
        expect(l.inlineStyle, `"${l.text}" inline style`).toBeNull();
        expect(l.width, `"${l.text}" width`).toBeGreaterThan(0);
        expect(await page.locator(`#${l.htmlFor}`).count(), `"${l.text}" labels no control`).toBe(1);
      }
      expect(await horizontalOverflow(page)).toBe(0);
    });
  }

  test("390: the segmented control, share rows, actions and the form stay inside the page", async ({ page }) => {
    await page.setViewportSize(NARROW);
    await openControls(page);

    const labels = await readLabels(page);
    expect(labels.length).toBe(4);
    for (const l of labels) {
      expect(l.color).toBe(LABEL_INK);
      expect(l.size).toBeCloseTo(12.5, 1);
    }
    expect(await horizontalOverflow(page)).toBe(0);

    const viewport = NARROW.width;
    const boxes = await page.evaluate(
      ({ pagePanel, sharesPanel }) =>
        Array.from(
          document.querySelectorAll<HTMLElement>(
            `${pagePanel} [role="radio"], ${pagePanel} [data-verification-disclosure-location], ` +
              `${pagePanel} [data-verification-access-action], ${pagePanel} [data-verification-visitor-preview], ` +
              `${sharesPanel} [data-verification-link], ${sharesPanel} [data-verification-link-action]`,
          ),
        )
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right };
          }),
      { pagePanel: PAGE_PANEL, sharesPanel: SHARES_PANEL },
    );
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(viewport + 0.5);
    }
    // Each option is a comfortable touch target.
    const heights = await page
      .locator(`${PAGE_PANEL} [role="radio"]`)
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
  });

  test("the disclosure radiogroup is keyboard operable and the location switch follows the mode", async ({ page }) => {
    await page.setViewportSize(WIDE);
    await openControls(page);

    const panel = page.locator(PAGE_PANEL);
    const vo = panel.locator('[data-verification-disclosure-mode="VERIFICATION_ONLY"]');
    const cp = panel.locator('[data-verification-disclosure-mode="CONTENT_PREVIEW"]');
    const location = panel.locator("[data-verification-disclosure-location]");

    await expect(vo).toHaveAttribute("aria-checked", "true");
    await expect(location).toBeDisabled();
    await vo.focus();
    await page.keyboard.press("ArrowRight");
    await expect(cp).toHaveAttribute("aria-checked", "true");
    await expect(cp).toBeFocused();
    await expect(location).toBeEnabled();
    await page.keyboard.press("ArrowLeft");
    await expect(vo).toHaveAttribute("aria-checked", "true");
    await expect(location).toBeDisabled();

    // The visitor preview is the server's, and the warning is always there.
    await expect(panel.locator("[data-verification-visitor-preview]")).toContainText("What anonymous visitors see");
    await expect(panel.locator('[data-verification-visitor-preview-group="withheld"]')).toContainText(
      "Title and description",
    );
    await expect(panel.locator("[data-verification-disclosure-warning]")).toContainText(
      "Anyone holding the permanent verification reference",
    );
    await expect(panel.locator('[data-verification-access-action="open"]')).toHaveAttribute(
      "href",
      /\/verify\/pvr_FixtureReferenceAAAAAAAAAAAA$/,
    );
  });

  test("the shares panel shows the active share and the legacy record-ID link as separate, revocable things", async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await openControls(page);

    const panel = page.locator(SHARES_PANEL);
    const active = panel.locator('[data-verification-links="active"] [data-verification-link]');
    await expect(active).toHaveCount(1);
    await expect(active.first()).toHaveAttribute("data-verification-link-state", "ACTIVE");
    await expect(active.first()).toHaveAttribute("data-verification-link-usable", "true");
    await expect(active.first().locator("[data-verification-link-profile]")).toHaveText("Content preview");
    await expect(active.first().locator('[data-verification-link-action="revoke"]')).toBeVisible();
    await expect(active.first().locator('[data-verification-link-action="rotate"]')).toBeVisible();

    const legacy = panel.locator('[data-verification-link="legacy"]');
    await expect(legacy).toHaveAttribute("data-verification-link-state", "ACTIVE");
    await expect(legacy.locator('[data-verification-link-action="revoke-legacy"]')).toBeVisible();

    // A stored share's secret is never in the page: only a share created in
    // this session is shown, once. Nothing on first paint carries a token.
    expect(await panel.locator("[data-verification-link-url]").count()).toBe(0);
    expect((await panel.innerText()).includes("pvs_")).toBe(false);
    // Nothing on either control offers to publish.
    expect(/publish/i.test(await page.locator(PAGE_PANEL).innerText())).toBe(false);
    expect(/publish/i.test(await panel.innerText())).toBe(false);
  });
});
