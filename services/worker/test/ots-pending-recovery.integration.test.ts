/**
 * ET-OTS-03 — a PENDING proof whose upgrade ladder is gone is re-scheduled by
 * the recovery sweep, exactly once; a ladder that is still scheduled is left
 * alone (never a second, parallel ladder).
 *
 * Live-integration convention (see uc4-screen-intelligence-persistence): runs
 * against a disposable migrated PostgreSQL named by TEST_DATABASE_URL and the
 * loopback Redis the bootstrap keeps; skipped in the DB-free CI unit phase.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.TEST_DATABASE_URL;
const REDIS_OK = /^redis:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(process.env.REDIS_URL ?? "");
const runIf = DB_URL && REDIS_OK ? describe : describe.skip;

runIf("ET-OTS-03 — PENDING proof recovery (live PostgreSQL + loopback Redis)", () => {
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let reconciler: typeof import("../src/ots-initialization-reconciler.js");
  let queueMod: typeof import("../src/queue.js");
  const ids = { user: randomUUID(), evidence: randomUUID() };

  beforeAll(async () => {
    // The worker's db module reads DATABASE_URL at import: point it at the
    // disposable database the harness names (never a real one).
    if (!/@(127\.0\.0\.1|localhost):/.test(DB_URL!)) throw new Error("TEST_DATABASE_URL must be loopback");
    process.env.DATABASE_URL = DB_URL;
    ({ prisma } = await import("../src/db.js"));
    reconciler = await import("../src/ots-initialization-reconciler.js");
    queueMod = await import("../src/queue.js");
    await prisma.user.create({ data: { id: ids.user, email: `ots-${ids.user}@test.proovra.local`, provider: "EMAIL", providerUserId: ids.user } as never });
    await prisma.evidence.create({
      data: {
        id: ids.evidence, title: "pending proof", type: "PHOTO", status: "SIGNED", ownerUserId: ids.user,
        otsStatus: "PENDING", otsProofBase64: "AAAA", otsHash: "0".repeat(64),
        createdAt: new Date(Date.now() - 2 * 86_400_000), otsUpgradedAtUtc: new Date(Date.now() - 10 * 3_600_000),
        fingerprintCanonicalJson: "{}",
      } as never,
    });
    // Prisma stamps updatedAt on write; the ladder has made no progress for 10h.
    await prisma.$executeRaw`UPDATE "evidence" SET "updated_at" = now() - interval '10 hours' WHERE "id" = ${ids.evidence}::uuid`;
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    const jobs = await queueMod.otsUpgradeQueue.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
    await Promise.all(jobs.filter((j) => JSON.stringify(j.data).includes(ids.evidence)).map((j) => j.remove().catch(() => undefined)));
    await prisma.evidence.deleteMany({ where: { id: ids.evidence } });
    await prisma.user.deleteMany({ where: { id: ids.user } });
    await queueMod.otsUpgradeQueue.close();
    await prisma.$disconnect();
  });

  it("re-schedules a lost ladder once, then recognises it as scheduled", async () => {
    expect(await queueMod.isOtsUpgradeScheduled(ids.evidence)).toBe(false);
    const first = await reconciler.runOtsInitializationReconciler({ trigger: "test" as never });
    expect(first.pendingRescheduled).toBeGreaterThanOrEqual(1);
    expect(await queueMod.isOtsUpgradeScheduled(ids.evidence)).toBe(true);

    const second = await reconciler.runOtsInitializationReconciler({ trigger: "test" as never });
    const scheduledForThis = (await queueMod.otsUpgradeQueue.getJobs(["waiting", "delayed", "active"])).filter((j) =>
      JSON.stringify(j.data).includes(ids.evidence),
    );
    expect(scheduledForThis).toHaveLength(1);
    expect(second.pendingAlreadyScheduled).toBeGreaterThanOrEqual(1);
  });

  it("a PENDING proof checked recently is not a recovery candidate", () => {
    const where = reconciler.pendingWithoutProgressWhere({ notAfter: new Date(Date.now() - 6 * 3_600_000), notBefore: new Date(0) });
    expect(where).toMatchObject({ otsStatus: "PENDING", deletedAt: null });
  });
});

/**
 * (2026-10-13) An attestation recorded while no chain verifier was configured
 * finished its ladder: once a verifier IS configured, the sweep schedules the
 * canonical upgrade job that runs the chain check. Without one, nothing is
 * scheduled; a concluded check (VERIFIED) is never revisited.
 */
