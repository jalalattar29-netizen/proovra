/**
 * PHASE 10 §13.2 + §0B corrections — managed-identity mode primitive.
 *
 * MANAGED (owner + valid source): no personal space, no personal export.
 * MANAGED_UNRESOLVED (managed signal, missing/invalid ownership or source):
 *   fails closed — no personal space/export, NOT downgraded to STANDARD.
 * SCHEMA UNAVAILABILITY (P2021/P2022 / absent client field): FAILS CLOSED with
 *   a typed SECURITY_SCHEMA_UNAVAILABLE (503) — NEVER interpreted as STANDARD.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  throwCode: null as string | null,
  throwMessage: null as string | null,
  conn: null as { status: string; team: { organizationId: string | null } | null } | null,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    user: {
      findUnique: async () => {
        if (H.throwCode || H.throwMessage) {
          const e = new Error(H.throwMessage ?? "db") as Error & { code?: string };
          if (H.throwCode) e.code = H.throwCode;
          throw e;
        }
        return H.row;
      },
    },
    ssoConnection: {
      findUnique: async () => H.conn,
    },
  },
}));

import {
  assertPersonalExportAllowed,
  isManagedEnterprise,
  personalSpaceAllowed,
  resolveManagedIdentity,
} from "../src/services/identity/identity-mode.service.js";

beforeEach(() => {
  H.row = { identityMode: "STANDARD", managingOrganizationId: null, managedIdentitySource: null, managedBySsoConnectionId: null };
  H.throwCode = null;
  H.throwMessage = null;
  H.conn = null;
});

describe("Phase 10 — identity mode resolution (owner + source integrity)", () => {
  it("STANDARD identity → STANDARD, not managed", async () => {
    const mi = await resolveManagedIdentity("u1");
    expect(mi.state).toBe("STANDARD");
    expect(await isManagedEnterprise("u1")).toBe(false);
  });

  it("MANAGED + owner + valid SCIM source → MANAGED", async () => {
    H.row = { identityMode: "MANAGED_ENTERPRISE", managingOrganizationId: "org-A", managedIdentitySource: "SCIM", managedBySsoConnectionId: null };
    const mi = await resolveManagedIdentity("u1");
    expect(mi.state).toBe("MANAGED");
    expect(await isManagedEnterprise("u1")).toBe(true);
  });

  it("SCHEMA UNAVAILABLE (P2022/P2021/absent field) → FAILS CLOSED (503), never STANDARD", async () => {
    H.throwCode = "P2022";
    await expect(resolveManagedIdentity("u1")).rejects.toMatchObject({ statusCode: 503, code: "SECURITY_SCHEMA_UNAVAILABLE" });
    H.throwCode = "P2021";
    await expect(resolveManagedIdentity("u1")).rejects.toMatchObject({ code: "SECURITY_SCHEMA_UNAVAILABLE" });
    H.throwCode = null;
    H.throwMessage = "Unknown field `managingOrganizationId` for select statement";
    await expect(resolveManagedIdentity("u1")).rejects.toMatchObject({ code: "SECURITY_SCHEMA_UNAVAILABLE" });
  });

  it("MANAGED signal with no owner → MANAGED_UNRESOLVED denies personal space + export", async () => {
    H.row = { identityMode: "MANAGED_ENTERPRISE", managingOrganizationId: null, managedIdentitySource: null, managedBySsoConnectionId: null };
    expect((await resolveManagedIdentity("u1")).state).toBe("MANAGED_UNRESOLVED");
    expect(await personalSpaceAllowed("u1")).toBe(false);
    await expect(assertPersonalExportAllowed("u1")).rejects.toMatchObject({
      statusCode: 403,
      code: "MANAGED_IDENTITY_NO_PERSONAL_EXPORT",
    });
  });

  it("standard identity: personal space + export allowed", async () => {
    expect(await personalSpaceAllowed("u1")).toBe(true);
    await expect(assertPersonalExportAllowed("u1")).resolves.toBeUndefined();
  });
});

describe("Phase 10 item 2 — management SOURCE integrity", () => {
  const managedSaml = (connId: string | null) => {
    H.row = { identityMode: "MANAGED_ENTERPRISE", managingOrganizationId: "org-A", managedIdentitySource: "SAML", managedBySsoConnectionId: connId };
  };

  it("valid SAML source (ACTIVE connection owned by the org) → MANAGED", async () => {
    managedSaml("conn-A"); H.conn = { status: "ACTIVE", team: { organizationId: "org-A" } };
    expect((await resolveManagedIdentity("u1")).state).toBe("MANAGED");
  });
  it("SAML source connection REVOKED/inactive → MANAGED_UNRESOLVED", async () => {
    managedSaml("conn-A"); H.conn = { status: "REVOKED", team: { organizationId: "org-A" } };
    expect((await resolveManagedIdentity("u1")).state).toBe("MANAGED_UNRESOLVED");
  });
  it("SAML source connection DELETED/missing → MANAGED_UNRESOLVED", async () => {
    managedSaml("conn-A"); H.conn = null;
    expect((await resolveManagedIdentity("u1")).state).toBe("MANAGED_UNRESOLVED");
  });
  it("SAML source connection owned by WRONG org → MANAGED_UNRESOLVED", async () => {
    managedSaml("conn-A"); H.conn = { status: "ACTIVE", team: { organizationId: "org-B" } };
    expect((await resolveManagedIdentity("u1")).state).toBe("MANAGED_UNRESOLVED");
  });
  it("SAML source with NO connection bound → MANAGED_UNRESOLVED", async () => {
    managedSaml(null);
    expect((await resolveManagedIdentity("u1")).state).toBe("MANAGED_UNRESOLVED");
  });
  it("null/unknown source with owner → MANAGED_UNRESOLVED (no proven source)", async () => {
    H.row = { identityMode: "MANAGED_ENTERPRISE", managingOrganizationId: "org-A", managedIdentitySource: null, managedBySsoConnectionId: null };
    expect((await resolveManagedIdentity("u1")).state).toBe("MANAGED_UNRESOLVED");
  });
});

describe("Phase 10 — bootstrap + export guards (source contract)", () => {
  const apiSrc = (rel: string) =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", rel), "utf8");

  it("ensurePersonalWorkspace guards on personalSpaceAllowed (denies MANAGED + UNRESOLVED)", () => {
    const src = apiSrc("services/platform-context/workspace-bootstrap.service.ts");
    expect(src).toContain("personalSpaceAllowed(input.userId, client)");
    expect(src).toContain("MANAGED_IDENTITY_NO_PERSONAL_SPACE");
  });

  it("the personal data-export route fails closed for managed identities BEFORE step-up", () => {
    const src = apiSrc("routes/account-data-export.routes.ts");
    const guardIdx = src.indexOf("assertPersonalExportAllowed(userId)");
    const stepUpIdx = src.indexOf('action: "data_export_request"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(stepUpIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(stepUpIdx);
  });
});
