/**
 * AUD-009 — the mobile release pipeline and its configuration.
 *
 * RED on the pre-remediation tree: a second, drifted eas.json at the repo root
 * (no env, no node pin, no ios-simulator profile); the extension Info.plist
 * hard-coded 1.0.0 / 1 under a host with remote auto-incremented build
 * numbers; no release workflow at all, and the native-build artifacts did not
 * say they were debug/simulator.
 *
 * Proven here: the release gate (scripts/validate-mobile-release.mjs) passes on
 * this tree and REFUSES each defect it exists for; mobile-release.yml is
 * manual-only, least-privilege, builds the production profile in the
 * mobile-release environment behind an explicit EXPO_TOKEN gate, and submits
 * only from the protected mobile-store-submission environment after an exact
 * confirmation; debug/simulator artifacts can never be named release.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const REPO_ROOT = resolve(MOBILE, "../..");

function resolveYaml() {
  const pnpmDir = join(REPO_ROOT, "node_modules", ".pnpm");
  const entry = readdirSync(pnpmDir).filter((d) => /^yaml@2\./.test(d)).sort().pop();
  assert.ok(entry, "the yaml package must be in the pnpm store");
  return require(join(pnpmDir, entry, "node_modules", "yaml"));
}
const YAML = resolveYaml();
const RELEASE_SRC = readFileSync(resolve(REPO_ROOT, ".github/workflows/mobile-release.yml"), "utf8");
const NATIVE_SRC = readFileSync(resolve(REPO_ROOT, ".github/workflows/native-build.yml"), "utf8");
const release = YAML.parse(RELEASE_SRC);
const native = YAML.parse(NATIVE_SRC);

let G;
before(async () => {
  G = await import("../scripts/validate-mobile-release.mjs");
});
const clone = (v) => JSON.parse(JSON.stringify(v));
const inputs = () => {
  const i = G.readReleaseInputs(MOBILE);
  return { ...i, eas: clone(i.eas), appJson: clone(i.appJson) };
};

/* ---------------------------------------------------------- the gate ---- */

test("AUD-009: this tree passes the release gate, and the only eas.json is apps/mobile's", () => {
  assert.deepEqual(G.validateMobileRelease(G.readReleaseInputs(MOBILE)), []);
  assert.equal(existsSync(resolve(REPO_ROOT, "eas.json")), false, "the drifted root eas.json is back");
  // EAS runs in the project directory (where app.json is): that eas.json is the live one.
  assert.ok(existsSync(resolve(MOBILE, "app.json")) && !existsSync(resolve(REPO_ROOT, "app.json")));
});

test("AUD-009: the gate refuses every non-store production profile", () => {
  const cases = [
    [(i) => (i.rootEasJsonExists = true), /second eas\.json/],
    [(i) => (i.eas.cli.appVersionSource = "local"), /appVersionSource/],
    [(i) => (i.eas.build.production.autoIncrement = false), /autoIncrement/],
    [(i) => (i.eas.build.production.developmentClient = true), /development client/],
    [(i) => (i.eas.build.production.distribution = "internal"), /distribution is "internal"/],
    [(i) => (i.eas.build.production.ios = { simulator: true }), /simulator/],
    [(i) => (i.eas.build.production.ios = { buildConfiguration: "Debug" }), /buildConfiguration is "Debug"/],
    [(i) => (i.eas.build.production.android = { buildType: "apk" }), /not app-bundle/],
    [(i) => (i.eas.build.production.android = { gradleCommand: ":app:assembleDebug" }), /builds Debug/],
    [(i) => (i.eas.build.production.extends = "preview"), /must not extend/],
    [(i) => (i.eas.build.production.env.EXPO_PUBLIC_DISTRIBUTION = "PRIVATE"), /private-distribution flag/],
    [(i) => delete i.eas.build.production, /no build\.production/],
    [(i) => delete i.eas.submit, /no submit\.production/],
  ];
  for (const [mutate, error] of cases) {
    const i = inputs();
    mutate(i);
    const problems = G.validateMobileRelease(i);
    assert.ok(problems.some((p) => error.test(p)), `${error} not reported: ${JSON.stringify(problems)}`);
  }
});

