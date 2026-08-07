import Fastify from "fastify";
import { getSecretsHealth } from "@proovra/shared-runtime";

import { env } from "./config.js";
import { logger } from "./logger.js";
import { redisConnection, reportDlqQueue, reportQueue } from "./queue.js";

export type HealthServer = {
  close: () => Promise<void>;
};

export async function startHealthServer(): Promise<HealthServer> {
  const app = Fastify({ logger: false });

  app.get("/health", async () => {
    const queues = await reportQueue.getJobCounts(
      "waiting",
      "active",
      "failed",
      "delayed"
    );
    const dlq = await reportDlqQueue.getJobCounts("waiting", "failed", "delayed");
    const pingStart = Date.now();
    const redisStatus = await redisConnection.ping();
    const redisLatencyMs = Date.now() - pingStart;

    return {
      ok: true,
      worker: "proovra-worker",
      buildInfo: env.WORKER_BUILD_INFO ?? null,
      queues: {
        report: queues,
        reportDlq: dlq,
      },
      redis: redisStatus === "PONG" ? "ok" : "degraded",
      redisLatencyMs,
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

  await app.listen({ port: env.WORKER_PORT, host: "0.0.0.0" });
  logger.info({ port: env.WORKER_PORT }, "Worker health server listening");

  return {
    close: async () => {
      await app.close();
    },
  };
}
