/**
 * ET-SEC-01 / ET-SEC-06 / ET-SEC-12 — Invariant E, legal hold wins, and
 * restore and destruction never both succeed. Live PostgreSQL 16; the storage
 * port is an honest in-memory store (the S3 boundary), every decision is the
 * production code.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("legal hold × destruction × restore (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let holds: typeof import("../src/services/governance/legal-hold.service.js");
  let executeEvidenceDestruction: (typeof import("@proovra/shared-runtime"))["executeEvidenceDestruction"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    holds = await import("../src/services/governance/legal-hold.service.js");
    ({ executeEvidenceDestruction } = await import("@proovra/shared-runtime"));
  }, 180_000);
  afterAll(async () => { await h?.cleanup(); });

  async function trashedPastGrace() {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: {
        title: "trashed", type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId,
        lifecycleState: "TRASHED", deletedAt: new Date(Date.now() - 40 * 86_400_000), deleteScheduledForUtc: new Date(Date.now() - 86_400_000),
        storageBucket: "fixture-bucket", storageKey: `evidence/${randomUUID()}/original.png`,
      } as never,
      select: { id: true },
    });
  }
  function honestStore() {
    const deleted = new Set<string>();
    return {
      deleted,
      port: {
        async listObjectVersions({ key }: { bucket: string; key: string }) {
          return deleted.has(key) ? [] : [{ versionId: "v1", isDeleteMarker: false, isLatest: true, retainUntil: null, lockMode: null, legalHold: false }];
        },
        async listKeysUnderPrefix() { return []; },
        async deleteObjectVersion({ key }: { bucket: string; key: string; versionId: string }) { deleted.add(key); return { ok: true }; },
      },
    };
  }
  const hold = (evidenceId: string, title = "hold") =>
    holds.placeCanonicalLegalHold({ teamId: h.fixtures.teamA.teamId, scope: "EVIDENCE", evidenceId, actorUserId: h.fixtures.teamA.ownerUserId, title });

  it("two ACTIVE holds block; after both are released the record can be destroyed; a retry is an idempotent no-op", async () => {
    const ev = await trashedPastGrace();
    const h1 = await hold(ev.id, "first");
    const h2 = await hold(ev.id, "second");
    const store = honestStore();
    const blocked = await executeEvidenceDestruction(prisma as never, { evidenceId: ev.id, trigger: "manual", legalHold: false }, store.port as never);
    expect(blocked).toMatchObject({ ok: false, outcome: "BLOCKED", reason: "LEGAL_HOLD_ACTIVE" });
    expect(store.deleted.size).toBe(0);
    // The refused decision left no claim behind.
    expect(await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id }, select: { lifecycleState: true, destructionClaimedAtUtc: true } })).toEqual({ lifecycleState: "TRASHED", destructionClaimedAtUtc: null });
    for (const x of [h1, h2]) {
      await holds.releaseCanonicalLegalHold({ teamId: h.fixtures.teamA.teamId, holdId: x.id, actorUserId: h.fixtures.teamA.ownerUserId, releaseNote: "released for the test" });
    }
    const done = await executeEvidenceDestruction(prisma as never, { evidenceId: ev.id, trigger: "manual", legalHold: false }, store.port as never);
    expect(done.outcome).toBe("DESTROYED");
    const again = await executeEvidenceDestruction(prisma as never, { evidenceId: ev.id, trigger: "manual", legalHold: false }, store.port as never);
    expect(again).toEqual({ ok: true, outcome: "ALREADY_DESTROYED" });
  });

  it("an evidence-scope hold arriving after the executor decided is refused honestly, not recorded", async () => {
    const ev = await trashedPastGrace();
    // The decided state the executor commits: PENDING_DESTRUCTION + claim stamp.
    await prisma.evidence.update({ where: { id: ev.id }, data: { lifecycleState: "PENDING_DESTRUCTION", destructionClaimedAtUtc: new Date() } as never });
    await expect(hold(ev.id)).rejects.toMatchObject({ code: "destruction_committed", statusCode: 409 });
    expect(await prisma.evidenceLegalHold.count({ where: { evidenceId: ev.id } })).toBe(0);
  });

  it("a governance-approved record (PENDING_DESTRUCTION, no claim yet) still accepts a hold, and the hold then stops the executor", async () => {
    const ev = await trashedPastGrace();
    await prisma.evidence.update({ where: { id: ev.id }, data: { lifecycleState: "PENDING_DESTRUCTION", destructionClaimedAtUtc: null } as never });
    await hold(ev.id);
    const store = honestStore();
    const r = await executeEvidenceDestruction(prisma as never, { evidenceId: ev.id, trigger: "destruction_review", legalHold: false }, store.port as never);
    expect(r).toMatchObject({ ok: false, outcome: "BLOCKED", reason: "LEGAL_HOLD_ACTIVE" });
    expect(store.deleted.size).toBe(0);
  });

  it("ET-SEC-06: restore is refused while the executor holds a decided claim", async () => {
    const A = h.fixtures.teamA;
    const ev = await trashedPastGrace();
    await prisma.evidence.update({ where: { id: ev.id }, data: { lifecycleState: "PENDING_DESTRUCTION", destructionClaimedAtUtc: new Date() } as never });
    const res = await h.app.inject({ method: "POST", url: `/v1/evidence/${ev.id}/restore`, headers: { authorization: `Bearer ${A.ownerToken}` }, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain("DESTRUCTION_IN_PROGRESS");
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id }, select: { lifecycleState: true } })).lifecycleState).toBe("PENDING_DESTRUCTION");
  });

  it("ET-SEC-12 (STATEMACHINE-04): an operator transition cannot resurrect a record the executor is destroying", async () => {
    const A = h.fixtures.teamA;
    const ev = await trashedPastGrace();
    await prisma.evidence.update({ where: { id: ev.id }, data: { lifecycleState: "PENDING_DESTRUCTION", destructionClaimedAtUtc: new Date() } as never });
    const { transitionLifecycle } = await import("../src/services/governance-lifecycle/lifecycle-orchestrator.service.js");
    await expect(
      transitionLifecycle({ teamId: A.teamId, evidenceId: ev.id, toState: "ACTIVE", actorUserId: A.ownerUserId, summary: "operator restore" } as never),
    ).rejects.toMatchObject({ code: "LIFECYCLE_INVALID_TRANSITION" });
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id }, select: { lifecycleState: true } })).lifecycleState).toBe("PENDING_DESTRUCTION");
  });

  it("ET-SEC-12: two concurrent restores of one trashed record produce exactly one state change and one custody event", async () => {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: { title: "trashed recent", type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId, lifecycleState: "TRASHED", deletedAt: new Date(), deleteScheduledForUtc: new Date(Date.now() + 30 * 86_400_000) } as never,
      select: { id: true },
    });
    const call = () => h.app.inject({ method: "POST", url: `/v1/evidence/${ev.id}/restore`, headers: { authorization: `Bearer ${A.ownerToken}` }, payload: {} });
    const [a, b] = await Promise.all([call(), call()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 200]);
    const restoredEvents = await prisma.custodyEvent.count({ where: { evidenceId: ev.id, eventType: "EVIDENCE_RESTORED" } });
    expect(restoredEvents).toBe(1);
  });
});
