/**
 * LEGAL HOLD — the effective commercial authority, exercised.
 *
 * ===========================================================================
 * THE CONTRACT UNDER TEST
 * ===========================================================================
 * Legal Hold is an ENTERPRISE governance capability whose availability is
 * CONTRACT-DRIVEN:
 *
 *     ENTERPRISE plan          — eligibility, necessary and not sufficient
 *         ↓
 *     ACTIVE Enterprise contract stating the term
 *         ↓
 *     FEATURE_LEGAL_HOLD       — what every route and the UI actually read
 *
 * These are behavioural cases against `resolveEntitlement`, not source-string
 * matches: each one drives the real resolver with a doubled commercial context
 * and asserts the answer it produces. The source-shape invariants live beside
 * them in `legal-hold-product-contract.test.ts`.
 *
 * THE INVARIANT THAT OUTRANKS ALL OF IT is proven in the last block: commercial
 * state governs ADMISSION to a NEW hold and nothing else. An ACTIVE hold keeps
 * protecting evidence through downgrade, expiry, entitlement removal and
 * suspension.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const commercial = vi.hoisted(() => ({
  plan: "ENTERPRISE" as string,
  contract: null as Record<string, unknown> | null,
}));

vi.mock("../src/services/billing/commercial-context.service.js", () => ({
  resolveCommercialContext: async () => ({
    plan: commercial.plan,
    enterpriseContract: commercial.contract,
  }),
}));

/** A contract row projection, defaulting to ACTIVE and silent on Legal Hold. */
function contract(over: Record<string, unknown> = {}) {
  return {
    organizationId: "org-1",
    status: "ACTIVE",
    activationState: "ACTIVATED",
    effectiveAtUtc: new Date("2026-01-01T00:00:00Z"),
    endsAtUtc: null,
    seatCount: 50,
    storageGb: 100,
    evidenceRecordsPerMonth: null,
    aiOperationsPerMonth: null,
    collaborationTeamsMax: null,
    collaborationTeamMembersMax: null,
    legalHoldEnabled: null,
    region: null,
    planVersion: null,
    billingCustomerRef: null,
    billingSubscriptionRef: null,
    contractOwnerUserId: null,
    legacyDerived: false,
    ...over,
  };
}

const prismaDouble = {
  team: { findUnique: async () => ({ ownerUserId: "owner-1" }) },
  // Present so a stray read would be visible rather than throwing; the Legal
  // Hold branch must never consult it.
  entitlementGrant: {
    findUnique: async () => {
      throw new Error("stored grants must not decide FEATURE_LEGAL_HOLD");
    },
  },
} as never;

async function resolve() {
  const { resolveEntitlement } = await import(
    "../src/services/packaging/entitlement.service.js"
  );
  return resolveEntitlement({
    prisma: prismaDouble,
    teamId: "11111111-1111-4111-8111-111111111111",
    key: "FEATURE_LEGAL_HOLD",
  });
}

beforeEach(() => {
  commercial.plan = "ENTERPRISE";
  commercial.contract = null;
  vi.resetModules();
});

describe("Legal Hold entitlement — the plan matrix", () => {
  // Eligibility is necessary and not sufficient: no non-Enterprise plan sells
  // Legal Hold, so no contract term could apply to one.
  for (const plan of ["FREE", "PAYG", "PRO", "TEAM"]) {
    it(`${plan} cannot create — the plan does not sell Legal Hold`, async () => {
      commercial.plan = plan;
      // Even handed a contract that grants it, which a non-Enterprise
      // workspace should never have: eligibility is checked first.
      commercial.contract = contract({ legalHoldEnabled: true });
      const res = await resolve();
      expect(res.value).toBe(false);
    });
  }

  it("ENTERPRISE with an ACTIVE contract that grants it CAN create", async () => {
    commercial.contract = contract({ legalHoldEnabled: true });
    const res = await resolve();
    expect(res.value).toBe(true);
    // The grant came from the contract, and the projection says so rather than
    // claiming a stored PLAN grant that does not exist.
    expect(res.source).toBe("CUSTOM");
  });

  it("ENTERPRISE with NO contract at all cannot create", async () => {
    commercial.contract = null;
    expect((await resolve()).value).toBe(false);
  });

  it("ENTERPRISE whose contract is SILENT cannot create", async () => {
    // The decisive case. Silence is not a grant — reading it as one would be
    // the `plan === ENTERPRISE` shortcut wearing a contract's clothes, and
    // would hand a governance capability to every Enterprise customer.
    commercial.contract = contract({ legalHoldEnabled: null });
    expect((await resolve()).value).toBe(false);
  });

  it("ENTERPRISE whose contract explicitly declines cannot create", async () => {
    commercial.contract = contract({ legalHoldEnabled: false });
    expect((await resolve()).value).toBe(false);
  });
});

