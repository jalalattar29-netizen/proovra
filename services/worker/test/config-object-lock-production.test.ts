/**
 * AUD-010 — the worker refuses to start in production unless its Object Lock
 * configuration states the retention contract. `S3_OBJECT_LOCK_ENABLED`
 * defaulted to false and `S3_OBJECT_LOCK_MODE` accepted GOVERNANCE, so a
 * production worker could write reports and packages unlocked or removable.
 */
import { beforeAll, describe, expect, it } from "vitest";

const BASE = {
  DATABASE_URL: "postgresql://x:x@127.0.0.1:1/none",
  REDIS_URL: "redis://127.0.0.1:1",
  S3_ENDPOINT: "http://127.0.0.1:1",
  S3_ACCESS_KEY: "k",
  S3_SECRET_KEY: "s",
  S3_BUCKET: "b",
};

let assertPosture: (typeof import("../src/config.js"))["assertProductionObjectLockPosture"];

beforeAll(async () => {
  Object.assign(process.env, { ...BASE, ...process.env, NODE_ENV: process.env.NODE_ENV ?? "test" });
  ({ assertProductionObjectLockPosture: assertPosture } = await import("../src/config.js"));
});

const CONTRACT = { NODE_ENV: "production", S3_OBJECT_LOCK_ENABLED: "true", S3_OBJECT_LOCK_MODE: "COMPLIANCE" };

describe("worker config — production Object Lock posture", () => {
  it("the exact contract starts", () => {
    expect(() => assertPosture(CONTRACT)).not.toThrow();
    expect(() => assertPosture({ ...CONTRACT, S3_OBJECT_LOCK_RETAIN_DAYS: "2920" })).not.toThrow();
  });

  it("disabled, default-off, GOVERNANCE and a short period each refuse to start", () => {
    for (const env of [
      { ...CONTRACT, S3_OBJECT_LOCK_ENABLED: "false" },
      { NODE_ENV: "production", S3_OBJECT_LOCK_MODE: "COMPLIANCE" },
      { ...CONTRACT, S3_OBJECT_LOCK_MODE: "GOVERNANCE" },
      { ...CONTRACT, S3_OBJECT_LOCK_RETAIN_DAYS: "365" },
    ]) {
      expect(() => assertPosture(env), JSON.stringify(env)).toThrow(/Worker production config refuses to start/);
    }
  });

  it("outside production the permissive defaults remain", () => {
    expect(() => assertPosture({ NODE_ENV: "development" })).not.toThrow();
    expect(() => assertPosture({ NODE_ENV: "test", S3_OBJECT_LOCK_MODE: "GOVERNANCE" })).not.toThrow();
  });
});
