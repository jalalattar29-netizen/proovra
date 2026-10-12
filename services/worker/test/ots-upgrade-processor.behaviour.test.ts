/**
 * THE OTS UPGRADE PROCESSOR, RUN (2026-09-29).
 *
 * The real `processOtsUpgrade` against an in-memory evidence row whose
 * `updateMany` is a real compare-and-set over the OTS columns. Only the
 * OpenTimestamps binary (`execFile`), `ots verify` / `ots info`, the custody
 * appender, the queue and the incident bridge are doubled.
 *
 * Covers: anchored-with-valid-proof, anchored-without-defensible-txid,
 * transient error, permanent invalid proof (hash mismatch + malformed),
 * stale job completion, duplicate delivery and concurrent update ordering —
 * and that no report is ever requested.
 */
import { readFileSync } from "node:fs";

import { JOB_NAMES, buildCanonicalJobPayload } from "@proovra/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * REAL PROOF BYTES (2026-10-12). The processor reads the digest a proof
 * commits to from its bytes, so the doubled `ots upgrade` writes real ones:
 * PROOF_V1 is a real calendar proof (opentimestamps-client 0.7.2) committing to
 * the fixture fingerprint; PROOF_V2 is that proof with a Bitcoin block-header
 * attestation added at its root — the exact serialization `ots upgrade`
 * appends. OTHER_PROOF is a real proof committing to a different digest.
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL("../../../packages/shared/tests/fixtures/ots-proofs.json", import.meta.url), "utf8"),
) as { boundFingerprintHash: string; boundProofBase64: string; otherProofBase64: string };
const OTS_HASH = FIXTURE.boundFingerprintHash;
const TXID = "c".repeat(64);
const HEADER_LEN = 31 + 1 + 1 + 32; // magic, version, sha256 op, digest
function withBitcoinAttestation(proofBase64: string, height: number): string {
  const bytes = Buffer.from(proofBase64, "base64");
  const varuint: number[] = [];
  for (let n = height; ; ) {
    const b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n === 0) {
      varuint.push(b);
      break;
    }
    varuint.push(b | 0x80);
  }
  const attestation = Buffer.from([0xff, 0x00, 0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01, varuint.length, ...varuint]);
  return Buffer.concat([bytes.subarray(0, HEADER_LEN), attestation, bytes.subarray(HEADER_LEN)]).toString("base64");
}
const PROOF_V1 = FIXTURE.boundProofBase64;
const PROOF_V2 = withBitcoinAttestation(PROOF_V1, 860000);
const OTHER_PROOF = withBitcoinAttestation(FIXTURE.otherProofBase64, 860000);

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state = {
    row: null as Record<string, unknown> | null,
    custody: [] as Array<{ eventType: string; payload: Record<string, unknown> }>,
    /** Pre-existing OTS custody history the budget reads (sequence order). */
    custodyHistory: [] as Array<{ atUtc: Date; payload: Record<string, unknown> }>,
    enqueued: [] as string[],
    incidents: [] as string[],
    reportRequests: 0,
    /** Per-call behaviour of `ots upgrade`, consumed in order. */
    upgrades: [] as Array<(file: string) => Promise<{ stdout: string; stderr: string }>>,
    verify: null as unknown,
    info: null as unknown,
    /** The chain verifier the processor resolves; null = the real "none". */
    chainVerifier: null as unknown,
  };
  return state;
});

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
        if (!sameValue(h.row[k], v)) return { count: 0 };
      }
      h.row = { ...h.row, ...args.data };
      return { count: 1 };
    },
  };
  const prisma = {
    evidence,
    custodyEvent: {
      findMany: async () => h.custodyHistory.map((e) => ({ ...e })),
    },
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
  enqueueOtsUpgradeJob: async (id: string) => {
    h.enqueued.push(id);
  },
  enqueueReportGenerationRequest: async () => {
    h.reportRequests += 1;
  },
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
  verifyOtsProof: async () => h.verify,
  getOtsProofInfo: async () => h.info,
}));

vi.mock("../src/ots-chain-verifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ots-chain-verifier.js")>();
  return {
    ...actual,
    resolveOtsChainVerifier: () => h.chainVerifier ?? actual.NOT_CONFIGURED_VERIFIER,
  };
});

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

const { processOtsUpgrade } = await import("../src/ots-upgrade.processor.js");
const { writeFile } = await import("node:fs/promises");

function job() {
  return {
    id: `ots-upgrade-ev-1`,
    name: JOB_NAMES.UPGRADE_OTS,
    attemptsMade: 0,
    data: buildCanonicalJobPayload({ commandId: "ev-1", traceId: "t" }),
  };
}

