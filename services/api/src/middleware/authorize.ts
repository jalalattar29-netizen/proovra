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

import { getAuthUserId } from "../auth.js";
import { bump } from "../services/ops/metrics.service.js";
import {
  evaluateMemberAccess,
  type AccessDecision,
  type AccessDenyReason,
} from "../services/identity/access-policy.service.js";

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
] as const;

export type AuthorizationDenialCode =
  (typeof AUTHORIZATION_DENIAL_CODES)[number];

const ACCESS_DENY_REASON_SET: ReadonlySet<string> = new Set<AccessDenyReason>([
  "no_actor",
  "member_not_active",
  "member_access_expired",
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
    reasonCode === "member_access_expired";
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
