/**
 * Phase IA-home-acceptance — dev/staging-only impersonation login.
 *
 *   GET /v1/dev/login?persona=pro-empty | pro-populated | pro-issues | team-org
 *
 * Mints a real PROOVRA session token (the EXACT same `signJwt` the
 * production email-login route uses) for one of the fixed acceptance
 * personas, so the Playwright Home acceptance suite can reach the
 * authenticated `/home` surface without a real OAuth/magic-link flow.
 *
 * It lives under `src/dev/` (NOT `src/routes/`) deliberately: it is not
 * a product route surface, and the route-inventory guards intentionally
 * only enumerate `src/routes/`.
 *
 * HARD SAFETY (three layers, matching the house pattern used by the
 * operational-seeding + e2e-auth-bypass surfaces):
 *
 *   1. The plugin is only REGISTERED when `DEV_AUTH_ENABLED === "true"`
 *      AND `NODE_ENV !== "production"` (see server.ts). In production
 *      the surface does not exist at all.
 *   2. The handler itself re-checks both conditions and 404s otherwise,
 *      so even a mis-registration in production is inert.
 *   3. Only the four hard-coded persona keys are accepted — there is
 *      no way to mint a token for an arbitrary user id.
 *
 * It writes NOTHING to the database and emits no audit event. It only
 * signs a token for a user the seed script already created.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { getSecret } from "../config/runtime-secrets.js";
import { signJwt } from "../services/jwt.js";
import { HOME_PERSONAS, isHomePersonaKey } from "./home-personas.js";

/** True only outside production AND when explicitly opted in. */
export function devAuthEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.DEV_AUTH_ENABLED === "true"
  );
}

export async function devLoginRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/v1/dev/login",
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Layer 2 — the handler refuses even if somehow registered in prod.
      if (!devAuthEnabled()) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }

      const persona = (req.query as { persona?: string } | undefined)?.persona;
      if (!persona || !isHomePersonaKey(persona)) {
        return reply.code(400).send({
          error: {
            code: "invalid_persona",
            message:
              "persona must be one of: pro-empty, pro-populated, pro-issues, team-org",
          },
        });
      }

      const secret = getSecret("AUTH_JWT_SECRET");
      if (!secret) {
        return reply.code(500).send({ error: { code: "auth_secret_unset" } });
      }

      const p = HOME_PERSONAS[persona];

      // Identical shape + lifetime model to the production email-login
      // mint. provider is a clearly-labelled dev value so a session
      // minted this way is auditable as an impersonation.
      const token = signJwt(
        { sub: p.userId, provider: "DEV_IMPERSONATION", email: p.email },
        secret,
        60 * 60 * 24, // 24h — long enough for an e2e run, short by design
      );

      // Mirror the production web-cookie behaviour (only when the web
      // client signals itself). Dev origin → secure:false, no domain.
      if (req.headers["x-web-client"] === "1") {
        reply.clearCookie("proovra_session", { path: "/" });
        reply.setCookie("proovra_session", token, {
          httpOnly: true,
          secure: false,
          sameSite: "lax",
          path: "/",
          maxAge: 60 * 60 * 24,
        });
      }

      return reply.code(200).send({
        token,
        persona: p.key,
        user: { id: p.userId, email: p.email, provider: "DEV_IMPERSONATION" },
        workspace: { id: p.workspaceId, type: p.workspaceType },
      });
    },
  );
}

export default devLoginRoutes;
