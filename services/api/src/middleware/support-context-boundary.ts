/**
 * THE SUPPORT-CONTEXT TOKEN ON A REQUEST: is it real, and may it write?
 *
 * `evaluateAuthorize` narrows every canonical permission check by the grant. A
 * large part of the API does not reach that chain: routes that read a TeamMember
 * row for themselves, and the Organization routes on `checkOrgAccess`. A write
 * there under a READ_ONLY context ran on the actor's ordinary authority, so
 * "read only" held only on some routes. `requireAuth` runs on all of them, so
 * the write boundary is decided there, once, and the chain keeps deciding scope
 * and the forbidden actions per permission.
 *
 * Ordinary sessions carry no such header and pay for one header read.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

import { getAuthSessionId } from "../auth.js";
import { prisma } from "../db.js";
import { isSessionRevoked } from "../services/identity-security/session-revocation.service.js";
import { verifySupportContextToken } from "../services/identity/support-context-token.service.js";
import { evaluateSupportContextWrite } from "../services/identity/support-runtime.service.js";

export const SUPPORT_CONTEXT_HEADER = "x-proovra-support-context";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Writes that are not writes into the customer: the context's own lifecycle, the
 * ceremony an ELEVATED action needs, and leaving. The actor is on these as
 * themselves whatever the context says.
 */
const CONTEXT_LIFECYCLE_ROUTE = /^\/v1\/(support-access\/|identity-security\/step-up\/|auth\/)/;

function readToken(req: FastifyRequest): string | null {
  const raw = req.headers[SUPPORT_CONTEXT_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * PHASE 10 HARDENING FIX 1 (2026-07-23) — is the persisted session backing
 * `sessionIdHash` still active? Two independent fail-closed checks:
 *
 *   1. `isSessionRevoked` (the SAME registry `requireAuth` consults on every
 *      request) — catches an explicit single-session or log-out-everywhere
 *      revocation issued AFTER the support-context token was minted.
 *   2. The persisted `AuthenticatedSession` row itself — catches the session's
 *      own natural expiry (or the row being entirely absent, which is "cannot
 *      prove liveness" → deny, never "assume alive").
 *
 * Any lookup failure denies (fail closed).
 */
async function isBoundSessionActive(userId: string, sessionIdHash: string): Promise<boolean> {
  try {
    const revoked = await isSessionRevoked({
      userId,
      sessionIdHash,
      // ALL_FOR_USER revocation is already enforced on every request by
      // `requireAuth` (which has the JWT's real `iat`); this call adds the
      // SINGLE_SESSION check specific to the exact session the token is bound
      // to. `iat: null` skips re-deriving ALL_FOR_USER here.
      iat: null,
    });
    if (revoked) return false;

    const sessionRow = await prisma.authenticatedSession.findFirst({
      where: { userId, sessionIdHash },
      select: { expiresAtUtc: true, revokedAtUtc: true },
    });
    if (!sessionRow) return false;
    if (sessionRow.revokedAtUtc) return false;
    if (sessionRow.expiresAtUtc.getTime() <= Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

export type SupportContextOnRequest =
  | { kind: "absent" }
  | { kind: "refused" }
  | { kind: "bound"; grantId: string };

/**
 * CLOSURE FIX 1 — the token is SERVER-VERIFIED here, never trusted at face value.
 * An invalid, forged or expired token is NOT a support context: it refuses the
 * operation outright rather than enforcing attacker-declared values or falling
 * through to an ordinary allow. Bound to the actor and to the EXACT session that
 * entered the context, and that session must still be provably live.
 */
export async function readSupportContext(
  req: FastifyRequest,
  actorUserId: string,
): Promise<SupportContextOnRequest> {
  const token = readToken(req);
  if (token === null) return { kind: "absent" };

  const verified = verifySupportContextToken(token);
  if (!verified.valid) return { kind: "refused" };
  // A token minted for a different user (stolen, replayed, copy-pasted) is never
  // honoured for this session, even though its signature verifies.
  if (verified.payload.supportUserId !== actorUserId) return { kind: "refused" };

  // `getAuthSessionId` throws when the request has no resolvable session, which
  // fails closed identically to a mismatch.
  let currentSessionIdHash: string;
  try {
    currentSessionIdHash = getAuthSessionId(req);
  } catch {
    return { kind: "refused" };
  }
  if (verified.payload.sessionIdHash !== currentSessionIdHash) return { kind: "refused" };
  if (!(await isBoundSessionActive(actorUserId, currentSessionIdHash))) return { kind: "refused" };
  return { kind: "bound", grantId: verified.payload.grantId };
}

/**
 * Called by `requireAuth`. Sends the same bounded refusal as the canonical chain
 * and returns true when the request must stop. Fails closed.
 */
export async function refuseSupportContextWrite(
  req: FastifyRequest,
  reply: FastifyReply,
  actorUserId: string,
  routePattern: string,
): Promise<boolean> {
  if (readToken(req) === null) return false;
  if (SAFE_METHODS.has(req.method)) return false;
  if (CONTEXT_LIFECYCLE_ROUTE.test(routePattern)) return false;

  let allowed = false;
  try {
    const context = await readSupportContext(req, actorUserId);
    if (context.kind === "bound") {
      allowed = await evaluateSupportContextWrite({
        actorUserId,
        grantId: context.grantId,
        action: `${req.method} ${routePattern}`,
        ipAddress: (req.ip as string | undefined) ?? null,
        userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      });
    }
  } catch {
    allowed = false;
  }
  if (allowed) return false;
  await reply.code(403).send({ error: { code: "permission_denied", reason: "support_access_denied" } });
  return true;
}
