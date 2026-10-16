/**
 * THE OTS RECONCILIATION SCRIPT, on real proof bytes:
 *
 *   alignment  dry run by default, bounded arguments, compare-and-set,
 *              idempotent, one custody event per ACTUAL change, no deletes,
 *              nothing inferred from a label.
 *   pagination keyset on (createdAt, id); batches of at most 100; every row
 *              counted exactly once; resumable with --after.
 *   --chain    the independent Bitcoin-chain pass: refused unless the verifier
 *              is enabled AND ready; a dry run writes nothing; only an RPC
 *              match (a DECIDED VERIFIED check) is ever counted / written as
 *              VERIFIED — never a stored ANCHORED label; the derivative
 *              version is decided only after CHAIN_VERIFIED.
 *
 * Doubled: Prisma (an in-memory table whose findMany honours the keyset
 * where/orderBy/take/select and whose updateMany is a real compare-and-set),
 * the custody appender, the version decision, and — as MOCKS, never a node —
 * the verifier config and the two verifier entry points the script imports.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type FindManyArgs = {
  where: Row;
  orderBy: Array<Record<string, "asc" | "desc">>;
  take: number;
  select: Record<string, boolean>;
};

const h = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  custody: [] as Array<{ evidenceId: string; eventType: string; payload: Record<string, unknown> }>,
  versions: [] as Array<{ evidenceId: string; dryRun: boolean; verification: string }>,
  findManyArgs: [] as unknown[],
  updates: [] as Array<{ id: string; data: Record<string, unknown>; count: number }>,
  deletes: 0,
  /** Mutate a row between the read and the write (a concurrent worker). */
  raceOn: null as string | null,
  /** MOCK verifier config returned by resolveOtsBitcoinVerifierConfig(). */
  config: { kind: "disabled" } as Record<string, unknown>,
  /** MOCK readiness returned by probeOtsBitcoinVerifierReadiness(). */
  readiness: { ready: true, code: null, detail: null } as Record<string, unknown>,
  probes: 0,
  /** MOCK chain check, per proofSha256 (fallback: `defaultCheck`). */
  checkFor: new Map<string, () => unknown>(),
  defaultCheck: null as null | (() => unknown),
  checks: [] as Array<{ proofSha256: string | null; state: string }>,
}));

function same(a: unknown, b: unknown) {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  return (a ?? null) === (b ?? null);
}

function baseMatches(r: Row, w: Row): boolean {
  if ("deletedAt" in w && w.deletedAt === null && r.deletedAt != null) return false;
  const proof = w.otsProofBase64 as { not?: unknown } | undefined;
  if (proof && "not" in proof && proof.not === null && r.otsProofBase64 == null) return false;
  if (typeof w.id === "string" && r.id !== w.id) return false;
  if (typeof w.teamId === "string" && r.teamId !== w.teamId) return false;
  return true;
}

