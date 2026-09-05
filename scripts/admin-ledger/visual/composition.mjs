/**
 * COMPOSITION PROBE — what a migrated page actually renders.
 *
 * The legacy-system migration replaced 335 inline style attributes with
 * classes. An inline style always applied; a class only applies if the
 * stylesheet reached the page and the selector matched. Nothing in a
 * typecheck or a lint can tell those apart, and a page that silently lost
 * every border and every cell padding still compiles.
 *
 * So this measures, per route:
 *
 *   - the console stylesheet reached it        (a probe element resolves)
 *   - tables have real cell padding and rules  (not 0px, not transparent)
 *   - fields have a visible border             (not `none`)
 *   - the page did not lose its ground         (body background is set)
 *   - console errors
 *   - document scroll width vs viewport        (overflow)
 *
 * Usage: node scripts/admin-ledger/visual/composition.mjs <route> [<route>…]
 */
import { open, signIn, strip, WEB } from "./lib.mjs";

const routes = process.argv.slice(2);
if (routes.length === 0) {
  console.error("usage: composition.mjs <route> [<route>…]");
  process.exit(2);
}

/** The fixture rows the capture harness uses for the dynamic segments. */
const PARAMS = {
  "/admin/customers/:id": "0adf0000-0000-4000-8000-0000000000a1",
  "/admin/workspaces/:id": "0adf0000-0000-4000-8000-0000000000b1",
  "/admin/users/:id": "0adf0000-0000-4000-8000-000000000002",
  "/admin/demo-requests/:id": "0adf0000-0000-4000-8000-0000000000e1",
  "/admin/contact-sales/:id": "0adf0000-0000-4000-8000-0000000000e2",
  "/admin/platform/runbooks/:slug": "tsa-timestamp-failure",
};
const concrete = (r) => (PARAMS[r] ? r.replace(/:(\w+)$/, PARAMS[r]) : r);

const { browser, page } = await open({ width: 1440, height: 900 });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await signIn(page);

let failures = 0;

