/**
 * THE ONE ISSUANCE DECISION (2026-09-29) — the policy table, pinned.
 *
 * `resolveOutputIssuanceEntitlement` (@proovra/shared-billing) is what every
 * producer and gate asks: finalization, first-issuance reconciliation,
 * recovery, Operations and the worker. A change to a row here is a product
 * policy change and must be made on purpose.
 */
import { describe, expect, it } from "vitest";
import {
  outputEarnedFactFromDecision,
  readOutputEarnedFact,
  resolveEvidenceCreationPlan,
  resolveOutputIssuanceEntitlement,
} from "@proovra/shared-billing";

const lc = (state: string, providerStatus: string | null = "ACTIVE") =>
  ({ state, providerStatus }) as Parameters<typeof resolveOutputIssuanceEntitlement>[0]["lifecycle"];

describe("resolveOutputIssuanceEntitlement", () => {
  it("a credit-funded record is entitled and may be issued historically, whatever the plan", () => {
    const d = resolveOutputIssuanceEntitlement({ plan: "FREE", funding: "EVIDENCE_CREDIT", lifecycle: null });
    expect(d).toMatchObject({ decision: "ENTITLED", basis: "EVIDENCE_CREDIT", mayIssueHistoricalFirstOutputs: true });
  });

  it("Free: original evidence only — nothing issued, not a failure", () => {
    const d = resolveOutputIssuanceEntitlement({ plan: "FREE", funding: "PLAN", lifecycle: lc("INACTIVE", null) });
    expect(d).toMatchObject({ decision: "NOT_ENTITLED", basis: "FREE_PLAN", reportsIncluded: false });
  });

  it("confirmed paid subscription: entitled AND schedules first issuance for earlier records", () => {
    const d = resolveOutputIssuanceEntitlement({ plan: "PRO", funding: "PLAN", lifecycle: lc("ACTIVE", "ACTIVE") });
    expect(d).toMatchObject({ decision: "ENTITLED", basis: "PAID_SUBSCRIPTION", mayIssueHistoricalFirstOutputs: true });
  });

  it("cancelled but inside the paid period still counts as paid", () => {
    const d = resolveOutputIssuanceEntitlement({ plan: "PRO", funding: "PLAN", lifecycle: lc("ACTIVE", "CANCELED") });
    expect(d.basis).toBe("PAID_SUBSCRIPTION");
  });

  it("trial and past-due grace: new records yes, historical first issuance no", () => {
    for (const [state, status, basis] of [
      ["ACTIVE", "TRIALING", "TRIAL"],
      ["GRACE", "PAST_DUE", "PAYMENT_GRACE"],
    ] as const) {
      const d = resolveOutputIssuanceEntitlement({ plan: "PRO", funding: "PLAN", lifecycle: lc(state, status) });
      expect(d).toMatchObject({ decision: "ENTITLED", basis, mayIssueHistoricalFirstOutputs: false });
    }
  });

  it("past due beyond grace, or ended: nothing new is issued", () => {
    expect(
      resolveOutputIssuanceEntitlement({ plan: "PRO", funding: "PLAN", lifecycle: lc("PAST_DUE_EXPIRED", "PAST_DUE") }),
    ).toMatchObject({ decision: "NOT_ENTITLED", basis: "PAYMENT_LAPSED" });
    expect(
      resolveOutputIssuanceEntitlement({ plan: "PRO", funding: "PLAN", lifecycle: lc("CANCELLED", "CANCELED") }),
    ).toMatchObject({ decision: "NOT_ENTITLED", basis: "SUBSCRIPTION_ENDED" });
  });

  it("an unreadable plan, funding or lifecycle is UNRESOLVED — never FREE, never paid", () => {
    for (const input of [
      { plan: null, funding: "PLAN" as const, lifecycle: lc("ACTIVE") },
      { plan: "PRO" as const, funding: null, lifecycle: lc("ACTIVE") },
      { plan: "PRO" as const, funding: "PLAN" as const, lifecycle: null },
      // A paid plan with an INACTIVE lifecycle is contradictory input.
      { plan: "PRO" as const, funding: "PLAN" as const, lifecycle: lc("INACTIVE", null) },
    ]) {
      const d = resolveOutputIssuanceEntitlement(input as never);
      expect(d.decision).toBe("UNRESOLVED");
      expect(d.reportsIncluded).toBe(false);
      expect(d.mayIssueHistoricalFirstOutputs).toBe(false);
    }
  });
});

/**
 * ET-COM-04 (owner decision 2026-09-30) — a billing lapse is not a revocation,
 * and not a lockout.
 */
