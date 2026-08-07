/**
 * Phase 17 — Identity & Access Platform routes.
 *
 *   GET    /v1/identity/members                          — list members + access state
 *   POST   /v1/identity/members/:id/suspend              — suspend a member
 *   POST   /v1/identity/members/:id/restore              — restore a suspended member
 *   POST   /v1/identity/members/:id/revoke               — revoke a member
 *   POST   /v1/identity/members/:id/role                 — change a member's role
 *   POST   /v1/identity/members/:id/capabilities         — grant a capability
 *   DELETE /v1/identity/capabilities/:grantId            — revoke a capability grant
 *   POST   /v1/identity/members/:id/delegated-admin      — grant a delegated admin scope
 *   DELETE /v1/identity/delegated-admin/:scopeId         — revoke a delegated admin scope
 *   GET    /v1/identity/service-accounts                 — list service accounts (+hardening)
 *   POST   /v1/identity/service-accounts/:id/disable     — disable a credential
 *   POST   /v1/identity/service-accounts/:id/enable      — re-enable a credential
 *   PATCH  /v1/identity/service-accounts/:id/hardening   — update expiry/IP/env/rotation
 *   POST   /v1/identity/contributor-sessions/:id/revoke  — immediate contributor revoke
 *   GET    /v1/identity/access-reviews                   — list access-review queue
 *   POST   /v1/identity/access-reviews/regenerate        — trigger queue regeneration
 *   POST   /v1/identity/access-reviews/:id/decision      — record a review decision
 *   GET    /v1/identity/external-mappings                — list SSO/SCIM mappings
 *   POST   /v1/identity/external-mappings                — link an external identity
 *   DELETE /v1/identity/external-mappings/:id            — unlink an external identity
 *
 * Authentication: session auth (requireAuth). NEVER service-account.
 *
 * ============================================================================
 * PHASE 12B — IDENTITY ADMINISTRATION (2026-07-30). Consumed by
 * `/admin/identity` (the Organization identity administration console).
 *
 * WORKSPACE SUBJECT IS SERVER-DERIVED. The client no longer declares the
 * Organization/workspace it acts in. Two derivations, no third:
 *
 *   1. TARGET-BOUND operations (every mutation that names a member,
 *      capability grant, delegated scope, service account or external
 *      mapping) derive the authoritative workspace from the TARGET ROW
 *      itself (`resolve*Target` below). A `teamId` in the body is accepted
 *      only to REJECT a mismatch — never to widen or choose the scope.
 *   2. COLLECTION operations (list / regenerate / link) derive it from the
 *      persisted `User.currentWorkspaceId` rail, written only by the audited
 *      workspace switcher in platform-context.routes.ts.
 *
 * Both paths then run the CANONICAL authorization primitive
 * (`authorizeOrFail`), which supplies ACTIVE membership + parent-Organization
 * lifecycle + access expiry + capability + audit + fail-closed. The local
 * `evaluateMemberAccess` call and the hand-rolled 403 body that used to live in
 * this file's actor guard are DELETED — this file no longer makes an
 * authorization decision of its own.
 *
 * Hard invariants:
 *   - 404-on-non-member (no oracle for "this team exists"), and a target id
 *     belonging to another Organization is CONCEALED as 404 — never a
 *     403-with-detail that would confirm the row exists somewhere.
 *   - Every sensitive mutation runs `requireStepUpForSensitiveAction` bound to
 *     the TARGET (resourceKind + resourceId), so a challenge minted for one
 *     member can never authorise a mutation on another.
 *   - SCIM/SSO-MANAGED identities are not mutable through these unmanaged
 *     paths (bounded 409 `managed_identity_readonly`); the directory owns them.
 *   - All mutations fail closed if the access policy engine denies.
 *   - All mutations write an AdminAuditLog chain entry (via the service
 *     layer) AND a SecurityEvent (operator surface), carrying BOTH the actor
 *     and the target identity.
 *   - Service-account secrets are never returned (list/read project the
 *     hardening surface only — see `projectApiCredential`).
 * ============================================================================
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
// PHASE 12B — the ONE canonical authorization primitive. It enforces ACTIVE
// membership, parent-Organization lifecycle, access expiry, capability,
// permission-decision audit and fail-closed behaviour. Route-local role/plan
// approximations are not permitted alongside it.
import { authorizeOrFail } from "../middleware/authorize.js";
import { denyTeamIfNotEnterprise as denyIfTeamNotEnterprise } from "../services/enterprise-gate-resolvers.service.js";
import {
  PermissionSchema,
  DELEGATED_ADMIN_SCOPE_KINDS,
  EXTERNAL_IDENTITY_PROVIDERS,
  type Permission,
  type DelegatedAdminScopeKind,
  type ExternalIdentityProvider,
} from "@proovra/shared";
import * as prismaPkg from "@prisma/client";
// WAVE A FINAL CLOSURE (2026-07-22) — member transitions are consumed via the
// Membership Orchestrator public command surface; the rbac engine is internal.
import {
  RbacError,
  changeMemberRole,
  grantCapability,
  grantDelegatedAdminScope,
  listTeamMembersWithAccess,
  restoreMember,
  revokeCapability,
  revokeDelegatedAdminScope,
  revokeMember,
  suspendMember,
} from "../services/identity/membership-provisioning.service.js";
// PHASE 12B — managed (SCIM/SSO-owned) identities are read-only on this
// unmanaged administration path.
import { resolveManagedIdentity } from "../services/identity/identity-mode.service.js";
import {
  disableApiCredential,
  enableApiCredential,
  listApiCredentials,
  projectApiCredential,
  ApiCredentialError,
  updateApiCredentialHardening,
} from "../services/integrations/api-keys.service.js";
import {
  ContributorGovernanceError,
  revokeContributorSession,
} from "../services/identity/contributor-governance.service.js";
import {
  AccessReviewError,
  completeAccessReview,
  listAccessReviews,
  regenerateAccessReviewQueue,
} from "../services/identity/access-review.service.js";
import {
  ExternalIdentityError,
  linkExternalIdentity,
  listExternalIdentityMappings,
  unlinkExternalIdentity,
} from "../services/identity/external-identity.service.js";
// Phase 19 — sensitive routes consume step-up challenges before mutating.
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";

/**
 * `teamId` is now NON-AUTHORITATIVE everywhere in this file: it is accepted
 * for backwards compatibility and used ONLY to reject a mismatch against the
 * server-derived workspace (concealed 404). It never selects the scope.
 */
