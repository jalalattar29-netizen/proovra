/**
 * INTERNAL PLAN GRANT — the worker resolves the SAME effective plan as the API.
 *
 * The worker builds its own workspace scope (it may not import API source), so
 * it must read the grant through the same shared reader and decide through the
 * same shared policy. This drives the worker's real builders against a stubbed
 * database client: no grant → the provider plan; an active TEAM grant → TEAM;
 * a grant never lowers a higher provider plan; a grant does not cover an OWNED
 * workspace.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type GrantRow = { id: string; plan: string; source: string; expiresAtUtc: Date | null } | null;

const state: {
  entitlementPlan: string;
  grant: GrantRow;
  team: Record<string, unknown> | null;
  personalTeam: { storageBytesOverride: bigint | null } | null;
  grantQueries: Array<Record<string, unknown>>;
} = { entitlementPlan: "FREE", grant: null, team: null, personalTeam: null, grantQueries: [] };

vi.mock("../src/db.js", () => ({
  prisma: {
    entitlement: {
      findFirst: vi.fn(async () => ({ plan: state.entitlementPlan, credits: 0, teamSeats: 0 })),
    },
    planGrant: {
      findFirst: vi.fn(async (args: Record<string, unknown>) => {
        state.grantQueries.push(args);
        return state.grant;
      }),
    },
    workspaceStorageAddon: {
      aggregate: vi.fn(async () => ({ _sum: { extraStorageBytes: null } })),
    },
    team: {
      findUnique: vi.fn(async () => state.team),
      findFirst: vi.fn(async () => state.personalTeam),
    },
    enterpriseContract: {
      findUnique: vi.fn(async () => null),
    },
  },
}));

const { getPersonalWorkspaceScope, getTeamWorkspaceScope } = await import("../src/workspace-billing.js");

const USER = "11111111-1111-4111-8111-111111111111";
const TEAM_GRANT = { id: "g1", plan: "TEAM", source: "INTERNAL_TEST", expiresAtUtc: null };

beforeEach(() => {
  state.entitlementPlan = "FREE";
  state.grant = null;
  state.team = null;
  state.personalTeam = null;
  state.grantQueries = [];
});

describe("worker effective plan — internal plan grant", () => {
  it("no grant: the provider plan (FREE)", async () => {
    expect((await getPersonalWorkspaceScope(USER)).plan).toBe("FREE");
  });

  it("an active TEAM grant: TEAM, read with the active/unexpired predicate", async () => {
    state.grant = TEAM_GRANT;
    expect((await getPersonalWorkspaceScope(USER)).plan).toBe("TEAM");
    const where = state.grantQueries[0]?.where as Record<string, unknown>;
    expect(where).toMatchObject({ userId: USER, revokedAtUtc: null });
    expect(JSON.stringify(where.OR)).toContain("expiresAtUtc");
  });

  it("a grant never lowers a higher provider plan", async () => {
    state.entitlementPlan = "TEAM";
    state.grant = TEAM_GRANT;
    expect((await getPersonalWorkspaceScope(USER)).plan).toBe("TEAM");
    state.entitlementPlan = "PRO";
    expect((await getPersonalWorkspaceScope(USER)).plan).toBe("TEAM");
  });

  it("the owner's PERSONAL team row resolves through the grant; an OWNED workspace does not", async () => {
    state.grant = TEAM_GRANT;
    const base = {
      id: "22222222-2222-4222-8222-222222222222",
      ownerUserId: USER,
      organizationId: "33333333-3333-4333-8333-333333333333",
      billingPlan: "FREE",
      billingStatus: "INACTIVE",
      includedSeats: 0,
      storageBytesOverride: null,
    };
    state.team = { ...base, workspaceKind: "PERSONAL", isPersonal: true };
    expect((await getTeamWorkspaceScope(base.id)).plan).toBe("TEAM");
    state.team = { ...base, workspaceKind: "OWNED", isPersonal: false };
    expect((await getTeamWorkspaceScope(base.id)).plan).toBe("FREE");
  });
});

describe("worker personal scope — storage override parity (F-09)", () => {
  it("reached by user id, the personal scope reads the personal Team's override, as the team-id path does", async () => {
    const override = 5n * 1024n * 1024n * 1024n;
    state.personalTeam = { storageBytesOverride: override };
    state.team = {
      id: "22222222-2222-4222-8222-222222222222",
      ownerUserId: USER,
      organizationId: "33333333-3333-4333-8333-333333333333",
      billingPlan: "FREE",
      billingStatus: "INACTIVE",
      includedSeats: 0,
      storageBytesOverride: override,
      workspaceKind: "PERSONAL",
      isPersonal: true,
    };
    const byUser = await getPersonalWorkspaceScope(USER);
    const byTeam = await getTeamWorkspaceScope("22222222-2222-4222-8222-222222222222");
    expect(byUser.storageBytesOverride).toBe(override);
    expect(byUser.storageBytesOverride).toBe(byTeam.storageBytesOverride);
  });

  it("no personal Team row: no override", async () => {
    expect((await getPersonalWorkspaceScope(USER)).storageBytesOverride).toBeNull();
  });
});
