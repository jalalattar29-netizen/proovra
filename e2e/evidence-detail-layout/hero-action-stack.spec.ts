/**
 * The record actions belong to the HEADER, beside the title.
 *
 * They were first built into the download toolbar, which put "Edit name" and
 * "Lock" on the same line as the record's two primary outputs. Geometry is the
 * only thing that can prove where they ended up, so this asserts the boxes:
 * the stack shares the title block's row and starts to its right, and the
 * downloads sit BELOW it rather than beside it.
 */
import { test, expect } from "@playwright/test";
import { installApi } from "./_fixtures";

test("the action stack sits BESIDE the title, above the downloads", async ({ page }) => {
  await installApi(page, "organization", {});
  await page.goto("/evidence/11111111-1111-4111-8111-111111111111");
  await page.waitForSelector('[data-evidence-action="copy-verification-link"]');

  const title = await page.locator(".evidence-detail-hero-main").boundingBox();
  const stack = await page.locator(".evidence-detail-hero-icon-actions").boundingBox();
  const dl = await page.locator('[data-evidence-action="download-report"]').boundingBox();

  // Beside: the stack starts to the right of the title block and shares its row.
  expect(stack!.x).toBeGreaterThan(title!.x);
  expect(stack!.y).toBeLessThan(title!.y + title!.height);
  // Above: the downloads are below the stack, not beside it.
  expect(dl!.y).toBeGreaterThan(stack!.y);

  // Dark fill, white text.
  const c = await page.locator('[data-evidence-action="copy-verification-link"]').evaluate((e) => {
    const s = getComputedStyle(e);
    return { bg: s.backgroundColor, fg: s.color };
  });
  expect(c.bg).toBe("rgb(23, 32, 51)");
  expect(c.fg).toBe("rgb(255, 255, 255)");

  // No horizontal overflow at phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
});

test("the stack carries all five actions, with the trash one red on white", async ({ page }) => {
  await installApi(page, "organization", {
    lifecycle: {
      productState: "ACTIVE",
      canArchive: true,
      canUnarchive: false,
      canTrash: true,
      canRestoreFromTrash: false,
      trashBlockReason: null,
      archiveBlockReason: null,
      trashGraceUntilUtc: null,
      appRetentionUntilUtc: null,
      objectLockRetainUntilUtc: null,
      effectiveRetentionUntilUtc: null,
      objectLockCompliance: false,
      legalHold: false,
      destructionEligibleAtUtc: null,
      destructionBlockReason: null,
    },
    archivedAt: null,
    deletedAt: null,
    lockedAt: null,
  });
  await page.goto("/evidence/11111111-1111-4111-8111-111111111111");
  const stack = page.locator(".evidence-detail-hero-icon-actions");
  await stack.waitFor();

  const labels = await stack.locator("button span").allTextContents();
  expect(labels).toEqual([
    "Verification link",
    "Lock",
    "Archive",
    "Move to trash",
    "Edit name",
  ]);

  // One geometry for all five.
  const boxes = await stack.locator("button").evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    }),
  );
  expect(new Set(boxes.map((b) => b.w)).size).toBe(1);
  expect(new Set(boxes.map((b) => b.h)).size).toBe(1);

  // Red text on white — never a red fill.
  const trash = await page
    .locator('[data-evidence-action="header-trash"]')
    .evaluate((e) => {
      const s = getComputedStyle(e);
      return { bg: s.backgroundColor, fg: s.color };
    });
  expect(trash.fg).toBe("rgb(220, 38, 38)");
  expect(trash.bg).not.toBe("rgb(220, 38, 38)");
});

test("the verification link keeps white text on hover and focus", async ({ page }) => {
  await installApi(page, "organization", {});
  await page.goto("/evidence/11111111-1111-4111-8111-111111111111");
  const btn = page.locator('[data-evidence-action="copy-verification-link"]');
  await btn.waitFor();

  const read = () => btn.evaluate((e) => {
    const s = getComputedStyle(e);
    return { bg: s.backgroundColor, fg: s.color };
  });

  expect((await read()).fg).toBe("rgb(255, 255, 255)");
  await btn.hover();
  // Confirm :hover actually engaged before believing what we read.
  const hovered = await btn.evaluate((e) => e.matches(":hover"));
  expect(hovered, "hover did not engage").toBe(true);
  const h = await read();
  expect(h.fg, "the label must not go dark on hover").toBe("rgb(255, 255, 255)");
  // NOT the dark heading ink — that is exactly the regression: the base
  // `.app-secondary-action:hover` sets `color: var(--app-ink-heading)`, and a
  // filled control that does not override it renders dark-on-dark.
  expect(h.fg).not.toBe("rgb(23, 32, 51)");
  await btn.focus();
  expect((await read()).fg).toBe("rgb(255, 255, 255)");
});
