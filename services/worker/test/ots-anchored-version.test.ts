/**
 * ONE AUTOMATIC REPORT VERSION WHEN A PROOF IS INDEPENDENTLY VERIFIED AGAINST
 * THE BITCOIN MAIN CHAIN (2026-10-15; until then: "when a proof becomes
 * ANCHORED"). ANCHORED now only means the proof NAMES a block — an unchecked
 * attestation — and is never a reason for a new version; CHAIN_VERIFIED is.
 *
 * The decision is run against an in-memory store (MOCKS: prisma, the request
 * creator, the queue) whose request table enforces the idempotency
 * (clientRequestKey per evidence). Covered: PENDING v1 → CHAIN_VERIFIED
 * requests exactly one v2; verified before v1 requests nothing;
 * duplicate deliveries, the reconcile script and the post-commit hook collapse
 * onto the one request; a report in flight defers; no charge path exists.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  reports: [] as Array<{ version: number; anchorSnapshot: unknown }>,
  requests: [] as Array<{ id: string; evidenceId: string; clientRequestKey: string | null; artifactType: string; state: string; purpose?: string; forceRegenerate?: boolean; intent?: string; requestedByMachineId?: string }>,
  enqueued: [] as string[],
  row: null as Record<string, unknown> | null,
  /** O-1 — the writer collapses the next create onto this (terminal) head. */
  collapseTo: null as { id: string; state: string } | null,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    report: {
      findFirst: async () => [...h.reports].sort((a, b) => b.version - a.version)[0] ?? null,
    },
    reportGenerationRequest: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        h.requests.find(
          (r) =>
            r.evidenceId === where.evidenceId &&
            (where.clientRequestKey === undefined || r.clientRequestKey === where.clientRequestKey) &&
            (where.artifactType === undefined || r.artifactType === where.artifactType) &&
            (where.state === undefined || (where.state as { in: string[] }).in.includes(r.state)),
        ) ?? null,
      // F-10 — the owed-version decision reads every request under the proof's
      // key and its retry keys.
      findMany: async ({ where }: { where: { evidenceId: string; clientRequestKey: { in: string[] } } }) =>
        h.requests
          .filter((r) => r.evidenceId === where.evidenceId && r.clientRequestKey !== null && where.clientRequestKey.in.includes(r.clientRequestKey))
          .map((r) => ({ id: r.id, state: r.state, clientRequestKey: r.clientRequestKey })),
    },
    evidence: { findUnique: async () => (h.row ? { ...h.row } : null) },
  },
}));

vi.mock("@proovra/shared-runtime/reports", () => ({
  createReportGenerationRequest: async (_p: unknown, input: Record<string, unknown>) => {
    if (h.collapseTo) return { created: true, requestId: h.collapseTo.id, state: h.collapseTo.state, teamId: "t", deduplicated: true, superseded: false };
    const prior = h.requests.find((r) => r.evidenceId === input.evidenceId && r.clientRequestKey === input.clientRequestKey);
    if (prior) return { created: true, requestId: prior.id, state: prior.state, teamId: "t", deduplicated: true, superseded: false, replayed: true };
    const id = `req-${h.requests.length + 1}`;
    h.requests.push({
      id,
      evidenceId: String(input.evidenceId),
      clientRequestKey: (input.clientRequestKey as string) ?? null,
      artifactType: String(input.artifactType),
      state: "QUEUED",
      purpose: String(input.purpose),
      forceRegenerate: input.forceRegenerate as boolean,
      intent: input.intent as string,
      requestedByMachineId: input.requestedByMachineId as string,
    });
    return { created: true, requestId: id, state: "QUEUED", teamId: "t", deduplicated: false, superseded: false };
  },
}));

vi.mock("../src/queue.js", () => ({
  enqueueReportGenerationRequest: async (id: string) => {
    h.enqueued.push(id);
    return { enqueued: true };
  },
}));

import { REAL, upgradedProof } from "../../../packages/shared/tests/helpers/ots-fixtures.mjs";
import { chainColumnsFor } from "./fixtures/ots-chain-fixtures.js";
import { resolveRecordOtsAnchoring } from "@proovra/shared";