function baseRow(over: Row = {}): Row {
  return {
    id: "ev-1",
    createdAt: new Date(),
    teamId: null,
    otsProofBase64: PROOF_V1,
    otsStatus: "PENDING",
    otsHash: OTS_HASH,
    otsCalendar: "https://calendar.example",
    otsBitcoinTxid: null,
    otsAnchoredAtUtc: null,
    otsUpgradedAtUtc: new Date("2026-09-28T00:00:00Z"),
    otsFailureReason: null,
    otsAnchorCheck: null,
    fingerprintHash: OTS_HASH,
    ...over,
  };
}

/** `ots upgrade` wrote an upgraded proof and reported success. */
const upgradedTo = (proof: string) => async (file: string) => {
  await writeFile(file, Buffer.from(proof, "base64"));
  return { stdout: "Success! Timestamp complete", stderr: "" };
};
/** `ots upgrade` failed the way a network outage does. */
const networkFailure = async () => {
  throw Object.assign(new Error("Command failed"), { stdout: "", stderr: "getaddrinfo ENOTFOUND a.pool.opentimestamps.org" });
};

const infoAnchored = {
  status: "PARSED",
  info: { raw: "", fileHash: OTS_HASH, txid: TXID, bitcoinBlockHeights: [860000], pendingCalendars: [] },
  binaryMissing: false,
  error: null,
};
const infoPending = {
  status: "PARSED",
  info: { raw: "", fileHash: OTS_HASH, txid: null, bitcoinBlockHeights: [], pendingCalendars: ["https://a"] },
  binaryMissing: false,
  error: null,
};
const verifyUnavailable = { status: "ERROR", verify: null, binaryMissing: false, error: "no bitcoin node" };
beforeEach(() => {
  // A test that spies on a doubled export must not leak it into the next.
  vi.restoreAllMocks();
  h.row = null;
  h.custody.length = 0;
  h.custodyHistory.length = 0;
  h.enqueued.length = 0;
  h.incidents.length = 0;
  h.reportRequests = 0;
  h.upgrades.length = 0;
  h.verify = verifyUnavailable;
  h.info = infoPending;
  h.chainVerifier = null;
});

/** A deterministic chain verifier double. Never a real Bitcoin verification. */
function chainDouble(outcome: Record<string, unknown>) {
  return {
    kind: "test-double",
    calls: [] as unknown[],
    async verify(input: unknown) {
      (this as { calls: unknown[] }).calls.push(input);
      return { checkedAtUtc: new Date("2026-10-12T09:00:00Z"), verifier: "test-double/1", ...outcome };
    },
  };
}
const CHAIN_VERIFIED = {
  status: "VERIFIED",
  verifiedAtUtc: new Date("2026-10-12T09:00:00Z"),
  blockHeight: 860000,
  blockHash: "0000000000000000000a1b2c3d4e5f60718293a4b5c6d7e8f9001122334455aa",
  blockTimeUtc: new Date("2026-09-20T10:00:00Z"),
  confirmations: 12,
};

