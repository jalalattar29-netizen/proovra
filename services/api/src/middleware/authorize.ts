/**
 * Phase 26 — Centralized authorize() helper.
 *
 * Single canonical bridge between the Phase 17 access-policy engine
 * (`evaluateMemberAccess`) and route handlers. Replaces the 30+ ad-hoc
 * "look up member → evaluate → 403" patterns scattered across the
 * codebase with one bounded, fail-closed, audit-emitting helper.
 *
 * Hard contracts:
 *   - Returns a bounded `AuthorizationOutcome` discriminated union.
 *     Operators never see free-text error messages — only bounded
 *     reason codes.
 *   - On deny, sends the canonical HTTP response shape:
 *       403 { error: { code: "permission_denied", reason: <bounded> } }
 *     UNLESS the caller asks for `antiEnumeration: true`, in which
 *     case cross-team / no-membership denials return:
 *       404 { error: { code: "not_found" } }
 *     This is the canonical anti-enumeration pattern — non-members of
 *     a workspace must NOT be able to probe the existence of a
 *     resource via a 403 / 404 difference.
 *   - Audit emission is delegated to `evaluateMemberAccess` (which
 *     already calls `recordPermissionDecision`). The middleware itself
 *     never writes to the DB — it stays a thin policy bridge.
 *   - Fail-closed: any unexpected exception is caught + converted to
 *     a 503 deny. The middleware NEVER leaks a Prisma error message
 *     to the response.
 *
 * Usage patterns:
 *
 *   // Inline, for routes that already have teamId resolved:
 *   const actor = await authorizeOrFail(req, reply, {
 *     teamId: body.teamId,
 *     permission: "evidence.read",
 *   });
 *   if (!actor) return; // reply already sent
 *
 *   // PreHandler, for routes that read teamId from query:
 *   app.get("/v1/foo", {
 *     preHandler: [requireAuth, requireAuthorize({
 *       permission: "evidence.read",
 *       teamIdFrom: (req) => (req.query as { teamId?: string })?.teamId,
 *     })],
 *   }, handler);
 */

import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { Permission } from "@proovra/shared";

import { getAuthUserId, getAuthSessionId } from "../auth.js";
import { bump } from "../services/ops/metrics.service.js";
import { prisma } from "../db.js";
import {
  evaluateMemberAccess,
  type AccessDecision,
  type AccessDenyReason,
} from "../services/identity/access-policy.service.js";
// PHASE 10 HARDENING FIX 1 (2026-07-23) — the persisted-session liveness
// check re-run on every support-context request (see `isBoundSessionActive`
// below): a token bound to a session that has since been revoked or has
// naturally expired must stop authorizing support-scoped operations, even
// though its own short TTL has not yet elapsed and the underlying grant is
// still perfectly valid.
import { isSessionRevoked } from "../services/identity-security/session-revocation.service.js";
// PHASE 10 STEP 5 / CLOSURE FIX 1 (2026-07-23) — REAL-OPERATION
// support-access enforcement. Composed here (not forked):
// `applySupportAccessGuard` re-defers scope / expiry / revocation /
// action-permission entirely to the ONE support authority chain
// (`resolveSupportRuntimeContextByGrantId` + `authorizeSupportAction` in
// support-runtime.service.ts). This import is the ONLY new coupling.
import { applySupportAccessGuard } from "../services/identity/support-runtime.service.js";
// CLOSURE FIX 1 (2026-07-23) — the client can transport ONLY this opaque,
// server-issued, server-verified token. Verification never trusts the
// request; a forged/invalid/expired token is treated as "not support
// context", never as a permissive or client-declared signal.
import { verifySupportContextToken } from "../services/identity/support-context-token.service.js";

// =============================================================================
// Bounded denial vocabulary surfaced to route callers + tests.
// =============================================================================

/**
 * The exhaustive set of reason codes the authorize helper emits in
 * its 403 response body. Each code maps directly to an
 * `AccessDenyReason` from the access-policy engine or to a route-side
 * concern (`missing_team_id`, `missing_actor`).
 *
 * Operators see only these codes — never free-text Prisma errors,
 * never raw exception messages, never workspace-specific identifiers.
 */
