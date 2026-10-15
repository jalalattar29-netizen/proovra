/**
 * AUD-023 — `/readyz` against REAL dependencies that go away and come back.
 *
 * `/readyz` used to check configuration, Postgres, the schema canary, the
 * writer contract and the TSA bundle — not Redis and not evidence storage — so
 * an API whose Redis or bucket had vanished still reported ready. Here the
 * booted server is pointed at a disposable Redis and a disposable MinIO this
 * suite starts itself (unique container names, never a shared one), and each
 * dependency is taken down for real:
 *
 *   - Redis:    `docker stop`   → 503 redis_unreachable  → `docker start` → 200
 *   - storage:  `docker pause`  → 503 storage_unreachable → unpause       → 200
 *   - Postgres: `docker pause` of the harness database → 503 db_unreachable → 200
 *
 * Recovery needs no restart of the API: the probes are live and bounded.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const RUN = randomUUID().slice(0, 8);
const REDIS_NAME = `aud023-readyz-redis-${RUN}`;
const MINIO_NAME = `aud023-readyz-minio-${RUN}`;
const BUCKET = `aud023-readyz-${RUN}`;
const MINIO_USER = "aud023readyz";
const MINIO_PASS = "aud023readyz-secret";

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function until<T>(label: string, read: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T = await read();
  while (!ok(last)) {
    if (Date.now() > deadline) throw new Error(`${label}: condition not reached; last=${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 250));
    last = await read();
  }
  return last;
}

describe("AUD-023 — /readyz reflects real Redis, storage and database outages, then recovers", () => {
  let harness: IntegrationHarness;
  let dbContainer: string | null = null;
  const saved: Record<string, string | undefined> = {};
  /** This suite's dependency endpoints (the setup file re-asserts its own before each test). */
  const ours: Record<string, string> = {};

  const readyz = async () => {
    const res = await harness.app.inject({ method: "GET", url: "/readyz" });
    return { status: res.statusCode, reason: (res.json() as { reason?: string }).reason ?? null };
  };

  beforeAll(async () => {
    const redisPort = await freePort();
    const minioPort = await freePort();
    docker("run", "-d", "--name", REDIS_NAME, "-p", `127.0.0.1:${redisPort}:6379`, "redis:7-alpine");
    docker(
      "run", "-d", "--name", MINIO_NAME,
      "-p", `127.0.0.1:${minioPort}:9000`,
      "-e", `MINIO_ROOT_USER=${MINIO_USER}`,
      "-e", `MINIO_ROOT_PASSWORD=${MINIO_PASS}`,
      "pgsty/minio:RELEASE.2026-08-04T00-00-00Z", "server", "/data",
    );
    const endpoint = `http://127.0.0.1:${minioPort}`;
    for (const [k, v] of Object.entries({
      REDIS_URL: `redis://127.0.0.1:${redisPort}`,
      S3_ENDPOINT: endpoint,
      S3_ACCESS_KEY: MINIO_USER,
      S3_SECRET_KEY: MINIO_PASS,
      S3_BUCKET: BUCKET,
      S3_REGION: "us-east-1",
      S3_FORCE_PATH_STYLE: "true",
      S3_ALLOW_INSECURE: "true",
    })) {
      saved[k] = process.env[k];
      ours[k] = v;
      process.env[k] = v;
    }
    const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");
    const admin = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASS },
    });
    await until(
      "minio up",
      () => admin.send(new CreateBucketCommand({ Bucket: BUCKET })).then(() => true, () => false),
      (v) => v,
      60_000,
    );

    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();

    // The harness database container, found by the port it publishes.
    const dbPort = new URL(process.env.DATABASE_URL!).port;
    dbContainer = docker("ps", "-q", "--filter", `publish=${dbPort}`).split("\n")[0] || null;
  });

  afterAll(async () => {
    if (dbContainer) {
      try {
        docker("unpause", dbContainer);
      } catch {
        /* not paused */
      }
    }
    try {
      docker("unpause", MINIO_NAME);
    } catch {
      /* not paused */
    }
    await harness?.cleanup();
    for (const name of [REDIS_NAME, MINIO_NAME]) {
      try {
        docker("rm", "-f", name);
      } catch {
        /* already gone */
      }
    }
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // The shared safe-environment setup re-asserts the default loopback Redis and
  // S3 before every test; this suite's own disposable endpoints win again here.
  beforeEach(() => {
    Object.assign(process.env, ours);
  });

  it("all dependencies up → 200", async () => {
    expect(await readyz()).toEqual({ status: 200, reason: null });
  });

  it("Redis down → 503 redis_unreachable; Redis back → 200 (no API restart)", async () => {
    docker("stop", REDIS_NAME);
    expect(await readyz()).toEqual({ status: 503, reason: "redis_unreachable" });
    docker("start", REDIS_NAME);
    await until("redis recovery", readyz, (r) => r.status === 200);
  });

  it("storage unresponsive → 503 storage_unreachable within the probe bound; storage back → 200", async () => {
    docker("pause", MINIO_NAME);
    const started = Date.now();
    expect(await readyz()).toEqual({ status: 503, reason: "storage_unreachable" });
    expect(Date.now() - started).toBeLessThan(10_000);
    docker("unpause", MINIO_NAME);
    await until("storage recovery", readyz, (r) => r.status === 200);
  });

  it("a missing bucket is storage_unreachable too", async () => {
    const real = process.env.S3_BUCKET;
    process.env.S3_BUCKET = `aud023-no-such-bucket-${RUN}`;
    try {
      expect(await readyz()).toEqual({ status: 503, reason: "storage_unreachable" });
    } finally {
      process.env.S3_BUCKET = real;
    }
    expect((await readyz()).status).toBe(200);
  });

  it("database unresponsive → 503 db_unreachable within the probe bound; database back → 200", async () => {
    expect(dbContainer, "the harness database container must be found to take it down").toBeTruthy();
    docker("pause", dbContainer!);
    try {
      const started = Date.now();
      expect(await readyz()).toEqual({ status: 503, reason: "db_unreachable" });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      docker("unpause", dbContainer!);
    }
    await until("database recovery", readyz, (r) => r.status === 200);
  });
});
