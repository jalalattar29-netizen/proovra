/**
 * AUD-018 — capture durations are measured on a MONOTONIC clock.
 *
 * The camera/audio fallbacks in capture.tsx measured `Date.now() - startedAt`:
 * a wall-clock change mid-recording (user, network time) declared a stretched,
 * shrunk or negative duration. These drive the real helper with a clock that
 * jumps, and pin the screen to it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const HERE = dirname(fileURLToPath(import.meta.url));
const compile = (rel) =>
  ts.transpileModule(readFileSync(resolve(HERE, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const clock = await import(`data:text/javascript,${encodeURIComponent(compile("../src/capture/monotonic-clock.ts"))}`);

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("AUD-018: a wall-clock jump backwards mid-recording does not shrink or negate the duration", () => {
  let mono = 1_000;
  const source = { performance: { now: () => mono } };
  const realNow = Date.now;
  try {
    let wall = 1_790_000_000_000;
    Date.now = () => wall;
    const mark = clock.monotonicNowMs(source);
    mono += 12_000;
    wall -= 3_600_000; // the user set the clock back an hour
    assert.equal(clock.elapsedSinceMs(mark, clock.monotonicNowMs(source)), 12_000);
  } finally {
    Date.now = realNow;
  }
});

test("AUD-018: a wall-clock jump forwards does not stretch the duration", () => {
  let mono = 50;
  const source = { performance: { now: () => mono } };
  const realNow = Date.now;
  try {
    let wall = 1_790_000_000_000;
    Date.now = () => wall;
    const mark = clock.monotonicNowMs(source);
    mono += 4_000;
    wall += 86_400_000;
    assert.equal(clock.elapsedSinceMs(mark, clock.monotonicNowMs(source)), 4_000);
  } finally {
    Date.now = realNow;
  }
});

test("AUD-018: without a monotonic clock the fallback never declares a negative duration", () => {
  assert.equal(clock.elapsedSinceMs(10_000, 4_000), 0);
  assert.equal(clock.elapsedSinceMs(Number.NaN, 4_000), 0);
  const realNow = Date.now;
  try {
    Date.now = () => 777;
    assert.equal(clock.monotonicNowMs({}), 777, "wall clock only when no performance.now exists");
  } finally {
    Date.now = realNow;
  }
});

test("AUD-018: the capture screen measures its fallback durations monotonically", () => {
  // Line comments only: capture.tsx holds MIME globs ("image/*") a block-comment strip would eat.
  const src = readFileSync(resolve(HERE, "../app/(stack)/capture.tsx"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/Date\.now\(\)\s*-\s*startedAt/.test(src), "a wall-clock duration is back in capture.tsx");
  assert.match(src, /const startedAt = monotonicNowMs\(\);/);
  assert.match(src, /audioStartedAtRef\.current = monotonicNowMs\(\);/);
  assert.equal((src.match(/elapsedSinceMs\(startedAt\)/g) ?? []).length, 2);
});

test("AUD-018: both Android services measure on elapsedRealtime, not the wall clock", () => {
  const KT = resolve(HERE, "../modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture");
  const kt = (f) => stripComments(readFileSync(resolve(KT, f), "utf8"));
  for (const f of ["ContinuousScreenCaptureService.kt", "ScreenCaptureService.kt"]) {
    const src = kt(f);
    assert.ok(!/System\.currentTimeMillis\(\)/.test(src), `${f} still reads the wall clock`);
    assert.match(src, /SessionTimeline\(SystemCaptureClock\)/, f);
  }
  assert.match(kt("SystemCaptureClock.kt"), /override fun elapsedMs\(\): Long = SystemClock\.elapsedRealtime\(\)/);
});
