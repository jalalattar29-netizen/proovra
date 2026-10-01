/**
 * UC-1 — first-party extension OAuth routes (Authorization Code + PKCE S256).
 *
 *   GET  /v1/oauth/extension/authorize   (the user's PROOVRA session)
 *   POST /v1/oauth/extension/token       (public — exchanges a PKCE-bound code)
 *   POST /v1/oauth/extension/revoke      (the extension token itself — sign-out)
 *
 * The authorize step issues a single-use, short-lived code bound to the client,
 * the redirect URI, the PKCE challenge and the AUTHORIZING session's provenance,
 * then redirects to the extension's chromiumapp.org callback. The token step
 * exchanges it for a short-lived AUTH_JWT the canonical requireAuth accepts, and
 * REGISTERS it as an authenticated session (UC-SEC-004 / UC-EXT-009), so
 * organization session policy, the role session-timeout, the user's session
 * list and per-session revocation all reach it. No second auth system, no
 * embedded secret, no long-lived credential.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { bump } from "@proovra/shared-runtime";

import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import {
  signJwt,
  verifyJwt,
  resolveSupportedProvenance,
} from "../services/jwt.js";
import { getSecret } from "../config/runtime-secrets.js";
import { EXTENSION_CAPTURE_SCOPE } from "../services/auth/extension-scope.js";
import { recordAuthenticatedSession } from "../services/access-control/session-inventory.service.js";
import { revokeSession } from "../services/identity-security/session-revocation.service.js";
import {
  EXTENSION_ACCESS_TOKEN_TTL_SECONDS,
  EXTENSION_OAUTH_CODE_MAX_LENGTH,
  ExtensionOAuthError,
  createExtensionAuthCode,
  exchangeExtensionAuthCode,
  isAllowedExtensionRedirect,
  normalizeExtensionScope,
  type ExtensionAuthProvenance,
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
  code: z.string().min(10).max(EXTENSION_OAUTH_CODE_MAX_LENGTH),
  code_verifier: z.string().min(43).max(128),
  client_id: z.string().min(1).max(64),
  redirect_uri: z.string().min(1).max(512),
});

/**
 * UC-EXT-006 — where a signed-out browser is sent to sign in. The web login
 * accepts only a same-origin RELATIVE `next`, so the return path is the web's
 * `/auth/extension/continue` bridge, which re-enters THIS authorize request with
 * the same (already validated) parameters once the user is signed in.
 */
export const EXTENSION_AUTHORIZE_CONTINUE_PATH = "/auth/extension/continue";

function webBaseUrl(): string {
  return (process.env.WEB_BASE_URL || "https://www.proovra.com").replace(
    /\/+$/,
    "",
  );
}

