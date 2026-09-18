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
 *      uses that Info.plist + entitlements (App Group), links ReplayKit +
 *      AVFoundation, and is embedded in the main app's PlugIns/ folder;
 *   3. leaves the main-app App Group entitlement to app.json's ios.entitlements.
 *
 * Deployment target / signing / the Apple Team ID are supplied by EAS credentials
 * at build time — this plugin fabricates none of them.
 *
 * The pbxproj mutation is factored into the pure `applyBroadcastExtensionTarget`
 * function below so it can be validated offline against a fixture project
 * (test/pbxproj-integrity.test.mjs) — Windows cannot `expo prebuild -p ios`, so
 * the pbxproj plumbing is proven by that harness before it ever reaches EAS.
 *
 * Idempotent: re-running prebuild does not add a second target (guarded on the
 * native-target name, quote-insensitive — node-xcode stores target names quoted).
 */
const fs = require("fs");
const path = require("path");
// Import via `expo/config-plugins` (expo is a direct dependency and always
// resolvable from here); `@expo/config-plugins` is not hoisted under pnpm.
const { withXcodeProject, withDangerousMod } = require("expo/config-plugins");

const EXT_NAME = "ProovraBroadcast";
const EXT_SUFFIX = "broadcast";
const SRC_DIR = path.join(__dirname, "broadcast-extension");
const EXT_FILES = ["SampleHandler.swift", "Info.plist", "ProovraBroadcast.entitlements"];

/** Strip node-xcode's surrounding quotes from a stored string value. */
function unquote(value) {
  return String(value == null ? "" : value).replace(/^"|"$/g, "");
}

/**
 * Pure pbxproj mutation: add the Broadcast Upload Extension target to `proj`
 * (a parsed node-xcode project). Returns { added: boolean }.
 *
 * Correctness notes (the exact defect class this closes):
 *   - node-xcode's addTarget(..., "app_extension", ...) ALREADY creates the
 *     embed PBXCopyFilesBuildPhase (dstSubfolderSpec 13 = PlugIns) in the first
 *     target and adds the .appex product to it. We must NOT add a second embed
 *     phase by filename — doing so created a build file whose fileRef pointed at
 *     a fabricated-by-name PBXFileReference (the dangling reference).
 *   - The idempotency guard compares the UNQUOTED native-target name, because
 *     node-xcode stores names as '"ProovraBroadcast"'.
 */
function applyBroadcastExtensionTarget(proj, options) {
  const mainBundleId = (options && options.mainBundleId) || "com.jalalattar29.proovra";
  const extBundleId = `${mainBundleId}.${EXT_SUFFIX}`;

  // Idempotency: bail if the target already exists (quote-insensitive).
  const targets = proj.pbxNativeTargetSection();
  for (const key of Object.keys(targets)) {
    const t = targets[key];
    if (t && typeof t === "object" && unquote(t.name) === EXT_NAME) {
      return { added: false };
    }
  }

  // Source/resource group for the extension, attached under the project root.
  const group = proj.addPbxGroup(EXT_FILES, EXT_NAME, EXT_NAME);
  const groups = proj.hash.project.objects.PBXGroup;
  for (const key of Object.keys(groups)) {
    const g = groups[key];
    if (
      g &&
      typeof g === "object" &&
      g.name === undefined &&
      g.path === undefined &&
      Array.isArray(g.children)
    ) {
      g.children.push({ value: group.uuid, comment: EXT_NAME });
      break;
    }
  }

  // node-xcode's addTargetDependency silently no-ops (and some paths throw) when
  // these sections are absent from a freshly generated project — ensure they
  // exist before creating the target/dependency.
  const objects = proj.hash.project.objects;
  objects.PBXTargetDependency = objects.PBXTargetDependency || {};
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {};

  // Create the target. This auto-creates the embed (PlugIns) copy-files phase in
  // the main app target and adds the .appex product to it — no manual embed.
  const target = proj.addTarget(EXT_NAME, "app_extension", EXT_NAME, extBundleId);

  // Compile SampleHandler.swift in the extension; declare Resources + Frameworks.
  proj.addBuildPhase(["SampleHandler.swift"], "PBXSourcesBuildPhase", "Sources", target.uuid);
  proj.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
  proj.addBuildPhase(
    ["ReplayKit.framework", "AVFoundation.framework"],
    "PBXFrameworksBuildPhase",
    "Frameworks",
    target.uuid,
  );

  // Build settings for the extension's Debug + Release configurations only.
  const configs = proj.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configs)) {
    const cfgObj = configs[key];
    if (!cfgObj || typeof cfgObj !== "object" || !cfgObj.buildSettings) continue;
    const bs = cfgObj.buildSettings;
    if (bs.PRODUCT_NAME && unquote(bs.PRODUCT_NAME) === EXT_NAME) {
      bs.INFOPLIST_FILE = `${EXT_NAME}/Info.plist`;
      bs.CODE_SIGN_ENTITLEMENTS = `${EXT_NAME}/ProovraBroadcast.entitlements`;
      bs.PRODUCT_BUNDLE_IDENTIFIER = extBundleId;
      bs.IPHONEOS_DEPLOYMENT_TARGET = "13.4";
      bs.SWIFT_VERSION = "5.0";
      bs.TARGETED_DEVICE_FAMILY = '"1,2"';
      bs.CODE_SIGN_STYLE = "Automatic";
    }
  }

  // Make the main app depend on the extension (addTarget does not add this for
  // app_extension; it only wires the embed phase).
  proj.addTargetDependency(proj.getFirstTarget().uuid, [target.uuid]);

  return { added: true };
}

function withExtensionFilesCopied(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const iosRoot = cfg.modRequest.platformProjectRoot;
      const dest = path.join(iosRoot, EXT_NAME);
      fs.mkdirSync(dest, { recursive: true });
      for (const file of EXT_FILES) {
        fs.copyFileSync(path.join(SRC_DIR, file), path.join(dest, file));
      }
      return cfg;
    },
  ]);
}

function withExtensionTarget(config) {
  return withXcodeProject(config, (cfg) => {
    const mainBundleId =
      (cfg.ios && cfg.ios.bundleIdentifier) || "com.jalalattar29.proovra";
    applyBroadcastExtensionTarget(cfg.modResults, { mainBundleId });
    return cfg;
  });
}

module.exports = function withProovraIosScreenBroadcast(config) {
  config = withExtensionFilesCopied(config);
  config = withExtensionTarget(config);
  return config;
};

// Exposed for the offline pbxproj-integrity harness (no Expo/prebuild required).
module.exports.applyBroadcastExtensionTarget = applyBroadcastExtensionTarget;
module.exports.EXT_NAME = EXT_NAME;
module.exports.EXT_SUFFIX = EXT_SUFFIX;
