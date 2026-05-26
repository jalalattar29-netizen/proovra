/**
 * PHASE R8.1 — Real MFA Activation guardrails.
 *
 * R8.1 ships:
 *   - The cryptographic primitives (TOTP, recovery codes, AES-256-GCM
 *     envelope encryption of secrets).
 *   - Prisma schema additions (`MfaFactor`, `MfaRecoveryCode`).
 *   - The R8 event vocabulary is consumed by the primitives' callers.
 *
 * R8.1 explicitly DEFERS to R8.1.1:
 *   - The Prisma-integrated orchestrator service (`mfa.service.ts`).
 *   - The REST endpoints under `/v1/identity-security/mfa/*`.
 *   - Login-flow integration in `auth.routes.ts`.
 *   - Org-policy lockout enforcement migration tooling.
 *
 * The deferral is honest: the orchestrator depends on the generated
 * Prisma client which requires `pnpm prisma generate` after the
 * schema migration is applied. Shipping the orchestrator inside the
 * same phase as the schema is the kind of plumbing surprise R8
 * explicitly avoided.
 *
 * Hard contract pinned here:
 *
 *   1. The 3 pure cryptographic helpers exist + are pure.
 *   2. Schema additions are in place.
 *   3. R8 event vocabulary is unchanged (additive only).
 *   4. No new auth route file introduced.
 *   5. No raw secret / OTP logging in the primitives.
 *   6. Capture / custody / TSA / report files unchanged.
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

const TOTP_SRC = readApi("src/services/security/mfa-totp.ts");
const RECOVERY_SRC = readApi("src/services/security/mfa-recovery.ts");
const SECRET_SRC = readApi("src/services/security/mfa-secret-storage.ts");
const SCHEMA = readApi("prisma/schema.prisma");
const SHARED_SECURITY = readFileSync(
  fileURLToPath(
    new URL(`../../../packages/shared/src/security.ts`, import.meta.url),
  ),
  "utf8",
);

// =============================================================================
// PART 1 — Pure primitives exist + use only Node built-in crypto
// =============================================================================

describe("R8.1 Part 1 — pure cryptographic primitives", () => {
  it("mfa-totp.ts uses Node built-in crypto (no external TOTP dependency)", () => {
    expect(TOTP_SRC).toMatch(/from\s+["']node:crypto["']/);
    expect(TOTP_SRC).not.toMatch(/from\s+["']otplib["']/);
    expect(TOTP_SRC).not.toMatch(/from\s+["']speakeasy["']/);
  });

  it("mfa-recovery.ts uses Node built-in crypto for scrypt hashing", () => {
    expect(RECOVERY_SRC).toMatch(/from\s+["']node:crypto["']/);
    expect(RECOVERY_SRC).toMatch(/scryptSync/);
    expect(RECOVERY_SRC).toMatch(/timingSafeEqual/);
    expect(RECOVERY_SRC).not.toMatch(/from\s+["']bcrypt["']/);
    expect(RECOVERY_SRC).not.toMatch(/from\s+["']argon2["']/);
  });

  it("mfa-secret-storage.ts uses AES-256-GCM with per-encrypt CSPRNG IV", () => {
    expect(SECRET_SRC).toMatch(/aes-256-gcm/);
    expect(SECRET_SRC).toMatch(/randomBytes\(12\)/);
    expect(SECRET_SRC).toMatch(/getAuthTag/);
    expect(SECRET_SRC).toMatch(/setAuthTag/);
  });

  it("all 3 primitives are pure (no fetches, no async I/O)", () => {
    for (const src of [TOTP_SRC, RECOVERY_SRC, SECRET_SRC]) {
      expect(src).not.toMatch(/\bfetch\(/);
      expect(src).not.toMatch(/\bapiFetch\(/);
      expect(src).not.toMatch(/\basync\s+function\s/);
      expect(src).not.toMatch(/\bawait\b/);
    }
  });
});

// =============================================================================
// PART 2 — TOTP parameter pinning + verification window
// =============================================================================

describe("R8.1 Part 2 — TOTP pinned parameters", () => {
  it("pins SHA-1 / 6 digits / 30 s period", () => {
    expect(TOTP_SRC).toMatch(/TOTP_ALGORITHM\s*=\s*"SHA1"/);
    expect(TOTP_SRC).toMatch(/TOTP_DIGITS\s*=\s*6/);
    expect(TOTP_SRC).toMatch(/TOTP_PERIOD_SECONDS\s*=\s*30/);
  });

  it("pins the ±1-step default verification window", () => {
    expect(TOTP_SRC).toMatch(/TOTP_DEFAULT_WINDOW\s*=\s*1/);
  });
});

// =============================================================================
// PART 3 — Recovery code bound + storage shape
// =============================================================================

describe("R8.1 Part 3 — recovery code contract", () => {
  it("RECOVERY_CODE_BATCH_SIZE is bounded to 10", () => {
    expect(RECOVERY_SRC).toMatch(/RECOVERY_CODE_BATCH_SIZE\s*=\s*10/);
  });

  it("computeLookupHash uses SHA-256 (deterministic O(1) lookup)", () => {
    expect(RECOVERY_SRC).toMatch(/createHash\(["']sha256["']\)/);
  });

  it("buildRecoveryVerifier uses per-row salt (16 bytes random)", () => {
    expect(RECOVERY_SRC).toMatch(/randomBytes\(16\)/);
  });

  it("normalization tolerates user transcription quirks (case + hyphen + whitespace)", () => {
    expect(RECOVERY_SRC).toMatch(/toUpperCase/);
    expect(RECOVERY_SRC).toMatch(/replace\(\/-\/g/);
  });
});

// =============================================================================
// PART 4 — Secret storage: production gate + dev fallback
// =============================================================================

describe("R8.1 Part 4 — secret storage contract", () => {
  it("requires MFA_SECRET_KEK_BASE64 in production (no silent fallback)", () => {
    expect(SECRET_SRC).toMatch(/MFA_SECRET_KEK_BASE64/);
    expect(SECRET_SRC).toMatch(/NODE_ENV === "production"/);
    expect(SECRET_SRC).toMatch(/required in production/i);
  });

  it("never logs the KEK / plaintext / ciphertext", () => {
    expect(SECRET_SRC).not.toMatch(/console\.log\(/);
    expect(SECRET_SRC).not.toMatch(/console\.info\(/);
    expect(SECRET_SRC).not.toMatch(/console\.error\(/);
    expect(SECRET_SRC).not.toMatch(/console\.warn\(/);
  });

  it("KEK env value must decode to 32 bytes (256-bit)", () => {
    expect(SECRET_SRC).toMatch(/decoded\.length !== 32/);
    expect(SECRET_SRC).toMatch(/32 bytes/);
  });
});

// =============================================================================
// PART 5 — Schema additions present
// =============================================================================

describe("R8.1 Part 5 — Prisma schema additions", () => {
  it("MfaFactor model is defined with the canonical fields", () => {
    expect(SCHEMA).toMatch(/model MfaFactor \{/);
    expect(SCHEMA).toMatch(/secretCiphertext\s+Bytes/);
    expect(SCHEMA).toMatch(/secretIv\s+Bytes/);
    expect(SCHEMA).toMatch(/secretAuthTag\s+Bytes/);
    expect(SCHEMA).toMatch(/secretKekId\s+String/);
    expect(SCHEMA).toMatch(/algorithm\s+String\s+@default\("SHA1"\)/);
    expect(SCHEMA).toMatch(/digits\s+Int\s+@default\(6\)/);
    expect(SCHEMA).toMatch(/periodSeconds\s+Int\s+@default\(30\)/);
  });

  it("MfaRecoveryCode model is defined with deterministic-lookup + scrypt-verifier fields", () => {
    expect(SCHEMA).toMatch(/model MfaRecoveryCode \{/);
    expect(SCHEMA).toMatch(/codeLookupHash\s+String/);
    expect(SCHEMA).toMatch(/codeVerifier\s+Bytes/);
    expect(SCHEMA).toMatch(/codeVerifierSalt\s+Bytes/);
    expect(SCHEMA).toMatch(/batchId\s+String/);
    expect(SCHEMA).toMatch(/usedAt\s+DateTime\?/);
    expect(SCHEMA).toMatch(/batchInvalidatedAt\s+DateTime\?/);
  });

  it("MfaFactorStatus + MfaFactorKind enums defined", () => {
    expect(SCHEMA).toMatch(/enum MfaFactorStatus\s*\{[\s\S]{0,200}ENROLLING/);
    expect(SCHEMA).toMatch(/enum MfaFactorStatus[\s\S]{0,200}ACTIVE/);
    expect(SCHEMA).toMatch(/enum MfaFactorStatus[\s\S]{0,200}REVOKED/);
    expect(SCHEMA).toMatch(/enum MfaFactorKind\s*\{[\s\S]{0,80}TOTP/);
  });

  it("User has back-relations to MfaFactor + MfaRecoveryCode", () => {
    expect(SCHEMA).toMatch(/mfaFactors\s+MfaFactor\[\]/);
    expect(SCHEMA).toMatch(/mfaRecoveryCodes\s+MfaRecoveryCode\[\]/);
  });
});

// =============================================================================
// PART 6 — R8 event vocabulary still in place (no regression)
// =============================================================================

describe("R8.1 Part 6 — R8 event vocabulary intact", () => {
  const R8_MFA_EVENTS = [
    "mfa_enrollment_started",
    "mfa_enrollment_completed",
    "mfa_factor_added",
    "mfa_factor_removed",
    "mfa_verification_succeeded",
    "mfa_verification_failed",
  ];

  for (const event of R8_MFA_EVENTS) {
    it(`SECURITY_EVENT_TYPES still includes ${event}`, () => {
      expect(SHARED_SECURITY).toMatch(new RegExp(`"${event}"`));
    });
  }
});

// =============================================================================
// PART 7 — No parallel auth surfaces / no half-built orchestrator
// =============================================================================

describe("R8.1 Part 7 — bounded surface area (R8.1.1-aware)", () => {
  it("no parallel auth route file introduced (mfa.routes.ts is an identity sub-domain shipped by R8.1.1, NOT a parallel auth system)", () => {
    const forbiddenFiles = [
      "src/routes/auth2.routes.ts",
      "src/routes/auth-v2.routes.ts",
      "src/routes/totp.routes.ts",
    ];
    for (const rel of forbiddenFiles) {
      expect(
        existsSync(apiPath(rel)),
        `Forbidden parallel auth route file ${rel}`,
      ).toBe(false);
    }
  });

  it("R8.1.1 added the canonical orchestrator + REST surface (R8.1 deferral resolved)", () => {
    // R8.1 deferred these pending `pnpm prisma generate` after the
    // schema migration applied. R8.1.1 shipped them once the
    // generated Prisma client exposed `mfaFactor` + `mfaRecoveryCode`.
    expect(existsSync(apiPath("src/services/security/mfa.service.ts"))).toBe(
      true,
    );
    expect(existsSync(apiPath("src/routes/mfa.routes.ts"))).toBe(true);
  });

  it("canonical auth route files preserved in size (no R8.1 modification, R8.1.2 rebaselined)", () => {
    // R8.1.2 deliberately grew auth.routes.ts (login-MFA gate +
    // verify endpoint + pending-cookie helpers) and sso-auth.routes.ts
    // (OIDC MFA branch). Both baselines bumped accordingly so this
    // pin still detects further drift but accepts R8.1.2's known
    // additions.
    const PINS: ReadonlyArray<{ rel: string; expectedBytes: number }> = [
      // R8.1.9 rebaselined: +session-light endpoint added in R8.1.9 Part 1.
      // Phase E10.1 rebaselined: +per-IP rate limit on login +
      // password-reset (DEF-037 closure).
      { rel: "src/routes/auth.routes.ts", expectedBytes: 42051 },
      { rel: "src/routes/sso-auth.routes.ts", expectedBytes: 18565 },
      { rel: "src/routes/identity.routes.ts", expectedBytes: 31353 },
      {
        rel: "src/routes/identity-security.routes.ts",
        expectedBytes: 18952,
      },
      { rel: "src/routes/scim.routes.ts", expectedBytes: 11446 },
    ];
    for (const { rel, expectedBytes } of PINS) {
      const st = statSync(apiPath(rel));
      const low = Math.floor(expectedBytes * 0.95);
      const high = Math.ceil(expectedBytes * 1.05);
      expect(
        st.size,
        `${rel} drifted out of R8 baseline window [${low}, ${high}]. R8.1 must NOT modify canonical auth routes.`,
      ).toBeGreaterThanOrEqual(low);
      expect(st.size).toBeLessThanOrEqual(high);
    }
  });
});

// =============================================================================
// PART 8 — No raw secret/OTP logging in primitives
// =============================================================================

describe("R8.1 Part 8 — no raw secret/OTP logging in primitives", () => {
  it("mfa-totp does not console-log the secret or user code", () => {
    expect(TOTP_SRC).not.toMatch(/console\.log\(/);
    expect(TOTP_SRC).not.toMatch(/console\.info\(/);
    expect(TOTP_SRC).not.toMatch(/console\.warn\(/);
  });

  it("mfa-recovery does not console-log raw codes", () => {
    expect(RECOVERY_SRC).not.toMatch(/console\.log\(/);
    expect(RECOVERY_SRC).not.toMatch(/console\.info\(/);
    expect(RECOVERY_SRC).not.toMatch(/console\.warn\(/);
  });

  it("mfa-secret-storage does not console-log KEK / plaintext / ciphertext", () => {
    expect(SECRET_SRC).not.toMatch(/console\.log\(/);
    expect(SECRET_SRC).not.toMatch(/console\.info\(/);
    expect(SECRET_SRC).not.toMatch(/console\.warn\(/);
  });
});

// =============================================================================
// PART 9 — Documentation present + substantial
// =============================================================================

describe("R8.1 Part 9 — R8.1 documentation present", () => {
  const doc = readRepo("docs/security/R8_1_REAL_MFA.md");

  it("R8.1 doc exists and covers the required sections", () => {
    expect(doc.length).toBeGreaterThan(6000);
    expect(doc).toMatch(/PHASE R8\.1/);
    expect(doc).toMatch(/factor model/i);
    expect(doc).toMatch(/TOTP/i);
    expect(doc).toMatch(/recovery/i);
    expect(doc).toMatch(/trusted[-\s]device/i);
    expect(doc).toMatch(/migration/i);
    expect(doc).toMatch(/Remaining risks/i);
  });

  it("R8.1 doc honestly names the R8.1.1 deferral", () => {
    expect(doc).toMatch(/R8\.1\.1/);
  });
});

// =============================================================================
// PART 10 — Capture / custody / TSA / report / package unchanged
// =============================================================================

describe("R8.1 Part 10 — canonical capture/custody/TSA/report files unchanged", () => {
  const PINS: ReadonlyArray<{ rel: string; expectedBytes: number }> = [
    { rel: "src/routes/capture.routes.ts", expectedBytes: 18308 },
    { rel: "src/services/evidence-complete.service.ts", expectedBytes: 41849 },
    { rel: "src/services/custody-events.service.ts", expectedBytes: 4446 },
    { rel: "src/services/timestamp.service.ts", expectedBytes: 6033 },
    {
      rel: "src/services/reports/reports-aggregator.service.ts",
      expectedBytes: 13118,
    },
  ];

  for (const { rel, expectedBytes } of PINS) {
    it(`${rel} is within ±10% of the CR1.5 baseline`, () => {
      const st = statSync(apiPath(rel));
      const low = Math.floor(expectedBytes * 0.9);
      const high = Math.ceil(expectedBytes * 1.1);
      expect(
        st.size,
        `${rel} size ${st.size} drifted out of window [${low}, ${high}]`,
      ).toBeGreaterThanOrEqual(low);
      expect(st.size).toBeLessThanOrEqual(high);
    });
  }
});
