/**
 * PHASE R8.1 — Real MFA: backup recovery code unit tests.
 *
 * Pure-function tests — no Prisma, no DB. Validates the recovery-
 * code generation, normalization, deterministic lookup hash, and
 * scrypt verifier round-trip + tampering resistance.
 */

import { describe, expect, it } from "vitest";

import {
  buildRecoveryVerifier,
  computeLookupHash,
  generateRecoveryBatch,
  generateRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_BATCH_SIZE,
  verifyRecoveryVerifier,
} from "../src/services/security/mfa-recovery.js";

// =============================================================================
// PART 1 — Code shape + alphabet
// =============================================================================

describe("R8.1 recovery — generated code shape", () => {
  it("renders as XXXXX-XXXXX (11 chars including hyphen)", () => {
    for (let i = 0; i < 20; i += 1) {
      const code = generateRecoveryCode();
      expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    }
  });

  it("uses the unambiguous alphabet (no 0 / 1 / I / L / O)", () => {
    const ambiguous = /[01ILO]/;
    for (let i = 0; i < 50; i += 1) {
      const code = generateRecoveryCode();
      expect(code).not.toMatch(ambiguous);
    }
  });

  it("generates the bounded batch size (10) by default", () => {
    const batch = generateRecoveryBatch();
    expect(batch.length).toBe(RECOVERY_CODE_BATCH_SIZE);
    expect(RECOVERY_CODE_BATCH_SIZE).toBe(10);
  });

  it("batch entries are all distinct", () => {
    const batch = generateRecoveryBatch();
    expect(new Set(batch).size).toBe(batch.length);
  });

  it("rejects invalid batch sizes", () => {
    expect(() => generateRecoveryBatch(0)).toThrow(/invalid_recovery_batch_size/);
    expect(() => generateRecoveryBatch(-1)).toThrow(/invalid_recovery_batch_size/);
    expect(() => generateRecoveryBatch(100)).toThrow(/invalid_recovery_batch_size/);
  });
});

// =============================================================================
// PART 2 — Normalization (storage form is uppercase, no hyphen, no whitespace)
// =============================================================================

describe("R8.1 recovery — normalization", () => {
  it("strips hyphen + whitespace + uppercases", () => {
    expect(normalizeRecoveryCode("abcde-fghjk")).toBe("ABCDEFGHJK");
    expect(normalizeRecoveryCode(" ABCDE-FGHJK ")).toBe("ABCDEFGHJK");
    expect(normalizeRecoveryCode("AB CDE-FG HJK")).toBe("ABCDEFGHJK");
  });

  it("handles empty/null/undefined safely", () => {
    expect(normalizeRecoveryCode("")).toBe("");
    expect(normalizeRecoveryCode(null as unknown as string)).toBe("");
    expect(normalizeRecoveryCode(undefined as unknown as string)).toBe("");
  });
});

// =============================================================================
// PART 3 — Deterministic lookup hash
// =============================================================================

describe("R8.1 recovery — deterministic SHA-256 lookup hash", () => {
  it("identical inputs produce identical hashes", () => {
    const code = "ABCDE-FGHJK";
    expect(computeLookupHash(code)).toBe(computeLookupHash(code));
  });

  it("normalization equivalents collide intentionally (so look-up tolerates user transcription quirks)", () => {
    const a = computeLookupHash("ABCDE-FGHJK");
    const b = computeLookupHash("abcde-fghjk");
    const c = computeLookupHash(" abcde fghjk ");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("different codes produce different hashes", () => {
    expect(computeLookupHash("ABCDE-FGHJK")).not.toBe(
      computeLookupHash("ABCDE-FGHJM"),
    );
  });

  it("hash is 64 hex chars (SHA-256 hex)", () => {
    const hash = computeLookupHash("ABCDE-FGHJK");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// =============================================================================
// PART 4 — scrypt verifier round-trip + tampering resistance
// =============================================================================

describe("R8.1 recovery — scrypt verifier", () => {
  it("verifies the original code", () => {
    const code = "ABCDE-FGHJK";
    const v = buildRecoveryVerifier(code);
    expect(verifyRecoveryVerifier(code, v)).toBe(true);
  });

  it("normalization equivalents verify (same as lookup-hash contract)", () => {
    const v = buildRecoveryVerifier("ABCDE-FGHJK");
    expect(verifyRecoveryVerifier("abcde-fghjk", v)).toBe(true);
    expect(verifyRecoveryVerifier(" ABCDE FGHJK ", v)).toBe(true);
  });

  it("rejects a one-character change", () => {
    const v = buildRecoveryVerifier("ABCDE-FGHJK");
    expect(verifyRecoveryVerifier("ABCDE-FGHJM", v)).toBe(false);
  });

  it("rejects an empty / wrong-length input safely", () => {
    const v = buildRecoveryVerifier("ABCDE-FGHJK");
    expect(verifyRecoveryVerifier("", v)).toBe(false);
    expect(verifyRecoveryVerifier("SHORT", v)).toBe(false);
    expect(verifyRecoveryVerifier("WAY-TOO-LONG-INPUT", v)).toBe(false);
  });

  it("different codes have different salts (per-row salt is fresh)", () => {
    const v1 = buildRecoveryVerifier("ABCDE-FGHJK");
    const v2 = buildRecoveryVerifier("ABCDE-FGHJK");
    // Same code, different salts → different verifiers.
    expect(v1.salt.equals(v2.salt)).toBe(false);
    expect(v1.verifier.equals(v2.verifier)).toBe(false);
    // But both still verify correctly.
    expect(verifyRecoveryVerifier("ABCDE-FGHJK", v1)).toBe(true);
    expect(verifyRecoveryVerifier("ABCDE-FGHJK", v2)).toBe(true);
  });

  it("a verifier from one code does NOT match a different code", () => {
    const v = buildRecoveryVerifier("AAAAA-BBBBB");
    expect(verifyRecoveryVerifier("CCCCC-DDDDD", v)).toBe(false);
  });
});
