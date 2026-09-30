/**
 * ET-PKG-08 — the package eligibility gate runs for EVERY package.
 *
 * It ran only when data.teamId was set AND isPersonalTeam === false, so a
 * Personal record — and any record whose workspace row was not loaded
 * (isPersonalTeam null) — skipped the lifecycle, pending-destruction and
 * immutable-drift checks, none of which is a team concept.
 *
 * The gate and the signer guard are doubles at their module boundaries: the
 * test asserts WHO is gated, not what the gate decides.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gateCalls = vi.hoisted(() => [] as Array<{ teamId: string | null; evidenceId: string }>);

vi.mock("../src/signing/signer-control-guard.js", () => ({
  assertWorkerSignerUsable: async () => undefined,
}));
vi.mock("../src/governance/package-eligibility-gate.js", () => ({
  assertPackageEligibleOrDeny: async (input: { teamId: string | null; evidenceId: string }) => {
    gateCalls.push({ teamId: input.teamId, evidenceId: input.evidenceId });
    return { allowed: false, outcome: "BLOCKED_BY_LIFECYCLE", reason: "pending_destruction", label: "blocked" };
  },
}));

const { createVerificationPackage, PackageGateDeniedError } = await import("../src/verification-package.js");

beforeEach(() => {
  gateCalls.length = 0;
});

const minimal = (over: Record<string, unknown>) =>
  createVerificationPackage({ evidenceId: "ev-1", ...over } as never);

describe("the package eligibility gate runs for every package (ET-PKG-08)", () => {
  it("a Personal workspace record is gated", async () => {
    await expect(minimal({ teamId: "team-personal", isPersonalTeam: true })).rejects.toBeInstanceOf(PackageGateDeniedError);
    expect(gateCalls).toEqual([{ teamId: "team-personal", evidenceId: "ev-1" }]);
  });

  it("a legacy Personal record with no workspace row is gated by its own row", async () => {
    await expect(minimal({ teamId: null, isPersonalTeam: null })).rejects.toBeInstanceOf(PackageGateDeniedError);
    expect(gateCalls).toEqual([{ teamId: null, evidenceId: "ev-1" }]);
  });

  it("a workspace whose kind was not resolved is denied without building (fail closed)", async () => {
    await expect(minimal({ teamId: "team-x", isPersonalTeam: null })).rejects.toMatchObject({
      outcome: "GOVERNANCE_STATE_UNAVAILABLE",
      reason: "workspace_kind_unresolved",
    });
  });

  it("a team workspace record is gated, as before", async () => {
    await expect(minimal({ teamId: "team-t", isPersonalTeam: false })).rejects.toBeInstanceOf(PackageGateDeniedError);
    expect(gateCalls).toEqual([{ teamId: "team-t", evidenceId: "ev-1" }]);
  });
});
