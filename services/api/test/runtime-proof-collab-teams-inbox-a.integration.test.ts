/**
 * BATCH K5 (part A) — runtime proof for the collaboration, discussion-thread,
 * inbox, notification-schedule and legacy workspace-administration (/v1/teams/*)
 * mutations the UI sweep could not drive to their success branch.
 *
 * Every action is proven three ways against a disposable PostgreSQL 16:
 *   1. the authorized SUCCESS branch, with the payload the product consumer
 *      sends, re-reading the exact row/column the action exists to change;
 *   2. the AUDIT record where the route writes one;
 *   3. an EXPECTED REFUSAL with its bounded status/code and no durable effect.
 *
 * Payloads come from the real consumers:
 *   - apps/web/lib/api/collaboration-teams.ts         (createTeam, deleteTeam, removeMember)
 *   - apps/web/lib/api/collaboration-completion.ts    (deleteComment)
 *   - apps/web/app/(app)/evidence/[id]/components/EvidenceDiscussionPanel.tsx
 *   - apps/web/app/(app)/inbox/page.tsx + components/app-shell-v2/NotificationBell.tsx
 *   - apps/web/components/notifications/NotificationPreferencesPanel.tsx
 *
 * A body-less mutation is sent WITHOUT a content-type, exactly as `apiFetch`
 * does (it only sets `content-type` when a body is present).
 *
 * Some sinks are written fire-and-forget by the product (`auditTeamAction` is
 * `void emitTenantAudit(...)`,
 * `safeEmitSecurityEvent`, the discussion reviewer-audit). Those rows are read
 * with `expect.poll` — a bounded wait for a write the product has already
 * dispatched, never a retry of the action under test.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];

const WS = "x-proovra-workspace-id";

describe("K5-A — collaboration, threads, inbox, schedule, workspace admin (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let svc: typeof import("../src/services/collaboration-team/collaboration-team.service.js");
  let completion: typeof import("../src/services/collaboration-team/collaboration-completion.service.js");
  let orgA: string;
  const disposableUsers: string[] = [];

  const call = (opts: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    token?: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) =>
    h.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });

  const tag = () => randomUUID().slice(0, 8);

  const auditRow = (action: string, resourceId: string) =>
    prisma.adminAuditLog.findFirst({
      where: { action, resourceId },
      orderBy: { createdAt: "desc" },
    });

  /** A persona created for one test, with the current legal acceptances. */
  async function disposableUser(label: string): Promise<{ id: string; email: string }> {
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    const email = `k5-${label}-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "K5", lastName: label, provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "integration-harness",
      })),
    });
    disposableUsers.push(user.id);
    return { id: user.id, email };
  }

  /** `auditTeamAction` is fire-and-forget (`void emitTenantAudit(...)`). */
  const tenantAudit = (action: string, resourceId: string) =>
    expect.poll(
      () =>
        prisma.adminAuditLog.findFirst({
          where: { action, resourceId, outcome: "success" },
          orderBy: { createdAt: "desc" },
          select: { userId: true, workspaceId: true, outcome: true, resourceType: true, metadata: true },
        }),
      { timeout: 10_000, interval: 25 },
    );

  async function newGroup(workspaceId: string, leadUserId: string) {
    return svc.createCollaborationTeam({
      workspaceId,
      actorUserId: leadUserId,
      name: `k5 group ${tag()}`,
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    svc = await import("../src/services/collaboration-team/collaboration-team.service.js");
    completion = await import(
      "../src/services/collaboration-team/collaboration-completion.service.js"
    );
    orgA = (
      await prisma.team.findUniqueOrThrow({
        where: { id: h.fixtures.teamA.teamId },
        select: { organizationId: true },
      })
    ).organizationId;
    // TEAM includes collaboration groups; the harness default (FREE) holds none,
    // so without this every group assertion would pass at the commercial gate.
    await prisma.team.updateMany({
      where: { id: { in: [h.fixtures.teamA.teamId, h.fixtures.teamB.teamId] } },
      data: { billingPlan: "TEAM", billingStatus: "ACTIVE" },
    });
  }, 900_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { id: { in: disposableUsers } } }).catch(() => undefined);
    }
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // /v1/collaboration-teams
  // ===========================================================================

  describe("collaboration teams", () => {
    it("POST /v1/collaboration-teams — owner creates a group in the NAMED workspace; a viewer is refused 403, a foreign owner is concealed", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const name = `k5 create ${tag()}`;

      const viewer = await call({
        method: "POST",
        url: "/v1/collaboration-teams",
        token: a.viewerToken,
        headers: { [WS]: a.teamId },
        payload: { name, description: "viewer attempt", teamType: "INVESTIGATION" },
      });
      // An ACTIVE member without the capability is told the truth (403);
      // only a caller outside the workspace is concealed.
      expect(viewer.statusCode).toBe(403);
      expect((viewer.json() as { error: { code: string } }).error.code).toBe("permission_denied");

      const foreign = await call({
        method: "POST",
        url: "/v1/collaboration-teams",
        token: b.ownerToken,
        headers: { [WS]: a.teamId },
        payload: { name, description: "foreign attempt", teamType: "INVESTIGATION" },
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: { code: "not_found" } });
      expect(await prisma.collaborationTeam.count({ where: { name } })).toBe(0);

      const res = await call({
        method: "POST",
        url: "/v1/collaboration-teams",
        token: a.ownerToken,
        headers: { [WS]: a.teamId },
        payload: { name, description: "K5 runtime proof", teamType: "INVESTIGATION" },
      });
      expect(res.statusCode, res.body).toBe(201);
      const id = (res.json() as { team: { id: string } }).team.id;

      const row = await prisma.collaborationTeam.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        workspaceId: a.teamId,
        name,
        description: "K5 runtime proof",
        teamType: "INVESTIGATION",
        status: "ACTIVE",
        createdByUserId: a.ownerUserId,
      });
      const lead = await prisma.collaborationTeamMember.findFirstOrThrow({
        where: { teamId: id, userId: a.ownerUserId },
      });
      expect(lead).toMatchObject({ role: "LEAD", status: "ACTIVE" });

      const audit = await auditRow("collaboration_team.created", id);
      expect(audit).toMatchObject({
        userId: a.ownerUserId,
        workspaceId: a.teamId,
        resourceType: "collaboration_team",
        outcome: "success",
      });
    });

    it("DELETE /v1/collaboration-teams/:teamId — the LEAD deletes a history-free group; a group MEMBER and a foreign owner are concealed", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const group = await newGroup(a.teamId, a.ownerUserId);
      await svc.addExistingMember({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        userIdToAdd: a.memberUserId,
        role: "MEMBER",
      });

      const member = await call({
        method: "DELETE",
        url: `/v1/collaboration-teams/${group.id}`,
        token: a.memberToken,
        headers: { [WS]: a.teamId },
      });
      expect(member.statusCode).toBe(404);
      expect(member.json()).toEqual({ error: { code: "not_found" } });

      const foreign = await call({
        method: "DELETE",
        url: `/v1/collaboration-teams/${group.id}`,
        token: b.ownerToken,
        headers: { [WS]: b.teamId },
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual(member.json());
      expect(await prisma.collaborationTeam.findUnique({ where: { id: group.id } })).not.toBeNull();

      const res = await call({
        method: "DELETE",
        url: `/v1/collaboration-teams/${group.id}`,
        token: a.ownerToken,
        headers: { [WS]: a.teamId },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(await prisma.collaborationTeam.findUnique({ where: { id: group.id } })).toBeNull();
      expect(await prisma.collaborationTeamMember.count({ where: { teamId: group.id } })).toBe(0);

      const audit = await auditRow("collaboration_team.deleted", group.id);
      expect(audit).toMatchObject({
        userId: a.ownerUserId,
        workspaceId: a.teamId,
        resourceType: "collaboration_team",
        outcome: "success",
      });
      // D19 — one deletion, one record.
      expect(
        await prisma.adminAuditLog.count({
          where: { action: "collaboration_team.deleted", resourceId: group.id, outcome: "success" },
        }),
      ).toBe(1);
    });

    it("DELETE /v1/collaboration-teams/:teamId/members/:memberId — the LEAD removes a member (status REMOVED); a MEMBER cannot remove anyone", async () => {
      const a = h.fixtures.teamA;
      const group = await newGroup(a.teamId, a.ownerUserId);
      const memberRow = await svc.addExistingMember({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        userIdToAdd: a.memberUserId,
        role: "MEMBER",
      });
      const adminRow = await svc.addExistingMember({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        userIdToAdd: a.adminUserId,
        role: "MEMBER",
      });

      const refused = await call({
        method: "DELETE",
        url: `/v1/collaboration-teams/${group.id}/members/${adminRow.id}`,
        token: a.memberToken,
        headers: { [WS]: a.teamId },
      });
      expect(refused.statusCode).toBe(404);
      expect(refused.json()).toEqual({ error: { code: "not_found" } });
      expect(
        await prisma.collaborationTeamMember.findUniqueOrThrow({ where: { id: adminRow.id } }),
      ).toMatchObject({ status: "ACTIVE", removedAt: null });

      const res = await call({
        method: "DELETE",
        url: `/v1/collaboration-teams/${group.id}/members/${memberRow.id}`,
        token: a.ownerToken,
        headers: { [WS]: a.teamId },
      });
      expect(res.statusCode, res.body).toBe(200);
      const after = await prisma.collaborationTeamMember.findUniqueOrThrow({
        where: { id: memberRow.id },
      });
      expect(after.status).toBe("REMOVED");
      expect(after.removedAt).toBeInstanceOf(Date);
      expect(
        await prisma.collaborationTeamActivity.count({
          where: { teamId: group.id, eventType: "MEMBER_REMOVED", targetId: a.memberUserId },
        }),
      ).toBe(1);

      const audit = await auditRow("collaboration_team.member.removed", memberRow.id);
      expect(audit).toMatchObject({
        userId: a.ownerUserId,
        workspaceId: a.teamId,
        resourceType: "collaboration_team_member",
        outcome: "success",
      });
    });

    it("DELETE /v1/collaboration-teams/:teamId/comments/:commentId — the author deletes; a non-author MEMBER is refused 403", async () => {
      const a = h.fixtures.teamA;
      const group = await newGroup(a.teamId, a.ownerUserId);
      for (const userId of [a.memberUserId, a.adminUserId]) {
        await svc.addExistingMember({
          teamId: group.id,
          actorUserId: a.ownerUserId,
          userIdToAdd: userId,
          role: "MEMBER",
        });
      }
      const comment = await completion.createComment({
        teamId: group.id,
        actorUserId: a.memberUserId,
        targetType: "TEAM",
        body: "K5 comment to be deleted",
      });

      const refused = await call({
        method: "DELETE",
        url: `/v1/collaboration-teams/${group.id}/comments/${comment.id}`,
        token: a.adminToken,
        headers: { [WS]: a.teamId },
      });
      expect(refused.statusCode).toBe(403);
      expect((refused.json() as { error: { code: string } }).error.code).toBe("team_forbidden");
      expect(
        await prisma.collaborationTeamComment.findUniqueOrThrow({ where: { id: comment.id } }),
      ).toMatchObject({ status: "ACTIVE", deletedAtUtc: null });

      const foreign = await call({
        method: "DELETE",
        url: `/v1/collaboration-teams/${group.id}/comments/${comment.id}`,
        token: h.fixtures.teamB.ownerToken,
        headers: { [WS]: h.fixtures.teamB.teamId },
      });
      expect(foreign.statusCode).toBe(404);

      const res = await call({
        method: "DELETE",
        url: `/v1/collaboration-teams/${group.id}/comments/${comment.id}`,
        token: a.memberToken,
        headers: { [WS]: a.teamId },
      });
      expect(res.statusCode, res.body).toBe(200);
      const after = await prisma.collaborationTeamComment.findUniqueOrThrow({
        where: { id: comment.id },
      });
      expect(after.status).toBe("DELETED");
      expect(after.deletedByUserId).toBe(a.memberUserId);
      expect(after.deletedAtUtc).toBeInstanceOf(Date);

      const audit = await auditRow("collaboration_team.comment.deleted", comment.id);
      expect(audit).toMatchObject({
        userId: a.memberUserId,
        workspaceId: a.teamId,
        resourceType: "collaboration_team_comment",
        outcome: "success",
      });
    });
  });

  // ===========================================================================
  // /v1/collaboration/threads
  // ===========================================================================

  describe("discussion threads", () => {
    async function newThread(visibility: "INTERNAL" | "CONTRIBUTOR_SCOPED" = "INTERNAL") {
      const a = h.fixtures.teamA;
      const thread = await prisma.discussionThread.create({
        data: {
          teamId: a.teamId,
          evidenceId: a.evidenceId,
          title: `k5 thread ${tag()}`,
          visibility,
          createdByUserId: a.ownerUserId,
        },
      });
      await prisma.discussionParticipant.create({
        data: {
          threadId: thread.id,
          teamId: a.teamId,
          userId: a.ownerUserId,
          role: "RESOLVER",
          addedByUserId: a.ownerUserId,
        },
      });
      return thread;
    }

    it("POST /v1/collaboration/threads/:id/mark-mentions-read — clears ONLY the caller's unread mentions; outsiders are concealed", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const thread = await newThread();
      const message = await prisma.discussionMessage.create({
        data: {
          threadId: thread.id,
          teamId: a.teamId,
          authorKind: "USER",
          authorUserId: a.ownerUserId,
          body: "@member and @admin please look",
        },
      });
      const mine = await prisma.discussionMention.create({
        data: { messageId: message.id, threadId: thread.id, teamId: a.teamId, mentionedUserId: a.memberUserId },
      });
      const theirs = await prisma.discussionMention.create({
        data: { messageId: message.id, threadId: thread.id, teamId: a.teamId, mentionedUserId: a.adminUserId },
      });
      const url = `/v1/collaboration/threads/${thread.id}/mark-mentions-read`;

      for (const [token, teamId] of [
        [b.ownerToken, a.teamId],
        [b.ownerToken, b.teamId],
        [a.viewerToken, a.teamId],
      ] as const) {
        const refused = await call({ method: "POST", url: `${url}?teamId=${teamId}`, token });
        expect(refused.statusCode).toBe(404);
        expect(refused.json()).toEqual({ error: { code: "not_found" } });
      }
      expect(
        (await prisma.discussionMention.findUniqueOrThrow({ where: { id: mine.id } })).notifiedAtUtc,
      ).toBeNull();

      const res = await call({ method: "POST", url: `${url}?teamId=${a.teamId}`, token: a.memberToken });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ markedRead: 1 });
      expect(
        (await prisma.discussionMention.findUniqueOrThrow({ where: { id: mine.id } })).notifiedAtUtc,
      ).toBeInstanceOf(Date);
      expect(
        (await prisma.discussionMention.findUniqueOrThrow({ where: { id: theirs.id } })).notifiedAtUtc,
      ).toBeNull();
    });

    it("POST /v1/collaboration/threads/:id/subscribe — a reviewer becomes a WATCHER; a VIEWER and a foreign owner are concealed", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const thread = await newThread();
      const url = `/v1/collaboration/threads/${thread.id}/subscribe`;

      const viewer = await call({ method: "POST", url: `${url}?teamId=${a.teamId}`, token: a.viewerToken });
      expect(viewer.statusCode).toBe(404);
      const foreign = await call({ method: "POST", url: `${url}?teamId=${b.teamId}`, token: b.ownerToken });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: { code: "not_found" } });
      expect(
        await prisma.discussionParticipant.count({
          where: { threadId: thread.id, userId: { in: [a.viewerUserId, b.ownerUserId] } },
        }),
      ).toBe(0);

      const res = await call({ method: "POST", url: `${url}?teamId=${a.teamId}`, token: a.memberToken });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toEqual({ subscribed: true, already: false });
      const row = await prisma.discussionParticipant.findUniqueOrThrow({
        where: { threadId_userId: { threadId: thread.id, userId: a.memberUserId } },
      });
      expect(row).toMatchObject({
        teamId: a.teamId,
        role: "WATCHER",
        addedByUserId: a.memberUserId,
        revokedAtUtc: null,
      });

      const again = await call({ method: "POST", url: `${url}?teamId=${a.teamId}`, token: a.memberToken });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ subscribed: true, already: true });
    });

    it("DELETE /v1/collaboration/threads/:id/subscribe — a WATCHER unsubscribes; the RESOLVER is refused 409; outsiders are concealed", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const thread = await newThread();
      const url = `/v1/collaboration/threads/${thread.id}/subscribe`;
      const watcher = await prisma.discussionParticipant.create({
        data: {
          threadId: thread.id,
          teamId: a.teamId,
          userId: a.memberUserId,
          role: "WATCHER",
          addedByUserId: a.memberUserId,
        },
      });

      const foreign = await call({ method: "DELETE", url: `${url}?teamId=${b.teamId}`, token: b.ownerToken });
      expect(foreign.statusCode).toBe(404);
      const resolver = await call({ method: "DELETE", url: `${url}?teamId=${a.teamId}`, token: a.ownerToken });
      expect(resolver.statusCode).toBe(409);
      expect(resolver.json()).toEqual({ error: { code: "resolver_cannot_unsubscribe" } });
      expect(
        (
          await prisma.discussionParticipant.findUniqueOrThrow({
            where: { threadId_userId: { threadId: thread.id, userId: a.ownerUserId } },
          })
        ).revokedAtUtc,
      ).toBeNull();

      const res = await call({ method: "DELETE", url: `${url}?teamId=${a.teamId}`, token: a.memberToken });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ revoked: true });
      const after = await prisma.discussionParticipant.findUniqueOrThrow({ where: { id: watcher.id } });
      expect(after.revokedAtUtc).toBeInstanceOf(Date);
      expect(after.revokedByUserId).toBe(a.memberUserId);
    });

    it("DELETE /v1/collaboration/threads/:id/contributors/:sessionId — a reviewer revokes contributor access (reviewer audit); outsiders are concealed", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const thread = await newThread("CONTRIBUTOR_SCOPED");
      const intakeSessionId = randomUUID();
      const granted = await call({
        method: "POST",
        url: `/v1/collaboration/threads/${thread.id}/contributors`,
        token: a.memberToken,
        payload: { teamId: a.teamId, intakeSessionId, contributorLabel: "K5 contributor" },
      });
      expect(granted.statusCode, granted.body).toBe(201);
      const participantId = (granted.json() as { participantId: string }).participantId;
      const url = `/v1/collaboration/threads/${thread.id}/contributors/${intakeSessionId}`;

      const viewer = await call({ method: "DELETE", url: `${url}?teamId=${a.teamId}`, token: a.viewerToken });
      expect(viewer.statusCode).toBe(404);
      const foreignWorkspace = await call({ method: "DELETE", url: `${url}?teamId=${b.teamId}`, token: b.ownerToken });
      expect(foreignWorkspace.statusCode).toBe(404);
      expect(foreignWorkspace.json()).toEqual({
        error: { code: "evidence_not_in_workspace", details: null },
      });
      const outsiderNamingA = await call({ method: "DELETE", url: `${url}?teamId=${a.teamId}`, token: b.ownerToken });
      expect(outsiderNamingA.statusCode).toBe(404);
      expect(outsiderNamingA.json()).toEqual({ error: { code: "not_found" } });
      expect(
        (await prisma.discussionParticipant.findUniqueOrThrow({ where: { id: participantId } }))
          .revokedAtUtc,
      ).toBeNull();

      const res = await call({ method: "DELETE", url: `${url}?teamId=${a.teamId}`, token: a.memberToken });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ revoked: true });
      const after = await prisma.discussionParticipant.findUniqueOrThrow({ where: { id: participantId } });
      expect(after).toMatchObject({
        intakeSessionId,
        role: "CONTRIBUTOR",
        revokedByUserId: a.memberUserId,
      });
      expect(after.revokedAtUtc).toBeInstanceOf(Date);

      await expect
        .poll(
          () =>
            prisma.evidenceReviewerAuditEvent.findFirst({
              where: {
                evidenceId: a.evidenceId,
                eventType: "CONTRIBUTOR_ACCESS_REVOKED",
                metadata: { path: ["intakeSessionId"], equals: intakeSessionId },
              },
              select: { actorUserId: true, metadata: true },
            }),
          { timeout: 10_000, interval: 25 },
        )
        .toMatchObject({
          actorUserId: a.memberUserId,
          metadata: { threadId: thread.id, intakeSessionId },
        });
    });
  });

  // ===========================================================================
  // /v1/me/inbox/items/:itemKey/*
  // ===========================================================================

  describe("personal inbox mutations", () => {
    async function collabNotification(userId: string, workspaceId: string) {
      return prisma.collaborationTeamNotification.create({
        data: {
          userId,
          workspaceId,
          type: "MENTION_IN_COMMENT",
          title: `K5 notification ${tag()}`,
        },
      });
    }
    const itemUrl = (key: string, action: string) =>
      `/v1/me/inbox/items/${encodeURIComponent(key)}/${action}`;
    const stateOf = (userId: string, itemKey: string) =>
      prisma.inboxItemState.findUnique({ where: { userId_itemKey: { userId, itemKey } } });

    it("every per-item action refuses an unauthenticated caller (401) and a malformed key (400) without writing state", async () => {
      const a = h.fixtures.teamA;
      const n = await collabNotification(a.memberUserId, a.teamId);
      const key = `collaboration:${n.id}`;
      const actions: Array<[string, unknown]> = [
        ["read", undefined],
        ["unread", undefined],
        ["archive", undefined],
        ["unarchive", undefined],
        ["remind", { remindAt: new Date(Date.now() + 3_600_000).toISOString() }],
        ["dismiss", undefined],
        ["undismiss", undefined],
        ["snooze", { snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() }],
      ];
      for (const [action, payload] of actions) {
        const anon = await call({ method: "POST", url: itemUrl(key, action), payload });
        expect(anon.statusCode, action).toBe(401);
        const bad = await call({
          method: "POST",
          url: itemUrl(`not_a_source:${n.id}`, action),
          token: a.memberToken,
          payload,
        });
        expect(bad.statusCode, action).toBe(400);
        expect((bad.json() as { message: string }).message, action).toBe("INBOX_ITEM_KEY_INVALID");
      }
      expect(await stateOf(a.memberUserId, key)).toBeNull();
      expect(
        (await prisma.collaborationTeamNotification.findUniqueOrThrow({ where: { id: n.id } })).readAt,
      ).toBeNull();

      for (const [action, payload] of [
        ["remind", { remindAt: new Date(Date.now() - 60_000).toISOString() }],
        ["snooze", {}],
      ] as const) {
        const invalid = await call({ method: "POST", url: itemUrl(key, action), token: a.memberToken, payload });
        expect(invalid.statusCode, action).toBe(400);
        expect((invalid.json() as { message: string }).message).toBe("SNOOZE_PAYLOAD_INVALID");
      }
      expect(await stateOf(a.memberUserId, key)).toBeNull();
    });

    it("POST …/read and …/unread — flip the caller's canonical collaboration readAt; another user's identical key never touches it", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const n = await collabNotification(a.memberUserId, a.teamId);
      const key = `collaboration:${n.id}`;

      const intruder = await call({ method: "POST", url: itemUrl(key, "read"), token: b.memberToken });
      expect(intruder.statusCode).toBe(200);
      expect(
        (await prisma.collaborationTeamNotification.findUniqueOrThrow({ where: { id: n.id } })).readAt,
      ).toBeNull();
      expect(await stateOf(a.memberUserId, key)).toBeNull();

      const read = await call({ method: "POST", url: itemUrl(key, "read"), token: a.memberToken });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json()).toMatchObject({ itemKey: key, isRead: true });
      expect(
        (await prisma.collaborationTeamNotification.findUniqueOrThrow({ where: { id: n.id } })).readAt,
      ).toBeInstanceOf(Date);
      expect(await stateOf(a.memberUserId, key)).toMatchObject({
        sourceType: "collaboration",
        sourceId: n.id,
        readAt: expect.any(Date),
      });

      const unread = await call({ method: "POST", url: itemUrl(key, "unread"), token: a.memberToken });
      expect(unread.statusCode, unread.body).toBe(200);
      expect(unread.json()).toMatchObject({ itemKey: key, isRead: false, readAt: null });
      expect(
        (await prisma.collaborationTeamNotification.findUniqueOrThrow({ where: { id: n.id } })).readAt,
      ).toBeNull();
      expect((await stateOf(a.memberUserId, key))?.readAt).toBeNull();
    });

    it("POST …/archive and …/unarchive — archive stamps dismissedAt (and readAt); unarchive clears dismissedAt", async () => {
      const a = h.fixtures.teamA;
      const key = `collaboration:${(await collabNotification(a.memberUserId, a.teamId)).id}`;

      const archived = await call({ method: "POST", url: itemUrl(key, "archive"), token: a.memberToken });
      expect(archived.statusCode, archived.body).toBe(200);
      expect(archived.json()).toMatchObject({ itemKey: key, isRead: true, dismissedAt: expect.any(String) });
      const s1 = await stateOf(a.memberUserId, key);
      expect(s1?.dismissedAt).toBeInstanceOf(Date);
      expect(s1?.readAt).toBeInstanceOf(Date);

      const restored = await call({ method: "POST", url: itemUrl(key, "unarchive"), token: a.memberToken });
      expect(restored.statusCode, restored.body).toBe(200);
      expect(restored.json()).toMatchObject({ itemKey: key, dismissedAt: null });
      expect((await stateOf(a.memberUserId, key))?.dismissedAt).toBeNull();
    });

    it("POST …/dismiss and …/undismiss — the legacy aliases write the SAME dismissedAt column", async () => {
      const a = h.fixtures.teamA;
      const key = `collaboration:${(await collabNotification(a.memberUserId, a.teamId)).id}`;

      const dismissed = await call({ method: "POST", url: itemUrl(key, "dismiss"), token: a.memberToken });
      expect(dismissed.statusCode, dismissed.body).toBe(200);
      expect((await stateOf(a.memberUserId, key))?.dismissedAt).toBeInstanceOf(Date);

      const undismissed = await call({ method: "POST", url: itemUrl(key, "undismiss"), token: a.memberToken });
      expect(undismissed.statusCode, undismissed.body).toBe(200);
      expect((await stateOf(a.memberUserId, key))?.dismissedAt).toBeNull();
    });

    it("POST …/remind (remindAt) and …/snooze (snoozedUntil) — both persist the reminder in snoozedUntil", async () => {
      const a = h.fixtures.teamA;
      const k1 = `collaboration:${(await collabNotification(a.memberUserId, a.teamId)).id}`;
      const k2 = `collaboration:${(await collabNotification(a.memberUserId, a.teamId)).id}`;
      const at1 = new Date(Date.now() + 2 * 3_600_000);
      const at2 = new Date(Date.now() + 5 * 3_600_000);

      const remind = await call({
        method: "POST",
        url: itemUrl(k1, "remind"),
        token: a.memberToken,
        payload: { remindAt: at1.toISOString() },
      });
      expect(remind.statusCode, remind.body).toBe(200);
      expect((await stateOf(a.memberUserId, k1))?.snoozedUntil?.toISOString()).toBe(at1.toISOString());

      const snooze = await call({
        method: "POST",
        url: itemUrl(k2, "snooze"),
        token: a.memberToken,
        payload: { snoozedUntil: at2.toISOString() },
      });
      expect(snooze.statusCode, snooze.body).toBe(200);
      expect((await stateOf(a.memberUserId, k2))?.snoozedUntil?.toISOString()).toBe(at2.toISOString());
    });
  });

  // ===========================================================================
  // PUT /v1/me/notification-schedule
  // ===========================================================================

  describe("notification schedule", () => {
    it("PUT /v1/me/notification-schedule — a member saves quiet hours for their workspace; a foreign workspace is concealed", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const body = {
        teamId: a.teamId,
        timezone: "Europe/Berlin",
        quietHoursEnabled: true,
        quietStartMinute: 21 * 60,
        quietEndMinute: 6 * 60 + 30,
        quietCriticalOverride: false,
      };

      const foreign = await call({
        method: "PUT",
        url: "/v1/me/notification-schedule",
        token: b.ownerToken,
        payload: body,
      });
      expect(foreign.statusCode).toBe(404);
      expect(
        await prisma.notificationScheduleSetting.count({
          where: { userId: b.ownerUserId, teamId: a.teamId },
        }),
      ).toBe(0);

      const badZone = await call({
        method: "PUT",
        url: "/v1/me/notification-schedule",
        token: a.memberToken,
        payload: { ...body, timezone: "Mars/Olympus_Mons" },
      });
      expect(badZone.statusCode).toBe(400);
      expect((badZone.json() as { error: { code: string } }).error.code).toBe("invalid_timezone");

      const res = await call({
        method: "PUT",
        url: "/v1/me/notification-schedule",
        token: a.memberToken,
        payload: body,
      });
      expect(res.statusCode, res.body).toBe(200);
      const row = await prisma.notificationScheduleSetting.findUniqueOrThrow({
        where: { userId_teamId: { userId: a.memberUserId, teamId: a.teamId } },
      });
      expect(row).toMatchObject({
        timezone: "Europe/Berlin",
        quietHoursEnabled: true,
        quietStartMinute: 1260,
        quietEndMinute: 390,
        quietCriticalOverride: false,
      });

      await expect
        .poll(
          () =>
            prisma.securityEvent.findFirst({
              where: {
                teamId: a.teamId,
                eventType: "notification_preference_updated",
                details: { path: ["timezone"], equals: "Europe/Berlin" },
              },
              select: { severity: true, details: true },
            }),
          { timeout: 10_000, interval: 25 },
        )
        .toMatchObject({ severity: "INFO", details: { schedule: true, quietHoursEnabled: true } });
    });
  });

  // ===========================================================================
  // Legacy workspace administration (/v1/teams/*)
  // ===========================================================================

  describe("workspace administration", () => {
    it("DELETE /v1/teams/:id — the OWNER deletes an empty workspace (tenant audit); its ADMIN is refused 403 and the row survives", async () => {
      const a = h.fixtures.teamA;
      const team = await prisma.team.create({
        data: {
          name: `k5 disposable workspace ${tag()}`,
          ownerUserId: a.ownerUserId,
          isPersonal: false,
          organizationId: orgA,
          workspaceKind: "ORGANIZATION",
        },
      });
      await prisma.teamMember.createMany({
        data: [
          { teamId: team.id, userId: a.ownerUserId, role: "OWNER", status: "ACTIVE" },
          { teamId: team.id, userId: a.adminUserId, role: "ADMIN", status: "ACTIVE" },
        ],
      });

      const admin = await call({ method: "DELETE", url: `/v1/teams/${team.id}`, token: a.adminToken });
      expect(admin.statusCode).toBe(403);
      expect(admin.json()).toEqual({ message: "Only the team owner can delete this team" });
      expect(await prisma.team.findUnique({ where: { id: team.id } })).not.toBeNull();
      const outsider = await call({ method: "DELETE", url: `/v1/teams/${team.id}`, token: h.fixtures.teamB.ownerToken });
      expect(outsider.statusCode).toBe(403);
      expect(await prisma.team.findUnique({ where: { id: team.id } })).not.toBeNull();

      const res = await call({ method: "DELETE", url: `/v1/teams/${team.id}`, token: a.ownerToken });
      expect(res.statusCode, res.body).toBe(204);
      expect(await prisma.team.findUnique({ where: { id: team.id } })).toBeNull();
      expect(await prisma.teamMember.count({ where: { teamId: team.id } })).toBe(0);
      await tenantAudit("teams.delete", team.id).toMatchObject({
        userId: a.ownerUserId,
        workspaceId: team.id,
        resourceType: "team",
        outcome: "success",
      });
    });

    it("DELETE /v1/teams/:id/invites/:inviteId — an ADMIN revokes (state kept, token rotated, tenant audit); a MEMBER is refused 403", async () => {
      const a = h.fixtures.teamA;
      const tokenHash = createHash("sha256").update(randomBytes(32)).digest("hex");
      const invite = await prisma.teamInvite.create({
        data: {
          teamId: a.teamId,
          email: `k5-ws-invite-${tag()}@invitee.test`,
          role: "MEMBER",
          tokenHash,
          invitedByUserId: a.ownerUserId,
          expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
        },
      });
      const url = `/v1/teams/${a.teamId}/invites/${invite.id}`;

      const member = await call({ method: "DELETE", url, token: a.memberToken });
      expect(member.statusCode).toBe(403);
      expect(member.json()).toEqual({ message: "Forbidden" });
      const foreign = await call({
        method: "DELETE",
        url: `/v1/teams/${h.fixtures.teamB.teamId}/invites/${invite.id}`,
        token: h.fixtures.teamB.ownerToken,
      });
      expect(foreign.statusCode).toBe(404);
      expect((foreign.json() as { error: { code: string } }).error.code).toBe("INVITE_NOT_FOUND");
      expect(await prisma.teamInvite.findUniqueOrThrow({ where: { id: invite.id } })).toMatchObject({
        revokedAt: null,
        tokenHash,
      });

      const res = await call({ method: "DELETE", url, token: a.adminToken });
      expect(res.statusCode, res.body).toBe(200);
      const row = await prisma.teamInvite.findUniqueOrThrow({ where: { id: invite.id } });
      expect(row.revokedAt).toBeInstanceOf(Date);
      expect(row.revokedByUserId).toBe(a.adminUserId);
      expect(row.tokenHash).not.toBe(tokenHash);
      await tenantAudit("teams.invite_revoke", a.teamId).toMatchObject({
        userId: a.adminUserId,
        workspaceId: a.teamId,
        metadata: expect.objectContaining({ inviteId: invite.id }),
      });
    });

    it("DELETE /v1/teams/:id/members/:memberId — an ADMIN removes a member (row gone, tenant audit); a MEMBER is refused 403", async () => {
      const a = h.fixtures.teamA;
      const target = await disposableUser("ws-member");
      const membership = await prisma.teamMember.create({
        data: { teamId: a.teamId, userId: target.id, role: "MEMBER", status: "ACTIVE" },
      });
      const url = `/v1/teams/${a.teamId}/members/${membership.id}`;

      const member = await call({ method: "DELETE", url, token: a.memberToken });
      expect(member.statusCode).toBe(403);
      expect(member.json()).toEqual({ message: "Forbidden" });
      const foreign = await call({
        method: "DELETE",
        url: `/v1/teams/${h.fixtures.teamB.teamId}/members/${membership.id}`,
        token: h.fixtures.teamB.ownerToken,
      });
      expect(foreign.statusCode).toBe(404);
      expect(await prisma.teamMember.findUnique({ where: { id: membership.id } })).not.toBeNull();

      const res = await call({ method: "DELETE", url, token: a.adminToken });
      expect(res.statusCode, res.body).toBe(204);
      expect(await prisma.teamMember.findUnique({ where: { id: membership.id } })).toBeNull();
      await expect
        .poll(
          () =>
            prisma.adminAuditLog.findFirst({
              where: {
                action: "teams.member_delete",
                workspaceId: a.teamId,
                outcome: "success",
                metadata: { path: ["memberId"], equals: membership.id },
              },
              select: { userId: true, metadata: true },
            }),
          { timeout: 10_000, interval: 25 },
        )
        .toMatchObject({ userId: a.adminUserId, metadata: { userId: target.id } });
    });

    it("DELETE /v1/teams/:id/cases/:caseId — an ADMIN unlinks a case (teamId cleared, tenant audit); a MEMBER and a foreign admin are refused", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const kase = await prisma.case.create({
        data: { name: `k5 unlink ${tag()}`, teamId: a.teamId, ownerUserId: a.ownerUserId },
      });

      const member = await call({ method: "DELETE", url: `/v1/teams/${a.teamId}/cases/${kase.id}`, token: a.memberToken });
      expect(member.statusCode).toBe(403);
      const foreign = await call({ method: "DELETE", url: `/v1/teams/${b.teamId}/cases/${kase.id}`, token: b.ownerToken });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ message: "Case not found in team" });
      expect((await prisma.case.findUniqueOrThrow({ where: { id: kase.id } })).teamId).toBe(a.teamId);

      const res = await call({ method: "DELETE", url: `/v1/teams/${a.teamId}/cases/${kase.id}`, token: a.adminToken });
      expect(res.statusCode, res.body).toBe(200);
      expect((await prisma.case.findUniqueOrThrow({ where: { id: kase.id } })).teamId).toBeNull();
      await expect
        .poll(
          () =>
            prisma.adminAuditLog.findFirst({
              where: {
                action: "teams.case_unlink",
                workspaceId: a.teamId,
                outcome: "success",
                metadata: { path: ["caseId"], equals: kase.id },
              },
              select: { userId: true },
            }),
          { timeout: 10_000, interval: 25 },
        )
        .toEqual({ userId: a.adminUserId });
    });

    it("DELETE /v1/teams/:id/external-grants/:grantId — an ADMIN revokes an external case grant (row gone, audit + activity); MEMBER and foreign admin are refused", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const external = await disposableUser("external");
      const kase = await prisma.case.create({
        data: { name: `k5 external ${tag()}`, teamId: a.teamId, ownerUserId: a.ownerUserId },
      });
      const grant = await prisma.caseAccess.create({ data: { caseId: kase.id, userId: external.id } });

      const member = await call({ method: "DELETE", url: `/v1/teams/${a.teamId}/external-grants/${grant.id}`, token: a.memberToken });
      expect(member.statusCode).toBe(403);
      const foreign = await call({ method: "DELETE", url: `/v1/teams/${b.teamId}/external-grants/${grant.id}`, token: b.ownerToken });
      expect(foreign.statusCode).toBe(404);
      expect((foreign.json() as { code: string }).code).toBe("GRANT_NOT_FOUND");
      expect(await prisma.caseAccess.findUnique({ where: { id: grant.id } })).not.toBeNull();

      const res = await call({ method: "DELETE", url: `/v1/teams/${a.teamId}/external-grants/${grant.id}`, token: a.adminToken });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ ok: true, grantId: grant.id });
      expect(await prisma.caseAccess.findUnique({ where: { id: grant.id } })).toBeNull();
      expect(
        await prisma.teamActivity.findFirst({
          where: { teamId: a.teamId, eventType: "team.external_access_revoked", targetId: grant.id },
          select: { actorUserId: true },
        }),
      ).toEqual({ actorUserId: a.adminUserId });
      await expect
        .poll(
          () =>
            prisma.adminAuditLog.findFirst({
              where: {
                action: "teams.external_access_revoked",
                workspaceId: a.teamId,
                metadata: { path: ["grantId"], equals: grant.id },
              },
              select: { userId: true, outcome: true, metadata: true },
            }),
          { timeout: 10_000, interval: 25 },
        )
        .toMatchObject({ userId: a.adminUserId, outcome: "success", metadata: { targetUserId: external.id } });
    });
  });
});
