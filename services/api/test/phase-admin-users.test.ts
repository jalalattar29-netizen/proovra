/**
 * Platform Control Center P1 — Platform Users roster contract.
 *
 * File-text contracts (no running DB / no live auth) matching the
 * prevailing admin-route test style in this package. They pin the
 * HONESTY + SECURITY invariants of GET /v1/admin/users:
 *
 *   1. The route is gated by requirePlatformAdmin (non-platform denied
 *      by the shared middleware — RBAC boundary is authoritative).
 *   2. It is paginated, searchable (email/name), and filterable
 *      (platformRole, provider, suspended).
 *   3. NO password hash / MFA secret material / token / secret ever
 *      appears in the selected payload.
 *   4. lastLoginAt is DERIVED from the login_completed analytics event —
 *      real-or-null, never fabricated (no Date.now()/synthetic default).
 *   5. Absent signals are honest null (riskStatus).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const API_ROOT = resolve(__dirname, "..");

function read(rel: string): string {
  return readFileSync(resolve(API_ROOT, rel), "utf8");
}

const ROUTE = read("src/routes/admin-users.routes.ts");

// The route's own doc comments name the forbidden fields (to explain
// that they are deliberately excluded). For the no-secrets assertions
// we inspect the CODE only, with block + line comments stripped, so the
// documentation of the invariant does not trip the invariant.
const ROUTE_CODE = ROUTE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /\/\/[^\n]*/g,
  ""
);

describe("admin-users route — gating", () => {
  it("registers GET /v1/admin/users", () => {
    expect(ROUTE).toMatch(/app\.get\(\s*"\/v1\/admin\/users"/);
  });

  it("gates the endpoint behind requirePlatformAdmin", () => {
    expect(ROUTE).toMatch(/preHandler:\s*requirePlatformAdmin/);
    expect(ROUTE).toMatch(
      /import \{ requirePlatformAdmin \} from "\.\.\/middleware\/require-platform-admin\.js"/
    );
  });
});

describe("admin-users route — pagination / search / filter", () => {
  it("supports page + pageSize pagination with skip/take", () => {
    expect(ROUTE).toMatch(/page:\s*z\.coerce\.number\(\)/);
    expect(ROUTE).toMatch(/pageSize:\s*z\.coerce/);
    expect(ROUTE).toMatch(/skip,/);
    expect(ROUTE).toMatch(/take:\s*pageSize/);
    // Returns total + totalPages so the client can paginate honestly.
    expect(ROUTE).toMatch(/prisma\.user\.count\(\{ where \}\)/);
    expect(ROUTE).toMatch(/totalPages/);
  });

  it("searches by email and name (case-insensitive)", () => {
    expect(ROUTE).toMatch(/email:\s*\{ contains:\s*search,\s*mode:\s*"insensitive" \}/);
    expect(ROUTE).toMatch(/displayName:\s*\{ contains:\s*search/);
    expect(ROUTE).toMatch(/firstName:\s*\{ contains:\s*search/);
    expect(ROUTE).toMatch(/lastName:\s*\{ contains:\s*search/);
  });

  it("filters by platformRole, provider, and suspended", () => {
    expect(ROUTE).toMatch(/platformRole:\s*z\.enum\(\["admin"\]\)/);
    expect(ROUTE).toMatch(/provider:\s*z\.enum\(\["GOOGLE",\s*"APPLE",\s*"GUEST",\s*"EMAIL"\]\)/);
    expect(ROUTE).toMatch(/suspended:/);
    // suspended → TeamMember.status SUSPENDED/REVOKED relation predicate.
    expect(ROUTE).toMatch(/TeamMemberStatus\.SUSPENDED/);
    expect(ROUTE).toMatch(/TeamMemberStatus\.REVOKED/);
  });
});

describe("admin-users route — NO secrets ever leave the endpoint", () => {
  it("never selects passwordHash", () => {
    expect(ROUTE_CODE).not.toMatch(/passwordHash/);
  });

  it("never reads MFA secret material (ciphertext / iv / auth tag / kek)", () => {
    expect(ROUTE_CODE).not.toMatch(/secretCiphertext/);
    expect(ROUTE_CODE).not.toMatch(/secretIv/);
    expect(ROUTE_CODE).not.toMatch(/secretAuthTag/);
    expect(ROUTE_CODE).not.toMatch(/secretKekId/);
  });

  it("never selects tokens or generic secret columns as data fields", () => {
    // No selected/emitted field is a token or secret. `: true` is the
    // Prisma select shape; `xxx:` is an emitted response field.
    expect(ROUTE_CODE).not.toMatch(/token[A-Za-z]*:\s*true/i);
    expect(ROUTE_CODE).not.toMatch(/secret[A-Za-z]*:\s*true/i);
    expect(ROUTE_CODE).not.toMatch(/token[A-Za-z]*:\s*[a-z]/i);
    expect(ROUTE_CODE).not.toMatch(/secret[A-Za-z]*:\s*[a-z]/i);
  });

  it("derives mfaEnrolled from a COUNT of factors, not their secrets", () => {
    expect(ROUTE).toMatch(/mfaFactors:\s*\{/);
    expect(ROUTE).toMatch(/mfaEnrolled:\s*u\._count\.mfaFactors > 0/);
  });
});

describe("admin-users route — lastLoginAt is real-or-null (never fabricated)", () => {
  it("derives lastLoginAt from the login_completed analytics event", () => {
    expect(ROUTE).toMatch(/eventType:\s*"login_completed"/);
    expect(ROUTE).toMatch(/prisma\.analyticsEvent\.groupBy/);
    expect(ROUTE).toMatch(/_max:\s*\{ createdAt: true \}/);
  });

  it("falls back to null (never Date.now / synthetic) when no login event exists", () => {
    expect(ROUTE).toMatch(/lastLoginByUser\.get\(u\.id\) \?\? null/);
    expect(ROUTE).toMatch(/lastLoginAt \? lastLoginAt\.toISOString\(\) : null/);
    // No fabricated timestamp default.
    expect(ROUTE).not.toMatch(/lastLoginAt:\s*new Date\(\)/);
  });
});

describe("admin-users route — honest nulls for unmeasured signals", () => {
  it("returns riskStatus as null (no per-user risk model yet)", () => {
    expect(ROUTE).toMatch(/riskStatus:\s*null/);
  });

  it("emits country / timezone as real-or-null (?? null), not empty string", () => {
    expect(ROUTE).toMatch(/country:\s*u\.country \?\? null/);
    expect(ROUTE).toMatch(/timezone:\s*u\.timezone \?\? null/);
  });

  it("uses real membership counts from _count (not hardcoded numbers)", () => {
    expect(ROUTE).toMatch(/orgMembershipsCount:\s*u\._count\.organizationMemberships/);
    expect(ROUTE).toMatch(/workspaceMembershipsCount:\s*u\._count\.teamMembers/);
  });
});
