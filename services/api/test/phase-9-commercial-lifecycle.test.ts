/**
 * PHASE 9 STEP 4/5 (2026-07-22) — canonical commercial LIFECYCLE/GRACE policy.
 *
 * Behavioral proof that `resolveCommercialContext(...).lifecycle` is the ONE
 * subscription-active + grace authority, replacing billing-guards' former
 * independent engine. Covers the subject/lifecycle matrix the Phase 9 mandate
 * requires: FREE, active, grace, grace-expired, cancelled, missing-record
 * (webhook lag), and the stale-row corroboration (terminal OTHER-plan row must
 * not deny a live current-plan subject).
 *
 * A status-aware Subscription mock emulates Prisma's `where.status` filtering
 * so the four-branch ordering (live → past-due grace → tolerate → terminal) is
 * genuinely exercised, not merely present in source.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { status: string; plan: string; currentPeriodEnd: Date | null; updatedAt: Date };
const H = vi.hoisted(() => ({
  scope: {} as Record<string, unknown>,
  rows: [] as Row[],
}));

// Status-aware subscription mock: honors where.status ({in:[...]} or scalar)
// and where.plan, orders by updatedAt desc, returns the first match.
function queryRowsAll(where: { status?: unknown; plan?: string }): Row[] {
  let rows = [...H.rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  if (where.plan) rows = rows.filter((r) => r.plan === where.plan);
  if (where.status) {
    const st = where.status as { in?: string[] } | string;
    if (typeof st === "object" && Array.isArray(st.in)) rows = rows.filter((r) => st.in!.includes(r.status));
    else rows = rows.filter((r) => r.status === st);
  }
  return rows;
}
function queryRows(where: { status?: unknown; plan?: string }): Row | null {
  return queryRowsAll(where)[0] ?? null;
}

vi.mock("../src/db.js", () => ({
  prisma: {
    team: { findUnique: async () => ({ billingOwnerUserId: null, ownerUserId: "u1" }) },
    subscription: {
      findFirst: async ({ where }: { where: { status?: unknown; plan?: string } }) => queryRows(where),
      findMany: async ({ where, take }: { where: { status?: unknown; plan?: string }; take?: number }) =>
        queryRowsAll(where).slice(0, take ?? undefined),
    },
  },
}));
vi.mock("../src/services/plan-catalog.service.js", () => ({
  getPlanCapabilities: (plan: string) => ({ plan, includedSeats: 5 }),
}));
vi.mock("../src/services/workspace-billing.service.js", () => ({
  resolveWorkspaceScopeForUser: async () => H.scope,
}));
vi.mock("../src/services/workspace-usage.service.js", () => ({
  getWorkspaceUsage: async () => ({ teamMemberCount: 0, seatLimit: 0, seatRemaining: 0 }),
}));
vi.mock("../src/services/organization/enterprise-contract.service.js", () => ({
  resolveEnterpriseContract: async () => null,
}));

import { resolveCommercialContext } from "../src/services/billing/commercial-context.service.js";

const DAY = 24 * 60 * 60 * 1000;
function personal(plan: string) {
  H.scope = { workspaceType: "PERSONAL", ownerUserId: "u1", teamId: null, organizationId: null, plan };
}
async function life() {
  return (await resolveCommercialContext({ ownerUserId: "u1" })).lifecycle;
}

beforeEach(() => {
  H.rows = [];
  personal("PRO");
});

describe("Phase 9 — canonical lifecycle/grace policy (ONE authority)", () => {
  it("FREE → INACTIVE, mutations allowed (feature-limit gated), not paid-active", async () => {
    personal("FREE");
    expect(await life()).toMatchObject({ state: "INACTIVE", paidActive: false, mutationsAllowed: true });
  });

  it("no matching subscription row (webhook lag) → ACTIVE (tolerated)", async () => {
    expect(await life()).toMatchObject({ state: "ACTIVE", paidActive: true, mutationsAllowed: true });
  });

  it("live ACTIVE row → ACTIVE", async () => {
    H.rows = [{ status: "ACTIVE", plan: "PRO", currentPeriodEnd: null, updatedAt: new Date(1000) }];
    expect(await life()).toMatchObject({ state: "ACTIVE", mutationsAllowed: true });
  });

  it("PAST_DUE within grace window → GRACE (still allowed)", async () => {
    H.rows = [{ status: "PAST_DUE", plan: "PRO", currentPeriodEnd: new Date(Date.now() - 2 * DAY), updatedAt: new Date(2000) }];
    const l = await life();
    expect(l).toMatchObject({ state: "GRACE", paidActive: true, mutationsAllowed: true });
    expect(l.graceEndsAtUtc).toBeInstanceOf(Date);
  });

  it("PAST_DUE past the grace window → PAST_DUE_EXPIRED (denied, fail closed)", async () => {
    H.rows = [{ status: "PAST_DUE", plan: "PRO", currentPeriodEnd: new Date(Date.now() - 30 * DAY), updatedAt: new Date(2000) }];
    expect(await life()).toMatchObject({ state: "PAST_DUE_EXPIRED", paidActive: false, mutationsAllowed: false });
  });

  it("CANCELED matching row → CANCELLED (denied)", async () => {
    H.rows = [{ status: "CANCELED", plan: "PRO", currentPeriodEnd: null, updatedAt: new Date(3000) }];
    expect(await life()).toMatchObject({ state: "CANCELLED", paidActive: false, mutationsAllowed: false });
  });

  it("STALE terminal row for ANOTHER plan does not deny a live current-plan subject", async () => {
    // Production 402 regression: a CANCELED PAYG row (newer) must be ignored
    // while the live PRO row governs.
    H.rows = [
      { status: "CANCELED", plan: "PAYG", currentPeriodEnd: null, updatedAt: new Date(9999) },
      { status: "ACTIVE", plan: "PRO", currentPeriodEnd: null, updatedAt: new Date(1000) },
    ];
    expect(await life()).toMatchObject({ state: "ACTIVE", mutationsAllowed: true });
  });

  it("§9.5 — PAST_DUE with NO trustworthy clock FAILS CLOSED for paid mutations", async () => {
    H.rows = [{ status: "PAST_DUE", plan: "PRO", currentPeriodEnd: null, updatedAt: new Date(2000) }];
    expect(await life()).toMatchObject({ state: "PAST_DUE_EXPIRED", paidActive: false, mutationsAllowed: false });
  });

  it("§9.5 — MULTIPLE live rows (ambiguous provider state) FAIL CLOSED", async () => {
    H.rows = [
      { status: "ACTIVE", plan: "PRO", currentPeriodEnd: null, updatedAt: new Date(2000) },
      { status: "ACTIVE", plan: "PRO", currentPeriodEnd: null, updatedAt: new Date(1000) },
    ];
    expect(await life()).toMatchObject({ paidActive: false, mutationsAllowed: false });
  });

  it("§9.5 — CANCELED with a FUTURE paid-through date stays commercially active until it", async () => {
    H.rows = [{ status: "CANCELED", plan: "PRO", currentPeriodEnd: new Date(Date.now() + 10 * DAY), updatedAt: new Date(2000) }];
    const l = await life();
    expect(l).toMatchObject({ state: "ACTIVE", paidActive: true, mutationsAllowed: true });
    expect(l.graceEndsAtUtc).toBeInstanceOf(Date);
  });

  it("live ACTIVE row wins over an also-present PAST_DUE row (prefer-live ordering)", async () => {
    H.rows = [
      { status: "PAST_DUE", plan: "PRO", currentPeriodEnd: new Date(Date.now() - 30 * DAY), updatedAt: new Date(5000) },
      { status: "ACTIVE", plan: "PRO", currentPeriodEnd: null, updatedAt: new Date(1000) },
    ];
    expect(await life()).toMatchObject({ state: "ACTIVE", mutationsAllowed: true });
  });
});
