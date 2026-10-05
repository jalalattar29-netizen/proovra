/**
 * INTERNAL PLAN GRANT — the effective-plan precedence (pure, DB-free).
 *
 * The PERSONAL subject resolves to the HIGHER of the provider-derived plan and
 * an active internal grant; the source says INTERNAL_GRANT only when the grant
 * is what lifts the account. Every other workspace kind ignores a personal
 * grant, exactly as it ignores the owner's personal plan.
 */
import { describe, expect, it } from "vitest";

import {
  PLAN_RANK,
  resolvePersonalEffectivePlan,
  resolveWorkspaceEffectivePlan,
} from "@proovra/shared-billing";
import { internalGrantCoversPlan } from "@proovra/shared-runtime";

describe("internal plan grant — effective-plan precedence", () => {
  it("no grant → the provider plan (FREE stays FREE)", () => {
    expect(resolvePersonalEffectivePlan({ providerPlan: "FREE", internalGrantPlan: null })).toEqual({
      plan: "FREE",
      source: "PERSONAL_ENTITLEMENT",
    });
  });

  it("a TEAM grant over FREE / PAYG / PRO → TEAM, source INTERNAL_GRANT", () => {
    for (const providerPlan of ["FREE", "PAYG", "PRO"] as const) {
      expect(resolvePersonalEffectivePlan({ providerPlan, internalGrantPlan: "TEAM" })).toEqual({
        plan: "TEAM",
        source: "INTERNAL_GRANT",
      });
    }
  });

  it("a grant never lowers a higher or equal provider plan; the provider governs the tie", () => {
    expect(resolvePersonalEffectivePlan({ providerPlan: "TEAM", internalGrantPlan: "TEAM" }).source).toBe("PERSONAL_ENTITLEMENT");
    expect(resolvePersonalEffectivePlan({ providerPlan: "ENTERPRISE", internalGrantPlan: "TEAM" })).toEqual({
      plan: "ENTERPRISE",
      source: "PERSONAL_ENTITLEMENT",
    });
    expect(resolvePersonalEffectivePlan({ providerPlan: "TEAM", internalGrantPlan: "PRO" }).plan).toBe("TEAM");
  });

  it("the workspace policy applies a grant to the PERSONAL kind only", () => {
    const inputs = { billingPlan: "FREE" as const, billingStatus: "INACTIVE" as const, ownerPlan: "FREE" as const, internalGrantPlan: "TEAM" as const };
    expect(resolveWorkspaceEffectivePlan({ ...inputs, workspaceKind: "PERSONAL" })).toEqual({ plan: "TEAM", source: "INTERNAL_GRANT" });
    expect(resolveWorkspaceEffectivePlan({ ...inputs, workspaceKind: "OWNED" }).plan).toBe("FREE");
    expect(resolveWorkspaceEffectivePlan({ ...inputs, workspaceKind: "ORGANIZATION" }).plan).toBe("FREE");
    expect(resolveWorkspaceEffectivePlan({ ...inputs, workspaceKind: "UNKNOWN" }).plan).toBe("FREE");
    // Omitting the grant is exactly the pre-grant behaviour.
    expect(resolveWorkspaceEffectivePlan({ ...inputs, internalGrantPlan: undefined, workspaceKind: "PERSONAL" })).toEqual({
      plan: "FREE",
      source: "PERSONAL_ENTITLEMENT",
    });
  });

  it("the lifecycle's coverage order agrees with PLAN_RANK", () => {
    const plans = ["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"] as const;
    for (const g of plans) {
      for (const p of plans) {
        expect(internalGrantCoversPlan(g, p), `${g} covers ${p}`).toBe(PLAN_RANK[g] >= PLAN_RANK[p]);
      }
    }
  });
});
