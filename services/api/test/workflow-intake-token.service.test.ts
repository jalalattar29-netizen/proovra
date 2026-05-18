/**
 * Phase 4 — token service unit tests.
 *
 * No DB. Tests the HMAC issuance + verification surface in isolation.
 */

import { describe, expect, it } from "vitest";

import {
  __testing,
  constantTimeEqualHex,
  hmacForIntake,
  isWorkflowIntakeFeatureEnabled,
  issueIntakeToken,
  lookupHashForIntakeToken,
  workflowIntakeFeatureDisabledReason,
} from "../src/services/workflow-intake-token.service.js";
import { parseWorkflowIntakeTokenShape } from "@proovra/shared";

const TEST_SECRET = "a".repeat(64); // 64-char hex = 32 bytes

describe("workflow intake token service — feature flag", () => {
  it("reports disabled when no env vars are set", () => {
    expect(isWorkflowIntakeFeatureEnabled()).toBe(false);
    expect(workflowIntakeFeatureDisabledReason()).not.toBeNull();
  });

  it("reports enabled when both flag and secret are configured", () => {
    __testing.withSecret(TEST_SECRET, () => {
      expect(isWorkflowIntakeFeatureEnabled()).toBe(true);
      expect(workflowIntakeFeatureDisabledReason()).toBeNull();
    });
  });

  it("issueIntakeToken returns null when feature is disabled", () => {
    expect(issueIntakeToken()).toBeNull();
  });

  it("hmacForIntake returns null when feature is disabled", () => {
    expect(hmacForIntake("any value")).toBeNull();
  });
});

describe("workflow intake token service — issuance", () => {
  it("issues a token with the wire format pwi_v1_<base64url>", () => {
    __testing.withSecret(TEST_SECRET, () => {
      const issued = issueIntakeToken();
      expect(issued).not.toBeNull();
      const shape = parseWorkflowIntakeTokenShape(issued!.rawToken);
      expect(shape).not.toBeNull();
      expect(shape!.version).toBe(1);
      expect(shape!.body.length).toBeGreaterThan(20);
      expect(issued!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(issued!.tokenVersion).toBe(1);
    });
  });

  it("produces unique tokens on repeated issuance", () => {
    __testing.withSecret(TEST_SECRET, () => {
      const a = issueIntakeToken()!;
      const b = issueIntakeToken()!;
      expect(a.rawToken).not.toBe(b.rawToken);
      expect(a.tokenHash).not.toBe(b.tokenHash);
    });
  });

  it("issuance hash matches lookup hash of the same raw token", () => {
    __testing.withSecret(TEST_SECRET, () => {
      const issued = issueIntakeToken()!;
      const lookup = lookupHashForIntakeToken(issued.rawToken);
      expect(lookup).not.toBeNull();
      expect(lookup!.tokenHash).toBe(issued.tokenHash);
    });
  });
});

describe("workflow intake token service — verification", () => {
  it("rejects a malformed token before any hashing", () => {
    __testing.withSecret(TEST_SECRET, () => {
      expect(lookupHashForIntakeToken("not-a-token")).toBeNull();
      expect(lookupHashForIntakeToken("")).toBeNull();
      // missing version prefix
      expect(lookupHashForIntakeToken("abcdefghijklmnop")).toBeNull();
    });
  });

  it("returns different hashes under different secrets", () => {
    const token = __testing.withSecret(TEST_SECRET, () => issueIntakeToken()!);

    const hashUnderSecretA = __testing.withSecret(TEST_SECRET, () =>
      lookupHashForIntakeToken(token.rawToken),
    );
    const hashUnderSecretB = __testing.withSecret("b".repeat(64), () =>
      lookupHashForIntakeToken(token.rawToken),
    );

    expect(hashUnderSecretA?.tokenHash).toBe(token.tokenHash);
    expect(hashUnderSecretB?.tokenHash).not.toBe(token.tokenHash);
  });
});

describe("constantTimeEqualHex", () => {
  it("returns true for identical 64-char hex strings", () => {
    const h = "f".repeat(64);
    expect(constantTimeEqualHex(h, h)).toBe(true);
  });

  it("returns false for hex strings of different content", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(constantTimeEqualHex(a, b)).toBe(false);
  });

  it("returns false for inputs of incorrect length", () => {
    expect(constantTimeEqualHex("short", "short")).toBe(false);
    expect(constantTimeEqualHex("f".repeat(63), "f".repeat(63))).toBe(false);
  });

  it("returns false for non-hex characters", () => {
    expect(constantTimeEqualHex("z".repeat(64), "z".repeat(64))).toBe(false);
  });
});