test("AUD-009: the gate refuses an extension version that is not the host's", () => {
  const legacy = inputs();
  legacy.extInfoPlist = legacy.extInfoPlist
    .replace("$(MARKETING_VERSION)", "1.0.0")
    .replace("$(CURRENT_PROJECT_VERSION)", "1");
  const problems = G.validateMobileRelease(legacy);
  assert.ok(problems.some((p) => /CFBundleShortVersionString/.test(p)));
  assert.ok(problems.some((p) => /CFBundleVersion/.test(p)));
  const unsynced = inputs();
  unsynced.pluginSource = unsynced.pluginSource.replace(/syncExtensionVersions\(cfg\.modResults/, "noop(cfg.modResults");
  assert.ok(G.validateMobileRelease(unsynced).some((p) => /does not sync/.test(p)));
});

test("AUD-009: the gate refuses App Group drift and a missing privacy manifest", () => {
  const cases = [
    [(i) => (i.extEntitlements = i.extEntitlements.replace("group.com.jalalattar29.proovra", "group.other")), /extension entitlements lack/],
    [(i) => (i.appJson.expo.extra.eas.build.experimental.ios.appExtensions[0].entitlements["com.apple.security.application-groups"] = ["group.other"]), /appExtensions App Groups differ/],
    [(i) => (i.sampleHandler = i.sampleHandler.replace('appGroup = "group.com.jalalattar29.proovra"', 'appGroup = "group.other"')), /SampleHandler\.swift uses App Group/],
    [(i) => (i.appJson.expo.extra.eas.build.experimental.ios.appExtensions = []), /does not declare the ProovraBroadcast extension/],
    [(i) => (i.extPrivacyManifestExists = false), /PrivacyInfo\.xcprivacy is missing/],
    [(i) => delete i.appJson.expo.ios.privacyManifests, /no expo\.ios\.privacyManifests/],
  ];
  for (const [mutate, error] of cases) {
    const i = inputs();
    mutate(i);
    assert.ok(G.validateMobileRelease(i).some((p) => error.test(p)), `${error} not reported`);
  }
});

/* ------------------------------------------------------ the workflow ---- */

test("AUD-009: mobile-release.yml is manual only — nothing triggers a build or a submission by itself", () => {
  assert.deepEqual(Object.keys(release.on), ["workflow_dispatch"]);
  const i = release.on.workflow_dispatch.inputs;
  assert.deepEqual(i.platform.options, ["ios", "android", "all"]);
  assert.equal(i.submit.type, "boolean");
  assert.equal(i.submit.default, false, "submission must be opt-in");
  assert.equal(release.concurrency["cancel-in-progress"], false);
});

test("AUD-009: least privilege — no default permissions, read-only contents per job, no write scopes", () => {
  assert.deepEqual(release.permissions, {});
  for (const [name, job] of Object.entries(release.jobs)) {
    assert.deepEqual(job.permissions, { contents: "read" }, `${name} asks for more than contents: read`);
  }
  assert.ok(!/pull_request_target|continue-on-error/.test(RELEASE_SRC));
});

test("AUD-009: the build job builds the PRODUCTION profile in the mobile-release environment behind an explicit EXPO_TOKEN gate", () => {
  const build = release.jobs.build;
  assert.equal(build.environment, "mobile-release");
  assert.equal(build.needs, "validate");
  const steps = build.steps;
  const gate = steps.findIndex((s) => /Require the Expo credential/.test(s.name ?? ""));
  const eas = steps.findIndex((s) => /eas-cli@\$\{EAS_CLI_VERSION\}" build/.test(s.run ?? ""));
  assert.ok(gate === 0, "the credential gate must be the job's first step");
  assert.ok(eas > gate);
  assert.equal(steps[gate].env.EXPO_TOKEN, "${{ secrets.EXPO_TOKEN }}");
  assert.match(steps[gate].run, /if \[ -z "\$EXPO_TOKEN" \]; then[\s\S]*::error::EXPO_TOKEN is not set[\s\S]*exit 1/);
  assert.match(steps[eas].run, /build --profile production --platform "\$PLATFORM" \\\s*--non-interactive/);
  assert.match(steps[eas].run, /\.\[0\]\.distribution == "STORE"/, "the built artifact is not checked to be a store build");
  assert.equal(steps[eas].env.EXPO_TOKEN, "${{ secrets.EXPO_TOKEN }}");
  // No fabricated credential anywhere: every token comes from secrets.
  const tokenValues = [...RELEASE_SRC.matchAll(/^\s*EXPO_TOKEN:[ \t]*(.*)$/gm)].map((m) => m[1].trim());
  assert.ok(tokenValues.length >= 3);
  for (const v of tokenValues) assert.equal(v, "${{ secrets.EXPO_TOKEN }}");
  // The gate runs before any build.
  assert.match(release.jobs.validate.steps.map((s) => s.run ?? "").join("\n"), /node scripts\/validate-mobile-release\.mjs/);
});

test("AUD-009: submission is a separate, protected, explicitly confirmed job — never automatic", () => {
  const submit = release.jobs.submit;
  assert.equal(submit.environment, "mobile-store-submission");
  assert.deepEqual(submit.needs, ["validate", "build"]);
  assert.equal(submit.if, "${{ inputs.submit == true }}");
  const runs = submit.steps.map((s) => s.run ?? "").join("\n");
  assert.match(runs, /if \[ "\$CONFIRM" != "SUBMIT \$PLATFORM_INPUT \$VERSION" \]; then[\s\S]*?exit 1/);
  assert.match(runs, /missing in the mobile-store-submission environment:\$missing[\s\S]*?exit 1/);
  assert.match(runs, /submit --profile production --platform "\$PLATFORM" \\\s*--id "\$build_id" --non-interactive/);
  // The confirmation is also checked before anything is built.
  assert.match(release.jobs.validate.steps.map((s) => s.run ?? "").join("\n"), /"\$SUBMIT" = "true" \] && \[ "\$CONFIRM" != "SUBMIT \$PLATFORM \$version" \]/);
  // `eas submit` appears only in the protected job, and `eas build` never auto-submits.
  for (const [name, job] of Object.entries(release.jobs)) {
    const text = job.steps.map((s) => s.run ?? "").join("\n");
    if (name !== "submit") assert.ok(!/\bsubmit --profile/.test(text), `${name} submits`);
    assert.ok(!/--auto-submit/.test(text), `${name} auto-submits`);
  }
  // Store identifiers come from the environment, never from committed eas.json values.
  const eas = JSON.parse(readFileSync(resolve(MOBILE, "eas.json"), "utf8"));
  assert.deepEqual(eas.submit.production, {}, "eas.json must not carry store identifiers or key paths");
});

test("AUD-009: debug / simulator artifacts can never be called release", () => {
  const artifactNames = (wf) =>
    Object.values(wf.jobs).flatMap((j) => j.steps.filter((s) => /upload-artifact/.test(s.uses ?? "")).map((s) => s.with.name));
  const nativeArtifacts = artifactNames(native);
  assert.ok(nativeArtifacts.length >= 1);
  for (const name of nativeArtifacts) {
    assert.match(name, /debug/, `${name} does not say it is a debug build`);
    assert.ok(!/release|store|production/i.test(name), `${name} could be mistaken for a release`);
  }
  assert.match(nativeArtifacts.join(" "), /simulator/);
  for (const name of artifactNames(release)) assert.match(name, /^store-release-\$\{\{ matrix\.platform \}\}-/);
  // native-build never builds a release configuration or talks to EAS.
  assert.ok(!/-configuration Release|eas-cli|EXPO_TOKEN/.test(NATIVE_SRC));
});
