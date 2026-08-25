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
import type { CanonicalRole } from "@proovra/shared";
import { listRolePermissions, mapTeamRoleToCanonical } from "@proovra/shared";

import { getAuthUserId, getAuthSessionId } from "../auth.js";
import { bump } from "../services/ops/metrics.service.js";
import { prisma } from "../db.js";
import {
  evaluateMemberAccess,
  evaluateMemberAccessWithSnapshot,
  type AccessDecision,
  type AccessDenyReason,
  type MemberAccessSnapshot,
} from "../services/identity/access-policy.service.js";
import { listPermissionsForDelegatedAdminScope } from "@proovra/shared";
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
    const supportDenied = await evaluateSupportContextGuard(
      req,
      actorUserId,
      options.teamId,
      options.permission,
    );
    if (supportDenied) {
      bump("authorize_denied_total");
      return {
        allowed: false,
        reasonCode: "support_access_denied",
        httpStatus: 403,
      };
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

  return {
    allowed: false,
    reasonCode,
    httpStatus: resolveDenyHttpStatus(reasonCode, options),
  };
}

/**
 * Anti-enumeration status resolution, shared by `evaluateAuthorize` and the
 * `AuthorizedWorkspaceContext` primitive so both conceal a non-member,
 * inactive-member, unavailable-organization or unprovable-workspace denial
 * identically. A caller outside the workspace must not be able to
 * distinguish "workspace does not exist" from "workspace exists and you are
 * not in it" by comparing status codes.
 */
function resolveDenyHttpStatus(
  reasonCode: AuthorizationDenialCode,
  options: { antiEnumeration?: boolean },
): 403 | 404 {
  const isMembershipFailure =
    reasonCode === "no_actor" ||
    reasonCode === "member_not_active" ||
    reasonCode === "member_access_expired" ||
    // PHASE 1 (2026-07-21) — an unavailable org, or a workspace whose kind
    // cannot be proven, is a "context you cannot enter" failure; under
    // anti-enumeration both conceal as 404 too.
    reasonCode === "organization_not_active" ||
    reasonCode === "workspace_kind_unresolved";
  return options.antiEnumeration && isMembershipFailure ? 404 : 403;
}

/**
 * PHASE 10 STEP 5 / CLOSURE FIX 1 (2026-07-23) — EVERY authorized operation
 * additionally runs the support-access runtime guard WHEN the request carries
 * a support-context token. Ordinary customer sessions carry no such header
 * and fall straight through — zero extra behaviour, zero extra DB reads.
 *
 * Extracted from `evaluateAuthorize` unchanged (PHASE 12 REMEDIATION,
 * 2026-08-06) so the canonical `AuthorizedWorkspaceContext` primitive
 * inherits the IDENTICAL support-access enforcement rather than
 * reimplementing it. Returns `true` when the request must be DENIED.
 */
async function evaluateSupportContextGuard(
  req: FastifyRequest,
  actorUserId: string,
  teamId: string,
  permission: Permission,
): Promise<boolean> {
  const supportContextToken = readHeaderValue(req, SUPPORT_CONTEXT_HEADER);
  if (supportContextToken === null) return false;

  // CLOSURE FIX 1 — the token is SERVER-VERIFIED here, never trusted at
  // face value. An invalid/forged/expired token is NOT a support
  // context — it denies the operation outright rather than either (a)
  // enforcing with attacker-declared values or (b) silently falling
  // through to an ordinary allow.
  const verified = verifySupportContextToken(supportContextToken);
  if (!verified.valid) return true;
  // Wrong-actor check: a token minted for a different authenticated
  // user (stolen, replayed, or copy-pasted) must never be honoured for
  // this session, even though its signature verifies.
  if (verified.payload.supportUserId !== actorUserId) return true;
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
    return true;
  }
  if (verified.payload.sessionIdHash !== currentSessionIdHash) return true;
  // The persisted session backing this (now-matched) hash must still
  // be provably active — a session revoked or naturally expired AFTER
  // the token was minted must not continue to authorize support-scoped
  // operations, independent of the token's own (longer-lived) TTL.
  const sessionActive = await isBoundSessionActive(
    actorUserId,
    currentSessionIdHash,
  );
  if (!sessionActive) return true;
  try {
    const guard = await applySupportAccessGuard({
      actorUserId,
      // The token pins the request to the EXACT grant validated at
      // entry time (`POST /v1/support-access/enter`) — never "any
      // active grant for this actor", which would let a client widen
      // its own effective scope.
      grantId: verified.payload.grantId,
      teamId,
      // SERVER-DERIVED action: the canonical permission already being
      // authorized for this route — never a client-supplied body field.
      permission,
      hasStepUpProof: headerPresent(req, STEP_UP_PROOF_HEADER),
      ipAddress: (req.ip as string | undefined) ?? null,
      userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
    });
    if (!guard.allowed) return true;
  } catch {
    // Fail closed: any unexpected failure evaluating the support
    // authority denies the operation — never a silent fallthrough to
    // ordinary allow, and never a 500 leak.
    return true;
  }
  return false;
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

