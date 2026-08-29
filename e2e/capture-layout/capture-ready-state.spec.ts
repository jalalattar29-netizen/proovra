/**
 * CAPTURE — the two states the fresh session never reaches.
 *
 * A page opened cold has no materials, so `computeSessionReadiness` always
 * refuses and always has something to warn about. That left two branches
 * asserted only against the source: the READY verdict, and the compact row
 * that blockers-and-warnings collapse to when there are none of either.
 * Source assertions cannot tell you whether "Ready to finalize" sits above an
 * enabled button, or whether the clear state is really one row.
 *
 * So this drives the page instead of stubbing it. A file goes in through the
 * real `input[aria-label="Upload evidence files"]`, the real change handler
 * stages it, and the real readiness authority decides what follows. Nothing is
 * faked: the state is reached the way an operator reaches it.
 *
 * `force: true` on the clicks is about the sticky app header overlapping the
 * control after Playwright scrolls it to the top of the viewport, not about
 * the control being unreachable. These specs measure readiness, not hit
 * testing; the responsive project measures geometry.
 */

import { expect, test } from "@playwright/test";

import { openCapture } from "./_fixtures";

const PDF = {
  name: "primary-evidence.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4\n% capture layout fixture\n"),
};

async function stageOneMaterial(page: import("@playwright/test").Page) {
  await page.setInputFiles('input[aria-label="Upload evidence files"]', PDF);
  await expect(page.locator(".capture-material-dropdown-trigger").first()).toBeVisible();
}

test.describe("capture — the ready branch", () => {
  test("one staged material reaches READY, above an ENABLED button", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openCapture(page);

    const summary = page.locator("[data-capture-final-readiness]");
    await expect(summary).toHaveAttribute("data-capture-final-readiness", "not_ready");

    await stageOneMaterial(page);

    // The verdict flipped, in words, and the button it governs agrees.
    await expect(summary).toHaveAttribute("data-capture-final-readiness", "ready");
    await expect(summary).toContainText("Ready to finalize");
    await expect(summary).toHaveAttribute("data-capture-can-finalize", "true");

    const finalize = page
      .locator("[data-capture-finalize], button:has-text('Review & Sign')")
      .first();
    expect(
      await finalize.isDisabled(),
      "Ready to finalize must not sit above a disabled button",
    ).toBe(false);

    // The ready detail is counted facts, not a claim about the evidence.
    await expect(summary).toContainText(/1 material added/);
    await expect(summary).not.toContainText(/verified|admissible|court/i);
  });
});

test.describe("capture — the clear branch", () => {
  test("zero blockers and zero warnings render as ONE compact row", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openCapture(page);
    await stageOneMaterial(page);

    const nudge = async (locator: ReturnType<typeof page.locator>) => {
      await locator.scrollIntoViewIfNeeded();
      await locator.click({ force: true });
    };

    // Clear the two things the authority warns about: the plan recommends
    // location metadata, and the staged material is not mapped to a
    // requirement yet.
    await nudge(page.locator(".capture-setup-location input"));
    await nudge(page.locator(".capture-material-dropdown-trigger").first());
    await page
      .locator(".capture-material-dropdown-menu button")
      .nth(1)
      .click({ force: true });

    const signals = page.locator("[data-capture-signals]");
    await expect(signals).toHaveAttribute("data-capture-signals", "clear");
    await expect(signals).toContainText("No blockers");
    await expect(signals).toContainText("No warnings");

    // ONE row. Two cards each announcing an absence is what this state
    // replaced, and the height is the only thing that can tell them apart.
    const box = await signals.boundingBox();
    expect(box!.height, "the clear state must not be two stacked cards").toBeLessThan(
      90,
    );

    // And mapping the required step is reflected in the verdict's own count.
    await expect(page.locator("[data-capture-final-readiness]")).toContainText(
      "1/1 required items mapped",
    );
  });
});
