/**
 * AUD-023 — the worker's `/readyz` against REAL dependencies that go away and
 * come back; `/health` stays liveness throughout.
 *
 * The worker had no readiness endpoint, and `/health` answered 200 whatever
 * Redis was doing. This suite starts its own disposable PostgreSQL, Redis and
 * MinIO (unique container names), boots the worker's real health server
 * against them, and takes each dependency down for real:
 *
 *   - Redis    `docker stop`  → 503 redis_unreachable    → start   → 200
 *   - storage  `docker pause` → 503 storage_unreachable  → unpause → 200
 *   - Postgres `docker pause` → 503 database_unreachable → unpause → 200
 *
 * and `/health` answers 200 during every outage (a dependency outage must
 * never read as a dead process, or the orchestrator restarts healthy workers).
 *
 * Needs Docker: gated on WORKER_READYZ_DOCKER=1, which CI sets (and refuses a
 * skipped run), exactly like the MinIO suites.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = process.env.WORKER_READYZ_DOCKER === "1" ? describe : describe.skip;

const RUN = randomUUID().slice(0, 8);
const NAMES = {
  pg: `aud023-wready-pg-${RUN}`,
  redis: `aud023-wready-redis-${RUN}`,
  minio: `aud023-wready-minio-${RUN}`,
};
const BUCKET = `aud023-wready-${RUN}`;

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

async function until<T>(label: string, read: () => Promise<T>, ok: (v: T) => boolean, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T = await read().catch((e: unknown) => e as T);
  while (!ok(last)) {
    if (Date.now() > deadline) throw new Error(`${label}: condition not reached; last=${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 300));
    last = await read().catch((e: unknown) => e as T);
  }
  return last;
}

run("worker /readyz reflects real database, Redis and storage outages; /health stays liveness", () => {
  let base = "";
  let close: (() => Promise<void>) | null = null;

  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    const body = (await res.json()) as { reason?: string };
    return { status: res.status, reason: body.reason ?? null };
  };

  beforeAll(async () => {
    const [pgPort, redisPort, minioPort, workerPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
    docker(
      "run", "-d", "--name", NAMES.pg, "-p", `127.0.0.1:${pgPort}:5432`,
      "-e", "POSTGRES_USER=aud023", "-e", "POSTGRES_PASSWORD=aud023", "-e", "POSTGRES_DB=aud023",
      "pgvector/pgvector:pg16",
    );
    docker("run", "-d", "--name", NAMES.redis, "-p", `127.0.0.1:${redisPort}:6379`, "redis:7-alpine");
    docker(
      "run", "-d", "--name", NAMES.minio, "-p", `127.0.0.1:${minioPort}:9000`,
      "-e", "MINIO_ROOT_USER=aud023wready", "-e", "MINIO_ROOT_PASSWORD=aud023wready-secret",
      "pgsty/minio:RELEASE.2026-08-04T00-00-00Z", "server", "/data",
    );
    Object.assign(process.env, {
      DATABASE_URL: `postgresql://aud023:aud023@127.0.0.1:${pgPort}/aud023`,
      REDIS_URL: `redis://127.0.0.1:${redisPort}`,
      S3_ENDPOINT: `http://127.0.0.1:${minioPort}`,
      S3_REGION: "us-east-1",
      S3_ACCESS_KEY: "aud023wready",
      S3_SECRET_KEY: "aud023wready-secret",
      S3_BUCKET: BUCKET,
      S3_ALLOW_INSECURE: "true",
      S3_FORCE_PATH_STYLE: "true",
      WORKER_PORT: String(workerPort),
    });
    const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");
    const admin = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "aud023wready", secretAccessKey: "aud023wready-secret" },
    });
    await until("minio up", () => admin.send(new CreateBucketCommand({ Bucket: BUCKET })).then(() => true), (v) => v === true);

    const { startHealthServer } = await import("../src/health.js");
    const server = await startHealthServer();
    close = server.close;
    base = `http://127.0.0.1:${workerPort}`;
    await until("postgres up", () => get("/readyz"), (r) => (r as { status?: number }).status === 200);
  }, 180_000);

  afterAll(async () => {
    for (const name of [NAMES.pg, NAMES.minio]) {
      try {
        docker("unpause", name);
      } catch {
        /* not paused */
      }
    }
    await close?.().catch(() => undefined);
    for (const name of Object.values(NAMES)) {
      try {
        docker("rm", "-f", name);
      } catch {
        /* already gone */
      }
    }
  }, 120_000);

  it("every dependency up → /readyz 200, /health 200", async () => {
    expect(await get("/readyz")).toEqual({ status: 200, reason: null });
    expect((await get("/health")).status).toBe(200);
  });

  it("Redis down → /readyz 503 redis_unreachable while /health stays 200; back → 200", async () => {
    docker("stop", NAMES.redis);
    expect(await get("/readyz")).toEqual({ status: 503, reason: "redis_unreachable" });
    expect((await get("/health")).status).toBe(200);
    docker("start", NAMES.redis);
    await until("redis recovery", () => get("/readyz"), (r) => r.status === 200);
  }, 120_000);

  it("storage unresponsive → 503 storage_unreachable; back → 200", async () => {
    docker("pause", NAMES.minio);
    try {
      expect(await get("/readyz")).toEqual({ status: 503, reason: "storage_unreachable" });
      expect((await get("/health")).status).toBe(200);
    } finally {
      docker("unpause", NAMES.minio);
    }
    await until("storage recovery", () => get("/readyz"), (r) => r.status === 200);
  }, 120_000);

  it("database unresponsive → 503 database_unreachable; back → 200", async () => {
    docker("pause", NAMES.pg);
    try {
      expect(await get("/readyz")).toEqual({ status: 503, reason: "database_unreachable" });
      expect((await get("/health")).status).toBe(200);
    } finally {
      docker("unpause", NAMES.pg);
    }
    await until("database recovery", () => get("/readyz"), (r) => r.status === 200);
  }, 120_000);
});
