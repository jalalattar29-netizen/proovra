/**
 * THE INDEPENDENT BITCOIN-CHAIN CHECK, RUN THROUGH THE OTS UPGRADE PROCESSOR.
 *
 * The real `processOtsUpgrade` against an in-memory evidence row whose
 * `updateMany` is a real compare-and-set over the OTS columns (chain columns
 * included), on REAL OpenTimestamps bytes (packages/shared/tests/helpers/
 * ots-fixtures.mjs). Doubled, as in ots-upgrade-processor.behaviour.test.ts:
 * the `ots` binary, the custody appender, the queue, the incident bridge and
 * the version decision. Additionally MOCKED (never a node):
 *   * ../src/ots-bitcoin-config.js    resolveOtsBitcoinVerifierConfig → enabled/disabled per test
 *   * ../src/ots-bitcoin-verifier.js  checkOtsProofAgainstBitcoin → a scripted OtsChainCheck
 *
 * ANCHORED only means the proof NAMES a block. Only a DECIDED VERIFIED check
 * makes it CHAIN_VERIFIED, and only CHAIN_VERIFIED asks for a report version.
 */
import { JOB_NAMES, OTS_CHAIN_POLICY_DEFAULTS, buildCanonicalJobPayload, formatOtsChainVerifier } from "@proovra/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { REAL, upgradedProof } from "../../../packages/shared/tests/helpers/ots-fixtures.mjs";
import { chainColumnsFor } from "./fixtures/ots-chain-fixtures.js";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  updates: [] as Array<{ data: Record<string, unknown>; count: number }>,
  custody: [] as Array<{ eventType: string; payload: Record<string, unknown> }>,
  enqueued: [] as Array<{ evidenceId: string; options: { delayMs?: number; traceId?: string; selfJobId?: unknown } }>,
  incidents: [] as string[],
  versionDecisions: [] as Array<{ evidenceId: string; state: string; verification: string; proofSha256: string | null }>,
  upgrades: [] as Array<(file: string) => Promise<{ stdout: string; stderr: string }>>,
  /** MOCK verifier config. */
  config: { kind: "disabled" } as Record<string, unknown>,
  /** MOCK scripted chain check (called with the resolved anchoring). */
  check: null as null | (() => unknown),
  checks: 0,
}));

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return (a ?? null) === (b ?? null);
}

vi.mock("../src/db.js", () => {
  const evidence = {
    findUnique: async () => (h.row ? { ...h.row } : null),
    updateMany: async (args: { where: Row; data: Row }) => {
      if (!h.row) return { count: 0 };
      for (const [k, v] of Object.entries(args.where)) {
        if (k === "id") continue;
        if (!sameValue(h.row[k], v)) {
          h.updates.push({ data: args.data, count: 0 });
          return { count: 0 };
        }
      }
      h.row = { ...h.row, ...args.data };
      h.updates.push({ data: args.data, count: 1 });
      return { count: 1 };
    },
  };
  const prisma = {
    evidence,
    custodyEvent: { findMany: async () => [] },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
  };
  return { prisma };
});

vi.mock("../src/custody-events.js", () => ({
  appendCustodyEventTx: async (_tx: unknown, e: { eventType: string; payload: Record<string, unknown> }) => {
    h.custody.push({ eventType: String(e.eventType), payload: e.payload });
  },
}));

vi.mock("../src/queue.js", () => ({
  enqueueOtsUpgradeJob: async (evidenceId: string, options: { delayMs?: number; traceId?: string; selfJobId?: unknown } = {}) => {
    h.enqueued.push({ evidenceId, options });
    return { enqueued: true, jobId: `ots-upgrade-${evidenceId}` };
  },
  enqueueReportGenerationRequest: async () => undefined,
}));

vi.mock("../src/governance/incident-emitter.js", () => ({
  recordWorkerIncident: async (i: { fingerprint: string }) => {
    h.incidents.push(i.fingerprint);
  },
}));

