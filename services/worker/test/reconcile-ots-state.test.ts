/**
 * THE LEGACY OTS RECONCILIATION SCRIPT (2026-10-13), on real proof bytes:
 * dry run by default, bounded arguments, compare-and-set, idempotent, one
 * custody event per ACTUAL change, no deletes, nothing inferred from a label.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  custody: [] as Array<{ evidenceId: string; eventType: string; payload: Record<string, unknown> }>,
  versions: [] as Array<{ evidenceId: string; dryRun: boolean }>,
  findManyArgs: [] as unknown[],
  deletes: 0,
  /** Mutate a row between the read and the write (a concurrent worker). */
  raceOn: null as string | null,
}));

function same(a: unknown, b: unknown) {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  return (a ?? null) === (b ?? null);
}

vi.mock("../src/db.js", () => {
  const prisma = {
    evidence: {
      findMany: async (args: { where: Record<string, unknown>; take: number }) => {
        h.findManyArgs.push(args);
        const id = args.where.id as string | undefined;
        return [...h.rows.values()].filter((r) => !id || r.id === id).slice(0, args.take).map((r) => ({ ...r }));
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = h.rows.get(where.id as string);
        if (!row) return { count: 0 };
        if (h.raceOn === row.id) {
          row.otsUpgradedAtUtc = new Date();
          h.raceOn = null;
        }
        for (const [k, v] of Object.entries(where)) if (k !== "id" && !same(row[k], v)) return { count: 0 };
        Object.assign(row, data);
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
  ensureOtsAnchoredReportVersion: async (i: { evidenceId: string; dryRun?: boolean }) => {
    h.versions.push({ evidenceId: i.evidenceId, dryRun: Boolean(i.dryRun) });
    return { outcome: "requested" };
  },
}));

import { REAL, upgradedProof } from "../../../packages/shared/tests/helpers/ots-fixtures.mjs";

const { main, parseArgs } = await import("../src/scripts/reconcile-ots-state.js");

const FP = REAL.boundFingerprintHash;
const UP = upgradedProof();
const ID = {
  pendingButAnchored: "11111111-1111-4111-8111-111111111111",
  labelOnly: "22222222-2222-4222-8222-222222222222",
  aligned: "33333333-3333-4333-8333-333333333333",
  mismatch: "44444444-4444-4444-8444-444444444444",
};

function seed() {
  const base = { otsHash: FP, fingerprintHash: FP, otsCalendar: "https://a", otsBitcoinTxid: null, otsAnchoredAtUtc: null, otsUpgradedAtUtc: new Date("2026-10-01T00:00:00Z"), otsFailureReason: null };
  h.rows.set(ID.pendingButAnchored, { id: ID.pendingButAnchored, ...base, otsStatus: "PENDING", otsProofBase64: UP.base64 });
  h.rows.set(ID.labelOnly, { id: ID.labelOnly, ...base, otsStatus: "ANCHORED", otsProofBase64: REAL.boundProofBase64, otsBitcoinTxid: "e".repeat(64), otsAnchoredAtUtc: new Date("2026-10-02T00:00:00Z") });
  h.rows.set(ID.aligned, { id: ID.aligned, ...base, otsStatus: "PENDING", otsProofBase64: REAL.boundProofBase64 });
  h.rows.set(ID.mismatch, { id: ID.mismatch, ...base, otsStatus: "PENDING", otsProofBase64: REAL.otherProofBase64 });
}

beforeEach(() => {
  h.rows.clear();
  h.custody.length = 0;
  h.versions.length = 0;
  h.findManyArgs.length = 0;
  h.deletes = 0;
  h.raceOn = null;
  seed();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("arguments", () => {
  it("dry run by default; bounded limit; ids must be UUIDs; unknown flags refused", () => {
    expect(parseArgs([])).toEqual({ apply: false, limit: 100, evidenceId: null, teamId: null });
    expect(parseArgs(["--apply", "--limit", "5", "--evidence-id", ID.aligned])).toMatchObject({ apply: true, limit: 5, evidenceId: ID.aligned });
    expect(() => parseArgs(["--limit", "1001"])).toThrow();
    expect(() => parseArgs(["--limit", "0"])).toThrow();
    expect(() => parseArgs(["--evidence-id", "not-a-uuid"])).toThrow();
    expect(() => parseArgs(["--force"])).toThrow();
  });
});

describe("dry run", () => {
  it("decides every row and writes nothing", async () => {
    const before = JSON.stringify([...h.rows.values()]);
    const { results, summary } = await main([]);
    expect(JSON.stringify([...h.rows.values()])).toBe(before);
    expect(h.custody).toEqual([]);
    expect(summary).toMatchObject({ applied: false, scanned: 4, toAlign: 3, aligned: 0 });
    const by = Object.fromEntries(results.map((r) => [r.evidenceId, r]));
    expect(by[ID.pendingButAnchored]).toMatchObject({ state: "ANCHORED", action: "align", phase: "anchored_by_stored_proof", version: "would_request" });
    expect(by[ID.labelOnly]).toMatchObject({ state: "PENDING", action: "align", phase: "legacy_anchor_label_without_attestation" });
    expect(by[ID.aligned]).toMatchObject({ state: "PENDING", action: "none" });
    expect(by[ID.mismatch]).toMatchObject({ state: "FAILED", failureCode: "PROOF_HASH_MISMATCH", action: "align" });
    expect(h.versions.every((v) => v.dryRun)).toBe(true);
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
    expect(h.custody.find((c) => c.evidenceId === ID.pendingButAnchored)!.payload).toMatchObject({ otsState: "ANCHORED", trigger: "reconcile_ots_state" });
    expect(h.versions.filter((v) => !v.dryRun).map((v) => v.evidenceId)).toEqual([ID.pendingButAnchored]);
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
    const { results } = await main(["--apply", "--evidence-id", ID.pendingButAnchored]);
    expect(results[0]).toMatchObject({ action: "skipped_row_moved" });
    expect(h.rows.get(ID.pendingButAnchored)!.otsStatus).toBe("PENDING");
    expect(h.custody).toEqual([]);
  });
});
