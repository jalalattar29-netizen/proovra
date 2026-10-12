/**
 * VERIFICATION-PACKAGE DOWNLOADS FAIL CLOSED WHEN THE VERIFICATION POLICY
 * CANNOT BE READ.
 *
 * `evaluateArtifactDownload` consults the governance VERIFICATION policy
 * (requireTrustReferences / blockedPublicExposure) before a package leaves.
 * A failed effective-policy read used to evaluate as "no policy" and the
 * package was released. It now answers 503 GOVERNANCE_CHECK_FAILED
 * (`verification_policy_unavailable`) — the same code the workspace
 * governance lookup above it already uses — and records the refusal.
 *
 * The REAL gate and evaluator run; only db reads and the unrelated
 * collaborators (access resolution, sensitive-action policy, eligibility) are
 * stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  policyReadFails: false,
  custody: [] as Array<{ eventType: unknown; payload: Record<string, unknown> }>,
  eligibilityCalls: 0,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    evidence: {
      findUnique: async () => ({ id: "ev-1", teamId: "team-1", ownerUserId: "owner-1", retentionUntilUtc: null }),
    },
    teamMember: {
      findUnique: async () => ({ role: "OWNER", status: "ACTIVE" }),
    },
    governancePolicyAssignment: {
      findMany: async () => {
        if (H.policyReadFails) throw new Error("INFRA_FAILURE:governancePolicyAssignment.findMany");
        return [];
      },
    },
    governancePolicyAudit: { create: async () => ({ id: "audit-1" }) },
    trustCenterArticle: { count: async () => 1 },
  },
}));
vi.mock("../src/services/evidence/evidence-record-access.service.js", () => ({
  resolveEvidenceRecordAccess: async () => ({ allowed: true }),
}));
vi.mock("../src/services/redaction/redaction-rbac.service.js", () => ({
  assertRedactionCapability: async () => ({ ok: true }),
}));
vi.mock("../src/services/custody-events.service.js", () => ({
  appendCustodyEvent: async (e: { eventType: unknown; payload: Record<string, unknown> }) => {
    H.custody.push({ eventType: e.eventType, payload: e.payload });
  },
}));
vi.mock("../src/services/governance.service.js", () => ({
  enforceSensitiveAction: async () => ({ allowed: true }),
}));
vi.mock("../src/services/governance-lifecycle/export-governance.service.js", () => ({
  checkExportEligibility: async () => {
    H.eligibilityCalls += 1;
    return { outcome: "ALLOWED", reason: null };
  },
}));

const { evaluateArtifactDownload } = await import(
  "../src/services/evidence/artifact-download-gate.service.js"
);

beforeEach(() => {
  H.policyReadFails = false;
  H.custody.length = 0;
  H.eligibilityCalls = 0;
});

const run = (kind: "package" | "package_external") =>
  evaluateArtifactDownload({
    evidenceId: "ev-1",
    actorUserId: "owner-1",
    kind,
    readAccess: async () => undefined,
  });

describe("verification policy read failure → 503 GOVERNANCE_CHECK_FAILED", () => {
  for (const kind of ["package", "package_external"] as const) {
    it(`${kind}: refused 503, reason verification_policy_unavailable, never released`, async () => {
      H.policyReadFails = true;
      const decision = await run(kind);
      expect(decision.allowed).toBe(false);
      if (decision.allowed) return;
      expect(decision.statusCode).toBe(503);
      expect(decision.body.code).toBe("GOVERNANCE_CHECK_FAILED");
      expect(decision.body.reason).toBe("verification_policy_unavailable");
      // The decision stopped at the gate: eligibility was never consulted.
      expect(H.eligibilityCalls).toBe(0);
      // The refusal is recorded like every other download denial.
      expect(H.custody).toHaveLength(1);
      expect(H.custody[0]!.payload.reason).toBe("verification_policy_unavailable");
    });
  }

  it("an empty policy set (nothing configured) is released (control)", async () => {
    const decision = await run("package");
    expect(decision.allowed).toBe(true);
    expect(H.eligibilityCalls).toBe(1);
  });
});
