/**
 * Phase 2.7Z+ — Unit tests for the E2E auth rate-limit bypass helper.
 *
 * These tests verify the 3 defense layers of
 * `shouldBypassAuthRateLimit` directly, without needing the API to
 * be running. The full end-to-end behavior is exercised by
 * `e2e/phase2-7z-auth-bypass.spec.ts`.
 *
 * Critical invariants this file locks in:
 *   1. Production NODE_ENV ALWAYS refuses the bypass, regardless
 *      of env + header.
 *   2. Missing or short env secret refuses the bypass.
 *   3. Missing or wrong header refuses the bypass.
 *   4. Constant-time comparison rejects same-length wrong secrets.
 *   5. Only an exact match across all 3 layers honors the bypass.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyRequest } from "fastify";

import { shouldBypassAuthRateLimit } from "../src/services/auth-test-bypass.js";

const VALID_SECRET =
  "e2e-bypass-test-fixture-secret-1234567890abcdef-extra-chars-for-length";

function makeReq(headers: Record<string, string | string[] | undefined> = {}): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe("shouldBypassAuthRateLimit", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.E2E_AUTH_BYPASS_SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("refuses when NODE_ENV is production, even with valid env + header", () => {
    process.env.NODE_ENV = "production";
    process.env.E2E_AUTH_BYPASS_SECRET = VALID_SECRET;
    const req = makeReq({ "x-e2e-auth-bypass": VALID_SECRET });
    expect(shouldBypassAuthRateLimit(req)).toBe(false);
  });

  it("refuses when env secret is unset", () => {
    process.env.NODE_ENV = "test";
    const req = makeReq({ "x-e2e-auth-bypass": VALID_SECRET });
    expect(shouldBypassAuthRateLimit(req)).toBe(false);
  });

  it("refuses when env secret is shorter than 32 chars", () => {
    process.env.NODE_ENV = "test";
    process.env.E2E_AUTH_BYPASS_SECRET = "too-short";
    const req = makeReq({ "x-e2e-auth-bypass": "too-short" });
    expect(shouldBypassAuthRateLimit(req)).toBe(false);
  });

  it("refuses when header is missing", () => {
    process.env.NODE_ENV = "test";
    process.env.E2E_AUTH_BYPASS_SECRET = VALID_SECRET;
    const req = makeReq({});
    expect(shouldBypassAuthRateLimit(req)).toBe(false);
  });

  it("refuses when header is empty string", () => {
    process.env.NODE_ENV = "test";
    process.env.E2E_AUTH_BYPASS_SECRET = VALID_SECRET;
    const req = makeReq({ "x-e2e-auth-bypass": "" });
    expect(shouldBypassAuthRateLimit(req)).toBe(false);
  });

  it("refuses when header is whitespace-only", () => {
    process.env.NODE_ENV = "test";
    process.env.E2E_AUTH_BYPASS_SECRET = VALID_SECRET;
    const req = makeReq({ "x-e2e-auth-bypass": "   " });
    expect(shouldBypassAuthRateLimit(req)).toBe(false);
  });

  it("refuses when header value doesn't match env secret (different length)", () => {
    process.env.NODE_ENV = "test";
    process.env.E2E_AUTH_BYPASS_SECRET = VALID_SECRET;
    const req = makeReq({ "x-e2e-auth-bypass": "wrong" });
    expect(shouldBypassAuthRateLimit(req)).toBe(false);
  });

  it("refuses when header value doesn't match env secret (same length, different content)", () => {
    process.env.NODE_ENV = "test";
    process.env.E2E_AUTH_BYPASS_SECRET = VALID_SECRET;
    // Same length as VALID_SECRET, every byte differs.
    const wrongSameLength = "X".repeat(VALID_SECRET.length);
    const req = makeReq({ "x-e2e-auth-bypass": wrongSameLength });
    expect(shouldBypassAuthRateLimit(req)).toBe(false);
  });

  it("honors the bypass when all 3 layers are satisfied (NODE_ENV != production + env set + header matches)", () => {
    process.env.NODE_ENV = "test";
    process.env.E2E_AUTH_BYPASS_SECRET = VALID_SECRET;
    const req = makeReq({ "x-e2e-auth-bypass": VALID_SECRET });
    expect(shouldBypassAuthRateLimit(req)).toBe(true);
  });

  it("honors the bypass when NODE_ENV is development", () => {
    process.env.NODE_ENV = "development";
    process.env.E2E_AUTH_BYPASS_SECRET = VALID_SECRET;
    const req = makeReq({ "x-e2e-auth-bypass": VALID_SECRET });
    expect(shouldBypassAuthRateLimit(req)).toBe(true);
  });

  it("honors the bypass when NODE_ENV is unset", () => {
    process.env.E2E_AUTH_BYPASS_SECRET = VALID_SECRET;
    const req = makeReq({ "x-e2e-auth-bypass": VALID_SECRET });
    expect(shouldBypassAuthRateLimit(req)).toBe(true);
  });

  it("trims surrounding whitespace on the header value", () => {
    process.env.NODE_ENV = "test";
    process.env.E2E_AUTH_BYPASS_SECRET = VALID_SECRET;
    const req = makeReq({ "x-e2e-auth-bypass": `  ${VALID_SECRET}  ` });
    expect(shouldBypassAuthRateLimit(req)).toBe(true);
  });

  it("handles array-valued header (Node treats duplicate headers as arrays) — takes the first value", () => {
    process.env.NODE_ENV = "test";
    process.env.E2E_AUTH_BYPASS_SECRET = VALID_SECRET;
    const req = makeReq({ "x-e2e-auth-bypass": [VALID_SECRET, "extra"] });
    expect(shouldBypassAuthRateLimit(req)).toBe(true);
  });
});
