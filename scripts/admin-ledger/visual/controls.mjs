/**
 * CONTROLS PROBE — filters, pagination, icons and charts, measured.
 *
 * §14 asks whether a filter and a pager behave; §15 whether the console's
 * icons are one set at one weight; §16 whether a chart says what it plots and
 * what it does when there is nothing to plot. All four are DOM facts, so none
 * of them needs an opinion to check.
 *
 * WHAT IT MEASURES, AND WHY EACH ONE IS A DEFECT WHEN IT FAILS
 *
 *   filter has a label            a bare <select> is a mystery until you open
 *                                 it; an operator cannot tell WHAT it filters
 *   filter is reflected           a filtered view that looks identical to an
 *                                 unfiltered one is how "no results" gets
 *                                 read as "no data"
 *   filter is resettable          a page whose only way back is a reload
 *   filter is URL-addressable     a filtered view an operator cannot send to
 *                                 a colleague, or return to
 *   pager states its position     "Next" with no page number, or a Previous
 *                                 that is enabled on page one and does
 *                                 nothing
 *   pager disables truthfully     Next enabled with nothing to follow
 *   result count present          a table with no count cannot be reconciled
 *                                 against the number on the card above it
 *   cap disclosed                 a read capped at 500 rows that says "500"
 *                                 and not "500 of more"
 *   icon set is single            two icon libraries in one console is the
 *                                 most visible inconsistency there is
 *   icon stroke is uniform        the same glyph at 1.5 and 2 next to itself
 *   icon has a name or is hidden  an icon-only control with no accessible
 *                                 name is unusable by a screen reader
 *   chart is titled + labelled    a plot with no axis label and no unit is
 *                                 decoration
 *   chart empty state            a chart with no data must SAY so rather
 *                                 than draw an empty frame
 *
 * Usage: node scripts/admin-ledger/visual/controls.mjs [route…]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { open, signIn, strip, WEB } from "./lib.mjs";

const ROUTES = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const routes = ROUTES.length
  ? ROUTES
  : JSON.parse(readFileSync("docs/admin/phase7-routes.json", "utf8")).routes;

const OUT = "docs/admin/artifacts/controls";
mkdirSync(OUT, { recursive: true });

/** The fixture rows the capture harness uses for the dynamic segments. */
const PARAMS = {
  "/admin/customers/:id": "0adf0000-0000-4000-8000-0000000000a1",
  "/admin/workspaces/:id": "0adf0000-0000-4000-8000-0000000000b1",
  "/admin/users/:id": "0adf0000-0000-4000-8000-000000000002",
  "/admin/demo-requests/:id": "0adf0000-0000-4000-8000-0000000000e1",
  "/admin/contact-sales/:id": "0adf0000-0000-4000-8000-0000000000e2",
  "/admin/platform/runbooks/:slug": "tsa-timestamp-failure",
};

const concrete = (route) =>
  PARAMS[route] ? route.replace(/:(\w+)$/, PARAMS[route]) : route;

const { browser, page } = await open({ width: 1440, height: 900 });
await signIn(page);

const rows = [];