for (const route of routes) {
  errors.length = 0;
  await page.goto(`${WEB}${concrete(route)}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await strip(page);
  await page.waitForTimeout(1200);

  const result = await page.evaluate(() => {
    /* The console's stylesheet is loaded by the admin LAYOUT, so `.adm-card`
       only exists under /admin. A Security Center page is on the product's
       shared `app-*` primitives instead, and probing it for `.adm-card` would
       report a missing stylesheet on a page that is styled correctly. Probe
       whichever system the route is supposed to be on. */
    const main = document.querySelector("main") ?? document.body;
    const admin = location.pathname.startsWith("/admin");
    const probe = document.createElement(admin ? "div" : "input");
    probe.className = admin ? "adm-card" : "app-input";
    document.body.appendChild(probe);
    const probeBorder = getComputedStyle(probe).borderTopWidth;
    probe.remove();

    /* A full-width cell is a state row — it holds an EmptyState or an
       AdmInline, both of which carry their own padding, so the CELL having
       none is correct rather than a defect. Only data cells are measured. */
    const cells = Array.from(document.querySelectorAll("td"))
      .filter((td) => !td.hasAttribute("colspan"))
      .slice(0, 60);
    const cellPads = cells.map((c) => getComputedStyle(c).paddingTop);
    const cellRules = cells.map((c) => getComputedStyle(c).borderBottomStyle);

    const fields = Array.from(
      document.querySelectorAll(
        "main input:not([type=checkbox]):not([type=radio]):not([type=hidden]), main select, main textarea",
      ),
    ).slice(0, 40);
    const fieldBorders = fields.map((f) => getComputedStyle(f).borderTopStyle);
    const fieldHeights = fields.map((f) => Math.round(f.getBoundingClientRect().height));

    /* ===================================================================
     * THE SHAPES THE COMPOSITION REVIEW KEPT FINDING BY EYE
     * ===================================================================
     * Each of these was found by opening a screenshot, and each turned out to
     * be a PATTERN rather than a one-off. Looking at 47 pages one at a time
     * finds the first instance of a shape; measuring finds all of them.
     * =================================================================== */

    /* TWO PRIMARY ACTIONS ON ONE SCREEN. /admin/identity/providers rendered
       "New connection" as a filled enterprise button in the page header AND
       again as a filled enterprise button in the empty state — so an operator
       had to decide which of two identical buttons was the real one. */
    const filled = Array.from(
      main.querySelectorAll(
        '[data-variant="primary"], [data-variant="enterprise"], .ui-button[data-variant="primary"]',
      ),
    ).filter((b) => b.getBoundingClientRect().height > 0);
    const filledLabels = filled.map((b) => (b.textContent ?? "").trim());
    const duplicatePrimary = filledLabels.filter(
      (l, i) => l && filledLabels.indexOf(l) !== i,
    ).length;

    /* A RATIO OVER ZERO. `5 / 0` seats, `0 of 0` connections ready — two
       facts that disagree, rendered as though they were one measurement. An
       operator reads it as a fault rather than as "there is no denominator". */
    const zeroDenominator = (
      (main.textContent ?? "").match(/\b\d+\s*(?:\/|of)\s*0\b/g) ?? []
    ).length;

    /* A FULL TIMESTAMP AS A SUB-LINE IN A SCANNABLE LIST. Correct on an audit
       row; noise under every name in a directory, where it also wraps and
       makes each row three lines tall. Detected as a seconds-precision stamp
       inside a table cell that also holds a bold name. */
    const secondsInList = Array.from(main.querySelectorAll("tbody td")).filter(
      (td) =>
        /\d{1,2}:\d{2}:\d{2}/.test(td.textContent ?? "") &&
        /* ANY bold weight, not the two this happened to be written with.
           /admin/users used `fontWeight: 620` and was therefore reported as
           clean while printing `joined 05 Sept 2026, 11:19:54 Europe/Berlin`
           under every address. */
        (td.querySelector("strong, b") ||
          Array.from(td.querySelectorAll("*")).some(
            (el) => (parseInt(getComputedStyle(el).fontWeight, 10) || 400) >= 600,
          )),
    ).length;

    /* A ROW RENDERED FOUR LINES TALL. Two stacked badges saying the same
       thing twice, or a phrase wrapping mid-word in a narrow column.
       MEASURED PER ROW, NOT PER CELL: a `<td>`'s height IS its row's height,
       so the first version of this counted every cell in a tall row and
       reported "18 tall cells" for a two-row table with nine columns. The
       threshold is absolute — 100px is four lines of 13px text with padding,
       which no data row needs. */
    const tallRows = Array.from(main.querySelectorAll("tbody tr")).filter(
      (tr) =>
        !tr.querySelector("td[colspan]") &&
        tr.getBoundingClientRect().height > 100,
    ).length;
    const rows = main.querySelectorAll("tbody tr").length;

    return {
      probeBorder,
      duplicatePrimary,
      filledPrimaries: filled.length,
      zeroDenominator,
      secondsInList,
      tallRows,
      rows,
      cells: cells.length,
      flatCells: cellPads.filter((p) => p === "0px").length,
      ruleless: cellRules.filter((s) => s === "none").length,
      fields: fields.length,
      borderless: fieldBorders.filter((s) => s === "none").length,
      shortFields: fieldHeights.filter((h) => h > 0 && h < 44).length,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      overflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      height: document.documentElement.scrollHeight,
      legacyInline: document.querySelectorAll(
        'main [style*="borderCollapse"], main [style*="border-collapse"]',
      ).length,
    };
  });

  const bad = [];
  if (result.probeBorder === "0px") bad.push("STYLESHEET NOT APPLIED");
  if (result.cells > 0 && result.flatCells > 0)
    bad.push(`${result.flatCells}/${result.cells} cells with no padding`);
  if (result.cells > 0 && result.ruleless === result.cells)
    bad.push("no row rules at all");
  if (result.borderless > 0)
    bad.push(`${result.borderless}/${result.fields} fields with no border`);
  if (result.shortFields > 0)
    bad.push(`${result.shortFields} fields under 44px`);
  if (result.overflow > 0) bad.push(`overflow ${result.overflow}px`);

  /* A SCRIPT ERROR IS A DEFECT. A 402 IS THE PAGE DOING ITS JOB.
     `/admin/identity/access-reviews` logs "Failed to load resource: the
     server responded with a status of 402" because the fixture workspace's
     plan does not carry the surface — and the page then renders the refusal
     that 402 means. Counting the browser's network log as a page defect
     reported the ONE route that exercises PLAN_GATED as the only unclean
     route in the console. A refusal the page handles is separated from an
     error it did not. */
  const REFUSAL_STATUS = /Failed to load resource.*\b(400|402|403|404|409)\b/;
  const refusals = errors.filter((e) => REFUSAL_STATUS.test(e));
  const scriptErrors = errors.filter((e) => !REFUSAL_STATUS.test(e));
  if (scriptErrors.length) bad.push(`${scriptErrors.length} console errors`);
  const note = refusals.length
    ? `  (${refusals.length} handled refusal response${refusals.length > 1 ? "s" : ""})`
    : "";
  if (result.duplicatePrimary > 0) {
    bad.push(`${result.duplicatePrimary} duplicate primary action(s)`);
  }
  if (result.zeroDenominator > 0) {
    bad.push(`${result.zeroDenominator} ratio(s) over a zero denominator`);
  }
  if (result.secondsInList > 0) {
    bad.push(`${result.secondsInList} list cells carrying a seconds-precision stamp`);
  }
  if (result.tallRows > 0) {
    bad.push(`${result.tallRows}/${result.rows} data rows over four lines tall`);
  }

  if (bad.length) failures += 1;
  console.log(
    `${bad.length ? "FAIL" : "ok  "}  ${route.padEnd(44)} ` +
      `h=${String(result.height).padStart(5)} ` +
      `td=${String(result.cells).padStart(3)} ` +
      `field=${String(result.fields).padStart(2)}` +
      note +
      (bad.length ? "\n        " + bad.join("; ") : ""),
  );
  if (scriptErrors.length) {
    for (const e of scriptErrors.slice(0, 3)) console.log("        ! " + e.slice(0, 160));
  }
}

await browser.close();
console.log(`\n${routes.length - failures}/${routes.length} routes clean`);
process.exit(failures ? 1 : 0);