describe("valid anchored proof", () => {
  it("an anchor verified against the chain records BITCOIN_VERIFIED with the block time", async () => {
    h.row = baseRow();
    h.upgrades.push(upgradedTo(PROOF_V2));
    h.chainVerifier = chainDouble(CHAIN_VERIFIED);
    h.info = infoAnchored;
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({
      otsStatus: "ANCHORED",
      otsAnchorCheck: "BITCOIN_VERIFIED",
      otsBitcoinTxid: TXID,
      otsProofBase64: PROOF_V2,
      otsAttestationBlockHeight: 860000,
      otsChainVerificationStatus: "VERIFIED",
      otsChainBlockHeight: 860000,
      otsChainBlockHash: CHAIN_VERIFIED.blockHash,
      otsChainConfirmations: 12,
      otsChainVerifier: "test-double/1",
    });
    expect((h.row!.otsChainBlockTimeUtc as Date).toISOString()).toBe("2026-09-20T10:00:00.000Z");
    expect((h.row!.otsAnchoredAtUtc as Date).toISOString()).toBe("2026-09-20T10:00:00.000Z");
    // The verifier was asked about THIS proof's committed digest and heights.
    expect((h.chainVerifier as { calls: Array<Record<string, unknown>> }).calls[0]).toMatchObject({
      digestHex: OTS_HASH,
      attestationBlockHeights: [860000],
    });
    expect(h.custody.map((c) => c.payload.otsPhase)).toEqual(["anchored_verified"]);
    expect(h.enqueued).toEqual([]);
    expect(h.reportRequests).toBe(0);
  });

  it("an anchor proven only by the proof structure records PROOF_STRUCTURE (not verified)", async () => {
    h.row = baseRow();
    h.upgrades.push(upgradedTo(PROOF_V2));
    h.info = infoAnchored;
    await processOtsUpgrade(job() as never);
    // THE INCIDENT SHAPE: no verifier is configured, so the attestation is
    // recorded as present and NOT verified. No block time exists; the
    // recording time is stored as the attestation-recorded time.
    expect(h.row).toMatchObject({
      otsStatus: "ANCHORED",
      otsAnchorCheck: "PROOF_STRUCTURE",
      otsAttestationBlockHeight: 860000,
      otsChainVerificationStatus: "NOT_CONFIGURED",
      otsChainBlockTimeUtc: null,
      otsChainVerifiedAtUtc: null,
    });
    expect(h.row!.otsAttestationRecordedAtUtc).toBeInstanceOf(Date);
    expect(h.custody.map((c) => c.payload.otsPhase)).toEqual(["attestation_recorded_by_proof_structure"]);
    expect(h.custody[0]!.payload).toMatchObject({ digestBinding: "MATCH", committedDigestMatchesFingerprint: true });
    // No configured verifier: nothing to follow up.
    expect(h.enqueued).toEqual([]);
  });

  it("duplicate delivery after the anchor is recorded does nothing at all", async () => {
    h.row = baseRow({
      otsStatus: "ANCHORED",
      otsAnchorCheck: "PROOF_STRUCTURE",
      otsBitcoinTxid: TXID,
      otsAnchoredAtUtc: new Date("2026-09-20T10:00:00Z"),
    });
    const before = { ...h.row };
    await processOtsUpgrade(job() as never);
    expect(h.row).toEqual(before);
    expect(h.custody).toEqual([]);
    expect(h.upgrades.length).toBe(0); // the binary was never asked
  });
});

describe("anchored without a defensible txid (legacy, never checked)", () => {
  it("is demoted to PENDING, keeps its proof, and is followed up — when the re-check cannot confirm it", async () => {
    h.row = baseRow({ otsStatus: "ANCHORED", otsAnchoredAtUtc: new Date("2026-09-01T00:00:00Z") });
    h.upgrades.push(upgradedTo(PROOF_V1));
    h.info = infoPending;
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "PENDING", otsAnchoredAtUtc: null, otsProofBase64: PROOF_V1 });
    expect(h.custody.map((c) => c.payload.otsPhase)).toEqual(["anchor_not_confirmed_on_recheck"]);
    expect(h.enqueued).toEqual(["ev-1"]);
  });
});

/*
 * AN INCONCLUSIVE CHECK IS AN ATTEMPT FAILURE, NOT A PENDING PROOF (2026-09-29).
 *
 * `ots upgrade` succeeded, but `ots info` did not yield a proof read and
 * pinned to this record with no attestation. That is the only thing a PENDING
 * observation may assert; anything weaker leaves the row exactly as it was.
 */
