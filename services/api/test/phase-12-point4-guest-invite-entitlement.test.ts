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
 * That entitlement gate has since been retired along with the operation it
 * guarded — see the describe block below for why, and for the stricter
 * property that replaced it. The history above is kept because the bypass it
 * records is the reason this file exists.
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

/**
 * WORKSPACE AND COLLABORATION ARCHITECTURE RECONCILIATION — the subject of
 * this suite was retired, and the reason matters.
 *
 * "Guests" never granted anything. The operation wrote a
 * `CollaborationTeamGuest` row and stopped: no email was ever sent,
 * `acceptedUserId` / `acceptedAtUtc` were written by ZERO code paths, the
 * status never left PENDING, and no read path anywhere consulted the table
 * for access. An operator pressing "Invite guest" was told an external
 * collaborator had time-bounded access to their evidence, and no access
 * existed and nobody had been contacted. External review has a real
 * authority — grants, identity, expiry, audit — and that is where external
 * reviewers are granted access.
 *
 * So the commercial gate this file used to prove was gating a no-op. The
 * property that replaces it is STRICTER, not weaker: the operation now
 * refuses for EVERY plan and EVERY workspace kind — including all four
 * configurations that used to be allowed — with one typed, identical
 * refusal, and mutates nothing. A refusal that does not depend on the plan
 * cannot be widened by getting the plan wrong, which is what every case
 * below used to be about.
 */
describe("Workspace/collaboration reconciliation — guest invitation is retired, for everyone", () => {
  /** The exact commercial configurations the entitlement gate used to decide. */
  const CONFIGURATIONS: Array<{ name: string; apply: () => void }> = [
    {
      name: "FREE personal (was denied)",
      apply: () => {
        state.workspaceKind = "PERSONAL";
        state.ownerPlan = "FREE";
      },
    },
    {
      name: "PAYG personal (was denied)",
      apply: () => {
        state.workspaceKind = "PERSONAL";
        state.ownerPlan = "PAYG";
      },
    },
    {
      name: "PRO personal (was ALLOWED)",
      apply: () => {
        state.workspaceKind = "PERSONAL";
        state.ownerPlan = "PRO";
      },
    },
    {
      name: "TEAM workspace (was ALLOWED)",
      apply: () => {
        state.workspaceBillingPlan = "TEAM";
        state.workspaceBillingStatus = "ACTIVE";
      },
    },
    {
      name: "ENTERPRISE organization contract (was ALLOWED)",
      apply: () => {
        state.workspaceKind = "ORGANIZATION";
        state.organizationKind = "CUSTOMER";
        state.workspaceBillingPlan = "ENTERPRISE";
        state.workspaceBillingStatus = "ACTIVE";
      },
    },
    {
      name: "SUSPENDED organization carrying an ENTERPRISE string (was denied)",
      apply: () => {
        state.workspaceKind = "ORGANIZATION";
        state.organizationKind = "CUSTOMER";
        state.workspaceBillingPlan = "ENTERPRISE";
        state.workspaceBillingStatus = "SUSPENDED";
      },
    },
    {
      name: "OWNED workspace under an ENTERPRISE owner (was denied)",
      apply: () => {
        state.workspaceKind = "OWNED";
        state.workspaceBillingPlan = "FREE";
        state.ownerPlan = "ENTERPRISE";
      },
    },
    {
      name: "OWNED workspace with a legacy ENTERPRISE string (was denied)",
      apply: () => {
        state.workspaceKind = "OWNED";
        state.workspaceBillingPlan = "ENTERPRISE";
        state.workspaceBillingStatus = "ACTIVE";
      },
    },
  ];

  it.each(CONFIGURATIONS)(
    "$name → the same typed retirement, and NOTHING is written",
    async ({ apply }) => {
      apply();
      await expect(invite()).rejects.toMatchObject({
        code: "COLLABORATION_TEAM_GUESTS_RETIRED",
        httpStatus: 410,
      });
      // No guest row, no activity row, no transaction at all.
      expect(writes).toEqual([]);
    },
  );

  it("the refusal is IDENTICAL across every configuration — the plan cannot widen it", async () => {
    const refusals: string[] = [];
    for (const config of CONFIGURATIONS) {
      writes.length = 0;
      Object.assign(state, {
        workspaceKind: "OWNED" as const,
        workspaceBillingPlan: "FREE",
        workspaceBillingStatus: "ACTIVE",
        ownerPlan: "FREE",
        organizationKind: "SYSTEM" as const,
        organizationStatus: "ACTIVE",
      });
      config.apply();
      const refusal = await invite().then(
        () => "ALLOWED",
        (e: { code?: string; httpStatus?: number }) =>
          `${e.code}:${e.httpStatus}`,
      );
      refusals.push(refusal);
    }
    expect(new Set(refusals)).toEqual(
      new Set(["COLLABORATION_TEAM_GUESTS_RETIRED:410"]),
    );
  });

  it("capacity is irrelevant now — a workspace with room is refused too", async () => {
    state.workspaceBillingPlan = "TEAM";
    state.pendingGuests = 0;
    await expect(invite()).rejects.toMatchObject({
      code: "COLLABORATION_TEAM_GUESTS_RETIRED",
    });
    expect(writes).toEqual([]);
  });

  it("authorization still runs FIRST — an inactive member is denied before anything else", async () => {
    state.workspaceBillingPlan = "TEAM";
    state.memberStatus = "SUSPENDED";
    await expectDenied("team_forbidden");
  });

  it("a foreign / missing team is concealed, not described", async () => {
    state.teamExists = false;
    await expectDenied("team_not_found");
  });

  it("existing guest rows stay READABLE — an operator can see and revoke what they believe they granted", async () => {
    state.workspaceBillingPlan = "TEAM";
    const { listGuests } = await import(
      "../src/services/collaboration-team/collaboration-completion.service.js"
    );
    await expect(
      listGuests({ teamId: "ct-1", actorUserId: "user-1" }),
    ).resolves.toBeDefined();
    expect(writes).toEqual([]);
  });

  it("the catalog — not a plan-name list — is still the authority for workspace membership", () => {
    expect(canPlanOperateSharedWorkspace("FREE")).toBe(false);
    expect(canPlanOperateSharedWorkspace("PAYG")).toBe(false);
    expect(canPlanOperateSharedWorkspace("PRO")).toBe(true);
    expect(canPlanOperateSharedWorkspace("TEAM")).toBe(true);
    expect(canPlanOperateSharedWorkspace("ENTERPRISE")).toBe(true);
  });
});
