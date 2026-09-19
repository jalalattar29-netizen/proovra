/**
 * PERMANENT GUARD J (Phase 4C) — native auth API surface targets the canonical
 * backend endpoints and handles the MFA + legal shapes. Source-as-text (the
 * module imports ../api at runtime, so it can't be transpile-imported).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/auth/auth-api.ts"), "utf8");

test("targets the canonical auth endpoints", () => {
  for (const ep of [
    "/v1/auth/email/login",
    "/v1/auth/email/register",
    "/v1/auth/email/verify",
    "/v1/auth/email/resend-verification",
    "/v1/auth/password-reset/request",
    "/v1/auth/password-reset/confirm",
    "/v1/auth/mfa/verify",
    "/v1/auth/google",
    "/v1/auth/apple",
    "/v1/auth/me",
    "/v1/auth/logout",
    "/v1/users/legal-status",
    "/v1/users/legal-acceptance",
  ]) {
    assert.ok(src.includes(`"${ep}"`), `auth-api must call ${ep}`);
  }
});

test("handles the MFA-required login shape (no dead-end on missing token)", () => {
  assert.match(src, /mfaRequired/, "must detect mfaRequired");
  assert.match(src, /mfaPendingToken/, "must carry mfaPendingToken");
  assert.match(src, /kind:\s*"mfaRequired"/, "must return a discriminated mfaRequired result");
});

test("legal status parses missingPolicies + requiredVersions", () => {
  assert.match(src, /missingPolicies/);
  assert.match(src, /requiredVersions/);
});
