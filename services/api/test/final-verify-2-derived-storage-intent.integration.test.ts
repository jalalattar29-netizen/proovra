/**
 * FINAL-VERIFY-2 closure — DERIVED WRITES ARE HELD BY DURABLE INTENTS UNTIL
 * RECONCILED, against a real PostgreSQL (all migrations, including
 * 20281123060000_derived_asset_storage_intent) and a FAKE object store (the
 * versions, Object Lock state and incomplete multipart uploads of each key).
 *
 * The invariant: capacity is never freed while stored bytes can still exist
 * unaccounted for. Being unable to delete (custody) never makes bytes vanish
 * from accounting. Proven through the REAL worker gate and renewal, the REAL
 * bounded settle, the REAL holder disposal and the REAL reconciler, with BOTH
 * hosts' meters asserted equal at every step:
 *   1. process death mid-upload (incomplete multipart parts, no object);
 *   2. a lost upload response, the request landing after the holder's delete;
 *   3. (b) a lost upload response under Object Lock: neither deletable nor
 *      recordable by the holder;
 *   4. (a) settle AND fallback both fail (database outage), then recovery;
 *   5. (c) a settle stalled on a lock past its window: cancelled BY THE
 *      SERVER (no statement left waiting), never committed later;
 *   6. reservation replacement while the old holder still runs (fencing),
 *      and a zombie settle after the reconciler resolved its intent;
 *   7. concurrent uploads against quota, holders dying after upload.
 * After every reconciliation: the bytes both meters count above the baseline
 * EQUAL the bytes the store actually holds for the tenant's derived keys.
 */
import { randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps, type PersonalTenant } from "./point7/product-fixtures.js";

const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------
// The fake store (versions, lock state, incomplete multipart uploads).
// ---------------------------------------------------------------------------
const fake = vi.hoisted(() => {
  type V = { versionId: string; sizeBytes: number; legalHold: boolean; retainUntil: Date | null; lastModified: Date };
  type U = { uploadId: string; initiated: Date };
  const id = (k: { bucket: string; key: string }) => `${k.bucket}\u0000${k.key}`;
  let seq = 0;
  const versions = new Map<string, V[]>();
  const mpus = new Map<string, U[]>();
  /** A one-shot hook run when the reconciler first lists a key's uploads (a holder arriving mid-reconcile). */
  const hooks: { onListUploads: null | (() => Promise<void>) } = { onListUploads: null };
  const locked = (v: V) => v.legalHold || (v.retainUntil != null && v.retainUntil.getTime() > Date.now());
  const check = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("aborted");
  };
  return {
    versions,
    mpus,
    hooks,
    put(
      bucket: string,
      key: string,
      sizeBytes: number,
      lock: { legalHold?: boolean; retainUntil?: Date } = {},
      at: Date = new Date(),
    ): string {
      const versionId = `v${++seq}`;
      const list = versions.get(id({ bucket, key })) ?? [];
      list.push({ versionId, sizeBytes, legalHold: lock.legalHold ?? false, retainUntil: lock.retainUntil ?? null, lastModified: at });
      versions.set(id({ bucket, key }), list);
      return versionId;
    },
    createMultipart(bucket: string, key: string, at: Date = new Date()): string {
      const uploadId = `u${++seq}`;
      mpus.set(id({ bucket, key }), [...(mpus.get(id({ bucket, key })) ?? []), { uploadId, initiated: at }]);
      return uploadId;
    },
    /** Everything the store created on this key before `at` moves to `at` (the holder's era, when tests age a holder). */
    backdate(bucket: string, key: string, at: Date) {
      for (const v of versions.get(id({ bucket, key })) ?? []) if (v.lastModified > at) v.lastModified = at;
      for (const u of mpus.get(id({ bucket, key })) ?? []) if (u.initiated > at) u.initiated = at;
    },
    completeMultipart(bucket: string, key: string, uploadId: string) {
      mpus.set(id({ bucket, key }), (mpus.get(id({ bucket, key })) ?? []).filter((u) => u.uploadId !== uploadId));
    },
    /** Bytes stored (data versions) under keys containing any of `needles`. */
    storedBytes(needles: string[]): bigint {
      let n = 0n;
      for (const [k, list] of versions) {
        if (!needles.some((s) => k.includes(s))) continue;
        for (const v of list) n += BigInt(v.sizeBytes);
      }
      return n;
    },
    store: {
      async listVersions(t: { bucket: string; key: string }, signal: AbortSignal) {
        check(signal);
        return (versions.get(id(t)) ?? []).map((v) => ({ ...v }));
      },
      async deleteVersion(t: { bucket: string; key: string; versionId: string }, signal: AbortSignal) {
        check(signal);
        const list = versions.get(id(t)) ?? [];
        const v = list.find((x) => x.versionId === t.versionId);
        if (!v) return true;
        if (locked(v)) return false; // Object Lock refuses the delete
        versions.set(id(t), list.filter((x) => x !== v));
        return true;
      },
      async listMultipartUploads(t: { bucket: string; key: string }, signal: AbortSignal) {
        check(signal);
        const hook = hooks.onListUploads;
        if (hook) {
          hooks.onListUploads = null;
          await hook();
        }
        return (mpus.get(id(t)) ?? []).map((u) => ({ ...u }));
      },
      async abortMultipartUpload(t: { bucket: string; key: string; uploadId: string }, signal: AbortSignal) {
        check(signal);
        mpus.set(id(t), (mpus.get(id(t)) ?? []).filter((u) => u.uploadId !== t.uploadId));
      },
    },
    /** The worker's `deleteObjectVersions` (holder disposal), with the version-port semantics. */
    removeForHolder(o: { bucket: string; key: string; versionId?: string | null }) {
      const list = versions.get(id(o)) ?? [];
      const target = list.filter((v) => o.versionId == null || v.versionId === o.versionId);
      const retained = target.filter(locked);
      const removed = target.filter((v) => !locked(v));
      versions.set(id(o), list.filter((v) => !removed.includes(v)));
      return {
        deleted: target.length > 0 && retained.length === 0,
        deletedVersions: removed.length,
        retainedVersions: retained.length,
        deleteMarkerOnly: false,
        failed: 0,
      };
    },
  };
});

