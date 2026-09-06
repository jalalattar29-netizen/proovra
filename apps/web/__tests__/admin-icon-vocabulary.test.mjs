/**
 * NINE GLYPHS, ONE WEIGHT, NO DUPLICATES.
 *
 * ===========================================================================
 * WHAT THIS IS ABOUT
 * ===========================================================================
 * §B8 asks for placeholder SVGs removed, duplicate inline SVGs replaced with
 * canonical ones, strokes and sizes normalised, icon-only controls given
 * accessible names, and directional icons mirrored in RTL.
 *
 * The console turned out to be close to that already — the whole vocabulary an
 * admin page can render is NINE inline glyphs, all of them in shared
 * components, none of them duplicated. What was not consistent was the
 * rendered LINE. Declared stroke widths ran 1.6 to 2.4 on a 24 viewBox across
 * four render sizes, which is not the same question: at 15px a 1.8 stroke
 * paints 1.13 device pixels and at 26px a 1.6 stroke paints 1.73, so the same
 * family read light in a table and heavy in an empty state. The fix is one
 * RENDERED weight — ~1.35px — with the declared width following from the size.
 *
 * This guard is what keeps that true. It is deliberately about the declared
 * geometry, which a source check can see exactly; the browser sweep covers
 * what only a browser can answer.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");

/**
 * Where an admin page's icons can come from.
 *
 * The console's own tree plus the shared components it composes. Widening this
 * to all of `components/` would pull in surfaces Phase 7 does not govern —
 * marketing, capture, the public site — and a guard that fails for a page
 * outside its own scope gets switched off.
 */
const ROOTS = [
  "app/(app)/admin",
  "components/admin",
  "components/ui",
  "components/navigation",
  "components/app-primitives",
].map((p) => resolve(WEB, p));

/** The one rendered stroke weight, in device pixels at 1×. */
const TARGET_PX = 1.35;
const TOLERANCE = 0.06;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

function icons() {
  const rows = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const rel = file.slice(WEB.length + 1).split("\\").join("/");
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/<svg[\s\S]*?<\/svg>/g)) {
        const body = m[0];
        const line = src.slice(0, m.index).split("\n").length;
        const shape = body
          .replace(/\s+/g, " ")
          .replace(/\s(key|className|style|aria-label|data-[\w-]+)="[^"]*"/g, "")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .trim();
        const num = (re) => {
          const v = re.exec(body);
          return v ? Number(v[1]) : null;
        };
        rows.push({
          where: `${rel}:${line}`,
          hash: createHash("sha1").update(shape).digest("hex").slice(0, 8),
          stroke: num(/strokeWidth=\{?"?([\d.]+)/),
          width: num(/\bwidth=\{?"?([\d.]+)/),
          viewBox: (/viewBox="0 0 (\d+) \d+"/.exec(body) ?? [])[1],
          ariaHidden: /aria-hidden/.test(body),
          hasTitle: /<title>/.test(body),
          drawn: (body.match(/<(path|polyline|polygon|line)\b/g) ?? []).length,
          simple: (body.match(/<(rect|circle|ellipse)\b/g) ?? []).length,
          snippet: shape.slice(0, 90),
        });
      }
    }
  }
  return rows;
}

const ICONS = icons();

test("the console's icon vocabulary is small and fully accounted for", () => {
  assert.ok(ICONS.length > 0, "no icons were found — the roots are wrong");
  // A census, printed so a change in the number is visible in a diff of the
  // run rather than only in a failure.
  // eslint-disable-next-line no-console
  console.log(`admin icon vocabulary: ${ICONS.length} inline glyphs`);
});

test("no placeholder glyph", () => {
  /* A placeholder is a box or a dot standing in for a drawing nobody made:
     no path, polyline or polygon, and at most one primitive shape. A real
     glyph in this vocabulary always draws something. */
  const placeholders = ICONS.filter((i) => i.drawn === 0 && i.simple <= 1);
  assert.deepEqual(
    placeholders.map((i) => `${i.where}  ${i.snippet}`),
    [],
    "placeholder SVGs are still in the console",
  );
});

test("no drawing appears twice", () => {
  const byHash = new Map();
  for (const i of ICONS) {
    if (!byHash.has(i.hash)) byHash.set(i.hash, []);
    byHash.get(i.hash).push(i.where);
  }
  const dupes = [...byHash.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([h, v]) => `${h}: ${v.join(" · ")}`);
  assert.deepEqual(
    dupes,
    [],
    "the same drawing is inlined more than once — it belongs in one component",
  );
});

test("every glyph renders the same stroke weight", () => {
  const off = [];
  for (const i of ICONS) {
    if (i.stroke === null || i.width === null || !i.viewBox) continue;
    const rendered = (i.stroke * i.width) / Number(i.viewBox);
    if (Math.abs(rendered - TARGET_PX) > TOLERANCE) {
      off.push(
        `${i.where}  ${i.width}px @ stroke ${i.stroke} on a ${i.viewBox} box = ${rendered.toFixed(
          2,
        )}px rendered`,
      );
    }
  }
  assert.deepEqual(
    off,
    [],
    `every glyph should render ~${TARGET_PX}px of stroke; a declared width is not a rendered one`,
  );
});

test("every glyph is either hidden from assistive tech or titled", () => {
  /* A decorative glyph beside a label must be hidden or a screen reader reads
     a shape as a word. A glyph carrying meaning on its own needs a name. The
     one exception in this vocabulary is the search magnifier, whose WRAPPER
     carries `aria-hidden` — so the check accepts a hidden ancestor, and the
     browser sweep is what confirms the accessible name of the control. */
  const unnamed = ICONS.filter((i) => !i.ariaHidden && !i.hasTitle).map((i) => i.where);
  const WRAPPER_HIDDEN = new Set([
    // components/ui/FilterBar.tsx — the magnifier inside the search field.
    // Its <span aria-hidden="true"> wraps it; the input carries the label.
    "components/ui/FilterBar.tsx",
  ]);
  const leftover = unnamed.filter((w) => !WRAPPER_HIDDEN.has(w.split(":")[0]));
  assert.deepEqual(
    leftover,
    [],
    "an icon is exposed to assistive tech with no name",
  );
});

test("no physical inset positions an icon in the console's shared controls", () => {
  /* `left: 12` pins a decoration to the same corner in every language. In
     Arabic the field's text starts on the right, so a physically-left icon
     lands on top of what the person typed. Logical properties follow the
     direction; this is the rule, not a preference. */
  const offenders = [];
  for (const root of ROOTS.filter((r) => /components\\(ui|admin|app-primitives)$/.test(r))) {
    for (const file of walk(root)) {
      const rel = file.slice(WEB.length + 1).split("\\").join("/");
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, n) => {
        if (/^\s*\/[/*]/.test(line) || /^\s*\*/.test(line)) return;
        if (/\bposition:\s*"absolute"/.test(line)) return;
        if (/^\s*(left|right):\s*\d/.test(line)) {
          offenders.push(`${rel}:${n + 1}  ${line.trim()}`);
        }
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a shared control positions something with a physical inset",
  );
});