// =============================================================================
// PHASE 12 REMEDIATION (2026-08-06) — CANONICAL AUTHORIZED WORKSPACE CONTEXT.
//
// Batch A of the Phase-12 focused-reachability remediation removes an entire
// DEFECT CLASS rather than its individual symptoms. The class is:
//
//     "a route resolves a workspace for itself, reads a TeamMember row for
//      itself, and decides for itself what that row means"
//
// Every instance of it (SEC-001, AUTH-001, AUTH-002, AUTH-003, AUTH-005) had
// the same shape — the row's EXISTENCE was mistaken for its VALIDITY, and in
// the external-portal case even the row was optional, because the workspace
// itself came from `User.currentWorkspaceId`, a NAVIGATION HINT.
//
// The correction is a single typed value, `AuthorizedWorkspaceContext`, that
// is UNFORGEABLE: it carries a module-private brand, so the only way any
// module in this service can obtain one is to call a constructor below, and
// every constructor runs the full canonical chain first:
//
//     identity -> workspace existence -> workspace kind (never UNKNOWN)
//     -> EXPLICIT membership row -> membership status ACTIVE
//     -> member access-expiry -> parent-Organization lifecycle
//     -> canonical permission (role floor + capability grants + delegated
//        admin scopes) -> support-access runtime guard
//
// The chain itself is NOT reimplemented here. It is exactly
// `loadMemberAccessSnapshot` + `evaluateAccess` + `recordPermissionDecision`
// + `evaluateSupportContextGuard` — the same four calls `evaluateAuthorize`
// composes — so there is ONE policy authority, not two.
//
// What the type makes structurally impossible:
//   * `workspaceRole: null`                  — the field is CanonicalRole.
//   * an absent membership row               — `no_actor` denies first.
//   * SUSPENDED / REVOKED membership         — `member_not_active` denies.
//   * a suspended / archived Organization    — `organization_not_active`.
//   * an unprovable workspace kind           — `workspace_kind_unresolved`.
//   * a workspace accepted merely because it is stored in
//     `User.currentWorkspaceId` — the pointer is only ever an INPUT
//     CANDIDATE (see `authorizeCurrentWorkspaceOrFail`); every check above
//     still runs in full against the database.
// =============================================================================

/**
 * The canonical semantic Workspace kinds. There is no semantic
 * "Team Workspace": `TEAM` is a commercial plan/capability bundle that
 * operates INSIDE an OWNED workspace, never a container category.
 *
 * `ORGANIZATION` is this codebase's persisted spelling of the canonical
 * ORGANIZATION_PROVISIONED kind. The enum is deliberately NOT re-spelled
 * here — a parallel enum would be a second authority for the same fact.
 */
export type CanonicalWorkspaceKind = "PERSONAL" | "OWNED" | "ORGANIZATION";

/** The only membership status that grants access. */
export type CanonicalActiveMembershipStatus = "ACTIVE";

/** The only Organization lifecycle state that permits operation. */
export type CanonicalActiveLifecycle = "ACTIVE";

declare const AUTHORIZED_WORKSPACE_BRAND: unique symbol;

/**
 * Proof that a specific actor is authorized to perform a specific canonical
 * permission inside a specific workspace, RIGHT NOW, against the database.
 *
 * Constructible only by the helpers in this module. A structurally identical
 * object literal will not type-check as this type, so no route can fabricate
 * authorization by assembling fields it happens to have on hand.
 */
