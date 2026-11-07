/**
 * The fmt pod is compiled as C++17 so React Native 0.76's fmt 11.0.2 builds
 * under Xcode 16.3+ (plugins/withFmtCxx17.cjs). The plugin must extend the
 * Podfile's existing post_install hook, touch only the fmt target, insert
 * itself once, and refuse a Podfile it cannot extend instead of silently
 * doing nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const plugin = require("../plugins/withFmtCxx17.cjs");
const { addFmtCxx17, MARKER } = plugin;

const PODFILE = [
  "target 'Proovra' do",
  "  use_expo_modules!",
  "  post_install do |installer|",
  "    react_native_post_install(installer, config[:reactNativePath])",
  "  end",
  "end",
  "",
].join("\n");

test("the fmt target, and only it, is set to C++17 inside the existing post_install hook", () => {
  const out = addFmtCxx17(PODFILE);
  const hook = out.indexOf("post_install do |installer|");
  const marker = out.indexOf(MARKER);
  const rnHook = out.indexOf("react_native_post_install");
  assert.ok(hook >= 0 && marker > hook && marker < rnHook, "inserted at the top of the existing hook");
  assert.match(out, /next unless target\.name == 'fmt'/);
  assert.match(out, /build_settings\['CLANG_CXX_LANGUAGE_STANDARD'\] = 'c\+\+17'/);
  assert.equal((out.match(/post_install do/g) ?? []).length, 1, "no second post_install hook");
});

test("running prebuild twice inserts it once", () => {
  const once = addFmtCxx17(PODFILE);
  assert.equal(addFmtCxx17(once), once);
});

test("a Podfile without a post_install hook is refused, not silently left alone", () => {
  assert.throws(() => addFmtCxx17("target 'Proovra' do\nend\n"), /no `post_install do \|installer\|` hook/);
});

test("the plugin is registered in app.json", () => {
  const app = JSON.parse(fs.readFileSync(new URL("../app.json", import.meta.url), "utf8"));
  assert.ok(app.expo.plugins.includes("./plugins/withFmtCxx17.cjs"));
});
