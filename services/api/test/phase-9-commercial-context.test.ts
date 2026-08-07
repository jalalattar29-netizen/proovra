/**
 * PHASE 9 §12.1/§12.7 (2026-07-22) — canonical commercial-context
 * resolver. It COMPOSES the existing canonical pieces (workspace scope,
 * plan capabilities, workspace usage, enterprise contract) into ONE
 * envelope and encodes the §12.7 ACTIVE-only seat rule + billing-owner
 * resolution. No parallel billing model.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  scope: {} as Record<string, unknown>,
  usage: {} as Record<string, unknown>,
  contract: null as unknown,
  team: null as Record<string, unknown> | null,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    team: { findUnique: async () => H.team },
    // STEP 4 lifecycle policy reads Subscription; empty here → "no row →
    // tolerate webhook lag → ACTIVE" (does not disturb these composition tests).
    subscription: { findFirst: async () => null, findMany: async () => [] },
  },
}));
vi.mock("../src/services/plan-catalog.service.js", () => ({
  getPlanCapabilities: (plan: string) => ({ plan, includedSeats: 5 }),
}));
vi.mock("../src/services/workspace-billing.service.js", () => ({
  resolveWorkspaceScopeForUser: async () => H.scope,
}));
vi.mock("../src/services/workspace-usage.service.js", () => ({
  getWorkspaceUsage: async () => H.usage,
}));
vi.mock("../src/services/organization/enterprise-contract.service.js", () => ({
  resolveEnterpriseContract: async () => H.contract,
}));

import { resolveCommercialContext } from "../src/services/billing/commercial-context.service.js";

beforeEach(() => {
  H.scope = {
    billingShape: "SHARED",
    ownerUserId: "u1",
    teamId: "t1",
    organizationId: "org-1",
    plan: "TEAM",
  };
  H.usage = { teamMemberCount: 3, seatLimit: 5, seatRemaining: 2 };
  H.contract = { status: "ACTIVE", legacyDerived: false, seatCount: 50 };
  H.team = { billingOwnerUserId: "billing-owner", ownerUserId: "u1" };
});

describe("Phase 9 §12.1 — commercial-context composition", () => {
  it("unifies plan, capabilities, seats, billing owner, and enterprise contract", async () => {
    const ctx = await resolveCommercialContext({ ownerUserId: "u1", teamId: "t1" });
    expect(ctx).toMatchObject({
      billingShape: "SHARED",
      plan: "TEAM",
      organizationId: "org-1",
      billingOwnerUserId: "billing-owner",
      seats: { consumed: 3, limit: 5, remaining: 2 },
      enterpriseContract: { status: "ACTIVE", seatCount: 50 },
    });
    expect(ctx.capabilities).toMatchObject({ plan: "TEAM" });
  });

  it("§12.7 seat = ACTIVE-only member count from usage (never invitations)", async () => {
    H.usage = { teamMemberCount: 5, seatLimit: 5, seatRemaining: 0 };
    const ctx = await resolveCommercialContext({ ownerUserId: "u1", teamId: "t1" });
    expect(ctx.seats).toEqual({ consumed: 5, limit: 5, remaining: 0 });
  });

  it("personal scope bills the owner and carries no enterprise contract", async () => {
    H.scope = {
      billingShape: "SINGLE_OCCUPANT",
      ownerUserId: "u1",
      teamId: null,
      organizationId: null,
      plan: "PRO",
    };
    H.usage = { teamMemberCount: 0, seatLimit: 0, seatRemaining: 0 };
    const ctx = await resolveCommercialContext({ ownerUserId: "u1" });
    expect(ctx.billingOwnerUserId).toBe("u1");
    expect(ctx.enterpriseContract).toBeNull();
    expect(ctx.billingShape).toBe("SINGLE_OCCUPANT");
  });

  it("falls back to team owner when no explicit billing owner", async () => {
    H.team = { billingOwnerUserId: null, ownerUserId: "team-owner" };
    const ctx = await resolveCommercialContext({ ownerUserId: "u1", teamId: "t1" });
    expect(ctx.billingOwnerUserId).toBe("team-owner");
  });
});
