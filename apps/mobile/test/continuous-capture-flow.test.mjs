/**
 * UC-3 — deterministic tests for the Continuous Screen Capture state machine (no
 * device). The pure reducer is the UX contract: intro → active (segments captured
 * + uploaded stream in) → review → finalizing → success, with safe-only error
 * branches. Loaded by stripping types from the TS source with the TS transpiler
 * (the reducer has no runtime imports).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/continuous-capture-flow.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);
const { continuousFlowReducer: reduce, INITIAL_CONTINUOUS_FLOW: init } = mod;

test("starts at intro", () => {
  assert.equal(init.phase, "intro");
});

test("intro → active; captured/uploaded counts only rise (monotonic)", () => {
  let s = reduce(init, { type: "STARTED" });
  assert.equal(s.phase, "active");
  assert.deepEqual([s.captured, s.uploaded], [0, 0]);
  s = reduce(s, { type: "SEGMENT_CAPTURED", captured: 2 });
  s = reduce(s, { type: "SEGMENT_UPLOADED", uploaded: 1 });
  assert.deepEqual([s.captured, s.uploaded], [2, 1]);
  // Out-of-order/stale lower values never lower the visible counts.
  s = reduce(s, { type: "SEGMENT_CAPTURED", captured: 1 });
  s = reduce(s, { type: "SEGMENT_UPLOADED", uploaded: 0 });
  assert.deepEqual([s.captured, s.uploaded], [2, 1]);
});

test("STOPPED → review carries the session summary; finalize → finalizing → success", () => {
  let s = reduce(init, { type: "STARTED" });
  s = reduce(s, { type: "SEGMENT_CAPTURED", captured: 3 });
  s = reduce(s, { type: "SEGMENT_UPLOADED", uploaded: 3 });
  s = reduce(s, {
    type: "STOPPED",
    captured: 3,
    uploaded: 3,
    completeness: "COMPLETE_SESSION",
    stopReason: "USER_STOPPED",
  });
  assert.equal(s.phase, "review");
  assert.equal(s.completeness, "COMPLETE_SESSION");

  s = reduce(s, { type: "FINALIZE" });
  assert.equal(s.phase, "finalizing");
  assert.equal(s.captured, 3);

  s = reduce(s, {
    type: "FINALIZED",
    evidenceId: "ev-9",
    segmentCount: 3,
    completeness: "COMPLETE_SESSION",
  });
  assert.equal(s.phase, "success");
  assert.equal(s.evidenceId, "ev-9");
  assert.equal(s.segmentCount, 3);
});

test("an INTERRUPTED session is preserved through review and never relabelled complete", () => {
  let s = reduce(init, { type: "STARTED" });
  s = reduce(s, { type: "SEGMENT_CAPTURED", captured: 2 });
  s = reduce(s, {
    type: "STOPPED",
    captured: 2,
    uploaded: 2,
    completeness: "INTERRUPTED_SESSION",
    stopReason: "PERMISSION_REVOKED",
  });
  assert.equal(s.phase, "review");
  assert.equal(s.completeness, "INTERRUPTED_SESSION");
  s = reduce(s, { type: "FINALIZE" });
  s = reduce(s, {
    type: "FINALIZED",
    evidenceId: "ev-int",
    segmentCount: 2,
    completeness: "INTERRUPTED_SESSION",
  });
  assert.equal(s.completeness, "INTERRUPTED_SESSION");
});

test("finalize with zero recorded segments → recoverable error, not a seal", () => {
  let s = reduce(init, { type: "STARTED" });
  s = reduce(s, { type: "STOPPED", captured: 0, uploaded: 0, completeness: "INTERRUPTED_SESSION", stopReason: "ERROR" });
  assert.equal(s.phase, "review");
  const err = reduce(s, { type: "FINALIZE" });
  assert.equal(err.phase, "error");
  assert.equal(err.recoverable, true);
});

test("FAIL gives a safe recoverable error; RESET returns to intro", () => {
  const active = reduce(init, { type: "STARTED" });
  const err = reduce(active, { type: "FAIL", message: "denied" });
  assert.equal(err.phase, "error");
  assert.equal(err.recoverable, true);
  assert.deepEqual(reduce(err, { type: "RESET" }), { phase: "intro" });
});

test("the reducer is TOTAL — out-of-phase events never corrupt state", () => {
  const active = reduce(init, { type: "STARTED" });
  // FINALIZE while active (not review) is ignored.
  assert.deepEqual(reduce(active, { type: "FINALIZE" }), active);
  // SEGMENT_CAPTURED while in intro is ignored.
  assert.deepEqual(reduce(init, { type: "SEGMENT_CAPTURED", captured: 5 }), init);
  // STOPPED echo while not active is ignored.
  const review = reduce(active, { type: "STOPPED", captured: 1, uploaded: 1, completeness: "COMPLETE_SESSION", stopReason: "USER_STOPPED" });
  assert.deepEqual(
    reduce(review, { type: "STOPPED", captured: 9, uploaded: 9, completeness: "COMPLETE_SESSION", stopReason: "USER_STOPPED" }),
    review,
  );
  // FINALIZED while not finalizing is ignored.
  assert.deepEqual(reduce(active, { type: "FINALIZED", evidenceId: "x", segmentCount: 1, completeness: "COMPLETE_SESSION" }), active);
});

test("a stopped session never appears successful without finalization", () => {
  let s = reduce(init, { type: "STARTED" });
  s = reduce(s, { type: "SEGMENT_CAPTURED", captured: 1 });
  s = reduce(s, { type: "STOPPED", captured: 1, uploaded: 1, completeness: "INTERRUPTED_SESSION", stopReason: "PERMISSION_REVOKED" });
  assert.equal(s.phase, "review"); // review, NOT success
});