const DeclaredTeamId = z.object({ teamId: z.string().uuid().optional() });
const ParamsId = z.object({ id: z.string().uuid() });

function requestIp(req: FastifyRequest): string | null {
  const raw = (req.ip ?? "").trim();
  return raw.length > 0 ? raw : null;
}

function requestUa(req: FastifyRequest): string | null {
  const raw = req.headers["user-agent"];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 512) : null;
}

function notFound(reply: FastifyReply): null {
  reply.code(404).send({ error: { code: "not_found" } });
  return null;
}

/**
 * Anti-enumeration + canonical authorization.
 *
 * Step 1 — membership EXISTENCE probe. A caller with no membership row in the
 * authoritative workspace gets 404 (never 403): the response must not confirm
 * that the workspace, or the target inside it, exists at all.
 *
 * Step 2 — the canonical `authorizeOrFail` primitive decides everything else
 * (ACTIVE status, parent-Organization lifecycle, access expiry, capability),
 * emits the permission-decision audit, and sends its own bounded denial.
 * 403 is therefore reserved for denials AFTER membership is confirmed.
 */
async function requireIdentityActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
  permission: Permission,
  resource?: { kind: string; id: string },
): Promise<{ userId: string; teamMemberId: string } | null> {
  const userId = getAuthUserId(req);
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { id: true },
  });
  if (!member) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission,
    ...(resource ? { resourceKind: resource.kind, resourceId: resource.id } : {}),
  });
  if (!outcome) return null;
  return { userId: outcome.actorUserId, teamMemberId: member.id };
}

/**
 * COLLECTION-scope derivation: the persisted `User.currentWorkspaceId` rail
 * (written only by the audited workspace switcher). A declared `teamId` that
 * disagrees is a concealed 404 — the client cannot point a list or a link at a
 * workspace it is not currently in.
 *
 * PHASE 12 CORRECTIVE PASS §1 (2026-08-06) — THE POINTER NO LONGER LEAVES THIS
 * FUNCTION UNAUTHORIZED.
 *
 * What was here before, and why it was replaced
 * ---------------------------------------------------------------------------
 * A `resolveWorkspaceSubject` helper READ the pointer and RETURNED it, on the
 * argument that all seven callers authorized on the next line and a parsing
 * test enforced that they did. The reasoning was sound but the arrangement was
 * not: `verify-current-workspace-authority.mjs` — the gate whose entire
 * purpose is to find pointers laundered through a return value — reported it
 * as its ONE outstanding violation, and a gate that a module argues its way
 * around is not a gate. The previous note also justified the shape by the cost
 * of "a second authorization", which was the wrong trade to be weighing: the
 * fix is not to authorize twice, it is to authorize ONCE, HERE.
 *
 * So the derivation and the authorization are now the same call. The pointer is
 * a CANDIDATE that never escapes: it is handed to `authorizeOrFail` inside this
 * function, and what comes back to the caller is a workspace id the canonical
 * chain has already proven — identity, workspace existence, workspace kind,
 * EXPLICIT membership, membership status, access expiry, parent-Organization
 * lifecycle, the permission, and the support-access guard. There is exactly one
 * policy evaluation and exactly one permission-decision audit row per request,
 * as before.
 *
 * Membership existence is probed FIRST and answers 404, never 403: a caller
 * with no membership must not learn that the workspace or its contents exist.
 */
async function resolveAuthorizedWorkspaceSubject(
  req: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
  declaredTeamId?: string | undefined,
  resource?: { kind: string; id: string },
): Promise<{ teamId: string; actor: { userId: string; teamMemberId: string } } | null> {
  const userId = getAuthUserId(req);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currentWorkspaceId: true },
  });
  const candidateTeamId = user?.currentWorkspaceId ?? null;
  if (!candidateTeamId) return notFound(reply);
  // A consistency check that can only NARROW the outcome: it rejects, it never
  // selects. The authorization below runs on the pointer either way.
  if (declaredTeamId && declaredTeamId !== candidateTeamId) return notFound(reply);

  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId: candidateTeamId, userId } },
    select: { id: true },
  });
  if (!member) return notFound(reply);

  const outcome = await authorizeOrFail(req, reply, {
    teamId: candidateTeamId,
    permission,
    ...(resource ? { resourceKind: resource.kind, resourceId: resource.id } : {}),
  });
  if (!outcome) return null;
  return {
    teamId: candidateTeamId,
    actor: { userId: outcome.actorUserId, teamMemberId: member.id },
  };
}

