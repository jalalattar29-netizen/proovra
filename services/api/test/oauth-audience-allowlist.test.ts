/**
 * Phase 4A — OAuth audience allowlist. Web and native clients carry DIFFERENT
 * `aud` values; the verifier must accept an explicit allowlist (never a
 * wildcard) while remaining backward-compatible with the single-env deployment.
 */
import { afterEach, describe, expect, it } from "vitest";
import { allowedAudiences } from "../src/services/auth.service";

const PRIMARY = "APPLE_CLIENT_ID";
const LIST = "APPLE_CLIENT_IDS";

afterEach(() => {
  delete process.env[PRIMARY];
  delete process.env[LIST];
});

describe("allowedAudiences", () => {
  it("returns the single primary value when only the primary env is set (backward compatible)", () => {
    process.env[PRIMARY] = "com.proovra.web";
    expect(allowedAudiences(PRIMARY, LIST)).toEqual(["com.proovra.web"]);
  });

  it("merges the primary with the comma-separated list and de-duplicates", () => {
    process.env[PRIMARY] = "com.proovra.web";
    process.env[LIST] = "com.jalalattar29.proovra, com.proovra.web , com.proovra.ios";
    const out = allowedAudiences(PRIMARY, LIST);
    expect(new Set(out)).toEqual(new Set(["com.proovra.web", "com.jalalattar29.proovra", "com.proovra.ios"]));
    expect(out.length).toBe(3); // de-duplicated
  });

  it("accepts a native bundle id via the list even without the primary", () => {
    process.env[LIST] = "com.jalalattar29.proovra";
    expect(allowedAudiences(PRIMARY, LIST)).toEqual(["com.jalalattar29.proovra"]);
  });

  it("throws when neither env is set (never a wildcard / empty allowlist)", () => {
    expect(() => allowedAudiences(PRIMARY, LIST)).toThrow(/is not set/);
  });

  it("ignores blank entries in the list", () => {
    process.env[PRIMARY] = "com.proovra.web";
    process.env[LIST] = " , ,";
    expect(allowedAudiences(PRIMARY, LIST)).toEqual(["com.proovra.web"]);
  });
});