describe("inconclusive check (info timeout, unreadable output, attestation without txid, no hash)", () => {
  const FORTY_DAYS_AGO = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const infoTimeout = { status: "ERROR", info: null, binaryMissing: false, error: "timeout" };
  const infoNoHashLine = {
    status: "PARSED",
    info: { raw: "", fileHash: null, txid: null, bitcoinBlockHeights: [], pendingCalendars: [] },
    binaryMissing: false,
    error: null,
  };
  const infoAttestationNoTxid = {
    status: "PARSED",
    info: { raw: "", fileHash: OTS_HASH, txid: null, bitcoinBlockHeights: [860000], pendingCalendars: [] },
    binaryMissing: false,
    error: null,
  };

  async function expectUnchangedAttempt(reason: RegExp) {
    const before = { ...h.row! };
    await expect(processOtsUpgrade(job() as never)).rejects.toThrow("OTS_UPGRADE_ATTEMPT_FAILED");
    expect(h.row).toEqual(before);
    expect(h.custody.map((c) => c.eventType)).toEqual(["OTS_ATTEMPT_ERROR"]);
    expect(String(h.custody[0]!.payload.reason)).toMatch(reason);
    expect(h.incidents).toEqual([]);
    expect(h.enqueued).toEqual([]);
    expect(h.reportRequests).toBe(0);
  }

  it("an ANCHORED legacy row is NOT demoted when ots info times out", async () => {
    h.row = baseRow({ otsStatus: "ANCHORED", otsAnchoredAtUtc: new Date("2026-09-01T00:00:00Z") });
    h.upgrades.push(upgradedTo(PROOF_V2));
    h.info = infoTimeout;
    await expectUnchangedAttempt(/ots info did not complete \(ERROR\)/);
  });

  it("an ANCHORED legacy row is NOT demoted when ots info output has no hash line", async () => {
    h.row = baseRow({ otsStatus: "ANCHORED", otsAnchoredAtUtc: new Date("2026-09-01T00:00:00Z") });
    h.upgrades.push(upgradedTo(PROOF_V2));
    h.info = infoNoHashLine;
    await expectUnchangedAttempt(/no file hash/);
  });

  // ET-OTS-06 — a proof that commits to THIS record and carries a Bitcoin
  // block attestation is an anchor by proof structure; the txid is optional
  // for that (not-checked) claim. It used to be retried as inconclusive forever.
  it("ET-OTS-06: a block attestation without a readable txid records the anchor as PROOF_STRUCTURE (no txid)", async () => {
    h.row = baseRow({ otsStatus: "ANCHORED", otsAnchoredAtUtc: new Date("2026-09-01T00:00:00Z") });
    h.upgrades.push(upgradedTo(PROOF_V2));
    h.info = infoAttestationNoTxid;
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "ANCHORED", otsAnchorCheck: "PROOF_STRUCTURE", otsBitcoinTxid: null, otsProofBase64: PROOF_V2 });
    expect(h.custody.map((c) => c.eventType)).toEqual(["OTS_APPLIED"]);
  });

  it("a PENDING proof past the 30-day budget is NOT marked FAILED when the check cannot complete", async () => {
    h.row = baseRow({ createdAt: FORTY_DAYS_AGO });
    h.upgrades.push(upgradedTo(PROOF_V1));
    h.info = infoTimeout;
    await expectUnchangedAttempt(/OTS_CHECK_INCONCLUSIVE/);
    expect(h.row!.otsStatus).toBe("PENDING");
  });

  it("ET-OTS-06: a PENDING proof past the budget with an attestation but no txid is ANCHORED by proof structure, not FAILED", async () => {
    h.row = baseRow({ createdAt: FORTY_DAYS_AGO });
    h.upgrades.push(upgradedTo(PROOF_V2));
    h.info = infoAttestationNoTxid;
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "ANCHORED", otsAnchorCheck: "PROOF_STRUCTURE" });
  });

  // ET-OTS-06 — `ots info` is offline; a deterministic read failure repeats
  // for the same bytes. It is an attempt error until the third consecutive
  // identical one, which is terminal MALFORMED_PROOF.
  const infoUnreadable = { status: "ERROR", info: null, binaryMissing: false, error: "Error! not a timestamp", deterministic: true };
  const unreadableAttempt = {
    atUtc: new Date("2026-09-29T00:00:00Z"),
    eventType: "OTS_ATTEMPT_ERROR",
    payload: { reason: "OTS_PROOF_UNREADABLE: ots info could not read this proof (an offline, deterministic read)." },
  };

  it("ET-OTS-06: a first deterministic unreadable read is an attempt error with the bounded reason", async () => {
    h.row = baseRow();
    h.upgrades.push(upgradedTo(PROOF_V1));
    h.info = infoUnreadable;
    await expectUnchangedAttempt(/^OTS_PROOF_UNREADABLE:/);
  });

  it("ET-OTS-06: the third consecutive deterministic unreadable read is FAILED (MALFORMED_PROOF), not retried", async () => {
    h.row = baseRow();
    h.custodyHistory.push(unreadableAttempt as never, unreadableAttempt as never);
    h.upgrades.push(upgradedTo(PROOF_V1));
    h.info = infoUnreadable;
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "FAILED", otsFailureReason: "MALFORMED_PROOF" });
    expect(h.custody.map((c) => c.eventType)).toEqual(["OTS_FAILED"]);
    expect(h.enqueued).toEqual([]);
  });

  it("ET-OTS-06: a timeout never counts toward the strikes, and an intervening other event resets them", async () => {
    h.row = baseRow();
    h.custodyHistory.push(unreadableAttempt as never, unreadableAttempt as never);
    h.upgrades.push(upgradedTo(PROOF_V1));
    h.info = { ...infoUnreadable, deterministic: false };
    await expectUnchangedAttempt(/OTS_CHECK_INCONCLUSIVE/);

    h.custody.length = 0;
    h.custodyHistory.length = 0;
    h.custodyHistory.push(unreadableAttempt as never, { atUtc: new Date(), eventType: "OTS_APPLIED", payload: {} } as never);
    h.upgrades.push(upgradedTo(PROOF_V1));
    h.info = infoUnreadable;
    await expectUnchangedAttempt(/^OTS_PROOF_UNREADABLE:/);
  });

  it("a record with no OpenTimestamps hash to compare is inconclusive, not pending", async () => {
    h.row = baseRow({ otsHash: null, createdAt: FORTY_DAYS_AGO });
    h.upgrades.push(upgradedTo(PROOF_V1));
    h.info = infoPending;
    await expectUnchangedAttempt(/no OpenTimestamps hash to compare/);
  });

  it("UNCHANGED: a proof READ and pinned with no attestation is still pending, and the budget still applies to it", async () => {
    h.row = baseRow({ createdAt: FORTY_DAYS_AGO });
    h.custodyHistory.push({ atUtc: FORTY_DAYS_AGO, payload: { phase: "ots_initialized", otsPhase: "proof_created" } });
    h.upgrades.push(upgradedTo(PROOF_V1));
    h.info = infoPending;
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "FAILED", otsFailureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED" });
  });
});

