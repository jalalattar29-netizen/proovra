/**
 * THE RTL SWEEP.
 *
 * =============================================================================
 * IT SETS A LOCALE, NOT A `dir` ATTRIBUTE
 * =============================================================================
 * The existing admin specs flip `documentElement.dir = "rtl"` directly. That
 * checks the stylesheet and nothing else. The product reaches RTL through
 * `providers.tsx`, which reads `proovra-locale` / `proovra-locale-mode` from
 * localStorage and sets `dir` from the locale — so seeding those exercises the
 * real path, including the translated strings that make a label long enough to
 * break a layout the English one fits.
 *
 * =============================================================================
 * WHAT IT MEASURES
 * =============================================================================
 * §20 rules out `text-align: right` as an implementation, and it rules out
 * mirroring things that must not mirror. Both are measurable:
 *
 *   body-level horizontal overflow
 *   TECHNICAL TEXT STILL LTR — an id, hash, email, URL, path, command or
 *     inline code inside RTL prose must not reverse. This is the defect that
 *     actually harms an operator: a mirrored UUID is a wrong UUID.
 *   PHYSICAL-PROPERTY LEAKS — any element whose computed style shows a
 *     physical margin/padding/border asymmetry that logical properties would
 *     have mirrored. Reported per route with the offenders named.
 *   the breadcrumb and the tab indicator resolve to the inline-start edge
 *   directional glyphs (-> arrows) present as text, which do NOT mirror
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { WEB, strip, signIn, concreteRoute } from "./lib.mjs";

const routes = readFileSync(process.argv[2], "utf8")
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

const MEASURE = () => {
  const doc = document.documentElement;

  /** A string that must read left-to-right whatever the page direction. */
  const TECHNICAL =
    /(^[0-9a-f]{8}-[0-9a-f]{4}|^[0-9a-f]{16,}$|@[\w.-]+\.\w+|^\/[\w./:?=&-]+$|^https?:\/\/|^--[a-z]|\.(ts|tsx|mjs|md|json)$)/;
  // A single ALL-CAPS word ("WARNING", "FREE", "TEAM") was in this pattern
  // and was removed: it renders identically in either direction, so it is not
  // a direction defect. It IS a raw enum label reaching the UI, which is a
  // separate finding and belongs in the copy review rather than here.

  /*
   * WHAT COUNTS AS RESOLVED.
   *
   * The first version of this checked `direction === "ltr"` only, and that
   * misses the correct answer. `unicode-bidi: plaintext` does NOT change the
   * computed `direction` -- it changes how the bidi algorithm resolves the
   * element's content, so a cell with plaintext still reports
   * `direction: rtl` while RENDERING its email left to right. Checking
   * direction alone reported 10 defects that were already fixed.
   */
  const resolved = (cs) => cs.direction === "ltr" || cs.unicodeBidi === "plaintext";

  const badDirection = [];
  const MONO = 'code, pre, .adm-mono, .adm-id__value, .rb-code-inline, [class*="mono"]';
  for (const el of document.querySelectorAll(MONO)) {
    const cs = getComputedStyle(el);
    if (!resolved(cs)) {
      badDirection.push({
        why: "monospace element is not ltr",
        tag: el.tagName,
        cls: (el.className || "").toString().slice(0, 28),
        txt: (el.textContent || "").trim().slice(0, 26),
      });
    }
  }
  // And any element whose own text LOOKS technical but inherits rtl.
  for (const el of document.querySelectorAll("main *")) {
    const hasText = [...el.childNodes].some(
      (c) => c.nodeType === 3 && c.textContent.trim().length > 3,
    );
    if (!hasText) continue;
    const t = (el.textContent || "").trim();
    if (!TECHNICAL.test(t)) continue;
    if (!resolved(getComputedStyle(el))) {
      badDirection.push({
        why: "technical string inherits rtl",
        tag: el.tagName,
        cls: (el.className || "").toString().slice(0, 28),
        txt: t.slice(0, 34),
      });
    }
  }

  /**
   * PHYSICAL PROPERTIES THAT SHOULD HAVE BEEN LOGICAL.
   *
   * Under RTL, `margin-left: 12px` stays on the left where
   * `margin-inline-start` would have moved to the right. Detected by asking
   * the element which of its own longhands it set asymmetrically AND whether
   * the corresponding logical property agrees — a genuinely mirrored element
   * shows the asymmetry on the INLINE-START side, which under rtl is the
   * right.
   */
  const physical = [];
  for (const el of document.querySelectorAll("main *")) {
    const cs = getComputedStyle(el);
    // Inline boxes report USED margins that no rule set -- rb-code-inline came
    // back with marginLeft 133px. Only block-level boxes are meaningful here.
    /*
     * INLINE BOXES ARE EXCLUDED, AND ONE STILL GETS THROUGH.
     *
     * getComputedStyle on an inline box reports a USED inline-axis margin
     * that no rule set: `.rb-code-inline` has no margin declaration at all in
     * runbooks.css and comes back with marginLeft between 117px and 400px,
     * varying with where the span happens to sit on its line. Those two
     * runbook routes are the only remaining "physical-prop" findings and they
     * are this artifact, not a leak.
     *
     * `display` is checked rather than the tag because a `<code>` set to
     * inline-flex or inline-block reports a real margin and should be caught.
     */
    if (cs.display === "inline" || cs.display === "inline flow") continue;

    /*
     * AN ELEMENT THAT PINS ITS OWN DIRECTION HAS ITS OWN INLINE AXIS.
     *
     * This check reads COMPUTED left/right, and under `direction: rtl` a
     * logical `padding-inline-start` computes to padding-RIGHT — which is what
     * makes the asymmetry test work. It does not hold for an element whose own
     * direction is LTR: there, inline-start IS the left, and a correctly
     * written logical property computes to padding-left.
     *
     * `.adm-mono` and `.rb-code-inline` do exactly that, on purpose:
     *
     *     .adm-mono { direction: ltr; unicode-bidi: isolate; }
     *
     * because an identifier is read left to right whatever the prose around it
     * does — this sweep's own header says a mirrored UUID is a wrong UUID.
     * Without this exemption the sweep reported 5 findings on
     * /admin/identity/permission-matrix and 33 on /admin/platform/runbooks, and
     * every one of them was a `paddingInlineStart` written correctly in the
     * source. An instrument that condemns the behaviour the phase implemented
     * deliberately does not find defects, it manufactures them.
     */
    if (cs.direction !== "rtl") continue;

    const ml = parseFloat(cs.marginLeft) || 0;
    const mr = parseFloat(cs.marginRight) || 0;
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    // Under rtl, inline-start is the RIGHT. An element using logical
    // properties therefore shows its asymmetry on the right.
    const leftHeavy =
      (ml - mr > 6 && mr === 0) ||
      (pl - pr > 10 && pr === 0) ||
      (bl > 0 && br === 0 && bl >= 2);
    if (leftHeavy) {
      physical.push({
        tag: el.tagName,
        cls: (el.className || "").toString().slice(0, 30),
        m: `${ml}/${mr}`,
        p: `${pl}/${pr}`,
        b: `${bl}/${br}`,
      });
    }
  }

  const crumb = document.querySelector(".adminnav__crumbs ol");
  const crumbDir = crumb ? getComputedStyle(crumb).direction : null;

  return {
    dir: doc.getAttribute("dir"),
    lang: doc.getAttribute("lang"),
    overflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
    badDirection: badDirection.slice(0, 5),
    badDirectionCount: badDirection.length,
    physical: physical.slice(0, 5),
    physicalCount: physical.length,
    crumbDir,
    h1: document.querySelectorAll("h1").length,
  };
};

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "ar",
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
    // THE REAL PATH: providers.tsx reads these and sets `dir` from the locale.
    window.localStorage.setItem("proovra-locale", "ar");
    window.localStorage.setItem("proovra-locale-mode", "manual");
  } catch {}
});
const page = await ctx.newPage();
await signIn(page);

