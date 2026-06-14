/**
 * Phase 16 — Enterprise collaboration routes.
 *
 *   GET   /v1/collaboration/threads?teamId&evidenceId&status...
 *   GET   /v1/collaboration/threads/counts?teamId
 *   POST  /v1/collaboration/threads
 *   GET   /v1/collaboration/threads/:id
 *   POST  /v1/collaboration/threads/:id/resolve
 *   POST  /v1/collaboration/threads/:id/reopen
 *   POST  /v1/collaboration/threads/:id/assign
 *   POST  /v1/collaboration/threads/:id/escalate
 *   GET   /v1/collaboration/threads/:id/messages
 *   POST  /v1/collaboration/threads/:id/messages
 *   POST  /v1/collaboration/threads/:id/contributors  (grant access)
 *   DELETE /v1/collaboration/threads/:id/contributors/:sessionId (revoke)
 *
 * Every authenticated route requires `evidence_request.review`
 * (reviewer permission). Anti-enumeration: non-members + non-permitted
 * get 404, never 403. Service accounts are EXPLICITLY blocked from
 * posting human collaboration messages (route uses `requireAuth`,
 * never `requireApiKey`).
 *
 * Contributor write surface is intentionally NOT in this file — Phase
 * 16 ships internal-only routes. Contributor write integration ties
 * into the existing external intake flow (deferred wiring).
 */
