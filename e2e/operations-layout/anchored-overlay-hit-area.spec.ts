import { test, expect } from "@playwright/test";
import { openOperations } from "./_fixtures";
const popup = ".app-listbox__popup";

test("outside clicks close the commitment dropdown", async ({ page }) => {
  await openOperations(page, "team-admin");
  const sla = page.getByRole("combobox", { name: "Filter by time commitment" });

  await sla.click();
  await page.waitForSelector(popup);

  // 2026-10-23 — the menu is never narrower than its trigger (the canonical
  // listbox fits its longest option and is at least the trigger's width), so
  // the invisible band that used to sit beside a narrow menu inside a wide
  // container is gone. What this guarded stays pinned: the container never
  // takes clicks, and the menu covers its trigger's width.
  const probe = await page.evaluate(() => {
    const ov = document.querySelector(".app-anchored-overlay") as HTMLElement;
    const pop = document.querySelector(".app-listbox__popup") as HTMLElement;
    const trig = document.querySelector('.app-listbox__trigger[aria-expanded="true"]') as HTMLElement;
    return {
      pointerEvents: getComputedStyle(ov).pointerEvents,
      menuWidth: pop.getBoundingClientRect().width,
      triggerWidth: trig.getBoundingClientRect().width,
      menuRight: pop.getBoundingClientRect().right,
      viewport: window.innerWidth,
    };
  });
  expect(probe.pointerEvents, "the container must not take clicks").toBe("none");
  expect(probe.menuWidth, "the menu is at least its trigger's width").toBeGreaterThanOrEqual(probe.triggerWidth - 1);
  expect(probe.menuRight, "the menu stays inside the viewport").toBeLessThanOrEqual(probe.viewport + 0.5);

  await page.mouse.click(5, 400);
  await expect(page.locator(popup), "empty space").toHaveCount(0);
});
