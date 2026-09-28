/**
 * BILLING ACTIVITY (2026-09-28) — the incident account, rendered in a browser.
 *
 * Two PayPal 50 GB storage attempts that never completed, and no payment.
 * Before: the Storage card listed both as "pending", with raw PayPal ids,
 * while Billing history said "No payments yet" and nothing connected the two.
 * The account re-check could call such attempts "still settling".
 *
 * Pinned here in a real browser, at desktop and phone width:
 *   - Billing activity lists both, with product, provider, amount, date, the
 *     provider's last answer and why no payment exists — and no provider id;
 *   - the Storage card does not list them as storage;
 *   - "Re-check purchases and billing" reports what was checked and never says
 *     "settling" or "pending" for a 404;
 *   - "Abandon" is confirmed first and states it cancels nothing at PayPal;
 *   - nothing overflows horizontally at 390px.
 *
 * The API is answered in-process with the SERVER's own DTO shapes; this proves
 * the page, not the provider.
 */

import { expect, test, type Page } from "@playwright/test";

import { installBillingApi } from "./_fixtures";

const ATTEMPT_1 = "a2cc1107-cf53-4b74-9cda-9a93dcbe6555";
const ATTEMPT_2 = "b5c641a3-4e54-45a5-9743-a9627189ec1e";

const attempt = (id: string, createdAtUtc: string) => ({
  id,
  product: "STORAGE",
  description: "+50 GB storage add-on",
  providerLabel: "PayPal",
  createdAtUtc,
  state: "PROVIDER_NO_RECORD",
  statusLabel: "No record at PayPal",
  explanation:
    "PayPal no longer has a record of this checkout, and it was never approved through PROOVRA. It has not produced a payment, so it is not in your payment history, and nothing has been added to your account.",
  recurring: true,
  lastCheckedAtUtc: "2026-09-28T09:00:00.000Z",
  amountCents: 799,
  currency: "EUR",
  actions: { canRecheck: true, canAbandon: true },
});

async function openIncidentBilling(page: Page) {
  const posts: Array<{ path: string; body: string | null }> = [];
  await installBillingApi(page);
  // Registered AFTER the shared fixture, so these win for their paths.
  await page.route("**/v1/billing/accounts/*/*/history**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [],
        count: 0,
        activity: [
          attempt(ATTEMPT_2, "2026-09-26T15:01:24.000Z"),
          attempt(ATTEMPT_1, "2026-09-26T09:46:37.000Z"),
        ],
      }),
    }),
  );
  await page.route("**/v1/billing/accounts/*/*/reconcile", (route) => {
    posts.push({ path: new URL(route.request().url()).pathname, body: route.request().postData() });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "ACTION_REQUIRED",
        summary: {
          checked: 2, creditsRestored: 0, paymentsRecorded: 0, subscriptionsUpdated: 0,
          pending: 0, actionRequired: 2, unavailable: 0, discrepancies: 0, attemptsUpdated: 0,
          storageAttempts: [],
          attempts: [ATTEMPT_1, ATTEMPT_2].map((attemptId) => ({
            attemptId, product: "STORAGE", createdAtUtc: "2026-09-26T09:46:37.000Z", provider: "PAYPAL",
            providerBound: true, previousStatus: "PENDING", currentStatus: "PENDING",
            outcome: "PROVIDER_REFERENCE_NOT_FOUND", locallyAbandoned: false,
          })),
        },
      }),
    });
  });
  await page.route("**/v1/billing/accounts/*/*/checkout-attempts/*/abandon", (route) => {
    const body = route.request().postData() ?? "{}";
    posts.push({ path: new URL(route.request().url()).pathname, body });
    const confirmed = JSON.parse(body).confirmed === true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        confirmed
          ? { attemptId: ATTEMPT_1, outcome: "ABANDONED", cancelsAtProvider: false }
          : {
              attemptId: ATTEMPT_1,
              outcome: "ABANDON_CONFIRMATION_REQUIRED",
              cancelsAtProvider: false,
              warning:
                "PayPal no longer has a record of this checkout. It was not approved through PROOVRA. Abandoning only removes it from PROOVRA's open purchases so you can start again. It does not cancel, reverse or refund anything at PayPal.",
            },
      ),
    });
  });
  await page.goto("/billing");
  await page.waitForSelector("[data-billing-layout]", { timeout: 30_000 });
  await page.waitForSelector("[data-billing-activity]", { timeout: 30_000 });
  // The consent banner is not under test and covers the lower half at 390px.
  const reject = page.getByRole("button", { name: "Reject all" });
  if (await reject.isVisible().catch(() => false)) await reject.click();
  return posts;
}

