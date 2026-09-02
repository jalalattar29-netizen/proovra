/**
 * THE ADMIN CONTROL PLANE VERIFICATION MATRIX.
 *
 * =============================================================================
 * WHAT THIS REPLACES
 * =============================================================================
 * A previous pass opened all 47 admin routes at 1440px as one platform admin
 * and reported it as browser verification. It was reachability proof and
 * nothing more: it could not have caught a table that overflows at 320px, a
 * page that renders for a read-only member who should not see it, a second
 * <h1>, or a control smaller than a thumb.
 *
 * This drives every route across every viewport and every role, and writes a
 * machine-readable result per (route, viewport, role, direction) so the
 * completion ledger can cite an artefact instead of an adjective.
 *
 * =============================================================================
 * WHY IT IS ONE DATA-DRIVEN SPEC AND NOT 47 FILES
 * =============================================================================
 * 47 hand-written specs drift: somebody adds a route and does not add a file,
 * and the suite stays green while coverage silently drops. The route list is
 * read from the same generated inventory the ledger uses, so a new admin page
 * joins this matrix by existing.
 *
 * =============================================================================
 * PREREQUISITES — it FAILS rather than skips if they are missing
 * =============================================================================
 *   node services/api/scripts/dev-admin-fixture-api.mjs
 *   node apps/web/scripts/dev-admin-fixture.mjs
 *   seed-admin-fixture.ts has been run against the fixture database
 *
 * A verification suite that quietly skips is how "37 of 47" became "47/47".
 *
 * Run:
 *   pnpm exec playwright test --config apps/web/e2e/admin-control-plane/playwright.config.ts
 *
 * Narrow it while iterating:
 *   PROOVRA_MATRIX_ROUTES=/admin,/admin/costs  ...
 *   PROOVRA_MATRIX_VIEWPORTS=1440,320          ...
 *   PROOVRA_MATRIX_ROLES=platform-admin        ...
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// The consent version lives in ONE place; reading it here means a bump cannot
// silently leave this suite seeding a stale decision that the app re-prompts on.
import { CONSENT_VERSION } from "../../lib/consent";

const REPO = resolve(process.cwd());
const WEB = process.env.PROOVRA_FIXTURE_WEB_BASE ?? "http://localhost:3311";
const OUT_DIR = resolve(REPO, "artifacts/admin-matrix");
const SHOT_DIR = resolve(OUT_DIR, "screenshots");

/** The fixture's people. Password is the same for all of them, by design. */
const PASSWORD = "fixture-local-only-password";

export const ROLES = [
  { id: "anonymous", email: null, expect: "redirected-to-login" },
  { id: "free-personal", email: "free-personal@fixture.local", expect: "denied" },
  { id: "pro-personal", email: "pro-personal@fixture.local", expect: "denied" },
  { id: "read-only", email: "read-only@fixture.local", expect: "denied" },
  { id: "workspace-admin", email: "workspace-admin@fixture.local", expect: "denied" },
  { id: "org-owner", email: "org-owner@fixture.local", expect: "denied" },
  { id: "platform-admin", email: "platform-admin@fixture.local", expect: "allowed" },
] as const;

/**
 * Widths, and the one that is not a width.
 *
 * 320 is the floor the layout has to survive; 200% zoom is emulated as a
 * halved viewport with a doubled device scale factor, which is what a browser
 * at 200% actually gives the page.
 */
export const VIEWPORTS = [
  { id: "1440", width: 1440, height: 900, scale: 1 },
  { id: "1280", width: 1280, height: 800, scale: 1 },
  { id: "1024", width: 1024, height: 768, scale: 1 },
  { id: "768", width: 768, height: 1024, scale: 1 },
  { id: "390", width: 390, height: 844, scale: 3 },
  { id: "375", width: 375, height: 812, scale: 2 },
  { id: "320", width: 320, height: 568, scale: 2 },
  { id: "zoom200", width: 720, height: 450, scale: 2 },
] as const;