export type AuthorizedWorkspaceContext = {
  readonly [AUTHORIZED_WORKSPACE_BRAND]: true;
  readonly userId: string;
  readonly workspaceId: string;
  /**
   * WORKSPACE-SCOPE CONVERGENCE — the id of the row that PHYSICALLY stores
   * this workspace, which today is the legacy `Team` row.
   *
   * `workspaceId` is the SEMANTIC name every API and service boundary speaks;
   * `physicalWorkspaceId` is the value a storage predicate is written against.
   * They are the same string today and this field asserts that rather than
   * hiding it: a reader of a `where: { teamId: ctx.physicalWorkspaceId }` can
   * see they are looking at storage, and if the physical home ever moves,
   * every such predicate is already pointing at the field that would change.
   *
   * It is deliberately NOT a second source of truth — it is minted from the
   * same proven workspace id, in the same constructor, and can never diverge.
   */
  readonly physicalWorkspaceId: string;
  readonly workspaceKind: CanonicalWorkspaceKind;
  readonly workspaceRole: CanonicalRole;
  readonly membershipStatus: CanonicalActiveMembershipStatus;
  /**
   * The proven `TeamMember` row id this grant rests on. Carried so a consumer
   * that must record WHICH membership authorized an action does not re-read
   * the row to find out — a second read that could return a different row than
   * the one the decision was made from.
   */
  readonly membershipId: string;
  /**
   * The owner of a PERSONAL workspace, and `null` for every other kind.
   *
   * This is the binding the canonical read scope needs: a personal
   * workspace's legacy `team_id IS NULL` rows are identified by their owner,
   * and the NULL arm of the scope is conjoined with THIS id so it can never
   * reach another tenant's orphan rows. It is deliberately null for OWNED and
   * ORGANIZATION workspaces — those are strict-scope workspaces and an owner
   * arm there would widen a shared population, which is the opposite defect.
   *
   * NEVER an authorization input. Membership decided that, above.
   */
  readonly personalOwnerUserId: string | null;
  readonly organizationId: string | null;
  /**
   * `ACTIVE` for an ORGANIZATION_PROVISIONED workspace (proven above), and
   * `null` for PERSONAL / OWNED workspaces, which are backed by internal
   * SYSTEM containers to which CUSTOMER-organization lifecycle does not
   * apply. It is NEVER a non-ACTIVE value: that path denied.
   */
  readonly organizationLifecycle: CanonicalActiveLifecycle | null;
  /**
   * Every canonical permission this actor effectively holds in this
   * workspace — the canonical role floor, unioned with active capability
   * grants and active delegated-admin scopes. Callers use this for
   * SECONDARY capability decisions inside an already-authorized handler;
   * the PRIMARY decision is always the `permission` passed to the
   * constructor, which has already been enforced.
   */
  readonly capabilities: ReadonlySet<Permission>;
};

/**
 * WORKSPACE-SCOPE CONVERGENCE — the canonical workspace context.
 *
 * This is an ALIAS, not a new type. The convergence brief asked for a
 * "CanonicalWorkspaceContext": a transient, server-resolved object carrying
 * workspace identity, physical storage identity, kind, owner, membership,
 * lifecycle and capabilities, which fails closed on any contradiction.
 * `AuthorizedWorkspaceContext` already IS that object — it is minted by one
 * constructor, only after the full identity → workspace → kind → membership →
 * status → expiry → organization-lifecycle → permission → support-guard
 * chain, and it is unforgeable at runtime, not merely at compile time.
 *
 * Introducing a separate type would have created exactly what the brief
 * forbids: a second workspace authority, resolvable by a second path, able to
 * disagree with the first. The name is provided so the vocabulary exists; the
 * authority remains singular.
 *
 * On the two field mappings that are not spelled identically:
 *   * `lifecycle` is carried as the TWO facts the chain actually proves —
 *     `membershipStatus` (always ACTIVE here) and `organizationLifecycle`
 *     (ACTIVE for an ORGANIZATION workspace, null where CUSTOMER-org
 *     lifecycle does not apply). Collapsing them into one string would lose
 *     which of the two was proven and add a third spelling of both.
 *   * `workspaceKind` keeps its canonical THREE values. `OWNED` is a real
 *     kind in this schema, not a synonym for either of the other two, and
 *     re-spelling the enum with two would be the parallel enum the brief
 *     rules out.
 */
