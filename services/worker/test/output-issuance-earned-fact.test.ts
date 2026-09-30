/**
 * ET-COM-04 — the worker honours the record's stored funding fact.
 *
 * A report job queued while the plan was paid must still run after the plan
 * lapses: the record earned that output at finalization. Before this the
 * adapter read only the CURRENT lifecycle, so the generation claim refused
 * the job once the subscription was past due beyond grace.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const evidenceFindUnique = vi.fn();
const funding = vi.fn();
const scopeFor = vi.fn();
const lifecycle = vi.fn();

vi.mock("../src/db.js", () => ({
  prisma: { evidence: { findUnique: (...a: unknown[]) => evidenceFindUnique(...a) } },
}));
vi.mock("../src/workspace-billing.js", () => ({
  resolveEvidenceFundingSource: (...a: unknown[]) => funding(...a),
  resolveWorkspaceScopeForEvidence: (...a: unknown[]) => scopeFor(...a),
}));
vi.mock("@proovra/shared-runtime", () => ({
  readCommercialLifecycle: (...a: unknown[]) => lifecycle(...a),
}));

const { resolveEvidenceOutputIssuance } = await import("../src/output-issuance.js");

const RECORD = { id: "ev-1", ownerUserId: "u-1", teamId: "t-personal" };
const LAPSED = { state: "PAST_DUE_EXPIRED", providerStatus: "PAST_DUE" };

beforeEach(() => {
  vi.clearAllMocks();
  funding.mockResolvedValue("PLAN");
  scopeFor.mockResolvedValue({ plan: "PRO", billingShape: "SINGLE_OCCUPANT", ownerUserId: "u-1", teamId: "t-personal" });
  lifecycle.mockResolvedValue(LAPSED);
});

describe("resolveEvidenceOutputIssuance — the stored funding fact (ET-COM-04)", () => {
  it("a record finalized while the plan was paid is still entitled after the lapse", async () => {
    evidenceFindUnique.mockResolvedValue({ outputEarnedPlan: "PRO", outputEarnedBasis: "PAID_SUBSCRIPTION" });
    const d = await resolveEvidenceOutputIssuance(RECORD);
    expect(d).toMatchObject({
      decision: "ENTITLED",
      basis: "EARNED_AT_FINALIZATION",
      reportsIncluded: true,
      verificationPackageIncluded: true,
      mayIssueHistoricalFirstOutputs: true,
    });
    expect(evidenceFindUnique).toHaveBeenCalledWith({
      where: { id: "ev-1" },
      select: { outputEarnedPlan: true, outputEarnedBasis: true },
    });
  });

  it("a record with no stored fact follows the lapsed lifecycle: nothing new is issued", async () => {
    evidenceFindUnique.mockResolvedValue({ outputEarnedPlan: null, outputEarnedBasis: null });
    expect(await resolveEvidenceOutputIssuance(RECORD)).toMatchObject({
      decision: "NOT_ENTITLED",
      basis: "PAYMENT_LAPSED",
    });
  });

  it("an unreadable fact is no fact — the stricter current-lifecycle answer stands", async () => {
    evidenceFindUnique.mockRejectedValue(new Error("db down"));
    expect(await resolveEvidenceOutputIssuance(RECORD)).toMatchObject({
      decision: "NOT_ENTITLED",
      basis: "PAYMENT_LAPSED",
    });
  });

  it("the earned fact also survives an unreadable lifecycle (it would otherwise be UNRESOLVED)", async () => {
    evidenceFindUnique.mockResolvedValue({ outputEarnedPlan: "PRO", outputEarnedBasis: "PAID_SUBSCRIPTION" });
    lifecycle.mockRejectedValue(new Error("subscription read failed"));
    expect(await resolveEvidenceOutputIssuance(RECORD)).toMatchObject({
      decision: "ENTITLED",
      basis: "EARNED_AT_FINALIZATION",
    });
  });

  it("a credit-funded record never needs the fact", async () => {
    funding.mockResolvedValue("EVIDENCE_CREDIT");
    expect(await resolveEvidenceOutputIssuance(RECORD)).toMatchObject({ decision: "ENTITLED", basis: "EVIDENCE_CREDIT" });
    expect(evidenceFindUnique).not.toHaveBeenCalled();
  });
});
