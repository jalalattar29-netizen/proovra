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
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";
import { resolveActiveOperationalWorkspace } from "../services/access/canonical-workspace-resolver.js";
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
  createEmailInvite,
  getCollaborationTeamDetail,
  listAssignments,
  listCollaborationTeams,
  listTeamActivity,
  removeMember,
  revokeInvite,
  suspendMember,
  updateAssignment,
  updateCollaborationTeam,
} from "../services/collaboration-team/collaboration-team.service.js";
import { sendCollaborationTeamInviteEmail } from "../services/collaboration-team/collaboration-team-delivery.service.js";
import {
  BillingLimitError,
  assertCanCreateCollaborationTeam,
  assertCanInviteCollaborationTeamMember,
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

async function requireWorkspaceMembership(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ workspaceId: string; userId: string } | null> {
  const userId = await getAuthUserId(req);
  if (!userId) {
    void reply.code(401).send({ error: "auth_required" });
    return null;
  }
  const ws = await resolveActiveOperationalWorkspace(req, userId);
  if (!ws) {
    void reply.code(409).send({ error: "no_active_workspace" });
    return null;
  }
  return { workspaceId: ws.teamId, userId };
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

// Invitations are EMAIL-ONLY (Teams Entitlement Alignment, 2026-07-14).
// The SMS and shareable-link invitation methods were removed product-wide
// — their endpoints are deleted, not disabled (requests now 404).
const EmailInviteBody = z.object({
  email: z.string().email().max(320),
  role: z.enum(["LEAD", "ADMIN", "MEMBER", "VIEWER", "EXTERNAL"]).optional(),
  expiresInDays: z.number().int().min(1).max(30).optional(),
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
      const ctx = await requireWorkspaceMembership(req, reply);
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
      const ctx = await requireWorkspaceMembership(req, reply);
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
        const ctx = await requireWorkspaceMembership(req, reply);
        if (!ctx) return;
        try {
          const detail = await getCollaborationTeamDetail({
            teamId: req.params.teamId,
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
        const ctx = await requireWorkspaceMembership(req, reply);
        if (!ctx) return;
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
        const ctx = await requireWorkspaceMembership(req, reply);
        if (!ctx) return;
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
        const ctx = await requireWorkspaceMembership(req, reply);
        if (!ctx) return;
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
        const ctx = await requireWorkspaceMembership(req, reply);
        if (!ctx) return;
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
        const ctx = await requireWorkspaceMembership(req, reply);
        if (!ctx) return;
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
  // POST /v1/collaboration-teams/:teamId/invites/email
  // ---------------------------------------------------------------------------
  app.post<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/invites/email",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const ctx = await requireWorkspaceMembership(req, reply);
        if (!ctx) return;
        const parsed = EmailInviteBody.safeParse(req.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        try {
          // Phase 10 — billing guards (pre-mutation).
          await assertSubscriptionActiveOrGraceAllowed(ctx.userId);
          await assertCanInviteCollaborationTeamMember(
            req.params.teamId,
            "EMAIL",
          );
          await assertCollaborationTeamMemberLimit(req.params.teamId, 1);
          const invite = await createEmailInvite({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            email: parsed.data.email,
            role: parsed.data.role,
            expiresInMs: parsed.data.expiresInDays
              ? parsed.data.expiresInDays * 24 * 60 * 60 * 1000
              : undefined,
          });
          // Deliver the email. The send is awaited so the 201 response
          // can carry the actual delivery outcome; the invite row also
          // persists the result for the dashboard (resend / inspect).
          const teamInfo = await getInviteContext({
            teamId: req.params.teamId,
            inviterUserId: ctx.userId,
          });
          const delivered = await sendCollaborationTeamInviteEmail({
            invite,
            teamId: req.params.teamId,
            workspaceId: ctx.workspaceId,
            teamName: teamInfo.teamName,
            workspaceName: teamInfo.workspaceName,
            inviterDisplay: teamInfo.inviterDisplay,
            inviterEmail: teamInfo.inviterEmail,
            inviterUserId: ctx.userId,
            email: parsed.data.email,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.invite.email.created",
            resourceType: "collaboration_team_invite",
            resourceId: invite.id,
            outcome: "success",
            requestId: req.id ?? null,
            metadata: {
              teamId: req.params.teamId,
              channel: "EMAIL",
              delivery: delivered ? "SENT" : "FAILED",
            },
          });
          // NOTE: the raw token is intentionally NOT returned by the
          // email route — the token is delivered out-of-band via the
          // email itself. The dashboard manages the invite by
          // inviteId (resend / revoke / inspect delivery status).
          //
          // PARTIAL SUCCESS: the invite row is created even when the
          // email could not be delivered — `delivery: "FAILED"` tells
          // the operator to resend rather than silently pretending the
          // email went out.
          return reply.code(201).send({
            invite: {
              id: invite.id,
              channel: invite.channel,
              expiresAtUtc: invite.expiresAtUtc,
            },
            delivery: delivered ? "SENT" : "FAILED",
          });
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
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
        const ctx = await requireWorkspaceMembership(req, reply);
        if (!ctx) return;
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
  // GET /v1/collaboration-teams/:teamId/activity
  // ---------------------------------------------------------------------------
  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/activity",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const ctx = await requireWorkspaceMembership(req, reply);
        if (!ctx) return;
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
        const ctx = await requireWorkspaceMembership(req, reply);
        if (!ctx) return;
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
        const ctx = await requireWorkspaceMembership(req, reply);
        if (!ctx) return;
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
        const ctx = await requireWorkspaceMembership(req, reply);
        if (!ctx) return;
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

// -----------------------------------------------------------------------------
// Invite context resolver (helper for delivery wrappers)
// -----------------------------------------------------------------------------

async function getInviteContext(input: {
  teamId: string;
  inviterUserId: string;
}): Promise<{
  teamName: string;
  workspaceName: string;
  inviterDisplay: string;
  inviterEmail: string | null;
}> {
  const team = await prisma.collaborationTeam.findUnique({
    where: { id: input.teamId },
    select: {
      name: true,
      workspace: { select: { name: true } },
    },
  });
  const user = await prisma.user.findUnique({
    where: { id: input.inviterUserId },
    select: {
      email: true,
      displayName: true,
      firstName: true,
      lastName: true,
    },
  });
  const displayName =
    user?.displayName ||
    [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
    user?.email ||
    "A teammate";
  return {
    teamName: team?.name ?? "Team",
    workspaceName: team?.workspace?.name ?? "Workspace",
    inviterDisplay: displayName,
    inviterEmail: user?.email ?? null,
  };
}