describe("the stored funding fact and the lapsed creation plan (ET-COM-04)", () => {
  it("a record that earned its outputs at finalization keeps them through a lapse or an ended subscription", () => {
    for (const lifecycle of [lc("PAST_DUE_EXPIRED", "PAST_DUE"), lc("CANCELLED", "CANCELED"), null]) {
      const d = resolveOutputIssuanceEntitlement({
        plan: "PRO",
        funding: "PLAN",
        lifecycle,
        earned: { plan: "PRO", basis: "PAID_SUBSCRIPTION" },
      });
      expect(d).toMatchObject({
        decision: "ENTITLED",
        basis: "EARNED_AT_FINALIZATION",
        reportsIncluded: true,
        verificationPackageIncluded: true,
        mayIssueHistoricalFirstOutputs: true,
      });
    }
  });

  it("the fact survives the account's plan being rewritten to FREE", () => {
    const d = resolveOutputIssuanceEntitlement({
      plan: "FREE",
      funding: "PLAN",
      lifecycle: lc("INACTIVE", null),
      earned: { plan: "PRO", basis: "PAID_SUBSCRIPTION" },
    });
    expect(d).toMatchObject({ decision: "ENTITLED", basis: "EARNED_AT_FINALIZATION" });
  });

  it("no fact, or a fact on a plan that includes no outputs, changes nothing", () => {
    expect(
      resolveOutputIssuanceEntitlement({ plan: "PRO", funding: "PLAN", lifecycle: lc("PAST_DUE_EXPIRED", "PAST_DUE"), earned: null }),
    ).toMatchObject({ decision: "NOT_ENTITLED", basis: "PAYMENT_LAPSED" });
    expect(
      resolveOutputIssuanceEntitlement({
        plan: "PRO",
        funding: "PLAN",
        lifecycle: lc("PAST_DUE_EXPIRED", "PAST_DUE"),
        earned: { plan: "FREE", basis: "PAID_SUBSCRIPTION" },
      }),
    ).toMatchObject({ decision: "NOT_ENTITLED", basis: "PAYMENT_LAPSED" });
  });

  it("only an ENTITLED plan-basis decision is stored; FREE, lapsed, unresolved and credit decisions store nothing", () => {
    const store = (plan: "PRO" | "FREE", lifecycle: ReturnType<typeof lc>, funding: "PLAN" | "EVIDENCE_CREDIT" = "PLAN") =>
      outputEarnedFactFromDecision({ plan, decision: resolveOutputIssuanceEntitlement({ plan, funding, lifecycle }) });
    expect(store("PRO", lc("ACTIVE", "ACTIVE"))).toEqual({ plan: "PRO", basis: "PAID_SUBSCRIPTION" });
    expect(store("PRO", lc("ACTIVE", "TRIALING"))).toEqual({ plan: "PRO", basis: "TRIAL" });
    expect(store("PRO", lc("GRACE", "PAST_DUE"))).toEqual({ plan: "PRO", basis: "PAYMENT_GRACE" });
    expect(store("PRO", lc("PAST_DUE_EXPIRED", "PAST_DUE"))).toBeNull();
    expect(store("PRO", null)).toBeNull();
    expect(store("FREE", lc("INACTIVE", null))).toBeNull();
    // A credit-funded record's fact is its ledger row, not this column.
    expect(store("FREE", lc("INACTIVE", null), "EVIDENCE_CREDIT")).toBeNull();
  });

  it("stored columns written by anything but the completion path are not a fact", () => {
    expect(readOutputEarnedFact(null)).toBeNull();
    expect(readOutputEarnedFact({ outputEarnedPlan: "PRO", outputEarnedBasis: null })).toBeNull();
    expect(readOutputEarnedFact({ outputEarnedPlan: "PRO", outputEarnedBasis: "EVIDENCE_CREDIT" })).toBeNull();
    expect(readOutputEarnedFact({ outputEarnedPlan: "PRO", outputEarnedBasis: "PAID_SUBSCRIPTION" })).toEqual({
      plan: "PRO",
      basis: "PAID_SUBSCRIPTION",
    });
  });

  it("a lapsed personal plan creates on the FREE policy; a lapsed shared workspace has none; nothing else changes", () => {
    expect(resolveEvidenceCreationPlan({ plan: "PRO", billingShape: "SINGLE_OCCUPANT", lifecycleAllowsPaidMutations: false })).toEqual({
      lapsed: true,
      creationPlan: "FREE",
      lapsedPlan: "PRO",
    });
    expect(resolveEvidenceCreationPlan({ plan: "TEAM", billingShape: "SHARED", lifecycleAllowsPaidMutations: false })).toEqual({
      lapsed: true,
      creationPlan: null,
      lapsedPlan: "TEAM",
    });
    for (const allows of [true, undefined]) {
      expect(
        resolveEvidenceCreationPlan({ plan: "PRO", billingShape: "SINGLE_OCCUPANT", lifecycleAllowsPaidMutations: allows }),
      ).toEqual({ lapsed: false, creationPlan: "PRO" });
    }
    expect(resolveEvidenceCreationPlan({ plan: "FREE", billingShape: "SINGLE_OCCUPANT", lifecycleAllowsPaidMutations: false })).toEqual({
      lapsed: false,
      creationPlan: "FREE",
    });
  });
});
