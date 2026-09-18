import assert from "node:assert/strict";
import { test } from "node:test";

import { runScreenIntelligence } from "../dist/screen-intelligence.js";

/** A deterministic local fake OCR provider: imageRef → predefined text rows. */
function fakeOcr(map, opts = {}) {
  return {
    name: opts.name ?? "fake",
    version: "v0",
    local: true,
    async extract({ imageRef }) {
      if (opts.failRefs?.includes(imageRef)) throw new Error("ocr failure");
      const rows = map[imageRef] ?? [];
      return { regions: rows.map((text, i) => ({ text, kind: "TEXT", rowOrder: i })), language: "en" };
    },
  };
}

// One candidate frame per part so keyframe selection keeps exactly one (the first).
const oneKeyframe = (offsetMs = 0) => [{ offsetMs, changeScore: 1 }];
const imageRef = (partIndex, kf) => `p${partIndex}/${kf.variantKey}`;

test("MANDATORY source-lineage E2E: block → observation → keyframe → ORIGINAL part", async () => {
  // Two ORIGINAL segments; a scroll across the boundary shares rows "3","4".
  const map = {
    "p0/kf-0000": ["1", "2", "3", "4"],
    "p1/kf-0000": ["3", "4", "5", "6"],
  };
  const res = await runScreenIntelligence({
    parts: [
      { partIndex: 0, candidates: oneKeyframe() },
      { partIndex: 1, candidates: oneKeyframe() },
    ],
    ocr: fakeOcr(map),
    imageRefForKeyframe: imageRef,
  });

  assert.deepEqual(res.reconstruction.blocks.map((b) => b.text), ["1", "2", "3", "4", "5", "6"]);
  assert.equal(res.ocrProvider.local, true);

  // Pick a reconstructed block and trace it ALL the way back to ORIGINAL parts.
  const block = res.reconstruction.blocks.find((b) => b.text === "3");
  assert.ok(block, "block exists");
  // block → observation(s)
  const obs = res.observations.filter((o) => block.observationIds.includes(o.id));
  assert.ok(obs.length >= 1);
  // observation → keyframe → ORIGINAL part(s)  ("3" was observed scrolling p0→p1)
  const parts = [...new Set(obs.map((o) => o.sourcePartIndex))].sort();
  assert.deepEqual(parts, [0, 1]);
  assert.deepEqual(block.sourcePartIndexes, [0, 1]);
  // Every observation names a keyframe that belongs to its source part.
  for (const o of obs) assert.ok(o.keyframeId.startsWith(`p${o.sourcePartIndex}-`));
  // The shared row is corroborated across two frames → HIGH_OVERLAP.
  assert.equal(block.confidence, "HIGH_OVERLAP");
});

test("UC-2 support: a single-Evidence multi-FRAME part reconstructs with lineage", async () => {
  // UC-2 = N ORIGINAL screen_frame parts (partIndex 0..2), no scroll overlap needed.
  const map = { "p0/kf-0000": ["a"], "p1/kf-0000": ["b"], "p2/kf-0000": ["c"] };
  const res = await runScreenIntelligence({
    parts: [0, 1, 2].map((partIndex) => ({ partIndex, candidates: oneKeyframe() })),
    ocr: fakeOcr(map),
    imageRefForKeyframe: imageRef,
  });
  assert.deepEqual(res.reconstruction.blocks.map((b) => b.text), ["a", "b", "c"]);
  assert.equal(res.observations.length, 3);
  assert.deepEqual(res.reconstruction.blocks.map((b) => b.sourcePartIndexes[0]), [0, 1, 2]);
});

test("OCR failure on one keyframe degrades that frame only — pipeline + others survive", async () => {
  const map = { "p0/kf-0000": ["x"], "p1/kf-0000": ["y"] };
  const res = await runScreenIntelligence({
    parts: [
      { partIndex: 0, candidates: oneKeyframe() },
      { partIndex: 1, candidates: oneKeyframe() },
    ],
    ocr: fakeOcr(map, { failRefs: ["p0/kf-0000"] }),
    imageRefForKeyframe: imageRef,
  });
  assert.equal(res.stats.ocrFailedKeyframes, 1);
  assert.deepEqual(res.reconstruction.blocks.map((b) => b.text), ["y"]); // p0 degraded, p1 intact
});

test("keyframe selection is applied per part and stats reflect the bounded set", async () => {
  // Many static candidates → selection keeps far fewer than provided.
  const many = Array.from({ length: 30 }, (_, i) => ({ offsetMs: i * 200, changeScore: 0 }));
  const res = await runScreenIntelligence({
    parts: [{ partIndex: 0, candidates: many }],
    ocr: fakeOcr({}),
    imageRefForKeyframe: imageRef,
  });
  assert.ok(res.keyframesByPart[0].keyframes.length < many.length);
  assert.equal(res.stats.keyframeCount, res.keyframesByPart[0].keyframes.length);
});
