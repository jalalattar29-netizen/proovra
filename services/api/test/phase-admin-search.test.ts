/**
 * Platform Control Center (item I) — Global Search.
 *
 * Locks the READ-ONLY, platform-admin-only search surface:
 *
 *   1. adminGlobalSearch returns typed, uniform { type, id, label, sublabel,
 *      href } results for organizations, users, and workspaces (Team).
 *   2. Each type deep-links to the correct admin surface via `href`.
 *   3. GET /v1/admin/search is requirePlatformAdmin — a non-admin caller is
 *      rejected (403) and never reaches the aggregation.
 *   4. No secrets: the projected results NEVER contain a password hash,
 *      token, evidence file hash / storage key, or evidence file content —
 *      asserted by a payload scan + a source-contract scan of the service.
 *
 * House style: injectable in-memory prisma double + a source-contract scan.
 * No live database.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

// db default client is never used — every call injects an explicit client.
vi.mock("../src/db.js", () => ({ prisma: {} }));

import {
  adminGlobalSearch,
  ALL_SEARCH_TYPES,
} from "../src/services/admin/search.service.js";

// ---------------------------------------------------------------------------
// In-memory prisma double. Each model exposes a `findMany` that filters its
// seed rows by a case-insensitive `contains` on the OR clause fields.
// ---------------------------------------------------------------------------

type Seed = {
  organizations?: Array<{
    id: string;
    name: string;
    legalName?: string | null;
    status?: string;
  }>;
  users?: Array<{
    id: string;
    email?: string | null;
    displayName?: string | null;
    platformRole?: string | null;
    // A secret column that must NEVER be selected/projected.
    passwordHash?: string | null;
  }>;
  teams?: Array<{
    id: string;
    name: string;
    legalName?: string | null;
    billingPlan?: string | null;
  }>;
};

function containsMatch(row: any, or: any[]): boolean {
  for (const clause of or) {
    for (const [field, cond] of Object.entries(clause)) {
      const needle = (cond as any)?.contains;
      if (typeof needle !== "string") continue;
      const value = row[field];
      if (
        typeof value === "string" &&
        value.toLowerCase().includes(needle.toLowerCase())
      ) {
        return true;
      }
    }
  }
  return false;
}

// A findMany that honours { where: { OR }, take, select } enough for the SUT.
function makeFindMany(rows: any[]) {
  return vi.fn(async ({ where, take, select }: any) => {
    let out = rows;
    if (where?.OR) out = out.filter((r) => containsMatch(r, where.OR));
    if (typeof take === "number") out = out.slice(0, take);
    // Honour `select` so the double can only ever hand back selected columns —
    // this makes the "no secrets" payload assertion meaningful.
    if (select) {
      out = out.map((r) => {
        const projected: any = {};
        for (const key of Object.keys(select)) {
          if (select[key]) projected[key] = r[key] ?? null;
        }
        return projected;
      });
    }
    return out;
  });
}

function makeClient(seed: Seed): any {
  const empty = makeFindMany([]);
  return {
    organization: { findMany: makeFindMany(seed.organizations ?? []) },
    user: { findMany: makeFindMany(seed.users ?? []) },
    team: { findMany: makeFindMany(seed.teams ?? []) },
    demoRequest: { findMany: empty },
    contactSalesRequest: { findMany: empty },
    evidence: { findMany: empty },
    report: { findMany: empty },
    verificationPackage: { findMany: empty },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Typed results per entity + deep-link hrefs.
// ---------------------------------------------------------------------------

describe("adminGlobalSearch", () => {
  it("searches organizations → typed result deep-linking to /admin/organizations/:id", async () => {
    const client = makeClient({
      organizations: [
        { id: "org-1", name: "Acme Corp", status: "ACTIVE" },
        { id: "org-2", name: "Beta LLC", status: "ACTIVE" },
      ],
    });
    const res = await adminGlobalSearch(
      { query: "acme", types: ["organization"] },
      client,
    );
    const group = res.groups.find((g) => g.type === "organization")!;
    expect(group.results).toHaveLength(1);
    const item = group.results[0]!;
    expect(item.type).toBe("organization");
    expect(item.id).toBe("org-1");
    expect(item.label).toBe("Acme Corp");
    expect(item.href).toBe("/admin/organizations/org-1");
  });

  it("searches users by email → typed result, email is the only PII exposed", async () => {
    const client = makeClient({
      users: [
        {
          id: "u-1",
          email: "owner@acme.test",
          displayName: "Owner",
          platformRole: null,
          passwordHash: "SECRET_ARGON2_HASH",
        },
        { id: "u-2", email: "other@beta.test", passwordHash: "x" },
      ],
    });
    const res = await adminGlobalSearch(
      { query: "acme.test", types: ["user"] },
      client,
    );
    const group = res.groups.find((g) => g.type === "user")!;
    expect(group.results).toHaveLength(1);
    const item = group.results[0]!;
    expect(item.type).toBe("user");
    expect(item.id).toBe("u-1");
    expect(item.label).toBe("owner@acme.test");
    expect(item.href).toContain("/admin/users?search=");
    // The password hash must NOT appear anywhere in the projected result.
    expect(JSON.stringify(item)).not.toContain("SECRET_ARGON2_HASH");
  });

  it("searches workspaces (Team) → typed result", async () => {
    const client = makeClient({
      teams: [
        { id: "t-1", name: "Legal Workspace", billingPlan: "ENTERPRISE" },
        { id: "t-2", name: "Ops", billingPlan: "FREE" },
      ],
    });
    const res = await adminGlobalSearch(
      { query: "legal", types: ["team"] },
      client,
    );
    const group = res.groups.find((g) => g.type === "team")!;
    expect(group.results).toHaveLength(1);
    const item = group.results[0]!;
    expect(item.type).toBe("team");
    expect(item.id).toBe("t-1");
    expect(item.label).toBe("Legal Workspace");
    expect(item.sublabel).toBe("ENTERPRISE");
  });

  it("bounds results per type to the requested limit", async () => {
    const organizations = Array.from({ length: 25 }, (_, i) => ({
      id: `org-${i}`,
      name: `Match ${i}`,
      status: "ACTIVE",
    }));
    const client = makeClient({ organizations });
    const res = await adminGlobalSearch(
      { query: "match", types: ["organization"], perTypeLimit: 10 },
      client,
    );
    const group = res.groups.find((g) => g.type === "organization")!;
    expect(group.results).toHaveLength(10);
  });

  it("returns honest empty arrays for types with no matches", async () => {
    const client = makeClient({ organizations: [] });
    const res = await adminGlobalSearch({ query: "nothing" }, client);
    // All eight groups present, every one an honest empty array.
    expect(res.groups.map((g) => g.type).sort()).toEqual(
      [...ALL_SEARCH_TYPES].sort(),
    );
    expect(res.total).toBe(0);
    for (const g of res.groups) expect(g.results).toEqual([]);
  });

  it("NO secret / password / token / evidence-content field appears in any result projection", async () => {
    const client = makeClient({
      organizations: [{ id: "o", name: "Acme", status: "ACTIVE" }],
      users: [
        {
          id: "u",
          email: "a@acme.test",
          passwordHash: "SECRET_HASH_VALUE",
        },
      ],
      teams: [{ id: "t", name: "Acme WS", billingPlan: "PRO" }],
    });
    const res = await adminGlobalSearch({ query: "acme" }, client);
    const json = JSON.stringify(res).toLowerCase();
    for (const forbidden of [
      "passwordhash",
      "password_hash",
      "secret_hash_value",
      "tokenhash",
      "token_hash",
      "filesha256",
      "file_sha256",
      "storagekey",
      "storage_key",
      "storagebucket",
      "internalnotes",
      "providersecret",
      "privatekey",
    ]) {
      expect(json.includes(forbidden)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Route gate — non-platform-admin is rejected before aggregation runs.
// ---------------------------------------------------------------------------

describe("admin-search route gate", () => {
  it("requirePlatformAdmin replies 403 for a non-admin caller", async () => {
    vi.resetModules();

    vi.doMock("../src/middleware/auth.js", () => ({
      requireAuth: vi.fn(async (req: any) => {
        req.user = { sub: "not-an-admin" };
      }),
    }));
    vi.doMock("../src/services/platform-admin.service.js", () => ({
      isPlatformAdmin: vi.fn(async () => false),
    }));

    const Fastify = (await import("fastify")).default;
    const { adminSearchRoutes } = await import(
      "../src/routes/admin-search.routes.js"
    );

    const app = Fastify();
    await app.register(adminSearchRoutes);

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/search?q=acme",
    });

    expect(res.statusCode).toBe(403);
    await app.close();
    vi.resetModules();
  });

  it("rejects a too-short query with 400 (min length guard)", async () => {
    vi.resetModules();

    vi.doMock("../src/middleware/auth.js", () => ({
      requireAuth: vi.fn(async (req: any) => {
        req.user = { sub: "admin" };
      }),
    }));
    vi.doMock("../src/services/platform-admin.service.js", () => ({
      isPlatformAdmin: vi.fn(async () => true),
    }));
    vi.doMock("../src/services/admin/search.service.js", () => ({
      adminGlobalSearch: vi.fn(async () => ({ query: "", groups: [], total: 0 })),
      ALL_SEARCH_TYPES: [],
    }));

    const Fastify = (await import("fastify")).default;
    const { adminSearchRoutes } = await import(
      "../src/routes/admin-search.routes.js"
    );

    const app = Fastify();
    await app.register(adminSearchRoutes);

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/search?q=a",
    });

    expect(res.statusCode).toBe(400);
    await app.close();
    vi.resetModules();
  });
});

// ---------------------------------------------------------------------------
// Source-contract — route gated + read-only + no secret columns selected.
// ---------------------------------------------------------------------------

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("admin-search source contract", () => {
  it("the route is gated by requirePlatformAdmin + carries the tenant-scope exception", () => {
    const src = readSource("../src/routes/admin-search.routes.ts");
    expect(src).toContain('"/v1/admin/search"');
    expect(src).toContain("preHandler: requirePlatformAdmin");
    expect(src).toContain("TENANT_SCOPE_EXCEPTION: platform_admin_global");
  });

  it("the search service performs NO writes (read-only)", () => {
    const src = readSource("../src/services/admin/search.service.ts");
    expect(src).not.toMatch(
      /\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/,
    );
  });

  it("the search service selects NO secret / evidence-content columns", () => {
    const raw = readSource("../src/services/admin/search.service.ts");
    // Strip comments — the doc-comment NAMES these columns to explain they are
    // never read; the scan must inspect executable code only.
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const forbidden of [
      "passwordHash",
      "fileSha256",
      "storageKey",
      "storageBucket",
      "internalNotes",
      "tokenHash",
      "providerUserId",
      "multipartManifestSha256",
    ]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });
});
