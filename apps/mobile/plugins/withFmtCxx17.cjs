/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Compiles React Native 0.76's bundled `fmt` pod as C++17.
 *
 * WHY: fmt 11.0.2, which RN 0.76.9 ships, turns on `consteval` when it is built
 * as C++20. Xcode 16.3 and later reject that ("call to consteval function ...
 * is not a constant expression" in fmt/format-inl.h) before any app source
 * compiles. CI was therefore pinned to Xcode 16.2 on the macos-14 image, and
 * GitHub has since retired that image ("The configuration
 * 'macos-14-arm64-us-default' is not supported"). Under C++17, fmt's own
 * feature check leaves `consteval` off, and nothing outside the fmt target
 * changes: every other pod keeps the C++ standard React Native sets.
 *
 * The edit goes into the Podfile's existing `post_install` hook, so it applies
 * to every `expo prebuild` (CI and release builds alike). It runs once: a
 * marker line keeps it from being inserted twice.
 */
const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("expo/config-plugins");

const MARKER = "# proovra: fmt as C++17 (withFmtCxx17)";
const HOOK = /post_install do \|installer\|\n/;

const SNIPPET = [
  `    ${MARKER}`,
  "    installer.pods_project.targets.each do |target|",
  "      next unless target.name == 'fmt'",
  "      target.build_configurations.each do |build_config|",
  "        build_config.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'",
  "      end",
  "    end",
  "",
].join("\n");

function addFmtCxx17(podfile) {
  if (podfile.includes(MARKER)) return podfile;
  if (!HOOK.test(podfile)) {
    throw new Error("withFmtCxx17: the Podfile has no `post_install do |installer|` hook to extend");
  }
  return podfile.replace(HOOK, (hook) => hook + SNIPPET);
}

function withFmtCxx17(config) {
  return withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      const podfile = fs.readFileSync(podfilePath, "utf8");
      fs.writeFileSync(podfilePath, addFmtCxx17(podfile));
      return cfg;
    },
  ]);
}

module.exports = withFmtCxx17;
module.exports.addFmtCxx17 = addFmtCxx17;
module.exports.MARKER = MARKER;
