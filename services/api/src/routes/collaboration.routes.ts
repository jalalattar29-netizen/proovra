/**
 * Phase 16 — Enterprise collaboration routes.
 *
 *   GET   /v1/collaboration/threads?teamId&evidenceId&status...
 *   POST  /v1/collaboration/threads
 *   GET   /v1/collaboration/threads/:id
 *   POST  /v1/collaboration/threads/:id/resolve
 *   POST  /v1/collaboration/threads/:id/reopen
 *   POST  /v1/collaboration/threads/:id/assign
 *   POST  /v1/collaboration/threads/:id/escalate
 *   GET   /v1/collaboration/threads/:id/messages
 *   POST  /v1/collaboration/threads/:id/messages
 *   POST  /v1/collaboration/threads/:id/contributors  (RETIRED, 410 — 2026-09-16)
 *   DELETE /v1/collaboration/threads/:id/contributors/:sessionId (RETIRED, 410)
 *   POST|DELETE /v1/collaboration/threads/:id/subscribe (RETIRED, 410 — 2026-09-16)
 *
 * Every authenticated route requires `evidence_request.review`
 * (reviewer permission). Anti-enumeration: non-members + non-permitted
 * get 404, never 403. Service accounts are EXPLICITLY blocked from
 * posting human collaboration messages (route uses `requireAuth`,
 * never `requireApiKey`).
 *
 * Contributor write surface is intentionally NOT in this file — Phase
 * 16 ships internal-only routes. The deferred contributor wiring was
 * never built, and on 2026-09-16 the owner retired contributor thread
 * access and thread subscriptions instead: those four routes are typed
 * 410 tombstones that authenticate and do nothing else (no membership
 * check, no data read or written).
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  DISCUSSION_PARTICIPANT_ROLES,
  DISCUSSION_THREAD_KINDS,
  DISCUSSION_THREAD_STATUSES,
  DISCUSSION_THREAD_VISIBILITIES,
} from "@proovra/shared";

import prismaPkg from "@prisma/client";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { evaluateAuthorize } from "../middleware/authorize.js";
import { hiddenRecordIdsInWorkspace } from "../services/access/record-reach.js";
import { resolveEvidenceRecordAccess } from "../services/evidence/evidence-record-access.service.js";
import { invalidateOperationsSummary } from "../services/notifications/operations-summary-cache.js";
import {
  DiscussionError,
  assignDiscussionThread,
  createDiscussionThread,
  escalateDiscussionThread,
  getDiscussionThread,
  listDiscussionThreads,
  listMessagesForThread,
  postMessageWithMentionOutcome,
  projectDiscussionMessage,
  projectDiscussionThread,
  reopenDiscussionThread,
  resolveDiscussionThread,
} from "../services/collaboration/discussion.service.js";

const ParamsId = z.object({ id: z.string().uuid() });

/**
 * The canonical engine, not a local reading of the membership row: access
 * expiry, organization lifecycle, delegated capability and support-context
 * rules all live there, and this gate used to test `status` and the role table
 * only (AUTHZ-003), so an expired member and a member of a suspended
 * organization kept every thread.
 *
 * Anti-enumeration: every rejection path returns the same opaque 404, so a
 * caller never learns whether the team, the membership or the permission was
 * the gating factor. An authority outage stays a 503.
 */
async function requireReviewerMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  const outcome = await evaluateAuthorize(req, {
    teamId,
    permission: "evidence_request.review",
    antiEnumeration: true,
  });
  if (outcome.allowed) return { userId: outcome.actorUserId };
  if (outcome.httpStatus === 401) {
    reply.code(401).send({ error: { code: "unauthenticated" } });
    return null;
  }
  if (outcome.httpStatus === 503) {
    reply.code(503).send({ error: { code: "authorization_unavailable" } });
    return null;
  }
  reply.code(404).send({ error: { code: "not_found" } });
  return null;
}

/**
 * THE THREAD BELONGS TO ITS RECORD (EVID-002). A thread is a conversation about
 * one evidence record, so whoever cannot open the record cannot read, post into
 * or move the thread: the record authority, the same 404 as a missing thread.
 */
async function loadThreadInReach(threadId: string, teamId: string, userId: string) {
  const thread = await getDiscussionThread(threadId);
  if (!thread || thread.teamId !== teamId) return null;
  const record = await resolveEvidenceRecordAccess({
    userId,
    evidenceId: thread.evidenceId,
    permission: "evidence.read",
  });
  return record.allowed ? thread : null;
}

