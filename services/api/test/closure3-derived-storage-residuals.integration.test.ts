/**
 * closure3/store — FV2-RESIDUAL-2 / -3 / -5 / -6: the derived write intents
 * against a REAL S3 implementation (local MinIO, a bucket this suite creates
 * with Object Lock, hence versioning), live PostgreSQL 16 (all migrations),
 * the REAL worker processor (`processDerivedAssetJob`, real sharp), the REAL
 * worker S3 client and holder disposal (`deleteObjectVersions`), the REAL
 * reconciler with the REAL `s3DerivedObjectStore`.
 *
 *   -5  the processor's intent path end to end: reserve with a declared
 *       target, PUT, settle under the intent (SETTLED, never counted twice);
 *       a lost PUT answer under Object Lock found and adopted by the reconciler.
 *   -2  a holder FROZEN past its write margin + the grace: the reconciler
 *       judges the key on a listing taken BEFORE the late PUT lands (ABSENT).
 *       Before this closure the surviving holder's disposal could neither
 *       delete (Object Lock) nor adopt (intent no longer OPEN) and released
 *       nothing that counted: an UNDER-COUNT. Now it re-declares the write.
 *   -3  atomicity of the settle with its intent: the process dies between the
 *       upload and the commit; the commit applies but its answer is lost; the
 *       COMMIT stalls (the intent row stays locked; the reconciler skips it)
 *       and then commits or rolls back. In every case the reconciler converges
 *       with no under-count and no live object deleted.
 *   -6  every store call above is MinIO's real answer (versions, retention,
 *       legal hold, deletes refused under lock). Real AWS S3 is NOT exercised.
 *
 * A real object cannot be backdated, so where the reconciler must judge a key
 * holding an object written moments ago, its grace is compressed to zero for
 * that call (`graceMs: 0`, a supported parameter) after the holder's stamp is
 * moved back by the reservation TTL (the database clock is the injected
 * clock); the claim and freshness rules are otherwise exactly production's.
 */
import { createHash, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { JOB_NAMES, getWorkEntryOrThrow } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps, type PersonalTenant } from "./point7/product-fixtures.js";

type PutParams = { bucket: string; key: string; body: Buffer; contentType: string; lock?: unknown; abortSignal?: AbortSignal };

const HOOK = vi.hoisted(() => ({
  put: null as null | ((p: PutParams, real: (p: PutParams) => Promise<{ versionId: string | null }>) => Promise<unknown>),
  lock: null as null | { mode: "GOVERNANCE" | "COMPLIANCE"; retainUntil: Date },
}));

vi.mock("../../worker/src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../worker/src/storage.js")>();
  return {
    ...actual,
    putObjectBuffer: async (p: PutParams) => {
      const real = actual.putObjectBuffer as unknown as (p: PutParams) => Promise<{ versionId: string | null }>;
      return HOOK.put ? HOOK.put(p, real) : real(p);
    },
  };
});
vi.mock("../../worker/src/object-retention.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../worker/src/object-retention.js")>();
  return { ...actual, artifactLockFor: async () => HOOK.lock };
});

/** A solid-colour RGB PNG (the API package has no image library). */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => rgb[i % 3]!)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const TAG = randomUUID().slice(0, 8);
const BUCKET = `c3-derived-${TAG}`;
const ENTRY = getWorkEntryOrThrow(JOB_NAMES.GENERATE_DERIVED_ASSET);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const governance = () => ({ mode: "GOVERNANCE" as const, retainUntil: new Date(Date.now() + 86_400_000) });

