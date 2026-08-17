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
import { trustedClientIp, trustedClientIpKey } from "../middleware/client-ip.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import { createContactSalesRequest } from "../services/contact-sales.service.js";

function readHeader(req: FastifyRequest, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * PHASE1-005 — the RECORDED address must be trustworthy too, not just the
 * limiter key.
 *
 * `createContactSalesRequest` counts recent rows sharing this `ipAddress` as a
 * hammer signal. Derived from a raw `x-forwarded-for` that signal could be
 * defeated by rotating one header, and the value an operator later reads while
 * triaging the row was whatever the sender chose to put there.
 */
function readIp(req: FastifyRequest): string | null {
  return trustedClientIp(req);
}

/**
 * PHASE1-005 (2026-08-16) — an unauthenticated public WRITE with no bound.
 *
 * FINAL-004 fixed exactly this shape on the citizen-intake routes. The public
 * lead-capture pair was the same thing and was not looked at: no auth, no
 * token, no rate limit, and a `prisma.contactSalesRequest.create` at the end of
 * it. The input schema bounds each FIELD, which is why this reads as safe on a
 * quick pass — but nothing bounded the number of REQUESTS, so anyone could
 * insert rows into the sales pipeline for as long as they cared to.
 *
 * The header above lists an "IP-hammer" control in the service layer, and that
 * is the reason this went unnoticed. It is a SPAM SCORE, not a bound: hitting
 * it sets `isSpam`, which downgrades priority and suppresses the auto-reply.
 * `prisma.contactSalesRequest.create` runs either way. A control that changes
 * how a row is filed is not a control that stops the row being written, and the
 * web-tier limit it also cites protects the Next proxy, not this route, which
 * is reachable directly.
 *
 * The bound is per-IP and deliberately generous: a real prospect fills this in
 * once, and a shared corporate NAT should never hit it.
 */
const CONTACT_SALES_RATE_LIMIT_PER_IP_PER_MIN = 5;

export async function contactSalesRoutes(app: FastifyInstance) {
  app.post("/v1/contact-sales", async (req, reply) => {
    const rl = await enforceRateLimit({
      key: `contact-sales:ip:${trustedClientIpKey(req)}`,
      max: CONTACT_SALES_RATE_LIMIT_PER_IP_PER_MIN,
      windowSec: 60,
    });
    if (!rl.allowed) {
      // Refused BEFORE the write, so a rate-limited request leaves no row.
      return reply
        .code(429)
        .header("Retry-After", String(Math.max(1, Math.ceil((rl.resetAtMs - Date.now()) / 1000))))
        .send({ error: { code: "RATE_LIMITED" } });
    }

    const result = await createContactSalesRequest(req.body, {
      ipAddress: readIp(req),
      userAgent: readHeader(req, "user-agent"),
    });

    return reply.code(201).send(result);
  });
}
