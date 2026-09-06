/**
 * WORKSPACE AND COLLABORATION RECONCILIATION — CLOSURE, part 3:
 * custody, privacy, audit and authority consolidation, against live
 * PostgreSQL 16.
 *
 * A collaboration group is a way of ORGANISING people around work. It is not a
 * custody boundary, not an access grant and not a second tenancy — and the
 * cheapest way for that to stop being true is for one of its writes to reach
 * something it does not own. Each property below is the failure that would
 * make it untrue, asserted directly.
 *
 * Nothing under proof is mocked.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = typeof import("../src/db.js")["prisma"];
type TeamService = typeof import("../src/services/collaboration-team/collaboration-team.service.js");
type Completion = typeof import("../src/services/collaboration-team/collaboration-completion.service.js");

const WORKSPACE_HEADER = "x-proovra-workspace-id";

describe("WCR closure — custody, privacy, audit (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let svc: TeamService;
  let completion: Completion;

  const inject = (opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    token: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) =>
    h.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.payload ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.payload ? { payload: opts.payload as never } : {}),
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    svc = await import(
      "../src/services/collaboration-team/collaboration-team.service.js"
    );
    completion = await import(
      "../src/services/collaboration-team/collaboration-completion.service.js"
    );
    // The fixture workspaces default to FREE, which includes zero groups; the
    // properties here are about what a group may TOUCH, so the workspace has
    // to be able to hold one.
    await prisma.team.updateMany({
      where: { id: { in: [h.fixtures.teamA.teamId, h.fixtures.teamB.teamId] } },
      data: { billingPlan: "TEAM", billingStatus: "ACTIVE" },
    });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  /**
   * A fresh group, from a workspace that is under its plan's group ceiling.
   *
   * TEAM includes five ACTIVE groups, and that ceiling is real — it refused
   * this suite's sixth test, which is the guard doing its job. Archiving what
   * previous tests left behind keeps each case starting from the same state
   * without weakening the limit: archived groups are not active, and the
   * ceiling is still enforced by the same guard on every create below.
   */
  async function newGroup(workspaceId: string, actorUserId: string) {
    const stale = await prisma.collaborationTeam.findMany({
      where: { workspaceId, status: "ACTIVE" },
      select: { id: true },
    });
    for (const g of stale) {
      await svc.archiveCollaborationTeam({ teamId: g.id, actorUserId });
    }
    return svc.createCollaborationTeam({
      workspaceId,
      actorUserId,
      name: `wcr ${randomUUID().slice(0, 8)}`,
    });
  }

  async function refusal(fn: () => Promise<unknown>) {
    try {
      await fn();
      return "ALLOWED";
    } catch (err) {
      return (err as { code?: string }).code ?? "UNTYPED";
    }
  }

  // =========================================================================
  // ASSIGNMENT CUSTODY
  // =========================================================================

  describe("assignment custody", () => {
    it("only supported resource types are accepted", async () => {
      const a = h.fixtures.teamA;
      const group = await newGroup(a.teamId, a.ownerUserId);
      for (const targetType of ["USER", "WORKSPACE", "PACKAGE", "", "case"]) {
        const outcome = await refusal(() =>
          svc.createAssignment({
            teamId: group.id,
            actorUserId: a.ownerUserId,
            targetType,
            targetId: a.evidenceId,
          }),
        );
        expect(outcome, `targetType=${targetType}`).not.toBe("ALLOWED");
      }
      expect(
        await prisma.collaborationTeamAssignment.count({
          where: { teamId: group.id },
        }),
      ).toBe(0);
    });

    it("a target that does not exist, and a FOREIGN one, are both refused with zero rows", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const group = await newGroup(a.teamId, a.ownerUserId);

      const cases = [
        { label: "arbitrary uuid", targetType: "EVIDENCE", targetId: randomUUID() },
        { label: "foreign evidence", targetType: "EVIDENCE", targetId: b.evidenceId },
        { label: "foreign case", targetType: "CASE", targetId: b.caseId },
      ];
      for (const c of cases) {
        const outcome = await refusal(() =>
          svc.createAssignment({
            teamId: group.id,
            actorUserId: a.ownerUserId,
            targetType: c.targetType,
            targetId: c.targetId,
          }),
        );
        expect(outcome, c.label).not.toBe("ALLOWED");
      }
      expect(
        await prisma.collaborationTeamAssignment.count({
          where: { teamId: group.id },
        }),
      ).toBe(0);

      // Non-vacuous: the workspace's OWN evidence and case are assignable, so
      // the refusals above were about ownership and not about the operation.
      await svc.createAssignment({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        targetType: "EVIDENCE",
        targetId: a.evidenceId,
      });
      await svc.createAssignment({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        targetType: "CASE",
        targetId: a.caseId,
      });
      expect(
        await prisma.collaborationTeamAssignment.count({
          where: { teamId: group.id },
        }),
      ).toBe(2);
    });

    it("the assignable-target list is the workspace's own records, and only those", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      // The picker is WORKSPACE-scoped, not group-scoped: a group has no
      // records of its own to offer.
      const page = await svc.listAssignableTargets({
        workspaceId: a.teamId,
        targetType: "EVIDENCE",
      });
      const ids = page.targets.map((t) => t.id);
      expect(ids).toContain(a.evidenceId);
      expect(ids).not.toContain(b.evidenceId);
    });
  });

  // =========================================================================
  // A GROUP OWNS NOTHING
  // =========================================================================

  describe("a group owns nothing", () => {
    it("archiving a group deletes no Evidence and no Case", async () => {
      const a = h.fixtures.teamA;
      const group = await newGroup(a.teamId, a.ownerUserId);
      await svc.createAssignment({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        targetType: "EVIDENCE",
        targetId: a.evidenceId,
      });

      const evidenceBefore = await prisma.evidence.count({
        where: { teamId: a.teamId },
      });
      const casesBefore = await prisma.case.count({ where: { teamId: a.teamId } });

      await svc.archiveCollaborationTeam({
        teamId: group.id,
        actorUserId: a.ownerUserId,
      });

      expect(await prisma.evidence.count({ where: { teamId: a.teamId } })).toBe(
        evidenceBefore,
      );
      expect(await prisma.case.count({ where: { teamId: a.teamId } })).toBe(
        casesBefore,
      );
      // The record itself is untouched, not merely still counted.
      const ev = await prisma.evidence.findUniqueOrThrow({
        where: { id: a.evidenceId },
        select: { id: true, deletedAt: true, ownerUserId: true },
      });
      expect(ev.deletedAt).toBeNull();
    });

    it("removing someone from a group changes no Evidence ownership", async () => {
      const a = h.fixtures.teamA;
      const group = await newGroup(a.teamId, a.ownerUserId);
      await svc.addExistingMember({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        userIdToAdd: a.memberUserId,
        role: "MEMBER",
      });
      const member = await prisma.collaborationTeamMember.findFirstOrThrow({
        where: { teamId: group.id, userId: a.memberUserId },
        select: { id: true },
      });

      const owners = await prisma.evidence.findMany({
        where: { teamId: a.teamId },
        select: { id: true, ownerUserId: true },
        orderBy: { id: "asc" },
      });

      await svc.removeMember({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        memberId: member.id,
      });

      const after = await prisma.evidence.findMany({
        where: { teamId: a.teamId },
        select: { id: true, ownerUserId: true },
        orderBy: { id: "asc" },
      });
      expect(after).toEqual(owners);
      // And they are still in the WORKSPACE — leaving a group is not leaving
      // the tenancy, which is the whole distinction the model rests on.
      expect(
        await prisma.teamMember.count({
          where: { teamId: a.teamId, userId: a.memberUserId, status: "ACTIVE" },
        }),
      ).toBe(1);
    });

    it("group membership grants no INDEPENDENT evidence access", async () => {
      // A person who is in the GROUP but whose WORKSPACE membership has been
      // revoked must lose access, because the group grants nothing on its own.
      const a = h.fixtures.teamA;
      const group = await newGroup(a.teamId, a.ownerUserId);
      await svc.addExistingMember({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        userIdToAdd: a.memberUserId,
        role: "MEMBER",
      });

      const before = await inject({
        method: "GET",
        url: `/v1/collaboration-teams/${group.id}`,
        token: a.memberToken,
        headers: { [WORKSPACE_HEADER]: a.teamId },
      });
      expect(before.statusCode).toBe(200);

      await prisma.teamMember.updateMany({
        where: { teamId: a.teamId, userId: a.memberUserId },
        data: { status: "REVOKED" },
      });

      const after = await inject({
        method: "GET",
        url: `/v1/collaboration-teams/${group.id}`,
        token: a.memberToken,
        headers: { [WORKSPACE_HEADER]: a.teamId },
      });
      expect(after.statusCode).toBe(404);
      // Their GROUP row is still ACTIVE — so the refusal came from the
      // workspace layer, which is exactly the ordering under test.
      expect(
        await prisma.collaborationTeamMember.count({
          where: { teamId: group.id, userId: a.memberUserId, status: "ACTIVE" },
        }),
      ).toBe(1);

      await prisma.teamMember.updateMany({
        where: { teamId: a.teamId, userId: a.memberUserId },
        data: { status: "ACTIVE" },
      });
    });

    it("a discussion message changes nothing about the evidence it mentions", async () => {
      const a = h.fixtures.teamA;
      const group = await newGroup(a.teamId, a.ownerUserId);
      const before = await prisma.evidence.findUniqueOrThrow({
        where: { id: a.evidenceId },
      });
      await completion.createComment({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        targetType: "TEAM",
        body: `discussing ${a.evidenceId}`,
      });
      const after = await prisma.evidence.findUniqueOrThrow({
        where: { id: a.evidenceId },
      });
      expect(after).toEqual(before);
    });
  });

  // =========================================================================
  // LEAST PRIVILEGE
  // =========================================================================

  describe("least privilege", () => {
    it("a group VIEWER may read and may not write", async () => {
      const a = h.fixtures.teamA;
      const group = await newGroup(a.teamId, a.ownerUserId);
      await svc.addExistingMember({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        userIdToAdd: a.viewerUserId,
        role: "VIEWER",
      });

      const read = await inject({
        method: "GET",
        url: `/v1/collaboration-teams/${group.id}`,
        token: a.viewerToken,
        headers: { [WORKSPACE_HEADER]: a.teamId },
      });
      expect(read.statusCode).toBe(200);

      const write = await inject({
        method: "POST",
        url: `/v1/collaboration-teams/${group.id}/comments`,
        token: a.viewerToken,
        headers: { [WORKSPACE_HEADER]: a.teamId },
        payload: { body: "viewers do not post" },
      });
      expect(write.statusCode).toBeGreaterThanOrEqual(400);
      expect(
        await prisma.collaborationTeamComment.count({
          where: { teamId: group.id, authorUserId: a.viewerUserId },
        }),
      ).toBe(0);
    });

    it("billing, seats and contract data never appear on a collaboration surface", async () => {
      const a = h.fixtures.teamA;
      const group = await newGroup(a.teamId, a.ownerUserId);
      // The projection is what a GROUP MEMBER sees, so they have to be one.
      await svc.addExistingMember({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        userIdToAdd: a.memberUserId,
        role: "MEMBER",
      });
      const detail = await inject({
        method: "GET",
        url: `/v1/collaboration-teams/${group.id}`,
        token: a.memberToken,
        headers: { [WORKSPACE_HEADER]: a.teamId },
      });
      expect(detail.statusCode).toBe(200);
      const body = JSON.stringify(detail.json());
      for (const forbidden of [
        "billingPlan",
        "billingStatus",
        "includedSeats",
        "stripe",
        "paypal",
        "contract",
        "kms",
        "arn:aws",
        "tokenHash",
        "passwordHash",
        "userAgent",
        "ipAddress",
      ]) {
        expect(body.toLowerCase(), `${forbidden} must not be projected`).not.toContain(
          forbidden.toLowerCase(),
        );
      }
    });
  });

  // =========================================================================
  // AUDIT COMPLETENESS
  // =========================================================================

  describe("audit completeness", () => {
    it("a material mutation records workspace, actor, target, outcome and correlation", async () => {
      const a = h.fixtures.teamA;
      const res = await inject({
        method: "POST",
        url: "/v1/collaboration-teams",
        token: a.ownerToken,
        headers: { [WORKSPACE_HEADER]: a.teamId },
        payload: { name: `wcr audit ${randomUUID().slice(0, 6)}` },
      });
      expect(res.statusCode).toBe(201);
      const groupId = (res.json() as { team: { id: string } }).team.id;

      let row = null as Awaited<
        ReturnType<typeof prisma.adminAuditLog.findFirst>
      >;
      for (let i = 0; i < 40 && !row; i += 1) {
        row = await prisma.adminAuditLog.findFirst({
          where: { action: "collaboration_team.created", resourceId: groupId },
        });
        if (!row) await new Promise((r) => setTimeout(r, 50));
      }
      expect(row, "the mutation must be audited").not.toBeNull();
      expect(row!.workspaceId).toBe(a.teamId);
      expect(row!.userId).toBe(a.ownerUserId);
      expect(row!.resourceType).toBe("collaboration_team");
      expect(row!.resourceId).toBe(groupId);
      expect(row!.outcome).toBe("success");
    });

    it("a REFUSAL is never recorded as a success", async () => {
      const a = h.fixtures.teamA;
      const before = await prisma.adminAuditLog.count({
        where: { action: "teams.invite_create", outcome: "success" },
      });
      const res = await inject({
        method: "POST",
        url: `/v1/teams/${a.teamId}/invites`,
        token: a.adminToken,
        payload: { email: `refused-${randomUUID().slice(0, 6)}@x.test`, role: "OWNER" },
      });
      expect(res.statusCode).toBe(403);
      expect(
        await prisma.adminAuditLog.count({
          where: { action: "teams.invite_create", outcome: "success" },
        }),
      ).toBe(before);
      // The refusal IS recorded — silence would be worse than a wrong outcome.
      // The refusal IS recorded — silence would be worse than a wrong
      // outcome. The facade is fire-and-forget, so the row may land just after
      // the response; a bounded wait distinguishes "not yet" from "never".
      let denied = null as Awaited<
        ReturnType<typeof prisma.adminAuditLog.findFirst>
      >;
      for (let i = 0; i < 40 && !denied; i += 1) {
        denied = await prisma.adminAuditLog.findFirst({
          where: { action: "teams.invite_create", outcome: "denied" },
          orderBy: { createdAt: "desc" },
        });
        if (!denied) await new Promise((r) => setTimeout(r, 50));
      }
      expect(denied).not.toBeNull();
      expect(denied!.workspaceId).toBe(a.teamId);
    });

    it("concurrent losers emit no duplicate success", async () => {
      const a = h.fixtures.teamA;
      const group = await newGroup(a.teamId, a.ownerUserId);
      const review = await completion.openAccessReview({
        teamId: group.id,
        actorUserId: a.ownerUserId,
      });

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          completion
            .completeAccessReview({
              teamId: group.id,
              actorUserId: a.ownerUserId,
              reviewId: review.id,
            })
            .then(
              () => "COMPLETED",
              (err: { code?: string }) => err.code ?? "UNTYPED",
            ),
        ),
      );
      // Exactly one winner. The rest are refusals, not silent successes.
      expect(results.filter((r) => r === "COMPLETED").length).toBe(1);
      expect(results.filter((r) => r === "UNTYPED")).toEqual([]);

      const completions = await prisma.collaborationTeamActivity.count({
        where: { teamId: group.id, eventType: "ACCESS_REVIEW_COMPLETED" },
      });
      expect(completions).toBeLessThanOrEqual(1);
    });
  });

  // =========================================================================
  // AUTHORITY CONSOLIDATION
  // =========================================================================

  describe("authority consolidation", () => {
    it("the INBOX is the reader for a group notification, and the retired surface says so", async () => {
      const a = h.fixtures.teamA;
      const group = await newGroup(a.teamId, a.ownerUserId);
      await svc.addExistingMember({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        userIdToAdd: a.memberUserId,
        role: "MEMBER",
      });

      // The emitter still writes; only the second READER was retired. A
      // `@team` mention is the production path that produces one.
      await completion.createComment({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        targetType: "TEAM",
        body: "@team please look at this",
      });
      const notifications = await prisma.collaborationTeamNotification.count({
        where: { workspaceId: a.teamId, userId: a.memberUserId },
      });
      expect(notifications).toBeGreaterThan(0);

      const retired = await inject({
        method: "GET",
        url: "/v1/collaboration-team-notifications",
        token: a.memberToken,
        headers: { [WORKSPACE_HEADER]: a.teamId },
      });
      expect(retired.statusCode).toBe(410);
      expect(JSON.stringify(retired.json())).toContain(
        "COLLABORATION_TEAM_NOTIFICATIONS_RETIRED",
      );

      // And the canonical inbox answers.
      const inbox = await inject({
        method: "GET",
        url: "/v1/me/inbox",
        token: a.memberToken,
        headers: { [WORKSPACE_HEADER]: a.teamId },
      });
      expect(inbox.statusCode).toBe(200);
    });

    it("per-group notification PREFERENCES are retired in favour of Settings", async () => {
      const a = h.fixtures.teamA;
      const group = await newGroup(a.teamId, a.ownerUserId);
      for (const method of ["GET", "PATCH"] as const) {
        const res = await inject({
          method,
          url: `/v1/collaboration-teams/${group.id}/notification-preferences`,
          token: a.ownerToken,
          headers: { [WORKSPACE_HEADER]: a.teamId },
          ...(method === "PATCH" ? { payload: { digest: "MUTED" } } : {}),
        });
        expect(res.statusCode).toBe(410);
        expect(JSON.stringify(res.json())).toContain(
          "COLLABORATION_TEAM_PREFERENCES_RETIRED",
        );
      }
    });

    it("guest invitation is retired for EVERY caller, and existing rows stay readable", async () => {
      const a = h.fixtures.teamA;
      const group = await newGroup(a.teamId, a.ownerUserId);
      const outcome = await refusal(() =>
        completion.inviteGuest({
          teamId: group.id,
          actorUserId: a.ownerUserId,
          email: "outsider@example.invalid",
        }),
      );
      expect(outcome).toBe("COLLABORATION_TEAM_GUESTS_RETIRED");
      expect(await prisma.collaborationTeamGuest.count()).toBe(0);
      // The read path survives so an operator can see and revoke what they
      // believed they had granted.
      await expect(
        completion.listGuests({ teamId: group.id, actorUserId: a.ownerUserId }),
      ).resolves.toBeDefined();
    });

    it("an access-review decision ENFORCES — it does not merely record", async () => {
      const a = h.fixtures.teamA;
      const group = await newGroup(a.teamId, a.ownerUserId);
      await svc.addExistingMember({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        userIdToAdd: a.adminUserId,
        role: "MEMBER",
      });
      const review = await completion.openAccessReview({
        teamId: group.id,
        actorUserId: a.ownerUserId,
      });
      const item = await prisma.collaborationTeamAccessReviewItem.findFirstOrThrow(
        {
          where: {
            reviewId: review.id,
            member: { userId: a.adminUserId },
          },
          select: { id: true, memberId: true },
        },
      );

      await completion.decideAccessReviewItem({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        itemId: item.id,
        decision: "REMOVE",
      });
      // A decision alone changes nothing — completion is where it lands.
      expect(
        (
          await prisma.collaborationTeamMember.findUniqueOrThrow({
            where: { id: item.memberId },
            select: { status: true },
          })
        ).status,
      ).toBe("ACTIVE");

      await completion.completeAccessReview({
        teamId: group.id,
        actorUserId: a.ownerUserId,
        reviewId: review.id,
      });
      expect(
        (
          await prisma.collaborationTeamMember.findUniqueOrThrow({
            where: { id: item.memberId },
            select: { status: true },
          })
        ).status,
      ).toBe("REMOVED");
    });
  });
});
