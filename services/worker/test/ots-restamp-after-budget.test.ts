/**
 * CRYPTO-005 / OPS-016 — a proof that missed its 30-day budget is stamped
 * again, once, and the superseded proof is kept on the custody event.
 *
 * The OTS client and the database are doubles (the calendar is external); the
 * function under test is the real re-stamp authority.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  priorRestamps: 0,
  updates: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
  events: [] as Array<Record<string, unknown>>,
  stamp: { status: "PENDING", proofBase64: Buffer.from("new-proof").toString("base64"), hash: "h", calendar: "https://a.example" } as Record<string, unknown>,
  stampCalls: 0,
}));

vi.mock("../src/db.js", () => {
  const tx = {
    evidence: {
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        S.updates.push(args);
        const r = S.row!;
        const matches =
          r.otsStatus === args.where.otsStatus &&
          r.otsFailureReason === args.where.otsFailureReason &&
          r.otsProofBase64 === args.where.otsProofBase64;
        if (matches) Object.assign(r, args.data);
        return { count: matches ? 1 : 0 };
      },
    },
  };
  return {
    prisma: {
      evidence: { findFirst: async () => (S.row ? { ...S.row } : null) },
      custodyEvent: { count: async () => S.priorRestamps },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});
vi.mock("../src/custody-events.js", () => ({
  appendCustodyEventTx: async (_tx: unknown, event: Record<string, unknown>) => {
    S.events.push(event);
  },
}));
vi.mock("../src/ots.service.js", () => ({
  createOpenTimestamp: async () => {
    S.stampCalls += 1;
    return S.stamp;
  },
}));
vi.mock("@proovra/shared", async (orig) => ({
  ...(await orig<typeof import("@proovra/shared")>()),
  checkOtsDigestBinding: () => ({ kind: "MATCH" }),
}));

import { MAX_OTS_RESTAMPS, restampExhaustedOtsProof } from "../src/ots-lifecycle.js";

const OLD = Buffer.from("old-proof").toString("base64");

beforeEach(() => {
  S.row = {
    id: "ev-1",
    teamId: "t-1",
    status: "SIGNED",
    fingerprintCanonicalJson: "{\"a\":1}",
    fingerprintHash: "f".repeat(64),
    otsProofBase64: OLD,
    otsStatus: "FAILED",
    otsFailureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED",
    otsHash: "h",
    otsCalendar: "https://old.example",
  };
  S.priorRestamps = 0;
  S.updates = [];
  S.events = [];
  S.stampCalls = 0;
  S.stamp = { status: "PENDING", proofBase64: Buffer.from("new-proof").toString("base64"), hash: "h", calendar: "https://a.example" };
});

describe("CRYPTO-005 — re-stamp after the budget", () => {
  it("stamps the same digest again and keeps the superseded proof whole on the custody event", async () => {
    const out = await restampExhaustedOtsProof({ evidenceId: "ev-1" });
    expect(out).toEqual({ restamped: true, status: "PENDING", needsUpgrade: true });
    expect(S.row!.otsStatus).toBe("PENDING");
    expect(S.row!.otsProofBase64).toBe(S.stamp.proofBase64);
    // The write was conditional on the exhausted proof still being there.
    expect(S.updates[0]!.where).toMatchObject({ otsStatus: "FAILED", otsFailureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED", otsProofBase64: OLD });
    expect(S.events).toHaveLength(1);
    expect(S.events[0]).toMatchObject({ eventType: "OTS_APPLIED" });
    expect(S.events[0]!.payload).toMatchObject({
      otsPhase: "proof_restamped",
      restampOrdinal: 1,
      previousProofBase64: OLD,
      previousFailureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED",
      previousCalendar: "https://old.example",
    });
    expect((S.events[0]!.payload as { previousProofSha256: string }).previousProofSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is bounded: a record already re-stamped is not stamped again", async () => {
    S.priorRestamps = MAX_OTS_RESTAMPS;
    expect(await restampExhaustedOtsProof({ evidenceId: "ev-1" })).toEqual({ restamped: false, reason: "restamp_limit_reached" });
    expect(S.stampCalls).toBe(0);
  });

  it("only a budget-exhausted proof qualifies; an invalid proof or a pending one is left alone", async () => {
    S.row!.otsFailureReason = "PROOF_HASH_MISMATCH";
    expect(await restampExhaustedOtsProof({ evidenceId: "ev-1" })).toMatchObject({ restamped: false, reason: "not_budget_exhausted" });
    S.row!.otsFailureReason = "OTS_GLOBAL_BUDGET_EXHAUSTED";
    S.row!.otsStatus = "PENDING";
    expect(await restampExhaustedOtsProof({ evidenceId: "ev-1" })).toMatchObject({ restamped: false, reason: "not_budget_exhausted" });
    expect(S.stampCalls).toBe(0);
  });

  it("a stamp that does not come back pending changes nothing; a raced writer wins", async () => {
    S.stamp = { status: "FAILED", proofBase64: null, failureReason: "calendar_down" };
    expect(await restampExhaustedOtsProof({ evidenceId: "ev-1" })).toEqual({ restamped: false, reason: "stamp_not_pending" });
    expect(S.row!.otsProofBase64).toBe(OLD);
    S.stamp = { status: "PENDING", proofBase64: Buffer.from("new").toString("base64"), hash: "h", calendar: "c" };
    // Another writer replaced the proof between the read and the write.
    const realFind = S.row!;
    S.row = { ...realFind };
    const original = S.row;
    S.updates = [];
    original.otsProofBase64 = OLD;
    const pending = restampExhaustedOtsProof({ evidenceId: "ev-1" });
    original.otsProofBase64 = Buffer.from("someone-else").toString("base64");
    expect(await pending).toEqual({ restamped: false, reason: "raced" });
    expect(S.events).toHaveLength(0);
  });
});