export type CanonicalWorkspaceContext = AuthorizedWorkspaceContext;

// =============================================================================
// PHASE 12 CORRECTIVE PASS §1.2 (2026-08-06) — RUNTIME AUTHORITY.
//
// The declaration above is a COMPILE-TIME brand. It stops an honest module
// from assembling a context by accident, and the AST rule forbidding
// `as AuthorizedWorkspaceContext` stops the obvious dishonest one. Neither is
// a security boundary: `unknown as`, a wrapper function, `JSON.parse`, object
// spread, a `.js` caller, or a deserialised cache entry all defeat both,
// because after erasure the value is an ordinary object with ordinary fields.
//
// The boundary below is a RUNTIME one. Every context this service can obtain
// is minted by `mintAuthorizedWorkspaceContext`, which is module-private —
// not exported, so no import can reach it — and registration happens in a
// `WeakSet` keyed by OBJECT IDENTITY. Identity is the one property a forger
// cannot reproduce: it cannot be spelled, copied, spread, serialised,
// guessed, or transported. A structurally perfect twin is a DIFFERENT object
// and therefore is not in the set.
//
// Nothing secret is created, stored on the value, serialised, or logged. The
// registry holds no token: it holds the objects themselves, weakly, so a
// context becomes collectable the moment the request that minted it is gone.
// =============================================================================

/**
 * Identity registry of every context this module has minted. WeakSet, so it
 * never retains a context beyond its natural life and never grows unbounded.
 */
const MINTED_WORKSPACE_CONTEXTS = new WeakSet<object>();

/**
 * What each minted context was minted FOR. Consulted on every verification so
 * a context proven for one actor / workspace / permission cannot be presented
 * for another — the WeakSet alone would accept any genuine context anywhere.
 */
type AuthorizedContextBinding = {
  readonly userId: string;
  readonly workspaceId: string;
  readonly permission: Permission;
  readonly mintedAtEpochMs: number;
  /**
   * Fingerprint of the exact membership/lifecycle facts the grant rests on.
   * Revalidation recomputes it and refuses on any change, so a role
   * downgrade, a capability revocation, an access-expiry edit or an
   * Organization suspension invalidates a context that was minted before it —
   * this is what stops a long-lived cached grant from outliving its premise.
   */
  readonly membershipGeneration: string;
  /**
   * The request the grant was proven for. Held so revalidation can re-run the
   * IDENTICAL chain — including the support-access guard, which is a property
   * of the request, not of the membership row.
   */
  readonly request: FastifyRequest;
};

const AUTHORIZED_CONTEXT_BINDINGS = new WeakMap<object, AuthorizedContextBinding>();

/**
 * The facts a grant rests on, rendered as a comparable string.
 *
 * Deliberately NOT a hash: there is no secret here to protect, and a readable
 * fingerprint makes a refusal diagnosable. It contains no token and no value
 * an attacker could not already read from their own membership row.
 */
function membershipGenerationOf(member: MemberAccessSnapshot): string {
  const grants = member.capabilityGrants
    .filter((g) => g.revokedAtUtc === null)
    .map((g) => `${g.id}:${g.permission}:${g.expiresAtUtc?.getTime() ?? 0}`)
    .sort()
    .join(",");
  const scopes = member.delegatedAdminScopes
    .filter((s) => s.revokedAtUtc === null)
    .map((s) => `${s.id}:${s.scopeKind}:${s.expiresAtUtc?.getTime() ?? 0}`)
    .sort()
    .join(",");
  return [
    member.teamMemberId,
    member.status,
    member.role,
    member.accessExpiresAtUtc?.getTime() ?? 0,
    member.workspaceKind,
    member.organizationId ?? "",
    member.organizationStatus ?? "",
    grants,
    scopes,
  ].join("|");
}

/**
 * The ONLY way a value of this type comes into existence. Module-private by
 * construction — there is no export, so `mintAuthorizedWorkspaceContext` is
 * unreachable from any other module regardless of how it is imported.
 *
 * The returned object is FROZEN: a consumer cannot repoint a genuine context
 * at another workspace after the fact, which would otherwise turn a valid
 * grant into a universal one.
 */
