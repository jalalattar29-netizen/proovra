/**
 * PHASE 12 POINT 4 PASS C3 — a manual route cannot rebind an IdP-managed
 * identity.
 *
 * The defect: `POST/DELETE /v1/identity/external-mappings` wrote
 * `ExternalIdentityMapping` rows through `linkExternalIdentity` /
 * `unlinkExternalIdentity` without ever consulting managed ownership. The SSO
 * login flow resolves the signing-in user by (provider, externalSubjectId)
 * from exactly those rows (access-control/sso.service.ts), so an operator
 * holding `identity.external_mapping.write` — strictly weaker than IdP
 * administration — could bind an external subject THEY control to an
 * enterprise-managed account and then sign in as that user. The same route
 * could unlink a managed subject, severing an account from its provider
 * outside the provisioning system.
 *
 * The rules under proof:
 *   - MANAGED_ENTERPRISE identities refuse manual link AND unlink;
 *   - an unresolved / schema-unavailable managed state DENIES (fail closed);
 *   - an external subject already resolving to another user cannot be taken;
 *   - STANDARD identities still work — this is a gate, not a freeze;
 *   - every denial writes NOTHING.
 *
 * Only Prisma is faked; the service, its gate and the canonical
 * `resolveManagedIdentity` all run for real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const writes: string[] = [];

const state = {
  identityMode: "STANDARD" as string,
  managingOrganizationId: null as string | null,
  isMember: true,
  activeMapping: null as { id: string; userId: string } | null,
  subjectOwnerUserId: null as string | null,
  /** Simulate the managed-ownership columns being unavailable. */
  userReadThrows: false,
};

vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: async () => undefined,
}));
vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: () => undefined,
}));

const prismaFake = {
  user: {
    findUnique: async () => {
      if (state.userReadThrows) {
        const err = Object.assign(new Error("column missing"), {
          code: "P2022",
          clientVersion: "test",
        });
        Object.setPrototypeOf(err, Object.getPrototypeOf(err));
        throw err;
      }
      return {
        identityMode: state.identityMode,
        managingOrganizationId: state.managingOrganizationId,
        managedIdentitySource: state.identityMode === "MANAGED_ENTERPRISE" ? "SCIM" : null,
        managedBySsoConnectionId: null,
      };
    },
  },
  teamMember: {
    findFirst: async () => (state.isMember ? { id: "m-1" } : null),
  },
  externalIdentityMapping: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      // Subject-ownership probe (provider + externalSubjectId).
      if (args.where.externalSubjectId) {
        return state.subjectOwnerUserId
          ? { id: "map-other", userId: state.subjectOwnerUserId }
          : null;
      }
      // Active-mapping probes (link re-issue guard / unlink lookup).
      return state.activeMapping
        ? { ...state.activeMapping, provider: "OIDC", teamId: "t1" }
        : null;
    },
    create: async () => {
      writes.push("mapping.create");
      return { id: "map-new" };
    },
    update: async () => {
      writes.push("mapping.update");
      return { id: "map-1", unlinkedAtUtc: new Date() };
    },
  },
};

vi.mock("../src/db.js", () => ({ prisma: prismaFake }));

const { linkExternalIdentity, unlinkExternalIdentity } = await import(
  "../src/services/identity/external-identity.service.js"
);

const link = () =>
  linkExternalIdentity({
    teamId: "t1",
    userId: "u-target",
    provider: "OIDC" as never,
    externalSubjectId: "attacker-controlled-subject",
    actorUserId: "operator-1",
  });

const unlink = () =>
  unlinkExternalIdentity({
    teamId: "t1",
    mappingId: "map-1",
    actorUserId: "operator-1",
  });

beforeEach(() => {
  writes.length = 0;
  state.identityMode = "STANDARD";
  state.managingOrganizationId = null;
  state.isMember = true;
  state.activeMapping = null;
  state.subjectOwnerUserId = null;
  state.userReadThrows = false;
});

describe("Phase 12 Point 4 — manual external-identity binding vs managed ownership", () => {
  it("refuses to bind an external subject to a MANAGED identity, writing nothing", async () => {
    state.identityMode = "MANAGED_ENTERPRISE";
    state.managingOrganizationId = "org-1";
    await expect(link()).rejects.toMatchObject({
      code: "managed_identity_readonly",
    });
    expect(writes).toEqual([]);
  });

  it("refuses to unlink a MANAGED identity's subject, writing nothing", async () => {
    state.identityMode = "MANAGED_ENTERPRISE";
    state.managingOrganizationId = "org-1";
    state.activeMapping = { id: "map-1", userId: "u-target" };
    await expect(unlink()).rejects.toMatchObject({
      code: "managed_identity_readonly",
    });
    expect(writes).toEqual([]);
  });

  it("DENIES when managed ownership cannot be resolved — ambiguity is not permission", async () => {
    state.userReadThrows = true;
    await expect(link()).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it("refuses to take an external subject that already resolves to another user", async () => {
    // Without this, the row that the SSO login resolves by
    // (provider, externalSubjectId) could be pointed at a different account.
    state.subjectOwnerUserId = "u-someone-else";
    await expect(link()).rejects.toMatchObject({
      code: "external_subject_already_mapped",
    });
    expect(writes).toEqual([]);
  });

  it("still links a STANDARD identity — a gate, not a freeze", async () => {
    await expect(link()).resolves.toMatchObject({ id: "map-new" });
    expect(writes).toContain("mapping.create");
  });

  it("still unlinks a STANDARD identity", async () => {
    state.activeMapping = { id: "map-1", userId: "u-target" };
    await expect(unlink()).resolves.toMatchObject({ id: "map-1" });
    expect(writes).toContain("mapping.update");
  });

  it("a non-member subject is still refused before anything else", async () => {
    state.isMember = false;
    await expect(link()).rejects.toMatchObject({
      code: "user_not_in_workspace",
    });
    expect(writes).toEqual([]);
  });
});
