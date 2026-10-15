/**
 * AUD-010 — the API refuses a production configuration that does not state the
 * evidence retention contract, and readiness reflects it.
 */
import { afterEach, describe, expect, it } from "vitest";

import { collectStartupViolations } from "../src/config/index.js";

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

const lockViolations = (env: Record<string, string | undefined>) => {
  process.env = { ...ORIGINAL, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  return collectStartupViolations().filter((v) => v.envName.startsWith("S3_OBJECT_LOCK_"));
};

const CONTRACT = {
  NODE_ENV: "production",
  S3_OBJECT_LOCK_ENABLED: "true",
  S3_OBJECT_LOCK_MODE: "COMPLIANCE",
  S3_OBJECT_LOCK_RETAIN_DAYS: undefined,
};

describe("collectStartupViolations — Object Lock in production", () => {
  it("the exact contract passes (period unset or >= 2920)", () => {
    expect(lockViolations(CONTRACT)).toEqual([]);
    expect(lockViolations({ ...CONTRACT, S3_OBJECT_LOCK_RETAIN_DAYS: "2920" })).toEqual([]);
  });

  it("disabled / unset is a violation (no default to 'off' in production)", () => {
    expect(lockViolations({ ...CONTRACT, S3_OBJECT_LOCK_ENABLED: "false" })).toEqual([
      { envName: "S3_OBJECT_LOCK_ENABLED", reason: "object_lock_disabled" },
    ]);
    expect(lockViolations({ ...CONTRACT, S3_OBJECT_LOCK_ENABLED: undefined })).toEqual([
      { envName: "S3_OBJECT_LOCK_ENABLED", reason: "object_lock_disabled" },
    ]);
  });

  it("GOVERNANCE or a missing mode is a violation", () => {
    for (const mode of ["GOVERNANCE", undefined, "bogus"]) {
      expect(lockViolations({ ...CONTRACT, S3_OBJECT_LOCK_MODE: mode })).toEqual([
        { envName: "S3_OBJECT_LOCK_MODE", reason: "object_lock_mode_not_compliance" },
      ]);
    }
  });

  it("a period under 2920 days is a violation", () => {
    expect(lockViolations({ ...CONTRACT, S3_OBJECT_LOCK_RETAIN_DAYS: "365" })).toEqual([
      { envName: "S3_OBJECT_LOCK_RETAIN_DAYS", reason: "object_lock_retain_days_below_contract" },
    ]);
  });

  it("outside production none of this is a violation (fixtures run unlocked)", () => {
    expect(lockViolations({ ...CONTRACT, NODE_ENV: "test", S3_OBJECT_LOCK_ENABLED: "false" })).toEqual([]);
  });
});

describe("runtime readiness — s3_object_lock reflects the contract", () => {
  it("production + GOVERNANCE is CRITICAL; production + contract is HEALTHY; dev + disabled is DEGRADED", async () => {
    const { checkS3ObjectLock } = await import("../src/runtime/runtime-readiness.js");
    const subsystem = async (env: Record<string, string | undefined>) => {
      process.env = {
        ...ORIGINAL,
        S3_BUCKET: "b",
        S3_REGION: "auto",
        S3_ACCESS_KEY: "k",
        S3_SECRET_KEY: "s",
        ...env,
      };
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
      return checkS3ObjectLock();
    };
    const gov = await subsystem({ ...CONTRACT, S3_OBJECT_LOCK_MODE: "GOVERNANCE" });
    expect(gov?.status).toBe("CRITICAL");
    expect(gov?.reasonCode).toBe("object_lock_mode_not_compliance");
    const ok = await subsystem(CONTRACT);
    expect(ok?.status).toBe("HEALTHY");
    const dev = await subsystem({ NODE_ENV: "development", S3_OBJECT_LOCK_ENABLED: "false" });
    expect(dev?.status).toBe("DEGRADED");
  });
});
