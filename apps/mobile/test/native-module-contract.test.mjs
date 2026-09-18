/**
 * PERMANENT GUARD E (audit §19) — JS ↔ Kotlin native-module binding contract.
 *
 * F5 was: the JS binding called `ProovraScreenCapture.stopCapture()` but the
 * Kotlin module only exposed `AsyncFunction("stop")`, so `stopScreenCapture()`
 * rejected at runtime — UC-2 could start and capture frames but never seal.
 *
 * This guard fails if the JS binding ever invokes a native method (or listens
 * to an event) that the Kotlin `ModuleDefinition` does not expose. It reads both
 * sources as text (no device, no compile) and compares name sets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = resolve(HERE, "../modules/proovra-screen-capture");
const jsBinding = readFileSync(resolve(MODULE_DIR, "index.ts"), "utf8");
const kotlin = readFileSync(
  resolve(MODULE_DIR, "android/src/main/java/com/proovra/screencapture/ProovraScreenCaptureModule.kt"),
  "utf8",
);
const swift = readFileSync(resolve(MODULE_DIR, "ios/ProovraScreenCaptureModule.swift"), "utf8");

function uniq(arr) {
  return [...new Set(arr)];
}

// Every native method the JS binding actually invokes at runtime.
const jsNativeCalls = uniq(
  [...jsBinding.matchAll(/(?:nativeModule|continuousModule)\(\)\.(\w+)\(/g)].map((m) => m[1]),
);

// Every method the Kotlin ModuleDefinition exposes (Function + AsyncFunction).
const kotlinMethods = uniq(
  [...kotlin.matchAll(/\b(?:Async)?Function\(\s*"([^"]+)"/g)].map((m) => m[1]),
);

// Events the JS binding subscribes to, and events the Kotlin module declares.
const jsEventListeners = uniq(
  [...jsBinding.matchAll(/addListener\(\s*"([^"]+)"/g)].map((m) => m[1]),
);
const kotlinEventsDecl = kotlin.match(/Events\(([^)]*)\)/);
const kotlinEvents = kotlinEventsDecl
  ? uniq([...kotlinEventsDecl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]))
  : [];

test("the JS binding invokes at least the core native methods", () => {
  // Guard the guard: extraction must actually find calls.
  assert.ok(jsNativeCalls.length >= 5, `expected >=5 native calls, found ${jsNativeCalls.join(",")}`);
  for (const required of ["startCapture", "captureFrame", "stopCapture", "startContinuousCapture", "stopContinuousCapture"]) {
    assert.ok(jsNativeCalls.includes(required), `JS binding should call ${required}`);
  }
});

test("every native method the JS binding calls exists in the Kotlin module (F5)", () => {
  for (const name of jsNativeCalls) {
    assert.ok(
      kotlinMethods.includes(name),
      `JS calls native "${name}" but Kotlin exposes only: ${kotlinMethods.join(", ")}`,
    );
  }
});

test("stopCapture is the canonical UC-2 stop name on both sides (no stale alias)", () => {
  assert.ok(jsNativeCalls.includes("stopCapture"), "JS must call stopCapture()");
  assert.ok(kotlinMethods.includes("stopCapture"), "Kotlin must expose stopCapture");
  assert.ok(!kotlinMethods.includes("stop"), "the old 'stop' name must be gone");
});

// UC-5 — the iOS Swift module must expose the CONTINUOUS methods + events the
// shared JS continuous binding calls (the frame API is Android-only).
const swiftMethods = uniq([...swift.matchAll(/\b(?:Async)?Function\(\s*"([^"]+)"/g)].map((m) => m[1]));
const swiftEventsDecl = swift.match(/Events\(([^)]*)\)/);
const swiftEvents = swiftEventsDecl
  ? uniq([...swiftEventsDecl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]))
  : [];

test("the iOS Swift module exposes the continuous methods the JS binding calls (UC-5)", () => {
  for (const name of [
    "isContinuousSupported",
    "getContinuousState",
    "startContinuousCapture",
    "stopContinuousCapture",
  ]) {
    assert.ok(
      swiftMethods.includes(name),
      `iOS Swift must expose "${name}"; found: ${swiftMethods.join(", ")}`,
    );
  }
  // The name is "ProovraScreenCapture" on BOTH platforms so requireNativeModule works.
  assert.match(swift, /Name\("ProovraScreenCapture"\)/);
});

test("the iOS Swift module declares the continuous events the JS listens to", () => {
  for (const name of ["onScreenSegment", "onScreenContinuousStopped"]) {
    assert.ok(swiftEvents.includes(name), `iOS Swift must declare event "${name}"`);
  }
});

test("every event the JS binding listens to is declared by the Kotlin module", () => {
  assert.ok(kotlinEvents.length >= 4, `expected Kotlin Events(...), found ${kotlinEvents.join(",")}`);
  for (const name of jsEventListeners) {
    assert.ok(
      kotlinEvents.includes(name),
      `JS listens to "${name}" but Kotlin Events are: ${kotlinEvents.join(", ")}`,
    );
  }
});