runIf("OTS chain-check backfill (live PostgreSQL + loopback Redis)", () => {
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let reconciler: typeof import("../src/ots-initialization-reconciler.js");
  let queueMod: typeof import("../src/queue.js");
  const ids = { user: randomUUID(), awaiting: randomUUID(), concluded: randomUUID() };
  const saved = { kind: process.env.OTS_CHAIN_VERIFIER, url: process.env.OTS_BITCOIN_NODE_URL };

  beforeAll(async () => {
    if (!/@(127\.0\.0\.1|localhost):/.test(DB_URL!)) throw new Error("TEST_DATABASE_URL must be loopback");
    process.env.DATABASE_URL = DB_URL;
    ({ prisma } = await import("../src/db.js"));
    reconciler = await import("../src/ots-initialization-reconciler.js");
    queueMod = await import("../src/queue.js");
    await prisma.user.create({ data: { id: ids.user, email: `ots-${ids.user}@test.proovra.local`, provider: "EMAIL", providerUserId: ids.user } as never });
    const attested = (id: string, chain: string | null) =>
      prisma.evidence.create({
        data: {
          id, title: "attested proof", type: "PHOTO", status: "SIGNED", ownerUserId: ids.user,
          otsStatus: "ANCHORED", otsProofBase64: "AAAA", otsHash: "0".repeat(64), otsBitcoinTxid: "e".repeat(64),
          otsChainVerificationStatus: chain, fingerprintCanonicalJson: "{}",
        } as never,
      });
    await attested(ids.awaiting, "NOT_CONFIGURED");
    // The database refuses VERIFIED without its evidence, so a FAILED check stands for "concluded".
    await attested(ids.concluded, "FAILED");
  }, 60_000);

  afterAll(async () => {
    process.env.OTS_CHAIN_VERIFIER = saved.kind;
    process.env.OTS_BITCOIN_NODE_URL = saved.url;
    if (!prisma) return;
    const jobs = await queueMod.otsUpgradeQueue.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
    await Promise.all(
      jobs.filter((j) => [ids.awaiting, ids.concluded].some((id) => JSON.stringify(j.data).includes(id))).map((j) => j.remove().catch(() => undefined)),
    );
    await prisma.evidence.deleteMany({ where: { id: { in: [ids.awaiting, ids.concluded] } } });
    await prisma.user.deleteMany({ where: { id: ids.user } });
    await queueMod.otsUpgradeQueue.close();
    await prisma.$disconnect();
  });

  it("schedules nothing while no verifier is configured", async () => {
    delete process.env.OTS_CHAIN_VERIFIER;
    const r = await reconciler.runOtsInitializationReconciler({ trigger: "test" as never });
    expect(r.chainCheckScanned).toBe(0);
    expect(await queueMod.isOtsUpgradeScheduled(ids.awaiting)).toBe(false);
  });

  it("schedules the chain check once a verifier is configured — once, and never for a concluded check", async () => {
    process.env.OTS_CHAIN_VERIFIER = "bitcoind-rpc";
    process.env.OTS_BITCOIN_NODE_URL = "http://user:pass@127.0.0.1:9";
    const first = await reconciler.runOtsInitializationReconciler({ trigger: "test" as never });
    expect(first.chainCheckEnqueued).toBeGreaterThanOrEqual(1);
    expect(await queueMod.isOtsUpgradeScheduled(ids.awaiting)).toBe(true);
    expect(await queueMod.isOtsUpgradeScheduled(ids.concluded)).toBe(false);
    await reconciler.runOtsInitializationReconciler({ trigger: "test" as never });
    const scheduled = (await queueMod.otsUpgradeQueue.getJobs(["waiting", "delayed", "active"])).filter((j) =>
      JSON.stringify(j.data).includes(ids.awaiting),
    );
    expect(scheduled).toHaveLength(1);
  });
});
