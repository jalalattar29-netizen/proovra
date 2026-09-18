/**
 * PERMANENT GUARD (UC-5) — Broadcast Upload Extension pbxproj integrity.
 *
 * The defect this closes: the config plugin's app-extension target creation
 * produced a DANGLING build-file reference (a PBXBuildFile whose fileRef, and a
 * copy-phase entry, pointed at a PBXFileReference fabricated by bare `.appex`
 * filename). node-xcode's `addTarget(..., "app_extension", ...)` ALREADY creates
 * the embed (PlugIns) copy-files phase and adds the product to it, so the
 * plugin's *second* manual embed created the phantom reference. It also had an
 * idempotency bug: the guard compared an unquoted name against node-xcode's
 * quoted storage, so a re-run added a second target.
 *
 * This harness runs the REAL plugin mutation (`applyBroadcastExtensionTarget`)
 * against a committed app-style pbxproj fixture, offline — Windows cannot
 * `expo prebuild -p ios`, so the pbxproj plumbing is proven here before EAS.
 * It asserts: exactly one extension target, idempotency, product embedded in
 * PlugIns, correct build settings, source membership, and — the load-bearing
 * invariant — ZERO dangling references anywhere in the emitted project.
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
const REPO_ROOT = resolve(HERE, "../../..");
const FIXTURE = resolve(HERE, "fixtures/base-app.pbxproj");

const EXT_NAME = "ProovraBroadcast";
const MAIN_BUNDLE_ID = "com.jalalattar29.proovra";
const EXT_BUNDLE_ID = `${MAIN_BUNDLE_ID}.broadcast`;

// Resolve node-xcode from the pnpm store (not hoisted into apps/mobile).
function resolveXcode() {
  try {
    return require("xcode");
  } catch {
    const pnpmDir = join(REPO_ROOT, "node_modules", ".pnpm");
    const entry = readdirSync(pnpmDir).find((d) => /^xcode@/.test(d));
    assert.ok(entry, "node-xcode must be installed in the pnpm store");
    return require(join(pnpmDir, entry, "node_modules", "xcode"));
  }
}

const xcode = resolveXcode();
const { applyBroadcastExtensionTarget } = require(
  resolve(HERE, "../plugins/withProovraIosScreenBroadcast.cjs"),
);

function freshFixtureProject() {
  // node-xcode mutates the file path in place on writeSync, so copy to a temp
  // file per test to keep the committed fixture pristine.
  const dir = mkdtempSync(join(tmpdir(), "pbxproj-"));
  const p = join(dir, "project.pbxproj");
  writeFileSync(p, readFileSync(FIXTURE, "utf8"));
  const proj = xcode.project(p);
  proj.parseSync();
  return proj;
}

function nonComment(section) {
  const out = {};
  for (const k of Object.keys(section || {})) {
    if (!k.endsWith("_comment")) out[k] = section[k];
  }
  return out;
}

// Re-serialize then re-parse, so every assertion runs against the ACTUAL text
// Xcode would read — a dangling ref that survives round-trip is a real defect.
function roundTrip(proj) {
  const dir = mkdtempSync(join(tmpdir(), "pbxproj-rt-"));
  const p = join(dir, "project.pbxproj");
  writeFileSync(p, proj.writeSync());
  const p2 = xcode.project(p);
  p2.parseSync();
  return p2;
}

test("fixture parses with no pre-existing extension target", () => {
  const proj = freshFixtureProject();
  const targets = nonComment(proj.pbxNativeTargetSection());
  assert.ok(Object.keys(targets).length >= 1, "fixture must have at least one target");
  const preExt = Object.values(targets).filter(
    (t) => String(t.name).replace(/"/g, "") === EXT_NAME,
  );
  assert.equal(preExt.length, 0, "fixture must not already contain the extension target");
});

test("applying the plugin adds exactly one ProovraBroadcast app-extension target", () => {
  const proj = freshFixtureProject();
  const baseline = Object.keys(nonComment(proj.pbxNativeTargetSection())).length;
  const r = applyBroadcastExtensionTarget(proj, { mainBundleId: MAIN_BUNDLE_ID });
  assert.equal(r.added, true);
  const after = roundTrip(proj);
  const targets = nonComment(after.pbxNativeTargetSection());
  assert.equal(Object.keys(targets).length, baseline + 1, "exactly one target added");
  const extTargets = Object.values(targets).filter(
    (t) => String(t.name).replace(/"/g, "") === EXT_NAME,
  );
  assert.equal(extTargets.length, 1, "exactly one extension target");
  assert.equal(
    String(extTargets[0].productType).replace(/"/g, ""),
    "com.apple.product-type.app-extension",
  );
});

test("the plugin is idempotent — a second apply adds no second target", () => {
  const proj = freshFixtureProject();
  assert.equal(applyBroadcastExtensionTarget(proj, { mainBundleId: MAIN_BUNDLE_ID }).added, true);
  assert.equal(
    applyBroadcastExtensionTarget(proj, { mainBundleId: MAIN_BUNDLE_ID }).added,
    false,
    "second apply must be a no-op",
  );
  const after = roundTrip(proj);
  const targets = nonComment(after.pbxNativeTargetSection());
  const extTargets = Object.values(targets).filter(
    (t) => String(t.name).replace(/"/g, "") === EXT_NAME,
  );
  assert.equal(extTargets.length, 1, "still exactly one extension target after re-apply");
});

test("the .appex product is embedded in the main app via a PlugIns copy-files phase", () => {
  const proj = freshFixtureProject();
  applyBroadcastExtensionTarget(proj, { mainBundleId: MAIN_BUNDLE_ID });
  const after = roundTrip(proj);

  const copyPhases = nonComment(after.hash.project.objects.PBXCopyFilesBuildPhase);
  // dstSubfolderSpec 13 == PlugIns (Xcode's "Embed App Extensions").
  const pluginsPhases = Object.values(copyPhases).filter(
    (ph) => String(ph.dstSubfolderSpec) === "13",
  );
  assert.ok(pluginsPhases.length >= 1, "a PlugIns (spec 13) copy-files phase must exist");

  const buildFiles = nonComment(after.hash.project.objects.PBXBuildFile);
  const fileRefs = after.hash.project.objects.PBXFileReference;
  // Count every embed entry for the .appex across ALL copy-files phases. The
  // original defect double-embedded it (addTarget auto-embeds, then a manual
  // embed added a second) — Xcode then fails with "multiple commands produce".
  let appexEmbedCount = 0;
  for (const ph of Object.values(copyPhases)) {
    for (const f of ph.files || []) {
      const bf = buildFiles[f.value];
      const ref = bf && fileRefs[bf.fileRef];
      const p = ref ? String(ref.path || ref.name || "") : String(f.comment || "");
      if (/ProovraBroadcast\.appex/.test(p) || /ProovraBroadcast\.appex/.test(String(f.comment || ""))) {
        appexEmbedCount += 1;
      }
    }
  }
  assert.equal(appexEmbedCount, 1, "the .appex must be embedded EXACTLY once (no double-embed)");
});

test("SampleHandler.swift is compiled in the extension's Sources phase", () => {
  const proj = freshFixtureProject();
  applyBroadcastExtensionTarget(proj, { mainBundleId: MAIN_BUNDLE_ID });
  const after = roundTrip(proj);

  const targets = nonComment(after.pbxNativeTargetSection());
  const ext = Object.values(targets).find(
    (t) => String(t.name).replace(/"/g, "") === EXT_NAME,
  );
  const sourcesPhaseRef = ext.buildPhases.find((b) => /Sources/.test(String(b.comment)));
  assert.ok(sourcesPhaseRef, "extension has a Sources build phase");
  const sources = after.hash.project.objects.PBXSourcesBuildPhase[sourcesPhaseRef.value];
  const buildFiles = nonComment(after.hash.project.objects.PBXBuildFile);
  const fileRefs = after.hash.project.objects.PBXFileReference;
  const compiles = (sources.files || []).some((f) => {
    const bf = buildFiles[f.value];
    const ref = bf && fileRefs[bf.fileRef];
    const p = ref ? String(ref.path || ref.name || "") : String(f.comment || "");
    return /SampleHandler\.swift/.test(p) || /SampleHandler\.swift/.test(String(f.comment || ""));
  });
  assert.ok(compiles, "SampleHandler.swift must be in the extension Sources phase");
});

test("the extension's build settings carry the broadcast bundle id, deployment target, Info.plist and entitlements", () => {
  const proj = freshFixtureProject();
  applyBroadcastExtensionTarget(proj, { mainBundleId: MAIN_BUNDLE_ID });
  const after = roundTrip(proj);

  const configs = nonComment(after.pbxXCBuildConfigurationSection());
  const extConfigs = Object.values(configs).filter(
    (c) => c.buildSettings && String(c.buildSettings.PRODUCT_NAME).replace(/"/g, "") === EXT_NAME,
  );
  assert.equal(extConfigs.length, 2, "extension has Debug + Release configs");
  for (const c of extConfigs) {
    const bs = c.buildSettings;
    assert.equal(String(bs.PRODUCT_BUNDLE_IDENTIFIER).replace(/"/g, ""), EXT_BUNDLE_ID);
    assert.equal(String(bs.IPHONEOS_DEPLOYMENT_TARGET).replace(/"/g, ""), "13.4");
    assert.match(String(bs.INFOPLIST_FILE), /ProovraBroadcast\/Info\.plist/);
    assert.match(String(bs.CODE_SIGN_ENTITLEMENTS), /ProovraBroadcast\/ProovraBroadcast\.entitlements/);
  }
});

test("the main app declares a target dependency on the extension", () => {
  const proj = freshFixtureProject();
  applyBroadcastExtensionTarget(proj, { mainBundleId: MAIN_BUNDLE_ID });
  const after = roundTrip(proj);
  const mainTarget = after.pbxNativeTargetSection()[after.getFirstTarget().uuid];
  assert.ok(
    Array.isArray(mainTarget.dependencies) && mainTarget.dependencies.length >= 1,
    "main app must depend on the extension",
  );
  // The dependency must resolve to the extension target through the proxy.
  const deps = nonComment(after.hash.project.objects.PBXTargetDependency);
  const targets = nonComment(after.pbxNativeTargetSection());
  const extUuid = Object.keys(targets).find(
    (k) => String(targets[k].name).replace(/"/g, "") === EXT_NAME,
  );
  const pointsToExt = Object.values(deps).some((d) => d.target === extUuid);
  assert.ok(pointsToExt, "the target dependency must reference the extension target");
});

test("ZERO dangling references: every build-file fileRef and every phase entry resolves", () => {
  const proj = freshFixtureProject();
  applyBroadcastExtensionTarget(proj, { mainBundleId: MAIN_BUNDLE_ID });
  const after = roundTrip(proj);
  const objects = after.hash.project.objects;

  const buildFiles = nonComment(objects.PBXBuildFile);
  const fileRefs = objects.PBXFileReference || {};
  const groups = objects.PBXGroup || {};
  const variantGroups = objects.PBXVariantGroup || {};

  // (1) Every PBXBuildFile.fileRef must resolve to a real referenceable object.
  for (const [uuid, bf] of Object.entries(buildFiles)) {
    const ref = bf.fileRef;
    const exists = fileRefs[ref] || groups[ref] || variantGroups[ref];
    assert.ok(exists, `PBXBuildFile ${uuid} has dangling fileRef ${ref}`);
  }

  // (2) Every entry in every build phase's files[] must resolve to a PBXBuildFile.
  const phaseSections = [
    "PBXSourcesBuildPhase",
    "PBXResourcesBuildPhase",
    "PBXFrameworksBuildPhase",
    "PBXCopyFilesBuildPhase",
  ];
  for (const section of phaseSections) {
    const phases = nonComment(objects[section]);
    for (const [phaseUuid, phase] of Object.entries(phases)) {
      for (const f of phase.files || []) {
        assert.ok(
          buildFiles[f.value],
          `${section} ${phaseUuid} references missing build file ${f.value} (${f.comment})`,
        );
      }
    }
  }

  // (3) Every native target's buildPhases must point at an existing phase object.
  const targets = nonComment(objects.PBXNativeTarget);
  for (const [tUuid, t] of Object.entries(targets)) {
    for (const bp of t.buildPhases || []) {
      const found = phaseSections.some((s) => objects[s] && objects[s][bp.value]);
      assert.ok(found, `target ${tUuid} references missing build phase ${bp.value} (${bp.comment})`);
    }
  }
});
