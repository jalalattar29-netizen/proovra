/**
 * PROOVRA Phase 5 — Collaboration Teams API routes.
 *
 * Mounted under `/v1/collaboration-teams` (distinct from the legacy
 * `/v1/teams` workspace-admin endpoints which remain authoritative
 * for runtime workspace administration).
 *
 * Constitutional rules:
 *
 *   - Personal users CAN create collaboration teams (no Organization
 *     required).
 *   - Every mutation goes through the canonical service module.
 *   - Every successful mutation emits a tenant-audit event via the
 *     canonical `emitTenantAudit` facade.
 *   - Invitations are EMAIL-ONLY (Teams Entitlement Alignment,
 *     2026-07-14). Raw invite tokens are NEVER returned by the API —
 *     the token is delivered out-of-band via the invite email and the
 *     database stores the sha256 hash only.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  collaborationTeamRoleHasPermission,
  type Permission,
} from "@proovra/shared";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";
import {
  authorizeCollaborationTeam,
  authorizeCollaborationWorkspace,
} from "../services/collaboration-team/collaboration-authorization.js";
import { prisma } from "../db.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import {
  CollaborationTeamError,
  acceptInvite,
  addExistingMember,
  archiveCollaborationTeam,
  changeMemberRole,
  createAssignment,
  createCollaborationTeam,
  getCollaborationTeamDetail,
  listAssignments,
  listCollaborationTeamMembers,
  listCollaborationTeams,
  listEligibleWorkspaceMembersForTeam,
  listTeamActivity,
  removeMember,
  revokeInvite,
  suspendMember,
  updateAssignment,
  updateCollaborationTeam,
} from "../services/collaboration-team/collaboration-team.service.js";
import {
  BillingLimitError,
  assertCanCreateCollaborationTeam,
  assertCollaborationTeamMemberLimit,
  assertSubscriptionActiveOrGraceAllowed,
} from "../services/collaboration-team/billing-guards.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Phase 10 — translate a `BillingLimitError` thrown by the canonical
 * billing-guard helpers into the canonical structured HTTP response.
 *
 * Shape (fixed by Phase 10):
 *   {
 *     code:        <CollaborationTeamBillingErrorCode>,
 *     message:     <operator-readable string>,
 *     details:     <machine-readable context: plan/limit/usage/...>,
 *     upgradeHref: "/billing",
 *     requestId:   <existing request id | null>,
 *   }
 *
 * Returns `true` if the error was a billing-limit error (and was
 * responded to); `false` otherwise so the caller can fall through to
 * its normal error pipeline.
 */
function handleBillingError(
  reply: FastifyReply,
  err: unknown,
  requestId: string | null,
): boolean {
  if (err instanceof BillingLimitError) {
    void reply.code(err.httpStatus).send({
      code: err.code,
      message: err.message,
      details: err.details,
      upgradeHref: err.upgradeCta,
      requestId,
    });
    return true;
  }
  return false;
}

/**
 * Resolve the PROVEN workspace this request operates in.
 *
 * Replaces `requireWorkspaceMembership`, which called
 * `resolveActiveOperationalWorkspace` and therefore silently answered "your
 * Personal Space" whenever the client named no workspace — which the web
 * client never did. Every caller below now receives a workspace it has been
 * authorized in, or nothing.
 *
 * `permission` is the WORKSPACE-level floor for the operation. Group-local
 * authority is a second, separate check (`authorizeCollaborationTeam`).
 */
async function requireWorkspace(
  req: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
): Promise<{ workspaceId: string; userId: string } | null> {
  const ctx = await authorizeCollaborationWorkspace(req, reply, permission);
  if (!ctx) return null;
  return { workspaceId: ctx.workspaceId, userId: ctx.userId };
}

function handleServiceError(
  reply: FastifyReply,
  err: unknown,
  requestId: string | null,
): void {
  // Phase 10 billing-guard errors get the canonical structured response.
  if (handleBillingError(reply, err, requestId)) {
    return;
  }
  if (err instanceof CollaborationTeamError) {
    // `code` is the stable machine code (INVITE_EXPIRED, INVITE_REVOKED,
    // WORKSPACE_MEMBERSHIP_REQUIRED, ...). `error` mirrors it for
    // backwards compatibility with older consumers.
    void reply.code(err.httpStatus).send({
      code: err.code,
      error: err.code,
      message: err.message,
      requestId,
    });
    return;
  }
  void reply.code(500).send({
    error: "internal_error",
    message: "Something went wrong.",
    requestId,
  });
}

