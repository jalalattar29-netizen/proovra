/**
 * THE STATES A CONSOLE PAGE CAN BE IN, CAPTURED DELIBERATELY.
 *
 * =============================================================================
 * WHY THESE CAPTURES EXIST
 * =============================================================================
 * The visual review shows every route POPULATED, because the fixture seeds
 * data. That proves the happy path and nothing else: a page whose error
 * region is broken, whose filtered-empty wording lies, or whose loading
 * skeleton never appears looks identical in a populated capture.
 *
 * This spec drives one representative route per LAYOUT FAMILY through the
 * states a page cannot fake, and writes each as a screenshot:
 *
 *   loading         the request is held open — the skeleton is on screen
 *   error           the request is aborted — the failure path renders
 *   filtered-empty  a server filter that matches nothing — the wording must
 *                   say "no match", never "all clear"
 *   unauthorized    a read-only member opens the route — the denial panel
 *   dialog          a destructive confirmation is open — scope on screen
 *   rtl             the same page with dir=rtl — layout survives the flip
 *
 * States that interception cannot produce honestly are not faked: a page's
 * "degraded" is its own error-region rendering of a failed source, which the
 * aborted-request capture IS. No response body is invented beyond an aborted
 * transport, so nothing here can teach a page to render a state the real
 * backend could not produce.
 *
 * The captures land in artifacts/admin-visual-review/states/ and the tracked
 * manifest (docs/admin/evidence/screenshot-manifest.json) records their
 * hashes, so "the evidence exists" is checkable without the binaries.
 *
 * Prerequisites: the seeded fixture stack (API :8191, web :3311).
 *
 * Run:
 *   pnpm exec playwright test admin-states --config apps/web/e2e/admin-control-plane/playwright.config.ts
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { CONSENT_VERSION } from "../../lib/consent";
import { ADMIN_EMPTY_COPY } from "../../lib/admin/read-state";

const WEB = process.env.PROOVRA_FIXTURE_WEB_BASE ?? "http://localhost:3311";
const REPO = resolve(process.cwd());
const OUT = resolve(REPO, "artifacts/admin-visual-review/states");
const PASSWORD = "fixture-local-only-password";

/**
 * One representative per layout family, and the interception that produces
 * each state honestly. `dataUrl` is the API path whose responses carry the
 * page's main content; aborting it produces the error state, holding it
 * produces loading.
 */
/**
 * THE SEMANTIC LOCATORS, NOT SENTENCES.
 *
 * `AdmReadFailure` emits `data-admin-read-failure` and its retry control emits
 * `data-admin-read-retry`. Asserting on those is what makes this suite immune
 * to the failure mode it previously had: a phrase the test author invented,
 * which the product never rendered, so the assertion could not fail.
 */
const FAILURE_SURFACE = "[data-admin-read-failure]";
const RETRY_CONTROL = "[data-admin-read-retry]";