import prismaPkg from "@prisma/client";
import { z } from "zod";
import { DISCUSSION_PARTICIPANT_ROLES, DISCUSSION_THREAD_KINDS, DISCUSSION_THREAD_STATUSES, DISCUSSION_THREAD_VISIBILITIES, } from "@proovra/shared";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../services/governance.service.js";
import { DiscussionError, assignDiscussionThread, countDiscussionThreads, createDiscussionThread, escalateDiscussionThread, getDiscussionThread, grantContributorAccess, listDiscussionThreads, listMessagesForThread, postMessage, projectDiscussionMessage, projectDiscussionThread, reopenDiscussionThread, resolveDiscussionThread, revokeContributorAccess, } from "../services/collaboration/discussion.service.js";
const ParamsId = z.object({ id: z.string().uuid() });
async function requireReviewerMember(req, reply, teamId) {
    const userId = getAuthUserId(req);
    const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId } },
    });
    // Phase DISCUSSION-CAPABILITY-FIX (backend-parity) — reject
    // SUSPENDED / REVOKED memberships even when the role still carries
    // the reviewer permission. Anti-enumeration: every rejection path
    // returns the same opaque 404.
    const isActiveMember = membership !== null &&
        membership.status === prismaPkg.TeamMemberStatus.ACTIVE;
    if (!isActiveMember) {
        reply.code(404).send({ error: { code: "not_found" } });
        return null;
    }
    const perm = requirePermission(membership.role, "evidence_request.review");
    if (!perm.allowed) {
        reply.code(404).send({ error: { code: "not_found" } });
        return null;
    }
    return { userId, role: membership.role };
}
function discussionErrorToReply(err, reply) {
    if (err instanceof DiscussionError) {
        const status = err.code === "thread_not_found" ||
            err.code === "evidence_not_in_workspace" ||
            err.code === "user_not_found"
            ? 404
            : err.code === "invalid_status_transition" ||
                err.code === "thread_terminal"
                ? 409
                : err.code === "body_empty" || err.code === "body_too_long"
                    ? 422
                    : err.code === "internal_only" ||
                        err.code === "contributor_revoked" ||
                        err.code === "not_participant" ||
                        err.code === "service_account_forbidden"
                        ? 403
                        : 400;
        reply.code(status).send({ error: { code: err.code, details: err.details ?? null } });
        return;
    }
    reply.code(500).send({ error: { code: "internal_error" } });
}
export async function collaborationRoutes(app) {
    // ---------------------------------------------------------------------------
    // List + counts
    // ---------------------------------------------------------------------------
    app.get("/v1/collaboration/threads", { preHandler: requireAuth }, async (req, reply) => {
        const query = z
            .object({
            teamId: z.string().uuid(),
            evidenceId: z.string().uuid().optional(),
            status: z.enum(DISCUSSION_THREAD_STATUSES).optional(),
            visibility: z.enum(DISCUSSION_THREAD_VISIBILITIES).optional(),
            assignedToUserId: z.string().uuid().optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
        })
            .parse(req.query ?? {});
        const ok = await requireReviewerMember(req, reply, query.teamId);
        if (!ok)
            return;
        const rows = await listDiscussionThreads(query);
        return reply.code(200).send({
            threads: rows.map(projectDiscussionThread),
        });
    });
    app.get("/v1/collaboration/threads/counts", { preHandler: requireAuth }, async (req, reply) => {
        const query = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ok = await requireReviewerMember(req, reply, query.teamId);
        if (!ok)
            return;
        const counts = await countDiscussionThreads({
            teamId: query.teamId,
            meUserId: ok.userId,
        });
        return reply.code(200).send({ counts });
    });
    // ---------------------------------------------------------------------------
    // Create + read
    // ---------------------------------------------------------------------------
    app.post("/v1/collaboration/threads", { preHandler: requireAuth }, async (req, reply) => {
        const body = z
            .object({
            teamId: z.string().uuid(),
            evidenceId: z.string().uuid(),
            evidenceRequestId: z.string().uuid().nullable().optional(),
            kind: z.enum(DISCUSSION_THREAD_KINDS),
            visibility: z.enum(DISCUSSION_THREAD_VISIBILITIES),
            title: z.string().min(1).max(180),
            initialBody: z.string().max(8 * 1024).nullable().optional(),
        })
            .parse(req.body ?? {});
        const ok = await requireReviewerMember(req, reply, body.teamId);
        if (!ok)
            return;
        try {
            const thread = await createDiscussionThread({
                teamId: body.teamId,
                evidenceId: body.evidenceId,
                evidenceRequestId: body.evidenceRequestId ?? null,
                kind: body.kind,
                visibility: body.visibility,
                title: body.title,
                createdByUserId: ok.userId,
                initialBody: body.initialBody ?? null,
            });
            return reply
                .code(201)
                .send({ thread: projectDiscussionThread(thread) });
        }
        catch (err) {
            return discussionErrorToReply(err, reply);
        }
    });
    app.get("/v1/collaboration/threads/:id", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const query = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ok = await requireReviewerMember(req, reply, query.teamId);
        if (!ok)
            return;
        const thread = await getDiscussionThread(id);
        if (!thread || thread.teamId !== query.teamId) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        return reply.code(200).send({
            thread: projectDiscussionThread(thread),
            resolutionNote: thread.resolutionNote, // internal; reviewer-only
            escalationReason: thread.escalationReason,
        });
    });
    // ---------------------------------------------------------------------------
    // Status transitions
    // ---------------------------------------------------------------------------
    app.post("/v1/collaboration/threads/:id/resolve", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            resolutionNote: z.string().max(1000).nullable().optional(),
        })
            .parse(req.body ?? {});
        const ok = await requireReviewerMember(req, reply, body.teamId);
        if (!ok)
            return;
        const thread = await getDiscussionThread(id);
        if (!thread || thread.teamId !== body.teamId) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        try {
            const updated = await resolveDiscussionThread({
                threadId: id,
                actorUserId: ok.userId,
                resolutionNote: body.resolutionNote ?? null,
            });
            return reply
                .code(200)
                .send({ thread: projectDiscussionThread(updated) });
        }
        catch (err) {
            return discussionErrorToReply(err, reply);
        }
    });
    app.post("/v1/collaboration/threads/:id/reopen", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            reason: z.string().min(1).max(400),
        })
            .parse(req.body ?? {});
        const ok = await requireReviewerMember(req, reply, body.teamId);
        if (!ok)
            return;
        const thread = await getDiscussionThread(id);
        if (!thread || thread.teamId !== body.teamId) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        try {
            const updated = await reopenDiscussionThread({
                threadId: id,
                actorUserId: ok.userId,
                reason: body.reason,
            });
            return reply
                .code(200)
                .send({ thread: projectDiscussionThread(updated) });
        }
        catch (err) {
            return discussionErrorToReply(err, reply);
        }
    });
    app.post("/v1/collaboration/threads/:id/assign", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            assignedToUserId: z.string().uuid(),
        })
            .parse(req.body ?? {});
        const ok = await requireReviewerMember(req, reply, body.teamId);
        if (!ok)
            return;
        const thread = await getDiscussionThread(id);
        if (!thread || thread.teamId !== body.teamId) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        try {
            const updated = await assignDiscussionThread({
                threadId: id,
                actorUserId: ok.userId,
                assignedToUserId: body.assignedToUserId,
            });
            return reply
                .code(200)
                .send({ thread: projectDiscussionThread(updated) });
        }
        catch (err) {
            return discussionErrorToReply(err, reply);
        }
    });
    app.post("/v1/collaboration/threads/:id/escalate", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            reason: z.string().min(1).max(400),
        })
            .parse(req.body ?? {});
        const ok = await requireReviewerMember(req, reply, body.teamId);
        if (!ok)
            return;
        const thread = await getDiscussionThread(id);
        if (!thread || thread.teamId !== body.teamId) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        try {
            const updated = await escalateDiscussionThread({
                threadId: id,
                actorUserId: ok.userId,
                reason: body.reason,
            });
            return reply
                .code(200)
                .send({ thread: projectDiscussionThread(updated) });
        }
        catch (err) {
            return discussionErrorToReply(err, reply);
        }
    });
    // ---------------------------------------------------------------------------
    // Messages
    // ---------------------------------------------------------------------------
    app.get("/v1/collaboration/threads/:id/messages", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const query = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ok = await requireReviewerMember(req, reply, query.teamId);
        if (!ok)
            return;
        const thread = await getDiscussionThread(id);
        if (!thread || thread.teamId !== query.teamId) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        const rows = await listMessagesForThread(id);
        return reply
            .code(200)
            .send({ messages: rows.map(projectDiscussionMessage) });
    });
    app.post("/v1/collaboration/threads/:id/messages", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            body: z.string().min(1).max(8 * 1024),
        })
            .parse(req.body ?? {});
        const ok = await requireReviewerMember(req, reply, body.teamId);
        if (!ok)
            return;
        try {
            const message = await postMessage({
                threadId: id,
                teamId: body.teamId,
                authorKind: "USER",
                authorUserId: ok.userId,
                body: body.body,
            });
            return reply
                .code(201)
                .send({ message: projectDiscussionMessage(message) });
        }
        catch (err) {
            return discussionErrorToReply(err, reply);
        }
    });
    // ---------------------------------------------------------------------------
    // Contributor access management
    // ---------------------------------------------------------------------------
    app.post("/v1/collaboration/threads/:id/contributors", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            intakeSessionId: z.string().uuid(),
            contributorLabel: z.string().max(180).nullable().optional(),
        })
            .parse(req.body ?? {});
        const ok = await requireReviewerMember(req, reply, body.teamId);
        if (!ok)
            return;
        try {
            const row = await grantContributorAccess({
                threadId: id,
                teamId: body.teamId,
                intakeSessionId: body.intakeSessionId,
                contributorLabel: body.contributorLabel ?? null,
                actorUserId: ok.userId,
            });
            return reply.code(201).send({ participantId: row.id });
        }
        catch (err) {
            return discussionErrorToReply(err, reply);
        }
    });
    app.delete("/v1/collaboration/threads/:id/contributors/:sessionId", { preHandler: requireAuth }, async (req, reply) => {
        const params = z
            .object({
            id: z.string().uuid(),
            sessionId: z.string().uuid(),
        })
            .parse(req.params);
        const query = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ok = await requireReviewerMember(req, reply, query.teamId);
        if (!ok)
            return;
        try {
            const row = await revokeContributorAccess({
                threadId: params.id,
                teamId: query.teamId,
                intakeSessionId: params.sessionId,
                actorUserId: ok.userId,
            });
            if (!row) {
                return reply.code(404).send({ error: { code: "not_found" } });
            }
            return reply.code(200).send({ revoked: true });
        }
        catch (err) {
            return discussionErrorToReply(err, reply);
        }
    });
    // ---------------------------------------------------------------------------
    // Phase C2 — mark caller's mentions in a thread as read.
    //
    // POST /v1/collaboration/threads/:id/mark-mentions-read
    //
    // Idempotent: sets DiscussionMention.notifiedAtUtc = now() for every
    // mention in this thread that names the caller and is still unread
    // (notifiedAtUtc IS NULL). Used by the Discussion tab to clear the
    // caller's unread badge when they open the thread, and by the inbox
    // page when the user clicks through.
    //
    // Anti-enumeration: thread access is gated by the same team
    // membership + reviewer permission as the rest of the collaboration
    // surface, so a non-member sees 404.
    //
    // Workspace isolation: the update is constrained to
    // `mentionedUserId = caller AND threadId = :id`. The mention row
    // already carries `teamId`, but the caller's reviewer-member check
    // on `query.teamId` plus the thread's `teamId` invariant means a
    // mention created in a different workspace cannot be marked read
    // through a workspace the caller can reach.
    // ---------------------------------------------------------------------------
    app.post("/v1/collaboration/threads/:id/mark-mentions-read", { preHandler: requireAuth }, async (req, reply) => {
        const params = ParamsId.parse(req.params);
        const query = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ok = await requireReviewerMember(req, reply, query.teamId);
        if (!ok)
            return;
        // Cross-workspace safety: ensure the thread actually belongs to
        // the workspace the caller is authenticated against.
        const thread = await prisma.discussionThread.findUnique({
            where: { id: params.id },
            select: { id: true, teamId: true },
        });
        if (!thread || thread.teamId !== query.teamId) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        const result = await prisma.discussionMention.updateMany({
            where: {
                threadId: params.id,
                mentionedUserId: ok.userId,
                notifiedAtUtc: null,
            },
            data: { notifiedAtUtc: new Date() },
        });
        return reply.code(200).send({
            markedRead: result.count,
        });
    });
    // ---------------------------------------------------------------------------
    // Phase G3 — Thread subscriptions.
    //
    //   POST   /v1/collaboration/threads/:id/subscribe
    //   DELETE /v1/collaboration/threads/:id/subscribe
    //
    // Reviewers can subscribe themselves to a discussion thread to
    // receive inbox + notification updates without being explicitly
    // mentioned, assigned, or made the resolver. Subscription is
    // modelled on the existing Phase 16 `DiscussionParticipant` model
    // with `role = WATCHER` — no new schema is introduced.
    //
    // Workspace + access discipline mirror the rest of the
    // collaboration surface: `requireReviewerMember` 404s non-members
    // (anti-enumeration); thread.teamId is cross-checked against the
    // caller's workspace claim.
    //
    // Idempotent: subscribing twice is a no-op (upsert); unsubscribing
    // an already-revoked subscription returns 200 with `revoked: false`.
    // ---------------------------------------------------------------------------
    app.post("/v1/collaboration/threads/:id/subscribe", { preHandler: requireAuth }, async (req, reply) => {
        const params = ParamsId.parse(req.params);
        const query = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ok = await requireReviewerMember(req, reply, query.teamId);
        if (!ok)
            return;
        const thread = await prisma.discussionThread.findUnique({
            where: { id: params.id },
            select: { id: true, teamId: true },
        });
        if (!thread || thread.teamId !== query.teamId) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        const existing = await prisma.discussionParticipant.findUnique({
            where: { threadId_userId: { threadId: params.id, userId: ok.userId } },
        });
        if (existing) {
            if (existing.revokedAtUtc) {
                // Un-revoke and bump the role to WATCHER if it was something else.
                await prisma.discussionParticipant.update({
                    where: { id: existing.id },
                    data: {
                        revokedAtUtc: null,
                        revokedByUserId: null,
                        role: existing.role === "RESOLVER" ? "RESOLVER" : "WATCHER",
                    },
                });
            }
            return reply.code(200).send({ subscribed: true, already: true });
        }
        await prisma.discussionParticipant.create({
            data: {
                threadId: params.id,
                teamId: query.teamId,
                userId: ok.userId,
                role: "WATCHER",
                addedByUserId: ok.userId,
            },
        });
        return reply.code(201).send({ subscribed: true, already: false });
    });
    app.delete("/v1/collaboration/threads/:id/subscribe", { preHandler: requireAuth }, async (req, reply) => {
        const params = ParamsId.parse(req.params);
        const query = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ok = await requireReviewerMember(req, reply, query.teamId);
        if (!ok)
            return;
        const thread = await prisma.discussionThread.findUnique({
            where: { id: params.id },
            select: { id: true, teamId: true },
        });
        if (!thread || thread.teamId !== query.teamId) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        const existing = await prisma.discussionParticipant.findUnique({
            where: { threadId_userId: { threadId: params.id, userId: ok.userId } },
        });
        if (!existing || existing.revokedAtUtc) {
            return reply.code(200).send({ revoked: false });
        }
        // RESOLVER cannot self-unsubscribe — that would orphan the
        // thread. Only revoke WATCHER / PARTICIPANT roles via this
        // endpoint; resolver removal goes through the existing assign
        // flow.
        if (existing.role === "RESOLVER") {
            return reply.code(409).send({
                error: { code: "resolver_cannot_unsubscribe" },
            });
        }
        await prisma.discussionParticipant.update({
            where: { id: existing.id },
            data: {
                revokedAtUtc: new Date(),
                revokedByUserId: ok.userId,
            },
        });
        return reply.code(200).send({ revoked: true });
    });
    // ---------------------------------------------------------------------------
    // Catalogs
    // ---------------------------------------------------------------------------
    app.get("/v1/collaboration/catalogs", async (_req, reply) => {
        return reply.code(200).send({
            threadKinds: DISCUSSION_THREAD_KINDS,
            threadStatuses: DISCUSSION_THREAD_STATUSES,
            threadVisibilities: DISCUSSION_THREAD_VISIBILITIES,
            participantRoles: DISCUSSION_PARTICIPANT_ROLES,
        });
    });
}
