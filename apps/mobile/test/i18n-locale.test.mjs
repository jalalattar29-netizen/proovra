/**
 * GUARD — device-locale detection must not reference an uninstalled/optional
 * native module via `require(...)`.
 *
 * The bug: `getDeviceLocale()` did `require("expo-localization")`, but
 * expo-localization is NOT a dependency. Metro baked the unresolved dependency
 * into the bundle as `undefined`, so on the physical iPad Hermes threw
 * `Requiring unknown module "undefined"` at boot (crash chain: initializeLocale
 * -> resolveInitialLocale -> getDeviceLocale). The surrounding try/catch could
 * not intercept it because the failure is Metro's build-time resolution, not a
 * runtime throw.
 *
 * Fix: read the device language from React Native core (SettingsManager on iOS,
 * I18nManager elsewhere) — statically analyzable, always present, no extra dep.
 *
 * This test reads the source as text (i18n.ts imports react-native, so it can't
 * be imported under node:test) and locks the invariant + full locale coverage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const i18nSrc = readFileSync(resolve(HERE, "../src/i18n.ts"), "utf8");
const sharedI18n = readFileSync(resolve(HERE, "../../../packages/shared/src/i18n.ts"), "utf8");

const SUPPORTED = ["en", "ar", "de", "fr", "es", "tr", "ru"];

test("i18n.ts does NOT require expo-localization (the module is not installed)", () => {
  assert.ok(
    !/require\(\s*["']expo-localization["']\s*\)/.test(i18nSrc),
    "getDeviceLocale must not require('expo-localization') — it is not a dependency",
  );
});

test("i18n.ts has no unresolvable/optional/dynamic require of a native module", () => {
  // No require() of any package at all (the fix uses static ESM imports), and no
  // dynamic require(variable)/require(expr) that Metro cannot statically resolve.
  assert.ok(!/\brequire\(/.test(i18nSrc), "i18n.ts must not use require(); use static imports");
});

test("device-locale detection uses React Native core (statically resolvable)", () => {
  assert.match(i18nSrc, /from\s+["']react-native["']/, "must import from react-native");
  assert.match(i18nSrc, /NativeModules/, "must read locale via NativeModules (SettingsManager/I18nManager)");
  assert.match(i18nSrc, /SettingsManager/);
  assert.match(i18nSrc, /I18nManager/);
});

test("all supported locales are preserved and mapping stays data-driven", () => {
  // The canonical list still has all 7 locales, and getDeviceLocale gates on it.
  for (const loc of SUPPORTED) {
    assert.match(sharedI18n, new RegExp(`["']${loc}["']`), `shared Locale must include ${loc}`);
  }
  assert.match(i18nSrc, /supportedLocales\.includes/, "getDeviceLocale must gate on supportedLocales");
  assert.match(i18nSrc, /defaultLocale/, "must fall back to defaultLocale");
});

test("RTL/persistence contract is untouched by the fix (still keyed on locale)", () => {
  const ctx = readFileSync(resolve(HERE, "../src/locale-context.tsx"), "utf8");
  assert.match(ctx, /isRTL\s*=\s*locale === "ar"/, "RTL must still derive from locale === 'ar'");
  assert.match(ctx, /"proovra-locale"/, "persisted locale key preserved");
  assert.match(ctx, /"proovra-locale-mode"/, "persisted mode key preserved");
});
