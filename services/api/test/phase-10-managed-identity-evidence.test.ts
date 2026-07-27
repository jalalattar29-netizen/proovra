/**
 * PHASE 10 §6/§9 — PERSISTENCE-VERIFIED managed-identity source evidence.
 *
 * `setManagedIdentity` loads every source identifier from the DB and validates
 * it against the managing Organization — it NEVER trusts caller-asserted truth
 * (no caller-supplied tenant/org id is accepted as proof). Every invalid case
 * performs ZERO identity/session/membership mutation.
 */

import { describe, expect, it } from "vitest";

import { setManagedIdentity } from "../src/services/identity/identity-mode.service.js";

/**
 * Stub with a configurable SsoConnection + OrganizationDomain and a STANDARD
 * user (so a valid write would flip it to MANAGED). Records writes.
 */
function stub(opts: {
  conn?: { status: string; provider: string; orgId: string | null } | null;
  scimTok?: { status: string; orgId: string | null } | null;
  domain?: { organizationId: string; domain: string; verifiedAt: Date | null } | null;
}) {
  const writes: string[] = [];
  const prisma = {
    user: {
      findUnique: async () => ({ identityMode: "STANDARD", managingOrganizationId: null, managedIdentitySource: null, managedBySsoConnectionId: null }),
      update: async () => { writes.push("user.update"); return {}; },
    },
    ssoConnection: {
      findUnique: async () => (opts.conn ? { status: opts.conn.status, provider: opts.conn.provider, team: { organizationId: opts.conn.orgId } } : null),
    },
    scimProvisioningToken: {
      findUnique: async () => (opts.scimTok ? { status: opts.scimTok.status, team: { organizationId: opts.scimTok.orgId } } : null),
    },
    organizationDomain: {
      findUnique: async () => opts.domain ?? null,
    },
  } as never;
  return { prisma, writes };
}

const INVALID = { code: "MANAGED_IDENTITY_SOURCE_INVALID" };

describe("§9 — SAML/OIDC/SCIM evidence is DB-verified", () => {
  it("valid ACTIVE SAML connection owned by the org → written", async () => {
    const { prisma, writes } = stub({ conn: { status: "ACTIVE", provider: "GENERIC_SAML", orgId: "org-A" } });
    await setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "SAML", ssoConnectionId: "c1" } }, prisma);
    expect(writes).toContain("user.update");
  });

  it("valid ACTIVE SCIM token whose team is owned by the org → written", async () => {
    const { prisma, writes } = stub({ scimTok: { status: "ACTIVE", orgId: "org-A" } });
    await setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "SCIM", scimTokenId: "t1" } }, prisma);
    expect(writes).toContain("user.update");
  });

  it("REVOKED SSO connection → rejected, zero mutation", async () => {
    const { prisma, writes } = stub({ conn: { status: "REVOKED", provider: "GENERIC_SAML", orgId: "org-A" } });
    await expect(setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "SAML", ssoConnectionId: "c1" } }, prisma)).rejects.toMatchObject(INVALID);
    expect(writes).toEqual([]);
  });

  it("missing/deleted SSO connection → rejected, zero mutation", async () => {
    const { prisma, writes } = stub({ conn: null });
    await expect(setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "OIDC", ssoConnectionId: "c1" } }, prisma)).rejects.toMatchObject(INVALID);
    expect(writes).toEqual([]);
  });

  it("SSO connection owned by a DIFFERENT org → rejected, zero mutation", async () => {
    const { prisma, writes } = stub({ conn: { status: "ACTIVE", provider: "GENERIC_OIDC", orgId: "org-B" } });
    await expect(setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "OIDC", ssoConnectionId: "c1" } }, prisma)).rejects.toMatchObject(INVALID);
    expect(writes).toEqual([]);
  });

  it("REVOKED/inactive SCIM token → rejected, zero mutation", async () => {
    const { prisma, writes } = stub({ scimTok: { status: "REVOKED", orgId: "org-A" } });
    await expect(setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "SCIM", scimTokenId: "t1" } }, prisma)).rejects.toMatchObject(INVALID);
    expect(writes).toEqual([]);
  });

  it("missing/deleted SCIM token → rejected", async () => {
    const { prisma, writes } = stub({ scimTok: null });
    await expect(setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "SCIM", scimTokenId: "t1" } }, prisma)).rejects.toMatchObject(INVALID);
    expect(writes).toEqual([]);
  });

  it("a forged SCIM org (caller cannot assert org via a raw value) — only the token's team owner counts", async () => {
    // The caller supplies only a token id; the org comes from the DB row's team.
    // A token whose team is org-OTHER cannot manage org-A no matter what caller wants.
    const { prisma, writes } = stub({ scimTok: { status: "ACTIVE", orgId: "org-OTHER" } });
    await expect(setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "SCIM", scimTokenId: "t1" } }, prisma)).rejects.toMatchObject(INVALID);
    expect(writes).toEqual([]);
  });
});

describe("§9 — DOMAIN evidence is DB-verified (verified + org + email match)", () => {
  it("valid verified domain owned by org + matching email → written", async () => {
    const { prisma, writes } = stub({ domain: { organizationId: "org-A", domain: "acme.com", verifiedAt: new Date() } });
    await setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "DOMAIN", organizationDomainId: "d1", userEmail: "jo@acme.com" } }, prisma);
    expect(writes).toContain("user.update");
  });

  it("UNVERIFIED domain → rejected, zero mutation", async () => {
    const { prisma, writes } = stub({ domain: { organizationId: "org-A", domain: "acme.com", verifiedAt: null } });
    await expect(setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "DOMAIN", organizationDomainId: "d1", userEmail: "jo@acme.com" } }, prisma)).rejects.toMatchObject(INVALID);
    expect(writes).toEqual([]);
  });

  it("verified domain owned by ANOTHER org → rejected", async () => {
    const { prisma, writes } = stub({ domain: { organizationId: "org-B", domain: "acme.com", verifiedAt: new Date() } });
    await expect(setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "DOMAIN", organizationDomainId: "d1", userEmail: "jo@acme.com" } }, prisma)).rejects.toMatchObject(INVALID);
    expect(writes).toEqual([]);
  });

  it("user email domain does NOT match the verified domain → rejected", async () => {
    const { prisma, writes } = stub({ domain: { organizationId: "org-A", domain: "acme.com", verifiedAt: new Date() } });
    await expect(setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "DOMAIN", organizationDomainId: "d1", userEmail: "jo@evil.com" } }, prisma)).rejects.toMatchObject(INVALID);
    expect(writes).toEqual([]);
  });

  it("missing domain row → rejected", async () => {
    const { prisma, writes } = stub({ domain: null });
    await expect(setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "DOMAIN", organizationDomainId: "d1", userEmail: "jo@acme.com" } }, prisma)).rejects.toMatchObject(INVALID);
    expect(writes).toEqual([]);
  });
});

describe("§9 — machine metric: evidence trusted without DB verification = 0", () => {
  it("the evidence union carries IDs (not caller-asserted org truth) and every path loads from DB", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../src/services/identity/identity-mode.service.ts"), "utf8");
    // The evidence union no longer accepts caller-supplied org ids as proof.
    expect(src).not.toMatch(/scimTenantOrganizationId|verifiedDomainOrganizationId/);
    // SAML/OIDC/SCIM load the connection; DOMAIN loads the OrganizationDomain.
    expect(src).toMatch(/ssoConnection\.findUnique/);
    expect(src).toMatch(/organizationDomain\.findUnique/);
  });
});
