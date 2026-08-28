/**
 * Platform Control Center — Customers / Organizations SOURCE CONTRACT.
 *
 * WHAT THIS FILE IS, AFTER ADM-014 / ADM-023 (2026-08-27)
 * ---------------------------------------------------------------------------
 * Source-text invariants ONLY. Everything this file used to assert about the
 * roster's BEHAVIOUR — pagination, search by name, search by owner email, the
 * derived health filter, the enriched row — now lives in
 * `admin-population-truth.integration.test.ts`, executed against live
 * PostgreSQL 16.
 *
 * That move is not a convenience. The behaviour here was proven by a
 * hand-rolled in-memory Prisma double that reimplemented the roster's filtering
 * in JavaScript, and a double that reimplements a WHERE clause can only prove
 * the simulation agrees with itself. It filtered in memory because the SERVICE
 * filtered in memory; when the service moved its filtering into the database —
 * which is the ADM-014 fix — the double had nothing left to say, and would have
 * gone on passing against a WHERE clause that was silently wrong. That is the
 * precise failure ADM-023 is about, and it is not one to re-create.
 *
 * What a text test CAN prove is architectural: which authority a module
 * imports, that it performs no writes, and that it selects no secret column.
 * Those assertions are here and are worth keeping — a regex genuinely settles
 * "does this file import the canonical predicate", and no executed test settles
 * it as cheaply.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyRequest } from "fastify";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/**
 * Strip comments before an ABSENCE assertion.
 *
 * These modules deliberately NAME the pattern they removed, in a comment, so the
 * next reader learns why it is gone. A bare `not.toContain("isPersonal: false")`
 * would then fail on the explanation itself — and the obvious "fix" is to delete
 * the explanation, which is the worst available outcome. Absence is therefore
 * asserted against CODE; presence is asserted against the whole file.
 */
