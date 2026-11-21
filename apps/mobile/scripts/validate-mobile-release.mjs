/**
 * AUD-009 — THE release-configuration gate for a store build.
 *
 * Run by .github/workflows/mobile-release.yml before any `eas build` (and
 * exercised by test/mobile-release-config.test.mjs). It refuses a release
 * whose configuration would ship something other than what the store expects:
 *
 *   - one eas.json: EAS reads the project directory's (apps/mobile — where
 *     app.json is and where `eas build` runs; EXPO_USE_WORKSPACE_ROOT only
 *     widens the uploaded archive), so a second one at the repo root is a
 *     drifted copy nobody uses;
 *   - the production profile is a STORE build: not a development client, not
 *     internal distribution, not a simulator build, not a Debug configuration,
 *     not an Android APK, not the private-distribution build flags; remote
 *     versioning with auto-increment;
 *   - the extension's version is its host's (build settings, synced by the
 *     config plugin on every prebuild);
 *   - App Group parity across app.json, the EAS appExtensions declaration, the
 *     extension entitlements and both Swift sides;
 *   - both privacy manifests are present and wired;
 *   - (B6-F-64) the ENVIRONMENT the release runs in does not carry the
 *     private-distribution flags either. `externalCheckoutEnabled()` reads
 *     them at bundle time from whatever env the build sees — eas.json is one
 *     source, the build machine's own environment is another (`eas build
 *     --local`, or a CI step that exports them). The EAS-dashboard
 *     "production" environment variables are a third, readable here only with
 *     an Expo token; they are checked where they are resolved instead: on the
 *     EAS build worker, by the `eas-build-post-install` hook running this file
 *     with `--eas-build-env` (easBuildEnvProblems), which refuses the store
 *     build before anything is bundled.
 *
 * Nothing here reads credentials; the workflow gates those separately.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");

/** Every input the gate looks at, read from a mobile app root. */
export function readReleaseInputs(mobileRoot = MOBILE) {
  const read = (rel) => readFileSync(resolve(mobileRoot, rel), "utf8");
  const require = createRequire(import.meta.url);
  return {
    rootEasJsonExists: existsSync(resolve(mobileRoot, "../../eas.json")),
    eas: JSON.parse(read("eas.json")),
    appJson: JSON.parse(read("app.json")),
    extInfoPlist: read("plugins/broadcast-extension/Info.plist"),
    extEntitlements: read("plugins/broadcast-extension/ProovraBroadcast.entitlements"),
    extPrivacyManifestExists: existsSync(resolve(mobileRoot, "plugins/broadcast-extension/PrivacyInfo.xcprivacy")),
    plugin: require(resolve(mobileRoot, "plugins/withProovraIosScreenBroadcast.cjs")),
    pluginSource: read("plugins/withProovraIosScreenBroadcast.cjs"),
    sampleHandler: read("plugins/broadcast-extension/SampleHandler.swift"),
    iosModule: read("modules/proovra-screen-capture/ios/ProovraScreenCaptureModule.swift"),
    buildEnv: pickPrivateFlags(process.env),
  };
}

/** The two flags that turn on in-app checkout, as an environment sets them. */
export const PRIVATE_DISTRIBUTION_FLAGS = ["EXPO_PUBLIC_DISTRIBUTION", "EXPO_PUBLIC_PRIVATE_BILLING"];

export function pickPrivateFlags(env) {
  const out = {};
  for (const flag of PRIVATE_DISTRIBUTION_FLAGS) {
    const value = env?.[flag];
    if (typeof value === "string" && value.trim() !== "") out[flag] = value;
  }
  return out;
}

/**
 * B6-F-64 — PURE: the private-distribution flags in the environment of the
 * machine that is BUILDING the binary right now. On an EAS build worker that
 * environment is eas.json's profile env PLUS the EAS-dashboard environment
 * variables of the profile's environment, resolved by EAS itself, which is
 * exactly what Metro inlines into the JS bundle (externalCheckoutEnabled()).
 * It runs there through the package.json `eas-build-post-install` hook
 * (`--eas-build-env`), before any bundling.
 *
 * Only a profile eas.json declares `distribution: "internal"` may carry the
 * flags (preview: private distribution, the only place in-app checkout is
 * allowed). Every other profile, an unknown one, and a missing
 * EAS_BUILD_PROFILE are treated as a store build and refused.
 */
export function easBuildEnvProblems(eas, env) {
  const profileName = typeof env?.EAS_BUILD_PROFILE === "string" ? env.EAS_BUILD_PROFILE.trim() : "";
  const profile = profileName ? eas?.build?.[profileName] : undefined;
  if (profile && profile.distribution === "internal") return [];
  const label = profileName ? `EAS build profile "${profileName}"` : "a build with no EAS_BUILD_PROFILE";
  return Object.keys(pickPrivateFlags(env)).map(
    (flag) => `${label} is a store build, but its build environment sets the private-distribution flag ${flag}; remove it from the EAS environment (eas env:list) and rebuild`,
  );
}

