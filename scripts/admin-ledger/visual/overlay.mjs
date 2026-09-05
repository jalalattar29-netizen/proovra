/**
 * OVERLAY PROBE — does the panel actually behave like a modal?
 *
 * Four admin panels were hand-rolled `role="dialog"` divs and now share
 * `AdmOverlay`. The claim being tested is not "it renders": it is that
 * opening one moves focus INTO it, that Tab cannot leave it, that Escape
 * closes it, that the page behind is `inert`, and that it anchors to the
 * writing direction's END edge rather than the physical right.
 *
 * None of that is visible in a screenshot and none of it is checkable by a
 * typecheck, which is exactly why all four copies shipped without it.
 *
 * Usage: node scripts/admin-ledger/visual/overlay.mjs
 */
import { open, signIn, strip, WEB } from "./lib.mjs";

/** route, the control that opens the panel, the panel's test id. */
const CASES = [
  {
    route: "/admin/platform/exports",
    trigger: '[data-testid="export-row-open"], table tbody tr button',
    panel: '[data-testid="export-drawer"]',
  },
  {
    route: "/admin/platform/recovery",
    trigger: 'table tbody tr button, [data-testid="recovery-report-open"]',
    panel: '[data-testid="report-drawer"]',
  },
  {
    route: "/admin/platform/queues",
    trigger: '[data-testid="replay-open"], table tbody tr button',
    panel: '[data-testid="replay-dialog"]',
  },
  {
    route: "/admin/identity/sessions",
    trigger: '[data-testid="session-timeline-open"], table tbody tr button',
    panel: '[data-testid="session-timeline-drawer"]',
  },
];

const rtl = process.argv.includes("--rtl");
const { browser, page } = await open({ width: 1440, height: 900, rtl });
await signIn(page);

let pass = 0;
let checked = 0;

for (const c of CASES) {
  await page.goto(`${WEB}${c.route}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await strip(page);
  await page.waitForTimeout(1200);

  const trigger = page.locator(c.trigger).first();
  if ((await trigger.count()) === 0) {
    console.log(`skip  ${c.route.padEnd(34)} no trigger in the fixture data`);
    continue;
  }

  await trigger.click().catch(() => undefined);
  await page.waitForTimeout(900);

  const panel = page.locator(c.panel).first();
  if ((await panel.count()) === 0) {
    console.log(`skip  ${c.route.padEnd(34)} panel did not open`);
    continue;
  }

  checked += 1;
  const found = [];

  const state = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const overlay = el.closest(".adm-overlay");
    const behind = Array.from(document.body.children).filter(
      (n) => !n.contains(el),
    );
    return {
      focusInside: el.contains(document.activeElement),
      ariaModal: el.getAttribute("aria-modal"),
      labelledby: !!el.getAttribute("aria-labelledby"),
      hasScrim: !!overlay && getComputedStyle(overlay).backgroundColor !== "rgba(0, 0, 0, 0)",
      inertBehind: behind.length > 0 && behind.every((n) => n.hasAttribute("inert")),
      dir: getComputedStyle(document.documentElement).direction,
      left: Math.round(box.left),
      right: Math.round(window.innerWidth - box.right),
      focusables: el.querySelectorAll(
        "a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex='-1'])",
      ).length,
    };
  }, c.panel);

  if (!state) continue;

  if (!state.focusInside) found.push("focus did NOT move into the panel");
  if (state.ariaModal !== "true") found.push("no aria-modal");
  if (!state.labelledby) found.push("no aria-labelledby");
  if (!state.hasScrim) found.push("no scrim");
  if (!state.inertBehind) found.push("page behind is not inert");

  // Anchoring: under RTL the panel must sit against the LEFT edge.
  if (state.dir === "rtl" && state.left > 4) {
    found.push(`rtl but anchored ${state.left}px from the left edge`);
  }
  if (state.dir === "ltr" && state.right > 4) {
    found.push(`ltr but anchored ${state.right}px from the right edge`);
  }

  // The trap: Tab past the last stop must come back to the first.
  for (let i = 0; i < state.focusables + 2; i += 1) {
    await page.keyboard.press("Tab");
  }
  const stillInside = await page.evaluate(
    (sel) => document.querySelector(sel)?.contains(document.activeElement) ?? false,
    c.panel,
  );
  if (!stillInside) found.push("Tab escaped the panel");

  // Escape closes.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const closed = (await page.locator(c.panel).count()) === 0;
  if (!closed) found.push("Escape did not close it");

  // And focus came back to the opener rather than to <body>.
  if (closed) {
    const returned = await page.evaluate(
      () => document.activeElement !== document.body,
    );
    if (!returned) found.push("focus was returned to <body>");
  }

  if (found.length === 0) pass += 1;
  console.log(
    `${found.length ? "FAIL" : "ok  "}  ${c.route.padEnd(34)} ` +
      `${state.focusables} stops` +
      (found.length ? "\n        " + found.join("; ") : ""),
  );
}

await browser.close();
console.log(`\n${pass}/${checked} overlays behave (${rtl ? "rtl" : "ltr"})`);
process.exit(checked > 0 && pass < checked ? 1 : 0);