type MemberTarget = {
  teamId: string;
  teamMemberId: string;
  userId: string;
  role: prismaPkg.TeamRole;
  status: prismaPkg.TeamMemberStatus;
};

/**
 * TARGET-scope derivation for a member id. The authoritative workspace is the
 * one PERSISTED on the target membership row; the caller's declared `teamId`
 * only ever rejects. A member of another Organization is indistinguishable
 * from a member that does not exist (both 404) — and because authorization
 * then runs against the DERIVED workspace, a foreign target can never be
 * mutated even when the id is guessed correctly.
 */
async function resolveMemberTarget(
  reply: FastifyReply,
  teamMemberId: string,
  declaredTeamId?: string | undefined,
): Promise<MemberTarget | null> {
  const row = await prisma.teamMember.findFirst({
    where: { id: teamMemberId },
    select: { id: true, teamId: true, userId: true, role: true, status: true },
  });
  if (!row || !row.teamId) return notFound(reply);
  if (declaredTeamId && declaredTeamId !== row.teamId) return notFound(reply);
  return {
    teamId: row.teamId,
    teamMemberId: row.id,
    userId: row.userId,
    role: row.role,
    status: row.status,
  };
}

/** TARGET-scope derivation for a capability grant id. */
async function resolveCapabilityTarget(
  reply: FastifyReply,
  grantId: string,
  declaredTeamId?: string | undefined,
): Promise<{ teamId: string; grantId: string; teamMemberId: string } | null> {
  const row = await prisma.memberCapabilityGrant.findFirst({
    where: { id: grantId },
    select: { id: true, teamId: true, teamMemberId: true },
  });
  if (!row || !row.teamId) return notFound(reply);
  if (declaredTeamId && declaredTeamId !== row.teamId) return notFound(reply);
  return { teamId: row.teamId, grantId: row.id, teamMemberId: row.teamMemberId };
}

/** TARGET-scope derivation for a delegated-admin scope id. */
async function resolveDelegatedScopeTarget(
  reply: FastifyReply,
  scopeId: string,
  declaredTeamId?: string | undefined,
): Promise<{ teamId: string; scopeId: string; teamMemberId: string } | null> {
  const row = await prisma.memberDelegatedAdminScope.findFirst({
    where: { id: scopeId },
    select: { id: true, teamId: true, teamMemberId: true },
  });
  if (!row || !row.teamId) return notFound(reply);
  if (declaredTeamId && declaredTeamId !== row.teamId) return notFound(reply);
  return { teamId: row.teamId, scopeId: row.id, teamMemberId: row.teamMemberId };
}

/** TARGET-scope derivation for a service-account (ApiCredential) id. */
async function resolveServiceAccountTarget(
  reply: FastifyReply,
  credentialId: string,
  declaredTeamId?: string | undefined,
): Promise<{ teamId: string; credentialId: string } | null> {
  const row = await prisma.apiCredential.findFirst({
    where: { id: credentialId },
    select: { id: true, teamId: true },
  });
  if (!row || !row.teamId) return notFound(reply);
  if (declaredTeamId && declaredTeamId !== row.teamId) return notFound(reply);
  return { teamId: row.teamId, credentialId: row.id };
}

/**
 * TARGET-scope derivation for a contributor (intake) session id. The workspace
 * lives on the owning intake LINK, so the scope is derived through it — a
 * session belonging to another Organization is a concealed 404.
 */
async function resolveContributorSessionTarget(
  reply: FastifyReply,
  intakeSessionId: string,
  declaredTeamId?: string | undefined,
): Promise<{
  teamId: string;
  intakeSessionId: string;
  revokedAtUtc: Date | null;
} | null> {
  const row = await prisma.workflowIntakeSession.findFirst({
    where: { id: intakeSessionId },
    select: {
      id: true,
      revokedAtUtc: true,
      intakeLink: { select: { teamId: true } },
    },
  });
  const teamId = row?.intakeLink?.teamId ?? null;
  if (!row || !teamId) return notFound(reply);
  if (declaredTeamId && declaredTeamId !== teamId) return notFound(reply);
  return {
    teamId,
    intakeSessionId: row.id,
    revokedAtUtc: row.revokedAtUtc,
  };
}

/** TARGET-scope derivation for an external identity mapping id. */
async function resolveMappingTarget(
  reply: FastifyReply,
  mappingId: string,
  declaredTeamId?: string | undefined,
): Promise<{ teamId: string; mappingId: string; userId: string } | null> {
  const row = await prisma.externalIdentityMapping.findFirst({
    where: { id: mappingId },
    select: { id: true, teamId: true, userId: true },
  });
  if (!row || !row.teamId) return notFound(reply);
  if (declaredTeamId && declaredTeamId !== row.teamId) return notFound(reply);
  return { teamId: row.teamId, mappingId: row.id, userId: row.userId };
}

/**
 * MANAGED-IDENTITY GUARD. A SCIM/SSO-owned identity's membership state is
 * owned by the directory; changing it here would be silently reverted on the
 * next sync and would break the organization's provable provisioning trail.
 * Both the resolved MANAGED and the fail-closed MANAGED_UNRESOLVED states are
 * refused with ONE bounded code (never a free-text or state-revealing body).
 * A schema-unavailable read denies too — it is never read as "STANDARD".
 *
 * Returns true when the caller must stop (the reply has been sent).
 */