const FAMILIES: Array<{
  family: string;
  route: string;
  dataUrl: string;
  /**
   * The successful-empty claim this surface makes, imported from the product's
   * own constants. A failed read must never render it.
   */
  emptyCopy?: readonly string[];
  /** A successful but empty body for this route's primary read. */
  emptyBody?: unknown;
  /** Set with a REASON where the strict failure/empty contract does not apply. */
  notStrict?: string;
  /** False where a repeat of the read cannot help (none today; kept explicit). */
  retryable?: boolean;
  /** Applies a server filter that matches nothing, where the page has one. */
  filteredEmpty?: (page: Page) => Promise<void>;
  /** Opens a confirmation dialog, where the page has a destructive action. */
  dialog?: (page: Page) => Promise<void>;
}> = [
  {
    family: "dashboard-kpi",
    route: "/admin",
    dataUrl: "**/v1/admin/overview*",
    emptyCopy: [ADMIN_EMPTY_COPY["/admin"].title],
    // No `emptyBody`: the overview payload is a deep Metric<T> envelope and a
    // hand-written empty body would assert a shape the server does not send.
    // The FAILURE half of the contract still applies, which is the half the
    // P1 on this family is about.
  },
  {
    family: "data-table",
    route: "/admin/contact-sales",
    dataUrl: "**/v1/admin/contact-sales?*",
    emptyCopy: [ADMIN_EMPTY_COPY["/admin/contact-sales"].title],
    /*
     * THE ENVELOPE THE SERVER ACTUALLY SENDS.
     *
     * This was `{ items: [], total: 0, summary: {} }` — a body
     * `GET /v1/admin/contact-sales` has never returned. The handler answers
     * `{ ok: true, data: { items, total, summary } }`
     * (admin-contact-sales.routes.ts:144).
     *
     * The stub passed anyway, and the reason it passed is the defect it was
     * meant to be testing around: the page read `res.data.items` only
     * `if (res.ok)`, so a body with no `ok` skipped every branch silently,
     * left `items` at `[]`, and rendered "No contact-sales inquiries yet".
     * The fixture and the page were wrong in the same direction, so the pair
     * agreed and the case looked green.
     *
     * Corrected to the real envelope. The assertion either side of it is
     * unchanged and just as strict — this only stops the "successful empty"
     * case being expressed as a body the server cannot produce.
     */
    emptyBody: { ok: true, data: { items: [], total: 0, summary: {} } },
    filteredEmpty: async (page) => {
      await page
        .locator("input[placeholder*='Search'], input[type='search']")
        .first()
        .fill("zzz-no-such-inquiry-zzz");
      await page.waitForTimeout(1_200);
    },
  },
  {
    family: "dynamic-detail",
    route: "/admin/contact-sales/0adf0000-0000-4000-8000-0000000000e2",
    dataUrl: "**/v1/admin/contact-sales/0adf*",
    dialog: async (page) => {
      await page
        .locator('[data-testid^="contact-sales-status-"]')
        .first()
        .waitFor({ state: "visible", timeout: 60_000 });
      const rejected = page.getByTestId("contact-sales-status-rejected");
      if ((await rejected.count()) > 0) await rejected.click();
      else await page.locator('[data-testid^="contact-sales-status-"]').last().click();
      await page
        .locator("[data-confirm-action-modal]")
        .waitFor({ state: "visible", timeout: 10_000 });
    },
  },
  {
    family: "form-configuration",
    route: "/admin/provisioning",
    dataUrl: "**/v1/admin/provisioning*",
    notStrict:
      "Provisioning is a FORM, not a read projection: it has no list whose emptiness could be confused with a failed read, and its own submit path already classifies refusals separately. The tone assertion below still applies.",
  },
  {
    family: "timeline",
    route: "/admin/timeline",
    dataUrl: "**/v1/admin/timeline*",
    emptyCopy: [ADMIN_EMPTY_COPY["/admin/timeline"].title],
    emptyBody: { items: [], nextCursor: null },
  },
  {
    family: "runbook-reader",
    route: "/admin/platform/runbooks/tsa-timestamp-failure",
    dataUrl: "**/v1/admin/audit-log*",
    notStrict:
      "The reader renders a runbook compiled into the bundle; it issues no read of its own, so the intercepted URL here is the shell's, not the page's. There is no empty state to confuse with a failure. The tone assertion below still applies.",
  },
  {
    family: "operations-grid",
    route: "/admin/operations",
    dataUrl: "**/v1/admin/incidents*",
    emptyCopy: [ADMIN_EMPTY_COPY["/admin/operations"].title],
    emptyBody: { items: [], total: 0, severityBreakdown: {} },
  },
  {
    family: "master-detail",
    route: "/admin/platform/queues",
    dataUrl: "**/v1/operations/queues*",
    notStrict:
      "Queues is outside the Batch-B remediation set. It is kept in the matrix for its loading, dialog and RTL captures; the tone assertion below still applies. Promoting it to the strict contract is tracked as residual work in the Phase-10 report.",
  },
];

const slug = (route: string) =>
  route.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+$/, "");

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

