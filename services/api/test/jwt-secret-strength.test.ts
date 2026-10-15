/**
 * AUTH_JWT_SECRET strength in production.
 *
 * Session tokens are HS256: whoever knows or guesses the secret mints a session
 * for any user. The startup validator only checked that the variable was
 * PRESENT, so `AUTH_JWT_SECRET=changeme` booted a production API.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  JWT_SECRET_MIN_LENGTH,
  assessJwtSecretStrength,
  collectStartupViolations,
} from "../src/config/index.js";

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

const jwtViolations = (env: Record<string, string | undefined>) => {
  process.env = { ...ORIGINAL, ...env };
  return collectStartupViolations().filter((v) => v.envName === "AUTH_JWT_SECRET");
};

describe("assessJwtSecretStrength", () => {
  it("refuses short secrets", () => {
    expect(assessJwtSecretStrength("x".repeat(JWT_SECRET_MIN_LENGTH - 1))).toBe("jwt_secret_too_short");
    expect(assessJwtSecretStrength("changeme")).toBe("jwt_secret_too_short");
  });

  it("refuses template placeholders of adequate length", () => {
    for (const v of [
      "changeme-changeme-changeme-changeme-123",
      "your-secret-goes-here-0123456789abcdefgh",
      "REPLACE_ME_with_a_real_value_0123456789xyz",
      "example-jwt-signing-key-0123456789abcdefghij",
      "supersecret-0123456789abcdefghijklmnopqrstuv",
    ]) {
      expect(assessJwtSecretStrength(v), v).toBe("jwt_secret_placeholder");
    }
  });

  it("refuses low-entropy values", () => {
    expect(assessJwtSecretStrength("a".repeat(64))).toBe("jwt_secret_low_entropy");
    expect(assessJwtSecretStrength("abcabcabcabcabcabcabcabcabcabcabcabc")).toBe("jwt_secret_low_entropy");
    expect(assessJwtSecretStrength("0101010101010101010101010101010101010101")).toBe("jwt_secret_low_entropy");
  });

  it("accepts a generated secret", () => {
    expect(assessJwtSecretStrength("u8Jq2Zr7Kx0bP4mW1sVd9TgHc6NeLfYa3RoXiE5k")).toBeNull();
  });
});

describe("collectStartupViolations — AUTH_JWT_SECRET", () => {
  it("production: a weak secret is a startup violation", () => {
    expect(jwtViolations({ NODE_ENV: "production", AUTH_JWT_SECRET: "changeme" })).toEqual([
      { envName: "AUTH_JWT_SECRET", reason: "jwt_secret_too_short" },
    ]);
    expect(jwtViolations({ NODE_ENV: "production", AUTH_JWT_SECRET: "a".repeat(40) })).toEqual([
      { envName: "AUTH_JWT_SECRET", reason: "jwt_secret_low_entropy" },
    ]);
  });

  it("production: missing stays required_missing (not double-reported)", () => {
    expect(jwtViolations({ NODE_ENV: "production", AUTH_JWT_SECRET: "" })).toEqual([
      { envName: "AUTH_JWT_SECRET", reason: "required_missing" },
    ]);
  });

  it("non-production fixtures are not judged", () => {
    expect(jwtViolations({ NODE_ENV: "development", AUTH_JWT_SECRET: "changeme" })).toEqual([]);
  });

  it("every CI value that boots an API as production passes the production check", () => {
    // The CI full stack runs the API with NODE_ENV=production; its fixture
    // secret must satisfy the same rule a real deployment must.
    const ci = readFileSync(
      fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url)),
      "utf8",
    );
    const values = [...ci.matchAll(/^\s*AUTH_JWT_SECRET:\s*(\S+)\s*$/gm)].map((m) => m[1]!);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(jwtViolations({ NODE_ENV: "production", AUTH_JWT_SECRET: value }), value).toEqual([]);
    }
  });
});

describe("one JWT secret accessor", () => {
  it("no route or service reads AUTH_JWT_SECRET from process.env directly", () => {
    for (const rel of [
      "../src/routes/mfa-admin.routes.ts",
      "../src/routes/saml-auth.routes.ts",
      "../src/routes/sso-auth.routes.ts",
      "../src/services/reports/output-offer.service.ts",
    ]) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect(src, rel).not.toMatch(/process\.env(\.AUTH_JWT_SECRET|\[\s*["']AUTH_JWT_SECRET["']\s*\])/);
    }
  });
});
