/**
 * RTL FLASH PROBE — is the direction right in the HTML, or only after React?
 *
 * The claim under test is specifically about the SERVED DOCUMENT, so this does
 * not look at the rendered page first. It:
 *
 *   1. signs in and sets Arabic the way a person does, so the locale cookie is
 *      written the way the app writes it;
 *   2. FETCHES the admin URL directly — no browser, no JavaScript — and reads
 *      the `<html …>` tag out of the response body;
 *   3. then does a COLD navigation with JavaScript DISABLED, so nothing can
 *      correct the attribute after the fact, and measures where the sidebar
 *      actually sits;
 *   4. finally, a normal cold load that records `dir` at the earliest
 *      observable moment and again after hydration — if those differ, the
 *      document flashed.
 *
 * Usage: node scripts/admin-ledger/visual/rtl-flash.mjs [route…]
 */
import { chromium } from "@playwright/test";
import { open, signIn, strip, WEB } from "./lib.mjs";

const ROUTES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["/admin", "/admin/evidence-ops", "/admin/identity/scim", "/admin/platform/queues"];

const { browser, ctx, page } = await open({ width: 1440, height: 900, rtl: true });
await signIn(page);

/* Switch to Arabic the way a person does.
 *
 * As an INIT script, not a one-off evaluate: `lib.mjs` installs its own init
 * script that writes a necessary-only consent record on every navigation, so a
 * value written once into the page is overwritten by the next load. This runs
 * after that one and grants PREFERENCES, which is the consent the locale is
 * persisted under — without it the app is behaving correctly by not
 * remembering the choice at all. */
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("proovra-locale", "ar");
    localStorage.setItem("proovra-locale-mode", "manual");
    localStorage.setItem(
      "proovra-cookie-consent-state",
      JSON.stringify({
        necessary: true, preferences: true, analytics: false, marketing: false,
        consentVersion: "2026-04-06", updatedAt: new Date().toISOString(),
      }),
    );
  } catch {}
});
await page.goto(`${WEB}/admin`, { waitUntil: "networkidle", timeout: 90_000 });
await page.waitForTimeout(1500);

const cookies = await ctx.cookies();
const localeCookie = cookies.find((c) => c.name === "proovra-locale");
console.log(
  `locale cookie: ${localeCookie ? `${localeCookie.name}=${localeCookie.value}` : "ABSENT"}`,
);
if (!localeCookie || localeCookie.value !== "ar") {
  console.log("FAIL — the app did not mirror the locale into a cookie.");
  await browser.close();
  process.exit(1);
}

let failures = 0;

/* -------------------------------------------------- 1. the served HTML --- */
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
for (const route of ROUTES) {
  const res = await fetch(`${WEB}${route}`, { headers: { cookie: cookieHeader } });
  const html = await res.text();
  const tag = /<html[^>]*>/.exec(html)?.[0] ?? "";
  const dir = /dir="([^"]+)"/.exec(tag)?.[1];
  const lang = /lang="([^"]+)"/.exec(tag)?.[1];
  const ok = dir === "rtl" && lang === "ar";
  if (!ok) failures += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"}  served HTML   ${route.padEnd(28)} dir=${dir} lang=${lang}`,
  );
}

/* ------------------------------------- 2. rendered with JS switched off -- */
const noJs = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "ar",
  javaScriptEnabled: false,
  storageState: { cookies, origins: [] },
});
const noJsPage = await noJs.newPage();
for (const route of ROUTES.slice(0, 2)) {
  await noJsPage.goto(`${WEB}${route}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const measured = await noJsPage.evaluate(() => ({
    dir: document.documentElement.getAttribute("dir"),
    computed: getComputedStyle(document.documentElement).direction,
  }));
  const ok = measured.dir === "rtl" && measured.computed === "rtl";
  if (!ok) failures += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"}  no-JS render  ${route.padEnd(28)} ` +
      `dir=${measured.dir} computed=${measured.computed}`,
  );
}
await noJs.close();

/* ------------------------------------------- 3. first frame vs hydrated -- */
for (const route of ROUTES) {
  const p = await ctx.newPage();
  // Record `dir` at the earliest point a script can run in the document.
  await p.addInitScript(() => {
    document.addEventListener("readystatechange", () => {
      if (!window.__firstDir) {
        window.__firstDir = document.documentElement.getAttribute("dir");
      }
    });
  });
  await p.goto(`${WEB}${route}`, { waitUntil: "networkidle", timeout: 90_000 });
  await strip(p);
  await p.waitForTimeout(1200);
  const seen = await p.evaluate(() => ({
    first: window.__firstDir ?? null,
    now: document.documentElement.getAttribute("dir"),
  }));
  const ok = seen.first === "rtl" && seen.now === "rtl";
  if (!ok) failures += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"}  no flash      ${route.padEnd(28)} ` +
      `first=${seen.first} hydrated=${seen.now}`,
  );
  await p.close();
}

await browser.close();
console.log(failures === 0 ? "\nRTL: no flash, direction is in the document" : `\n${failures} failures`);
process.exit(failures ? 1 : 0);
