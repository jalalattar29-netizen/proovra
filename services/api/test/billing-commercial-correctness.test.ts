/**
 * BILLING COMMERCIAL CORRECTNESS — Gate A.
 *
 * Pins the commercial contract that the redesign depends on:
 *   1. the evidence-credit wallet (PAYG) and its admission order;
 *   2. one quota authority for evidence records and storage;
 *   3. Owned Workspace / Collaboration Team / accepted-member separation;
 *   4. Enterprise contract limits actually governing;
 *   5. paid-record output entitlements.
 *
 * These are PURE-POLICY tests against the canonical authorities. The
 * database-bound behaviour (atomic consumption, per-record idempotency,
 * concurrency) is proven in `test/point7/plan-matrix.integration.test.ts`
 * against a real Postgres.
 */

import { describe, expect, it } from "vitest";

import {
  EVIDENCE_CREDIT_PRODUCT,
  PLAN_CAPABILITIES,
  getPlanCapabilities,
  resolveEvidenceOutputEntitlements,
  resolvePersonalEvidenceAdmission,
  type PlanType,
} from "@proovra/shared-billing";

import {
  NO_CONTRACT_LIMITS,
  resolveEffectiveBaseStorageBytes,
  resolveEffectiveContractAiCap,
  resolveEffectiveContractEvidenceCap,
  resolveEffectiveContractSeats,
  resolveEnterpriseContractLimits,
} from "../src/services/billing/enterprise-contract-limits.js";

const ALL_PLANS: PlanType[] = ["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"];
const GB = 1024n * 1024n * 1024n;
const MB = 1024n * 1024n;

// =============================================================================
// 1. The evidence-credit product and the admission order
// =============================================================================

describe("evidence credits — the PAYG contract", () => {
  it("is a credit product, not a plan: one purchase grants one completion", () => {
    expect(EVIDENCE_CREDIT_PRODUCT.productKey).toBe("EVIDENCE_CREDIT");
    expect(EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase).toBe(1);
    expect(EVIDENCE_CREDIT_PRODUCT.creditsPerCompletion).toBe(1);
    expect(EVIDENCE_CREDIT_PRODUCT.unitPriceCents).toBe(500);
    // Credits are explicitly non-expiring so nothing has to infer it.
    expect(EVIDENCE_CREDIT_PRODUCT.creditsExpire).toBe(false);
  });

  it("carries NO perpetual storage or AI promise", () => {
    // The whole product surface. A one-time payment cannot fund a recurring
    // monthly entitlement, so the descriptor deliberately has no field for one.
    expect(Object.keys(EVIDENCE_CREDIT_PRODUCT).sort()).toEqual([
      "creditsExpire",
      "creditsGrantedPerPurchase",
      "creditsPerCompletion",
      "displayName",
      "productKey",
      "unitPriceCents",
    ]);
  });

  it("spends the FREE plan allowance BEFORE any purchased credit", () => {
    // 2 of 3 FREE records used, 5 credits banked → the plan pays.
    const first = resolvePersonalEvidenceAdmission({
      plan: "FREE",
      currentRecordCount: 2,
      effectiveLifetimeRecordCap: 3,
      availableEvidenceCredits: 5,
    });
    expect(first).toEqual({ allowed: true, funding: "PLAN" });
  });

  it("spends a purchased credit only once the plan allowance is exhausted", () => {
    const admission = resolvePersonalEvidenceAdmission({
      plan: "FREE",
      currentRecordCount: 3,
      effectiveLifetimeRecordCap: 3,
      availableEvidenceCredits: 1,
    });
    expect(admission).toEqual({ allowed: true, funding: "EVIDENCE_CREDIT" });
  });

  it("denies when the allowance is exhausted and no credit remains", () => {
    const admission = resolvePersonalEvidenceAdmission({
      plan: "FREE",
      currentRecordCount: 3,
      effectiveLifetimeRecordCap: 3,
      availableEvidenceCredits: 0,
    });
    expect(admission).toEqual({
      allowed: false,
      reason: "PLAN_ALLOWANCE_EXHAUSTED_NO_CREDITS",
    });
  });

  it("REGRESSION: a FREE account holding credits is admitted past the free cap", () => {
    // THE defect. A real buyer stays on FREE, because no production path
    // writes `entitlements.plan = 'PAYG'`. The old gate asked
    // `caps.paygCreditsRequiredPerCompletion`, which is 0 on FREE, so the
    // credit branch was unreachable and the buyer was refused with
    // FREE_LIMIT_REACHED while holding paid credits.
    expect(getPlanCapabilities("FREE").paygCreditsRequiredPerCompletion).toBe(0);

    const admission = resolvePersonalEvidenceAdmission({
      plan: "FREE",
      currentRecordCount: 3,
      effectiveLifetimeRecordCap: 3,
      availableEvidenceCredits: 1,
    });
    expect(admission.allowed).toBe(true);
  });

  it("a plan with NO lifetime cap never reaches the credit branch", () => {
    const admission = resolvePersonalEvidenceAdmission({
      plan: "ENTERPRISE",
      currentRecordCount: 10_000,
      effectiveLifetimeRecordCap: null,
      availableEvidenceCredits: 0,
    });
    expect(admission).toEqual({ allowed: true, funding: "PLAN" });
  });

  it("honours a grandfather override as the effective lifetime cap", () => {
    const admission = resolvePersonalEvidenceAdmission({
      plan: "PRO",
      currentRecordCount: 150,
      effectiveLifetimeRecordCap: 200, // migrated override, above the PRO 100
      availableEvidenceCredits: 0,
    });
    expect(admission).toEqual({ allowed: true, funding: "PLAN" });
  });
});

