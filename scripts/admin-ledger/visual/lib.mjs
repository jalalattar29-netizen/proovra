/** Shared driver for the Phase 7 visual probes. Mirrors admin-visual-review's
 *  consent handling, which is the part that otherwise eats every run. */
import { chromium } from "@playwright/test";

export const WEB = process.env.P7_WEB ?? "http://localhost:3315";
const PASSWORD = "fixture-local-only-password";

export async function open({ width = 1440, height = 900, rtl = false } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width, height },
    locale: rtl ? "ar" : "en-US",
  });
  await ctx.addInitScript(() => {
    try {
      window.localStorage.setItem(
        "proovra-cookie-consent-state",
        JSON.stringify({
          necessary: true, preferences: false, analytics: false,
          marketing: false, consentVersion: 1,
          updatedAt: new Date().toISOString(),
        }),
      );
    } catch {}
  });
  const page = await ctx.newPage();
  return { browser, ctx, page };
}

export async function strip(page) {
  return page.evaluate(() => {
    let n = 0;
    for (const el of document.querySelectorAll('#cc-main, [class*="cc--"]')) {
      el.remove(); n += 1;
    }
    for (const el of document.body.querySelectorAll("div,section,aside")) {
      if (getComputedStyle(el).position !== "fixed") continue;
      if (!/Privacy Preferences|Cookie Policy/.test(el.textContent ?? "")) continue;
      el.remove(); n += 1;
    }
    return n;
  });
}

export async function signIn(page, who = "platform-admin@fixture.local") {
  await page.goto(`${WEB}/login`, { waitUntil: "networkidle", timeout: 90_000 });
  await strip(page);
  const email = page.locator('input[type="email"]:visible').first();
  const pass = page.locator('input[type="password"]:visible').first();
  for (let i = 1; i <= 3; i += 1) {
    await email.fill(who);
    await pass.fill(PASSWORD);
    if ((await email.inputValue()) === who) break;
    await page.waitForTimeout(800);
  }
  // Consent checkboxes, then ENTER. Clicking the submit button does not
  // navigate in this fixture (recorded in the admin-cp closure notes); the
  // form submit handler is what actually fires.
  const boxes = page.locator('input[type="checkbox"]:visible');
  for (let i = 0; i < (await boxes.count()); i += 1) {
    await boxes.nth(i).check().catch(() => {});
  }
  await pass.press("Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 });
}

/**
 * NAVIGATE AND WAIT FOR THE DATA, NOT JUST FOR THE DOCUMENT.
 *
 * A fixed timeout is a race against the slowest page, and losing it does not
 * under-report — it produces a confident wrong answer. The contrast sweep
 * measured /admin/platform-health with `samples: 0` and printed
 * "AA-fail=0", which reads as a pass and means "nothing was on screen": that
 * page fans out to the runtime-readiness, signer, queue, observability and
 * provider probes and they are cold on a freshly seeded fixture.
 *
 * networkidle first with a ceiling, then a floor for the render that follows
 * the last response. A page that never goes idle (a poll, a live connection)
 * falls through to the floor rather than hanging.
 */
export async function visit(page, route, wait = 2500) {
  await page.goto(`${WEB}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(wait);
  await strip(page);
}
