/**
 * PRODUCTION-CONTAINER SMOKE — local OCR languages, inside the built image.
 *
 *   docker run --rm <worker-image> node scripts/smoke-ocr-languages.mjs
 *
 * AUD-019. The worker advertises OCR for the PROOVRA locales — English, Arabic
 * and German — and records the language each derived review was read with.
 * That is only true if the SHIPPED image has the engine AND the three models,
 * and if the worker's own provider recognises text in each script. This smoke
 * proves it with the shipped code (dist/), not a re-implementation:
 *
 *   1. ENGINE — `detectTesseractCapability()` finds tesseract and its
 *      `--list-langs` contains eng, ara and deu;
 *   2. RESOLUTION — the default request resolves to exactly deu+eng+ara with
 *      nothing missing, and a model that is not installed is reported missing
 *      and never becomes part of the effective language;
 *   3. RECOGNITION — a screen rendered here by the image's own Chromium, with
 *      one English, one German and one Arabic line, is read through
 *      `createTesseractOcrProvider` with the effective language, and each
 *      line's distinctive words are recognised.
 *
 * Prints one JSON line; exit 1 on failure.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, "..");
const dist = (p) => pathToFileURL(join(workerDir, "dist", p)).href;

const REQUIRED = ["eng", "ara", "deu"];
const result = { ok: false, steps: {} };
const step = (name, value) => {
  result.steps[name] = value;
};
const fail = (why) => {
  result.error = why;
  console.log(JSON.stringify(result));
  process.exit(1);
};

/** Case-, diacritic-form- and whitespace-tolerant containment. */
const norm = (s) => s.normalize("NFKC").replace(/\s+/g, " ").toLowerCase();

async function renderScreen(executablePath, file) {
  const { default: puppeteer } = await import("puppeteer");
  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 420, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>
        body{margin:0;background:#fff;color:#000;font-family:"FreeSerif",serif;font-size:52px;padding:30px 40px}
        p{margin:0 0 40px 0;line-height:1.2}
        .ar{direction:rtl;text-align:right}
      </style></head><body>
        <p>Invoice 88213 confirmed</p>
        <p>Größe und Übertragung prüfen</p>
        <p class="ar" lang="ar">تم تأكيد الدفع اليوم</p>
      </body></html>`,
      { waitUntil: "load" },
    );
    await page.screenshot({ path: file, type: "png" });
  } finally {
    await browser.close();
  }
}

let dir = null;
try {
  const cap = await import(dist("tesseract-capability.js"));
  const ocr = await import(dist("tesseract-ocr-provider.js"));

  // 1. ENGINE + installed models.
  const c = await cap.detectTesseractCapability();
  step("engine", c.ok ? { version: c.version, languages: c.languages } : { ok: false, reason: c.reason });
  if (!c.ok) fail("tesseract engine not found in the image");
  const missing = REQUIRED.filter((l) => !c.languages.includes(l));
  if (missing.length > 0) fail(`tesseract --list-langs is missing: ${missing.join(", ")}`);

  // 2. requested ∩ installed.
  const def = cap.resolveOcrLanguages(cap.DEFAULT_OCR_LANGUAGES, c.languages);
  const withAbsent = cap.resolveOcrLanguages("eng+zzz", c.languages);
  step("resolution", { default: def, withAbsent });
  if (def.effective !== "deu+eng+ara" || def.missing.length !== 0) fail("default OCR languages do not resolve to deu+eng+ara");
  if (withAbsent.effective !== "eng" || withAbsent.missing.join() !== "zzz") fail("an absent model leaked into the effective language");

  // 3. Real recognition through the worker's provider.
  const { resolveBrowserExecutablePath } = await import(dist("report-v2/render-pdf.js"));
  const executablePath = resolveBrowserExecutablePath();
  if (!executablePath) fail("no Chromium in the image to render the OCR screen");
  dir = await mkdtemp(join(tmpdir(), "proovra-ocr-smoke-"));
  const png = join(dir, "screen.png");
  await renderScreen(executablePath, png);
  const provider = await ocr.createTesseractOcrProvider(def.effective);
  const res = await provider.extract({ imageRef: png });
  const text = norm(res.regions.map((r) => r.text).join("\n"));
  const expectations = {
    english: ["invoice", "88213", "confirmed"],
    german: ["größe", "übertragung", "prüfen"],
    arabic: ["تأكيد", "الدفع"],
  };
  const recognised = {};
  for (const [script, words] of Object.entries(expectations)) {
    recognised[script] = words.filter((w) => text.includes(norm(w)));
  }
  step("recognition", { language: res.language, regions: res.regions.length, recognised });
  if (res.language !== "deu+eng+ara") fail(`provider ran with ${res.language}, not deu+eng+ara`);
  for (const [script, words] of Object.entries(expectations)) {
    if (recognised[script].length !== words.length) {
      fail(`${script} text not fully recognised: ${JSON.stringify({ expected: words, recognised: recognised[script], text })}`);
    }
  }

  result.ok = true;
  console.log(JSON.stringify(result));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