// =============================================================================
// 2. Paid-record outputs
// =============================================================================

describe("evidence outputs follow the RECORD's funding, not the account plan", () => {
  it("a credit-funded record earns report + package + public verify on FREE", () => {
    const free = getPlanCapabilities("FREE");
    expect(free.reportsIncluded).toBe(false);
    expect(free.verificationPackageIncluded).toBe(false);

    expect(
      resolveEvidenceOutputEntitlements({ plan: "FREE", funding: "EVIDENCE_CREDIT" }),
    ).toEqual({
      reportsIncluded: true,
      verificationPackageIncluded: true,
      publicVerifyIncluded: true,
    });
  });

  it("a plan-funded record on FREE still gets no report or package", () => {
    expect(
      resolveEvidenceOutputEntitlements({ plan: "FREE", funding: "PLAN" }),
    ).toEqual({
      reportsIncluded: false,
      verificationPackageIncluded: false,
      publicVerifyIncluded: true,
    });
  });

  it("paying for one record does not upgrade the account's plan outputs", () => {
    // The entitlement is attached to the record. Nothing here grants the
    // account PRO-level capability for its OTHER records.
    for (const funding of ["PLAN", "EVIDENCE_CREDIT"] as const) {
      const outputs = resolveEvidenceOutputEntitlements({ plan: "FREE", funding });
      expect(typeof outputs.reportsIncluded).toBe("boolean");
    }
    expect(getPlanCapabilities("FREE").aiAdvisoryMonthlyOperations).toBe(0);
    expect(getPlanCapabilities("FREE").includedStorageBytes).toBe(250n * MB);
  });

  it("plan-funded records on paid plans keep their catalog outputs", () => {
    for (const plan of ["PRO", "TEAM", "ENTERPRISE"] as const) {
      const caps = getPlanCapabilities(plan);
      expect(
        resolveEvidenceOutputEntitlements({ plan, funding: "PLAN" }),
      ).toEqual({
        reportsIncluded: caps.reportsIncluded,
        verificationPackageIncluded: caps.verificationPackageIncluded,
        publicVerifyIncluded: caps.publicVerifyIncluded,
      });
    }
  });
});

// =============================================================================
// 3. One quota authority
// =============================================================================