function readCode(rel: string): string {
  return readSource(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const SERVICE = "../src/services/organization/admin-organizations.service.ts";
const ROUTES = "../src/routes/admin-organizations.routes.ts";

// ---------------------------------------------------------------------------
// Route gate.
// ---------------------------------------------------------------------------

describe("admin-organizations route gate", () => {
  it("replies 403 for a non-admin caller (list)", async () => {
    vi.resetModules();

    vi.doMock("../src/middleware/auth.js", () => ({
      requireAuth: vi.fn(async (req: FastifyRequest) => {
        req.user = { sub: "not-an-admin", provider: "EMAIL" };
      }),
    }));
    // ADM-001 — the gate now decides through `resolvePlatformAdmin`, which
    // returns a DECISION (allowed + source + whether a stale admin claim was
    // presented) rather than a bare boolean, because a withdrawn grant that is
    // still being exercised is worth logging. Both exports are stubbed so this
    // double matches the module's real shape.
    vi.doMock("../src/services/platform-admin.service.js", () => ({
      isPlatformAdmin: vi.fn(async () => false),
      resolvePlatformAdmin: vi.fn(async () => ({
        allowed: false,
        source: "NOT_ADMIN" as const,
        claimedAdmin: false,
      })),
    }));

    const Fastify = (await import("fastify")).default;
    const { adminOrganizationsRoutes } = await import(
      "../src/routes/admin-organizations.routes.js"
    );

    const app = Fastify();
    await app.register(adminOrganizationsRoutes);

    const res = await app.inject({ method: "GET", url: "/v1/admin/customers" });
    expect(res.statusCode).toBe(403);

    // The compatibility alias must be gated identically — an unguarded legacy
    // path is a bypass, not a convenience.
    const legacy = await app.inject({
      method: "GET",
      url: "/v1/admin/organizations",
    });
    expect(legacy.statusCode).toBe(403);

    await app.close();
    vi.resetModules();
  });
});

// ---------------------------------------------------------------------------
// Source contract.
// ---------------------------------------------------------------------------

describe("admin-organizations source contract", () => {
  it("every registered route is gated by requirePlatformAdmin", () => {
    const src = readSource(ROUTES);
    // ADM-033 — `/v1/admin/customers` is the canonical path; the
    // `/v1/admin/organizations` pair remains as a compatibility alias.
    for (const path of [
      '"/v1/admin/customers"',
      '"/v1/admin/customers/:id"',
      '"/v1/admin/organizations"',
      '"/v1/admin/organizations/:id"',
    ]) {
      expect(src).toContain(path);
    }
    // Count the gates against the routes rather than pinning a literal, so
    // adding a route without a gate fails here instead of silently passing.
    const routeCount = (src.match(/app\.(get|post|patch|put|delete)\(/g) ?? [])
      .length;
    const gateCount = (src.match(/preHandler: requirePlatformAdmin/g) ?? []).length;
    expect(gateCount).toBe(routeCount);
  });

  it("carries the platform-admin cross-tenant marker", () => {
    // Removing this marker would make an intentional cross-tenant read
    // indistinguishable from a tenant-isolation leak to the scope verifier.
    expect(readSource(ROUTES)).toMatch(
      /TENANT_SCOPE_EXCEPTION:\s*platform_admin_global/,
    );
  });

  it("ADM-002 — the roster reads the CANONICAL customer predicate", () => {
    const src = readSource(SERVICE);
    expect(src).toContain("customerOrganizationWhere");
    expect(src).toMatch(/from "@proovra\/shared-runtime"/);
    // The bare, unfiltered count is what made SYSTEM bootstrap containers show
    // up as customers. It must not come back.
    expect(readCode(SERVICE)).not.toMatch(/organization\.findMany\(\{\s*where: orgWhere/);
  });

  it("ADM-003 — enterprise is the CONTRACT, never a plan string", () => {
    const src = readSource(SERVICE);
    expect(src).toContain("resolveEnterpriseContract");
    // `plans.includes("ENTERPRISE")` reported a customer whose contract had
    // been terminated — but whose workspace still carried the plan string — as
    // a live enterprise customer.
    expect(readCode(SERVICE)).not.toMatch(/enterprise:\s*plans\.includes/);
  });

  it("ADM-004 / ADM-008 — live workspaces and ACTIVE-only seats", () => {
    const src = readSource(SERVICE);
    expect(src).toContain("liveWorkspaceWhere");
    expect(src).toContain("seatConsumingMemberCountArgs");
    // The legacy discriminator and the all-status seat count are both gone.
    expect(readCode(SERVICE)).not.toMatch(/isPersonal:\s*false/);
    expect(readCode(SERVICE)).not.toMatch(/select:\s*\{\s*members:\s*true\s*\}/);
  });

  it("ADM-014 — filtering and pagination are pushed into the database", () => {
    const src = readSource(SERVICE);
    expect(src).toMatch(/client\.organization\.count\(\{ where \}\)/);
    expect(src).toMatch(/skip:\s*\(page - 1\) \* limit/);
    expect(src).toMatch(/take:\s*limit/);
    // The in-memory slice that made "total" the length of an array we happened
    // to build, after a sequential per-org enrichment loop.
    expect(readCode(SERVICE)).not.toMatch(/filtered\.slice\(start, start \+ limit\)/);
    expect(readCode(SERVICE)).not.toMatch(/for \(const org of orgs\)\s*\{\s*const item = await/);
  });

  it("the aggregation service selects NO SSO/SCIM secret columns", () => {
    const src = readCode(SERVICE);
    for (const secret of [
      "samlCertificate",
      "samlSpPrivateKey",
      "clientSecretHash",
      "tokenHash",
      "privateKey",
    ]) {
      expect(src).not.toContain(secret);
    }
  });

  it("the aggregation service performs NO writes (read-only)", () => {
    const src = readCode(SERVICE);
    for (const write of [
      ".create(",
      ".createMany(",
      ".update(",
      ".updateMany(",
      ".delete(",
      ".deleteMany(",
      ".upsert(",
    ]) {
      expect(src).not.toContain(write);
    }
  });
});
