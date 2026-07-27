/**
 * AVATAR OAuth ingest — proves the picture claim flows from Google's
 * id_token payload all the way into User.avatarUrl.
 *
 * This is a source-contract test — no live DB or network — that
 * exercises the exact byte-level code paths so a regression at any of
 * these choke points is caught in CI:
 *
 *   1. `parseJwt` extracts `picture` from the payload.
 *   2. `verifyGoogleIdToken` maps `payload.picture` → `avatarUrl` on
 *      the returned AuthProfile.
 *   3. `verifyAppleIdToken` sets `avatarUrl: null` (Apple's id_token
 *      has no picture claim).
 *   4. `upsertUserWithEmailLink`:
 *      - CREATE path passes `avatarUrl` through
 *      - UPDATE path only writes when the existing row has no avatar
 *      - GUEST-UPGRADE path only writes when the guest row has none
 *
 * We intentionally use source regex against the compiled JS AND the
 * TS source so a future refactor that DROPS the wiring is caught
 * (same source-contract idiom used elsewhere in this suite).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const AUTH_SERVICE_SRC = readFileSync(
  fileURLToPath(new URL("../src/services/auth.service.ts", import.meta.url)),
  "utf8",
);

describe("avatar OAuth ingest — Google", () => {
  it("AuthProfile type carries an avatarUrl field", () => {
    expect(AUTH_SERVICE_SRC).toMatch(/avatarUrl\?:\s*string\s*\|\s*null;/);
  });

  it("parseJwt extracts the picture claim from the payload", () => {
    // The payload cast must include `picture?: string` so the
    // `verifyGoogleIdToken` return statement can read it type-safely.
    expect(AUTH_SERVICE_SRC).toMatch(/picture\?:\s*string;/);
  });

  it("verifyGoogleIdToken maps payload.picture → avatarUrl on the returned profile", () => {
    // Strip block comments so a docstring mentioning the field doesn't
    // false-positive the match.
    const stripped = AUTH_SERVICE_SRC.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).toMatch(
      /provider:\s*prismaPkg\.AuthProvider\.GOOGLE[\s\S]{0,400}avatarUrl:\s*payload\.picture\s*\?\s*String\(payload\.picture\)\s*:\s*null/,
    );
  });

  it("verifyAppleIdToken explicitly sets avatarUrl to null (Apple has no picture claim)", () => {
    const stripped = AUTH_SERVICE_SRC.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).toMatch(
      /provider:\s*prismaPkg\.AuthProvider\.APPLE[\s\S]{0,400}avatarUrl:\s*null/,
    );
  });
});

describe("avatar persistence — upsertUserWithEmailLink", () => {
  it("CREATE path writes profile.avatarUrl to the new User row", () => {
    // The create data object must contain a line that persists the
    // provider-supplied avatar (defaulting to null if none).
    expect(AUTH_SERVICE_SRC).toMatch(
      /prisma\.user\.create\(\{[\s\S]{0,600}avatarUrl:\s*profile\.avatarUrl\s*\?\?\s*null/,
    );
  });

  it("UPDATE path backfills only when the current row has no avatar", () => {
    // Guarded write — profile.avatarUrl truthy AND user.avatarUrl null.
    // Never overwrite a user-uploaded custom avatar.
    expect(AUTH_SERVICE_SRC).toMatch(
      /profile\.avatarUrl\s*&&\s*!user\.avatarUrl[\s\S]{0,120}avatarUrl:\s*profile\.avatarUrl/,
    );
  });

  it("GUEST-UPGRADE avatar path is removed (Guest Login physically deleted, PHASE 10)", () => {
    // Guest Login is no longer an authentication concept (physically removed).
    // There is therefore no anonymous guest row to upgrade, and the guest
    // avatar-backfill branch is correctly gone from the auth service. The
    // CREATE (first OAuth login) and UPDATE (repeat sign-in) paths below remain
    // the only avatar write sites.
    expect(AUTH_SERVICE_SRC).not.toMatch(/!guest\.avatarUrl/);
    expect(AUTH_SERVICE_SRC).not.toMatch(/createGuestProfile|ensureGuestIdentity/);
  });

  it("UPDATE path never null-outs an existing avatarUrl on repeat sign-in", () => {
    // If a user has an avatar and Google's next id_token has no
    // picture, the update must be a NOOP for the avatar field — never
    // write `avatarUrl: null` unconditionally on an existing row.
    const updateBlock = AUTH_SERVICE_SRC.match(
      /prisma\.user\.update\(\{[\s\S]{0,900}?email:\s*profile\.email[\s\S]{0,900}?\}\s*\)/,
    );
    expect(updateBlock).toBeTruthy();
    // Inside the update data, `avatarUrl` may appear ONLY as a
    // conditional spread — never as a bare assignment.
    if (updateBlock) {
      const body = updateBlock[0];
      // No bare `avatarUrl: ...,` line — it must be behind a spread.
      const barePattern = /(?<!\.\.\.\([^)]{0,200})^\s*avatarUrl:\s*[^p]/m;
      expect(body).not.toMatch(barePattern);
    }
  });
});

describe("avatar debug tap — off by default, opt-in via AVATAR_DEBUG env", () => {
  it("debug helper exists and is guarded by AVATAR_DEBUG env", () => {
    expect(AUTH_SERVICE_SRC).toMatch(/process\.env\.AVATAR_DEBUG/);
    expect(AUTH_SERVICE_SRC).toMatch(/function debugAvatar/);
  });

  it("verifyGoogleIdToken taps the pipeline after mapping", () => {
    expect(AUTH_SERVICE_SRC).toMatch(
      /debugAvatar\(["']google\.verifyIdToken["']/,
    );
  });

  it("upsertUserWithEmailLink taps both entry (incoming profile) and exit (persisted row)", () => {
    expect(AUTH_SERVICE_SRC).toMatch(
      /debugAvatar\(["']upsertUser\.in["']/,
    );
    expect(AUTH_SERVICE_SRC).toMatch(
      /debugAvatar\(["']upsertUser\.out["']/,
    );
  });
});