function mintAuthorizedWorkspaceContext(
  fields: Omit<AuthorizedWorkspaceContext, typeof AUTHORIZED_WORKSPACE_BRAND>,
  binding: AuthorizedContextBinding,
): AuthorizedWorkspaceContext {
  const ctx = Object.freeze({ ...fields }) as AuthorizedWorkspaceContext;
  MINTED_WORKSPACE_CONTEXTS.add(ctx);
  AUTHORIZED_CONTEXT_BINDINGS.set(ctx, binding);
  return ctx;
}

/**
 * Why a presented context was refused. Bounded, like every other denial
 * vocabulary in this module — a consumer surfaces a 403/404, never this text.
 */
export const AUTHORIZED_CONTEXT_REJECTIONS = [
  /** Not an object, or an object this module never minted. */
  "context_not_minted",
  /** Genuine, but proven for a different workspace. */
  "context_workspace_mismatch",
  /** Genuine, but proven for a different actor. */
  "context_actor_mismatch",
  /** Genuine, but the facts it rests on have since changed. */
  "context_generation_stale",
  /** Genuine, but the actor no longer holds the grant. */
  "context_no_longer_authorized",
] as const;

export type AuthorizedContextRejection =
  (typeof AUTHORIZED_CONTEXT_REJECTIONS)[number];

/**
 * Thrown by the verification helpers. Carries a bounded code and NEVER the
 * presented value — a forged object may contain attacker-chosen strings, and
 * echoing them into a log is how a refusal becomes a log-injection.
 */
export class UnauthorizedWorkspaceContextError extends Error {
  readonly code: AuthorizedContextRejection;
  constructor(code: AuthorizedContextRejection) {
    super(`authorized workspace context refused: ${code}`);
    this.name = "UnauthorizedWorkspaceContextError";
    this.code = code;
  }
}

/**
 * SYNCHRONOUS boundary check: is this value a context THIS module minted, and
 * was it minted for the workspace (and, when given, the actor) the caller is
 * about to act on?
 *
 * Use at a boundary that is already inside the authorized request and is not
 * itself a tenant read or an outbound side effect. For those, use
 * `requireLiveAuthorizedWorkspaceContext`, which additionally re-proves the
 * grant against the database.
 */
export function assertMintedAuthorizedWorkspaceContext(
  candidate: unknown,
  expected: { workspaceId: string; userId?: string },
): AuthorizedWorkspaceContext {
  const ctx = assertMintedContext(candidate);
  const binding = AUTHORIZED_CONTEXT_BINDINGS.get(ctx);
  if (!binding) {
    // Registered but unbound is not a state this module can produce; treat it
    // as forged rather than as a genuine context with unknown provenance.
    throw new UnauthorizedWorkspaceContextError("context_not_minted");
  }
  if (binding.workspaceId !== expected.workspaceId) {
    throw new UnauthorizedWorkspaceContextError("context_workspace_mismatch");
  }
  if (expected.userId !== undefined && binding.userId !== expected.userId) {
    throw new UnauthorizedWorkspaceContextError("context_actor_mismatch");
  }
  return ctx;
}

/**
 * PROVENANCE ONLY: "did this module mint this value?", with no opinion about
 * which workspace or actor it was minted for.
 *
 * For consumers that are already INSIDE the authorized frame and are reading
 * a field OFF the context to make a secondary decision — a role tier, a
 * capability — rather than deciding which tenant to touch. Those consumers do
 * not know an independent expected workspace id to compare against (the
 * context is their source for it), so demanding one would be circular; what
 * they genuinely need is the guarantee that the fields they are about to
 * trust came from the canonical chain and not from a caller's object literal.
 *
 * A consumer that CHOOSES a tenant from the context must use
 * `assertMintedAuthorizedWorkspaceContext` (binding-checked) or
 * `requireLiveAuthorizedWorkspaceContext` (binding-checked and re-proven).
 */
export function assertMintedContext(
  candidate: unknown,
): AuthorizedWorkspaceContext {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !MINTED_WORKSPACE_CONTEXTS.has(candidate)
  ) {
    throw new UnauthorizedWorkspaceContextError("context_not_minted");
  }
  return candidate as AuthorizedWorkspaceContext;
}

