/**
 * PHASE 10 closure Fix 2 — SCIM managed-ownership invariant is ENFORCED (not
 * assumed) on every SCIM mutation. Behavioral: drives the real
 * `enforceScimManagedOwnership` composer with the four canonical authorities
 * mocked, asserting each disposition + zero-mutation on conflict/unresolved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const A = vi.hoisted(() => ({
  orgId: "org-A" as string | null,
  managedRequired: true,
  managed: {
    state: "STANDARD" as "STANDARD" | "MANAGED" | "MANAGED_UNRESOLVED",
    managingOrganizationId: null as string | null,
  },
  managedThrows: null as null | Error,
  provisionCalls: 0,
}));

vi.mock("../src/services/identity/org-security-policy.service.js", () => ({
  organizationIdForPolicy: async () => A.orgId,
  resolveOrganizationPolicy: async () =>
    A.orgId
      ? { applicability: "ORGANIZATION", organizationId: A.orgId, policy: { managedIdentityRequired: A.managedRequired } }
      : { applicability: "NOT_APPLICABLE", reason: "PERSONAL" },
}));
vi.mock("../src/services/identity/identity-mode.service.js", () => ({
  resolveManagedIdentity: async () => {
    if (A.managedThrows) throw A.managedThrows;
    return { state: A.managed.state, managed: A.managed.state === "MANAGED", managingOrganizationId: A.managed.managingOrganizationId };
  },
}));
vi.mock("../src/services/identity/membership-provisioning.service.js", () => ({
  provisionManagedMembership: async () => {
    A.provisionCalls += 1;
    return { managedBound: true };
  },
}));

import {
  enforceScimManagedOwnership,
  ScimManagedOwnershipError,
} from "../src/services/access-control/scim-managed-ownership.service.js";

const CTX = { teamId: "team-1", tokenId: "tok-1" };
const client = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) } as never;

beforeEach(() => {
  A.orgId = "org-A";
  A.managedRequired = true;
  A.managed = { state: "STANDARD", managingOrganizationId: null };
  A.managedThrows = null;
  A.provisionCalls = 0;
});
afterEach(() => vi.clearAllMocks());

describe("Fix 2 — enforceScimManagedOwnership dispositions", () => {
  it("non-CUSTOMER target → NOT_APPLICABLE, zero provisioning", async () => {
    A.orgId = null;
    expect(await enforceScimManagedOwnership(CTX, { userId: "u1" }, client)).toBe("NOT_APPLICABLE");
    expect(A.provisionCalls).toBe(0);
  });

  it("MANAGED by THIS org → IDEMPOTENT, zero provisioning", async () => {
    A.managed = { state: "MANAGED", managingOrganizationId: "org-A" };
    expect(await enforceScimManagedOwnership(CTX, { userId: "u1" }, client)).toBe("IDEMPOTENT");
    expect(A.provisionCalls).toBe(0);
  });

  it("MANAGED by ANOTHER org → cross-org conflict, ZERO mutation", async () => {
    A.managed = { state: "MANAGED", managingOrganizationId: "org-B" };
    const err = await enforceScimManagedOwnership(CTX, { userId: "u1" }, client).catch((e) => e);
    expect(err).toBeInstanceOf(ScimManagedOwnershipError);
    expect((err as ScimManagedOwnershipError).code).toBe("SCIM_MANAGED_CROSS_ORG_CONFLICT");
    expect(A.provisionCalls).toBe(0);
  });

  it("MANAGED_UNRESOLVED → fail closed, ZERO mutation", async () => {
    A.managed = { state: "MANAGED_UNRESOLVED", managingOrganizationId: null };
    const err = await enforceScimManagedOwnership(CTX, { userId: "u1" }, client).catch((e) => e);
    expect((err as ScimManagedOwnershipError).code).toBe("SCIM_MANAGED_UNRESOLVED");
    expect(A.provisionCalls).toBe(0);
  });

  it("STANDARD + policy does NOT require managed → allowed, zero provisioning", async () => {
    A.managed = { state: "STANDARD", managingOrganizationId: null };
    A.managedRequired = false;
    expect(await enforceScimManagedOwnership(CTX, { userId: "u1" }, client)).toBe("STANDARD_ALLOWED");
    expect(A.provisionCalls).toBe(0);
  });

  it("STANDARD + policy REQUIRES managed → RECONCILED via the atomic intent BEFORE the mutation", async () => {
    A.managed = { state: "STANDARD", managingOrganizationId: null };
    A.managedRequired = true;
    expect(await enforceScimManagedOwnership(CTX, { userId: "u1", workspaceRole: "MEMBER" }, client)).toBe("RECONCILED");
    expect(A.provisionCalls).toBe(1); // bind + seat + membership ran
  });

  it("schema-unavailable (resolveManagedIdentity throws) → propagates (fail closed)", async () => {
    A.managedThrows = Object.assign(new Error("schema"), { code: "SECURITY_SCHEMA_UNAVAILABLE" });
    await expect(enforceScimManagedOwnership(CTX, { userId: "u1" }, client)).rejects.toThrow(/schema/);
    expect(A.provisionCalls).toBe(0);
  });
});
