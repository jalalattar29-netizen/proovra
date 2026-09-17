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

/**
 * What the page is showing, decided from the PRODUCT'S OWN markers.
 *
 * An earlier version read free text and mislabelled pages: the single sign-on
 * page contains the words "Sign in", and an identity panel contains "not
 * found", so both were scored as denials when they had rendered fine. The
 * product marks its own states — `data-system-state-kind` on the shared state
 * component, `data-page-route-gate-state` on the canonical gate — and those
 * are what this reads. Free text is now only a fallback, and it says so.
 */
async function classify(page) {
  return page.evaluate(() => {
    const text = document.body.innerText ?? "";
    const url = window.location.pathname;
    const gate = document.querySelector("[data-page-route-gate-state]");
    const systemState = document.querySelector("[data-system-state-kind]");
    const kind = systemState?.getAttribute("data-system-state-kind") ?? null;
    const gateState = gate?.getAttribute("data-page-route-gate-state") ?? null;

    let state;
    let decidedBy;
    if (url.startsWith("/login")) {
      state = "REDIRECTED_TO_LOGIN";
      decidedBy = "URL";
    } else if (gateState) {
      state = `GATE_${gateState}`;
      decidedBy = "data-page-route-gate-state";
    } else if (kind === "not-found") {
      state = "NOT_FOUND";
      decidedBy = "data-system-state-kind";
    } else if (kind === "error" || /ERROR\s*[·.]\s*5\d\d|Something went wrong on our end/i.test(text)) {
      state = "ERROR_BOUNDARY_5XX";
      decidedBy = kind ? "data-system-state-kind" : "TEXT_FALLBACK";
    } else if (kind === "forbidden" || kind === "upgrade") {
      state = "REFUSED_OR_UPGRADE";
      decidedBy = "data-system-state-kind";
    } else if (kind) {
      state = `SYSTEM_STATE_${kind.toUpperCase()}`;
      decidedBy = "data-system-state-kind";
    } else if (/Could not load|Unable to load|failed to load|try again in a moment/i.test(text)) {
      state = "READ_FAILURE_STATED";
      decidedBy = "TEXT_FALLBACK";
    } else {
      state = "CONTENT_OR_EMPTY";
      decidedBy = "NO_STATE_MARKER";
    }
    return {
      state,
      decidedBy,
      systemStateKind: kind,
      gateState,
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
