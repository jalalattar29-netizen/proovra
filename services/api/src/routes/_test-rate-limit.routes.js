import { shouldBypassAuthRateLimit } from "../services/auth-test-bypass.js";
import { clearAllRateLimitBuckets } from "../services/rate-limit.js";
export async function testRateLimitRoutes(app) {
    app.post("/v1/_test/rate-limit/reset", async (req, reply) => {
        // Layer 1+2+3 — gate via the same helper that protects the
        // guest-auth bypass. Production-mode + missing env + missing
        // header all collapse to a single 404 so the surface is
        // undiscoverable in production.
        if (!shouldBypassAuthRateLimit(req)) {
            return reply.code(404).send({ message: "Not found" });
        }
        const { memoryCleared, redisCleared } = await clearAllRateLimitBuckets();
        req.log.info({
            bucket: "e2e-rate-limit-reset",
            memoryCleared,
            redisCleared,
        }, "test.rate_limit.reset");
        return reply.code(200).send({
            cleared: true,
            memoryCleared,
            redisCleared,
        });
    });
}
