/**
 * ORGANIZATION PERSONAS AGAINST THE REAL API (live PostgreSQL).
 *
 * The enterprise audit crawled pages as these personas and never sent an API
 * request as one. This suite does: one Enterprise Organization with real rows,
 * each OrganizationRole held by a real user, each against the billing, security
 * policy, SSO/SCIM, member, audit, export and closure routes.
 *
 * Who may do what is stated here, not imported, so a change to a role set in the
 * source has to be argued with this table:
 *
 *   ORG_BILLING_ROLES, ORG_DOMAIN_READ_ROLES, ORG_DOMAIN_WRITE_ROLES   org-access.ts
 *   SEATS / OVERSIGHT / MEMBERS export sets (AUD-31)      organizations-reports.routes.ts
 *   "Administrative authority does not imply evidence access"   AZ-R09
 *   Identity configuration writes need an Organization identity role   DOM-13
 *   Enterprise billing changes go through the account manager   BILLING_MANAGE
 *
 * Reading the table: every refusal is the same request a listed role makes
 * successfully, so a 403 here cannot be a bad payload or a missing fixture. A
 * write states what must change for the listed role and asserts the same snapshot
 * did not move for everyone else.
 */
import { randomUUID } from "node:crypto";

import { roleHasPermission } from "@proovra/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Injected, type Person } from "./support/coverage-actors.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Prisma = import("@prisma/client").PrismaClient;

const ROLES = [
  "ORG_OWNER",
  "ORG_ADMIN",
  "ORG_SECURITY_ADMIN",
  "ORG_BILLING_ADMIN",
  "ORG_AUDITOR",
  "ORG_MEMBER",
] as const;
type Role = (typeof ROLES)[number];

const EVERYONE: readonly Role[] = ROLES;
const OWNER_ONLY: readonly Role[] = ["ORG_OWNER"];
const FULL_ADMINS: readonly Role[] = ["ORG_OWNER", "ORG_ADMIN"];
const BILLING: readonly Role[] = ["ORG_OWNER", "ORG_ADMIN", "ORG_BILLING_ADMIN"];
const OVERSIGHT: readonly Role[] = ["ORG_OWNER", "ORG_ADMIN", "ORG_SECURITY_ADMIN", "ORG_AUDITOR"];
const DOMAIN_WRITE: readonly Role[] = ["ORG_OWNER", "ORG_ADMIN", "ORG_SECURITY_ADMIN"];
const MEMBER_DIRECTORY: readonly Role[] = [
  "ORG_OWNER",
  "ORG_ADMIN",
  "ORG_SECURITY_ADMIN",
  "ORG_BILLING_ADMIN",
  "ORG_AUDITOR",
];

const without = (set: readonly Role[]) => ROLES.filter((r) => !set.includes(r));

type Attempt = {
  method: string;
  url: string;
  payload?: unknown;
  /** Step-up the listed role satisfies; a refused role must never get this far. */
  stepUp?: { purpose: string; resourceKind?: string; resourceId?: string };
  snapshot: () => Promise<unknown>;
};

type WriteRow = {
  name: string;
  allowed: readonly Role[];
  okStatus: number[];
  arrange: (role: Role) => Promise<Attempt>;
};