function discussionErrorToReply(err: unknown, reply: FastifyReply): void {
  if (err instanceof DiscussionError) {
    const status =
      err.code === "thread_not_found" ||
      err.code === "evidence_not_in_workspace" ||
      err.code === "user_not_found"
        ? 404
        : err.code === "invalid_status_transition" ||
            err.code === "thread_terminal"
          ? 409
          : err.code === "body_empty" ||
              err.code === "body_too_long" ||
              err.code === "assignee_not_eligible"
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

export async function collaborationRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // List + counts
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/collaboration/threads",
    { preHandler: requireAuth },
    async (req, reply) => {
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
      if (!ok) return;
      const hidden = await hiddenRecordIdsInWorkspace(query.teamId, ok.userId);
      const rows = await listDiscussionThreads({
        ...query,
        hiddenEvidenceIds: hidden.evidenceIds,
      });
      return reply.code(200).send({
        threads: rows.map(projectDiscussionThread),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Create + read
  // ---------------------------------------------------------------------------

  app.post(
    "/v1/collaboration/threads",
    { preHandler: requireAuth },
    async (req, reply) => {
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
      if (!ok) return;
      const record = await resolveEvidenceRecordAccess({
        userId: ok.userId,
        evidenceId: body.evidenceId,
        permission: "evidence.read",
      });
      if (!record.allowed) {
        return reply.code(404).send({
          error: { code: "evidence_not_in_workspace", details: null },
        });
      }
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
      } catch (err) {
        return discussionErrorToReply(err, reply);
      }
    },
  );

  app.get(
    "/v1/collaboration/threads/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = ParamsId.parse(req.params);
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireReviewerMember(req, reply, query.teamId);
      if (!ok) return;
      const thread = await loadThreadInReach(id, query.teamId, ok.userId);
      if (!thread) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send({
        thread: projectDiscussionThread(thread),
        resolutionNote: thread.resolutionNote, // internal; reviewer-only
        escalationReason: thread.escalationReason,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Status transitions
  // ---------------------------------------------------------------------------

  app.post(
    "/v1/collaboration/threads/:id/resolve",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          resolutionNote: z.string().max(1000).nullable().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireReviewerMember(req, reply, body.teamId);
      if (!ok) return;
      const thread = await loadThreadInReach(id, body.teamId, ok.userId);
      if (!thread) {
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
      } catch (err) {
        return discussionErrorToReply(err, reply);
      }
    },
  );

  app.post(
    "/v1/collaboration/threads/:id/reopen",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().min(1).max(400),
        })
        .parse(req.body ?? {});
      const ok = await requireReviewerMember(req, reply, body.teamId);
      if (!ok) return;
      const thread = await loadThreadInReach(id, body.teamId, ok.userId);
      if (!thread) {
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
      } catch (err) {
        return discussionErrorToReply(err, reply);
      }
    },
  );

  app.post(
    "/v1/collaboration/threads/:id/assign",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          assignedToUserId: z.string().uuid(),
        })
        .parse(req.body ?? {});
      const ok = await requireReviewerMember(req, reply, body.teamId);
      if (!ok) return;
      const thread = await loadThreadInReach(id, body.teamId, ok.userId);
      if (!thread) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      // D34 — the assignee must be an ACTIVE member of the thread's workspace.
      // Any uuid used to be accepted, so a thread could be handed to another
      // tenant's user (who was then written in as a RESOLVER participant) or to
      // a suspended/revoked member. Refused before anything is written; the
      // code is the one evidence-request assignment already uses.
      const assignee = await prisma.teamMember.findUnique({
        where: {
          teamId_userId: { teamId: thread.teamId, userId: body.assignedToUserId },
        },
        select: { status: true },
      });
      if (assignee?.status !== prismaPkg.TeamMemberStatus.ACTIVE) {
        return reply.code(400).send({
          error: {
            code: "assignee_not_workspace_member",
            message: "A thread can only be assigned to an active member of this workspace.",
          },
        });
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
      } catch (err) {
        return discussionErrorToReply(err, reply);
      }
    },
  );

  app.post(
    "/v1/collaboration/threads/:id/escalate",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().min(1).max(400),
        })
        .parse(req.body ?? {});
      const ok = await requireReviewerMember(req, reply, body.teamId);
      if (!ok) return;
      const thread = await loadThreadInReach(id, body.teamId, ok.userId);
      if (!thread) {
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
      } catch (err) {
        return discussionErrorToReply(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/collaboration/threads/:id/messages",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = ParamsId.parse(req.params);
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireReviewerMember(req, reply, query.teamId);
      if (!ok) return;
      const thread = await loadThreadInReach(id, query.teamId, ok.userId);
      if (!thread) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      const rows = await listMessagesForThread(id);
      return reply
        .code(200)
        .send({ messages: rows.map(projectDiscussionMessage) });
    },
  );

  app.post(
    "/v1/collaboration/threads/:id/messages",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          body: z.string().min(1).max(8 * 1024),
        })
        .parse(req.body ?? {});
      const ok = await requireReviewerMember(req, reply, body.teamId);
      if (!ok) return;
      const thread = await loadThreadInReach(id, body.teamId, ok.userId);
      if (!thread) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      try {
        const { message, unresolvedMentions } = await postMessageWithMentionOutcome({
          threadId: id,
          teamId: body.teamId,
          authorKind: "USER",
          authorUserId: ok.userId,
          body: body.body,
        });
        return reply
          .code(201)
          .send({ message: projectDiscussionMessage(message), unresolvedMentions });
      } catch (err) {
        return discussionErrorToReply(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // (RETIRED) Contributor access management
  //
  // OWNER DECISION (2026-09-16): contributor thread access is not offered.
  //
  // `POST .../contributors` wrote a CONTRIBUTOR `DiscussionParticipant` row and
  // `DELETE .../contributors/:sessionId` revoked it, but nothing ever let a
  // contributor use that row: the only message writer (`postMessage` above)
  // hard-codes a USER author, `canReadThread` has no caller, and the
  // contributor write surface this file promised was never wired (header
  // note). A grant that grants nothing is worse than no grant on an evidence
  // platform, so both routes answer a typed 410 — the same call 27984456 made
  // for collaboration-team guests. External parties are given access through
  // External Review. No web or mobile caller existed. Stored participant rows
  // are left untouched; nothing here reads or writes them any more.
  // ---------------------------------------------------------------------------

  const contributorsRetired = (reply: FastifyReply) =>
    reply.code(410).send({
      error: {
        code: "COLLABORATION_THREAD_CONTRIBUTORS_RETIRED",
        message:
          "Contributor access to discussion threads is not offered. A contributor grant never let anyone read or reply, so it has been retired; external parties are given access through External Review.",
      },
      canonical: "/v1/external-review/invitations",
    });

  app.post(
    "/v1/collaboration/threads/:id/contributors",
    { preHandler: requireAuth },
    async (_req, reply) => contributorsRetired(reply),
  );

  app.delete(
    "/v1/collaboration/threads/:id/contributors/:sessionId",
    { preHandler: requireAuth },
    async (_req, reply) => contributorsRetired(reply),
  );

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

  app.post(
    "/v1/collaboration/threads/:id/mark-mentions-read",
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = ParamsId.parse(req.params);
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireReviewerMember(req, reply, query.teamId);
      if (!ok) return;

      // Cross-workspace safety: ensure the thread actually belongs to
      // the workspace the caller is authenticated against.
      const thread = await loadThreadInReach(params.id, query.teamId, ok.userId);
      if (!thread) {
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
      // This is the caller's notification READ state too (the inbox ORs it
      // into the mention item), so the bell's cached count must reconcile now
      // rather than after its TTL.
      if (result.count > 0) await invalidateOperationsSummary(ok.userId);

      return reply.code(200).send({
        markedRead: result.count,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // (RETIRED) Phase G3 — Thread subscriptions.
  //
  //   POST   /v1/collaboration/threads/:id/subscribe
  //   DELETE /v1/collaboration/threads/:id/subscribe
  //
  // OWNER DECISION (2026-09-16): thread watching is not offered.
  //
  // These routes promised that a subscriber would "receive inbox +
  // notification updates", and wrote a WATCHER `DiscussionParticipant` row to
  // do it. Nothing ever read that row: no inbox source, notification fan-out
  // or worker consults WATCHER participants (the inbox's discussion sources
  // are mentions and assignment only), so subscribing changed nothing a person
  // would ever see. No web or mobile caller existed. Both routes now answer a
  // typed 410; people are told about a thread by being mentioned or assigned,
  // and those reach the Inbox. Stored participant rows are left untouched.
  // ---------------------------------------------------------------------------

  const subscriptionsRetired = (reply: FastifyReply) =>
    reply.code(410).send({
      error: {
        code: "COLLABORATION_THREAD_SUBSCRIPTIONS_RETIRED",
        message:
          "Watching a discussion thread is not offered. Subscribing never changed which notifications anyone received, so it has been retired; mentions and assignments reach your Inbox.",
      },
      canonical: "/v1/me/inbox",
    });

  app.post(
    "/v1/collaboration/threads/:id/subscribe",
    { preHandler: requireAuth },
    async (_req, reply) => subscriptionsRetired(reply),
  );

  app.delete(
    "/v1/collaboration/threads/:id/subscribe",
    { preHandler: requireAuth },
    async (_req, reply) => subscriptionsRetired(reply),
  );

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
