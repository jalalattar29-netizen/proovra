/**
 * UC-1 — first-party extension OAuth routes (Authorization Code + PKCE S256).
 *
 *   GET  /v1/oauth/extension/authorize   (requireAuth — the user is signed in)
 *   POST /v1/oauth/extension/token       (public — exchanges a PKCE-bound code)
 *
 * The authorize step issues a single-use, short-lived code bound to the client,
 * the redirect URI and the PKCE challenge, then redirects to the extension's
 * chromiumapp.org callback. The token step exchanges it for a short-lived
 * AUTH_JWT the canonical requireAuth already accepts. No second auth system, no
 * embedded secret, no long-lived credential.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { signJwt } from "../services/jwt.js";
import { getSecret } from "../config/runtime-secrets.js";
import {
  EXTENSION_ACCESS_TOKEN_TTL_SECONDS,
  ExtensionOAuthError,
  createExtensionAuthCode,
  exchangeExtensionAuthCode,
} from "../services/auth/extension-oauth.service.js";

const AuthorizeQuery = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1).max(64),
  redirect_uri: z.string().min(1).max(512),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  state: z.string().min(1).max(256),
  scope: z.string().max(120).optional(),
});

const TokenBody = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().min(10).max(200),
  code_verifier: z.string().min(43).max(128),
  client_id: z.string().min(1).max(64),
  redirect_uri: z.string().min(1).max(512),
});

export async function extensionOAuthRoutes(app: FastifyInstance) {
  app.get(
    "/v1/oauth/extension/authorize",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      const parsed = AuthorizeQuery.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const q = parsed.data;
      try {
        const { code } = await createExtensionAuthCode({
          userId,
          clientId: q.client_id,
          redirectUri: q.redirect_uri,
          codeChallenge: q.code_challenge,
          codeChallengeMethod: q.code_challenge_method,
          scope: q.scope ?? "capture.direct",
        });
        const url = new URL(q.redirect_uri);
        url.searchParams.set("code", code);
        url.searchParams.set("state", q.state);
        return reply.code(302).redirect(url.toString());
      } catch (err) {
        if (err instanceof ExtensionOAuthError) {
          return reply.code(err.httpStatus).send({ error: err.code });
        }
        throw err;
      }
    },
  );

  app.post(
    "/v1/oauth/extension/token",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = TokenBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const b = parsed.data;
      try {
        const { userId, scope } = await exchangeExtensionAuthCode({
          code: b.code,
          codeVerifier: b.code_verifier,
          clientId: b.client_id,
          redirectUri: b.redirect_uri,
        });
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, provider: true, email: true, platformRole: true },
        });
        if (!user) return reply.code(400).send({ error: "invalid_grant" });

        const secret = getSecret("AUTH_JWT_SECRET");
        if (!secret) return reply.code(500).send({ error: "server_misconfigured" });
        const accessToken = signJwt(
          {
            sub: user.id,
            provider: user.provider,
            email: user.email,
            authMethod: "SOCIAL_OAUTH",
            authAt: Math.floor(Date.now() / 1000),
            ...(user.platformRole === "admin" ? { role: "admin" as const } : {}),
          } as never,
          secret,
          EXTENSION_ACCESS_TOKEN_TTL_SECONDS,
        );
        return reply.code(200).send({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: EXTENSION_ACCESS_TOKEN_TTL_SECONDS,
          scope,
          account: user.email ?? null,
        });
      } catch (err) {
        if (err instanceof ExtensionOAuthError) {
          return reply.code(err.httpStatus).send({ error: err.code });
        }
        throw err;
      }
    },
  );
}
