/**
 * PHASE 12 POINT 4 PASS C0 — guest-invitation commercial entitlement,
 * BEHAVIORAL proof.
 *
 * The defect this locks down: `POST /v1/collaboration-teams/:teamId/guests/invite`
 * enforced its plan gate ONLY in the browser. Neither the route nor the service
 * checked the plan, so a FREE workspace could invite external collaborators by
 * calling the API directly, and the client held the commercial decision.
 *
 * The first repair read `Team.billingPlan` inside the service. That closed the
 * bypass but created a SECOND commercial authority, which disagreed with the
 * canonical one wherever the raw column is not the subject:
 *
 *   - PERSONAL workspace  → the subject is the OWNER'S ENTITLEMENT;
 *   - OWNED + legacy "ENTERPRISE" string → not enterprise coverage;
 *   - non-live billingStatus (suspended org) → stale plan string still granted.
 *
 * Guest invitation now runs through `assertCanInviteCollaborationTeamGuest`,
 * which resolves the plan with the SAME subject-correct authority every other
 * invitation channel uses (`resolveCommercialContext`) and applies the SAME
 * catalog capacity limits.
 *
 * Nothing under proof is mocked: the guard, the commercial resolver, the
 * effective-plan policy and the plan catalog all run for real. Only Prisma —
 * a genuine external process boundary — is faked, and the fake RECORDS every
 * write so a denial can be shown to mutate nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { canPlanOperateSharedWorkspace } from "../src/services/plan-catalog.service.js";

/** Every write the service could attempt. A denial must leave these empty. */
const writes: string[] = [];

type WorkspaceKind = "PERSONAL" | "OWNED" | "ORGANIZATION";

const state = {
  /** Persisted commercial state of the WORKSPACE row. */
  workspaceKind: "OWNED" as WorkspaceKind,
  workspaceBillingPlan: "FREE" as string,
  workspaceBillingStatus: "ACTIVE" as string,
  /** The OWNER's account entitlement — must never decide an OWNED workspace. */
  ownerPlan: "FREE" as string,
  /** CUSTOMER organization contract state behind an ORGANIZATION workspace. */
  organizationKind: "SYSTEM" as "SYSTEM" | "CUSTOMER",
  organizationStatus: "ACTIVE" as string,
  memberRole: "ADMIN" as string | null,
  memberStatus: "ACTIVE" as string,
  teamExists: true,
  pendingGuests: 0,
};

/** Aggregate result whose every `_sum.<field>` reads as null. */
const emptyAggregate = () => ({
  _sum: new Proxy({}, { get: () => null }),
  _count: 0,
  _avg: new Proxy({}, { get: () => null }),
  _max: new Proxy({}, { get: () => null }),
  _min: new Proxy({}, { get: () => null }),
});

const workspaceRow = () => ({
  id: "ws-1",
  ownerUserId: "owner-1",
  organizationId: "org-1",
  billingPlan: state.workspaceBillingPlan,
  billingStatus: state.workspaceBillingStatus,
  includedSeats: 0,
  storageBytesOverride: null,
  workspaceKind: state.workspaceKind,
  isPersonal: state.workspaceKind === "PERSONAL",
  billingOwnerUserId: "owner-1",
});

/**
 * Explicit rows for the models the canonical path actually reads. Anything
 * else falls through to the neutral defaults below, so the fake never
 * silently invents commercial facts.
 */
const models: Record<string, Record<string, (...args: never[]) => unknown>> = {
  collaborationTeam: {
    findUnique: () =>
      state.teamExists
        ? {
            id: "ct-1",
            workspaceId: "ws-1",
            workspace: {
              id: "ws-1",
              ownerUserId: "owner-1",
              isPersonal: state.workspaceKind === "PERSONAL",
            },
          }
        : null,
  },
  collaborationTeamMember: {
    findFirst: () =>
      state.memberStatus === "ACTIVE" && state.memberRole
        ? { role: state.memberRole }
        : null,
  },
  collaborationTeamGuest: {
    count: () => state.pendingGuests,
  },
  team: {
    findUnique: () => workspaceRow(),
    findFirst: () => workspaceRow(),
  },
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
      status: state.organizationStatus,
      createdAt: new Date(0),
      billingOwnerUserId: "owner-1",
      pendingEnterpriseSeats: null,
    }),
  },
};

