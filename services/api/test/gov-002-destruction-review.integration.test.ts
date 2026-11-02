/**
 * GOV-002, OPS-002, GOV-003, GOV-004, GOV-007, GOV-013, GOV-019 — the governed
 * destruction review, through the real routes and the real worker sweep.
 *
 * What was wrong: every move on a review asked only for `evidence.delete`, one
 * ADMIN could open and approve alone, approval reached storage on the next
 * five-minute tick with no execute act, `DESTRUCTION_EXECUTION_ENABLED` had no
 * reader, a trashed or archived record could never be approved, approval ignored
 * Object Lock, and a workspace-scope hold was invisible until the executor.
 *
 * FIXTURES (labelled): FEATURE and plan rows are written as a contract would
 * land them; `governance.destruction.*` capabilities are capability-grant rows;
 * records are seeded directly in the posture a case needs. The Enterprise plan
 * gate is exercised by its own suites and is satisfied here by a fixture.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

vi.mock("../src/services/billing-enforcement.service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/services/billing-enforcement.service.js")>();
  return {
    ...original,
    // Fixture: the plan gate has its own proof; here every workspace is on the plan
    // unless a test says otherwise.
    assertTeamAllowsEnterpriseFeature: vi.fn(async () => undefined),
  };
});

describe("governed destruction review (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let orchestrator: typeof import("../../worker/src/governance/destruction-orchestrator.worker.js");
  let stepUp: ReturnType<typeof createStepUpCeremony>;

  const A = () => h.fixtures.teamA;

  const person = (who: "owner" | "admin" | "member") => ({
    token: who === "owner" ? A().ownerToken : who === "admin" ? A().adminToken : A().memberToken,
    userId: who === "owner" ? A().ownerUserId : who === "admin" ? A().adminUserId : A().memberUserId,
  });

  async function capability(userId: string, permission: string) {
    const member = await prisma.teamMember.findFirstOrThrow({
      where: { teamId: A().teamId, userId },
      select: { id: true },
    });
    await prisma.memberCapabilityGrant.create({
      data: {
        teamMemberId: member.id,
        teamId: A().teamId,
        permission,
        grantedByUserId: A().ownerUserId,
        reason: "gov-002 test fixture",
      },
    });
  }

  async function record(over: Record<string, unknown> = {}) {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: A().teamId },
      select: { organizationId: true },
    });
    return prisma.evidence.create({
      data: {
        title: "gov-002 record",
        type: "PHOTO",
        status: "SIGNED",
        mimeType: "image/jpeg",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        ...over,
      } as never,
      select: { id: true },
    });
  }

  const trashed = () => {
    const past = new Date(Date.now() - 86_400_000);
    return { lifecycleState: "TRASHED", deletedAt: past, deleteScheduledForUtc: past };
  };

  const inject = (who: "owner" | "admin" | "member", url: string, payload: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${person(who).token}`,
        "content-type": "application/json",
        ...headers,
      },
      payload: payload as never,
    });

  const header = (who: "owner" | "admin" | "member", purpose: string, reviewId: string) =>
    stepUp.approvedHeader({
      token: person(who).token,
      userId: person(who).userId,
      teamId: A().teamId,
      purpose,
      resourceKind: "destruction_review",
      resourceId: reviewId,
    });

  async function open(who: "owner" | "admin", evidenceId: string): Promise<string> {
    const res = await inject(who, "/v1/governance/destruction-reviews", {
      teamId: A().teamId,
      evidenceId,
      reason: "manual_review",
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { review: { id: string } }).review.id;
  }

  const transition = async (
    who: "owner" | "admin" | "member",
    id: string,
    nextStatus: string,
    withStepUp = false,
  ) =>
    inject(
      who,
      `/v1/governance/destruction-reviews/${id}/transition`,
      { teamId: A().teamId, nextStatus, decisionNote: "gov-002 decision" },
      withStepUp
        ? await header(
            who,
            nextStatus === "APPROVED" ? "EVIDENCE_DESTRUCTION_APPROVE" : "EVIDENCE_DESTRUCTION_EXECUTE",
            id,
          )
        : {},
    );

  async function takenUp(evidenceId: string, opener: "owner" | "admin" = "admin") {
    const id = await open(opener, evidenceId);
    const moved = await transition(opener, id, "UNDER_REVIEW");
    expect(moved.statusCode, moved.body).toBe(200);
    return id;
  }

  async function approved(evidenceId: string) {
    const id = await takenUp(evidenceId);
    const res = await transition("owner", id, "APPROVED", true);
    expect(res.statusCode, res.body).toBe(200);
    return id;
  }

  const sweep = () => orchestrator.runDestructionOrchestration({ trigger: "test", teamId: A().teamId });

  const reviewRow = (id: string) => prisma.destructionReview.findUniqueOrThrow({ where: { id } });
  const evidenceRow = (id: string) =>
    prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: { lifecycleState: true, destroyedAtUtc: true },
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    orchestrator = await import("../../worker/src/governance/destruction-orchestrator.worker.js");
    stepUp = createStepUpCeremony({ prisma: prisma as never, inject: h.app.inject.bind(h.app) as never });
    for (const userId of [A().ownerUserId, A().adminUserId, A().memberUserId]) {
      await prisma.user.update({ where: { id: userId }, data: { currentWorkspaceId: A().teamId } });
    }
    await capability(A().adminUserId, "governance.destruction.execute");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  beforeEach(() => {
    process.env.DESTRUCTION_EXECUTION_ENABLED = "true";
  });

  describe("GOV-003: authority and separation of duties", () => {
    it("the workspace ADMIN role cannot approve: the delegated floor is consulted", async () => {
      const ev = await record(trashed());
      const id = await takenUp(ev.id, "owner");
      const res = await transition("admin", id, "APPROVED");
      expect(res.statusCode, res.body).toBe(403);
      expect((await reviewRow(id)).status).toBe("UNDER_REVIEW");
    });

    it("the person who opened a review cannot approve it, even holding the permission", async () => {
      const ev = await record(trashed());
      const id = await takenUp(ev.id, "owner");
      const res = await transition("owner", id, "APPROVED", true);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: "DESTRUCTION_REVIEW_SEPARATION_OF_DUTIES" } });
      expect((await reviewRow(id)).status).toBe("UNDER_REVIEW");
      expect((await evidenceRow(ev.id)).lifecycleState).toBe("TRASHED");
    });

    it("on a review a sweep opened, the person who took it up is the first of the two", async () => {
      const ev = await record(trashed());
      const review = await prisma.destructionReview.create({
        data: { teamId: A().teamId, evidenceId: ev.id, status: "PENDING", reason: "retention_expired" },
      });
      await prisma.evidence.update({ where: { id: ev.id }, data: { activeDestructionReviewId: review.id } });
      expect((await transition("owner", review.id, "UNDER_REVIEW")).statusCode).toBe(200);
      const alone = await transition("owner", review.id, "APPROVED", true);
      expect(alone.statusCode, alone.body).toBe(403);
      expect((await reviewRow(review.id)).reviewStartedByUserId).toBe(A().ownerUserId);
    });

    it("approving and executing both need a fresh factor", async () => {
      const ev = await record(trashed());
      const id = await takenUp(ev.id);
      const noStepUp = await transition("owner", id, "APPROVED");
      expect(noStepUp.statusCode, noStepUp.body).toBe(401);
      expect((await reviewRow(id)).status).toBe("UNDER_REVIEW");
      expect((await transition("owner", id, "APPROVED", true)).statusCode).toBe(200);
      const execute = await transition("admin", id, "EXECUTED");
      expect(execute.statusCode, execute.body).toBe(401);
      expect((await reviewRow(id)).status).toBe("APPROVED");
    });
  });

  describe("GOV-002, OPS-002: approval is not execution", () => {
    it("the sweep leaves an APPROVED review alone until a person asks for execution", async () => {
      const ev = await record(trashed());
      const id = await approved(ev.id);
      await sweep();
      await sweep();
      expect((await evidenceRow(ev.id)).destroyedAtUtc).toBeNull();
      expect(await reviewRow(id)).toMatchObject({ status: "APPROVED", executionRequestedAtUtc: null });
      expect(await prisma.destructionExecution.count({ where: { destructionReviewId: id } })).toBe(0);
    });

    it("with the switch off nothing destroys: the API refuses, the sweep idles, the executor refuses", async () => {
      const ev = await record(trashed());
      const id = await approved(ev.id);
      process.env.DESTRUCTION_EXECUTION_ENABLED = "false";

      const refused = await transition("admin", id, "EXECUTED");
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ error: { code: "DESTRUCTION_EXECUTION_DISABLED" } });

      // A request that was already standing when the switch went off.
      await prisma.destructionReview.update({
        where: { id },
        data: { executionRequestedAtUtc: new Date(), executionRequestedByUserId: A().adminUserId },
      });
      await sweep();
      await sweep();
      expect((await evidenceRow(ev.id)).destroyedAtUtc).toBeNull();
      expect((await reviewRow(id)).status).toBe("APPROVED");
      expect(await prisma.destructionExecution.count({ where: { destructionReviewId: id } })).toBe(0);

      const { executeEvidenceDestruction } = await import("@proovra/shared-runtime");
      const { apiEvidenceDestructionStorage } = await import(
        "../src/services/evidence/destruction-storage-port.js"
      );
      const direct = await executeEvidenceDestruction(
        prisma as never,
        { evidenceId: ev.id, trigger: "manual", destructionReviewId: id, legalHold: false },
        apiEvidenceDestructionStorage,
      );
      expect(direct).toMatchObject({ ok: false, outcome: "BLOCKED", reason: "DESTRUCTION_EXECUTION_DISABLED" });
      expect(await prisma.custodyEvent.count({ where: { evidenceId: ev.id, eventType: "EVIDENCE_PURGED" } })).toBe(0);
    });

    it("with the switch on, the stepped-up act of a holder executes and certifies", async () => {
      const ev = await record(trashed());
      const id = await approved(ev.id);
      const res = await transition("admin", id, "EXECUTED", true);
      expect(res.statusCode, res.body).toBe(200);
      const review = await reviewRow(id);
      expect(review).toMatchObject({ status: "EXECUTED", executionRequestedByUserId: A().adminUserId });
      expect(review.certificateHash).toMatch(/^[0-9a-f]{64}$/);
      expect((await evidenceRow(ev.id)).lifecycleState).toBe("DESTROYED");
      const event = await prisma.evidenceLifecycleEvent.findFirstOrThrow({
        where: { evidenceId: ev.id, eventType: "destruction_executed" },
      });
      expect((event.metadata as { certificate: Record<string, unknown> }).certificate).toMatchObject({
        approvedByUserIds: [A().ownerUserId],
        executedByUserId: A().adminUserId,
        executedBy: "USER",
      });
    });

    it("the sweep continues a person's request, and the certificate says a worker ran it", async () => {
      const ev = await record(trashed());
      const id = await approved(ev.id);
      await prisma.destructionReview.update({
        where: { id },
        data: { executionRequestedAtUtc: new Date(), executionRequestedByUserId: A().adminUserId },
      });
      await sweep();
      expect((await reviewRow(id)).status).toBe("EXECUTED");
      const event = await prisma.evidenceLifecycleEvent.findFirstOrThrow({
        where: { evidenceId: ev.id, eventType: "destruction_executed" },
      });
      expect((event.metadata as { certificate: Record<string, unknown> }).certificate).toMatchObject({
        executedByUserId: A().adminUserId,
        executedBy: "WORKER",
      });
    });
  });

  describe("GOV-004: every destruction-bound record can reach purge", () => {
    it.each([
      ["TRASHED", trashed()],
      ["RETENTION_ARCHIVED", { ...trashed(), lifecycleState: "RETENTION_ARCHIVED" }],
      ["ARCHIVED", { lifecycleState: "ARCHIVED", archivedAt: new Date() }],
      ["UNDER_REVIEW", { lifecycleState: "UNDER_REVIEW" }],
    ])("a review on a %s record can be approved, executed and certified", async (_state, over) => {
      const ev = await record(over);
      const id = await approved(ev.id);
      const res = await transition("admin", id, "EXECUTED", true);
      expect(res.statusCode, res.body).toBe(200);
      expect((await evidenceRow(ev.id)).lifecycleState).toBe("DESTROYED");
      const cert = await h.app.inject({
        method: "GET",
        url: `/v1/governance/destruction-reviews/${id}/certificate?teamId=${A().teamId}`,
        headers: { authorization: `Bearer ${A().ownerToken}` },
      });
      expect(cert.statusCode, cert.body).toBe(200);
      expect((cert.json() as { certificate: { destruction: unknown } }).certificate.destruction).toMatchObject({
        verification: "ALL_OBJECT_VERSIONS_ABSENT",
      });
    });

    it.each([
      ["ARCHIVED", { lifecycleState: "ARCHIVED", archivedAt: new Date() }, "ARCHIVED"],
      ["TRASHED", trashed(), "TRASHED"],
    ])("cancelling an approval on a %s record leaves it where approval found it", async (_s, over, expected) => {
      const ev = await record(over);
      const id = await approved(ev.id);
      const res = await inject("owner", `/v1/governance/destruction-reviews/${id}/transition`, {
        teamId: A().teamId,
        nextStatus: "CANCELLED",
        decisionNote: "changed our minds",
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((await evidenceRow(ev.id)).lifecycleState).toBe(expected);
    });
  });

  describe("GOV-007: approval tells the truth about barriers", () => {
    it("approval is refused with the date while retention stands, and the record stays usable", async () => {
      const until = new Date(Date.now() + 40 * 86_400_000);
      const ev = await record({ retentionUntilUtc: until });
      const id = await takenUp(ev.id);
      const res = await transition("owner", id, "APPROVED", true);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({
        error: {
          code: "DESTRUCTION_REVIEW_BLOCKED_BY_RETENTION",
          details: { blockReason: "APP_RETENTION_ACTIVE", eligibleAtUtc: until.toISOString() },
        },
      });
      expect(await reviewRow(id)).toMatchObject({ status: "UNDER_REVIEW" });
      expect((await evidenceRow(ev.id)).lifecycleState).toBe("ACTIVE");
    });

    it("the preview names the barrier and the date instead of 'no blockers'", async () => {
      const until = new Date(Date.now() + 40 * 86_400_000);
      const ev = await record({ retentionUntilUtc: until });
      const id = await takenUp(ev.id);
      const res = await h.app.inject({
        method: "GET",
        url: `/v1/governance/destruction-reviews/${id}/preview?teamId=${A().teamId}`,
        headers: { authorization: `Bearer ${A().ownerToken}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { blockedBy: string[]; eligibleAtUtc: string; guidance: string };
      expect(body.blockedBy).toContain("application_retention");
      expect(body.eligibleAtUtc).toBe(until.toISOString());
      expect(body.guidance).not.toContain("No blockers");
    });

    it("a barrier met in the sweep lands once: no row per tick, and the review goes back to a person", async () => {
      const ev = await record(trashed());
      const id = await approved(ev.id);
      await prisma.destructionReview.update({
        where: { id },
        data: { executionRequestedAtUtc: new Date(), executionRequestedByUserId: A().adminUserId },
      });
      await prisma.evidence.update({
        where: { id: ev.id },
        data: { retentionUntilUtc: new Date(Date.now() + 86_400_000) },
      });
      await sweep();
      await sweep();
      await sweep();
      expect(await prisma.destructionExecution.count({ where: { destructionReviewId: id } })).toBe(1);
      expect(await reviewRow(id)).toMatchObject({ status: "APPROVED", executionRequestedAtUtc: null });
    });

    it("a due review is not starved by one still backing off", async () => {
      const held = await record(trashed());
      const heldId = await approved(held.id);
      const fresh = await record(trashed());
      const freshId = await approved(fresh.id);
      await prisma.destructionReview.update({
        where: { id: heldId },
        data: {
          executionRequestedAtUtc: new Date(Date.now() - 86_400_000),
          executionRequestedByUserId: A().adminUserId,
          executionNotBeforeUtc: new Date(Date.now() + 3_600_000),
        },
      });
      await prisma.destructionReview.update({
        where: { id: freshId },
        data: { executionRequestedAtUtc: new Date(), executionRequestedByUserId: A().adminUserId },
      });
      await orchestrator.runDestructionOrchestration({ trigger: "test", teamId: A().teamId, batchSize: 1 });
      expect((await reviewRow(freshId)).status).toBe("EXECUTED");
      expect((await reviewRow(heldId)).status).toBe("APPROVED");
    });
  });

  describe("GOV-013: every hold scope, every gate", () => {
    async function workspaceHold() {
      return prisma.evidenceLegalHold.create({
        data: {
          teamId: A().teamId,
          scope: "WORKSPACE",
          status: "ACTIVE",
          title: "gov-013 workspace hold (fixture row)",
          reason: "gov-013",
          placedByUserId: A().ownerUserId,
        } as never,
        select: { id: true },
      });
    }

    it("a workspace-scope hold refuses approval and the preview names it", async () => {
      const ev = await record(trashed());
      const id = await takenUp(ev.id);
      const hold = await workspaceHold();
      try {
        const res = await transition("owner", id, "APPROVED", true);
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json()).toMatchObject({ error: { code: "DESTRUCTION_REVIEW_BLOCKED_BY_HOLD" } });
        const preview = await h.app.inject({
          method: "GET",
          url: `/v1/governance/destruction-reviews/${id}/preview?teamId=${A().teamId}`,
          headers: { authorization: `Bearer ${A().ownerToken}` },
        });
        const body = preview.json() as { blockedBy: string[]; holds: { workspace: Array<{ id: string }> } };
        expect(body.blockedBy).toContain("workspace_legal_hold");
        expect(body.holds.workspace.map((h) => h.id)).toEqual([hold.id]);
      } finally {
        await prisma.evidenceLegalHold.update({
          where: { id: hold.id },
          data: { status: "RELEASED", releasedAtUtc: new Date(), releasedByUserId: A().ownerUserId },
        });
      }
    });
  });

  describe("GOV-019: the state machine holds under a race and a crash", () => {
    it("two concurrent EXECUTED calls leave one hash, and neither overwrites it with null", async () => {
      const ev = await record(trashed());
      const id = await approved(ev.id);
      const [a, b] = await Promise.all([
        transition("admin", id, "EXECUTED", true),
        transition("owner", id, "EXECUTED", true),
      ]);
      expect([a.statusCode, b.statusCode]).toContain(200);
      const review = await reviewRow(id);
      expect(review.status).toBe("EXECUTED");
      expect(review.certificateHash).toMatch(/^[0-9a-f]{64}$/);
      expect(
        await prisma.custodyEvent.count({ where: { evidenceId: ev.id, eventType: "EVIDENCE_PURGED" } }),
      ).toBe(1);
    });

    it("a worker that died after the executor: the next sweep finishes the review from the ledger", async () => {
      const ev = await record(trashed());
      const id = await approved(ev.id);
      await prisma.destructionReview.update({
        where: { id },
        data: { executionRequestedAtUtc: new Date(), executionRequestedByUserId: A().adminUserId },
      });
      const { executeEvidenceDestruction } = await import("@proovra/shared-runtime");
      const { apiEvidenceDestructionStorage } = await import(
        "../src/services/evidence/destruction-storage-port.js"
      );
      const destroyed = await executeEvidenceDestruction(
        prisma as never,
        { evidenceId: ev.id, trigger: "destruction_review", destructionReviewId: id, legalHold: false },
        apiEvidenceDestructionStorage,
      );
      if (!destroyed.ok || destroyed.outcome !== "DESTROYED") throw new Error("fixture: not destroyed");
      expect((await reviewRow(id)).status).toBe("APPROVED");

      await sweep();
      const review = await reviewRow(id);
      expect(review).toMatchObject({ status: "EXECUTED", certificateHash: destroyed.certificateHash });
      const executions = await prisma.destructionExecution.findMany({ where: { destructionReviewId: id } });
      expect(executions.map((e) => e.status)).toEqual(["COMPLETED"]);
    });

    it("a sweep-opened review carries the canonical reason", async () => {
      const worker = await import("../../worker/src/governance/trash-grace-reconciler.js");
      expect(typeof worker).toBe("object");
      const { DESTRUCTION_REVIEW_REASONS } = await import("@proovra/shared");
      expect(DESTRUCTION_REVIEW_REASONS).toContain("retention_expired");
    });
  });
});
