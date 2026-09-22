/**
 * GUARD — the token module is DERIVED from the web design authority.
 *
 * Replaces `apps/mobile/test/design-token-parity.test.mjs`, which compared a
 * hand-written list of 27 literal pairs across two hand-authored files. It
 * could only ever prove the 27 it named: 63 of the CSS file's custom properties
 * were mirrored, ~95 were not, and nothing failed for the ones nobody listed.
 *
 * Drift is now impossible rather than detected: `tokens.css` is the only
 * authored source and `proovra.generated.ts` is emitted from it. This guard
 * re-runs the generator and fails when the checked-in artefact differs — and
 * separately checks the properties that make the output USABLE on native
 * (every `var()` flattened, radii and spacing as numbers, badge tones complete).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  generate,
  OUT_TS,
  TOKENS_CSS,
  parseRootTokens,
  resolveAliases,
  nestStatus,
} from "../tools/generate-tokens.mjs";

const css = readFileSync(TOKENS_CSS, "utf8");

test("the checked-in token module matches a fresh generation", () => {
  const { source } = generate();
  assert.equal(
    readFileSync(OUT_TS, "utf8"),
    source,
    "proovra.generated.ts is stale — run: node packages/ui/tools/generate-tokens.mjs",
  );
});

test("the web authority still parses and is substantial", () => {
  const vars = parseRootTokens(css);
  assert.ok(vars.size > 120, `expected >120 custom properties, parsed ${vars.size}`);
  assert.ok(vars.has("ink-primary") && vars.has("accent-500") && vars.has("surface-app"));
});

test("documentation comments inside :root are not parsed as declarations", () => {
  // tokens.css records several decisions in long block comments INSIDE :root,
  // and those contain both ';' and '--name:' text. A scan over the raw source
  // captured a paragraph of prose as a token value.
  const vars = parseRootTokens(css);
  for (const [name, value] of vars) {
    assert.ok(value.length < 200, `--${name} captured prose as its value: ${value.slice(0, 80)}…`);
    assert.doesNotMatch(value, /\n\s{2,}[A-Z]/, `--${name} captured a comment body`);
  }
});

test("every var() alias is flattened — React Native has no cascade", () => {
  const generated = readFileSync(OUT_TS, "utf8");
  assert.doesNotMatch(
    generated,
    /var\(--/,
    "an unresolved var() would reach a StyleSheet as a literal string and render nothing",
  );
});

test("aliases resolve transitively and honour CSS fallback semantics", () => {
  const resolved = resolveAliases(
    new Map([
      ["a", "#111111"],
      ["b", "var(--a)"],
      ["c", "var(--b)"],
      ["d", "var(--missing, #222222)"],
    ]),
  );
  assert.equal(resolved.get("b"), "#111111");
  assert.equal(resolved.get("c"), "#111111", "resolution must be transitive");
  assert.equal(resolved.get("d"), "#222222", "an undefined target must fall back like CSS");
});

test("a circular alias is refused rather than emitted", () => {
  assert.throws(
    () => resolveAliases(new Map([["a", "var(--b)"], ["b", "var(--a)"]])),
    /circular/,
  );
});

test("an alias to a token that does not exist is refused", () => {
  assert.throws(() => resolveAliases(new Map([["a", "var(--nope)"]])), /never declared/);
});

test("badge tones are complete; text-only tones are kept separately", () => {
  const { badge, text } = nestStatus({
    verifiedBg: "#1", verifiedFg: "#2", verifiedBorder: "#3", verifiedSolid: "#4",
    okFg: "#5",
  });
  assert.deepEqual(Object.keys(badge), ["verified"]);
  assert.deepEqual(badge.verified, { bg: "#1", fg: "#2", border: "#3", solid: "#4" });
  assert.deepEqual(text, { ok: "#5" });
});

test("every emitted badge tone really has all four parts", async () => {
  const { proovraStatus } = await import("../src/tokens/proovra.generated.ts").catch(() => ({}));
  // The module is TypeScript; when it cannot be imported directly, assert over
  // the emitted source instead — the shape is what matters either way.
  if (proovraStatus) {
    for (const [tone, parts] of Object.entries(proovraStatus)) {
      for (const p of ["bg", "fg", "border", "solid"]) {
        assert.ok(parts[p], `status tone ${tone} is missing ${p}`);
      }
    }
    return;
  }
  const src = readFileSync(OUT_TS, "utf8");
  const block = src.match(/export const proovraStatus = \{([\s\S]*?)\n\} as const;/)[1];
  for (const tone of block.matchAll(/^ {2}([a-zA-Z0-9]+): \{([\s\S]*?)^ {2}\},/gm)) {
    for (const p of ["bg", "fg", "border", "solid"]) {
      assert.match(tone[2], new RegExp(`\\b${p}:`), `status tone ${tone[1]} is missing ${p}`);
    }
  }
});

test("radii and spacing arrive as numbers React Native can use", () => {
  const src = readFileSync(OUT_TS, "utf8");
  for (const group of ["proovraRadius", "proovraSpace"]) {
    const block = src.match(new RegExp(`export const ${group} = \\{([\\s\\S]*?)\\n\\} as const;`))[1];
    for (const line of block.split("\n").filter((l) => l.trim())) {
      const value = line.split(":").slice(1).join(":").trim().replace(/,$/, "");
      assert.doesNotMatch(value, /px|rem|em/, `${group} must be unitless numbers, found ${line.trim()}`);
    }
  }
});

test("identifier-safe aliases exist for the digit-leading canonical names", () => {
  const src = readFileSync(OUT_TS, "utf8");
  assert.match(src, /\bs4: 16,/, "space must expose s4 alongside the canonical 4");
  assert.match(src, /\ba500: "#7C3AED",/, "accent must expose a500 alongside the canonical 500");
});

test("the hand-mirrored literals are gone from the authored module", () => {
  const authored = readFileSync(new URL("../src/tokens/proovra.ts", import.meta.url), "utf8");
  assert.match(authored, /from "\.\/proovra\.generated"/, "the bundle must read the generated artefact");
  const colourLiterals = authored.match(/#[0-9A-Fa-f]{6}/g) ?? [];
  assert.deepEqual(
    colourLiterals,
    [],
    "a colour literal here is a second authored source — put it in tokens.css",
  );
});