export function buildExtensionSignInRedirect(
  q: z.infer<typeof AuthorizeQuery>,
): string {
  const params = new URLSearchParams({
    response_type: q.response_type,
    client_id: q.client_id,
    redirect_uri: q.redirect_uri,
    code_challenge: q.code_challenge,
    code_challenge_method: q.code_challenge_method,
    state: q.state,
    ...(q.scope ? { scope: q.scope } : {}),
  });
  const next = `${EXTENSION_AUTHORIZE_CONTINUE_PATH}?${params.toString()}`;
  return `${webBaseUrl()}/login?next=${encodeURIComponent(next)}`;
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const p = part.trim();
    if (p.startsWith(`${name}=`))
      return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

/** Does the request carry a credential that is at least a valid, unexpired JWT? */
function hasVerifiableCredential(req: FastifyRequest): boolean {
  const auth = req.headers.authorization ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const cookie =
    (req.cookies as { proovra_session?: string } | undefined)
      ?.proovra_session ?? readCookie(req.headers.cookie, "proovra_session");
  const token = bearer || cookie;
  if (!token) return false;
  const secret = getSecret("AUTH_JWT_SECRET");
  if (!secret) return false;
  try {
    const payload = verifyJwt(token, secret);
    return payload.mfa !== "pending";
  } catch {
    return false;
  }
}

/** A top-level browser navigation (the auth window), as opposed to an API call. */
function isBrowserNavigation(req: FastifyRequest): boolean {
  const mode = req.headers["sec-fetch-mode"];
  if (mode === "navigate") return true;
  const accept = req.headers.accept ?? "";
  return typeof accept === "string" && accept.includes("text/html");
}

function uaPreview(req: FastifyRequest): string {
  const raw = req.headers["user-agent"];
  const ua = typeof raw === "string" ? raw.trim() : "";
  return `PROOVRA browser extension${ua ? ` · ${ua}` : ""}`.slice(0, 120);
}

function ipPreview(req: FastifyRequest): string | null {
  const ip = req.ip ?? "";
  if (!ip) return null;
  const parts = ip.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.•••`;
  return `${ip.slice(0, 10)}…`;
}

/** The authorizing session's provenance and workspace anchor (UC-SEC-004). */
async function authorizingProvenance(
  req: FastifyRequest,
  userId: string,
): Promise<ExtensionAuthProvenance | null> {
  const u = req.user as
    | {
        authMethod?: string | null;
        authAt?: number | null;
        ssoConnId?: string | null;
        mfaAt?: number | null;
        sessionIdHash?: string | null;
      }
    | undefined;
  const method = resolveSupportedProvenance(u?.authMethod ?? null);
  if (!method) return null;
  let teamId: string | null = null;
  if (u?.sessionIdHash) {
    const row = await prisma.authenticatedSession.findFirst({
      where: { userId, sessionIdHash: u.sessionIdHash },
      select: { teamId: true },
    });
    teamId = row?.teamId ?? null;
  }
  if (!teamId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { currentWorkspaceId: true },
    });
    teamId = user?.currentWorkspaceId ?? null;
  }
  return {
    authMethod: method,
    authAt: typeof u?.authAt === "number" ? u.authAt : null,
    ssoConnId: typeof u?.ssoConnId === "string" ? u.ssoConnId : null,
    mfaAt: typeof u?.mfaAt === "number" ? u.mfaAt : null,
    teamId,
  };
}

/**
 * UC-EXT-006 — runs BEFORE requireAuth on authorize. A signed-out user in the
 * extension's auth window is sent to sign in, with a validated return path back
 * to this request; it used to get a 401 JSON body they could do nothing with.
 * The client + redirect are checked first, so an unregistered redirect is
 * refused here and never bounced through the sign-in page. Everything else
 * (an API caller, a present credential) falls through to requireAuth.
 */
async function extensionSignInRedirect(
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const parsed = AuthorizeQuery.safeParse(req.query ?? {});
  if (!parsed.success) return; // the handler answers invalid_request after auth
  const q = parsed.data;
  if (!isAllowedExtensionRedirect(q.client_id, q.redirect_uri)) {
    return reply.code(400).send({ error: "INVALID_CLIENT_OR_REDIRECT" });
  }
  if (!hasVerifiableCredential(req) && isBrowserNavigation(req)) {
    return reply.code(302).redirect(buildExtensionSignInRedirect(q));
  }
  return;
}

export async function extensionOAuthRoutes(app: FastifyInstance) {
  app.get(
    "/v1/oauth/extension/authorize",
    { preHandler: [extensionSignInRedirect, requireAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = AuthorizeQuery.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const q = parsed.data;
      const userId = getAuthUserId(req);

      try {
        const provenance = await authorizingProvenance(req, userId);
        if (!provenance) {
          return reply.code(401).send({ error: "reauthentication_required" });
        }
        const { code } = await createExtensionAuthCode({
          userId,
          clientId: q.client_id,
          redirectUri: q.redirect_uri,
          codeChallenge: q.code_challenge,
          codeChallengeMethod: q.code_challenge_method,
          scope: normalizeExtensionScope(),
          provenance,
        });
        const url = new URL(q.redirect_uri);
        url.searchParams.set("code", code);
        url.searchParams.set("state", q.state);
        return reply.code(302).redirect(url.toString());
      } catch (err) {
        if (err instanceof ExtensionOAuthError) {
          // UC-LCH-002 — an authorize/token refusal (the signed-out sign-in redirect is not one).
          bump("extension_oauth_failed_total");
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
        const { userId, scope, provenance } = await exchangeExtensionAuthCode({
          code: b.code,
          codeVerifier: b.code_verifier,
          clientId: b.client_id,
          redirectUri: b.redirect_uri,
        });
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, provider: true, email: true },
        });
        if (!user) return reply.code(400).send({ error: "invalid_grant" });

        const secret = getSecret("AUTH_JWT_SECRET");
        if (!secret)
          return reply.code(500).send({ error: "server_misconfigured" });
        // The extension token deliberately carries NO elevated role. Direct Web
        // Capture needs only evidence.create in the chosen workspace (enforced by
        // authorizeOrFail on every capture call), never platform-admin — so an
        // admin user's capture token must not confer admin.
        const accessToken = signJwt(
          {
            sub: user.id,
            provider: user.provider,
            email: user.email,
            // UC-SEC-004 — the AUTHORIZING session's real ceremony, not a
            // hard-coded SOCIAL_OAUTH, so SSO-mandatory organization policy
            // judges the extension token by how the user actually signed in.
            authMethod: provenance.authMethod,
            authAt: provenance.authAt ?? Math.floor(Date.now() / 1000),
            ...(provenance.ssoConnId
              ? { ssoConnId: provenance.ssoConnId }
              : {}),
            ...(provenance.mfaAt ? { mfaAt: provenance.mfaAt } : {}),
            // UC-1 §4.1 — the RESTRICTED scope. requireAuth refuses this token on
            // any route outside the capture allowlist (extension-scope.ts).
            scope: EXTENSION_CAPTURE_SCOPE,
          } as never,
          secret,
          EXTENSION_ACCESS_TOKEN_TTL_SECONDS,
        );

        // UC-SEC-004 / UC-EXT-009 — register the token's session (its `sid`),
        // anchored to the authorizing session's workspace. requireAuth then runs
        // the organization security gate and the role session-timeout against
        // it, it appears in the user's session list, and it can be revoked on
        // its own. FAIL CLOSED: a token whose session could not be registered
        // would escape all of that, so it is not issued.
        const claims = JSON.parse(
          Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString(
            "utf8",
          ),
        ) as {
          sid?: string;
          iat?: number;
          exp?: number;
        };
        if (
          typeof claims.sid !== "string" ||
          typeof claims.iat !== "number" ||
          typeof claims.exp !== "number"
        ) {
          return reply.code(500).send({ error: "server_misconfigured" });
        }
        try {
          await recordAuthenticatedSession({
            userId: user.id,
            teamId: provenance.teamId,
            sid: claims.sid,
            iat: claims.iat,
            exp: claims.exp,
            ssoConnectionId: provenance.ssoConnId,
            ipPreview: ipPreview(req),
            uaPreview: uaPreview(req),
          });
        } catch (err) {
          req.log.error(
            {
              errorMessage:
                err instanceof Error ? err.message : "session_record_failed",
            },
            "extension_oauth.session_record_failed",
          );
          return reply.code(503).send({ error: "temporarily_unavailable" });
        }

        return reply.code(200).send({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: EXTENSION_ACCESS_TOKEN_TTL_SECONDS,
          scope,
          account: user.email ?? null,
        });
      } catch (err) {
        if (err instanceof ExtensionOAuthError) {
          // UC-LCH-002 — an authorize/token refusal (the signed-out sign-in redirect is not one).
          bump("extension_oauth_failed_total");
          return reply.code(err.httpStatus).send({ error: err.code });
        }
        throw err;
      }
    },
  );

  // UC-EXT-009 — the extension's sign-out. Revokes THIS token's session
  // (SINGLE_SESSION by its sid), so a copied token stops working at once rather
  // than living out its hour. Only an extension token may call it, and only for
  // itself.
  app.post(
    "/v1/oauth/extension/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      const u = req.user as
        | { tokenScope?: string | null; sessionIdHash?: string | null }
        | undefined;
      if (u?.tokenScope !== EXTENSION_CAPTURE_SCOPE) {
        return reply.code(403).send({ error: "not_an_extension_token" });
      }
      if (!u.sessionIdHash)
        return reply.code(400).send({ error: "no_session" });
      const row = await prisma.authenticatedSession.findFirst({
        where: { userId, sessionIdHash: u.sessionIdHash },
        select: { teamId: true },
      });
      await revokeSession({
        userId,
        sessionIdHash: u.sessionIdHash,
        teamId: row?.teamId ?? null,
        reason: "USER_LOGGED_OUT",
        actorUserId: userId,
      });
      await prisma.authenticatedSession.updateMany({
        where: { userId, sessionIdHash: u.sessionIdHash, revokedAtUtc: null },
        data: {
          revokedAtUtc: new Date(),
          revokedByUserId: userId,
          revokedReason: "EXTENSION_SIGN_OUT",
        },
      });
      return reply.code(200).send({ revoked: true });
    },
  );
}
