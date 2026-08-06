/**
 * PHASE 10 §0B — MANAGED IDENTITY OWNERSHIP (unit, real authority).
 *
 * `User.identityMode` is a GLOBAL flag. On its own it must NOT let Organization
 * A govern the user's Personal scope or Organization B. The canonical
 * managed-identity authority (`identity-mode.service.ts`) now binds the managed
 * flag to exactly ONE managing Organization + verified provenance, and:
 *   - an UNOWNED managed flag is NOT authoritative (fail-safe → not managed);
 *   - Org A's managed policy applies ONLY to identities managed BY Org A;
 *   - a management CONFLICT (Org B claiming an A-managed identity) fails closed;
 *   - releasing management is owner-scoped (Org B cannot release Org A's).
 *
 * These run against the REAL service with an in-memory prisma stub (no DB).
 */

import { describe, expect, it } from "vitest";

import {
  resolveManagedIdentity,
  isManagedEnterprise,
  isManagedByOrganization,
  setManagedIdentity,
  releaseManagedIdentity,
  personalSpaceAllowed,
} from "../src/services/identity/identity-mode.service.js";

type Row = {
  identityMode?: string | null;
  managingOrganizationId?: string | null;
  managedIdentitySource?: string | null;
  managedBySsoConnectionId?: string | null;
};

/** Minimal prisma stub: one `users` row + an optional SCIM connection. */
function stub(row: Row, connOrgId: string | null = "org-A") {
  const state: Row = { ...row };
  return {
    prisma: {
      user: {
        findUnique: async () => ({ ...state }),
        update: async ({ data }: { data: Row }) => {
          Object.assign(state, data);
          return { ...state };
        },
      },
      // A valid ACTIVE SCIM provisioning token whose team is owned by `connOrgId`
      // — the persistence-verified evidence path (§9) loads this for SCIM writes.
      scimProvisioningToken: {
        findUnique: async () =>
          connOrgId ? { status: "ACTIVE", team: { organizationId: connOrgId } } : null,
      },
      // PHASE 12 POINT 7 — the personal-space decision now also reads the
      // Organization's `noPersonalSpace` policy. This stub answers "no
      // Organization the user belongs to forbids it", which is what every
      // assertion in THIS suite (an identity-ownership suite) assumes.
      organizationSecurityPolicy: { findMany: async () => [] },
    } as never,
    read: () => state,
  };
}

describe("§0B/correction 2 — unowned managed flag is UNRESOLVED, never STANDARD", () => {
  it("MANAGED with no managing Org → MANAGED_UNRESOLVED (NOT managed, NOT standard)", async () => {
    const { prisma } = stub({ identityMode: "MANAGED_ENTERPRISE", managingOrganizationId: null });
    const mi = await resolveManagedIdentity("u1", prisma);
    expect(mi.state).toBe("MANAGED_UNRESOLVED");
    expect(mi.managed).toBe(false); // not authoritatively managed
    expect(await isManagedEnterprise("u1", prisma)).toBe(false);
    // …but it is NOT downgraded to STANDARD: Personal bootstrap is DENIED.
    expect(await personalSpaceAllowed("u1", prisma)).toBe(false);
  });

  it("MANAGED + deleted/missing owner (FK SET NULL) → UNRESOLVED, not STANDARD", async () => {
    // The FK is ON DELETE SET NULL; identityMode is NOT cleared, so a deleted
    // managing Org leaves the row MANAGED_UNRESOLVED (fail closed), never a
    // silent MANAGED→NULL→STANDARD Personal-privilege restoration.
    const { prisma } = stub({ identityMode: "MANAGED_ENTERPRISE", managingOrganizationId: null, managedIdentitySource: "SCIM" });
    const mi = await resolveManagedIdentity("u1", prisma);
    expect(mi.state).toBe("MANAGED_UNRESOLVED");
    expect(await personalSpaceAllowed("u1", prisma)).toBe(false);
  });

  it("STANDARD identity → personal space allowed", async () => {
    const { prisma } = stub({ identityMode: "STANDARD", managingOrganizationId: null });
    const mi = await resolveManagedIdentity("u1", prisma);
    expect(mi.state).toBe("STANDARD");
    expect(await personalSpaceAllowed("u1", prisma)).toBe(true);
  });

  it("correction 1 — an INFRA read failure PROPAGATES (fail closed), not swallowed to STANDARD", async () => {
    const prisma = {
      user: {
        findUnique: async () => { throw new Error("INFRA_FAILURE"); },
        update: async () => ({}),
      },
    } as never;
    await expect(resolveManagedIdentity("u1", prisma)).rejects.toThrow("INFRA_FAILURE");
  });

  it("schema unavailability (P2022/P2021) FAILS CLOSED → 503, never STANDARD", async () => {
    // Deployment order is schema-before-code: a missing column is NOT evidence
    // the identity is STANDARD — it is a typed security-schema-unavailable
    // failure that every caller denies.
    const mk = (code: string) => ({
      user: {
        findUnique: async () => { const e = new Error("schema") as Error & { code?: string }; e.code = code; throw e; },
        update: async () => ({}),
      },
    } as never);
    await expect(resolveManagedIdentity("u1", mk("P2022"))).rejects.toMatchObject({ statusCode: 503, code: "SECURITY_SCHEMA_UNAVAILABLE" });
    await expect(resolveManagedIdentity("u1", mk("P2021"))).rejects.toMatchObject({ code: "SECURITY_SCHEMA_UNAVAILABLE" });
  });

  it("MANAGED_ENTERPRISE owned by Org-A → authoritative + org-scoped", async () => {
    const { prisma } = stub({ identityMode: "MANAGED_ENTERPRISE", managingOrganizationId: "org-A", managedIdentitySource: "SCIM" });
    expect(await isManagedEnterprise("u1", prisma)).toBe(true);
    expect(await isManagedByOrganization("u1", "org-A", prisma)).toBe(true);
    // Org-B does NOT manage this identity.
    expect(await isManagedByOrganization("u1", "org-B", prisma)).toBe(false);
  });
});

