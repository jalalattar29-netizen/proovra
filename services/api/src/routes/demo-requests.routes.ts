import type { FastifyInstance, FastifyRequest } from "fastify";
import { trustedClientIp, trustedClientIpKey } from "../middleware/client-ip.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import { createDemoRequest } from "../services/demo-request.service.js";

function readHeader(req: FastifyRequest, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** PHASE1-005 — see `contact-sales.routes.ts`; the recorded IP is a signal too. */
function readIp(req: FastifyRequest): string | null {
  return trustedClientIp(req);
}

/** PHASE1-005 — see `contact-sales.routes.ts`; this is the same public write. */
const DEMO_REQUEST_RATE_LIMIT_PER_IP_PER_MIN = 5;

export async function demoRequestsRoutes(app: FastifyInstance) {
  app.post("/v1/demo-requests", async (req, reply) => {
    const rl = await enforceRateLimit({
      key: `demo-requests:ip:${trustedClientIpKey(req)}`,
      max: DEMO_REQUEST_RATE_LIMIT_PER_IP_PER_MIN,
      windowSec: 60,
    });
    if (!rl.allowed) {
      // Refused BEFORE the write, so a rate-limited request leaves no row.
      return reply
        .code(429)
        .header("Retry-After", String(Math.max(1, Math.ceil((rl.resetAtMs - Date.now()) / 1000))))
        .send({ error: { code: "RATE_LIMITED" } });
    }

    const result = await createDemoRequest(req.body, {
      ipAddress: readIp(req),
      userAgent: readHeader(req, "user-agent"),
    });

    return reply.code(201).send(result);
  });
}