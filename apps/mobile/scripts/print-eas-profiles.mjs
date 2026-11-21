#!/usr/bin/env node
/**
 * B6-F-64 / closure phase 2 — PRINT THE RESOLVED BUILD CONFIGURATION PER EAS
 * PROFILE, WITHOUT SECRETS.
 *
 *   node scripts/print-eas-profiles.mjs                 # every profile, table
 *   node scripts/print-eas-profiles.mjs --json          # machine-readable
 *   node scripts/print-eas-profiles.mjs --profile preview
 *
 * What it resolves, from the repository alone (apps/mobile/eas.json,
 * app.json, package.json — there is no app.config.*):
 *   - distribution (store unless eas.json says internal), development client,
 *     simulator, auto-increment, the version source and app version;
 *   - the EXPO_PUBLIC_* values Metro inlines into the bundle for that profile:
 *     the origins and the two private-distribution flags in clear, everything
 *     else only as "set" / "unset" (the tile URL carries a provider key; the
 *     Google client ids and the Sentry DSN are published but not repeated);
 *   - what the build may sell (`purchaseAvailability()` — the same predicate
 *     as src/product/billing-purchase.ts);
 *   - the B6-F-64 verdict the EAS worker's `eas-build-post-install` hook
 *     (`validate-mobile-release.mjs --eas-build-env`) gives this profile's
 *     eas.json environment, and whether the hook is wired.
 *
 * What it CANNOT resolve: the EAS-dashboard environment variables that EAS
 * merges into the worker environment (`eas env:list --environment <env>`,
 * owner's Expo login). The hook judges those on the worker itself; this
 * script says so instead of guessing. `--overlay-env` adds the CURRENT
 * process's private-distribution flags (only those two names), so an operator
 * who exported the dashboard values can see the verdict locally.
 *
 * Read-only. No network. Prints no secret.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { easBuildEnvProblems, pickPrivateFlags } from "./validate-mobile-release.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");

/** Printed in clear: origins and switches, never a credential. */
const CLEAR_KEYS = new Set([
  "EXPO_PUBLIC_API_BASE",
  "EXPO_PUBLIC_WEB_BASE",
  "EXPO_PUBLIC_DISTRIBUTION",
  "EXPO_PUBLIC_PRIVATE_BILLING",
  "EXPO_PUBLIC_ENV",
  "EXPO_PUBLIC_RELEASE",
  "EXPO_USE_WORKSPACE_ROOT",
  "SENTRY_DISABLE_AUTO_UPLOAD",
]);
/** Read by the app (src/, app/) — reported as set/unset even when a profile omits them. */
export const APP_ENV_KEYS = [
  "EXPO_PUBLIC_API_BASE",
  "EXPO_PUBLIC_WEB_BASE",
  "EXPO_PUBLIC_DISTRIBUTION",
  "EXPO_PUBLIC_PRIVATE_BILLING",
  "EXPO_PUBLIC_ENV",
  "EXPO_PUBLIC_RELEASE",
  "EXPO_PUBLIC_SENTRY_DSN",
  "EXPO_PUBLIC_CAPTURE_LOCATION_TILE_URL",
  "EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID",
  "EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID",
  "EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID",
];

export function readProfileInputs(mobileRoot = MOBILE) {
  const read = (rel) => JSON.parse(readFileSync(resolve(mobileRoot, rel), "utf8"));
  return { eas: read("eas.json"), appJson: read("app.json"), pkg: read("package.json") };
}

/** eas.json `extends`, resolved the way EAS does (parent first, child wins; env merged). */
function flatten(eas, name, seen = new Set()) {
  const own = eas?.build?.[name];
  if (!own) return null;
  if (seen.has(name)) throw new Error(`eas.json build profile "${name}" extends itself`);
  seen.add(name);
  const parent = own.extends ? flatten(eas, own.extends, seen) : null;
  if (!parent) return own;
  return {
    ...parent,
    ...own,
    env: { ...(parent.env ?? {}), ...(own.env ?? {}) },
    android: { ...(parent.android ?? {}), ...(own.android ?? {}) },
    ios: { ...(parent.ios ?? {}), ...(own.ios ?? {}) },
  };
}

function shown(key, value) {
  if (value === undefined || value === null || value === "") return "unset";
  return CLEAR_KEYS.has(key) ? String(value) : "set";
}