async function denyIfManagedIdentity(
  reply: FastifyReply,
  targetUserId: string,
): Promise<boolean> {
  try {
    const identity = await resolveManagedIdentity(targetUserId);
    if (identity.state === "STANDARD") return false;
    reply.code(409).send({ error: { code: "managed_identity_readonly" } });
    return true;
  } catch {
    // FAIL CLOSED: an unresolvable identity mode (schema unavailable, read
    // failure) is never read as "STANDARD" — the mutation is refused.
    reply.code(503).send({ error: { code: "identity_mode_unavailable" } });
    return true;
  }
}

function handleRbacError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof RbacError) {
    const status =
      err.code === "member_not_found"
        ? 404
        : err.code === "self_action_forbidden"
          ? 403
          : err.code === "member_owner_immutable" ||
              err.code === "role_transition_to_owner_forbidden"
            ? 400
            : err.code === "invalid_status_transition" ||
                // PHASE 12B — the atomic last-administrator guard.
                err.code === "last_administrator_protected"
              ? 409
              : err.code === "capability_unknown"
                ? 400
                : err.code === "capability_already_active" ||
                    err.code === "delegated_scope_already_active"
                  ? 409
                  : err.code === "capability_not_found" ||
                      err.code === "delegated_scope_not_found"
                    ? 404
                    : 400;
    reply.code(status).send({ error: { code: err.code } });
    return true;
  }
  return false;
}

function handleAccessReviewError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof AccessReviewError) {
    const status =
      err.code === "review_not_found" || err.code === "subject_missing"
        ? 404
        : 409;
    reply.code(status).send({ error: { code: err.code } });
    return true;
  }
  return false;
}

function handleContributorError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof ContributorGovernanceError) {
    const status =
      err.code === "session_not_found"
        ? 404
        : 409;
    reply.code(status).send({ error: { code: err.code } });
    return true;
  }
  return false;
}

function handleExternalError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof ExternalIdentityError) {
    // PHASE 12B — a subject that is not a member of the authoritative
    // workspace is CONCEALED (404), not reported as "exists elsewhere".
    const status =
      err.code === "mapping_not_found" || err.code === "user_not_in_workspace"
        ? 404
        : 409;
    reply.code(status).send({ error: { code: err.code } });
    return true;
  }
  return false;
}

function handleApiCredentialError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof ApiCredentialError) {
    const status =
      err.code === "credential_not_found"
        ? 404
        : err.code === "credential_already_revoked"
          ? 409
          : 400;
    reply.code(status).send({ error: { code: err.code } });
    return true;
  }
  return false;
}

const DelegatedAdminScopeSchema = z.enum(
  DELEGATED_ADMIN_SCOPE_KINDS as unknown as [string, ...string[]],
) as z.ZodType<DelegatedAdminScopeKind>;

const ExternalProviderSchema = z.enum(
  EXTERNAL_IDENTITY_PROVIDERS as unknown as [string, ...string[]],
) as z.ZodType<ExternalIdentityProvider>;

