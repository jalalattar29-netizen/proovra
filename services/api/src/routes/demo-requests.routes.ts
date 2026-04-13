import type { FastifyInstance, FastifyRequest } from "fastify";
import { createDemoRequest } from "../services/demo-request.service.js";

function readHeader(req: FastifyRequest, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readIp(req: FastifyRequest): string | null {
  const forwarded = readHeader(req, "x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? null;
}

export async function demoRequestsRoutes(app: FastifyInstance) {
  app.post("/v1/demo-requests", async (req, reply) => {
    const result = await createDemoRequest(req.body, {
      ipAddress: readIp(req),
      userAgent: readHeader(req, "user-agent"),
    });

    return reply.code(201).send(result);
  });
}