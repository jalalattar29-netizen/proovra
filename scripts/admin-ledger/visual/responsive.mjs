/**
 * THE RESPONSIVE SWEEP: 47 routes x 7 widths, plus 200% zoom.
 *
 * =============================================================================
 * DEVICE CLASS IS EMULATED, NOT ASSUMED
 * =============================================================================
 * The first version of this ran every width in Chromium's default context,
 * which reports `pointer: fine`. The app shell has a documented laptop-density
 * path behind `@media (pointer: fine) and (max-height: 900px)` that lowers the
 * sidebar links to 40px, and a touch path behind
 * `@media (pointer: coarse), (max-width: 900px)` that holds them at 44px. The
 * fine path is LATER in the file, so a headless run at 390x900 got the laptop
 * density and reported "17 small targets" on a phone width — measuring a state
 * no phone is ever in.
 *
 * So the phone and tablet widths run with `hasTouch` and `isMobile` and real
 * device heights, and the desktop widths run as a mouse. A finding is only a
 * finding if some real device can reach it.
 *
 * =============================================================================
 * FINDINGS ARE SPLIT BY OWNERSHIP
 * =============================================================================
 * `chrome` is the app shell — sidebar, header, bell — which every admin page
 * inherits and none of them owns. `content` is inside `<main>`. Reporting one
 * number over both makes a shell issue look like 47 page issues and buries any
 * real page issue underneath it.
 *
 * =============================================================================
 * BOUNDED, BECAUSE THE FIRST VERSION HUNG
 * =============================================================================
 * It walked every element twice and, for each overflowing one, walked its
 * ancestors — and stalled indefinitely on /admin/platform/readiness. Every
 * loop below is capped, and every evaluate races a deadline, so a slow page
 * costs one row rather than the run.
 *
 * 200% ZOOM is emulated by halving the CSS viewport at twice the device pixel
 * ratio, which is what a browser's zoom does to layout. Stated rather than
 * glossed: this is the equivalent arrangement, not the browser's own control.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { WEB, strip, signIn } from "./lib.mjs";

/** width -> the device a person would be holding at that width. */
const DEVICES = [
  { w: 320, h: 568, touch: true },
  { w: 375, h: 667, touch: true },
  { w: 390, h: 844, touch: true },
  { w: 768, h: 1024, touch: true },
  { w: 1024, h: 768, touch: false },
  { w: 1280, h: 800, touch: false },
  { w: 1440, h: 900, touch: false },
];