describe("organization personas against the real API", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let kit: CoverageKit;
  let stepUp: ReturnType<typeof createStepUpCeremony>;

  let orgId: string;
  let teamId: string;
  let evidenceId: string;
  const bare = new Map<Role, Person>();
  const inWorkspace = new Map<Role, Person>();
  let outsider: Person;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    kit = await coverageKit(h);
    const { signJwt } = await import("../src/services/jwt.js");
    const fixtures = await import("./point7/product-fixtures.js");
    stepUp = createStepUpCeremony({
      prisma,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });

    const tenant = await fixtures.seedOrganizationTenant({
      prisma: prisma as never,
      tag: `opa-${kit.tag()}`,
      mintToken: (userId: string, email: string) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET as string,
          3600,
        ),
    });
    orgId = tenant.organizationId;
    teamId = tenant.workspaceId;

    for (const role of ROLES) {
      const noWorkspace = await kit.person(null);
      await prisma.organizationMembership.create({ data: { organizationId: orgId, userId: noWorkspace.id, role } });
      bare.set(role, noWorkspace);
      // A workspace ADMIN too, which is what makes a refusal here the org role's
      // doing: the workspace permission and the step-up workspace are both held.
      const withWorkspace = await kit.person(teamId, "ADMIN");
      await prisma.organizationMembership.create({ data: { organizationId: orgId, userId: withWorkspace.id, role } });
      inWorkspace.set(role, withWorkspace);
    }
    outsider = { id: h.fixtures.teamB.ownerUserId, email: "", token: h.fixtures.teamB.ownerToken };

    const evidence = await prisma.evidence.create({
      data: { title: `opa-${kit.tag()}`, type: "PHOTO", status: "CREATED", teamId, organizationId: orgId, ownerUserId: tenant.owner.userId },
      select: { id: true },
    });
    evidenceId = evidence.id;
    await prisma.organizationAuditEvent.create({
      data: { organizationId: orgId, actorUserId: tenant.owner.userId, eventType: "ORG_UPDATED", targetType: "organization", targetId: orgId, metadata: {} },
    });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  // `refused` defaults to 403; the billing authority conceals an account from a
  // viewer holding no capability on it, and that concealment is its contract.
  const READS: { name: string; url: () => string; allowed: readonly Role[]; refused?: number }[] = [
    { name: "organization detail", url: () => `/v1/orgs/${orgId}`, allowed: EVERYONE },
    { name: "member roster", url: () => `/v1/orgs/${orgId}/members`, allowed: EVERYONE },
    { name: "workspaces", url: () => `/v1/orgs/${orgId}/workspaces`, allowed: EVERYONE },
    { name: "published retention template", url: () => `/v1/orgs/${orgId}/policies/retention`, allowed: EVERYONE },
    { name: "pending invitations", url: () => `/v1/orgs/${orgId}/invites`, allowed: FULL_ADMINS },
    { name: "billing rollup", url: () => `/v1/orgs/${orgId}/billing/rollup`, allowed: BILLING },
    { name: "billing account", url: () => `/v1/billing/accounts/ORGANIZATION/${orgId}`, allowed: BILLING, refused: 404 },
    { name: "billing history", url: () => `/v1/billing/accounts/ORGANIZATION/${orgId}/history`, allowed: BILLING, refused: 404 },
    { name: "verified domains", url: () => `/v1/orgs/${orgId}/domains`, allowed: OVERSIGHT },
    { name: "security policy", url: () => `/v1/security-policy?organizationId=${orgId}`, allowed: FULL_ADMINS },
    {
      name: "high-security readiness",
      url: () => `/v1/security-policy/high-security/readiness?organizationId=${orgId}`,
      allowed: FULL_ADMINS,
    },
    { name: "audit trail", url: () => `/v1/orgs/${orgId}/audit-events`, allowed: OVERSIGHT },
    { name: "governance control center", url: () => `/v1/orgs/${orgId}/governance/control-center`, allowed: OVERSIGHT },
    { name: "members export", url: () => `/v1/orgs/${orgId}/reports/members.csv`, allowed: MEMBER_DIRECTORY },
    { name: "seats export", url: () => `/v1/orgs/${orgId}/reports/seats.csv`, allowed: BILLING },
    { name: "audit export", url: () => `/v1/orgs/${orgId}/reports/audit.csv`, allowed: OVERSIGHT },
    { name: "governance export", url: () => `/v1/orgs/${orgId}/reports/governance.csv`, allowed: OVERSIGHT },
    { name: "external access export", url: () => `/v1/orgs/${orgId}/reports/external-access.csv`, allowed: OVERSIGHT },
    { name: "download audit export", url: () => `/v1/orgs/${orgId}/reports/download-audit.csv`, allowed: OVERSIGHT },
    { name: "closure status", url: () => `/v1/orgs/${orgId}/closure`, allowed: OWNER_ONLY },
  ];

  it.each(READS.map((r) => [r.name, r] as const))("read: %s", async (_name, row) => {
    const wrong: string[] = [];
    for (const [variant, people] of [
      ["org role only", bare],
      ["org role and workspace ADMIN", inWorkspace],
    ] as const) {
      for (const role of ROLES) {
        const res = await kit.call("GET", row.url(), people.get(role)!);
        const expected = row.allowed.includes(role) ? 200 : (row.refused ?? 403);
        if (res.statusCode !== expected) wrong.push(`${role} (${variant}): ${res.statusCode}, wanted ${expected}: ${res.body.slice(0, 160)}`);
      }
    }
    expect(wrong, wrong.join("\n")).toEqual([]);

    const crossOrg = await kit.call("GET", row.url(), outsider);
    expect(crossOrg.statusCode, crossOrg.body).toBe(404);
    const anonymous = await kit.call("GET", row.url(), null);
    expect(anonymous.statusCode, anonymous.body).toBe(401);
  });

  it("an export or audit row an excluded role is refused never reaches it by the sibling JSON route", async () => {
    // AUD-31 took the audit, governance and access exports from the billing
    // specialist. The same rows on the JSON routes are the same disclosure.
    const marker = await prisma.organizationAuditEvent.findFirstOrThrow({ where: { organizationId: orgId }, select: { id: true } });
    for (const url of [`/v1/orgs/${orgId}/audit-events`, `/v1/orgs/${orgId}/governance/control-center`]) {
      const res = await kit.call("GET", url, bare.get("ORG_BILLING_ADMIN")!);
      expect(res.statusCode, url).toBe(403);
      expect(res.body).not.toContain(marker.id);
    }
    const positive = await kit.call("GET", `/v1/orgs/${orgId}/audit-events`, bare.get("ORG_AUDITOR")!);
    expect(positive.statusCode).toBe(200);
    expect(positive.body).toContain(marker.id);
  });

  it("workspace billing fields reach the billing roles and nobody else", async () => {
    for (const role of ROLES) {
      const res = await kit.call("GET", `/v1/orgs/${orgId}/workspaces`, bare.get(role)!);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { callerCanSeeBilling: boolean; workspaces: Record<string, unknown>[] };
      const row = body.workspaces.find((w) => w.workspaceId === teamId)!;
      expect(row, res.body.slice(0, 200)).toBeDefined();
      expect(body.callerCanSeeBilling, role).toBe(BILLING.includes(role));
      expect("billing" in row, role).toBe(BILLING.includes(role));
      if (!BILLING.includes(role)) expect(res.body, role).not.toContain("includedSeats");
    }
  });

  it("the billing account list names the organization only to the billing roles", async () => {
    for (const role of ROLES) {
      const res = await kit.call("GET", "/v1/billing/accounts", bare.get(role)!);
      expect(res.statusCode, res.body).toBe(200);
      const listed = (res.json() as { accounts: { type: string; id: string }[] }).accounts.some(
        (a) => a.type === "ORGANIZATION" && a.id === orgId,
      );
      expect(listed, role).toBe(BILLING.includes(role));
    }
  });

  it("a member sees who is in the organization, not why someone was suspended", async () => {
    const target = await kit.person(null);
    const membership = await prisma.organizationMembership.create({
      data: {
        organizationId: orgId,
        userId: target.id,
        role: "ORG_MEMBER",
        status: "SUSPENDED",
        suspendedAtUtc: new Date(),
        suspensionReason: "SENTINEL-suspension-reason",
      },
      select: { id: true },
    });
    const asMember = await kit.call("GET", `/v1/orgs/${orgId}/members`, bare.get("ORG_MEMBER")!);
    expect(asMember.statusCode).toBe(200);
    expect(asMember.body).toContain(membership.id);
    expect(asMember.body).not.toContain("SENTINEL-suspension-reason");
    const asAdmin = await kit.call("GET", `/v1/orgs/${orgId}/members`, bare.get("ORG_ADMIN")!);
    expect(asAdmin.body).toContain("SENTINEL-suspension-reason");
    await prisma.organizationMembership.delete({ where: { id: membership.id } });
  });

  it("the shell shows a role only the surfaces whose endpoint answers it", async () => {
    // Not `audit`: that tab is deliberately open to every role and renders an
    // honest "auditor only" state on the 403 (admin/audit/page.tsx).
    const surfaceEndpoint: Record<string, string> = {
      billing: `/v1/orgs/${orgId}/billing/rollup`,
      governance: `/v1/orgs/${orgId}/governance/control-center`,
      domains: `/v1/orgs/${orgId}/domains`,
    };
    const wrong: string[] = [];
    for (const role of ROLES) {
      const who = bare.get(role)!;
      const detail = await kit.call("GET", `/v1/orgs/${orgId}`, who);
      const surfaces = (detail.json() as { adminSurfaces: string[] }).adminSurfaces;
      for (const [surface, url] of Object.entries(surfaceEndpoint)) {
        const res = await kit.call("GET", url, who);
        if (surfaces.includes(surface) !== (res.statusCode === 200)) {
          wrong.push(`${role} ${surface}: shown=${surfaces.includes(surface)} endpoint=${res.statusCode}`);
        }
      }
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("administrative authority is not evidence access (AZ-R09)", async () => {
    for (const role of ROLES) {
      const res = await kit.call("GET", `/v1/evidence/${evidenceId}`, bare.get(role)!);
      expect([403, 404], `${role}: ${res.statusCode} ${res.body.slice(0, 120)}`).toContain(res.statusCode);
    }
    const positive = await kit.call("GET", `/v1/evidence/${evidenceId}`, inWorkspace.get("ORG_MEMBER")!);
    expect(positive.statusCode, positive.body).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Identity configuration reads stay on workspace authority (DOM-13)
  // ---------------------------------------------------------------------------

  it("SSO and SCIM configuration reads follow the workspace, not the org role", async () => {
    const viewer = await kit.person(teamId, "VIEWER");
    await prisma.organizationMembership.create({ data: { organizationId: orgId, userId: viewer.id, role: "ORG_MEMBER" } });
    for (const [url, permission] of [
      [`/v1/admin/identity/providers?teamId=${teamId}`, "identity.sso.read"],
      [`/v1/admin/identity/scim/tokens?teamId=${teamId}`, "identity.external_mapping.read"],
    ] as const) {
      for (const role of ROLES) {
        const inWs = await kit.call("GET", url, inWorkspace.get(role)!);
        expect(inWs.statusCode, `${url} ${role} ${inWs.body.slice(0, 160)}`).toBe(200);
        const noWs = await kit.call("GET", url, bare.get(role)!);
        expect(noWs.statusCode, `${url} ${role} bare`).toBe(404);
      }
      const asViewer = await kit.call("GET", url, viewer);
      expect(asViewer.statusCode, asViewer.body).toBe(roleHasPermission("VIEWER", permission) ? 200 : 403);
      const crossOrg = await kit.call("GET", url, outsider);
      expect(crossOrg.statusCode).toBe(404);
    }
  });

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  async function orgMemberTarget(): Promise<{ membershipId: string; userId: string }> {
    const person = await kit.person(null);
    const row = await prisma.organizationMembership.create({
      data: { organizationId: orgId, userId: person.id, role: "ORG_MEMBER" },
      select: { id: true },
    });
    return { membershipId: row.id, userId: person.id };
  }

  const WRITES: WriteRow[] = [
    {
      name: "rename the organization",
      allowed: FULL_ADMINS,
      okStatus: [200],
      arrange: async () => ({
        method: "PATCH",
        url: `/v1/orgs/${orgId}`,
        payload: { name: `opa-renamed-${kit.tag()}` },
        snapshot: () => prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } }),
      }),
    },
    {
      name: "invite a member",
      allowed: FULL_ADMINS,
      okStatus: [200, 201],
      arrange: async () => {
        const email = `opa-invite-${kit.tag()}@test.proovra.local`;
        return {
          method: "POST",
          url: `/v1/orgs/${orgId}/invites`,
          payload: { email, role: "ORG_MEMBER" },
          snapshot: () => prisma.organizationInvite.count({ where: { organizationId: orgId, email } }),
        };
      },
    },
    {
      name: "bulk invite",
      allowed: FULL_ADMINS,
      okStatus: [200, 201],
      arrange: async () => {
        const email = `opa-bulk-${kit.tag()}@test.proovra.local`;
        return {
          method: "POST",
          url: `/v1/orgs/${orgId}/invites/bulk`,
          payload: { rows: [{ email }] },
          snapshot: () => prisma.organizationInvite.count({ where: { organizationId: orgId, email } }),
        };
      },
    },
    {
      name: "change a member's role",
      allowed: FULL_ADMINS,
      okStatus: [200],
      arrange: async () => {
        const target = await orgMemberTarget();
        return {
          method: "PATCH",
          url: `/v1/orgs/${orgId}/members/${target.membershipId}`,
          payload: { role: "ORG_AUDITOR" },
          snapshot: () => prisma.organizationMembership.findUniqueOrThrow({ where: { id: target.membershipId }, select: { role: true } }),
        };
      },
    },
    {
      name: "suspend a member",
      allowed: FULL_ADMINS,
      okStatus: [200],
      arrange: async () => {
        const target = await orgMemberTarget();
        return {
          method: "POST",
          url: `/v1/orgs/${orgId}/members/${target.membershipId}/suspend`,
          payload: { reason: "matrix" },
          snapshot: () => prisma.organizationMembership.findUniqueOrThrow({ where: { id: target.membershipId }, select: { status: true } }),
        };
      },
    },
    {
      name: "remove a member",
      allowed: FULL_ADMINS,
      okStatus: [200, 204],
      arrange: async () => {
        const target = await orgMemberTarget();
        return {
          method: "DELETE",
          url: `/v1/orgs/${orgId}/members/${target.membershipId}`,
          snapshot: () =>
            prisma.organizationMembership.findFirst({
              where: { id: target.membershipId, status: "ACTIVE" },
              select: { id: true },
            }),
        };
      },
    },
    {
      name: "publish the retention template",
      allowed: FULL_ADMINS,
      okStatus: [200],
      arrange: async () => ({
        method: "POST",
        url: `/v1/orgs/${orgId}/policies/retention`,
        payload: { retentionDays: 1000 + Math.floor(Math.random() * 10_000), immutable: false, description: "matrix" },
        snapshot: () =>
          prisma.organizationPolicy.findFirst({ where: { organizationId: orgId, key: "retention.default" }, select: { value: true } }),
      }),
    },
    {
      name: "change the security policy",
      allowed: FULL_ADMINS,
      okStatus: [200],
      arrange: async () => ({
        method: "PATCH",
        url: "/v1/security-policy",
        payload: { organizationId: orgId, notes: `matrix ${kit.tag()}` },
        stepUp: { purpose: "ORG_SECURITY_POLICY_UPDATE" },
        snapshot: () =>
          prisma.organizationSecurityPolicy.findFirstOrThrow({ where: { organizationId: orgId }, select: { policyVersion: true, notes: true } }),
      }),
    },
    {
      name: "add a domain",
      allowed: DOMAIN_WRITE,
      okStatus: [200, 201],
      arrange: async () => {
        const domain = `opa-${kit.tag()}.example.test`;
        return {
          method: "POST",
          url: `/v1/orgs/${orgId}/domains`,
          payload: { domain },
          snapshot: () => prisma.organizationDomain.count({ where: { organizationId: orgId, domain } }),
        };
      },
    },
    {
      name: "remove a domain",
      allowed: DOMAIN_WRITE,
      okStatus: [200, 204],
      arrange: async () => {
        const row = await prisma.organizationDomain.create({
          data: {
            organizationId: orgId,
            domain: `opa-rm-${kit.tag()}.example.test`,
            verificationToken: kit.tag(),
            createdByUserId: inWorkspace.get("ORG_OWNER")!.id,
          },
          select: { id: true },
        });
        return {
          method: "DELETE",
          url: `/v1/orgs/${orgId}/domains/${row.id}`,
          stepUp: { purpose: "ORG_DOMAIN_REMOVE", resourceKind: "organization_domain", resourceId: row.id },
          snapshot: () => prisma.organizationDomain.count({ where: { id: row.id } }),
        };
      },
    },
    {
      name: "suspend a workspace",
      allowed: FULL_ADMINS,
      okStatus: [200],
      arrange: async () => {
        const owner = inWorkspace.get("ORG_OWNER")!;
        const team = await prisma.team.create({
          data: {
            name: `opa-ws-${kit.tag()}`,
            ownerUserId: owner.id,
            billingOwnerUserId: owner.id,
            isPersonal: false,
            organizationId: orgId,
            workspaceKind: "ORGANIZATION",
            billingPlan: "ENTERPRISE",
            billingStatus: "ACTIVE",
          },
          select: { id: true },
        });
        await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } });
        return {
          method: "POST",
          url: `/v1/orgs/${orgId}/workspaces/${team.id}/suspend`,
          payload: {},
          // Workspace suspension is the mass suspension of its members.
          snapshot: () => prisma.teamMember.findMany({ where: { teamId: team.id }, select: { userId: true, status: true } }),
        };
      },
    },
    {
      name: "create an SSO connection",
      allowed: DOMAIN_WRITE,
      okStatus: [201],
      arrange: async (role) => {
        // One live connection per provider per Organization: each listed role
        // creates a different one, so a 409 cannot read as a pass.
        const provider = { ORG_OWNER: "GENERIC_OIDC", ORG_ADMIN: "OKTA", ORG_SECURITY_ADMIN: "AZURE_AD" }[role as string] ?? "GOOGLE_WORKSPACE";
        const displayName = `opa-sso-${kit.tag()}`;
        return {
          method: "POST",
          url: "/v1/admin/identity/providers",
          payload: {
            teamId,
            provider,
            displayName,
            issuerUrl: "https://idp.opa.example.test/oauth2",
            clientId: "opa-local-client",
            clientSecret: "opa-local-client-secret",
            allowedEmailDomains: ["opa.example.test"],
            jitDefaultRole: "MEMBER",
          },
          stepUp: { purpose: "EXTERNAL_IDENTITY_LINK", resourceKind: "sso_connection" },
          snapshot: () => prisma.ssoConnection.count({ where: { displayName } }),
        };
      },
    },
    {
      name: "mint a SCIM token",
      allowed: DOMAIN_WRITE,
      okStatus: [201],
      arrange: async () => {
        const name = `opa-scim-${kit.tag()}`;
        return {
          method: "POST",
          url: "/v1/admin/identity/scim/tokens",
          payload: { teamId, name, scopes: ["users.read"] },
          stepUp: { purpose: "EXTERNAL_IDENTITY_LINK", resourceKind: "scim_token" },
          snapshot: () => prisma.scimProvisioningToken.count({ where: { name } }),
        };
      },
    },
  ];

  async function attempt(a: Attempt, who: Person, headers?: Record<string, string>): Promise<Injected> {
    const res = await kit.call(a.method, a.url, who, a.payload, headers);
    await h.handlersSettled();
    return res;
  }

  it.each(WRITES.map((r) => [r.name, r] as const))("write: %s", async (_name, row) => {
    const wrong: string[] = [];
    for (const role of without(row.allowed)) {
      const a = await row.arrange(role);
      const before = await a.snapshot();
      const res = await attempt(a, inWorkspace.get(role)!);
      if (res.statusCode !== 403) wrong.push(`${role}: ${res.statusCode}, wanted 403: ${res.body.slice(0, 160)}`);
      expect(await a.snapshot(), `${role} moved state`).toEqual(before);
    }
    expect(wrong, wrong.join("\n")).toEqual([]);

    for (const role of row.allowed) {
      const a = await row.arrange(role);
      const before = await a.snapshot();
      const who = inWorkspace.get(role)!;
      const headers = a.stepUp
        ? await stepUp.approvedHeader({ token: who.token, userId: who.id, teamId, ...a.stepUp })
        : undefined;
      const res = await attempt(a, who, headers);
      expect(row.okStatus, `${role}: ${res.statusCode} ${res.body.slice(0, 200)}`).toContain(res.statusCode);
      expect(await a.snapshot(), `${role} changed nothing`).not.toEqual(before);
    }

    const a = await row.arrange("ORG_MEMBER");
    const before = await a.snapshot();
    const crossOrg = await attempt(a, outsider);
    expect([403, 404], `${crossOrg.statusCode} ${crossOrg.body.slice(0, 160)}`).toContain(crossOrg.statusCode);
    expect(await a.snapshot()).toEqual(before);
    const anonymous = await kit.call(a.method, a.url, null, a.payload);
    expect(anonymous.statusCode).toBe(401);
    expect(await a.snapshot()).toEqual(before);
  });

  it("no read of the identity configuration carries a secret", async () => {
    const owner = inWorkspace.get("ORG_OWNER")!;
    const res = await kit.call("GET", `/v1/admin/identity/providers?teamId=${teamId}`, owner);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { providers: unknown[] }).providers.length).toBeGreaterThan(0);
    expect(res.body).not.toContain("opa-local-client-secret");
    const tokens = await kit.call("GET", `/v1/admin/identity/scim/tokens?teamId=${teamId}`, owner);
    expect(tokens.statusCode).toBe(200);
    expect(tokens.body.toLowerCase()).not.toContain("tokenhash");
  });

  it("an accepted write is on the Organization's audit trail, attributed to the actor", async () => {
    const who = inWorkspace.get("ORG_ADMIN")!;
    const name = `opa-audited-${kit.tag()}`;
    const res = await kit.call("PATCH", `/v1/orgs/${orgId}`, who, { name });
    expect(res.statusCode, res.body).toBe(200);
    const events = await prisma.organizationAuditEvent.findMany({
      where: { organizationId: orgId, actorUserId: who.id },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(events).toHaveLength(1);
  });

  it("billing changes on an Enterprise account belong to the account manager: no org role reaches them, and a payer still does", async () => {
    for (const role of ROLES) {
      const res = await kit.call("POST", `/v1/billing/accounts/ORGANIZATION/${orgId}/reconcile`, inWorkspace.get(role)!, {});
      // Refused for want of the capability, or concealed from a role holding none.
      expect(res.statusCode, `${role} ${res.body.slice(0, 160)}`).toBe(BILLING.includes(role) ? 403 : 404);
    }
    // Positive control on the same route: the capability exists and its holder
    // gets through, so the refusals above are the capability, not the route.
    const payer = await kit.person(null);
    const ok = await kit.call("POST", `/v1/billing/accounts/PERSONAL/${payer.id}/reconcile`, payer, {});
    expect(ok.statusCode, ok.body).not.toBe(403);
    const cross = await kit.call("POST", `/v1/billing/accounts/PERSONAL/${payer.id}/reconcile`, inWorkspace.get("ORG_OWNER")!, {});
    expect(cross.statusCode).toBe(404);
  });

  it("organization closure and ownership transfer are the owner's alone", async () => {
    const { hashPassword } = await import("../src/services/email-password-auth.service.js");
    const password = `Opa-Owner-Pass-${kit.tag()}`;
    const fixtures = await import("./point7/product-fixtures.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const disposable = await fixtures.seedOrganizationTenant({
      prisma: prisma as never,
      tag: `opa-${kit.tag()}`,
      mintToken: (userId: string, email: string) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET as string,
          3600,
        ),
    });
    const closeOrg = disposable.organizationId;
    // A live contract routes a real closure to the account manager and is a
    // closure blocker; a self-service Organization closes through this route.
    await prisma.enterpriseContract.deleteMany({ where: { organizationId: closeOrg } });
    await prisma.team.update({
      where: { id: disposable.workspaceId },
      data: { billingPlan: "FREE", billingStatus: "INACTIVE" },
    });
    await prisma.user.update({ where: { id: disposable.owner.userId }, data: { passwordHash: hashPassword(password) } });
    const owner: Person = { id: disposable.owner.userId, email: disposable.owner.email, token: disposable.owner.token };
    const proof = { stepUp: { method: "password", currentPassword: password } };

    const person = async (role: Role) => {
      const p = await kit.person(null);
      await prisma.organizationMembership.create({ data: { organizationId: closeOrg, userId: p.id, role } });
      return p;
    };
    const successor = await person("ORG_ADMIN");
    const members = await Promise.all(ROLES.filter((r) => r !== "ORG_OWNER").map(async (r) => [r, await person(r)] as const));

    const closure = { confirmation: "close this organization", ...proof };
    const status = await kit.call("GET", `/v1/orgs/${closeOrg}/closure`, owner);
    expect(status.statusCode, status.body).toBe(200);
    closure.confirmation = (status.json() as { confirmationPhrase: string }).confirmationPhrase;

    for (const [role, who] of members) {
      const closeTry = await kit.call("POST", `/v1/orgs/${closeOrg}/closure`, who, closure);
      expect(closeTry.statusCode, `${role} ${closeTry.body}`).toBe(403);
      expect((closeTry.json() as { error: { code: string } }).error.code).toBe("owner_required");
      const transferTry = await kit.call("POST", `/v1/orgs/${closeOrg}/transfer-ownership`, who, { targetUserId: who.id, ...proof });
      expect(transferTry.statusCode, `${role} ${transferTry.body}`).toBe(403);
    }
    const crossOrg = await kit.call("POST", `/v1/orgs/${closeOrg}/closure`, outsider, closure);
    expect(crossOrg.statusCode).toBe(404);
    expect(await prisma.organizationClosureRequest.count({ where: { organizationId: closeOrg } })).toBe(0);
    expect(
      await prisma.organizationMembership.count({ where: { organizationId: closeOrg, role: "ORG_OWNER" } }),
    ).toBe(1);

    // Positive controls, same payloads, on the same Organization. Closure refuses
    // while other members remain, so the roster leaves first and returns after.
    await prisma.organizationMembership.deleteMany({ where: { organizationId: closeOrg, role: { not: "ORG_OWNER" } } });
    await prisma.teamMember.deleteMany({ where: { teamId: disposable.workspaceId, role: { not: "OWNER" } } });
    const requested = await kit.call("POST", `/v1/orgs/${closeOrg}/closure`, owner, closure);
    expect([200, 201, 202], requested.body).toContain(requested.statusCode);
    const open = await prisma.organizationClosureRequest.findFirstOrThrow({ where: { organizationId: closeOrg } });
    expect(open.requestedByUserId).toBe(owner.id);
    await prisma.organizationMembership.create({ data: { organizationId: closeOrg, userId: successor.id, role: "ORG_ADMIN" } });
    const auditorMember = await person("ORG_AUDITOR");

    const cancelTry = await kit.call("POST", `/v1/orgs/${closeOrg}/closure/${open.id}/cancel`, auditorMember, {});
    expect(cancelTry.statusCode).toBe(403);
    expect((await prisma.organizationClosureRequest.findUniqueOrThrow({ where: { id: open.id } })).status).toBe(open.status);
    const cancelled = await kit.call("POST", `/v1/orgs/${closeOrg}/closure/${open.id}/cancel`, owner, {});
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await prisma.organizationClosureRequest.findUniqueOrThrow({ where: { id: open.id } })).status).not.toBe(open.status);

    // The transfer needs the seat the closure fixture gave up, so it runs on an
    // Organization that kept its contract.
    const contracted = await fixtures.seedOrganizationTenant({
      prisma: prisma as never,
      tag: `opa-${kit.tag()}`,
      mintToken: (userId: string, email: string) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET as string,
          3600,
        ),
    });
    await prisma.user.update({ where: { id: contracted.owner.userId }, data: { passwordHash: hashPassword(password) } });
    await prisma.organizationMembership.create({
      data: { organizationId: contracted.organizationId, userId: successor.id, role: "ORG_ADMIN" },
    });
    const transferred = await kit.call(
      "POST",
      `/v1/orgs/${contracted.organizationId}/transfer-ownership`,
      { token: contracted.owner.token },
      { targetUserId: successor.id, ...proof },
    );
    expect(transferred.statusCode, transferred.body).toBe(200);
    const owners = await prisma.organizationMembership.findMany({
      where: { organizationId: contracted.organizationId, role: "ORG_OWNER", status: "ACTIVE" },
      select: { userId: true },
    });
    expect(owners.map((o) => o.userId)).toEqual([successor.id]);
  });

  it("refused actors of another organization learn nothing that a missing organization does not say", async () => {
    const missing = randomUUID();
    const cross = await kit.call("GET", `/v1/orgs/${orgId}/audit-events`, outsider);
    const absent = await kit.call("GET", `/v1/orgs/${missing}/audit-events`, outsider);
    expect(cross.statusCode).toBe(404);
    expect(cross.body).toBe(absent.body);
  });
});