describe("one canonical quota authority", () => {
  it("publishes the approved plan limits verbatim", () => {
    expect(PLAN_CAPABILITIES.FREE.maxEvidenceRecords).toBe(3);
    expect(PLAN_CAPABILITIES.FREE.maxEvidenceRecordsPerMonth).toBeNull();
    expect(PLAN_CAPABILITIES.FREE.includedStorageBytes).toBe(250n * MB);
    expect(PLAN_CAPABILITIES.FREE.aiAdvisoryMonthlyOperations).toBe(0);

    expect(PLAN_CAPABILITIES.PRO.maxEvidenceRecords).toBe(100);
    expect(PLAN_CAPABILITIES.PRO.maxEvidenceRecordsPerMonth).toBeNull();
    expect(PLAN_CAPABILITIES.PRO.includedStorageBytes).toBe(100n * GB);
    expect(PLAN_CAPABILITIES.PRO.aiAdvisoryMonthlyOperations).toBe(100);
    expect(PLAN_CAPABILITIES.PRO.monthlyPriceCents).toBe(1900);

    // TEAM is a ROLLING 30-DAY cap, not a lifetime one.
    expect(PLAN_CAPABILITIES.TEAM.maxEvidenceRecords).toBeNull();
    expect(PLAN_CAPABILITIES.TEAM.maxEvidenceRecordsPerMonth).toBe(500);
    expect(PLAN_CAPABILITIES.TEAM.includedStorageBytes).toBe(500n * GB);
    expect(PLAN_CAPABILITIES.TEAM.aiAdvisoryMonthlyOperations).toBe(500);
    expect(PLAN_CAPABILITIES.TEAM.monthlyPriceCents).toBe(7900);
  });

  it("REGRESSION: TEAM is no longer capped by the retired packaging quotas", async () => {
    // The packaging entitlement engine used to gate evidence creation and
    // storage on shared workspaces at 100 records and 1 GiB per CALENDAR
    // MONTH, against a TEAM plan sold as 500 records per rolling 30 days and
    // 500 GB cumulative. The keys are gone from the engine entirely.
    const mod = await import("../src/services/packaging/entitlement.service.js");
    const keys = Object.keys(mod.DEFAULT_ENTITLEMENTS);
    expect(keys).not.toContain("QUOTA_EVIDENCE_COUNT");
    expect(keys).not.toContain("QUOTA_STORAGE_BYTES");

    for (const line of Object.values(mod.PLAN_LINE_ENTITLEMENTS)) {
      expect(Object.keys(line)).not.toContain("QUOTA_EVIDENCE_COUNT");
      expect(Object.keys(line)).not.toContain("QUOTA_STORAGE_BYTES");
    }
  });

  it("REGRESSION: the retired quota keys are gone from the shared key union", async () => {
    const { ENTITLEMENT_KEYS } = await import("@proovra/shared");
    expect(ENTITLEMENT_KEYS as readonly string[]).not.toContain(
      "QUOTA_EVIDENCE_COUNT",
    );
    expect(ENTITLEMENT_KEYS as readonly string[]).not.toContain(
      "QUOTA_STORAGE_BYTES",
    );
  });

  it("no evidence route decides an evidence or storage quota outside the catalog", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../src/routes/evidence.routes.ts", import.meta.url),
      "utf8",
    );
    // The strings survive only inside the explanatory comments that record the
    // deletion; no `assertQuotaEntitlement` call may name them.
    expect(src).not.toMatch(/key:\s*"QUOTA_EVIDENCE_COUNT"/);
    expect(src).not.toMatch(/key:\s*"QUOTA_STORAGE_BYTES"/);
  });
});

// =============================================================================
// 4. Owned Workspace / Collaboration Team / member separation
// =============================================================================

