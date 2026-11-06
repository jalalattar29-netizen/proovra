/**
 * PRODUCTION-CONTAINER SMOKE — non-Latin text in reports, inside the built image.
 *
 *   docker run --rm <worker-image> node scripts/smoke-report-scripts.mjs
 *
 * REPORT-012. Reports are written in English, but a record's title, its file
 * names and its notes are the customer's own words, in any script. The report
 * CSS names Helvetica Neue, Arial, Georgia and ui-monospace, none of which is
 * in the image; Chromium falls back to whatever fontconfig offers. The image
 * used to ship `ttf-freefont` only, which has Arabic (FreeSerif, FreeMono) and
 * no Chinese, Japanese or Korean at all, so a CJK title printed as empty
 * boxes in a signed report.
 *
 * This proves, with the shipped report stylesheet (dist/) and the image's own
 * Chromium and fonts:
 *
 *   1. COVERAGE — fontconfig has at least one family for each script the
 *      reports must carry (ar, he, ru, el, zh, ja, ko);
 *   2. RENDERING — a report title in each script, laid out by the report's own
 *      CSS, is drawn by Chromium from a family that covers that script (CDP
 *      CSS.getPlatformFontsForNode), never from a family that cannot draw it.
 *
 * Prints one JSON line; exit 1 on failure.
 */
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, "..");
const dist = (p) => pathToFileURL(join(workerDir, "dist", p)).href;

/** One sample per script: what a customer's title or file name may be. */
export const SCRIPT_SAMPLES = [
  { lang: "ar", text: "تقرير الأدلة الرقمية" },
  { lang: "he", text: "דוח ראיות דיגיטליות" },
  { lang: "ru", text: "Отчёт о цифровых доказательствах" },
  { lang: "el", text: "Αναφορά ψηφιακών αποδείξεων" },
  { lang: "zh", text: "数字证据报告" },
  { lang: "ja", text: "デジタル証拠報告書" },
  { lang: "ko", text: "디지털 증거 보고서" },
];

const result = { ok: false, steps: {} };
const step = (name, value) => {
  result.steps[name] = value;
};
const fail = (why) => {
  result.error = why;
  console.log(JSON.stringify(result));
  process.exit(1);
};

function familiesFor(lang) {
  try {
    const out = execFileSync("fc-list", [`:lang=${lang}`, "family"], { encoding: "utf8" });
    return new Set(
      out
        .split("\n")
        .flatMap((line) => line.split(","))
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch (err) {
    fail(`fc-list failed: ${err instanceof Error ? err.message : String(err)}`);
    return new Set();
  }
}

/**
 * SMOKE_REPORT_SCRIPTS=ar,ru narrows the run (a local check against an older
 * image). The release gate runs every script.
 */
const ONLY = (process.env.SMOKE_REPORT_SCRIPTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const SAMPLES = ONLY.length > 0 ? SCRIPT_SAMPLES.filter((s) => ONLY.includes(s.lang)) : SCRIPT_SAMPLES;

async function main() {
  step("scripts", SAMPLES.map((s) => s.lang));
  // 1. COVERAGE
  const coverage = {};
  const families = {};
  for (const { lang } of SAMPLES) {
    families[lang] = familiesFor(lang);
    coverage[lang] = [...families[lang]].slice(0, 4);
  }
  step("coverage", coverage);
  const uncovered = SAMPLES.filter(({ lang }) => families[lang].size === 0).map((s) => s.lang);
  if (uncovered.length > 0) fail(`no installed font covers: ${uncovered.join(", ")}`);

  // 2. RENDERING, with the report's own stylesheet.
  const { getReportCss } = await import(dist("report-v2/templates/report.css.js"));
  const { resolveBrowserExecutablePath } = await import(dist("report-v2/render-pdf.js"));
  const executablePath = resolveBrowserExecutablePath();
  if (!executablePath) fail("no Chromium in the image");
  const { default: puppeteer } = await import("puppeteer");
  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    const rows = SAMPLES.map(
      ({ lang, text }) => `<h1 class="cover-title" id="s-${lang}" lang="${lang}" dir="auto">${text}</h1>`,
    ).join("\n");
    await page.setContent(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${getReportCss()}</style></head><body>${rows}</body></html>`,
      { waitUntil: "load" },
    );
    const cdp = await page.createCDPSession();
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const rendered = {};
    const wrong = [];
    for (const { lang, text } of SAMPLES) {
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#s-${lang}` });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      rendered[lang] = fonts.map((f) => `${f.familyName}:${f.glyphCount}`);
      // The letters are drawn by a family fontconfig says covers the script.
      // A non-covering family may draw the spaces only (shaping can merge
      // letters, so glyphs are not counted against letters).
      const spaces = (text.match(/\s/g) ?? []).length;
      const covering = fonts.filter((f) => families[lang].has(f.familyName)).reduce((n, f) => n + f.glyphCount, 0);
      const other = fonts.filter((f) => !families[lang].has(f.familyName)).reduce((n, f) => n + f.glyphCount, 0);
      if (covering === 0 || other > spaces) {
        wrong.push(`${lang}: ${rendered[lang].join(", ") || "no font"} (covering ${covering}, other ${other})`);
      }
    }
    step("rendering", rendered);
    if (wrong.length > 0) fail(`drawn by a font that cannot render it: ${wrong.join("; ")}`);
  } finally {
    await browser.close();
  }

  result.ok = true;
  console.log(JSON.stringify(result));
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
