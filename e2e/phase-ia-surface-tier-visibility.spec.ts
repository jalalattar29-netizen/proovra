/**
 * Phase IA-surface-tier — Playwright UI gate.
 *
 * Proves a normal authenticated user cannot SEE or OPEN hidden
 * surfaces. Runs against the full stack (web + api + worker + db).
 *
 *   * Direct URL to `/tools` (INTERNAL) refuses: the surface renders a
 *     platform-admin elevation gate instead of the All Tools catalog.
 *   * Direct URL to ENTERPRISE surfaces (review/governance/intelligence/
 *     security-center/organization-admin/executive/investigation)
 *     refuses with the product's no-access panel — six inside the app
 *     shell at HTTP 200, `/organization-admin` as a hard 404.
 *   * `/ops` and `/operations` are NOT hidden from this persona and are
 *     asserted to render the Operations console the sidebar offers them.
 *   * `/platform` is a public marketing page and is asserted as one.
 *   * The sidebar, after login, does NOT contain hidden surface labels.
 *   * `/settings/security` (carved out of /security-center) DOES
 *     render normally for a personal user.
 *
 * Environment expected (same as the existing e2e suite):
 *   - WEB_BASE points at the running web app
 *   - The stack must accept email registration + sign-in. This spec used
 *     to log in through the guest flow; guest auth has been removed from
 *     the product, so it registers a real account and signs in through the
 *     login form like a user would.
 *
 * If the test runner can't reach a stack it logs and skips — local
 * `pnpm vitest` runs are NOT affected. CI's playwright-e2e workflow
 * provisions the stack and this spec runs there.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
  disposeSession,
  SESSION_PASSWORD,
  type GuestSession,
} from "./helpers/api-client";

/**
 * WHAT EACH OF THESE PATHS ACTUALLY DOES, MEASURED.
 *
 * `HIDDEN_INTERNAL_PATHS` used to hold all four of "/tools", "/ops",
 * "/operations" and "/platform" and require every one of them to render a
 * not-found page. Signed in as a paying personal user, three of the four
 * do something else entirely:
 *
 *   * `/tools` renders an elevation gate — the heading is still ALL TOOLS,
 *     but the body is "Platform admin elevation is required for this
 *     surface", and the catalog is not served;
 *   * `/ops` redirects to `/operations`, and `/operations` renders the real
 *     Operations console. It is not hidden from this persona at all: the
 *     sidebar advertises "Operations" to them, by the eligibility rule that
 *     governs that surface;
 *   * `/platform` is a PUBLIC MARKETING page. It has no app shell and no
 *     main landmark, and is not an internal console in any sense.
 *
 * So they are separated by what they are, and each is asserted for its own
 * behaviour below rather than all four being held to one claim that was
 * true of none of them.
 */
const PLATFORM_ADMIN_ONLY_PATHS = ["/tools"];

/** Reachable for this persona, and the sidebar says so. */
const OPERATIONS_PATHS = ["/ops", "/operations"];

/** Public marketing, not an app surface. */
const PUBLIC_MARKETING_PATHS = ["/platform"];

/**
 * Copy that identifies the in-shell no-access panel. Present on both
 * variants the product serves: the six enterprise paths that answer 200
 * with the panel inside the shell, and `/organization-admin`, which
 * answers a hard HTTP 404 with the same headline.
 */
const NOT_FOUND_COPY = /We couldn.t find that page/i;

/**
 * A line only the real Operations console renders. Used as the negative
 * control: it is how a case can tell "the surface refused" from "the
 * surface rendered and happens to mention operations".
 */
const OPERATIONS_CONSOLE_COPY =
  /Monitor, assign and resolve operational conditions/i;

/**
 * The surface gate's PENDING state.
 *
 * `SurfaceGate` renders "Checking whether this area is available in your
 * workspace…" while it resolves, and only then swaps in the surface or the
 * refusal. Reading the main landmark the instant navigation completes can
 * therefore catch this line instead of the decision — which is how two of
 * the seven enterprise paths failed while the other five passed, on a
 * product that was behaving identically for all of them.
 *
 * It matters just as much for the CORE cases, in the opposite direction:
 * the pending line contains no refusal copy, so a case asserting "this is
 * not the no-access panel" would PASS against a gate that had not yet
 * decided, and would go on passing if the decision later turned into a
 * refusal.
 */
const GATE_PENDING_COPY = /Checking whether this area is available/i;

