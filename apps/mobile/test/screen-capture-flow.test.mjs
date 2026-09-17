/**
 * UC-2 — deterministic tests for the Direct Screen Capture state machine (no
 * device). The pure reducer is the UX contract: intro → active → review →
 * uploading → success, with safe-only error branches. Loaded by stripping types
 * from the TS source with esbuild (the reducer has only type-level imports).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/screen-capture-flow.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);
const { screenFlowReducer: reduce, INITIAL_SCREEN_FLOW: init } = mod;

test("starts at intro", () => {
  assert.equal(init.phase, "intro");
});

test("intro → active on STARTED, then FRAME raises the count monotonically", () => {
  let s = reduce(init, { type: "STARTED" });
  assert.equal(s.phase, "active");
  assert.equal(s.frameCount, 0);
  s = reduce(s, { type: "FRAME", frameCount: 1 });
  assert.equal(s.frameCount, 1);
  // A stray lower/-1 count never lowers the visible count.
  s = reduce(s, { type: "FRAME", frameCount: -1 });
  assert.equal(s.frameCount, 1);
});

test("STOPPED with frames → review; with zero frames → recoverable error", () => {
  const active = reduce(init, { type: "STARTED" });
  const review = reduce(active, { type: "STOPPED", frameCount: 3, stopReason: "USER_STOPPED" });
  assert.equal(review.phase, "review");
  assert.equal(review.frameCount, 3);

  const err = reduce(active, { type: "STOPPED", frameCount: 0, stopReason: "USER_STOPPED" });
  assert.equal(err.phase, "error");
  assert.equal(err.recoverable, true);
});

test("review → uploading → success", () => {
  let s = reduce(init, { type: "STARTED" });
  s = reduce(s, { type: "STOPPED", frameCount: 2, stopReason: "USER_STOPPED" });
  s = reduce(s, { type: "FINALIZE" });
  assert.equal(s.phase, "uploading");
  s = reduce(s, { type: "FINALIZED", evidenceId: "ev-123" });
  assert.equal(s.phase, "success");
  assert.equal(s.evidenceId, "ev-123");
  assert.equal(s.frameCount, 2);
});

test("FAIL from any phase gives a safe recoverable error; RESET returns to intro", () => {
  const active = reduce(init, { type: "STARTED" });
  const err = reduce(active, { type: "FAIL", message: "denied" });
  assert.equal(err.phase, "error");
  assert.equal(err.recoverable, true);
  assert.deepEqual(reduce(err, { type: "RESET" }), { phase: "intro" });
});

test("the reducer is TOTAL — an out-of-phase event never corrupts state", () => {
  // FINALIZE while active (not review) is ignored.
  const active = reduce(init, { type: "STARTED" });
  assert.deepEqual(reduce(active, { type: "FINALIZE" }), active);
  // FRAME while in intro is ignored.
  assert.deepEqual(reduce(init, { type: "FRAME", frameCount: 5 }), init);
  // FINALIZED while not uploading is ignored.
  assert.deepEqual(reduce(active, { type: "FINALIZED", evidenceId: "x" }), active);
});

test("a stopped session never appears successful without finalization", () => {
  let s = reduce(init, { type: "STARTED" });
  s = reduce(s, { type: "STOPPED", frameCount: 1, stopReason: "PERMISSION_REVOKED" });
  // review, NOT success — sealing requires the explicit finalize path.
  assert.equal(s.phase, "review");
});