const {
  ensureOtsAnchoredReportVersion,
  otsChainVerifiedRequestKey,
  reconcileOtsAnchoredReportVersion,
  reportStatedChainVerification,
  OTS_ANCHORED_MACHINE_ID,
} = await import("../src/ots-anchored-version.js");

const FP = REAL.boundFingerprintHash;
const UP = upgradedProof();
const CHAIN = chainColumnsFor(UP);
const BLOCK = CHAIN.otsChainBlockHash as string;

/** An ANCHORED row whose proof was NOT checked against the chain. */
const ATTESTED_ROW = { otsStatus: "ANCHORED", otsProofBase64: UP.base64, otsHash: FP, fingerprintHash: FP };
/** The same row with an independent chain check bound to this proof: VERIFIED. */
const VERIFIED_ROW = { ...ATTESTED_ROW, ...CHAIN };

const ATTESTED = resolveRecordOtsAnchoring(ATTESTED_ROW);
const VERIFIED = resolveRecordOtsAnchoring(VERIFIED_ROW);
/** What a report that stated THIS chain verification carries in its anchor snapshot. */
const STATED_VERIFIED = { otsState: "ANCHORED", otsVerification: "CHAIN_VERIFIED", otsProofSha256: UP.proofSha256, otsChainBlockHash: BLOCK };

beforeEach(() => {
  h.reports.length = 0;
  h.requests.length = 0;
  h.enqueued.length = 0;
  h.row = null;
});

describe("fixtures", () => {
  it("the attested row is an unchecked attestation; the verified row is CHAIN_VERIFIED", () => {
    expect(ATTESTED).toMatchObject({ state: "ANCHORED", verification: "ATTESTATION_RECORDED", chain: null });
    expect(VERIFIED).toMatchObject({ state: "ANCHORED", verification: "CHAIN_VERIFIED" });
    expect(VERIFIED.chain?.blockHash).toBe(BLOCK);
  });
});