/** Neutral, non-granting defaults for every other read. */
function defaultFor(method: string): unknown {
  if (method === "count") return 0;
  if (method === "aggregate") return emptyAggregate();
  if (method === "findMany" || method === "groupBy") return [];
  return null;
}

const prismaFake: unknown = new Proxy(
  {},
  {
    get(_t, modelName: string) {
      if (modelName === "$transaction") {
        return async (fn: (tx: unknown) => Promise<unknown>) => {
          writes.push("transaction");
          return fn(txFake);
        };
      }
      if (modelName === "then") return undefined;
      return new Proxy(
        {},
        {
          get(_t2, method: string) {
            return async (...args: never[]) => {
              if (/^(create|update|upsert|delete)/.test(method)) {
                writes.push(`${modelName}.${method}`);
                return { id: `${modelName}-1` };
              }
              const explicit = models[modelName]?.[method];
              return explicit ? explicit(...args) : defaultFor(method);
            };
          },
        },
      );
    },
  },
);

const txFake = {
  collaborationTeamGuest: {
    create: async () => {
      writes.push("guest.create");
      return { id: "guest-1" };
    },
  },
  collaborationTeamActivity: {
    create: async () => {
      writes.push("activity.create");
      return { id: "act-1" };
    },
  },
};

vi.mock("../src/db.js", () => ({ prisma: prismaFake }));

const { inviteGuest } = await import(
  "../src/services/collaboration-team/collaboration-completion.service.js"
);

const invite = () =>
  inviteGuest({
    teamId: "ct-1",
    actorUserId: "user-1",
    email: "external@example.invalid",
  });

/**
 * Writes that would constitute invitation state. A denial must produce none
 * of them. (A CUSTOMER-org read may still emit the fire-and-forget
 * `enterprise_contract_legacy_fallback` audit — observability, and itself a
 * Phase-12 retirement metric — which is not invitation state.)
 */
const invitationWrites = () =>
  writes.filter((w) => !/^transaction$/.test(w));

/** Every commercial denial must be a billing denial that grants nothing. */
async function expectDenied(code: string) {
  await expect(invite()).rejects.toMatchObject({ code });
  expect(invitationWrites()).toEqual([]);
}

beforeEach(() => {
  writes.length = 0;
  state.workspaceKind = "OWNED";
  state.workspaceBillingPlan = "FREE";
  state.workspaceBillingStatus = "ACTIVE";
  state.ownerPlan = "FREE";
  state.organizationKind = "SYSTEM";
  state.organizationStatus = "ACTIVE";
  state.memberRole = "ADMIN";
  state.memberStatus = "ACTIVE";
  state.teamExists = true;
  state.pendingGuests = 0;
});