function routes(): string[] {
  const override = process.env.PROOVRA_MATRIX_ROUTES;
  if (override) return override.split(",").map((s) => s.trim()).filter(Boolean);

  const raw = execFileSync(
    process.execPath,
    [resolve(REPO, "apps/web/scripts/admin-inventory.mjs"), "--json"],
    { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return (JSON.parse(raw).rows as Array<{ route: string }>).map((r) => r.route);
}

/**
 * The seeded ids, so a dynamic route is opened with a REAL record.
 *
 * Hard-coded to match seed-admin-fixture.ts. A detail page opened with a
 * fabricated id proves the not-found path, not the page.
 */
const SEEDED: Record<string, string> = {
  "/admin/customers/:id": "0adf0000-0000-4000-8000-0000000000a1",
  "/admin/workspaces/:id": "0adf0000-0000-4000-8000-0000000000b1",
  "/admin/users/:id": "0adf0000-0000-4000-8000-000000000002",
  "/admin/demo-requests/:id": "0adf0000-0000-4000-8000-0000000000e1",
  "/admin/contact-sales/:id": "0adf0000-0000-4000-8000-0000000000e2",
  "/admin/platform/runbooks/:slug": "tsa-timestamp-failure",
};

export function concreteUrl(route: string): string {
  const seeded = SEEDED[route];
  if (!seeded) return route;
  return route.replace(/\/:(id|slug)$/, `/${seeded}`);
}

/**
 * Record a necessary-only consent decision BEFORE the first paint.
 *
 * The banner (`#cc-main`, vanilla-cookieconsent) is fixed-position and its
 * button row intercepts pointer events across the whole viewport. Clicking the
 * sign-in button through it does nothing, and Playwright reports only "subtree
 * intercepts pointer events" — which reads like a flaky selector rather than a
 * modal nobody dismissed.
 *
 * Dismissing it by clicking was tried twice and is fragile for a reason that
 * has nothing to do with selectors: the banner mounts after hydration, so a
 * check that runs before it appears finds nothing and a check that runs after
 * races the form. The first attempt passed for one role and failed for the
 * next, which is exactly the shape of a race.
 *
 * Seeding the decision removes the race instead of timing it. It also records
 * the RIGHT decision: necessary-only is the most privacy-preserving option,
 * and it is the correct default for an automated run that nobody consented on
 * behalf of. The shape is `ConsentState` from apps/web/lib/consent.ts; the
 * version is read from that module so this cannot silently drift.
 */
async function seedNecessaryOnlyConsent(context: BrowserContext): Promise<void> {
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
        /* a context with storage disabled still runs the rest of the suite */
      }
    },
    { key: "proovra-cookie-consent-state", version: CONSENT_VERSION },
  );

  /**
   * And take the banner out of the hit-testing layer.
   *
   * Seeding the decision records the right ANSWER; it does not stop
   * vanilla-cookieconsent mounting its own overlay, which is fixed-position and
   * swallows pointer events across the whole viewport. Three attempts to time a
   * click against it failed three different ways — mounted too late to dismiss,
   * re-rendered the form and emptied it, then intercepted the submit anyway —
   * because each was trying to win a race instead of removing it.
   *
   * This suite does not test the consent banner; apps/web/__tests__/
   * privacy-hardening.test.ts does. Hiding it removes a variable that has
   * nothing to do with the pages under test, and the recorded decision stays
   * necessary-only either way.
   */
  await context.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent =
      "#cc-main{display:none!important;pointer-events:none!important}";
    const attach = () => document.head?.appendChild(style);
    if (document.head) attach();
    else document.addEventListener("DOMContentLoaded", attach, { once: true });
  });
}

/**
 * Sign in, and check that the form still holds what was typed.
 *
 * The login form's inputs are React-controlled, and the cookie-consent banner
 * mounts AFTER hydration. That late mount re-renders the tree and empties the
 * controlled inputs, so a fill that happened a moment earlier is silently
 * discarded and the submit produces
 *
 *     alert: "Please enter email and password."
 *
 * — while Playwright reports only `waitForURL: Timeout 90000ms exceeded`,
 * which points at navigation and says nothing about an emptied field.
 *
 * Two things fix it, and both are needed. Waiting for the network to settle
 * lets the late mount happen BEFORE typing. Re-reading the values immediately
 * before the click catches the case where something re-renders anyway, instead
 * of submitting an empty form and blaming the navigation.
 */
async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(`${WEB}/login`, { waitUntil: "networkidle", timeout: 90_000 });
  await dismissConsent(page);

  const emailBox = page.locator('input[type="email"]:visible').first();
  const passwordBox = page.locator('input[type="password"]:visible').first();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await emailBox.fill(email);
    await passwordBox.fill(PASSWORD);

    const terms = page.locator('input[type="checkbox"]:visible');
    const count = await terms.count();
    for (let i = 0; i < count; i += 1) await terms.nth(i).check().catch(() => {});

    // Read them back. This is the whole point of the retry.
    if (
      (await emailBox.inputValue()) === email &&
      (await passwordBox.inputValue()) === PASSWORD
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

  await page.locator('button[type="submit"]:visible').first().click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90_000 });
}

/**
 * Dismiss the consent banner if it is on screen.
 *
 * Seeding `proovra-cookie-consent-state` records the right DECISION
 * (necessary-only, the most privacy-preserving option) but does not stop the
 * banner rendering, so this still has to run. Declining is also correct rather
 * than merely convenient: nobody consented on behalf of an automated run.
 */