async function auditEvent(args: {
  userId: string;
  workspaceId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  outcome: "success" | "failure" | "blocked";
  requestId: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await emitTenantAudit({
    action: args.action,
    outcome: args.outcome === "blocked" ? "denied" : args.outcome === "failure" ? "error" : "success",
    sourceApp: "API",
    actorUserId: args.userId,
    workspaceId: args.workspaceId,
    resourceType: args.resourceType,
    resourceId: args.resourceId,
    correlationId: args.requestId,
    metadata: args.metadata ?? {},
  });
}

// -----------------------------------------------------------------------------
// Request schemas
// -----------------------------------------------------------------------------

const CreateTeamBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(600).optional().nullable(),
  teamType: z
    .enum(["GENERAL", "INVESTIGATION", "LEGAL", "REVIEW", "COMPLIANCE"])
    .optional(),
});

const UpdateTeamBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(600).optional().nullable(),
  teamType: z
    .enum(["GENERAL", "INVESTIGATION", "LEGAL", "REVIEW", "COMPLIANCE"])
    .optional(),
});

const AddMemberBody = z.object({
  userId: z.string().uuid(),
  role: z
    .enum(["LEAD", "ADMIN", "MEMBER", "VIEWER", "EXTERNAL"])
    .optional(),
});

const UpdateMemberBody = z.object({
  role: z.enum(["LEAD", "ADMIN", "MEMBER", "VIEWER", "EXTERNAL"]).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "REMOVED"]).optional(),
  reason: z.string().max(400).optional().nullable(),
});

