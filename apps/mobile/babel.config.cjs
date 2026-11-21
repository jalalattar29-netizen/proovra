/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS Babel config */
/**
 * babel-preset-expo is a dependency of `expo`, not of this app. Under the
 * workspace's pnpm layout (.npmrc: hoist-pattern only, nothing publicly
 * hoisted) a bare 'babel-preset-expo' is NOT resolvable from apps/mobile, so
 * every Metro bundle — the release JS bundle that Gradle's
 * createBundleReleaseJsAndAssets / Xcode's "Bundle React Native code" step
 * runs, and `expo start` — failed with "Cannot find module
 * 'babel-preset-expo'" (closure phase 2, Docker assembleRelease of 2307542a8).
 * Resolving it from `expo`'s own location finds the exact version expo ships
 * with, with no lockfile change.
 */
const path = require("path");

const BABEL_PRESET_EXPO = require.resolve("babel-preset-expo", {
  paths: [path.dirname(require.resolve("expo/package.json"))],
});

module.exports = function (api) {
  api.cache(true);

  return {
    presets: [BABEL_PRESET_EXPO],
  };
};
