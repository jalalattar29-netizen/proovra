/**
 * Teams Entitlement Alignment (2026-07-14) — the commercial plan
 * matrix, enforced. RUNTIME tests: the real billing guards execute
 * against a Prisma double, proving per-plan behavior and that denials
 * write ZERO rows.
 *
 * Contract: FREE/PAYG → zero Teams (402 TEAM_PLAN_REQUIRED; existing
 * grandfathered Teams readable but ALL membership growth locked via
 * 402 TEAM_INVITES_NOT_INCLUDED). PRO → 2 Teams × 5 members. TEAM →
 * 5 × 5. ENTERPRISE → provisioned ceiling. Invitations EMAIL-ONLY.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  plan: "FREE" as string,
  workspaceTeams: 0,
  memberCount: 0,
  pendingInvites: 0,
  invites24h: 0,
  writes: [] as string[],
}));

vi.mock("../src/db.js", () => {
  // §9.7 target-architecture harness: member/invite guards resolve the PARENT
  // WORKSPACE's plan through the canonical envelope. The test workspace is
  // the owner's PERSONAL space (kind PERSONAL → plan = owner entitlement),
  // which preserves the original intent: the owner's plan drives the rails.
  const track =
    (name: string) =>
    async () => {
      H.writes.push(name);
      return { id: "x" };
    };
  const explicit: Record<string, Record<string, unknown>> = {
    entitlement: {
      findFirst: async () => ({ plan: H.plan }),
    },
    team: {
      findUnique: async () => ({
        id: "ws-1",
        ownerUserId: "owner-1",
        billingOwnerUserId: "owner-1",
        organizationId: "org-1",
        billingPlan: "FREE",
        billingStatus: "INACTIVE",
        includedSeats: 0,
        storageBytesOverride: null,
        workspaceKind: "PERSONAL",
        isPersonal: true,
      }),
      findFirst: async () => ({ id: "ws-1", organizationId: "org-1" }),
    },
    workspaceStorageAddon: {
      aggregate: async () => ({ _sum: { extraStorageBytes: 0n } }),
    },
    collaborationTeam: {
      count: async () => H.workspaceTeams,
      findFirst: async () => ({
        id: "team-1",
        workspace: { id: "ws-1", ownerUserId: "owner-1", isPersonal: true },
      }),
      findUnique: async () => ({
        id: "team-1",
        workspaceId: "ws-1",
        workspace: { id: "ws-1", ownerUserId: "owner-1", isPersonal: true },
      }),
      create: track("collaborationTeam.create"),
    },
    collaborationTeamMember: {
      count: async () => H.memberCount,
      create: track("collaborationTeamMember.create"),
    },
    collaborationTeamInvite: {
      count: async (args: { where?: Record<string, unknown> } = {}) =>
        args.where && "createdAt" in (args.where as object)
          ? H.invites24h
          : H.pendingInvites,
      create: track("collaborationTeamInvite.create"),
    },
    // WORKSPACE AND COLLABORATION ARCHITECTURE CLOSURE — the invitation that
    // grants tenancy. `resolveWorkspaceInvitationAllowance` counts PENDING by
    // the live-window predicate and the 24-hour rate by `createdAt`, so the
    // double discriminates the same way the group one above always did. A
    // double that answered 0 to both would make the rails look absent.
    teamInvite: {
      count: async (args: { where?: Record<string, unknown> } = {}) =>
        args.where && "createdAt" in (args.where as object)
          ? H.invites24h
          : H.pendingInvites,
      create: track("teamInvite.create"),
    },
    subscription: {
      findFirst: async () => null, // no row → entitlement authoritative
      findMany: async () => [], // §9.5 ambiguity probe — no rows
    },
  };
  // Fallback for every other model the envelope touches (usage/contract/...):
  // reads resolve empty, writes are tracked.
  const prisma = new Proxy(explicit, {
    get(target, model: string) {
      if (model in target) return target[model];
      if (model.startsWith("$")) return async (fn?: unknown) =>
        typeof fn === "function" ? (fn as (tx: unknown) => unknown)(prisma) : 0;
      return new Proxy(
        {},
        {
          get(_t, method: string) {
            return async () => {
              if (/^(create|update|upsert|delete)/.test(String(method)))
                H.writes.push(`${model}.${String(method)}`);
              if (method === "findMany") return [];
              if (method === "count") return 0;
              if (method === "aggregate") return { _sum: {} };
              return null;
            };
          },
        },
      );
    },
  });
  return { prisma };
});

import { resolveWorkspaceInvitationAllowance } from "../src/services/billing/workspace-seats.service.js";
import {
  assertCanCreateCollaborationTeam,
  assertCollaborationTeamMemberLimit,
  lowestPlanWithTeams,
  BillingLimitError,
} from "../src/services/collaboration-team/billing-guards.js";

beforeEach(() => {
  H.plan = "FREE";
  H.workspaceTeams = 0;
  H.memberCount = 0;
  H.pendingInvites = 0;
  H.invites24h = 0;
  H.writes.length = 0;
});

async function expectBillingError(
  fn: () => Promise<unknown>,
  code: string,
  httpStatus: number,
) {
  try {
    await fn();
    throw new Error(`expected ${code} but the guard allowed the action`);
  } catch (err) {
    const e = err as BillingLimitError;
    expect(e.code).toBe(code);
    expect(e.httpStatus).toBe(httpStatus);
    return e;
  }
}

describe("Team creation — the commercial plan matrix", () => {
  it("FREE: denied with 402 TEAM_PLAN_REQUIRED, requiredPlan=PRO, ZERO rows written", async () => {
    const e = await expectBillingError(
      () => assertCanCreateCollaborationTeam({ workspaceId: "ws-1", actorUserId: "owner-1" }),
      "TEAM_PLAN_REQUIRED",
      402,
    );
    expect(e.details.requiredPlan).toBe("PRO");
    expect(e.message).toContain("Pro, Team, and Enterprise");
    expect(H.writes).toEqual([]);
  });

  it("PAYG: identical denial — paying per evidence does not unlock Teams", async () => {
    H.plan = "PAYG";
    await expectBillingError(
      () => assertCanCreateCollaborationTeam({ workspaceId: "ws-1", actorUserId: "owner-1" }),
      "TEAM_PLAN_REQUIRED",
      402,
    );
    expect(H.writes).toEqual([]);
  });

  it("PRO: first and second allowed; third → 409 TEAM_LIMIT_REACHED with limit + usage", async () => {
    H.plan = "PRO";
    H.workspaceTeams = 0;
    await expect(
      assertCanCreateCollaborationTeam({ workspaceId: "ws-1", actorUserId: "owner-1" }),
    ).resolves.toMatchObject({ maxCollaborationTeamsPerWorkspace: 2, workspaceTeamCount: 0 });
    H.workspaceTeams = 1;
    await expect(
      assertCanCreateCollaborationTeam({ workspaceId: "ws-1", actorUserId: "owner-1" }),
    ).resolves.toMatchObject({ workspaceTeamCount: 1 });
    H.workspaceTeams = 2;
    const e = await expectBillingError(
      () => assertCanCreateCollaborationTeam({ workspaceId: "ws-1", actorUserId: "owner-1" }),
      "TEAM_LIMIT_REACHED",
      409,
    );
    expect(e.details.limit).toBe(2);
    expect(e.details.usage).toBe(2);
    expect(e.message).toContain("up to 2 Teams");
  });

  it("TEAM plan: fifth allowed, sixth denied with the same typed capacity response", async () => {
    H.plan = "TEAM";
    H.workspaceTeams = 4;
    await expect(
      assertCanCreateCollaborationTeam({ workspaceId: "ws-1", actorUserId: "owner-1" }),
    ).resolves.toMatchObject({ maxCollaborationTeamsPerWorkspace: 5 });
    H.workspaceTeams = 5;
    const e = await expectBillingError(
      () => assertCanCreateCollaborationTeam({ workspaceId: "ws-1", actorUserId: "owner-1" }),
      "TEAM_LIMIT_REACHED",
      409,
    );
    expect(e.details.limit).toBe(5);
  });

  it("ENTERPRISE: provisioned ceiling enforced (not unlimited frontend assumption)", async () => {
    H.plan = "ENTERPRISE";
    H.workspaceTeams = 1000;
    await expectBillingError(
      () => assertCanCreateCollaborationTeam({ workspaceId: "ws-1", actorUserId: "owner-1" }),
      "TEAM_LIMIT_REACHED",
      409,
    );
  });

  it("the upgrade target is DERIVED from the canonical table, not hardcoded", () => {
    expect(lowestPlanWithTeams()).toBe("PRO");
  });
});

describe("Grandfathered Teams — data readable, growth locked", () => {
  it("member add on a FREE-owned existing Team → 402 TEAM_INVITES_NOT_INCLUDED", async () => {
    H.plan = "FREE";
    H.memberCount = 3; // grandfathered team with members
    const e = await expectBillingError(
      () => assertCollaborationTeamMemberLimit("team-1"),
      "TEAM_INVITES_NOT_INCLUDED",
      402,
    );
    expect(e.details.requiredPlan).toBe("PRO");
    expect(H.writes).toEqual([]);
  });

  // WORKSPACE AND COLLABORATION ARCHITECTURE CLOSURE (2026-09-06) — the
  // invitation rails moved to the WORKSPACE, which is the subject they were
  // always about: they bound claims on SEATS, and a group holds none. The
  // per-group gate enforced them once per group, so a workspace with five
  // groups could hold five times the pending invitations its plan sells —
  // and the invitation that actually grants tenancy was gated by neither.
  //
  // The numbers are unchanged and come from the same catalog. What these
  // assert is that the surviving authority reports them for the right plan;
  // the ENFORCEMENT is proven end-to-end against live PostgreSQL in
  // `wcr-invitation-closure.integration.test.ts`.
  it("a zero-team plan includes no workspace invitations at all", async () => {
    H.plan = "PAYG";
    const allowance = await resolveWorkspaceInvitationAllowance("ws-1");
    expect(allowance.plan).toBe("PAYG");
    expect(allowance.featureIncluded).toBe(false);
    expect(allowance.maxPending).toBe(0);
    expect(H.writes).toEqual([]);
  });

  it("upgrading the owner restores growth (PRO passes the same gates)", async () => {
    H.plan = "PRO";
    H.memberCount = 2;
    await expect(
      assertCollaborationTeamMemberLimit("team-1"),
    ).resolves.toMatchObject({ maxAcceptedMembers: 5 });
    await expect(
      resolveWorkspaceInvitationAllowance("ws-1"),
    ).resolves.toMatchObject({ plan: "PRO", maxPending: 10, maxPer24h: 50 });
  });
});

describe("Member + invite rails on eligible plans", () => {
  it("PRO member cap: 5th member allowed, 6th → 409 TEAM_MEMBER_LIMIT_REACHED", async () => {
    H.plan = "PRO";
    H.memberCount = 4;
    await expect(
      assertCollaborationTeamMemberLimit("team-1"),
    ).resolves.toBeTruthy();
    H.memberCount = 5;
    await expectBillingError(
      () => assertCollaborationTeamMemberLimit("team-1"),
      "TEAM_MEMBER_LIMIT_REACHED",
      409,
    );
  });

  it("the pending and 24h rails are WORKSPACE-scoped and read the catalog", async () => {
    H.plan = "PRO";
    H.pendingInvites = 10;
    H.invites24h = 3;
    const atPendingCeiling = await resolveWorkspaceInvitationAllowance("ws-1");
    expect(atPendingCeiling.pending).toBe(10);
    expect(atPendingCeiling.pending).toBeGreaterThanOrEqual(
      atPendingCeiling.maxPending,
    );

    H.pendingInvites = 0;
    H.invites24h = 50;
    const atRateCeiling = await resolveWorkspaceInvitationAllowance("ws-1");
    expect(atRateCeiling.sentLast24h).toBe(50);
    expect(atRateCeiling.sentLast24h).toBeGreaterThanOrEqual(
      atRateCeiling.maxPer24h,
    );
    // Reading an allowance writes nothing.
    expect(H.writes).toEqual([]);
  });
});
