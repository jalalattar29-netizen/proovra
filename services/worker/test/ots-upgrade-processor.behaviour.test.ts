/**
 * THE OTS UPGRADE PROCESSOR, RUN (2026-10-13).
 *
 * The real `processOtsUpgrade` against an in-memory evidence row whose
 * `updateMany` is a real compare-and-set over the OTS columns, on REAL
 * OpenTimestamps bytes (packages/shared/tests/helpers/ots-fixtures.mjs). Only
 * the OpenTimestamps binary (`execFile`), the custody appender, the queue, the
 * incident bridge and the downstream version decision are doubled.
 *
 * The state is decided from the executed proof: a proof that executes to a
 * valid Bitcoin block attestation is ANCHORED (terminal per proof); calendar
 * output and status strings decide nothing.
 */
import { JOB_NAMES, buildCanonicalJobPayload } from "@proovra/shared";
import { beforeEach, describe, expect, it } from "vitest";

import { REAL, upgradedProof } from "../../../packages/shared/tests/helpers/ots-fixtures.mjs";

const OTS_HASH = REAL.boundFingerprintHash;
const PROOF_V1 = REAL.boundProofBase64;
const UPGRADED = upgradedProof({ blockHeight: 860000 });
const PROOF_V2 = UPGRADED.base64;
const OTHER_PROOF = REAL.otherProofBase64;

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  custody: [] as Array<{ eventType: string; payload: Record<string, unknown> }>,
  /** Pre-existing OTS custody history the budget reads (sequence order). */
  custodyHistory: [] as Array<{ atUtc: Date; payload: Record<string, unknown> }>,
  enqueued: [] as string[],
  incidents: [] as string[],
  versionDecisions: [] as Array<{ evidenceId: string; state: string; proofSha256: string | null }>,
  /** Per-call behaviour of `ots upgrade`, consumed in order. */
  upgrades: [] as Array<(file: string) => Promise<{ stdout: string; stderr: string }>>,
}));

import { vi } from "vitest";

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
    custodyEvent: { findMany: async () => h.custodyHistory.map((e) => ({ ...e })) },
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
  ensureOtsAnchoredReportVersion: async (input: { evidenceId: string; anchoring: { state: string; proofSha256: string | null } }) => {
    h.versionDecisions.push({ evidenceId: input.evidenceId, state: input.anchoring.state, proofSha256: input.anchoring.proofSha256 });
    return { outcome: "requested" };
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

const { processOtsUpgrade, resolveOtsBudgetStart, isOtsTransportFailure } = await import("../src/ots-upgrade.processor.js");
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
    fingerprintHash: OTS_HASH,
    ...over,
  };
}

/** `ots upgrade` wrote these bytes and reported success. */
const upgradedTo = (proof: string) => async (file: string) => {
  await writeFile(file, Buffer.from(proof, "base64"));
  return { stdout: "Success! Timestamp complete", stderr: "" };
};
/** `ots upgrade` exited non-zero because the calendar has nothing new yet (bytes unchanged). */
const stillPending = async () => {
  throw Object.assign(new Error("Command failed"), { stdout: "", stderr: "Pending confirmation in Bitcoin blockchain" });
};
/** `ots upgrade` could not reach the calendar. */
const networkFailure = async () => {
  throw Object.assign(new Error("Command failed"), { stdout: "", stderr: "getaddrinfo ENOTFOUND a.pool.opentimestamps.org" });
};

beforeEach(() => {
  // Live Bitcoin verification is OFF here (its default); the chain path is
  // exercised in test/ots-chain-processor.behaviour.test.ts.
  vi.stubEnv("OTS_BITCOIN_VERIFY_ENABLED", "false");
  h.row = null;
  h.custody.length = 0;
  h.custodyHistory.length = 0;
  h.enqueued.length = 0;
  h.incidents.length = 0;
  h.versionDecisions.length = 0;
  h.upgrades.length = 0;
});

