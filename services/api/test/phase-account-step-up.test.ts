/**
 * Account-level step-up enforcement contracts (2026-07-16).
 *
 * Pins the canonical backend-enforced re-auth on sensitive personal-account
 * mutations. The verifier itself queries the DB (user hash / active factor /
 * current session), so behavior tests for the full proof matrix belong to
 * the live harness; here we pin the ENFORCEMENT WIRING invariants that must
 * never regress:
 *
 *   1. Every classified sensitive route calls `verifyAccountStepUp` and
 *      early-returns the denial BEFORE its mutation.
 *   2. The MFA factor DELETE distinguishes ENROLLING (cancel — no step-up,
 *      caller-scoped) from ACTIVE (verified factor — step-up required).
 *   3. The verifier is ONE canonical module: rate-limited, audited, no
 *      frontend boolean accepted, no secrets in URLs.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), "utf8");

const SERVICE = read("../src/services/identity-security/account-step-up.service.ts");
const MFA_ROUTES = read("../src/routes/mfa.routes.ts");
const IDSEC_ROUTES = read("../src/routes/identity-security.routes.ts");

describe("canonical account step-up verifier", () => {
  it("supports password, current-MFA-code, and OAuth recent-auth methods", () => {
    expect(SERVICE).toMatch(/verifyPassword\(/);
    expect(SERVICE).toMatch(/verifyActiveTotp\(/);
    expect(SERVICE).toMatch(/RECENT_AUTH_WINDOW_MS/);
    // Recent-auth is bound to the CURRENT session row.
    expect(SERVICE).toMatch(/sessionIdHash/);
    expect(SERVICE).toMatch(/issuedAtUtc/);
  });

  it("never accepts a frontend boolean and reads proof from the body only", () => {
    expect(SERVICE).not.toMatch(/confirmed/i);
    // No query/URL parsing for proof material.
    expect(SERVICE).not.toMatch(/req\.query/);
  });

  it("is rate limited before verification and audited on both outcomes", () => {
    expect(SERVICE).toMatch(/isRateLimited\(/);
    expect(SERVICE).toMatch(/"step_up_denied"/);
    expect(SERVICE).toMatch(/"step_up_approved"/);
  });

  it("never logs or echoes the password/code", () => {
    expect(SERVICE).not.toMatch(/console\./);
    // Denial bodies carry structured messages only, never the submitted
    // proof values.
    expect(SERVICE).not.toMatch(/proof\.currentPassword[\s\S]{0,80}details/);
  });
});

describe("sensitive routes enforce step-up before mutating", () => {
  function handlerSlice(src: string, anchor: string, span = 2600): string {
    const at = src.indexOf(anchor);
    expect(at, `${anchor} route must exist`).toBeGreaterThan(-1);
    return src.slice(at, at + span);
  }

  it("MFA factor removal requires step-up for ACTIVE factors only", () => {
    const h = handlerSlice(MFA_ROUTES, '"/v1/identity/mfa/factors/:id"');
    expect(h).toMatch(/verifyAccountStepUp/);
    expect(h).toMatch(/"mfa_factor_remove"/);
    // ENROLLING cancel path is exempt; the exemption is CALLER-scoped
    // (findFirst by id + userId), so it can never touch another user's
    // factor or bypass step-up for a verified one.
    expect(h).toMatch(/status === "ACTIVE"/);
    expect(h).toMatch(/where:\s*\{\s*id:\s*params\.id,\s*userId\s*\}/);
    // Denial early-returns BEFORE revokeFactor.
    expect(h.indexOf("verifyAccountStepUp")).toBeLessThan(h.indexOf("revokeFactor"));
  });

  it("recovery-code regeneration requires step-up before regenerating", () => {
    const h = handlerSlice(MFA_ROUTES, '"/v1/identity/mfa/recovery-codes/regenerate"');
    expect(h).toMatch(/verifyAccountStepUp/);
    expect(h).toMatch(/"mfa_recovery_codes_regenerate"/);
    expect(h.indexOf("verifyAccountStepUp")).toBeLessThan(
      h.indexOf("regenerateRecoveryBatch"),
    );
  });

  it("revoke-other-sessions requires step-up before revoking", () => {
    const h = handlerSlice(IDSEC_ROUTES, '"/v1/identity-security/my-sessions/revoke-others"', 3200);
    expect(h).toMatch(/verifyAccountStepUp/);
    expect(h).toMatch(/"sessions_revoke_others"/);
    expect(h.indexOf("verifyAccountStepUp")).toBeLessThan(h.indexOf("updateMany"));
  });

  it("password change keeps its equivalent re-auth (current password required)", () => {
    const h = handlerSlice(IDSEC_ROUTES, '"/v1/identity-security/password"', 3000);
    expect(h).toMatch(/currentPassword/);
  });
});
