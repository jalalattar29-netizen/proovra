import Fastify from "fastify";
import cors from "@fastify/cors";
import { prisma } from "./db";
import { evidenceRoutes } from "./routes/evidence.routes";

export async function buildServer() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });

  app.get("/health", async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true, db: "up" };
    } catch {
      return { ok: true, db: "down" };
    }
  });

  await app.register(evidenceRoutes);

  return app;
}