describe("workspace, collaboration-team and member limits are independent", () => {
  it("the overloaded fields are gone from the catalog", () => {
    for (const plan of ALL_PLANS) {
      const caps = getPlanCapabilities(plan) as unknown as Record<string, unknown>;
      expect(Object.keys(caps)).not.toContain("maxOwnedTeams");
      expect(Object.keys(caps)).not.toContain("maxMembersPerTeam");
    }
  });

  it("exposes four separately-named limits on every plan", () => {
    for (const plan of ALL_PLANS) {
      const caps = getPlanCapabilities(plan);
      expect(typeof caps.maxOwnedWorkspaces, plan).toBe("number");
      expect(typeof caps.maxCollaborationTeamsPerWorkspace, plan).toBe("number");
      expect(typeof caps.maxAcceptedMembersPerCollaborationTeam, plan).toBe(
        "number",
      );
      expect(typeof caps.maxWorkspaceSeats, plan).toBe("number");
    }
  });

  it("preserves the approved accepted-member limit of 5 on PRO and TEAM", () => {
    expect(getPlanCapabilities("PRO").maxAcceptedMembersPerCollaborationTeam).toBe(5);
    expect(getPlanCapabilities("TEAM").maxAcceptedMembersPerCollaborationTeam).toBe(5);
    expect(getPlanCapabilities("PRO").maxWorkspaceSeats).toBe(5);
    expect(getPlanCapabilities("TEAM").maxWorkspaceSeats).toBe(5);
  });

  it("FREE and PAYG include no owned workspaces and no collaboration teams", () => {
    for (const plan of ["FREE", "PAYG"] as const) {
      const caps = getPlanCapabilities(plan);
      expect(caps.maxOwnedWorkspaces, plan).toBe(0);
      expect(caps.maxCollaborationTeamsPerWorkspace, plan).toBe(0);
      expect(caps.maxAcceptedMembersPerCollaborationTeam, plan).toBe(0);
    }
  });

  it("pending invitations are a SEPARATE rail from accepted members", () => {
    const pro = getPlanCapabilities("PRO");
    // 10 pending invites may exist against a 5-accepted-member ceiling; the
    // two numbers are deliberately different so neither can be inferred from
    // the other.
    expect(pro.maxPendingInvitesPerTeam).toBe(10);
    expect(pro.maxAcceptedMembersPerCollaborationTeam).toBe(5);
    expect(pro.maxInvitesPer24h).toBe(50);
  });

  it("the deleted collaboration-limits adapter has no exports left", async () => {
    const mod = (await import("@proovra/shared-billing")) as Record<string, unknown>;
    expect(mod.COLLABORATION_TEAM_PLAN_LIMITS).toBeUndefined();
    expect(mod.getCollaborationTeamPlanLimits).toBeUndefined();
    // and the dead second pricing projection is gone too
    expect(mod.getPricingCatalogResponse).toBeUndefined();
  });

  it("the owned-workspace guard counts Team rows and the collab guard counts CollaborationTeam rows", async () => {
    const fs = await import("node:fs/promises");
    const teams = await fs.readFile(
      new URL("../src/routes/teams.routes.ts", import.meta.url),
      "utf8",
    );
    const guards = await fs.readFile(
      new URL("../src/services/collaboration-team/billing-guards.ts", import.meta.url),
      "utf8",
    );

    expect(teams).toMatch(/caps\.maxOwnedWorkspaces/);
    expect(teams).toMatch(/prisma\.team\.count/);
    expect(teams).not.toMatch(/maxCollaborationTeamsPerWorkspace/);

    expect(guards).toMatch(/maxCollaborationTeamsPerWorkspace/);
    expect(guards).toMatch(/collaborationTeam\.count/);
    expect(guards).not.toMatch(/maxOwnedWorkspaces/);
  });
});

// =============================================================================
// 5. Enterprise contract limits govern
// =============================================================================

