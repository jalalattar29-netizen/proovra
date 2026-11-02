/**
 * IDENT-007 / MOBILE-007 — the sign-in step for a person whose organization
 * requires MFA and who has no factor yet.
 *
 * Enforcement sits before the session, and enrolment needs an authenticated
 * caller. This token is what lets the two meet: proof that the primary sign-in
 * succeeded, good for a short time and for the enrolment routes only, through
 * the same restricted-scope boundary `requireAuth` applies to the extension
 * token. It opens no workspace and reads no data. A full session exists only
 * after a factor has been verified, through `POST /v1/auth/mfa/enrollment/complete`.
 *
 * The browser holds it in its own HTTP-only cookie, never `proovra_session`, so
 * nothing else in the product mistakes a half-finished sign-in for a session.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

import { isProovraProductionRequest } from "../../http/cors-origin-policy.js";
import { getSecret } from "../../config/runtime-secrets.js";
import { signJwt, verifyJwt, type JwtPayload } from "../jwt.js";
import { MFA_ENROLLMENT_SCOPE } from "./extension-scope.js";

export const MFA_ENROLLMENT_COOKIE = "proovra_mfa_enroll";
export const MFA_ENROLLMENT_TTL_SECONDS = 15 * 60;

type EnrollmentClaims = { scope: typeof MFA_ENROLLMENT_SCOPE; enrolledFactorId?: string };

export function signMfaEnrollmentToken(
  payload: JwtPayload,
  secret: string,
  enrolledFactorId?: string,
): string {
  const claims: EnrollmentClaims = {
    scope: MFA_ENROLLMENT_SCOPE,
    ...(enrolledFactorId ? { enrolledFactorId } : {}),
  };
  return signJwt({ ...payload, ...claims } as JwtPayload, secret, MFA_ENROLLMENT_TTL_SECONDS);
}

/**
 * A verified factor is what the holder of THIS token proved, so the proof is
 * carried on the token. A factor the same account gained some other way in the
 * same fifteen minutes finishes nothing for a holder who only has the password.
 */
export function enrolledFactorIdOf(token: string): string | null {
  const secret = getSecret("AUTH_JWT_SECRET");
  if (!secret) return null;
  const claims = verifyJwt(token, secret) as JwtPayload & EnrollmentClaims;
  if (claims.scope !== MFA_ENROLLMENT_SCOPE) return null;
  return typeof claims.enrolledFactorId === "string" ? claims.enrolledFactorId : null;
}

/** The token that can complete the sign-in, once this request verified `factorId`. */
export function issueEnrolledToken(
  req: FastifyRequest,
  reply: FastifyReply,
  factorId: string,
): string {
  const user = req.user;
  const secret = getSecret("AUTH_JWT_SECRET");
  if (!user || !secret) throw new Error("mfa enrollment: no authenticated user");
  const token = signMfaEnrollmentToken(
    {
      sub: user.sub,
      provider: user.provider,
      email: user.email,
      authMethod: user.authMethod,
      ...(user.authAt ? { authAt: user.authAt } : {}),
      ...(user.ssoConnId ? { ssoConnId: user.ssoConnId } : {}),
      ...(user.role === "admin" ? { role: "admin" as const } : {}),
    } as JwtPayload,
    secret,
    factorId,
  );
  if (req.headers["x-web-client"] === "1") setMfaEnrollmentCookie(req, reply, token);
  return token;
}

function cookieScope(req: FastifyRequest): { domain: string | undefined; secure: boolean } {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const domain =
    process.env["SSO_COOKIE_DOMAIN"] ||
    (isProovraProductionRequest(req.headers.host, origin) ? ".proovra.com" : undefined);
  return { domain, secure: process.env["SSO_COOKIE_SECURE"] === "true" || Boolean(domain) };
}

export function setMfaEnrollmentCookie(req: FastifyRequest, reply: FastifyReply, token: string): void {
  reply.setCookie(MFA_ENROLLMENT_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MFA_ENROLLMENT_TTL_SECONDS,
    ...cookieScope(req),
  });
}

export function clearMfaEnrollmentCookie(req: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(MFA_ENROLLMENT_COOKIE, { path: "/", domain: cookieScope(req).domain });
}