for (const viewport of [
  { name: "desktop-1440", width: 1440, height: 1000 },
  { name: "mobile-390", width: 390, height: 844 },
]) {
  test.describe(`billing activity — incident account at ${viewport.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test("both attempts are explained in Billing activity, without provider ids, and fit the screen", async ({ page }) => {
      await openIncidentBilling(page);
      const items = page.locator("[data-billing-activity-item]");
      await expect(items).toHaveCount(2);
      await expect(page.locator("[data-billing-activity]")).toContainText("No record at PayPal");
      await expect(page.locator("[data-billing-activity]")).toContainText("not in your payment history");
      await expect(page.locator("[data-billing-history]")).toContainText("No payments yet");
      const text = (await page.locator("body").innerText()) ?? "";
      expect(text).not.toMatch(/I-4P6XLPVJEMBK|I-X3KCTML39FWX|SA-A2CC1107/);
      // Not listed as storage capacity.
      await expect(page.locator('[data-billing-addon="PERSONAL_50_GB"]')).toHaveCount(0);
      // No horizontal page scroll, and no activity row wider than its list.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const clipped = await page.evaluate(() => {
        const list = document.querySelector("[data-billing-activity-list]")!.getBoundingClientRect();
        return Array.from(document.querySelectorAll("[data-billing-activity-item], [data-billing-activity-item] *"))
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.right > list.right + 1).length;
      });
      expect(clipped, "activity content must stay inside its list").toBe(0);
      await page.locator("[data-billing-activity]").screenshot({
        path: `test-results/billing-activity-${viewport.name}.png`,
      });
    });

    test("the account re-check says what it found, never 'settling' or 'pending' for a 404", async ({ page }) => {
      const posts = await openIncidentBilling(page);
      await page.locator("[data-billing-recheck]").click();
      const toast = page.getByText(/Checked 2 items with your payment provider/);
      await expect(toast).toBeVisible();
      const message = await toast.innerText();
      expect(message).toContain("2 purchases could not be confirmed by the provider");
      expect(message).not.toMatch(/settling|pending/i);
      expect(posts.map((p) => p.path)).toContain("/v1/billing/accounts/PERSONAL/user-1/reconcile");
    });

    test("abandon is confirmed first and says it cancels nothing at PayPal", async ({ page }) => {
      const posts = await openIncidentBilling(page);
      await page.locator(`[data-billing-activity-abandon="${ATTEMPT_1}"]`).click();
      const dialog = page.getByRole("dialog", { name: /Abandon this purchase\?/ });
      await expect(dialog).toContainText("does not cancel, reverse or refund anything at PayPal");
      expect(posts.filter((p) => p.path.endsWith("/abandon"))).toHaveLength(1);
      expect(JSON.parse(posts[0]!.body!).confirmed).toBe(false);
      await dialog.getByRole("button", { name: "Abandon in PROOVRA" }).click();
      await expect(page.getByText(/Nothing was cancelled or charged at the payment provider/)).toBeVisible();
      const abandonPosts = posts.filter((p) => p.path.endsWith("/abandon"));
      expect(abandonPosts).toHaveLength(2);
      expect(JSON.parse(abandonPosts[1]!.body!).confirmed).toBe(true);
    });
  });
}
