/**
 * Phase REPORT-RENDERER-FIX — regression lock for the `__name is not
 * defined` failure that prevented every report PDF from being
 * rendered.
 *
 * ROOT CAUSE
 *
 * `services/worker/src/report-v2/render-pdf.ts` calls
 * `page.evaluate(async () => { ... })` and
 * `page.evaluate(() => { ... })` with TypeScript arrow functions.
 *
 * tsx (in dev) and tsc (in prod) both transpile arrow / class /
 * decorator constructs and emit helper-symbol references like
 * `__name(fn, "label")`. When puppeteer's `page.evaluate(fn)`
 * serialises the function via `.toString()`, those helper-symbol
 * references end up in the JavaScript that the headless Chrome
 * actually executes — and the browser has no `__name` binding.
 * The browser throws `ReferenceError: __name is not defined`, the
 * report job hits 6 retries, lands in DLQ, and the user's Evidence
 * Detail page sits at SIGNED forever.
 *
 * THE FIX
 *
 * Pass the evaluate body as a **plain string** (template-literal),
 * so the body is sent verbatim to the browser. The transpiler can
 * never insert helpers into a string literal.
 *
 * THIS TEST
 *
 *   1. The render-pdf.ts file contains NO `page.evaluate(<arrow>)`
 *      call that the transpiler could mangle. Every evaluate body
 *      must be passed as a string.
 *   2. The render-pdf.ts file MUST NOT export any reference to
 *      `__name` — if a refactor accidentally re-introduces a
 *      transpiled arrow function inside an evaluate, this test
 *      catches it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const RENDER_PDF = readFileSync(
  resolve(REPO_ROOT, "services", "worker", "src", "report-v2", "render-pdf.ts"),
  "utf8",
);

describe("render-pdf.ts — __name regression lock", () => {
  it("every page.evaluate(...) call is passed a STRING template, not an arrow function", () => {
    // The transpiler-safe shape is:
    //   page.evaluate(`(...)`)
    //   page.evaluate(`(async () => { ... })()`)
    // The broken shape is:
    //   page.evaluate(() => { ... })
    //   page.evaluate(async () => { ... })
    //   page.evaluate(function () { ... })
    //
    // Grep for evaluate() calls whose first argument is a function
    // expression. Any match fails the lock.
    const evaluateFnArg = /page\.evaluate\(\s*(?:async\s*)?(?:\(|function\s*\()/g;
    const offenders: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = evaluateFnArg.exec(RENDER_PDF)) !== null) {
      const start = Math.max(0, match.index - 40);
      const end = Math.min(RENDER_PDF.length, match.index + 60);
      offenders.push(RENDER_PDF.slice(start, end));
    }
    expect(
      offenders.length,
      `Found ${offenders.length} page.evaluate() call(s) passed a function expression. ` +
        `These break in headless Chrome with ReferenceError: __name is not defined when ` +
        `the worker is run via tsx/tsc, because the helper-symbol references inserted by ` +
        `the transpiler get serialised into the browser body. Pass the body as a string ` +
        `template literal instead. Offenders:\n${offenders.join("\n---\n")}`,
    ).toBe(0);
  });

  it("at least two evaluate(...) calls remain in the file, each passing a string template", () => {
    // The two original calls (font/image readiness + footer metadata)
    // are still needed; the fix is the SHAPE not the count.
    const stringEvaluate = RENDER_PDF.match(/page\.evaluate\(\s*`/g) ?? [];
    expect(stringEvaluate.length).toBeGreaterThanOrEqual(2);
  });

  it("the file documents the WHY of the fix (so a future contributor doesn't 'simplify' it back)", () => {
    expect(RENDER_PDF).toMatch(/__name/);
    expect(RENDER_PDF).toMatch(/ReferenceError/);
  });

  it("the renderer still resolves an executable Chrome path before launch (no fake render)", () => {
    expect(RENDER_PDF).toMatch(/resolveBrowserExecutablePath\(\)/);
    expect(RENDER_PDF).toMatch(/No usable Chromium executable was found/);
  });
});
