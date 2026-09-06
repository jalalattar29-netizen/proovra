/**
 * PROOVRA Phase 7 — Collaboration Completion API routes.
 *
 * Adds ~14 endpoints alongside the Phase 5 `/v1/collaboration-teams`
 * surface. Every mutation:
 *
 *   - resolves the active workspace via the Phase 3 canonical helper,
 *   - calls the canonical Phase 7 service module,
 *   - emits an audit event via the canonical `emitTenantAudit` facade.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
// Every surviving route here is GROUP-scoped, so each one binds through the
// team gate, which resolves and authorizes the containing workspace itself.
// The workspace-only entry point is no longer needed in this file.
import { authorizeCollaborationTeam } from "../services/collaboration-team/collaboration-authorization.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import { BillingLimitError } from "../services/collaboration-team/billing-guards.js";
import { CollaborationTeamError } from "../services/collaboration-team/collaboration-team.service.js";
import {
  completeAccessReview,
  createComment,
  decideAccessReviewItem,
  deleteComment,
  editComment,
  inviteGuest,
  listAccessReviews,
  listComments,
  listGuests,
  listTeamActivityFiltered,
  openAccessReview,
  revokeGuest,
} from "../services/collaboration-team/collaboration-completion.service.js";

function handleError(
  reply: FastifyReply,
  err: unknown,
  requestId: string | null,
): void {
  if (err instanceof CollaborationTeamError) {
    void reply.code(err.httpStatus).send({
      error: err.code,
      message: err.message,
      requestId,
    });
    return;
  }
  // PHASE 12 POINT 4 PASS C0 — commercial denials from the canonical
  // billing guards carry their own status + upgrade CTA. Without this
  // branch a plan/capacity denial surfaced as an opaque 500 and the
  // surface could not tell "not included" from "something broke".
  if (err instanceof BillingLimitError) {
    void reply.code(err.httpStatus).send({
      error: err.code,
      message: err.message,
      upgradeCta: err.upgradeCta,
      details: err.details,
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

async function audit(args: {
  userId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string | null;
  // PHASE 11 §3 Batch A — the authoritative workspace, from the caller's
  // already-resolved `ctx.workspaceId` (requireWorkspaceCtx), never a
  // raw request param.
  workspaceId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await emitTenantAudit({
    action: args.action,
    outcome: "success",
    sourceApp: "API",
    actorUserId: args.userId,
    workspaceId: args.workspaceId,
    resourceType: args.resourceType,
    resourceId: args.resourceId,
    correlationId: args.requestId,
    metadata: args.metadata ?? {},
  });
}

// =============================================================================
// Schemas
// =============================================================================

const CreateCommentBody = z.object({
  targetType: z.enum(["TEAM", "ASSIGNMENT", "CASE", "EVIDENCE", "REVIEW"]),
  targetId: z.string().uuid().optional().nullable(),
  body: z.string().min(1).max(4000),
});
const EditCommentBody = z.object({ body: z.string().min(1).max(4000) });

const GuestInviteBody = z.object({
  email: z.string().email().max(320),
  expiresInDays: z.number().int().min(1).max(90).optional(),
  scopeNote: z.string().max(400).optional().nullable(),
});

const OpenReviewBody = z.object({
  dueAtUtc: z
    .string()
    .datetime()
    .optional()
    .nullable()
    .transform((s) => (s ? new Date(s) : null)),
});

const DecideItemBody = z.object({
  decision: z.enum(["PENDING", "KEEP", "REMOVE", "CHANGE_ROLE"]),
  notes: z.string().max(600).optional().nullable(),
});

// =============================================================================
// Routes
// =============================================================================

export async function collaborationCompletionRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/comments",
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
          const q = (req.query as Record<string, string | undefined>) ?? {};
          const res = await listComments({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            targetType: q.targetType ?? null,
            targetId: q.targetId ?? null,
            limit: q.limit ? parseInt(q.limit, 10) : undefined,
          });
          return reply.send(res);
        } catch (err) {
          return handleError(reply, err, req.id ?? null);
        }
      },
    },
  );

  app.post<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/comments",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.message.post",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        const parsed = CreateCommentBody.safeParse(req.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        try {
          const result = await createComment({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            targetType: parsed.data.targetType,
            targetId: parsed.data.targetId ?? null,
            body: parsed.data.body,
          });
          await audit({
            userId: ctx.userId,
            action: "collaboration_team.comment.created",
            resourceType: "collaboration_team_comment",
            resourceId: result.id,
            requestId: req.id ?? null,
            workspaceId: ctx.workspaceId,
            metadata: {
              mentionCount: result.mentionCount,
              notificationCount: result.notificationCount,
            },
          });
          return reply.code(201).send({ comment: { id: result.id } });
        } catch (err) {
          return handleError(reply, err, req.id ?? null);
        }
      },
    },
  );

  app.patch<{ Params: { teamId: string; commentId: string } }>(
    "/v1/collaboration-teams/:teamId/comments/:commentId",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.message.post",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        const parsed = EditCommentBody.safeParse(req.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        try {
          await editComment({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            commentId: req.params.commentId,
            body: parsed.data.body,
          });
          await audit({
            userId: ctx.userId,
            action: "collaboration_team.comment.edited",
            resourceType: "collaboration_team_comment",
            resourceId: req.params.commentId,
            requestId: req.id ?? null,
            workspaceId: ctx.workspaceId,
          });
          return reply.send({ ok: true });
        } catch (err) {
          return handleError(reply, err, req.id ?? null);
        }
      },
    },
  );

  app.delete<{ Params: { teamId: string; commentId: string } }>(
    "/v1/collaboration-teams/:teamId/comments/:commentId",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.message.post",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          await deleteComment({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            commentId: req.params.commentId,
          });
          await audit({
            userId: ctx.userId,
            action: "collaboration_team.comment.deleted",
            resourceType: "collaboration_team_comment",
            resourceId: req.params.commentId,
            requestId: req.id ?? null,
            workspaceId: ctx.workspaceId,
          });
          return reply.send({ ok: true });
        } catch (err) {
          return handleError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // Notifications (per-viewer inbox)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // (RETIRED) Per-group notification list + read-state
  //
  // WORKSPACE AND COLLABORATION ARCHITECTURE CLOSURE (2026-09-06) — the INBOX
  // is the one place a person reads what happened to them.
  //
  // These three routes were a second surface over the same rows. The canonical
  // inbox (`me-inbox.routes.ts`) already reads `CollaborationTeamNotification`
  // as one of its sources, gated on the caller still belonging to the emitting
  // workspace, and marks the SAME `readAt` — so "read here or read there"
  // pointed at one column while presenting as two inboxes with two unread
  // counts. Retiring the duplicate is the whole point: nothing moved, and the
  // reader that survives is the one a person actually opens.
  //
  // The rows, the emitter and the read-state are untouched. Only the second
  // door is closed, and it answers with a typed 410 naming the first rather
  // than a 404, because a stale client deserves to be told where its data went.
  // ---------------------------------------------------------------------------

  const notificationsRetired = (reply: FastifyReply) =>
    reply.code(410).send({
      error: { code: "COLLABORATION_TEAM_NOTIFICATIONS_RETIRED" },
      message:
        "Team notifications are in your Inbox. This surface was a second view of the same rows and has been retired.",
      canonical: "/v1/me/inbox",
    });

  app.get("/v1/collaboration-team-notifications", {
    preHandler: requireAuth,
    handler: async (_req, reply) => notificationsRetired(reply),
  });

  app.post<{ Params: { notificationId: string } }>(
    "/v1/collaboration-team-notifications/:notificationId/read",
    {
      preHandler: requireAuth,
      handler: async (_req, reply) => notificationsRetired(reply),
    },
  );

  app.post("/v1/collaboration-team-notifications/read-all", {
    preHandler: requireAuth,
    handler: async (_req, reply) => notificationsRetired(reply),
  });

  // ---------------------------------------------------------------------------
  // (RETIRED) Per-group notification preferences
  //
  // A third preference store, with no stated precedence against the workspace
  // and organization notification policy it sat under — so a person could set
  // "mute" in one place and keep receiving, and no surface could say which
  // answer won. Notification preferences belong to Settings, where there is
  // one of them.
  //
  // The stored rows are left in place and are still read by the fan-out, so
  // nobody's existing choice is silently reversed by this retirement.
  // ---------------------------------------------------------------------------

  const preferencesRetired = (reply: FastifyReply) =>
    reply.code(410).send({
      error: { code: "COLLABORATION_TEAM_PREFERENCES_RETIRED" },
      message:
        "Notification preferences live in Settings. Per-team preferences were a third store with no stated precedence and have been retired.",
      canonical: "/settings/notifications",
    });

  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/notification-preferences",
    {
      preHandler: requireAuth,
      handler: async (_req, reply) => preferencesRetired(reply),
    },
  );

  app.patch<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/notification-preferences",
    {
      preHandler: requireAuth,
      handler: async (_req, reply) => preferencesRetired(reply),
    },
  );


  // ---------------------------------------------------------------------------
  // Guests
  // ---------------------------------------------------------------------------

  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/guests",
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
          const items = await listGuests({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
          });
          return reply.send({ guests: items });
        } catch (err) {
          return handleError(reply, err, req.id ?? null);
        }
      },
    },
  );

  app.post<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/guests/invite",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.contributor.access.manage",
          groupPermission: "team.member.invite",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        const parsed = GuestInviteBody.safeParse(req.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        try {
          const result = await inviteGuest({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            email: parsed.data.email,
            expiresInDays: parsed.data.expiresInDays,
            scopeNote: parsed.data.scopeNote,
          });
          await audit({
            userId: ctx.userId,
            action: "collaboration_team.guest.invited",
            resourceType: "collaboration_team_guest",
            resourceId: result.id,
            requestId: req.id ?? null,
            workspaceId: ctx.workspaceId,
          });
          return reply.code(201).send({ guest: { id: result.id } });
        } catch (err) {
          return handleError(reply, err, req.id ?? null);
        }
      },
    },
  );

  app.patch<{ Params: { teamId: string; guestId: string } }>(
    "/v1/collaboration-teams/:teamId/guests/:guestId/revoke",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.contributor.access.manage",
          groupPermission: "team.member.invite",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          await revokeGuest({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            guestId: req.params.guestId,
          });
          await audit({
            userId: ctx.userId,
            action: "collaboration_team.guest.revoked",
            resourceType: "collaboration_team_guest",
            resourceId: req.params.guestId,
            requestId: req.id ?? null,
            workspaceId: ctx.workspaceId,
          });
          return reply.send({ ok: true });
        } catch (err) {
          return handleError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // Access reviews
  // ---------------------------------------------------------------------------

  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/access-review",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "identity.access_review.read",
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          const reviews = await listAccessReviews({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
          });
          return reply.send({ reviews });
        } catch (err) {
          return handleError(reply, err, req.id ?? null);
        }
      },
    },
  );

  app.post<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/access-review",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "identity.access_review.action",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        const parsed = OpenReviewBody.safeParse(req.body ?? {});
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        try {
          const result = await openAccessReview({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            dueAtUtc: parsed.data.dueAtUtc ?? null,
          });
          await audit({
            userId: ctx.userId,
            action: "collaboration_team.access_review.opened",
            resourceType: "collaboration_team_access_review",
            resourceId: result.id,
            requestId: req.id ?? null,
            workspaceId: ctx.workspaceId,
            metadata: { itemCount: result.itemCount },
          });
          return reply.code(201).send({ review: result });
        } catch (err) {
          return handleError(reply, err, req.id ?? null);
        }
      },
    },
  );

  app.patch<{ Params: { teamId: string; itemId: string } }>(
    "/v1/collaboration-teams/:teamId/access-review/items/:itemId",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "identity.access_review.action",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        const parsed = DecideItemBody.safeParse(req.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        try {
          await decideAccessReviewItem({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            itemId: req.params.itemId,
            decision: parsed.data.decision,
            notes: parsed.data.notes,
          });
          await audit({
            userId: ctx.userId,
            action: "collaboration_team.access_review.item_decided",
            resourceType: "collaboration_team_access_review_item",
            resourceId: req.params.itemId,
            requestId: req.id ?? null,
            workspaceId: ctx.workspaceId,
            metadata: { decision: parsed.data.decision },
          });
          return reply.send({ ok: true });
        } catch (err) {
          return handleError(reply, err, req.id ?? null);
        }
      },
    },
  );

  app.post<{ Params: { teamId: string; reviewId: string } }>(
    "/v1/collaboration-teams/:teamId/access-review/:reviewId/complete",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "identity.access_review.action",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          await completeAccessReview({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            reviewId: req.params.reviewId,
          });
          await audit({
            userId: ctx.userId,
            action: "collaboration_team.access_review.completed",
            resourceType: "collaboration_team_access_review",
            resourceId: req.params.reviewId,
            requestId: req.id ?? null,
            workspaceId: ctx.workspaceId,
          });
          return reply.send({ ok: true });
        } catch (err) {
          return handleError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // Activity (filtered + enriched) — overrides Phase 5 listActivity for
  // the same path. Registered at a distinct subpath to avoid collision.
  // ---------------------------------------------------------------------------

  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/activity/v2",
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
          const res = await listTeamActivityFiltered({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            eventType: q.eventType ?? null,
            actorFilter: q.actor ?? null,
            sinceUtc: q.since ? new Date(q.since) : null,
            untilUtc: q.until ? new Date(q.until) : null,
            limit: q.limit ? parseInt(q.limit, 10) : undefined,
            cursor: q.cursor ?? null,
          });
          return reply.send(res);
        } catch (err) {
          return handleError(reply, err, req.id ?? null);
        }
      },
    },
  );
}
