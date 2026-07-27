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
  ownedTeams: 0,
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
    async (..._args: unknown[]) => {
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
      count: async () => H.ownedTeams,
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

import {
  assertCanCreateCollaborationTeam,
  assertCollaborationTeamMemberLimit,
  assertCanInviteCollaborationTeamMember,
  lowestPlanWithTeams,
  BillingLimitError,
} from "../src/services/collaboration-team/billing-guards.js";

beforeEach(() => {
  H.plan = "FREE";
  H.ownedTeams = 0;
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
      () => assertCanCreateCollaborationTeam("owner-1"),
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
      () => assertCanCreateCollaborationTeam("owner-1"),
      "TEAM_PLAN_REQUIRED",
      402,
    );
    expect(H.writes).toEqual([]);
  });

  it("PRO: first and second allowed; third → 409 TEAM_LIMIT_REACHED with limit + usage", async () => {
    H.plan = "PRO";
    H.ownedTeams = 0;
    await expect(
      assertCanCreateCollaborationTeam("owner-1"),
    ).resolves.toMatchObject({ maxTeams: 2, ownedTeamCount: 0 });
    H.ownedTeams = 1;
    await expect(
      assertCanCreateCollaborationTeam("owner-1"),
    ).resolves.toMatchObject({ ownedTeamCount: 1 });
    H.ownedTeams = 2;
    const e = await expectBillingError(
      () => assertCanCreateCollaborationTeam("owner-1"),
      "TEAM_LIMIT_REACHED",
      409,
    );
    expect(e.details.limit).toBe(2);
    expect(e.details.usage).toBe(2);
    expect(e.message).toContain("up to 2 Teams");
  });

  it("TEAM plan: fifth allowed, sixth denied with the same typed capacity response", async () => {
    H.plan = "TEAM";
    H.ownedTeams = 4;
    await expect(
      assertCanCreateCollaborationTeam("owner-1"),
    ).resolves.toMatchObject({ maxTeams: 5 });
    H.ownedTeams = 5;
    const e = await expectBillingError(
      () => assertCanCreateCollaborationTeam("owner-1"),
      "TEAM_LIMIT_REACHED",
      409,
    );
    expect(e.details.limit).toBe(5);
  });

  it("ENTERPRISE: provisioned ceiling enforced (not unlimited frontend assumption)", async () => {
    H.plan = "ENTERPRISE";
    H.ownedTeams = 1000;
    await expectBillingError(
      () => assertCanCreateCollaborationTeam("owner-1"),
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

  it("email invite on a PAYG-owned existing Team → same lock, zero invite rows", async () => {
    H.plan = "PAYG";
    await expectBillingError(
      () => assertCanInviteCollaborationTeamMember("team-1", "EMAIL"),
      "TEAM_INVITES_NOT_INCLUDED",
      402,
    );
    expect(H.writes).toEqual([]);
  });

  it("upgrading the owner restores growth (PRO passes the same gates)", async () => {
    H.plan = "PRO";
    H.memberCount = 2;
    await expect(
      assertCollaborationTeamMemberLimit("team-1"),
    ).resolves.toMatchObject({ maxMembersPerTeam: 5 });
    await expect(
      assertCanInviteCollaborationTeamMember("team-1", "EMAIL"),
    ).resolves.toBeTruthy();
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

  it("pending-invite and 24h rails still fire for eligible plans", async () => {
    H.plan = "PRO";
    H.pendingInvites = 10;
    await expectBillingError(
      () => assertCanInviteCollaborationTeamMember("team-1", "EMAIL"),
      "TEAM_INVITE_LIMIT_REACHED",
      429,
    );
    H.pendingInvites = 0;
    H.invites24h = 50;
    await expectBillingError(
      () => assertCanInviteCollaborationTeamMember("team-1", "EMAIL"),
      "TEAM_INVITE_LIMIT_REACHED",
      429,
    );
  });
});
