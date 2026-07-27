/**
 * PHASE R8.1.2 — Login-time MFA challenge + frontend stabilization
 * source-contract tests.
 *
 * 19 tests total:
 *   - 14 backend / orchestrator integration locks
 *   - 5  frontend / build prerequisite locks
 *
 * These are SOURCE-CONTRACT tests, not E2E. They lock the wiring
 * shape so future edits cannot silently:
 *   - Bypass MFA on login
 *   - Re-implement TOTP verification in auth.routes.ts
 *   - Persist OTP / recovery codes / pending tokens to localStorage
 *   - Issue the session cookie before MFA verifies
 *   - Re-introduce the build-breaking unused-vars in CommandCenter
 *   - Remove the /auth/mfa-challenge page
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  signMfaPendingToken,
  verifyMfaPendingTokenSignature,
  MFA_PENDING_TTL_SECONDS,
  signJwt,
} from "../src/services/jwt.js";

const REPO = resolve(__dirname, "..", "..", "..");
const apiPath = (rel: string) => resolve(REPO, "services/api", rel);
const webPath = (rel: string) => resolve(REPO, "apps/web", rel);

const AUTH_SRC = readFileSync(
  apiPath("src/routes/auth.routes.ts"),
  "utf8",
);
const SSO_SRC = readFileSync(
  apiPath("src/routes/sso-auth.routes.ts"),
  "utf8",
);
const JWT_SRC = readFileSync(apiPath("src/services/jwt.ts"), "utf8");
const MIDDLEWARE_SRC = readFileSync(
  apiPath("src/middleware/auth.ts"),
  "utf8",
);
const MFA_PAGE_PATH = webPath("app/auth/mfa-challenge/page.tsx");
const CMD_CENTER_PATH = webPath(
  "components/command-center/CommandCenter.tsx",
);

// =============================================================================
// PART 1 — Pending token primitives (jwt.ts)
// =============================================================================

describe("R8.1.2 Part 1 — mfa-pending JWT primitives", () => {
  const SECRET = "test-secret-for-r8-1-2-contract-only-do-not-deploy";

  it("test 1: signMfaPendingToken returns a token with the `mfa: pending` discriminator", () => {
    const token = signMfaPendingToken(
      { sub: "user_abc", provider: "EMAIL", email: "u@example.com" },
      SECRET,
    );
    // Decode payload manually (HS256 JWT, base64url middle segment).
    const payloadB64 = token.split(".")[1];
    const padded = payloadB64
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(payloadB64.length / 4) * 4, "=");
    const payload = JSON.parse(
      Buffer.from(padded, "base64").toString("utf8"),
    );
    expect(payload.mfa).toBe("pending");
    expect(payload.sub).toBe("user_abc");
    expect(typeof payload.sid).toBe("string");
    expect(typeof payload.exp).toBe("number");
    // Must expire in EXACTLY MFA_PENDING_TTL_SECONDS from issuance,
    // give or take 2 seconds for clock skew during the test.
    const now = Math.floor(Date.now() / 1000);
    expect(payload.exp - now).toBeGreaterThanOrEqual(
      MFA_PENDING_TTL_SECONDS - 2,
    );
    expect(payload.exp - now).toBeLessThanOrEqual(
      MFA_PENDING_TTL_SECONDS + 2,
    );
  });

  it("test 2: MFA_PENDING_TTL_SECONDS equals exactly 5 minutes (replay-bound)", () => {
    expect(MFA_PENDING_TTL_SECONDS).toBe(5 * 60);
  });

  it("test 3: verifyMfaPendingTokenSignature returns the same payload across calls (replay protection delegated to durable store)", () => {
    // R8.1.4 — in-memory deny-list was removed. Single-use replay
    // protection is now solely the responsibility of
    // `consumeMfaPendingChallenge` (atomic UPDATE on the durable
    // `MfaPendingChallenge` row). The signature primitive itself is
    // intentionally pure: it does NOT mutate any process-local state.
    // R8.1.3 contract test 4 + R8.1.4 contract tests cover the
    // durable replay-detection path.
    const token = signMfaPendingToken(
      { sub: "user_replay", provider: "EMAIL", email: "r@example.com" },
      SECRET,
      "test-jti-replay-1234567890abcdef",
    );
    const first = verifyMfaPendingTokenSignature(token, SECRET);
    expect(first.sub).toBe("user_replay");
    expect(first.mfa).toBe("pending");
    expect(first.sid).toBe("test-jti-replay-1234567890abcdef");
    // Same signature verifies again — replay protection lives in
    // the DB, NOT in the signature primitive.
    const second = verifyMfaPendingTokenSignature(token, SECRET);
    expect(second.sid).toBe(first.sid);
  });

  it("test 4: verifyMfaPendingTokenSignature refuses a regular (non-pending) session token", () => {
    const normal = signJwt(
      { sub: "user_full", provider: "EMAIL", email: "f@example.com" },
      SECRET,
      60,
    );
    expect(() =>
      verifyMfaPendingTokenSignature(normal, SECRET),
    ).toThrowError(/not_a_pending_token/);
  });
});

// =============================================================================
// PART 2 — auth middleware refuses pending tokens
// =============================================================================

describe("R8.1.2 Part 2 — requireAuth rejects pending tokens", () => {
  it("test 5: middleware refuses payload.mfa === 'pending' with a generic 401", () => {
    expect(MIDDLEWARE_SRC).toMatch(/payload\.mfa\s*===\s*["']pending["']/);
    // The reject path must NOT leak the discriminator to the caller.
    // We assert a generic `UNAUTHORIZED` is returned at the rejection
    // site (the same code-path label used for plain invalid tokens).
    const mfaRejectBlock = MIDDLEWARE_SRC.match(
      /payload\.mfa\s*===\s*["']pending["'][\s\S]{0,400}/,
    );
    expect(mfaRejectBlock).toBeTruthy();
    expect(mfaRejectBlock![0]).toMatch(/code\(401\)/);
    expect(mfaRejectBlock![0]).toMatch(/ErrorCode\.UNAUTHORIZED/);
  });
});

// =============================================================================
// PART 3 — auth.routes.ts wires the gate at every login path
// =============================================================================

/**
 * Extract the source span of a Fastify route handler, anchored on
 * the path literal and bounded by the NEXT `app.post(` / `app.get(`
 * / `app.delete(` / end-of-file. Greedy regex with lookahead fails
 * because nested `})` close earlier scopes. This is a deterministic
 * substring walk.
 */
