/**
 * EVERY TAB IN THE CONSOLE, OPENED.
 *
 * =============================================================================
 * WHY THE LIST IS SHORT, AND WHY THAT IS THE ANSWER
 * =============================================================================
 * A grep of the admin tree for `role="tab"` returns ONE page:
 * /admin/identity/scim, with four. Every other section switches view through
 * the console's secondary navigation row, which is real links with real URLs —
 * which is what §10 asks for ("unrelated destinations must be links, not
 * tabs"). Two pages carry a time-window segmented control.
 *
 * So the complete tab surface is: 4 tabs + 2 window controls of 3 options.
 * This opens each one and records what is behind it.
 *
 * =============================================================================
 * WHAT IS CHECKED PER TAB
 * =============================================================================
 *   the correct panel is shown and the others are not
 *   exactly one tab is aria-selected
 *   the tab is URL-addressable and a reload returns to it
 *   Back leaves the page rather than silently changing tabs
 *   arrow keys move between tabs (the ARIA pattern, not just clicks)
 *   the panel's own heading structure, states and controls
 *   no body overflow at 1440 or at 390
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { open, signIn, visit, WEB } from "./lib.mjs";

const SCIM = "/admin/identity/scim";
const TABS = ["tokens", "ownership", "drift", "replay"];

const PANEL = () => {
  const doc = document.documentElement;
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const main = document.querySelector("main") || document.body;
  return {
    url: location.pathname + location.search,
    tabCount: tabs.length,
    selected: tabs.filter((t) => t.getAttribute("aria-selected") === "true").length,
    selectedLabel: tabs.find((t) => t.getAttribute("aria-selected") === "true")
      ?.textContent?.trim()
      .slice(0, 26),
    tabLabels: tabs.map((t) => (t.textContent || "").trim().slice(0, 22)),
    tabTargets: tabs.map((t) => {
      const r = t.getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)}`;
    }),
    overflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
    h1: [...document.querySelectorAll("h1")].map((h) => h.textContent.trim().slice(0, 26)),
    headings: [...main.querySelectorAll("h2,h3")].map((h) => h.tagName + ":" + h.textContent.trim().slice(0, 26)).slice(0, 5),
    // What state is the panel in?
    inlineStates: [...main.querySelectorAll("[data-ui-empty-state], .adm-inline")].map(
      (e) => (e.innerText || "").trim().slice(0, 40).replace(/\n/g, " | "),
    ),
    controls: [...main.querySelectorAll("button, select, input")].length,
    tableRows: main.querySelectorAll("tbody tr").length,
  };
};

const { browser, ctx, page } = await open();
await signIn(page);
const report = [];

/* ---------------------------------------------------------- SCIM: FOUR TABS */
for (const t of TABS) {
  // Reached by URL, which is the thing being proven.
  const q = t === "tokens" ? "" : `?tab=${t}`;
  await visit(page, `${SCIM}${q}`, 3000);
  const desktop = await page.evaluate(PANEL);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(900);
  const mobile = await page.evaluate(() => {
    const doc = document.documentElement;
    const row = document.querySelector('[role="tablist"]');
    return {
      overflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
      // The tab row must scroll inside ITSELF, not move the page.
      tablistScrolls: row ? row.scrollWidth > row.clientWidth : null,
      tablistOverflowX: row ? getComputedStyle(row).overflowX : null,
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);

  report.push({ tab: t, desktop, mobile });
  console.log(
    `${(SCIM + q).padEnd(40)} selected="${desktop.selectedLabel}" one-selected=${desktop.selected === 1} url=${desktop.url} rows=${desktop.tableRows} controls=${desktop.controls} overflow=${desktop.overflow} mobileOverflow=${mobile.overflow}`,
  );
  console.log(`      targets ${desktop.tabTargets.join(" ")}`);
  for (const s of desktop.inlineStates) console.log(`      state: ${s}`);
}

/* ------------------------------------- SCIM: keyboard + reload + Back */
{
  await visit(page, SCIM, 3000);
  await page.locator('[role="tab"]').first().focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(600);
  const afterArrow = await page.evaluate(PANEL);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const afterReload = await page.evaluate(PANEL);

  // Where does Back go? It should LEAVE the page, because tab changes use
  // replace() rather than push() — four peer views should not build four
  // history entries.
  await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(1500);
  const afterBack = await page.evaluate(() => location.pathname + location.search);

  console.log("\n=== SCIM keyboard + persistence ===");
  console.log(`  ArrowRight  -> selected="${afterArrow.selectedLabel}" url=${afterArrow.url}`);
  console.log(`  reload      -> selected="${afterReload.selectedLabel}" url=${afterReload.url}`);
  console.log(`  Back        -> ${afterBack}`);
  report.push({ keyboard: { afterArrow, afterReload, afterBack } });
}

/* --------------------------------------------- THE TWO WINDOW CONTROLS */
for (const route of ["/admin/dashboard", "/admin/platform/analytics"]) {
  await visit(page, route, 3500);
  const win = await page.evaluate(() => {
    const main = document.querySelector("main") || document.body;
    const opts = [...main.querySelectorAll("button")].filter((b) =>
      /^(24 hours|7 days|30 days)$/.test((b.textContent || "").trim()),
    );
    return {
      options: opts.map((b) => (b.textContent || "").trim()),
      targets: opts.map((b) => {
        const r = b.getBoundingClientRect();
        return `${Math.round(r.width)}x${Math.round(r.height)}`;
      }),
      // Which one reads as chosen, and is that stated in more than a colour?
      pressed: opts.map((b) => ({
        label: (b.textContent || "").trim(),
        ariaPressed: b.getAttribute("aria-pressed"),
        ariaCurrent: b.getAttribute("aria-current"),
        disabled: b.disabled,
      })),
      url: location.pathname + location.search,
    };
  });
  console.log(`\n=== window control: ${route}`);
  console.log("  " + JSON.stringify(win));
  report.push({ route, window: win });
}

mkdirSync("artifacts/admin-visual-review", { recursive: true });
writeFileSync(
  "artifacts/admin-visual-review/tabs.json",
  JSON.stringify({ report }, null, 2),
  "utf8",
);
await ctx.close();
await browser.close();
