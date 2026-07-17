/**
 * Settings/security remediation contracts (2026-07-16).
 *
 * RUNTIME tests for the canonical security-event presentation mapping (the
 * pure module is imported and executed), plus source contracts for the
 * wiring that has no executable form (OAuth-only password branch, removal
 * of the fake session status).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  humanizeEventKey,
  presentOutcome,
  presentSecurityEvent,
} from "../lib/security/securityEventLabels";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// RUNTIME — canonical security-event presentation
// ---------------------------------------------------------------------------

test("curated internal audit keys map to human titles", () => {
  assert.equal(presentSecurityEvent("auth.google_login").title, "Signed in with Google");
  assert.equal(presentSecurityEvent("auth.apple_login").title, "Signed in with Apple");
  assert.equal(
    presentSecurityEvent("identity_security.password_change").title,
    "Password changed",
  );
  assert.equal(presentSecurityEvent("auth.mfa_verify").title, "Two-factor verification");
});

test("a raw internal key is NEVER shown as the title (unknown keys are humanized)", () => {
  // The defect: `auth.google_login` rendered verbatim as the row title.
  const unknown = presentSecurityEvent("identity_security.some_new_event");
  assert.equal(unknown.title, "Some new event");
  assert.ok(!unknown.title.includes("."), "no dotted internal key in the title");
  assert.ok(!unknown.title.includes("_"), "no snake_case leaking into the title");
});

test("humanizeEventKey strips the internal namespace and never returns empty", () => {
  assert.equal(humanizeEventKey("auth.logout"), "Logout");
  assert.equal(humanizeEventKey("bare_event"), "Bare event");
  assert.equal(humanizeEventKey(""), "Security event");
});

test("Phase-2 identity/preference/membership events have curated human labels", () => {
  assert.equal(presentSecurityEvent("identity.profile_updated").title, "Profile updated");
  assert.equal(
    presentSecurityEvent("identity.preferences_updated").title,
    "Preferences updated",
  );
  assert.equal(
    presentSecurityEvent("identity.organization_left").title,
    "Left an organization",
  );
});

test("outcomes render as words, not raw enum values", () => {
  assert.equal(presentOutcome("success"), "Succeeded");
  assert.equal(presentOutcome("failure"), "Failed");
  assert.equal(presentOutcome("blocked"), "Blocked");
  assert.equal(presentOutcome(null), null);
});

// ---------------------------------------------------------------------------
// Source contracts — wiring with no executable form
// ---------------------------------------------------------------------------

const SECTIONS = read("app/(app)/security-center/components/PersonalSecuritySections.tsx");
const SETTINGS = read("app/(app)/settings/page.tsx");

test("security events render through the canonical mapping, not the raw action", () => {
  assert.match(SECTIONS, /presentSecurityEvent\(ev\.action\)\.title/);
  assert.match(SECTIONS, /presentOutcome\(ev\.outcome\)/);
  // The raw key must no longer be the primary copy.
  assert.doesNotMatch(SECTIONS, /<strong style=\{\{ fontWeight: 700 \}\}>\{ev\.action\}<\/strong>/);
});

test("forensic detail is preserved behind a technical-details disclosure", () => {
  assert.match(SECTIONS, /Technical details/);
  assert.match(SECTIONS, /Event key: \{ev\.action\}/);
});

test("OAuth-only accounts do not get an unusable change-password form", () => {
  // Provider comes from backend account data, not UI copy.
  assert.match(SECTIONS, /const providerKey = \(user\?\.provider \?\? ""\)\.toLowerCase\(\)/);
  assert.match(SECTIONS, /data-cc-password-oauth-only=\{providerKey\}/);
  // …and we do NOT invent an account-linking "Set a password" flow. This
  // targets rendered JSX copy (a control offered to the user), not prose in
  // a code comment explaining why the flow is deliberately absent.
  assert.doesNotMatch(SECTIONS, />\s*Set a password\s*</);
});

test("password-capable accounts still get the change-password form", () => {
  // The OAuth branch is keyed to a known provider allowlist, so unknown /
  // email accounts keep the form (no regression for password users).
  assert.match(SECTIONS, /OAUTH_PROVIDER_LABELS/);
  assert.match(SECTIONS, /data-cc-password-current/);
});

test("the fake hardcoded 'Session: Active' status is gone from /settings", () => {
  assert.doesNotMatch(SETTINGS, /font-semibold text-\[#2f7d5b\]">Active</);
  assert.doesNotMatch(SETTINGS, /<span className="text-\[#5F6B7D\]">Session<\/span>/);
  // Login method (real backend field) is retained.
  assert.match(SETTINGS, /Login method/);
});