function cmp(a: Row, b: Row): number {
  const t = (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime();
  return t !== 0 ? t : String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

vi.mock("../src/db.js", () => {
  const prisma = {
    evidence: {
      // A faithful-enough keyset reader: base filter, optional (createdAt, id)
      // cursor, (createdAt asc, id asc), take, select.
      findMany: async (args: FindManyArgs) => {
        h.findManyArgs.push(args);
        let base = args.where;
        let cursor: { createdAt: Date; id: string } | null = null;
        if (Array.isArray(args.where.AND)) {
          const [b, c] = args.where.AND as [Row, { OR: [{ createdAt: { gt: Date } }, { createdAt: Date; id: { gt: string } }] }];
          base = b;
          cursor = { createdAt: c.OR[0].createdAt.gt, id: c.OR[1].id.gt };
        }
        return [...h.rows.values()]
          .filter((r) => baseMatches(r, base))
          .filter((r) => !cursor || cmp(r, cursor) > 0)
          .sort(cmp)
          .slice(0, args.take)
          .map((r) => Object.fromEntries(Object.keys(args.select).map((k) => [k, r[k] ?? null])));
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const row = h.rows.get(where.id as string);
        if (!row) return { count: 0 };
        if (h.raceOn === row.id) {
          row.otsUpgradedAtUtc = new Date();
          h.raceOn = null;
        }
        for (const [k, v] of Object.entries(where)) {
          if (k !== "id" && !same(row[k], v)) {
            h.updates.push({ id: row.id as string, data, count: 0 });
            return { count: 0 };
          }
        }
        Object.assign(row, data);
        h.updates.push({ id: row.id as string, data, count: 1 });
        return { count: 1 };
      },
      deleteMany: async () => {
        h.deletes += 1;
        return { count: 0 };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
    $disconnect: async () => undefined,
  };
  return { prisma };
});
vi.mock("../src/custody-events.js", () => ({
  appendCustodyEventTx: async (_tx: unknown, e: { evidenceId: string; eventType: string; payload: Record<string, unknown> }) => {
    h.custody.push({ evidenceId: e.evidenceId, eventType: String(e.eventType), payload: e.payload });
  },
}));
vi.mock("../src/ots-anchored-version.js", () => ({
  ensureOtsAnchoredReportVersion: async (i: { evidenceId: string; dryRun?: boolean; anchoring: { verification: string } }) => {
    h.versions.push({ evidenceId: i.evidenceId, dryRun: Boolean(i.dryRun), verification: i.anchoring.verification });
    return { outcome: "requested" };
  },
}));
// MOCK — the verifier configuration (no environment is read).
vi.mock("../src/ots-bitcoin-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ots-bitcoin-config.js")>()),
  resolveOtsBitcoinVerifierConfig: () => h.config,
}));
// MOCK — the verifier: no RPC client, no node; scripted readiness and checks.
vi.mock("../src/ots-bitcoin-verifier.js", () => ({
  probeOtsBitcoinVerifierReadiness: async () => {
    h.probes += 1;
    return h.readiness;
  },
  checkOtsProofAgainstBitcoin: async (a: { state: string; proofSha256: string | null }) => {
    h.checks.push({ proofSha256: a.proofSha256, state: a.state });
    const scripted = (a.proofSha256 && h.checkFor.get(a.proofSha256)) || h.defaultCheck;
    if (!scripted) throw new Error("test: no chain check scripted");
    return scripted();
  },
}));

import { OTS_CHAIN_POLICY_DEFAULTS, formatOtsChainVerifier } from "@proovra/shared";

import { REAL, upgradedProof } from "../../../packages/shared/tests/helpers/ots-fixtures.mjs";
import { chainColumnsFor } from "./fixtures/ots-chain-fixtures.js";

const { main, parseArgs, RECONCILE_MAX_BATCH } = await import("../src/scripts/reconcile-ots-state.js");

const FP = REAL.boundFingerprintHash;
const UP = upgradedProof();
const ID = {
  pendingButAnchored: "11111111-1111-4111-8111-111111111111",
  labelOnly: "22222222-2222-4222-8222-222222222222",
  aligned: "33333333-3333-4333-8333-333333333333",
  mismatch: "44444444-4444-4444-8444-444444444444",
};
const T0 = Date.parse("2026-09-01T00:00:00Z");
const BLOCK_HASH = "00000000000000000002" + "ab".repeat(22);

const ENABLED_CONFIG = {
  kind: "enabled",
  rpcUrl: "http://127.0.0.1:8332/",
  rpcEndpointLabel: "127.0.0.1:8332",
  username: "proovra",
  timeoutMs: 5000,
  policy: { ...OTS_CHAIN_POLICY_DEFAULTS, minConfirmations: 6 },
  passwordFile: null,
  passwordFromEnvironmentAllowed: true,
};

function base(i: number): Row {
  return {
    createdAt: new Date(T0 + i * 1000),
    teamId: null,
    deletedAt: null,
    otsHash: FP,
    fingerprintHash: FP,
    otsCalendar: "https://a",
    otsBitcoinTxid: null,
    otsAnchoredAtUtc: null,
    otsUpgradedAtUtc: new Date("2026-10-01T00:00:00Z"),
    otsFailureReason: null,
  };
}

function seed() {
  h.rows.set(ID.pendingButAnchored, { id: ID.pendingButAnchored, ...base(1), otsStatus: "PENDING", otsProofBase64: UP.base64 });
  h.rows.set(ID.labelOnly, { id: ID.labelOnly, ...base(2), otsStatus: "ANCHORED", otsProofBase64: REAL.boundProofBase64, otsBitcoinTxid: "e".repeat(64), otsAnchoredAtUtc: new Date("2026-10-02T00:00:00Z") });
  h.rows.set(ID.aligned, { id: ID.aligned, ...base(3), otsStatus: "PENDING", otsProofBase64: REAL.boundProofBase64 });
  h.rows.set(ID.mismatch, { id: ID.mismatch, ...base(4), otsStatus: "PENDING", otsProofBase64: REAL.otherProofBase64 });
}

