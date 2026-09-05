/**
 * OPEN ALL 47 ADMIN ROUTES AND LOOK AT THEM.
 *
 * =============================================================================
 * WHY A SEPARATE SPEC FROM admin-matrix
 * =============================================================================
 * `admin-matrix` answers "does this route behave for this role at this width":
 * status codes, overflow, target sizes, focus. It is a correctness sweep and it
 * runs 47 routes × 7 roles × 8 viewports, so it deliberately captures almost
 * nothing.
 *
 * This one answers a different question — "what does the page LOOK like, and is
 * it composed" — for one role at two widths. It renders every route full-page,
 * writes the image, and records the measurements a person cannot eyeball
 * reliably across 47 pages:
 *
 *   how many screens tall the page is        (unnecessarily long pages)
 *   how many cards, and how many hold one    (single-value card walls)
 *     number
 *   the largest vertical gap between blocks  (excessive whitespace)
 *   how many distinct surface colours,       (repetitive white card walls)
 *     borders and shadows are in play
 *   how much red is on screen, and whether   (decorative red)
 *     it sits on a proven failure
 *   heading structure and H1 count           (visual hierarchy)
 *   filter position relative to the table    (filter placement)
 *   primary-action count                     (button hierarchy)
 *
 * The images are the review. The numbers are what makes the review repeatable
 * and what a diff can be taken against after a fix.
 *
 * =============================================================================
 * WHY THE IN-APP BROWSER PANE WAS NOT USED
 * =============================================================================
 * It mis-composites a scrolled page with a sticky header: the header paints
 * mid-document and content below the fold comes back blank. The DOM was intact
 * every time, so the pane is fine for reading structure and driving clicks and
 * wrong for judging appearance. Playwright's full-page capture is the reliable
 * surface, and item 8 requires Playwright captures regardless.
 *
 * Usage:
 *   npx playwright test admin-visual-review --config apps/web/e2e/admin-control-plane/playwright.config.ts
 *   PROOVRA_REVIEW_ROUTES=/admin,/admin/costs npx playwright test admin-visual-review …
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type BrowserContext, type Page } from "@playwright/test";

import { CONSENT_VERSION } from "../../lib/consent";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const WEB = process.env.PROOVRA_WEB_ORIGIN ?? "http://localhost:3311";
const OUT = resolve(REPO, "artifacts/admin-visual-review");
const SHOTS = resolve(OUT, "screenshots");

const PASSWORD = "fixture-local-only-password";
const ADMIN = "platform-admin@fixture.local";

/** Hard-coded to match services/api/scripts/seed-admin-fixture.ts. */
const SEEDED: Record<string, string> = {
  "/admin/customers/:id": "0adf0000-0000-4000-8000-0000000000a1",
  "/admin/workspaces/:id": "0adf0000-0000-4000-8000-0000000000b1",
  "/admin/users/:id": "0adf0000-0000-4000-8000-000000000002",
  "/admin/demo-requests/:id": "0adf0000-0000-4000-8000-0000000000e1",
  "/admin/contact-sales/:id": "0adf0000-0000-4000-8000-0000000000e2",
  "/admin/platform/runbooks/:slug": "tsa-timestamp-failure",
};

const concrete = (route: string) =>
  SEEDED[route] ? route.replace(/\/:(id|slug)$/, `/${SEEDED[route]}`) : route;

function routes(): string[] {
  const override = process.env.PROOVRA_REVIEW_ROUTES;
  if (override) return override.split(",").map((s) => s.trim()).filter(Boolean);
  const raw = execFileSync(
    process.execPath,
    [resolve(REPO, "apps/web/scripts/admin-inventory.mjs"), "--json"],
    { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return (JSON.parse(raw).rows as Array<{ route: string }>).map((r) => r.route);
}

const slug = (route: string) =>
  route.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+$/, "");

/**
 * The consent banner, neutralised before the first paint.
 *
 * It mounts late, overlays the page bottom, and intercepts clicks. Three
 * attempts at dismissing it after load all raced; seeding the decision plus
 * hiding the element is what actually holds.
 */
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
    style.textContent =
      "#cc-main{display:none!important;pointer-events:none!important}";
    const attach = () => document.head?.appendChild(style);
    // addInitScript runs BEFORE the document exists, so a DOMContentLoaded
    // listener registered unconditionally never fires on a document that is
    // already parsed by the time the script re-runs on a soft navigation.
    if (document.head) attach();
    else document.addEventListener("DOMContentLoaded", attach, { once: true });
  });
}

async function signIn(page: Page) {
  // networkidle, not domcontentloaded: the consent banner mounts after
  // hydration and re-renders the controlled login inputs, silently emptying a
  // fill that happened a moment earlier.
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
  await page.locator('button[type="submit"]:visible').first().click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 });
}