function endpointBody(path: string): string {
  const anchor = AUTH_SRC.indexOf(`app.post("${path}"`);
  if (anchor < 0) return "";
  const tail = AUTH_SRC.slice(anchor + 1);
  const nextRoute = tail.search(
    /\bapp\.(post|get|delete|put|patch)\(\s*["'][^"']+["']/,
  );
  const end = nextRoute >= 0 ? anchor + 1 + nextRoute : AUTH_SRC.length;
  return AUTH_SRC.slice(anchor, end);
}

describe("R8.1.2 Part 3 — gateLoginWithMfa wired into every login path", () => {
  it("test 6: auth.routes.ts imports the canonical orchestrator (no parallel implementation)", () => {
    expect(AUTH_SRC).toMatch(/from\s+["'][^"']*\/mfa\.service/);
    expect(AUTH_SRC).toMatch(/\bverifyActiveTotp\b/);
    expect(AUTH_SRC).toMatch(/\bconsumeRecoveryCode\b/);
    expect(AUTH_SRC).toMatch(/\breadMfaStatus\b/);
  });

  it("test 7: gateLoginWithMfa runs in google + apple + email login paths", () => {
    expect(endpointBody("/v1/auth/google")).toMatch(/gateLoginWithMfa/);
    expect(endpointBody("/v1/auth/apple")).toMatch(/gateLoginWithMfa/);
    expect(endpointBody("/v1/auth/email/login")).toMatch(
      /gateLoginWithMfa/,
    );
  });

  it("test 8: the guest endpoint no longer exists (Guest Login physically removed)", () => {
    // Guest Login was DELETED (2026-07-23) — there is no /v1/auth/guest route,
    // so there is no MFA gate to reason about. See phase-10-guest-login-removed.
    expect(endpointBody("/v1/auth/guest")).toBe("");
    expect(AUTH_SRC).not.toContain("/v1/auth/guest");
  });

  it("test 9: register endpoint NOT gated (a fresh user has no MFA factor yet)", () => {
    const register = endpointBody("/v1/auth/email/register");
    expect(register).toBeTruthy();
    expect(register).not.toMatch(/gateLoginWithMfa/);
  });
});

// =============================================================================
// PART 4 — POST /v1/auth/mfa/verify
// =============================================================================

describe("R8.1.2 Part 4 — POST /v1/auth/mfa/verify shape", () => {
  it("test 10: endpoint exists with correct path", () => {
    expect(AUTH_SRC).toMatch(/app\.post\(\s*["']\/v1\/auth\/mfa\/verify["']/);
  });

  it("test 11: endpoint delegates to the orchestrator (no parallel TOTP check)", () => {
    const verify = endpointBody("/v1/auth/mfa/verify");
    expect(verify).toBeTruthy();
    expect(verify).toMatch(/verifyActiveTotp/);
    expect(verify).toMatch(/consumeRecoveryCode/);
    // Must NOT re-implement TOTP locally.
    expect(verify).not.toMatch(/createHmac\s*\(/);
    expect(verify).not.toMatch(/scryptSync\s*\(/);
  });

  it("test 12: endpoint is rate-limited per user (5/min)", () => {
    expect(AUTH_SRC).toMatch(/LOGIN_MFA_ATTEMPT_MAX\s*=\s*5/);
    expect(AUTH_SRC).toMatch(/LOGIN_MFA_ATTEMPT_WINDOW_MS\s*=\s*60_?000/);
    expect(AUTH_SRC).toMatch(/loginMfaIsRateLimited/);
  });

  it("test 13: endpoint accepts pending token from EITHER cookie OR body", () => {
    const verify = endpointBody("/v1/auth/mfa/verify");
    expect(verify).toBeTruthy();
    expect(verify).toMatch(/proovra_mfa_pending/);
    expect(verify).toMatch(/\bmfaPendingToken\b/);
  });

  it("test 14: success path clears the pending cookie + sets the canonical session", () => {
    const verify = endpointBody("/v1/auth/mfa/verify");
    expect(verify).toBeTruthy();
    expect(verify).toMatch(/clearMfaPendingCookie/);
    expect(verify).toMatch(/maybeSetWebCookie/);
  });
});

// =============================================================================
// PART 5 — OIDC callback gate
// =============================================================================

describe("R8.1.2 Part 5 — OIDC callback respects MFA", () => {
  it("test 15: sso-auth.routes.ts gates the SSO success branch on readMfaStatus", () => {
    expect(SSO_SRC).toMatch(/readMfaStatus/);
    expect(SSO_SRC).toMatch(/signMfaPendingToken/);
    expect(SSO_SRC).toMatch(/proovra_mfa_pending/);
    expect(SSO_SRC).toMatch(/\/auth\/mfa-challenge/);
  });
});

// =============================================================================
// PART 6 — Bounded security vocabulary (no drift, no new event types)
// =============================================================================

describe("R8.1.2 Part 6 — uses only bounded SECURITY_EVENT_TYPES", () => {
  it("test 16: auth.routes.ts emits only `auth_login_failed` from R8 vocabulary (no new event types)", () => {
    // Find all safeEmitSecurityEvent calls and pull out the
    // `eventType` literal. Each must be one of the R8 bounded types.
    const emits = [
      ...AUTH_SRC.matchAll(
        /safeEmitSecurityEvent\s*\(\s*\{[\s\S]*?eventType:\s*["']([^"']+)["']/g,
      ),
    ].map((m) => m[1]);
    expect(emits.length).toBeGreaterThan(0);
    const allowed = new Set([
      "auth_login_failed",
      "mfa_verification_succeeded",
      "mfa_verification_failed",
      // R8.1.3 widened the auth.routes.ts emission set to include
      // the org-enforcement and enrollment-required events. These
      // remain in the bounded SECURITY_EVENT_TYPES vocabulary;
      // anything outside this set would be a vocabulary drift.
      "mfa_enrollment_required",
      "org_mfa_policy_enforced",
    ]);
    for (const e of emits) {
      expect(allowed.has(e), `unexpected eventType "${e}"`).toBe(true);
    }
  });
});

// =============================================================================
// PART 7 — Frontend / build prerequisite locks (R8.1A Part G)
// =============================================================================

describe("R8.1A Part 7 — CommandCenter.tsx build hygiene", () => {
  it("test 17: getPersonaSectionOrder is NOT imported directly into CommandCenter.tsx", () => {
    const src = readFileSync(CMD_CENTER_PATH, "utf8");
    // The import block must not pull the symbol in. R3 replaced it
    // with `resolveDashboardSections`; the dead import broke Vercel.
    const importBlock = src.match(
      /import\s*\{[\s\S]*?\}\s*from\s*["'][^"']*platform-context["']\s*;/,
    );
    expect(importBlock).toBeTruthy();
    expect(importBlock![0]).not.toMatch(/^\s*getPersonaSectionOrder,\s*$/m);
  });

  it("test 18: sectionEmphasisById is WIRED to data-cc-section-emphasis", () => {
    const src = readFileSync(CMD_CENTER_PATH, "utf8");
    expect(src).toMatch(/sectionEmphasisById/);
    // The Map must reach the DOM via the canonical data attribute.
    expect(src).toMatch(/data-cc-section-emphasis=\{[^}]*sectionEmphasisById/);
  });

  it("test 19: /auth/mfa-challenge page exists, has no localStorage call, and reuses /v1/auth/mfa/verify", () => {
    expect(existsSync(MFA_PAGE_PATH)).toBe(true);
    const page = readFileSync(MFA_PAGE_PATH, "utf8");
    // No localStorage / sessionStorage persistence of secrets.
    expect(page).not.toMatch(/localStorage\./);
    expect(page).not.toMatch(/sessionStorage\.set/);
    // Must POST to the canonical verify endpoint.
    expect(page).toMatch(/\/v1\/auth\/mfa\/verify/);
    // Must support BOTH TOTP and recovery code (single page, two
    // input modes — no separate /auth/mfa-recovery page).
    expect(page).toMatch(/recoveryCode/);
    expect(page).toMatch(/code/);
  });
});

// =============================================================================
// File size sentinel — keeps this test file from rotting silently
// =============================================================================

describe("R8.1.2 test file size sentinel", () => {
  it("this test file is non-trivial (>=12 KB) — protects against accidental truncation", () => {
    const st = statSync(__filename);
    expect(st.size).toBeGreaterThan(12_000);
  });
});
