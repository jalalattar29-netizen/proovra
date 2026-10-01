/**
 * Governed destruction from the Destruction page — the approval QUEUES the record.
 *
 * Found by the remediation journey J13: a review opened on an ACTIVE record
 * (the only kind the Destruction page can open) and approved could never be
 * executed — the lifecycle table has no ACTIVE -> DESTROYED edge and nothing
 * moved the record to PENDING_DESTRUCTION, so EXECUTED always answered 409
 * DESTRUCTION_REVIEW_BLOCKED_BY_LIFECYCLE / LIFECYCLE_INVALID_TRANSITION.
 *
 * Approval now moves the record ACTIVE -> PENDING_DESTRUCTION through the
 * lifecycle orchestrator before the review is marked APPROVED; cancelling an
 * approved review returns it to ACTIVE; a hold still wins over the approval.
 * The executor itself (delete + verify + certificate) is proven against real
 * storage by evidence-destruction-storage and by journey J13 on MinIO.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("destruction review approval queues the record (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let svc: typeof import("../src/services/governance-lifecycle/destruction-review.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    svc = await import("../src/services/governance-lifecycle/destruction-review.service.js");
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  async function activeRecord() {
    const a = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: a.teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: {
        title: "approval queues",
        type: "PHOTO",
        status: "SIGNED",
        mimeType: "image/jpeg",
        teamId: a.teamId,
        organizationId: team.organizationId,
        ownerUserId: a.ownerUserId,
      } as never,
      select: { id: true },
    });
  }

  const lifecycleOf = async (id: string) =>
    (await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { lifecycleState: true } })).lifecycleState;

  async function reviewUnderReview(evidenceId: string) {
    const a = h.fixtures.teamA;
    const review = await svc.createDestructionReview({
      teamId: a.teamId,
      evidenceId,
      reason: "manual_review",
      actorUserId: a.ownerUserId,
    } as never);
    await svc.transitionDestructionReview({
      teamId: a.teamId,
      id: review.id,
      nextStatus: "UNDER_REVIEW",
      actorUserId: a.ownerUserId,
    } as never);
    return review.id;
  }

  const transition = (id: string, nextStatus: string) =>
    svc.transitionDestructionReview({
      teamId: h.fixtures.teamA.teamId,
      id,
      nextStatus,
      decisionNote: "approval-queues test",
      actorUserId: h.fixtures.teamA.ownerUserId,
    } as never);

  it("approving a review on an ACTIVE record moves it to PENDING_DESTRUCTION (the state EXECUTED can leave)", async () => {
    const ev = await activeRecord();
    const id = await reviewUnderReview(ev.id);
    expect(await lifecycleOf(ev.id)).toBe("ACTIVE");
    await transition(id, "APPROVED");
    expect(await lifecycleOf(ev.id)).toBe("PENDING_DESTRUCTION");
    const events = await prisma.evidenceLifecycleEvent.findMany({
      where: { evidenceId: ev.id, toState: "PENDING_DESTRUCTION" },
      select: { fromState: true },
    });
    expect(events.map((e) => e.fromState)).toContain("ACTIVE");
  });

  it("cancelling an approved review releases the record back to ACTIVE", async () => {
    const ev = await activeRecord();
    const id = await reviewUnderReview(ev.id);
    await transition(id, "APPROVED");
    await transition(id, "CANCELLED");
    expect(await lifecycleOf(ev.id)).toBe("ACTIVE");
  });

  it("a hold placed before approval still wins: no approval, the record stays ACTIVE", async () => {
    const ev = await activeRecord();
    const id = await reviewUnderReview(ev.id);
    await prisma.evidenceLegalHold.create({
      data: {
        teamId: h.fixtures.teamA.teamId, evidenceId: ev.id, scope: "EVIDENCE", status: "ACTIVE",
        title: "approval-queues hold", reason: "approval-queues test", placedByUserId: h.fixtures.teamA.ownerUserId,
      } as never,
    });
    await expect(transition(id, "APPROVED")).rejects.toMatchObject({ code: "DESTRUCTION_REVIEW_BLOCKED_BY_HOLD" });
    expect(await lifecycleOf(ev.id)).toBe("ACTIVE");
    expect((await prisma.destructionReview.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("UNDER_REVIEW");
  });
});