describe("Enterprise contract limits are enforced, not merely displayed", () => {
  const activeContract = (over: Record<string, unknown> = {}) =>
    ({
      organizationId: "org-1",
      status: "ACTIVE",
      activationState: "ACTIVATED",
      effectiveAtUtc: null,
      endsAtUtc: null,
      seatCount: 400,
      storageGb: 20_000,
      region: null,
      planVersion: null,
      billingCustomerRef: null,
      billingSubscriptionRef: null,
      contractOwnerUserId: null,
      legacyDerived: false,
      ...over,
    }) as never;

  it("a contracted storage figure REPLACES the catalog placeholder", () => {
    const limits = resolveEnterpriseContractLimits(activeContract());
    expect(limits.contractGovernsCapability).toBe(true);
    expect(
      resolveEffectiveBaseStorageBytes({ plan: "ENTERPRISE", contract: limits }),
    ).toBe(20_000n * GB);
    // and it is NOT max()'d against the placeholder
    expect(PLAN_CAPABILITIES.ENTERPRISE.includedStorageBytes).toBe(500n * GB);
  });

  it("a contracted storage figure BELOW the placeholder still governs", () => {
    // The contract is the purchased right. Taking max() with a placeholder
    // would silently sell capacity nobody agreed to.
    const limits = resolveEnterpriseContractLimits(activeContract({ storageGb: 100 }));
    expect(
      resolveEffectiveBaseStorageBytes({ plan: "ENTERPRISE", contract: limits }),
    ).toBe(100n * GB);
  });

  it("a contracted seat count REPLACES the catalog seat ceiling", () => {
    const limits = resolveEnterpriseContractLimits(activeContract());
    expect(
      resolveEffectiveContractSeats({
        plan: "ENTERPRISE",
        contract: limits,
        persistedSeats: 5,
      }),
    ).toBe(400);
  });

  it("contracted evidence and AI allowances govern when stated", () => {
    const limits = resolveEnterpriseContractLimits(
      activeContract({ evidenceRecordsPerMonth: 25_000, aiOperationsPerMonth: 9_000 }),
    );
    expect(
      resolveEffectiveContractEvidenceCap({ plan: "ENTERPRISE", contract: limits }),
    ).toBe(25_000);
    expect(
      resolveEffectiveContractAiCap({ plan: "ENTERPRISE", contract: limits }),
    ).toBe(9_000);
  });

  it("falls back to the catalog default when the contract is silent", () => {
    const limits = resolveEnterpriseContractLimits(
      activeContract({ storageGb: null, seatCount: null }),
    );
    expect(limits.storageBytes).toBeNull();
    expect(
      resolveEffectiveBaseStorageBytes({ plan: "ENTERPRISE", contract: limits }),
    ).toBe(PLAN_CAPABILITIES.ENTERPRISE.includedStorageBytes);
    expect(
      resolveEffectiveContractAiCap({ plan: "ENTERPRISE", contract: limits }),
    ).toBe(PLAN_CAPABILITIES.ENTERPRISE.aiAdvisoryMonthlyOperations);
  });

  it("FAILS CLOSED: a non-ACTIVE contract grants nothing", () => {
    for (const status of ["DRAFT", "PENDING_ACTIVATION", "SUSPENDED", "TERMINATED"]) {
      const limits = resolveEnterpriseContractLimits(activeContract({ status }));
      expect(limits.contractGovernsCapability, status).toBe(false);
      expect(limits.storageBytes, status).toBeNull();
      expect(limits.seats, status).toBeNull();
      // and a suspended contract's stored numbers may not raise a limit
      expect(
        resolveEffectiveBaseStorageBytes({ plan: "ENTERPRISE", contract: limits }),
        status,
      ).toBe(PLAN_CAPABILITIES.ENTERPRISE.includedStorageBytes);
    }
  });

  it("a workspace with no contract is never contract-governed", () => {
    expect(resolveEnterpriseContractLimits(null)).toEqual(NO_CONTRACT_LIMITS);
    expect(NO_CONTRACT_LIMITS.contractGovernsCapability).toBe(false);
  });

  it("rejects non-positive contract values rather than enforcing zero", () => {
    const limits = resolveEnterpriseContractLimits(
      activeContract({ storageGb: 0, seatCount: -5 }),
    );
    expect(limits.storageBytes).toBeNull();
    expect(limits.seats).toBeNull();
  });

  it("marks a legacy-derived projection so surfaces can say so honestly", () => {
    const limits = resolveEnterpriseContractLimits(
      activeContract({ legacyDerived: true }),
    );
    expect(limits.legacyDerived).toBe(true);
  });
});
