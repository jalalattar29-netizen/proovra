/**
 * AUD-007 — Apple privacy manifests for the app and the ProovraBroadcast
 * extension.
 *
 * RED on the pre-remediation tree: there was no PrivacyInfo.xcprivacy anywhere
 * (app, extension or local pod), app.json had no ios.privacyManifests, and the
 * extension called volumeAvailableCapacityForImportantUsageKey (a DiskSpace
 * required-reason API) undeclared.
 *
 * Proven here: both manifests exist and parse as property lists; each declares
 * EXACTLY the required-reason API categories its own first-party Swift calls
 * (scanned from source, so a new call without a declaration fails); tracking is
 * off; the extension manifest is a Resources member of the extension target
 * (so it embeds in the .appex); Expo's own PrivacyInfo mod turns app.json into
 * a valid manifest; and native-build.yml checks both built bundles.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const REPO_ROOT = resolve(MOBILE, "../..");
const read = (rel) => readFileSync(resolve(MOBILE, rel), "utf8");

// @expo/plist and @expo/config-plugins, resolved the way the config plugin resolves them.
const requireFromPlugins = createRequire(require.resolve("expo/config-plugins"));
const configPlugins = requireFromPlugins("@expo/config-plugins");
const plist = createRequire(requireFromPlugins.resolve("@expo/config-plugins"))("@expo/plist").default;

const plugin = require(resolve(MOBILE, "plugins/withProovraIosScreenBroadcast.cjs"));
const appJson = JSON.parse(read("app.json"));
const EXT_MANIFEST_SRC = read("plugins/broadcast-extension/PrivacyInfo.xcprivacy");
const extManifest = plist.parse(EXT_MANIFEST_SRC);
const appManifest = appJson.expo.ios.privacyManifests;

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** Apple's required-reason API categories, by the symbols that put code in them. */
const REQUIRED_REASON_SYMBOLS = {
  NSPrivacyAccessedAPICategoryDiskSpace: /volumeAvailableCapacity|volumeTotalCapacity|systemFreeSize|systemSize\b|NSFileSystemFreeSize|NSFileSystemSize|\bstatfs\(|\bfstatfs\(/,
  NSPrivacyAccessedAPICategorySystemBootTime: /systemUptime|mach_absolute_time/,
  NSPrivacyAccessedAPICategoryFileTimestamp: /creationDate|modificationDate|contentModificationDate|attributesOfItem|fileModificationDate|getattrlist|\bstat\(|\blstat\(|\bfstat\(/,
  NSPrivacyAccessedAPICategoryUserDefaults: /UserDefaults|NSUserDefaults/,
  NSPrivacyAccessedAPICategoryActiveKeyboards: /activeInputModes/,
};
/** The reason code each category is declared with — the use, not a guess. */
const DECLARED_REASON = {
  // "check whether there is sufficient disk space to write files" (SampleHandler.startSegment).
  NSPrivacyAccessedAPICategoryDiskSpace: ["E174.1"],
  // "elapsed time between events that occurred within the app" (spool heartbeat / binding freshness).
  NSPrivacyAccessedAPICategorySystemBootTime: ["35F9.1"],
};

function categoriesUsedBy(files) {
  const used = new Set();
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"));
    for (const [category, re] of Object.entries(REQUIRED_REASON_SYMBOLS)) if (re.test(src)) used.add(category);
  }
  return [...used].sort();
}

const IOS_DIR = resolve(MOBILE, "modules/proovra-screen-capture/ios");
// Compiled into the APP (the local pod's source_files = '*.{h,m,mm,swift,…}').
const appFiles = readdirSync(IOS_DIR).filter((f) => /\.(swift|m|mm|h)$/.test(f)).map((f) => join(IOS_DIR, f));
// Compiled into the EXTENSION (the plugin's Sources phase).
const extFiles = plugin.EXT_SOURCES.map((f) =>
  plugin.SHARED_FILES.includes(f) ? join(IOS_DIR, f) : resolve(MOBILE, "plugins/broadcast-extension", f),
);

function declared(manifest) {
  return Object.fromEntries(
    (manifest.NSPrivacyAccessedAPITypes ?? []).map((t) => [t.NSPrivacyAccessedAPIType, [...t.NSPrivacyAccessedAPITypeReasons].sort()]),
  );
}

test("AUD-007: the extension manifest is a well-formed property list that tracks nothing", () => {
  assert.match(EXT_MANIFEST_SRC, /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN"/);
  assert.match(EXT_MANIFEST_SRC, /<plist version="1\.0">\s*<dict>[\s\S]*<\/dict>\s*<\/plist>\s*$/);
  // Round-trips through Apple's plist format unchanged.
  assert.deepEqual(plist.parse(plist.build(extManifest)), extManifest);
  assert.equal(extManifest.NSPrivacyTracking, false);
  assert.deepEqual(extManifest.NSPrivacyTrackingDomains, []);
  // The extension transmits nothing itself; the app declares the upload.
  assert.deepEqual(extManifest.NSPrivacyCollectedDataTypes, []);
});

test("AUD-007: each manifest declares EXACTLY the required-reason APIs its own code calls, with the use's reason", () => {
  const extUsed = categoriesUsedBy(extFiles);
  assert.ok(extUsed.includes("NSPrivacyAccessedAPICategoryDiskSpace"), "the scan no longer sees the extension's disk-space check");
  assert.deepEqual(Object.keys(declared(extManifest)).sort(), extUsed, "extension: declared categories != used categories");
  const appUsed = categoriesUsedBy(appFiles);
  assert.deepEqual(Object.keys(declared(appManifest)).sort(), appUsed, "app: declared categories != used categories");
  for (const [category, reasons] of Object.entries({ ...declared(extManifest), ...declared(appManifest) })) {
    assert.deepEqual(reasons, DECLARED_REASON[category], `${category} declared with ${reasons}`);
  }
});

test("AUD-007: app.json declares the app manifest through Expo's ios.privacyManifests, accurately and without tracking", () => {
  assert.ok(appManifest, "app.json has no expo.ios.privacyManifests");
  assert.equal(appManifest.NSPrivacyTracking, false);
  assert.deepEqual(appManifest.NSPrivacyTrackingDomains, []);
  const types = appManifest.NSPrivacyCollectedDataTypes;
  assert.ok(Array.isArray(types) && types.length > 0);
  for (const t of types) {
    assert.match(t.NSPrivacyCollectedDataType, /^NSPrivacyCollectedDataType[A-Z]\w+$/);
    assert.equal(t.NSPrivacyCollectedDataTypeTracking, false, `${t.NSPrivacyCollectedDataType} is declared as tracking`);
    assert.equal(typeof t.NSPrivacyCollectedDataTypeLinked, "boolean");
    assert.ok(t.NSPrivacyCollectedDataTypePurposes.length > 0);
    for (const p of t.NSPrivacyCollectedDataTypePurposes) {
      assert.ok(!/Advertising/.test(p), `${t.NSPrivacyCollectedDataType} is declared for advertising`);
    }
  }
  const names = types.map((t) => t.NSPrivacyCollectedDataType.replace("NSPrivacyCollectedDataType", ""));
  assert.equal(new Set(names).size, names.length, "a data type is declared twice");
  // Each declared type is evidenced by the app's own flows (not invented):
  const evidence = {
    EmailAddress: ["src/auth/auth-api.ts", /email/],
    Name: ["src/auth/auth-api.ts", /displayName/],
    PhoneNumber: ["src/product/contact-factors.ts", /destination/],
    UserID: ["src/auth-context.tsx", /id: string/],
    PhotosorVideos: ["app/(stack)/capture.tsx", /video|photo/i],
    AudioData: ["app/(stack)/capture.tsx", /audio/i],
    PreciseLocation: ["app/(stack)/capture.tsx", /getCurrentPositionAsync/],
    OtherUserContent: ["src/product/discussion.ts", /\w/],
    CrashData: ["src/sentry.ts", /Sentry\.init/],
  };
  assert.deepEqual([...names].sort(), Object.keys(evidence).sort());
  for (const [name, [file, re]] of Object.entries(evidence)) assert.match(read(file), re, `${name}: no evidence in ${file}`);
  // Crash reports carry no user identity (Sentry.setUser is never called).
  assert.ok(!/Sentry\.setUser/.test(read("src/sentry.ts")));
  assert.equal(types.find((t) => /CrashData$/.test(t.NSPrivacyCollectedDataType)).NSPrivacyCollectedDataTypeLinked, false);
});

test("AUD-007: Expo's PrivacyInfo mod turns app.json into a valid app manifest (merged with the template's)", () => {
  assert.equal(typeof configPlugins.IOSConfig.PrivacyInfo.mergePrivacyInfo, "function", "this Expo SDK has no ios.privacyManifests support");
  // The SDK template may already carry React Native's own entries; they are kept.
  const template = {
    NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults", NSPrivacyAccessedAPITypeReasons: ["CA92.1"] }],
  };
  const merged = configPlugins.IOSConfig.PrivacyInfo.mergePrivacyInfo(template, appManifest);
  const written = plist.parse(plist.build(merged));
  assert.equal(written.NSPrivacyTracking, false);
  assert.ok(written.NSPrivacyAccessedAPITypes.some((t) => t.NSPrivacyAccessedAPIType === "NSPrivacyAccessedAPICategorySystemBootTime"));
  assert.ok(written.NSPrivacyAccessedAPITypes.some((t) => t.NSPrivacyAccessedAPIType === "NSPrivacyAccessedAPICategoryUserDefaults"));
  assert.equal(written.NSPrivacyCollectedDataTypes.length, appManifest.NSPrivacyCollectedDataTypes.length);
});

function resolveXcode() {
  try {
    return require("xcode");
  } catch {
    const pnpmDir = join(REPO_ROOT, "node_modules", ".pnpm");
    const entry = readdirSync(pnpmDir).find((d) => /^xcode@/.test(d));
    return require(join(pnpmDir, entry, "node_modules", "xcode"));
  }
}

test("AUD-007: the extension manifest is copied by the plugin and is a Resources member of the extension target", () => {
  assert.ok(plugin.EXT_RESOURCES.includes("PrivacyInfo.xcprivacy"));
  assert.match(read("plugins/withProovraIosScreenBroadcast.cjs"), /const EXT_FILES = \[[^\]]*PRIVACY_MANIFEST\]/);
  const xcode = resolveXcode();
  const dir = mkdtempSync(join(tmpdir(), "pbxproj-privacy-"));
  const p = join(dir, "project.pbxproj");
  writeFileSync(p, read("test/fixtures/base-app.pbxproj"));
  const proj = xcode.project(p);
  proj.parseSync();
  plugin.applyBroadcastExtensionTarget(proj, { mainBundleId: "com.jalalattar29.proovra" });
  writeFileSync(p, proj.writeSync());
  const after = xcode.project(p);
  after.parseSync();
  const objects = after.hash.project.objects;
  const ext = Object.values(objects.PBXNativeTarget).find((t) => t && String(t.name).replace(/"/g, "") === plugin.EXT_NAME);
  const resourcesRef = ext.buildPhases.find((b) => /Resources/.test(String(b.comment)));
  const phase = objects.PBXResourcesBuildPhase[resourcesRef.value];
  const refs = phase.files.map((f) => objects.PBXFileReference[objects.PBXBuildFile[f.value].fileRef]);
  const manifestRef = refs.find((r) => String(r.path).replace(/"/g, "") === "PrivacyInfo.xcprivacy");
  assert.ok(manifestRef, "PrivacyInfo.xcprivacy is not in the extension's Resources phase");
  assert.equal(manifestRef.lastKnownFileType, "text.xml");
  // It is the EXTENSION's file (its group), not some other target's manifest.
  const extGroup = Object.values(objects.PBXGroup).find((g) => g && g.name === plugin.EXT_NAME);
  const manifestUuid = Object.keys(objects.PBXFileReference).find((k) => objects.PBXFileReference[k] === manifestRef);
  assert.ok(extGroup.children.some((c) => c.value === manifestUuid), "the Resources entry points outside ProovraBroadcast/");
  // And the main app's Resources phase does not pick the extension's manifest up.
  const main = after.pbxNativeTargetSection()[after.getFirstTarget().uuid];
  const mainRes = main.buildPhases.find((b) => /Resources/.test(String(b.comment)));
  if (mainRes) {
    const mainFiles = objects.PBXResourcesBuildPhase[mainRes.value].files.map((f) => objects.PBXBuildFile[f.value]?.fileRef);
    assert.ok(!mainFiles.includes(manifestUuid));
  }
});

test("AUD-007: native-build.yml checks the manifest inside the built .app AND the embedded ProovraBroadcast.appex", () => {
  const wf = readFileSync(resolve(REPO_ROOT, ".github/workflows/native-build.yml"), "utf8");
  const step = wf.match(/- name: Refuse a build without the privacy manifests[\s\S]*?(?=\n {6}- )/);
  assert.ok(step, "the privacy-manifest step is missing");
  assert.match(step[0], /APPEX="\$APP\/PlugIns\/ProovraBroadcast\.appex"/);
  assert.match(step[0], /for bundle in "\$APP" "\$APPEX"/);
  assert.match(step[0], /PrivacyInfo\.xcprivacy/);
  assert.match(step[0], /plutil -lint/);
  assert.match(step[0], /exit 1/);
  // After the build, never before it.
  assert.ok(wf.indexOf("Refuse a build without the privacy manifests") > wf.indexOf("xcodebuild -workspace"));
});
