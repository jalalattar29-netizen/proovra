/**
 * PHASE 12 POINT 4 PASS C5 — the enterprise-feature gate has no owner-plan
 * fallback.
 *
 * `resolveTeamEnterpriseFeatureGate` (and the byte-identical copy in
 * billing-enforcement) used to read `Team.billingPlan` and, whenever the
 * workspace's billing was NOT live, substitute the OWNER's personal
 * entitlement. This gate guards SCIM and SAML, so a suspended or cancelled
 * enterprise workspace kept its enterprise identity features for as long as
 * its owner personally held a plan that included them.
 *
 * The canonical policy uses an owner's entitlement ONLY for a PERSONAL
 * workspace. An OWNED / ORGANIZATION workspace answers from its own persisted
 * commercial state (or its organization contract).
 *
 * Only Prisma is faked; the gate, `resolveCommercialContext`, the
 * effective-plan policy and the plan catalog all run for real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  workspaceKind: "ORGANIZATION" as "PERSONAL" | "OWNED" | "ORGANIZATION",
  billingPlan: "ENTERPRISE" as string,
  billingStatus: "ACTIVE" as string,
  /** The owner's PERSONAL entitlement — must not decide a workspace gate. */
  ownerPlan: "ENTERPRISE" as string,
  organizationKind: "CUSTOMER" as "SYSTEM" | "CUSTOMER",
  teamExists: true,
};

const emptyAggregate = () => ({
  _sum: new Proxy({}, { get: () => null }),
  _count: 0,
  _avg: new Proxy({}, { get: () => null }),
  _max: new Proxy({}, { get: () => null }),
  _min: new Proxy({}, { get: () => null }),
});

const teamRow = () =>
  state.teamExists
    ? {
        id: "ws-1",
        ownerUserId: "owner-1",
        organizationId: "org-1",
        billingPlan: state.billingPlan,
        billingStatus: state.billingStatus,
        includedSeats: 0,
        storageBytesOverride: null,
        workspaceKind: state.workspaceKind,
        isPersonal: state.workspaceKind === "PERSONAL",
        billingOwnerUserId: "owner-1",
      }
    : null;

const models: Record<string, Record<string, () => unknown>> = {
  team: { findUnique: () => teamRow(), findFirst: () => teamRow() },
  entitlement: {
    findFirst: () => ({
      userId: "owner-1",
      plan: state.ownerPlan,
      credits: 0,
      teamSeats: 0,
      active: true,
      legacyRecordCapOverride: null,
    }),
  },
  organization: {
    findUnique: () => ({
      id: "org-1",
      kind: state.organizationKind,
      status: "ACTIVE",
      createdAt: new Date(0),
      billingOwnerUserId: "owner-1",
      pendingEnterpriseSeats: null,
    }),
  },
};

function defaultFor(method: string): unknown {
  if (method === "count") return 0;
  if (method === "aggregate") return emptyAggregate();
  if (method === "findMany" || method === "groupBy") return [];
  return null;
}

const prismaFake: unknown = new Proxy(
  {},
  {
    get(_t, model: string) {
      if (model === "then") return undefined;
      if (model === "$transaction") {
        return async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaFake);
      }
      return new Proxy(
        {},
        {
          get(_t2, method: string) {
            return async () =>
              models[model]?.[method]?.() ?? defaultFor(method);
          },
        },
      );
    },
  },
);

vi.mock("../src/db.js", () => ({ prisma: prismaFake }));

const { resolveTeamEnterpriseFeatureGate } = await import(
  "../src/services/enterprise-gate-resolvers.service.js"
);

const gate = () => resolveTeamEnterpriseFeatureGate("ws-1", "ssoScim");

beforeEach(() => {
  state.workspaceKind = "ORGANIZATION";
  state.billingPlan = "ENTERPRISE";
  state.billingStatus = "ACTIVE";
  state.ownerPlan = "ENTERPRISE";
  state.organizationKind = "CUSTOMER";
  state.teamExists = true;
});

describe("Phase 12 Point 4 — enterprise gate resolves the WORKSPACE subject", () => {
  it("a live ORGANIZATION workspace on its contract passes", async () => {
    await expect(gate()).resolves.toEqual({ ok: true });
  });

  it("a SUSPENDED organization workspace is DENIED even though its owner holds ENTERPRISE", async () => {
    // The exact regression: not-live billing used to hand control to the
    // owner's personal entitlement, keeping SCIM/SAML alive after lapse.
    state.billingStatus = "SUSPENDED";
    state.ownerPlan = "ENTERPRISE";
    await expect(gate()).resolves.toMatchObject({
      ok: false,
      reason: "ENTERPRISE_FEATURE_REQUIRED",
      statusCode: 402,
    });
  });

  it("a CANCELED workspace is DENIED regardless of the owner's plan", async () => {
    state.billingStatus = "CANCELED";
    await expect(gate()).resolves.toMatchObject({ ok: false });
  });

  it("an OWNED workspace carrying a legacy ENTERPRISE string is DENIED", async () => {
    // Enterprise coverage requires an organization contract; the ambiguous
    // legacy row fails closed instead of unlocking identity features.
    state.workspaceKind = "OWNED";
    state.organizationKind = "SYSTEM";
    state.billingPlan = "ENTERPRISE";
    state.ownerPlan = "ENTERPRISE";
    await expect(gate()).resolves.toMatchObject({ ok: false });
  });

  it("a missing workspace is not found — never gated on someone else's plan", async () => {
    state.teamExists = false;
    await expect(gate()).resolves.toMatchObject({
      ok: false,
      reason: "team_not_found",
      statusCode: 404,
    });
  });
});
