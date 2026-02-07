import Fastify from "fastify";
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

  await app.listen({ port: env.WORKER_PORT, host: "0.0.0.0" });
  logger.info({ port: env.WORKER_PORT }, "Worker health server listening");

  return {
    close: async () => {
      await app.close();
    },
  };
}
