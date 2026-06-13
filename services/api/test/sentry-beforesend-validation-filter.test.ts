/**
 * Phase CAPTURE-HARDENING — regression lock for the Sentry beforeSend
 * filter. Validation errors (ZodError, AppError with 4xx) must NEVER
 * reach Sentry as captured events; they are client-input business
 * outcomes already surfaced to the user as HTTP 400.
 *
 * Real server-side errors (Error with 5xx, generic Error without a
 * statusCode) MUST still flow through to captureException.
 *
 * The filter lives in services/api/src/observability/sentry.ts. We
 * test it via a static source-level inspection — the actual Sentry
 * runtime is not initialised in dev/test (SENTRY_DSN is unset).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { AppError, ErrorCode, isAppError } from "../src/errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SENTRY_SRC = readFileSync(
  resolve(__dirname, "..", "src", "observability", "sentry.ts"),
  "utf8",
);

describe("Sentry beforeSend — validation filter (Phase CAPTURE-HARDENING)", () => {
  it("source: imports ZodError and isAppError (needed to recognise validation outcomes)", () => {
    expect(SENTRY_SRC).toMatch(/import\s+\{\s*ZodError\s*\}\s+from\s+"zod"/);
    expect(SENTRY_SRC).toMatch(/import\s+\{\s*isAppError\s*\}\s+from\s+"\.\.\/errors\.js"/);
  });

  it("source: beforeSend drops ZodError originalException → returns null", () => {
    expect(SENTRY_SRC).toMatch(/if\s*\(\s*err\s+instanceof\s+ZodError\s*\)\s*\{\s*return\s+null\s*;?\s*\}/);
  });

  it("source: beforeSend drops AppError with 4xx statusCode → returns null", () => {
    expect(SENTRY_SRC).toMatch(
      /if\s*\(\s*isAppError\(err\)\s*&&\s*err\.statusCode\s*>=\s*400\s*&&\s*err\.statusCode\s*<\s*500\s*\)\s*\{\s*return\s+null\s*;?\s*\}/,
    );
  });

  it("AppError(VALIDATION_ERROR) has a 4xx statusCode (would be filtered)", () => {
    const e = new AppError(ErrorCode.VALIDATION_ERROR, "x");
    expect(isAppError(e)).toBe(true);
    expect(e.statusCode).toBeGreaterThanOrEqual(400);
    expect(e.statusCode).toBeLessThan(500);
  });

  it("ZodError is filterable (constructor accepts an issues array)", () => {
    const zErr = new ZodError([
      { code: "invalid_type", path: ["x"], message: "Required" } as never,
    ]);
    expect(zErr).toBeInstanceOf(ZodError);
  });

  it("source: validation-instance filter executes BEFORE the message-match filter in beforeSend", () => {
    // The validation filter MUST run before the message-substring
    // filters (Redis ECONNREFUSED etc.), otherwise a malformed
    // ZodError carrying a Redis-like message could be filtered for
    // the wrong reason. We compare the FIRST occurrence of each
    // CHECK (not the comment block above), so this assertion
    // tracks the order of the executable branches inside
    // `beforeSend`.
    const zodCheckIdx = SENTRY_SRC.indexOf("err instanceof ZodError");
    const redisCheckIdx = SENTRY_SRC.indexOf('message.includes("ECONNREFUSED")');
    expect(zodCheckIdx).toBeGreaterThan(-1);
    expect(redisCheckIdx).toBeGreaterThan(-1);
    expect(zodCheckIdx).toBeLessThan(redisCheckIdx);
  });

  it("server route already maps ZodError → 400 before any captureException call (defense-in-depth check)", async () => {
    // Read the global handler and assert it returns 400 for
    // ZodError without invoking captureException. The beforeSend
    // filter is the BACKSTOP — the primary defence is the handler.
    const serverSrc = readFileSync(
      resolve(__dirname, "..", "src", "server.ts"),
      "utf8",
    );
    // The ZodError branch (line ~668) returns before line ~770's
    // captureException.
    const zodBranchIdx = serverSrc.indexOf("buildZodWirePayload");
    const captureIdx = serverSrc.indexOf("captureException(err, requestContext)");
    expect(zodBranchIdx).toBeGreaterThan(-1);
    expect(captureIdx).toBeGreaterThan(-1);
    expect(zodBranchIdx).toBeLessThan(captureIdx);
  });
});
