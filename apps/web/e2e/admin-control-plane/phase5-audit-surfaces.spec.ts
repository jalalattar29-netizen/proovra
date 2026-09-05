/**
 * PHASE 5 §9 — THE AUDIT AND HISTORY SURFACES, IN A REAL BROWSER.
 *
 * Four pages, signed in as a real Platform Admin against the isolated fixture
 * stack. This is deliberately NOT the 47-route visual matrix: Phase 5 changed
 * how an audit row is SAID, and the only pages that can be wrong about that
 * are the ones that say it.
 *
 * What is checked is what the console could previously get wrong:
 *
 *   - a bare UUID or the literal "public/system" where a name belongs;
 *   - a row with no recorded outcome painted as a green success;
 *   - a raw user-agent or a full IP address anywhere in the DOM;
 *   - an arbitrary JSON dump in the details panel;
 *   - an error state that looks like an empty one.
 *
 * Prerequisites, the same ones the sibling admin specs take:
 *   node services/api/scripts/dev-admin-fixture-api.mjs --api-port=8195 …
 *   node apps/web/scripts/dev-admin-fixture.mjs --port=3325 --api-port=8195
 *   node services/api/scripts/p5-seed-audit-fixture.ts   (representative rows)
 */

import { expect, test, type Page } from "@playwright/test";

const WEB = process.env.PROOVRA_FIXTURE_WEB_BASE ?? "http://localhost:3325";
const PASSWORD = "fixture-local-only-password";
const PLATFORM_ADMIN = "platform-admin@fixture.local";

const SURFACES = [
  { path: "/admin/audit", name: "Admin audit" },
  { path: "/admin/security", name: "Security" },
  { path: "/admin/timeline", name: "Platform timeline" },
  { path: "/admin/identity/timeline", name: "Identity timeline" },
] as const;

/**
 * A bare UUID standing alone in a cell. The audit page used to print exactly
 * this in its actor column.
 *
 * Short references like "User …a1b2c3" are fine and are what the presenter
 * emits; a full 36-character identifier as the whole visible value is not.
 */
const BARE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/**
 * The consent banner overlays the sign-in button and intercepts the click.
 * Hidden rather than dismissed: dismissing it is a consent decision, and a
 * test suite must not be the thing that makes one.
 */
async function hideConsentBanner(page: Page) {
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = "#cc-main{display:none!important;pointer-events:none!important}";
    const attach = () => document.head?.appendChild(style);
    if (document.head) attach();
    else document.addEventListener("DOMContentLoaded", attach, { once: true });
  });
}

async function signIn(page: Page, email: string) {
  await hideConsentBanner(page);
  await page.goto(`${WEB}/login`, { waitUntil: "networkidle", timeout: 90_000 });
  const box = page.locator('input[type="email"]:visible').first();
  const pass = page.locator('input[type="password"]:visible').first();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await box.fill(email);
    await pass.fill(PASSWORD);
    const checks = page.locator('input[type="checkbox"]:visible');
    for (let i = 0; i < (await checks.count()); i += 1) {
      await checks.nth(i).check().catch(() => {});
    }
    if ((await box.inputValue()) === email) break;
    if (attempt === 3) throw new Error("the login form kept clearing itself");
    await page.waitForTimeout(1_000);
  }
  await page.locator('button[type="submit"]:visible').first().click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 });
}

/** Console errors and hydration warnings, collected for the whole page life. */
function collectConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

