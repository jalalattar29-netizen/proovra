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
 *   1. OrphanAiRowsAfterWorkspaceDestruction = 0
 *      A workspace is destroyed and every AI table is counted for rows still
 *      naming it. The AI tables key on a bare `workspace_id`/`team_id` uuid with
 *      NO foreign key, so this cannot be inferred from a cascade — it has to be
 *      measured after a real delete.
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

  // =========================================================================
  // INVESTIGATION 1 — workspace destruction vs AI advisory rows
  // =========================================================================

  describe("1. tenant destruction takes the AI rows with it", () => {
    /**
     * Every AI table that keys on a workspace WITHOUT a foreign key back to
     * Team. Each is counted after the destruction; the scalar is their sum.
     *
     * `workspace_ai_policies` and `ai_copilot_observation_reviews` are
     * deliberately NOT in this list: they carry real cascading relations (to
     * Team and to AiCopilotRun respectively) and the database removes them. The
     * point of the purge is the rows the database will NOT remove.
     */
    const ORPHANABLE = [
      ["ai_copilot_runs", "workspace_id"],
      ["ai_usage_events", "workspace_id"],
      ["ai_usage_daily", "workspace_id"],
      ["ai_usage_monthly", "workspace_id"],
      ["semantic_usage_daily", "workspace_id"],
      ["provider_usage_events", "team_id"],
      ["provider_budgets", "team_id"],
    ] as const;

    async function countOrphans(workspaceId: string): Promise<number> {
      let total = 0;
      for (const [table, column] of ORPHANABLE) {
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "${column}" = $1::uuid`,
          workspaceId,
        )) as Array<{ n: number }>;
        total += rows[0]?.n ?? 0;
      }
      return total;
    }

    /** A throwaway workspace with one row in every orphanable AI table. */
    async function seedDoomedWorkspace(): Promise<string> {
      const org = await prisma.organization.create({
        data: { name: `phase13-doomed-${Date.now()}`, kind: "SYSTEM" },
        select: { id: true },
      });
      const team = await prisma.team.create({
        data: {
          name: "phase13 doomed workspace",
          ownerUserId: ownerA,
          organizationId: org.id,
          workspaceKind: "OWNED",
        },
        select: { id: true },
      });
      const w = team.id;

      await prisma.aiCopilotRun.create({
        data: {
          workspaceId: w,
          userId: ownerA,
          feature: "CASE_COPILOT",
          requestId: `phase13-${w}`,
          provider: "test",
          model: "test-model",
          promptVersion: "1",
          systemPolicyVersion: "1",
          productKnowledgeVersion: "1",
          contextSchemaVersion: "1",
          outputSchemaVersion: "1",
          workspacePolicyVersion: 1,
          processingMode: "METADATA_ONLY",
          selectedObjectVersionsJson: {},
          status: "COMPLETED",
        },
      });
      await prisma.aiUsageEvent.create({
        data: {
          workspaceId: w,
          userId: ownerA,
          feature: "CASE_COPILOT",
          provider: "test",
          model: "test-model",
          requestId: `phase13-usage-${w}`,
          estimatedCostUsdMicros: BigInt(10),
          status: "COMMITTED",
        },
      });
      await prisma.aiUsageDaily.create({
        data: { workspaceId: w, dayUtc: "2026-08-17", operations: 1, costUsdMicros: BigInt(10) },
      });
      await prisma.aiUsageMonthly.create({
        data: { workspaceId: w, monthUtc: "2026-08", operations: 1, costUsdMicros: BigInt(10) },
      });
      await prisma.semanticUsageDaily.create({
        data: { workspaceId: w, dateUtc: new Date("2026-08-17T00:00:00Z"), chunksEmbedded: 3 },
      });
      await prisma.providerUsageEvent.create({
        data: { teamId: w, provider: "test", operation: "embed", unit: "tokens", units: 5 },
      });
      await prisma.providerBudget.create({
        data: {
          teamId: w,
          scope: "WORKSPACE",
          period: "MONTHLY",
          softLimitUsdMicros: BigInt(100),
          hardLimitUsdMicros: BigInt(200),
          createdByUserId: ownerA,
        },
      });
      return w;
    }

    it("without the purge, deleting the Team would leave every AI row behind (the defect)", async () => {
      const w = await seedDoomedWorkspace();
      expect(await countOrphans(w)).toBe(7);

      // Delete the Team the way the database would if nothing purged first.
      // This is the CONTROL: it demonstrates that no cascade exists, which is
      // the entire reason the purge has to be called at all. If this ever
      // returns 0 the schema has grown foreign keys and the purge is redundant
      // — and this case will say so rather than quietly passing.
      await prisma.teamInvite.deleteMany({ where: { teamId: w } });
      await prisma.teamMember.deleteMany({ where: { teamId: w } });
      await prisma.team.delete({ where: { id: w } });
      expect(await countOrphans(w)).toBe(7);

      // Clean up the orphans this control deliberately created.
      const { purgeWorkspaceAiRecords } = await import(
        "../src/services/ai/ai-retention.service.js"
      );
      await purgeWorkspaceAiRecords(w, prisma as never);
      expect(await countOrphans(w)).toBe(0);
    });

    it("OrphanAiRowsAfterWorkspaceDestruction = 0 when destruction runs the purge", async () => {
      const w = await seedDoomedWorkspace();
      expect(await countOrphans(w)).toBe(7);

      const { purgeWorkspaceAiRecords } = await import(
        "../src/services/ai/ai-retention.service.js"
      );
      // The destruction ordering under test: purge FIRST, then delete the Team.
      const purged = await purgeWorkspaceAiRecords(w, prisma as never);
      expect(purged.purged).toBe(7);
      await prisma.teamInvite.deleteMany({ where: { teamId: w } });
      await prisma.teamMember.deleteMany({ where: { teamId: w } });
      await prisma.team.delete({ where: { id: w } });

      const OrphanAiRowsAfterWorkspaceDestruction = await countOrphans(w);
      expect(OrphanAiRowsAfterWorkspaceDestruction).toBe(0);
    });

    it("the purge is tenant-scoped — a sibling workspace keeps its rows", async () => {
      const doomed = await seedDoomedWorkspace();
      const survivor = await seedDoomedWorkspace();
      const { purgeWorkspaceAiRecords } = await import(
        "../src/services/ai/ai-retention.service.js"
      );
      await purgeWorkspaceAiRecords(doomed, prisma as never);
      expect(await countOrphans(doomed)).toBe(0);
      expect(await countOrphans(survivor)).toBe(7);
      await purgeWorkspaceAiRecords(survivor, prisma as never);
    });

    it("the purge is idempotent — a second run removes nothing and does not throw", async () => {
      const w = await seedDoomedWorkspace();
      const { purgeWorkspaceAiRecords } = await import(
        "../src/services/ai/ai-retention.service.js"
      );
      expect((await purgeWorkspaceAiRecords(w, prisma as never)).purged).toBe(7);
      expect((await purgeWorkspaceAiRecords(w, prisma as never)).purged).toBe(0);
    });
  });

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
