/**
 * PHASE R8.1.1 — MFA Orchestrator + REST + Step-Up integration guardrails.
 *
 * R8.1 shipped the cryptographic foundation + schema. R8.1.1 ships
 * the Prisma-integrated orchestrator + 6 REST endpoints + the R8.1
 * migration SQL file + server registration. Login-flow integration
 * (after password / OIDC, require MFA challenge before issuing the
 * full session) is honestly DEFERRED to R8.1.2 — touching
 * auth.routes.ts in the same phase as the orchestrator + REST is
 * the kind of plumbing surprise R8 explicitly avoided.
 *
 * Hard contract pinned here:
 *
 *   1. Prisma migration file present.
 *   2. Orchestrator service composes the R8.1 pure helpers.
 *   3. REST surface exposes the 6 canonical endpoints under
 *      /v1/identity/mfa/*.
 *   4. Server registers mfaRoutes.
 *   5. Recovery codes returned ONLY at enrollment-verify + regenerate.
 *   6. Orchestrator emits the bounded R8 events on every transition.
 *   7. Rate limiter present on verify endpoints.
 *   8. No raw secret / OTP / recovery-code logging.
 *   9. Canonical auth files preserved.
 *   10. Capture / custody / TSA / report files unchanged.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function apiPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}
function readApi(rel: string): string {
  return readFileSync(apiPath(rel), "utf8");
}

const ORCH_SRC = readApi("src/services/security/mfa.service.ts");
const ROUTES_SRC = readApi("src/routes/mfa.routes.ts");
const SERVER_SRC = readApi("src/server.ts");
const AUTH_SRC = readApi("src/routes/auth.routes.ts");

// =============================================================================
// PART 1 — Prisma migration present
// =============================================================================

describe("R8.1.1 Part 1 — Prisma migration for R8.1 schema", () => {
  it("migration directory exists", () => {
    const dir = apiPath("prisma/migrations/20260722000000_r8_1_mfa_activation");
    expect(existsSync(dir)).toBe(true);
  });

  it("migration SQL creates the canonical tables + enums", () => {
    const sql = readApi(
      "prisma/migrations/20260722000000_r8_1_mfa_activation/migration.sql",
    );
    expect(sql).toMatch(/CREATE TYPE "MfaFactorStatus"/);
    expect(sql).toMatch(/CREATE TYPE "MfaFactorKind"/);
    expect(sql).toMatch(/CREATE TABLE "mfa_factors"/);
    expect(sql).toMatch(/CREATE TABLE "mfa_recovery_codes"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "mfa_recovery_codes_code_lookup_hash_key"/);
    expect(sql).toMatch(/ON DELETE CASCADE/);
  });

  it("migration is append-only (no DROP / ALTER on existing tables)", () => {
    const sql = readApi(
      "prisma/migrations/20260722000000_r8_1_mfa_activation/migration.sql",
    );
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/ALTER TABLE "users"/i);
    expect(sql).not.toMatch(/ALTER TABLE "step_up_challenges"/i);
    expect(sql).not.toMatch(/ALTER TABLE "trusted_devices"/i);
  });
});

// =============================================================================
// PART 2 — Orchestrator service composes the R8.1 primitives
// =============================================================================

describe("R8.1.1 Part 2 — orchestrator composes R8.1 helpers", () => {
  it("imports the R8.1 TOTP + recovery + secret-storage helpers", () => {
    expect(ORCH_SRC).toMatch(/from\s+["']\.\/mfa-totp\.js["']/);
    expect(ORCH_SRC).toMatch(/from\s+["']\.\/mfa-recovery\.js["']/);
    expect(ORCH_SRC).toMatch(/from\s+["']\.\/mfa-secret-storage\.js["']/);
  });

  it("exposes the canonical orchestrator entry points", () => {
    expect(ORCH_SRC).toMatch(/export async function beginTotpEnrollment/);
    expect(ORCH_SRC).toMatch(/export async function verifyAndActivateEnrollment/);
    expect(ORCH_SRC).toMatch(/export async function verifyActiveTotp/);
    expect(ORCH_SRC).toMatch(/export async function revokeFactor/);
    expect(ORCH_SRC).toMatch(/export async function consumeRecoveryCode/);
    expect(ORCH_SRC).toMatch(/export async function regenerateRecoveryBatch/);
    expect(ORCH_SRC).toMatch(/export async function readMfaStatus/);
  });

  it("emits the bounded R8 vocabulary via safeEmitSecurityEvent", () => {
    expect(ORCH_SRC).toMatch(/safeEmitSecurityEvent/);
    for (const event of [
      "mfa_enrollment_started",
      "mfa_enrollment_completed",
      "mfa_factor_added",
      "mfa_factor_removed",
      "mfa_verification_succeeded",
      "mfa_verification_failed",
    ]) {
      expect(ORCH_SRC).toMatch(new RegExp(`"${event}"`));
    }
  });

  it("activation requires a successful TOTP verify (no auto-activate)", () => {
    // The activation transition (status=ACTIVE) MUST happen only
    // after a successful verifyTotpCode. We check structurally that
    // BOTH primitives are present AND that the negation branch
    // (if (!verifyTotpCode(...))) returns early without setting
    // ACTIVE. This is the canonical no-auto-activate shape.
    expect(ORCH_SRC).toMatch(/verifyTotpCode\(/);
    expect(ORCH_SRC).toMatch(/status:\s*"ACTIVE"/);
    expect(ORCH_SRC).toMatch(
      /if\s*\(\s*!verifyTotpCode\([^)]+\)\s*\)\s*\{[\s\S]{0,600}return\s*\{\s*ok:\s*false/,
    );
  });

  it("recovery codes inserted in the same transaction as factor activation", () => {
    expect(ORCH_SRC).toMatch(/prisma\.\$transaction\([\s\S]{0,500}mfaRecoveryCode\.createMany/);
  });

  it("regenerate invalidates the previous batch atomically", () => {
    expect(ORCH_SRC).toMatch(
      /mfaRecoveryCode\.updateMany[\s\S]{0,400}batchInvalidatedAt[\s\S]{0,400}mfaRecoveryCode\.createMany/,
    );
  });

  it("readMfaStatus does NOT return secrets / verifiers / lookup hashes", () => {
    // Validate the `select` shape — only safe metadata columns are
    // projected to the response.
    const selectMatch = ORCH_SRC.match(
      /readMfaStatus[\s\S]*?prisma\.mfaFactor\.findMany\(\{[\s\S]*?select:\s*\{([\s\S]*?)\}/,
    );
    expect(selectMatch).toBeTruthy();
    const select = selectMatch![1];
    expect(select).not.toMatch(/secretCiphertext/);
    expect(select).not.toMatch(/secretIv/);
    expect(select).not.toMatch(/secretAuthTag/);
  });
});

// =============================================================================
// PART 3 — REST surface registers the 6 endpoints
// =============================================================================

describe("R8.1.1 Part 3 — REST endpoints registered", () => {
  it("exposes the 6 canonical MFA endpoints under /v1/identity/mfa/*", () => {
    expect(ROUTES_SRC).toMatch(/app\.get\(\s*"\/v1\/identity\/mfa\/factors"/);
    expect(ROUTES_SRC).toMatch(/app\.post\(\s*"\/v1\/identity\/mfa\/enroll\/start"/);
    expect(ROUTES_SRC).toMatch(
      /app\.post\(\s*"\/v1\/identity\/mfa\/enroll\/verify"/,
    );
    // R8.1.2 introduced an optional generic param on app.delete (for
    // typed Params); the regex tolerates an optional `<...>` between
    // the method and the opening paren.
    expect(ROUTES_SRC).toMatch(
      /app\.delete(?:<[^>]+>)?\(\s*"\/v1\/identity\/mfa\/factors\/:id"/,
    );
    expect(ROUTES_SRC).toMatch(
      /app\.post\(\s*"\/v1\/identity\/mfa\/recovery-codes\/regenerate"/,
    );
    expect(ROUTES_SRC).toMatch(
      /app\.post\(\s*"\/v1\/identity\/mfa\/challenge\/verify"/,
    );
  });

  it("every endpoint requires authentication via the canonical requireAuth preHandler", () => {
    const preHandlerCount =
      (ROUTES_SRC.match(/preHandler:\s*requireAuth/g) ?? []).length;
    // 6 endpoints × 1 preHandler each.
    expect(preHandlerCount).toBeGreaterThanOrEqual(6);
  });

  it("server.ts registers mfaRoutes", () => {
    expect(SERVER_SRC).toMatch(/import\s*\{\s*mfaRoutes\s*\}/);
    expect(SERVER_SRC).toMatch(/app\.register\(mfaRoutes\)/);
  });

  it("inputs go through bounded zod validation", () => {
    expect(ROUTES_SRC).toMatch(/EnrollStartBody/);
    expect(ROUTES_SRC).toMatch(/EnrollVerifyBody/);
    expect(ROUTES_SRC).toMatch(/ChallengeVerifyBody/);
    expect(ROUTES_SRC).toMatch(/z\.string\(\)\.min\(6\)/);
  });
});

// =============================================================================
// PART 4 — Recovery codes returned ONLY at enrollment-verify + regenerate
// =============================================================================

describe("R8.1.1 Part 4 — recovery codes surfaced only at issuance", () => {
  it("verify-enroll endpoint returns recoveryCodes (one-time)", () => {
    // The enroll/verify handler must return the plaintext recovery
    // codes. Accept either `result.recoveryCodes` or another local
    // variable name — the contract is the response field name.
    expect(ROUTES_SRC).toMatch(
      /enroll\/verify[\s\S]{0,2000}recoveryCodes:\s*\w+\.recoveryCodes/,
    );
  });

  it("regenerate endpoint returns recoveryCodes (one-time)", () => {
    expect(ROUTES_SRC).toMatch(
      // Window widened 2026-07-16: the step-up enforcement block now sits
      // between the route path and the one-time return (contract unchanged).
      /recovery-codes\/regenerate[\s\S]{0,1800}recoveryCodes:\s*\w+\.recoveryCodes/,
    );
  });

  it("factors endpoint (status) does NOT return recoveryCodes plaintext", () => {
    // The factors endpoint returns readMfaStatus output, which only
    // includes a `recoveryCodesRemaining` count — never the codes.
    expect(ORCH_SRC).toMatch(/recoveryCodesRemaining:/);
    const statusReturnBlock = ORCH_SRC.match(
      /readMfaStatus[\s\S]*?return\s*\{([\s\S]*?)\};/,
    );
    expect(statusReturnBlock).toBeTruthy();
    expect(statusReturnBlock![1]).not.toMatch(/recoveryCodes:/);
  });
});

// =============================================================================
// PART 5 — Rate limiting on verify endpoints
// =============================================================================

describe("R8.1.1 Part 5 — rate limiting on verify endpoints", () => {
  it("declares a bounded per-window attempt cap", () => {
    expect(ROUTES_SRC).toMatch(/ATTEMPT_MAX\s*=\s*5/);
    expect(ROUTES_SRC).toMatch(/ATTEMPT_WINDOW_MS\s*=\s*60_000/);
  });

  it("enroll-verify checks the rate limiter and returns 429 when exceeded", () => {
    expect(ROUTES_SRC).toMatch(
      /enroll\/verify[\s\S]{0,600}isRateLimited[\s\S]{0,400}reply\.code\(429\)/,
    );
  });

  it("challenge-verify checks the rate limiter and returns 429 when exceeded", () => {
    expect(ROUTES_SRC).toMatch(
      /challenge\/verify[\s\S]{0,600}isRateLimited[\s\S]{0,400}reply\.code\(429\)/,
    );
  });

  it("rate-limit hits emit mfa_verification_failed with reason=rate_limited", () => {
    expect(ROUTES_SRC).toMatch(
      /isRateLimited[\s\S]{0,400}reason:\s*"rate_limited"/,
    );
  });
});

// =============================================================================
// PART 6 — No raw secret / OTP / recovery code logging
// =============================================================================

describe("R8.1.1 Part 6 — no raw secret / OTP / recovery-code logging", () => {
  const SWEEP = [
    { name: "orchestrator", src: ORCH_SRC },
    { name: "routes", src: ROUTES_SRC },
  ];

  const FORBIDDEN_LOG_PATTERNS: ReadonlyArray<RegExp> = [
    /console\.log\([^)]*\bsecret\b[^)]*\)/i,
    /console\.log\([^)]*\bcode\b[^)]*\)/i,
    /console\.log\([^)]*\botp\b[^)]*\)/i,
    /console\.log\([^)]*\brecoveryCode\b[^)]*\)/i,
    /console\.log\([^)]*\bcodeVerifier\b[^)]*\)/i,
    /console\.log\([^)]*\bsecretCiphertext\b[^)]*\)/i,
    /\.info\([^)]*\bsecret\b[^)]*\)/i,
    /\.warn\([^)]*\bsecret\b[^)]*\)/i,
    /\.error\([^)]*\bsecret\b[^)]*\)/i,
  ];

  for (const { name, src } of SWEEP) {
    it(`${name} carries no raw-secret logging anti-patterns`, () => {
      for (const pattern of FORBIDDEN_LOG_PATTERNS) {
        expect(src, `${name} matches ${pattern}`).not.toMatch(pattern);
      }
    });
  }

  it("orchestrator never emits the raw `code` in security-event details", () => {
    // The orchestrator should NEVER place `code: input.code` in the
    // emitted details (only `context`, `factorId`, `reason`).
    expect(ORCH_SRC).not.toMatch(/details:\s*\{[^}]*\bcode:\s*input\.code/);
    expect(ORCH_SRC).not.toMatch(/details:\s*\{[^}]*\brecoveryCode:/);
  });
});

// =============================================================================
// PART 7 — R8.1.2 FLIPPED: login flow IS now wired to the orchestrator
// =============================================================================

describe("R8.1.2 Part 7 — login flow integration LIVE (was deferred in R8.1.1)", () => {
  it("auth.routes.ts size is at the R8.1.2 baseline (±5%)", () => {
    const st = statSync(apiPath("src/routes/auth.routes.ts"));
    // Re-baselined for R8.1.3's durable-challenge gate + ENROLLMENT_REQUIRED
    // branch. R8.1.9 further rebaselined: +session-light endpoint.
    // Phase E10.1 rebaselined: +per-IP rate limit on login +
    // password-reset (DEF-037 closure).
    // Rebaselined post-G3.x/G4/G5 — auth.routes.ts grew.
    // Phase EV rebaselined: enterprise email verification — verify +
    // resend + register-dispatch logic was extracted into
    // email-verification.service.ts (saves ~5.3 KB) before this bump,
    // so the residual growth reflects the irreducible HTTP-layer cost
    // of the new flow.
    // PHASE 10 (2026-07-23) rebaselined 60497→56683: Guest Login was PHYSICALLY
    // DELETED — the /v1/auth/guest route + handler + guest comments were removed.
    const expected = 56683;
    const low = Math.floor(expected * 0.95);
    const high = Math.ceil(expected * 1.05);
    expect(st.size).toBeGreaterThanOrEqual(low);
    expect(st.size).toBeLessThanOrEqual(high);
  });

  it("auth.routes.ts imports the MFA orchestrator + reuses verifyActiveTotp / consumeRecoveryCode", () => {
    expect(AUTH_SRC).toMatch(/from\s+["'][^"']*\/mfa\.service/);
    expect(AUTH_SRC).toMatch(/\bverifyActiveTotp\b/);
    expect(AUTH_SRC).toMatch(/\bconsumeRecoveryCode\b/);
    expect(AUTH_SRC).toMatch(/\breadMfaStatus\b/);
  });

  it("R8.1.1 doc still references the R8.1.2 plan for traceability", () => {
    const doc = readRepo("docs/security/R8_1_1_MFA_ORCHESTRATOR.md");
    expect(doc).toMatch(/R8\.1\.2/);
    expect(doc).toMatch(/login flow/i);
  });
});

// =============================================================================
// PART 8 — Step-up consistency: same factor model
// =============================================================================

describe("R8.1.1 Part 8 — step-up uses the same factor model", () => {
  it("challenge-verify endpoint accepts EITHER TOTP code OR recovery code", () => {
    expect(ROUTES_SRC).toMatch(/ChallengeVerifyBody/);
    expect(ROUTES_SRC).toMatch(/code:\s*z\.string/);
    expect(ROUTES_SRC).toMatch(/recoveryCode:\s*z\.string/);
  });

  it("challenge-verify dispatches to the canonical orchestrator (no duplicate verify logic)", () => {
    expect(ROUTES_SRC).toMatch(/verifyActiveTotp/);
    expect(ROUTES_SRC).toMatch(/consumeRecoveryCode/);
  });

  /**
   * PHASE 12B ACCEPTANCE — this test used to be a byte-size pin ALONE, which
   * made it a proxy for the invariant rather than a check of it: it fires on any
   * growth, including growth that strengthens enforcement, and it would NOT fire
   * if someone added a parallel step-up implementation while deleting an equal
   * number of bytes elsewhere. The invariant is now asserted directly, and the
   * size pin is kept only as a secondary drift detector.
   */
  it("identity-security.routes.ts has NO parallel step-up authority", () => {
    // NOTE: the file-level `ROUTES_SRC` is mfa.routes.ts. This test is about a
    // DIFFERENT file, so it reads its own source explicitly.
    const IDSEC_SRC = readApi("src/routes/identity-security.routes.ts");
    // 1. Every gate in this file delegates to the ONE canonical middleware.
    expect(IDSEC_SRC).toMatch(/requireStepUpForSensitiveAction\(/);
    // 2. Start/check delegate to the canonical challenge service — the file
    //    does not re-implement the lifecycle.
    expect(IDSEC_SRC).toMatch(/startStepUpChallenge\(/);
    expect(IDSEC_SRC).toMatch(/checkStepUpChallenge\(/);
    // 3. THE ACTUAL INVARIANT: this file never approves or consumes a
    //    challenge itself. `consumeApprovedChallenge` is the single-use consume
    //    authority and belongs to step-up.service.ts; an APPROVED/CANCELLED
    //    write here would be a second authority over elevation.
    expect(IDSEC_SRC).not.toMatch(/consumeApprovedChallenge/);
    expect(IDSEC_SRC).not.toMatch(/StepUpChallengeStatus\.APPROVED/);
    expect(IDSEC_SRC).not.toMatch(/StepUpChallengeStatus\.CANCELLED/);
    // The ONLY permitted direct write to the challenge table here is the
    // operator/cron TTL sweep, which expires PENDING rows and can never grant
    // elevation. Pin it to exactly that transition so a future edit cannot
    // widen it into an approval path.
    const challengeWrites =
      // `updateMany` FIRST — regex alternation is ordered, so a leading
      // `update` would match the prefix and mask the real method name.
      IDSEC_SRC.match(/stepUpChallenge\.(?:updateMany|create|update|upsert|delete)/g) ?? [];
    expect(challengeWrites).toEqual(["stepUpChallenge.updateMany"]);
    expect(IDSEC_SRC).toMatch(
      /status:\s*prismaPkg\.StepUpChallengeStatus\.PENDING[\s\S]{0,220}?status:\s*prismaPkg\.StepUpChallengeStatus\.EXPIRED/,
    );
  });

  it("identity-security.routes.ts size has not drifted from its canonical baseline", () => {
    const st = statSync(apiPath("src/routes/identity-security.routes.ts"));
    // Historical baselines: 18952 (R8.1.1) → 30979 (Final Closure Part D) →
    // 35440 (2026-07-16 account step-up on revoke-others; 2026-07-17 single
    // own-session revoke).
    // Rebaselined 2026-07-30 (PHASE 12B Identity/Security closure) to 48524.
    // The +13KB is ENFORCEMENT, not surface area, and the invariant test above
    // proves no step-up authority was added:
    //   * devices/trust: the device secret is now server-derived from an
    //     HTTP-only cookie this route mints (was client-supplied), the subject
    //     is self-only, and it gained authorizeOrFail + target-bound step-up;
    //   * risk/user/:id: gained target membership verification + concealed 404
    //     (previously accepted any user id);
    //   * reconcile: gained an operator path (authorize + step-up), workspace
    //     scoping so an operator cannot trigger a platform-wide sweep, and one
    //     transaction around both sweeps;
    //   * my-sessions: sessionIdHash removed from the projection;
    //   * one new read (session-policy-impact) computed server-side.
    const expected = 48524;
    const low = Math.floor(expected * 0.95);
    const high = Math.ceil(expected * 1.05);
    expect(st.size).toBeGreaterThanOrEqual(low);
    expect(st.size).toBeLessThanOrEqual(high);
  });
});

// =============================================================================
// PART 9 — R8.1.1 documentation
// =============================================================================

describe("R8.1.1 Part 9 — documentation present", () => {
  const doc = readRepo("docs/security/R8_1_1_MFA_ORCHESTRATOR.md");

  it("R8.1.1 doc covers the required sections", () => {
    expect(doc.length).toBeGreaterThan(5000);
    expect(doc).toMatch(/PHASE R8\.1\.1/);
    expect(doc).toMatch(/Prisma generate/i);
    expect(doc).toMatch(/orchestrator/i);
    expect(doc).toMatch(/endpoint/i);
    expect(doc).toMatch(/rate limit/i);
    expect(doc).toMatch(/Remaining risks/i);
  });

  it("doc surfaces the bounded R8 event vocabulary table", () => {
    for (const event of [
      "mfa_enrollment_started",
      "mfa_enrollment_completed",
      "mfa_factor_added",
      "mfa_factor_removed",
      "mfa_verification_succeeded",
      "mfa_verification_failed",
    ]) {
      expect(doc).toMatch(new RegExp(event));
    }
  });
});

// =============================================================================
// PART 10 — Capture / custody / TSA / report / package unchanged
// =============================================================================
