/**
 * PRO-034 (AUTH-28) — POST /v1/auth/oauth/nonce.
 *
 * The nonce a Google or Apple ceremony signs into its id_token. A client asks
 * for one before the provider prompt; the sign-in (`/v1/auth/google|apple`) or
 * link (`/v1/identity/links/google|apple`) that presents the resulting token
 * consumes it once (services/auth/social-sign-in-nonce.service.ts). Public, so
 * rate-limited per trusted client address, like the other public auth routes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { trustedClientIpKey } from "../middleware/client-ip.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import {
  issueSocialSignInNonce,
  SOCIAL_NONCE_TTL_SECONDS,
} from "../services/auth/social-sign-in-nonce.service.js";

const NonceBody = z.object({ provider: z.enum(["google", "apple"]) });
const NONCE_RATE_LIMIT_PER_IP_PER_MIN = 30;

export async function socialSignInNonceRoutes(app: FastifyInstance) {
  app.post("/v1/auth/oauth/nonce", async (req: FastifyRequest, reply: FastifyReply) => {
    const rl = await enforceRateLimit({
      key: `auth:oauth-nonce:ip:${trustedClientIpKey(req).slice(0, 200)}`,
      bound: "global",
      max: NONCE_RATE_LIMIT_PER_IP_PER_MIN,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(Math.max(1, Math.ceil((rl.resetAtMs - Date.now()) / 1000))))
        .send({ error: { code: "RATE_LIMITED", message: "Too many requests. Try again shortly." } });
    }
    const parsed = NonceBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: "INVALID_REQUEST", message: "provider must be google or apple." } });
    }
    const issued = await issueSocialSignInNonce(
      req,
      reply,
      parsed.data.provider === "google" ? "GOOGLE" : "APPLE",
    );
    return reply.code(200).send({ nonce: issued.nonce, expiresInSeconds: SOCIAL_NONCE_TTL_SECONDS });
  });
}
