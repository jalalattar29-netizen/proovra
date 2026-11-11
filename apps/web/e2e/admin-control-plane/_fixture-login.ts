import { createHash, createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, type Page } from "@playwright/test";

/**
 * THE ONE FIXTURE SIGN-IN FOR THE ADMIN CONTROL-PLANE SUITE.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS
 * =============================================================================
 * There were EIGHT independent `signIn` helpers across nine spec files, and
 * they had drifted. `phase6-admin-journeys.spec.ts` failed in CI with
 *
 *   page.waitForURL((u) => !u.pathname.startsWith("/login")) timed out after 60s
 *
 * inside its own copy — 96 of 97 tests passed, and the one that failed was
 * using the weakest version of the same journey. Comparing it against
 * `admin-matrix.spec.ts`, whose copy carries 71 green cases, the differences
 * are not stylistic:
 *
 *   1. The fill-retry loop read back only the EMAIL. The matrix copy reads
 *      back both fields, with the comment "this is the whole point of the
 *      retry". If a re-render clears the password and leaves the email, the
 *      weak loop breaks out satisfied, submits an empty password, and the URL
 *      never leaves /login — which presents exactly as a 60s navigation
 *      timeout, and only sometimes.
 *
 *   2. It clicked `button[type="submit"]`. The matrix copy deliberately stopped
 *      doing that: at narrow widths the button reports "visible, enabled" but
 *      never "stable", because an ancestor keeps re-laying-out under it.
 *      Pressing Enter in the password field runs the same handler through the
 *      same form and does not depend on the button's geometry.
 *
 *   3. It waited for a URL change and nothing else. A 60-second wait on a
 *      navigation that will never happen cannot say WHY: a refused sign-in, a
 *      submit that never fired and a slow redirect all look identical.
 *
 * =============================================================================
 * WHAT THIS ONE DOES DIFFERENTLY
 * =============================================================================
 * It waits for the authentication RESPONSE, and it arms that wait BEFORE
 * submitting. The response is the deterministic signal; the URL change is a
 * consequence of it. Arming first also removes the race where the navigation
 * completes before the wait is registered.
 *
 * When authentication is refused, this fails immediately and says the status
 * and the stable error code, instead of spending a minute proving that a page
 * which was never going to navigate did not navigate.
 *
 * It is NOT a cookie shortcut. The real form is filled and submitted, because
 * the sign-in journey is part of what these specs exist to verify.
 */

const AUTH_PATH = "/v1/auth/email/login";
const MFA_VERIFY_PATH = "/v1/auth/mfa/verify";

/**
 * AUD-0021 — the platform administrator's authenticator secret, the same 32
 * bytes services/api/scripts/seed-admin-fixture.ts enrols (change both together).
 * Local-only: the seeder refuses non-local databases.
 */
const FIXTURE_TOTP_SECRET = Buffer.from("proovra-fixture-local-only-totp!", "utf8");
const TOTP_PERIOD_SECONDS = 30;

/** RFC 6238 (SHA-1, 6 digits, 30 s) — what the API's mfa-totp verifies. */
function totpCode(step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 0x1_0000_0000), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const hmac = createHmac("sha1", FIXTURE_TOTP_SECRET).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (binary % 1_000_000).toString().padStart(6, "0");
}

/**
 * The next code the API's replay guard accepts. It takes each time step once,
 * in increasing order, within current ±1; so a run that signs the administrator
 * in more often than every 30 s has to WAIT for a fresh step rather than replay
 * one. The last step spent is kept in a file per fixture API, because spec files
 * may run in fresh worker processes against the same database.
 */