const CreateAssignmentBody = z.object({
  targetType: z.enum(["CASE", "EVIDENCE", "REVIEW"]),
  targetId: z.string().uuid(),
  assigneeUserId: z.string().uuid().optional().nullable(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
  dueAtUtc: z
    .string()
    .datetime()
    .optional()
    .nullable()
    .transform((s) => (s ? new Date(s) : null)),
  note: z.string().max(600).optional().nullable(),
});

const UpdateAssignmentBody = z.object({
  status: z
    .enum(["OPEN", "IN_PROGRESS", "COMPLETED", "REASSIGNED", "CANCELLED"])
    .optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
  assigneeUserId: z.string().uuid().optional().nullable(),
  dueAtUtc: z
    .string()
    .datetime()
    .optional()
    .nullable()
    .transform((s) => (s ? new Date(s) : null)),
  note: z.string().max(600).optional().nullable(),
});

// -----------------------------------------------------------------------------
// Route registration
// -----------------------------------------------------------------------------

export async function collaborationTeamsRoutes(app: FastifyInstance) {
  // Global prefix is set at register-time; routes here are relative.

  // ---------------------------------------------------------------------------
  // GET /v1/collaboration-teams  — list teams visible to actor in active workspace
  // ---------------------------------------------------------------------------
  app.get("/v1/collaboration-teams", {
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const ctx = await requireWorkspace(req, reply, "collaboration.thread.read");
      if (!ctx) return;
      try {
        const includeArchived =
          (req.query as Record<string, string | undefined>)?.includeArchived ===
          "true";
        const teams = await listCollaborationTeams({
          workspaceId: ctx.workspaceId,
          actorUserId: ctx.userId,
          includeArchived,
        });
        return reply.send({ teams });
      } catch (err) {
        return handleServiceError(reply, err, req.id ?? null);
      }
    },
  });

  // ---------------------------------------------------------------------------
  // POST /v1/collaboration-teams  — create team
  // ---------------------------------------------------------------------------
  app.post("/v1/collaboration-teams", {
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const ctx = await requireWorkspace(req, reply, "collaboration.thread.create");
      if (!ctx) return;
      const parsed = CreateTeamBody.safeParse(req.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: "invalid_body", message: parsed.error.message });
      try {
        // Phase 10 — billing guards (pre-mutation).
        await assertSubscriptionActiveOrGraceAllowed(ctx.userId);
        await assertCanCreateCollaborationTeam({
          workspaceId: ctx.workspaceId,
          actorUserId: ctx.userId,
        });
        const result = await createCollaborationTeam({
          workspaceId: ctx.workspaceId,
          actorUserId: ctx.userId,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          teamType: parsed.data.teamType ?? null,
        });
        await auditEvent({
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          action: "collaboration_team.created",
          resourceType: "collaboration_team",
          resourceId: result.id,
          outcome: "success",
          requestId: req.id ?? null,
          metadata: { name: parsed.data.name },
        });
        return reply.code(201).send({ team: { id: result.id } });
      } catch (err) {
        return handleServiceError(reply, err, req.id ?? null);
      }
    },
  });

  // ---------------------------------------------------------------------------
  // GET /v1/collaboration-teams/:teamId  — detail
  // ---------------------------------------------------------------------------
  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.read",
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          const detail = await getCollaborationTeamDetail({
            teamId: req.params.teamId,
            workspaceId: ctx.workspaceId,
            actorUserId: ctx.userId,
          });
          return reply.send({ team: detail });
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /v1/collaboration-teams/:teamId  — update
  // ---------------------------------------------------------------------------
  app.patch<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          groupPermission: "team.update_settings",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        const parsed = UpdateTeamBody.safeParse(req.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        try {
          // Phase 10 — billing write-gate (no quota for plain updates).
          await assertSubscriptionActiveOrGraceAllowed(ctx.userId);
          await updateCollaborationTeam({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            name: parsed.data.name,
            description: parsed.data.description,
            teamType: parsed.data.teamType,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.updated",
            resourceType: "collaboration_team",
            resourceId: req.params.teamId,
            outcome: "success",
            requestId: req.id ?? null,
          });
          return reply.send({ ok: true });
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/collaboration-teams/:teamId/archive  — archive
  // ---------------------------------------------------------------------------
  app.post<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/archive",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          groupPermission: "team.archive",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          await archiveCollaborationTeam({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.archived",
            resourceType: "collaboration_team",
            resourceId: req.params.teamId,
            outcome: "success",
            requestId: req.id ?? null,
          });
          return reply.send({ ok: true });
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/collaboration-teams/:teamId/members  — add existing member
  // ---------------------------------------------------------------------------
  app.post<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/members",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          groupPermission: "team.member.invite",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        const parsed = AddMemberBody.safeParse(req.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        try {
          // Phase 10 — billing guards (pre-mutation).
          await assertSubscriptionActiveOrGraceAllowed(ctx.userId);
          await assertCollaborationTeamMemberLimit(req.params.teamId, 1);
          const { id } = await addExistingMember({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            userIdToAdd: parsed.data.userId,
            role: parsed.data.role,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.member.added",
            resourceType: "collaboration_team_member",
            resourceId: id,
            outcome: "success",
            requestId: req.id ?? null,
            metadata: { teamId: req.params.teamId, role: parsed.data.role },
          });
          return reply.code(201).send({ member: { id } });
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /v1/collaboration-teams/:teamId/members/:memberId  — role or status
  // ---------------------------------------------------------------------------
  app.patch<{ Params: { teamId: string; memberId: string } }>(
    "/v1/collaboration-teams/:teamId/members/:memberId",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        const parsed = UpdateMemberBody.safeParse(req.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        try {
          // Phase 10 — billing write-gate (no quota for role/status changes).
          await assertSubscriptionActiveOrGraceAllowed(ctx.userId);
          if (parsed.data.role) {
            await changeMemberRole({
              teamId: req.params.teamId,
              actorUserId: ctx.userId,
              memberId: req.params.memberId,
              role: parsed.data.role,
            });
            await auditEvent({
              userId: ctx.userId,
              workspaceId: ctx.workspaceId,
              action: "collaboration_team.member.role_changed",
              resourceType: "collaboration_team_member",
              resourceId: req.params.memberId,
              outcome: "success",
              requestId: req.id ?? null,
              metadata: { newRole: parsed.data.role },
            });
          }
          if (parsed.data.status === "SUSPENDED") {
            await suspendMember({
              teamId: req.params.teamId,
              actorUserId: ctx.userId,
              memberId: req.params.memberId,
              reason: parsed.data.reason,
            });
            await auditEvent({
              userId: ctx.userId,
              workspaceId: ctx.workspaceId,
              action: "collaboration_team.member.suspended",
              resourceType: "collaboration_team_member",
              resourceId: req.params.memberId,
              outcome: "success",
              requestId: req.id ?? null,
            });
          }
          return reply.send({ ok: true });
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /v1/collaboration-teams/:teamId/members/:memberId  — remove
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { teamId: string; memberId: string } }>(
    "/v1/collaboration-teams/:teamId/members/:memberId",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          groupPermission: "team.member.remove",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          await removeMember({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            memberId: req.params.memberId,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.member.removed",
            resourceType: "collaboration_team_member",
            resourceId: req.params.memberId,
            outcome: "success",
            requestId: req.id ?? null,
          });
          return reply.send({ ok: true });
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/collaboration-teams/:teamId/invites/email  — RETIRED
  //
  // A Collaboration Team does not invite people. It groups people who already
  // hold authority in the workspace that contains it.
  //
  // This endpoint modelled the opposite: it was shaped like a workspace
  // invitation — address, token, delivery, expiry, single use — while its own
  // acceptance path required the recipient to ALREADY be an active member of
  // the parent workspace. Everything that made it an invitation was therefore
  // redundant, and every one of its defects lived in that redundant machinery:
  // no binding to the invited address, a non-atomic claim, no resend, an
  // unrecoverable delivery failure, and a token in a URL.
  //
  // The two real operations are separate and both already exist:
  //
  //   1. bring the person into the WORKSPACE — POST /v1/teams/:id/invites
  //      (or an Organization invitation with workspace assignments, or SCIM);
  //   2. assign an existing active workspace member to the group —
  //      POST /v1/collaboration-teams/:teamId/members.
  //
  // Outstanding links keep working: the accept path is repaired, bound to the
  // invited address and atomic. Revocation stays reachable so operators can
  // clear pending rows. Nothing new is written.
  // ---------------------------------------------------------------------------
  app.post<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/invites/email",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          groupPermission: "team.member.invite",
          requireActiveTeam: true,
        });
        if (!binding) return;
        await auditEvent({
          userId: binding.workspace.userId,
          workspaceId: binding.workspace.workspaceId,
          action: "collaboration_team.invite.email.retired",
          resourceType: "collaboration_team",
          resourceId: req.params.teamId,
          outcome: "blocked",
          requestId: req.id ?? null,
        });
        return reply.code(410).send({
          code: "COLLABORATION_TEAM_INVITE_RETIRED",
          error: "COLLABORATION_TEAM_INVITE_RETIRED",
          message:
            "Teams are made from people who are already in this workspace. Invite them to the workspace first, then add them to the team.",
          nextSteps: {
            inviteToWorkspace: "/v1/teams/{workspaceId}/invites",
            addExistingMember:
              "/v1/collaboration-teams/{teamId}/members",
            eligibleMembers:
              "/v1/collaboration-teams/{teamId}/eligible-members",
          },
          requestId: req.id ?? null,
        });
      },
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/collaboration-teams/:teamId/invites/:inviteId/revoke
  // ---------------------------------------------------------------------------
  app.post<{ Params: { teamId: string; inviteId: string } }>(
    "/v1/collaboration-teams/:teamId/invites/:inviteId/revoke",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          groupPermission: "team.invite.revoke",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          await revokeInvite({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            inviteId: req.params.inviteId,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.invite.revoked",
            resourceType: "collaboration_team_invite",
            resourceId: req.params.inviteId,
            outcome: "success",
            requestId: req.id ?? null,
          });
          return reply.send({ ok: true });
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/collaboration-team-invites/:token/accept
  // ---------------------------------------------------------------------------
  app.post<{ Params: { token: string } }>(
    "/v1/collaboration-team-invites/:token/accept",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const userId = await getAuthUserId(req);
        if (!userId)
          return reply.code(401).send({ error: "auth_required" });
        try {
          // No subscription gate here: acceptance is by the invitee,
          // not the team owner. The owner's plan controls the per-team
          // cap — the service calls the canonical
          // `assertCollaborationTeamMemberLimit` guard AFTER the
          // already-a-member short-circuit and BEFORE the membership
          // write, so:
          //   - already-member re-accepts succeed even on a full team,
          //   - capacity / plan-restriction failures propagate with
          //     their stable billing codes (TEAM_MEMBER_LIMIT_REACHED /
          //     TEAM_INVITES_NOT_INCLUDED) + details via
          //     handleServiceError → handleBillingError.
          const result = await acceptInvite({
            rawToken: req.params.token,
            actorUserId: userId,
          });
          await auditEvent({
            userId,
            workspaceId: result.workspaceId,
            action: "collaboration_team.invite.accepted",
            resourceType: "collaboration_team_member",
            resourceId: result.memberId,
            outcome: "success",
            requestId: req.id ?? null,
            metadata: {
              teamId: result.teamId,
              alreadyMember: result.alreadyMember,
            },
          });
          return reply.send({
            teamId: result.teamId,
            memberId: result.memberId,
            alreadyMember: result.alreadyMember,
          });
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/collaboration-teams/:teamId/eligible-members
  //
  // The directory a team is BUILT FROM, and the replacement for inviting by
  // address from inside a group.
  //
  // It answers one question — "which people already authorized in this
  // workspace are not yet in this team?" — and it answers it on the server,
  // paginated and searchable, because the alternative is what the members tab
  // used to do: fetch every member and filter in the browser.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/eligible-members",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "identity.member.read",
          groupPermission: "team.member.invite",
        });
        if (!binding) return;
        try {
          const q = (req.query as Record<string, string | undefined>) ?? {};
          const res = await listEligibleWorkspaceMembersForTeam({
            workspaceId: binding.workspace.workspaceId,
            teamId: req.params.teamId,
            search: q.q ?? null,
            limit: q.limit ? parseInt(q.limit, 10) : undefined,
            cursor: q.cursor ?? null,
          });
          return reply.send(res);
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/collaboration-teams/:teamId/members
  //
  // Paginated, searchable membership. The detail endpoint used to return every
  // member of a team in one unbounded array — 386 KB at a thousand members,
  // every address included, with no search anywhere to escape it.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/members",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.read",
        });
        if (!binding) return;
        try {
          const q = (req.query as Record<string, string | undefined>) ?? {};
          const res = await listCollaborationTeamMembers({
            teamId: req.params.teamId,
            viewerCanSeeContact: binding.groupRole
              ? collaborationTeamRoleHasPermission(
                  binding.groupRole,
                  "team.member.invite",
                )
              : false,
            search: q.q ?? null,
            status: q.status ?? null,
            role: q.role ?? null,
            limit: q.limit ? parseInt(q.limit, 10) : undefined,
            cursor: q.cursor ?? null,
          });
          return reply.send(res);
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/collaboration-teams/:teamId/activity
  // ---------------------------------------------------------------------------
  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/activity",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.read",
          groupPermission: "team.activity.read",
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          const q = (req.query as Record<string, string | undefined>) ?? {};
          const limit = q.limit ? parseInt(q.limit, 10) : undefined;
          const cursor = q.cursor ?? null;
          const result = await listTeamActivity({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            limit,
            cursor,
          });
          return reply.send(result);
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/collaboration-teams/:teamId/assignments
  // ---------------------------------------------------------------------------
  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/assignments",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.read",
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          const status =
            (req.query as Record<string, string | undefined>)?.status ?? null;
          const items = await listAssignments({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            status,
          });
          return reply.send({ assignments: items });
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/collaboration-teams/:teamId/assignments
  // ---------------------------------------------------------------------------
  app.post<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/assignments",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          groupPermission: "team.assignment.create",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        const parsed = CreateAssignmentBody.safeParse(req.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        try {
          // Phase 10 — billing write-gate.
          await assertSubscriptionActiveOrGraceAllowed(ctx.userId);
          const result = await createAssignment({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            targetType: parsed.data.targetType,
            targetId: parsed.data.targetId,
            assigneeUserId: parsed.data.assigneeUserId,
            priority: parsed.data.priority,
            dueAtUtc: parsed.data.dueAtUtc,
            note: parsed.data.note,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.assignment.created",
            resourceType: "collaboration_team_assignment",
            resourceId: result.id,
            outcome: "success",
            requestId: req.id ?? null,
            metadata: {
              teamId: req.params.teamId,
              targetType: parsed.data.targetType,
              targetId: parsed.data.targetId,
            },
          });
          return reply.code(201).send({ assignment: { id: result.id } });
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /v1/collaboration-teams/:teamId/assignments/:assignmentId
  // ---------------------------------------------------------------------------
  app.patch<{ Params: { teamId: string; assignmentId: string } }>(
    "/v1/collaboration-teams/:teamId/assignments/:assignmentId",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        const parsed = UpdateAssignmentBody.safeParse(req.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        try {
          // Phase 10 — billing write-gate.
          await assertSubscriptionActiveOrGraceAllowed(ctx.userId);
          await updateAssignment({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            assignmentId: req.params.assignmentId,
            status: parsed.data.status,
            priority: parsed.data.priority,
            assigneeUserId: parsed.data.assigneeUserId,
            dueAtUtc: parsed.data.dueAtUtc,
            note: parsed.data.note,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.assignment.updated",
            resourceType: "collaboration_team_assignment",
            resourceId: req.params.assignmentId,
            outcome: "success",
            requestId: req.id ?? null,
          });
          return reply.send({ ok: true });
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );
}

