/**
 * The Technical Appendix section header — ONE anatomy, two axes.
 *
 * `.ta-intro` is the horizontal axis: an optional leading icon beside a copy
 * column. `.ta-intro-copy` is the vertical axis: a title with its description
 * underneath. A consumer that skips the copy column puts its `<h2>` and `<p>`
 * directly into the horizontal axis, and the engine paints them as two columns
 * — the heading on one side, the sentence that explains it on the other.
 *
 * The browser project `e2e/evidence-detail-layout` measures the resulting
 * boxes. This file holds the SOURCE contract, so the anatomy cannot be broken
 * silently in a component that no geometry test happens to visit, and so the
 * fix cannot quietly become a `<br>`, a fixed width or an override.
 */
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const WEB = resolve(dirname(__filename), "..");
const read = (rel: string) => readFileSync(resolve(WEB, rel), "utf8");

const CSS = "app/(app)/evidence/[id]/evidence-detail.css";

/** Every .tsx under the evidence detail route. */
function routeFiles(): string[] {
  const root = resolve(WEB, "app/(app)/evidence/[id]");
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".tsx")) out.push(p);
    }
  })(root);
  return out;
}

/** The declared body of a CSS rule, read from the shipped stylesheet. */
function rule(selector: string): string {
  const css = read(CSS);
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no rule for ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

test("the copy column is a vertical axis with one spacing authority", () => {
  const copy = rule(".ta-intro-copy");
  assert.match(copy, /display:\s*flex/);
  assert.match(copy, /flex-direction:\s*column/);
  assert.match(copy, /gap:\s*4px/);
  // It takes the row it is given, so the title has the full measure and never
  // shares a track with the sentence beneath it.
  assert.match(copy, /flex:\s*1 1 auto/);

  // The gap is the ONLY spacing authority: neither child declares a margin
  // for the space between them.
  assert.match(rule(".ta-intro-sub"), /margin:\s*0;/);
  assert.match(rule(".ta-intro-title"), /margin:\s*0;/);
});

test("the description keeps the canonical secondary ink and a readable line", () => {
  const sub = rule(".ta-intro-sub");
  assert.match(sub, /color:\s*var\(--app-ink-secondary\)/);
  const size = Number(sub.match(/font-size:\s*([\d.]+)px/)?.[1]);
  const line = Number(sub.match(/line-height:\s*([\d.]+)px/)?.[1]);
  assert.ok(size > 0 && line > 0, "size and line-height are declared in px");
  assert.ok(
    line / size >= 1.4,
    `line-height ${line}/${size} = ${(line / size).toFixed(2)} is too tight`,
  );

  // The heading stays the heading tier: larger, heavier, heading ink.
  const title = rule(".ta-intro-title");
  const titleSize = Number(title.match(/font-size:\s*([\d.]+)px/)?.[1]);
  assert.ok(titleSize > size + 3, "the heading is not a distinct tier");
  assert.match(title, /color:\s*var\(--app-ink-heading\)/);
});

test("every consumer of the section header uses the copy column", () => {
  const offenders: string[] = [];
  for (const file of routeFiles()) {
    const src = readFileSync(file, "utf8");
    let index = src.indexOf('className="ta-intro"');
    while (index >= 0) {
      // The block from this `.ta-intro` up to the next section-level marker.
      const window = src.slice(index, index + 900);
      const hasTitle = window.includes('className="ta-intro-title"');
      const hasCopy = window.includes('className="ta-intro-copy"');
      if (hasTitle && !hasCopy) {
        offenders.push(`${file.slice(WEB.length + 1)} — title outside the copy column`);
      }
      index = src.indexOf('className="ta-intro"', index + 1);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the hierarchy is not forced by markup, width or an override", () => {
  const appendix = read(
    "app/(app)/evidence/[id]/_tabs/technical-appendix/EvidenceTechnicalAppendix.tsx",
  );
  const intro = appendix.slice(
    appendix.indexOf('className="ta-intro"'),
    appendix.indexOf('className="ta-grid"'),
  );
  // No line break element, no inline style, no width forced onto the copy.
  assert.doesNotMatch(intro, /<br\s*\/?>/i);
  assert.doesNotMatch(intro, /style=\{\{/);
  assert.doesNotMatch(intro, /width|maxWidth|flexBasis/);

  // And nothing in the stylesheet props the anatomy up with an escape hatch.
  const css = read(CSS);
  const block = css.slice(
    css.indexOf(".ta-intro {"),
    css.indexOf(".ta-grid {"),
  );
  assert.doesNotMatch(block, /!important/);
  assert.doesNotMatch(block, /:nth-child|:first-child|:last-child|\+\s*\./);
  assert.doesNotMatch(block, /\bwidth:\s*\d/);
});