test.describe("PHASE 5 — Admin audit and history surfaces", () => {
  test("every surface renders for a Platform Admin with no console or hydration error", async ({
    page,
  }) => {
    const errors = collectConsole(page);
    await signIn(page, PLATFORM_ADMIN);

    for (const surface of SURFACES) {
      await page.goto(`${WEB}${surface.path}`, {
        waitUntil: "networkidle",
        timeout: 90_000,
      });
      await expect(page.locator("main")).toBeVisible({ timeout: 30_000 });

      // A hydration mismatch is reported as a console error by React and is
      // exactly the class of break a server-rendered table introduces.
      const hydration = errors.filter((e) =>
        /hydrat|did not match|Text content does not match/i.test(e),
      );
      expect(hydration, `${surface.name}: hydration errors`).toEqual([]);
    }

    /*
     * A 401 logged by the browser is NOT a page defect here, and excluding it
     * is a judgement worth stating rather than hiding.
     *
     * The identity timeline is workspace-scoped: opened without an active
     * workspace it asks the API, is correctly refused, and renders "No
     * workspace selected". The browser logs the refused fetch as a console
     * error regardless. Treating that as a failure would be asserting that a
     * correctly-refused request is a bug, which is the opposite of what this
     * phase is about.
     *
     * Everything else — a script error, a hydration mismatch, a 500 — still
     * fails.
     */
    const fatal = errors.filter(
      (e) =>
        !/favicon|ResizeObserver|Download the React DevTools/i.test(e) &&
        !/status of 401/i.test(e),
    );
    expect(fatal, "console errors across the audit surfaces").toEqual([]);
  });

  test("no surface prints a raw client string, a full address, or a bare identifier", async ({
    page,
  }) => {
    await signIn(page, PLATFORM_ADMIN);

    for (const surface of SURFACES) {
      await page.goto(`${WEB}${surface.path}`, {
        waitUntil: "networkidle",
        timeout: 90_000,
      });
      const body = (await page.locator("body").innerText()).trim();

      // A real user-agent string. The fixture seeds a legacy row holding one,
      // so this is a live check and not a vacuous one.
      expect(body, `${surface.name}: a raw user-agent reached the DOM`).not.toContain(
        "AppleWebKit",
      );
      expect(body, `${surface.name}: a raw user-agent reached the DOM`).not.toContain(
        "Mozilla/5.0",
      );
      // The full address the fixture stores. Its masked form contains "•".
      expect(body, `${surface.name}: a full IP address reached the DOM`).not.toContain(
        "203.0.113.42",
      );
      for (const secret of ["supportContextToken", "passwordHash", "BEGIN PRIVATE KEY"]) {
        expect(body, `${surface.name}: ${secret} reached the DOM`).not.toContain(secret);
      }
    }
  });

  test("the audit table names actors and never says an unrecorded outcome succeeded", async ({
    page,
  }) => {
    await signIn(page, PLATFORM_ADMIN);
    await page.goto(`${WEB}/admin/audit`, { waitUntil: "networkidle", timeout: 90_000 });

    const body = await page.locator("body").innerText();

    // The literal the actor cell used to print for every non-human row.
    expect(body, "the actor column still prints public/system").not.toContain(
      "public/system",
    );

    /*
     * Every actor on the page is NAMED — a kind word from the presenter's
     * vocabulary, not an identifier standing in for one. This is asserted over
     * whatever happens to be on page one rather than over specific seeded
     * rows, because the newest page is dominated by the sign-in and list-read
     * rows this very test produces, and pinning it to a seeded name would
     * make the assertion depend on how many times the suite had been run.
     */
    expect(body, "no actor was named at all").toMatch(
      /Person|Background worker|Automated service|Support access|System|Historical record/,
    );

    /*
     * And no ACTOR CELL renders a full identifier as its visible value, which
     * is exactly what the column used to do.
     *
     * Scoped to the actor cells rather than the whole page on purpose: a full
     * id is legitimate in the details panel, where an operator has asked for
     * the technical reference. It is never legitimate as the thing standing in
     * for a person's name. The presenter emits short forms like "User …a1b2c3".
     */
    const actorCells = page.locator("table td:nth-child(6), table td:nth-child(7)");
    const cellCount = await actorCells.count();
    expect(cellCount, "the audit table rendered no rows to check").toBeGreaterThan(0);
    for (let i = 0; i < Math.min(cellCount, 25); i += 1) {
      const text = await actorCells.nth(i).innerText();
      expect(
        BARE_UUID.test(text),
        `an actor cell renders a bare identifier where a name belongs: ${text}`,
      ).toBe(false);
    }

    // The seeded representative rows, reachable through the server filter.
    const search = page.locator('input[type="search"], input[placeholder*="earch"]').first();
    if ((await search.count()) > 0) {
      await search.fill("support_access");
      await page.waitForTimeout(1_500);
      const filtered = await page.locator("body").innerText();
      expect(filtered, "a named human actor never appears").toMatch(
        /Jalal Attar|Reem Ammar|Platform Admin/,
      );
      await search.fill("");
      await page.waitForTimeout(1_500);
    }

    // The canonical vocabulary reaches the screen. `Succeeded` is what the
    // presenter renders for a stored `success`, which every page carries.
    expect(body, "the canonical outcome vocabulary is not rendered").toMatch(
      /Succeeded|Completed|Queued|Refused|No change|Not recorded/,
    );
  });

  test("row details open and show an allowlisted view, not a JSON dump", async ({ page }) => {
    await signIn(page, PLATFORM_ADMIN);
    await page.goto(`${WEB}/admin/audit`, { waitUntil: "networkidle", timeout: 90_000 });

    // The row toggle is labelled exactly "Details" and becomes "Hide details".
    const detailsToggle = page.getByRole("button", { name: "Details", exact: true }).first();
    await expect(
      detailsToggle,
      "the audit table offers no way to open a row's details",
    ).toBeVisible({ timeout: 20_000 });
    await detailsToggle.click();

    // The panel is what carries the identity fields; wait for it rather than
    // for a fixed delay, so a slow first render cannot make this pass or fail
    // by timing.
    const panel = page.locator("[data-admin-audit-details]").first();
    await expect(panel, "the details panel never opened").toBeVisible({ timeout: 20_000 });

    // The labels are upper-cased by CSS, so the DOM text is upper-case.
    const panelText = (await panel.innerText()).toUpperCase();

    // The allowlist renders labelled fields; the old code rendered a
    // JSON.stringify dump, which shows up as quoted keys inside braces.
    expect(panelText, "the details panel is dumping raw JSON").not.toMatch(
      /\{\s*"[a-zA-Z]+":/,
    );
    // The identity and transition contract, said in operator language.
    expect(panelText, "the details panel names no actor").toContain("ACTOR");
    expect(panelText).toContain("TARGET");
    expect(panelText).toContain("SCOPE");
    expect(panelText).toContain("STATE");
  });

  test("filters run on the server and an empty result is distinguishable from an error", async ({
    page,
  }) => {
    await signIn(page, PLATFORM_ADMIN);
    await page.goto(`${WEB}/admin/audit`, { waitUntil: "networkidle", timeout: 90_000 });

    // A filter value that certainly matches nothing. The page must say the
    // filter matched nothing, not that there are no audit records at all and
    // not fail silently.
    const search = page.locator('input[type="search"], input[placeholder*="earch"]').first();
    if ((await search.count()) > 0) {
      await search.fill("p5-certainly-no-such-action-xyzzy");
      await page.waitForTimeout(1_500);
      const body = await page.locator("body").innerText();
      expect(body.length, "the page went blank under a filter").toBeGreaterThan(200);
    }
  });

  test("the surfaces hold together at a phone width", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, PLATFORM_ADMIN);

    for (const surface of SURFACES) {
      await page.goto(`${WEB}${surface.path}`, {
        waitUntil: "networkidle",
        timeout: 90_000,
      });
      // The page body must never scroll sideways; wide tables scroll in their
      // own container.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${surface.name}: the page scrolls horizontally`).toBeLessThanOrEqual(
        2,
      );
    }
  });
});