/** PURE — one profile's resolved configuration, secrets reduced to set/unset. */
export function resolveProfile(inputs, name, overlayEnv = {}) {
  const { eas, appJson, pkg } = inputs;
  const p = flatten(eas, name);
  if (!p) return null;
  const env = { ...(p.env ?? {}), ...pickPrivateFlags(overlayEnv) };
  const distribution = p.distribution ?? "store";
  const checkout =
    env.EXPO_PUBLIC_DISTRIBUTION === "PRIVATE" && env.EXPO_PUBLIC_PRIVATE_BILLING === "enabled"
      ? "EXTERNAL_CHECKOUT"
      : "NOT_IN_THIS_BUILD";
  const hookProblems = easBuildEnvProblems(eas, { ...env, EAS_BUILD_PROFILE: name });
  const hook = pkg?.scripts?.["eas-build-post-install"] ?? "";
  const keys = [...new Set([...APP_ENV_KEYS, ...Object.keys(env)])];
  return {
    profile: name,
    distribution,
    storeBuild: distribution !== "internal",
    developmentClient: p.developmentClient === true,
    iosSimulator: p.ios?.simulator === true,
    androidBuildType: p.android?.buildType ?? "unset (EAS default)",
    iosBuildConfiguration: p.ios?.buildConfiguration ?? (p.developmentClient ? "Debug (dev client default)" : "Release (EAS default)"),
    autoIncrement: p.autoIncrement === true,
    node: p.node ?? "unset",
    appVersionSource: eas?.cli?.appVersionSource ?? "local",
    appVersion: appJson?.expo?.version ?? null,
    runtimeVersionPolicy: appJson?.expo?.runtimeVersion?.policy ?? null,
    // With remote versioning, EAS owns versionCode / buildNumber; app.json's are ignored.
    nativeBuildNumber:
      eas?.cli?.appVersionSource === "remote"
        ? "remote (EAS servers; eas build:version:get, owner's Expo login)"
        : { iosBuildNumber: appJson?.expo?.ios?.buildNumber ?? null, androidVersionCode: appJson?.expo?.android?.versionCode ?? null },
    env: Object.fromEntries(keys.map((k) => [k, shown(k, env[k])])),
    purchaseAvailability: checkout,
    b6f64: {
      hookWired: /validate-mobile-release\.mjs --eas-build-env/.test(hook),
      verdictOnEasJsonEnv: hookProblems.length === 0 ? "allowed" : "refused",
      problems: hookProblems,
      dashboardEnv: "not readable here (eas env:list, owner's Expo login); judged on the worker by the hook",
    },
    otaChannel: p.channel ?? null,
  };
}

export function resolveAllProfiles(inputs, overlayEnv = {}) {
  return Object.keys(inputs.eas?.build ?? {}).map((n) => resolveProfile(inputs, n, overlayEnv));
}

function printTable(rows) {
  for (const r of rows) {
    console.log(`\n== ${r.profile} ==`);
    console.log(`  distribution        ${r.distribution}${r.storeBuild ? " (store build)" : " (internal)"}`);
    console.log(`  development client  ${r.developmentClient}   ios simulator ${r.iosSimulator}`);
    console.log(`  android buildType   ${r.androidBuildType}`);
    console.log(`  ios configuration   ${r.iosBuildConfiguration}`);
    console.log(`  version             ${r.appVersion} (source ${r.appVersionSource}; autoIncrement ${r.autoIncrement}; runtime ${r.runtimeVersionPolicy})`);
    console.log(`  build number        ${typeof r.nativeBuildNumber === "string" ? r.nativeBuildNumber : JSON.stringify(r.nativeBuildNumber)}`);
    console.log(`  OTA channel         ${r.otaChannel ?? "none (no expo-updates)"}`);
    for (const [k, v] of Object.entries(r.env)) console.log(`  ${k.padEnd(38)} ${v}`);
    console.log(`  purchase            ${r.purchaseAvailability}`);
    console.log(`  B6-F-64 hook        wired=${r.b6f64.hookWired} verdict(eas.json env)=${r.b6f64.verdictOnEasJsonEnv}`);
    for (const p of r.b6f64.problems) console.log(`    - ${p}`);
    console.log(`  dashboard env       ${r.b6f64.dashboardEnv}`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const inputs = readProfileInputs();
  const overlay = args.includes("--overlay-env") ? process.env : {};
  const pi = args.indexOf("--profile");
  const rows = pi >= 0 ? [resolveProfile(inputs, args[pi + 1], overlay)].filter(Boolean) : resolveAllProfiles(inputs, overlay);
  if (rows.length === 0) {
    console.error(`no such EAS build profile: ${args[pi + 1]}`);
    process.exit(2);
  }
  if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else printTable(rows);
}