const rows = [];
let bad = { overflow: 0, direction: 0, physical: 0, notRtl: 0 };
for (const route of routes) {
  /* Concrete, for the reason recorded on `concreteRoute`: a pattern route
     is not an address, and one of them resolves to a 404 outside the shell. */
  await page
    .goto(`${WEB}${concreteRoute(route)}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    .catch(() => {});
  /*
   * 3.5s, and the reason is a finding in itself.
   *
   * `providers.tsx` resolves the locale from localStorage on the CLIENT, after
   * mount, and only then sets `document.documentElement.dir`. So every page
   * renders LTR first and flips to RTL between 1s and 2s. Sampling /admin/audit
   * over time: ltr at 1000ms, rtl at 2000ms and after.
   *
   * At 1.8s this sweep caught eight of the slower routes mid-flip and reported
   * them as "dir=ltr", which reads as an RTL failure and is not one.
   *
   * THE FLASH ITSELF IS REAL and is reported as a finding: an Arabic operator
   * sees a left-to-right page for about a second on every navigation. Fixing
   * it means knowing the locale server-side (a cookie rather than
   * localStorage), which is an app-shell change rather than a visual one.
   */
  await page.waitForTimeout(3_500);
  /**
   * 3.5s IS STILL A GUESS, AND ONE ROUTE KEPT LOSING IT.
   *
   * This sweep seeds `preferences: false`, which is the honest thing to seed:
   * the locale cookie may not be written without preferences consent, so in
   * THIS configuration the server can only render `ltr` and the client effect
   * is what flips it. Every measurement here is therefore of a
   * post-hydration attribute, and a page slow to hydrate reads as an RTL
   * failure rather than as a slow page.
   *
   * `/admin/identity` — the heaviest page in the console, 2,900px and seven
   * selects — was reported `dir=ltr` on one pass. Re-run with this sweep's
   * exact seeding it reports `dir=rtl lang=ar` every time.
   *
   * So the flip is waited for, with a ceiling, instead of being timed. A page
   * that genuinely never flips still reports after the ceiling.
   *
   * (The flash this comment used to describe as unfixable IS fixed for the
   * consented case: the locale is mirrored into a cookie and the root layout
   * renders `dir` from it, so the document arrives correct. Where consent has
   * not been given there is no cookie to read, and LTR-then-flip is the
   * designed behaviour rather than a defect — a preference that may not be
   * stored cannot be known before hydration.)
   */
  await page
    .waitForFunction(() => document.documentElement.getAttribute("dir") === "rtl", {
      timeout: 12_000,
    })
    .catch(() => null);
  await strip(page).catch(() => {});
  const m = await page.evaluate(MEASURE).catch((e) => ({ error: String(e) }));
  rows.push({ route, ...m });
  if (m.dir !== "rtl") bad.notRtl += 1;
  if (m.overflow) bad.overflow += 1;
  if (m.badDirectionCount) bad.direction += 1;
  if (m.physicalCount) bad.physical += 1;
  const flag = [
    m.dir !== "rtl" ? `dir=${m.dir}` : "",
    m.overflow ? `OVERFLOW ${m.overflow}px` : "",
    m.badDirectionCount ? `${m.badDirectionCount} rtl-technical` : "",
    m.physicalCount ? `${m.physicalCount} physical-prop` : "",
  ].filter(Boolean).join(" · ");
  console.log(`${route.padEnd(46)} ${flag || "ok"}`);
  for (const b of m.badDirection ?? []) console.log(`      ${b.why}: ${b.tag}.${b.cls} "${b.txt}"`);
  for (const p of m.physical ?? []) console.log(`      physical ${p.tag}.${p.cls} m=${p.m} p=${p.p} b=${p.b}`);
}

mkdirSync("artifacts/admin-visual-review", { recursive: true });
writeFileSync("artifacts/admin-visual-review/rtl.json", JSON.stringify({ rows }, null, 2), "utf8");
console.log(
  `\nroutes=${rows.length}  not-rtl=${bad.notRtl}  with-overflow=${bad.overflow}  with-rtl-technical-text=${bad.direction}  with-physical-props=${bad.physical}`,
);
await browser.close();
