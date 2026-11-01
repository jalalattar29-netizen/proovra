/**
 * THE BROWSER THAT STARTED A SIGN-IN FINISHES IT (IDENT-014).
 *
 * State and RelayState prove the server issued a sign-in, not that this browser
 * asked for it. Without a binding, someone can start a sign-in with their own
 * account and hand the victim the callback, and the victim ends up working inside
 * the attacker's session (login CSRF). A short cookie derived from the state ties
 * the callback to the browser that started it.
 *
 * The cookie is derived from the state, so nothing new is stored and any instance
 * can check it. SAML delivers its answer as a cross-site POST, which a Lax cookie
 * does not survive, so it is `None` wherever the cookie can be `Secure`.
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

import { isProovraProductionRequest } from "../../http/cors-origin-policy.js";
import { hashStateToken } from "./sso-hardening.service.js";

export const SSO_BIND_COOKIE = "proovra_sso_bind";
const SSO_BIND_TTL_SECONDS = 15 * 60;

function bindingValue(stateRaw: string): string {
  return hashStateToken(`browser-binding:${stateRaw}`);
}

function secureRequest(req: FastifyRequest): boolean {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  return (
    process.env["SSO_COOKIE_SECURE"] === "true" ||
    Boolean(process.env["SSO_COOKIE_DOMAIN"]) ||
    isProovraProductionRequest(req.headers.host, origin)
  );
}

export function setSsoBrowserBinding(
  req: FastifyRequest,
  reply: FastifyReply,
  stateRaw: string,
): void {
  const secure = secureRequest(req);
  reply.setCookie(SSO_BIND_COOKIE, bindingValue(stateRaw), {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    path: "/v1/auth",
    maxAge: SSO_BIND_TTL_SECONDS,
  });
}

export function ssoBrowserBindingMatches(req: FastifyRequest, stateRaw: string): boolean {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;
  const presented = cookies?.[SSO_BIND_COOKIE];
  if (!presented) return false;
  const expected = Buffer.from(bindingValue(stateRaw));
  const actual = Buffer.from(presented);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function clearSsoBrowserBinding(reply: FastifyReply): void {
  reply.clearCookie(SSO_BIND_COOKIE, { path: "/v1/auth" });
}
