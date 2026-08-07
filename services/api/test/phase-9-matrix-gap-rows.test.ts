/**
 * PHASE 9 FINAL CLOSURE — behavioral proofs for the acceptance-matrix rows
 * that previously had no dedicated behavioral test (rows 14, 19, 23).
 * Real production services run; only the db client is substituted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  activeMembers: 0,
  includedSeats: 1,
  writes: [] as string[],
}));

vi.mock("../src/db.js", () => {
  const prisma = new Proxy(
    {},
    {
      get(_t, model: string) {
        if (String(model).startsWith("$")) return async () => 0;
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return async () => {
                if (/^(create|update|upsert|delete)/.test(String(method)))
                  H.writes.push(`${String(model)}.${String(method)}`);
                if (String(model) === "team" && method === "findUnique")
                  return {
                    id: "ws-1",
                    ownerUserId: "owner-1",
                    isPersonal: false,
                    billingPlan: "TEAM",
                    billingStatus: "ACTIVE",
                    includedSeats: H.includedSeats,
                    storageBytesOverride: null,
                    organizationId: "org-1",
                    workspaceKind: "OWNED",
                    _count: { members: H.activeMembers },
                  };
                if (String(model) === "teamMember" && method === "count")
                  return H.activeMembers;
                if (method === "findMany") return [];
                if (method === "count") return 0;
                if (method === "aggregate") return { _sum: {} };
                if (method === "findFirst" || method === "findUnique") return null;
                return {};
              };
            },
          },
        );
      },
    },
  );
  return { prisma };
});

import { assertTeamSeatAvailable } from "../src/services/workspace-usage.service.js";
import { activateTeamPlan } from "../src/services/billing.service.js";

beforeEach(() => {
  H.writes.length = 0;
  H.activeMembers = 0;
  H.includedSeats = 1;
});

describe("Row 14 — seat exhaustion is DETERMINISTIC (same state → same denial, zero mutation)", () => {
  it("exhausted seats deny BEFORE any membership mutation, with a stable shape, twice in a row", async () => {
    H.activeMembers = 5; // TEAM seat limit (5) fully consumed → exhausted
    H.includedSeats = 1;
    const scope = { billingShape: "SHARED", plan: "TEAM", teamId: "ws-1", ownerUserId: "owner-1", organizationId: "org-1", credits: 0, teamSeats: 1, storageBytesOverride: null, activeStorageAddonBytes: 0n, legacyRecordCapOverride: null } as never;
    const first = await assertTeamSeatAvailable(scope).then(
      () => "allowed",
      (e: Error & { code?: string; statusCode?: number }) => ({ code: e.code, status: e.statusCode }),
    );
    const second = await assertTeamSeatAvailable(scope).then(
      () => "allowed",
      (e: Error & { code?: string; statusCode?: number }) => ({ code: e.code, status: e.statusCode }),
    );
    expect(first).not.toBe("allowed");
    expect(second).toEqual(first); // deterministic
    expect(H.writes.filter((w) => /teamMember|invite/i.test(w))).toEqual([]);
  });

  it("a free seat allows deterministically", async () => {
    H.activeMembers = 0;
    H.includedSeats = 1;
    await expect(
      assertTeamSeatAvailable({ billingShape: "SHARED", plan: "TEAM", teamId: "ws-1", ownerUserId: "owner-1", organizationId: "org-1", credits: 0, teamSeats: 1, storageBytesOverride: null, activeStorageAddonBytes: 0n, legacyRecordCapOverride: null } as never),
    ).resolves.toMatchObject({ seatLimit: 5 });
  });
});

describe("Row 19 — members cannot manage owner-only payments (real billing.service)", () => {
  it("a NON-owner activating team billing → 403, ZERO billing writes", async () => {
    await expect(
      activateTeamPlan({
        teamId: "ws-1",
        ownerUserId: "member-2", // not the owner
        plan: "TEAM" as never,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(H.writes.filter((w) => w.startsWith("team."))).toEqual([]);
  });
});

describe("Row 23 — commercial denial performs ZERO partial mutation (activation path)", () => {
  it("denied activation leaves no team/billing/subscription writes behind", async () => {
    await activateTeamPlan({
      teamId: "ws-1",
      ownerUserId: "not-owner",
      plan: "TEAM" as never,
    }).catch(() => null);
    expect(H.writes).toEqual([]);
  });
});