describe("transient provider/network failure", () => {
  it("writes NO OTS column, records an attempt error, and throws for the retry budget", async () => {
    h.row = baseRow({ otsStatus: "ANCHORED", otsAnchoredAtUtc: new Date("2026-09-01T00:00:00Z") });
    const before = { ...h.row };
    h.upgrades.push(networkFailure);
    h.info = { status: "ERROR", info: null, binaryMissing: false, error: "x" };
    await expect(processOtsUpgrade(job() as never)).rejects.toThrow("OTS_UPGRADE_ATTEMPT_FAILED");
    expect(h.row).toEqual(before); // the previously established anchor survives
    expect(h.custody.map((c) => c.eventType)).toEqual(["OTS_ATTEMPT_ERROR"]);
  });
});

describe("permanently invalid proof", () => {
  it("a proof committing to another hash is FAILED (PROOF_HASH_MISMATCH), not retried", async () => {
    h.row = baseRow();
    h.upgrades.push(upgradedTo(PROOF_V1));
    h.info = { ...infoPending, info: { ...infoPending.info, fileHash: "d".repeat(64) } };
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "FAILED", otsFailureReason: "PROOF_HASH_MISMATCH", otsProofBase64: PROOF_V1 });
    expect(h.enqueued).toEqual([]);
  });

  it("a stored proof that is not an OpenTimestamps proof is FAILED (MALFORMED_PROOF) without calling the binary", async () => {
    h.row = baseRow({ otsProofBase64: Buffer.from("garbage bytes").toString("base64") });
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "FAILED", otsFailureReason: "MALFORMED_PROOF" });
    expect(h.custody.map((c) => c.eventType)).toEqual(["OTS_FAILED"]);

    // …and a second delivery leaves it alone.
    h.custody.length = 0;
    await processOtsUpgrade(job() as never);
    expect(h.custody).toEqual([]);
  });
});

describe("stale and concurrent completions", () => {
  it("a job whose row moved on while it ran discards its older observation", async () => {
    h.row = baseRow();
    h.upgrades.push(async (file) => {
      // Meanwhile another worker proved the anchor and committed it.
      h.row = {
        ...h.row!,
        otsStatus: "ANCHORED",
        otsAnchorCheck: "BITCOIN_VERIFIED",
        otsBitcoinTxid: TXID,
        otsAnchoredAtUtc: new Date("2026-09-20T10:00:00Z"),
        otsUpgradedAtUtc: new Date("2026-09-29T11:00:00Z"),
      };
      await writeFile(file, Buffer.from(PROOF_V1, "base64"));
      return { stdout: "Pending confirmation in Bitcoin blockchain", stderr: "" };
    });
    h.info = infoPending;
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "ANCHORED", otsAnchorCheck: "BITCOIN_VERIFIED" });
    expect(h.custody).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  it("two concurrent jobs: the anchored result wins whichever finishes last", async () => {
    h.row = baseRow();
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    // Job A (slow) will observe PENDING; job B (fast) proves the anchor.
    h.upgrades.push(async (file) => {
      await slowGate;
      await writeFile(file, Buffer.from(PROOF_V1, "base64"));
      return { stdout: "Pending confirmation", stderr: "" };
    });
    h.upgrades.push(upgradedTo(PROOF_V2));
    let infoCalls = 0;
    const infoFor = [infoAnchored, infoPending]; // B asks first, then A
    vi.spyOn(await import("../src/ots.service.js"), "getOtsProofInfo").mockImplementation(
      async () => infoFor[infoCalls++] as never,
    );
    const a = processOtsUpgrade(job() as never);
    const b = processOtsUpgrade(job() as never);
    // Which job reaches the binary first is scheduler order, not code order;
    // under load the fast behaviour can land on A. Never wait on B alone
    // before releasing the gate — that deadlocked the suite under load.
    await Promise.race([b.catch(() => undefined), new Promise((r) => setTimeout(r, 200))]);
    releaseSlow();
    await Promise.all([a, b]);
    expect(h.row).toMatchObject({ otsStatus: "ANCHORED", otsAnchorCheck: "PROOF_STRUCTURE", otsProofBase64: PROOF_V2 });
    expect(h.custody.map((c) => c.payload.otsPhase)).toEqual(["attestation_recorded_by_proof_structure"]);
  });
});