describe("a proof that executes to a Bitcoin block attestation", () => {
  it("is recorded ANCHORED with the txid the executed path derives — an unchecked attestation, so NO version decision", async () => {
    h.row = baseRow();
    h.upgrades.push(upgradedTo(PROOF_V2));
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({
      otsStatus: "ANCHORED",
      otsProofBase64: PROOF_V2,
      otsBitcoinTxid: UPGRADED.txid,
      otsFailureReason: null,
    });
    expect(h.row!.otsAnchoredAtUtc).toBeInstanceOf(Date);
    expect(h.custody).toHaveLength(1);
    expect(h.custody[0]).toMatchObject({ eventType: "OTS_APPLIED" });
    expect(h.custody[0]!.payload).toMatchObject({
      otsState: "ANCHORED",
      otsPhase: "anchored",
      bitcoinBlockHeight: 860000,
      bitcoinTxid: UPGRADED.txid,
      proofSha256: UPGRADED.proofSha256,
      // 2026-10-15: ANCHORED only NAMES a block; the event records it as such.
      otsVerification: "ATTESTATION_RECORDED",
    });
    // No chain fact and no verified claim anywhere in what is recorded.
    expect(JSON.stringify(h.custody)).not.toMatch(/CHAIN_VERIFIED|"chain"|anchorCheck|verif(y|ied)/i);
    // The verifier is disabled here: no chain-check follow-up is scheduled.
    expect(h.enqueued).toEqual([]);
    // 2026-10-15: a plain ANCHORED (unchecked attestation) requests NO derivative
    // version — only CHAIN_VERIFIED does (test/ots-chain-processor.behaviour.test.ts).
    expect(h.versionDecisions).toEqual([]);
  });

  it("a stored PENDING label over an already-anchored proof is aligned without calling the binary (restart recovery)", async () => {
    h.row = baseRow({ otsProofBase64: PROOF_V2 });
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "ANCHORED", otsBitcoinTxid: UPGRADED.txid });
    expect(h.custody.map((c) => c.payload.otsPhase)).toEqual(["anchored_by_stored_proof"]);
    expect(h.custody[0]!.payload.otsVerification).toBe("ATTESTATION_RECORDED");
    expect(h.upgrades.length).toBe(0);
    // 2026-10-15: no version for an unchecked attestation.
    expect(h.versionDecisions).toEqual([]);
  });

  it("duplicate delivery after the anchor is recorded changes nothing; with the verifier disabled no chain check and no version decision", async () => {
    h.row = baseRow({ otsStatus: "ANCHORED", otsProofBase64: PROOF_V2, otsBitcoinTxid: UPGRADED.txid, otsAnchoredAtUtc: new Date("2026-10-01T00:00:00Z") });
    const before = { ...h.row };
    await processOtsUpgrade(job() as never);
    expect(h.row).toEqual(before);
    expect(h.custody).toEqual([]);
    expect(h.upgrades.length).toBe(0);
    expect(h.enqueued).toEqual([]);
    // 2026-10-15: the old re-asked version decision for plain ANCHORED is gone.
    expect(h.versionDecisions).toEqual([]);
  });
});

describe("a proof still awaiting Bitcoin", () => {
  it("stays PENDING (no custody event when nothing changed) and is followed up — the non-zero exit is not an error", async () => {
    h.row = baseRow();
    h.upgrades.push(stillPending);
    await processOtsUpgrade(job() as never);
    expect(h.row!.otsStatus).toBe("PENDING");
    expect(h.custody).toEqual([]);
    expect(h.enqueued).toEqual(["ev-1"]);
    expect(h.versionDecisions).toEqual([]);
  });

  it("an ANCHORED label with a txid over a proof with no Bitcoin attestation is aligned to PENDING — never kept from the label", async () => {
    h.row = baseRow({ otsStatus: "ANCHORED", otsBitcoinTxid: "c".repeat(64), otsAnchoredAtUtc: new Date("2026-09-20T10:00:00Z") });
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "PENDING", otsBitcoinTxid: null, otsAnchoredAtUtc: null });
    expect(h.custody.map((c) => c.payload.otsPhase)).toEqual(["legacy_anchor_label_without_attestation"]);
  });
});