async function nextFixtureTotpCode(apiKey: string): Promise<string> {
  const dir = join(tmpdir(), "proovra-admin-fixture-totp");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}.json`);
  let lastStep = -Infinity;
  try {
    lastStep = Number((JSON.parse(readFileSync(file, "utf8")) as { lastStep?: number }).lastStep ?? -Infinity);
  } catch {
    /* first sign-in against this fixture */
  }
  for (;;) {
    const nowSeconds = Date.now() / 1000;
    const current = Math.floor(nowSeconds / TOTP_PERIOD_SECONDS);
    // The previous step is offered only while 5 s of the current one remain, so
    // a boundary crossed in flight cannot turn a correct code into a refusal.
    const oldest = nowSeconds % TOTP_PERIOD_SECONDS < 25 ? current - 1 : current;
    const step = Math.max(lastStep + 1, oldest);
    if (step <= current) {
      writeFileSync(file, JSON.stringify({ lastStep: step }));
      return totpCode(step);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/**
 * HOW MANY REAL PASSWORD LOGINS THIS WORKER HAS PERFORMED.
 *
 * The login limiter is keyed by IP — `auth:email-login:ip:<ip>` at ten per
 * sixty seconds — and every test in the suite reaches the API as 127.0.0.1, so
 * they all share one bucket. A spec that signs in per test spends the whole
 * allowance on itself and then refuses its neighbours, which is exactly what
 * happened: two Phase-6 tests failed with HTTP 429 before reaching a single
 * product assertion.
 *
 * This counter lets a spec PROVE it authenticates once rather than asserting it
 * by counting occurrences in its own source, which would pass while the calls
 * moved into a helper.
 */
let passwordSignIns = 0;
export const passwordSignInCount = () => passwordSignIns;
export const resetPasswordSignInCount = () => {
  passwordSignIns = 0;
};

/**
 * STOP THE CONSENT BANNER INTERCEPTING THE SUBMIT BUTTON.
 *
 * Measured, at 320px: the banner overlays the login form, and the click on
 * `button[type="submit"]` was refused for thirty seconds with
 *
 *   <button class="cm__btn" data-role="all"> from <div id="cc-main"> subtree
 *   intercepts pointer events
 *
 * Clicking "Reject all" is not sufficient on its own at that width — the
 * banner is still on screen when the form is submitted. This init script runs
 * before the first paint of every navigation, so the overlay can never take a
 * pointer event, at any viewport.
 *
 * `dismissConsent` below still runs and still records the necessary-only
 * DECISION where the banner is interactive. This only removes its ability to
 * swallow clicks meant for the page underneath.
 */
async function suppressConsentOverlay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent =
      "#cc-main#cc-main{display:none!important;pointer-events:none!important}";
    const attach = () => document.head?.appendChild(style);
    if (document.head) attach();
    else document.addEventListener("DOMContentLoaded", attach, { once: true });
  });
}

/** Dismiss the consent banner if it is on screen. */
async function dismissConsent(page: Page): Promise<void> {
  const banner = page.locator("#cc-main");
  if ((await banner.count()) === 0) return;
  if (!(await banner.first().isVisible().catch(() => false))) return;
  /*
   * Declining is correct, not merely convenient: nobody consented on behalf of
   * an automated run, and necessary-only is the privacy-preserving choice.
   */
  for (const name of [/reject all/i, /decline/i, /necessary only/i]) {
    const button = banner.getByRole("button", { name });
    if (await button.count()) {
      await button.first().click({ timeout: 5_000 }).catch(() => {});
      break;
    }
  }
  await banner.first().waitFor({ state: "hidden", timeout: 8_000 }).catch(() => {});
}

/**
 * AUD-0021 — answer the sign-in's MFA challenge as the fixture platform
 * administrator would: the enrolled authenticator's current code, typed into
 * the real /auth/mfa-challenge form. Throws when the API refuses it.
 */
export async function answerFixtureMfaChallenge(page: Page, email: string, web: string): Promise<void> {
  await page.waitForURL((u) => u.pathname.startsWith("/auth/mfa-challenge"), { timeout: 30_000 });
  const codeBox = page.locator('[data-cc-mfa-input="totp"]');
  await codeBox.waitFor({ state: "visible", timeout: 30_000 });
  const apiKey = process.env.PROOVRA_FIXTURE_API_BASE ?? web;
  await codeBox.fill(await nextFixtureTotpCode(apiKey));
  const verified = page.waitForResponse(
    (r) => r.url().includes(MFA_VERIFY_PATH) && r.request().method() === "POST",
    { timeout: 30_000 },
  );
  await codeBox.press("Enter");
  const verdict = await verified;
  if (!verdict.ok()) {
    throw new Error(`the second factor for ${email} was refused: HTTP ${verdict.status()}`);
  }
}

/**
 * AUD-0021 — finish a sign-in that the API answered with the MFA challenge (a
 * platform administrator): answer it and wait to leave the challenge page. A
 * sign-in that was not challenged (every other fixture account) is untouched.
 */
export async function settleFixtureSignIn(page: Page, email: string, web: string): Promise<void> {
  if (!new URL(page.url()).pathname.startsWith("/auth/mfa-challenge")) return;
  await answerFixtureMfaChallenge(page, email, web);
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/mfa-challenge"), { timeout: 60_000 });
}

export type FixtureLoginOptions = {
  /** Base URL of the fixture web tier. */
  web: string;
  /** The fixture password. Never logged. */
  password: string;
  /** Where the caller expects to land; defaults to "anywhere but /login". */
  expectPath?: (pathname: string) => boolean;
};

/**
 * Sign in through the real form and prove the session was actually issued.
 *
 * Throws with the HTTP status and the API's stable error code when the sign-in
 * is refused, so a failing test names the reason on its first line.
 */
export async function signInAsFixtureUser(
  page: Page,
  email: string,
  { web, password, expectPath }: FixtureLoginOptions,
): Promise<void> {
  // Before the first navigation: the overlay must never be able to take a
  // pointer event meant for the form.
  passwordSignIns += 1;
  await suppressConsentOverlay(page);
  await page.goto(`${web}/login`, { waitUntil: "networkidle", timeout: 90_000 });
  await dismissConsent(page);

  const emailBox = page.locator('input[type="email"]:visible').first();
  const passwordBox = page.locator('input[type="password"]:visible').first();

  // The form has to be ready before it can be filled, and "ready" means the
  // fields are actually present — not that the network happened to go quiet.
  await emailBox.waitFor({ state: "visible", timeout: 30_000 });
  await passwordBox.waitFor({ state: "visible", timeout: 30_000 });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await emailBox.fill(email);
    await passwordBox.fill(password);

    const terms = page.locator('input[type="checkbox"]:visible');
    const count = await terms.count();
    for (let i = 0; i < count; i += 1) await terms.nth(i).check().catch(() => {});

    // BOTH fields, every time. Reading back only the email is what let an
    // empty password reach the submit handler.
    if (
      (await emailBox.inputValue()) === email &&
      (await passwordBox.inputValue()) === password
    ) {
      break;
    }
    if (attempt === 3) {
      throw new Error(
        "the login form kept clearing itself — something is re-rendering it after fill",
      );
    }
    await page.waitForTimeout(1_000);
  }

  /*
   * Submit, with the wait ARMED FIRST so a fast response cannot be missed.
   *
   * One EFFECTIVE submit: the second attempt runs only when the first produced
   * no authentication request at all, which is measured rather than assumed —
   * the armed wait is what tells us. That is not a retry of a submitted login;
   * it is a second way of pressing the same button when the first did nothing.
   */
  const submitAndAwaitAuth = async (
    action: () => Promise<void>,
    timeout: number,
  ) => {
    const pending = page.waitForResponse(
      (r) => r.url().includes(AUTH_PATH) && r.request().method() === "POST",
      { timeout },
    );
    await action();
    return await pending.catch(() => null);
  };

  /*
   * Enter first, pointer second, and BOTH are needed — measured, not preferred.
   *
   * Enter in the password field runs the same handler through the same form and
   * does not depend on the button's geometry, which is why the matrix specs
   * adopted it: at narrow widths the button reports "visible, enabled" but never
   * "stable" and the click times out.
   *
   * But Enter alone is not sufficient either. With this helper submitting by
   * Enter only, "navigation holds at a phone width" — which sets a 320px
   * viewport before signing in — failed with "never sent /v1/auth/email/login".
   * At that width the form does not submit on Enter. Each mechanism covers the
   * case the other misses.
   */
  let response = await submitAndAwaitAuth(
    () => passwordBox.press("Enter"),
    15_000,
  );

  if (response === null) {
    const submit = page.locator('button[type="submit"]:visible').first();
    await submit.scrollIntoViewIfNeeded().catch(() => {});
    response = await submitAndAwaitAuth(
      () => submit.click({ timeout: 30_000 }),
      45_000,
    );
  }

  if (response === null) {
    throw new Error(
      `sign-in for ${email} never sent ${AUTH_PATH} by keyboard or pointer. ` +
        "The form did not submit; this is not a slow redirect.",
    );
  }

  if (!response.ok()) {
    // Surface the API's own stable code. Never the payload, which carries the
    // submitted credentials.
    let code = "(no code in body)";
    try {
      const body = (await response.json()) as { error?: { code?: string } };
      code = body?.error?.code ?? code;
    } catch {
      /* non-JSON refusal */
    }
    throw new Error(
      `sign-in for ${email} was refused: HTTP ${response.status()} ${code}`,
    );
  }

  /*
   * AUD-0021 — a platform administrator's password is only the first step: the
   * API answers with an MFA challenge and the page moves to
   * /auth/mfa-challenge. Answer it the way the administrator would, with the
   * enrolled authenticator's code typed into the real form.
   */
  const answer = (await response.json().catch(() => null)) as { mfaRequired?: boolean } | null;
  if (answer?.mfaRequired === true) {
    await answerFixtureMfaChallenge(page, email, web);
  }

  // Only now is a navigation actually owed to us.
  const landed = expectPath ?? ((pathname: string) => !pathname.startsWith("/login"));
  await page.waitForURL((u) => landed(u.pathname), { timeout: 30_000 });

  // The session has to survive the navigation, not merely have been issued.
  expect(
    new URL(page.url()).pathname.startsWith("/login"),
    "authentication succeeded but the browser bounced back to /login",
  ).toBe(false);
}
