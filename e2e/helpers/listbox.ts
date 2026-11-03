import type { Locator } from "@playwright/test";

/**
 * Choose a value in an AppListbox. The popup is portaled out of the control,
 * so the option is found on the page, by the stored value it carries.
 */
export async function chooseListbox(trigger: Locator, value: string): Promise<void> {
  await trigger.click();
  await trigger.page().locator(`[role="option"][data-value="${value}"]`).click();
}