vi.mock("../src/ots-lifecycle.js", () => ({
  ensureEvidenceOtsInitialized: async () => ({ initialized: false, reason: "test" }),
}));

vi.mock("../src/ots.service.js", () => ({
  resolveOtsBin: () => "ots",
  resolveOtsTimeoutMs: () => 1000,
}));

vi.mock("../src/ots-anchored-version.js", () => ({
  ensureOtsAnchoredReportVersion: async (input: { evidenceId: string; anchoring: { state: string; verification: string; proofSha256: string | null } }) => {
    h.versionDecisions.push({
      evidenceId: input.evidenceId,
      state: input.anchoring.state,
      verification: input.anchoring.verification,
      proofSha256: input.anchoring.proofSha256,
    });
    return { outcome: "requested" };
  },
}));

// MOCK — the verifier configuration; every other export is the real one.
vi.mock("../src/ots-bitcoin-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ots-bitcoin-config.js")>()),
  resolveOtsBitcoinVerifierConfig: () => h.config,
}));

// MOCK — the chain check returns a scripted OtsChainCheck; no RPC client is built.
vi.mock("../src/ots-bitcoin-verifier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ots-bitcoin-verifier.js")>()),
  checkOtsProofAgainstBitcoin: async () => {
    h.checks += 1;
    if (!h.check) throw new Error("test: no chain check scripted");
    return h.check();
  },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (_bin: string, args: string[], _opts: unknown, cb: (err: unknown, out?: unknown) => void) => {
      const next = h.upgrades.shift();
      if (!next) {
        cb(Object.assign(new Error("no upgrade behaviour queued"), { stdout: "", stderr: "" }));
        return;
      }
      next(args[1]!).then(
        (out) => cb(null, out),
        (err) => cb(err),
      );
    },
  };
});

const { processOtsUpgrade, OTS_CHAIN_FIRST_CHECK_DELAY_MS } = await import("../src/ots-upgrade.processor.js");
const { writeFile } = await import("node:fs/promises");

const OTS_HASH = REAL.boundFingerprintHash;
const up = upgradedProof({ blockHeight: 860000 });
const BLOCK_HASH = "00000000000000000003" + "cd".repeat(22);
const VERIFIER = formatOtsChainVerifier({ nodeVersion: 270000, minConfirmations: 6, proofSha256: up.proofSha256 });
const HOUR = 60 * 60 * 1000;

const ENABLED_CONFIG = {
  kind: "enabled",
  rpcUrl: "http://10.0.0.5:8332/",
  rpcEndpointLabel: "10.0.0.5:8332",
  username: "btc-rpc-user",
  timeoutMs: 5000,
  policy: { ...OTS_CHAIN_POLICY_DEFAULTS, minConfirmations: 6 },
  passwordFile: null,
  passwordFromEnvironmentAllowed: true,
};

function job() {
  return {
    id: `ots-upgrade-ev-1`,
    name: JOB_NAMES.UPGRADE_OTS,
    attemptsMade: 0,
    data: buildCanonicalJobPayload({ commandId: "ev-1", traceId: "t" }),
  };
}

const CHAIN_NULL = {
  otsChainVerificationStatus: null,
  otsChainCheckedAtUtc: null,
  otsChainVerifiedAtUtc: null,
  otsChainBlockHeight: null,
  otsChainBlockHash: null,
  otsChainBlockTimeUtc: null,
  otsChainConfirmations: null,
  otsChainVerifier: null,
  otsChainFailureCode: null,
};

/** An ANCHORED row: the stored proof names block 860000, its label agrees, never chain-checked. */
function anchoredRow(over: Row = {}): Row {
  return {
    id: "ev-1",
    createdAt: new Date(),
    teamId: null,
    deletedAt: null,
    otsProofBase64: up.base64,
    otsStatus: "ANCHORED",
    otsHash: OTS_HASH,
    otsCalendar: "https://calendar.example",
    otsBitcoinTxid: up.txid,
    otsAnchoredAtUtc: new Date("2026-10-14T00:00:00Z"),
    otsUpgradedAtUtc: new Date("2026-10-14T00:00:00Z"),
    otsFailureReason: null,
    fingerprintHash: OTS_HASH,
    ...CHAIN_NULL,
    ...over,
  };
}

