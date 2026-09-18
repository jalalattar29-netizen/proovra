import assert from "node:assert/strict";
import { test } from "node:test";

import {
  reconstructScreenConversation,
  scrollOverlap,
  reconstructionCoverageLabel,
  SCREEN_RECONSTRUCTION_TRANSFORMATION,
} from "../dist/screen-reconstruction.js";

let idc = 0;
/** Build observations for a frame: rows is an array of {text, kind?, fp?}. */
function frame(frameOrder, partIndex, offsetMs, rows) {
  return rows.map((r, i) => ({
    id: `obs-${idc++}`,
    keyframeId: `kf-${frameOrder}`,
    sourcePartIndex: partIndex,
    sourceOffsetMs: offsetMs,
    frameOrder,
    rowOrder: i,
    text: typeof r === "string" ? r : r.text,
    kind: (typeof r === "object" && r.kind) || "TEXT",
    fingerprint: (typeof r === "object" && r.fp) || null,
  }));
}

test("scrollOverlap finds the largest suffix/prefix run (bottom of A = top of B)", () => {
  const a = frame(0, 0, 0, ["1", "2", "3", "4"]);
  const b = frame(1, 0, 6000, ["3", "4", "5", "6"]);
  assert.equal(scrollOverlap(a, b), 2);
  assert.equal(scrollOverlap(a, frame(1, 0, 0, ["9", "8"])), 0); // no overlap
});

test("STATIC screen: two identical frames → each block corroborated in 2 frames, COMPLETE", () => {
  idc = 0;
  const obs = [...frame(0, 0, 0, ["A", "B", "C"]), ...frame(1, 0, 6000, ["A", "B", "C"])];
  const r = reconstructScreenConversation(obs);
  assert.equal(r.transformation, SCREEN_RECONSTRUCTION_TRANSFORMATION);
  assert.equal(r.blockCount, 3); // A,B,C merged across frames
  assert.equal(r.coverage, "COMPLETE");
  assert.ok(r.blocks.every((b) => b.confidence === "HIGH_OVERLAP" && b.observedInFrames === 2));
  assert.deepEqual(r.blocks.map((b) => b.text), ["A", "B", "C"]);
});

test("SCROLLING conversation: A[1234] B[3456] → 6 ordered blocks, 3&4 merged (HIGH), lineage kept", () => {
  idc = 0;
  const obs = [...frame(0, 7, 0, ["1", "2", "3", "4"]), ...frame(1, 7, 6000, ["3", "4", "5", "6"])];
  const r = reconstructScreenConversation(obs);
  assert.deepEqual(r.blocks.map((b) => b.text), ["1", "2", "3", "4", "5", "6"]);
  assert.equal(r.blockCount, 6);
  const three = r.blocks.find((b) => b.text === "3");
  assert.equal(three.confidence, "HIGH_OVERLAP");
  assert.equal(three.observedInFrames, 2);
  assert.deepEqual(three.sourcePartIndexes, [7]); // lineage back to ORIGINAL part 7
  assert.equal(r.coverage, "COMPLETE");
});

test("REPEATED overlap chain A[1234] B[3456] C[5678] → 8 unique ordered blocks", () => {
  idc = 0;
  const obs = [
    ...frame(0, 0, 0, ["1", "2", "3", "4"]),
    ...frame(1, 0, 6000, ["3", "4", "5", "6"]),
    ...frame(2, 0, 12000, ["5", "6", "7", "8"]),
  ];
  const r = reconstructScreenConversation(obs);
  assert.deepEqual(r.blocks.map((b) => b.text), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.equal(r.blockCount, 8);
});

test("TWO DISTINCT identical 'OK' in the same frame stay distinct (no text-equality merge)", () => {
  idc = 0;
  // Same frame, two different rows both "OK" — must remain two blocks.
  const obs = frame(0, 0, 0, ["hi", "OK", "later", "OK"]);
  const r = reconstructScreenConversation(obs);
  const oks = r.blocks.filter((b) => b.text === "OK");
  assert.equal(oks.length, 2); // conservative: never merged on text alone
  assert.equal(r.blockCount, 4);
});

test("TWO 'OK' in NON-adjacent-overlap frames stay distinct", () => {
  idc = 0;
  // Frame boundaries with NO scroll overlap between the two OK contexts.
  const obs = [
    ...frame(0, 0, 0, ["a", "OK"]),
    ...frame(1, 0, 6000, ["x", "y"]), // jump: no overlap with frame 0 or 2
    ...frame(2, 0, 12000, ["b", "OK"]),
  ];
  const r = reconstructScreenConversation(obs);
  assert.equal(r.blocks.filter((b) => b.text === "OK").length, 2);
  // A non-overlapping boundary marks the derived coverage PARTIAL (possible gap).
  assert.equal(r.coverage, "PARTIAL");
  assert.ok(r.limitations.includes("RECONSTRUCTION_POSSIBLE_GAP"));
});

test("fingerprint disagreement prevents merging equal text across a scroll boundary", () => {
  idc = 0;
  const a = frame(0, 0, 0, [{ text: "OK", fp: "fpA" }]);
  const b = frame(1, 0, 6000, [{ text: "OK", fp: "fpB" }]);
  assert.equal(scrollOverlap(a, b), 0); // fingerprints differ → not the same row
  const r = reconstructScreenConversation([...a, ...b]);
  assert.equal(r.blocks.filter((x) => x.text === "OK").length, 2);
});

test("single-frame content is PARTIAL_OVERLAP (uncorroborated), not fabricated confidence", () => {
  idc = 0;
  const r = reconstructScreenConversation(frame(0, 0, 0, ["only"]));
  assert.equal(r.blocks[0].confidence, "PARTIAL_OVERLAP");
});

test("block kinds are preserved (VISIBLE_LABEL / VISIBLE_TIMESTAMP are displayed, not verified)", () => {
  idc = 0;
  const obs = frame(0, 0, 0, [
    { text: "Alice", kind: "VISIBLE_LABEL" },
    { text: "10:30", kind: "VISIBLE_TIMESTAMP" },
    { text: "hello", kind: "TEXT" },
  ]);
  const r = reconstructScreenConversation(obs);
  assert.equal(r.blocks.find((b) => b.text === "Alice").kind, "VISIBLE_LABEL");
  assert.equal(r.blocks.find((b) => b.text === "10:30").kind, "VISIBLE_TIMESTAMP");
});

test("reconstruction coverage NEVER upgrades an interrupted acquisition to complete", () => {
  // Even if derived coverage is COMPLETE, an interrupted acquisition stays PARTIAL.
  assert.equal(reconstructionCoverageLabel(false, "COMPLETE"), "PARTIAL");
  assert.equal(reconstructionCoverageLabel(true, "COMPLETE"), "COMPLETE");
  assert.equal(reconstructionCoverageLabel(true, "PARTIAL"), "PARTIAL");
});

test("every reconstructed block traces to at least one source observation + ORIGINAL part", () => {
  idc = 0;
  const obs = [...frame(0, 3, 0, ["1", "2"]), ...frame(1, 4, 6000, ["2", "3"])];
  const r = reconstructScreenConversation(obs);
  for (const b of r.blocks) {
    assert.ok(b.observationIds.length >= 1, "has source observations");
    assert.ok(b.sourcePartIndexes.length >= 1, "traces to ORIGINAL part(s)");
  }
  // Block "2" was observed in parts 3 and 4 (spanning a scroll across segments).
  const two = r.blocks.find((b) => b.text === "2");
  assert.deepEqual(two.sourcePartIndexes, [3, 4]);
});
