/**
 * B6-F-64 / closure phase 2 — the per-profile build configuration, resolved
 * from eas.json + app.json + package.json, and printed without secrets.
 *
 * Asserts the facts the release record depends on: preview is the ONLY
 * internal profile that may sell (EXTERNAL_CHECKOUT), production is a store
 * build that cannot, the EAS worker hook is wired, a flagged store profile is
 * refused while the same flags on preview are allowed, and the CLI output
 * never carries a client id, DSN or tile URL value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readProfileInputs, resolveAllProfiles, resolveProfile } from "../scripts/print-eas-profiles.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const inputs = readProfileInputs(MOBILE);

test("preview is the internal-distribution profile, and the only one that may sell", () => {
  const rows = resolveAllProfiles(inputs);
  const selling = rows.filter((r) => r.purchaseAvailability === "EXTERNAL_CHECKOUT").map((r) => r.profile);
  assert.deepEqual(selling, ["preview"]);
  const preview = resolveProfile(inputs, "preview");
  assert.equal(preview.distribution, "internal");
  assert.equal(preview.storeBuild, false);
  assert.equal(preview.env.EXPO_PUBLIC_API_BASE, "https://api.proovra.com");
  assert.equal(preview.b6f64.hookWired, true);
  assert.equal(preview.b6f64.verdictOnEasJsonEnv, "allowed");
});

test("production is a store build with auto-increment and remote versioning that cannot sell", () => {
  const prod = resolveProfile(inputs, "production");
  assert.equal(prod.distribution, "store");
  assert.equal(prod.storeBuild, true);
  assert.equal(prod.autoIncrement, true);
  assert.equal(prod.appVersionSource, "remote");
  assert.equal(prod.purchaseAvailability, "NOT_IN_THIS_BUILD");
  assert.equal(prod.env.EXPO_PUBLIC_DISTRIBUTION, "unset");
  assert.equal(prod.env.EXPO_PUBLIC_PRIVATE_BILLING, "unset");
  assert.equal(prod.b6f64.verdictOnEasJsonEnv, "allowed");
});

test("refused: a store profile whose environment carries a private-distribution flag (eas.json or dashboard overlay)", () => {
  const flagged = structuredClone(inputs);
  flagged.eas.build.production.env.EXPO_PUBLIC_PRIVATE_BILLING = "enabled";
  const viaEasJson = resolveProfile(flagged, "production");
  assert.equal(viaEasJson.b6f64.verdictOnEasJsonEnv, "refused");
  assert.match(viaEasJson.b6f64.problems.join("\n"), /EXPO_PUBLIC_PRIVATE_BILLING/);

  const viaOverlay = resolveProfile(inputs, "production", { EXPO_PUBLIC_DISTRIBUTION: "PRIVATE", EXPO_PUBLIC_PRIVATE_BILLING: "enabled", UNRELATED: "x" });
  assert.equal(viaOverlay.b6f64.verdictOnEasJsonEnv, "refused");
  assert.equal(viaOverlay.purchaseAvailability, "EXTERNAL_CHECKOUT", "the overlay shows what the bundle would have done");
  assert.equal("UNRELATED" in viaOverlay.env, false, "only the two flag names are taken from the process env");
  // The same flags on the internal profile are its purpose.
  assert.equal(resolveProfile(inputs, "preview", { EXPO_PUBLIC_PRIVATE_BILLING: "enabled" }).b6f64.verdictOnEasJsonEnv, "allowed");
});

test("refused: an unwired hook is reported", () => {
  const unwired = structuredClone(inputs);
  unwired.pkg.scripts["eas-build-post-install"] = "pnpm run build:deps";
  assert.equal(resolveProfile(unwired, "production").b6f64.hookWired, false);
});

test("extends is resolved parent-first with the child's env winning", () => {
  const ext = structuredClone(inputs);
  ext.eas.build.child = { extends: "preview", env: { EXPO_PUBLIC_API_BASE: "http://10.0.2.2:8081" } };
  const child = resolveProfile(ext, "child");
  assert.equal(child.distribution, "internal");
  assert.equal(child.env.EXPO_PUBLIC_API_BASE, "http://10.0.2.2:8081");
  assert.equal(child.env.EXPO_PUBLIC_PRIVATE_BILLING, "enabled");
  assert.equal(resolveProfile(ext, "missing"), null);
});

test("the CLI prints no client id, DSN or tile URL value", () => {
  const withSecrets = structuredClone(inputs);
  const out = execFileSync(process.execPath, [resolve(MOBILE, "scripts/print-eas-profiles.mjs"), "--json"], { cwd: MOBILE, encoding: "utf8" });
  const rows = JSON.parse(out);
  assert.equal(rows.length, Object.keys(withSecrets.eas.build).length);
  for (const profile of Object.values(withSecrets.eas.build)) {
    for (const [k, v] of Object.entries(profile.env ?? {})) {
      if (/CLIENT_ID|DSN|TILE_URL/.test(k)) assert.ok(!out.includes(v), `${k} value printed`);
    }
  }
  assert.ok(rows.every((r) => r.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID === "set"));
});
