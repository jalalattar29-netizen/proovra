import assert from "node:assert/strict";
import { test } from "node:test";

import {
  selectKeyframes,
  keyframeVariantKey,
  KEYFRAME_SELECTION_BOUNDS,
} from "../dist/screen-keyframes.js";

const B = KEYFRAME_SELECTION_BOUNDS;

test("keyframeVariantKey is zero-padded and deterministic", () => {
  assert.equal(keyframeVariantKey(0), "kf-0000");
  assert.equal(keyframeVariantKey(42), "kf-0042");
});

test("always keeps the first candidate, then spaces by the min interval", () => {
  const cands = [0, 300, 700, 1600, 1900, 3200].map((offsetMs) => ({ offsetMs, changeScore: 0 }));
  const r = selectKeyframes(cands);
  // 0 (first), 1600 (>=1500 since 0), 3200 (>=1500 since 1600). 300/700/1900 dropped.
  assert.deepEqual(r.keyframes.map((k) => k.offsetMs), [0, 1600, 3200]);
  assert.equal(r.keyframes[0].reason, "first");
  assert.equal(r.keyframes[1].reason, "interval");
});

test("keeps a frame on material CHANGE even within the interval", () => {
  const cands = [
    { offsetMs: 0, changeScore: 0 },
    { offsetMs: 200, changeScore: 0.9 }, // big change soon after → kept ("change")
    { offsetMs: 300, changeScore: 0.01 }, // static + too soon → dropped
  ];
  const r = selectKeyframes(cands);
  assert.deepEqual(r.keyframes.map((k) => k.offsetMs), [0, 200]);
  assert.equal(r.keyframes[1].reason, "change");
});

test("a fully static screen keeps only interval-spaced frames (not every frame)", () => {
  const cands = Array.from({ length: 20 }, (_, i) => ({ offsetMs: i * 300, changeScore: 0 }));
  const r = selectKeyframes(cands);
  // 6s of static content at 300ms cadence → ~ one per 1500ms.
  assert.ok(r.keyframes.length < cands.length);
  assert.ok(r.keyframes.length <= Math.ceil((19 * 300) / B.minIntervalMs) + 1);
});

test("selection is BOUNDED — excess candidates degrade to PARTIAL, never unbounded", () => {
  // Every frame changes a lot AND is far apart → all would qualify; cap enforced.
  const cands = Array.from({ length: B.maxKeyframes + 50 }, (_, i) => ({
    offsetMs: i * (B.minIntervalMs + 100),
    changeScore: 1,
  }));
  const r = selectKeyframes(cands);
  assert.equal(r.keyframes.length, B.maxKeyframes);
  assert.equal(r.boundsReached, true);
  // Variant keys are unique + deterministic.
  assert.equal(new Set(r.keyframes.map((k) => k.variantKey)).size, r.keyframes.length);
});

test("deterministic regardless of input order", () => {
  const a = selectKeyframes([{ offsetMs: 0, changeScore: 0 }, { offsetMs: 2000, changeScore: 0 }]);
  const b = selectKeyframes([{ offsetMs: 2000, changeScore: 0 }, { offsetMs: 0, changeScore: 0 }]);
  assert.deepEqual(a.keyframes.map((k) => k.offsetMs), b.keyframes.map((k) => k.offsetMs));
});
