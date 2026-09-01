/**
 * WHERE THE LIFECYCLE STATUS IS, MEASURED.
 *
 * Status was the fourth column, immediately after Condition — the one elastic
 * column on the page. It therefore started at a different x on every row, and
 * "which of these has someone on it" meant reading a ragged edge in the middle
 * of the table. It is the last column before the row menu now.
 *
 * Every assertion here is a box, which is why it lives in this project: the
 * unit test beside it can prove the cell moved in the markup, but only an
 * engine can say whether five rows agree on where the answer is, whether a
 * 150-character title ever reaches it, and what happens to it at 320px.
 */

import { expect, test, type Page } from "@playwright/test";

import { hasHorizontalOverflow, openOperations } from "./_fixtures";

/**
 * The banner is a fixed overlay and does not move the layout, but it does sit
 * over the controls this spec has to press. This states the same fact the
 * fixture's own `/v1/users/cookie-consent/latest` already returns, in the
 * place the client reads it. Necessary categories only.
 */
const ANSWERED_CONSENT = JSON.stringify({
  categories: ["necessary"],
  revision: 1,
  data: null,
  consentTimestamp: "2026-08-29T19:14:00.000Z",
  consentId: "fixture-consent",
  services: { necessary: [], preferences: [], analytics: [], marketing: [] },
  languageCode: "en",
  lastConsentTimestamp: "2026-08-29T19:14:00.000Z",
  expirationTime: 4102444800000,
});

/**
 * The flat list, which is where a status column exists at all.
 *
 * The page opens GROUPED, and the grouped renderer is a different surface with
 * its own header. A spec that measured whatever was on screen would measure
 * the empty state and pass.
 */
async function openConditionList(
  page: Page,
  scenario: "long-title" | "mixed-severity",
  /**
   * WHICH renderer to wait for, stated by the caller.
   *
   * Both are in the document at every width and the stylesheet decides which
   * one is in the layout, so a selector covering both resolves to whichever
   * comes first in DOM order — the hidden table — and then waits for it to
   * become visible until the test times out.
   */
  awaiting: string,
) {
  await page.addInitScript((v) => {
    document.cookie = `cc_cookie=${encodeURIComponent(v as string)};path=/`;
  }, ANSWERED_CONSENT);
  await openOperations(page, "team-admin", { scenario });
  await page.getByRole("button", { name: "All conditions" }).click();
  await page.waitForSelector(awaiting);
}

test("every row answers at the same x, at the end of the row", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openConditionList(page, "long-title", "[data-ops-table-surface] tbody tr");

  const geometry = await page.evaluate(() => {
    const cells = Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-ops-table-surface] td.opsw-col-status",
      ),
    );
    const round = (n: number) => Math.round(n);
    return {
      rows: cells.length,
      lefts: [...new Set(cells.map((c) => round(c.getBoundingClientRect().left)))],
      rights: [...new Set(cells.map((c) => round(c.getBoundingClientRect().right)))],
      // The badge's own right edge, not the cell's: a right-aligned cell whose
      // content still floats left would pass a cell-edge check.
      badgeRights: [
        ...new Set(
          cells.map((c) =>
            round((c.firstElementChild as HTMLElement).getBoundingClientRect().right),
          ),
        ),
      ],
      followsActivity: cells.every((c) => {
        const activity = c.parentElement?.querySelector("td.opsw-col-activity");
        return (
          !!activity &&
          c.compareDocumentPosition(activity) === Node.DOCUMENT_POSITION_PRECEDING
        );
      }),
      beforeActions: cells.every(
        (c) => (c.nextElementSibling as HTMLElement | null)?.classList.contains(
          "opsw-col-actions",
        ) ?? false,
      ),
    };
  });

  expect(geometry.rows, "the scenario must render rows to measure").toBeGreaterThan(1);
  expect(geometry.lefts, "one x for the column, not one per row").toHaveLength(1);
  expect(geometry.rights).toHaveLength(1);
  expect(geometry.badgeRights, "the badges align, not just their cells").toHaveLength(1);
  expect(geometry.followsActivity, "Status comes after the descriptive columns").toBe(true);
  expect(geometry.beforeActions, "the row menu stays last").toBe(true);
});

test("the longest title in the fixture never reaches the status", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openConditionList(page, "long-title", "[data-ops-table-surface] tbody tr");

  const gaps = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-ops-table-surface] tbody tr"),
    ).map((row) => {
      const activity = row.querySelector<HTMLElement>("td.opsw-col-activity");
      const badge = row.querySelector<HTMLElement>("td.opsw-col-status > *");
      if (!activity || !badge) return -1;
      // The TEXT box, not the cell box — a cell is as wide as its column and
      // says nothing about where its content actually ends.
      const range = document.createRange();
      range.selectNodeContents(activity);
      return Math.round(
        badge.getBoundingClientRect().left - range.getBoundingClientRect().right,
      );
    }),
  );

  expect(gaps.length).toBeGreaterThan(1);
  for (const gap of gaps) {
    expect(gap, `a row left ${gap}px before its status`).toBeGreaterThan(16);
  }
  expect(await hasHorizontalOverflow(page)).toBe(false);
});

for (const width of [1024, 768, 430, 390, 320]) {
  test(`${width}px: the card keeps the status at the trailing edge`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openConditionList(page, "mixed-severity", "[data-ops-cards] .opsw-card__head");

    const heads = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-ops-cards] .opsw-card__head"),
      ).map((head) => {
        const slot = head.querySelector<HTMLElement>(".opsw-card__status");
        if (!slot) return null;
        const h = head.getBoundingClientRect();
        const s = slot.getBoundingClientRect();
        return {
          overhangRight: Math.round(s.right - h.right),
          overflowsBottom: s.bottom > h.bottom + 1,
          empty: slot.textContent?.trim() === "",
        };
      }),
    );

    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) {
      expect(head, "every card head carries a status slot").not.toBeNull();
      expect(head!.empty, "the slot must not be empty").toBe(false);
      // Flush with the trailing edge — pushed there by the layout, so it is
      // allowed to sit exactly on it, never past it.
      expect(head!.overhangRight, "the status must not spill out of its head")
        .toBeLessThanOrEqual(0);
      expect(head!.overflowsBottom, "wrapping is fine; clipping is not").toBe(false);
    }
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });
}
