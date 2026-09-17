/**
 * PHASE UI-TRUTH — signed-in browser probe (AUDIT HARNESS).
 *
 * Opens real surfaces in a real browser, signed in as a fixture persona
 * against the disposable loopback stack, and records what the page ACTUALLY
 * shows: the error boundary, an empty state, a refusal, or content. This is
 * the only way to tell "the read failed and the page said nothing" from "the
 * page is fine", which no amount of source reading settles.
 *
 * SAFETY: refuses to run unless both the web and API origins are loopback.
 *
 * Usage: node audit/ui-truth/harness/browser-probe.mjs <persona> <route...>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

import { REPO } from "./surfaces.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(join(REPO, "node_modules", "@playwright", "test"));

const WEB = process.env.UIT_WEB ?? "http://127.0.0.1:3951";
const API = process.env.UIT_API ?? "http://127.0.0.1:8931";
for (const origin of [WEB, API]) {
  const host = new URL(origin).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    console.error(`REFUSED — ${origin} is not loopback. Nothing was opened.`);
    process.exit(2);
  }
}

const PASSWORD = "fixture-local-only-password";
const [, , personaArg, ...routeArgs] = process.argv;
const persona = personaArg ?? "org-owner";
const routes =
  routeArgs.length > 0
    ? routeArgs
    : JSON.parse(readFileSync(join(REPO, "audit", "ui-truth", "data", "browser-probe-routes.json"), "utf8")).routes;

/** What the page is showing, decided from the DOM the user would see. */
async function classify(page) {
  return page.evaluate(() => {
    const text = document.body.innerText ?? "";
    const has = (re) => re.test(text);
    const state = has(/ERROR\s*[·.]\s*5\d\d|Something went wrong on our end/i)
      ? "ERROR_BOUNDARY_5XX"
      : has(/ERROR\s*[·.]\s*4\d\d|not found|Page not found/i)
        ? "NOT_FOUND"
        : has(/Sign in|Log in to PROOVRA/i)
          ? "REDIRECTED_TO_LOGIN"
          : has(/not available for this workspace|Platform admin elevation|requires an organization|Upgrade|Enterprise agreement/i)
            ? "REFUSED_OR_UPGRADE"
            : has(/Could not load|Unable to load|failed to load|try again in a moment/i)
              ? "READ_FAILURE_STATED"
              : has(/No .{0,40}(yet|found)|nothing here|Nothing to show|is empty/i)
                ? "EMPTY_STATE"
                : "CONTENT";
    return {
      state,
      h1Count: document.querySelectorAll("h1").length,
      firstH1: document.querySelector("h1")?.textContent?.trim() ?? null,
      mainLandmarks: document.querySelectorAll("main").length,
      excerpt: text.replace(/\s+/g, " ").slice(0, 220),
    };
  });
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});
const failedRequests = [];
page.on("response", (r) => {
  if (r.status() >= 400 && r.url().includes("/v1/")) {
    failedRequests.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
  }
});

await page.goto(`${WEB}/login`, { waitUntil: "networkidle", timeout: 90_000 });
// The consent overlay must not be able to take a pointer event meant for the
// form; answer it the privacy-preserving way first, as _fixture-login does.
const reject = page.locator('#cc-main').getByRole("button", { name: /Reject all/i });
if (await reject.count()) await reject.first().click({ timeout: 10_000 }).catch(() => {});
const emailBox = page.locator('input[type="email"]:visible').first();
const passwordBox = page.locator('input[type="password"]:visible').first();
await emailBox.waitFor({ state: "visible", timeout: 30_000 });
await emailBox.fill(`${persona}@fixture.local`);
await passwordBox.fill(PASSWORD);
const terms = page.locator('input[type="checkbox"]:visible');
const termsCount = await terms.count();
for (let i = 0; i < termsCount; i += 1) await terms.nth(i).check().catch(() => {});
const authed = page.waitForResponse((r) => r.url().includes("/v1/auth/email/login") && r.request().method() === "POST", { timeout: 60_000 });
await passwordBox.press("Enter");
await authed.catch(() => null);
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 });

const rows = [];
for (const route of routes) {
  consoleErrors.length = 0;
  failedRequests.length = 0;
  const started = Date.now();
  let navError = null;
  try {
    await page.goto(`${WEB}${route}`, { waitUntil: "networkidle", timeout: 45_000 });
  } catch (err) {
    navError = String(err).slice(0, 160);
  }
  await page.waitForTimeout(1200);
  const observed = await classify(page);
  rows.push({
    route,
    persona,
    ...observed,
    navError,
    ms: Date.now() - started,
    failedApiRequests: [...new Set(failedRequests)].sort(),
    consoleErrors: [...new Set(consoleErrors)].slice(0, 5),
  });
  console.log(`${observed.state.padEnd(22)} ${route}`);
}

await browser.close();

const byState = {};
for (const r of rows) byState[r.state] = (byState[r.state] ?? 0) + 1;
const out = join(REPO, "audit", "ui-truth", "data", `browser-probe-${persona}.json`);
writeFileSync(
  out,
  JSON.stringify(
    { artifact: "ui-truth/browser-probe", schemaVersion: 1, persona, web: "loopback", totals: { routes: rows.length, byState }, rows },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(byState, null, 2));
