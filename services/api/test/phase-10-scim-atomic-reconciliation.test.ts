/**
 * PHASE 10 hardening Fix 2 — SCIM update / group reconciliation is ATOMIC and
 * EXPLICIT. Ownership reconciliation + role transition share ONE transaction;
 * a cross-org / unresolved member fails the whole operation with an explicit
 * SCIM error (never a silent skip / partial state); a role failure after
 * reconciliation rolls the reconciliation back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({
  orgId: "org-A" as string | null,
  managedRequired: true,
  // per-user managed state (default STANDARD).
  managedByUser: {} as Record<string, { state: string; managingOrganizationId: string | null }>,
  provisionCalls: [] as string[],
  roleChangeCalls: [] as string[],
  roleChangeThrows: false,
  txEntered: 0,
  txRolledBack: 0,
}));

vi.mock("../src/services/identity/org-security-policy.service.js", () => ({
  organizationIdForPolicy: async () => S.orgId,
  resolveOrganizationPolicy: async () =>
    S.orgId
      ? { applicability: "ORGANIZATION", organizationId: S.orgId, policy: { managedIdentityRequired: S.managedRequired } }
      : { applicability: "NOT_APPLICABLE", reason: "PERSONAL" },
}));
vi.mock("../src/services/identity/identity-mode.service.js", () => ({
  resolveManagedIdentity: async (userId: string) =>
    S.managedByUser[userId] ?? { state: "STANDARD", managingOrganizationId: null },
}));
vi.mock("../src/services/identity/membership-provisioning.service.js", () => ({
  provisionManagedMembership: async (_tx: unknown, input: { userId: string }) => {
    S.provisionCalls.push(input.userId);
    return { managedBound: true };
  },
  applyDirectoryRoleChange: async (_c: unknown, input: { teamMemberId: string }) => {
    S.roleChangeCalls.push(input.teamMemberId);
    if (S.roleChangeThrows) throw new Error("role_change_failed");
    return { changed: true };
  },
  provisionMembership: async () => ({ organizationMembershipCreated: true, workspaceGrants: 1, failedAssignments: [] }),
  suspendWorkspaceMembership: async () => {},
  demoteGroupMappedRoleOnArchive: async () => {},
}));
// Telemetry/audit → no-ops (avoid real DB).
vi.mock("../src/services/security/security-event.service.js", () => ({ safeEmitSecurityEvent: () => {} }));
vi.mock("../src/services/platform-audit-log.service.js", () => ({ appendPlatformAuditLog: async () => {} }));
vi.mock("../src/services/ops/metrics.service.js", () => ({ bump: () => {}, setGauge: () => {} }));

import { scimUpdateUserAttributes } from "../src/services/access-control/scim.service.js";
import { scimPatchGroup } from "../src/services/access-control/scim-groups.service.js";

// A prisma mock whose $transaction SIMULATES rollback: on throw, the recorded
// mutation log is truncated back to the pre-transaction mark.
function makeClient(members: Record<string, { id: string; role: string; status: string }>) {
  const writes: string[] = [];
  const c: Record<string, unknown> = {
    _writes: writes,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      S.txEntered += 1;
      const mark = writes.length;
      try {
        return await fn(c);
      } catch (e) {
        writes.length = mark; // rollback
        S.txRolledBack += 1;
        throw e;
      }
    },
    teamMember: {
      findUnique: async ({ where }: { where: { teamId_userId: { userId: string } } }) => members[where.teamId_userId.userId] ?? null,
      findFirst: async ({ where }: { where: { userId: string } }) => members[where.userId] ?? null,
      findMany: async () => [], // buildResource member list (orthogonal to atomicity)
    },
    externalIdentityMapping: {
      findFirst: async () => ({ id: "map-1" }),
      update: async () => { writes.push("mapping.update"); return {}; },
    },
    scimGroup: {
      findFirst: async () => ({ id: "grp-1", teamId: "team-1", status: "ACTIVE", mappedRole: "MEMBER", displayName: "G", externalId: null, createdAt: new Date(0), updatedAt: new Date(0) }),
      findUnique: async () => ({ id: "grp-1", teamId: "team-1", status: "ACTIVE", mappedRole: "MEMBER", displayName: "G", externalId: null, createdAt: new Date(0), updatedAt: new Date(0) }),
      update: async () => { writes.push("group.update"); return {}; },
    },
  };
  return c;
}

const CTX = { teamId: "team-1", tokenId: "tok-1" } as never;

beforeEach(() => {
  S.orgId = "org-A";
  S.managedRequired = true;
  S.managedByUser = {};
  S.provisionCalls = [];
  S.roleChangeCalls = [];
  S.roleChangeThrows = false;
  S.txEntered = 0;
  S.txRolledBack = 0;
});
afterEach(() => vi.clearAllMocks());

describe("Fix 2 — SCIM UPDATE atomic reconciliation", () => {
  it("reconcile + role success runs in ONE transaction", async () => {
    const client = makeClient({ u1: { id: "m1", role: "MEMBER", status: "ACTIVE" } });
    const res = await scimUpdateUserAttributes(CTX, "u1", { role: "VIEWER" }, client as never);
    expect(res.ok).toBe(true);
    expect(S.txEntered).toBe(1);
    expect(S.provisionCalls).toContain("u1"); // STANDARD+required → reconciled
    expect(S.roleChangeCalls).toContain("m1"); // then role applied — same tx
  });

  it("role transition FAILURE rolls back the managed reconciliation (fail closed)", async () => {
    S.roleChangeThrows = true;
    const client = makeClient({ u1: { id: "m1", role: "MEMBER", status: "ACTIVE" } });
    await expect(scimUpdateUserAttributes(CTX, "u1", { role: "VIEWER" }, client as never)).rejects.toThrow(/role_change_failed/);
    expect(S.provisionCalls).toContain("u1"); // reconciliation was attempted…
    expect(S.txRolledBack).toBe(1); // …and rolled back atomically with the role failure
  });

  it("cross-org member → explicit 409 SCIM error, ZERO mutation", async () => {
    S.managedByUser["u1"] = { state: "MANAGED", managingOrganizationId: "org-B" };
    const client = makeClient({ u1: { id: "m1", role: "MEMBER", status: "ACTIVE" } });
    const res = await scimUpdateUserAttributes(CTX, "u1", { role: "VIEWER" }, client as never);
    expect(res).toMatchObject({ ok: false, status: 409, detail: "managed_cross_org_conflict" });
    expect(S.roleChangeCalls).toHaveLength(0); // no role write
    expect((client as { _writes: string[] })._writes).toHaveLength(0); // zero mutation
  });

  it("MANAGED_UNRESOLVED member → explicit 409 error, zero mutation", async () => {
    S.managedByUser["u1"] = { state: "MANAGED_UNRESOLVED", managingOrganizationId: null };
    const client = makeClient({ u1: { id: "m1", role: "MEMBER", status: "ACTIVE" } });
    const res = await scimUpdateUserAttributes(CTX, "u1", { role: "VIEWER" }, client as never);
    expect(res).toMatchObject({ ok: false, status: 409, detail: "managed_identity_unresolved" });
    expect(S.roleChangeCalls).toHaveLength(0);
  });
});

describe("Fix 2 — SCIM GROUP PATCH atomic (no silent skip)", () => {
  const groupPatch = (userIds: string[]) => ({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "add", path: "members", value: userIds.map((v) => ({ value: v })) }],
  });

  it("one cross-org member fails the WHOLE PATCH atomically (explicit error, no partial state)", async () => {
    S.managedByUser["bad"] = { state: "MANAGED", managingOrganizationId: "org-B" };
    const client = makeClient({
      good: { id: "mg", role: "MEMBER", status: "ACTIVE" },
      bad: { id: "mb", role: "MEMBER", status: "ACTIVE" },
    });
    const res = await scimPatchGroup(CTX, "grp-1", groupPatch(["good", "bad"]) as never, client as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
    expect(S.txRolledBack).toBe(1); // whole PATCH rolled back — no silent skip
  });

  it("all-valid members apply in one transaction (idempotent role no-ops short-circuit)", async () => {
    const client = makeClient({ a: { id: "ma", role: "MEMBER", status: "ACTIVE" }, b: { id: "mb", role: "MEMBER", status: "ACTIVE" } });
    const res = await scimPatchGroup(CTX, "grp-1", groupPatch(["a", "b"]) as never, client as never);
    expect(res.ok).toBe(true);
    expect(S.txEntered).toBe(1);
    expect(S.txRolledBack).toBe(0);
  });
});