/** An ANCHORED row whose stored proof resolves to ANCHORED and whose label already agrees. */
function anchoredRow(id: string, up: ReturnType<typeof upgradedProof>, i: number, over: Row = {}): Row {
  return { id, ...base(i), otsStatus: "ANCHORED", otsProofBase64: up.base64, otsBitcoinTxid: up.txid, otsAnchoredAtUtc: new Date("2026-10-02T00:00:00Z"), ...over };
}

/** Chain columns as Prisma returns them (Dates, not ISO strings). */
function chainCols(up: ReturnType<typeof upgradedProof>, o: Record<string, unknown> = {}): Row {
  const c = chainColumnsFor(up, o) as Row;
  for (const k of ["otsChainCheckedAtUtc", "otsChainVerifiedAtUtc", "otsChainBlockTimeUtc"]) if (c[k]) c[k] = new Date(c[k] as string);
  return c;
}

// --- scripted chain checks (the shape checkOtsProofAgainstBitcoin returns) ---
const verifierFor = (up: { proofSha256: string }) => formatOtsChainVerifier({ nodeVersion: 270000, minConfirmations: 6, proofSha256: up.proofSha256 });
const tip = (height: number) => ({ chain: "main", height, hash: "", nodeVersion: 270000 });
const CHECKED_AT = new Date("2026-10-15T09:00:00Z");
function decided(up: ReturnType<typeof upgradedProof>, status: "VERIFIED" | "INSUFFICIENT_CONFIRMATIONS", confirmations: number) {
  return () => ({
    kind: "DECIDED",
    decision: {
      status,
      failureCode: status === "VERIFIED" ? null : "INSUFFICIENT_CONFIRMATIONS",
      blockHeight: up.blockHeight,
      blockHash: BLOCK_HASH,
      blockTimeUtc: "2024-05-01T12:00:00.000Z",
      confirmations,
      rejected: [],
    },
    verifier: verifierFor(up),
    checkedAtUtc: new Date(CHECKED_AT),
    tip: tip(up.blockHeight + confirmations - 1),
  });
}
function decidedFailed(up: ReturnType<typeof upgradedProof>, code: string) {
  return () => ({
    kind: "DECIDED",
    decision: { status: "FAILED", failureCode: code, blockHeight: up.blockHeight, blockHash: null, blockTimeUtc: null, confirmations: null, rejected: [{ blockHeight: up.blockHeight, code }] },
    verifier: verifierFor(up),
    checkedAtUtc: new Date(CHECKED_AT),
    tip: tip(up.blockHeight + 100),
  });
}
const unavailable = (code = "BTC_RPC_TIMEOUT") => () => ({ kind: "UNAVAILABLE", code, detail: "timeout", checkedAtUtc: new Date(CHECKED_AT) });

