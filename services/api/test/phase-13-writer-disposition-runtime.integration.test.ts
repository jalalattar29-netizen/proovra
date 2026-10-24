/**
 * PHASE 13 §4 — RUNTIME PROOF FOR THE THREE NAMED WRITER INVESTIGATIONS.
 *
 * WHY THIS SUITE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * The v1 preservation manifest cited tests as evidence that a writer was
 * "driven" or "exercised". Most of those tests were source-text regexes over the
 * service file and two were `vi.mock` stubs — they proved an identifier EXISTED.
 * That is exactly how a record starts describing itself instead of the system.
 *
 * So the three investigations that carry required outcome scalars are proven
 * HERE, against a live PostgreSQL 16, with the real services and the real
 * schema. Nothing about the transitions under test is stubbed, because they are
 * the things under test.
 *
 *   1. (retired) OrphanAiRowsAfterWorkspaceDestruction — no product path
 *      destroys a workspace any more (members audit LIFE-01); see below.
 *
 *   2. ReusableApprovedMfaRecoveryRequests = 0
 *      NonTerminalConsumedRecoveryRequests = 0
 *      An approved recovery request is completed CONCURRENTLY from two callers
 *      and must produce exactly one effect, and must not remain APPROVED — i.e.
 *      re-usable — afterwards.
 *
 *   3. ClaimedButUnwrittenLastSeenFields = 0
 *      The membership heartbeat advances a real `TeamMember.lastSeenAtUtc`,
 *      THROTTLES inside its sample window, and refuses a non-ACTIVE membership.
 *
 * The suite skips ONLY when the live-integration environment is absent, which is
 * the harness's own contract — never per-case, and never to hide a failure.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("PHASE 13 §4 — writer dispositions (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let teamA: string;
  let ownerA: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    teamA = harness.fixtures.teamA.teamId;
    ownerA = harness.fixtures.teamA.ownerUserId;
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  // INVESTIGATION 1 (workspace destruction vs AI advisory rows) is RETIRED.
  // It proved that the one tenant-destruction path — DELETE /v1/teams/:id —
  // purged the AI rows before prisma.team.delete. Members audit LIFE-01 removed
  // that path: no Workspace kind has a self-service hard delete, so no product
  // path can orphan AI rows. The behavioural proof that DELETE makes zero
  // mutations lives in workspace-lifecycle-no-hard-delete.integration.test.ts;
  // purgeWorkspaceAiRecords is recorded backlog-only in writer-preservations.json
  // for the future operator purge.

  // =========================================================================
  // INVESTIGATION 2 — MFA recovery request terminal state
  // =========================================================================

  describe("2. an approved MFA recovery request reaches a terminal state, once", () => {
    async function seedApprovedRequest(userId: string): Promise<string> {
      const row = await prisma.mfaRecoveryRequest.create({
        data: {
          userId,
          teamId: teamA,
          status: "APPROVED",
          reason: "phase 13 §4 proof",
          requiredApprovals: 1,
          approvalCount: 1,
          approvedAtUtc: new Date(),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
        select: { id: true },
      });
      return row.id;
    }

    it("APPROVED becomes COMPLETED, and the row stops being reusable", async () => {
      const userId = harness.fixtures.teamA.memberUserId;
      await prisma.mfaRecoveryRequest.deleteMany({ where: { userId } });
      const id = await seedApprovedRequest(userId);

      const { markRecoveryCompleted } = await import(
        "../src/services/security/mfa-recovery-request.service.js"
      );
      const res = await markRecoveryCompleted({ userId });
      expect(res.completed).toBe(1);

      const after = await prisma.mfaRecoveryRequest.findUnique({
        where: { id },
        select: { status: true, completedAtUtc: true },
      });
      expect(after?.status).toBe("COMPLETED");
      expect(after?.completedAtUtc).not.toBeNull();

      const ReusableApprovedMfaRecoveryRequests =
        await prisma.mfaRecoveryRequest.count({
          where: { userId, status: "APPROVED" },
        });
      expect(ReusableApprovedMfaRecoveryRequests).toBe(0);

      const NonTerminalConsumedRecoveryRequests =
        await prisma.mfaRecoveryRequest.count({
          where: {
            userId,
            completedAtUtc: { not: null },
            status: { notIn: ["COMPLETED", "EXPIRED", "REJECTED", "CANCELLED"] },
          },
        });
      expect(NonTerminalConsumedRecoveryRequests).toBe(0);
    });

    it("two CONCURRENT completions produce exactly one effect", async () => {
      const userId = harness.fixtures.teamA.viewerUserId;
      await prisma.mfaRecoveryRequest.deleteMany({ where: { userId } });
      const id = await seedApprovedRequest(userId);

      const { markRecoveryCompleted } = await import(
        "../src/services/security/mfa-recovery-request.service.js"
      );
      // Both callers see the row as APPROVED; only one may claim it. The
      // affected count of the guarded UPDATE — not the earlier read — is what
      // decides which, so the totals must sum to exactly one.
      const [a, b] = await Promise.all([
        markRecoveryCompleted({ userId }),
        markRecoveryCompleted({ userId }),
      ]);
      expect(a.completed + b.completed).toBe(1);

      const row = await prisma.mfaRecoveryRequest.findUnique({
        where: { id },
        select: { status: true },
      });
      expect(row?.status).toBe("COMPLETED");
    });

    it("a repeated completion after the fact is a no-op, not a second closure", async () => {
      const userId = harness.fixtures.teamA.adminUserId;
      await prisma.mfaRecoveryRequest.deleteMany({ where: { userId } });
      await seedApprovedRequest(userId);
      const { markRecoveryCompleted } = await import(
        "../src/services/security/mfa-recovery-request.service.js"
      );
      expect((await markRecoveryCompleted({ userId })).completed).toBe(1);
      expect((await markRecoveryCompleted({ userId })).completed).toBe(0);
    });

    it("a request that is not APPROVED is never completed by this transition", async () => {
      const userId = harness.fixtures.teamA.memberUserId;
      await prisma.mfaRecoveryRequest.deleteMany({ where: { userId } });
      const row = await prisma.mfaRecoveryRequest.create({
        data: {
          userId,
          teamId: teamA,
          status: "PENDING_ADMIN_REVIEW",
          reason: "phase 13 §4 negative control",
          expiresAt: new Date(Date.now() + 60_000),
        },
        select: { id: true },
      });
      const { markRecoveryCompleted } = await import(
        "../src/services/security/mfa-recovery-request.service.js"
      );
      expect((await markRecoveryCompleted({ userId })).completed).toBe(0);
      const after = await prisma.mfaRecoveryRequest.findUnique({
        where: { id: row.id },
        select: { status: true },
      });
      expect(after?.status).toBe("PENDING_ADMIN_REVIEW");
      await prisma.mfaRecoveryRequest.deleteMany({ where: { userId } });
    });
  });

  // =========================================================================
  // INVESTIGATION 3 — the membership last-seen heartbeat
  // =========================================================================

  describe("3. TeamMember.lastSeenAtUtc has a writer, and it is throttled", () => {
    it("ClaimedButUnwrittenLastSeenFields = 0 — the column the roster renders is written", async () => {
      const userId = harness.fixtures.teamA.memberUserId;
      await prisma.teamMember.updateMany({
        where: { teamId: teamA, userId },
        data: { lastSeenAtUtc: null },
      });

      const { touchMemberLastSeen } = await import(
        "../src/services/identity/rbac.service.js"
      );
      const first = await touchMemberLastSeen({ teamId: teamA, userId });
      expect(first.written).toBe(true);

      const row = await prisma.teamMember.findFirst({
        where: { teamId: teamA, userId },
        select: { lastSeenAtUtc: true },
      });
      const ClaimedButUnwrittenLastSeenFields = row?.lastSeenAtUtc ? 0 : 1;
      expect(ClaimedButUnwrittenLastSeenFields).toBe(0);
    });

    it("a second touch inside the sample window writes nothing", async () => {
      const userId = harness.fixtures.teamA.memberUserId;
      const { touchMemberLastSeen } = await import(
        "../src/services/identity/rbac.service.js"
      );
      await touchMemberLastSeen({ teamId: teamA, userId });
      const before = await prisma.teamMember.findFirst({
        where: { teamId: teamA, userId },
        select: { lastSeenAtUtc: true },
      });

      const second = await touchMemberLastSeen({ teamId: teamA, userId });
      expect(second.written).toBe(false);

      const after = await prisma.teamMember.findFirst({
        where: { teamId: teamA, userId },
        select: { lastSeenAtUtc: true },
      });
      expect(after?.lastSeenAtUtc?.toISOString()).toBe(
        before?.lastSeenAtUtc?.toISOString(),
      );
    });

    it("the window is in the WHERE, so concurrent touches collapse to one write", async () => {
      const userId = harness.fixtures.teamA.adminUserId;
      await prisma.teamMember.updateMany({
        where: { teamId: teamA, userId },
        data: { lastSeenAtUtc: null },
      });
      const { touchMemberLastSeen } = await import(
        "../src/services/identity/rbac.service.js"
      );
      const results = await Promise.all([
        touchMemberLastSeen({ teamId: teamA, userId }),
        touchMemberLastSeen({ teamId: teamA, userId }),
        touchMemberLastSeen({ teamId: teamA, userId }),
      ]);
      expect(results.filter((r) => r.written).length).toBe(1);
    });

    it("an expired window DOES advance it — the throttle is a bound, not a lock", async () => {
      const userId = harness.fixtures.teamA.viewerUserId;
      const stale = new Date(Date.now() - 10 * 60 * 1000);
      await prisma.teamMember.updateMany({
        where: { teamId: teamA, userId },
        data: { lastSeenAtUtc: stale },
      });
      const { touchMemberLastSeen } = await import(
        "../src/services/identity/rbac.service.js"
      );
      expect((await touchMemberLastSeen({ teamId: teamA, userId })).written).toBe(true);
      const after = await prisma.teamMember.findFirst({
        where: { teamId: teamA, userId },
        select: { lastSeenAtUtc: true },
      });
      expect(after!.lastSeenAtUtc!.getTime()).toBeGreaterThan(stale.getTime());
    });

    it("a SUSPENDED membership is never touched — last-seen describes live access", async () => {
      const userId = harness.fixtures.teamA.viewerUserId;
      const marker = new Date(Date.now() - 10 * 60 * 1000);
      await prisma.teamMember.updateMany({
        where: { teamId: teamA, userId },
        data: { status: "SUSPENDED", lastSeenAtUtc: marker },
      });
      try {
        const { touchMemberLastSeen } = await import(
          "../src/services/identity/rbac.service.js"
        );
        expect((await touchMemberLastSeen({ teamId: teamA, userId })).written).toBe(
          false,
        );
        const after = await prisma.teamMember.findFirst({
          where: { teamId: teamA, userId },
          select: { lastSeenAtUtc: true },
        });
        expect(after!.lastSeenAtUtc!.toISOString()).toBe(marker.toISOString());
      } finally {
        await prisma.teamMember.updateMany({
          where: { teamId: teamA, userId },
          data: { status: "ACTIVE" },
        });
      }
    });

    it("a foreign workspace's membership is not touched by this workspace's request", async () => {
      const teamB = harness.fixtures.teamB.teamId;
      const userId = harness.fixtures.teamB.memberUserId;
      await prisma.teamMember.updateMany({
        where: { teamId: teamB, userId },
        data: { lastSeenAtUtc: null },
      });
      const { touchMemberLastSeen } = await import(
        "../src/services/identity/rbac.service.js"
      );
      // Same user id, wrong workspace anchor: nothing matches.
      expect(
        (await touchMemberLastSeen({ teamId: teamA, userId })).written,
      ).toBe(false);
      const row = await prisma.teamMember.findFirst({
        where: { teamId: teamB, userId },
        select: { lastSeenAtUtc: true },
      });
      expect(row?.lastSeenAtUtc).toBeNull();
    });
  });
});
