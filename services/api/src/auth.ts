import type { FastifyRequest } from "fastify";

export function getAuthUserId(req: FastifyRequest): string {
  if (!req.user?.sub) {
    throw new Error("Unauthenticated");
  }
  return req.user.sub;
}

/**
 * PHASE 10 HARDENING FIX 1 (2026-07-23) — the CURRENT authenticated
 * session's hashed session id. `middleware/auth.ts#requireAuth` already
 * computes this via `hashSessionId(sid)` (session-revocation.service.ts)
 * from the JWT's `sid` claim and stores it on `req.user.sessionIdHash`
 * (Phase 2.4) — this accessor is the one place callers read it, mirroring
 * `getAuthUserId`. Used to BIND server-issued support-context tokens to
 * the exact session that requested them
 * (services/identity/support-context-token.service.ts) — a token minted in
 * one session must never verify from another session, even for the same
 * actor. Throws when the session is not resolved (no JWT `sid`, e.g. a
 * pre-Phase-19 token or an unauthenticated request) — callers MUST treat
 * that as "cannot bind", never as an unbound/wildcard session.
 */
export function getAuthSessionId(req: FastifyRequest): string {
  const sessionIdHash = req.user?.sessionIdHash;
  if (!sessionIdHash) {
    throw new Error("Session not resolved");
  }
  return sessionIdHash;
}
