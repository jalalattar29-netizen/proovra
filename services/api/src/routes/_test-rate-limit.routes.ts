/**
 * Phase 2.7Z+ — E2E rate-limit reset endpoint (test-only).
 *
 * Background:
 *   Multiple Playwright specs share the same client IP (127.0.0.1)
 *   and therefore the same `ratelimit:verify:ip:127.0.0.1` bucket
 *   (and any other per-IP buckets). When the intentional 429 tests
 *   run, they saturate the bucket; subsequent specs in the run
 *   inherit the saturated state and fail with spurious 429s.
 *
 *   The historical Redis-direct scrubber in `e2e/helpers/api-client.ts`
 *   relied on `docker exec proovra_redis redis-cli --scan ... | xargs -r del`
 *   which is fragile across host shells (especially Git Bash on
 *   Windows where `xargs -r` is not universally available). When the
 *   scrubber silently failed, pollution carried forward.
 *
 *   This module replaces the docker-exec approach with an in-process
 *   API endpoint that the test helper hits via plain HTTP. The
 *   endpoint clears BOTH the in-memory map and any Redis `ratelimit:*`
 *   keys atomically and reports the counts back so the helper can
 *   verify the operation actually ran.
 *
 * Hard rules (three-layer defense, identical to auth-test-bypass):
 *
 *   1. `NODE_ENV === "production"`   → endpoint responds 404 always.
 *      Production never has a path to reach the reset, even if the
 *      env var and header somehow appear in prod.
 *
 *   2. `E2E_AUTH_BYPASS_SECRET` unset OR shorter than 32 chars
 *                                    → endpoint responds 404.
 *
 *   3. `X-E2E-Auth-Bypass` header missing or doesn't match the env
 *                                    → endpoint responds 404.
 *
 *   The same `shouldBypassAuthRateLimit` helper that gates the
 *   guest-auth bypass also gates this endpoint. The defense
 *   surface is unified — one secret, one header, one NODE_ENV
 *   guard. Operators rotating the secret get coverage on both
 *   surfaces simultaneously.
 *
 *   The 404 (not 403) response is intentional: production must
 *   never even hint that the path exists.
 *
 * Scope rules:
 *
 *   - This endpoint ONLY clears rate-limit state. It does NOT touch
 *     evidence, custody, sessions, or any other domain data.
 *   - It does NOT change limits, windows, or store selection.
 *     Production semantics for the limiter are unchanged. After
 *     reset, the next request starts counting from zero — exactly
 *     the same baseline a fresh API process would have.
 *   - It does NOT affect the public-verify route's two-layer
 *     rate-limit design (IP + per-evidence-id). Both buckets reset
 *     because both live under the same `ratelimit:*` prefix.
 *   - The X-E2E-Auth-Bypass header is NEVER consulted by any data-
 *     plane route (evidence, cases, reviewer ops). The auth-bypass
 *     and rate-limit-reset gates are the only two consumers.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  buildBypassLogPayload,
  shouldBypassAuthRateLimit,
} from "../services/auth-test-bypass.js";
import { clearAllRateLimitBuckets } from "../services/rate-limit.js";

export async function testRateLimitRoutes(app: FastifyInstance) {
  app.post("/v1/_test/rate-limit/reset", async (req: FastifyRequest, reply) => {
    // Layer 1+2+3 — gate via the same helper that protects the
    // guest-auth bypass. Production-mode + missing env + missing
    // header all collapse to a single 404 so the surface is
    // undiscoverable in production.
    if (!shouldBypassAuthRateLimit(req)) {
      return reply.code(404).send({ message: "Not found" });
    }

    const { memoryCleared, redisCleared } = await clearAllRateLimitBuckets();

    // The canonical bypass log payload (route + headerPresent, never the
    // secret) so an honored bypass is searchable in the audit log; the
    // bucket stays distinct from the guest-auth bypass surface.
    req.log.info(
      {
        ...buildBypassLogPayload(req),
        bucket: "e2e-rate-limit-reset",
        memoryCleared,
        redisCleared,
      },
      "test.rate_limit.reset",
    );

    return reply.code(200).send({
      cleared: true,
      memoryCleared,
      redisCleared,
    });
  });
}
