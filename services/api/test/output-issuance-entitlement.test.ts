/**
 * THE ONE ISSUANCE DECISION (2026-09-29) — the policy table, pinned.
 *
 * `resolveOutputIssuanceEntitlement` (@proovra/shared-billing) is what every
 * producer and gate asks: finalization, first-issuance reconciliation,
 * recovery, Operations and the worker. A change to a row here is a product
 * policy change and must be made on purpose.
 */
import { describe, expect, it } from "vitest";
import { resolveOutputIssuanceEntitlement } from "@proovra/shared-billing";

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
