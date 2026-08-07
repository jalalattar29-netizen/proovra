/**
 * PHASE 4 §7.4/§7.5 (2026-07-22) — workspace lifecycle behavioral pins.
 *
 * §7.4 transferWorkspaceOwnership: OWNED-only fail-closed matrix; team-row
 *      owner+billing swap; orchestrated OWNER/ADMIN membership legs with
 *      MANUAL provenance.
 * §7.4 reopenClosedWorkspace: owner-only; ONLY the owner's membership is
 *      restored (members/credentials/webhooks stay dark).
 * §7.5 suspend/resumeOrganizationWorkspace: reversible marker-reason
 *      suspension; switcher pointers cleared; webhook delivery paused;
 *      resume reverts EXACTLY the marker rows.
 *
 * Preservation invariant for every transition: no evidence access, no
 * hard-deletes anywhere in these flows.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  calls: [] as { model: string; method: string; args: unknown[] }[],
  team: null as Record<string, unknown> | null,
  members: {} as Record<string, { id: string; status: string } | null>,
  activeMembers: [] as { id: string }[],
  markedSuspended: [] as { id: string }[],
  openClosure: null as { id: string } | null,
  completedClosure: null as { id: string } | null,
}));

function makeTx() {
  return new Proxy(
    {},
    {
      get(_t, model: string) {
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return async (...args: unknown[]) => {
                H.calls.push({ model, method, args });
                if (model === "team" && method === "findUnique") return H.team;
                if (model === "teamMember" && method === "findUnique") {
                  const where = (
                    args[0] as {
                      where: { teamId_userId: { userId: string } };
                    }
                  ).where.teamId_userId;
                  return H.members[where.userId] ?? null;
                }
                if (model === "teamMember" && method === "findMany") {
                  const where = (args[0] as { where: Record<string, unknown> })
                    .where;
                  if (where.status === "ACTIVE") return H.activeMembers;
                  if (where.suspensionReason) return H.markedSuspended;
                  return [];
                }
                if (
                  model === "workspaceClosureRequest" &&
                  method === "findFirst"
                ) {
                  const where = (args[0] as { where: { status: unknown } })
                    .where;
                  if (typeof where.status === "string")
                    return H.completedClosure;
                  return H.openClosure;
                }
                if (method === "findFirst" || method === "findUnique")
                  return null;
                if (method === "findMany") return [];
                if (method === "count") return 0;
                if (method === "updateMany") return { count: 1 };
                if (method === "create") return { id: "created-1" };
                return {};
              };
            },
          },
        );
      },
    },
  );
}

vi.mock("../src/db.js", () => {
  const base = makeTx();
  return {
    prisma: new Proxy(base as object, {
      get(t, prop: string) {
        if (prop === "$transaction") {
          return async (cb: (tx: unknown) => Promise<unknown>) => cb(makeTx());
        }
        return (t as Record<string, unknown>)[prop];
      },
    }),
  };
});

vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: async () => ({}),
}));

import {
  ORG_WORKSPACE_SUSPENSION_REASON,
  reopenClosedWorkspace,
  resumeOrganizationWorkspace,
  suspendOrganizationWorkspace,
  transferWorkspaceOwnership,
} from "../src/services/workspace/workspace-lifecycle.service.js";

const OWNED_TEAM = {
  id: "t1",
  name: "Acme Evidence",
  ownerUserId: "owner-1",
  billingOwnerUserId: "owner-1",
  isPersonal: false,
  workspaceKind: "OWNED",
  billingPlan: "TEAM",
  organizationId: "org-1",
};

beforeEach(() => {
  H.calls = [];
  H.team = { ...OWNED_TEAM };
  H.members = {
    "owner-1": { id: "m-owner", status: "ACTIVE" },
    "user-2": { id: "m-user2", status: "ACTIVE" },
  };
  H.activeMembers = [{ id: "m-owner" }, { id: "m-user2" }];
  H.markedSuspended = [{ id: "m-user2" }];
  H.openClosure = null;
  H.completedClosure = { id: "closure-1" };
});

const writesTo = (model: string) =>
  H.calls.filter(
    (c) =>
      c.model === model &&
      /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(
        c.method,
      ),
  );

function assertPreservation() {
  expect(H.calls.some((c) => c.model === "evidence")).toBe(false);
  expect(
    H.calls.some((c) => c.method === "delete" || c.method === "deleteMany"),
  ).toBe(false);
}

describe("Phase 4 §7.4 — transferWorkspaceOwnership", () => {
  it("OWNED happy path: team-row owner+billing swap, OWNER/ADMIN legs with provenance", async () => {
    const result = await transferWorkspaceOwnership({
      teamId: "t1",
      actorUserId: "owner-1",
      newOwnerUserId: "user-2",
    });
    expect(result).toEqual({
      teamId: "t1",
      fromUserId: "owner-1",
      toUserId: "user-2",
    });

    const teamUpdates = writesTo("team");
    expect(teamUpdates.length).toBe(1);
    expect((teamUpdates[0].args[0] as { data: unknown }).data).toEqual({
      ownerUserId: "user-2",
      billingOwnerUserId: "user-2",
    });

    const roleUpdates = writesTo("teamMember").map(
      (c) => c.args[0] as { where: { id: string }; data: { role: string } },
    );
    expect(roleUpdates).toEqual([
      { where: { id: "m-user2" }, data: { role: "OWNER" } },
      { where: { id: "m-owner" }, data: { role: "ADMIN" } },
    ]);

    const grants = writesTo("membershipGrant").map(
      (c) =>
        (c.args[0] as { data: Record<string, unknown> }).data as {
          source: string;
          intent: string;
          grantedRole: string | null;
        },
    );
    expect(grants).toMatchObject([
      { source: "MANUAL", intent: "OWNED_WORKSPACE_OWNER", grantedRole: "OWNER" },
      { source: "MANUAL", intent: "ADMIN_ASSIGNMENT", grantedRole: "ADMIN" },
    ]);

    const activity = writesTo("teamActivity");
    expect(
      (activity[0].args[0] as { data: { eventType: string } }).data.eventType,
    ).toBe("workspace_ownership_transferred");
    assertPreservation();
  });

  it("fail-closed kind matrix: PERSONAL / ORGANIZATION / UNKNOWN all refuse", async () => {
    H.team = { ...OWNED_TEAM, workspaceKind: "PERSONAL", isPersonal: true };
    await expect(
      transferWorkspaceOwnership({
        teamId: "t1",
        actorUserId: "owner-1",
        newOwnerUserId: "user-2",
      }),
    ).rejects.toMatchObject({ code: "PERSONAL_WORKSPACE_NOT_TRANSFERABLE" });

    H.team = { ...OWNED_TEAM, workspaceKind: "ORGANIZATION" };
    await expect(
      transferWorkspaceOwnership({
        teamId: "t1",
        actorUserId: "owner-1",
        newOwnerUserId: "user-2",
      }),
    ).rejects.toMatchObject({ code: "ORG_WORKSPACE_OWNERSHIP_IS_ORG_GOVERNED" });

    // PHASE 12 CORRECTIVE PASS §5.2 (ARCH-002, 2026-08-06).
    //
    // This case used to assert that a NULL kind with ENTERPRISE billing
    // resolved to ORGANIZATION, and called that "never silently OWNED". It was
    // silently something either way: the plan decided the tenancy. The kind is
    // now NOT NULL and the classifier fails closed, so an unprovable row
    // refuses with the ambiguity code rather than being classified from what
    // the account happens to pay. The refusal is stronger, not weaker — the
    // transfer is still denied, and now for a reason that is true.
    H.team = { ...OWNED_TEAM, workspaceKind: null, billingPlan: "ENTERPRISE" };
    await expect(
      transferWorkspaceOwnership({
        teamId: "t1",
        actorUserId: "owner-1",
        newOwnerUserId: "user-2",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_KIND_UNKNOWN" });
  });

  it("non-owner actor 403; self-transfer and inactive target refused; no partial writes", async () => {
    await expect(
      transferWorkspaceOwnership({
        teamId: "t1",
        actorUserId: "user-2",
        newOwnerUserId: "owner-1",
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "NOT_WORKSPACE_OWNER" });

    await expect(
      transferWorkspaceOwnership({
        teamId: "t1",
        actorUserId: "owner-1",
        newOwnerUserId: "owner-1",
      }),
    ).rejects.toMatchObject({ code: "TRANSFER_TARGET_IS_OWNER" });

    H.members["user-2"] = { id: "m-user2", status: "REVOKED" };
    await expect(
      transferWorkspaceOwnership({
        teamId: "t1",
        actorUserId: "owner-1",
        newOwnerUserId: "user-2",
      }),
    ).rejects.toMatchObject({ code: "TRANSFER_TARGET_NOT_ACTIVE_MEMBER" });

    // Every refusal above must leave zero mutation calls behind.
    expect(
      H.calls.filter((c) =>
        /^(create|update|updateMany|upsert|delete|deleteMany)$/.test(c.method),
      ),
    ).toEqual([]);
  });
});

describe("Phase 4 §7.4 — reopenClosedWorkspace", () => {
  it("owner-only reopen restores ONLY the owner's membership (revocation bookkeeping cleared)", async () => {
    H.members["owner-1"] = { id: "m-owner", status: "REVOKED" };
    await reopenClosedWorkspace({ teamId: "t1", actorUserId: "owner-1" });

    const memberWrites = writesTo("teamMember");
    expect(memberWrites.length).toBe(1); // ONLY the owner's row
    const data = (memberWrites[0].args[0] as { data: Record<string, unknown> })
      .data;
    expect(data).toMatchObject({
      status: "ACTIVE",
      role: "OWNER",
      revokedAtUtc: null,
      revokedByUserId: null,
      revocationReason: null,
      suspendedAtUtc: null,
    });

    // Safe-by-default: nothing else is restored.
    expect(writesTo("apiCredential")).toEqual([]);
    expect(writesTo("webhookEndpoint")).toEqual([]);
    expect(
      H.calls.some(
        (c) => c.model === "teamMember" && c.method === "updateMany",
      ),
    ).toBe(false);
    assertPreservation();
  });

  it("refuses while a closure request is open, and when nothing completed exists", async () => {
    H.openClosure = { id: "open-1" };
    await expect(
      reopenClosedWorkspace({ teamId: "t1", actorUserId: "owner-1" }),
    ).rejects.toMatchObject({ code: "CLOSURE_IN_PROGRESS" });

    H.openClosure = null;
    H.completedClosure = null;
    await expect(
      reopenClosedWorkspace({ teamId: "t1", actorUserId: "owner-1" }),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_CLOSED" });

    await expect(
      reopenClosedWorkspace({ teamId: "t1", actorUserId: "user-2" }),
    ).rejects.toMatchObject({ statusCode: 403, code: "NOT_WORKSPACE_OWNER" });
  });
});

describe("Phase 4 §7.5 — organization-workspace suspend/resume", () => {
  const ORG_TEAM = { ...OWNED_TEAM, workspaceKind: "ORGANIZATION" };

  it("suspend: memberships → SUSPENDED with marker, switcher cleared, webhooks paused", async () => {
    H.team = { ...ORG_TEAM };
    const result = await suspendOrganizationWorkspace({
      teamId: "t1",
      actorUserId: "admin-1",
      organizationId: "org-1",
    });
    expect(result).toEqual({ teamId: "t1", membersSuspended: 2 });

    const memberMass = H.calls.find(
      (c) => c.model === "teamMember" && c.method === "updateMany",
    );
    expect(
      (memberMass!.args[0] as { data: Record<string, unknown> }).data,
    ).toMatchObject({
      status: "SUSPENDED",
      suspensionReason: ORG_WORKSPACE_SUSPENSION_REASON,
    });

    const userClear = H.calls.find(
      (c) => c.model === "user" && c.method === "updateMany",
    );
    expect(userClear!.args[0]).toMatchObject({
      where: { currentWorkspaceId: "t1" },
      data: { currentWorkspaceId: null },
    });

    const webhook = H.calls.find(
      (c) => c.model === "webhookEndpoint" && c.method === "updateMany",
    );
    expect(webhook!.args[0]).toMatchObject({
      where: { teamId: "t1", status: "ACTIVE" },
      data: { status: "DISABLED" },
    });

    // Reversible: API credentials are NOT burned (enum has no SUSPENDED).
    expect(writesTo("apiCredential")).toEqual([]);
    assertPreservation();
  });

  it("suspend refuses non-organization workspaces and cross-org teamIds", async () => {
    H.team = { ...OWNED_TEAM }; // OWNED
    await expect(
      suspendOrganizationWorkspace({ teamId: "t1", actorUserId: "a" }),
    ).rejects.toMatchObject({ code: "NOT_ORGANIZATION_WORKSPACE" });

    H.team = { ...ORG_TEAM, organizationId: "org-OTHER" };
    await expect(
      suspendOrganizationWorkspace({
        teamId: "t1",
        actorUserId: "a",
        organizationId: "org-1",
      }),
    ).rejects.toMatchObject({ code: "TEAM_NOT_IN_ORGANIZATION" });
  });

  it("resume reactivates ONLY marker-suspended rows; webhooks stay disabled", async () => {
    H.team = { ...ORG_TEAM };
    const result = await resumeOrganizationWorkspace({
      teamId: "t1",
      actorUserId: "admin-1",
      organizationId: "org-1",
    });
    expect(result).toEqual({ teamId: "t1", membersReactivated: 1 });

    // The find is scoped to the canonical marker reason — individually
    // suspended/revoked members are untouched.
    const find = H.calls.find(
      (c) => c.model === "teamMember" && c.method === "findMany",
    );
    expect(find!.args[0]).toMatchObject({
      where: {
        teamId: "t1",
        status: "SUSPENDED",
        suspensionReason: ORG_WORKSPACE_SUSPENSION_REASON,
      },
    });

    expect(writesTo("webhookEndpoint")).toEqual([]);
    assertPreservation();
  });
});

describe("Phase 4 §7.4/§7.5 — route registration source contracts", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

  it("teams.routes registers transfer-ownership + reopen", () => {
    const src = readFileSync(join(ROOT, "routes", "teams.routes.ts"), "utf8");
    expect(src).toContain('"/v1/teams/:id/transfer-ownership"');
    expect(src).toContain('"/v1/teams/:id/reopen"');
    expect(src).toContain("workspace_ownership_transfer"); // step-up gate
  });

  it("organizations.routes registers workspace suspend/resume behind ORG_ADMIN", () => {
    const src = readFileSync(
      join(ROOT, "routes", "organizations.routes.ts"),
      "utf8",
    );
    expect(src).toContain("/v1/orgs/:id/workspaces/:teamId/");
    expect(src).toContain("suspendOrganizationWorkspace");
    expect(src).toContain("resumeOrganizationWorkspace");
  });
});
