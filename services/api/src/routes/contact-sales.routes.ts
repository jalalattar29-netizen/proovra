// Public Contact Sales submission route.
//
// Receives the payload the web `/api/contact-sales` proxy forwards
// (normalized — empty optionals already stripped). Delegates to
// `createContactSalesRequest` which persists the row and best-effort
// dispatches operator + visitor email. Returns 201 with the new
// record id on success; validation errors surface as 400 via the
// app error handler so the marketing proxy can show a clear error
// state instead of fail-open.
//
// TENANT_SCOPE_EXCEPTION: public_verify_token_readonly
//   This route is the public unauthenticated marketing lead intake
//   endpoint. It is intentionally not gated by `authorizeOrFail` /
//   `requireAuthorize` because the visitor is anonymous at submission
//   time — no `userId`, no `teamId`, no workspace context exists yet.
//   The handler writes to `contact_sales_requests`, a standalone
//   marketing lead table with NO `team_id` / `user_id` foreign keys
//   and NO relation to any tenant evidence record. It NEVER reads
//   tenant data, NEVER queries another team's records, and NEVER
//   joins to evidence / cases / reports. Cross-workspace access is
//   structurally impossible because there is no workspace dimension
//   in the schema for this table. Anti-abuse is layered by:
//     * web-tier same-origin guard + per-intent / per-IP rate limit
//       (5 / 5min) in `apps/web/app/api/_marketing-leads.ts`
//     * `createContactSalesRequest` honeypot + IP-hammer + duplicate
//       detection inside the service layer
//     * shared zod schema validation rejects malformed payloads
//   Operators triage the resulting rows from `/admin/contact-sales`
//   (gated by `requirePlatformAdmin`).

import type { FastifyInstance, FastifyRequest } from "fastify";
import { createContactSalesRequest } from "../services/contact-sales.service.js";

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

export async function contactSalesRoutes(app: FastifyInstance) {
  app.post("/v1/contact-sales", async (req, reply) => {
    const result = await createContactSalesRequest(req.body, {
      ipAddress: readIp(req),
      userAgent: readHeader(req, "user-agent"),
    });

    return reply.code(201).send(result);
  });
}
