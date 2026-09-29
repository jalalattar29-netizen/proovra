/**
 * ET-ACQ-02 / ET-DC-05 — abandoned reservations are released; live ones never.
 *
 * Drives the Worker's releaseExpiredReservations (the canonical capture sweep)
 * against live PostgreSQL 16 through THE reservation authority
 * (@proovra/shared-runtime evidence-reservation).
 *
 * On a40ca76f nothing ended an ACTIVE/INTERRUPTED direct-capture session past
 * its expiry (the reaper touched DRAFT only), and an interrupted web capture's
 * CREATED/UPLOADING record stayed forever — listed nowhere, never reaped, its
 * part objects orphaned. orphan-scan only counted.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const DAY = 24 * 60 * 60 * 1000;

describe("reservation sweep (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let reaper: typeof import("../../worker/src/capture-reaper.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    reaper = await import("../../worker/src/capture-reaper.js");
  }, 180_000);
  afterAll(async () => {
    await harness?.cleanup();
  });

  async function reservation(opts: { ageMs: number; status?: "CREATED" | "UPLOADING" | "SIGNED" }) {
    const A = harness.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: {
        title: `reservation ${randomUUID().slice(0, 6)}`,
        type: "PHOTO",
        status: opts.status ?? "UPLOADING",
        teamId: A.teamId,
        organizationId: team.organizationId,
        ownerUserId: A.ownerUserId,
      } as never,
      select: { id: true },
    });
    await prisma.evidencePart.create({
      data: {
        evidenceId: ev.id,
        partIndex: 0,
        storageBucket: "sweep-bucket",
        storageKey: `parts/${ev.id}/0`,
        mimeType: "image/jpeg",
      } as never,
    });
    const at = new Date(Date.now() - opts.ageMs);
    await prisma.$executeRaw`UPDATE evidence SET created_at = ${at}, updated_at = ${at} WHERE id = ${ev.id}::uuid`;
    return ev.id;
  }

  async function state(id: string) {
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { deletedAt: true, status: true } });
    const deleted = await prisma.custodyEvent.findMany({
      where: { evidenceId: id, eventType: "EVIDENCE_DELETED" },
      select: { payload: true },
    });
    return { deletedAt: ev.deletedAt, status: String(ev.status), deleted: deleted.map((d) => (d.payload as { reason?: string }).reason) };
  }

  it("contrast (the prior tree's only sweep): the draft reaper leaves an abandoned reservation and an expired ACTIVE session untouched", async () => {
    const id = await reservation({ ageMs: 2 * DAY });
    const A = harness.fixtures.teamA;
    const session = await prisma.captureSession.create({
      data: { ownerUserId: A.ownerUserId, teamId: A.teamId, status: "ACTIVE", expiresAtUtc: new Date(Date.now() - 60_000) } as never,
      select: { id: true },
    });
    await reaper.reapExpiredCaptureDrafts({ trigger: "contrast" });
    expect((await state(id)).deletedAt).toBeNull();
    expect((await prisma.captureSession.findUniqueOrThrow({ where: { id: session.id }, select: { status: true } })).status).toBe("ACTIVE");
    // The canonical sweep then ends both.
    await reaper.releaseExpiredReservations({ trigger: "test" });
    expect((await state(id)).deleted).toEqual(["RESERVATION_EXPIRED"]);
  });

  it("ET-ACQ-02: an abandoned web reservation past the window is released, and its part object removal requested", async () => {
    const id = await reservation({ ageMs: 2 * DAY });
    const deleted: string[] = [];
    await reaper.releaseExpiredReservations({ trigger: "test", deleteObject: async (o) => void deleted.push(o.key) });
    const s = await state(id);
    expect(s.deletedAt).not.toBeNull();
    expect(s.deleted).toEqual(["RESERVATION_EXPIRED"]);
    expect(deleted).toContain(`parts/${id}/0`);
  });

  it("a reservation inside the window, and a signed record of any age, are never touched", async () => {
    const fresh = await reservation({ ageMs: 60 * 60 * 1000 });
    const signed = await reservation({ ageMs: 30 * DAY, status: "SIGNED" });
    await reaper.releaseExpiredReservations({ trigger: "test" });
    expect((await state(fresh)).deletedAt).toBeNull();
    expect((await state(signed)).deletedAt).toBeNull();
    expect((await state(signed)).deleted).toEqual([]);
  });

  it("a reservation held by a live direct-capture session is kept", async () => {
    const id = await reservation({ ageMs: 2 * DAY });
    const A = harness.fixtures.teamA;
    await prisma.captureSession.create({
      data: { ownerUserId: A.ownerUserId, teamId: A.teamId, status: "ACTIVE", finalizedEvidenceId: id, expiresAtUtc: new Date(Date.now() + 60 * 60 * 1000) } as never,
    });
    await reaper.releaseExpiredReservations({ trigger: "test" });
    expect((await state(id)).deletedAt).toBeNull();
  });

  it("ET-DC-05: an ACTIVE direct-capture session past expiry is ended EXPIRED and its reservation released", async () => {
    const id = await reservation({ ageMs: 2 * 60 * 60 * 1000 }); // young record: released because the SESSION expired
    const A = harness.fixtures.teamA;
    const session = await prisma.captureSession.create({
      data: { ownerUserId: A.ownerUserId, teamId: A.teamId, status: "ACTIVE", finalizedEvidenceId: id, expiresAtUtc: new Date(Date.now() - 60_000) } as never,
      select: { id: true },
    });
    await reaper.releaseExpiredReservations({ trigger: "test" });
    const row = await prisma.captureSession.findUniqueOrThrow({ where: { id: session.id }, select: { status: true, endReason: true } });
    expect(row).toMatchObject({ status: "EXPIRED", endReason: "EXPIRED" });
    expect((await state(id)).deleted).toEqual(["CAPTURE_SESSION_EXPIRED"]);
  });

  it("concurrent sweeps release a reservation exactly once", async () => {
    const id = await reservation({ ageMs: 3 * DAY });
    await Promise.all([
      reaper.releaseExpiredReservations({ trigger: "race-a" }),
      reaper.releaseExpiredReservations({ trigger: "race-b" }),
      reaper.releaseExpiredReservations({ trigger: "race-c" }),
    ]);
    expect((await state(id)).deleted).toEqual(["RESERVATION_EXPIRED"]);
  });
});
