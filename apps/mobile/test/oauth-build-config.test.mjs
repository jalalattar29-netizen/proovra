/**
 * GUARD — GOOGLE SIGN-IN IS CONFIGURED IN THE THINGS THAT BUILD THE BINARY.
 *
 * Replaces the assertion in `oauth-config.test.mjs` that Google worked because
 * the STRINGS `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` etc. appeared in the source of
 * use-oauth.ts. They did — and all three were `undefined` in every EAS build,
 * because they existed only in a gitignored `.env.local` and in no build
 * profile. `EXPO_PUBLIC_*` is inlined at bundle time, so `Google.useAuthRequest`
 * returned a null request and `promptGoogle` short-circuited to
 * OAUTH_GOOGLE_UNCONFIGURED on the device. The test could not see it because it
 * was reading source, not configuration.
 *
 * This reads the actual build inputs — eas.json and app.json — and checks the
 * two things that decide whether the ceremony can complete:
 *   1. every build profile carries all three platform client ids;
 *   2. iOS registers the reversed-client-id URL scheme, DERIVED from the
 *      configured iOS client id, so the OAuth redirect can return to the app.
 *      Without it the browser opens and never comes back, whatever the env says.
 *
 * Client ids are public identifiers that ship inside the binary regardless, not
 * secrets. Nothing here asserts a secret value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const MOBILE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const eas = JSON.parse(readFileSync(resolve(MOBILE_ROOT, "eas.json"), "utf8"));
const app = JSON.parse(readFileSync(resolve(MOBILE_ROOT, "app.json"), "utf8")).expo;

const REQUIRED_ENV = [
  "EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID",
  "EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID",
  "EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID",
  "EXPO_PUBLIC_API_BASE",
];

const GOOGLE_CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

test("every EAS build profile carries the values the bundle inlines", () => {
  const profiles = Object.keys(eas.build ?? {});
  assert.ok(profiles.length >= 1, "eas.json declares no build profiles");
  for (const name of profiles) {
    const env = eas.build[name].env ?? {};
    for (const key of REQUIRED_ENV) {
      assert.ok(
        typeof env[key] === "string" && env[key].length > 0,
        `build profile "${name}" would produce a binary with ${key} undefined`,
      );
    }
  }
});

test("the configured Google client ids are well-formed", () => {
  for (const name of Object.keys(eas.build ?? {})) {
    const env = eas.build[name].env ?? {};
    for (const key of REQUIRED_ENV.filter((k) => k.includes("GOOGLE"))) {
      assert.match(env[key], GOOGLE_CLIENT_ID, `${name}.${key} is not a Google client id`);
    }
  }
});

test("iOS registers the reversed-client-id scheme DERIVED from the iOS client id", () => {
  const iosClientId = eas.build.production.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  const expected = `com.googleusercontent.apps.${iosClientId.replace(/\.apps\.googleusercontent\.com$/, "")}`;

  const urlTypes = app.ios?.infoPlist?.CFBundleURLTypes ?? [];
  const schemes = urlTypes.flatMap((t) => t.CFBundleURLSchemes ?? []);
  assert.ok(
    schemes.includes(expected),
    `iOS must register ${expected} or the Google redirect cannot return to the app; found: ${JSON.stringify(schemes)}`,
  );
});

test("the app's own scheme survives alongside the OAuth scheme", () => {
  // Adding CFBundleURLTypes by hand REPLACES what Expo would have generated
  // from `scheme`, so dropping it here would silently break every proovra://
  // deep link — including the credential links.
  const schemes = (app.ios?.infoPlist?.CFBundleURLTypes ?? []).flatMap(
    (t) => t.CFBundleURLSchemes ?? [],
  );
  assert.ok(app.scheme, "app.json declares no scheme");
  assert.ok(schemes.includes(app.scheme), `iOS must still register "${app.scheme}"`);
});

test("Apple Sign In stays declared (the entitlement Expo generates from it)", () => {
  assert.equal(app.ios?.usesAppleSignIn, true);
  assert.ok(
    (app.plugins ?? []).includes("expo-apple-authentication"),
    "expo-apple-authentication must be declared or the native module is not linked",
  );
});

test("the native audiences the server must accept are the ids configured here", () => {
  // Documents the server-side half so the two cannot drift silently: the API's
  // GOOGLE_CLIENT_IDS / APPLE_CLIENT_IDS allowlists must contain these values
  // and the iOS bundle id, or a valid native token is refused on `aud`.
  const env = eas.build.production.env;
  assert.match(env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID, GOOGLE_CLIENT_ID);
  assert.match(env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID, GOOGLE_CLIENT_ID);
  assert.equal(app.ios.bundleIdentifier, "com.jalalattar29.proovra");
});