/**
 * ASYNCHRONOUS boundary check for HIGH-RISK consumers: everything
 * `assertMintedAuthorizedWorkspaceContext` proves, PLUS a fresh proof that the
 * grant still holds right now.
 *
 * This is what makes "minted before the suspension, used after it" refuse.
 * The membership row is re-read, the canonical chain re-evaluated, and the
 * generation fingerprint compared; any divergence refuses BEFORE the caller
 * touches tenant data or performs a side effect.
 *
 * It returns a NEWLY MINTED context bound to the fresh facts, so a caller that
 * keeps using the returned value cannot silently drift back onto the stale one.
 */
export async function requireLiveAuthorizedWorkspaceContext(
  candidate: unknown,
  expected: { workspaceId: string; userId?: string },
): Promise<AuthorizedWorkspaceContext> {
  const ctx = assertMintedAuthorizedWorkspaceContext(candidate, expected);
  const binding = AUTHORIZED_CONTEXT_BINDINGS.get(ctx)!;

  const outcome = await evaluateAuthorizedWorkspace(binding.request, {
    workspaceId: binding.workspaceId,
    permission: binding.permission,
  });
  if (!outcome.allowed) {
    throw new UnauthorizedWorkspaceContextError("context_no_longer_authorized");
  }
  const fresh = AUTHORIZED_CONTEXT_BINDINGS.get(outcome.context)!;
  if (fresh.membershipGeneration !== binding.membershipGeneration) {
    throw new UnauthorizedWorkspaceContextError("context_generation_stale");
  }
  return outcome.context;
}

export type AuthorizeWorkspaceOptions = {
  workspaceId: string | null | undefined;
  permission: Permission;
  resourceKind?: string;
  resourceId?: string;
  /**
   * Conceal "this workspace exists but you cannot enter it" as 404. Defaults
   * to `true` for this primitive — every surface migrated in Batch A is one
   * where leaking a workspace's or a resource's existence to a non-member is
   * itself the defect.
   */
  antiEnumeration?: boolean;
};

export type AuthorizedWorkspaceOutcome =
  | { allowed: true; context: AuthorizedWorkspaceContext }
  | {
      allowed: false;
      reasonCode: AuthorizationDenialCode;
      httpStatus: 401 | 403 | 404 | 503;
    };

/**
 * Effective capability set for an ACTIVE member snapshot: canonical role
 * floor + active capability grants + active delegated-admin scopes.
 *
 * Derived from the SAME inputs `evaluateMember` consults, in the same order,
 * so `ctx.capabilities.has(p)` agrees with what a second `evaluateAccess`
 * for `p` would decide on this snapshot. It is a PROJECTION of the policy
 * engine, never an alternative to it.
 */
function projectEffectiveCapabilities(
  member: MemberAccessSnapshot,
): ReadonlySet<Permission> {
  const now = Date.now();
  const out = new Set<Permission>(
    listRolePermissions(mapTeamRoleToCanonical(member.role)),
  );
  for (const grant of member.capabilityGrants) {
    if (grant.revokedAtUtc !== null) continue;
    if (grant.expiresAtUtc !== null && grant.expiresAtUtc.getTime() <= now) {
      continue;
    }
    out.add(grant.permission as Permission);
  }
  for (const scope of member.delegatedAdminScopes) {
    if (scope.revokedAtUtc !== null) continue;
    if (scope.expiresAtUtc !== null && scope.expiresAtUtc.getTime() <= now) {
      continue;
    }
    for (const p of listPermissionsForDelegatedAdminScope(scope.scopeKind)) {
      // The scope registry is typed as `string[]`; every entry is a canonical
      // Permission by construction (same registry `evaluateMember` consults).
      out.add(p as Permission);
    }
  }
  return out;
}

/**
 * Pure outcome computation for the workspace-context primitive. Exposed for
 * runtime probes and advanced callers that want the decision without a reply.
 */
