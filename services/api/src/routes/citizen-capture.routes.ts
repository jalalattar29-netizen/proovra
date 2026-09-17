/**
 * Citizen Capture routes — RETIRED (UC-0, 2026-09-16).
 *
 *   POST  /v1/intake/citizen/sessions              — 410 CITIZEN_CAPTURE_RETIRED
 *   POST  /v1/intake/citizen/sessions/:id/capture  — 410 CITIZEN_CAPTURE_RETIRED
 *
 * TENANT_SCOPE_EXCEPTION: public_verify_token_readonly
 *   Anonymous by design; the handlers read and write nothing.
 *
 * WHY RETIRED, NOT REPAIRED
 * ---------------------------------------------------------------------------
 * This was a second, weaker public intake beside the canonical one
 * (/v1/external-intake/*), and it could not be made truthful without becoming
 * a copy of it:
 *
 *   * It labelled any file picked from disk (`<input type="file">`) as
 *     "Class B — Browser captured" and recorded the upload source as
 *     MOBILE_APP. The material was an upload, not a capture, and not mobile.
 *   * It was anchored on the intake link's database ID — an identifier, not
 *     the link's secret token — so anyone who learned an id could write
 *     evidence into that workspace. It skipped the intake session, consent and
 *     identity rules the canonical flow enforces, and its own page passed the
 *     URL token where the id was expected, so it never worked from its page.
 *   * It carried the whole asset as base64 inside a JSON body (under the 1 MiB
 *     default body limit) and minted its own session ids and nonces.
 *
 * A contributor submitting through an intake link now uses the canonical
 * secure intake flow (/intake/[token]), which records acquisition
 * SECURE_INTAKE_LINK, uploads bytes to storage through presigned URLs, and
 * enforces consent. The web page at /intake/[token]/capture hands off to it.
 *
 * The public bound below is kept: a retired public endpoint is still a public
 * endpoint, and the limiter costs nothing while it keeps probing bounded.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

// PHASE1-002 — the one trusted-client-IP binding; see `clientIp` below.
import { trustedClientIpKey } from "../middleware/client-ip.js";
import { enforceRateLimit } from "../services/rate-limit.js";

// ---------------------------------------------------------------------------
// FINAL-004 (2026-08-15) — the anti-abuse control this file's own header
// promised ("rate-limited by IP + bounded asset size") existed only as prose.
// The size bound was real; the rate limit was never written. Both routes are
// unauthenticated and both WRITE: opening a session inserts a Device row, and
// capture ingests up to 32 MiB and creates evidence. Anyone holding an intake
// link id could therefore drive unbounded row and object creation into the
// workspace anchored on it, at whatever rate they could issue requests.
//
// The shape is deliberately the same two-layer bound the sibling public intake
// surface uses in `external-intake.routes.ts` — per-IP and per-capability —
// because "the other public intake surface does it differently" is how one of
// the two ends up forgotten again.
// ---------------------------------------------------------------------------
const CITIZEN_INTAKE_RATE_LIMIT_PER_IP_PER_MIN = 30;
const CITIZEN_INTAKE_RATE_LIMIT_PER_TOKEN_PER_MIN = 20;

/**
 * PHASE1-002 (2026-08-16) — the per-IP bound MUST NOT trust a header the
 * caller controls.
 *
 * The first version of this read `x-forwarded-for` unconditionally and keyed
 * the limiter on its first value. On a deployment where `API_TRUST_PROXY` is
 * unset — which is this service's documented safe default — that header is
 * attacker-supplied, so sending a different `X-Forwarded-For` on every request
 * yielded a fresh bucket every time. The per-IP limit was defeated by one
 * header, on the exact surface the limit was added to protect, while reading in
 * review as though the surface were bounded.
 *
 * `getTrustedClientIp` is the authority that already answers this question for
 * capture-environment recording: it returns the socket IP unless the deployment
 * has explicitly declared itself to be behind a proxy, and only then consults
 * CF-Connecting-IP / the first PUBLIC forwarded hop. Using it here means the
 * limiter and the evidence metadata agree about who the caller is, and the
 * trust decision lives in one place instead of two.
 *
 * The per-token layer below is deliberately kept as well: a distributed
 * attacker with many real source addresses defeats any per-IP bound, and the
 * intake-link id is the thing that identifies which surface is being driven.
 */
function clientIp(req: FastifyRequest): string {
  return trustedClientIpKey(req);
}

/**
 * Two-layer public-intake bound. `capabilityKey` is the intake-link id for the
 * open-session call and the capture-session id for ingest — the value that
 * identifies WHICH citizen surface is being driven, never a secret worth
 * storing whole, so only a bounded prefix reaches the limiter key.
 */
async function applyCitizenRateLimits(
  req: FastifyRequest,
  reply: FastifyReply,
  capabilityKey: string,
): Promise<boolean> {
  const ipResult = await enforceRateLimit({
    key: `citizen-intake:ip:${clientIp(req)}`,
    max: CITIZEN_INTAKE_RATE_LIMIT_PER_IP_PER_MIN,
    windowSec: 60,
  });
  if (!ipResult.allowed) {
    reply.code(429).send({ error: { code: "RATE_LIMITED", scope: "ip" } });
    return false;
  }

  const tokenResult = await enforceRateLimit({
    key: `citizen-intake:token:${capabilityKey.slice(0, 32)}`,
    max: CITIZEN_INTAKE_RATE_LIMIT_PER_TOKEN_PER_MIN,
    windowSec: 60,
  });
  if (!tokenResult.allowed) {
    reply.code(429).send({ error: { code: "RATE_LIMITED", scope: "token" } });
    return false;
  }
  return true;
}

const RETIRED_BODY = {
  denial: "CITIZEN_CAPTURE_RETIRED",
  replacement: "/intake/{token}",
} as const;

export async function citizenCaptureRoutes(app: FastifyInstance) {
  app.post(
    "/v1/intake/citizen/sessions",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const capability = z
        .object({ intakeTokenId: z.string().min(1).max(120) })
        .safeParse(req.body);
      const key = capability.success ? capability.data.intakeTokenId : "unparsed";
      if (!(await applyCitizenRateLimits(req, reply, key))) return;
      return reply.code(410).send(RETIRED_BODY);
    },
  );

  app.post(
    "/v1/intake/citizen/sessions/:id/capture",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z.object({ id: z.string().min(1).max(64) }).safeParse(req.params);
      const key = params.success ? params.data.id : "unparsed";
      if (!(await applyCitizenRateLimits(req, reply, key))) return;
      return reply.code(410).send(RETIRED_BODY);
    },
  );
}