/** PURE — the problems that block a store release; [] means releasable. */
export function validateMobileRelease(inputs) {
  const problems = [];
  const fail = (m) => problems.push(m);
  const { eas, appJson } = inputs;

  // One eas.json.
  if (inputs.rootEasJsonExists) {
    fail("a second eas.json exists at the repository root; EAS uses apps/mobile/eas.json — remove the drifted copy");
  }

  // Versioning: remote source, store builds auto-increment.
  if (eas?.cli?.appVersionSource !== "remote") fail('eas.json cli.appVersionSource must be "remote"');
  const prod = eas?.build?.production;
  if (!prod) {
    fail("eas.json has no build.production profile");
  } else {
    if (prod.autoIncrement !== true) fail("build.production.autoIncrement must be true");
    if (prod.developmentClient) fail("build.production is a development client");
    if (prod.distribution && prod.distribution !== "store") fail(`build.production.distribution is "${prod.distribution}", not store`);
    if (prod.extends) fail("build.production must not extend another profile (its store settings must be explicit)");
    if (prod.ios?.simulator) fail("build.production.ios.simulator is set — a simulator build cannot be submitted");
    if (prod.ios?.buildConfiguration && prod.ios.buildConfiguration !== "Release") {
      fail(`build.production.ios.buildConfiguration is "${prod.ios.buildConfiguration}"`);
    }
    if (prod.android?.buildType && prod.android.buildType !== "app-bundle") {
      fail(`build.production.android.buildType is "${prod.android.buildType}", not app-bundle`);
    }
    if (prod.android?.gradleCommand && /Debug/i.test(prod.android.gradleCommand)) fail("build.production.android.gradleCommand builds Debug");
    for (const flag of PRIVATE_DISTRIBUTION_FLAGS) {
      if (prod.env && flag in prod.env) fail(`build.production.env sets the private-distribution flag ${flag}`);
    }
  }
  // B6-F-64 — the resolved build environment, not only eas.json.
  for (const flag of Object.keys(inputs.buildEnv ?? {})) {
    fail(`the release environment sets the private-distribution flag ${flag}; a store build must be produced without it`);
  }
  if (!eas?.submit?.production) fail("eas.json has no submit.production profile");

  // The extension's version is its host's.
  if (!/<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/.test(inputs.extInfoPlist)) {
    fail("the extension Info.plist does not take CFBundleShortVersionString from $(MARKETING_VERSION)");
  }
  if (!/<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/.test(inputs.extInfoPlist)) {
    fail("the extension Info.plist does not take CFBundleVersion from $(CURRENT_PROJECT_VERSION)");
  }
  if (typeof inputs.plugin?.syncExtensionVersions !== "function" || !/syncExtensionVersions\(cfg\.modResults/.test(inputs.pluginSource)) {
    fail("the config plugin does not sync the extension's MARKETING_VERSION / CURRENT_PROJECT_VERSION with the host");
  }
  if (!appJson?.expo?.version) fail("app.json has no expo.version");

  // App Group parity.
  const ios = appJson?.expo?.ios ?? {};
  const appGroups = ios.entitlements?.["com.apple.security.application-groups"] ?? [];
  if (appGroups.length !== 1) fail("app.json must declare exactly one App Group");
  const group = appGroups[0];
  const declaredExt = appJson?.expo?.extra?.eas?.build?.experimental?.ios?.appExtensions ?? [];
  const ext = declaredExt.find((e) => e.targetName === inputs.plugin?.EXT_NAME);
  if (!ext) fail("app.json does not declare the ProovraBroadcast extension to EAS (appExtensions)");
  if (ext && ext.bundleIdentifier !== `${ios.bundleIdentifier}.${inputs.plugin.EXT_SUFFIX}`) {
    fail(`the declared extension bundle id ${ext.bundleIdentifier} is not ${ios.bundleIdentifier}.${inputs.plugin.EXT_SUFFIX}`);
  }
  const extGroups = ext?.entitlements?.["com.apple.security.application-groups"] ?? [];
  if (JSON.stringify(extGroups) !== JSON.stringify(appGroups)) fail("the EAS appExtensions App Groups differ from the app's");
  if (group && !inputs.extEntitlements.includes(`<string>${group}</string>`)) fail(`the extension entitlements lack the App Group ${group}`);
  for (const [name, src] of [["SampleHandler.swift", inputs.sampleHandler], ["ProovraScreenCaptureModule.swift", inputs.iosModule]]) {
    const m = src.match(/static let appGroup = "([^"]+)"/);
    if (!m || m[1] !== group) fail(`${name} uses App Group ${m?.[1] ?? "(none)"}, not ${group}`);
  }

  // Privacy manifests.
  if (!inputs.extPrivacyManifestExists) fail("plugins/broadcast-extension/PrivacyInfo.xcprivacy is missing");
  if (!(inputs.plugin?.EXT_RESOURCES ?? []).includes("PrivacyInfo.xcprivacy")) {
    fail("the extension's PrivacyInfo.xcprivacy is not a Resources member of its target");
  }
  if (!ios.privacyManifests) fail("app.json has no expo.ios.privacyManifests");
  else if (ios.privacyManifests.NSPrivacyTracking !== false) fail("the app privacy manifest must declare NSPrivacyTracking false");

  return problems;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes("--eas-build-env")) {
  // B6-F-64 — on the EAS build worker (package.json eas-build-post-install).
  const eas = JSON.parse(readFileSync(resolve(MOBILE, "eas.json"), "utf8"));
  const problems = easBuildEnvProblems(eas, process.env);
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error::${p}`);
    console.error("Store build refused: the EAS build environment would enable in-app checkout. Nothing was bundled.");
    process.exit(1);
  }
  console.log(`EAS build environment OK for profile ${process.env.EAS_BUILD_PROFILE ?? "(none)"}: no private-distribution flag reaches a store build.`);
} else if (isMain) {
  const inputs = readReleaseInputs();
  const problems = validateMobileRelease(inputs);
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error::${p}`);
    console.error(`Mobile release configuration refused (${problems.length} problem(s)). Nothing was built.`);
    process.exit(1);
  }
  console.log(`Mobile release configuration OK — version ${inputs.appJson.expo.version} (build number from EAS remote versioning).`);
}
