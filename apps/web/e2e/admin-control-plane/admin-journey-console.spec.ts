/**
 * THE SIGN-IN → HOME → ADMIN JOURNEY LOGS NOTHING.
 *
 * =============================================================================
 * WHY A WHOLE-JOURNEY CONSOLE GATE EXISTS
 * =============================================================================
 * The route-by-route matrix resets its console capture per page, so a warning
 * that fires exactly once — on the authenticated shell's FIRST mount, during
 * the login transition — landed between its samples and survived every sweep.
 * That is how "Each child in a list should have a unique key prop" rode along
 * on every operator's first paint: the shell received the Flight-deserialized
 * route child and the assistant widget as an unkeyed pair, React 19's
 * reconciler-level key check (which the per-element `validated` mark from the
 * jsx runtime does not cover for Flight elements) warned once per mount, and
 * nothing was listening at that moment.
 *
 * This spec listens across the WHOLE journey: submit the login form, land on
 * the post-login surface, let it settle, then enter /admin — one capture,
 * zero tolerated errors. No excusal list: on this path, with a seeded
 * fixture and a signed-in platform admin, there is nothing a browser should
 * be logging as an error at all.
 *
 * Prerequisites (it FAILS rather than skips without them):
 *   node services/api/scripts/dev-admin-fixture-api.mjs
 *   node apps/web/scripts/dev-admin-fixture.mjs
 *
 * Run:
 *   pnpm exec playwright test admin-journey-console --config apps/web/e2e/admin-control-plane/playwright.config.ts
 */

import { expect, test, type BrowserContext } from "@playwright/test";

import { CONSENT_VERSION } from "../../lib/consent";

const WEB = process.env.PROOVRA_FIXTURE_WEB_BASE ?? "http://localhost:3311";
const PASSWORD = "fixture-local-only-password";
const ADMIN = "platform-admin@fixture.local";

/** The consent banner, neutralised the way the sibling specs do it. */
async function seedConsent(context: BrowserContext) {
  await context.addInitScript(
    ({ key, version }) => {
      try {
        window.localStorage.setItem(
          key,
          JSON.stringify({
            necessary: true,
            preferences: false,
            analytics: false,
            marketing: false,
            consentVersion: version,
            updatedAt: new Date().toISOString(),
          }),
        );
      } catch {
        /* storage disabled — the style rule below still removes the overlay */
      }
    },
    { key: "proovra-cookie-consent-state", version: CONSENT_VERSION },
  );
  await context.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = "#cc-main{display:none!important;pointer-events:none!important}";
    const attach = () => document.head?.appendChild(style);
    if (document.head) attach();
    else document.addEventListener("DOMContentLoaded", attach, { once: true });
  });
}

test("sign-in through home into /admin produces zero console errors", async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await seedConsent(context);
  const page = await context.newPage();

  const journeyErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") journeyErrors.push(`[${page.url()}] ${m.text().slice(0, 240)}`);
  });
  page.on("pageerror", (e) => journeyErrors.push(`[pageerror ${page.url()}] ${e.message.slice(0, 240)}`));

  await page.goto(`${WEB}/login`, { waitUntil: "networkidle", timeout: 90_000 });
  const email = page.locator('input[type="email"]:visible').first();
  const pass = page.locator('input[type="password"]:visible').first();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await email.fill(ADMIN);
    await pass.fill(PASSWORD);
    const boxes = page.locator('input[type="checkbox"]:visible');
    for (let i = 0; i < (await boxes.count()); i += 1) {
      await boxes.nth(i).check().catch(() => {});
    }
    if ((await email.inputValue()) === ADMIN) break;
    if (attempt === 3) throw new Error("the login form kept clearing itself");
    await page.waitForTimeout(1_000);
  }

  // The journey under test starts at SUBMIT. What an unauthenticated login
  // page logs while probing session state is the login page's own business,
  // measured elsewhere; this gate is about what an operator's first signed-in
  // minutes print.
  journeyErrors.length = 0;
  await pass.press("Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 });

  // Let the post-login surface settle completely — the shell's first mount is
  // exactly where the unkeyed-pair warning used to fire, once, and a capture
  // that leaves too early recreates the blind spot this spec closes.
  await page.locator("h1:visible").first().waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(6_000);

  await page.goto(`${WEB}/admin`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.locator("h1:visible").first().waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(4_000);

  expect(
    journeyErrors,
    `the sign-in → home → /admin journey logged:\n${journeyErrors.join("\n")}`,
  ).toEqual([]);

  await context.close();
});