/**
 * Everything measurable about how the page is composed.
 *
 * Runs in the page. Deliberately returns raw numbers rather than verdicts —
 * a threshold belongs in the review, not in the instrument, because "six cards
 * is too many" is true of a summary and false of a roster.
 */
const MEASURE = `(() => {
  const px = (v) => parseFloat(v) || 0;
  const doc = document.documentElement;
  const main = document.querySelector('main') || document.body;

  const isCardish = (el) => {
    const s = getComputedStyle(el);
    const bordered = px(s.borderTopWidth) > 0 || px(s.borderBottomWidth) > 0;
    const shadowed = s.boxShadow && s.boxShadow !== 'none';
    const rounded = px(s.borderTopLeftRadius) >= 4;
    const r = el.getBoundingClientRect();
    return (bordered || shadowed) && rounded && r.height > 24 && r.width > 80;
  };

  const all = [...main.querySelectorAll('div,section,article,li')];
  const cards = all.filter(isCardish);

  // A card whose whole text is a short label plus a number.
  const oneValue = cards.filter((c) => {
    if (cards.some((o) => o !== c && o.contains(c))) return false;
    const t = (c.innerText || '').trim();
    if (t.length > 90) return false;
    return /\\d/.test(t) && t.split(/\\n+/).filter(Boolean).length <= 3;
  });

  const surfaces = {};
  const borders = {};
  const shadows = {};
  for (const c of cards) {
    const s = getComputedStyle(c);
    surfaces[s.backgroundColor] = (surfaces[s.backgroundColor] || 0) + 1;
    borders[s.borderTopColor + ' ' + s.borderTopWidth] =
      (borders[s.borderTopColor + ' ' + s.borderTopWidth] || 0) + 1;
    if (s.boxShadow !== 'none') shadows[s.boxShadow] = (shadows[s.boxShadow] || 0) + 1;
  }

  // Red anywhere it is painted, and what text sits in it.
  const REDISH = (c) => {
    const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(c || '');
    if (!m) return false;
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    return r > 130 && r - g > 45 && r - b > 45;
  };
  const reds = [];
  for (const el of all.slice(0, 4000)) {
    const s = getComputedStyle(el);
    if (REDISH(s.backgroundColor) || REDISH(s.color) || REDISH(s.borderTopColor)) {
      const t = (el.innerText || '').trim().slice(0, 48);
      if (t) reds.push(t);
    }
  }

  // The largest vertical gap between consecutive top-level blocks.
  const blocks = [...main.children].flatMap((c) => [...c.children]);
  let maxGap = 0, gapAfter = '';
  for (let i = 1; i < blocks.length; i += 1) {
    const a = blocks[i - 1].getBoundingClientRect();
    const b = blocks[i].getBoundingClientRect();
    const gap = b.top - a.bottom;
    if (gap > maxGap) {
      maxGap = gap;
      gapAfter = (blocks[i - 1].innerText || '').trim().slice(0, 40);
    }
  }

  const tables = [...main.querySelectorAll('table')];
  // Row height is the single best predictor of an unnecessarily long page:
  // a table row should be 40-60px, and /admin/identity/sessions was at 205
  // because one cell dumped a raw user-agent.
  const rowStats = tables.map((t) => {
    const rows = [...t.querySelectorAll('tbody tr')];
    if (rows.length === 0) return { rows: 0, medianRowH: 0, tallestRowH: 0 };
    const hs = rows.map((r) => r.getBoundingClientRect().height).sort((a, b) => a - b);
    return {
      rows: rows.length,
      medianRowH: Math.round(hs[Math.floor(hs.length / 2)]),
      tallestRowH: Math.round(hs[hs.length - 1]),
    };
  });
  const filterFirst = (() => {
    const f = main.querySelector('[class*="filter"],[data-testid*="filter"],select');
    const t = tables[0] || main.querySelector('[role="table"]');
    if (!f || !t) return null;
    return f.getBoundingClientRect().top <= t.getBoundingClientRect().top;
  })();

  return {
    scrollHeight: doc.scrollHeight,
    screensTall: +(doc.scrollHeight / window.innerHeight).toFixed(1),
    overflowX: doc.scrollWidth > doc.clientWidth + 1,
    h1: [...document.querySelectorAll('h1')].map((e) => e.textContent.trim()),
    headings: [...main.querySelectorAll('h1,h2,h3,h4')].map(
      (e) => e.tagName + ':' + e.textContent.trim().slice(0, 44),
    ),
    cards: cards.length,
    oneValueCards: oneValue.length,
    oneValueText: oneValue.slice(0, 8).map((c) => (c.innerText || '').replace(/\\n+/g, ' | ').slice(0, 60)),
    distinctSurfaces: Object.keys(surfaces).length,
    surfaces,
    distinctBorders: Object.keys(borders).length,
    distinctShadows: Object.keys(shadows).length,
    redCount: reds.length,
    redText: reds.slice(0, 10),
    maxGap: Math.round(maxGap),
    gapAfter,
    tables: tables.length,
    rowStats,
    filterAboveTable: filterFirst,
    primaryActions: main.querySelectorAll('[class*="primary"],[data-variant="primary"]').length,
    buttons: main.querySelectorAll('button').length,
    longParagraphs: [...main.querySelectorAll('p')]
      .map((p) => (p.innerText || '').trim())
      .filter((t) => t.length > 160).length,
  };
})()`;

