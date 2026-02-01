import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { prisma } from "./db.js";
import { evidenceRoutes } from "./routes/evidence.routes.js";

function parseCorsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS ?? "";
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function buildServer() {
  const app = Fastify({
    logger: true,
    genReqId: () => randomUUID(),
  });

  const allowlist = parseCorsOrigins();
  const isProd = process.env.NODE_ENV === "production";
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowlist.length === 0) {
        return cb(null, !isProd);
      }
      return cb(null, allowlist.includes(origin));
    },
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

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
