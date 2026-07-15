/**
 * Secure-intake plan gate (2026-07-15) — P0. Intake links + submission
 * requests are excluded from FREE per the published Pricing contract
 * (PLAN_CAPABILITIES.intakeIncluded). This proves the CREATION-boundary
 * guard denies FREE/PAYG-excluded plans with the stable code before any
 * DB write, and allows PAYG+ (the canonical commercial values).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/services/internal-testers.js", () => ({
  isInternalUnlimitedTester: () => false,
}));

import { assertWorkspaceAllowsIntake } from "../src/services/billing-enforcement.service.js";
import { getPlanCapabilities } from "@proovra/shared-billing";

function scope(plan: "FREE" | "PAYG" | "PRO" | "TEAM" | "ENTERPRISE") {
  return {
    plan,
    authenticatedUserEmail: "u@example.com",
  } as unknown as Parameters<typeof assertWorkspaceAllowsIntake>[0];
}

describe("assertWorkspaceAllowsIntake — commercial contract", () => {
  it("FREE is denied with 409 INTAKE_NOT_INCLUDED", async () => {
    expect(getPlanCapabilities("FREE").intakeIncluded).toBe(false);
    await expect(assertWorkspaceAllowsIntake(scope("FREE"))).rejects.toMatchObject({
      code: "INTAKE_NOT_INCLUDED",
      statusCode: 409,
    });
  });

  it("PAYG / PRO / TEAM / ENTERPRISE are allowed (canonical values)", async () => {
    for (const p of ["PAYG", "PRO", "TEAM", "ENTERPRISE"] as const) {
      expect(getPlanCapabilities(p).intakeIncluded).toBe(true);
      await expect(assertWorkspaceAllowsIntake(scope(p))).resolves.toBeUndefined();
    }
  });

  it("the published pricing matrix is encoded exactly", () => {
    const m = (p: "FREE" | "PAYG" | "PRO" | "TEAM" | "ENTERPRISE") =>
      getPlanCapabilities(p);
    expect([m("FREE"), m("PAYG"), m("PRO"), m("TEAM"), m("ENTERPRISE")].map((c) => c.intakeIncluded))
      .toEqual([false, true, true, true, true]);
    expect(["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"].map((p) => m(p as never).casesIncluded))
      .toEqual([false, false, true, true, true]);
    expect(["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"].map((p) => m(p as never).reviewerOperationsIncluded))
      .toEqual([false, false, false, true, true]);
  });
});
