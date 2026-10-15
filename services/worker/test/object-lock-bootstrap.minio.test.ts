/**
 * AUD-010 — the worker's Object Lock startup decision against a REAL MinIO
 * (the API applies the same shared decision, `decideObjectLockBootstrap`).
 *
 * Each case creates its own bucket through the S3 API, so the probe the
 * bootstrap runs (`GetObjectLockConfiguration`) answers from real storage:
 *
 *   - a bucket created WITH Object Lock and no default retention → starts;
 *   - a bucket created WITHOUT Object Lock → production refuses;
 *   - a locked bucket whose DEFAULT retention is weaker than the contract
 *     (COMPLIANCE 1 day, or GOVERNANCE) → production refuses;
 *   - the environment stating GOVERNANCE → production refuses even on a
 *     correctly locked bucket.
 *
 * Gated on OBJECT_LOCK_MINIO_ENDPOINT like the publication suite (CI runs
 * both against the disposable MinIO on 127.0.0.1:59000).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENDPOINT = process.env.OBJECT_LOCK_MINIO_ENDPOINT;
const run = ENDPOINT ? describe : describe.skip;

if (ENDPOINT) {
  process.env.S3_ENDPOINT = ENDPOINT;
  process.env.S3_REGION = "us-east-1";
  process.env.S3_ACCESS_KEY = process.env.OBJECT_LOCK_MINIO_LOGIN ?? "";
  process.env.S3_SECRET_KEY = process.env.OBJECT_LOCK_MINIO_PASSPHRASE ?? "";
  process.env.S3_BUCKET = "placeholder-set-per-case";
  process.env.S3_ALLOW_INSECURE = "true";
  process.env.S3_FORCE_PATH_STYLE = "true";
}

run("worker Object Lock bootstrap against real MinIO (production refuses every shortfall)", () => {
  const RUN = randomUUID().slice(0, 8);
  const buckets = {
    locked: `aud010-locked-${RUN}`,
    plain: `aud010-plain-${RUN}`,
    shortDefault: `aud010-short-${RUN}`,
    governanceDefault: `aud010-gov-${RUN}`,
  };
  let client: import("@aws-sdk/client-s3").S3Client;
  let sdk: typeof import("@aws-sdk/client-s3");
  let bootstrap: (typeof import("../src/object-lock-bootstrap.js"))["bootstrapObjectLockVerification"];
  const saved = { ...process.env };

  const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const before = { ...process.env };
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    try {
      await fn();
    } finally {
      process.env = before;
    }
  };
  const production = (bucket: string, extra: Record<string, string | undefined> = {}) => ({
    NODE_ENV: "production",
    S3_BUCKET: bucket,
    S3_OBJECT_LOCK_ENABLED: "true",
    S3_OBJECT_LOCK_MODE: "COMPLIANCE",
    S3_OBJECT_LOCK_RETAIN_DAYS: undefined,
    ...extra,
  });

  beforeAll(async () => {
    sdk = await import("@aws-sdk/client-s3");
    client = new sdk.S3Client({
      endpoint: ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.OBJECT_LOCK_MINIO_LOGIN ?? "",
        secretAccessKey: process.env.OBJECT_LOCK_MINIO_PASSPHRASE ?? "",
      },
    });
    await client.send(new sdk.CreateBucketCommand({ Bucket: buckets.locked, ObjectLockEnabledForBucket: true }));
    await client.send(new sdk.CreateBucketCommand({ Bucket: buckets.plain }));
    for (const [bucket, mode, days] of [
      [buckets.shortDefault, "COMPLIANCE", 1],
      [buckets.governanceDefault, "GOVERNANCE", 3650],
    ] as const) {
      await client.send(new sdk.CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
      await client.send(
        new sdk.PutObjectLockConfigurationCommand({
          Bucket: bucket,
          ObjectLockConfiguration: {
            ObjectLockEnabled: "Enabled",
            Rule: { DefaultRetention: { Mode: mode, Days: days } },
          },
        }),
      );
    }
    ({ bootstrapObjectLockVerification: bootstrap } = await import("../src/object-lock-bootstrap.js"));
  });

  afterAll(async () => {
    process.env = saved;
    // The buckets hold no objects, so they can be removed even when locked.
    for (const bucket of Object.values(buckets)) {
      await client?.send(new sdk.DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
    }
  });

  it("a bucket created with Object Lock and the exact contract → starts", async () => {
    await withEnv(production(buckets.locked), async () => {
      await expect(bootstrap()).resolves.toBeUndefined();
    });
    await withEnv(production(buckets.locked, { S3_OBJECT_LOCK_RETAIN_DAYS: "2920" }), async () => {
      await expect(bootstrap()).resolves.toBeUndefined();
    });
  });

  it("a bucket WITHOUT Object Lock → production refuses (the bucket cannot hold locks)", async () => {
    await withEnv(production(buckets.plain), async () => {
      await expect(bootstrap()).rejects.toThrow(/OBJECT_LOCK_BOOTSTRAP_FAILED: .*object_lock_unsupported_by_bucket/);
    });
  });

  it("a weaker bucket DEFAULT retention → production refuses", async () => {
    await withEnv(production(buckets.shortDefault), async () => {
      await expect(bootstrap()).rejects.toThrow(/bucket_default_retention_below_contract/);
    });
    await withEnv(production(buckets.governanceDefault), async () => {
      await expect(bootstrap()).rejects.toThrow(/bucket_default_retention_not_compliance/);
    });
  });

  it("the environment stating GOVERNANCE, a short period, or disabled → production refuses on a good bucket", async () => {
    for (const extra of [
      { S3_OBJECT_LOCK_MODE: "GOVERNANCE" },
      { S3_OBJECT_LOCK_RETAIN_DAYS: "365" },
      { S3_OBJECT_LOCK_ENABLED: "false" },
      // The removed bypass changes nothing.
      { S3_OBJECT_LOCK_ENABLED: "false", OBJECT_LOCK_VERIFICATION_BYPASS: "true" },
    ]) {
      await withEnv(production(buckets.locked, extra), async () => {
        await expect(bootstrap(), JSON.stringify(extra)).rejects.toThrow(/OBJECT_LOCK_BOOTSTRAP_FAILED/);
      });
    }
  });

  it("outside production the same unlocked bucket only warns", async () => {
    await withEnv({ ...production(buckets.plain), NODE_ENV: "development" }, async () => {
      await expect(bootstrap()).resolves.toBeUndefined();
    });
  });
});