/**
 * Remove the consent overlay from the captured page, and SAY SO.
 *
 * The decision is seeded in localStorage before first paint, and in a normal
 * browser that is enough — the banner never mounts. Under Playwright it still
 * appeared over the middle of /admin/costs, which means something other than
 * that key decides whether it renders. Hiding it by stylesheet did not work
 * either, so it is removed from the DOM.
 *
 * The count is reported per route rather than swallowed: a capture that needed
 * an overlay removed is a capture of a page that was showing a consent prompt
 * to a signed-in platform admin, and that is worth knowing even though it is
 * not what this review is about.
 */
async function stripConsentOverlay(page: Page): Promise<number> {
  return page.evaluate(() => {
    const nodes = new Set<Element>();
    for (const el of document.querySelectorAll(
      '#cc-main, [class*="cc--"], [data-nosnippet]',
    )) {
      nodes.add(el);
    }
    for (const el of document.body.querySelectorAll("div,section,aside")) {
      const s = getComputedStyle(el);
      if (s.position !== "fixed") continue;
      if (!/Privacy Preferences|Cookie Policy/.test(el.textContent ?? "")) continue;
      nodes.add(el);
    }
    for (const n of nodes) n.remove();
    return nodes.size;
  });
}

const VIEWS = [
  { id: "desktop", width: 1440, height: 900 },
  { id: "mobile", width: 390, height: 844 },
] as const;

test.describe.configure({ mode: "serial" });

test("render and measure every admin route", async ({ browser }) => {
  test.setTimeout(30 * 60_000);
  mkdirSync(SHOTS, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await seedConsent(context);
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });

  await signIn(page);

  const report: Record<string, unknown>[] = [];

  for (const route of routes()) {
    const url = `${WEB}${concrete(route)}`;
    const row: Record<string, unknown> = { route, url };

    for (const view of VIEWS) {
      await page.setViewportSize({ width: view.width, height: view.height });
      consoleErrors.length = 0;
      const res = await page
        .goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 })
        .catch(() => null);
      /*
       * WAIT FOR THE DATA, AND THEN WAIT LONGER.
       *
       * 2,500ms was not enough and the failure mode was the worst kind: it
       * produced a plausible NUMBER. /admin/platform-health captured mid-load
       * measured 900px against a 2,391px baseline and appeared in the
       * before/after table as a 1,491px improvement — the single largest
       * "win" on the branch. It was a screenshot of a loading row.
       *
       * That page fans out to the runtime-readiness, signer, queue,
       * observability and provider probes, and on a freshly re-seeded fixture
       * those are cold. A capture harness that races the slowest page on the
       * console does not under-report; it invents results.
       *
       * The network is asked first and the timeout is the ceiling, not the
       * plan, so a fast page still costs a fraction of a second.
       */
      await page
        .waitForLoadState("networkidle", { timeout: 12_000 })
        .catch(() => {
          /* A page with a poll or a live connection never goes idle. The
             floor below is what covers it. */
        });
      await page.waitForTimeout(1_500);

      const overlaysRemoved = await stripConsentOverlay(page).catch(() => 0);

      const file = `${slug(route)}--${view.id}.png`;
      await page
        .screenshot({ path: resolve(SHOTS, file), fullPage: true })
        .catch(() => {});

      const m = await page.evaluate(MEASURE).catch((e) => ({ error: String(e) }));
      row[view.id] = {
        status: res?.status() ?? null,
        overlaysRemoved,
        screenshot: `artifacts/admin-visual-review/screenshots/${file}`,
        consoleErrors: [...consoleErrors],
        ...(m as object),
      };
    }
    report.push(row);
    const last = report.at(-1) as {
      desktop: { screensTall: number; cards: number; oneValueCards: number };
    };
    // eslint-disable-next-line no-console
    console.log(
      `${route.padEnd(38)} ${JSON.stringify(last.desktop.screensTall)}` +
        ` screens · ${last.desktop.cards} cards` +
        ` · ${last.desktop.oneValueCards} one-value`,
    );
  }

  writeFileSync(
    resolve(OUT, "review.json"),
    JSON.stringify({ generatedFrom: WEB, routes: report }, null, 2),
    "utf8",
  );
  await context.close();
});
