/**
 * PHASE R8.1 — Real MFA: RFC 6238 TOTP unit tests.
 *
 * Pure-function tests — no Prisma, no DB. Validates the RFC 6238
 * implementation against the reference test vectors from the RFC
 * itself (Appendix B) and against round-trip Base32 + verification
 * window correctness.
 */

import { describe, expect, it } from "vitest";

import {
  buildOtpauthUri,
  computeTotpCode,
  decodeBase32,
  encodeBase32,
  generateTotpSecretBytes,
  TOTP_ALGORITHM,
  TOTP_DEFAULT_WINDOW,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  timeStep,
  verifyTotpCode,
} from "../src/services/security/mfa-totp.js";

// =============================================================================
// PART 1 — Bounded RFC parameters
// =============================================================================

describe("R8.1 TOTP — pinned RFC parameters", () => {
  it("uses SHA-1 / 6 digits / 30 s period (universal authenticator compatibility)", () => {
    expect(TOTP_ALGORITHM).toBe("SHA1");
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_PERIOD_SECONDS).toBe(30);
  });

  it("verification window is ±1 step (30 s skew tolerance)", () => {
    expect(TOTP_DEFAULT_WINDOW).toBe(1);
  });
});

// =============================================================================
// PART 2 — Base32 round-trip (RFC 4648)
// =============================================================================

describe("R8.1 TOTP — RFC 4648 Base32 round-trip", () => {
  it("encodes + decodes the empty buffer", () => {
    expect(encodeBase32(Buffer.alloc(0))).toBe("");
    expect(decodeBase32("").length).toBe(0);
  });

  it("encodes the RFC 4648 test vector 'foobar'", () => {
    // RFC 4648 §10 — "foobar" → "MZXW6YTBOI======" (with padding)
    expect(encodeBase32(Buffer.from("foobar", "utf8"))).toBe("MZXW6YTBOI");
  });

  it("round-trips arbitrary 20-byte secrets", () => {
    for (let i = 0; i < 50; i += 1) {
      const original = generateTotpSecretBytes();
      const encoded = encodeBase32(original);
      const decoded = decodeBase32(encoded);
      expect(decoded.equals(original)).toBe(true);
    }
  });

  it("decoder tolerates case + whitespace + padding", () => {
    expect(decodeBase32("mzxw 6ytb oi==")).toEqual(
      Buffer.from("foobar", "utf8"),
    );
  });

  it("decoder rejects invalid characters", () => {
    expect(() => decodeBase32("MZXW@YTBOI")).toThrowError(
      /invalid_base32_character/,
    );
  });
});

// =============================================================================
// PART 3 — RFC 6238 reference vectors (Appendix B)
// =============================================================================

describe("R8.1 TOTP — RFC 6238 Appendix B reference vectors (SHA-1)", () => {
  // RFC 6238 Appendix B test vectors. The SHA-1 secret is the
  // ASCII string "12345678901234567890" (20 bytes).
  const RFC_SECRET = Buffer.from("12345678901234567890", "utf8");
  const VECTORS = [
    { t: 59, expected: "94287082" },
    { t: 1111111109, expected: "07081804" },
    { t: 1111111111, expected: "14050471" },
    { t: 1234567890, expected: "89005924" },
    { t: 2000000000, expected: "69279037" },
    { t: 20000000000, expected: "65353130" },
  ] as const;

  for (const { t, expected } of VECTORS) {
    it(`SHA-1 / 8 digits / t=${t} → ${expected}`, () => {
      const step = timeStep(t, 30);
      const code = computeTotpCode(RFC_SECRET, step, 8);
      expect(code).toBe(expected);
    });
  }

  it("the same vectors truncated to 6 digits match the last 6 of the 8-digit form", () => {
    for (const { t, expected } of VECTORS) {
      const step = timeStep(t, 30);
      const code = computeTotpCode(RFC_SECRET, step, 6);
      expect(code).toBe(expected.slice(-6));
    }
  });
});

// =============================================================================
// PART 4 — Verification window behavior
// =============================================================================

describe("R8.1 TOTP — verification window behavior", () => {
  const secret = Buffer.from("12345678901234567890", "utf8");
  const nowSeconds = 1234567890;
  const currentStep = timeStep(nowSeconds, 30);

  it("accepts the current-step code", () => {
    const code = computeTotpCode(secret, currentStep, 6);
    expect(verifyTotpCode(secret, code, { nowSeconds })).toBe(true);
  });

  it("accepts the previous-step code (clock skew)", () => {
    const code = computeTotpCode(secret, currentStep - 1, 6);
    expect(verifyTotpCode(secret, code, { nowSeconds })).toBe(true);
  });

  it("accepts the next-step code (clock skew)", () => {
    const code = computeTotpCode(secret, currentStep + 1, 6);
    expect(verifyTotpCode(secret, code, { nowSeconds })).toBe(true);
  });

  it("rejects a code from 2 steps in the past (outside default window)", () => {
    const code = computeTotpCode(secret, currentStep - 2, 6);
    expect(verifyTotpCode(secret, code, { nowSeconds })).toBe(false);
  });

  it("rejects a code from 2 steps in the future (outside default window)", () => {
    const code = computeTotpCode(secret, currentStep + 2, 6);
    expect(verifyTotpCode(secret, code, { nowSeconds })).toBe(false);
  });

  it("rejects an obviously wrong code", () => {
    expect(verifyTotpCode(secret, "000000", { nowSeconds })).toBe(false);
  });

  it("rejects empty / non-numeric / wrong-length input safely", () => {
    expect(verifyTotpCode(secret, "", { nowSeconds })).toBe(false);
    expect(verifyTotpCode(secret, "12345", { nowSeconds })).toBe(false);
    expect(verifyTotpCode(secret, "12345a", { nowSeconds })).toBe(false);
    expect(verifyTotpCode(secret, "abcdef", { nowSeconds })).toBe(false);
    expect(verifyTotpCode(secret, "1234567", { nowSeconds })).toBe(false);
  });

  it("strips whitespace from user input before verifying", () => {
    const code = computeTotpCode(secret, currentStep, 6);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotpCode(secret, spaced, { nowSeconds })).toBe(true);
  });
});

// =============================================================================
// PART 5 — Secret generation entropy
// =============================================================================

describe("R8.1 TOTP — secret generation", () => {
  it("generateTotpSecretBytes returns 20 bytes (RFC 6238 reference length)", () => {
    expect(generateTotpSecretBytes().length).toBe(20);
  });

  it("two consecutive calls produce different secrets", () => {
    const a = generateTotpSecretBytes();
    const b = generateTotpSecretBytes();
    expect(a.equals(b)).toBe(false);
  });
});

// =============================================================================
// PART 6 — otpauth URI shape
// =============================================================================

describe("R8.1 TOTP — otpauth URI shape", () => {
  const secret = Buffer.from("12345678901234567890", "utf8");

  it("uri matches the Key Uri Format with all required params", () => {
    const uri = buildOtpauthUri({
      secret,
      issuer: "PROOVRA",
      accountName: "alice@example.com",
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("PROOVRA");
    expect(uri).toContain("alice%40example.com");
    expect(uri).toContain("secret=");
    expect(uri).toContain("issuer=PROOVRA");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });

  it("uri's Base32 secret round-trips to the original bytes", () => {
    const uri = buildOtpauthUri({
      secret,
      issuer: "PROOVRA",
      accountName: "alice",
    });
    const match = uri.match(/secret=([A-Z0-9=]+)/);
    expect(match).toBeTruthy();
    const decoded = decodeBase32(match![1]);
    expect(decoded.equals(secret)).toBe(true);
  });
});
