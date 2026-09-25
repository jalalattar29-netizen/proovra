/**
 * T-07 / RC-07 — the shared primitives must carry the PWA's shape, because the
 * PWA is the canonical design reference.
 *
 * THE DEFECT THESE TESTS WOULD HAVE CAUGHT
 * ----------------------------------------
 * Native rendered buttons at `radius.pill` (999) where the web uses 8px — a
 * capsule instead of a rounded rectangle, on every screen. It filled the
 * primary action flat where the web uses a 135deg gradient, used `ink.inverse`
 * (#F8FAFC) where the web uses #ffffff, and rounded inputs to 8px where the web
 * uses 6px.
 *
 * Each assertion is paired with the exact web rule it mirrors, and the last
 * test reads that rule back out of the stylesheet so a web restyle fails here
 * rather than drifting silently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const WEB = resolve(MOBILE, "../web");
const ui = readFileSync(resolve(MOBILE, "src/ui/index.tsx"), "utf8");
const css = readFileSync(resolve(WEB, "components/app-primitives/app-primitives.css"), "utf8");

/**
 * The declarations of the block a selector belongs to.
 *
 * Handles GROUPED selectors: `.app-input` is authored as
 * `.app-input, .app-select, .app-textarea { … }`, so looking for
 * `".app-input {"` finds nothing and the test passes vacuously.
 */
function rule(selector) {
  const re = new RegExp(`(^|[,}\\s])${selector.replace(".", "\\.")}\\s*[,{]`, "m");
  const m = css.match(re);
  assert.ok(m, `${selector} is no longer declared in app-primitives.css`);
  const open = css.indexOf("{", m.index);
  assert.ok(open > 0, `${selector} has no declaration block`);
  return css.slice(open, css.indexOf("}", open));
}

test("the button is a rounded rectangle, not a capsule", () => {
  const start = ui.indexOf("  button: {");
  const block = ui.slice(start, ui.indexOf("},", start));
  assert.match(
    block,
    /borderRadius: theme\.radius\.md/,
    "the button no longer uses radius.md (8px). The web's .app-primary-action " +
      "is border-radius: 8px; radius.pill (999) renders a capsule instead.",
  );
  assert.doesNotMatch(block, /radius\.pill/, "the button reverted to the pill radius");
  // The touch-target adaptation must survive the shape change.
  assert.match(block, /minHeight: MIN_TOUCH/, "the 44pt minimum touch target was lost");
});

test("the primary action is a gradient, matching the web", () => {
  // The stops arrive through the theme — accent.a500/a600 ARE #7C3AED/#6D28D9 —
  // because `ui-kit.render.test.mjs` forbids a raw hex anywhere in the kit.
  // That guard is correct and was NOT weakened to accommodate this change; the
  // value was added to tokens.css and regenerated instead.
  assert.match(
    ui,
    /PRIMARY_GRADIENT = \[theme\.color\.accent\.a500, theme\.color\.accent\.a600\]/,
    "the gradient stops no longer come from the accent tokens",
  );
  assert.match(ui, /<LinearGradient/, "ProovraButton renders no gradient layer");
  // It must be scoped to the primary variant — the other variants are flat on
  // the web, and painting them would be a different defect.
  assert.match(ui, /variant === "primary" && !isDisabled \? \(/, "the gradient is not scoped to the primary variant");
});

test("the primary foreground is true white, not ink.inverse", () => {
  const start = ui.indexOf('case "primary":');
  const block = ui.slice(start, start + 260);
  assert.match(block, /fg: theme\.color\.ink\.onAccent/, "the primary foreground is not ink.onAccent");
  assert.doesNotMatch(
    block,
    /fg: theme\.color\.ink\.inverse/,
    "the primary foreground reverted to ink.inverse (#F8FAFC), which is not white",
  );
});

test("the input uses the web's 6px radius", () => {
  const start = ui.indexOf("  input: {");
  const block = ui.slice(start, ui.indexOf("},", start));
  assert.match(
    block,
    /borderRadius: theme\.radius\.sm/,
    "the input no longer uses radius.sm (6px); .app-input is border-radius: var(--radius-sm)",
  );
});

test("the native values still match the web stylesheet", () => {
  // Falsifiable against the reference rather than against itself.
  const primary = rule(".app-primary-action");
  assert.match(primary, /border-radius:\s*8px/, "the web primary action is no longer 8px");
  assert.match(
    primary,
    /linear-gradient\(135deg,\s*#7C3AED 0%,\s*#6D28D9 100%\)/,
    "the web primary gradient changed; PRIMARY_GRADIENT must follow it",
  );
  assert.match(primary, /color:\s*#ffffff/, "the web primary foreground changed");

  const input = rule(".app-input");
  assert.match(input, /border-radius:\s*var\(--radius-sm\)/, "the web input radius changed");

  const tokens = readFileSync(resolve(WEB, "lib/design-tokens/tokens.css"), "utf8");
  assert.match(tokens, /--ink-on-accent:\s*#ffffff/, "--ink-on-accent must be true white to match .app-primary-action");
  assert.match(tokens, /--accent-500:\s*#7C3AED/, "--accent-500 must remain the gradient start");
  assert.match(tokens, /--accent-600:\s*#6D28D9/, "--accent-600 must remain the gradient end");
  assert.match(tokens, /--radius-sm:\s*6px/, "--radius-sm is no longer 6px");
  assert.match(tokens, /--radius-md:\s*8px/, "--radius-md is no longer 8px");
});