export async function identityRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  app.get(
    "/v1/identity/members",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = DeclaredTeamId.parse(req.query ?? {});
      const resolved = await resolveAuthorizedWorkspaceSubject(
        req, reply, "identity.member.read", q.teamId,
      );
      if (!resolved) return;
      const { teamId, actor } = resolved;
      void actor;
      const rows = await listTeamMembersWithAccess(teamId);
      // The SERVER-derived workspace is echoed so the console can render the
      // scope it is actually administering instead of asserting one.
      return reply.code(200).send({ members: rows, teamId });
    },
  );

  const LifecycleBody = DeclaredTeamId.extend({
    reason: z.string().min(1).max(400).optional(),
  });

  app.post(
    "/v1/identity/members/:id/suspend",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = LifecycleBody.parse(req.body ?? {});
      const target = await resolveMemberTarget(reply, id, body.teamId);
      if (!target) return;
      const actor = await requireIdentityActor(
        req, reply, target.teamId, "identity.member.suspend",
        { kind: "team_member", id: target.teamMemberId },
      );
      if (!actor) return;
      if (await denyIfManagedIdentity(reply, target.userId)) return;
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: target.teamId,
        userId: actor.userId,
        purpose: "MEMBER_SUSPEND",
        resourceKind: "team_member",
        resourceId: target.teamMemberId,
      });
      if (gate.sent) return;
      try {
        const updated = await suspendMember({
          teamId: target.teamId,
          teamMemberId: target.teamMemberId,
          actorUserId: actor.userId,
          reason: body.reason ?? null,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ member: updated });
      } catch (err) {
        if (handleRbacError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/identity/members/:id/restore",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = LifecycleBody.parse(req.body ?? {});
      const target = await resolveMemberTarget(reply, id, body.teamId);
      if (!target) return;
      const actor = await requireIdentityActor(
        req, reply, target.teamId, "identity.member.restore",
        { kind: "team_member", id: target.teamMemberId },
      );
      if (!actor) return;
      if (await denyIfManagedIdentity(reply, target.userId)) return;
      // PHASE 12B — restoring access is as sensitive as removing it: it hands
      // a suspended principal its held role back.
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: target.teamId,
        userId: actor.userId,
        purpose: "MEMBER_RESTORE",
        resourceKind: "team_member",
        resourceId: target.teamMemberId,
      });
      if (gate.sent) return;
      try {
        const updated = await restoreMember({
          teamId: target.teamId,
          teamMemberId: target.teamMemberId,
          actorUserId: actor.userId,
          reason: body.reason ?? null,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ member: updated });
      } catch (err) {
        if (handleRbacError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/identity/members/:id/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = LifecycleBody.parse(req.body ?? {});
      const target = await resolveMemberTarget(reply, id, body.teamId);
      if (!target) return;
      const actor = await requireIdentityActor(
        req, reply, target.teamId, "identity.member.revoke",
        { kind: "team_member", id: target.teamMemberId },
      );
      if (!actor) return;
      if (await denyIfManagedIdentity(reply, target.userId)) return;
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: target.teamId,
        userId: actor.userId,
        purpose: "MEMBER_REVOKE",
        resourceKind: "team_member",
        resourceId: target.teamMemberId,
      });
      if (gate.sent) return;
      try {
        const updated = await revokeMember({
          teamId: target.teamId,
          teamMemberId: target.teamMemberId,
          actorUserId: actor.userId,
          reason: body.reason ?? null,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ member: updated });
      } catch (err) {
        if (handleRbacError(reply, err)) return;
        throw err;
      }
    },
  );

  const RoleChangeBody = LifecycleBody.extend({
    role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
  });

  app.post(
    "/v1/identity/members/:id/role",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = RoleChangeBody.parse(req.body ?? {});
      const target = await resolveMemberTarget(reply, id, body.teamId);
      if (!target) return;
      const actor = await requireIdentityActor(
        req, reply, target.teamId, "identity.member.role.change",
        { kind: "team_member", id: target.teamMemberId },
      );
      if (!actor) return;
      if (await denyIfManagedIdentity(reply, target.userId)) return;
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: target.teamId,
        userId: actor.userId,
        purpose: "MEMBER_ROLE_CHANGE",
        resourceKind: "team_member",
        resourceId: target.teamMemberId,
      });
      if (gate.sent) return;
      try {
        // Last-administrator protection is enforced ATOMICALLY inside the
        // engine's transaction (re-counted under the same snapshot as the
        // write), never pre-flighted here where it would race.
        const updated = await changeMemberRole({
          teamId: target.teamId,
          teamMemberId: target.teamMemberId,
          actorUserId: actor.userId,
          reason: body.reason ?? null,
          newRole: body.role as prismaPkg.TeamRole,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ member: updated });
      } catch (err) {
        if (handleRbacError(reply, err)) return;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  const GrantCapabilityBody = DeclaredTeamId.extend({
    permission: PermissionSchema,
    reason: z.string().min(1).max(400).optional(),
    expiresAtUtc: z.string().datetime().optional(),
  });

  app.post(
    "/v1/identity/members/:id/capabilities",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = GrantCapabilityBody.parse(req.body ?? {});
      const target = await resolveMemberTarget(reply, id, body.teamId);
      if (!target) return;
      const actor = await requireIdentityActor(
        req, reply, target.teamId, "identity.capability.grant",
        { kind: "team_member", id: target.teamMemberId },
      );
      if (!actor) return;
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: target.teamId,
        userId: actor.userId,
        purpose: "CAPABILITY_GRANT",
        resourceKind: "team_member",
        resourceId: target.teamMemberId,
      });
      if (gate.sent) return;
      try {
        const grant = await grantCapability({
          teamId: target.teamId,
          teamMemberId: target.teamMemberId,
          permission: body.permission,
          reason: body.reason ?? null,
          expiresAtUtc: body.expiresAtUtc ? new Date(body.expiresAtUtc) : null,
          actorUserId: actor.userId,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ grant });
      } catch (err) {
        if (handleRbacError(reply, err)) return;
        throw err;
      }
    },
  );

  app.delete(
    "/v1/identity/capabilities/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = LifecycleBody.parse(req.body ?? {});
      const target = await resolveCapabilityTarget(reply, id, body.teamId);
      if (!target) return;
      const actor = await requireIdentityActor(
        req, reply, target.teamId, "identity.capability.revoke",
        { kind: "member_capability_grant", id: target.grantId },
      );
      if (!actor) return;
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: target.teamId,
        userId: actor.userId,
        purpose: "CAPABILITY_REVOKE",
        resourceKind: "member_capability_grant",
        resourceId: target.grantId,
      });
      if (gate.sent) return;
      try {
        const grant = await revokeCapability({
          teamId: target.teamId,
          grantId: target.grantId,
          actorUserId: actor.userId,
          reason: body.reason ?? null,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ grant });
      } catch (err) {
        if (handleRbacError(reply, err)) return;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Delegated admin scopes
  // -------------------------------------------------------------------------

  const GrantDelegatedAdminBody = DeclaredTeamId.extend({
    scopeKind: DelegatedAdminScopeSchema,
    reason: z.string().min(1).max(400).optional(),
    expiresAtUtc: z.string().datetime().optional(),
  });

  app.post(
    "/v1/identity/members/:id/delegated-admin",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = GrantDelegatedAdminBody.parse(req.body ?? {});
      const target = await resolveMemberTarget(reply, id, body.teamId);
      if (!target) return;
      const actor = await requireIdentityActor(
        req, reply, target.teamId, "identity.delegated_admin.grant",
        { kind: "team_member", id: target.teamMemberId },
      );
      if (!actor) return;
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: target.teamId,
        userId: actor.userId,
        purpose: "DELEGATED_ADMIN_GRANT",
        resourceKind: "team_member",
        resourceId: target.teamMemberId,
      });
      if (gate.sent) return;
      try {
        const scope = await grantDelegatedAdminScope({
          teamId: target.teamId,
          teamMemberId: target.teamMemberId,
          scopeKind: body.scopeKind,
          reason: body.reason ?? null,
          expiresAtUtc: body.expiresAtUtc ? new Date(body.expiresAtUtc) : null,
          actorUserId: actor.userId,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ scope });
      } catch (err) {
        if (handleRbacError(reply, err)) return;
        throw err;
      }
    },
  );

  app.delete(
    "/v1/identity/delegated-admin/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = LifecycleBody.parse(req.body ?? {});
      const target = await resolveDelegatedScopeTarget(reply, id, body.teamId);
      if (!target) return;
      const actor = await requireIdentityActor(
        req, reply, target.teamId, "identity.delegated_admin.revoke",
        { kind: "delegated_admin_scope", id: target.scopeId },
      );
      if (!actor) return;
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: target.teamId,
        userId: actor.userId,
        purpose: "DELEGATED_ADMIN_REVOKE",
        resourceKind: "delegated_admin_scope",
        resourceId: target.scopeId,
      });
      if (gate.sent) return;
      try {
        const scope = await revokeDelegatedAdminScope({
          teamId: target.teamId,
          scopeId: target.scopeId,
          actorUserId: actor.userId,
          reason: body.reason ?? null,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ scope });
      } catch (err) {
        if (handleRbacError(reply, err)) return;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Service accounts
  //
  // Machine identities. The projection is hardening-only — the key hash and
  // any plaintext secret are NEVER returned here (a secret is shown at most
  // once, by the credential-creation authority in integrations).
  // -------------------------------------------------------------------------

  app.get(
    "/v1/identity/service-accounts",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = DeclaredTeamId.parse(req.query ?? {});
      const resolved = await resolveAuthorizedWorkspaceSubject(
        req, reply, "identity.service_account.manage", q.teamId,
      );
      if (!resolved) return;
      const { teamId, actor } = resolved;
      void actor;
      const rows = await listApiCredentials({ teamId });
      return reply
        .code(200)
        .send({ serviceAccounts: rows.map(projectApiCredential), teamId });
    },
  );

  app.post(
    "/v1/identity/service-accounts/:id/disable",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = DeclaredTeamId.parse(req.body ?? {});
      const target = await resolveServiceAccountTarget(reply, id, body.teamId);
      if (!target) return;
      const actor = await requireIdentityActor(
        req, reply, target.teamId, "identity.service_account.disable",
        { kind: "api_credential", id: target.credentialId },
      );
      if (!actor) return;
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: target.teamId,
        userId: actor.userId,
        purpose: "SERVICE_ACCOUNT_DISABLE",
        resourceKind: "api_credential",
        resourceId: target.credentialId,
      });
      if (gate.sent) return;
      try {
        const updated = await disableApiCredential({
          id: target.credentialId,
          teamId: target.teamId,
          actorUserId: actor.userId,
        });
        return reply.code(200).send({ serviceAccount: projectApiCredential(updated) });
      } catch (err) {
        if (handleApiCredentialError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/identity/service-accounts/:id/enable",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = DeclaredTeamId.parse(req.body ?? {});
      const target = await resolveServiceAccountTarget(reply, id, body.teamId);
      if (!target) return;
      const actor = await requireIdentityActor(
        req, reply, target.teamId, "identity.service_account.manage",
        { kind: "api_credential", id: target.credentialId },
      );
      if (!actor) return;
      // PHASE 12B — re-enabling machine access restores a credential that can
      // act without a human present; it is gated exactly like disabling.
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: target.teamId,
        userId: actor.userId,
        purpose: "SERVICE_ACCOUNT_ENABLE",
        resourceKind: "api_credential",
        resourceId: target.credentialId,
      });
      if (gate.sent) return;
      try {
        const updated = await enableApiCredential({
          id: target.credentialId,
          teamId: target.teamId,
        });
        return reply.code(200).send({ serviceAccount: projectApiCredential(updated) });
      } catch (err) {
        if (handleApiCredentialError(reply, err)) return;
        throw err;
      }
    },
  );

  const HardeningPatchBody = DeclaredTeamId.extend({
    expiresAtUtc: z.string().datetime().nullable().optional(),
    ipAllowlist: z.array(z.string().min(1).max(64)).optional(),
    environment: z.string().max(32).nullable().optional(),
    rotationRequired: z.boolean().optional(),
  });

  app.patch(
    "/v1/identity/service-accounts/:id/hardening",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = HardeningPatchBody.parse(req.body ?? {});
      const target = await resolveServiceAccountTarget(reply, id, body.teamId);
      if (!target) return;
      const actor = await requireIdentityActor(
        req, reply, target.teamId, "identity.service_account.manage",
        { kind: "api_credential", id: target.credentialId },
      );
      if (!actor) return;
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: target.teamId,
        userId: actor.userId,
        purpose: "SERVICE_ACCOUNT_HARDENING_UPDATE",
        resourceKind: "api_credential",
        resourceId: target.credentialId,
      });
      if (gate.sent) return;
      try {
        const updated = await updateApiCredentialHardening({
          id: target.credentialId,
          teamId: target.teamId,
          expiresAtUtc:
            body.expiresAtUtc === undefined
              ? undefined
              : body.expiresAtUtc === null
                ? null
                : new Date(body.expiresAtUtc),
          ipAllowlist: body.ipAllowlist,
          environment: body.environment,
          rotationRequired: body.rotationRequired,
        });
        return reply.code(200).send({ serviceAccount: projectApiCredential(updated) });
      } catch (err) {
        if (handleApiCredentialError(reply, err)) return;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Contributor sessions
  // -------------------------------------------------------------------------

  app.post(
    "/v1/identity/contributor-sessions/:id/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = LifecycleBody.parse(req.body ?? {});
      // TARGET-derived scope: a session id from another Organization is
      // indistinguishable from one that does not exist.
      const target = await resolveContributorSessionTarget(reply, id, body.teamId);
      if (!target) return;
      const actor = await requireIdentityActor(
        req, reply, target.teamId, "identity.contributor_session.revoke",
        { kind: "workflow_intake_session", id: target.intakeSessionId },
      );
      if (!actor) return;
      // LIVE-STATE check before spending a step-up challenge on a no-op. The
      // authoritative check is still the engine's atomic `updateMany`
      // (revokedAtUtc: null) — this only avoids consuming a challenge for a
      // session that is already revoked.
      if (target.revokedAtUtc !== null) {
        return reply
          .code(409)
          .send({ error: { code: "session_already_revoked" } });
      }
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: target.teamId,
        userId: actor.userId,
        purpose: "CONTRIBUTOR_SESSION_REVOKE",
        resourceKind: "workflow_intake_session",
        resourceId: target.intakeSessionId,
      });
      if (gate.sent) return;
      try {
        const updated = await revokeContributorSession({
          teamId: target.teamId,
          intakeSessionId: target.intakeSessionId,
          actorUserId: actor.userId,
          reason: body.reason ?? null,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ session: updated });
      } catch (err) {
        if (handleContributorError(reply, err)) return;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Org security policy — PHASE 12B WAVE 1.2 (2026-07-28): the legacy
  // GET/PUT /v1/identity/policy pair was DELETED. It was a PARALLEL WRITER of
  // the ONE organization_security_policy row — teamId-keyed, unversioned, no
  // step-up. Its unique fields (mfaRequiredFlag, allowedEmailDomains,
  // restrictedIpRanges, reviewer/contributorSessionTimeoutSeconds,
  // ssoReadyFlag, scimReadyFlag, notes) were FOLDED into the canonical
  // org-keyed authority: PATCH /v1/security-policy (enterprise-security.routes
  // → applySecurityPolicyPatch: versioned, optimistic-concurrency,
  // ORG_SECURITY_POLICY_UPDATE step-up). Zero product consumers existed.
  // Stays-removed guard: phase-12-dead-routes-removed.test.ts.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Access reviews
  // -------------------------------------------------------------------------

  app.get(
    "/v1/identity/access-reviews",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid().optional(),
          status: z
            .enum([
              "PENDING",
              "IN_PROGRESS",
              "COMPLETED_KEEP",
              "COMPLETED_REVOKED",
              "COMPLETED_SUSPENDED",
              "COMPLETED_NO_ACTION",
              "CANCELLED",
            ])
            .optional(),
          kind: z
            .enum([
              "PERIODIC_MEMBER_REVIEW",
              "STALE_ACCESS",
              "UNUSED_SERVICE_ACCOUNT",
              "EXPIRING_TEMPORARY_ACCESS",
              "SUSPICIOUS_ACCESS_PATTERN",
              "EMERGENCY_REVOCATION_FOLLOWUP",
            ])
            .optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const resolved = await resolveAuthorizedWorkspaceSubject(
        req, reply, "identity.access_review.read", q.teamId,
      );
      if (!resolved) return;
      const { teamId, actor } = resolved;
      void actor;
      if (await denyIfTeamNotEnterprise(reply, teamId, "accessReviews")) return;
      const rows = await listAccessReviews({
        teamId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
      });
      return reply.code(200).send({ accessReviews: rows, teamId });
    },
  );

  app.post(
    "/v1/identity/access-reviews/regenerate",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = DeclaredTeamId.parse(req.body ?? {});
      const resolved = await resolveAuthorizedWorkspaceSubject(
        req, reply, "identity.access_review.action", body.teamId,
      );
      if (!resolved) return;
      const { teamId, actor } = resolved;
      if (await denyIfTeamNotEnterprise(reply, teamId, "accessReviews")) return;
      const { created } = await regenerateAccessReviewQueue({
        teamId,
        actorUserId: actor.userId,
      });
      return reply.code(200).send({ created });
    },
  );

  const DecisionBody = DeclaredTeamId.extend({
    decision: z.enum([
      "KEEP",
      "REVOKE_MEMBER",
      "SUSPEND_MEMBER",
      "NO_ACTION",
      "CANCEL",
    ]),
    decisionNote: z.string().min(1).max(2000).optional(),
  });

  app.post(
    "/v1/identity/access-reviews/:id/decision",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = DecisionBody.parse(req.body ?? {});
      const resolved = await resolveAuthorizedWorkspaceSubject(
        req, reply, "identity.access_review.action", body.teamId,
        { kind: "access_review", id },
      );
      if (!resolved) return;
      const { teamId, actor } = resolved;
      if (await denyIfTeamNotEnterprise(reply, teamId, "accessReviews")) return;

      // PHASE 12B ACCEPTANCE — CLOSE A STEP-UP AND MANAGED-IDENTITY BYPASS.
      //
      // A REVOKE_MEMBER / SUSPEND_MEMBER decision reaches the SAME orchestrator
      // commands as POST /v1/identity/members/:id/revoke and .../suspend — but
      // this route applied neither of the two gates those routes apply. The
      // result was a parallel, ungated path to the same mutation:
      //   * no target-bound step-up, so a member could be revoked with no
      //     re-authentication at all; and
      //   * no managed-identity guard, so a SCIM/SSO-owned identity that the
      //     direct route refuses with 409 `managed_identity_readonly` was
      //     revoked here with 200 — silently converting a directory-owned
      //     membership through an unmanaged path.
      //
      // Both gates are applied BEFORE the write, bound to the review's SUBJECT
      // (not the review row), so an approval for one member can never satisfy a
      // decision about another. KEEP / NO_ACTION / CANCEL are not membership
      // mutations and stay ungated.
      const MUTATING_DECISIONS = new Set(["REVOKE_MEMBER", "SUSPEND_MEMBER"]);
      if (MUTATING_DECISIONS.has(body.decision)) {
        const review = await prisma.accessReview.findFirst({
          where: { id, teamId },
          select: { subjectUserId: true },
        });
        // Anti-enumeration: a review from another workspace is indistinguishable
        // from one that does not exist. `completeAccessReview` would also refuse,
        // but the gates must not be skippable by a missing row either.
        if (!review?.subjectUserId) {
          return reply.code(404).send({ error: { code: "not_found" } });
        }
        if (await denyIfManagedIdentity(reply, review.subjectUserId)) return;
        const gate = await requireStepUpForSensitiveAction({
          req,
          reply,
          teamId,
          userId: actor.userId,
          purpose:
            body.decision === "REVOKE_MEMBER" ? "MEMBER_REVOKE" : "MEMBER_SUSPEND",
          resourceKind: "member",
          resourceId: review.subjectUserId,
        });
        if (gate.sent) return;
      }

      try {
        const updated = await completeAccessReview({
          teamId,
          reviewId: id,
          actorUserId: actor.userId,
          decision: body.decision,
          decisionNote: body.decisionNote ?? null,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ accessReview: updated });
      } catch (err) {
        if (handleAccessReviewError(reply, err)) return;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // External identity mappings (SSO/SCIM readiness)
  // -------------------------------------------------------------------------

  app.get(
    "/v1/identity/external-mappings",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid().optional(),
          activeOnly: z.coerce.boolean().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const resolved = await resolveAuthorizedWorkspaceSubject(
        req, reply, "identity.external_mapping.read", q.teamId,
      );
      if (!resolved) return;
      const { teamId, actor } = resolved;
      void actor;
      const rows = await listExternalIdentityMappings({
        teamId,
        ...(q.activeOnly === undefined ? {} : { activeOnly: q.activeOnly }),
        ...(q.limit ? { limit: q.limit } : {}),
      });
      return reply.code(200).send({ externalMappings: rows, teamId });
    },
  );

  const LinkExternalBody = DeclaredTeamId.extend({
    userId: z.string().uuid(),
    provider: ExternalProviderSchema,
    externalSubjectId: z.string().min(1).max(320),
    displayName: z.string().max(180).nullable().optional(),
    externalEmail: z.string().email().max(320).nullable().optional(),
  });

  app.post(
    "/v1/identity/external-mappings",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = LinkExternalBody.parse(req.body ?? {});
      const resolved = await resolveAuthorizedWorkspaceSubject(
        req, reply, "identity.external_mapping.manage", body.teamId,
        { kind: "user", id: body.userId },
      );
      if (!resolved) return;
      const { teamId, actor } = resolved;
      // The subject must be a member of the SERVER-derived workspace. A
      // foreign subject is concealed as 404 by `handleExternalError`.
      if (await denyIfManagedIdentity(reply, body.userId)) return;
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId,
        userId: actor.userId,
        purpose: "EXTERNAL_IDENTITY_LINK",
        resourceKind: "user",
        resourceId: body.userId,
      });
      if (gate.sent) return;
      try {
        const mapping = await linkExternalIdentity({
          teamId,
          userId: body.userId,
          provider: body.provider,
          externalSubjectId: body.externalSubjectId,
          displayName: body.displayName ?? null,
          externalEmail: body.externalEmail ?? null,
          actorUserId: actor.userId,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ mapping });
      } catch (err) {
        if (handleExternalError(reply, err)) return;
        throw err;
      }
    },
  );

  app.delete(
    "/v1/identity/external-mappings/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = DeclaredTeamId.parse(req.body ?? {});
      const target = await resolveMappingTarget(reply, id, body.teamId);
      if (!target) return;
      const actor = await requireIdentityActor(
        req, reply, target.teamId, "identity.external_mapping.manage",
        { kind: "external_identity_mapping", id: target.mappingId },
      );
      if (!actor) return;
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: target.teamId,
        userId: actor.userId,
        purpose: "EXTERNAL_IDENTITY_UNLINK",
        resourceKind: "external_identity_mapping",
        resourceId: target.mappingId,
      });
      if (gate.sent) return;
      try {
        const mapping = await unlinkExternalIdentity({
          teamId: target.teamId,
          mappingId: target.mappingId,
          actorUserId: actor.userId,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ mapping });
      } catch (err) {
        if (handleExternalError(reply, err)) return;
        throw err;
      }
    },
  );
}
