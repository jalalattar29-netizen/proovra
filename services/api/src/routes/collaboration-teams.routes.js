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
 *   - Every successful mutation emits an audit event via
 *     `appendPlatformAuditLog`.
 *   - Raw invite tokens are returned ONCE in the create-invite
 *     response (so the operator can copy a link) and otherwise NEVER
 *     re-exposed (the database stores sha256 hash only).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";
import { resolveActiveOperationalWorkspace } from "../services/access/canonical-workspace-resolver.js";
import { prisma } from "../db.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { CollaborationTeamError, acceptInvite, addExistingMember, archiveCollaborationTeam, changeMemberRole, createAssignment, createCollaborationTeam, createEmailInvite, createLinkInvite, createSmsInvite, getCollaborationTeamDetail, listAssignments, listCollaborationTeams, listTeamActivity, removeMember, revokeInvite, suspendMember, updateAssignment, updateCollaborationTeam, } from "../services/collaboration-team/collaboration-team.service.js";
import { sendCollaborationTeamInviteEmail, sendCollaborationTeamInviteSms, } from "../services/collaboration-team/collaboration-team-delivery.service.js";
import { BillingLimitError, assertCanCreateCollaborationTeam, assertCanInviteCollaborationTeamMember, assertCollaborationTeamMemberLimit, assertSubscriptionActiveOrGraceAllowed, } from "../services/collaboration-team/billing-guards.js";
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
 *     upgradeHref: "/billing",
 *     requestId:   <existing request id | null>,
 *   }
 *
 * Returns `true` if the error was a billing-limit error (and was
 * responded to); `false` otherwise so the caller can fall through to
 * its normal error pipeline.
 */