function pendingRow(over: Row = {}): Row {
  return anchoredRow({
    otsProofBase64: REAL.boundProofBase64,
    otsStatus: "PENDING",
    otsBitcoinTxid: null,
    otsAnchoredAtUtc: null,
    otsUpgradedAtUtc: new Date("2026-10-14T00:00:00Z"),
    ...over,
  });
}

const CHECKED_AT = new Date("2026-10-15T09:00:00Z");
function decided(status: "VERIFIED" | "INSUFFICIENT_CONFIRMATIONS", confirmations: number) {
  return () => ({
    kind: "DECIDED",
    decision: {
      status,
      failureCode: status === "VERIFIED" ? null : "INSUFFICIENT_CONFIRMATIONS",
      blockHeight: up.blockHeight,
      blockHash: BLOCK_HASH,
      blockTimeUtc: "2024-08-20T10:00:00.000Z",
      confirmations,
      rejected: [],
    },
    verifier: VERIFIER,
    checkedAtUtc: new Date(CHECKED_AT),
    tip: { chain: "main", height: up.blockHeight + confirmations - 1, hash: "", nodeVersion: 270000 },
  });
}
const unavailable = () => () => ({ kind: "UNAVAILABLE", code: "BTC_RPC_TIMEOUT", detail: "timeout", checkedAtUtc: new Date(CHECKED_AT) });

const chainWrites = () => h.updates.filter((u) => u.count === 1 && Object.keys(u.data).every((k) => k.startsWith("otsChain")));
const PROOF_KEYS = ["otsStatus", "otsProofBase64", "otsHash", "otsCalendar", "otsBitcoinTxid", "otsAnchoredAtUtc", "otsUpgradedAtUtc", "otsFailureReason"];
const proofColumns = (r: Row) => Object.fromEntries(PROOF_KEYS.map((k) => [k, r[k]]));

/** `ots upgrade` wrote these bytes and reported success. */
const upgradedTo = (proof: string) => async (file: string) => {
  await writeFile(file, Buffer.from(proof, "base64"));
  return { stdout: "Success! Timestamp complete", stderr: "" };
};

beforeEach(() => {
  h.row = null;
  h.updates.length = 0;
  h.custody.length = 0;
  h.enqueued.length = 0;
  h.incidents.length = 0;
  h.versionDecisions.length = 0;
  h.upgrades.length = 0;
  h.config = { kind: "disabled" };
  h.check = null;
  h.checks = 0;
});

