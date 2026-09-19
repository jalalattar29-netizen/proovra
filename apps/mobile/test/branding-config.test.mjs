/**
 * PERMANENT GUARD — canonical PROOVRA branding wiring (Master Program §8, N2).
 *
 * The native app must reference the derived canonical branding assets, never the
 * old navy-checkmark icon or the legacy #050b18 chrome. This guard fails if the
 * config regresses (wrong adaptive foreground, missing monochrome, legacy splash
 * color, or the oversized 2048² assets creeping back). Config + asset headers as
 * data — no device, no compile.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const appJsonRaw = readFileSync(resolve(MOBILE, "app.json"), "utf8");
const { expo } = JSON.parse(appJsonRaw);

/** Read a PNG's width/height/byte-size from its IHDR header (no image lib). */
function pngInfo(relPath) {
  const abs = resolve(MOBILE, relPath);
  const buf = readFileSync(abs);
  assert.equal(buf.toString("ascii", 1, 4), "PNG", `${relPath} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: statSync(abs).size };
}

test("legacy #050b18 chrome is gone from native config", () => {
  assert.ok(!/#050b18/i.test(appJsonRaw), "app.json must not reference the legacy #050b18 color");
});

test("icon config points at the canonical derived assets", () => {
  assert.equal(expo.icon, "./assets/icon.png");
  assert.equal(expo.ios?.icon, "./assets/icon.png", "iOS must declare an opaque icon");
  // The adaptive FOREGROUND must be the safe-zone asset, NOT the full icon (full-bleed misuse).
  assert.equal(expo.android?.adaptiveIcon?.foregroundImage, "./assets/adaptive-icon.png");
  assert.notEqual(expo.android?.adaptiveIcon?.foregroundImage, "./assets/icon.png");
  assert.equal(expo.android?.adaptiveIcon?.monochromeImage, "./assets/adaptive-icon-monochrome.png");
  assert.equal(expo.android?.adaptiveIcon?.backgroundColor, "#0F172A");
});

test("splash uses the canonical mark on the canonical deep background", () => {
  assert.equal(expo.splash?.image, "./assets/splash-icon.png");
  assert.equal(expo.splash?.backgroundColor, "#0F172A");
});

test("derived assets are 1024² and optimized (not the old 2048² 4-5MB files)", () => {
  for (const p of [
    "assets/icon.png",
    "assets/adaptive-icon.png",
    "assets/adaptive-icon-monochrome.png",
    "assets/splash-icon.png",
  ]) {
    const { width, height, bytes } = pngInfo(p);
    assert.equal(width, 1024, `${p} must be 1024 wide`);
    assert.equal(height, 1024, `${p} must be 1024 tall`);
    assert.ok(bytes < 2_000_000, `${p} must be optimized (<2MB), was ${(bytes / 1048576).toFixed(2)}MB`);
  }
});

test("the in-app auth brand mark exists and is optimized", () => {
  const { width, height, bytes } = pngInfo("assets/brand-mark.png");
  assert.ok(width > 0 && height > 0, "brand-mark.png must be a real PNG");
  assert.ok(bytes < 1_000_000, `brand-mark.png must be optimized (<1MB), was ${(bytes / 1048576).toFixed(2)}MB`);
});

test("the iOS icon is opaque (no alpha channel — Apple requires it)", () => {
  // PNG color type is byte 25 of the IHDR; type 2 = RGB (opaque), type 6 = RGBA.
  const buf = readFileSync(resolve(MOBILE, "assets/icon.png"));
  const colorType = buf.readUInt8(25);
  assert.notEqual(colorType, 6, "iOS icon.png must not carry an alpha channel");
});
