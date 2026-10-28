/**
 * 2026-10-28 — IDP_REAUTH step-up: the system browser's one call.
 *
 * TENANT_SCOPE_EXCEPTION: account_tier_user_scoped
 * Unauthenticated by design; the handoff token resolves exactly ONE pending
 * challenge, whose own user, workspace and Organization bind everything that
 * follows. Nothing here reads a workspace a caller names.
 *
 *   POST /v1/identity-security/step-up/handoff/idp/begin  { challengeId, token }
 *     → 200 { redirectUrl }   the forced reauthentication at the Organization's
 *                             IdP (SAML ForceAuthn / OIDC prompt=login,max_age=0)
 *     → 400 { error: { code } }  STEP_UP_HANDOFF_INVALID | IDP_REAUTH_EXPIRED |
 *                                IDP_CONNECTION_UNAVAILABLE | IDP_CONTEXT_INSUFFICIENT
 *     → 429 { error: { code: "rate_limited" } }
 *
 * UNAUTHENTICATED BY DESIGN: the system browser holds no app session. What
 * authorises the call is the single-use handoff token (hashed at rest, bound to
 * ONE pending challenge), and what approves the challenge is the IdP sign-in
 * that follows — verified in the existing SAML ACS / OIDC callback, which never
 * mints a session on this branch. The token travels in the request BODY (the
 * page reads it from the URL fragment), so it never lands in an access log.
 *
 * Every refusal is an expected, typed 4xx: none becomes an error-tracker
 * incident, and none names the Organization's IdP configuration.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import { oidcRedirectUri, samlAcsUrl } from "../services/access-control/sso-endpoints.js";
import {
  IdpStepUpBeginError,
  beginIdpStepUp,
} from "../services/identity-security/step-up-idp-flow.js";

const BeginBody = z
  .object({
    challengeId: z.string().uuid(),
    token: z.string().min(16).max(128),
  })
  .strict();

function ipPreview(req: FastifyRequest): string | null {
  const ip = req.ip ?? "";
  if (!ip) return null;
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.•••`;
  }
  return ip.slice(0, 10) + "…";
}

function uaPreview(req: FastifyRequest): string | null {
  const raw = req.headers["user-agent"];
  return typeof raw === "string" ? raw.trim().slice(0, 120) : null;
}

export async function stepUpIdpRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/v1/identity-security/step-up/handoff/idp/begin",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = BeginBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "STEP_UP_HANDOFF_INVALID" } });
      }
      const body = parsed.data;
      // Bounded per challenge, across instances: a round trip is never a hot
      // path, and a guessed challenge id must not become an unmetered probe.
      const limit = await enforceRateLimit({
        key: `step-up-handoff-idp:${body.challengeId}`,
        bound: "global",
        max: 10,
        windowSec: 600,
      });
      if (!limit.allowed) {
        return reply.code(429).send({ error: { code: "rate_limited" } });
      }
      try {
        const { redirectUrl } = await beginIdpStepUp(prisma, {
          challengeId: body.challengeId,
          handoffToken: body.token,
          samlAcsUrl: samlAcsUrl(req),
          oidcRedirectUri: oidcRedirectUri(req),
          ipPreview: ipPreview(req),
          uaPreview: uaPreview(req),
        });
        return reply.code(200).send({ redirectUrl });
      } catch (err) {
        if (err instanceof IdpStepUpBeginError) {
          return reply.code(400).send({ error: { code: err.code } });
        }
        throw err;
      }
    },
  );
}
