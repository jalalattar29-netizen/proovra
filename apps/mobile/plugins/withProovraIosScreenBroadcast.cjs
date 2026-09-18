/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * UC-5 — Expo config plugin that adds the PROOVRA iOS Broadcast Upload Extension
 * target to the generated Xcode project during `expo prebuild`.
 *
 * It:
 *   1. copies the extension source (SampleHandler.swift, Info.plist, entitlements)
 *      into ios/ProovraBroadcast/;
 *   2. creates a broadcast-upload app-extension target
 *      (bundle id <MAIN_BUNDLE_ID>.broadcast) that compiles SampleHandler.swift,
 *      uses that Info.plist + entitlements (App Group), and is embedded in the
 *      main app;
 *   3. leaves the main-app App Group entitlement to app.json's ios.entitlements.
 *
 * Deployment target / signing / the Apple Team ID are supplied by EAS credentials
 * at build time — this plugin fabricates none of them. Idempotent: re-running
 * prebuild does not add a second target.
 */
const fs = require("fs");
const path = require("path");
// Import via `expo/config-plugins` (expo is a direct dependency and always
// resolvable from here); `@expo/config-plugins` is not hoisted under pnpm.
const { withXcodeProject, withDangerousMod } = require("expo/config-plugins");

const EXT_NAME = "ProovraBroadcast";
const EXT_SUFFIX = "broadcast";
const SRC_DIR = path.join(__dirname, "broadcast-extension");

function withExtensionFilesCopied(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const iosRoot = cfg.modRequest.platformProjectRoot;
      const dest = path.join(iosRoot, EXT_NAME);
      fs.mkdirSync(dest, { recursive: true });
      for (const file of ["SampleHandler.swift", "Info.plist", "ProovraBroadcast.entitlements"]) {
        fs.copyFileSync(path.join(SRC_DIR, file), path.join(dest, file));
      }
      return cfg;
    },
  ]);
}

function withExtensionTarget(config) {
  return withXcodeProject(config, (cfg) => {
    const proj = cfg.modResults;
    const mainBundleId =
      (cfg.ios && cfg.ios.bundleIdentifier) || "com.jalalattar29.proovra";
    const extBundleId = `${mainBundleId}.${EXT_SUFFIX}`;

    // Idempotency: bail if the target already exists.
    const targets = proj.pbxNativeTargetSection();
    for (const key of Object.keys(targets)) {
      if (targets[key] && targets[key].name === EXT_NAME) return cfg;
    }

    // Group + target for the extension.
    const group = proj.addPbxGroup(
      ["SampleHandler.swift", "Info.plist", "ProovraBroadcast.entitlements"],
      EXT_NAME,
      EXT_NAME,
    );
    // Attach the group under the project root group.
    const groups = proj.hash.project.objects.PBXGroup;
    for (const key of Object.keys(groups)) {
      if (groups[key] && groups[key].name === undefined && groups[key].path === undefined && Array.isArray(groups[key].children)) {
        groups[key].children.push({ value: group.uuid, comment: EXT_NAME });
        break;
      }
    }

    const target = proj.addTarget(EXT_NAME, "app_extension", EXT_NAME, extBundleId);
    proj.addBuildPhase(["SampleHandler.swift"], "PBXSourcesBuildPhase", "Sources", target.uuid);
    proj.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
    proj.addBuildPhase(
      ["ReplayKit.framework", "AVFoundation.framework"],
      "PBXFrameworksBuildPhase",
      "Frameworks",
      target.uuid,
    );

    // Build settings for BOTH configurations (Debug/Release).
    const configs = proj.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configs)) {
      const bs = configs[key].buildSettings;
      if (!bs || configs[key].name === undefined) continue;
      if (bs.PRODUCT_NAME && String(bs.PRODUCT_NAME).includes(EXT_NAME)) {
        bs.INFOPLIST_FILE = `${EXT_NAME}/Info.plist`;
        bs.CODE_SIGN_ENTITLEMENTS = `${EXT_NAME}/ProovraBroadcast.entitlements`;
        bs.PRODUCT_BUNDLE_IDENTIFIER = extBundleId;
        bs.IPHONEOS_DEPLOYMENT_TARGET = "13.4";
        bs.SWIFT_VERSION = "5.0";
        bs.TARGETED_DEVICE_FAMILY = '"1,2"';
        bs.CODE_SIGN_STYLE = "Automatic";
      }
    }

    // Embed the extension into the main app.
    proj.addTargetDependency(proj.getFirstTarget().uuid, [target.uuid]);
    proj.addBuildPhase(
      [`${EXT_NAME}.appex`],
      "PBXCopyFilesBuildPhase",
      "Embed App Extensions",
      proj.getFirstTarget().uuid,
      "app_extension",
    );
    return cfg;
  });
}

module.exports = function withProovraIosScreenBroadcast(config) {
  config = withExtensionFilesCopied(config);
  config = withExtensionTarget(config);
  return config;
};
