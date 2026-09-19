/**
 * PERMANENT GUARD — native OAuth repository wiring (A1/A2).
 *
 * Google must use PLATFORM-SPECIFIC client ids and NOT a single generic clientId
 * with a custom proovra:// redirect (the defect). Apple must be declared in
 * app.json (usesAppleSignIn + plugin) and rendered iOS-only. Config + source text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const oauth = readFileSync(resolve(MOBILE, "src/auth/use-oauth.ts"), "utf8");
const { expo } = JSON.parse(readFileSync(resolve(MOBILE, "app.json"), "utf8"));

test("Google uses platform-specific client ids", () => {
  assert.match(oauth, /EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID/);
  assert.match(oauth, /EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID/);
  assert.match(oauth, /EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID/);
  assert.match(oauth, /iosClientId/);
  assert.match(oauth, /androidClientId/);
  assert.match(oauth, /webClientId/);
});

test("the old generic-clientId + proovra:// redirect defect is gone", () => {
  assert.doesNotMatch(oauth, /EXPO_PUBLIC_GOOGLE_CLIENT_ID\b/, "generic single client id must be removed");
  assert.doesNotMatch(oauth, /makeRedirectUri\(\s*\{\s*scheme:\s*["']proovra["']/, "no custom proovra:// redirect for Google");
});

test("Apple sign-in is declared in app.json (iOS)", () => {
  assert.equal(expo.ios?.usesAppleSignIn, true);
  assert.ok(
    (expo.plugins ?? []).includes("expo-apple-authentication"),
    "expo-apple-authentication plugin must be declared",
  );
});

test("Apple is gated on native availability (never faked on Android)", () => {
  assert.match(oauth, /isAvailableAsync/, "Apple button must gate on isAvailableAsync (iOS)");
});
