/**
 * Phase 2 — Enterprise activation & provisioning keystone.
 *
 * Locks WORKSTREAM A:
 *
 *   1. grantEnterprisePlanToOrg flips EVERY workspace (Team) of an org to
 *      ENTERPRISE with the resolved seat count, ACTIVE billing status, and
 *      a recomputed overSeatLimit; writes an org + platform audit row.
 *   2. provisionEnterpriseCustomer (existing owner) creates an Organization,
 *      an ENTERPRISE workspace owned by the user, an ORG_OWNER membership,
 *      and sets org.billingOwnerUserId.
 *   3. provisionEnterpriseCustomer (missing owner) creates an Organization
 *      and a canonical ORG_OWNER invite (hashed token, 7-day expiry, no
 *      workspace) and returns the raw token once.
 *   4. The admin routes are gated by requirePlatformAdmin — a non-admin
 *      gets 403 and never reaches provisioning.
 *   5. Audit rows are written for every mutation.
 *   6. getPlanCapabilities("ENTERPRISE").enterpriseFeatures.ssoScim === true
 *      (setting billingPlan=ENTERPRISE auto-unlocks enterprise features).
 *   7. The line-59 platform-context defect is fixed additively
 *      (ENTERPRISE_PLAN_KEYS contains both TEAM and ENTERPRISE).
 *
 * House style: mocked audit modules + an injectable in-memory prisma
 * double + a source-contract scan. No live database.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — bound BEFORE the SUT imports.
// ---------------------------------------------------------------------------

const { emitOrgAuditEventMock, appendPlatformAuditLogMock } = vi.hoisted(
  () => ({
    emitOrgAuditEventMock: vi.fn(async () => undefined),
    appendPlatformAuditLogMock: vi.fn(async () => undefined),
  }),
);
vi.mock("../src/services/organization/org-audit.service.js", () => ({
  emitOrgAuditEvent: emitOrgAuditEventMock,
}));
vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: appendPlatformAuditLogMock,
}));

// The service only needs `prisma` for its default client — every test
// injects an explicit client, so this stub is never actually used.
vi.mock("../src/db.js", () => ({ prisma: {} }));

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------

import {
  EnterpriseProvisioningError,
  grantEnterprisePlanToOrg,
  provisionEnterpriseCustomer,
} from "../src/services/enterprise-provisioning.service.js";
import { getPlanCapabilities } from "../src/services/plan-catalog.service.js";

// ---------------------------------------------------------------------------
// In-memory prisma double.
// ---------------------------------------------------------------------------

type Team = {
  id: string;
  organizationId: string | null;
  ownerUserId: string;
  billingOwnerUserId: string | null;
  name: string;
  billingPlan: string;
  billingStatus: string;
  includedSeats: number;
  overSeatLimit: boolean;
  memberCount: number;
};

type Org = {
  id: string;
  name: string;
  status: string;
  billingOwnerUserId: string | null;
  pendingEnterpriseSeats: number | null;
};

function makeClient(seed: {
  orgs?: (Omit<Org, "pendingEnterpriseSeats"> & {
    pendingEnterpriseSeats?: number | null;
  })[];
  teams?: Team[];
  users?: { id: string; email: string }[];
}) {
  const orgs = new Map<string, Org>(
    (seed.orgs ?? []).map((o) => [
      o.id,
      { ...o, pendingEnterpriseSeats: o.pendingEnterpriseSeats ?? null },
    ]),
  );
  const teams = new Map<string, Team>((seed.teams ?? []).map((t) => [t.id, t]));
  const users = seed.users ?? [];
  const memberships: { organizationId: string; userId: string; role: string }[] =
    [];
  const invites: {
    id: string;
    organizationId: string;
    email: string;
    role: string;
    token: string | null;
    tokenHash: string;
    invitedByUserId: string;
    expiresAt: Date;
  }[] = [];

  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  const tx = {
    organization: {
      findUnique: vi.fn(async ({ where }: any) => orgs.get(where.id) ?? null),
      // (P1 domain remediation 2026-07-21) — grantEnterprisePlanToOrg now
      // also promotes the org to kind: "CUSTOMER"; the fake supports the
      // update so the existing behavioral assertions keep running.
      update: vi.fn(async ({ where, data }: any) => {
        const org = orgs.get(where.id);
        if (org) Object.assign(org, data);
        return org ?? {};
      }),
      create: vi.fn(async ({ data }: any) => {
        const org: Org = {
          id: nextId("org"),
          name: data.name,
          status: data.status,
          billingOwnerUserId: data.billingOwnerUserId ?? null,
          pendingEnterpriseSeats: data.pendingEnterpriseSeats ?? null,
        };
        orgs.set(org.id, org);
        return { id: org.id };
      }),
    },
    team: {
      findMany: vi.fn(async ({ where }: any) => {
        const rows = [...teams.values()].filter(
          (t) => t.organizationId === where.organizationId,
        );
        return rows.map((t) => ({
          id: t.id,
          _count: { members: t.memberCount },
        }));
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const t = teams.get(where.id)!;
        Object.assign(t, data);
        return t;
      }),
      create: vi.fn(async ({ data }: any) => {
        const t: Team = {
          id: nextId("team"),
          organizationId: data.organizationId,
          ownerUserId: data.ownerUserId,
          billingOwnerUserId: data.billingOwnerUserId ?? null,
          name: data.name,
          billingPlan: data.billingPlan,
          billingStatus: data.billingStatus,
          includedSeats: data.includedSeats,
          overSeatLimit: data.overSeatLimit ?? false,
          memberCount: data.members?.create ? 1 : 0,
        };
        teams.set(t.id, t);
        return { id: t.id };
      }),
    },
    organizationMembership: {
      // PHASE 3: the canonical orchestrator checks for an existing
      // membership before creating (idempotent grant).
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => {
        memberships.push(data);
        return { id: nextId("mem") };
      }),
    },
    organizationInvite: {
      create: vi.fn(async ({ data }: any) => {
        const invite = { id: nextId("inv"), ...data };
        invites.push(invite);
        return { id: invite.id };
      }),
    },
    // PHASE 10 §Step-1 — CUSTOMER-org creators now provision the baseline
    // OrganizationSecurityPolicy (org-keyed, idempotent) and the enterprise
    // contract transactionally. The fake supports both so provisioning runs.
    organizationSecurityPolicy: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => ({ id: nextId("osp"), ...data })),
    },
    enterpriseContract: {
      upsert: vi.fn(async ({ create }: any) => ({ id: nextId("ec"), ...create })),
    },
  };

  const client: any = {
    ...tx,
    user: {
      findFirst: vi.fn(async ({ where }: any) => {
        const u = users.find((x) => x.email === where.email);
        return u ? { id: u.id } : null;
      }),
    },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };

  return { client, orgs, teams, memberships, invites };
}

beforeEach(() => {
  emitOrgAuditEventMock.mockClear();
  appendPlatformAuditLogMock.mockClear();
});

// ---------------------------------------------------------------------------
// grantEnterprisePlanToOrg
// ---------------------------------------------------------------------------

describe("grantEnterprisePlanToOrg", () => {
  it("flips every workspace to ENTERPRISE, applies seats + ACTIVE, recomputes overSeatLimit", async () => {
    const { client, teams } = makeClient({
      orgs: [{ id: "org-a", name: "Acme", status: "ACTIVE", billingOwnerUserId: null }],
      teams: [
        {
          id: "t1",
          organizationId: "org-a",
          ownerUserId: "u1",
          billingOwnerUserId: "u1",
          name: "WS1",
          billingPlan: "FREE",
          billingStatus: "INACTIVE",
          includedSeats: 0,
          overSeatLimit: false,
          memberCount: 3,
        },
        {
          id: "t2",
          organizationId: "org-a",
          ownerUserId: "u1",
          billingOwnerUserId: "u1",
          name: "WS2",
          billingPlan: "FREE",
          billingStatus: "INACTIVE",
          includedSeats: 0,
          overSeatLimit: false,
          memberCount: 10,
        },
      ],
    });

    const res = await grantEnterprisePlanToOrg(
      { orgId: "org-a", plan: "ENTERPRISE", seats: 5, actorUserId: "admin-1" },
      client,
    );

    expect(res).toEqual({
      organizationId: "org-a",
      plan: "ENTERPRISE",
      seats: 5,
      workspacesUpdated: 2,
    });

    for (const t of teams.values()) {
      expect(t.billingPlan).toBe("ENTERPRISE");
      expect(t.billingStatus).toBe("ACTIVE");
      expect(t.includedSeats).toBe(5);
    }
    // t1 has 3 members (<=5 → within limit); t2 has 10 (>5 → over limit).
    expect(teams.get("t1")!.overSeatLimit).toBe(false);
    expect(teams.get("t2")!.overSeatLimit).toBe(true);
  });

  it("defaults seats to the plan catalog includedSeats when omitted", async () => {
    const { client, teams } = makeClient({
      orgs: [{ id: "org-b", name: "B", status: "ACTIVE", billingOwnerUserId: null }],
      teams: [
        {
          id: "t1",
          organizationId: "org-b",
          ownerUserId: "u1",
          billingOwnerUserId: "u1",
          name: "WS",
          billingPlan: "FREE",
          billingStatus: "INACTIVE",
          includedSeats: 0,
          overSeatLimit: false,
          memberCount: 1,
        },
      ],
    });

    const res = await grantEnterprisePlanToOrg(
      { orgId: "org-b", actorUserId: "admin-1" },
      client,
    );

    const expectedSeats = getPlanCapabilities("ENTERPRISE").includedSeats;
    expect(res.seats).toBe(expectedSeats);
    expect(teams.get("t1")!.includedSeats).toBe(expectedSeats);
  });

  it("writes an org audit row AND a platform audit row", async () => {
    const { client } = makeClient({
      orgs: [{ id: "org-c", name: "C", status: "ACTIVE", billingOwnerUserId: null }],
      teams: [],
    });

    await grantEnterprisePlanToOrg(
      { orgId: "org-c", plan: "ENTERPRISE", seats: 5, actorUserId: "admin-1" },
      client,
    );

    expect(emitOrgAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: "org-c",
        eventType: "ORG_PLAN_GRANTED",
        actorUserId: "admin-1",
      }),
    );
    expect(appendPlatformAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ORG_PLAN_GRANTED",
        userId: "admin-1",
        resourceId: "org-c",
      }),
    );
  });

  it("throws ORG_NOT_FOUND for an unknown org", async () => {
    const { client } = makeClient({ orgs: [], teams: [] });
    await expect(
      grantEnterprisePlanToOrg(
        { orgId: "missing", plan: "ENTERPRISE", actorUserId: "admin-1" },
        client,
      ),
    ).rejects.toBeInstanceOf(EnterpriseProvisioningError);
    // No audit rows when the org does not exist.
    expect(appendPlatformAuditLogMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// provisionEnterpriseCustomer — existing owner
// ---------------------------------------------------------------------------

describe("provisionEnterpriseCustomer — existing owner", () => {
  it("creates an org, an ENTERPRISE workspace owned by the user, and an ORG_OWNER membership", async () => {
    const { client, orgs, teams, memberships } = makeClient({
      users: [{ id: "user-9", email: "owner@acme.test" }],
    });

    const res = await provisionEnterpriseCustomer(
      {
        organizationName: "Acme Inc",
        ownerEmail: "owner@acme.test",
        seats: 25,
        actorUserId: "admin-1",
      },
      client,
    );

    expect(res).toMatchObject({
      provisioned: true,
      ownerUserId: "user-9",
    });
    if (!res.provisioned) throw new Error("expected provisioned");

    const org = orgs.get(res.organizationId)!;
    expect(org.billingOwnerUserId).toBe("user-9");

    const ws = teams.get(res.workspaceId)!;
    expect(ws.ownerUserId).toBe("user-9");
    expect(ws.billingPlan).toBe("ENTERPRISE");
    expect(ws.billingStatus).toBe("ACTIVE");
    expect(ws.includedSeats).toBe(25);

    expect(memberships).toContainEqual(
      expect.objectContaining({ userId: "user-9", role: "ORG_OWNER" }),
    );
    expect(appendPlatformAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ENTERPRISE_PROVISIONED" }),
    );
  });

  it("uses workspaceName when supplied, else the org name", async () => {
    const { client, teams } = makeClient({
      users: [{ id: "user-9", email: "owner@acme.test" }],
    });
    const res = await provisionEnterpriseCustomer(
      {
        organizationName: "Acme Inc",
        ownerEmail: "owner@acme.test",
        workspaceName: "Acme HQ",
        actorUserId: "admin-1",
      },
      client,
    );
    if (!res.provisioned) throw new Error("expected provisioned");
    expect(teams.get(res.workspaceId)!.name).toBe("Acme HQ");
  });
});

// ---------------------------------------------------------------------------
// provisionEnterpriseCustomer — missing owner
// ---------------------------------------------------------------------------

describe("provisionEnterpriseCustomer — missing owner", () => {
  it("creates an org + ORG_OWNER invite (hashed token, no workspace) and returns the raw token once", async () => {
    const { client, orgs, teams, invites } = makeClient({ users: [] });

    const res = await provisionEnterpriseCustomer(
      {
        organizationName: "Beta LLC",
        ownerEmail: "new-owner@beta.test",
        actorUserId: "admin-1",
      },
      client,
    );

    expect(res).toMatchObject({ provisioned: false, pendingOwner: true });
    if (res.provisioned) throw new Error("expected pending owner");

    // Raw token returned once; invite URL points at the canonical accept flow.
    expect(res.ownerInviteToken).toMatch(/^[0-9a-f]{64}$/);
    expect(res.inviteUrl).toBe(`/invite/${res.ownerInviteToken}`);

    // No workspace created (Team.ownerUserId is required).
    expect(teams.size).toBe(0);

    const org = orgs.get(res.organizationId)!;
    expect(org.billingOwnerUserId).toBeNull();

    // Phase 2 Blocker 1 — the brand-new-owner branch persists the resolved
    // enterprise seats on the org so the ORG_OWNER accept can complete
    // provisioning. Default seats = plan-catalog ENTERPRISE includedSeats.
    expect(org.pendingEnterpriseSeats).toBe(
      getPlanCapabilities("ENTERPRISE").includedSeats,
    );

    expect(invites).toHaveLength(1);
    const invite = invites[0]!;
    expect(invite.email).toBe("new-owner@beta.test");
    expect(invite.role).toBe("ORG_OWNER");
    // Raw token is never persisted — only the SHA-256 hash.
    expect(invite.token).toBeNull();
    expect(invite.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(invite.tokenHash).not.toBe(res.ownerInviteToken);
    // ~7-day expiry.
    const days = (invite.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it("persists the explicit provisioned seat count as pendingEnterpriseSeats", async () => {
    const { client, orgs } = makeClient({ users: [] });
    const res = await provisionEnterpriseCustomer(
      {
        organizationName: "Gamma Co",
        ownerEmail: "new-owner@gamma.test",
        seats: 42,
        actorUserId: "admin-1",
      },
      client,
    );
    if (res.provisioned) throw new Error("expected pending owner");
    expect(orgs.get(res.organizationId)!.pendingEnterpriseSeats).toBe(42);
  });

  it("audits an ENTERPRISE_PROVISIONED event for the pending-owner path", async () => {
    const { client } = makeClient({ users: [] });
    await provisionEnterpriseCustomer(
      {
        organizationName: "Beta LLC",
        ownerEmail: "new-owner@beta.test",
        actorUserId: "admin-1",
      },
      client,
    );
    expect(emitOrgAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "ENTERPRISE_PROVISIONED" }),
    );
    expect(appendPlatformAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ENTERPRISE_PROVISIONED",
        metadata: expect.objectContaining({ provisioned: false }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Enterprise features + platform-context defect fix (source-contract).
// ---------------------------------------------------------------------------

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("enterprise capability + gate wiring", () => {
  it("getPlanCapabilities('ENTERPRISE').enterpriseFeatures.ssoScim === true", () => {
    expect(getPlanCapabilities("ENTERPRISE").enterpriseFeatures.ssoScim).toBe(
      true,
    );
  });

  it("platform-context ENTERPRISE_PLAN_KEYS is ENTERPRISE-only (TEAM is NOT enterprise — locked model)", () => {
    const src = readSource(
      "../src/services/platform-context/platform-context.service.ts",
    );
    const match = src.match(
      /ENTERPRISE_PLAN_KEYS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(match).not.toBeNull();
    const body = match![1]!;
    expect(body).toContain('"ENTERPRISE"');
    // Locked model: TEAM is a subscription plan inside a PERSONAL workspace,
    // NOT an enterprise workspace type. It must never be an enterprise key.
    expect(body).not.toContain('"TEAM"');
  });

  it("admin-provisioning routes are gated by requirePlatformAdmin AND step-up on both endpoints", () => {
    const src = readSource("../src/routes/admin-provisioning.routes.ts");
    expect(src).toContain('preHandler: requirePlatformAdmin');
    expect(src).toContain("requireStepUpForSensitiveAction");
    expect(src).toContain('"/v1/admin/orgs/:id/plan"');
    expect(src).toContain('"/v1/admin/enterprise/provision"');
    // One step-up gate per endpoint: plan grant, provision, and the
    // PHASE 4 §7.6 shared suspend/resume handler (one loop body).
    const gateCount = (src.match(/requireStepUpForSensitiveAction\(/g) ?? [])
      .length;
    expect(gateCount).toBe(3);
  });

  it("the new route is registered in server.ts", () => {
    const src = readSource("../src/server.ts");
    expect(src).toContain("adminProvisioningRoutes");
    expect(src).toContain("await app.register(adminProvisioningRoutes)");
  });
});

// ---------------------------------------------------------------------------
// Route gate — non-platform-admin is rejected before provisioning runs.
// ---------------------------------------------------------------------------

describe("admin-provisioning route gate", () => {
  it("requirePlatformAdmin replies 403 for a non-admin caller", async () => {
    vi.resetModules();

    // requireAuth: succeed and stamp a user, without touching JWT/session.
    vi.doMock("../src/middleware/auth.js", () => ({
      requireAuth: vi.fn(async (req: any) => {
        req.user = { sub: "not-an-admin" };
      }),
    }));
    // isPlatformAdmin: deny.
    vi.doMock("../src/services/platform-admin.service.js", () => ({
      isPlatformAdmin: vi.fn(async () => false),
    }));

    const Fastify = (await import("fastify")).default;
    const { adminProvisioningRoutes } = await import(
      "../src/routes/admin-provisioning.routes.js"
    );

    const app = Fastify();
    await app.register(adminProvisioningRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/enterprise/provision",
      payload: {
        teamId: "00000000-0000-4000-8000-000000000000",
        organizationName: "X",
        ownerEmail: "x@x.test",
      },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
    vi.resetModules();
  });
});
