/**
 * FREE per-record output authority — the worker's artifact gates answer only
 * per record.
 *
 * `assertWorkspaceAllowsReportArtifact` / `...VerificationPackageArtifact` fell
 * back to `resolveEvidenceOutputEntitlements({ plan, funding: "PLAN" })` when no
 * evidenceId was passed — a plan-only answer to a per-record question, and
 * FREE's plan row includes reports. A gate call without a record is now
 * refused, and never reaches a plan-only decision.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const issuance = vi.fn();

vi.mock("../src/db.js", () => ({
  prisma: {
    entitlement: { findFirst: vi.fn(async () => ({ plan: "FREE", credits: 0, teamSeats: 0 })) },
    planGrant: { findFirst: vi.fn(async () => null) },
    workspaceStorageAddon: { aggregate: vi.fn(async () => ({ _sum: { extraStorageBytes: null } })) },
    team: { findUnique: vi.fn(async () => null) },
    enterpriseContract: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("../src/output-issuance.js", () => ({
  resolveEvidenceOutputIssuance: (...args: unknown[]) => issuance(...args),
}));

const { assertWorkspaceAllowsReportArtifact, assertWorkspaceAllowsVerificationPackageArtifact } =
  await import("../src/workspace-billing.js");

const OWNER = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  issuance.mockReset();
});

describe("artifact gates require the evidence record", () => {
  for (const [name, gate] of [
    ["report", assertWorkspaceAllowsReportArtifact],
    ["verification package", assertWorkspaceAllowsVerificationPackageArtifact],
  ] as const) {
    it(`${name}: no evidenceId → refused OUTPUT_ELIGIBILITY_UNRESOLVED, no plan-only answer`, async () => {
      for (const evidenceId of [undefined, null, "", "  "]) {
        await expect(
          gate({ ownerUserId: OWNER, teamId: null, evidenceId: evidenceId as unknown as string }),
        ).rejects.toMatchObject({ code: "OUTPUT_ELIGIBILITY_UNRESOLVED", statusCode: 409 });
      }
      expect(issuance).not.toHaveBeenCalled();
    });

    it(`${name}: with a record, the per-record issuance decides (a FREE record outside its allowance is refused)`, async () => {
      issuance.mockResolvedValue({ reportsIncluded: false, verificationPackageIncluded: false });
      await expect(
        gate({ ownerUserId: OWNER, teamId: null, evidenceId: "ev-1" }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(issuance).toHaveBeenCalledWith({ id: "ev-1", ownerUserId: OWNER, teamId: null });
    });
  }
});