async function dismissConsent(page: Page): Promise<void> {
  const banner = page.locator("#cc-main");
  if ((await banner.count()) === 0) return;
  if (!(await banner.first().isVisible().catch(() => false))) return;
  for (const name of [/reject all/i, /decline/i, /necessary only/i]) {
    const button = banner.getByRole("button", { name });
    if (await button.count()) {
      await button.first().click({ timeout: 5_000 }).catch(() => {});
      break;
    }
  }
  await banner.first().waitFor({ state: "hidden", timeout: 8_000 }).catch(() => {});
}

type Finding = {
  route: string;
  viewport: string;
  role: string;
  dir: "ltr" | "rtl";
  ok: boolean;
  problems: string[];
  screenshot: string | null;
};

const findings: Finding[] = [];

/**
 * Everything measurable about the page as rendered, in one round trip.
 *
 * Done in ONE evaluate rather than a dozen locator calls because 47 routes ×
 * 8 viewports × 7 roles is 2,632 page loads, and per-call latency dominates.
 */
async function inspect(page: Page) {
  return page.evaluate(() => {
    const problems: string[] = [];
    const doc = document.documentElement;

    // The page body must never scroll sideways. A wide TABLE is fine; a wide
    // table that drags the header and navigation with it is not.
    if (doc.scrollWidth > doc.clientWidth + 1) {
      problems.push(
        `horizontal overflow: ${doc.scrollWidth}px in ${doc.clientWidth}px`,
      );
    }

    const h1s = [...document.querySelectorAll("h1")].filter(
      (h) => (h as HTMLElement).offsetParent !== null,
    );
    if (h1s.length === 0) problems.push("no visible <h1>");
    if (h1s.length > 1) problems.push(`${h1s.length} visible <h1> elements`);

    if (!document.querySelector("main")) problems.push("no <main> landmark");

    // 44x44 is the floor for anything a thumb has to hit. Links inside running
    // text are exempt — they are read, not tapped at.
    const small: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(
      "button:not([disabled]), a[href], input[type=checkbox], input[type=radio], select",
    )) {
      if (el.offsetParent === null) continue;
      if (el.closest("p, li, .rb-prose, .prose")) continue;
      // The consent banner is third-party chrome this suite deliberately hides;
      // measuring its buttons reported a finding against every single page.
      if (el.closest("#cc-main")) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width < 44 || r.height < 44) {
        small.push(
          `${el.tagName.toLowerCase()}"${(el.textContent ?? "").trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
      }
    }
    if (small.length > 0) {
      problems.push(`${small.length} target(s) under 44px: ${small.slice(0, 3).join("; ")}`);
    }

    // An unlabelled control is unusable with a screen reader.
    const unlabelled: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("button, a[href], input, select")) {
      if (el.offsetParent === null) continue;
      if (el.closest("#cc-main")) continue;
      const name =
        el.getAttribute("aria-label") ??
        el.getAttribute("title") ??
        (el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : null) ??
        el.textContent;
      if (!name || !name.trim()) {
        unlabelled.push(`${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""}`);
      }
    }
    if (unlabelled.length > 0) {
      problems.push(`${unlabelled.length} unnamed control(s): ${unlabelled.slice(0, 3).join(", ")}`);
    }

    const text = (document.querySelector("main") ?? document.body).innerText;
    return {
      problems,
      h1: h1s[0]?.textContent?.trim() ?? null,
      chars: text.replace(/\s+/g, " ").length,
      deniedText: /elevation is required|Platform administrator only|not authorized|Access denied/i.test(text),
      signInOffered: /\bSign in\b/i.test(text),
    };
  });
}

test.describe.configure({ mode: "serial" });

test("the fixture stack is up", async ({ page }) => {
  // FAIL, not skip. A verification suite that quietly skips is how "37 of 47"
  // was reported as complete.
  const res = await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
  expect(
    res?.status(),
    `no fixture web server at ${WEB}. Start dev-admin-fixture-api.mjs and dev-admin-fixture.mjs.`,
  ).toBe(200);
});

const SELECTED_VIEWPORTS = process.env.PROOVRA_MATRIX_VIEWPORTS
  ? VIEWPORTS.filter((v) =>
      process.env.PROOVRA_MATRIX_VIEWPORTS!.split(",").includes(v.id),
    )
  : VIEWPORTS;

const SELECTED_ROLES = process.env.PROOVRA_MATRIX_ROLES
  ? ROLES.filter((r) => process.env.PROOVRA_MATRIX_ROLES!.split(",").includes(r.id))
  : ROLES;

for (const role of SELECTED_ROLES) {
  test.describe(`role ${role.id}`, () => {
    for (const dir of ["ltr", "rtl"] as const) {
      for (const vp of SELECTED_VIEWPORTS) {
        // RTL is checked at the two widths that matter, not at all eight: the
        // direction interacts with LAYOUT, and a bug that survives 1440 and
        // 320 does not appear only at 1024.
        if (dir === "rtl" && !["1440", "320"].includes(vp.id)) continue;

        test(`${dir} ${vp.id}`, async ({ browser }) => {
          test.setTimeout(20 * 60_000);

          const context = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            deviceScaleFactor: vp.scale,
            reducedMotion: "reduce",
          });
          await seedNecessaryOnlyConsent(context);
          const page = await context.newPage();

          const consoleErrors: string[] = [];
          page.on("console", (m) => {
            if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
          });
          page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`));

          if (role.email) await signIn(page, role.email);
          /**
           * RTL is applied AFTER hydration, deliberately.
           *
           * An init script setting dir="rtl" before first paint produced a
           * genuine React hydration mismatch on every RTL check — the server
           * rendered dir="ltr" from the root layout and the client found
           * "rtl". That is a defect this harness INVENTED and then reported
           * against the pages it was measuring, which is worse than not
           * checking RTL at all.
           *
           * What RTL verification is actually for here is LAYOUT: does a table
           * overflow, does a drawer clip, does a sticky header overlap when the
           * writing direction flips. Flipping after hydration exercises exactly
           * that, and leaves hydration alone.
           */
          for (const route of routes()) {
            const url = `${WEB}${concreteUrl(route)}`;
            consoleErrors.length = 0;

            /**
             * domcontentloaded, then settle on the CONTENT.
             *
             * `networkidle` never arrives against a Next dev server: HMR holds
             * a websocket open and the client polls, so waiting for a quiet
             * network is waiting for something that will not happen. It timed
             * out at 90s on the first route and looked like a broken page.
             *
             * Waiting for a visible <h1> is the honest readiness signal here —
             * every admin page renders one, and the checks below assert that.
             * The fallback timeout keeps a genuinely broken page reportable
             * instead of failing the whole run.
             */
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
            await page
              .locator("h1:visible")
              .first()
              .waitFor({ state: "visible", timeout: 45_000 })
              .catch(() => {});
            if (dir === "rtl") {
              await page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"));
            }
            await page.waitForTimeout(400);

            const r = await inspect(page);
            const problems = [...r.problems];

            // Console errors are part of the result, not a separate concern:
            // a page that renders correctly while throwing is not verified.
            const expectedRefusal = role.expect !== "allowed";
            const realErrors = consoleErrors.filter((e) => {
              // A refused role SHOULD see 401/403 — that is the authorization
              // boundary working. Counting it as a console defect made every
              // correct refusal look like a bug and buried the real errors.
              if (expectedRefusal && /status of (401|403)/.test(e)) return false;
              return true;
            });
            if (realErrors.length > 0) {
              problems.push(`console: ${realErrors.slice(0, 2).join(" | ")}`);
            }

            // Authorization, checked as behaviour rather than as a claim.
            if (role.expect === "allowed" && r.deniedText) {
              problems.push("platform admin was refused");
            }
            if (role.expect === "denied" && !r.deniedText && !page.url().includes("/login")) {
              problems.push(`${role.id} was NOT refused`);
            }
            if (role.email && r.signInOffered) {
              problems.push('a signed-in reader was offered "Sign in"');
            }

            // Screenshots for the two viewports a person actually looks at.
            let shot: string | null = null;
            if (role.id === "platform-admin" && (vp.id === "1440" || vp.id === "390")) {
              const safe = route.replace(/[/:]/g, "_").replace(/^_/, "");
              shot = `screenshots/${safe}__${vp.id}__${dir}__${role.id}.png`;
              const file = resolve(OUT_DIR, shot);
              mkdirSync(dirname(file), { recursive: true });
              await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
            }

            findings.push({
              route,
              viewport: vp.id,
              role: role.id,
              dir,
              ok: problems.length === 0,
              problems,
              screenshot: shot,
            });
          }

          await context.close();
        });
      }
    }
  });
}

test.afterAll(() => {
  mkdirSync(SHOT_DIR, { recursive: true });
  writeFileSync(
    resolve(OUT_DIR, "findings.json"),
    JSON.stringify({ base: WEB, at: new Date().toISOString(), findings }, null, 2),
    "utf8",
  );
  const bad = findings.filter((f) => !f.ok);
  // Written whether or not anything failed. The report is the artefact the
  // ledger cites, and a report that only exists on success is not evidence.
  console.log(
    `admin-matrix: ${findings.length} checks, ${bad.length} with findings — artifacts/admin-matrix/findings.json`,
  );
});