/*
 * THE BUDGET CLOCK STARTS WHEN THE PROOF DID (2026-09-29).
 *
 * It started at evidence.createdAt, so an old Free record stamped recently
 * was "exhausted" on its first pending observation.
 */
describe("global budget start", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(Date.now() - days * DAY);

  it("an old Free record whose proof was initialized hours ago is NOT failed on its first pending observation", async () => {
    h.row = baseRow({ createdAt: ago(400) });
    h.custodyHistory.push({ atUtc: new Date(Date.now() - 2 * 60 * 60 * 1000), payload: { phase: "ots_initialized", otsPhase: "proof_created" } });
    h.upgrades.push(upgradedTo(PROOF_V1));
    h.info = infoPending;
    await processOtsUpgrade(job() as never);
    expect(h.row!.otsStatus).toBe("PENDING");
    expect(h.incidents).toEqual([]);
    expect(h.enqueued).toEqual(["ev-1"]); // followed up on the normal cadence
  });

  it("a historical row with NO recorded OTS event is never failed by the budget (no date is invented)", async () => {
    h.row = baseRow({ createdAt: ago(400) });
    h.upgrades.push(upgradedTo(PROOF_V1));
    h.info = infoPending;
    await processOtsUpgrade(job() as never);
    expect(h.row!.otsStatus).toBe("PENDING");
    expect(h.incidents).toEqual([]);
  });

  it("the report job's legacy proof_created event is the start for pre-2026-09-09 proofs", async () => {
    h.row = baseRow({ createdAt: ago(400) });
    h.custodyHistory.push({ atUtc: ago(45), payload: { otsStatus: "PENDING", otsPhase: "proof_created" } });
    h.upgrades.push(upgradedTo(PROOF_V1));
    h.info = infoPending;
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "FAILED", otsFailureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED" });
    expect(h.incidents).toEqual(["OTS:ev-1:GLOBAL_BUDGET_EXHAUSTED"]);
  });

  it("a demoted anchor gets a full budget from its demotion, not from its initialization", async () => {
    h.row = baseRow({ createdAt: ago(400) });
    h.custodyHistory.push(
      { atUtc: ago(300), payload: { otsPhase: "proof_created" } },
      { atUtc: ago(10), payload: { otsPhase: "anchor_not_confirmed_on_recheck" } },
    );
    h.upgrades.push(upgradedTo(PROOF_V1));
    h.info = infoPending;
    await processOtsUpgrade(job() as never);
    expect(h.row!.otsStatus).toBe("PENDING");
    expect(h.incidents).toEqual([]);
  });

  it("an inconclusive check past the budget still fails nothing (the budget is only read for a conclusive pending)", async () => {
    h.row = baseRow({ createdAt: ago(400) });
    h.custodyHistory.push({ atUtc: ago(300), payload: { otsPhase: "proof_created" } });
    h.upgrades.push(upgradedTo(PROOF_V1));
    h.info = { status: "ERROR", info: null, binaryMissing: false, error: "timeout" };
    const before = { ...h.row };
    await expect(processOtsUpgrade(job() as never)).rejects.toThrow("OTS_UPGRADE_ATTEMPT_FAILED");
    expect(h.row).toEqual(before);
    expect(h.incidents).toEqual([]);
  });

  it("a stale worker cannot write budget exhaustion over a newer anchor", async () => {
    h.row = baseRow({ createdAt: ago(400) });
    h.custodyHistory.push({ atUtc: ago(45), payload: { otsPhase: "proof_created" } });
    h.upgrades.push(async (file) => {
      h.row = {
        ...h.row!,
        otsStatus: "ANCHORED",
        otsAnchorCheck: "PROOF_STRUCTURE",
        otsBitcoinTxid: TXID,
        otsAnchoredAtUtc: new Date("2026-09-20T10:00:00Z"),
        otsUpgradedAtUtc: new Date("2026-09-29T11:00:00Z"),
      };
      await writeFile(file, Buffer.from(PROOF_V1, "base64"));
      return { stdout: "Pending confirmation", stderr: "" };
    });
    h.info = infoPending;
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "ANCHORED", otsAnchorCheck: "PROOF_STRUCTURE" });
    expect(h.incidents).toEqual([]);
  });
});

