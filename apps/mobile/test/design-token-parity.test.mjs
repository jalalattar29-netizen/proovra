/**
 * PERMANENT GUARD H (Native Convergence, Phase 1) — design-token parity.
 *
 * The 2026-02→2026-09 divergence happened because web and native had no shared
 * token layer: web rebuilt `tokens.css`, native stayed frozen. This guard makes
 * drift a build failure. It asserts that the canonical values agree across:
 *   web authority : apps/web/lib/design-tokens/tokens.css  (:root)
 *   shared tokens : packages/ui/src/tokens/proovra.ts       (proovraTokens)
 *   native adapter: apps/mobile/src/theme/theme.ts          (consumes tokens)
 *
 * Reads all three as text (no build, no device). The adapter is checked for
 * *provenance* (it must import the tokens, not hardcode palette hex) since it
 * references proovraTokens by value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webCss = readFileSync(resolve(HERE, "../../web/lib/design-tokens/tokens.css"), "utf8");
const uiTokens = readFileSync(resolve(HERE, "../../../packages/ui/src/tokens/proovra.ts"), "utf8");
const adapter = readFileSync(resolve(HERE, "../src/theme/theme.ts"), "utf8");

// [css custom property, literal value] — must appear verbatim in tokens.css AND proovra.ts.
const COLOR_PARITY = [
  ["--surface-app", "#F7F8FC"],
  ["--surface-card", "#FFFFFF"],
  ["--surface-muted", "#F1F4F9"],
  ["--ink-primary", "#0F172A"],
  ["--ink-secondary", "#475569"],
  ["--ink-muted", "#94A3B8"],
  ["--accent-050", "#F2ECFE"],
  ["--accent-500", "#7C3AED"],
  ["--accent-600", "#6D28D9"],
  ["--success", "#10B981"],
  ["--warning", "#F59E0B"],
  ["--error", "#DC2626"],
  ["--info", "#2563EB"],
  ["--border-subtle", "rgba(15, 23, 42, 0.06)"],
  ["--status-verified-bg", "#ECFDF5"],
  ["--status-pending-solid", "#F59E0B"],
  ["--status-risk-fg", "#991B1B"],
  ["--status-governance-solid", "#7C3AED"],
];

// [css radius/space var + px value, numeric literal expected in proovra.ts]
const NUMERIC_PARITY = [
  ["--radius-sm: 6px", "sm: 6"],
  ["--radius-md: 8px", "md: 8"],
  ["--radius-lg: 12px", "lg: 12"],
  ["--radius-card: 14px", "card: 14"],
  ["--space-1: 4px", "s1: 4"],
  ["--space-4: 16px", "s4: 16"],
  ["--space-6: 24px", "s6: 24"],
  ["--space-10: 40px", "s10: 40"],
];

test("guard the guard: all three sources are non-empty", () => {
  assert.ok(webCss.length > 2000, "tokens.css should be substantial");
  assert.ok(uiTokens.includes("proovraTokens"), "proovra.ts must export proovraTokens");
  assert.ok(adapter.includes("export const theme"), "theme.ts must export theme");
});

test("every parity-checked color matches web ↔ @proovra/ui exactly", () => {
  for (const [cssVar, value] of COLOR_PARITY) {
    assert.ok(
      new RegExp(`${cssVar}\\s*:\\s*${value.replace(/[()]/g, "\\$&")}\\s*;`).test(webCss),
      `tokens.css must define ${cssVar}: ${value}`,
    );
    assert.ok(uiTokens.includes(`"${value}"`), `proovra.ts must carry ${value} (for ${cssVar})`);
  }
});

test("radii and spacing match web ↔ @proovra/ui exactly", () => {
  for (const [cssFrag, tsFrag] of NUMERIC_PARITY) {
    assert.ok(webCss.includes(cssFrag), `tokens.css must contain "${cssFrag}"`);
    assert.ok(uiTokens.includes(tsFrag), `proovra.ts must contain "${tsFrag}"`);
  }
});

test("native adapter consumes the shared tokens (does not hardcode palette hex)", () => {
  assert.match(adapter, /from\s+["']@proovra\/ui["']/, "adapter must import from @proovra/ui");
  assert.match(adapter, /proovraTokens/, "adapter must reference proovraTokens");
  // The accent/palette hexes must never be hardcoded in the adapter — they must
  // arrive via the shared tokens (the shadow ink #0F172A is the only allowed hex).
  for (const banned of ["#7C3AED", "#F7F8FC", "#10B981", "#DC2626"]) {
    assert.ok(!adapter.includes(banned), `adapter must not hardcode ${banned}; consume it via proovraTokens`);
  }
});
