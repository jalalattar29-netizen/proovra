/**
 * BROWSER VERIFICATION — the Public verification links panel on Evidence
 * Detail (ET-PKG-07).
 *
 * The panel is where an owner creates, copies, revokes and replaces the links
 * that open a record's public verification page. Two things about it are
 * cascade or geometry questions a source guard cannot answer:
 *
 *   1. Its create form labels its four fields with `.app-field-label`, the ONE
 *      field-label authority. `apps/web/__tests__/app-field-label-authority`
 *      records the panel as a consumer; this measures what that class actually
 *      paints HERE, under the Evidence Detail route stylesheet.
 *   2. A link row carries a state, an audience, dates and two actions. At a
 *      narrow width that is the row that overflows the page.
 *
 * The API is intercepted (see `_fixtures`): the fixture record has one active
 * share link and a legacy record-id link still inside its transition period.
 */

import { expect, test, type Page } from "@playwright/test";

import { DIRECTIONS, EVIDENCE_ID, installApi, setDirection } from "./_fixtures";

/** The resolved value of `--app-ink-label` (#344054). */
const LABEL_INK = "rgb(52, 64, 84)";

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 844 };

async function openLinksPanel(page: Page): Promise<void> {
  await installApi(page, "organization");
  await page.goto(`/evidence/${EVIDENCE_ID}?tab=artifacts`);
  await page.waitForSelector(
    '[data-evidence-section="public-verification-links"] [data-verification-link-form]',
    { timeout: 30_000 },
  );
}

async function readLabels(page: Page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-verification-link-form] .app-field-label",
      ),
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

test.describe("public verification links panel", () => {
  for (const dir of DIRECTIONS) {
    test(`${dir} @ 1440: the create form's labels are the one label tier`, async ({
      page,
    }) => {
      await page.setViewportSize(WIDE);
      await openLinksPanel(page);
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
        // Each label names a real control.
        expect(
          await page.locator(`#${l.htmlFor}`).count(),
          `"${l.text}" labels no control`,
        ).toBe(1);
      }
      expect(await horizontalOverflow(page)).toBe(0);
    });
  }

  test("390: rows, actions and the form stay inside the page", async ({ page }) => {
    await page.setViewportSize(NARROW);
    await openLinksPanel(page);

    const labels = await readLabels(page);
    expect(labels.length).toBe(4);
    for (const l of labels) {
      expect(l.color).toBe(LABEL_INK);
      expect(l.size).toBeCloseTo(12.5, 1);
    }
    expect(await horizontalOverflow(page)).toBe(0);

    const viewport = NARROW.width;
    const boxes = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-evidence-section="public-verification-links"] [data-verification-link], ' +
            '[data-evidence-section="public-verification-links"] [data-verification-link-action]',
        ),
      ).map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }),
    );
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(viewport + 0.5);
    }
  });

  test("the panel shows the active link and the legacy record-ID link as separate, revocable things", async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await openLinksPanel(page);

    const panel = page.locator('[data-evidence-section="public-verification-links"]');
    const active = panel.locator('[data-verification-links="active"] [data-verification-link]');
    await expect(active).toHaveCount(1);
    await expect(active.first()).toHaveAttribute("data-verification-link-state", "ACTIVE");
    await expect(active.first().locator('[data-verification-link-action="revoke"]')).toBeVisible();
    await expect(active.first().locator('[data-verification-link-action="rotate"]')).toBeVisible();

    const legacy = panel.locator('[data-verification-link="legacy"]');
    await expect(legacy).toHaveAttribute("data-verification-link-state", "ACTIVE");
    await expect(legacy.locator('[data-verification-link-action="revoke-legacy"]')).toBeVisible();

    // A stored link's secret is never in the page: only a link created in this
    // session is shown, once. Nothing on first paint carries a share token.
    expect(await panel.locator("[data-verification-link-url]").count()).toBe(0);
    expect((await panel.innerText()).includes("pvs_")).toBe(false);
  });
});
