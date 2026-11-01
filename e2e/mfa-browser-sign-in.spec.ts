/**
 * RT-006 — A PERSON WITH AN AUTHENTICATOR APP SIGNS IN THROUGH THE BROWSER.
 *
 * Nothing is mocked. The factor is enrolled through the product routes, and the
 * test acts as the user's phone. The API-level proofs could not catch the
 * defect, because they carry the pending token in the body and the browser
 * carries it only in an HTTP-only cookie.
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";

import { computeTotpCode, decodeBase32, timeStep, TOTP_DIGITS, TOTP_PERIOD_SECONDS } from "../services/api/src/services/security/mfa-totp";
import { SESSION_PASSWORD, clearTestRateLimits, createGuestSession, disposeSession, type GuestSession } from "./helpers/api-client";
import { answerCookieBanner } from "./helpers/consent";

const PENDING_COOKIE = "proovra_mfa_pending";

/** The code the phone would show `stepOffset` steps from now. */
function totpCode(secretBase32: string, stepOffset = 0): string {
  const step = timeStep(Math.floor(Date.now() / 1000), TOTP_PERIOD_SECONDS);
  return computeTotpCode(decodeBase32(secretBase32), step + stepOffset, TOTP_DIGITS);
}

/** A syntactically valid code outside the server's ±1-step window. */
function wrongTotpCode(secretBase32: string): string {
  const accepted = new Set([-1, 0, 1].map((d) => totpCode(secretBase32, d)));
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(TOTP_DIGITS, "0");
    if (!accepted.has(candidate)) return candidate;
  }
}

async function enrolAuthenticator(session: GuestSession): Promise<{ secret: string; recoveryCodes: string[] }> {
  const started = await session.api.post("/v1/identity/mfa/enroll/start", { data: { label: "e2e authenticator" } });
  expect(started.ok(), await started.text()).toBe(true);
  const { factorId, secretBase32 } = (await started.json()) as { factorId: string; secretBase32: string };
  const verified = await session.api.post("/v1/identity/mfa/enroll/verify", {
    data: { factorId, code: totpCode(secretBase32) },
  });
  expect(verified.ok(), await verified.text()).toBe(true);
  const { recoveryCodes } = (await verified.json()) as { recoveryCodes: string[] };
  return { secret: secretBase32, recoveryCodes };
}

async function submitPassword(page: Page, email: string) {
  await clearTestRateLimits();
  await answerCookieBanner(page);
  await page.goto("/login");
  await page.locator('input[placeholder="Email"]:visible').first().fill(email);
  await page.locator('input[placeholder="Password"]:visible').first().fill(SESSION_PASSWORD);
  await page.locator("input.auth-legal-checkbox:visible").first().check();
  await page.locator('[data-auth-email-cta="SIGN_IN"]:visible').first().click();
  await page.waitForURL(/\/auth\/mfa-challenge/, { timeout: 30_000 });
}

async function pendingCookie(context: BrowserContext) {
  return (await context.cookies()).find((c) => c.name === PENDING_COOKIE);
}

async function submitCode(page: Page, code: string) {
  await page.locator('input[name="code"]').fill(code);
  await page.getByRole("button", { name: "Verify and continue" }).click();
}

test.describe("MFA sign-in through the browser", () => {
  let session: GuestSession;

  test.beforeEach(async () => {
    session = await createGuestSession();
  });
  test.afterEach(async () => {
    await disposeSession(session);
  });

  test("a wrong code can be retried and a current code reaches the app", async ({ page, context }) => {
    const { secret } = await enrolAuthenticator(session);
    await submitPassword(page, session.email);

    await page.waitForLoadState("networkidle");
    expect(await pendingCookie(context), "the challenge must survive the page loading").toBeTruthy();

    await submitCode(page, wrongTotpCode(secret));
    await expect(page.locator("[data-cc-mfa-error]")).toContainText("did not match");
    expect(await pendingCookie(context), "a wrong code must leave the challenge open").toBeTruthy();

    // One step ahead: the current step may already be spent by the enrolment.
    await submitCode(page, totpCode(secret, 1));
    await page.waitForURL(/\/home/, { timeout: 30_000 });
    expect(await pendingCookie(context), "sign-in must end the challenge").toBeUndefined();
  });

  test("a recovery code reaches the app in place of the authenticator", async ({ page, context }) => {
    const { recoveryCodes } = await enrolAuthenticator(session);
    await submitPassword(page, session.email);

    await page.locator('[data-cc-mfa-toggle="use-recovery"]').click();
    await page.locator('input[name="recoveryCode"]').fill(recoveryCodes[0]!);
    await page.getByRole("button", { name: "Verify and continue" }).click();
    await page.waitForURL(/\/home/, { timeout: 30_000 });
    expect(await pendingCookie(context), "sign-in must end the challenge").toBeUndefined();
  });

  test("arriving with no challenge pending offers a fresh sign-in, not a dead form", async ({ page }) => {
    await answerCookieBanner(page);
    await page.goto("/auth/mfa-challenge");
    await page.waitForLoadState("networkidle");
    await expect(page.locator('[data-cc-mfa-state="verify"]')).toBeVisible();
    await expect(page.locator("[data-cc-mfa-error]")).toHaveCount(0);

    await submitCode(page, "123456");
    await expect(page.locator('[data-cc-mfa-state="challenge-expired"]')).toBeVisible();
    await expect(page.locator("[data-cc-mfa-restart-login]")).toHaveAttribute("href", "/login");
  });
});
