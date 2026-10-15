import Fastify from "fastify";
import { getSecretsHealth } from "@proovra/shared-runtime";

import { env } from "./config.js";
import { logger } from "./logger.js";
import { prisma } from "./db.js";
import { redisConnection, reportDlqQueue, reportQueue } from "./queue.js";
import { probeEvidenceBucket } from "./storage.js";
import { getOtsBitcoinVerifierReadiness } from "./ots-bitcoin-verifier.js";

export type HealthServer = {
  close: () => Promise<void>;
};

/** Resolve within `ms` or reject — a dependency probe never hangs. */
function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export type WorkerReadiness =
  | { ready: true; checks: Record<"database" | "redis" | "storage", "ok"> }
  | {
      ready: false;
      reason: "database_unreachable" | "redis_unreachable" | "storage_unreachable" | "bucket_not_configured";
      checks: Record<"database" | "redis" | "storage", "ok" | "failed">;
    };

/**
 * AUD-023 — the worker's READINESS: can it do its job right now? A job needs
 * the database (Prisma `SELECT 1`), Redis (the queues) and evidence storage
 * (`HeadBucket`). Each probe is bounded, so a hung dependency answers
 * "not ready" instead of hanging the probe. `/health` stays LIVENESS.
 */
export async function evaluateWorkerReadiness(
  probes: {
    database?: () => Promise<unknown>;
    redis?: () => Promise<unknown>;
    storage?: () => Promise<{ ok: boolean; reason?: string }>;
  } = {},
): Promise<WorkerReadiness> {
  const database = probes.database ?? (() => prisma.$queryRawUnsafe("SELECT 1"));
  const redis =
    probes.redis ??
    (async () => {
      const pong = await redisConnection.ping();
      if (pong !== "PONG") throw new Error("unexpected PING reply");
    });
  const storage = probes.storage ?? (() => probeEvidenceBucket(2_000));
  const [db, rd, st] = await Promise.allSettled([
    bounded(Promise.resolve().then(database), 2_000, "database"),
    bounded(Promise.resolve().then(redis), 1_500, "redis"),
    bounded(Promise.resolve().then(storage), 2_500, "storage"),
  ]);
  const storageOk = st.status === "fulfilled" && st.value.ok === true;
  const checks = {
    database: db.status === "fulfilled" ? "ok" : "failed",
    redis: rd.status === "fulfilled" ? "ok" : "failed",
    storage: storageOk ? "ok" : "failed",
  } as const;
  if (checks.database === "failed") return { ready: false, reason: "database_unreachable", checks };
  if (checks.redis === "failed") return { ready: false, reason: "redis_unreachable", checks };
  if (!storageOk) {
    const reason =
      st.status === "fulfilled" && st.value.reason === "bucket_not_configured"
        ? "bucket_not_configured"
        : "storage_unreachable";
    return { ready: false, reason, checks };
  }
  return { ready: true, checks: { database: "ok", redis: "ok", storage: "ok" } };
}

export async function startHealthServer(): Promise<HealthServer> {
  const app = Fastify({ logger: false });

  /**
   * LIVENESS. 200 whenever the process can answer — the restart signal must
   * not depend on Redis, Postgres or S3, or a dependency outage restarts every
   * worker in a loop. Queue and Redis figures are reported best-effort and
   * bounded; a dependency failure shows up here as data and in `/readyz` as a
   * 503, never as a failed liveness check.
   */
  app.get("/health", async () => {
    let queues: unknown = null;
    let dlq: unknown = null;
    let redisStatus: string | null = null;
    let redisLatencyMs: number | null = null;
    try {
      queues = await bounded(
        reportQueue.getJobCounts("waiting", "active", "failed", "delayed"),
        1_500,
        "queue counts",
      );
      dlq = await bounded(reportDlqQueue.getJobCounts("waiting", "failed", "delayed"), 1_500, "dlq counts");
      const pingStart = Date.now();
      redisStatus = await bounded(redisConnection.ping(), 1_500, "redis ping");
      redisLatencyMs = Date.now() - pingStart;
    } catch {
      redisStatus = null;
    }

    return {
      ok: true,
      worker: "proovra-worker",
      buildInfo: env.WORKER_BUILD_INFO ?? null,
      queues: {
        report: queues,
        reportDlq: dlq,
      },
      redis: redisStatus === "PONG" ? "ok" : redisStatus === null ? "unreachable" : "degraded",
      redisLatencyMs,
      // NON-FATAL: an optional, deferred trust signal. A Bitcoin verifier that
      // is off, down or not ready never fails this endpoint (capture, upload,
      // TSA, reports and packages keep running); it only means no proof is
      // stated as independently verified. Credential- and address-free.
      bitcoinVerifier: (() => {
        const r = getOtsBitcoinVerifierReadiness();
        return { enabled: r.enabled, ready: r.ready, code: r.code, chain: r.chain, tipHeight: r.tipHeight, nodeVersion: r.nodeVersion, observedAtUtc: r.observedAtUtc };
      })(),
    };
  });

  /**
   * PHASE 12 CORRECTIVE PASS §4 (SEC-004) — the Worker's half of the ONE
   * secrets readiness contract.
   *
   * The API has exposed `GET /v1/runtime/secrets-health` for some time; the
   * Worker exposed nothing, so "do both processes resolve secrets from the
   * same authority?" was not an answerable question in a running deployment.
   * It is now: this endpoint returns the SAME `SecretsHealth` document, built
   * by the SAME `getSecretsHealth()` in the shared runtime, so the two can be
   * compared field by field. No secret name and no secret value is in it —
   * only the declared mode, connection state and a bounded key COUNT.
   */
  app.get("/health/secrets", async () => getSecretsHealth());

  /**
   * AUD-023 — READINESS: 200 only when the database, Redis and evidence
   * storage all answer; 503 with the first failing dependency as a bounded
   * reason otherwise. Compose `depends_on: service_healthy` and deploy gates
   * read this; the restart signal reads `/health`.
   */
  app.get("/readyz", async (_req, reply) => {
    const readiness = await evaluateWorkerReadiness();
    if (!readiness.ready) {
      logger.warn({ reason: readiness.reason, checks: readiness.checks }, "worker.readyz.not_ready");
      return reply.code(503).send({ status: "degraded", reason: readiness.reason, checks: readiness.checks });
    }
    return reply.code(200).send({ status: "ok", checks: readiness.checks });
  });

  await app.listen({ port: env.WORKER_PORT, host: "0.0.0.0" });
  logger.info({ port: env.WORKER_PORT }, "Worker health server listening");

  return {
    close: async () => {
      await app.close();
    },
  };
}