describe("resolveOtsBudgetStart", () => {
  it("is the earliest recorded OTS event, moved forward only by a demotion", async () => {
    const { resolveOtsBudgetStart } = await import("../src/ots-upgrade.processor.js");
    const t = (iso: string) => new Date(iso);
    expect(resolveOtsBudgetStart([])).toBeNull();
    expect(
      resolveOtsBudgetStart([
        { atUtc: t("2026-05-02T00:00:00Z"), payload: { otsPhase: "pending_confirmation" } },
        { atUtc: t("2026-05-01T00:00:00Z"), payload: { otsPhase: "proof_created" } },
      ])?.toISOString(),
    ).toBe("2026-05-01T00:00:00.000Z");
    expect(
      resolveOtsBudgetStart([
        { atUtc: t("2026-05-01T00:00:00Z"), payload: { otsPhase: "proof_created" } },
        { atUtc: t("2026-08-01T00:00:00Z"), payload: { otsPhase: "anchor_not_confirmed_on_recheck" } },
        { atUtc: t("2026-08-02T00:00:00Z"), payload: null },
      ])?.toISOString(),
    ).toBe("2026-08-01T00:00:00.000Z");
  });
});

/*
 * DIGEST BINDING AND INDEPENDENT CHAIN VERIFICATION (2026-10-12).
 *
 * The upgraded proof's committed digest is read from its bytes; the chain
 * verifier is a deterministic double — never a real Bitcoin verification.
 */
describe("digest binding at the upgrade boundary (real proof bytes)", () => {
  it("a real proof committing to another digest is FAILED (PROOF_HASH_MISMATCH) and never recorded as an attestation", async () => {
    h.row = baseRow();
    h.upgrades.push(upgradedTo(OTHER_PROOF));
    // Even an `ots info` that claims this record's hash cannot rescue it: the bytes decide.
    h.info = infoAnchored;
    h.chainVerifier = chainDouble(CHAIN_VERIFIED);
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({
      otsStatus: "FAILED",
      otsFailureReason: "PROOF_HASH_MISMATCH",
      otsAnchorCheck: null,
      otsAttestationRecordedAtUtc: null,
      otsChainVerificationStatus: null,
    });
    expect(h.custody.map((c) => c.payload.otsPhase)).toEqual(["proof_hash_mismatch"]);
    expect(h.custody[0]!.payload).toMatchObject({ digestBinding: "MISMATCH", committedDigestMatchesFingerprint: false });
    // The verifier is never asked about a proof bound to another digest.
    expect((h.chainVerifier as { calls: unknown[] }).calls).toEqual([]);
  });

  it("a record whose OTS hash is not its fingerprint digest is FAILED, not anchored", async () => {
    h.row = baseRow({ fingerprintHash: "d".repeat(64) });
    h.upgrades.push(upgradedTo(PROOF_V2));
    h.info = infoAnchored;
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "FAILED", otsFailureReason: "PROOF_HASH_MISMATCH" });
  });
});

