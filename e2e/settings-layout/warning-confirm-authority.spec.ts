/**
 * THE WARNING CONFIRMATION SAYS CAUTION IN THE PRODUCT'S CAUTION COLOUR.
 *
 * "Sign out other sessions?" is the one destructive-adjacent confirmation an
 * ordinary account meets, and both its icon and its submit button were brown:
 * the icon mixed its own #FFF4E5 / #F4D3A4 / #A85F12 container, and the button
 * painted `--orange-ink` (#C2410C). Neither is the colour the product uses to
 * mean "high / attention" — that is the Notifications card, which paints
 * `--orange-500`.
 *
 * Measured on the OPENED dialog, because both halves are only reachable there
 * and a class name is not a colour.
 */

import { expect, test } from "@playwright/test";

import { openSettings } from "./_fixtures";

const REFERENCE_ORANGE = "rgb(234, 88, 12)";

test("the sign-out confirmation's icon and action are the reference orange", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openSettings(page, "org-owner");
  await page.getByRole("button", { name: "Security", exact: true }).first().click();

  const trigger = page.getByRole("button", { name: "Sign out other sessions" }).first();
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await expect(page.locator("[data-confirm-action-title]")).toBeVisible();

  const modal = await page.evaluate(() => {
    const icon = document.querySelector<HTMLElement>("[data-confirm-action-tone-icon]")!;
    const submit = document.querySelector<HTMLElement>("[data-confirm-action-submit]")!;
    const cancel = document.querySelector<HTMLElement>("[data-confirm-action-cancel]")!;
    const title = document.querySelector<HTMLElement>("[data-confirm-action-title]")!;
    return {
      title: title.textContent?.trim(),
      iconTone: icon.getAttribute("data-confirm-action-tone-icon"),
      iconColor: getComputedStyle(icon).color,
      submitLabel: submit.textContent?.trim(),
      submitBg: getComputedStyle(submit).backgroundColor,
      submitColor: getComputedStyle(submit).color,
      cancelBg: getComputedStyle(cancel).backgroundColor,
      cancelColor: getComputedStyle(cancel).color,
    };
  });

  expect(modal.title).toBe("Sign out other sessions?");
  expect(modal.iconTone).toBe("warning");

  // Both halves, one authority.
  expect(modal.iconColor, "the caution glyph").toBe(REFERENCE_ORANGE);
  expect(modal.submitBg, "the action").toBe(REFERENCE_ORANGE);
  expect(modal.submitColor).toBe("rgb(255, 255, 255)");

  // The retired browns, explicitly absent.
  for (const gone of ["rgb(168, 95, 18)", "rgb(194, 65, 12)", "rgb(180, 83, 9)"]) {
    expect(modal.iconColor).not.toBe(gone);
    expect(modal.submitBg).not.toBe(gone);
  }

  // Cancel stays neutral — a warning confirmation with two coloured buttons
  // is a confirmation with no recommended answer.
  expect(modal.cancelBg).toBe("rgb(255, 255, 255)");
  expect(modal.cancelColor).not.toBe(REFERENCE_ORANGE);
});
