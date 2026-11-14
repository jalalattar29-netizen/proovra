/**
 * A FAILED FUNDING READ IS UNRESOLVED, NOT PLAN (2026-09-29).
 *
 * The API defaulted a failed credit-ledger read to PLAN, so a credit-funded
 * record on a FREE account read "not included" whenever the ledger could not
 * be read, while the worker answered UNRESOLVED and retried. Unknown is
 * neither a paid activation nor a permanent refusal — for the single and the
 * page resolver alike. A readable ledger keeps its answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  fail: false,
  funding: "PLAN" as "PLAN" | "EVIDENCE_CREDIT",
  earnedFail: false,
  earned: [] as Array<{ id: string; outputEarnedPlan: string; outputEarnedBasis: string }>,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    subscription: { findMany: async () => [], findFirst: async () => null },
    // ET-COM-04 — the stored earned facts (F-09: a failed read is UNRESOLVED).
    evidence: {
      findMany: async () => {
        if (h.earnedFail) throw new Error("evidence read failed");
        return h.earned;
      },
    },
  },
}));
vi.mock("../src/services/billing/commercial-context.service.js", () => ({
  resolveCommercialPlan: async () => ({ plan: "FREE", ownerUserId: "u1", billingShape: "SINGLE_OCCUPANT" }),
}));
vi.mock("../src/services/billing/evidence-credits.service.js", () => ({
  resolveEvidenceFunding: async () => {
    if (h.fail) throw new Error("ledger unavailable");
    return h.funding;
  },
  resolveEvidenceFundingMany: async (ids: readonly string[]) => {
    if (h.fail) throw new Error("ledger unavailable");
    return new Map(ids.map((id) => [id, h.funding]));
  },
}));

const svc = await import("../src/services/billing/evidence-output-eligibility.service.js");

beforeEach(() => {
  h.fail = false;
  h.funding = "PLAN";
  h.earnedFail = false;
  h.earned = [];
});

describe("output eligibility when the funding ledger cannot be read", () => {
  it("single record: UNRESOLVED, not NOT_INCLUDED", async () => {
    h.fail = true;
    const e = await svc.resolveEvidenceOutputEligibility({ evidenceId: "ev1", ownerUserId: "u1", teamId: "t1" });
    expect(e.reportEligibility).toBe("UNRESOLVED");
    expect(e.packageEligibility).toBe("UNRESOLVED");
    expect(e.funding).toBeNull();
  });

  it("a page: every record UNRESOLVED", async () => {
    h.fail = true;
    const m = await svc.resolveEvidenceOutputEligibilityMany({ evidenceIds: ["a", "b"], ownerUserId: "u1", teamId: "t1" });
    expect([...m.values()].map((e) => e.reportEligibility)).toEqual(["UNRESOLVED", "UNRESOLVED"]);
  });

  it("a readable ledger keeps its answer: a credit-funded record on FREE is included", async () => {
    h.funding = "EVIDENCE_CREDIT";
    const e = await svc.resolveEvidenceOutputEligibility({ evidenceId: "ev1", ownerUserId: "u1", teamId: "t1" });
    expect(e.reportEligibility).toBe("ELIGIBLE");
    expect(e.funding).toBe("EVIDENCE_CREDIT");
  });

  it("a readable ledger with no consumption is PLAN: FREE stays not included", async () => {
    const e = await svc.resolveEvidenceOutputEligibility({ evidenceId: "ev1", ownerUserId: "u1", teamId: "t1" });
    expect(e.reportEligibility).toBe("NOT_INCLUDED");
    expect(e.funding).toBe("PLAN");
  });
});

/**
 * F-09 (2026-11-13) — A FAILED EARNED-FACT READ IS UNRESOLVED, NOT "NOT
 * INCLUDED". For a FREE allowance record the stored fact IS the entitlement;
 * reading its failure as "no fact" told the owner the plan does not include a
 * report the record had earned, with a pricing link.
 */
describe("output eligibility when the stored earned fact cannot be read", () => {
  it("a FREE allowance record: ELIGIBLE with its fact, UNRESOLVED (not NOT_INCLUDED) when the read fails", async () => {
    h.earned = [{ id: "ev1", outputEarnedPlan: "FREE", outputEarnedBasis: "FREE_ALLOWANCE" }];
    const earned = await svc.resolveEvidenceOutputEligibility({ evidenceId: "ev1", ownerUserId: "u1", teamId: "t1" });
    expect(earned.reportEligibility).toBe("ELIGIBLE");
    h.earnedFail = true;
    const unread = await svc.resolveEvidenceOutputEligibility({ evidenceId: "ev1", ownerUserId: "u1", teamId: "t1" });
    expect(unread.reportEligibility).toBe("UNRESOLVED");
    expect(unread.ineligibilityReason).toBe("ENTITLEMENT_UNRESOLVED");
    expect(unread.plan).toBe("FREE");
  });

  it("a page: every record UNRESOLVED when the facts cannot be read", async () => {
    h.earnedFail = true;
    const m = await svc.resolveEvidenceOutputEligibilityMany({ evidenceIds: ["a", "b"], ownerUserId: "u1", teamId: "t1" });
    expect([...m.values()].map((e) => e.reportEligibility)).toEqual(["UNRESOLVED", "UNRESOLVED"]);
  });

  it("a credit-funded record is still answered by its ledger row", async () => {
    h.earnedFail = true;
    h.funding = "EVIDENCE_CREDIT";
    const e = await svc.resolveEvidenceOutputEligibility({ evidenceId: "ev1", ownerUserId: "u1", teamId: "t1" });
    expect(e.reportEligibility).toBe("ELIGIBLE");
  });
});
