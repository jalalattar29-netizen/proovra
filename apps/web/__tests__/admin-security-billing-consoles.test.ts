/**
 * Platform Control Center P1 — Security & Billing console UX contracts.
 *
 * Source-contract style (matches admin-console-ux.test.ts): asserts the two
 * new admin consoles render through the shared PageShell (no marketing hero),
 * present honest null states, and never surface secrets / raw IPs / card
 * tokens in the client.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");
const exists = (rel: string): boolean => existsSync(resolve(APP_ROOT, rel));

const SECURITY = "app/(app)/admin/security/page.tsx";
const BILLING = "app/(app)/admin/billing/page.tsx";

test("both new admin console pages exist", () => {
  assert.ok(exists(SECURITY), "security console page must exist");
  assert.ok(exists(BILLING), "billing console page must exist");
});

test("both consoles render through the shared PageShell (no marketing hero)", () => {
  for (const rel of [SECURITY, BILLING]) {
    const src = read(rel);
    assert.match(src, /PageShell/, `${rel} must use the shared PageShell`);
    assert.doesNotMatch(
      src,
      /app-hero-full|className="app-hero/,
      `${rel} must not render the marketing app-hero`,
    );
    assert.doesNotMatch(src, /cc-page|btn-/, `${rel} must not use legacy cc-page/btn- classes`);
    assert.match(src, /AdminConsoleNav/, `${rel} must render the admin console nav`);
  }
});

test("both consoles route errors through toSafeUserError (sanctioned path)", () => {
  for (const rel of [SECURITY, BILLING]) {
    assert.match(read(rel), /toSafeUserError/, `${rel} must use toSafeUserError`);
  }
});

test("security console renders honest empty + 'Not measured' states", () => {
  const src = read(SECURITY);
  assert.match(src, /EmptyState/, "must render EmptyState");
  assert.match(src, /No security events/i, "honest empty state for events");
  assert.match(src, /No incidents recorded/i, "honest empty state for incidents");
  assert.match(src, /Not measured/i, "honest 'Not measured' for absent severity signal");
});

test("security console exposes the type + severity FilterBar", () => {
  const src = read(SECURITY);
  assert.match(src, /FilterBar/, "must render FilterBar");
  assert.match(src, /eventType/, "must filter by event type");
  assert.match(src, /severity/i, "must filter by severity");
});

test("billing console renders honest 'Not measured' MRR/ARR + not-connected webhook states", () => {
  const src = read(BILLING);
  assert.match(src, /Not measured/i, "honest 'Not measured' for non-derivable MRR/ARR");
  assert.match(src, /Not connected/i, "honest not-connected webhook state");
  assert.match(src, /Subscription MRR/, "renders subscription MRR tile");
  assert.match(src, /Subscription ARR/, "renders subscription ARR tile");
});

test("neither console surfaces secrets, raw IPs, or card tokens in the client", () => {
  for (const rel of [SECURITY, BILLING]) {
    const src = read(rel);
    // Guard against actual data-leak field access, not descriptive prose.
    assert.doesNotMatch(src, /r\.ipAddress\b|\.ipAddress\b/, `${rel} must not read a raw IP field`);
    assert.doesNotMatch(src, /\.token\b|accessToken|apiKey|\.secret\b|cardNumber/i, `${rel} must not read token/secret/card fields`);
    assert.doesNotMatch(src, /providerPaymentId|providerSubId/, `${rel} must not surface provider payment identifiers`);
  }
});

test("billing console exposes only email as customer PII", () => {
  const src = read(BILLING);
  assert.match(src, /userEmail/, "payment rows show email");
  assert.doesNotMatch(src, /\.phone\b|customerName|\.ssn\b/i, "no broader PII fields");
});
