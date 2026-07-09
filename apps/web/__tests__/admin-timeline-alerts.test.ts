/**
 * PROOVRA Platform Admin (items J + K) — Global Timeline + Alerts Center UX
 * contracts.
 *
 * Source-contract style (matches admin-security-billing-consoles.test.ts):
 * asserts the two new admin pages exist, render through the shared PageShell,
 * wrap the platform.admin PageRouteGate, present honest states, and — for the
 * timeline — call out its separation from evidence custody.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");
const exists = (rel: string): boolean => existsSync(resolve(APP_ROOT, rel));

const TIMELINE = "app/(app)/admin/timeline/page.tsx";
const ALERTS = "app/(app)/admin/alerts/page.tsx";

test("both new admin pages exist", () => {
  assert.ok(exists(TIMELINE), "timeline page must exist");
  assert.ok(exists(ALERTS), "alerts page must exist");
});

test("both pages wrap the platform.admin PageRouteGate", () => {
  for (const rel of [TIMELINE, ALERTS]) {
    const src = read(rel);
    assert.match(src, /PageRouteGate/, `${rel} must use PageRouteGate`);
    assert.match(
      src,
      /routeId="platform\.admin"/,
      `${rel} must gate on platform.admin`,
    );
  }
});

test("both pages render through the shared PageShell + admin nav (no marketing hero)", () => {
  for (const rel of [TIMELINE, ALERTS]) {
    const src = read(rel);
    assert.match(src, /PageShell/, `${rel} must use the shared PageShell`);
    assert.match(src, /AdminConsoleNav/, `${rel} must render the admin console nav`);
    assert.doesNotMatch(
      src,
      /app-hero-full|className="app-hero/,
      `${rel} must not render the marketing app-hero`,
    );
    assert.doesNotMatch(src, /cc-page|btn-/, `${rel} must not use legacy cc-page/btn- classes`);
  }
});

test("both pages route errors through toSafeUserError (sanctioned path)", () => {
  for (const rel of [TIMELINE, ALERTS]) {
    assert.match(read(rel), /toSafeUserError/, `${rel} must use toSafeUserError`);
  }
});

test("both pages carry their data-testid handles", () => {
  assert.match(read(TIMELINE), /data-testid="admin-timeline"/, "timeline testid");
  assert.match(read(ALERTS), /data-testid="admin-alerts"/, "alerts testid");
});

test("timeline notes it is the PLATFORM feed, SEPARATE from evidence custody", () => {
  const src = read(TIMELINE);
  assert.match(src, /PLATFORM/, "must call itself the platform timeline");
  assert.match(src, /custody/i, "must reference evidence custody");
  assert.match(
    src,
    /SEPARATE|separate|not evidence custody|not the evidence/i,
    "must state the separation from custody",
  );
});

test("timeline exposes source / severity / organization filters", () => {
  const src = read(TIMELINE);
  assert.match(src, /FilterBar/, "must render FilterBar");
  assert.match(src, /source/i, "must filter by source");
  assert.match(src, /severity/i, "must filter by severity");
  assert.match(src, /organization/i, "must filter by organization");
});

test("alerts page has an honest 'No active alerts' empty state", () => {
  const src = read(ALERTS);
  assert.match(src, /EmptyState/, "must render EmptyState");
  assert.match(src, /No active alerts/i, "honest empty state copy");
});

test("alerts page states the read-only (no ack/resolve) posture honestly", () => {
  const src = read(ALERTS);
  assert.match(
    src,
    /read-only|point-in-time|no per-alert|resolve an alert at its source/i,
    "must state the read-only posture",
  );
});

test("neither page surfaces raw IPs or secrets in the client", () => {
  for (const rel of [TIMELINE, ALERTS]) {
    const src = read(rel);
    assert.doesNotMatch(src, /\.ipAddress\b|ipAddressHash/, `${rel} must not read a raw/hashed IP field`);
    assert.doesNotMatch(
      src,
      /\.token\b|accessToken|apiKey|\.secret\b|clientSecret|cardNumber/i,
      `${rel} must not read token/secret/card fields`,
    );
  }
});
