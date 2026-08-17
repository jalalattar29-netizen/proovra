/**
 * PHASE 13 (NEW-060) — THE ONE PLACE ZOD'S RUNTIME IS CONFIGURED.
 *
 * WHAT THIS FIXES
 * ---------------------------------------------------------------------------
 * Under the application's strict CSP, every page that loads a Zod schema
 * reported a real `script-src` violation:
 *
 *   script-src blocked eval (…/governance-platform/policies)
 *     [source=…/_next/static/chunks/7746-*.js:1:6676 sample=""]
 *
 * The offset resolves to Zod 4's own eval-capability probe
 * (`zod/v4/core/util.js` → `allowsEval`):
 *
 *   export const allowsEval = cached(() => { … const F = Function; new F(""); … });
 *
 * `$ZodObject` reads it while a schema is being CONSTRUCTED, to decide whether
 * to compile a `new Function`-based fast validator. `new F("")` is an eval, the
 * CSP refuses it, and the browser reports a violation before Zod falls back to
 * the interpreted path.
 *
 * So the violation was never harness instrumentation and never a browser
 * extension — it was product code (a bundled dependency), on every schema-
 * bearing page, in production. A text search for `eval(` could not find it,
 * because the call is spelled `new Function`.
 *
 * WHY `jitless` REMOVES THE PROBE RATHER THAN JUST THE FAST PATH
 * ---------------------------------------------------------------------------
 * `zod/v4/core/schemas.js` computes
 *
 *   const jit = !core.globalConfig.jitless;
 *   const fastEnabled = jit && allowsEval.value;
 *
 * `&&` short-circuits, so with `jitless: true` the getter is never read and
 * the `new Function("")` is never evaluated. This is therefore a removal of
 * the eval-generating path, not a suppression of its report — nothing is added
 * to the CSP, and `'unsafe-eval'` stays absent.
 *
 * WHY THE BROWSER ONLY
 * ---------------------------------------------------------------------------
 * The JIT fast path is a validation optimisation, and in the browser it is one
 * the product can never actually have: the CSP that refuses the probe would
 * equally refuse the compiled validator, so `allowsEval` resolves `false`
 * there and Zod uses the interpreted path regardless. Disabling it in the
 * browser costs nothing and buys a clean CSP posture. Node has no CSP and IS
 * the hot validation path (every API request body), so the fast path is left
 * intact there.
 *
 * HOW TO KEEP THIS WORKING
 * ---------------------------------------------------------------------------
 * `allowsEval` is read at schema CONSTRUCTION time, and most schema modules
 * build their schemas at module scope. So this module must be evaluated before
 * the first `z.object()` in the graph — which is why it is the FIRST import in
 * `packages/shared/src/index.ts`, ahead of that file's own `import { z }`, and
 * why any other client-side module that defines Zod schemas imports it too
 * (`@proovra/shared/zod-runtime-config`). Adding a new client-side schema
 * module without that import re-opens the violation on that page only.
 */

import { config } from "zod";

/**
 * True in a document context — the only place a Content-Security-Policy can
 * refuse an eval. Deliberately `document` rather than `window`: a worker has a
 * `self` and no CSP-bearing document, and SSR has neither.
 */
const inBrowser =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { document?: unknown }).document !== "undefined";

if (inBrowser) {
  config({ jitless: true });
}

/** Exported so the module cannot be tree-shaken as a pure side effect. */
export const ZOD_JITLESS_IN_BROWSER = inBrowser;