vi.mock("../../worker/src/storage.js", () => ({
  deleteObjectVersions: async (o: { bucket: string; key: string; versionId?: string | null }) => fake.removeForHolder(o),
}));

const BUCKET = "fv2-bucket";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("FINAL-VERIFY-2 — derived write intents keep possibly-stored bytes counted until reconciled (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let apiUsage: (typeof import("../src/services/workspace-usage.service.js"))["getWorkspaceUsage"];
  let apiScope: (typeof import("../src/services/billing-enforcement.service.js"))["resolveEnforcementScopeForRequester"];
  let workerBilling: typeof import("../../worker/src/workspace-billing.js");
  let intents: typeof import("../../worker/src/derived-storage-intent.js");
  let disposal: typeof import("../../worker/src/derived-unsettled-object.js");
  let runtime: typeof import("@proovra/shared-runtime");
  let deadPool: Pool;
  let deadClient: PrismaClient;
  let blockerPool: Pool;
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
    intents = await import("../../worker/src/derived-storage-intent.js");
    disposal = await import("../../worker/src/derived-unsettled-object.js");
    deps = {
      prisma: prisma as never,
      tag: `fv2-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    // A database that is DOWN (nothing listens on port 1): the outage client.
    deadPool = new Pool({ connectionString: "postgresql://x:x@127.0.0.1:1/x", connectionTimeoutMillis: 1_000 });
    deadClient = new PrismaClient({ adapter: new PrismaPg(deadPool) });
    blockerPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  }, 600_000);

  afterAll(async () => {
    if (createdEvidence.length) {
      await prisma.evidencePartDerivedAsset.deleteMany({ where: { evidenceId: { in: createdEvidence } } }).catch(() => undefined);
      await prisma.derivedAssetStorageIntent.deleteMany({ where: { evidenceId: { in: createdEvidence } } }).catch(() => undefined);
    }
    await deadClient?.$disconnect().catch(() => undefined);
    await blockerPool?.end().catch(() => undefined);
    await harness?.cleanup();
  });

  async function record(t: PersonalTenant, bytes: bigint) {
    const key = `fv2/${randomBytes(6).toString("hex")}`;
    const ev = await prisma.evidence.create({
      data: {
        title: "FV2 fixture",
        type: "PHOTO",
        status: "SIGNED",
        teamId: t.personalTeamId,
        organizationId: t.personalOrganizationId,
        ownerUserId: t.owner.userId,
        storageBucket: BUCKET,
        storageKey: key,
        sizeBytes: bytes,
      } as never,
      select: { id: true },
    });
    createdEvidence.push(ev.id);
    const part = await prisma.evidencePart.create({
      data: { evidenceId: ev.id, partIndex: 0, storageBucket: BUCKET, storageKey: `${key}.part0`, sha256: "a".repeat(64) },
      select: { id: true },
    });
    return { evidenceId: ev.id, partId: part.id };
  }

  async function bothHosts(t: PersonalTenant) {
    const api = await apiUsage(await apiScope({ ownerUserId: t.owner.userId, teamId: t.personalTeamId }));
    const wk = await workerBilling.getWorkspaceUsage(
      await workerBilling.resolveWorkspaceScopeForEvidence({ ownerUserId: t.owner.userId, teamId: t.personalTeamId }),
    );
    expect(wk.storageBytesUsed, "worker = API (storageBytesUsed)").toBe(api.storageBytesUsed);
    expect(wk.reservedStorageBytes, "worker = API (reservedStorageBytes)").toBe(api.reservedStorageBytes);
    expect(wk.actualStorageBytes, "worker = API (actualStorageBytes)").toBe(api.actualStorageBytes);
    return api;
  }

  async function tenantWithRoom(room: bigint) {
    const t = await seedPersonalTenant(deps, "FREE");
    const limit = (await bothHosts(t)).storageBytesLimit;
    await record(t, limit - room);
    const baseline = limit - room;
    expect((await bothHosts(t)).storageBytesUsed).toBe(baseline);
    return { t, limit, baseline };
  }

  const derivedKey = (rec: { evidenceId: string }, tag: string) => `derived-assets/${rec.evidenceId}/${tag}.webp`;

  async function reserve(
    t: PersonalTenant,
    rec: { evidenceId: string; partId: string },
    bytes: number,
    key: string,
    assetKind = "image_thumbnail",
  ) {
    return workerBilling.reserveDerivedArtifactStorage({
      evidenceId: rec.evidenceId,
      incomingBytes: bytes,
      reservation: { teamId: t.personalTeamId, evidencePartId: rec.partId, assetKind, variantKey: "default" },
      target: { bucket: BUCKET, key, derivedSha256: "d".repeat(64), contentType: "image/webp" },
    });
  }
  async function admit(t: PersonalTenant, rec: { evidenceId: string; partId: string }, bytes: number, key: string) {
    const v = await reserve(t, rec, bytes, key);
    if (!v.allowed) throw new Error(`not admitted: ${v.reason}`);
    expect(v.hold.intentId, "a declared target holds a durable intent").toBeTruthy();
    return v.hold;
  }

  const ttl = () => runtime.DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS;
  const grace = () => runtime.DERIVED_ASSET_INTENT_RECONCILE_GRACE_MS;

  /** Move a holder's clock back: its reservation AND its intent's last stamp (database clock). */
  async function age(hold: { intentId?: string | null; key: { teamId: string; evidencePartId: string; assetKind: string; variantKey: string } }, ms: number) {
    const secs = ms / 1000;
    const intent = await prisma.derivedAssetStorageIntent.findUniqueOrThrow({ where: { id: hold.intentId! }, select: { storageBucket: true, storageKey: true } });
    // What this holder wrote, it wrote during its own window.
    fake.backdate(intent.storageBucket, intent.storageKey, new Date(Date.now() - ms + 1_000));
    await prisma.$executeRaw`UPDATE "derived_asset_storage_intents" SET "holder_stamp_utc" = NOW() - make_interval(secs => ${secs}::double precision) WHERE "id" = ${hold.intentId}::uuid`;
    await prisma.$executeRaw`
      UPDATE "evidence_part_derived_assets" SET "storage_reserved_at_utc" = NOW() - make_interval(secs => ${secs}::double precision)
       WHERE "team_id" = ${hold.key.teamId}::uuid AND "evidence_part_id" = ${hold.key.evidencePartId}::uuid
         AND "asset_kind" = ${hold.key.assetKind}::varchar AND "variant_key" = ${hold.key.variantKey}::varchar
         AND "storage_reservation_token" = ${hold.intentId}::uuid`;
  }

  const intentOf = (id: string | null | undefined) =>
    prisma.derivedAssetStorageIntent.findUniqueOrThrow({ where: { id: id! }, select: { state: true, resolution: true, resolvedBytes: true } });

  const reconcile = () => intents.reconcileDerivedAssetStorageIntents({ store: fake.store, client: prisma as never });

  /** THE INVARIANT: what both meters count above the baseline equals what the store holds. */
  async function accountingEqualsStored(t: PersonalTenant, baseline: bigint, evidenceIds: string[]) {
    const u = await bothHosts(t);
    expect(u.reservedStorageBytes, "nothing left reserved or OPEN").toBe(0n);
    expect(u.storageBytesUsed - baseline, "accounting = bytes actually stored").toBe(fake.storedBytes(evidenceIds));
  }

  it("process death mid-upload: the intent keeps counting past the reservation's TTL until the reconciler aborts the parts and proves the key empty", async () => {
    const { t, baseline } = await tenantWithRoom(BigInt(4 * MIB));
    const rec = await record(t, 0n);
    const key = derivedKey(rec, "combined");
    const hold = await admit(t, rec, 3 * MIB, key);
    fake.createMultipart(BUCKET, key); // parts uploaded ... and the process dies (no settle, no release)

    // The reservation lapses: before the closure both meters freed the 3 MiB here.
    await age(hold, ttl() + 1_000);
    await runtime.releaseExpiredDerivedAssetStorageReservations(prisma as never);
    let u = await bothHosts(t);
    expect(u.reservedStorageBytes, "the OPEN intent still counts on both hosts").toBe(BigInt(3 * MIB));
    const other = await record(t, 0n);
    expect((await reserve(t, other, 2 * MIB, derivedKey(other, "x"))).allowed, "no room is handed out on top of possibly-stored bytes").toBe(false);

    // Inside the grace the reconciler does not judge it (a late commit may still land).
    expect((await reconcile()).claimed).toBe(0);
    expect((await intentOf(hold.intentId)).state).toBe("OPEN");

    // After the grace: the parts are aborted, the key holds nothing, the intent is ABSENT.
    await age(hold, ttl() + grace() + 1_000);
    const r = await reconcile();
    expect(r).toMatchObject({ claimed: 1, absent: 1, kept: 0 });
    expect(fake.mpus.get(`${BUCKET}\u0000${key}`) ?? []).toEqual([]);
    expect(await intentOf(hold.intentId)).toMatchObject({ state: "ABSENT", resolution: "reconciled_absent" });
    await accountingEqualsStored(t, baseline, [rec.evidenceId]);
    u = await bothHosts(t);
    expect((await reserve(t, other, 2 * MIB, derivedKey(other, "x"))).allowed, "the room is free once proven").toBe(true);
  }, 300_000);

  it("parts that cannot be aborted keep the intent OPEN and counted", async () => {
    const { t } = await tenantWithRoom(BigInt(4 * MIB));
    const rec = await record(t, 0n);
    const key = derivedKey(rec, "stuck-parts");
    const hold = await admit(t, rec, 2 * MIB, key);
    fake.createMultipart(BUCKET, key);
    await age(hold, ttl() + grace() + 1_000);
    const abort = fake.store.abortMultipartUpload;
    fake.store.abortMultipartUpload = async () => undefined; // the store answers but keeps the parts
    try {
      const r = await reconcile();
      expect(r).toMatchObject({ claimed: 1, resolved: 0, kept: 1 });
    } finally {
      fake.store.abortMultipartUpload = abort;
    }
    expect((await intentOf(hold.intentId)).state).toBe("OPEN");
    expect((await bothHosts(t)).reservedStorageBytes).toBe(BigInt(2 * MIB));
    // The lease was given back: the next tick judges the key again, and once
    // the parts can be aborted the key is proven empty.
    expect(await reconcile()).toMatchObject({ claimed: 1, absent: 1, kept: 0 });
    expect((await bothHosts(t)).reservedStorageBytes).toBe(0n);
  }, 300_000);

  it("a lost upload response: the holder's key-wide delete never resolves the intent; the late-landing version is found and deleted by the reconciler", async () => {
    const { t, baseline } = await tenantWithRoom(BigInt(6 * MIB));
    const rec = await record(t, 0n);
    const key = derivedKey(rec, "lost-answer");
    const hold = await admit(t, rec, 2 * MIB, key);
    // The PUT's answer is lost: the holder disposes with an UNKNOWN version.
    const outcome = await disposal.disposeUnsettledDerivedObject({
      key: hold.key,
      heldSince: hold.reservedAtUtc,
      intentId: hold.intentId,
      object: { bucket: BUCKET, key, versionId: null },
      written: { derivedSha256: "d".repeat(64), sizeBytes: 2 * MIB, contentType: "image/webp" },
      reason: "derived_put_deadline_exceeded",
    });
    expect(outcome).toBe("deleted");
    expect((await intentOf(hold.intentId)).state, "a delete of an unknown version proves nothing about a request still in flight").toBe("OPEN");
    // ... and the store commits the lost request a moment later.
    fake.put(BUCKET, key, 2 * MIB - 512);
    await age(hold, ttl() + 1_000);
    expect((await bothHosts(t)).reservedStorageBytes, "still counted after the reservation lapsed").toBe(BigInt(2 * MIB));

    await age(hold, ttl() + grace() + 1_000);
    expect(await reconcile()).toMatchObject({ claimed: 1, deleted: 1 });
    expect(fake.storedBytes([rec.evidenceId])).toBe(0n);
    expect((await intentOf(hold.intentId)).state).toBe("DELETED");
    await accountingEqualsStored(t, baseline, [rec.evidenceId]);
  }, 300_000);

  it("(b) a lost upload response under Object Lock: neither deletable nor recordable by the holder, kept counted, then ADOPTED with its STORED size", async () => {
    const { t, baseline } = await tenantWithRoom(BigInt(6 * MIB));
    const rec = await record(t, 0n);
    const key = derivedKey(rec, "locked-lost");
    const hold = await admit(t, rec, 3 * MIB, key);
    const stored = 3 * MIB - 4096; // what actually landed differs from the reservation
    fake.put(BUCKET, key, stored, { retainUntil: new Date(Date.now() + 365 * 86_400_000) });
    const outcome = await disposal.disposeUnsettledDerivedObject({
      key: hold.key,
      heldSince: hold.reservedAtUtc,
      intentId: hold.intentId,
      object: { bucket: BUCKET, key, versionId: null },
      written: { derivedSha256: "d".repeat(64), sizeBytes: 3 * MIB, contentType: "image/webp" },
      reason: "upload_completion_unknown",
    });
    expect(outcome).toBe("reservation_kept");
    expect(fake.storedBytes([rec.evidenceId]), "Object Lock kept the version").toBe(BigInt(stored));

    await age(hold, ttl() + 1_000);
    await runtime.releaseExpiredDerivedAssetStorageReservations(prisma as never);
    expect((await bothHosts(t)).reservedStorageBytes, "custody cannot delete it, so accounting must not drop it").toBe(BigInt(3 * MIB));

    await age(hold, ttl() + grace() + 1_000);
    expect(await reconcile()).toMatchObject({ claimed: 1, adopted: 1 });
    expect(await intentOf(hold.intentId)).toMatchObject({ state: "ADOPTED", resolvedBytes: BigInt(stored) });
    const rows = await prisma.evidencePartDerivedAsset.findMany({
      where: { evidenceId: rec.evidenceId, storageKey: key },
      select: { status: true, sizeBytes: true, storageVersionId: true },
    });
    expect(rows).toEqual([{ status: "FAILED", sizeBytes: stored, storageVersionId: expect.any(String) }]);
    await accountingEqualsStored(t, baseline, [rec.evidenceId]);
  }, 300_000);

  it("(a) the settle AND the fallback row both fail (database outage): the intent outlives the reservation; after recovery the reconciler adopts (locked) or deletes (unlocked)", async () => {
    const { t, baseline } = await tenantWithRoom(BigInt(8 * MIB));
    const lockedRec = await record(t, 0n);
    const freeRec = await record(t, 0n);
    const results: Array<{ hold: Awaited<ReturnType<typeof admit>>; key: string; versionId: string }> = [];
    for (const [rec, lock] of [[lockedRec, true], [freeRec, false]] as const) {
      const key = derivedKey(rec, "outage");
      const hold = await admit(t, rec, 2 * MIB, key);
      const versionId = fake.put(BUCKET, key, 2 * MIB, lock ? { legalHold: true } : {});
      // The database goes down after the upload: the settle fails ...
      const settled = await intents.settleDerivedAssetUnderIntent({
        hold,
        client: deadClient,
        record: {
          teamId: t.personalTeamId,
          evidenceId: rec.evidenceId,
          evidencePartId: rec.partId,
          assetKind: "image_thumbnail",
          status: "COMPLETED",
          derivedSha256: "d".repeat(64),
          sizeBytes: 2 * MIB,
          storageBucket: BUCKET,
          storageKey: key,
          storageVersionId: versionId,
        },
      });
      expect(settled.ok).toBe(false);
      // ... and so does the fallback (nothing is deleted while the database cannot be read).
      const outcome = await disposal.disposeUnsettledDerivedObject({
        key: hold.key,
        heldSince: hold.reservedAtUtc,
        intentId: hold.intentId,
        object: { bucket: BUCKET, key, versionId },
        written: { derivedSha256: "d".repeat(64), sizeBytes: 2 * MIB, contentType: "image/webp" },
        reason: "persist_failed:db_down",
        client: deadClient,
      });
      expect(outcome).toBe("reservation_kept");
      results.push({ hold, key, versionId });
    }
    expect(fake.storedBytes([lockedRec.evidenceId, freeRec.evidenceId])).toBe(BigInt(4 * MIB));
    for (const r of results) await age(r.hold, ttl() + 1_000);
    expect((await bothHosts(t)).reservedStorageBytes, "both stored objects still counted after their reservations lapsed").toBe(BigInt(4 * MIB));

    // The database recovers; the reconciler judges both keys.
    for (const r of results) await age(r.hold, ttl() + grace() + 1_000);
    expect(await reconcile()).toMatchObject({ claimed: 2, adopted: 1, deleted: 1 });
    expect((await intentOf(results[0]!.hold.intentId)).state).toBe("ADOPTED");
    expect((await intentOf(results[1]!.hold.intentId)).state).toBe("DELETED");
    expect(fake.storedBytes([freeRec.evidenceId])).toBe(0n);
    await accountingEqualsStored(t, baseline, [lockedRec.evidenceId, freeRec.evidenceId]);
  }, 300_000);

  it("(c) a settle stalled on a lock is cancelled BY THE DATABASE within its window (no statement left waiting) and never commits later", async () => {
    const { t, baseline } = await tenantWithRoom(BigInt(6 * MIB));
    const rec = await record(t, 0n);
    const key = derivedKey(rec, "stalled");
    const hold = await admit(t, rec, 2 * MIB, key);
    const versionId = fake.put(BUCKET, key, 2 * MIB, { legalHold: true });

    // Another session holds the derived row's lock and does not let go.
    const blocker = await blockerPool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      `SELECT 1 FROM "evidence_part_derived_assets" WHERE "team_id" = $1::uuid AND "evidence_part_id" = $2::uuid AND "asset_kind" = 'image_thumbnail' AND "variant_key" = 'default' FOR UPDATE`,
      [t.personalTeamId, rec.partId],
    );
    const record_ = {
      teamId: t.personalTeamId,
      evidenceId: rec.evidenceId,
      evidencePartId: rec.partId,
      assetKind: "image_thumbnail" as const,
      status: "COMPLETED" as const,
      derivedSha256: "d".repeat(64),
      sizeBytes: 2 * MIB,
      storageBucket: BUCKET,
      storageKey: key,
      storageVersionId: versionId,
    };
    let settled: Awaited<ReturnType<typeof intents.settleDerivedAssetUnderIntent>>;
    const started = Date.now();
    try {
      // The window left is 2 s (a holder near the end of its reservation).
      settled = await intents.settleDerivedAssetUnderIntent({ hold, record: record_, deadlineAt: Date.now() + 2_000 });
      const elapsed = Date.now() - started;
      expect(settled).toEqual({ ok: false, reason: "settle_cancelled_by_database" });
      expect(elapsed, "returned inside its window").toBeLessThan(5_000);
      // The SERVER ended the waiting statement: no other session waits on a lock now.
      const waiting = (await prisma.$queryRaw`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`) as Array<{ n: number }>;
      expect(waiting[0]!.n, "a client that merely stopped waiting would leave the statement queued on the lock").toBe(0);
    } finally {
      await blocker.query("COMMIT");
      blocker.release();
    }
    await sleep(1_500);
    const row = await prisma.evidencePartDerivedAsset.findFirstOrThrow({
      where: { evidencePartId: rec.partId, assetKind: "image_thumbnail", variantKey: "default" },
      select: { status: true, storageKey: true },
    });
    expect(row.status, "the cancelled settle never committed after the lock was released").not.toBe("COMPLETED");
    expect((await intentOf(hold.intentId)).state, "the intent still holds the bytes").toBe("OPEN");
    expect((await bothHosts(t)).reservedStorageBytes).toBe(BigInt(2 * MIB));

    // The holder then disposes: the locked version is ADOPTED with the intent, atomically.
    const outcome = await disposal.disposeUnsettledDerivedObject({
      key: hold.key,
      heldSince: hold.reservedAtUtc,
      intentId: hold.intentId,
      object: { bucket: BUCKET, key, versionId },
      written: { derivedSha256: "d".repeat(64), sizeBytes: 2 * MIB, contentType: "image/webp" },
      reason: settled!.ok ? "x" : settled!.reason,
    });
    expect(outcome).toBe("retained");
    expect((await intentOf(hold.intentId)).state).toBe("ADOPTED");
    await accountingEqualsStored(t, baseline, [rec.evidenceId]);
  }, 300_000);

  it("fencing: a replaced holder can neither renew nor settle; both intents count while either may write; the reconciler waits for the live holder and then removes only the stale version", async () => {
    const { t, baseline } = await tenantWithRoom(BigInt(8 * MIB));
    const rec = await record(t, 0n);
    const key = derivedKey(rec, "same-content"); // a retry writes the same content-addressed key
    const a = await admit(t, rec, 2 * MIB, key);
    await sleep(5);
    const b = await admit(t, rec, 2 * MIB, key); // retry B replaces A's reservation; A still runs
    expect(await workerBilling.renewDerivedArtifactReservation(a), "A's fence is dead").toBeNull();
    expect((await bothHosts(t)).reservedStorageBytes, "A's in-flight bytes are not dropped by the replacement").toBe(BigInt(4 * MIB));

    const recordFor = (versionId: string) => ({
      teamId: t.personalTeamId,
      evidenceId: rec.evidenceId,
      evidencePartId: rec.partId,
      assetKind: "image_thumbnail" as const,
      status: "COMPLETED" as const,
      derivedSha256: "d".repeat(64),
      sizeBytes: 2 * MIB,
      storageBucket: BUCKET,
      storageKey: key,
      storageVersionId: versionId,
    });
    const vA = fake.put(BUCKET, key, 2 * MIB); // A's PUT lands anyway
    expect(await intents.settleDerivedAssetUnderIntent({ hold: a, record: recordFor(vA) })).toEqual({
      ok: false,
      reason: "storage_reservation_lost_at_settle",
    });
    const vB = fake.put(BUCKET, key, 2 * MIB);
    // A's window and grace are long over, but B (same key) is live and has
    // not settled yet: the key is not judged (B's version would look
    // unreferenced and could be removed under it).
    await age(a, ttl() + grace() + 1_000);
    expect((await reconcile()).claimed, "no judgment of a key a live holder may still write or settle").toBe(0);
    await prisma.$executeRaw`UPDATE "derived_asset_storage_intents" SET "holder_stamp_utc" = NOW() WHERE "id" = ${a.intentId}::uuid`;
    const settledB = await intents.settleDerivedAssetUnderIntent({ hold: b, record: recordFor(vB) });
    expect(settledB.ok).toBe(true);
    expect((await intentOf(b.intentId)).state).toBe("SETTLED");
    expect((await bothHosts(t)).reservedStorageBytes, "A still counted; B counted once, by its row").toBe(BigInt(2 * MIB));

    // A's reservation lapses; until A's own window and grace pass, the key is not judged.
    await age(a, ttl() + 1_000);
    expect((await reconcile()).claimed).toBe(0);
    await age(a, ttl() + grace() + 1_000);
    expect(await reconcile()).toMatchObject({ claimed: 1, deleted: 1 });
    const left = await fake.store.listVersions({ bucket: BUCKET, key }, new AbortController().signal);
    expect(left.map((v) => v.versionId), "B's recorded version is never touched").toEqual([vB]);
    await accountingEqualsStored(t, baseline, [rec.evidenceId]);
  }, 300_000);

  it("fencing: a zombie holder cannot settle once the reconciler resolved its intent (no double count), even if its reservation still looked live", async () => {
    const { t, baseline } = await tenantWithRoom(BigInt(6 * MIB));
    const rec = await record(t, 0n);
    const key = derivedKey(rec, "zombie");
    const hold = await admit(t, rec, 2 * MIB, key);
    const versionId = fake.put(BUCKET, key, 2 * MIB, { legalHold: true });
    // Only the intent is aged (the row's stamp stays live): the intent fence alone must refuse.
    fake.backdate(BUCKET, key, new Date(Date.now() - ttl() - grace()));
    await prisma.$executeRaw`UPDATE "derived_asset_storage_intents" SET "holder_stamp_utc" = NOW() - make_interval(secs => ${(ttl() + grace() + 1_000) / 1000}::double precision) WHERE "id" = ${hold.intentId}::uuid`;
    expect(await reconcile()).toMatchObject({ claimed: 1, adopted: 1 });
    const settled = await intents.settleDerivedAssetUnderIntent({
      hold,
      record: {
        teamId: t.personalTeamId,
        evidenceId: rec.evidenceId,
        evidencePartId: rec.partId,
        assetKind: "image_thumbnail",
        status: "COMPLETED",
        derivedSha256: "d".repeat(64),
        sizeBytes: 2 * MIB,
        storageBucket: BUCKET,
        storageKey: key,
        storageVersionId: versionId,
      },
    });
    expect(settled).toEqual({ ok: false, reason: "storage_intent_not_open_at_settle" });
    expect(await workerBilling.renewDerivedArtifactReservation(hold), "nor renew a reservation whose intent is resolved").toBeNull();
    await workerBilling.releaseDerivedArtifactReservation(hold.key, hold.reservedAtUtc);
    await accountingEqualsStored(t, baseline, [rec.evidenceId]);
  }, 300_000);

  it("concurrent uploads against quota: exactly the room is admitted; holders that die after uploading keep their room until reconciled; then accounting equals what is stored", async () => {
    const { t, baseline } = await tenantWithRoom(BigInt(5 * MIB));
    const recs = await Promise.all([record(t, 0n), record(t, 0n), record(t, 0n), record(t, 0n)]);
    const verdicts = await Promise.all(recs.map((r, i) => reserve(t, r, 2 * MIB, derivedKey(r, `c${i}`))));
    const admitted = verdicts.flatMap((v, i) => (v.allowed ? [{ hold: v.hold, rec: recs[i]!, key: derivedKey(recs[i]!, `c${i}`) }] : []));
    expect(admitted, "2 x 2 MiB fit in 5 MiB, a third does not").toHaveLength(2);
    expect((await bothHosts(t)).storageBytesUsed - baseline).toBe(BigInt(4 * MIB));

    // Both upload, then both processes die. One object is under a legal hold.
    fake.put(BUCKET, admitted[0]!.key, 2 * MIB, { legalHold: true });
    fake.put(BUCKET, admitted[1]!.key, 2 * MIB);
    for (const a of admitted) await age(a.hold, ttl() + 1_000);
    const late = await record(t, 0n);
    expect((await reserve(t, late, 2 * MIB, derivedKey(late, "late"))).allowed, "expired reservations free nothing while the bytes may exist").toBe(false);

    for (const a of admitted) await age(a.hold, ttl() + grace() + 1_000);
    expect(await reconcile()).toMatchObject({ claimed: 2, adopted: 1, deleted: 1 });
    const ids = recs.map((r) => r.evidenceId);
    await accountingEqualsStored(t, baseline, ids);
    // 5 MiB - 2 MiB adopted = 3 MiB of room: one more 2 MiB fits, a second does not.
    const late2 = await record(t, 0n);
    expect((await reserve(t, late, 2 * MIB, derivedKey(late, "late"))).allowed).toBe(true);
    expect((await reserve(t, late2, 2 * MIB, derivedKey(late2, "late2"))).allowed).toBe(false);
  }, 300_000);

  // ---------------------------------------------------------------------------
  // Review findings (closure follow-up): a holder arriving AFTER the claim, and
  // a row that references the key with no version.
  // ---------------------------------------------------------------------------

  const completedRecord = (t: PersonalTenant, rec: { evidenceId: string; partId: string }, key: string, versionId: string) => ({
    teamId: t.personalTeamId,
    evidenceId: rec.evidenceId,
    evidencePartId: rec.partId,
    assetKind: "image_thumbnail" as const,
    status: "COMPLETED" as const,
    derivedSha256: "d".repeat(64),
    sizeBytes: 2 * MIB,
    storageBucket: BUCKET,
    storageKey: key,
    storageVersionId: versionId,
  });

  it("a retry that reserves the SAME key after the claim (store clock lagging): its upload and in-flight parts are never deleted, adopted or aborted; after it settles the stale version alone is removed", async () => {
    const { t, baseline } = await tenantWithRoom(BigInt(8 * MIB));
    const rec = await record(t, 0n);
    const key = derivedKey(rec, "retry-after-claim");
    const a = await admit(t, rec, 2 * MIB, key);
    const vA = fake.put(BUCKET, key, 2 * MIB); // A uploaded, then died before settling
    await age(a, ttl() + grace() + 1_000);

    let b: Awaited<ReturnType<typeof admit>> | null = null;
    let vB = "";
    let bUpload = "";
    // The store's clock lags the database's: B's objects carry timestamps
    // inside A's old window, so only the holder re-check can tell them apart.
    const lagging = new Date(Date.now() - ttl() - grace());
    fake.hooks.onListUploads = async () => {
      b = await admit(t, rec, 2 * MIB, key); // the retry: same row, same content-addressed key
      vB = fake.put(BUCKET, key, 2 * MIB, {}, lagging);
      bUpload = fake.createMultipart(BUCKET, key, lagging);
    };
    expect(await reconcile()).toMatchObject({ claimed: 1, resolved: 0, kept: 1 });
    const versions = (await fake.store.listVersions({ bucket: BUCKET, key }, new AbortController().signal)).map((v) => v.versionId);
    expect(versions.sort(), "nothing deleted").toEqual([vA, vB].sort());
    expect((await fake.store.listMultipartUploads({ bucket: BUCKET, key }, new AbortController().signal)).map((u) => u.uploadId), "B's parts not aborted").toEqual([bUpload]);
    expect(await prisma.evidencePartDerivedAsset.count({ where: { storageKey: key, status: "FAILED" } }), "nothing adopted").toBe(0);
    expect((await intentOf(a.intentId)).state).toBe("OPEN");

    // B completes its upload and settles the canonical row for vB.
    fake.completeMultipart(BUCKET, key, bUpload);
    expect((await intents.settleDerivedAssetUnderIntent({ hold: b!, record: completedRecord(t, rec, key, vB) })).ok).toBe(true);
    // Next tick: A alone is judged; vB is referenced, vA is removed.
    expect(await reconcile()).toMatchObject({ claimed: 1, deleted: 1 });
    expect((await fake.store.listVersions({ bucket: BUCKET, key }, new AbortController().signal)).map((v) => v.versionId)).toEqual([vB]);
    await accountingEqualsStored(t, baseline, [rec.evidenceId]);
  }, 300_000);

  it("a writer WITHOUT an intent (an older image) uploading the same key after the claim: what the store created after the claimed window is never touched", async () => {
    const { t } = await tenantWithRoom(BigInt(8 * MIB));
    const rec = await record(t, 0n);
    const key = derivedKey(rec, "old-image-after-claim");
    const a = await admit(t, rec, 2 * MIB, key);
    const vA = fake.put(BUCKET, key, 2 * MIB);
    await age(a, ttl() + grace() + 1_000);
    let vB = "";
    let bUpload = "";
    fake.hooks.onListUploads = async () => {
      // An older worker image: a plain reservation (no declared target, no intent).
      const plain = await workerBilling.reserveDerivedArtifactStorage({
        evidenceId: rec.evidenceId,
        incomingBytes: 2 * MIB,
        reservation: { teamId: t.personalTeamId, evidencePartId: rec.partId, assetKind: "image_thumbnail", variantKey: "default" },
      });
      expect(plain.allowed && plain.hold.intentId).toBeNull();
      vB = fake.put(BUCKET, key, 2 * MIB);
      bUpload = fake.createMultipart(BUCKET, key);
    };
    expect(await reconcile()).toMatchObject({ claimed: 1, resolved: 0, kept: 1 });
    const versions = (await fake.store.listVersions({ bucket: BUCKET, key }, new AbortController().signal)).map((v) => v.versionId);
    expect(versions.sort(), "nothing deleted").toEqual([vA, vB].sort());
    expect((await fake.store.listMultipartUploads({ bucket: BUCKET, key }, new AbortController().signal)).map((u) => u.uploadId)).toEqual([bUpload]);
    expect(await prisma.evidencePartDerivedAsset.count({ where: { storageKey: key, status: "FAILED" } }), "nothing adopted").toBe(0);
    expect((await intentOf(a.intentId)).state, "A stays OPEN and counted").toBe("OPEN");

    // The older image settles its row for vB; the next tick removes only A's stale version.
    fake.completeMultipart(BUCKET, key, bUpload);
    expect((await runtime.recordDerivedAsset(completedRecord(t, rec, key, vB), prisma as never)).ok).toBe(true);
    expect(await reconcile()).toMatchObject({ claimed: 1, deleted: 1 });
    expect((await fake.store.listVersions({ bucket: BUCKET, key }, new AbortController().signal)).map((v) => v.versionId)).toEqual([vB]);
  }, 300_000);

  async function legacyRow(t: PersonalTenant, rec: { evidenceId: string; partId: string }, key: string, sizeBytes: number, versionId: string | null) {
    await prisma.$executeRaw`
      INSERT INTO "evidence_part_derived_assets"
        ("team_id", "evidence_id", "evidence_part_id", "asset_kind", "status", "derived_sha256", "size_bytes",
         "storage_bucket", "storage_key", "storage_version_id", "variant_key", "generated_at_utc", "updated_at_utc")
      VALUES (${t.personalTeamId}::uuid, ${rec.evidenceId}::uuid, ${rec.partId}::uuid, 'image_thumbnail', 'COMPLETED',
              ${"e".repeat(64)}, ${sizeBytes}, ${BUCKET}, ${key}, ${versionId}, 'legacy-v0', NOW(), NOW())`;
  }

  it("a row referencing the key with a NULL version counts its object: the reconciler never deletes or adopts it (one version: resolved with no new row; more: kept OPEN)", async () => {
    const { t, baseline } = await tenantWithRoom(BigInt(8 * MIB));
    const rec = await record(t, 0n);
    const key = derivedKey(rec, "legacy-null-version");
    const vL = fake.put(BUCKET, key, 1 * MIB, {}, new Date(Date.now() - 86_400_000)); // the legacy object
    await legacyRow(t, rec, key, 1 * MIB, null);
    const a = await admit(t, rec, 2 * MIB, key); // a dead holder whose PUT never landed
    await age(a, ttl() + grace() + 1_000);
    expect(await reconcile()).toMatchObject({ claimed: 1, absent: 1 });
    expect(await intentOf(a.intentId)).toMatchObject({ state: "ABSENT", resolution: "reconciled_counted_by_key_reference" });
    expect((await fake.store.listVersions({ bucket: BUCKET, key }, new AbortController().signal)).map((v) => v.versionId), "the live object is kept").toEqual([vL]);
    expect(await prisma.evidencePartDerivedAsset.count({ where: { storageKey: key } }), "no new row").toBe(1);
    await accountingEqualsStored(t, baseline, [rec.evidenceId]);

    // A second holder whose version DID land: ambiguous against the NULL-version row, so kept OPEN, nothing touched.
    const b = await admit(t, rec, 2 * MIB, key);
    const vB = fake.put(BUCKET, key, 2 * MIB);
    await age(b, ttl() + grace() + 1_000);
    expect(await reconcile()).toMatchObject({ claimed: 1, resolved: 0, kept: 1 });
    expect((await fake.store.listVersions({ bucket: BUCKET, key }, new AbortController().signal)).map((v) => v.versionId).sort()).toEqual([vL, vB].sort());
    expect((await bothHosts(t)).reservedStorageBytes, "the ambiguous bytes stay counted").toBe(BigInt(2 * MIB));
    // Once only the row's object remains (an operator removed vB), the intent resolves with no new row.
    await fake.store.deleteVersion({ bucket: BUCKET, key, versionId: vB }, new AbortController().signal);
    expect(await reconcile()).toMatchObject({ claimed: 1, absent: 1 });
    await accountingEqualsStored(t, baseline, [rec.evidenceId]);
  }, 300_000);

  it("an unversioned store (\"null\" version) referenced by a row: the reconciler and the holder's disposal never delete it", async () => {
    const { t } = await tenantWithRoom(BigInt(8 * MIB));
    const rec = await record(t, 0n);
    const key = derivedKey(rec, "unversioned");
    // An unversioned store keeps one object per key, version "null", counted by a row.
    fake.versions.set(`${BUCKET}\u0000${key}`, [
      { versionId: "null", sizeBytes: 1 * MIB, legalHold: false, retainUntil: null, lastModified: new Date(Date.now() - 86_400_000) },
    ]);
    await legacyRow(t, rec, key, 1 * MIB, "null");
    const hold = await admit(t, rec, 1 * MIB, key);
    // The holder's settle failed after a PUT that overwrote the key ("null" again).
    const outcome = await disposal.disposeUnsettledDerivedObject({
      key: hold.key,
      heldSince: hold.reservedAtUtc,
      intentId: hold.intentId,
      object: { bucket: BUCKET, key, versionId: "null" },
      written: { derivedSha256: "d".repeat(64), sizeBytes: 1 * MIB, contentType: "image/webp" },
      reason: "persist_failed:x",
    });
    expect(outcome).toBe("already_counted");
    expect(fake.storedBytes([key]), "not deleted by the holder").toBe(BigInt(1 * MIB));
    expect((await intentOf(hold.intentId)).state).toBe("ADOPTED");

    // A dead holder on the same key, judged by the reconciler: nothing deleted either.
    const dead = await admit(t, rec, 1 * MIB, key);
    await age(dead, ttl() + grace() + 1_000);
    expect(await reconcile()).toMatchObject({ claimed: 1, absent: 1 });
    expect(fake.storedBytes([key]), "not deleted by the reconciler").toBe(BigInt(1 * MIB));
  }, 300_000);

  it("the holder's disposal of a KNOWN real version never deletes it while a row references the key with a NULL version (adopted instead)", async () => {
    const { t, baseline } = await tenantWithRoom(BigInt(8 * MIB));
    const rec = await record(t, 0n);
    const key = derivedKey(rec, "legacy-known-version");
    fake.put(BUCKET, key, 1 * MIB, {}, new Date(Date.now() - 86_400_000));
    await legacyRow(t, rec, key, 1 * MIB, null);
    const hold = await admit(t, rec, 2 * MIB, key);
    const v = fake.put(BUCKET, key, 2 * MIB);
    const outcome = await disposal.disposeUnsettledDerivedObject({
      key: hold.key,
      heldSince: hold.reservedAtUtc,
      intentId: hold.intentId,
      object: { bucket: BUCKET, key, versionId: v },
      written: { derivedSha256: "d".repeat(64), sizeBytes: 2 * MIB, contentType: "image/webp" },
      reason: "persist_failed:x",
    });
    expect(outcome).toBe("retained");
    expect(fake.storedBytes([key])).toBe(BigInt(3 * MIB));
    await accountingEqualsStored(t, baseline, [rec.evidenceId]);
  }, 300_000);

  it("a holder that never started a write releases its intent; a reservation without a declared target holds no intent (plain M676 semantics)", async () => {
    const { t } = await tenantWithRoom(BigInt(6 * MIB));
    const rec = await record(t, 0n);
    const hold = await admit(t, rec, 2 * MIB, derivedKey(rec, "never"));
    await workerBilling.releaseUnwrittenDerivedArtifactHold(hold);
    expect((await intentOf(hold.intentId)).state).toBe("RELEASED");
    expect((await bothHosts(t)).reservedStorageBytes).toBe(0n);

    const plain = await workerBilling.reserveDerivedArtifactStorage({
      evidenceId: rec.evidenceId,
      incomingBytes: MIB,
      reservation: { teamId: t.personalTeamId, evidencePartId: rec.partId, assetKind: "image_thumbnail", variantKey: "default" },
    });
    expect(plain.allowed && plain.hold.intentId).toBeNull();
    expect((await bothHosts(t)).reservedStorageBytes).toBe(BigInt(MIB));
  }, 300_000);
});
