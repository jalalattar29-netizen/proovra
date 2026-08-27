import { test, expect } from "@playwright/test";
import { openOperations } from "./_fixtures";
const popup = ".app-listbox__popup";

test("outside clicks close the commitment dropdown", async ({ page }) => {
  await openOperations(page, "team-admin");
  const sla = page.getByRole("combobox", { name: "Filter by time commitment" });

  await sla.click();
  await page.waitForSelector(popup);

  // The container matches its trigger and is wider than the menu; the empty
  // part must not be a click target, and what is underneath must be reachable.
  const probe = await page.evaluate(() => {
    const ov = document.querySelector(".app-anchored-overlay") as HTMLElement;
    const pop = document.querySelector(".app-listbox__popup") as HTMLElement;
    const ob = ov.getBoundingClientRect();
    const pb = pop.getBoundingClientRect();
    // A point inside the container but well past the menu's right edge.
    const x = Math.min(pb.right + 60, ob.right - 4);
    const y = pb.top + 20;
    const hit = document.elementFromPoint(x, y);
    return {
      pointerEvents: getComputedStyle(ov).pointerEvents,
      bandExists: ob.width > pb.width + 20,
      hitIsOverlay: ov.contains(hit),
    };
  });
  expect(probe.bandExists, "the container is wider than its menu").toBe(true);
  expect(probe.pointerEvents, "the container must not take clicks").toBe("none");
  expect(probe.hitIsOverlay, "a click beside the menu must reach the page").toBe(false);

  await page.mouse.click(5, 400);
  await expect(page.locator(popup), "empty space").toHaveCount(0);

});
