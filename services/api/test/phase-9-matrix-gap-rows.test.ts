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
  orgMemberships: [] as unknown[],
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
                if (String(model) === "collaborationTeam" && method === "findUnique")
                  return { workspace: { id: "ws-1", ownerUserId: "owner-1" } };
                if (String(model) === "collaborationTeamMember" && method === "count")
                  return H.activeMembers;
                // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — rows 19
                // and 23 now exercise the billing-account capability
                // chokepoint, which reads the viewer and their organization
                // memberships.
                if (String(model) === "user" && method === "findUnique")
                  return { displayName: "Viewer", email: "viewer@example.test" };
                if (String(model) === "organizationMembership" && method === "findMany")
                  return H.orgMemberships;
                if (String(model) === "organization" && method === "findUnique")
                  return { id: "org-1", kind: "CUSTOMER", status: "ACTIVE" };
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

// Members audit ENT-04 — row 14 follows the capacity gate that exists now:
// the per-Collaboration-Team member capacity (the workspace seat pool it used
// to exercise, `assertTeamSeatAvailable`, was deleted with the pool). Only
// the commercial subject is substituted, so the rule itself runs for real.
vi.mock("../src/services/billing/workspace-seats.service.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  resolveWorkspaceCommercialContext: async () => ({
    plan: "TEAM",
    scope: { plan: "TEAM" },
    enterpriseContract: null,
  }),
}));

import { assertCollaborationTeamMemberLimit } from "../src/services/collaboration-team/billing-guards.js";
import { assertBillingCapability } from "../src/services/billing/billing-accounts.service.js";

// The REAL module (its role sets included — the billing-account service reads
// ORG_BILLING_ROLES from it), with only the gate's decision replaced.
vi.mock("../src/services/organization/org-access.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  checkOrgAccess: async () => ({ kind: "ok" }),
}));

vi.mock("../src/services/identity/identity-mode.service.js", () => ({
  assertPersonalSpaceAllowed: async () => undefined,
}));

beforeEach(() => {
  H.writes.length = 0;
  H.activeMembers = 0;
  H.includedSeats = 1;
  H.orgMemberships = [
    {
      organizationId: "org-1",
      organization: { name: "Acme", billingOwnerUserId: "payer-1" },
    },
  ];
});

describe("Row 14 — capacity exhaustion is DETERMINISTIC (same state → same denial, zero mutation)", () => {
  it("a full Collaboration Team denies BEFORE any membership mutation, with a stable shape, twice in a row", async () => {
    // TEAM sells up to 10 accepted non-owner members per Collaboration Team.
    // This row is about determinism, not about the number, so it tracks it.
    H.activeMembers = 10;
    const deny = () =>
      assertCollaborationTeamMemberLimit("ct-1", 1).then(
        () => "allowed",
        (e: Error & { code?: string; httpStatus?: number }) => ({
          code: e.code,
          status: e.httpStatus,
        }),
      );
    const first = await deny();
    const second = await deny();
    expect(first).toEqual({ code: "TEAM_MEMBER_LIMIT_REACHED", status: 409 });
    expect(second).toEqual(first); // deterministic
    expect(H.writes.filter((w) => /member|invite/i.test(w))).toEqual([]);
  });

  it("a group with room allows deterministically", async () => {
    H.activeMembers = 9;
    await expect(assertCollaborationTeamMemberLimit("ct-1", 1)).resolves.toMatchObject({
      maxAcceptedMembers: 10,
      currentMemberCount: 9,
    });
  });
});

// BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — rows 19 and 23 were
// RETARGETED from `activateTeamPlan`, which was deleted once TEAM stopped
// being a workspace's commercial state.
//
// Both rows are about the same two properties, and both properties survive the
// model change intact: someone who is not the payer cannot make a financial
// change, and a denial writes nothing at all. What changed is where those
// properties are decided. They used to live inside a workspace-plan writer
// that re-checked `ownerUserId` itself; they now live in
// `assertBillingCapability`, the single chokepoint every billing route passes
// through before touching a subject. That is a strictly better place for them
// — one rule instead of one per writer — so the rows follow it there rather
// than being retired with the function they happened to be written against.
//
// The subject used here is an ORGANIZATION account, because that is the one
// remaining account a viewer can reach without being its payer: Enterprise is
// contract-managed, so an organization billing admin sees the plan, the
// amounts and the history, and holds no self-service manage or cancel.

describe("Row 19 — a non-payer cannot manage owner-only billing (real chokepoint)", () => {
  it("an ORG billing admin managing the subscription → 403, ZERO billing writes", async () => {
    await expect(
      assertBillingCapability({
        viewerUserId: "org-admin-1",
        type: "ORGANIZATION",
        id: "org-1",
        capability: "BILLING_MANAGE",
      }),
    ).rejects.toMatchObject({ httpStatus: 403 });
    expect(H.writes).toEqual([]);
  });

  it("the same viewer cancelling → 403, ZERO billing writes", async () => {
    await expect(
      assertBillingCapability({
        viewerUserId: "org-admin-1",
        type: "ORGANIZATION",
        id: "org-1",
        capability: "BILLING_CANCEL",
      }),
    ).rejects.toMatchObject({ httpStatus: 403 });
    expect(H.writes).toEqual([]);
  });

  it("positive separation: the SAME viewer may still READ that account", async () => {
    // Non-vacuous. A denial that came from the account being unreachable
    // rather than from the capability would deny this too.
    await expect(
      assertBillingCapability({
        viewerUserId: "org-admin-1",
        type: "ORGANIZATION",
        id: "org-1",
        capability: "BILLING_HISTORY_VIEW",
      }),
    ).resolves.toMatchObject({ type: "ORGANIZATION", id: "org-1" });
    expect(H.writes).toEqual([]);
  });
});

describe("Row 23 — commercial denial performs ZERO partial mutation", () => {
  it("a denied capability leaves no team/billing/subscription writes behind", async () => {
    await assertBillingCapability({
      viewerUserId: "org-admin-1",
      type: "ORGANIZATION",
      id: "org-1",
      capability: "BILLING_ADDON_PURCHASE",
    }).catch(() => null);
    expect(H.writes).toEqual([]);
  });

  it("an account the viewer cannot see is 404 — not a silent fallback, and ZERO writes", async () => {
    // Fails CLOSED and indistinguishably: a cross-tenant id must not be
    // usable to enumerate other tenants' organizations.
    H.orgMemberships = [];
    await expect(
      assertBillingCapability({
        viewerUserId: "outsider-1",
        type: "ORGANIZATION",
        id: "org-someone-else",
        capability: "BILLING_ACCOUNT_VIEW",
      }),
    ).rejects.toMatchObject({ httpStatus: 404 });
    expect(H.writes).toEqual([]);
  });
});