describe("calendar failure", () => {
  it("writes NO OTS column, records an attempt error, and throws for the retry budget", async () => {
    h.row = baseRow();
    const before = { ...h.row };
    h.upgrades.push(networkFailure);
    await expect(processOtsUpgrade(job() as never)).rejects.toThrow("OTS_UPGRADE_ATTEMPT_FAILED");
    expect(h.row).toEqual(before);
    expect(h.custody.map((c) => c.eventType)).toEqual(["OTS_ATTEMPT_ERROR"]);
    // Bounded reason: no calendar URL, no path.
    expect(String(h.custody[0]!.payload.reason)).not.toMatch(/https?:|pool\.opentimestamps/);
  });

  it("classifies transport failures and leaves 'pending' output alone", () => {
    expect(isOtsTransportFailure("getaddrinfo ENOTFOUND a.pool.opentimestamps.org")).toBe(true);
    expect(isOtsTransportFailure("HTTP Error 503: Service Unavailable")).toBe(true);
    expect(isOtsTransportFailure("spawn ots ENOENT")).toBe(true);
    expect(isOtsTransportFailure("Pending confirmation in Bitcoin blockchain")).toBe(false);
    expect(isOtsTransportFailure("")).toBe(false);
  });
});

describe("proof defects (terminal, bounded codes)", () => {
  it("upgraded bytes committing to another digest: FAILED PROOF_HASH_MISMATCH, the stored proof preserved, never anchored", async () => {
    h.row = baseRow();
    h.upgrades.push(upgradedTo(upgradedProof({ base64: OTHER_PROOF }).base64));
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "FAILED", otsFailureReason: "PROOF_HASH_MISMATCH", otsProofBase64: PROOF_V1, otsBitcoinTxid: null });
    expect(h.custody.map((c) => c.eventType)).toEqual(["OTS_FAILED"]);
    expect(h.versionDecisions).toEqual([]);
  });

  it("a stored proof that is not an OpenTimestamps proof is FAILED MALFORMED_PROOF without calling the binary", async () => {
    h.row = baseRow({ otsProofBase64: Buffer.from("not a proof at all, just bytes").toString("base64") });
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "FAILED", otsFailureReason: "MALFORMED_PROOF" });
    expect(h.upgrades.length).toBe(0);
  });

  it("a malformed Bitcoin attestation is FAILED INVALID_ATTESTATION", async () => {
    h.row = baseRow();
    h.upgrades.push(upgradedTo(upgradedProof({ trailingPayload: new Uint8Array([9]) }).base64));
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "FAILED", otsFailureReason: "INVALID_ATTESTATION" });
  });

  it("a FAILED proof defect is not retried", async () => {
    h.row = baseRow({ otsStatus: "FAILED", otsProofBase64: OTHER_PROOF, otsFailureReason: "PROOF_HASH_MISMATCH" });
    const before = { ...h.row };
    await processOtsUpgrade(job() as never);
    expect(h.row).toEqual(before);
    expect(h.upgrades.length).toBe(0);
  });
});

describe("stale and concurrent completions (compare-and-set)", () => {
  it("a job whose row anchored while it ran discards its older observation", async () => {
    h.row = baseRow();
    h.upgrades.push(async (file) => {
      h.row = { ...h.row!, otsStatus: "ANCHORED", otsProofBase64: PROOF_V2, otsBitcoinTxid: UPGRADED.txid, otsAnchoredAtUtc: new Date(), otsUpgradedAtUtc: new Date() };
      await writeFile(file, Buffer.from(PROOF_V1, "base64"));
      return { stdout: "Pending confirmation", stderr: "" };
    });
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "ANCHORED", otsProofBase64: PROOF_V2 });
    expect(h.custody).toEqual([]);
  });

  it("two concurrent jobs: exactly one ANCHORED write and one custody event", async () => {
    h.row = baseRow();
    h.upgrades.push(upgradedTo(PROOF_V2), upgradedTo(PROOF_V2));
    await Promise.all([processOtsUpgrade(job() as never), processOtsUpgrade(job() as never)]);
    expect(h.row).toMatchObject({ otsStatus: "ANCHORED", otsProofBase64: PROOF_V2 });
    expect(h.custody.filter((c) => c.payload.otsState === "ANCHORED")).toHaveLength(1);
    // 2026-10-15: no derivative version for an unchecked attestation.
    expect(h.versionDecisions).toEqual([]);
  });
});