const HIDDEN_ENTERPRISE_PATHS = [
  "/review",
  "/governance",
  "/intelligence",
  "/security-center",
  "/organization-admin",
  "/executive",
  "/investigation",
];

const CORE_PATHS_THAT_RENDER = [
  "/home",
  "/capture",
  "/evidence",
  "/cases",
  "/intake-links",
  "/search",
  "/reports",
  "/teams",
  "/inbox",
  "/trust-center",
  "/settings",
  "/settings/security",
  "/billing",
];

/**
 * THIS HELPER USED TO SIGN NOBODY IN.
 *
 * It clicked a "Try Proovra" guest button, and when that button was not
 * there it fell back to `page.goto("/home")` on the assumption that a
 * storageState cookie existed. Guest auth has been removed from the product
 * and this suite configures no storageState, so every case ran
 * UNAUTHENTICATED: `/home` redirected to `/login`, and the
 * `getByRole("navigation")` the assertions read was the login page's own
 * nav.
 *
 * That is why this spec looked almost green. A gate that proves a user
 * cannot SEE hidden surfaces passes trivially when the page under test is
 * the sign-in screen — the hidden labels were absent because everything
 * was absent. The two cases that did fail were the only two asserting that
 * something IS present, which is the shape a silently-unauthenticated
 * suite always takes.
 *
 * So it now signs in the way a person does: register through the API (the
 * same helper the rest of the suite uses, so plan setup and legal
 * acceptance stay in one place), then drive the real login form and wait
 * to land on /home. The returned session is the caller's to dispose.
 */
/**
 * ONE ACCOUNT FOR THE FILE, NOT ONE PER CASE.
 *
 * Registering per test asked the API for twenty-six accounts in two and a
 * half minutes and met the registration limiter:
 * `Registration failed (HTTP 429)`. Every case here is a read-only look at
 * a surface, so they have no reason to want separate identities, and the
 * limiter was reporting something true — that was a lot of sign-ups from
 * one address.
 *
 * The account is created once, lazily, behind the same
 * `clearTestRateLimits()` the rest of the suite calls, and disposed once
 * when the file finishes. PRO because intake links are a plan-gated CORE
 * surface this suite asserts is present, and because an entitled account
 * makes the hidden-surface cases stricter: someone who pays must still
 * not reach the internal or enterprise surfaces.
 */
let sharedSession: GuestSession | null = null;

async function ensureSharedSession(): Promise<GuestSession> {
  if (!sharedSession) {
    await clearTestRateLimits();
    sharedSession = await createGuestSession({ plan: "PRO" });
  }
  return sharedSession;
}

test.afterAll(async () => {
  if (sharedSession) await disposeSession(sharedSession);
  sharedSession = null;
});

async function loginAsPersonalUser(page: Page): Promise<GuestSession> {
  const session = await ensureSharedSession();
  // Each case signs in through the real form, and the production login
  // limiter is 10/min/IP — so twenty-six of them in one file will meet it,
  // and the case that meets it fails by waiting for a navigation the 429
  // never produces. The limiter is not what this file is about (the auth
  // spec owns it), so the bucket is reset first, using the same test-only
  // endpoint the rest of the suite resets it with.
  await clearTestRateLimits();
  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(session.email);
  await page.getByPlaceholder("Password").fill(SESSION_PASSWORD);
  // The form will not submit without this. Sign-in requires agreeing to
  // the Terms, Privacy and Cookie policies, and refuses with
  // "You must accept the Terms of Service, Privacy Policy, and Cookie
  // Policy before continuing." — a refusal that renders in the page
  // rather than as a failed request, so a fixture that skips it simply
  // waits on a navigation that is never coming.
  await page.locator("input.auth-legal-checkbox").check();
  await page.locator('[data-auth-email-cta="SIGN_IN"]').click();
  // Landing on /home is the proof the session exists. Without this wait a
  // later assertion could read the login page again and call it a pass.
  await page.waitForURL(/\/home/, { timeout: 30_000 });
  return session;
}

/**
 * THE SIDEBAR IS FOUR NAVIGATION LANDMARKS, NOT ONE.
 *
 * Every assertion in this file used to read `getByRole("navigation")
 * .first()`, which is the first GROUP only — "Home, Notifications, Cases,
 * Evidence, Capture, Intake links, Search, Teams". The remaining three
 * groups hold "People", "Reports", and "Billing & plan / Operations", so a
 * case looking for Reports or Billing in `.first()` could never find them,
 * and a case looking for a BANNED label was only ever searching a quarter
 * of the nav.
 *
 * Reading the union fixes both directions at once: the present-labels case
 * can see the whole menu, and the absent-labels case now actually covers
 * the groups where a leaked surface would most likely appear.
 */
