/**
 * `.app-field-label` — ONE declaration, product-wide.
 *
 * There were two. The canonical primitive in `app-primitives.css` set the
 * label tier (12.5px, weight 600, `--app-ink-label`); a second copy near the
 * bottom of `globals.css`, written for a dark admin shell that never used it,
 * set 11px uppercase weight-800 in `rgba(194, 204, 201, 0.56)`.
 *
 * Both are a single class, so specificity ties and SOURCE ORDER decides. The
 * primitive is `@import`ed at the top of `globals.css`, so the pale rule won —
 * and every field label in the authenticated product was painted at 56% alpha
 * on a light surface. It read as helper text, and no component could see why,
 * because nothing in any component or route stylesheet mentioned it.
 *
 * A duplicate that loses is invisible. A duplicate that wins is a second
 * authority. This test allows neither.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const WEB = resolve(dirname(__filename), "..");
const read = (rel: string) => readFileSync(resolve(WEB, rel), "utf8");

const PRIMITIVES = "components/app-primitives/app-primitives.css";

/** Every stylesheet the app cascade pulls in, in import order. */
function importedStylesheets(): string[] {
  const globals = read("app/globals.css");
  const imports = [...globals.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]!);
  return [
    ...imports
      .filter((p) => p.startsWith(".") && p.endsWith(".css"))
      .map((p) => resolve(WEB, "app", p).slice(WEB.length + 1).replace(/\\/g, "/")),
    "app/globals.css",
  ];
}

test("the field-label rule is declared exactly once, in the primitive", () => {
  const sheets = importedStylesheets();
  assert.ok(
    sheets.includes(PRIMITIVES),
    "the primitives sheet is no longer in the cascade",
  );

  const declaringSheets: string[] = [];
  for (const sheet of sheets) {
    // A RULE for the bare class — not a compound selector that merely mentions
    // it (`.app-field-label + p`, `.something .app-field-label`), which is a
    // contextual adjustment rather than a second definition of the tier.
    const rules = [...read(sheet).matchAll(/(^|\})\s*\.app-field-label\s*\{/gm)];
    if (rules.length > 0) declaringSheets.push(`${sheet} ×${rules.length}`);
  }
  assert.deepEqual(declaringSheets, [`${PRIMITIVES} ×1`]);
});

test("the one declaration is the label tier, not a pale uppercase variant", () => {
  const css = read(PRIMITIVES);
  const start = css.indexOf(".app-field-label {");
  const body = css.slice(start, css.indexOf("}", start));

  assert.match(body, /color:\s*var\(--app-ink-label\)/);
  assert.match(body, /font-weight:\s*600/);
  // The tier is legible at its size: no uppercase, no 11px, no alpha.
  assert.doesNotMatch(body, /text-transform/);
  assert.doesNotMatch(body, /rgba\(/);
  assert.match(body, /font-size:\s*12\.5px/);
});

test("the retired pale value is gone from the cascade entirely", () => {
  for (const sheet of importedStylesheets()) {
    assert.doesNotMatch(
      read(sheet),
      /\.app-field-label[^{}]*\{[^}]*rgba\(194,\s*204,\s*201/,
      `${sheet} still paints the retired pale label`,
    );
  }
});
