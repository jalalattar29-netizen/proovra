/**
 * GOV-005 — a named retention policy governs the records it claims to, through the
 * real creation writer, the real reconciler and the real executor.
 *
 * Before this nothing wrote `Evidence.retentionPolicyVersionId`, so "immutable"
 * blocked nothing, a policy's days changed no date, and the Phase 4B gate had no
 * caller.
 *
 * FIXTURES (labelled): policies come through the real create functions; a Phase 4B
 * template policy is written as a row; capability and step-up rows are not needed
 * because the service functions are called directly here (the routes are proven
 * in gov-002).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { executeEvidenceDestruction } from "@proovra/shared-runtime";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedExecutableReview } from "./support/executable-destruction-review.js";

describe("GOV-005 named retention policies bind to records (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let engine: typeof import("../src/services/governance-lifecycle/retention-engine.service.js");
  let evidenceService: typeof import("../src/services/evidence.service.js");
  let reviews: typeof import("../src/services/governance-lifecycle/destruction-review.service.js");
  let reconciler: typeof import("../../worker/src/governance/retention-reconciliation.worker.js");
  let storage: (typeof import("../src/services/evidence/destruction-storage-port.js"))["apiEvidenceDestructionStorage"];

  const A = () => h.fixtures.teamA;
  const created: string[] = [];

  async function policy(over: Record<string, unknown>) {
    const row = await engine.createRetentionPolicy({
      teamId: A().teamId,
      displayName: `gov-005 ${Math.random()}`,
      scope: "WORKSPACE",
      actorUserId: A().ownerUserId,
      ...over,
    } as never);
    created.push(row.id);
    return row;
  }

  async function record(over: Record<string, unknown> = {}) {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: A().teamId },
      select: { organizationId: true },
    });
    return prisma.evidence.create({
      data: {
        title: "gov-005 record",
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

  async function createThroughWriter() {
    const result = await evidenceService.createEvidence({
      ownerUserId: A().ownerUserId,
      teamId: A().teamId,
      type: "PHOTO",
      mimeType: "image/jpeg",
      originalFileName: "gov-005.jpg",
      captureFileName: null,
      acquisitionMode: "PROOVRA_WEB_UPLOAD",
    } as never);
    return (result as unknown as { id: string }).id;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    engine = await import("../src/services/governance-lifecycle/retention-engine.service.js");
    evidenceService = await import("../src/services/evidence.service.js");
    reviews = await import("../src/services/governance-lifecycle/destruction-review.service.js");
    reconciler = await import("../../worker/src/governance/retention-reconciliation.worker.js");
    // Fixture: a workspace on a plan that may create shared evidence.
    await prisma.team.update({
      where: { id: A().teamId },
      data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never,
    });
    ({ apiEvidenceDestructionStorage: storage } = await import(
      "../src/services/evidence/destruction-storage-port.js"
    ));
  }, 900_000);

  afterEach(async () => {
    for (const id of created.splice(0)) {
      await prisma.evidenceRetentionPolicy.update({ where: { id }, data: { status: "ARCHIVED" } });
    }
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("a new record is stamped with the policy version and its date, and custody says so", async () => {
    const p = await policy({ retentionDays: 400 });
    const before = Date.now();
    const id = await createThroughWriter();
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: { retentionPolicyVersionId: true, retentionUntilUtc: true },
    });
    const version = await prisma.evidenceRetentionPolicyVersion.findFirstOrThrow({
      where: { retentionPolicyId: p.id },
    });
    expect(row.retentionPolicyVersionId).toBe(version.id);
    expect(row.retentionUntilUtc!.getTime()).toBeGreaterThanOrEqual(before + 399 * 86_400_000);
    const custody = await prisma.custodyEvent.findFirstOrThrow({
      where: { evidenceId: id, eventType: "RETENTION_POLICY_APPLIED" },
    });
    expect(custody.payload).toMatchObject({ retentionPolicyVersionId: version.id, source: "retention_policy" });
  });

  it("immutable means immutable: approval is refused and the executor refuses even with an approved review", async () => {
    await policy({ retentionDays: 0, immutable: true });
    const id = await createThroughWriter();
    await prisma.evidence.update({
      where: { id },
      data: {
        lifecycleState: "TRASHED",
        deletedAt: new Date(Date.now() - 86_400_000),
        deleteScheduledForUtc: new Date(Date.now() - 86_400_000),
        retentionUntilUtc: new Date(Date.now() - 1000),
      },
    });
    const review = await prisma.destructionReview.create({
      data: {
        teamId: A().teamId,
        evidenceId: id,
        status: "UNDER_REVIEW",
        reason: "manual_review",
        initiatedByUserId: A().ownerUserId,
      },
      select: { id: true },
    });
    await expect(
      reviews.transitionDestructionReview({
        teamId: A().teamId,
        id: review.id,
        actorUserId: A().adminUserId,
        nextStatus: "APPROVED",
        decisionNote: "approve an immutable record",
      }),
    ).rejects.toMatchObject({ code: "DESTRUCTION_REVIEW_BLOCKED_BY_IMMUTABLE" });

    await prisma.destructionReview.update({
      where: { id: review.id },
      data: { status: "APPROVED", executionRequestedAtUtc: new Date(), executionRequestedByUserId: A().ownerUserId },
    });
    const res = await executeEvidenceDestruction(
      prisma as never,
      { evidenceId: id, trigger: "destruction_review", destructionReviewId: review.id, legalHold: false },
      storage,
    );
    expect(res).toMatchObject({ ok: false, outcome: "BLOCKED", reason: "RETENTION_POLICY_IMMUTABLE" });
    expect(await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "EVIDENCE_PURGED" } })).toBe(0);
  });

  it("a record created before the policy is extended at expiry, never shortened, and no review opens", async () => {
    await policy({ retentionDays: 3650 });
    const old = await record({ retentionUntilUtc: new Date(Date.now() - 86_400_000) });
    await reconciler.runRetentionReconciliation({ trigger: "test", teamId: A().teamId });
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: old.id },
      select: { retentionUntilUtc: true, retentionPolicyVersionId: true, activeDestructionReviewId: true },
    });
    expect(row.retentionUntilUtc!.getTime()).toBeGreaterThan(Date.now());
    expect(row.retentionPolicyVersionId).not.toBeNull();
    expect(row.activeDestructionReviewId).toBeNull();
    expect(await prisma.custodyEvent.count({ where: { evidenceId: old.id, eventType: "RETENTION_POLICY_APPLIED" } })).toBe(1);
  });

  it("a policy shorter than the date already on the record never moves it earlier", async () => {
    await policy({ retentionDays: 1 });
    const until = new Date(Date.now() + 500 * 86_400_000);
    const id = await createThroughWriter();
    await prisma.evidence.update({ where: { id }, data: { retentionUntilUtc: until } });
    await reconciler.runRetentionReconciliation({ trigger: "test", teamId: A().teamId });
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { retentionUntilUtc: true } });
    expect(row.retentionUntilUtc!.toISOString()).toBe(until.toISOString());
  });

  it("a Phase 4B template policy stands between a record and its destruction, with its date", async () => {
    const rule = await prisma.retentionPolicyConfig.create({
      data: {
        teamId: A().teamId,
        name: "gov-005 template (fixture row)",
        template: "CUSTOM",
        years: 7,
        scopeKind: "WORKSPACE",
        scopeTargetId: null,
        createdByUserId: A().ownerUserId,
      },
      select: { id: true },
    });
    try {
      const ev = await record();
      const review = await prisma.destructionReview.create({
        data: {
          teamId: A().teamId,
          evidenceId: ev.id,
          status: "UNDER_REVIEW",
          reason: "manual_review",
          initiatedByUserId: A().ownerUserId,
        },
        select: { id: true },
      });
      await expect(
        reviews.transitionDestructionReview({
          teamId: A().teamId,
          id: review.id,
          actorUserId: A().adminUserId,
          nextStatus: "APPROVED",
          decisionNote: "too young",
        }),
      ).rejects.toMatchObject({
        code: "DESTRUCTION_REVIEW_BLOCKED_BY_RETENTION",
        details: { blockReason: "APP_RETENTION_ACTIVE" },
      });
    } finally {
      await prisma.retentionPolicyConfig.update({ where: { id: rule.id }, data: { state: "RELEASED" } });
    }
  });

  it("POSITIVE CONTROL: with no policy a record is not bound and its destruction proceeds", async () => {
    const past = new Date(Date.now() - 86_400_000);
    const ev = await record({ lifecycleState: "TRASHED", deletedAt: past, deleteScheduledForUtc: past });
    await seedExecutableReview(prisma as never, ev.id);
    const res = await executeEvidenceDestruction(
      prisma as never,
      { evidenceId: ev.id, trigger: "manual", legalHold: false },
      storage,
    );
    expect(res).toMatchObject({ ok: true, outcome: "DESTROYED" });
  });
});
