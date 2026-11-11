/**
 * AUD-0022 — with OpenTimestamps off, initialization records the record's
 * DISABLED status but appends NO custody event. It appended OTS_APPLIED
 * (otsStatus DISABLED, otsPhase proof_created) for every record, and the report
 * then said "OpenTimestamps proof updated" beside "Anchoring: Not requested".
 * Events already on the append-only chain now read as what they were.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  updates: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
  events: [] as Array<Record<string, unknown>>,
  stamp: { status: "DISABLED", proofBase64: null, hash: null, calendar: null } as Record<string, unknown>,
}));

vi.mock("../src/db.js", () => {
  const tx = {
    evidence: {
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        S.updates.push(args);
        const r = S.row!;
        const matches = r.otsProofBase64 === null;
        if (matches) Object.assign(r, args.data);
        return { count: matches ? 1 : 0 };
      },
    },
  };
  return {
    prisma: {
      evidence: { findFirst: async () => (S.row ? { ...S.row } : null) },
      custodyEvent: { count: async () => 0 },
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
  createOpenTimestamp: async () => S.stamp,
}));
vi.mock("@proovra/shared", async (orig) => ({
  ...(await orig<typeof import("@proovra/shared")>()),
  checkOtsDigestBinding: () => ({ kind: "MATCH" }),
}));

import { ensureEvidenceOtsInitialized } from "../src/ots-lifecycle.js";
import { otsCustodyEventLines } from "@proovra/shared";

beforeEach(() => {
  S.row = {
    id: "ev-1",
    teamId: "t-1",
    status: "SIGNED",
    fingerprintCanonicalJson: "{\"a\":1}",
    fingerprintHash: "f".repeat(64),
    otsProofBase64: null,
    otsStatus: null,
    otsFailureReason: null,
    otsHash: null,
    otsCalendar: null,
  };
  S.updates = [];
  S.events = [];
});

describe("AUD-0022 — a disabled stamp is recorded on the record, not on the custody chain", () => {
  it("DISABLED: the record's status is written; no custody event is appended", async () => {
    S.stamp = { status: "DISABLED", proofBase64: null, hash: null, calendar: null };
    await ensureEvidenceOtsInitialized({ evidenceId: "ev-1" });
    expect(S.updates).toHaveLength(1);
    expect(S.events).toEqual([]);
  });

  it("control: a PENDING stamp still appends its OTS_APPLIED event", async () => {
    S.stamp = { status: "PENDING", proofBase64: Buffer.from("proof").toString("base64"), hash: "h", calendar: "https://a.example" };
    await ensureEvidenceOtsInitialized({ evidenceId: "ev-1" });
    expect(S.events).toHaveLength(1);
    expect(S.events[0]).toMatchObject({ eventType: "OTS_APPLIED" });
  });

  it("events already written while OTS was off read as not requested, never 'proof updated'", () => {
    const lines = otsCustodyEventLines({ otsStatus: "DISABLED", otsPhase: "proof_created" });
    expect(lines.join(" ")).not.toMatch(/proof updated/);
    expect(lines.join(" ")).toMatch(/not requested/);
    // Control: a pending proof keeps its wording.
    expect(otsCustodyEventLines({ otsStatus: "PENDING" }).join(" ")).toMatch(/pending/);
  });
});
