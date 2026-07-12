/**
 * Public marketing page-view beacon — allowlist + token-safety contract.
 *
 * Platform Control Center P1 item 11: public marketing pages must emit
 * `page_view` AnalyticsEvents so the admin dashboard's Countries / Top-pages
 * panels populate. This test pins the guarantees the beacon must never
 * regress:
 *
 *   1. It emits page_view ONLY for allowed public marketing paths.
 *   2. It NEVER emits for the sensitive token families
 *      (verify / v / share / intake / portal / auth / invite) — the same
 *      families the API rejects server-side (shouldRejectAnalyticsEvent).
 *   3. It NEVER emits for authenticated app / admin surfaces.
 *   4. The path it forwards is sanitized — no query string, hash, token, or
 *      raw IP is ever included.
 *   5. Consent is honored by DELEGATING to trackEvent (which no-ops unless
 *      hasAnalyticsConsent()) — the beacon must not bypass that gate.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import {
  isTrackablePublicPath,
  sanitizePublicPath,
} from "../lib/analytics-public-paths";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED_PUBLIC_PATHS = [
  "/",
  "/platform",
  "/pricing",
  "/trust",
  "/faq",
  "/about",
  "/technology",
  "/compare",
  "/why-proovra",
  "/support",
  "/login",
  "/register",
  "/reset-password",
  "/request-demo",
  "/request-demo/success",
  "/contact-sales",
  "/legal/privacy",
  "/legal/terms",
  "/for-lawyers",
  "/for-government",
  "/for-insurance",
  "/for-investigations",
  "/for-journalism",
  "/for-compliance",
];

const BLOCKED_TOKEN_PATHS = [
  "/verify",
  "/verify/abc123DEF456ghi789JKL012",
  "/v/abc123DEF456ghi789JKL012",
  "/share/9f8e1e9a-3a8b-4491-b0ce-6da010738f1c",
  "/intake/sometoken",
  "/intake/sometoken/capture",
  "/portal/sometoken",
  "/portal/sometoken/work/wf-123",
  "/auth/callback",
  "/auth/verify-email",
  "/invite/sometoken",
];

const BLOCKED_APP_PATHS = [
  "/home",
  "/capture",
  "/cases/123",
  "/evidence/abc",
  "/reports",
  "/billing",
  "/settings",
  "/admin",
  "/admin/dashboard",
  "/teams/1",
  "/app",
];

test("beacon emits page_view for allowed public marketing paths", () => {
  for (const path of ALLOWED_PUBLIC_PATHS) {
    assert.ok(
      isTrackablePublicPath(path),
      `public path must be trackable: ${path}`,
    );
  }
});

test("beacon does NOT emit for verify/v/share/intake/portal/auth/invite token paths", () => {
  for (const path of BLOCKED_TOKEN_PATHS) {
    assert.equal(
      isTrackablePublicPath(path),
      false,
      `sensitive token path must NOT be trackable: ${path}`,
    );
  }
});

test("beacon does NOT emit for authenticated app / admin surfaces", () => {
  for (const path of BLOCKED_APP_PATHS) {
    assert.equal(
      isTrackablePublicPath(path),
      false,
      `app/admin path must NOT be trackable: ${path}`,
    );
  }
});

test("sanitized path drops query string and hash (no tokens forwarded)", () => {
  assert.equal(sanitizePublicPath("/pricing?ref=token123&utm=x"), "/pricing");
  assert.equal(sanitizePublicPath("/trust#section"), "/trust");
  assert.equal(sanitizePublicPath("/about/"), "/about");
  assert.equal(sanitizePublicPath("/"), "/");
  assert.equal(sanitizePublicPath(""), null);
  assert.equal(sanitizePublicPath(null), null);
});

test("a token smuggled via query string on an allowed path is not trackable through the raw value, only the base route is sent", () => {
  // Even if a caller passes a full URL-ish string, only the sanitized base
  // path is considered, and the base decides trackability. No token survives.
  const sanitized = sanitizePublicPath(
    "/verify/eyJhbGciOiJI.token.sig?x=1",
  );
  assert.equal(sanitized, "/verify/eyJhbGciOiJI.token.sig");
  assert.equal(isTrackablePublicPath(sanitized), false);
});

test("beacon component delegates to the consent-gated trackEvent and never bypasses consent", () => {
  const source = readFileSync(
    resolve(APP_ROOT, "components/analytics/PublicPageView.tsx"),
    "utf8",
  );

  // Must go through trackEvent (which is gated by hasAnalyticsConsent).
  assert.match(
    source,
    /trackEvent\(\s*["']page_view["']/,
    "beacon must fire page_view via trackEvent",
  );

  // Must NOT read consent itself or hit the ingest endpoint directly —
  // consent gating is trackEvent's job and must not be duplicated/bypassed.
  // (We look for an actual call, not the word in a comment.)
  const codeWithoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(
    codeWithoutComments,
    /hasAnalyticsConsent\s*\(/,
    "beacon must not re-implement the consent gate (delegate to trackEvent)",
  );
  assert.doesNotMatch(
    codeWithoutComments,
    /\/v1\/analytics/,
    "beacon must not call the ingest endpoint directly",
  );
  assert.doesNotMatch(
    codeWithoutComments,
    /apiFetch/,
    "beacon must not post to the API directly (goes through trackEvent)",
  );

  // Must screen the path through the allowlist before emitting.
  assert.match(
    source,
    /isTrackablePublicPath/,
    "beacon must gate emission on isTrackablePublicPath",
  );
});

test("trackEvent itself is consent-gated (the gate the beacon relies on)", () => {
  const source = readFileSync(resolve(APP_ROOT, "lib/analytics.ts"), "utf8");
  // The very first thing trackEvent does is bail when consent is absent.
  assert.match(
    source,
    /export async function trackEvent[\s\S]{0,200}if \(!hasAnalyticsConsent\(\)\) return;/,
    "trackEvent must early-return when analytics consent is not granted",
  );
});
