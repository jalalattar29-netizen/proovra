/**
 * Production-honesty guard — Executive Dashboard null-metric rendering.
 *
 * The Executive dashboard used to surface fabricated KPIs (fixed 0 / 100
 * placeholders for QC accuracy, review duration, verification success, and
 * detection/derivative latency). Those are now either computed from real
 * data or emitted as `null`. When a TrendMetric is `null` the UI MUST render
 * "Not measured" / "—" — never a fake "0" or "100%".
 *
 * This is a source-contract test (mirrors the executive service guard in
 * services/api/test/phase-3b-intelligence-platform.test.ts). It proves the
 * page component branches on `null` and shows the honest fallback.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PAGE = readFileSync(
  fileURLToPath(new URL("../app/(app)/executive/page.tsx", import.meta.url)),
  "utf8",
);

test("TrendTile accepts a nullable metric", () => {
  assert.match(PAGE, /metric:\s*TrendMetric\s*\|\s*null/);
});

test("null metric renders the honest 'Not measured' fallback, not 0/100", () => {
  // Explicit null branch exists.
  assert.match(PAGE, /if\s*\(metric === null\)/);
  // Renders the em-dash + "Not measured" copy.
  assert.match(PAGE, /Not measured/);
  assert.match(PAGE, /—/);
  // Exposes a testable data attribute for the not-measured state.
  assert.match(PAGE, /data-trend-not-measured/);
});

test("dashboard does NOT hardcode a fabricated 0/100 for these KPIs", () => {
  // No literal "100%" / "0%" string fabrications baked into the page.
  assert.doesNotMatch(PAGE, /successRatePct:\s*100/);
  assert.doesNotMatch(PAGE, /qcAccuracyPct:\s*0/);
});