describe("the automatic version decision", () => {
  it("v1 stated PENDING; the proof is chain-verified → exactly one forced NEW_VERSION request, by a machine, enqueued", async () => {
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } });
    const r = await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED });
    expect(r.outcome).toBe("requested");
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      purpose: "ots_upgrade_completed",
      artifactType: "REPORT",
      intent: "NEW_VERSION",
      forceRegenerate: true,
      clientRequestKey: otsChainVerifiedRequestKey(UP.proofSha256, BLOCK),
      requestedByMachineId: OTS_ANCHORED_MACHINE_ID,
    });
    expect(OTS_ANCHORED_MACHINE_ID).toBe("worker.ots-chain-verified");
    expect(h.enqueued).toEqual([h.requests[0]!.id]);
  });

  it("a plain ANCHORED proof (attestation recorded, never checked) requests NOTHING — the old v2-on-ANCHORED is gone", async () => {
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } });
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: ATTESTED })).outcome).toBe("not_chain_verified");
    h.row = ATTESTED_ROW;
    expect((await reconcileOtsAnchoredReportVersion("ev-1")).outcome).toBe("not_chain_verified");
    expect(h.requests).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  it("no chain outcome short of VERIFIED requests a version (pending confirmations, unavailable, failed)", async () => {
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } });
    for (const status of ["INSUFFICIENT_CONFIRMATIONS", "UNAVAILABLE", "FAILED"] as const) {
      const row = { ...ATTESTED_ROW, ...chainColumnsFor(UP, { status }) };
      h.row = row;
      const a = resolveRecordOtsAnchoring(row);
      expect(a.verification).not.toBe("CHAIN_VERIFIED");
      expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: a })).outcome).toBe("not_chain_verified");
      expect((await reconcileOtsAnchoredReportVersion("ev-1")).outcome).toBe("not_chain_verified");
    }
    expect(h.requests).toEqual([]);
  });

  it("a CHAIN_VERIFIED claim without a chain fact (no block hash) is not believed", async () => {
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } });
    const forged = { ...ATTESTED, verification: "CHAIN_VERIFIED" as const, chain: null };
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: forged })).outcome).toBe("not_chain_verified");
    expect(h.requests).toEqual([]);
  });

  it("is idempotent: duplicate deliveries, the reconcile script and the commit hook collapse onto the one request", async () => {
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } });
    h.row = VERIFIED_ROW;
    await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED });
    // The request has run and finished: still collapses on the key.
    h.requests[0]!.state = "SUCCEEDED";
    const again = await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED });
    const viaReconcile = await reconcileOtsAnchoredReportVersion("ev-1");
    expect(again.outcome).toBe("already_requested");
    expect(viaReconcile.outcome).toBe("already_requested");
    expect(h.requests).toHaveLength(1);
    expect(h.enqueued).toHaveLength(1);
  });

  it("F-10: a TECHNICALLY failed owed request is re-asked under the next retry key, collapsing on repeat, capped", async () => {
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } });
    h.row = VERIFIED_ROW;
    await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED });
    h.requests[0]!.state = "FAILED_TERMINAL";
    const retry = await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED });
    expect(retry.outcome).toBe("requested");
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.clientRequestKey).toMatch(/^ots-cv-r1:/);
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED })).outcome).toBe("already_requested");
    // Three retries, then the owed version is an operator matter.
    for (let i = 0; i < 5; i += 1) {
      h.requests.at(-1)!.state = "FAILED_TERMINAL";
      await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED });
    }
    expect(h.requests).toHaveLength(4);
  });

  it("O-1 (closure re-audit): a retry the writer collapses onto another terminal head is not a new request", async () => {
    h.reports = [{ version: 1, anchorSnapshot: { otsVerification: "PENDING" } }];
    h.row = { ...VERIFIED_ROW };
    const first = await reconcileOtsAnchoredReportVersion("e1");
    expect(first.outcome).toBe("requested");
    h.requests.find((q) => q.id === first.requestId)!.state = "FAILED_TERMINAL";
    const enqueuedBefore = h.enqueued.length;
    h.collapseTo = { id: "customer-head", state: "FAILED_TERMINAL" };
    try {
      const retry = await reconcileOtsAnchoredReportVersion("e1");
      expect(retry).toEqual({ outcome: "already_requested", requestId: "customer-head" });
      expect(h.enqueued.length).toBe(enqueuedBefore);
    } finally {
      h.collapseTo = null;
    }
  });

  it("F-10: a business refusal of the owed request is a stable answer, never re-asked", async () => {
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } });
    h.row = VERIFIED_ROW;
    await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED });
    for (const state of ["NOT_APPLICABLE", "BLOCKED_POLICY", "BLOCKED_STALE", "SUCCEEDED"]) {
      h.requests[0]!.state = state;
      expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED })).outcome, state).toBe("already_requested");
    }
    expect(h.requests).toHaveLength(1);
  });

  it("once v2 stated this chain verification nothing more is requested (previous versions untouched)", async () => {
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } }, { version: 2, anchorSnapshot: STATED_VERIFIED });
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED })).outcome).toBe("latest_report_chain_verified");
    expect(h.requests).toEqual([]);
  });

  it("a latest report that stated only an ANCHORED attestation (not chain-verified) is superseded once", async () => {
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "ANCHORED", otsVerification: "ATTESTATION_RECORDED", otsProofSha256: UP.proofSha256 } });
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED })).outcome).toBe("requested");
    expect(h.requests).toHaveLength(1);
  });

  it("a report that stated a verification of ANOTHER block (reorg) or ANOTHER proof is not this verification", async () => {
    const v = { proofSha256: UP.proofSha256, blockHash: BLOCK };
    expect(reportStatedChainVerification(STATED_VERIFIED, v)).toBe(true);
    expect(reportStatedChainVerification({ ...STATED_VERIFIED, otsChainBlockHash: "ab".repeat(32) }, v)).toBe(false);
    expect(reportStatedChainVerification({ ...STATED_VERIFIED, otsProofSha256: "cd".repeat(32) }, v)).toBe(false);
    expect(reportStatedChainVerification({ ...STATED_VERIFIED, otsVerification: "ATTESTATION_RECORDED" }, v)).toBe(false);
    h.reports.push({ version: 2, anchorSnapshot: { ...STATED_VERIFIED, otsChainBlockHash: "ab".repeat(32) } });
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED })).outcome).toBe("requested");
  });

  it("THE RACE: verified before v1 → no request; v1 itself states the verification", async () => {
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED })).outcome).toBe("no_report_yet");
    h.reports.push({ version: 1, anchorSnapshot: STATED_VERIFIED });
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED })).outcome).toBe("latest_report_chain_verified");
    expect(h.requests).toEqual([]);
  });

  it("THE RACE, other side: a v1 in flight defers; when it commits stating PENDING the hook requests v2 once", async () => {
    h.requests.push({ id: "v1-req", evidenceId: "ev-1", clientRequestKey: null, artifactType: "REPORT", state: "PROCESSING" });
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } });
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED })).outcome).toBe("report_in_flight");
    h.requests[0]!.state = "SUCCEEDED";
    h.row = VERIFIED_ROW;
    expect((await reconcileOtsAnchoredReportVersion("ev-1")).outcome).toBe("requested");
    expect(h.requests.filter((r) => r.clientRequestKey)).toHaveLength(1);
  });

  it("a legacy report without a stated state is eligible once", async () => {
    h.reports.push({ version: 3, anchorSnapshot: { mode: "off" } });
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED })).outcome).toBe("requested");
  });

  it("never for a proof that is not ANCHORED, never from a status label, never from a chain record about another proof", async () => {
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } });
    const pending = resolveRecordOtsAnchoring({ otsStatus: "PENDING", otsProofBase64: REAL.boundProofBase64, otsHash: FP, fingerprintHash: FP });
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: pending })).outcome).toBe("not_chain_verified");
    // An ANCHORED label (and a VERIFIED chain row) over a proof with no Bitcoin attestation.
    h.row = { otsStatus: "ANCHORED", otsProofBase64: REAL.boundProofBase64, otsHash: FP, fingerprintHash: FP, ...CHAIN };
    expect((await reconcileOtsAnchoredReportVersion("ev-1")).outcome).toBe("not_chain_verified");
    // A VERIFIED chain record whose verifier names another proof.
    h.row = { ...ATTESTED_ROW, ...chainColumnsFor(UP, { proofSha256: "f".repeat(64) }) };
    expect((await reconcileOtsAnchoredReportVersion("ev-1")).outcome).toBe("not_chain_verified");
    expect(h.requests).toEqual([]);
  });

  it("a dry run decides and writes nothing", async () => {
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } });
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: VERIFIED, dryRun: true })).outcome).toBe("requested");
    expect(h.requests).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  it("the key is per proof AND block, lower-cased", () => {
    const key = otsChainVerifiedRequestKey(UP.proofSha256.toUpperCase(), BLOCK.toUpperCase());
    expect(key).toBe(`ots-chain-verified:${UP.proofSha256.slice(0, 30)}:${BLOCK.slice(-30)}`);
    // The key is stored WHOLE: report_generation_requests.client_request_key is
    // VARCHAR(80) and createReportGenerationRequest truncates at 80.
    expect(key.length).toBeLessThanOrEqual(80);
    expect(key.trim().slice(0, 80)).toBe(key);
    // Another block for the same proof is another key — even for mainnet-shaped
    // hashes that share a long leading run of zeros.
    const mainnetA = "0".repeat(19) + "1".repeat(45);
    const mainnetB = "0".repeat(19) + "1".repeat(44) + "2";
    expect(otsChainVerifiedRequestKey(UP.proofSha256, mainnetA)).not.toBe(otsChainVerifiedRequestKey(UP.proofSha256, mainnetB));
    expect(otsChainVerifiedRequestKey(UP.proofSha256, "ab".repeat(32))).not.toBe(key);
  });
});
