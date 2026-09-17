import assert from "node:assert/strict";
import { test } from "node:test";

import { planFullPageTiles } from "./dist/capture-plan.js";

test("a short page yields one tile at offset 0", () => {
  const p = planFullPageTiles({ pageHeightPx: 600, viewportHeightPx: 800, maxTiles: 40, maxPageHeightPx: 40000 });
  assert.deepEqual(p.offsets, [0]);
  assert.equal(p.truncated, false);
});

test("tiles are deterministic top-to-bottom and the last is clamped to the page end", () => {
  const p = planFullPageTiles({ pageHeightPx: 2000, viewportHeightPx: 800, maxTiles: 40, maxPageHeightPx: 40000 });
  // 0, 800, then clamp to 1200 (2000-800), never past the end.
  assert.deepEqual(p.offsets, [0, 800, 1200]);
  assert.equal(p.truncated, false);
  // strictly increasing
  for (let i = 1; i < p.offsets.length; i += 1) assert.ok(p.offsets[i] > p.offsets[i - 1]);
});

test("a page over the height bound is truncated and marked", () => {
  const p = planFullPageTiles({ pageHeightPx: 100000, viewportHeightPx: 800, maxTiles: 40, maxPageHeightPx: 40000 });
  assert.equal(p.truncated, true);
  assert.ok(p.offsets.length <= 40);
});

test("the tile count bound truncates a very tall page", () => {
  const p = planFullPageTiles({ pageHeightPx: 40000, viewportHeightPx: 500, maxTiles: 10, maxPageHeightPx: 40000 });
  assert.equal(p.offsets.length, 10);
  assert.equal(p.truncated, true);
});
