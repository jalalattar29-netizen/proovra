/**
 * M676 (WS-SCHED, DEC-04) — DERIVED-ARTIFACT STORAGE IS RESERVED BEFORE IT IS
 * WRITTEN, against a real PostgreSQL (all migrations, including
 * 20281122000000_derived_asset_storage_reservation).
 *
 * The derived storage gate (`workspaceAllowsDerivedArtifact`, worker) was
 * check-then-write: two derived jobs of one workspace both read the same
 * committed usage, both passed, and both wrote an object under Object Lock —
 * overshoot of one derived object per concurrent job. The gate now reserves
 * the admitted bytes on the derived row under the workspace capacity lock, in
 * a short transaction that ends before the upload.
 *
 * Proves, through the REAL worker gate, the REAL shared derived writer and
 * BOTH hosts' usage meters (API `getWorkspaceUsage`, worker
 * `getWorkspaceUsage`):
 *   1. two concurrent derived jobs that jointly exceed the allowance: exactly
 *      one is admitted (before the fix both were — revert-checked);
 *   2. the settling write clears the reservation: COMPLETED counts the live
 *      size once, FAILED counts nothing new; an aborted job's release removes
 *      a placeholder that never received an object;
 *   3. an expired reservation stops counting on both hosts, and the
 *      reconciler's release clears it;
 *   4. the two meters agree at every step (parity), reservation included;
 *   5. a row written the pre-M676 way (no reservation columns) is unaffected.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps, type PersonalTenant } from "./point7/product-fixtures.js";

const MIB = 1024 * 1024;

describe("M676 — derived-artifact storage reservation (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let apiUsage: (typeof import("../src/services/workspace-usage.service.js"))["getWorkspaceUsage"];
  let apiScope: (typeof import("../src/services/billing-enforcement.service.js"))["resolveEnforcementScopeForRequester"];
  let workerBilling: typeof import("../../worker/src/workspace-billing.js");
  let runtime: typeof import("@proovra/shared-runtime");
  const createdEvidence: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    const { signJwt } = await import("../src/services/jwt.js");
    ({ getWorkspaceUsage: apiUsage } = await import("../src/services/workspace-usage.service.js"));
    ({ resolveEnforcementScopeForRequester: apiScope } = await import("../src/services/billing-enforcement.service.js"));
    workerBilling = await import("../../worker/src/workspace-billing.js");
    deps = {
      prisma: prisma as never,
      tag: `m676-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
  }, 600_000);

  afterAll(async () => {
    if (createdEvidence.length) {
      await prisma.evidencePartDerivedAsset.deleteMany({ where: { evidenceId: { in: createdEvidence } } }).catch(() => undefined);
    }
    await harness?.cleanup();
  });

  /** A stored record of `bytes` with one part (the derived rows' FK anchor). */
  async function record(t: PersonalTenant, bytes: bigint) {
    const key = `m676/${randomBytes(6).toString("hex")}`;
    const ev = await prisma.evidence.create({
      data: {
        title: "M676 fixture",
        type: "PHOTO",
        status: "SIGNED",
        teamId: t.personalTeamId,
        organizationId: t.personalOrganizationId,
        ownerUserId: t.owner.userId,
        storageBucket: "m676-bucket",
        storageKey: key,
        sizeBytes: bytes,
      } as never,
      select: { id: true },
    });
    createdEvidence.push(ev.id);
    const part = await prisma.evidencePart.create({
      data: { evidenceId: ev.id, partIndex: 0, storageBucket: "m676-bucket", storageKey: `${key}.part0`, sha256: "a".repeat(64) },
      select: { id: true },
    });
    return { evidenceId: ev.id, partId: part.id };
  }

  /** The PENDING request row the API's producer writes before enqueueing a derived job. */
  async function pendingDerived(t: PersonalTenant, rec: { evidenceId: string; partId: string }, assetKind = "image_thumbnail") {
    return prisma.evidencePartDerivedAsset.create({
      data: { teamId: t.personalTeamId, evidenceId: rec.evidenceId, evidencePartId: rec.partId, assetKind, status: "PENDING" },
      select: { id: true },
    });
  }

  const keyOf = (t: PersonalTenant, rec: { partId: string }, assetKind = "image_thumbnail", variantKey = "default") => ({
    teamId: t.personalTeamId,
    evidencePartId: rec.partId,
    assetKind,
    variantKey,
  });

  /** Both meters, asserted equal (parity) on the figure every gate reads and on the reservation. */
  async function bothHosts(t: PersonalTenant) {
    const api = await apiUsage(await apiScope({ ownerUserId: t.owner.userId, teamId: t.personalTeamId }));
    const wk = await workerBilling.getWorkspaceUsage(
      await workerBilling.resolveWorkspaceScopeForEvidence({ ownerUserId: t.owner.userId, teamId: t.personalTeamId }),
    );
    expect(wk.storageBytesUsed, "worker = API (storageBytesUsed)").toBe(api.storageBytesUsed);
    expect(wk.reservedStorageBytes, "worker = API (reservedStorageBytes)").toBe(api.reservedStorageBytes);
    expect(wk.actualStorageBytes, "worker = API (actualStorageBytes)").toBe(api.actualStorageBytes);
    expect(wk.storageBytesLimit, "worker = API (storageBytesLimit)").toBe(api.storageBytesLimit);
    return api;
  }

  /** A tenant filled to `room` bytes below its allowance. */
  async function tenantWithRoom(room: bigint) {
    const t = await seedPersonalTenant(deps, "FREE");
    const limit = (await bothHosts(t)).storageBytesLimit;
    const padding = await record(t, limit - room);
    expect((await bothHosts(t)).storageBytesUsed).toBe(limit - room);
    return { t, limit, padding };
  }

  const reservationOf = async (id: string) =>
    prisma.evidencePartDerivedAsset.findUniqueOrThrow({
      where: { id },
      select: { status: true, storageReservedBytes: true, storageReservedAtUtc: true, sizeBytes: true, storageKey: true },
    });

  it("two concurrent derived jobs that jointly exceed the allowance: exactly one is admitted, the other refused; no joint overshoot", async () => {
    const { t, limit } = await tenantWithRoom(BigInt(3 * MIB));
    const a = await record(t, 0n);
    const b = await record(t, 0n);
    const rowA = await pendingDerived(t, a);
    const rowB = await pendingDerived(t, b);
    const each = 2 * MIB; // each fits alone, both do not

    const verdicts = await Promise.all([
      workerBilling.workspaceAllowsDerivedArtifact({ evidenceId: a.evidenceId, incomingBytes: each, reservation: keyOf(t, a) }),
      workerBilling.workspaceAllowsDerivedArtifact({ evidenceId: b.evidenceId, incomingBytes: each, reservation: keyOf(t, b) }),
    ]);
    const admitted = verdicts.filter((v) => v.allowed);
    expect(admitted, "exactly one derived job is admitted").toHaveLength(1);
    expect(verdicts.filter((v) => !v.allowed)).toEqual([{ allowed: false, reason: "storage_limit" }]);

    // The winner's bytes are reserved before any upload: both hosts see them.
    const [winRow, loseRow, winRec] = verdicts[0]!.allowed ? [rowA, rowB, a] : [rowB, rowA, b];
    expect((await reservationOf(winRow.id)).storageReservedBytes).toBe(BigInt(each));
    expect((await reservationOf(loseRow.id)).storageReservedBytes, "a refused job reserves nothing").toBeNull();
    let u = await bothHosts(t);
    expect(u.reservedStorageBytes).toBe(BigInt(each));
    expect(u.storageBytesUsed).toBe(limit - BigInt(3 * MIB) + BigInt(each));
    expect(u.actualStorageBytes, "reserved bytes are not stored bytes").toBe(limit - BigInt(3 * MIB));

    // A THIRD job is refused against the reservation, though nothing is stored yet.
    const c = await record(t, 0n);
    await pendingDerived(t, c);
    expect(
      await workerBilling.workspaceAllowsDerivedArtifact({ evidenceId: c.evidenceId, incomingBytes: each, reservation: keyOf(t, c) }),
    ).toEqual({ allowed: false, reason: "storage_limit" });

    // The winner settles COMPLETED: the live size replaces the reservation in one statement.
    const settled = await runtime.recordDerivedAsset(
      {
        teamId: t.personalTeamId,
        evidenceId: winRec.evidenceId,
        evidencePartId: winRec.partId,
        assetKind: "image_thumbnail",
        status: "COMPLETED",
        derivedSha256: "d".repeat(64),
        sizeBytes: each,
        storageBucket: "m676-bucket",
        storageKey: `derived-assets/${winRec.evidenceId}/thumb.webp`,
      },
      prisma as never,
    );
    expect(settled.ok).toBe(true);
    expect(await reservationOf(winRow.id)).toMatchObject({ status: "COMPLETED", storageReservedBytes: null, storageReservedAtUtc: null, sizeBytes: each });
    u = await bothHosts(t);
    expect(u.reservedStorageBytes).toBe(0n);
    expect(u.storageBytesUsed, "counted once, as stored bytes").toBe(limit - BigInt(3 * MIB) + BigInt(each));
    expect(u.storageBytesUsed <= u.storageBytesLimit, "no joint overshoot").toBe(true);
  }, 300_000);

  it("a failed job's settling write clears its reservation; an aborted job's release removes a placeholder that never received an object", async () => {
    const { t, limit } = await tenantWithRoom(BigInt(10 * MIB));
    const rec = await record(t, 0n);
    const row = await pendingDerived(t, rec, "low_res_proxy");

    // FAILED after admission (e.g. the upload failed): nothing new counts.
    expect(
      await workerBilling.workspaceAllowsDerivedArtifact({ evidenceId: rec.evidenceId, incomingBytes: 4 * MIB, reservation: keyOf(t, rec, "low_res_proxy") }),
    ).toEqual({ allowed: true });
    expect((await bothHosts(t)).reservedStorageBytes).toBe(BigInt(4 * MIB));
    const failed = await runtime.recordDerivedAsset(
      { teamId: t.personalTeamId, evidenceId: rec.evidenceId, evidencePartId: rec.partId, assetKind: "low_res_proxy", status: "FAILED", lastError: "derived_put_failed" },
      prisma as never,
    );
    expect(failed.ok).toBe(true);
    expect(await reservationOf(row.id)).toMatchObject({ status: "FAILED", storageReservedBytes: null, storageReservedAtUtc: null, storageKey: null });
    expect((await bothHosts(t)).storageBytesUsed).toBe(limit - BigInt(10 * MIB));

    // A retry of the same row re-reserves without counting its own earlier reservation.
    const retryKey = keyOf(t, rec, "low_res_proxy");
    expect(await workerBilling.workspaceAllowsDerivedArtifact({ evidenceId: rec.evidenceId, incomingBytes: 6 * MIB, reservation: retryKey })).toEqual({ allowed: true });
    expect(await workerBilling.workspaceAllowsDerivedArtifact({ evidenceId: rec.evidenceId, incomingBytes: 9 * MIB, reservation: retryKey })).toEqual({ allowed: true });
    expect((await bothHosts(t)).reservedStorageBytes, "one reservation per row, the latest").toBe(BigInt(9 * MIB));
    // Refused (over the room): the row keeps no reservation.
    expect(await workerBilling.workspaceAllowsDerivedArtifact({ evidenceId: rec.evidenceId, incomingBytes: 11 * MIB, reservation: retryKey })).toEqual({
      allowed: false,
      reason: "storage_limit",
    });
    expect((await reservationOf(row.id)).storageReservedBytes).toBeNull();
    expect((await bothHosts(t)).reservedStorageBytes).toBe(0n);

    // The combined screen recording of a NEW generation has no row yet: the
    // reservation creates a PROCESSING placeholder (no pointer) ...
    const combinedKey = keyOf(t, rec, "screen_recording_combined", "combined-v1");
    expect(await workerBilling.workspaceAllowsDerivedArtifact({ evidenceId: rec.evidenceId, incomingBytes: 5 * MIB, reservation: combinedKey })).toEqual({ allowed: true });
    const placeholder = await prisma.evidencePartDerivedAsset.findFirstOrThrow({
      where: { evidenceId: rec.evidenceId, assetKind: "screen_recording_combined", variantKey: "combined-v1" },
      select: { id: true, status: true, storageKey: true, storageReservedBytes: true },
    });
    expect(placeholder).toMatchObject({ status: "PROCESSING", storageKey: null, storageReservedBytes: BigInt(5 * MIB) });
    expect((await bothHosts(t)).reservedStorageBytes).toBe(BigInt(5 * MIB));
    // ... which the aborted attempt's release removes with the reservation.
    await workerBilling.releaseDerivedArtifactReservation({ ...combinedKey, evidenceId: rec.evidenceId });
    expect(await prisma.evidencePartDerivedAsset.count({ where: { id: placeholder.id } })).toBe(0);
    let u = await bothHosts(t);
    expect(u.reservedStorageBytes).toBe(0n);
    expect(u.storageBytesUsed).toBe(limit - BigInt(10 * MIB));

    // A generation that records settles the placeholder into the COMPLETED row, counted once.
    expect(await workerBilling.workspaceAllowsDerivedArtifact({ evidenceId: rec.evidenceId, incomingBytes: 5 * MIB, reservation: combinedKey })).toEqual({ allowed: true });
    const recorded = await runtime.recordDerivedAsset(
      {
        teamId: t.personalTeamId,
        evidenceId: rec.evidenceId,
        evidencePartId: rec.partId,
        assetKind: "screen_recording_combined",
        variantKey: "combined-v1",
        status: "COMPLETED",
        derivedSha256: "e".repeat(64),
        sizeBytes: 5 * MIB,
        contentType: "video/mp4",
        storageBucket: "m676-bucket",
        storageKey: `derived-assets/${rec.evidenceId}/combined.mp4`,
      },
      prisma as never,
    );
    expect(recorded.ok).toBe(true);
    expect(
      await prisma.evidencePartDerivedAsset.count({ where: { evidenceId: rec.evidenceId, assetKind: "screen_recording_combined" } }),
      "the placeholder became the row: one row per generation",
    ).toBe(1);
    // A release after the settle (the finally of a handler) touches nothing it must not.
    await workerBilling.releaseDerivedArtifactReservation({ ...combinedKey, evidenceId: rec.evidenceId });
    u = await bothHosts(t);
    expect(u.reservedStorageBytes).toBe(0n);
    expect(u.storageBytesUsed).toBe(limit - BigInt(10 * MIB) + BigInt(5 * MIB));
  }, 300_000);

  it("an expired reservation stops counting on both hosts, and the reconciler's release clears it", async () => {
    const { t, limit } = await tenantWithRoom(BigInt(4 * MIB));
    const rec = await record(t, 0n);
    const row = await pendingDerived(t, rec);
    expect(await workerBilling.workspaceAllowsDerivedArtifact({ evidenceId: rec.evidenceId, incomingBytes: 3 * MIB, reservation: keyOf(t, rec) })).toEqual({ allowed: true });
    expect((await bothHosts(t)).reservedStorageBytes).toBe(BigInt(3 * MIB));
    expect(runtime.DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS, "the TTL is the media-intelligence run lease").toBe(runtime.MEDIA_INTELLIGENCE_RUN_LEASE_MS);
    const ttl = runtime.DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS;

    // Just inside the TTL it still counts (a live job) ...
    await prisma.evidencePartDerivedAsset.update({ where: { id: row.id }, data: { storageReservedAtUtc: new Date(Date.now() - ttl + 60_000) } });
    expect((await bothHosts(t)).reservedStorageBytes).toBe(BigInt(3 * MIB));
    const other = await record(t, 0n);
    await pendingDerived(t, other);
    expect(
      await workerBilling.workspaceAllowsDerivedArtifact({ evidenceId: other.evidenceId, incomingBytes: 2 * MIB, reservation: keyOf(t, other) }),
      "a live reservation holds its room",
    ).toEqual({ allowed: false, reason: "storage_limit" });

    // ... past it (the worker died) it counts nothing, on both hosts, and holds no room.
    await prisma.evidencePartDerivedAsset.update({ where: { id: row.id }, data: { storageReservedAtUtc: new Date(Date.now() - ttl - 1_000) } });
    let u = await bothHosts(t);
    expect(u.reservedStorageBytes).toBe(0n);
    expect(u.storageBytesUsed).toBe(limit - BigInt(4 * MIB));

    // An expired placeholder that never received an object is removed by the same release.
    const ghost = await record(t, 0n);
    await prisma.$executeRaw`
      INSERT INTO "evidence_part_derived_assets"
        ("team_id", "evidence_id", "evidence_part_id", "asset_kind", "variant_key", "status", "storage_reserved_bytes", "storage_reserved_at_utc")
      VALUES (${t.personalTeamId}::uuid, ${ghost.evidenceId}::uuid, ${ghost.partId}::uuid, 'screen_recording_combined', 'combined-v1',
              'PROCESSING', ${BigInt(MIB)}, ${new Date(Date.now() - ttl - 5_000)})`;
    expect((await bothHosts(t)).reservedStorageBytes).toBe(0n);

    const released = await runtime.releaseExpiredDerivedAssetStorageReservations(prisma as never);
    expect(released).toBeGreaterThanOrEqual(2);
    expect(await reservationOf(row.id)).toMatchObject({ status: "PENDING", storageReservedBytes: null, storageReservedAtUtc: null });
    expect(await prisma.evidencePartDerivedAsset.count({ where: { evidenceId: ghost.evidenceId } })).toBe(0);
    u = await bothHosts(t);
    expect(u.reservedStorageBytes).toBe(0n);
    expect(
      await workerBilling.workspaceAllowsDerivedArtifact({ evidenceId: other.evidenceId, incomingBytes: 2 * MIB, reservation: keyOf(t, other) }),
      "the room is free again",
    ).toEqual({ allowed: true });
  }, 300_000);

  // ---------------------------------------------------------------------------
  // M676 follow-up — the reservation is RENEWED (database clock, fenced on the
  // holder's stamp) and never outlived.
  // ---------------------------------------------------------------------------

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function admit(t: PersonalTenant, rec: { evidenceId: string; partId: string }, bytes: number, assetKind = "image_thumbnail") {
    const v = await workerBilling.reserveDerivedArtifactStorage({ evidenceId: rec.evidenceId, incomingBytes: bytes, reservation: keyOf(t, rec, assetKind) });
    if (!v.allowed) throw new Error(`not admitted: ${v.reason}`);
    return v.hold;
  }

  it("M676 follow-up — a job still running past its ORIGINAL window keeps its reservation counted because it renewed; a concurrent job B is refused", async () => {
    const { t, limit } = await tenantWithRoom(BigInt(4 * MIB));
    const a = await record(t, 0n);
    const rowA = await pendingDerived(t, a);
    const admitted = await admit(t, a, 3 * MIB);
    // The stamp is the database's, returned to the holder exactly as stored.
    expect((await reservationOf(rowA.id)).storageReservedAtUtc?.getTime()).toBe(admitted.reservedAtUtc.getTime());
    expect(admitted.writeDeadlineAt, "the write deadline ends the safety margin before the reservation does").toBeLessThanOrEqual(
      Date.now() + runtime.DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS - runtime.DERIVED_ASSET_RESERVATION_SAFETY_MARGIN_MS,
    );

    // Job A reserved at T0, 2 s before the end of its window (it has been running ~20 minutes).
    const ttl = runtime.DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS;
    const t0 = new Date(Date.now() - ttl + 2_000);
    await prisma.evidencePartDerivedAsset.update({ where: { id: rowA.id }, data: { storageReservedAtUtc: t0 } });
    const holdAtT0 = { ...admitted, reservedAtUtc: t0 };
    const renewed = await workerBilling.renewDerivedArtifactReservation(holdAtT0);
    expect(renewed, "the live reservation this job holds is renewed").not.toBeNull();
    expect(renewed!.reservedAtUtc.getTime()).toBeGreaterThan(t0.getTime() + ttl - 60_000);
    expect((await reservationOf(rowA.id)).storageReservedAtUtc?.getTime()).toBe(renewed!.reservedAtUtc.getTime());

    // T0 + TTL passes: without the renewal both meters would drop A's bytes here.
    await sleep(3_000);
    expect(Date.now()).toBeGreaterThan(t0.getTime() + ttl);
    const u = await bothHosts(t);
    expect(u.reservedStorageBytes, "A still counts on both hosts").toBe(BigInt(3 * MIB));
    expect(u.storageBytesUsed).toBe(limit - BigInt(4 * MIB) + BigInt(3 * MIB));

    // B is admitted against the same room? No: A's bytes still hold it.
    const b = await record(t, 0n);
    await pendingDerived(t, b);
    expect(
      await workerBilling.workspaceAllowsDerivedArtifact({ evidenceId: b.evidenceId, incomingBytes: 2 * MIB, reservation: keyOf(t, b) }),
      "a concurrent job B is refused",
    ).toEqual({ allowed: false, reason: "storage_limit" });

    // The superseded stamp is no longer a fence token: a stale copy of the hold cannot renew.
    expect(await workerBilling.renewDerivedArtifactReservation(holdAtT0)).toBeNull();
    // The reconciler's expiry sweep leaves a renewed reservation alone.
    await runtime.releaseExpiredDerivedAssetStorageReservations(prisma as never);
    expect((await reservationOf(rowA.id)).storageReservedBytes).toBe(BigInt(3 * MIB));
  }, 300_000);

  it("M676 follow-up — a reservation that expired, was replaced, settled or released is never renewed (the holder must stop); a stale holder's release spares its successor", async () => {
    const { t } = await tenantWithRoom(BigInt(10 * MIB));
    const rec = await record(t, 0n);
    const row = await pendingDerived(t, rec);
    const ttl = runtime.DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS;

    // EXPIRED on the database clock: not renewed, and not revived.
    const expiredHold = await admit(t, rec, 2 * MIB);
    const old = new Date(Date.now() - ttl - 1_000);
    await prisma.evidencePartDerivedAsset.update({ where: { id: row.id }, data: { storageReservedAtUtc: old } });
    expect(await workerBilling.renewDerivedArtifactReservation({ ...expiredHold, reservedAtUtc: old })).toBeNull();
    expect((await reservationOf(row.id)).storageReservedAtUtc?.getTime(), "an expired reservation is not revived").toBe(old.getTime());
    expect((await bothHosts(t)).reservedStorageBytes).toBe(0n);

    // REPLACED by another attempt of the same row: the first holder's stamp is dead.
    const first = await admit(t, rec, 2 * MIB);
    await sleep(5);
    const second = await admit(t, rec, 3 * MIB);
    expect(second.reservedAtUtc.getTime()).not.toBe(first.reservedAtUtc.getTime());
    expect(await workerBilling.renewDerivedArtifactReservation(first)).toBeNull();
    // ... and its fenced release does not take the successor's reservation.
    await workerBilling.releaseDerivedArtifactReservation({ ...keyOf(t, rec), evidenceId: rec.evidenceId }, first.reservedAtUtc);
    expect((await reservationOf(row.id)).storageReservedBytes).toBe(BigInt(3 * MIB));
    const live = await workerBilling.renewDerivedArtifactReservation(second);
    expect(live).not.toBeNull();

    // SETTLED: the settling write ends it; nothing left to renew.
    const settled = await runtime.recordDerivedAsset(
      { teamId: t.personalTeamId, evidenceId: rec.evidenceId, evidencePartId: rec.partId, assetKind: "image_thumbnail", status: "FAILED", lastError: "x" },
      prisma as never,
    );
    expect(settled.ok).toBe(true);
    expect(await workerBilling.renewDerivedArtifactReservation(live!)).toBeNull();

    // RELEASED (the holder's own fenced release): nothing left to renew either.
    const again = await admit(t, rec, 1 * MIB);
    await workerBilling.releaseDerivedArtifactReservation(again.key, again.reservedAtUtc);
    expect((await reservationOf(row.id)).storageReservedBytes).toBeNull();
    expect(await workerBilling.renewDerivedArtifactReservation(again)).toBeNull();
    expect((await bothHosts(t)).reservedStorageBytes).toBe(0n);
  }, 300_000);

  it("M676 follow-up — the meters judge liveness on the database clock (the clock that stamps and renews)", async () => {
    const { t } = await tenantWithRoom(BigInt(4 * MIB));
    const rec = await record(t, 0n);
    const row = await pendingDerived(t, rec);
    await admit(t, rec, 3 * MIB);
    const dbNow = ((await prisma.$queryRaw`SELECT NOW() AS "now"`) as Array<{ now: Date }>)[0]!.now;
    const ttl = runtime.DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS;
    // 30 s inside the window by the database clock: counts on both hosts.
    await prisma.$executeRaw`UPDATE "evidence_part_derived_assets" SET "storage_reserved_at_utc" = NOW() - make_interval(secs => ${(ttl - 30_000) / 1000}::double precision) WHERE "id" = ${row.id}::uuid`;
    expect((await bothHosts(t)).reservedStorageBytes).toBe(BigInt(3 * MIB));
    expect(await runtime.sumLiveDerivedAssetStorageReservationBytes(prisma as never, { teamId: t.personalTeamId })).toBe(BigInt(3 * MIB));
    // A pinned `now` is still honoured (callers that pass one keep their semantics).
    expect(
      await runtime.sumLiveDerivedAssetStorageReservationBytes(prisma as never, { teamId: t.personalTeamId, now: new Date(dbNow.getTime() + 60_000) }),
    ).toBe(0n);
    // 1 s past the window by the database clock: counts nothing.
    await prisma.$executeRaw`UPDATE "evidence_part_derived_assets" SET "storage_reserved_at_utc" = NOW() - make_interval(secs => ${(ttl + 1_000) / 1000}::double precision) WHERE "id" = ${row.id}::uuid`;
    expect((await bothHosts(t)).reservedStorageBytes).toBe(0n);
  }, 300_000);

  it("a row written the pre-M676 way (an older image: no reservation columns named) is stored with none and counted as before", async () => {
    const { t, limit } = await tenantWithRoom(BigInt(8 * MIB));
    const rec = await record(t, 0n);
    // The 0376721d9 writer's column list (no storage_reserved_*): NULL by default.
    const id = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO "evidence_part_derived_assets"
        ("id", "team_id", "evidence_id", "evidence_part_id", "asset_kind", "status", "derived_sha256", "size_bytes",
         "storage_bucket", "storage_key", "variant_key", "generated_at_utc", "updated_at_utc")
      VALUES (${id}::uuid, ${t.personalTeamId}::uuid, ${rec.evidenceId}::uuid, ${rec.partId}::uuid, 'video_frame', 'COMPLETED',
              ${"f".repeat(64)}, ${MIB}, 'm676-bucket', ${`derived-assets/${rec.evidenceId}/frame.webp`}, 'default', NOW(), NOW())`;
    expect(await reservationOf(id)).toMatchObject({ storageReservedBytes: null, storageReservedAtUtc: null });
    const u = await bothHosts(t);
    expect(u.reservedStorageBytes).toBe(0n);
    expect(u.storageBytesUsed).toBe(limit - BigInt(8 * MIB) + BigInt(MIB));
  }, 300_000);
});