async function signIn(page: Page, email: string) {
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

async function shoot(page: Page, name: string) {
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({
    path: resolve(OUT, `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}

test.describe.configure({ mode: "serial" });

test("family representatives across states", async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await seedConsent(context);
  const page = await context.newPage();
  await signIn(page, "platform-admin@fixture.local");

  for (const fam of FAMILIES) {
    const base = `${slug(fam.route)}`;

    // --- loading: hold the main read open past the capture -----------------
    let release: (() => void) | null = null;
    await page.route(fam.dataUrl, async (route) => {
      await new Promise<void>((r) => {
        release = r;
      });
      await route.continue().catch(() => {});
    });
    await page.goto(`${WEB}${fam.route}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(1_500);
    await shoot(page, `${base}--loading`);
    release?.();
    await page.unroute(fam.dataUrl);

    // --- error: abort the main read ---------------------------------------
    //
    // THE ASSERTION THIS REPLACES COULD NOT FAIL.
    //
    // It was `expect(errorText).not.toContain("all clear")`. The phrase "all
    // clear" appears in NO rendered admin copy — every occurrence in the admin
    // tree is inside a source comment, and `innerText()` returns rendered text
    // only. So the check passed on every family including this one, while
    // /admin/operations rendered "an empty table means nothing is currently
    // open — not that nothing was measured" over a read that never completed.
    // A test that names a phrase the author had in mind rather than the phrase
    // the product ships is the same defect as the historical `/try proovra/i`
    // surface-tier assertion, and it is worse than no test: it reports the
    // class as covered.
    //
    // The replacement asserts the SEMANTIC contract instead of any phrase:
    //   1. the canonical failure surface is present,
    //   2. this family's own successful-empty copy is absent,
    //   3. no healthy/zero tone is applied,
    //   4. Retry is offered where retry is safe.
    // `emptyCopy` is read from the product's own constants, never invented here.
    await page.route(fam.dataUrl, (route) => route.abort("connectionrefused"));
    await page.goto(`${WEB}${fam.route}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.locator("h1:visible").first().waitFor({ state: "visible", timeout: 45_000 }).catch(() => {});
    const failure = page.locator(FAILURE_SURFACE).first();
    await failure.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
    const errorText = await page.locator("main").first().innerText().catch(() => "");

    if (fam.emptyCopy) {
      expect(
        await failure.count(),
        `${fam.route}: a failed read rendered no failure surface. main was: ${errorText.slice(0, 400)}`,
      ).toBeGreaterThan(0);
    }

    for (const claim of fam.emptyCopy ?? []) {
      expect(
        errorText,
        `${fam.route}: a FAILED read rendered the successful-empty claim "${claim}"`,
      ).not.toContain(claim);
    }

    // A healthy or measured-zero tone must not be applied to a source that did
    // not answer. `data-tone` / `data-state` are the console's own attributes.
    const healthyTone = await page
      .locator('main [data-tone="healthy"], main [data-state="done"]')
      .count();
    expect(
      healthyTone,
      `${fam.route}: a healthy tone is painted while the read is failing`,
    ).toBe(0);

    if (fam.emptyCopy && fam.retryable !== false) {
      expect(
        await page.locator(RETRY_CONTROL).count(),
        `${fam.route}: the failure surface offers no way to retry`,
      ).toBeGreaterThan(0);
    }

    await shoot(page, `${base}--error`);
    await page.unroute(fam.dataUrl);

    // --- success-empty: the OTHER side of the same contract ---------------
    //
    // Proving the failure state alone is half a proof. A page that renders the
    // failure surface unconditionally would pass everything above. So the same
    // family is driven through a SUCCESSFUL empty response, and the two states
    // must be distinguishable: the empty state appears, the failure surface
    // does not, and the operator claims are not the same sentence.
    if (fam.emptyBody !== undefined) {
    await page.route(fam.dataUrl, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fam.emptyBody),
      }),
    );
    await page.goto(`${WEB}${fam.route}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.locator("h1:visible").first().waitFor({ state: "visible", timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    const emptyText = await page.locator("main").first().innerText().catch(() => "");
    expect(
      await page.locator(FAILURE_SURFACE).count(),
      `${fam.route}: a SUCCESSFUL empty response rendered the failure surface`,
    ).toBe(0);
    expect(
      emptyText,
      `${fam.route}: a successful empty response rendered neither its empty copy nor any content`,
    ).toContain(fam.emptyCopy[0]);
    await shoot(page, `${base}--success-empty`);
    await page.unroute(fam.dataUrl);
    }

    // --- populated (control), then the optional page-specific states ------
    await page.goto(`${WEB}${fam.route}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.locator("h1:visible").first().waitFor({ state: "visible", timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(1_000);

    if (fam.filteredEmpty) {
      await fam.filteredEmpty(page);
      const text = await page.locator("main").first().innerText().catch(() => "");
      expect(text.toLowerCase()).toMatch(/no .*match|no inquiries match|clearing the filter|no results/);
      await shoot(page, `${base}--filtered-empty`);
    }
    if (fam.dialog) {
      await fam.dialog(page);
      await shoot(page, `${base}--dialog`);
      await page.keyboard.press("Escape");
    }

    // --- rtl ---------------------------------------------------------------
    await page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"));
    await page.waitForTimeout(400);
    await shoot(page, `${base}--rtl`);
    await page.evaluate(() => document.documentElement.setAttribute("dir", "ltr"));
  }

  await context.close();
});

test("dynamic details: an invalid identifier is a not-found state, not a crash", async ({
  browser,
}) => {
  test.setTimeout(10 * 60_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await seedConsent(context);
  const page = await context.newPage();
  await signIn(page, "platform-admin@fixture.local");

  // A well-formed UUID that no seed ever wrote, and one malformed id. Both
  // must land on the page's own not-found rendering with a way back — never
  // a blank page, a crash overlay, or invented data.
  const NO_SUCH = "0adf0000-0000-4000-8000-00000000dead";
  const targets = [
    `/admin/customers/${NO_SUCH}`,
    `/admin/workspaces/${NO_SUCH}`,
    `/admin/users/${NO_SUCH}`,
    `/admin/demo-requests/${NO_SUCH}`,
    `/admin/contact-sales/${NO_SUCH}`,
    "/admin/platform/runbooks/no-such-runbook-slug",
  ];
  for (const route of targets) {
    const consoleCrashes: string[] = [];
    page.on("pageerror", (e) => consoleCrashes.push(e.message.slice(0, 120)));
    await page.goto(`${WEB}${route}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(2_500);
    const text = await page.locator("body").innerText();
    expect(
      /not found|could not be found|doesn.t exist|no longer exists|404/i.test(text),
      `${route} did not present a not-found state; body starts: ${text.slice(0, 160)}`,
    ).toBe(true);
    // The seeded records' names must not leak into a not-found page.
    expect(text).not.toContain("Sam Fixture");
    expect(text).not.toContain("Dana Fixture");
    expect(consoleCrashes, `${route} crashed: ${consoleCrashes.join(" | ")}`).toEqual([]);
    await shoot(page, `${slug(route)}--not-found`);
  }
  await context.close();
});

test("unauthorized: a read-only member is refused, and the refusal is the page", async ({
  browser,
}) => {
  test.setTimeout(10 * 60_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await seedConsent(context);
  const page = await context.newPage();
  await signIn(page, "read-only@fixture.local");

  for (const route of ["/admin", "/admin/contact-sales", "/admin/platform/queues"]) {
    await page.goto(`${WEB}${route}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(2_000);
    const text = await page.locator("body").innerText();
    expect(
      /elevation is required|Platform administrator only|not authorized|Access denied/i.test(text) ||
        page.url().includes("/login"),
      `read-only was not refused on ${route}`,
    ).toBe(true);
    await shoot(page, `${slug(route)}--unauthorized`);
  }

  await context.close();
});