export async function evaluateAuthorizedWorkspace(
  req: FastifyRequest,
  options: AuthorizeWorkspaceOptions,
): Promise<AuthorizedWorkspaceOutcome> {
  const antiEnumeration = options.antiEnumeration ?? true;

  let userId: string;
  try {
    userId = getAuthUserId(req);
  } catch {
    bump("authorize_denied_total");
    return { allowed: false, reasonCode: "missing_actor", httpStatus: 401 };
  }

  if (!options.workspaceId) {
    bump("authorize_denied_total");
    return {
      allowed: false,
      reasonCode: "missing_team_id",
      // A caller who names no workspace learns nothing about any workspace.
      httpStatus: antiEnumeration ? 404 : 403,
    };
  }

  // ONE policy authority, ONE audit emission. This is
  // `evaluateMemberAccess` — the very call `evaluateAuthorize` makes — in the
  // variant that also hands back the snapshot the decision was made from, so
  // the proven role / kind / organization / capabilities can be reported
  // without a second read and WITHOUT this module re-implementing the
  // load-evaluate-audit composition (which would risk a duplicate audit row
  // for one decision). No status, role or lifecycle comparison is written
  // here.
  let decision: AccessDecision;
  let member: MemberAccessSnapshot | null;
  try {
    const evaluated = await evaluateMemberAccessWithSnapshot({
      teamId: options.workspaceId,
      userId,
      permission: options.permission,
      resourceKind: options.resourceKind,
      resourceId: options.resourceId,
    });
    decision = evaluated.decision;
    member = evaluated.snapshot;
  } catch {
    bump("authorize_failed_closed_total");
    return {
      allowed: false,
      reasonCode: "authorization_unavailable",
      httpStatus: 503,
    };
  }

  if (!decision.allowed) {
    bump("authorize_denied_total");
    const reasonCode: AuthorizationDenialCode = ACCESS_DENY_REASON_SET.has(
      decision.reason,
    )
      ? (decision.reason as AuthorizationDenialCode)
      : "permission_not_granted";
    return {
      allowed: false,
      reasonCode,
      httpStatus: resolveDenyHttpStatus(reasonCode, { antiEnumeration }),
    };
  }

  // `evaluateAccess` cannot allow with a null actor; this narrows the
  // snapshot for the compiler and fails closed if that ever changes.
  if (!member) {
    bump("authorize_failed_closed_total");
    return {
      allowed: false,
      reasonCode: "authorization_unavailable",
      httpStatus: 503,
    };
  }

  const supportDenied = await evaluateSupportContextGuard(
    req,
    userId,
    options.workspaceId,
    options.permission,
  );
  if (supportDenied) {
    bump("authorize_denied_total");
    return {
      allowed: false,
      reasonCode: "support_access_denied",
      httpStatus: 403,
    };
  }

  // Every field below is a PROVEN fact at this point: `evaluateAccess`
  // allowed, which means the kind was not UNKNOWN, the status granted
  // access, the access had not expired, and — for an ORGANIZATION workspace
  // — the parent Organization was ACTIVE.
  const workspaceKind = member.workspaceKind as CanonicalWorkspaceKind;
  bump("authorize_allowed_total");
  // §1.2 — MINTED, not cast. This is the single site in the service where a
  // value of this type is created; the registry entry it writes is what makes
  // the type unforgeable at runtime rather than only at compile time.
  return {
    allowed: true,
    context: mintAuthorizedWorkspaceContext(
      {
        userId,
        workspaceId: options.workspaceId,
        // The physical home of this workspace is the Team row the whole chain
        // above was evaluated against. Same value, named for what it is.
        physicalWorkspaceId: options.workspaceId,
        workspaceKind,
        workspaceRole: mapTeamRoleToCanonical(member.role),
        membershipStatus: "ACTIVE",
        membershipId: member.teamMemberId,
        // Owner identity is carried ONLY for a PERSONAL workspace. On OWNED
        // and ORGANIZATION workspaces the population is strict, so exposing an
        // owner here would invite a read to widen a shared workspace by one
        // person's rows — the mirror image of the omission this closes.
        personalOwnerUserId:
          workspaceKind === "PERSONAL" ? member.workspaceOwnerUserId : null,
        organizationId: member.organizationId,
        organizationLifecycle:
          workspaceKind === "ORGANIZATION" ? "ACTIVE" : null,
        capabilities: projectEffectiveCapabilities(member),
      },
      {
        userId,
        workspaceId: options.workspaceId,
        permission: options.permission,
        mintedAtEpochMs: Date.now(),
        membershipGeneration: membershipGenerationOf(member),
        request: req,
      },
    ),
  };
}

