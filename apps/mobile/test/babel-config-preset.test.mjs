/**
 * The Metro/Babel config must load its preset in this workspace's pnpm layout.
 * A bare 'babel-preset-expo' is not resolvable from apps/mobile (it is expo's
 * dependency, and .npmrc hoists nothing publicly), which failed the release JS
 * bundle (Gradle createBundleReleaseJsAndAssets) of 2307542a8 in a clean
 * install. The config now resolves the preset from expo's own location.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const config = require(resolve(HERE, "../babel.config.cjs"));

test("the babel config's preset resolves to an existing babel-preset-expo and loads as a preset", () => {
  let cached = null;
  const out = config({ cache: (v) => (cached = v) });
  assert.equal(cached, true);
  assert.equal(out.presets.length, 1);
  const preset = out.presets[0];
  assert.ok(typeof preset === "string" && existsSync(preset), `preset path does not exist: ${preset}`);
  assert.match(preset.split("\\").join("/"), /\/babel-preset-expo\//);
  assert.equal(typeof require(preset), "function", "babel-preset-expo did not load as a preset function");
});

test("it is the version expo itself depends on", () => {
  const expoPkg = require(require.resolve("expo/package.json", { paths: [resolve(HERE, "..")] }));
  const preset = config({ cache: () => {} }).presets[0];
  let dir = dirname(preset);
  while (!existsSync(resolve(dir, "package.json"))) dir = dirname(dir);
  const presetPkg = require(resolve(dir, "package.json"));
  assert.equal(presetPkg.name, "babel-preset-expo");
  const wanted = expoPkg.dependencies["babel-preset-expo"].replace(/^[~^]/, "");
  assert.equal(presetPkg.version.split(".").slice(0, 2).join("."), wanted.split(".").slice(0, 2).join("."));
});