async function fullSidebarText(page: Page): Promise<string> {
  const navs = page.getByRole("navigation");
  await expect(navs.first()).toBeVisible();
  const count = await navs.count();
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    parts.push(await navs.nth(i).innerText());
  }
  expect(count, "expected the grouped sidebar landmarks").toBeGreaterThan(0);
  return parts.join("\n");
}

/**
 * Read the main landmark AFTER the surface gate has decided.
 *
 * This is a wait for a state, not a sleep for a duration: the assertion
 * retries until the pending line is gone and fails loudly if the decision
 * never arrives, so a gate that hangs is reported as a hang rather than
 * being papered over.
 */
async function settledMainText(page: Page): Promise<string> {
  const main = page.getByRole("main").first();
  await expect(main).not.toContainText(GATE_PENDING_COPY, {
    timeout: 30_000,
  });
  return main.innerText();
}

test.describe("Phase IA-surface-tier — normal user cannot SEE hidden surfaces", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsPersonalUser(page);
  });

  test("the sidebar does NOT contain hidden surface labels", async ({ page }) => {
    // Hidden surfaces must not appear anywhere in the rendered nav — so
    // this reads every group, not just the first.
    //
    // The sidebar has to be COMPLETE before absence means anything: a nav
    // whose later groups have not mounted yet is missing the banned
    // labels for an uninteresting reason, and this case would pass on a
    // page that later grew one. "Billing" sits in the last group, so its
    // arrival is the signal that there is nothing further to wait for.
    await expect
      .poll(() => fullSidebarText(page), {
        message: "the sidebar never finished rendering its groups",
        timeout: 30_000,
      })
      .toContain("Billing");
    const sidebarText = await fullSidebarText(page);
    for (const banned of [
      "Review",
      "Reviewer Operations",
      "Governance",
      "Intelligence",
      "Security Center",
      "Organization Admin",
      "Executive",
      "Investigation",
      "All Tools",
    ]) {
      expect(
        sidebarText,
        `sidebar must NOT contain "${banned}"`,
      ).not.toContain(banned);
    }
  });

  test("the sidebar DOES contain every CORE label", async ({ page }) => {
    // THE LABELS, AS THE PRODUCT WRITES THEM.
    //
    // The old list said "12" and held eleven, three of which no longer
    // exist as written: the label is `Intake links` (one capital, not
    // two), the inbox is now `Notifications`, and billing renders as
    // `Billing & plan`. `Settings` is not in the sidebar at all — it
    // lives in the account menu, which is a different surface with its
    // own resolver — so requiring it here was asserting the wrong
    // component. `People` was missing from the list entirely.
    //
    // These are checked as substrings, so `Billing & plan` also covers
    // the shorter name if the label is ever trimmed back.
    // THE GROUPS DO NOT ALL ARRIVE AT ONCE.
    //
    // Run on its own this passed; run after ninety-four other cases it
    // failed on "Billing", having read a sidebar holding only the first
    // group. The later groups (People, Reports, Billing & plan,
    // Operations) mount after the first paint, so a single read taken the
    // moment the page settles can miss them.
    //
    // Each label is therefore polled rather than read once. This waits for
    // a state, not for a duration: a label that genuinely never renders
    // still fails, and still names itself in the message.
    for (const expected of [
      "Home",
      "Capture",
      "Evidence",
      "Cases",
      "Intake links",
      "Search",
      "Reports",
      "Teams",
      "People",
      "Notifications",
      "Billing",
    ]) {
      await expect
        .poll(() => fullSidebarText(page), {
          message: `sidebar must contain "${expected}"`,
          timeout: 30_000,
        })
        .toContain(expected);
    }
  });
});