/**
 * Canonical inline gate. Sends the bounded denial response and returns
 * `null` on deny; returns the proof object on allow.
 *
 *   const ctx = await authorizeWorkspaceOrFail(req, reply, {
 *     workspaceId,
 *     permission: "review.queue.read",
 *   });
 *   if (!ctx) return reply;
 */
export async function authorizeWorkspaceOrFail(
  req: FastifyRequest,
  reply: FastifyReply,
  options: AuthorizeWorkspaceOptions,
): Promise<AuthorizedWorkspaceContext | null> {
  const outcome = await evaluateAuthorizedWorkspace(req, options);
  if (outcome.allowed) return outcome.context;
  sendDenyResponse(reply, outcome);
  return null;
}

/**
 * Secondary capability check INSIDE an already-authorized handler.
 *
 * The handler's primary permission is enforced by the constructor; this
 * covers the "…and this operation additionally requires X" case. It reads
 * the projected effective capability set — it never re-derives policy.
 */
export function contextHasCapability(
  ctx: AuthorizedWorkspaceContext,
  permission: Permission,
): boolean {
  // §1.2 — verify provenance before believing the capability set. Without
  // this, a forged object carrying `capabilities: new Set(["*"])` would answer
  // every secondary capability question affirmatively, and the primitive's
  // guarantee would end at the primary gate.
  return assertMintedContext(ctx).capabilities.has(permission);
}

/**
 * SEC-001 — the canonical replacement for `resolveInternalTeam`.
 *
 * `User.currentWorkspaceId` is a NAVIGATION HINT. It records where the
 * operator last was; it records nothing about whether they may still be
 * there. It is read here ONLY to obtain a CANDIDATE workspace id, which is
 * then handed to `evaluateAuthorizedWorkspace` and revalidated in full
 * against the database — identity, workspace existence, workspace kind,
 * EXPLICIT membership, membership status, access expiry, Organization
 * lifecycle, canonical permission and the support-access guard.
 *
 * A pointer at a workspace the caller was removed from, was suspended in, or
 * whose Organization was suspended therefore authorizes NOTHING; it denies
 * exactly as if the caller had named that workspace explicitly. Pointer
 * hygiene (`repairStaleCurrentWorkspacePointer`) reduces how often a stale
 * pointer is even observed — authorization never depends on it having run.
 */
export async function authorizeCurrentWorkspaceOrFail(
  req: FastifyRequest,
  reply: FastifyReply,
  options: Omit<AuthorizeWorkspaceOptions, "workspaceId">,
): Promise<AuthorizedWorkspaceContext | null> {
  const outcome = await evaluateCurrentWorkspace(req, options);
  if (outcome.allowed) return outcome.context;
  sendDenyResponse(reply, outcome);
  return null;
}

/**
 * The evaluate-only counterpart of `authorizeCurrentWorkspaceOrFail`, for
 * guards that own their own denial shape and must not have a canonical
 * response sent underneath them.
 *
 * Added by the §1.3 corrective pass so `require-delegated-tier.ts` — which
 * emits its own `DELEGATED_ADMIN_REQUIRED` envelope and a POLICY_VIOLATION
 * audit event on denial — could adopt the canonical chain WITHOUT either
 * duplicating the pointer read or having two different bodies raced onto one
 * reply.
 */
export async function evaluateCurrentWorkspace(
  req: FastifyRequest,
  options: Omit<AuthorizeWorkspaceOptions, "workspaceId">,
): Promise<AuthorizedWorkspaceOutcome> {
  let candidateWorkspaceId: string | null = null;
  try {
    const userId = getAuthUserId(req);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { currentWorkspaceId: true },
    });
    candidateWorkspaceId = user?.currentWorkspaceId ?? null;
  } catch {
    candidateWorkspaceId = null;
  }
  // A null / absent pointer is indistinguishable from an inaccessible one in
  // the response — both take the `missing_team_id` branch and, under
  // anti-enumeration, conceal as 404.
  return evaluateAuthorizedWorkspace(req, {
    ...options,
    workspaceId: candidateWorkspaceId,
  });
}