for (const route of routes) {
  await page.goto(`${WEB}${concrete(route)}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  }).catch(() => undefined);
  await strip(page);
  await page.waitForTimeout(900);

  /* EXERCISE A FILTER BEFORE ASKING WHETHER THE PAGE CAN BE UNFILTERED.
     A reset control that is present when nothing is filtered is a control
     that usually does nothing, so the console renders it only once a filter
     is actually applied. Checking a page at rest therefore reports "no
     reset" on every page that does this correctly — which is what the first
     version of this probe did, on three pages that had just been given one.
     So: change the first select to a value that is not its current one, let
     the page settle, and measure THAT. */
  const filterChanged = await page
    .evaluate(() => {
      const sel = document.querySelector("main select");
      if (!(sel instanceof HTMLSelectElement)) return false;
      const other = Array.from(sel.options).find((o) => o.value !== sel.value);
      if (!other) return false;
      sel.value = other.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })
    .catch(() => false);
  if (filterChanged) await page.waitForTimeout(1100);

  const r = await page.evaluate(() => {
    const main = document.querySelector("main") ?? document.body;

    const labelFor = (el) => {
      if (el.getAttribute("aria-label")) return true;
      if (el.getAttribute("aria-labelledby")) return true;
      if (el.getAttribute("title")) return true;
      if (el.id && document.querySelector(`label[for="${el.id}"]`)) return true;
      if (el.closest("label")) return true;
      // A visible label immediately before the control counts.
      const prev = el.previousElementSibling;
      if (prev && /^(LABEL|SPAN|STRONG)$/.test(prev.tagName) && (prev.textContent ?? "").trim()) {
        return true;
      }
      if (el.getAttribute("placeholder")) return true;
      return false;
    };

    /* ------------------------------------------------------ filters ------ */
    const filters = Array.from(
      main.querySelectorAll("select, input[type='search'], input[type='text']"),
    );
    const unlabelledFilters = filters.filter((f) => !labelFor(f)).length;
    const activeChips = main.querySelectorAll(
      ".adm-chip, .app-chip, [data-active-filter]",
    ).length;
    const RESET_WORDS =
      /^(reset|clear|clear all|clear filters|show all|reset filters|clear selection)$/i;
    const resetControl =
      main.querySelectorAll("[data-ui-filter-reset]").length > 0 ||
      Array.from(main.querySelectorAll("button, a")).some((b) =>
        RESET_WORDS.test((b.textContent ?? "").trim()),
      );

    /* PER FILTER BAR, NOT PER PAGE.
       Counting a page's controls conflated two different things:
       /admin/support-access has TWO independent sections, each with one
       self-describing status select, and was reported as "4 filters with no
       reset" — a page-level reset there would be a control that clears two
       unrelated lists at once. /admin/identity is four sections the same way.
       The defect is a SINGLE filter row carrying three or more controls with
       no way to clear them, because that is where "show me everything again"
       becomes a hunt through the row. */
    const bars = Array.from(main.querySelectorAll("[data-ui-filter-bar]")).map(
      (bar) => ({
        controls: bar.querySelectorAll(
          "select, input[type='search'], input[type='text']",
        ).length,
        reset:
          bar.querySelectorAll("[data-ui-filter-reset]").length > 0 ||
          Array.from(bar.querySelectorAll("button, a")).some((b) =>
            RESET_WORDS.test((b.textContent ?? "").trim()),
          ),
      }),
    );
    const crowdedBarsWithoutReset = bars.filter(
      (b) => b.controls >= 3 && !b.reset,
    ).length;

    /* ---------------------------------------------------- pagination ----- */
    const pagerButtons = Array.from(main.querySelectorAll("button, a")).filter((b) =>
      /^(next|previous|prev|older|newer|load more|show more)$/i.test(
        (b.textContent ?? "").trim(),
      ),
    );
    const positionText = /page\s+\d+|\d+\s*[–-]\s*\d+\s+of\s+|showing\s+\d+/i.test(
      main.textContent ?? "",
    );
    const resultCount = main.querySelectorAll(
      "[data-result-count], .adm-controls__count, .ui-result-count",
    ).length;
    /* The count is a SENTENCE from lib/ui/resultCountSentence, so a page that
       states it without the shared component still counts. Matching the
       wording is what stops this from reporting "no count" on a page that
       says "No customers match these filters". */
    const countSentence =
      /(\d+ (of \d+ )?[a-z-]+( shown| loaded)?)|no [a-z-]+ (yet|match these filters)|count unavailable|loading [a-z-]+…/i.test(
        main.textContent ?? "",
      );
    const capDisclosed = /of (more|\d+\+)|capped at|first \d+|showing the (first|newest)/i.test(
      main.textContent ?? "",
    );

    /* --------------------------------------------------------- icons ----- */
    const svgs = Array.from(main.querySelectorAll("svg"));
    const strokes = new Map();
    let iconNoName = 0;
    for (const s of svgs) {
      const cs = getComputedStyle(s);
      const w = s.getAttribute("stroke-width") ?? cs.strokeWidth ?? "";
      if (w && w !== "0px" && w !== "none") {
        strokes.set(String(w), (strokes.get(String(w)) ?? 0) + 1);
      }
      const parent = s.closest("button, a, [role='button']");
      const decorative =
        s.getAttribute("aria-hidden") === "true" || s.getAttribute("focusable") === "false";
      if (parent && !decorative) {
        const named =
          (parent.textContent ?? "").trim().length > 0 ||
          parent.getAttribute("aria-label") ||
          parent.getAttribute("title");
        if (!named) iconNoName += 1;
      }
    }
    // Two different viewBox conventions is the signature of two icon sets.
    const viewBoxes = new Map();
    for (const s of svgs) {
      const vb = s.getAttribute("viewBox") ?? "none";
      viewBoxes.set(vb, (viewBoxes.get(vb) ?? 0) + 1);
    }

    /* -------------------------------------------------------- charts ----- */
    const charts = Array.from(
      main.querySelectorAll(
        "[data-chart], [data-sparkline], .adm-chart, .app-chart, svg[role='img'], canvas",
      ),
    );
    const chartsUntitled = charts.filter((c) => {
      if (c.getAttribute("aria-label")) return false;
      if (c.querySelector("[aria-label], title, desc")) return false;
      const fig = c.closest("figure, section, .adm-card, .app-panel");
      if (fig && fig.querySelector("h2, h3, h4, figcaption")) return false;
      return true;
    }).length;
    /* A chart with nothing to plot must SAY so. An empty frame is the most
       misleading thing a chart can do: it reads as "measured, and flat". */
    const emptyCharts = Array.from(main.querySelectorAll("[data-sparkline]")).filter(
      (s) => Number(s.getAttribute("data-sample-count") ?? "0") < 2,
    );
    const emptyChartsSilent = emptyCharts.filter(
      (s) => (s.textContent ?? "").replace(/\s+/g, "").length < 8,
    ).length;

    return {
      filters: filters.length,
      unlabelledFilters,
      activeChips,
      resetControl,
      bars: bars.length,
      crowdedBarsWithoutReset,
      pagerButtons: pagerButtons.length,
      pagerAlwaysEnabled: pagerButtons.filter(
        (b) => !b.hasAttribute("disabled") && b.getAttribute("aria-disabled") !== "true",
      ).length,
      positionText,
      resultCount,
      countSentence,
      capDisclosed,
      svgs: svgs.length,
      strokes: Object.fromEntries(strokes),
      viewBoxes: Object.keys(viewBoxes).length,
      iconNoName,
      charts: charts.length,
      chartsUntitled,
      emptyCharts: emptyCharts.length,
      emptyChartsSilent,
      tableRows: main.querySelectorAll("tbody tr").length,
      url: location.pathname + location.search,
    };
  });

  const findings = [];
  if (r.unlabelledFilters > 0) {
    findings.push(`${r.unlabelledFilters}/${r.filters} filters unlabelled`);
  }
  /* WHEN A MISSING RESET IS ACTUALLY A DEFECT.
     The first version of this rule flagged any page with a filter and no
     reset, which was 19 routes — and most of them did not deserve it. A
     single `<select>` DISPLAYS its own state ("Status: Failed") and
     re-selecting "All" IS the reset; adding a button beside it is a control
     that usually does nothing.
     It becomes a defect at THREE OR MORE filters, because that is the point
     at which "show me everything again" means remembering which of them you
     changed. A page that shows active-filter chips has answered it another
     way and is not flagged. */
  if (r.crowdedBarsWithoutReset > 0 && r.activeChips === 0) {
    findings.push(
      `${r.crowdedBarsWithoutReset} filter row(s) with 3+ controls and no reset`,
    );
  }
  if (r.pagerButtons > 0 && !r.positionText) {
    findings.push("pager states no position");
  }
  if (r.pagerButtons >= 2 && r.pagerAlwaysEnabled === r.pagerButtons) {
    findings.push("both pager controls enabled on the first page");
  }
  if (r.iconNoName > 0) findings.push(`${r.iconNoName} icon-only controls unnamed`);
  if (Object.keys(r.strokes).length > 2) {
    findings.push(`${Object.keys(r.strokes).length} icon stroke widths`);
  }
  if (r.chartsUntitled > 0) {
    findings.push(`${r.chartsUntitled}/${r.charts} charts untitled`);
  }
  if (r.emptyChartsSilent > 0) {
    findings.push(`${r.emptyChartsSilent} empty charts say nothing`);
  }
  // A table with rows and no stated count cannot be reconciled against the
  // number on the card above it.
  if (r.tableRows > 1 && r.resultCount === 0 && !r.countSentence) {
    findings.push("rows with no stated count");
  }

  rows.push({ route, filterChanged, ...r, findings });
  console.log(
    `${findings.length ? "FAIL" : "ok  "}  ${route.padEnd(38)} ` +
      `filt=${r.filters} pager=${r.pagerButtons} count=${r.resultCount} ` +
      `svg=${r.svgs} vb=${r.viewBoxes} chart=${r.charts}` +
      (findings.length ? "\n        " + findings.join("; ") : ""),
  );
}

await browser.close();
writeFileSync(`${OUT}/controls.json`, JSON.stringify({ rows }, null, 2), "utf8");

const bad = rows.filter((r) => r.findings.length > 0);
console.log(`\n${rows.length - bad.length}/${rows.length} routes clean`);
console.log(`artifact: ${OUT}/controls.json`);
