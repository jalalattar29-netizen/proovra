/**
 * AUD-0028 — on a 1080-px Android phone (420 dpi, about 411 dp wide) the header
 * was wider than the screen: the account control was cut off and the search
 * control rendered as an empty box.
 *
 * There is no layout engine here, so this checks the two things that decide
 * it: the header's minimum width fits the screen, and the rendered styles let
 * the right controls shrink (workspace chip) and keep the search control from
 * collapsing (minimum width).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWithProviders } from "./support/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const header = readFileSync(resolve(HERE, "../src/ui/header.tsx"), "utf8");
const layout = await loadWithProviders("src/ui/header-layout.ts", ["headerMetrics", "headerMinimumWidth"]);

const PIXEL_6_DP = Math.floor(1080 / (420 / 160)); // 411
// The status pill is shown only during an incident; its slot shrinks to a touch
// target and its label (up to "Status unavailable") ellipsizes.
const STATUS_PILL_DP = 44;

test("the header's minimum width fits a 1080-px / 420-dpi phone, with the status pill shown", () => {
  const m = layout.headerMetrics(PIXEL_6_DP);
  const min = layout.headerMinimumWidth(m, STATUS_PILL_DP);
  assert.ok(min <= PIXEL_6_DP, `header needs ${min} dp on a ${PIXEL_6_DP} dp screen`);
});

test("and fits a 360 dp phone, with the status pill shown", () => {
  const m = layout.headerMetrics(360);
  assert.equal(m.compact, true);
  const min = layout.headerMinimumWidth(m, STATUS_PILL_DP);
  assert.ok(min <= 360, `header needs ${min} dp on a 360 dp screen`);
});

test("the workspace chip may shrink; the bell and account control may not", () => {
  const styles = header.slice(header.indexOf("const styles = StyleSheet.create("));
  const block = (name) => styles.slice(styles.indexOf(`  ${name}: {`), styles.indexOf("},", styles.indexOf(`  ${name}: {`)));
  assert.match(block("workspace"), /flexShrink: 1/, "the workspace chip never shrinks, so it pushes the account control off-screen");
  assert.match(block("bell"), /flexShrink: 0/);
  assert.match(block("avatar"), /flexShrink: 0/);
  assert.match(block("statusSlot"), /flexShrink: 1, minWidth: 44/);
  assert.ok(header.includes("<ServiceStatusIndicator style={styles.statusSlot} />"));
});

test("the search control has a minimum width, so it never collapses to an empty box", () => {
  assert.match(header, /styles\.search, \{ minWidth: metrics\.searchMinWidth \}/);
  assert.match(header, /maxWidth: metrics\.workspaceMaxWidth, minWidth: metrics\.workspaceMinWidth/);
  assert.ok(layout.headerMetrics(PIXEL_6_DP).searchMinWidth >= 44);
});
