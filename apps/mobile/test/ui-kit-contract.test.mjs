/**
 * PERMANENT GUARD I (Native Convergence, Phase 2) — UI kit token discipline.
 *
 * The canonical kit (src/ui/index.tsx) must consume the theme adapter and never
 * hardcode palette hex (the drift vector). It must export the canonical
 * primitives, keep the 44pt touch minimum, and remain RTL-aware. Source-as-text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const kit = readFileSync(resolve(HERE, "../src/ui/index.tsx"), "utf8");

const PRIMITIVES = [
  "ProovraScreen",
  "ProovraText",
  "ProovraCard",
  "ProovraSection",
  "ProovraButton",
  "ProovraBadge",
  "ProovraListRow",
  "ProovraEmptyState",
  "ProovraErrorState",
  "ProovraLoadingState",
];

test("kit exports the canonical primitives", () => {
  for (const p of PRIMITIVES) {
    assert.match(kit, new RegExp(`export function ${p}\\b`), `kit must export ${p}`);
  }
});

test("kit consumes the theme adapter, not raw palette", () => {
  assert.match(kit, /from\s+["']\.\.\/theme\/theme["']/, "kit must import the theme adapter");
  assert.match(kit, /\btheme\.color\b/, "kit must read colors from theme");
});

test("kit hardcodes no palette hex (all color arrives via theme)", () => {
  const hexes = kit.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
  assert.deepEqual(hexes, [], `kit must not hardcode hex colors: ${hexes.join(", ")}`);
});

test("kit keeps the 44pt touch minimum and is RTL-aware", () => {
  assert.match(kit, /MIN_TOUCH\s*=\s*44/, "kit must define a 44pt touch minimum");
  assert.match(kit, /isRTL/, "kit must be RTL-aware");
  assert.match(kit, /accessibilityRole/, "kit must set accessibility roles");
});