describe("an ANCHORED proof checked against the Bitcoin chain (verifier enabled)", () => {
  beforeEach(() => {
    h.config = ENABLED_CONFIG;
  });

  it("DECIDED VERIFIED: one chain write, one CHAIN_VERIFIED custody event, one version decision", async () => {
    h.row = anchoredRow();
    const before = proofColumns(h.row);
    h.check = decided("VERIFIED", 10);
    await processOtsUpgrade(job() as never);

    expect(h.checks).toBe(1);
    expect(h.updates).toHaveLength(1);
    expect(chainWrites()).toHaveLength(1);
    expect(h.row).toMatchObject({
      otsChainVerificationStatus: "VERIFIED",
      otsChainBlockHeight: up.blockHeight,
      otsChainBlockHash: BLOCK_HASH,
      otsChainConfirmations: 10,
      otsChainVerifier: VERIFIER,
      otsChainFailureCode: null,
    });
    // The proof and its lifecycle status are untouched by a chain outcome.
    expect(proofColumns(h.row!)).toEqual(before);

    expect(h.custody).toHaveLength(1);
    expect(h.custody[0]).toMatchObject({ eventType: "OTS_APPLIED" });
    expect(h.custody[0]!.payload).toMatchObject({
      otsStatus: "ANCHORED",
      otsState: "ANCHORED",
      otsVerification: "CHAIN_VERIFIED",
      otsPhase: "chain_verified",
      proofSha256: up.proofSha256,
      chain: { status: "VERIFIED", blockHeight: up.blockHeight, blockHash: BLOCK_HASH, confirmations: 10, minConfirmations: 6, verifier: VERIFIER },
    });
    // No node address, user, password or URL in what is recorded.
    expect(JSON.stringify(h.custody)).not.toMatch(/https?:|10\.0\.0\.5|8332|btc-rpc-user|password/i);

    expect(h.versionDecisions).toEqual([{ evidenceId: "ev-1", state: "ANCHORED", verification: "CHAIN_VERIFIED", proofSha256: up.proofSha256 }]);
    // Shallower than final: one reorg recheck is scheduled.
    expect(h.enqueued.map((e) => e.options.delayMs)).toEqual([24 * HOUR]);
  });

  it("DECIDED INSUFFICIENT_CONFIRMATIONS: one write and one custody event, NO version, a follow-up enqueued", async () => {
    h.row = anchoredRow();
    h.check = decided("INSUFFICIENT_CONFIRMATIONS", 2);
    await processOtsUpgrade(job() as never);
    expect(chainWrites()).toHaveLength(1);
    expect(h.row).toMatchObject({ otsChainVerificationStatus: "INSUFFICIENT_CONFIRMATIONS", otsChainConfirmations: 2, otsStatus: "ANCHORED" });
    expect(h.custody).toHaveLength(1);
    expect(h.custody[0]!.payload).toMatchObject({ otsVerification: "CHAIN_CONFIRMATIONS_PENDING", otsPhase: "chain_confirmations_pending" });
    expect(h.versionDecisions).toEqual([]);
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({ evidenceId: "ev-1", options: { delayMs: HOUR, selfJobId: "ots-upgrade-ev-1" } });
  });

  it("UNAVAILABLE: writes UNAVAILABLE, no version", async () => {
    h.row = anchoredRow();
    h.check = unavailable();
    await processOtsUpgrade(job() as never);
    expect(chainWrites()).toHaveLength(1);
    expect(h.row).toMatchObject({ otsChainVerificationStatus: "UNAVAILABLE", otsChainFailureCode: "BTC_RPC_TIMEOUT", otsStatus: "ANCHORED" });
    expect(h.custody).toHaveLength(1);
    expect(h.custody[0]!.payload).toMatchObject({ otsVerification: "CHAIN_UNAVAILABLE", otsPhase: "chain_verification_unavailable" });
    expect(h.versionDecisions).toEqual([]);
    expect(h.enqueued.map((e) => e.options.delayMs)).toEqual([HOUR]);
  });

  it("a stale concurrent job (chain columns changed between read and write) writes nothing, records nothing, asks no version", async () => {
    h.row = anchoredRow();
    h.check = () => {
      // Another delivery recorded a chain outcome while this one was checking.
      h.row = { ...h.row!, otsChainVerificationStatus: "INSUFFICIENT_CONFIRMATIONS", otsChainCheckedAtUtc: new Date("2026-10-15T08:59:00Z"), otsChainBlockHeight: up.blockHeight, otsChainBlockHash: BLOCK_HASH, otsChainBlockTimeUtc: new Date("2024-08-20T10:00:00Z"), otsChainConfirmations: 3, otsChainVerifier: VERIFIER, otsChainFailureCode: "INSUFFICIENT_CONFIRMATIONS" };
      return decided("VERIFIED", 10)();
    };
    await processOtsUpgrade(job() as never);
    expect(h.updates).toEqual([expect.objectContaining({ count: 0 })]);
    expect(h.row).toMatchObject({ otsChainVerificationStatus: "INSUFFICIENT_CONFIRMATIONS", otsChainConfirmations: 3 });
    expect(h.custody).toEqual([]);
    expect(h.versionDecisions).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  it("a prior VERIFIED re-check on the same block: no custody event (non-material), the idempotent version decision is re-asked", async () => {
    const prior = chainColumnsFor(up, { status: "VERIFIED", blockHash: BLOCK_HASH, confirmations: 10, blockTimeUtc: "2024-08-20T10:00:00.000Z", verifier: VERIFIER });
    h.row = anchoredRow({
      ...prior,
      otsChainCheckedAtUtc: new Date(prior.otsChainCheckedAtUtc as string),
      otsChainVerifiedAtUtc: new Date(prior.otsChainVerifiedAtUtc as string),
      otsChainBlockTimeUtc: new Date(prior.otsChainBlockTimeUtc as string),
    });
    const verifiedAt = (h.row.otsChainVerifiedAtUtc as Date).getTime();
    h.check = decided("VERIFIED", 11);
    await processOtsUpgrade(job() as never);
    expect(h.checks).toBe(1);
    expect(chainWrites()).toHaveLength(1);
    expect(h.row).toMatchObject({ otsChainVerificationStatus: "VERIFIED", otsChainConfirmations: 11, otsChainBlockHash: BLOCK_HASH });
    // The first verification time is kept for the same block.
    expect((h.row!.otsChainVerifiedAtUtc as Date).getTime()).toBe(verifiedAt);
    expect(h.custody).toEqual([]);
    expect(h.versionDecisions).toEqual([{ evidenceId: "ev-1", state: "ANCHORED", verification: "CHAIN_VERIFIED", proofSha256: up.proofSha256 }]);
  });
});

describe("the chain check does not run", () => {
  it("verifier disabled: no check, no write, no custody, no version, no enqueue", async () => {
    h.config = { kind: "disabled" };
    h.row = anchoredRow();
    const before = { ...h.row };
    h.check = decided("VERIFIED", 10);
    await processOtsUpgrade(job() as never);
    expect(h.checks).toBe(0);
    expect(h.updates).toEqual([]);
    expect(h.row).toEqual(before);
    expect(h.custody).toEqual([]);
    expect(h.versionDecisions).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  it("deleted evidence is skipped: nothing written, no check called", async () => {
    h.config = ENABLED_CONFIG;
    h.row = anchoredRow({ deletedAt: new Date("2026-10-14T12:00:00Z") });
    const before = { ...h.row };
    h.check = decided("VERIFIED", 10);
    await processOtsUpgrade(job() as never);
    expect(h.checks).toBe(0);
    expect(h.updates).toEqual([]);
    expect(h.row).toEqual(before);
    expect(h.custody).toEqual([]);
    expect(h.versionDecisions).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });
});

describe("a plain PENDING → ANCHORED upgrade (the proof now NAMES a block)", () => {
  it("requests NO report version and, with the verifier enabled, schedules one first chain check 60s later", async () => {
    h.config = ENABLED_CONFIG;
    h.row = pendingRow();
    h.upgrades.push(upgradedTo(up.base64));
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "ANCHORED", otsProofBase64: up.base64, otsBitcoinTxid: up.txid, otsChainVerificationStatus: null });
    expect(h.custody).toHaveLength(1);
    expect(h.custody[0]!.payload).toMatchObject({ otsState: "ANCHORED", otsPhase: "anchored", otsVerification: "ATTESTATION_RECORDED" });
    // No chain check runs in the same tick, and no version for an unchecked attestation.
    expect(h.checks).toBe(0);
    expect(h.versionDecisions).toEqual([]);
    expect(OTS_CHAIN_FIRST_CHECK_DELAY_MS).toBe(60_000);
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({ evidenceId: "ev-1", options: { delayMs: 60_000, selfJobId: "ots-upgrade-ev-1" } });
  });

  it("with the verifier disabled enqueues nothing and requests no version", async () => {
    h.config = { kind: "disabled" };
    h.row = pendingRow();
    h.upgrades.push(upgradedTo(up.base64));
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "ANCHORED", otsProofBase64: up.base64 });
    expect(h.custody).toHaveLength(1);
    expect(h.versionDecisions).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });
});
