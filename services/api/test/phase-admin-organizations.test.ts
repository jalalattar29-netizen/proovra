/**
 * Platform Control Center P0 — Customers / Organizations roster + detail.
 *
 * Locks the READ-ONLY aggregation surface:
 *
 *   1. GET /v1/admin/organizations is requirePlatformAdmin — a non-admin
 *      caller is rejected (403) and never reaches the aggregation.
 *   2. The list paginates (page/limit) and searches (name / owner email).
 *   3. The detail throws OrgNotFoundError → the route returns 404 for a
 *      missing org.
 *   4. Every derived field is real / computed / honest-null. The list
 *      derives plan, seats, owner email, domain count, SSO/SCIM booleans,
 *      and an onboarding health badge from real rows.
 *   5. No secrets: the aggregation service selects NO SsoConnection secret
 *      columns, NO ScimProvisioningToken.tokenHash, NO SAML private key —
 *      asserted by a source-contract scan + a payload scan.
 *
 * House style: mocked audit module + an injectable in-memory prisma
 * double + a source-contract scan. No live database.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { asPrismaDouble } from "./support/prisma-double.js";

/**
 * The exact `where` fields the doubles below read. Declared rather than
 * inferred so a production query that starts filtering on something new fails
 * to type-check here instead of silently matching nothing.
 */
type DoubleWhere = {
  id?: string;
  organizationId?: string;
  status?: string | { notIn?: string[] };
  role?: string | { in?: string[] };
  teamId?: { in?: string[] };
  verifiedAt?: { not?: unknown };
  OR?: Array<{
    name?: { contains?: string };
    memberships?: { some?: { user?: { email?: { contains?: string } } } };
  }>;
};
type WhereArgs = { where?: DoubleWhere };
const asStatus = (v: DoubleWhere["status"]): string | null =>
  typeof v === "string" ? v : null;
const notIn = (v: DoubleWhere["status"]): string[] =>
  typeof v === "object" && v ? (v.notIn ?? []) : [];
const roleIn = (v: DoubleWhere["role"]): string[] =>
  typeof v === "object" && v ? (v.in ?? []) : [];

// ---------------------------------------------------------------------------
// Mocks — bound BEFORE the SUT imports.
// ---------------------------------------------------------------------------

// The SSO health snapshot is exercised by its own suite; here we stub it so
// the org aggregation test stays focused and DB-free.
vi.mock("../src/services/security/sso-health.service.js", () => ({
  buildSsoHealthSnapshot: vi.fn(async ({ teamId }: { teamId: string }) => ({
    teamId,
    generatedAtUtc: new Date().toISOString(),
    overallStatus: "HEALTHY",
    connections: [],
  })),
}));

// db default client is never used — every call injects an explicit client.
vi.mock("../src/db.js", () => ({ prisma: {} }));

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------

import {
  getAdminOrganizationDetail,
  listAdminOrganizations,
  OrgNotFoundError,
} from "../src/services/organization/admin-organizations.service.js";

// ---------------------------------------------------------------------------
// In-memory prisma double.
// ---------------------------------------------------------------------------

type SeedOrg = {
  id: string;
  name: string;
  status?: string;
  createdAt?: Date;
  billingOwnerUserId?: string | null;
  legalName?: string | null;
};
type SeedTeam = {
  id: string;
  organizationId: string;
  name?: string;
  billingPlan?: string;
  billingStatus?: string;
  includedSeats?: number;
  members?: number;
  isPersonal?: boolean;
};
type SeedMembership = {
  organizationId: string;
  userId: string;
  role: string;
  createdAt?: Date;
  email?: string | null;
  displayName?: string | null;
};
type SeedDomain = {
  organizationId: string;
  domain: string;
  verifiedAt?: Date | null;
};