describe("global budget", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(Date.now() - days * DAY);

  it("a proof initialized hours ago is NOT failed on its first pending observation", async () => {
    h.row = baseRow({ createdAt: ago(400) });
    h.custodyHistory.push({ atUtc: new Date(Date.now() - 2 * 60 * 60 * 1000), payload: { otsPhase: "proof_created" } });
    h.upgrades.push(stillPending);
    await processOtsUpgrade(job() as never);
    expect(h.row!.otsStatus).toBe("PENDING");
    expect(h.incidents).toEqual([]);
  });

  // 2026-10-29: a row with NO recorded OTS event used to get a null budget
  // start and stay PENDING forever. Its start is now the record's creation
  // (resolveOtsAnchoringStart) — the same start the aging condition reads.
  it("a historical row with NO recorded OTS event is failed at budget, measured from its creation", async () => {
    h.row = baseRow({ createdAt: ago(400) });
    h.upgrades.push(stillPending);
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "FAILED", otsFailureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED", otsProofBase64: PROOF_V1 });
    expect(h.incidents).toEqual(["OTS:ev-1:GLOBAL_BUDGET_EXHAUSTED"]);
  });

  it("a row with NO recorded OTS event, created inside the budget, stays PENDING", async () => {
    h.row = baseRow({ createdAt: ago(10) });
    h.upgrades.push(stillPending);
    await processOtsUpgrade(job() as never);
    expect(h.row!.otsStatus).toBe("PENDING");
    expect(h.incidents).toEqual([]);
  });

  it("a proof still pending past the budget is FAILED OTS_GLOBAL_BUDGET_EXHAUSTED with one incident", async () => {
    h.row = baseRow({ createdAt: ago(400) });
    h.custodyHistory.push({ atUtc: ago(45), payload: { otsPhase: "proof_created" } });
    h.upgrades.push(stillPending);
    await processOtsUpgrade(job() as never);
    expect(h.row).toMatchObject({ otsStatus: "FAILED", otsFailureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED", otsProofBase64: PROOF_V1 });
    expect(h.incidents).toEqual(["OTS:ev-1:GLOBAL_BUDGET_EXHAUSTED"]);
  });

  it("a proof that anchors past the budget is ANCHORED, not failed", async () => {
    h.row = baseRow({ createdAt: ago(400) });
    h.custodyHistory.push({ atUtc: ago(45), payload: { otsPhase: "proof_created" } });
    h.upgrades.push(upgradedTo(PROOF_V2));
    await processOtsUpgrade(job() as never);
    expect(h.row!.otsStatus).toBe("ANCHORED");
    expect(h.incidents).toEqual([]);
  });

  it("a calendar failure past the budget fails nothing", async () => {
    h.row = baseRow({ createdAt: ago(400) });
    h.custodyHistory.push({ atUtc: ago(300), payload: { otsPhase: "proof_created" } });
    h.upgrades.push(networkFailure);
    await expect(processOtsUpgrade(job() as never)).rejects.toThrow("OTS_UPGRADE_ATTEMPT_FAILED");
    expect(h.row!.otsStatus).toBe("PENDING");
    expect(h.incidents).toEqual([]);
  });

  it("resolveOtsBudgetStart is the earliest recorded OTS event, moved forward only by a demotion", () => {
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
        { atUtc: t("2026-08-01T00:00:00Z"), payload: { otsPhase: "legacy_anchor_label_without_attestation" } },
      ])?.toISOString(),
    ).toBe("2026-08-01T00:00:00.000Z");
  });
});