describe("Phase 12 Point 4 — guest invitation is server-enforced", () => {
  it("FREE is denied and mutates NOTHING", async () => {
    state.workspaceKind = "PERSONAL";
    state.ownerPlan = "FREE";
    // The whole point: no guest row, no activity row, no transaction at all.
    await expectDenied("TEAM_INVITES_NOT_INCLUDED");
    expect(writes).toEqual([]);
  });

  it("PAYG is denied — it is an operation entitlement, not a workspace plan", async () => {
    state.workspaceKind = "PERSONAL";
    state.ownerPlan = "PAYG";
    await expectDenied("TEAM_INVITES_NOT_INCLUDED");
    expect(canPlanOperateSharedWorkspace("PAYG")).toBe(false);
  });

  it("PRO is allowed within its limits", async () => {
    state.workspaceKind = "PERSONAL";
    state.ownerPlan = "PRO";
    await expect(invite()).resolves.toMatchObject({ id: "guest-1" });
    expect(writes).toContain("guest.create");
  });

  it("TEAM is allowed within its limits", async () => {
    state.workspaceBillingPlan = "TEAM";
    state.workspaceBillingStatus = "ACTIVE";
    await expect(invite()).resolves.toMatchObject({ id: "guest-1" });
    expect(writes).toContain("guest.create");
  });

  it("an allowed plan is still DENIED over its pending-invitation limit", async () => {
    state.workspaceBillingPlan = "TEAM";
    // Sit exactly at the catalog cap for this plan.
    const { getPlanCapabilities } = await import("@proovra/shared-billing");
    state.pendingGuests =
      getPlanCapabilities("TEAM").maxPendingInvitesPerTeam;
    await expectDenied("TEAM_INVITE_LIMIT_REACHED");
    // One under the cap still passes — the gate is the limit, not a block.
    state.pendingGuests -= 1;
    await expect(invite()).resolves.toMatchObject({ id: "guest-1" });
  });

  it("ENTERPRISE is allowed from the ORGANIZATION contract", async () => {
    state.workspaceKind = "ORGANIZATION";
    state.organizationKind = "CUSTOMER";
    state.workspaceBillingPlan = "ENTERPRISE";
    state.workspaceBillingStatus = "ACTIVE";
    await expect(invite()).resolves.toMatchObject({ id: "guest-1" });
    // Guards the exact regression: the old browser rule was
    // `plan === "PRO" || plan === "TEAM"`, which locked out ENTERPRISE.
    expect(canPlanOperateSharedWorkspace("ENTERPRISE")).toBe(true);
  });

  it("a SUSPENDED organization is denied even though the plan string says ENTERPRISE", async () => {
    state.workspaceKind = "ORGANIZATION";
    state.organizationKind = "CUSTOMER";
    state.workspaceBillingPlan = "ENTERPRISE";
    // Not a live billing status → no contract coverage, whatever the string.
    state.workspaceBillingStatus = "SUSPENDED";
    await expectDenied("TEAM_INVITES_NOT_INCLUDED");
  });

  it("an OWNED workspace uses its OWN persisted state, never the owner's plan", async () => {
    state.workspaceKind = "OWNED";
    state.workspaceBillingPlan = "FREE";
    // An ENTERPRISE account owning the workspace must not lift it.
    state.ownerPlan = "ENTERPRISE";
    await expectDenied("TEAM_INVITES_NOT_INCLUDED");
  });

  it("an OWNED workspace carrying a legacy ENTERPRISE string is NOT enterprise-covered", async () => {
    state.workspaceKind = "OWNED";
    state.workspaceBillingPlan = "ENTERPRISE";
    state.workspaceBillingStatus = "ACTIVE";
    // Enterprise coverage requires an ORGANIZATION contract; the ambiguous
    // legacy row fails closed instead of granting external access.
    await expectDenied("TEAM_INVITES_NOT_INCLUDED");
  });

  it("inactive membership is denied before the plan is even consulted", async () => {
    state.workspaceBillingPlan = "TEAM";
    state.memberStatus = "SUSPENDED";
    await expectDenied("team_forbidden");
  });

  it("a foreign / missing team is concealed, not described", async () => {
    state.teamExists = false;
    await expectDenied("team_not_found");
  });

  it("a client-forged capability cannot widen eligibility — the plan comes from persistence", async () => {
    state.workspaceKind = "PERSONAL";
    state.ownerPlan = "FREE";
    // The caller supplies no plan/capability at all; the service resolves it
    // from persisted state, so there is nothing to forge.
    await expectDenied("TEAM_INVITES_NOT_INCLUDED");
  });

  it("the catalog — not a plan-name list — is the authority", () => {
    // If the catalog changes, enforcement follows automatically.
    expect(canPlanOperateSharedWorkspace("FREE")).toBe(false);
    expect(canPlanOperateSharedWorkspace("PAYG")).toBe(false);
    expect(canPlanOperateSharedWorkspace("PRO")).toBe(true);
    expect(canPlanOperateSharedWorkspace("TEAM")).toBe(true);
    expect(canPlanOperateSharedWorkspace("ENTERPRISE")).toBe(true);
  });
});