describe("§0B — management is org-owned; conflict fails closed", () => {
  it("Org-B cannot re-claim an identity already managed by Org-A", async () => {
    // Valid SCIM connection owned by org-B (evidence passes) → reaches conflict.
    const { prisma } = stub({ identityMode: "MANAGED_ENTERPRISE", managingOrganizationId: "org-A" }, "org-B");
    await expect(
      setManagedIdentity({ userId: "u1", managingOrganizationId: "org-B", evidence: { source: "SCIM", scimTokenId: "tok-B" } }, prisma),
    ).rejects.toMatchObject({ code: "MANAGED_IDENTITY_CONFLICT" });
  });

  it("setting management requires a managing Organization", async () => {
    const { prisma } = stub({ identityMode: "STANDARD", managingOrganizationId: null });
    await expect(
      setManagedIdentity({ userId: "u1", managingOrganizationId: "", evidence: { source: "SCIM", scimTokenId: "tok-A" } }, prisma),
    ).rejects.toMatchObject({ code: "MANAGED_IDENTITY_UNOWNED" });
  });

  it("§9 — a SCIM connection NOT owned by the managing Org is rejected (persistence-verified)", async () => {
    // The stub's connection is owned by org-OTHER, not the managing org-A.
    const { prisma, read } = stub({ identityMode: "STANDARD", managingOrganizationId: null }, "org-OTHER");
    await expect(
      setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "SCIM", scimTokenId: "tok-X" } }, prisma),
    ).rejects.toMatchObject({ code: "MANAGED_IDENTITY_SOURCE_INVALID" });
    expect(read().identityMode).toBe("STANDARD"); // no write
  });

  it("idempotent same-Org re-set with DB-verified SCIM evidence records provenance", async () => {
    const { prisma, read } = stub({ identityMode: "STANDARD", managingOrganizationId: null }, "org-A");
    await setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "SCIM", scimTokenId: "tok-A" } }, prisma);
    expect(read().identityMode).toBe("MANAGED_ENTERPRISE");
    expect(read().managingOrganizationId).toBe("org-A");
    expect(read().managedIdentitySource).toBe("SCIM");
    // Same Org again → no conflict.
    await expect(
      setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "SCIM", scimTokenId: "tok-A" } }, prisma),
    ).resolves.toBeUndefined();
  });
});

describe("§0B — release is owner-scoped (deprovision A never touches B)", () => {
  it("Org-B cannot release Org-A's management (fail closed, no mutation)", async () => {
    const { prisma, read } = stub({ identityMode: "MANAGED_ENTERPRISE", managingOrganizationId: "org-A" });
    const released = await releaseManagedIdentity({ userId: "u1", managingOrganizationId: "org-B" }, prisma);
    expect(released).toBe(false);
    // Still managed by Org-A — untouched.
    expect(read().identityMode).toBe("MANAGED_ENTERPRISE");
    expect(read().managingOrganizationId).toBe("org-A");
  });

  it("Org-A releasing its own management clears the binding to STANDARD", async () => {
    const { prisma, read } = stub({ identityMode: "MANAGED_ENTERPRISE", managingOrganizationId: "org-A", managedIdentitySource: "SCIM" });
    const released = await releaseManagedIdentity({ userId: "u1", managingOrganizationId: "org-A" }, prisma);
    expect(released).toBe(true);
    expect(read().identityMode).toBe("STANDARD");
    expect(read().managingOrganizationId).toBeNull();
    expect(read().managedIdentitySource).toBeNull();
  });
});