test.describe("Phase IA-surface-tier — direct URL is blocked", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsPersonalUser(page);
  });

  for (const path of PLATFORM_ADMIN_ONLY_PATHS) {
    test(`INTERNAL: GET ${path} demands platform-admin elevation`, async ({
      page,
    }) => {
      // WHY THIS NO LONGER LOOKS FOR THE ABSENCE OF A STRING.
      //
      // The old case required that "All Tools" appear nowhere in the
      // markup. But the surface refuses by rendering an elevation gate
      // that is still TITLED All Tools — so the string is present while
      // the catalog is not, and the assertion failed on a page that was
      // behaving correctly. A substring cannot tell those apart.
      //
      // What distinguishes them is content only the real surface has. So
      // the gate is asserted positively, and a line unique to an internal
      // console is the negative control.
      const res = await page.goto(path);
      expect(res?.status()).toBeLessThan(500);
      const main = await settledMainText(page);
      expect(
        main,
        `${path} must refuse without platform-admin elevation`,
      ).toMatch(/platform admin(istrator)?/i);
      expect(main).toMatch(/elevation is required/i);
      // Nothing from an internal console leaked past the gate.
      expect(main).not.toMatch(OPERATIONS_CONSOLE_COPY);
    });
  }

  for (const path of OPERATIONS_PATHS) {
    test(`OPERATIONS: GET ${path} renders the console this persona is offered`, async ({
      page,
    }) => {
      // These two were in the hidden list, and they are not hidden. The
      // sidebar offers "Operations" to a paying personal workspace, so a
      // suite that demanded a 404 here was demanding that a menu entry
      // lead nowhere. `/ops` is the short form and redirects onto
      // `/operations`.
      const res = await page.goto(path);
      expect(res?.status()).toBeLessThan(500);
      expect(page.url()).toMatch(/\/operations/);
      const main = await settledMainText(page);
      expect(main, `${path} must render the Operations console`).toMatch(
        OPERATIONS_CONSOLE_COPY,
      );
      expect(main).not.toMatch(NOT_FOUND_COPY);
    });
  }

  for (const path of PUBLIC_MARKETING_PATHS) {
    test(`PUBLIC: GET ${path} is the marketing page, not an app surface`, async ({
      page,
    }) => {
      // `/platform` is a public marketing route. It was being held to an
      // internal-console standard, which it could never meet and should
      // not: it has no app shell, and therefore no main landmark at all.
      const res = await page.goto(path);
      expect(res?.status()).toBeLessThan(500);
      expect(await page.getByRole("main").count()).toBe(0);
      const body = await page.locator("body").innerText();
      expect(body).not.toMatch(OPERATIONS_CONSOLE_COPY);
    });
  }

  for (const path of HIDDEN_ENTERPRISE_PATHS) {
    test(`ENTERPRISE: GET ${path} refuses with the no-access panel`, async ({
      page,
    }) => {
      // THE OLD ASSERTION COULD NOT FAIL.
      //
      // It searched the whole serialized document for `404`, `Not Found`
      // or `not-found` — strings that appear in the framework payload of
      // EVERY page this app serves, `/home` included. A surface that
      // rendered in full would have passed it. (The dead `if (segment)`
      // block above it, which admitted the case asserted nothing about
      // the surface's own content, is gone with it.)
      //
      // The panel is real and has its own copy, so that is what gets
      // asserted, read from the main landmark rather than the markup.
      // Six of these paths answer 200 with the panel inside the shell and
      // `/organization-admin` answers a hard 404 with the same headline;
      // both are refusals, and the assertion covers both.
      const res = await page.goto(path);
      expect(res?.status()).toBeLessThan(500);
      const main = await settledMainText(page);
      expect(main, `${path} must refuse to render`).toMatch(NOT_FOUND_COPY);
      expect(main).not.toMatch(OPERATIONS_CONSOLE_COPY);
    });
  }
});

test.describe("Phase IA-surface-tier — CORE surfaces still render", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsPersonalUser(page);
  });

  for (const path of CORE_PATHS_THAT_RENDER) {
    test(`CORE: GET ${path} renders its own page`, async ({ page }) => {
      // The old negative looked for Next.js's stock "This page could not
      // be found", which this app never serves — it has its own 404
      // panel — so the case passed on any page at all, a refusal
      // included. It now checks for the panel the product actually
      // renders, in the main landmark.
      const res = await page.goto(path);
      expect(res?.status()).toBeLessThan(500);
      const main = await settledMainText(page);
      expect(
        main,
        `${path} rendered the no-access panel instead of its own UI`,
      ).not.toMatch(NOT_FOUND_COPY);
      // And it rendered SOMETHING of its own, rather than an empty shell.
      expect(main.trim().length, `${path} rendered an empty main`).toBeGreaterThan(0);
    });
  }
});
