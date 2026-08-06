/**
 * PHASE 4 §7.6 (2026-07-22) — organization suspend/resume lifecycle.
 *
 * suspendOrganization (CUSTOMER-only, reversible):
 *   status → SUSPENDED (master halt: authorize + checkOrgAccess +
 *   switcher all key off it); workspace-member sessions revoked; SSO
 *   ACTIVE→SUSPENDED; SCIM tokens ACTIVE→SUSPENDED; open invites
 *   expired; API credentials soft-paused via disabledAtUtc (NEVER
 *   REVOKED — revocation is permanent by contract) with the paused ids
 *   recorded in the ORG_SUSPENDED audit event; switcher pointers
 *   cleared. Memberships, webhooks, Evidence, audit: untouched.
 *
 * resumeOrganization: SUSPENDED → ACTIVE; marker-status SSO/SCIM flips
 *   back; EXACTLY the audit-recorded credential ids re-enabled; invites
 *   and sessions NOT restored (re-issue / re-authenticate).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  calls: [] as { model: string; method: string; args: unknown[] }[],
  org: null as Record<string, unknown> | null,
  teams: [{ id: "t1" }, { id: "t2" }] as { id: string }[],
  activeMemberUserIds: ["u1", "u2"] as string[],
  pausableCredentials: [{ id: "cred-1" }, { id: "cred-2" }] as { id: string }[],
  latestSuspendEvent: null as { metadata: unknown } | null,
  sessionsRevoked: [] as unknown[],
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
                if (model === "organization" && method === "findUnique")
                  return H.org;
                if (model === "team" && method === "findMany") return H.teams;
                if (model === "teamMember" && method === "findMany")
                  return H.activeMemberUserIds.map((userId) => ({ userId }));
                if (model === "apiCredential" && method === "findMany")
                  return H.pausableCredentials;
                if (
                  model === "organizationAuditEvent" &&
                  method === "findFirst"
                )
                  return H.latestSuspendEvent;
                if (method === "findFirst" || method === "findUnique")
                  return null;
                if (method === "findMany") return [];
                if (method === "updateMany") {
                  // Echo a plausible affected count for effect summaries.
                  return { count: 2 };
                }
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

vi.mock(
  "../src/services/identity-security/session-revocation.service.js",
  () => ({
    revokeAllSessionsForUser: async (input: unknown) => {
      H.sessionsRevoked.push(input);
    },
  }),
);

import {
  ORG_SUSPENSION_STATUS,
  resumeOrganization,
  suspendOrganization,
} from "../src/services/organization/org-lifecycle.service.js";

beforeEach(() => {
  H.calls = [];
  H.org = { id: "o1", kind: "CUSTOMER", status: "ACTIVE" };
  H.teams = [{ id: "t1" }, { id: "t2" }];
  H.activeMemberUserIds = ["u1", "u2"];
  H.pausableCredentials = [{ id: "cred-1" }, { id: "cred-2" }];
  H.latestSuspendEvent = {
    metadata: { pausedApiCredentialIds: ["cred-1", "cred-2"] },
  };
  H.sessionsRevoked = [];
});

const callsFor = (model: string, method?: string) =>
  H.calls.filter(
    (c) => c.model === model && (method === undefined || c.method === method),
  );

function assertPreservation() {
  expect(H.calls.some((c) => c.model === "evidence")).toBe(false);
  expect(
    H.calls.some((c) => c.method === "delete" || c.method === "deleteMany"),
  ).toBe(false);
  // Org suspension never touches membership rows (§7.6 recorded decision).
  expect(
    callsFor("teamMember").filter((c) => c.method !== "findMany"),
  ).toEqual([]);
  expect(callsFor("organizationMembership")).toEqual([]);
}

describe("Phase 4 §7.6 — suspendOrganization", () => {
  it("full effect matrix on a CUSTOMER ACTIVE org", async () => {
    const result = await suspendOrganization({
      organizationId: "o1",
      actorUserId: "admin-1",
      reason: "billing default",
    });

    // 1. Master halt.
    const orgUpdate = callsFor("organization", "update")[0];
    expect(orgUpdate.args[0]).toMatchObject({ data: { status: "SUSPENDED" } });

    // 3. SSO reversibly halted.
    const sso = callsFor("ssoConnection", "updateMany")[0];
    expect(sso.args[0]).toMatchObject({
      where: { teamId: { in: ["t1", "t2"] }, status: "ACTIVE" },
      data: { status: ORG_SUSPENSION_STATUS },
    });

    // 4. SCIM reversibly halted.
    const scim = callsFor("scimProvisioningToken", "updateMany")[0];
    expect(scim.args[0]).toMatchObject({
      where: { teamId: { in: ["t1", "t2"] }, status: "ACTIVE" },
      data: { status: ORG_SUSPENSION_STATUS },
    });

    // 5. Open invites expired.
    const invites = callsFor("organizationInvite", "updateMany")[0];
    expect(invites.args[0]).toMatchObject({
      where: { organizationId: "o1", acceptedAt: null, revokedAt: null },
    });
    expect(
      (invites.args[0] as { data: { expiresAt: Date } }).data.expiresAt,
    ).toBeInstanceOf(Date);

    // 6. Credentials soft-paused, NEVER revoked.
    const cred = callsFor("apiCredential", "updateMany")[0];
    expect(cred.args[0]).toMatchObject({
      where: { id: { in: ["cred-1", "cred-2"] } },
    });
    const credData = (cred.args[0] as { data: Record<string, unknown> }).data;
    expect(credData.disabledAtUtc).toBeInstanceOf(Date);
    expect(credData.status).toBeUndefined();

    // 7. Switcher pointers cleared.
    const users = callsFor("user", "updateMany")[0];
    expect(users.args[0]).toMatchObject({
      where: { currentWorkspaceId: { in: ["t1", "t2"] } },
      data: { currentWorkspaceId: null },
    });

    // 2. Sessions revoked per distinct workspace member, AFTER commit.
    expect(H.sessionsRevoked).toEqual([
      { userId: "u1", reason: "ORG_SUSPENDED" },
      { userId: "u2", reason: "ORG_SUSPENDED" },
    ]);
    expect(result.sessionsRevokedForUsers).toBe(2);

    // Audit event carries the resume contract.
    const audit = callsFor("organizationAuditEvent", "create")[0];
    const auditData = (audit.args[0] as { data: Record<string, unknown> })
      .data;
    expect(auditData.eventType).toBe("ORG_SUSPENDED");
    expect(auditData.metadata).toMatchObject({
      pausedApiCredentialIds: ["cred-1", "cred-2"],
    });

    // Untouched surfaces.
    expect(callsFor("webhookEndpoint")).toEqual([]);
    assertPreservation();
  });

  it("refuses SYSTEM orgs, ARCHIVED orgs, and double-suspension", async () => {
    H.org = { id: "o1", kind: "SYSTEM", status: "ACTIVE" };
    await expect(
      suspendOrganization({ organizationId: "o1", actorUserId: "a" }),
    ).rejects.toMatchObject({ code: "NOT_CUSTOMER_ORGANIZATION" });

    H.org = { id: "o1", kind: "CUSTOMER", status: "ARCHIVED" };
    await expect(
      suspendOrganization({ organizationId: "o1", actorUserId: "a" }),
    ).rejects.toMatchObject({ code: "ORG_ARCHIVED_PERMANENT" });

    H.org = { id: "o1", kind: "CUSTOMER", status: "SUSPENDED" };
    await expect(
      suspendOrganization({ organizationId: "o1", actorUserId: "a" }),
    ).rejects.toMatchObject({ code: "ORG_ALREADY_SUSPENDED" });

    expect(H.sessionsRevoked).toEqual([]);
    expect(
      H.calls.filter((c) =>
        /^(create|update|updateMany|upsert|delete|deleteMany)$/.test(c.method),
      ),
    ).toEqual([]);
  });
});

describe("Phase 4 §7.6 — resumeOrganization", () => {
  beforeEach(() => {
    H.org = { id: "o1", kind: "CUSTOMER", status: "SUSPENDED" };
  });

  it("restores status + marker-matched SSO/SCIM/credentials; invites/sessions stay dark", async () => {
    const result = await resumeOrganization({
      organizationId: "o1",
      actorUserId: "admin-1",
    });

    const orgUpdate = callsFor("organization", "update")[0];
    expect(orgUpdate.args[0]).toMatchObject({ data: { status: "ACTIVE" } });

    const sso = callsFor("ssoConnection", "updateMany")[0];
    expect(sso.args[0]).toMatchObject({
      where: { status: ORG_SUSPENSION_STATUS },
      data: { status: "ACTIVE" },
    });
    const scim = callsFor("scimProvisioningToken", "updateMany")[0];
    expect(scim.args[0]).toMatchObject({
      where: { status: ORG_SUSPENSION_STATUS },
      data: { status: "ACTIVE" },
    });

    // EXACTLY the audit-recorded ids, still-disabled guard included.
    const cred = callsFor("apiCredential", "updateMany")[0];
    expect(cred.args[0]).toMatchObject({
      where: {
        id: { in: ["cred-1", "cred-2"] },
        disabledAtUtc: { not: null },
      },
      data: { disabledAtUtc: null, disabledByUserId: null },
    });

    // NOT restored on resume.
    expect(callsFor("organizationInvite")).toEqual([]);
    expect(H.sessionsRevoked).toEqual([]);

    const audit = callsFor("organizationAuditEvent", "create")[0];
    expect(
      (audit.args[0] as { data: { eventType: string } }).data.eventType,
    ).toBe("ORG_RESUMED");

    expect(result.organizationId).toBe("o1");
    assertPreservation();
  });

  it("only a SUSPENDED org resumes (ACTIVE and ARCHIVED refuse)", async () => {
    H.org = { id: "o1", kind: "CUSTOMER", status: "ACTIVE" };
    await expect(
      resumeOrganization({ organizationId: "o1", actorUserId: "a" }),
    ).rejects.toMatchObject({ code: "ORG_NOT_SUSPENDED" });

    H.org = { id: "o1", kind: "CUSTOMER", status: "ARCHIVED" };
    await expect(
      resumeOrganization({ organizationId: "o1", actorUserId: "a" }),
    ).rejects.toMatchObject({ code: "ORG_NOT_SUSPENDED" });
  });

  it("resume with no recorded suspend event re-enables nothing", async () => {
    H.latestSuspendEvent = null;
    const result = await resumeOrganization({
      organizationId: "o1",
      actorUserId: "admin-1",
    });
    expect(result.apiCredentialsRestored).toBe(0);
    expect(callsFor("apiCredential", "updateMany")).toEqual([]);
  });
});

describe("Phase 4 §7.6 — access/switcher gates key off SUSPENDED", () => {
  it("checkOrgAccess denies members of a SUSPENDED org", async () => {
    const { checkOrgAccess } = await import(
      "../src/services/organization/org-access.js"
    );
    const fakePrisma = {
      organization: {
        findUnique: async () => ({ id: "o1", status: "SUSPENDED" }),
      },
      organizationMembership: {
        findFirst: async () => ({ role: "ORG_OWNER" }),
      },
    } as never;
    const outcome = await checkOrgAccess(fakePrisma, {
      orgId: "o1",
      userId: "u1",
    });
    expect(outcome).toEqual({ kind: "forbidden" });
  });

  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

  it("switcher already excludes non-ACTIVE orgs (source contract)", () => {
    const src = readFileSync(
      join(
        ROOT,
        "services",
        "platform-context",
        "platform-context.service.ts",
      ),
      "utf8",
    );
    expect(src).toContain('organization.status !== "ACTIVE"');
  });

  it("authorize denies ORGANIZATION-workspace context when org not ACTIVE (source contract)", () => {
    const src = readFileSync(
      join(ROOT, "services", "identity", "access-policy.service.ts"),
      "utf8",
    );
    expect(src).toContain('actor.organizationStatus !== "ACTIVE"');
  });

  it("admin routes register suspend + resume behind platform admin + step-up", () => {
    const src = readFileSync(
      join(ROOT, "routes", "admin-provisioning.routes.ts"),
      "utf8",
    );
    expect(src).toContain("/v1/admin/orgs/:id/${leg}");
    expect(src).toContain("suspendOrganization");
    expect(src).toContain("resumeOrganization");
    expect(src).toContain("requirePlatformAdmin");
  });
});
