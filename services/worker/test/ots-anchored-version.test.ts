/**
 * ONE AUTOMATIC REPORT VERSION WHEN A PROOF BECOMES ANCHORED (2026-10-13).
 *
 * The decision is run against an in-memory store whose request table enforces
 * the real idempotency (clientRequestKey per evidence). Covered: PENDING v1 →
 * ANCHORED requests exactly one v2; ANCHORED before v1 requests nothing;
 * duplicate deliveries, the reconcile script and the post-commit hook collapse
 * onto the one request; a report in flight defers; no charge path exists.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  reports: [] as Array<{ version: number; anchorSnapshot: unknown }>,
  requests: [] as Array<{ id: string; evidenceId: string; clientRequestKey: string | null; artifactType: string; state: string; purpose?: string; forceRegenerate?: boolean; intent?: string; requestedByMachineId?: string }>,
  enqueued: [] as string[],
  row: null as Record<string, unknown> | null,
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
    },
    evidence: { findUnique: async () => (h.row ? { ...h.row } : null) },
  },
}));

vi.mock("@proovra/shared-runtime/reports", () => ({
  createReportGenerationRequest: async (_p: unknown, input: Record<string, unknown>) => {
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

const { ensureOtsAnchoredReportVersion, otsAnchoredRequestKey, reconcileOtsAnchoredReportVersion, reportStatedOtsState } = await import(
  "../src/ots-anchored-version.js"
);

const UP = upgradedProof();
const ANCHORED = { state: "ANCHORED" as const, proofSha256: UP.proofSha256 };

beforeEach(() => {
  h.reports.length = 0;
  h.requests.length = 0;
  h.enqueued.length = 0;
  h.row = null;
});

describe("the automatic version decision", () => {
  it("v1 stated PENDING; the proof anchors → exactly one forced NEW_VERSION request, by a machine, enqueued", async () => {
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } });
    const r = await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: ANCHORED });
    expect(r.outcome).toBe("requested");
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      purpose: "ots_upgrade_completed",
      artifactType: "REPORT",
      intent: "NEW_VERSION",
      forceRegenerate: true,
      clientRequestKey: otsAnchoredRequestKey(UP.proofSha256),
      requestedByMachineId: "worker.ots-anchored",
    });
    expect(h.enqueued).toEqual([h.requests[0]!.id]);
  });

  it("is idempotent: duplicate deliveries, the reconcile script and the commit hook collapse onto the one request", async () => {
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } });
    h.row = { otsStatus: "ANCHORED", otsProofBase64: UP.base64, otsHash: REAL.boundFingerprintHash, fingerprintHash: REAL.boundFingerprintHash };
    await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: ANCHORED });
    // The request has run and finished: still collapses on the key.
    h.requests[0]!.state = "SUCCEEDED";
    const again = await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: ANCHORED });
    const viaReconcile = await reconcileOtsAnchoredReportVersion("ev-1");
    expect(again.outcome).toBe("already_requested");
    expect(viaReconcile.outcome).toBe("already_requested");
    expect(h.requests).toHaveLength(1);
    expect(h.enqueued).toHaveLength(1);
  });

  it("once v2 stated ANCHORED nothing more is requested (previous versions untouched)", async () => {
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } }, { version: 2, anchorSnapshot: { otsState: "ANCHORED" } });
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: ANCHORED })).outcome).toBe("latest_report_anchored");
    expect(h.requests).toEqual([]);
  });

  it("THE RACE: anchored before v1 → no request; v1 itself states ANCHORED", async () => {
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: ANCHORED })).outcome).toBe("no_report_yet");
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "ANCHORED" } });
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: ANCHORED })).outcome).toBe("latest_report_anchored");
    expect(h.requests).toEqual([]);
  });

  it("THE RACE, other side: a v1 in flight defers; when it commits stating PENDING the hook requests v2 once", async () => {
    h.requests.push({ id: "v1-req", evidenceId: "ev-1", clientRequestKey: null, artifactType: "REPORT", state: "PROCESSING" });
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } });
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: ANCHORED })).outcome).toBe("report_in_flight");
    h.requests[0]!.state = "SUCCEEDED";
    h.row = { otsStatus: "ANCHORED", otsProofBase64: UP.base64, otsHash: REAL.boundFingerprintHash, fingerprintHash: REAL.boundFingerprintHash };
    expect((await reconcileOtsAnchoredReportVersion("ev-1")).outcome).toBe("requested");
    expect(h.requests.filter((r) => r.clientRequestKey)).toHaveLength(1);
  });

  it("a legacy report without a stated state is eligible once", async () => {
    h.reports.push({ version: 3, anchorSnapshot: { mode: "off" } });
    expect(reportStatedOtsState({ mode: "off" })).toBeNull();
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: ANCHORED })).outcome).toBe("requested");
  });

  it("never for a proof that is not ANCHORED, and never from a status label", async () => {
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } });
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: { state: "PENDING", proofSha256: "x" } })).outcome).toBe("not_anchored");
    h.row = { otsStatus: "ANCHORED", otsProofBase64: REAL.boundProofBase64, otsHash: REAL.boundFingerprintHash, fingerprintHash: REAL.boundFingerprintHash };
    expect((await reconcileOtsAnchoredReportVersion("ev-1")).outcome).toBe("not_anchored");
    expect(h.requests).toEqual([]);
  });

  it("a dry run decides and writes nothing", async () => {
    h.reports.push({ version: 1, anchorSnapshot: { otsState: "PENDING" } });
    expect((await ensureOtsAnchoredReportVersion({ evidenceId: "ev-1", anchoring: ANCHORED, dryRun: true })).outcome).toBe("requested");
    expect(h.requests).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  it("the key is per proof and bounded", () => {
    const key = otsAnchoredRequestKey(UP.proofSha256.toUpperCase());
    expect(key).toBe(`ots-anchored:${UP.proofSha256}`);
    expect(key.length).toBeLessThanOrEqual(80);
  });
});
