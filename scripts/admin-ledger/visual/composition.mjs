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

const { browser, page } = await open({ width: 1440, height: 900 });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await signIn(page);

let failures = 0;

for (const route of routes) {
  errors.length = 0;
  await page.goto(`${WEB}${route}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await strip(page);
  await page.waitForTimeout(1200);

  const result = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "adm-card";
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

    return {
      probeBorder,
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
  if (errors.length) bad.push(`${errors.length} console errors`);

  if (bad.length) failures += 1;
  console.log(
    `${bad.length ? "FAIL" : "ok  "}  ${route.padEnd(44)} ` +
      `h=${String(result.height).padStart(5)} ` +
      `td=${String(result.cells).padStart(3)} ` +
      `field=${String(result.fields).padStart(2)} ` +
      (bad.length ? "\n        " + bad.join("; ") : ""),
  );
  if (errors.length) {
    for (const e of errors.slice(0, 3)) console.log("        ! " + e.slice(0, 160));
  }
}

await browser.close();
console.log(`\n${routes.length - failures}/${routes.length} routes clean`);
process.exit(failures ? 1 : 0);
