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

/**
 * ADM-028 (2026-08-27) — the roster's QUERY moved out of the route.
 *
 * `admin-users.routes.ts` is now a validator and a projection boundary; the
 * pagination, the search predicate, the commercial filters and every batched
 * rollup live in `services/admin/people.service.ts`. These contracts follow the
 * logic rather than the path — asserting them against the route would pass
 * vacuously the moment anything moved, which is the opposite of what they are for.
 */
const SERVICE = read("src/services/admin/people.service.ts");

/**
 * The whole users surface: the route plus the service behind it.
 *
 * ADM-028 (2026-08-27) — the roster's QUERY moved out of the route.
 * `admin-users.routes.ts` is now a validator and a projection boundary; the
 * pagination, the search predicate, the commercial filters and every batched
 * rollup live in `people.service.ts`. These contracts follow the LOGIC rather
 * than the path — asserting them against the route alone would pass vacuously
 * the moment anything moved, which is the opposite of what they exist for.
 */
const SURFACE = `${ROUTE}\n${SERVICE}`;

// The route's own doc comments name the forbidden fields (to explain
// that they are deliberately excluded). For the no-secrets assertions
// we inspect the CODE only, with block + line comments stripped, so the
// documentation of the invariant does not trip the invariant.
const SURFACE_CODE = SURFACE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /\/\/[^\n]*/g,
  ""
);

describe("admin-users route — gating", () => {
  it("registers GET /v1/admin/users", () => {
    expect(ROUTE).toMatch(/app\.get\(\s*"\/v1\/admin\/users"/);
  });

  it("gates the endpoint behind requirePlatformAdmin", () => {
    expect(SURFACE).toMatch(/preHandler:\s*requirePlatformAdmin/);
    expect(SURFACE).toMatch(
      /import \{ requirePlatformAdmin \} from "\.\.\/middleware\/require-platform-admin\.js"/
    );
  });
});

describe("admin-users route — pagination / search / filter", () => {
  it("supports page + pageSize pagination with skip/take", () => {
    expect(SURFACE).toMatch(/page:\s*z\.coerce\.number\(\)/);
    expect(SURFACE).toMatch(/pageSize:\s*z\.coerce/);
    expect(SERVICE).toMatch(/skip: \(page - 1\) \* pageSize/);
    expect(SURFACE).toMatch(/take:\s*pageSize/);
    // Returns total + totalPages so the client can paginate honestly.
    expect(SURFACE).toContain("user.count({ where })");
    expect(SURFACE).toMatch(/totalPages/);
  });

  it("searches by email and name (case-insensitive)", () => {
    expect(SURFACE).toMatch(/email: \{ contains: q, mode: "insensitive" \}/);
    expect(SURFACE).toMatch(/displayName: \{ contains: q/);
    expect(SURFACE).toMatch(/firstName: \{ contains: q/);
    expect(SURFACE).toMatch(/lastName: \{ contains: q/);
  });

  it("filters by platformRole, provider, and the commercial dimension", () => {
    expect(SURFACE).toMatch(/platformRole:\s*z\.enum\(\["admin"\]\)/);
    expect(SURFACE).toMatch(/provider:\s*z\.enum\(\["GOOGLE",\s*"APPLE",\s*"GUEST",\s*"EMAIL"\]\)/);
    // ADM-028 — the `suspended` filter is deliberately GONE. It was derived
    // from `TeamMember.status` across ALL of a user’s memberships and
    // presented as an ACCOUNT state; `User` models no account-level disable
    // at all, so someone suspended from one workspace and active in five read
    // as suspended platform-wide. Membership states are now reported AS
    // memberships, and the filters that replaced it are commercial.
    expect(SURFACE).toMatch(/tier: z\.enum/);
    expect(SURFACE).toMatch(/subscriptionStatus/);
    expect(SURFACE).toMatch(/pendingCancellation/);
    expect(SURFACE).toMatch(/memberships: \{/);
    expect(SURFACE).not.toMatch(/suspended: z\./);
  });
});

describe("admin-users route — NO secrets ever leave the endpoint", () => {
  it("never selects passwordHash", () => {
    expect(SURFACE_CODE).not.toMatch(/passwordHash/);
  });

  it("never reads MFA secret material (ciphertext / iv / auth tag / kek)", () => {
    expect(SURFACE_CODE).not.toMatch(/secretCiphertext/);
    expect(SURFACE_CODE).not.toMatch(/secretIv/);
    expect(SURFACE_CODE).not.toMatch(/secretAuthTag/);
    expect(SURFACE_CODE).not.toMatch(/secretKekId/);
  });

  it("never selects tokens or generic secret columns as data fields", () => {
    // No selected/emitted field is a token or secret. `: true` is the
    // Prisma select shape; `xxx:` is an emitted response field.
    expect(SURFACE_CODE).not.toMatch(/token[A-Za-z]*:\s*true/i);
    expect(SURFACE_CODE).not.toMatch(/secret[A-Za-z]*:\s*true/i);
    expect(SURFACE_CODE).not.toMatch(/token[A-Za-z]*:\s*[a-z]/i);
    expect(SURFACE_CODE).not.toMatch(/secret[A-Za-z]*:\s*[a-z]/i);
  });

  it("derives mfaEnrolled from a COUNT of factors, not their secrets", () => {
    expect(SURFACE).toMatch(/mfaFactors:\s*\{/);
    expect(SURFACE).toMatch(/mfaEnrolled:\s*u\._count\.mfaFactors > 0/);
  });
});

describe("admin-users route — lastLoginAt is real-or-null (never fabricated)", () => {
  it("derives lastLoginAt from the login_completed analytics event", () => {
    expect(SURFACE).toMatch(/eventType:\s*"login_completed"/);
    expect(SURFACE).toMatch(/analyticsEvent\.groupBy/);
    expect(SURFACE).toMatch(/_max:\s*\{ createdAt: true \}/);
  });

  it("falls back to null (never Date.now / synthetic) when no login event exists", () => {
    expect(SURFACE).toMatch(/lastLoginByUser\.get\(u\.id\)\?\.toISOString\(\) \?\? null/);
    // No fabricated timestamp default.
    expect(ROUTE).not.toMatch(/lastLoginAt:\s*new Date\(\)/);
  });
});

describe("admin-users route — honest nulls for unmeasured signals", () => {
  it("returns riskStatus as null (no per-user risk model yet)", () => {
    expect(SURFACE).toMatch(/riskStatus:\s*null/);
  });

  it("emits country / timezone as real-or-null (?? null), not empty string", () => {
    expect(SURFACE).toMatch(/country:\s*u\.country \?\? null/);
    expect(SURFACE).toMatch(/timezone:\s*u\.timezone \?\? null/);
  });

  it("uses real membership counts from _count (not hardcoded numbers)", () => {
    expect(SURFACE).toMatch(/orgMembershipsCount:\s*u\._count\.organizationMemberships/);
    expect(SURFACE).toMatch(/workspaceMembershipsCount:\s*u\._count\.teamMembers/);
  });
});
