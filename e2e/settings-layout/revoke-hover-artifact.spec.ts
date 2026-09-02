/**
 * THE WHITE RECTANGLE BEHIND A HOVERED LABEL.
 *
 * `[data-cc-revoke-others]` and `[data-cc-revoke-others] *` both painted
 * `--set-panel-solid` (#ffffff). At rest they agree and nothing shows. On hover
 * only the BUTTON repaints, so the label span kept its own opaque white and sat
 * on top of the hover tint — a white strip exactly the width of the text.
 *
 * A class name cannot show that. This hovers the real control and reads what
 * the child actually paints.
 */

import { expect, test } from "@playwright/test";

import { openSettings } from "./_fixtures";

test("no child of the sign-out button paints its own background on hover", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openSettings(page, "org-owner");
  await page.getByRole("button", { name: "Security", exact: true }).first().click();

  const button = page.locator("[data-cc-revoke-others]").first();
  await button.scrollIntoViewIfNeeded();

  const read = () =>
    button.evaluate((el: HTMLElement) => {
      const self = getComputedStyle(el);
      const children = Array.from(el.querySelectorAll<HTMLElement>("*")).map((c) => ({
        tag: c.tagName,
        bg: getComputedStyle(c).backgroundColor,
      }));
      return { buttonBg: self.backgroundColor, children };
    });

  const rest = await read();
  await button.hover();
  await page.waitForTimeout(250);
  const hovered = await read();

  // The button is the only thing that paints, and hovering changes it.
  expect(hovered.buttonBg).not.toBe(rest.buttonBg);

  // NOTHING inside it has a background, in either state. An opaque child is
  // the artifact, and it is invisible until the parent moves underneath it.
  for (const state of [rest, hovered]) {
    for (const child of state.children) {
      expect(
        child.bg,
        `a ${child.tag} inside the button paints ${child.bg}`,
      ).toBe("rgba(0, 0, 0, 0)");
    }
  }

  // Focus is still visible — the artifact is not fixed by removing states.
  await button.focus();
  const focused = await button.evaluate((el: HTMLElement) => {
    const cs = getComputedStyle(el);
    return { outline: cs.outlineStyle, shadow: cs.boxShadow };
  });
  expect(
    focused.outline !== "none" || focused.shadow !== "none",
    "a keyboard user must still see where they are",
  ).toBe(true);
});