beforeEach(() => {
  h.rows.clear();
  h.custody.length = 0;
  h.versions.length = 0;
  h.findManyArgs.length = 0;
  h.updates.length = 0;
  h.deletes = 0;
  h.raceOn = null;
  h.config = { kind: "disabled" };
  h.readiness = { enabled: true, ready: true, code: null, detail: null };
  h.probes = 0;
  h.checkFor.clear();
  h.defaultCheck = null;
  h.checks.length = 0;
  seed();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("arguments", () => {
  it("dry run by default; bounded limit; ids must be UUIDs; unknown flags refused", () => {
    expect(parseArgs([])).toEqual({ apply: false, chain: false, batchSize: 100, maxRows: 1000, evidenceId: null, teamId: null, after: null });
    // --limit is kept as an alias of the total bound --max-rows.
    expect(parseArgs(["--apply", "--limit", "5", "--evidence-id", ID.aligned])).toMatchObject({ apply: true, maxRows: 5, evidenceId: ID.aligned });
    expect(parseArgs(["--chain", "--max-rows", "500"])).toMatchObject({ chain: true, maxRows: 500 });
    expect(() => parseArgs(["--limit", "100001"])).toThrow();
    expect(() => parseArgs(["--max-rows", "100001"])).toThrow();
    expect(() => parseArgs(["--limit", "0"])).toThrow();
    expect(() => parseArgs(["--evidence-id", "not-a-uuid"])).toThrow();
    expect(() => parseArgs(["--team-id", "not-a-uuid"])).toThrow();
    expect(() => parseArgs(["--after", "2026-10-01T00:00:00.000Z,not-a-uuid"])).toThrow();
    expect(() => parseArgs(["--after", `not-a-date,${ID.aligned}`])).toThrow();
    expect(parseArgs(["--after", `2026-10-01T00:00:00.000Z,${ID.aligned}`]).after).toEqual({ createdAt: new Date("2026-10-01T00:00:00.000Z"), id: ID.aligned });
    expect(() => parseArgs(["--force"])).toThrow();
  });

  it("the batch size is capped at 100", () => {
    expect(RECONCILE_MAX_BATCH).toBe(100);
    expect(parseArgs(["--batch-size", "100"]).batchSize).toBe(100);
    expect(parseArgs(["--batch-size", "7"]).batchSize).toBe(7);
    expect(() => parseArgs(["--batch-size", "101"])).toThrow();
    expect(() => parseArgs(["--batch-size", "0"])).toThrow();
  });
});

describe("dry run", () => {
  it("decides every row and writes nothing", async () => {
    const before = JSON.stringify([...h.rows.values()]);
    const { results, summary } = await main([]);
    expect(JSON.stringify([...h.rows.values()])).toBe(before);
    expect(h.custody).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(summary).toMatchObject({ applied: false, chainPass: false, scanned: 4, toAlign: 3, aligned: 0, versionWouldRequest: 0, versionRequested: 0 });
    const by = Object.fromEntries(results.map((r) => [r.evidenceId, r]));
    // The proof NAMES a block (ANCHORED) but nothing was checked against the
    // chain: ATTESTATION_RECORDED, and no derivative version is decided for it.
    expect(by[ID.pendingButAnchored]).toMatchObject({ state: "ANCHORED", verification: "ATTESTATION_RECORDED", action: "align", phase: "anchored_by_stored_proof", chain: "not_evaluated", version: "not_evaluated" });
    expect(by[ID.labelOnly]).toMatchObject({ state: "PENDING", action: "align", phase: "legacy_anchor_label_without_attestation" });
    expect(by[ID.aligned]).toMatchObject({ state: "PENDING", action: "none" });
    expect(by[ID.mismatch]).toMatchObject({ state: "FAILED", failureCode: "PROOF_HASH_MISMATCH", action: "align" });
    expect(h.versions).toEqual([]);
    // Output carries no proof bytes, storage keys or URLs.
    expect(JSON.stringify(results)).not.toMatch(/https?:|AE9wZW5UaW1l/);
  });

  it("is bounded to one evidence id", async () => {
    const { results } = await main(["--evidence-id", ID.pendingButAnchored]);
    expect(results.map((r) => r.evidenceId)).toEqual([ID.pendingButAnchored]);
  });
});

describe("--apply", () => {
  it("aligns each row compare-and-set with exactly one custody event per actual change; nothing deleted", async () => {
    const { summary } = await main(["--apply"]);
    expect(summary).toMatchObject({ applied: true, aligned: 3, skippedRowMoved: 0 });
    expect(h.rows.get(ID.pendingButAnchored)).toMatchObject({ otsStatus: "ANCHORED", otsBitcoinTxid: UP.txid, otsProofBase64: UP.base64 });
    expect(h.rows.get(ID.labelOnly)).toMatchObject({ otsStatus: "PENDING", otsBitcoinTxid: null, otsAnchoredAtUtc: null, otsProofBase64: REAL.boundProofBase64 });
    expect(h.rows.get(ID.mismatch)).toMatchObject({ otsStatus: "FAILED", otsFailureReason: "PROOF_HASH_MISMATCH", otsProofBase64: REAL.otherProofBase64 });
    expect(h.custody.map((c) => c.evidenceId).sort()).toEqual([ID.labelOnly, ID.mismatch, ID.pendingButAnchored].sort());
    expect(h.custody.find((c) => c.evidenceId === ID.pendingButAnchored)!.payload).toMatchObject({
      otsState: "ANCHORED",
      otsVerification: "ATTESTATION_RECORDED",
      trigger: "reconcile_ots_state",
    });
    // No version is requested for an unchecked attestation (re-pinned: the
    // version now follows CHAIN_VERIFIED only).
    expect(h.versions).toEqual([]);
    expect(summary.versionRequested).toBe(0);
    expect(h.deletes).toBe(0);
  });

  it("is idempotent: a second run changes nothing and records nothing", async () => {
    await main(["--apply"]);
    const events = h.custody.length;
    const snapshot = JSON.stringify([...h.rows.values()]);
    const { summary } = await main(["--apply"]);
    expect(summary).toMatchObject({ toAlign: 0, aligned: 0 });
    expect(h.custody.length).toBe(events);
    expect(JSON.stringify([...h.rows.values()])).toBe(snapshot);
  });

  it("a row that moved on between read and write is skipped, never overwritten", async () => {
    h.raceOn = ID.pendingButAnchored;
    const { results, summary } = await main(["--apply", "--evidence-id", ID.pendingButAnchored]);
    expect(results[0]).toMatchObject({ action: "skipped_row_moved" });
    expect(summary).toMatchObject({ aligned: 0, skippedRowMoved: 1 });
    expect(h.rows.get(ID.pendingButAnchored)!.otsStatus).toBe("PENDING");
    expect(h.custody).toEqual([]);
  });
});

describe("keyset pagination", () => {
  function seedMany(n: number) {
    h.rows.clear();
    for (let i = 0; i < n; i += 1) {
      const id = `${String(i).padStart(8, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`;
      // Groups of three share a createdAt: the id breaks the tie.
      h.rows.set(id, { id, ...base(Math.floor(i / 3)), otsStatus: "PENDING", otsProofBase64: REAL.boundProofBase64 });
    }
    // A deleted record is never scanned.
    h.rows.set("ffffffff-ffff-4fff-8fff-ffffffffffff", { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", ...base(0), deletedAt: new Date(), otsStatus: "PENDING", otsProofBase64: UP.base64 });
  }
  const live = () => [...h.rows.values()].filter((r) => r.deletedAt == null).map((r) => r.id as string).sort();

  it("counts every row exactly once across batches (more rows than one batch)", async () => {
    seedMany(250);
    const { results, summary } = await main([]);
    const ids = results.map((r) => r.evidenceId);
    expect(summary.scanned).toBe(250);
    expect(new Set(ids).size).toBe(250);
    expect([...ids].sort()).toEqual(live());
    const takes = (h.findManyArgs as FindManyArgs[]).map((a) => a.take);
    expect(takes).toEqual([100, 100, 100]);
    expect((h.findManyArgs as FindManyArgs[])[0]!.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    expect(summary.nextAfter).toBe(`${(h.rows.get(ids[249]!)!.createdAt as Date).toISOString()},${ids[249]}`);
  });

  it("small batches with tied createdAt still count every row once", async () => {
    seedMany(23);
    const { results, summary } = await main(["--batch-size", "4"]);
    expect(summary.scanned).toBe(23);
    expect([...results.map((r) => r.evidenceId)].sort()).toEqual(live());
    expect((h.findManyArgs as FindManyArgs[]).every((a) => a.take <= 4)).toBe(true);
  });

  it("--max-rows bounds the run and --after resumes it without overlap or gap", async () => {
    seedMany(250);
    const first = await main(["--batch-size", "7", "--max-rows", "20"]);
    expect(first.summary.scanned).toBe(20);
    expect(first.summary.nextAfter).toBeTruthy();
    h.findManyArgs.length = 0;
    const rest = await main(["--after", first.summary.nextAfter!]);
    const a = first.results.map((r) => r.evidenceId);
    const b = rest.results.map((r) => r.evidenceId);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
    expect([...a, ...b].sort()).toEqual(live());
  });

  it("the findMany take never exceeds 100, even when asked for more rows in total", async () => {
    seedMany(250);
    await main(["--max-rows", "100000"]);
    expect(h.findManyArgs.length).toBeGreaterThan(0);
    expect((h.findManyArgs as FindManyArgs[]).every((a) => a.take <= 100)).toBe(true);
  });

  it("reads the full OTS snapshot, chain columns included", async () => {
    await main([]);
    const select = (h.findManyArgs as FindManyArgs[])[0]!.select;
    expect(select).toMatchObject({ id: true, createdAt: true, otsProofBase64: true, otsChainVerificationStatus: true, otsChainVerifier: true, otsChainBlockHeight: true });
  });
});

describe("--chain: refusal (fail closed)", () => {
  it("--chain --apply is refused when the verifier is disabled — nothing read, checked or written", async () => {
    h.config = { kind: "disabled" };
    const before = JSON.stringify([...h.rows.values()]);
    const { summary, results } = await main(["--chain", "--apply"]);
    expect(summary).toMatchObject({ refused: 1, scanned: 0, aligned: 0, verified: 0 });
    expect(results).toEqual([]);
    expect(h.findManyArgs).toEqual([]);
    expect(h.checks).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.custody).toEqual([]);
    expect(JSON.stringify([...h.rows.values()])).toBe(before);
  });

  it("--chain --apply is refused when the verifier is misconfigured", async () => {
    h.config = { kind: "misconfigured", reason: "OTS_BITCOIN_RPC_URL is required" };
    const { summary } = await main(["--chain", "--apply"]);
    expect(summary.refused).toBe(1);
    expect(h.updates).toEqual([]);
    expect(h.probes).toBe(0);
  });

  it("--chain --apply is refused when the readiness gate fails NOW", async () => {
    h.config = ENABLED_CONFIG;
    h.readiness = { enabled: true, ready: false, code: "NODE_STALE", detail: "tip too old" };
    h.defaultCheck = decided(UP, "VERIFIED", 10);
    const before = JSON.stringify([...h.rows.values()]);
    const { summary } = await main(["--chain", "--apply"]);
    expect(h.probes).toBe(1);
    expect(summary).toMatchObject({ refused: 1, scanned: 0, aligned: 0, verified: 0, versionRequested: 0 });
    expect(h.findManyArgs).toEqual([]);
    expect(h.checks).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.custody).toEqual([]);
    expect(h.versions).toEqual([]);
    expect(JSON.stringify([...h.rows.values()])).toBe(before);
  });
});

describe("--chain: the independent Bitcoin-chain pass", () => {
  beforeEach(() => {
    h.config = ENABLED_CONFIG;
  });

  it("a dry run writes nothing and reports what would change", async () => {
    h.defaultCheck = decided(UP, "VERIFIED", 10);
    const before = JSON.stringify([...h.rows.values()]);
    const { summary, results } = await main(["--chain"]);
    expect(JSON.stringify([...h.rows.values()])).toBe(before);
    expect(h.updates).toEqual([]);
    expect(h.custody).toEqual([]);
    expect(summary).toMatchObject({ applied: false, chainPass: true, scanned: 4, wouldVerify: 1, verified: 0, versionWouldRequest: 1, versionRequested: 0 });
    // Only the row whose PROOF resolves to ANCHORED is checked — never by label.
    expect(h.checks).toEqual([{ proofSha256: UP.proofSha256, state: "ANCHORED" }]);
    const by = Object.fromEntries(results.map((r) => [r.evidenceId, r]));
    expect(by[ID.pendingButAnchored]).toMatchObject({ chain: "would_verify", verification: "CHAIN_VERIFIED", version: "would_request" });
    expect(by[ID.labelOnly]).toMatchObject({ state: "PENDING", chain: "not_applicable" });
    expect(by[ID.labelOnly]!.verification).not.toBe("CHAIN_VERIFIED");
    expect(h.versions).toEqual([{ evidenceId: ID.pendingButAnchored, dryRun: true, verification: "CHAIN_VERIFIED" }]);
  });

  it("--apply: an RPC-proven match is written VERIFIED (chain columns only) with one custody event and one version request", async () => {
    h.defaultCheck = decided(UP, "VERIFIED", 10);
    const { summary, results } = await main(["--chain", "--apply", "--evidence-id", ID.pendingButAnchored]);
    expect(summary).toMatchObject({ aligned: 1, verified: 1, wouldVerify: 0, versionRequested: 1, skippedRowMoved: 0 });
    expect(results[0]).toMatchObject({ action: "aligned", chain: "verified", verification: "CHAIN_VERIFIED", version: "requested" });
    expect(h.rows.get(ID.pendingButAnchored)).toMatchObject({
      otsStatus: "ANCHORED",
      otsProofBase64: UP.base64,
      otsBitcoinTxid: UP.txid,
      otsChainVerificationStatus: "VERIFIED",
      otsChainBlockHeight: UP.blockHeight,
      otsChainBlockHash: BLOCK_HASH,
      otsChainConfirmations: 10,
      otsChainVerifier: verifierFor(UP),
      otsChainFailureCode: null,
    });
    // The chain write touches only chain columns.
    const chainWrite = h.updates.filter((u) => u.count === 1)[1]!;
    expect(Object.keys(chainWrite.data).every((k) => k.startsWith("otsChain"))).toBe(true);
    expect(h.custody.map((c) => c.payload.otsPhase)).toEqual(["anchored_by_stored_proof", "chain_verified"]);
    const chainEvent = h.custody[1]!;
    expect(chainEvent).toMatchObject({ eventType: "OTS_APPLIED" });
    expect(chainEvent.payload).toMatchObject({ otsVerification: "CHAIN_VERIFIED", trigger: "reconcile_ots_state", chain: { status: "VERIFIED", blockHash: BLOCK_HASH, confirmations: 10 } });
    // No node address, user or password reaches the custody chain.
    expect(JSON.stringify(h.custody)).not.toMatch(/https?:|127\.0\.0\.1|8332|password|proovra"/i);
    expect(h.versions).toEqual([{ evidenceId: ID.pendingButAnchored, dryRun: false, verification: "CHAIN_VERIFIED" }]);
  });

  it("--apply is idempotent: a re-check on the same block records no new custody event", async () => {
    h.defaultCheck = decided(UP, "VERIFIED", 10);
    await main(["--chain", "--apply", "--evidence-id", ID.pendingButAnchored]);
    const events = h.custody.length;
    const { summary } = await main(["--chain", "--apply", "--evidence-id", ID.pendingButAnchored]);
    expect(summary).toMatchObject({ toAlign: 0, aligned: 0, skippedRowMoved: 0 });
    expect(h.custody.length).toBe(events);
    expect(h.rows.get(ID.pendingButAnchored)!.otsChainVerificationStatus).toBe("VERIFIED");
  });

  it("counts each outcome once: verified / insufficient confirmations / unavailable / failed, and versions only after VERIFIED", async () => {
    h.rows.clear();
    const ups = [842_101, 842_102, 842_103, 842_104].map((blockHeight) => upgradedProof({ blockHeight }));
    const ids = ["a1111111-1111-4111-8111-111111111111", "a2222222-2222-4222-8222-222222222222", "a3333333-3333-4333-8333-333333333333", "a4444444-4444-4444-8444-444444444444"];
    ups.forEach((up, i) => h.rows.set(ids[i]!, anchoredRow(ids[i]!, up, i)));
    h.checkFor.set(ups[0]!.proofSha256, decided(ups[0]!, "VERIFIED", 10));
    h.checkFor.set(ups[1]!.proofSha256, decided(ups[1]!, "INSUFFICIENT_CONFIRMATIONS", 2));
    h.checkFor.set(ups[2]!.proofSha256, unavailable());
    h.checkFor.set(ups[3]!.proofSha256, decidedFailed(ups[3]!, "ROOT_MISMATCH"));

    const dry = await main(["--chain"]);
    expect(dry.summary).toMatchObject({ scanned: 4, wouldVerify: 1, verified: 0, insufficientConfirmations: 1, unavailable: 1, failed: 1, versionWouldRequest: 1, versionRequested: 0, skippedRowMoved: 0 });
    expect(h.updates).toEqual([]);

    h.versions.length = 0;
    const { summary, results } = await main(["--chain", "--apply"]);
    expect(summary).toMatchObject({ scanned: 4, wouldVerify: 0, verified: 1, insufficientConfirmations: 1, unavailable: 1, failed: 1, versionWouldRequest: 0, versionRequested: 1, skippedRowMoved: 0 });
    expect(results.map((r) => r.chain)).toEqual(["verified", "insufficient_confirmations", "unavailable", "failed"]);
    expect(results.map((r) => r.verification)).toEqual(["CHAIN_VERIFIED", "CHAIN_CONFIRMATIONS_PENDING", "CHAIN_UNAVAILABLE", "CHAIN_FAILED"]);
    expect(ids.map((id) => h.rows.get(id)!.otsChainVerificationStatus)).toEqual(["VERIFIED", "INSUFFICIENT_CONFIRMATIONS", "UNAVAILABLE", "FAILED"]);
    // The lifecycle status and the proof are never touched by a chain outcome.
    expect(ids.map((id) => h.rows.get(id)!.otsStatus)).toEqual(["ANCHORED", "ANCHORED", "ANCHORED", "ANCHORED"]);
    expect(ids.map((id, i) => h.rows.get(id)!.otsProofBase64 === ups[i]!.base64)).toEqual([true, true, true, true]);
    expect(h.custody.map((c) => c.payload.otsVerification)).toEqual(["CHAIN_VERIFIED", "CHAIN_CONFIRMATIONS_PENDING", "CHAIN_UNAVAILABLE", "CHAIN_FAILED"]);
    expect(h.versions).toEqual([{ evidenceId: ids[0], dryRun: false, verification: "CHAIN_VERIFIED" }]);
    // A terminal contradiction is not re-checked on the next run.
    h.checks.length = 0;
    const again = await main(["--chain", "--apply", "--evidence-id", ids[3]!]);
    expect(again.results[0]).toMatchObject({ chain: "terminal" });
    expect(h.checks).toEqual([]);
  });

  it("a chain write whose row moved on is skipped and counted, never overwritten — no custody event, no version", async () => {
    h.rows.clear();
    const id = "b1111111-1111-4111-8111-111111111111";
    h.rows.set(id, anchoredRow(id, UP, 1));
    h.defaultCheck = decided(UP, "VERIFIED", 10);
    h.raceOn = id;
    const { summary, results } = await main(["--chain", "--apply"]);
    expect(results[0]).toMatchObject({ action: "none", chain: "skipped_row_moved" });
    expect(summary).toMatchObject({ verified: 0, skippedRowMoved: 1, versionRequested: 0 });
    expect(h.rows.get(id)!.otsChainVerificationStatus ?? null).toBeNull();
    expect(h.custody).toEqual([]);
    expect(h.versions).toEqual([]);
  });
});

describe("never promoted from a stored ANCHORED label", () => {
  beforeEach(() => {
    h.config = ENABLED_CONFIG;
  });

  it("an ANCHORED row whose chain check is not VERIFIED is never counted or written VERIFIED", async () => {
    h.rows.clear();
    const id = "c1111111-1111-4111-8111-111111111111";
    h.rows.set(id, anchoredRow(id, UP, 1));
    for (const check of [decided(UP, "INSUFFICIENT_CONFIRMATIONS", 2), unavailable("NODE_STALE"), decidedFailed(UP, "NOT_IN_ACTIVE_CHAIN")]) {
      h.defaultCheck = check;
      const { summary, results } = await main(["--chain", "--apply"]);
      expect(summary).toMatchObject({ verified: 0, wouldVerify: 0, versionRequested: 0 });
      expect(results[0]!.verification).not.toBe("CHAIN_VERIFIED");
      expect(h.rows.get(id)!.otsChainVerificationStatus).not.toBe("VERIFIED");
    }
    expect(h.versions).toEqual([]);
  });

  it("a VERIFIED chain record bound to ANOTHER proof is ignored: the row is not verified and an outage replaces it", async () => {
    h.rows.clear();
    const id = "c2222222-2222-4222-8222-222222222222";
    const other = upgradedProof({ blockHeight: 900_000 });
    // Stored VERIFIED columns, but the verifier identity names another proof.
    h.rows.set(id, anchoredRow(id, UP, 1, chainCols(UP, { status: "VERIFIED", proofSha256: other.proofSha256 })));
    // Without --chain: no version for a record that is not CHAIN_VERIFIED.
    const plain = await main([]);
    expect(plain.results[0]).toMatchObject({ state: "ANCHORED", verification: "ATTESTATION_RECORDED", version: "not_evaluated" });
    expect(h.versions).toEqual([]);
    // With --chain and the node unavailable: still never VERIFIED.
    h.defaultCheck = unavailable();
    const { summary, results } = await main(["--chain", "--apply"]);
    expect(summary).toMatchObject({ verified: 0, unavailable: 1, versionRequested: 0 });
    expect(results[0]!.verification).toBe("CHAIN_UNAVAILABLE");
    expect(h.rows.get(id)!.otsChainVerificationStatus).toBe("UNAVAILABLE");
    expect(h.versions).toEqual([]);
  });

  it("a PENDING proof with an ANCHORED label (and VERIFIED-looking chain columns) is never checked and never verified", async () => {
    h.rows.set(ID.labelOnly, { ...h.rows.get(ID.labelOnly)!, ...chainCols(UP, { status: "VERIFIED" }) });
    h.defaultCheck = decided(UP, "VERIFIED", 10);
    const { results, summary } = await main(["--chain", "--apply", "--evidence-id", ID.labelOnly]);
    expect(h.checks).toEqual([]);
    expect(results[0]).toMatchObject({ state: "PENDING", action: "aligned", chain: "not_applicable", version: "not_evaluated" });
    expect(results[0]!.verification).not.toBe("CHAIN_VERIFIED");
    expect(summary).toMatchObject({ verified: 0, wouldVerify: 0, versionRequested: 0 });
    // The demotion clears the chain columns: no chain fact about a PENDING proof.
    expect(h.rows.get(ID.labelOnly)).toMatchObject({ otsStatus: "PENDING", otsChainVerificationStatus: null, otsChainVerifier: null });
    expect(h.versions).toEqual([]);
  });
});