describe("independent chain verification outcomes (verifier double)", () => {
  it("UNAVAILABLE: the attestation is recorded, not verified, and the check is followed up", async () => {
    h.row = baseRow();
    h.upgrades.push(upgradedTo(PROOF_V2));
    h.info = infoAnchored;
    h.chainVerifier = chainDouble({ status: "UNAVAILABLE", reason: "node down" });
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({
      otsStatus: "ANCHORED",
      otsAnchorCheck: "PROOF_STRUCTURE",
      otsChainVerificationStatus: "UNAVAILABLE",
      otsChainVerifier: "test-double/1",
      otsChainBlockTimeUtc: null,
    });
    expect(h.enqueued).toEqual(["ev-1"]);
  });

  it("INSUFFICIENT_CONFIRMATIONS: not verified yet, followed up", async () => {
    h.row = baseRow();
    h.upgrades.push(upgradedTo(PROOF_V2));
    h.info = infoAnchored;
    h.chainVerifier = chainDouble({ status: "INSUFFICIENT_CONFIRMATIONS", blockHeight: 860000, confirmations: 2, requiredConfirmations: 6 });
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsAnchorCheck: "PROOF_STRUCTURE", otsChainVerificationStatus: "INSUFFICIENT_CONFIRMATIONS", otsChainBlockHeight: null });
    expect(h.enqueued).toEqual(["ev-1"]);
  });

  it("FAILED: a configured verifier rejected the attestation — recorded with its code, never verified, not followed up", async () => {
    h.row = baseRow();
    h.upgrades.push(upgradedTo(PROOF_V2));
    h.info = infoAnchored;
    h.chainVerifier = chainDouble({ status: "FAILED", failureCode: "ATTESTATION_NOT_IN_CHAIN" });
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({
      otsAnchorCheck: "PROOF_STRUCTURE",
      otsChainVerificationStatus: "FAILED",
      otsChainFailureCode: "ATTESTATION_NOT_IN_CHAIN",
    });
    expect(h.enqueued).toEqual([]);
  });

  const verifiedRow = () =>
    baseRow({
      otsStatus: "ANCHORED",
      otsAnchorCheck: "BITCOIN_VERIFIED",
      otsBitcoinTxid: TXID,
      otsProofBase64: PROOF_V2,
      otsAnchoredAtUtc: CHAIN_VERIFIED.blockTimeUtc,
      otsAttestationRecordedAtUtc: new Date("2026-09-20T11:00:00Z"),
      otsAttestationBlockHeight: 860000,
      otsChainVerificationStatus: "VERIFIED",
      otsChainCheckedAtUtc: CHAIN_VERIFIED.verifiedAtUtc,
      otsChainVerifiedAtUtc: CHAIN_VERIFIED.verifiedAtUtc,
      otsChainBlockHeight: 860000,
      otsChainBlockHash: CHAIN_VERIFIED.blockHash,
      otsChainBlockTimeUtc: CHAIN_VERIFIED.blockTimeUtc,
      otsChainConfirmations: 12,
      otsChainVerifier: "test-double/1",
      otsChainFailureCode: null,
    });

  it("a chain-verified anchor is not re-checked: the evidence is the conclusion", async () => {
    h.row = verifiedRow();
    h.chainVerifier = chainDouble({ status: "UNAVAILABLE", reason: "node down" });
    const before = { ...h.row };
    await processOtsUpgrade(job() as never);
    expect(h.row).toEqual(before);
    expect(h.upgrades.length).toBe(0);
  });

  it("a recorded attestation is re-checked once a verifier is configured, and the evidence is recorded", async () => {
    h.row = baseRow({
      otsStatus: "ANCHORED",
      otsAnchorCheck: "PROOF_STRUCTURE",
      otsBitcoinTxid: TXID,
      otsProofBase64: PROOF_V2,
      otsAnchoredAtUtc: new Date("2026-10-08T17:22:20.958Z"),
    });
    h.upgrades.push(upgradedTo(PROOF_V2));
    h.info = infoAnchored;
    h.chainVerifier = chainDouble(CHAIN_VERIFIED);
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsAnchorCheck: "BITCOIN_VERIFIED", otsChainVerificationStatus: "VERIFIED" });
    // The legacy recording time is kept as the attestation-recorded time.
    expect((h.row!.otsAttestationRecordedAtUtc as Date).toISOString()).toBe("2026-10-08T17:22:20.958Z");
    expect(h.custody.map((c) => c.payload.otsPhase)).toEqual(["chain_verified"]);
  });

  it("without a configured verifier a recorded attestation is not re-checked", async () => {
    h.row = baseRow({
      otsStatus: "ANCHORED",
      otsAnchorCheck: "PROOF_STRUCTURE",
      otsBitcoinTxid: TXID,
      otsProofBase64: PROOF_V2,
      otsAnchoredAtUtc: new Date("2026-10-08T17:22:20.958Z"),
    });
    const before = { ...h.row };
    await processOtsUpgrade(job() as never);
    expect(h.row).toEqual(before);
  });
});

describe("(2026-10-13) an attestation recorded with no verifier is verified once a verifier is configured", () => {
  it("THE ce465a9e SHAPE: NOT_CONFIGURED is re-checked when the job runs again, and the verified result is persisted", async () => {
    // 1. No verifier configured: the attestation is recorded, not verified.
    h.row = baseRow();
    h.upgrades.push(upgradedTo(PROOF_V2));
    h.info = infoAnchored;
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "ANCHORED", otsAnchorCheck: "PROOF_STRUCTURE", otsChainVerificationStatus: "NOT_CONFIGURED" });

    // 2. A verifier is configured and the backfill sweep re-enqueues the job:
    //    the same canonical path runs the chain check and persists its result.
    h.custody = [];
    h.upgrades.push(upgradedTo(PROOF_V2));
    h.chainVerifier = chainDouble(CHAIN_VERIFIED);
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({
      otsStatus: "ANCHORED",
      otsAnchorCheck: "BITCOIN_VERIFIED",
      otsChainVerificationStatus: "VERIFIED",
      otsChainBlockHeight: 860000,
      otsChainVerifier: "test-double/1",
    });
    expect(h.row!.otsChainVerifiedAtUtc).toBeInstanceOf(Date);
    expect((h.chainVerifier as { calls: Array<Record<string, unknown>> }).calls[0]).toMatchObject({ digestHex: OTS_HASH });
  });
});