export const AUTHORIZATION_DENIAL_CODES = [
  // Route-side: required input missing.
  "missing_team_id",
  // Route-side: session not resolved.
  "missing_actor",
  // From access-policy:
  "no_actor",
  "member_not_active",
  "member_access_expired",
  // PHASE 1 (2026-07-21) — org-lifecycle + workspace-kind denials.
  "organization_not_active",
  "workspace_kind_unresolved",
  "service_account_revoked",
  "service_account_disabled",
  "service_account_expired",
  "service_account_scope_missing",
  "contributor_session_revoked",
  "contributor_session_expired",
  "contributor_unsupported_permission",
  "permission_not_granted",
  // Route-side: unexpected failure → fail-closed.
  "authorization_unavailable",
  // PHASE 10 STEP 5 / CLOSURE FIX 1 (2026-07-23) — a request carrying a
  // valid, server-verified support-context token that the composed
  // support-runtime guard denies (this also covers a missing/forged/
  // wrong-actor token — see `evaluateAuthorize` below). The bounded
  // internal reason (scope/expiry/revocation/read-only/elevated gate) is
  // audited via `authorizeSupportAction`; this single code is all an
  // operator/client ever sees on the canonical route response.
  "support_access_denied",
] as const;

export type AuthorizationDenialCode =
  (typeof AUTHORIZATION_DENIAL_CODES)[number];

const ACCESS_DENY_REASON_SET: ReadonlySet<string> = new Set<AccessDenyReason>([
  "no_actor",
  "member_not_active",
  "member_access_expired",
  "organization_not_active",
  "workspace_kind_unresolved",
  "service_account_revoked",
  "service_account_disabled",
  "service_account_expired",
  "service_account_scope_missing",
  "contributor_session_revoked",
  "contributor_session_expired",
  "contributor_unsupported_permission",
  "permission_not_granted",
]);

// =============================================================================
// PHASE 10 CLOSURE FIX 1 (2026-07-23) — server-authoritative support-context
// token.
//
// The former design armed support enforcement off a CLIENT-CONTROLLED
// boolean header (`x-proovra-support-mode`) — any caller could decide for
// itself whether the guard ran. That header is DELETED. The client may now
// transport ONLY an OPAQUE, SERVER-ISSUED, SERVER-VERIFIED token, minted by
// `POST /v1/support-access/enter` (enterprise-security.routes.ts) after the
// server has already validated the caller's ACTIVE `SupportAccessGrant`
// against the DB. Ordinary customer sessions never carry this header, so the
// guard below is skipped entirely for them — zero extra behaviour, zero
// extra DB reads. A present-but-invalid (missing signature, forged,
// wrong-actor, expired) token is NEVER treated as a valid support-context
// request — it denies the operation outright (see `evaluateAuthorize`
// below) rather than silently falling through to an ordinary allow.
// =============================================================================

const SUPPORT_CONTEXT_HEADER = "x-proovra-support-context";
// Same header `requireStepUpForSensitiveAction` (step-up-middleware.ts)
// reads. Presence-only check here — this guard never consumes/verifies the
// challenge itself; it is an ADDITIONAL gate before permitting an ELEVATED
// support action, layered on top of (not a replacement for) the route-level
// step-up enforcement that already runs for sensitive mutations.
const STEP_UP_PROOF_HEADER = "x-proovra-step-up-challenge-id";

/**
 * PHASE 10 HARDENING FIX 1 (2026-07-23) — is the persisted session backing
 * `sessionIdHash` still active? Two independent fail-closed checks:
 *
 *   1. `isSessionRevoked` (the SAME registry `requireAuth` consults on
 *      every request) — catches an explicit single-session or
 *      log-out-everywhere revocation issued AFTER the support-context
 *      token was minted.
 *   2. The persisted `AuthenticatedSession` row itself — catches the
 *      session's own natural expiry (or the row being entirely absent,
 *      which we treat as "cannot prove liveness" → deny, never "assume
 *      alive").
 *
 * Any lookup failure denies (fail closed) — never falls through to
 * "assume active".
 */
