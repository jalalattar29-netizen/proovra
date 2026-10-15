/**
 * THE CHAIN CHECK THROUGH THE REAL LIFECYCLE: a persisted ANCHORED record in a
 * disposable migrated PostgreSQL, the `ots-upgrade` processor, and a REAL
 * regtest Bitcoin Core node. No doubles on the path under test.
 *
 *   1 confirmation   → chain INSUFFICIENT_CONFIRMATIONS persisted, one custody
 *                      event, otsStatus still ANCHORED, next check scheduled
 *   policy minimum   → chain VERIFIED persisted (block hash, confirmations,
 *                      verifier bound to the proof), one more custody event
 *   same job again   → idempotent: no second custody event, no second
 *                      verification request
 *   stale snapshot   → the compare-and-set over the chain columns refuses it
 *
 * Live-integration convention: needs TEST_DATABASE_URL (loopback, migrated),
 * the loopback Redis the bootstrap keeps, and TEST_BITCOIN_REGTEST_RPC_URL.
 * Skipped otherwise.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JOB_NAMES, buildCanonicalJobPayload } from "@proovra/shared";

import { passwordFiles, regtestHarness, regtestTarget, type StampedProof } from "./fixtures/bitcoin-regtest.js";

const DB_URL = process.env.TEST_DATABASE_URL;
const REDIS_OK = /^redis:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(process.env.REDIS_URL ?? "");
const TARGET = regtestTarget();
const runIf = DB_URL && REDIS_OK && TARGET ? describe : describe.skip;

const OTS_ENV = [
  "OTS_BITCOIN_VERIFY_ENABLED",
  "OTS_BITCOIN_RPC_URL",
  "OTS_BITCOIN_RPC_USERNAME",
  "OTS_BITCOIN_RPC_PASSWORD_FILE",
  "OTS_BITCOIN_EXPECTED_CHAIN",
  "OTS_BITCOIN_MIN_CONFIRMATIONS",
] as const;

runIf("ots-upgrade chain verification — PostgreSQL + Redis + real regtest Bitcoin Core", () => {
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let processor: typeof import("../src/ots-upgrade.processor.js");
  let state: typeof import("../src/ots-state.js");
  let queueMod: typeof import("../src/queue.js");
  const node = regtestHarness(TARGET!);
  const files = passwordFiles();
  const ids = { user: randomUUID(), evidence: randomUUID() };
  let stamped: StampedProof;
  const savedEnv: Record<string, string | undefined> = {};

  const job = () =>
    ({
      id: `ots-upgrade-${ids.evidence}`,
      name: JOB_NAMES.UPGRADE_OTS,
      attemptsMade: 0,
      data: buildCanonicalJobPayload({ commandId: ids.evidence, traceId: "chain-it" }),
    }) as never;
  const otsEvents = () =>
    prisma.custodyEvent.findMany({ where: { evidenceId: ids.evidence }, orderBy: { sequence: "asc" }, select: { sequence: true, eventType: true, payload: true } });
  const row = () => prisma.evidence.findUniqueOrThrow({ where: { id: ids.evidence }, select: { ...state.OTS_ROW_SNAPSHOT_SELECT } });

  beforeAll(async () => {
    if (!/@(127\.0\.0\.1|localhost):/.test(DB_URL!)) throw new Error("TEST_DATABASE_URL must be loopback");
    process.env.DATABASE_URL = DB_URL;
    for (const k of OTS_ENV) savedEnv[k] = process.env[k];
    Object.assign(process.env, {
      OTS_BITCOIN_VERIFY_ENABLED: "true",
      OTS_BITCOIN_RPC_URL: TARGET!.url,
      OTS_BITCOIN_RPC_USERNAME: TARGET!.user,
      OTS_BITCOIN_RPC_PASSWORD_FILE: files.write("password", TARGET!.password),
      OTS_BITCOIN_EXPECTED_CHAIN: "regtest",
      OTS_BITCOIN_MIN_CONFIRMATIONS: "6",
    });
    ({ prisma } = await import("../src/db.js"));
    processor = await import("../src/ots-upgrade.processor.js");
    state = await import("../src/ots-state.js");
    queueMod = await import("../src/queue.js");

    stamped = await node.stamp(randomBytes(32));
    await prisma.user.create({ data: { id: ids.user, email: `chain-${ids.user}@test.proovra.local`, provider: "EMAIL", providerUserId: ids.user } as never });
    await prisma.evidence.create({
      data: {
        id: ids.evidence, title: "chain verification", type: "PHOTO", status: "SIGNED", ownerUserId: ids.user,
        // As a calendar upgrade stores it: the proof, and the txid it derives.
        otsStatus: "ANCHORED", otsProofBase64: stamped.base64, otsHash: stamped.digestHex, otsBitcoinTxid: stamped.txidDisplay,
        fingerprintHash: stamped.digestHex, fingerprintCanonicalJson: "{}",
        otsAnchoredAtUtc: new Date(), otsUpgradedAtUtc: new Date(),
      } as never,
    });
  }, 120_000);

  afterAll(async () => {
    for (const k of OTS_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    files.dispose();
    if (!prisma) return;
    const jobs = await queueMod.otsUpgradeQueue.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
    await Promise.all(jobs.filter((j) => JSON.stringify(j.data).includes(ids.evidence)).map((j) => j.remove().catch(() => undefined)));
    // custody_events is append-only by design (a DELETE is refused), so the
    // record and its owner stay in the DISPOSABLE database this suite requires.
    await queueMod.otsUpgradeQueue.close();
    await prisma.$disconnect();
  });

  it("1 confirmation: INSUFFICIENT_CONFIRMATIONS is persisted with one custody event; the lifecycle stays ANCHORED; a re-check is scheduled", async () => {
    await processor.processOtsUpgrade(job());
    const r = await row();
    expect(r.otsStatus).toBe("ANCHORED");
    expect(r.otsChainVerificationStatus).toBe("INSUFFICIENT_CONFIRMATIONS");
    expect(r.otsChainBlockHash).toBe(stamped.blockHash);
    expect(r.otsChainConfirmations).toBe(1);
    expect(state.resolveRowOtsAnchoring(r as never).verification).toBe("CHAIN_CONFIRMATIONS_PENDING");
    const events = await otsEvents();
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]!.payload)).toContain("CHAIN_CONFIRMATIONS_PENDING");
    expect(await queueMod.isOtsUpgradeScheduled(ids.evidence)).toBe(true);
  });

  it("at the policy minimum: VERIFIED is persisted, bound to the proof, with one more custody event", async () => {
    await node.mine(5);
    await processor.processOtsUpgrade(job());
    const r = await row();
    expect(r.otsChainVerificationStatus).toBe("VERIFIED");
    expect(r.otsChainBlockHash).toBe(stamped.blockHash);
    expect(r.otsChainBlockHeight).toBe(stamped.blockHeight);
    expect(r.otsChainConfirmations).toBe(6);
    expect(r.otsChainVerifier).toMatch(/^proovra-ots-chain\/1;core=\d+;min=6;proof=[0-9a-f]{16}$/);
    expect(r.otsChainVerifiedAtUtc).toBeInstanceOf(Date);
    expect(state.resolveRowOtsAnchoring(r as never).verification).toBe("CHAIN_VERIFIED");
    const events = await otsEvents();
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events[1]!.payload)).toContain("CHAIN_VERIFIED");
    // Nothing in custody carries the node address or a credential.
    expect(JSON.stringify(events)).not.toContain(TARGET!.password);
    expect(JSON.stringify(events)).not.toContain(TARGET!.url);
  });

  it("the same job again is idempotent: no second custody event, the verified fact is kept", async () => {
    const before = await row();
    await processor.processOtsUpgrade(job());
    const after = await row();
    expect(after.otsChainVerificationStatus).toBe("VERIFIED");
    expect(after.otsChainBlockHash).toBe(before.otsChainBlockHash);
    expect(after.otsChainVerifiedAtUtc?.toISOString()).toBe(before.otsChainVerifiedAtUtc?.toISOString());
    expect(await otsEvents()).toHaveLength(2);
  });

  it("compare-and-set: a write decided from a stale chain snapshot matches no row", async () => {
    const current = await row();
    const stale = { ...current, otsChainVerificationStatus: "INSUFFICIENT_CONFIRMATIONS", otsChainConfirmations: 1 };
    const won = await prisma.evidence.updateMany({
      where: state.otsSnapshotWhere(ids.evidence, stale as never),
      data: { otsChainVerificationStatus: "UNAVAILABLE" },
    });
    expect(won.count).toBe(0);
    expect((await row()).otsChainVerificationStatus).toBe("VERIFIED");
    const fresh = await prisma.evidence.updateMany({ where: state.otsSnapshotWhere(ids.evidence, current as never), data: {} });
    expect(fresh.count).toBe(1);
  });
});