const MEASURE = () => {
  // 2500 inline, not a module const: this body runs INSIDE the page, where a
  // Node-scope binding is not defined -- the first attempt failed 48/48 with
  // "ReferenceError: CAP is not defined" and reported h1=undefined for all of
  // them, which is exactly the shape of an instrument fault rather than a
  // finding.
  const doc = document.documentElement;
  /**
   * NO MAIN IS A FINDING, NOT A REASON TO CALL EVERYTHING CONTENT.
   *
   * This read `document.querySelector("main") || document.body`. On
   * `/admin/platform/runbooks/:slug` — the console's not-found state, which
   * rendered a bare div — there was no main, so the fallback made the whole
   * document count as page content and the sweep reported the app shell's
   * 38px privacy-preferences launcher as an admin content target. Global
   * chrome, with an aria-label, on a page no admin route owns.
   *
   * The ownership split now has no fallback, and the absence is reported in
   * its own right: a page with no main landmark has no primary region and no
   * "skip to content" target, which is worth a line of its own.
   */
  const mainEl = document.querySelector("main, [role='main']");
  const inMain = (el) => (mainEl ? mainEl.contains(el) : false);
  const main = mainEl ?? doc;
  const overflow = Math.max(0, doc.scrollWidth - doc.clientWidth);

  const culprits = [];
  if (overflow > 1) {
    const all = [...document.querySelectorAll("body *")].slice(0, 2500);
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right <= doc.clientWidth + 1 && r.left >= -1) continue;
      // A wide table inside an overflow-x container is correct, not a defect.
      let p = el.parentElement;
      let contained = false;
      for (let i = 0; i < 12 && p; i += 1) {
        const ov = getComputedStyle(p).overflowX;
        if (ov === "auto" || ov === "scroll" || ov === "hidden") { contained = true; break; }
        p = p.parentElement;
      }
      if (contained) continue;
      culprits.push({
        where: inMain(el) ? "content" : "chrome",
        tag: el.tagName,
        cls: (el.className || "").toString().slice(0, 34),
        w: Math.round(r.width),
        right: Math.round(r.right),
      });
      if (culprits.length >= 6) break;
    }
  }

  const SEL =
    'a[href], button, input, select, textarea, [role="tab"], [role="button"], [tabindex]:not([tabindex="-1"])';
  const small = { content: [], chrome: [] };
  let nativeWidgets = 0;
  for (const el of [...document.querySelectorAll(SEL)].slice(0, 2500)) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    /*
     * WCAG 2.5.8 EXEMPTS A CONTROL INLINE IN A SENTENCE — AND NOT ONLY A LINK.
     *
     * The first version of this checked `tagName === "A"`, and the exemption
     * in the success criterion is about being INLINE IN TEXT, not about the
     * element being an anchor: "the target is in a sentence, or its size is
     * otherwise constrained by the line-height of non-target text".
     *
     * The gap showed up as 32 reported failures for one control: the
     * "Read more" toggle in the Security sections, which sets `font: inherit`
     * and `minHeight: 0` precisely so that it sits IN the description
     * sentence rather than beside it. Forcing it to 44px would push it out of
     * the sentence, which is a worse outcome than the rule was written to
     * prevent.
     */
    const parent = el.parentElement;
    const inlineInText =
      parent != null &&
      /^(P|SPAN|LI|TD|DIV|STRONG|EM|LABEL)$/.test(parent.tagName) &&
      (parent.textContent || "").trim().length >
        (el.textContent || "").trim().length + 6 &&
      // A LINK inline in text is the criterion's own example and needs no
      // further test. A BUTTON has to prove it: it must genuinely inherit the
      // surrounding type, so a styled button that merely sits NEXT TO text is
      // not exempt.
      //
      // The font-size condition was applied to both at first, and it wrongly
      // un-exempted the runbook cross-references — links whose label is inline
      // `code` and therefore renders smaller than the sentence around it.
      // Forcing those to 44px would break the prose they sit in, which is the
      // opposite of what the rule protects.
      (el.tagName === "A" ||
        (el.tagName === "BUTTON" &&
          cs.fontSize === getComputedStyle(parent).fontSize));
    if (inlineInText) continue;

    /*
     * A NATIVE CHECKBOX OR RADIO IS 13x13 AND ALWAYS WILL BE — that is the
     * platform widget, and 2.5.8 exempts a control whose presentation is
     * determined by the user agent. Its LABEL is the target a person clicks,
     * and `choiceRowStyle` already makes that 44px. Counted separately rather
     * than silently dropped.
     */
    if (el.tagName === "INPUT" && /^(checkbox|radio)$/.test(el.type ?? "")) {
      nativeWidgets += 1;
      continue;
    }
    if (r.height >= 43.5 && r.width >= 43.5) continue;
    const bucket = inMain(el) ? small.content : small.chrome;
    if (bucket.length < 40) {
      bucket.push({
        tag: el.tagName,
        cls: (el.className || "").toString().slice(0, 26),
        box: `${Math.round(r.width)}x${Math.round(r.height)}`,
        txt: (el.textContent || "").trim().slice(0, 22),
      });
    }
  }

  const tiny = { content: [], chrome: [] };
  for (const el of [...document.querySelectorAll("body *")].slice(0, 2500)) {
    const hasText = [...el.childNodes].some(
      (c) => c.nodeType === 3 && c.textContent.trim().length > 1,
    );
    if (!hasText) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    // 11px is the console FLOOR, not a violation: an uppercase micro-label
    // with positive letter-spacing has a larger perceived x-height than
    // sentence-case text at the same size, and 11px caps is the convention
    // the KPI labels, table headers and status chips use. Anything BELOW 11
    // is reported. Sentence-case text under 12px is caught by eye in the
    // contact sheets rather than by this threshold.
    if (size >= 10.9) continue;
    const bucket = inMain(el) ? tiny.content : tiny.chrome;
    if (bucket.length < 20) {
      bucket.push({
        size,
        cls: (el.className || "").toString().slice(0, 26),
        txt: (el.textContent || "").trim().slice(0, 24),
      });
    }
  }

  return {
    overflow,
    culprits,
    nativeWidgets,
    smallContent: small.content.length,
    smallChrome: small.chrome.length,
    smallContentTop: small.content.slice(0, 4),
    smallChromeTop: small.chrome.slice(0, 3),
    tinyContent: tiny.content.length,
    tinyChrome: tiny.chrome.length,
    tinyContentTop: tiny.content.slice(0, 4),
    tinyChromeTop: tiny.chrome.slice(0, 3),
    h1: document.querySelectorAll("h1").length,
    hasMainLandmark: Boolean(mainEl),
  };
};

