/**
 * THE ONE THING THIS PACKAGE CAN GET WRONG.
 *
 * `@proovra/ui` is five constant tables — colours, radii, spacing, typography,
 * shadows — consumed by the mobile app through one barrel. It has no branch, no
 * function and no state, so its `test` script was `echo "(no tests)"` and the
 * CI step that ran it was green without executing anything. That is honest
 * labelling of an empty suite and still a hollow gate: a release step that
 * cannot fail teaches nobody anything.
 *
 * There IS something to hold. A token table is only useful if every entry is a
 * value the consumer can render, and the failure mode is a typo — a five-digit
 * hex, a missing `#`, an alias pointing at a key that was renamed. None of that
 * is caught by a typecheck: `"#0B1F5"` is a perfectly good `string`.
 *
 * Nothing here asserts that a token EQUALS a particular value. Pinning the
 * palette to itself would be the tautology the "(no tests)" script at least did
 * not pretend to be.
 *
 * THE MODULES ARE IMPORTED BY EXPLICIT PATH, AND THE BARREL IS READ.
 * `dist/index.js` re-exports with EXTENSIONLESS specifiers — `./tokens/colors` —
 * which Metro resolves for the mobile app and Node's ESM loader does not. So
 * each module is imported by its real path and the barrel is checked for its
 * re-export lines, rather than changing the package's emit to suit its test.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const colorsMod = await import("../dist/tokens/colors.js");
const radiusMod = await import("../dist/tokens/radius.js");
const spacingMod = await import("../dist/tokens/spacing.js");
const typographyMod = await import("../dist/tokens/typography.js");
const shadowsMod = await import("../dist/tokens/shadows.js");

const ui = {
  ...colorsMod,
  ...radiusMod,
  ...spacingMod,
  ...typographyMod,
  shadows: shadowsMod.shadows,
};

const BARREL = readFileSync(
  fileURLToPath(new URL("../dist/index.js", import.meta.url)),
  "utf8",
);

const CSS_COLOR =
  /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)|transparent|currentColor)$/;

test("the barrel re-exports every token module", () => {
  for (const mod of ["colors", "radius", "spacing", "typography", "shadows"]) {
    assert.ok(
      BARREL.includes(`"./tokens/${mod}"`),
      `dist/index.js does not re-export tokens/${mod}`,
    );
  }
});

test("the token groups the app imports are present and non-empty", () => {
  for (const name of ["baseColors", "colors", "radius", "spacing", "typography", "shadows"]) {
    assert.ok(name in ui, `@proovra/ui does not export ${name}`);
    assert.ok(ui[name] && typeof ui[name] === "object", `${name} is not a table`);
    assert.ok(Object.keys(ui[name]).length > 0, `${name} is empty`);
  }
});

test("every colour token is a value a renderer can accept", () => {
  for (const [table, name] of [
    [ui.baseColors, "baseColors"],
    [ui.colors, "colors"],
  ]) {
    for (const [key, value] of Object.entries(table)) {
      assert.equal(typeof value, "string", `${name}.${key} is not a string`);
      assert.match(value, CSS_COLOR, `${name}.${key} = ${value} is not a colour`);
    }
  }
});

test("the alias table resolves — no colors entry is a dangling name", () => {
  for (const [key, value] of Object.entries(ui.colors)) {
    assert.notEqual(value, undefined, `colors.${key} is undefined`);
  }
  for (const key of Object.keys(ui.baseColors)) {
    assert.equal(
      ui.colors[key],
      ui.baseColors[key],
      `colors.${key} disagrees with baseColors.${key}`,
    );
  }
});

test("the numeric scales are finite, non-negative numbers", () => {
  for (const [table, name] of [
    [ui.radius, "radius"],
    [ui.spacing, "spacing"],
  ]) {
    for (const [key, value] of Object.entries(table)) {
      assert.equal(typeof value, "number", `${name}.${key} is not a number`);
      assert.ok(Number.isFinite(value), `${name}.${key} is not finite`);
      assert.ok(value >= 0, `${name}.${key} is negative`);
    }
  }
});

test("the typography scale is complete and usable", () => {
  // Four sub-tables with different value kinds: two font families (strings),
  // a size and a lineHeight scale (numbers), and a weight scale (the numeric
  // strings React Native wants). Each is checked as what it is.
  const { fontFamily, size, weight, lineHeight } = ui.typography;
  for (const [key, value] of Object.entries(fontFamily)) {
    assert.equal(typeof value, "string", "fontFamily." + key + " is not a string");
    assert.ok(value.length > 0, "fontFamily." + key + " is empty");
  }
  for (const [table, name] of [
    [size, "size"],
    [lineHeight, "lineHeight"],
  ]) {
    for (const [key, value] of Object.entries(table)) {
      assert.equal(typeof value, "number", name + "." + key + " is not a number");
      assert.ok(Number.isFinite(value) && value > 0, name + "." + key + " is not a usable size");
    }
  }
  for (const [key, value] of Object.entries(weight)) {
    assert.match(String(value), /^[1-9]00$/, "weight." + key + " = " + value + " is not a font weight");
  }
  // Every size has a line height to sit on. A size without one is how a scale
  // silently loses a step in a merge.
  for (const key of Object.keys(size)) {
    if (key === "h4") continue; // h4 shares body's line height by design
    assert.ok(key in lineHeight, "size." + key + " has no lineHeight");
  }
});