function handleBillingError(reply, err, requestId) {
    if (err instanceof BillingLimitError) {
        void reply.code(err.httpStatus).send({
            code: err.code,
            message: err.message,
            upgradeHref: err.upgradeCta,
            requestId,
        });
        return true;
    }
    return false;
}
async function requireWorkspaceMembership(req, reply) {
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
function handleServiceError(reply, err, requestId) {
    // Phase 10 billing-guard errors get the canonical structured response.
    if (handleBillingError(reply, err, requestId)) {
        return;
    }
    if (err instanceof CollaborationTeamError) {
        void reply.code(err.httpStatus).send({
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
async function auditEvent(args) {
    await appendPlatformAuditLog({
        userId: args.userId,
        action: args.action,
        category: "collaboration_team",
        severity: "info",
        source: "api_collaboration_teams",
        outcome: args.outcome,
        resourceType: args.resourceType,
        resourceId: args.resourceId,
        requestId: args.requestId,
        metadata: (args.metadata ?? {}),
        ipAddress: null,
        userAgent: null,
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
const EmailInviteBody = z.object({
    email: z.string().email().max(320),
    role: z.enum(["LEAD", "ADMIN", "MEMBER", "VIEWER", "EXTERNAL"]).optional(),
    expiresInDays: z.number().int().min(1).max(30).optional(),
});
const SmsInviteBody = z.object({
    phone: z.string().min(8).max(20),
    role: z.enum(["LEAD", "ADMIN", "MEMBER", "VIEWER", "EXTERNAL"]).optional(),
    expiresInDays: z.number().int().min(1).max(30).optional(),
});
const LinkInviteBody = z.object({
    role: z.enum(["LEAD", "ADMIN", "MEMBER", "VIEWER", "EXTERNAL"]).optional(),
    maxUses: z.number().int().min(1).max(1000).optional(),
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
export async function collaborationTeamsRoutes(app) {
    // Global prefix is set at register-time; routes here are relative.
    // ---------------------------------------------------------------------------
    // GET /v1/collaboration-teams  — list teams visible to actor in active workspace
    // ---------------------------------------------------------------------------
    app.get("/v1/collaboration-teams", {
        preHandler: requireAuth,
        handler: async (req, reply) => {
            const ctx = await requireWorkspaceMembership(req, reply);
            if (!ctx)
                return;
            try {
                const includeArchived = req.query?.includeArchived ===
                    "true";
                const teams = await listCollaborationTeams({
                    workspaceId: ctx.workspaceId,
                    actorUserId: ctx.userId,
                    includeArchived,
                });
                return reply.send({ teams });
            }
            catch (err) {
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
            if (!ctx)
                return;
            const parsed = CreateTeamBody.safeParse(req.body);
            if (!parsed.success)
                return reply
                    .code(400)
                    .send({ error: "invalid_body", message: parsed.error.message });
            try {
                // Phase 10 — billing guards (pre-mutation).
                await assertSubscriptionActiveOrGraceAllowed(ctx.userId);
                await assertCanCreateCollaborationTeam(ctx.userId);
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
            }
            catch (err) {
                return handleServiceError(reply, err, req.id ?? null);
            }
        },
    });
    // ---------------------------------------------------------------------------
    // GET /v1/collaboration-teams/:teamId  — detail
    // ---------------------------------------------------------------------------
    app.get("/v1/collaboration-teams/:teamId", {
        preHandler: requireAuth,
        handler: async (req, reply) => {
            const ctx = await requireWorkspaceMembership(req, reply);
            if (!ctx)
                return;
            try {
                const detail = await getCollaborationTeamDetail({
                    teamId: req.params.teamId,
                    actorUserId: ctx.userId,
                });
                return reply.send({ team: detail });
            }
            catch (err) {
                return handleServiceError(reply, err, req.id ?? null);
            }
        },
    });
    // ---------------------------------------------------------------------------
    // PATCH /v1/collaboration-teams/:teamId  — update
    // ---------------------------------------------------------------------------
    app.patch("/v1/collaboration-teams/:teamId", {
        preHandler: requireAuth,
        handler: async (req, reply) => {
            const ctx = await requireWorkspaceMembership(req, reply);
            if (!ctx)
                return;
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
            }
            catch (err) {
                return handleServiceError(reply, err, req.id ?? null);
            }
        },
    });
    // ---------------------------------------------------------------------------
    // POST /v1/collaboration-teams/:teamId/archive  — archive
    // ---------------------------------------------------------------------------
    app.post("/v1/collaboration-teams/:teamId/archive", {
        preHandler: requireAuth,
        handler: async (req, reply) => {
            const ctx = await requireWorkspaceMembership(req, reply);
            if (!ctx)
                return;
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
            }
            catch (err) {
                return handleServiceError(reply, err, req.id ?? null);
            }
        },
    });
    // ---------------------------------------------------------------------------
    // POST /v1/collaboration-teams/:teamId/members  — add existing member
    // ---------------------------------------------------------------------------
    app.post("/v1/collaboration-teams/:teamId/members", {
        preHandler: requireAuth,
        handler: async (req, reply) => {
            const ctx = await requireWorkspaceMembership(req, reply);
            if (!ctx)
                return;
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
            }
            catch (err) {
                return handleServiceError(reply, err, req.id ?? null);
            }
        },
    });
    // ---------------------------------------------------------------------------
    // PATCH /v1/collaboration-teams/:teamId/members/:memberId  — role or status
    // ---------------------------------------------------------------------------
    app.patch("/v1/collaboration-teams/:teamId/members/:memberId", {
        preHandler: requireAuth,
        handler: async (req, reply) => {
            const ctx = await requireWorkspaceMembership(req, reply);
            if (!ctx)
                return;
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
            }
            catch (err) {
                return handleServiceError(reply, err, req.id ?? null);
            }
        },
    });
    // ---------------------------------------------------------------------------
    // DELETE /v1/collaboration-teams/:teamId/members/:memberId  — remove
    // ---------------------------------------------------------------------------
    app.delete("/v1/collaboration-teams/:teamId/members/:memberId", {
        preHandler: requireAuth,
        handler: async (req, reply) => {
            const ctx = await requireWorkspaceMembership(req, reply);
            if (!ctx)
                return;
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
            }
            catch (err) {
                return handleServiceError(reply, err, req.id ?? null);
            }
        },
    });
    // ---------------------------------------------------------------------------
    // POST /v1/collaboration-teams/:teamId/invites/email
    // ---------------------------------------------------------------------------
    app.post("/v1/collaboration-teams/:teamId/invites/email", {
        preHandler: requireAuth,
        handler: async (req, reply) => {
            const ctx = await requireWorkspaceMembership(req, reply);
            if (!ctx)
                return;
            const parsed = EmailInviteBody.safeParse(req.body);
            if (!parsed.success)
                return reply
                    .code(400)
                    .send({ error: "invalid_body", message: parsed.error.message });
            try {
                // Phase 10 — billing guards (pre-mutation).
                await assertSubscriptionActiveOrGraceAllowed(ctx.userId);
                await assertCanInviteCollaborationTeamMember(req.params.teamId, "EMAIL");
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
                // Deliver the email (fire-and-forget on error; the invite
                // row carries the delivery result for the dashboard).
                const teamInfo = await getInviteContext({
                    teamId: req.params.teamId,
                    inviterUserId: ctx.userId,
                });
                await sendCollaborationTeamInviteEmail({
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
                    metadata: { teamId: req.params.teamId, channel: "EMAIL" },
                });
                // NOTE: the raw token is intentionally NOT returned by the
                // email route — the token is delivered out-of-band via the
                // email itself. The dashboard manages the invite by
                // inviteId (resend / revoke / inspect delivery status).
                return reply.code(201).send({
                    invite: {
                        id: invite.id,
                        channel: invite.channel,
                        expiresAtUtc: invite.expiresAtUtc,
                    },
                });
            }
            catch (err) {
                return handleServiceError(reply, err, req.id ?? null);
            }
        },
    });
    // ---------------------------------------------------------------------------
    // POST /v1/collaboration-teams/:teamId/invites/sms
    // ---------------------------------------------------------------------------
    app.post("/v1/collaboration-teams/:teamId/invites/sms", {
        preHandler: requireAuth,
        handler: async (req, reply) => {
            const ctx = await requireWorkspaceMembership(req, reply);
            if (!ctx)
                return;
            const parsed = SmsInviteBody.safeParse(req.body);
            if (!parsed.success)
                return reply
                    .code(400)
                    .send({ error: "invalid_body", message: parsed.error.message });
            try {
                // Phase 10 — billing guards (pre-mutation).
                await assertSubscriptionActiveOrGraceAllowed(ctx.userId);
                await assertCanInviteCollaborationTeamMember(req.params.teamId, "SMS");
                await assertCollaborationTeamMemberLimit(req.params.teamId, 1);
                const invite = await createSmsInvite({
                    teamId: req.params.teamId,
                    actorUserId: ctx.userId,
                    phone: parsed.data.phone,
                    role: parsed.data.role,
                    expiresInMs: parsed.data.expiresInDays
                        ? parsed.data.expiresInDays * 24 * 60 * 60 * 1000
                        : undefined,
                });
                const teamInfo = await getInviteContext({
                    teamId: req.params.teamId,
                    inviterUserId: ctx.userId,
                });
                await sendCollaborationTeamInviteSms({
                    invite,
                    teamId: req.params.teamId,
                    workspaceId: ctx.workspaceId,
                    teamName: teamInfo.teamName,
                    workspaceName: teamInfo.workspaceName,
                    inviterDisplay: teamInfo.inviterDisplay,
                    inviterEmail: teamInfo.inviterEmail,
                    inviterUserId: ctx.userId,
                    phone: parsed.data.phone,
                });
                await auditEvent({
                    userId: ctx.userId,
                    workspaceId: ctx.workspaceId,
                    action: "collaboration_team.invite.sms.created",
                    resourceType: "collaboration_team_invite",
                    resourceId: invite.id,
                    outcome: "success",
                    requestId: req.id ?? null,
                    metadata: { teamId: req.params.teamId, channel: "SMS" },
                });
                return reply.code(201).send({
                    invite: {
                        id: invite.id,
                        channel: invite.channel,
                        expiresAtUtc: invite.expiresAtUtc,
                    },
                });
            }
            catch (err) {
                return handleServiceError(reply, err, req.id ?? null);
            }
        },
    });
    // ---------------------------------------------------------------------------
    // POST /v1/collaboration-teams/:teamId/invites/link
    // ---------------------------------------------------------------------------
    app.post("/v1/collaboration-teams/:teamId/invites/link", {
        preHandler: requireAuth,
        handler: async (req, reply) => {
            const ctx = await requireWorkspaceMembership(req, reply);
            if (!ctx)
                return;
            const parsed = LinkInviteBody.safeParse(req.body);
            if (!parsed.success)
                return reply
                    .code(400)
                    .send({ error: "invalid_body", message: parsed.error.message });
            try {
                // Phase 10 — billing guards (pre-mutation).
                await assertSubscriptionActiveOrGraceAllowed(ctx.userId);
                await assertCanInviteCollaborationTeamMember(req.params.teamId, "LINK");
                await assertCollaborationTeamMemberLimit(req.params.teamId, 1);
                const invite = await createLinkInvite({
                    teamId: req.params.teamId,
                    actorUserId: ctx.userId,
                    role: parsed.data.role,
                    maxUses: parsed.data.maxUses,
                    expiresInMs: parsed.data.expiresInDays
                        ? parsed.data.expiresInDays * 24 * 60 * 60 * 1000
                        : undefined,
                });
                await auditEvent({
                    userId: ctx.userId,
                    workspaceId: ctx.workspaceId,
                    action: "collaboration_team.invite.link.created",
                    resourceType: "collaboration_team_invite",
                    resourceId: invite.id,
                    outcome: "success",
                    requestId: req.id ?? null,
                    metadata: {
                        teamId: req.params.teamId,
                        channel: "LINK",
                        maxUses: invite.maxUses,
                    },
                });
                // LINK invites return the rawToken + acceptUrl ONCE so the
                // operator can copy it. Subsequent GETs only expose the
                // delivery status + role + expiry.
                return reply.code(201).send({
                    invite: {
                        id: invite.id,
                        channel: invite.channel,
                        expiresAtUtc: invite.expiresAtUtc,
                        maxUses: invite.maxUses,
                        rawToken: invite.rawToken,
                        acceptUrl: invite.acceptUrl,
                    },
                });
            }
            catch (err) {
                return handleServiceError(reply, err, req.id ?? null);
            }
        },
    });
    // ---------------------------------------------------------------------------
    // POST /v1/collaboration-teams/:teamId/invites/:inviteId/revoke
    // ---------------------------------------------------------------------------
    app.post("/v1/collaboration-teams/:teamId/invites/:inviteId/revoke", {
        preHandler: requireAuth,
        handler: async (req, reply) => {
            const ctx = await requireWorkspaceMembership(req, reply);
            if (!ctx)
                return;
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
            }
            catch (err) {
                return handleServiceError(reply, err, req.id ?? null);
            }
        },
    });
    // ---------------------------------------------------------------------------
    // POST /v1/collaboration-team-invites/:token/accept
    // ---------------------------------------------------------------------------
    app.post("/v1/collaboration-team-invites/:token/accept", {
        preHandler: requireAuth,
        handler: async (req, reply) => {
            const userId = await getAuthUserId(req);
            if (!userId)
                return reply.code(401).send({ error: "auth_required" });
            try {
                // Phase 10 — pre-flight member-limit gate. No subscription
                // gate here: acceptance is by the invitee, not the team owner.
                // The owner's plan controls the per-team cap; the invitee can
                // be on any plan. We resolve the teamId from the raw token so
                // we can gate before the service performs the membership
                // write (which is what creates the cap-violating row). If the
                // invite is missing/expired/already-accepted the service
                // surfaces the canonical CollaborationTeamError; we do not
                // short-circuit that here.
                const inviteTokenHash = createHash("sha256")
                    .update(req.params.token)
                    .digest("hex");
                const inviteRow = await prisma.collaborationTeamInvite.findFirst({
                    where: { tokenHash: inviteTokenHash, status: "PENDING" },
                    select: { teamId: true },
                });
                if (inviteRow) {
                    await assertCollaborationTeamMemberLimit(inviteRow.teamId, 1);
                }
                const result = await acceptInvite({
                    rawToken: req.params.token,
                    actorUserId: userId,
                });
                await auditEvent({
                    userId,
                    workspaceId: "", // workspaceId resolved inside service
                    action: "collaboration_team.invite.accepted",
                    resourceType: "collaboration_team_member",
                    resourceId: result.memberId,
                    outcome: "success",
                    requestId: req.id ?? null,
                    metadata: { teamId: result.teamId },
                });
                return reply.send({
                    teamId: result.teamId,
                    memberId: result.memberId,
                });
            }
            catch (err) {
                return handleServiceError(reply, err, req.id ?? null);
            }
        },
    });
    // ---------------------------------------------------------------------------
    // GET /v1/collaboration-teams/:teamId/activity
    // ---------------------------------------------------------------------------
    app.get("/v1/collaboration-teams/:teamId/activity", {
        preHandler: requireAuth,
        handler: async (req, reply) => {
            const ctx = await requireWorkspaceMembership(req, reply);
            if (!ctx)
                return;
            try {
                const q = req.query ?? {};
                const limit = q.limit ? parseInt(q.limit, 10) : undefined;
                const cursor = q.cursor ?? null;
                const result = await listTeamActivity({
                    teamId: req.params.teamId,
                    actorUserId: ctx.userId,
                    limit,
                    cursor,
                });
                return reply.send(result);
            }
            catch (err) {
                return handleServiceError(reply, err, req.id ?? null);
            }
        },
    });
    // ---------------------------------------------------------------------------
    // GET /v1/collaboration-teams/:teamId/assignments
    // ---------------------------------------------------------------------------
    app.get("/v1/collaboration-teams/:teamId/assignments", {
        preHandler: requireAuth,
        handler: async (req, reply) => {
            const ctx = await requireWorkspaceMembership(req, reply);
            if (!ctx)
                return;
            try {
                const status = req.query?.status ?? null;
                const items = await listAssignments({
                    teamId: req.params.teamId,
                    actorUserId: ctx.userId,
                    status,
                });
                return reply.send({ assignments: items });
            }
            catch (err) {
                return handleServiceError(reply, err, req.id ?? null);
            }
        },
    });
    // ---------------------------------------------------------------------------
    // POST /v1/collaboration-teams/:teamId/assignments
    // ---------------------------------------------------------------------------
    app.post("/v1/collaboration-teams/:teamId/assignments", {
        preHandler: requireAuth,
        handler: async (req, reply) => {
            const ctx = await requireWorkspaceMembership(req, reply);
            if (!ctx)
                return;
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
            }
            catch (err) {
                return handleServiceError(reply, err, req.id ?? null);
            }
        },
    });
    // ---------------------------------------------------------------------------
    // PATCH /v1/collaboration-teams/:teamId/assignments/:assignmentId
    // ---------------------------------------------------------------------------
    app.patch("/v1/collaboration-teams/:teamId/assignments/:assignmentId", {
        preHandler: requireAuth,
        handler: async (req, reply) => {
            const ctx = await requireWorkspaceMembership(req, reply);
            if (!ctx)
                return;
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
            }
            catch (err) {
                return handleServiceError(reply, err, req.id ?? null);
            }
        },
    });
}
// -----------------------------------------------------------------------------
// Invite context resolver (helper for delivery wrappers)
// -----------------------------------------------------------------------------
async function getInviteContext(input) {
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
    const displayName = user?.displayName ||
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