describe("closure3/store — derived write intents on a real S3 store (live PostgreSQL 16 + MinIO Object Lock)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let s3: S3Client;
  let runtime: typeof import("@proovra/shared-runtime");
  let apiUsage: (typeof import("../src/services/workspace-usage.service.js"))["getWorkspaceUsage"];
  let apiScope: (typeof import("../src/services/billing-enforcement.service.js"))["resolveEnforcementScopeForRequester"];
  let workerBilling: typeof import("../../worker/src/workspace-billing.js");
  let intents: typeof import("../../worker/src/derived-storage-intent.js");
  let disposal: typeof import("../../worker/src/derived-unsettled-object.js");
  let processor: typeof import("../../worker/src/derived-assets.processor.js");
  let workerStorage: typeof import("../../worker/src/storage.js");
  let image: Buffer;
  const savedLockEnv = process.env.S3_OBJECT_LOCK_ENABLED;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    const { signJwt } = await import("../src/services/jwt.js");
    ({ getWorkspaceUsage: apiUsage } = await import("../src/services/workspace-usage.service.js"));
    ({ resolveEnforcementScopeForRequester: apiScope } = await import("../src/services/billing-enforcement.service.js"));
    workerBilling = await import("../../worker/src/workspace-billing.js");
    intents = await import("../../worker/src/derived-storage-intent.js");
    disposal = await import("../../worker/src/derived-unsettled-object.js");
    processor = await import("../../worker/src/derived-assets.processor.js");
    workerStorage = await import("../../worker/src/storage.js");
    ({ s3 } = workerStorage);
    deps = {
      prisma: prisma as never,
      tag: `c3dr-${TAG}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    process.env.S3_OBJECT_LOCK_ENABLED = "true";
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET, ObjectLockEnabledForBucket: true }));
    image = solidPng(640, 480, [0x33, 0x66, 0xcc]);
  }, 600_000);

  // The shared setup re-asserts the safe test environment (Object Lock off)
  // before every test: this suite runs with the worker applying locks.
  beforeEach(() => {
    process.env.S3_OBJECT_LOCK_ENABLED = "true";
  });

  afterAll(async () => {
    if (savedLockEnv === undefined) delete process.env.S3_OBJECT_LOCK_ENABLED;
    else process.env.S3_OBJECT_LOCK_ENABLED = savedLockEnv;
    // The suite's own bucket only: every version, governance bypassed.
    const listed = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET })).catch(() => null);
    for (const v of [...(listed?.Versions ?? []), ...(listed?.DeleteMarkers ?? [])]) {
      await s3
        .send(new DeleteObjectCommand({ Bucket: BUCKET, Key: v.Key!, VersionId: v.VersionId, BypassGovernanceRetention: true }))
        .catch(() => undefined);
    }
    await s3.send(new DeleteBucketCommand({ Bucket: BUCKET })).catch(() => undefined);
    await h?.cleanup();
  });

  // -------------------------------------------------------------------------
  const ttl = () => runtime.DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS;
  const grace = () => runtime.DERIVED_ASSET_INTENT_RECONCILE_GRACE_MS;
  const store = () => intents.s3DerivedObjectStore(s3 as never);
  const reconcile = (graceMs?: number) =>
    intents.reconcileDerivedAssetStorageIntents({ store: store(), client: prisma as never, ...(graceMs === undefined ? {} : { graceMs }) });

  async function bothHosts(t: PersonalTenant) {
    const api = await apiUsage(await apiScope({ ownerUserId: t.owner.userId, teamId: t.personalTeamId }));
    const wk = await workerBilling.getWorkspaceUsage(
      await workerBilling.resolveWorkspaceScopeForEvidence({ ownerUserId: t.owner.userId, teamId: t.personalTeamId }),
    );
    expect(wk.storageBytesUsed, "worker = API (storageBytesUsed)").toBe(api.storageBytesUsed);
    expect(wk.reservedStorageBytes, "worker = API (reservedStorageBytes)").toBe(api.reservedStorageBytes);
    return api;
  }

  async function tenant() {
    const t = await seedPersonalTenant(deps, "FREE");
    return { t, baseline: (await bothHosts(t)).storageBytesUsed };
  }

  /** An image record with one part whose bytes are in the bucket, and its PENDING thumbnail row. */
  async function imageRecord(t: PersonalTenant) {
    const key = `c3dr/${TAG}/${randomUUID()}.png`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: image, ContentType: "image/png" }));
    const ev = await prisma.evidence.create({
      data: {
        title: "closure3 derived",
        type: "PHOTO",
        status: "SIGNED",
        teamId: t.personalTeamId,
        organizationId: t.personalOrganizationId,
        ownerUserId: t.owner.userId,
        storageBucket: BUCKET,
        storageKey: key,
        sizeBytes: BigInt(image.length),
      } as never,
      select: { id: true },
    });
    const part = await prisma.evidencePart.create({
      data: {
        evidenceId: ev.id,
        partIndex: 0,
        storageBucket: BUCKET,
        storageKey: key,
        sha256: createHash("sha256").update(image).digest("hex"),
        sizeBytes: BigInt(image.length),
        mimeType: "image/png",
      } as never,
      select: { id: true },
    });
    const request = await prisma.evidencePartDerivedAsset.create({
      data: { teamId: t.personalTeamId, evidenceId: ev.id, evidencePartId: part.id, assetKind: "image_thumbnail", variantKey: "default", status: "PENDING" } as never,
      select: { id: true },
    });
    return { evidenceId: ev.id, partId: part.id, requestId: request.id, baselineAfter: (await bothHosts(t)).storageBytesUsed };
  }

  const job = (requestId: string) =>
    ({
      id: `c3dr-${requestId}`,
      name: ENTRY.workName,
      attemptsMade: 0,
      opts: { attempts: 3 },
      data: { commandId: requestId, traceId: "t", schemaVersion: ENTRY.schemaVersion },
    }) as never;

  async function storedBytes(evidenceIds: string[]): Promise<bigint> {
    let n = 0n;
    for (const id of evidenceIds) {
      const res = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: `derived-assets/${id}/` }));
      for (const v of res.Versions ?? []) n += BigInt(v.Size ?? 0);
    }
    return n;
  }

  /** THE INVARIANT at rest: what both meters count above the baseline equals what is stored. */
  async function accountingEqualsStored(t: PersonalTenant, baseline: bigint, evidenceIds: string[]) {
    const u = await bothHosts(t);
    expect(u.reservedStorageBytes, "nothing left reserved or OPEN").toBe(0n);
    expect(u.storageBytesUsed - baseline, "accounting = bytes actually stored").toBe(await storedBytes(evidenceIds));
  }
  /** While anything may still be written: never LESS than stored. */
  async function neverUnderCounted(t: PersonalTenant, baseline: bigint, evidenceIds: string[]) {
    const u = await bothHosts(t);
    expect(u.storageBytesUsed - baseline, "accounting >= bytes actually stored").toBeGreaterThanOrEqual(await storedBytes(evidenceIds));
  }

  /** Move a holder's clock back (database clock): its intent's stamp and, optionally, its reservation. */
  async function age(intentId: string, ms: number, withReservation = true) {
    const secs = ms / 1000;
    await prisma.$executeRaw`UPDATE "derived_asset_storage_intents" SET "holder_stamp_utc" = NOW() - make_interval(secs => ${secs}::double precision) WHERE "id" = ${intentId}::uuid`;
    if (withReservation) {
      await prisma.$executeRaw`UPDATE "evidence_part_derived_assets" SET "storage_reserved_at_utc" = NOW() - make_interval(secs => ${secs}::double precision) WHERE "storage_reservation_token" = ${intentId}::uuid`;
    }
  }
  const openIntents = (evidenceId: string) =>
    prisma.derivedAssetStorageIntent.findMany({ where: { evidenceId, state: "OPEN" }, orderBy: { createdAtUtc: "asc" } });
  const intentOf = (id: string) => prisma.derivedAssetStorageIntent.findUniqueOrThrow({ where: { id } });
  /**
   * The reconciler is database-wide (other suites may share the database):
   * a tick is judged by what it did to THIS test's intents only.
   */
  async function judge(ids: string[], graceMs?: number) {
    await reconcile(graceMs);
    return Promise.all(ids.map(async (id) => {
      const i = await intentOf(id);
      return { state: i.state, claimed: i.reconcileAttempts > 0 };
    }));
  }

  async function admit(t: PersonalTenant, rec: { evidenceId: string; partId: string }, bytes: number, key: string) {
    const v = await workerBilling.reserveDerivedArtifactStorage({
      evidenceId: rec.evidenceId,
      incomingBytes: bytes,
      reservation: { teamId: t.personalTeamId, evidencePartId: rec.partId, assetKind: "image_thumbnail", variantKey: "default" },
      target: { bucket: BUCKET, key, derivedSha256: "d".repeat(64), contentType: "image/webp" },
    });
    if (!v.allowed) throw new Error(`not admitted: ${v.reason}`);
    return v.hold;
  }
  const recordFor = (t: PersonalTenant, rec: { evidenceId: string; partId: string }, key: string, size: number, versionId: string | null) => ({
    teamId: t.personalTeamId,
    evidenceId: rec.evidenceId,
    evidencePartId: rec.partId,
    assetKind: "image_thumbnail" as const,
    status: "COMPLETED" as const,
    derivedSha256: "d".repeat(64),
    sizeBytes: size,
    storageBucket: BUCKET,
    storageKey: key,
    storageVersionId: versionId,
  });

  const reset = () => {
    HOOK.put = null;
    HOOK.lock = null;
  };

  // ===========================================================================
  // FV2-RESIDUAL-5 — the processor's intent path, end to end
  // ===========================================================================
  it("-5: processDerivedAssetJob reserves with a declared target, writes under Object Lock and settles UNDER its intent (SETTLED, counted once)", async () => {
    reset();
    HOOK.lock = governance();
    const { t } = await tenant();
    const rec = await imageRecord(t);
    let reservedAtPut: bigint | null = null;
    HOOK.put = async (p, real) => {
      reservedAtPut = (await bothHosts(t)).reservedStorageBytes;
      return real(p);
    };
    const out = await processor.processDerivedAssetJob(job(rec.requestId));
    expect(out).toEqual({ ok: true, status: "COMPLETED" });
    expect(reservedAtPut, "the PUT ran under an OPEN intent").toBeGreaterThan(0n);
    const intentRows = await prisma.derivedAssetStorageIntent.findMany({ where: { evidenceId: rec.evidenceId } });
    expect(intentRows).toHaveLength(1);
    expect(intentRows[0]).toMatchObject({ state: "SETTLED", resolution: "settled" });
    const row = await prisma.evidencePartDerivedAsset.findUniqueOrThrow({ where: { id: rec.requestId } });
    expect(row).toMatchObject({ status: "COMPLETED", storageReservedBytes: null });
    expect(row.storageVersionId, "the version MinIO returned is recorded").toBeTruthy();
    expect(intentRows[0]!.resolvedAssetId).toBe(row.id);
    await accountingEqualsStored(t, rec.baselineAfter, [rec.evidenceId]);
    // A replay changes nothing.
    expect(await processor.processDerivedAssetJob(job(rec.requestId))).toEqual({ ok: true, status: "COMPLETED" });
    await accountingEqualsStored(t, rec.baselineAfter, [rec.evidenceId]);
  }, 300_000);

  it("-5: a lost PUT answer through the processor under Object Lock: the intent stays OPEN and counted; the reconciler finds the version and ADOPTS it", async () => {
    reset();
    HOOK.lock = governance();
    const { t } = await tenant();
    const rec = await imageRecord(t);
    HOOK.put = async (p, real) => {
      await real(p);
      throw new Error("socket hang up ETIMEDOUT");
    };
    await expect(processor.processDerivedAssetJob(job(rec.requestId))).rejects.toThrow(/ETIMEDOUT/);
    const open = await openIntents(rec.evidenceId);
    expect(open, "an unknown version under lock: kept OPEN").toHaveLength(1);
    await neverUnderCounted(t, rec.baselineAfter, [rec.evidenceId]);
    expect(await storedBytes([rec.evidenceId])).toBeGreaterThan(0n);

    await sleep(1_500);
    await age(open[0]!.id, ttl() + 1_000);
    expect(await judge([open[0]!.id], 0)).toEqual([{ state: "ADOPTED", claimed: true }]);
    await accountingEqualsStored(t, rec.baselineAfter, [rec.evidenceId]);
  }, 300_000);

  // ===========================================================================
  // FV2-RESIDUAL-2 — a holder frozen past its write margin + the grace
  // ===========================================================================
  it("-2: the frozen-holder bound is margin + grace past the local write deadline (exact arithmetic of the shared constants)", () => {
    const sentAt = 1_000_000_000_000;
    const deadline = runtime.derivedAssetReservationWriteDeadline(sentAt);
    const margin = runtime.DERIVED_ASSET_RESERVATION_SAFETY_MARGIN_MS;
    expect(deadline).toBe(sentAt + ttl() - margin);
    // The reconciler judges a key no earlier than (stamp + TTL + grace), and
    // the database stamp is never earlier than `sentAt`: a write that lands
    // after the judgment was still in flight at least margin + grace after
    // the holder's own deadline (3 + 5 = 8 minutes today).
    expect(sentAt + ttl() + grace() - deadline).toBe(margin + grace());
    expect(margin + grace()).toBe(8 * 60 * 1000);
  });

  it("-2: frozen past margin + grace, the reconciler resolves ABSENT before the PUT lands; the SURVIVING holder re-declares the locked object and the reconciler adopts it (no under-count)", async () => {
    reset();
    HOOK.lock = governance();
    const { t } = await tenant();
    const rec = await imageRecord(t);
    let heldId: string | null = null;
    HOOK.put = async (p, real) => {
      // The holder passed its renewal and deadline check, then froze. On the
      // database clock (the injected clock) its stamp is now TTL + grace old:
      // the reconciler lists the key, finds nothing, resolves ABSENT.
      const [held] = await openIntents(rec.evidenceId);
      heldId = held!.id;
      await age(held!.id, ttl() + grace() + 1_000);
      expect(await judge([held!.id]), "judged on a listing taken before the PUT lands").toEqual([{ state: "ABSENT", claimed: true }]);
      // The holder resumes: its request reaches the store and is committed.
      return real(p);
    };
    const out = await processor.processDerivedAssetJob(job(rec.requestId));
    expect(heldId).not.toBeNull();
    expect(out.status).toBe("FAILED");
    const stored = await storedBytes([rec.evidenceId]);
    expect(stored, "Object Lock kept the late version").toBeGreaterThan(0n);
    // The disposal could not delete (lock) nor adopt (intent ABSENT): it
    // declared the write again, so the bytes stay counted.
    const open = await openIntents(rec.evidenceId);
    expect(open, "re-declared on a fresh OPEN intent").toHaveLength(1);
    expect(open[0]!.storageKey).toMatch(new RegExp(`^derived-assets/${rec.evidenceId}/`));
    await neverUnderCounted(t, rec.baselineAfter, [rec.evidenceId]);

    // The fresh intent is judged like any other: found, adopted, equal.
    await sleep(1_500);
    await age(open[0]!.id, ttl() + 1_000);
    expect(await judge([open[0]!.id], 0)).toEqual([{ state: "ADOPTED", claimed: true }]);
    await accountingEqualsStored(t, rec.baselineAfter, [rec.evidenceId]);
  }, 300_000);

  it("-2: the same freeze with an UNLOCKED object: the surviving holder deletes its own late version (proven by listing); nothing stays stored or counted", async () => {
    reset();
    const { t } = await tenant();
    const rec = await imageRecord(t);
    HOOK.put = async (p, real) => {
      const [held] = await openIntents(rec.evidenceId);
      await age(held!.id, ttl() + grace() + 1_000);
      expect(await judge([held!.id])).toEqual([{ state: "ABSENT", claimed: true }]);
      return real(p);
    };
    await processor.processDerivedAssetJob(job(rec.requestId));
    expect(await storedBytes([rec.evidenceId])).toBe(0n);
    expect(await openIntents(rec.evidenceId)).toHaveLength(0);
    await accountingEqualsStored(t, rec.baselineAfter, [rec.evidenceId]);
  }, 300_000);

  it("-2: a write that lands after its holder's window while its intent is still OPEN is not left OPEN forever: the disposal re-declares it and the reconciler converges", async () => {
    reset();
    HOOK.lock = governance();
    const { t } = await tenant();
    const rec = await imageRecord(t);
    const key = `derived-assets/${rec.evidenceId}/${rec.partId}/image_thumbnail-late.webp`;
    const hold = await admit(t, rec, 4096, key);
    // The holder's window ended (no reconciler ran yet), then the PUT lands,
    // its answer lost (version unknown).
    await age(hold.intentId!, ttl() + 1_000);
    await workerStorage.putObjectBuffer({ bucket: BUCKET, key, body: Buffer.alloc(4000, 7), contentType: "image/webp", lock: governance() });
    const outcome = await disposal.disposeUnsettledDerivedObject({
      key: hold.key,
      heldSince: hold.reservedAtUtc,
      intentId: hold.intentId,
      object: { bucket: BUCKET, key, versionId: null },
      written: { derivedSha256: "d".repeat(64), sizeBytes: 4096, contentType: "image/webp" },
      reason: "derived_put_deadline_exceeded",
    });
    expect(outcome).toBe("reservation_kept");
    const open = await openIntents(rec.evidenceId);
    expect(open, "the original (its window over) and a fresh one").toHaveLength(2);
    // The original alone would only ever be KEPT (the version is newer than its
    // window); judged together with the fresh one, the key converges.
    await sleep(1_500);
    for (const i of open) await age(i.id, ttl() + 1_000, false);
    expect(await judge(open.map((i) => i.id), 0)).toEqual([
      { state: "ADOPTED", claimed: true },
      { state: "ADOPTED", claimed: true },
    ]);
    await accountingEqualsStored(t, rec.baselineAfter, [rec.evidenceId]);
  }, 300_000);

  // ===========================================================================
  // FV2-RESIDUAL-3 — the settle is atomic with its intent; a stalled COMMIT
  // ===========================================================================
  it("-3: the process dies between the upload and the commit: the OPEN intent counts; the reconciler adopts the locked version and deletes the unlocked one", async () => {
    reset();
    const { t } = await tenant();
    const lockedRec = await imageRecord(t);
    const freeRec = await imageRecord(t);
    const baseline = freeRec.baselineAfter;
    const holds = [];
    for (const [rec, lock] of [[lockedRec, true], [freeRec, false]] as const) {
      const key = `derived-assets/${rec.evidenceId}/${rec.partId}/image_thumbnail-died.webp`;
      const hold = await admit(t, rec, 5000, key);
      await workerStorage.putObjectBuffer({ bucket: BUCKET, key, body: Buffer.alloc(5000, 3), contentType: "image/webp", lock: lock ? governance() : null });
      holds.push(hold); // ... and the process is gone: no settle, no disposal.
    }
    await neverUnderCounted(t, baseline, [lockedRec.evidenceId, freeRec.evidenceId]);
    await sleep(1_500);
    for (const hold of holds) await age(hold.intentId!, ttl() + 1_000);
    expect(await judge(holds.map((hd) => hd.intentId!), 0)).toEqual([
      { state: "ADOPTED", claimed: true },
      { state: "DELETED", claimed: true },
    ]);
    expect(await storedBytes([freeRec.evidenceId])).toBe(0n);
    expect(await storedBytes([lockedRec.evidenceId]), "the locked version is never deleted").toBe(5000n);
    await accountingEqualsStored(t, baseline, [lockedRec.evidenceId, freeRec.evidenceId]);
  }, 300_000);

  it("-3: the commit applies but its answer is lost: the holder's disposal finds the version counted (nothing deleted); the reconciler has nothing to judge", async () => {
    reset();
    const { t } = await tenant();
    const rec = await imageRecord(t);
    const key = `derived-assets/${rec.evidenceId}/${rec.partId}/image_thumbnail-lost-commit.webp`;
    const hold = await admit(t, rec, 6000, key);
    const put = await workerStorage.putObjectBuffer({ bucket: BUCKET, key, body: Buffer.alloc(6000, 4), contentType: "image/webp", lock: null });
    const versionId = (put as { versionId: string | null }).versionId;
    expect(versionId).toBeTruthy();
    const lostAnswer = new Proxy(prisma as unknown as PrismaClient, {
      get(target, prop, receiver) {
        if (prop === "$transaction") {
          return async (fn: never, opts: never) => {
            await target.$transaction(fn, opts); // COMMITTED ...
            throw new Error("Connection terminated unexpectedly"); // ... answer lost
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const settled = await intents.settleDerivedAssetUnderIntent({ hold, record: recordFor(t, rec, key, 6000, versionId), client: lostAnswer as never });
    expect(settled.ok, "the holder believes the settle failed").toBe(false);
    expect((await intentOf(hold.intentId!)).state, "yet it committed, atomically with the row").toBe("SETTLED");
    // What the processor does next on a failed settle: dispose. The version is
    // referenced by the committed row, so it is counted: nothing is deleted.
    const outcome = await disposal.disposeUnsettledDerivedObject({
      key: hold.key,
      heldSince: hold.reservedAtUtc,
      intentId: hold.intentId,
      object: { bucket: BUCKET, key, versionId },
      written: { derivedSha256: "d".repeat(64), sizeBytes: 6000, contentType: "image/webp" },
      reason: "persist_failed:settle_failed",
    });
    expect(outcome).toBe("already_counted");
    expect(await storedBytes([rec.evidenceId])).toBe(6000n);
    expect(await judge([hold.intentId!], 0), "a SETTLED intent is never judged").toEqual([{ state: "SETTLED", claimed: false }]);
    expect(await prisma.derivedAssetStorageIntent.count({ where: { evidenceId: rec.evidenceId, state: "OPEN" } })).toBe(0);
    await accountingEqualsStored(t, rec.baselineAfter, [rec.evidenceId]);
  }, 300_000);

  it("closure3 review L2: the holder's adoption commits but its answer is lost — the bytes are counted once by the retained row, never re-declared on a second intent", async () => {
    reset();
    const { t } = await tenant();
    const rec = await imageRecord(t);
    const key = `derived-assets/${rec.evidenceId}/${rec.partId}/image_thumbnail-adopt-lost.webp`;
    const hold = await admit(t, rec, 8000, key);
    const put = await workerStorage.putObjectBuffer({ bucket: BUCKET, key, body: Buffer.alloc(8000, 6), contentType: "image/webp", lock: governance() });
    const versionId = (put as { versionId: string | null }).versionId;
    const lostAnswer = new Proxy(prisma as unknown as PrismaClient, {
      get(target, prop, receiver) {
        if (prop === "$transaction") {
          return async (fn: never, opts: never) => {
            await target.$transaction(fn, opts); // the adoption COMMITS ...
            throw new Error("Connection terminated unexpectedly"); // ... its answer is lost
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    // The settle failed (say); the holder disposes: the locked version cannot
    // be deleted, so it is adopted with the intent — which commits, unanswered.
    const outcome = await disposal.disposeUnsettledDerivedObject({
      key: hold.key,
      heldSince: hold.reservedAtUtc,
      intentId: hold.intentId,
      object: { bucket: BUCKET, key, versionId },
      written: { derivedSha256: "d".repeat(64), sizeBytes: 8000, contentType: "image/webp" },
      reason: "persist_failed:settle_failed",
      client: lostAnswer as never,
    });
    expect(outcome, "the holder could not see its adoption succeed").toBe("reservation_kept");
    expect((await intentOf(hold.intentId!)).state).toBe("ADOPTED");
    expect(await openIntents(rec.evidenceId), "no second intent for bytes a row already counts").toHaveLength(0);
    await workerBilling.releaseDerivedArtifactReservation(hold.key, hold.reservedAtUtc);
    await accountingEqualsStored(t, rec.baselineAfter, [rec.evidenceId]);
  }, 300_000);

  it("-3: a STALLED commit keeps the intent row locked, so the reconciler skips it; it then commits (SETTLED) or rolls back (OPEN, later adopted) — never both, never neither", async () => {
    reset();
    const { t } = await tenant();
    for (const outcome of ["commit", "rollback"] as const) {
      const rec = await imageRecord(t);
      const key = `derived-assets/${rec.evidenceId}/${rec.partId}/image_thumbnail-stall-${outcome}.webp`;
      const hold = await admit(t, rec, 7000, key);
      const put = await workerStorage.putObjectBuffer({ bucket: BUCKET, key, body: Buffer.alloc(7000, 5), contentType: "image/webp", lock: governance() });
      const versionId = (put as { versionId: string | null }).versionId;
      await sleep(1_500);
      // Only the intent's stamp is old (the reservation is live, so the settle
      // is allowed): without the lock the reconciler WOULD claim it now.
      await age(hold.intentId!, ttl() + 1_000, false);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let reachedCommit!: () => void;
      const atCommit = new Promise<void>((r) => (reachedCommit = r));
      const stalling = new Proxy(prisma as unknown as PrismaClient, {
        get(target, prop, receiver) {
          if (prop === "$transaction") {
            return (fn: (tx: unknown) => Promise<unknown>, opts: never) =>
              target.$transaction(async (tx) => {
                const r = await fn(tx);
                reachedCommit();
                await gate; // every statement done, the COMMIT not yet durable
                if (outcome === "rollback") throw new Error("server crashed before the commit was durable");
                return r;
              }, opts);
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const settling = intents.settleDerivedAssetUnderIntent({ hold, record: recordFor(t, rec, key, 7000, versionId), client: stalling as never });
      await atCommit;
      expect(await judge([hold.intentId!], 0), "the stalled settle's locked intent is skipped").toEqual([{ state: "OPEN", claimed: false }]);
      release();
      const settled = await settling;
      if (outcome === "commit") {
        expect(settled.ok).toBe(true);
        expect(await judge([hold.intentId!], 0)).toEqual([{ state: "SETTLED", claimed: false }]);
      } else {
        expect(settled.ok).toBe(false);
        expect((await intentOf(hold.intentId!)).state, "rolled back with the row: still OPEN, still counted").toBe("OPEN");
        await neverUnderCounted(t, rec.baselineAfter, [rec.evidenceId]);
        await workerBilling.releaseDerivedArtifactReservation(hold.key, hold.reservedAtUtc);
        expect(await judge([hold.intentId!], 0)).toEqual([{ state: "ADOPTED", claimed: true }]);
      }
      expect(await storedBytes([rec.evidenceId]), "the locked version is never deleted").toBe(7000n);
      await accountingEqualsStored(t, rec.baselineAfter, [rec.evidenceId]);
    }
  }, 300_000);
});