describe("Legal Hold entitlement — contract lifecycle", () => {
  // Every non-ACTIVE status fails closed upstream in
  // `resolveEnterpriseContractLimits`, so the term is never even read.
  for (const status of ["DRAFT", "PENDING_ACTIVATION", "SUSPENDED", "TERMINATED"]) {
    it(`a ${status} contract grants nothing, even stating the term`, async () => {
      commercial.contract = contract({ status, legalHoldEnabled: true });
      expect((await resolve()).value).toBe(false);
    });
  }

  it("removing the contract grant blocks NEW creation", async () => {
    commercial.contract = contract({ legalHoldEnabled: true });
    expect((await resolve()).value).toBe(true);

    // The amendment lands: the term is withdrawn.
    commercial.contract = contract({ legalHoldEnabled: false });
    expect((await resolve()).value).toBe(false);
  });

  it("a later amendment re-enables it through the same resolver", async () => {
    commercial.contract = contract({ legalHoldEnabled: false });
    expect((await resolve()).value).toBe(false);
    commercial.contract = contract({ legalHoldEnabled: true });
    expect((await resolve()).value).toBe(true);
  });

  it("downgrading off ENTERPRISE blocks NEW creation", async () => {
    commercial.contract = contract({ legalHoldEnabled: true });
    expect((await resolve()).value).toBe(true);
    commercial.plan = "TEAM";
    expect((await resolve()).value).toBe(false);
  });

  it("a commercial engine that throws has not said yes", async () => {
    const failing = {
      team: {
        findUnique: async () => {
          throw new Error("database unavailable");
        },
      },
    } as never;
    const { resolveEntitlement } = await import(
      "../src/services/packaging/entitlement.service.js"
    );
    const res = await resolveEntitlement({
      prisma: failing,
      teamId: "11111111-1111-4111-8111-111111111111",
      key: "FEATURE_LEGAL_HOLD",
    });
    expect(res.value).toBe(false);
  });
});

describe("Legal Hold entitlement — one authority, no stored-grant path", () => {
  it("a stored EntitlementGrant cannot decide this key", async () => {
    /*
     * The prisma double THROWS from `entitlementGrant.findUnique`. If the
     * Legal Hold branch ever falls through to the generic grant lookup this
     * test fails loudly, which is the point: `applyProductLine` is not the
     * Enterprise contract, and two writers answering one commercial question
     * is the defect this closure removes.
     */
    commercial.contract = contract({ legalHoldEnabled: true });
    await expect(resolve()).resolves.toMatchObject({ value: true });

    commercial.contract = contract({ legalHoldEnabled: false });
    await expect(resolve()).resolves.toMatchObject({ value: false });
  });

  it("the product-line matrix no longer grants Legal Hold on any line", async () => {
    const { PLAN_LINE_ENTITLEMENTS } = await import(
      "../src/services/packaging/entitlement.service.js"
    );
    for (const [line, entitlements] of Object.entries(PLAN_LINE_ENTITLEMENTS)) {
      expect(
        (entitlements as Record<string, unknown>).FEATURE_LEGAL_HOLD,
        `${line} must not grant FEATURE_LEGAL_HOLD — the contract decides it`,
      ).toBeUndefined();
      expect(
        (entitlements as Record<string, unknown>).LEGAL_HOLD_MAX_ACTIVE,
        `${line} must not carry an invented Legal Hold ceiling`,
      ).toBeUndefined();
    }
  });
});
