/**
 * LEGACY LIFECYCLE RECONCILIATION (2026-10-15) — executed proof.
 *
 * Production (read-only inspection): 17 rows ACTIVE while carrying a deletion
 * marker across 11 workspaces; 70 incomplete uploads carrying deletion or a
 * non-active lifecycle; one workspace with SIX rows but TWO consistent active
 * records, whose Home said "6 unlinked records".
 *
 * WHAT IS REAL: PostgreSQL 16 with every migration, the HTTP API (Home's command center, the Evidence Library
 * summary), the ONE population authority and the owner-run reconciliation
 * command. Nothing is doubled.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const DAY = 24 * 60 * 60 * 1000;

describe("legacy evidence lifecycle — one population, Home counts 2 not 6, bounded reconciliation", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let backfill: typeof import("../src/scripts/three-decisions-backfill.js");
  let runtime: typeof import("@proovra/shared-runtime");
  const ids: Record<string, string> = {};
  const W = { teamId: "" };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    backfill = await import("../src/scripts/three-decisions-backfill.js");
    // A dedicated workspace owned by teamA's owner: the six rows below are
    // the ONLY rows in it, exactly the shape the inspection found.
    const owner = h.fixtures.teamA.ownerUserId;
    W.teamId = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name: `Reem-shaped ${randomUUID().slice(0, 8)}`, billingOwnerUserId: owner, status: "ACTIVE", kind: "CUSTOMER" } as never,
        select: { id: true },
      });
      await tx.organizationMembership.create({ data: { organizationId: org.id, userId: owner, role: "ORG_OWNER" } as never });
      const team = await tx.team.create({
        data: { name: "Reem-shaped workspace", ownerUserId: owner, isPersonal: false, organizationId: org.id, workspaceKind: "ORGANIZATION" } as never,
        select: { id: true },
      });
      await tx.teamMember.create({ data: { teamId: team.id, userId: owner, role: "OWNER", status: "ACTIVE" } as never });
      return team.id;
    });
  }, 600_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 120_000);

  const A = () => h.fixtures.teamA;
  const get = (url: string) => h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${A().ownerToken}` } });

  /** One row exactly as given — including the LEGACY shapes no current code path writes. */
  async function row(data: Record<string, unknown>, opts: { updatedAt?: Date } = {}) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: W.teamId }, select: { organizationId: true } });
    const { id } = await prisma.evidence.create({
      data: { type: "DOCUMENT", teamId: W.teamId, organizationId: team.organizationId, ownerUserId: A().ownerUserId, ...data } as never,
      select: { id: true },
    });
    if (opts.updatedAt) await prisma.$executeRaw`UPDATE evidence SET updated_at = ${opts.updatedAt}, created_at = ${opts.updatedAt} WHERE id = ${id}::uuid`;
    return id;
  }

  const unlinked = async () => {
    const res = await get(`/v1/dashboard/command-center?teamId=${W.teamId}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().sections.caseOperations.data.unlinkedEvidenceCount as number;
  };

  it("REEM-SHAPED WORKSPACE: six rows, two consistent active records — Home and the Library both say 2", async () => {
    expect(await prisma.evidence.count({ where: { teamId: W.teamId } })).toBe(0);
    const now = Date.now();
    ids.active1 = await row({ status: "REPORTED", lifecycleState: "ACTIVE", signedAtUtc: new Date(now - 10 * DAY) });
    ids.active2 = await row({ status: "REPORTED", lifecycleState: "ACTIVE", signedAtUtc: new Date(now - 9 * DAY) });
    // Three released upload reservations (UPLOADING, lifecycle ACTIVE, legacy deleted_at).
    for (const k of ["released1", "released2", "released3"]) {
      ids[k] = await row({ status: "UPLOADING", lifecycleState: "ACTIVE", deletedAt: new Date(now - 5 * DAY) });
    }
    // One incomplete upload in Trash.
    ids.trashedUpload = await row({ status: "UPLOADING", lifecycleState: "TRASHED", deletedAt: new Date(now - 3 * DAY), deletedAtUtc: new Date(now - 3 * DAY) });
    expect(await prisma.evidence.count({ where: { teamId: W.teamId } })).toBe(6);

    expect(await unlinked()).toBe(2);
    const summary = await get(`/v1/evidence/library-summary?teamId=${W.teamId}`);
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json()).toMatchObject({ totalActiveRecords: 2, unassignedCount: 2 });
    const list = await get(`/v1/evidence?scope=active&teamId=${W.teamId}`);
    const listed = (list.json().items as Array<{ id: string }>).map((i) => i.id).sort();
    expect(listed).toEqual([ids.active1, ids.active2].sort());

    // Every row in exactly one class; the four incomplete uploads are abandoned, not Trash.
    const dry = await backfill.reconcileEvidenceLifecycle({ teamId: W.teamId });
    expect(dry.scanned).toBe(6);
    expect(dry.byClass).toMatchObject({ ACTIVE: 2, ABANDONED_UPLOAD: 4, TRASH: 0, RETENTION_ARCHIVE: 0, MANUAL_REVIEW: 0 });
    expect(Object.values(dry.byClass).reduce((a, b) => a + b, 0)).toBe(6);
  }, 120_000);

  it("a LEGACY completed record still ACTIVE but carrying a deletion marker (either column) never counts as active", async () => {
    ids.legacyDeleted = await row({
      status: "REPORTED",
      lifecycleState: "ACTIVE",
      signedAtUtc: new Date(Date.now() - 400 * DAY),
      deletedAt: new Date(Date.now() - 120 * DAY),
      fileSha256: "a".repeat(64),
    });
    ids.legacyDeletedUtc = await row({ status: "SIGNED", lifecycleState: "ACTIVE", signedAtUtc: new Date(), deletedAtUtc: new Date() });
    expect(await unlinked()).toBe(2);
    const summary = await get(`/v1/evidence/library-summary?teamId=${W.teamId}`);
    expect(summary.json()).toMatchObject({ totalActiveRecords: 2 });
    // Both are TRASH in the one classification (the reconciliation moves them there).
    const dry = await backfill.reconcileEvidenceLifecycle({ teamId: W.teamId });
    expect(dry.byClass).toMatchObject({ ACTIVE: 2, TRASH: 2, ABANDONED_UPLOAD: 4 });
  }, 120_000);

  it("RECONCILIATION: dry run writes nothing; apply moves the legacy-deleted record to Trash keeping its deletion date, releases an expired upload, refuses held/contradictory rows; a re-run changes nothing", async () => {
    ids.heldDeleted = await row(
      { status: "SIGNED", lifecycleState: "ACTIVE", signedAtUtc: new Date(Date.now() - 300 * DAY), deletedAt: new Date(Date.now() - 50 * DAY) });
    await prisma.evidenceLegalHold.create({
      data: { teamId: W.teamId, evidenceId: ids.heldDeleted, title: "Hold", reason: "test", status: "ACTIVE", placedByUserId: A().ownerUserId } as never,
    });
    ids.archiveMarker = await row({ status: "REPORTED", lifecycleState: "ACTIVE", signedAtUtc: new Date(), archivedAt: new Date() });
    ids.expiredUpload = await row({ status: "UPLOADING", lifecycleState: "ACTIVE" }, { updatedAt: new Date(Date.now() - 3 * DAY) });
    // None of these is an active record on Home.
    expect(await unlinked()).toBe(2);

    const before = await prisma.evidence.findMany({ where: { teamId: W.teamId }, orderBy: { id: "asc" } });
    const custodyBefore = await prisma.custodyEvent.count();
    const dry = await backfill.reconcileEvidenceLifecycle({ teamId: W.teamId, batchSize: 3 });
    expect(dry).toMatchObject({ mode: "DRY-RUN", movedToTrash: 2, releasedReservations: 1 });
    expect(dry.manualReview.map((m) => [m.id, m.reason]).sort()).toEqual(
      [
        [ids.archiveMarker, "CONTRADICTORY_LIFECYCLE_MARKERS"],
        [ids.heldDeleted, "DELETED_BUT_UNDER_LEGAL_HOLD"],
      ].sort(),
    );
    expect(await prisma.evidence.findMany({ where: { teamId: W.teamId }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await prisma.custodyEvent.count()).toBe(custodyBefore);

    // Bounded: one batch of 3 stops with a cursor to resume from.
    const page = await backfill.reconcileEvidenceLifecycle({ teamId: W.teamId, batchSize: 3, maxBatches: 1 });
    expect(page.scanned).toBe(3);
    expect(page.nextCursor).not.toBeNull();

    const applied = await backfill.reconcileEvidenceLifecycle({ apply: true, teamId: W.teamId, batchSize: 3 });
    expect(applied).toMatchObject({ mode: "APPLY", movedToTrash: 2, releasedReservations: 1 });
    // The record deleted through the canonical column alone keeps that instant.
    const utcOnly = await prisma.evidence.findUniqueOrThrow({ where: { id: ids.legacyDeletedUtc } });
    const utcBefore = before.find((r) => r.id === ids.legacyDeletedUtc)!;
    expect(utcOnly.lifecycleState).toBe("TRASHED");
    expect(utcOnly.deletedAt?.toISOString()).toBe(utcBefore.deletedAtUtc?.toISOString());
    const legacy = await prisma.evidence.findUniqueOrThrow({ where: { id: ids.legacyDeleted } });
    const legacyBefore = before.find((r) => r.id === ids.legacyDeleted)!;
    expect(legacy.lifecycleState).toBe("TRASHED");
    expect(legacy.deletedAt?.toISOString()).toBe(legacyBefore.deletedAt?.toISOString());
    expect(legacy.deletedAtUtc?.toISOString()).toBe(legacyBefore.deletedAt?.toISOString());
    expect(legacy.deleteScheduledForUtc!.getTime()).toBe(legacyBefore.deletedAt!.getTime() + 90 * DAY);
    // Content facts untouched.
    expect(legacy.fileSha256).toBe(legacyBefore.fileSha256);
    expect(legacy.signedAtUtc?.toISOString()).toBe(legacyBefore.signedAtUtc?.toISOString());
    const ev = await prisma.custodyEvent.findFirstOrThrow({ where: { evidenceId: ids.legacyDeleted, eventType: "EVIDENCE_DELETE_SCHEDULED" } });
    expect(ev.payload).toMatchObject({ reason: "LEGACY_DELETION_MARKER_RECONCILED" });
    // The expired upload is released (soft) — never trashed, never archived.
    const released = await prisma.evidence.findUniqueOrThrow({ where: { id: ids.expiredUpload } });
    expect(released).toMatchObject({ status: "UPLOADING", lifecycleState: "ACTIVE" });
    expect(released.deletedAt).not.toBeNull();
    // Refused rows are exactly as they were.
    for (const id of [ids.heldDeleted, ids.archiveMarker]) {
      expect(await prisma.evidence.findUniqueOrThrow({ where: { id } })).toEqual(before.find((r) => r.id === id));
    }
    // No row was deleted.
    expect(await prisma.evidence.count({ where: { teamId: W.teamId } })).toBe(before.length);

    // Idempotent: a second apply changes nothing.
    const custodyAfter = await prisma.custodyEvent.count();
    const again = await backfill.reconcileEvidenceLifecycle({ apply: true, teamId: W.teamId });
    expect(again).toMatchObject({ movedToTrash: 0, releasedReservations: 0 });
    expect(await prisma.custodyEvent.count()).toBe(custodyAfter);

    // Every row is in exactly one class, and Home still says 2.
    const final = await backfill.reconcileEvidenceLifecycle({ teamId: W.teamId });
    expect(Object.values(final.byClass).reduce((a, b) => a + b, 0)).toBe(final.scanned);
    expect(final.byClass).toMatchObject({ ACTIVE: 2, TRASH: 2, MANUAL_REVIEW: 2, ABANDONED_UPLOAD: 5 });
    expect(await unlinked()).toBe(2);
  }, 120_000);

  it("a record linked only to a CLOSED matter counts as unlinked; one in an active matter does not", async () => {
    const open = await prisma.case.create({ data: { name: `Open ${randomUUID()}`, teamId: W.teamId, ownerUserId: A().ownerUserId, status: "OPEN" } as never });
    const closed = await prisma.case.create({ data: { name: `Closed ${randomUUID()}`, teamId: W.teamId, ownerUserId: A().ownerUserId, status: "CLOSED" } as never });
    await prisma.caseEvidenceLink.create({ data: { caseId: open.id, evidenceId: ids.active1 } as never });
    await prisma.caseEvidenceLink.create({ data: { caseId: closed.id, evidenceId: ids.active2 } as never });
    expect(await unlinked()).toBe(1);
  }, 120_000);
});