const routes = readFileSync(process.argv[2], "utf8")
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);
const only = process.argv[3] ? Number(process.argv[3]) : null;
const skip = process.argv[4] ? Number(process.argv[4]) : 0;
const slice = only ? routes.slice(skip, skip + only) : routes;

const deadline = (p, ms, fallback) =>
  Promise.race([
    p,
    new Promise((r) => setTimeout(() => r(fallback), ms)),
  ]);

const browser = await chromium.launch();
const rows = [];

for (const zoom of [1, 2]) {
  const devices = zoom === 1 ? DEVICES : [{ w: 1440, h: 900, touch: false }];
  for (const dev of devices) {
    const cssW = zoom === 2 ? Math.round(dev.w / 2) : dev.w;
    const cssH = zoom === 2 ? Math.round(dev.h / 2) : dev.h;
    const ctx = await browser.newContext({
      viewport: { width: cssW, height: cssH },
      deviceScaleFactor: zoom,
      hasTouch: dev.touch,
      isMobile: dev.touch,
    });
    await ctx.addInitScript(() => {
      try {
        window.localStorage.setItem(
          "proovra-cookie-consent-state",
          JSON.stringify({
            necessary: true, preferences: false, analytics: false,
            marketing: false, consentVersion: 1,
            updatedAt: new Date().toISOString(),
          }),
        );
      } catch {}
    });
    const page = await ctx.newPage();
    await signIn(page);

    for (const route of slice) {
      await page
        .goto(`${WEB}${route}`, { waitUntil: "domcontentloaded", timeout: 45_000 })
        .catch(() => {});
      // 3s, not 1.5s. At 1.5s this sweep reported h1=0 on 17 of 32 checks and
      // every one of them was this wait: sampling /admin over time showed the
      // H1 arriving between 1.5s and 3s at the smaller viewports, alongside a
      // "Loading platform overview" H2 and four skeletons. A settle time that
      // is too short does not produce a weaker finding, it produces a false
      // one — and 17 false "missing page heading" reports would have been the
      // headline of the accessibility section.
      await page.waitForTimeout(3_000);
      /**
       * A FIXED SETTLE IS A RACE, AND LOSING IT PRODUCES A FALSE FINDING.
       *
       * 3s replaced 1.5s for exactly this reason and it is still a guess. On
       * one pass this sweep reported `/admin/identity` at 1024 as "h1=0 · NO
       * MAIN LANDMARK" — a page with no heading and no primary region, which
       * would be among the worst findings in the accessibility section. It was
       * not true: the same route, measured on its own AND in the sweep's exact
       * sequence at the same width with the same settle, reports one h1 and
       * one landmark every time. The dev server compiles per request, and a
       * cold compile of a heavy route can outrun three seconds.
       *
       * So the settle has a PRECONDITION rather than a longer guess: wait for
       * the primary region to exist, with a ceiling. A slow compile now costs
       * a longer wait; a page that genuinely has no landmark still reports one
       * after the ceiling, because the wait resolves either way.
       */
      const ready = await page
        .waitForSelector("main, [role='main']", { timeout: 15_000, state: "attached" })
        .then(() => true)
        .catch(() => false);
      await deadline(strip(page).catch(() => 0), 5_000, 0);
      /*
         A WAIT THAT FAILED IS NOT A MEASUREMENT OF ZERO.

         With the precondition catching its own timeout and falling through,
         a route whose primary region never appeared within 18s was measured
         anyway and reported "h1=0 · NO MAIN LANDMARK" — indistinguishable
         from a page that genuinely has neither. It moved between routes from
         run to run (/admin/identity at 1024 on one pass, /admin/billing at
         320 on the next), which is the shape of a dev-server cold compile and
         not the shape of a page defect. Both were checked individually and
         both have a heading and a landmark.

         So a failed precondition is reported AS a failed precondition. It is
         still visible — a route that is never ready is worth knowing about —
         and it can no longer be read as an accessibility finding.
      */
      const m = !ready
        ? { error: "NOT READY (no primary region within 18s — re-check this route alone)" }
        : await deadline(
            page.evaluate(MEASURE).catch((e) => ({ error: String(e).slice(0, 80) })),
            20_000,
            { error: "MEASURE TIMED OUT" },
          );
      const row = { route, width: dev.w, zoom, touch: dev.touch, ...m };
      rows.push(row);
      const flag = [
        m.error ? m.error : "",
        m.overflow ? `OVERFLOW ${m.overflow}px` : "",
        m.smallContent ? `${m.smallContent} small(content)` : "",
        m.smallChrome ? `${m.smallChrome} small(chrome)` : "",
        m.tinyContent ? `${m.tinyContent} tiny(content)` : "",
        m.tinyChrome ? `${m.tinyChrome} tiny(chrome)` : "",
      m.nativeWidgets ? `${m.nativeWidgets} native checkbox/radio (exempt)` : "",
        m.h1 !== 1 ? `h1=${m.h1}` : "",
        m.hasMainLandmark === false ? "NO MAIN LANDMARK" : "",
      ].filter(Boolean).join(" · ");
      if (flag) {
        console.log(
          `${route.padEnd(46)}${zoom === 2 ? "z200@" : "     "}${String(dev.w).padStart(5)}${dev.touch ? " touch" : "      "}  ${flag}`,
        );
        for (const c of m.culprits ?? []) console.log(`      culprit(${c.where}) ${c.tag}.${c.cls} w=${c.w} right=${c.right}`);
        for (const s of m.smallContentTop ?? []) console.log(`      target(content) ${s.tag}.${s.cls} ${s.box} "${s.txt}"`);
        for (const s of m.smallChromeTop ?? []) console.log(`      target(chrome)  ${s.tag}.${s.cls} ${s.box} "${s.txt}"`);
        for (const t of m.tinyContentTop ?? []) console.log(`      text(content)   ${t.size}px .${t.cls} "${t.txt}"`);
        for (const t of m.tinyChromeTop ?? []) console.log(`      text(chrome)    ${t.size}px .${t.cls} "${t.txt}"`);
      }
    }
    await ctx.close();
  }
}

mkdirSync("artifacts/admin-visual-review", { recursive: true });
const out = `artifacts/admin-visual-review/responsive${only ? `-${skip}` : ""}.json`;
writeFileSync(out, JSON.stringify({ rows }, null, 2), "utf8");

const n = (f) => rows.filter(f).length;
console.log(
  [
    "",
    `checks                 ${rows.length}`,
    `errors                 ${n((r) => r.error)}`,
    `with body overflow     ${n((r) => r.overflow)}`,
    `small targets: content ${n((r) => r.smallContent)}`,
    `small targets: chrome  ${n((r) => r.smallChrome)}`,
    `tiny text: content     ${n((r) => r.tinyContent)}`,
    `tiny text: chrome      ${n((r) => r.tinyChrome)}`,
    `h1 count not 1         ${n((r) => r.h1 !== 1)}`,
  ].join("\n"),
);
await browser.close();
