/**
 * PERMANENT GUARD G (Native Convergence, Phase 0) — protected native register.
 *
 * The UI/orchestration convergence redesigns screens around the sanctioned JS
 * boundary; it must never delete, rename, or relocate the protected native
 * capture engine, its iOS broadcast extension, or the canonical sealing clients
 * as collateral of a restyle. This guard asserts every path in
 * PROTECTED_NATIVE_PATHS still exists on disk. It complements GUARD E (which
 * checks the JS↔native *binding shape*); this one checks *file presence*.
 *
 * If a proven functional defect requires changing one of these files, that is a
 * Master-Program STOP condition handled outside ordinary UI work — this guard is
 * the tripwire that forces that conversation instead of a silent edit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_DIR = resolve(HERE, "..");
const CONTRACT = resolve(HERE, "../src/product/native-surface-contract.ts");
const contractSrc = readFileSync(CONTRACT, "utf8");

/** Extract the PROTECTED_NATIVE_PATHS string entries from the contract source. */
function parseProtectedPaths(src) {
  // Anchor on the `export const` declaration — the identifier also appears in
  // the doc comment, and `: readonly string[]` contains a `[` — so match the
  // assignment's array literal specifically.
  const block = src.match(/export const PROTECTED_NATIVE_PATHS[^=]*=\s*\[([\s\S]*?)\]\s*as const/);
  assert.ok(block, "PROTECTED_NATIVE_PATHS array must be present in the contract");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const protectedPaths = parseProtectedPaths(contractSrc);

test("the register lists the full protected engine + extension + sealing set", () => {
  assert.ok(protectedPaths.length >= 15, `expected >=15 protected paths, found ${protectedPaths.length}`);
  for (const required of [
    "modules/proovra-screen-capture/index.ts",
    "modules/proovra-screen-capture/ios/ProovraScreenCaptureModule.swift",
    "plugins/withProovraIosScreenBroadcast.cjs",
    "src/direct-capture.ts",
    "src/screen-capture-flow.ts",
    "src/continuous-capture-flow.ts",
  ]) {
    assert.ok(protectedPaths.includes(required), `register must protect ${required}`);
  }
});

test("every protected native path still exists on disk (no collateral deletion)", () => {
  const missing = protectedPaths.filter((p) => !existsSync(join(MOBILE_DIR, p)));
  assert.deepEqual(missing, [], `protected native files missing from disk: ${missing.join(", ")}`);
});

test("the Android MediaProjection service directory is present", () => {
  // The UC-2/UC-3 foreground services live here; guard the directory so a
  // restyle cannot remove the native service tree.
  const androidJava = join(
    MOBILE_DIR,
    "modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture",
  );
  assert.ok(existsSync(androidJava), "Android screencapture native source dir must exist");
});