async function isBoundSessionActive(
  userId: string,
  sessionIdHash: string,
): Promise<boolean> {
  try {
    const revoked = await isSessionRevoked({
      userId,
      sessionIdHash,
      // ALL_FOR_USER revocation is already enforced on every request by
      // `requireAuth` (which has the JWT's real `iat`); this call adds the
      // SINGLE_SESSION check specific to the exact session the token is
      // bound to. Passing `iat: null` intentionally skips re-deriving
      // ALL_FOR_USER here rather than threading a redundant claim through.
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

function headerPresent(req: FastifyRequest, name: string): boolean {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim().length > 0;
}

/** Returns the trimmed header value, or `null` when absent/blank. */
function readHeaderValue(req: FastifyRequest, name: string): string | null {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// =============================================================================
// Public surface
// =============================================================================

export type AuthorizeOptions = {
  teamId: string | null | undefined;
  permission: Permission;
  resourceKind?: string;
  resourceId?: string;
  /**
   * When true, the middleware converts "not a member of this team"
   * (or missing teamId) into a 404 not_found response. Defaults to
   * `false`. Set to `true` for any route where leaking a team's
   * existence would be sensitive.
   */
  antiEnumeration?: boolean;
};

export type AuthorizationOutcome =
  | {
      allowed: true;
      actorUserId: string;
      teamId: string;
    }
  | {
      allowed: false;
      reasonCode: AuthorizationDenialCode;
      httpStatus: 401 | 403 | 404 | 503;
    };

/**
 * Inline authorize helper. Sends the canonical 401/403/404/503
 * response on deny + returns null so the caller can short-circuit.
 * On allow, returns the actor + teamId for downstream handlers.
 */
export async function authorizeOrFail(
  req: FastifyRequest,
  reply: FastifyReply,
  options: AuthorizeOptions,
): Promise<{ actorUserId: string; teamId: string } | null> {
  const outcome = await evaluateAuthorize(req, options);
  if (outcome.allowed) {
    return {
      actorUserId: outcome.actorUserId,
      teamId: outcome.teamId,
    };
  }
  sendDenyResponse(reply, outcome);
  return null;
}

/**
 * Fastify preHandler factory. Use when the route can express
 * teamId-from-request as a pure function — query param, route param,
 * body field.
 */
export function requireAuthorize(
  options: Omit<AuthorizeOptions, "teamId"> & {
    teamIdFrom: (req: FastifyRequest) => string | null | undefined;
  },
): preHandlerAsyncHookHandler {
  const { teamIdFrom, ...rest } = options;
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const teamId = teamIdFrom(req);
    const outcome = await evaluateAuthorize(req, { ...rest, teamId });
    if (!outcome.allowed) {
      sendDenyResponse(reply, outcome);
      return;
    }
    // Attach the resolved actor + teamId for downstream handlers.
    (req as FastifyRequest & {
      authorized?: { actorUserId: string; teamId: string };
    }).authorized = {
      actorUserId: outcome.actorUserId,
      teamId: outcome.teamId,
    };
  };
}

/**
 * Pure outcome computation — exposed for tests + advanced callers
 * that want to inspect the decision without sending the response.
 */
export async function evaluateAuthorize(
  req: FastifyRequest,
  options: AuthorizeOptions,
): Promise<AuthorizationOutcome> {
  let actorUserId: string;
  try {
    actorUserId = getAuthUserId(req);
  } catch {
    bump("authorize_denied_total");
    return {
      allowed: false,
      reasonCode: "missing_actor",
      httpStatus: 401,
    };
  }

  if (!options.teamId) {
    bump("authorize_denied_total");
    return {
      allowed: false,
      reasonCode: "missing_team_id",
      httpStatus: options.antiEnumeration ? 404 : 400,
    } as never;
  }

  let decision: AccessDecision;
  try {
    decision = await evaluateMemberAccess({
      teamId: options.teamId,
      userId: actorUserId,
      permission: options.permission,
      resourceKind: options.resourceKind,
      resourceId: options.resourceId,
    });
  } catch {
    bump("authorize_failed_closed_total");
    return {
      allowed: false,
      reasonCode: "authorization_unavailable",
      httpStatus: 503,
    };
  }

  if (decision.allowed) {
    // PHASE 10 STEP 5 / CLOSURE FIX 1 (2026-07-23) — EVERY authorized
    // operation additionally runs the support-access runtime guard WHEN the
    // request carries a support-context token. Ordinary customer sessions
    // carry no such header and fall straight through to the unchanged allow
    // below — zero extra behaviour, zero extra DB reads.
    const supportContextToken = readHeaderValue(req, SUPPORT_CONTEXT_HEADER);
    if (supportContextToken !== null) {
      // CLOSURE FIX 1 — the token is SERVER-VERIFIED here, never trusted at
      // face value. An invalid/forged/expired token is NOT a support
      // context — it denies the operation outright rather than either (a)
      // enforcing with attacker-declared values or (b) silently falling
      // through to an ordinary allow.
      const verified = verifySupportContextToken(supportContextToken);
      if (!verified.valid) {
        bump("authorize_denied_total");
        return {
          allowed: false,
          reasonCode: "support_access_denied",
          httpStatus: 403,
        };
      }
      // Wrong-actor check: a token minted for a different authenticated
      // user (stolen, replayed, or copy-pasted) must never be honoured for
      // this session, even though its signature verifies.
      if (verified.payload.supportUserId !== actorUserId) {
        bump("authorize_denied_total");
        return {
          allowed: false,
          reasonCode: "support_access_denied",
          httpStatus: 403,
        };
      }
      // PHASE 10 HARDENING FIX 1 (2026-07-23) — SESSION BINDING. A token
      // minted in Session A must be rejected when presented from Session B,
      // even for the SAME support actor. `getAuthSessionId` throws when the
      // current request has no resolvable session (e.g. a pre-Phase-19
      // token) — that fails closed identically to a mismatch, never to an
      // unbound allow.
      let currentSessionIdHash: string;
      try {
        currentSessionIdHash = getAuthSessionId(req);
      } catch {
        bump("authorize_denied_total");
        return {
          allowed: false,
          reasonCode: "support_access_denied",
          httpStatus: 403,
        };
      }
      if (verified.payload.sessionIdHash !== currentSessionIdHash) {
        bump("authorize_denied_total");
        return {
          allowed: false,
          reasonCode: "support_access_denied",
          httpStatus: 403,
        };
      }
      // The persisted session backing this (now-matched) hash must still
      // be provably active — a session revoked or naturally expired AFTER
      // the token was minted must not continue to authorize support-scoped
      // operations, independent of the token's own (longer-lived) TTL.
      const sessionActive = await isBoundSessionActive(
        actorUserId,
        currentSessionIdHash,
      );
      if (!sessionActive) {
        bump("authorize_denied_total");
        return {
          allowed: false,
          reasonCode: "support_access_denied",
          httpStatus: 403,
        };
      }
      try {
        const guard = await applySupportAccessGuard({
          actorUserId,
          // The token pins the request to the EXACT grant validated at
          // entry time (`POST /v1/support-access/enter`) — never "any
          // active grant for this actor", which would let a client widen
          // its own effective scope.
          grantId: verified.payload.grantId,
          teamId: options.teamId,
          // SERVER-DERIVED action: the canonical permission already being
          // authorized for this route — never a client-supplied body field.
          permission: options.permission,
          hasStepUpProof: headerPresent(req, STEP_UP_PROOF_HEADER),
          ipAddress: (req.ip as string | undefined) ?? null,
          userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
        });
        if (!guard.allowed) {
          bump("authorize_denied_total");
          return {
            allowed: false,
            reasonCode: "support_access_denied",
            httpStatus: 403,
          };
        }
      } catch {
        // Fail closed: any unexpected failure evaluating the support
        // authority denies the operation — never a silent fallthrough to
        // ordinary allow, and never a 500 leak.
        bump("authorize_denied_total");
        return {
          allowed: false,
          reasonCode: "support_access_denied",
          httpStatus: 403,
        };
      }
    }
    bump("authorize_allowed_total");
    return {
      allowed: true,
      actorUserId,
      teamId: options.teamId,
    };
  }

  bump("authorize_denied_total");
  // Map the access-policy deny reason into the bounded route-side
  // catalog. The set is identical by construction (we copied it
  // above), so this is just a defensive narrowing.
  const reasonCode: AuthorizationDenialCode = ACCESS_DENY_REASON_SET.has(
    decision.reason,
  )
    ? (decision.reason as AuthorizationDenialCode)
    : "permission_not_granted";

  // Anti-enumeration: when the caller asks for it, the
  // "no membership" failure converts to 404 — operators outside the
  // workspace see the same response regardless of whether the team
  // exists.
  const isMembershipFailure =
    reasonCode === "no_actor" ||
    reasonCode === "member_not_active" ||
    reasonCode === "member_access_expired" ||
    // PHASE 1 (2026-07-21) — an unavailable org, or a workspace whose kind
    // cannot be proven, is a "context you cannot enter" failure; under
    // anti-enumeration both conceal as 404 too.
    reasonCode === "organization_not_active" ||
    reasonCode === "workspace_kind_unresolved";
  const httpStatus: 403 | 404 =
    options.antiEnumeration && isMembershipFailure ? 404 : 403;

  return {
    allowed: false,
    reasonCode,
    httpStatus,
  };
}

// =============================================================================
// Response sender — bounded shape, no free-text.
// =============================================================================

function sendDenyResponse(
  reply: FastifyReply,
  outcome: Extract<AuthorizationOutcome, { allowed: false }>,
): void {
  const { httpStatus, reasonCode } = outcome;
  if (httpStatus === 404) {
    reply.code(404).send({ error: { code: "not_found" } });
    return;
  }
  if (httpStatus === 401) {
    reply.code(401).send({ error: { code: "unauthenticated" } });
    return;
  }
  if (httpStatus === 503) {
    reply.code(503).send({
      error: {
        code: "authorization_unavailable",
        reason: "Authorization could not be evaluated. Please retry.",
      },
    });
    return;
  }
  reply.code(403).send({
    error: {
      code: "permission_denied",
      reason: reasonCode,
    },
  });
}
