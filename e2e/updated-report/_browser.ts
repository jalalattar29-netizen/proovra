import type { Page } from "@playwright/test";

import { SESSION_PASSWORD, clearTestRateLimits } from "../helpers/api-client";

export async function signIn(page: Page, email: string) {
  await clearTestRateLimits();
  await page.goto("/login");
  await page.locator('input[placeholder="Email"]:visible').first().fill(email);
  await page.locator('input[placeholder="Password"]:visible').first().fill(SESSION_PASSWORD);
  await page.locator("input.auth-legal-checkbox:visible").first().check();
  await page.locator('[data-auth-email-cta="SIGN_IN"]:visible').first().click();
  await page.waitForURL(/\/home/, { timeout: 60_000 });
}

export async function openArtifacts(page: Page, evidenceId: string) {
  await page.goto(`/evidence/${evidenceId}`);
  await page.waitForSelector(".evidence-detail-hero", { timeout: 60_000 });
  await page.getByRole("tab", { name: "Artifacts" }).click();
  await page.waitForSelector("[data-testid='artifact-truth-header']", { timeout: 60_000 });
}

/** Open the updated-report dialog and wait until it has loaded the current offer. */
export async function openUpdatedReportDialog(page: Page) {
  await page.getByTestId("evidence-new-version").click();
  const dialog = page.getByTestId("updated-report-dialog");
  await dialog.waitFor();
  await page.waitForFunction(() => {
    const d = document.querySelector("[data-testid='updated-report-dialog']");
    return d != null && d.getAttribute("aria-busy") == null;
  });
  return dialog;
}
