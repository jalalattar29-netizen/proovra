/**
 * OTS OBSERVABILITY (2026-10-29).
 *
 *  1. The client identity: `ots --version` → "opentimestamps-client x.y.z". The
 *     pattern had lost its backslashes, so every proof recorded null.
 *  2. ONE anchoring start: the Worker's budget and the operations aging
 *     condition measure from the same instant (resolveOtsAnchoringStart) — the
 *     custody-recorded start, or the record's creation when it has none.
 *  3. A DISABLED Bitcoin verifier while ANCHORED records wait unchecked is
 *     observable: a DEGRADED telemetry row (BTC_VERIFIER_DISABLED) the API's
 *     platform-conditions pass turns into `platform.bitcoin_verifier_unavailable`.
 *     Nothing is verified or marked verified; with nothing waiting, nothing is
 *     published.
 *
 * Doubled: the database client only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  awaiting: 0,
  countWhere: [] as unknown[],
  snapshots: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    evidence: {
      count: async (args: { where: unknown }) => {
        h.countWhere.push(args.where);
        return h.awaiting;
      },
      // Every chain/verification write would go through update(Many); none may happen.
      update: async () => {
        throw new Error("telemetry must never write evidence");
      },
      updateMany: async () => {
        throw new Error("telemetry must never write evidence");
      },
    },
    workerTelemetrySnapshot: {
      create: async (args: { data: Record<string, unknown> }) => {
        h.snapshots.push(args.data);
        return args.data;
      },
    },
  },
}));

import {
  isOtsGlobalBudgetExhausted,
  isOtsPendingAged,
  otsPendingAgeHours,
  resolveOtsAnchoringStart,
  resolveOtsBudgetStart,
} from "@proovra/shared-runtime";

import {
  BITCOIN_VERIFIER_DISABLED_CODE,
  countAnchoredAwaitingChainVerification,
  publishBitcoinVerifierReadiness,
} from "../src/ots-bitcoin-telemetry.js";
import { otsClientIdentityFromVersionOutput } from "../src/ots.service.js";

describe("OpenTimestamps client identity", () => {
  it("reads the version the client prints, with or without a leading v", () => {
    expect(otsClientIdentityFromVersionOutput("v0.7.2\n")).toBe("opentimestamps-client 0.7.2");
    expect(otsClientIdentityFromVersionOutput("0.7.1")).toBe("opentimestamps-client 0.7.1");
    expect(otsClientIdentityFromVersionOutput("  v0.7 ")).toBe("opentimestamps-client 0.7");
  });

  it("never guesses: anything that is not a version is null", () => {
    expect(otsClientIdentityFromVersionOutput("")).toBeNull();
    expect(otsClientIdentityFromVersionOutput("ots: command not found")).toBeNull();
    // The broken pattern /^(d+.d+…)/ matched this literal text and nothing real.
    expect(otsClientIdentityFromVersionOutput("dd.dd")).toBeNull();
  });
});

describe("one anchoring start for the budget and the aging condition", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const now = new Date("2026-10-29T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("the custody-recorded start wins over creation, for both readings", () => {
    const createdAt = ago(400 * DAY);
    const otsBudgetStartUtc = resolveOtsBudgetStart([{ atUtc: ago(2 * HOUR), payload: { otsPhase: "proof_created" } }]);
    const row = { otsStatus: "PENDING", otsAnchoredAtUtc: null, otsBudgetStartUtc, createdAt };
    const start = resolveOtsAnchoringStart(row);
    expect(start.toISOString()).toBe(ago(2 * HOUR).toISOString());
    // The Worker would not fail it; operations would not call it aged.
    expect(isOtsGlobalBudgetExhausted({ firstAttemptAtUtc: start, nowUtc: now })).toBe(false);
    expect(isOtsPendingAged(row, now)).toBe(false);
    expect(otsPendingAgeHours(row, now)).toBe(2);
  });

  it("with no OTS custody event the start is the record's creation — defined, so the budget is reachable", () => {
    const row = { otsStatus: "PENDING", otsAnchoredAtUtc: null, otsBudgetStartUtc: resolveOtsBudgetStart([]), createdAt: ago(40 * DAY) };
    const start = resolveOtsAnchoringStart(row);
    expect(start.toISOString()).toBe(row.createdAt.toISOString());
    expect(isOtsGlobalBudgetExhausted({ firstAttemptAtUtc: start, nowUtc: now })).toBe(true);
    expect(isOtsPendingAged(row, now)).toBe(true);
  });

  it("an anchor-recorded time is not an anchoring start (the Worker never measured from it)", () => {
    const row = { otsStatus: "PENDING", otsAnchoredAtUtc: ago(1 * HOUR), createdAt: ago(5 * DAY) };
    expect(otsPendingAgeHours(row, now)).toBe(5 * 24);
  });
});

describe("a disabled Bitcoin verifier with anchored records waiting", () => {
  beforeEach(() => {
    vi.stubEnv("OTS_BITCOIN_VERIFY_ENABLED", "false");
    h.awaiting = 0;
    h.countWhere.length = 0;
    h.snapshots.length = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("counts ANCHORED, undeleted records with no terminal chain outcome", async () => {
    h.awaiting = 3;
    expect(await countAnchoredAwaitingChainVerification()).toBe(3);
    expect(h.countWhere[0]).toEqual({
      deletedAt: null,
      otsStatus: "ANCHORED",
      OR: [{ otsChainVerificationStatus: null }, { otsChainVerificationStatus: { notIn: ["VERIFIED", "FAILED"] } }],
    });
  });

  it("publishes ONE degraded, credential-free row naming the wait — and verifies nothing", async () => {
    h.awaiting = 2;
    await publishBitcoinVerifierReadiness("w-1", { force: true, now: Date.parse("2026-10-29T12:00:00Z") });
    expect(h.snapshots).toHaveLength(1);
    const row = h.snapshots[0]!;
    expect(row).toMatchObject({
      workerId: "bitcoin-verifier:w-1",
      workerKind: "OTS",
      status: "DEGRADED",
      lastErrorCode: BITCOIN_VERIFIER_DISABLED_CODE,
    });
    // The API reads any non-HEALTHY status as ACTIVE and keeps a bounded code.
    expect(row.status).not.toBe("HEALTHY");
    expect(BITCOIN_VERIFIER_DISABLED_CODE).toMatch(/^[A-Z0-9_]{1,64}$/);
    expect(String(row.lastErrorMessage)).toContain("2 anchored record(s)");
    const meta = row.metadataJson as { anchoredAwaitingChainVerification: number; bitcoinVerifier: Record<string, unknown> };
    expect(meta.anchoredAwaitingChainVerification).toBe(2);
    expect(meta.bitcoinVerifier).toMatchObject({ enabled: false, ready: false, code: BITCOIN_VERIFIER_DISABLED_CODE });
    expect(JSON.stringify(row)).not.toMatch(/password|rpc_?url|http:\/\//i);
  });

  it("with nothing waiting, nothing is published (a deployment that never anchors needs no verifier)", async () => {
    h.awaiting = 0;
    await publishBitcoinVerifierReadiness("w-1", { force: true });
    expect(h.snapshots).toHaveLength(0);
  });
});
