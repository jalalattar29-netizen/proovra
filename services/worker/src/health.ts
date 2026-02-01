import Fastify from "fastify";
import { env } from "./config";
import { logger } from "./logger";
import { redisConnection, reportDlqQueue, reportQueue } from "./queue";

export async function startHealthServer() {
  const app = Fastify({ logger: false });

  app.get("/health", async () => {
    const queues = await reportQueue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed"
    );
    const dlq = await reportDlqQueue.getJobCounts("waiting", "failed", "delayed");
    const redisStatus = await redisConnection.ping();
    return {
      ok: true,
      worker: "digital-witness-worker",
      queues: {
        report: queues,
        reportDlq: dlq,
      },
      redis: redisStatus === "PONG" ? "ok" : "degraded",
    };
  });

  await app.listen({ port: env.WORKER_PORT, host: "0.0.0.0" });
  logger.info({ port: env.WORKER_PORT }, "Worker health server listening");
}