function makeClient(seed: {
  orgs?: SeedOrg[];
  teams?: SeedTeam[];
  memberships?: SeedMembership[];
  domains?: SeedDomain[];
  ssoConnections?: { teamId: string; status: string }[];
  scimTokens?: { teamId: string; status: string; lastUsedAtUtc?: Date | null }[];
  auditEvents?: { organizationId: string; createdAt: Date }[];
}) {
  const orgs = seed.orgs ?? [];
  const teams = (seed.teams ?? []).map((t) => ({
    isPersonal: false,
    name: t.name ?? "WS",
    billingPlan: t.billingPlan ?? "FREE",
    billingStatus: t.billingStatus ?? "INACTIVE",
    includedSeats: t.includedSeats ?? 0,
    members: t.members ?? 0,
    ...t,
  }));
  const memberships = seed.memberships ?? [];
  const domains = seed.domains ?? [];
  const sso = seed.ssoConnections ?? [];
  const scim = seed.scimTokens ?? [];
  const events = seed.auditEvents ?? [];

  const matchTeamIds = (where?: DoubleWhere): string[] => where?.teamId?.in ?? [];

  const client = {
    organization: {
      findMany: vi.fn(async ({ where }: WhereArgs) => {
        let rows = [...orgs];
        const wantStatus = asStatus(where?.status);
        if (wantStatus) rows = rows.filter((o) => (o.status ?? "ACTIVE") === wantStatus);
        if (where?.OR) {
          // name contains OR owner-email contains
          const nameNeedle =
            where.OR.find((c) => c.name)?.name?.contains?.toLowerCase() ?? null;
          const emailNeedle =
            where.OR.find((c) => c.memberships)?.memberships?.some?.user?.email
              ?.contains?.toLowerCase() ?? null;
          rows = rows.filter((o) => {
            const byName = nameNeedle
              ? o.name.toLowerCase().includes(nameNeedle)
              : false;
            const byEmail = emailNeedle
              ? memberships.some(
                  (m) =>
                    m.organizationId === o.id &&
                    m.role === "ORG_OWNER" &&
                    (m.email ?? "").toLowerCase().includes(emailNeedle),
                )
              : false;
            return byName || byEmail;
          });
        }
        return rows.map((o) => ({
          id: o.id,
          name: o.name,
          status: o.status ?? "ACTIVE",
          createdAt: o.createdAt ?? new Date("2026-01-01T00:00:00Z"),
        }));
      }),
      findUnique: vi.fn(async ({ where }: WhereArgs) => {
        const o = orgs.find((x) => x.id === where?.id);
        if (!o) return null;
        return {
          id: o.id,
          name: o.name,
          legalName: o.legalName ?? null,
          status: o.status ?? "ACTIVE",
          createdAt: o.createdAt ?? new Date("2026-01-01T00:00:00Z"),
          billingOwnerUserId: o.billingOwnerUserId ?? null,
        };
      }),
    },
    team: {
      findMany: vi.fn(async ({ where }: WhereArgs) => {
        return teams
          .filter((t) => t.organizationId === where?.organizationId && !t.isPersonal)
          .map((t) => ({
            id: t.id,
            name: t.name,
            billingPlan: t.billingPlan,
            billingStatus: t.billingStatus,
            includedSeats: t.includedSeats,
            _count: { members: t.members },
          }));
      }),
    },
    organizationMembership: {
      findFirst: vi.fn(async ({ where }: WhereArgs) => {
        const m = memberships.find(
          (x) => x.organizationId === where?.organizationId && x.role === asStatus(where?.role as DoubleWhere["status"]),
        );
        return m ? { user: { email: m.email ?? null } } : null;
      }),
      findMany: vi.fn(async ({ where }: WhereArgs) => {
        const roles: string[] = roleIn(where?.role);
        return memberships
          .filter(
            (m) =>
              m.organizationId === where?.organizationId &&
              (roles.length === 0 || roles.includes(m.role)),
          )
          .map((m) => ({
            userId: m.userId,
            role: m.role,
            createdAt: m.createdAt ?? new Date("2026-01-01T00:00:00Z"),
            user: { email: m.email ?? null, displayName: m.displayName ?? null },
          }));
      }),
    },
    organizationDomain: {
      count: vi.fn(async ({ where }: WhereArgs) => {
        return domains.filter(
          (d) =>
            d.organizationId === where?.organizationId &&
            (where?.verifiedAt?.not !== undefined ? Boolean(d.verifiedAt) : true),
        ).length;
      }),
      findMany: vi.fn(async ({ where }: WhereArgs) =>
        domains
          .filter((d) => d.organizationId === where?.organizationId)
          .map((d) => ({ domain: d.domain, verifiedAt: d.verifiedAt ?? null })),
      ),
    },
    ssoConnection: {
      count: vi.fn(async ({ where }: WhereArgs) => {
        const ids = matchTeamIds(where);
        const excluded: string[] = notIn(where?.status);
        return sso.filter(
          (s) => ids.includes(s.teamId) && !excluded.includes(s.status),
        ).length;
      }),
    },
    scimProvisioningToken: {
      count: vi.fn(async ({ where }: WhereArgs) => {
        const ids = matchTeamIds(where);
        return scim.filter(
          (s) => ids.includes(s.teamId) && s.status === asStatus(where?.status),
        ).length;
      }),
      findFirst: vi.fn(async ({ where }: WhereArgs) => {
        const ids = matchTeamIds(where);
        const rows = scim
          .filter((s) => ids.includes(s.teamId) && s.lastUsedAtUtc)
          .sort(
            (a, b) =>
              (b.lastUsedAtUtc!.getTime() ?? 0) - (a.lastUsedAtUtc!.getTime() ?? 0),
          );
        return rows[0] ? { lastUsedAtUtc: rows[0].lastUsedAtUtc } : null;
      }),
    },
    organizationAuditEvent: {
      findFirst: vi.fn(async ({ where }: WhereArgs) => {
        const rows = events
          .filter((e) => e.organizationId === where?.organizationId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows[0] ? { createdAt: rows[0].createdAt } : null;
      }),
      findMany: vi.fn(async () => []),
    },
    organizationPolicy: { count: vi.fn(async () => 0) },
    evidence: { count: vi.fn(async () => 0) },
    report: { count: vi.fn(async () => 0) },
    verificationPackage: { count: vi.fn(async () => 0) },
    evidenceLegalHold: { count: vi.fn(async () => 0) },
    destructionRequest: { count: vi.fn(async () => 0) },
    subscription: { count: vi.fn(async () => 0) },
    payment: { count: vi.fn(async () => 0) },
    user: { findUnique: vi.fn(async () => null) },
    adminAuditLog: { findMany: vi.fn(async () => []) },
  };

  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// List — pagination, search, derived fields.
// ---------------------------------------------------------------------------

describe("listAdminOrganizations", () => {
  it("derives plan, seats, owner email, domains, and SSO/SCIM booleans from real rows", async () => {
    const client = makeClient({
      orgs: [{ id: "org-a", name: "Acme" }],
      teams: [
        {
          id: "t1",
          organizationId: "org-a",
          billingPlan: "ENTERPRISE",
          includedSeats: 10,
          members: 4,
        },
        {
          id: "t2",
          organizationId: "org-a",
          billingPlan: "PRO",
          includedSeats: 5,
          members: 2,
        },
      ],
      memberships: [
        { organizationId: "org-a", userId: "u1", role: "ORG_OWNER", email: "owner@acme.test" },
      ],
      domains: [{ organizationId: "org-a", domain: "acme.test", verifiedAt: new Date() }],
      ssoConnections: [{ teamId: "t1", status: "ACTIVE" }],
      scimTokens: [{ teamId: "t1", status: "ACTIVE" }],
    });

    const res = await listAdminOrganizations({ page: 1, limit: 20 }, asPrismaDouble(client));
    expect(res.total).toBe(1);
    const item = res.items[0]!;
    expect(item.plan).toBe("ENTERPRISE");
    expect(item.enterprise).toBe(true);
    expect(item.workspaceCount).toBe(2);
    expect(item.seats).toEqual({ included: 15, used: 6 });
    expect(item.ownerEmail).toBe("owner@acme.test");
    expect(item.verifiedDomainsCount).toBe(1);
    expect(item.ssoConfigured).toBe(true);
    expect(item.scimConfigured).toBe(true);
    // Workspace + owner + verified domain → HEALTHY.
    expect(item.onboardingStatus).toBe("HEALTHY");
  });

  it("marks an org with no workspace or no owner as BLOCKED (honest, not fabricated)", async () => {
    const client = makeClient({
      orgs: [{ id: "org-empty", name: "Empty Co" }],
      teams: [],
      memberships: [],
    });
    const res = await listAdminOrganizations({ page: 1, limit: 20 }, asPrismaDouble(client));
    const item = res.items[0]!;
    expect(item.onboardingStatus).toBe("BLOCKED");
    expect(item.plan).toBeNull();
    expect(item.ownerEmail).toBeNull();
    expect(item.ssoConfigured).toBe(false);
    expect(item.scimConfigured).toBe(false);
  });

  it("paginates: page/limit slice the derived roster", async () => {
    const orgs = Array.from({ length: 5 }, (_, i) => ({
      id: `org-${i}`,
      name: `Org ${i}`,
    }));
    const client = makeClient({ orgs });
    const p1 = await listAdminOrganizations({ page: 1, limit: 2 }, asPrismaDouble(client));
    expect(p1.items).toHaveLength(2);
    expect(p1.total).toBe(5);
    expect(p1.totalPages).toBe(3);
    const p3 = await listAdminOrganizations({ page: 3, limit: 2 }, asPrismaDouble(client));
    expect(p3.items).toHaveLength(1);
  });

  it("searches by name", async () => {
    const client = makeClient({
      orgs: [
        { id: "o1", name: "Acme" },
        { id: "o2", name: "Beta" },
      ],
    });
    const res = await listAdminOrganizations(
      { page: 1, limit: 20, search: "acm" },
      asPrismaDouble(client),
    );
    expect(res.items.map((i) => i.name)).toEqual(["Acme"]);
  });

  it("searches by owner email", async () => {
    const client = makeClient({
      orgs: [
        { id: "o1", name: "Acme" },
        { id: "o2", name: "Beta" },
      ],
      memberships: [
        { organizationId: "o2", userId: "u2", role: "ORG_OWNER", email: "boss@beta.test" },
      ],
    });
    const res = await listAdminOrganizations(
      { page: 1, limit: 20, search: "beta.test" },
      asPrismaDouble(client),
    );
    expect(res.items.map((i) => i.name)).toEqual(["Beta"]);
  });

  it("filters by derived health", async () => {
    const client = makeClient({
      orgs: [
        { id: "healthy", name: "Healthy" },
        { id: "blocked", name: "Blocked" },
      ],
      teams: [{ id: "t1", organizationId: "healthy", members: 1 }],
      memberships: [
        { organizationId: "healthy", userId: "u1", role: "ORG_OWNER", email: "a@a.test" },
      ],
      domains: [{ organizationId: "healthy", domain: "a.test", verifiedAt: new Date() }],
    });
    const res = await listAdminOrganizations(
      { page: 1, limit: 20, health: "BLOCKED" },
      asPrismaDouble(client),
    );
    expect(res.items.map((i) => i.name)).toEqual(["Blocked"]);
  });
});

// ---------------------------------------------------------------------------
// Detail — 404, real fields, honest nulls, no secrets in payload.
// ---------------------------------------------------------------------------

describe("getAdminOrganizationDetail", () => {
  it("throws OrgNotFoundError for a missing org", async () => {
    const client = makeClient({ orgs: [] });
    await expect(
      getAdminOrganizationDetail("missing", asPrismaDouble(client)),
    ).rejects.toBeInstanceOf(OrgNotFoundError);
  });

  it("returns overview + identity + evidence + governance + billing + activity", async () => {
    const client = makeClient({
      orgs: [{ id: "org-a", name: "Acme", billingOwnerUserId: null }],
      teams: [
        {
          id: "t1",
          organizationId: "org-a",
          billingPlan: "ENTERPRISE",
          billingStatus: "ACTIVE",
          includedSeats: 10,
          members: 12,
        },
      ],
      memberships: [
        { organizationId: "org-a", userId: "u1", role: "ORG_OWNER", email: "owner@acme.test" },
        { organizationId: "org-a", userId: "u2", role: "ORG_ADMIN", email: "admin@acme.test" },
      ],
      domains: [
        { organizationId: "org-a", domain: "acme.test", verifiedAt: new Date() },
        { organizationId: "org-a", domain: "pending.test", verifiedAt: null },
      ],
    });

    const d = await getAdminOrganizationDetail("org-a", asPrismaDouble(client));
    expect(d.overview.plan).toBe("ENTERPRISE");
    expect(d.overview.owner?.email).toBe("owner@acme.test");
    expect(d.overview.admins).toHaveLength(1);
    expect(d.overview.seats).toEqual({
      included: 10,
      used: 12,
      overSeatWorkspaceCount: 1,
    });
    expect(d.identity.domains.verified.map((x) => x.domain)).toEqual(["acme.test"]);
    expect(d.identity.domains.pending.map((x) => x.domain)).toEqual(["pending.test"]);
    // Evidence counts default to 0 (no rows) — not fabricated.
    expect(d.evidence.evidenceCount).toBe(0);
    // billingOwner is honest-null when the org has none.
    expect(d.billing.billingOwner).toBeNull();
  });

  it("no secrets leak into the detail payload", async () => {
    const client = makeClient({
      orgs: [{ id: "org-a", name: "Acme" }],
      teams: [{ id: "t1", organizationId: "org-a", members: 1 }],
      ssoConnections: [{ teamId: "t1", status: "ACTIVE" }],
      scimTokens: [{ teamId: "t1", status: "ACTIVE", lastUsedAtUtc: new Date() }],
    });
    const d = await getAdminOrganizationDetail("org-a", asPrismaDouble(client));
    const json = JSON.stringify(d).toLowerCase();
    for (const forbidden of [
      "samlcertificate",
      "samlspprivatekey",
      "clientsecret",
      "tokenhash",
      "privatekey",
      "saml_certificate",
      "client_secret_hash",
    ]) {
      expect(json.includes(forbidden)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Route gate — non-platform-admin is rejected before aggregation runs.
// ---------------------------------------------------------------------------

describe("admin-organizations route gate", () => {
  it("requirePlatformAdmin replies 403 for a non-admin caller (list)", async () => {
    vi.resetModules();

    vi.doMock("../src/middleware/auth.js", () => ({
      requireAuth: vi.fn(async (req: FastifyRequest) => {
        req.user = { sub: "not-an-admin", provider: "EMAIL" };
      }),
    }));
    vi.doMock("../src/services/platform-admin.service.js", () => ({
      isPlatformAdmin: vi.fn(async () => false),
    }));

    const Fastify = (await import("fastify")).default;
    const { adminOrganizationsRoutes } = await import(
      "../src/routes/admin-organizations.routes.js"
    );

    const app = Fastify();
    await app.register(adminOrganizationsRoutes);

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/organizations",
    });

    expect(res.statusCode).toBe(403);
    await app.close();
    vi.resetModules();
  });
});

// ---------------------------------------------------------------------------
// Source-contract — routes gated + read-only + no secret columns selected.
// ---------------------------------------------------------------------------

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("admin-organizations source contract", () => {
  it("both routes are gated by requirePlatformAdmin", () => {
    const src = readSource("../src/routes/admin-organizations.routes.ts");
    expect(src).toContain('"/v1/admin/organizations"');
    expect(src).toContain('"/v1/admin/organizations/:id"');
    const gateCount = (src.match(/preHandler: requirePlatformAdmin/g) ?? []).length;
    expect(gateCount).toBe(2);
  });

  it("the aggregation service selects NO SSO/SCIM secret columns", () => {
    const raw = readSource(
      "../src/services/organization/admin-organizations.service.ts",
    );
    // Strip comments — the doc-comment NAMES these columns to explain they
    // are never read; the scan must inspect executable code only.
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // These secret columns must NEVER be selected by the aggregation.
    for (const forbidden of [
      "samlCertificate",
      "samlSpPrivateKey",
      "clientSecretHash",
      "tokenHash",
      "samlCertificateNext",
    ]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });

  it("the aggregation service performs NO writes (read-only)", () => {
    const src = readSource(
      "../src/services/organization/admin-organizations.service.ts",
    );
    // No create/update/delete/upsert Prisma calls.
    expect(src).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/);
  });
});
