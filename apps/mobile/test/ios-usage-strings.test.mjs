/**
 * F-P1-11 — every iOS privacy usage string promises something the app's code
 * actually does, and no unused permission-bearing library is linked.
 *
 * `NSPhotoLibraryUsageDescription` promised photo-library access ("when you
 * choose an existing photo or video"), but nothing imported a photo-library
 * picker: native picking is the system document picker (Files), which needs no
 * photo permission. `expo-image-picker` was a dependency with no import, yet
 * autolinking still linked its PHPhotoLibrary code on iOS and merged
 * READ/WRITE_EXTERNAL_STORAGE + CAMERA into the Android manifest. Both are
 * removed (2026-11-15); adding a photo-library picker later must add both back
 * together — this test then needs its import.
 *
 * Source/config check (no device): the final generated Info.plist / merged
 * Android manifest of a store build is EXTERNALLY-UNVERIFIED here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = JSON.parse(readFileSync(join(ROOT, "app.json"), "utf8")).expo;
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(readFileSync(p, "utf8"));
  }
  return out;
}
const code = [...sources(join(ROOT, "app")), ...sources(join(ROOT, "src"))].join("\n");
const imports = (mod) => new RegExp(`from\\s+["']${mod.replace(/[/-]/g, "\\$&")}["']`).test(code);

/** Usage string → the modules whose use it describes. */
const USERS = {
  NSCameraUsageDescription: ["expo-camera"],
  NSMicrophoneUsageDescription: ["expo-camera", "expo-audio"],
  NSLocationWhenInUseUsageDescription: ["expo-location"],
  NSPhotoLibraryUsageDescription: ["expo-image-picker", "expo-media-library"],
  NSPhotoLibraryAddUsageDescription: ["expo-media-library"],
};

test("F-P1-11: every iOS usage string has code that uses it", () => {
  const plist = app.ios?.infoPlist ?? {};
  for (const key of Object.keys(plist).filter((k) => /UsageDescription$/.test(k))) {
    const users = USERS[key];
    assert.ok(users, `${key} is declared but this test does not know which module uses it`);
    assert.ok(users.some(imports), `${key} promises access no code uses (none of ${users.join(", ")} is imported)`);
  }
});

test("F-P1-11: no photo-library permission string while no photo-library picker exists", () => {
  assert.equal(app.ios?.infoPlist?.NSPhotoLibraryUsageDescription, undefined);
  assert.equal(imports("expo-image-picker"), false);
});

test("F-P1-11: no unused permission-bearing native library is linked", () => {
  for (const lib of ["expo-image-picker", "expo-media-library"]) {
    if (pkg.dependencies?.[lib]) assert.ok(imports(lib), `${lib} is a dependency but nothing imports it (autolinking still links it)`);
  }
});
