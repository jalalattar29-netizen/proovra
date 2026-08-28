/**
 * PLATFORM ADMIN — AUTHORIZATION MATRIX, executed against live PostgreSQL 16.
 *
 * WHY THIS SUITE EXISTS (ADM-023)
 * ---------------------------------------------------------------------------
 * Every `phase-admin-*.test.ts` in this repository is a `readFileSync` of a
 * route file followed by a regex. Those tests assert that a gate is WRITTEN.
 * They cannot assert that it HOLDS, and they cannot fail when it stops holding
 * for a reason that leaves the source text intact — which is exactly how
 * ADM-001 survived: `requirePlatformAdmin` was present on every route, spelled
 * correctly, and returned `true` for a thirty-day-old token belonging to a user
 * who had been demoted.
 *
 * So this suite issues real HTTP requests through the real Fastify app against
 * a real database and asserts real status codes.
 *
 * THE STALE-CLAIM CASE (ADM-001)
 * ---------------------------------------------------------------------------
 * The decisive test mints a token the way `auth.routes.ts` does for a genuine
 * platform admin — including the `role: "admin"` claim — then clears
 * `User.platformRole` and replays the SAME token. Before the fix every
 * `/v1/admin/*` route answered 200. It must now answer 403.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedOrganizationTenant,
  seedPersonalTenant,
  seedUser,
  registerSessionForToken,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

/**
 * Every registered `/v1/admin/*` READ route, with a concrete request the gate
 * must refuse before any handler logic runs.
 *
 * Only routes gated by `requirePlatformAdmin` belong here. The
 * `/v1/admin/identity/*` family is DELIBERATELY absent: it is a workspace-scoped
 * surface that happens to live under an `/admin` path prefix (ADM-013), gated by
 * `requireAuth` + workspace RBAC, and it is covered by
 * `phase-12b-identity-admin-console-matrix`. Asserting it here would encode the
 * very confusion this remediation is removing.
 */
const PLATFORM_ADMIN_READS: ReadonlyArray<{ method: "GET"; url: string }> = [
  { method: "GET", url: "/v1/admin/overview" },
  { method: "GET", url: "/v1/admin/executive" },
  { method: "GET", url: "/v1/admin/customers" },
  { method: "GET", url: "/v1/admin/organizations" },
  { method: "GET", url: "/v1/admin/workspaces" },
  { method: "GET", url: "/v1/admin/users" },
  { method: "GET", url: "/v1/admin/billing/detail" },
  { method: "GET", url: "/v1/admin/evidence-health" },
  { method: "GET", url: "/v1/admin/evidence-health/records?signal=TSA_FAILED" },
  { method: "GET", url: "/v1/admin/incidents" },
  { method: "GET", url: "/v1/admin/security-events" },
  { method: "GET", url: "/v1/admin/platform-health" },
  { method: "GET", url: "/v1/admin/alerts" },
  { method: "GET", url: "/v1/admin/timeline" },
  { method: "GET", url: "/v1/admin/adoption" },
  { method: "GET", url: "/v1/admin/costs" },
  { method: "GET", url: "/v1/admin/search?q=zzz" },
  { method: "GET", url: "/v1/admin/audit-log" },
  { method: "GET", url: "/v1/admin/demo-requests" },
  { method: "GET", url: "/v1/admin/contact-sales" },
  { method: "GET", url: "/v1/admin/lifecycle-requests" },
  { method: "GET", url: "/v1/admin/analytics/dashboard" },
];

/** Platform-scoped MUTATIONS. Refusal must happen before any state changes. */
const PLATFORM_ADMIN_WRITES: ReadonlyArray<{
  method: "POST" | "PATCH";
  url: string;
  payload: unknown;
}> = [
  {
    method: "POST",
    url: `/v1/admin/incidents/${randomUUID()}/acknowledge`,
    payload: {},
  },
  {
    method: "POST",
    url: `/v1/admin/incidents/${randomUUID()}/resolve`,
    payload: { note: "x" },
  },
  {
    method: "POST",
    url: `/v1/admin/incidents/${randomUUID()}/assign`,
    payload: { assigneeUserId: randomUUID() },
  },
  {
    method: "POST",
    url: `/v1/admin/orgs/${randomUUID()}/suspend`,
    payload: { teamId: randomUUID(), reason: "test" },
  },
  {
    method: "POST",
    url: `/v1/admin/orgs/${randomUUID()}/resume`,
    payload: { teamId: randomUUID() },
  },
];

describe("PLATFORM ADMIN — authorization matrix (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let secret: string;
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];

  /** An ordinary authenticated user with no platform role. */
  let normalUser: SeededUser;
  /** An OWNER of a customer organization — a TENANT admin, not a platform one. */
  let tenantAdmin: SeededUser;
  /** A genuine platform admin (`User.platformRole = 'admin'`). */
  let platformAdmin: SeededUser;
  /**
   * A user who WAS a platform admin. Their token still carries `role: "admin"`;
   * their database row no longer does.
   */
  let demotedAdmin: SeededUser;

  /**
   * Mint a token the way `auth.routes.ts#jwtPayloadFromUser` does, including the
   * `role: "admin"` claim when the user is an admin AT MINT TIME. Reproducing
   * the production claim shape is the whole point — a token without the claim
   * could not demonstrate the defect.
   */
  function mintTokenWithRole(
    userId: string,
    email: string,
    role: "admin" | null,
  ): string {
    return signJwt(
      {
        sub: userId,
        provider: "EMAIL",
        email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
        ...(role === "admin" ? { role: "admin" as const } : {}),
      },
      secret,
      60 * 60,
    );
  }

  async function inject(opts: {
    method: "GET" | "POST" | "PATCH";
    url: string;
    token?: string;
    payload?: unknown;
  }): Promise<{ statusCode: number; body: string }> {
    const res = await harness.app.inject({
      method: opts.method,
      url: opts.url,
      ...(opts.token
        ? { headers: { authorization: `Bearer ${opts.token}` } }
        : {}),
      ...(opts.payload !== undefined
        ? { payload: opts.payload as Record<string, unknown> }
        : {}),
    });
    return { statusCode: res.statusCode, body: res.body };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    secret = process.env.AUTH_JWT_SECRET!;

    deps = {
      prisma: prisma as never,
      tag: `adm-authz-${Date.now().toString(36)}`,
      mintToken: (userId, email) => mintTokenWithRole(userId, email, null),
    };

    normalUser = (await seedPersonalTenant(deps, "FREE")).owner;
    tenantAdmin = (await seedOrganizationTenant(deps)).owner;

    // A REAL platform admin: DB role set, token carries the claim.
    platformAdmin = await seedUser(deps, "platform-admin");
    await prisma.user.update({
      where: { id: platformAdmin.userId },
      data: { platformRole: "admin" },
    });
    platformAdmin = {
      ...platformAdmin,
      token: mintTokenWithRole(
        platformAdmin.userId,
        platformAdmin.email,
        "admin",
      ),
    };
    await registerSessionForToken(
      deps,
      platformAdmin.userId,
      platformAdmin.token,
    );

    // The DEMOTED admin: token minted while they held the role, DB cleared
    // afterwards — exactly the offboarding sequence.
    demotedAdmin = await seedUser(deps, "demoted-admin");
    await prisma.user.update({
      where: { id: demotedAdmin.userId },
      data: { platformRole: "admin" },
    });
    demotedAdmin = {
      ...demotedAdmin,
      token: mintTokenWithRole(demotedAdmin.userId, demotedAdmin.email, "admin"),
    };
    await registerSessionForToken(deps, demotedAdmin.userId, demotedAdmin.token);
    await prisma.user.update({
      where: { id: demotedAdmin.userId },
      data: { platformRole: null },
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  // =========================================================================
  // ADM-001 — the finding this suite exists for.
  // =========================================================================

  describe("ADM-001 — a withdrawn platform-admin grant is withdrawn immediately", () => {
    it("refuses EVERY platform-admin read to a token whose admin claim outlived the DB role", async () => {
      for (const route of PLATFORM_ADMIN_READS) {
        const res = await inject({ ...route, token: demotedAdmin.token });
        expect(
          res.statusCode,
          `${route.method} ${route.url} must refuse a stale admin claim`,
        ).toBe(403);
      }
    });

    it("refuses EVERY platform-admin mutation to a stale admin claim", async () => {
      for (const route of PLATFORM_ADMIN_WRITES) {
        const res = await inject({ ...route, token: demotedAdmin.token });
        expect(
          res.statusCode,
          `${route.method} ${route.url} must refuse a stale admin claim`,
        ).toBe(403);
      }
    });

    it("refuses the support-access and break-glass staff surfaces to a stale claim", async () => {
      // These deny with a flat 404 by design (non-disclosure). The assertion is
      // that they DENY — preserving, not weakening, that behaviour.
      for (const url of ["/v1/support-access/grants", "/v1/break-glass/grants"]) {
        const res = await inject({ method: "GET", url, token: demotedAdmin.token });
        expect(res.statusCode, `${url} must refuse a stale admin claim`).toBe(404);
      }
    });

    it("still admits the SAME user the moment the role is restored, on the SAME token", async () => {
      // Proves the gate reads current state in BOTH directions — it is not
      // caching a denial either, and a re-grant does not require re-login.
      await prisma.user.update({
        where: { id: demotedAdmin.userId },
        data: { platformRole: "admin" },
      });
      const allowed = await inject({
        method: "GET",
        url: "/v1/admin/overview",
        token: demotedAdmin.token,
      });
      expect(allowed.statusCode).toBe(200);

      await prisma.user.update({
        where: { id: demotedAdmin.userId },
        data: { platformRole: null },
      });
      const refused = await inject({
        method: "GET",
        url: "/v1/admin/overview",
        token: demotedAdmin.token,
      });
      expect(refused.statusCode).toBe(403);
    });

    it("admits a user PROMOTED after their token was minted (no stale-negative)", async () => {
      // The mirror hazard: a "fast negative" on the missing claim would lock a
      // freshly-promoted operator out until they signed out and back in.
      const promoted = await seedUser(deps, "promoted");
      const tokenWithoutClaim = mintTokenWithRole(
        promoted.userId,
        promoted.email,
        null,
      );
      await registerSessionForToken(deps, promoted.userId, tokenWithoutClaim);

      const before = await inject({
        method: "GET",
        url: "/v1/admin/overview",
        token: tokenWithoutClaim,
      });
      expect(before.statusCode).toBe(403);

      await prisma.user.update({
        where: { id: promoted.userId },
        data: { platformRole: "admin" },
      });

      const after = await inject({
        method: "GET",
        url: "/v1/admin/overview",
        token: tokenWithoutClaim,
      });
      expect(
        after.statusCode,
        "a promotion must take effect on the existing token",
      ).toBe(200);
    });
  });

  // =========================================================================
  // The standing matrix.
  // =========================================================================

  describe("platform-admin reads", () => {
    it("refuse anonymous callers", async () => {
      for (const route of PLATFORM_ADMIN_READS) {
        const res = await inject(route);
        expect(
          res.statusCode,
          `${route.method} ${route.url} must refuse anonymous`,
        ).toBe(401);
      }
    });

    it("refuse an ordinary authenticated user", async () => {
      for (const route of PLATFORM_ADMIN_READS) {
        const res = await inject({ ...route, token: normalUser.token });
        expect(
          res.statusCode,
          `${route.method} ${route.url} must refuse a normal user`,
        ).toBe(403);
      }
    });

    it("refuse a TENANT organization owner (customer admin is not platform admin)", async () => {
      for (const route of PLATFORM_ADMIN_READS) {
        const res = await inject({ ...route, token: tenantAdmin.token });
        expect(
          res.statusCode,
          `${route.method} ${route.url} must refuse a tenant admin`,
        ).toBe(403);
      }
    });

    it("admit a current platform admin", async () => {
      for (const route of PLATFORM_ADMIN_READS) {
        const res = await inject({ ...route, token: platformAdmin.token });
        expect(
          res.statusCode,
          `${route.method} ${route.url} must admit a platform admin (body: ${res.body.slice(0, 300)})`,
        ).toBe(200);
      }
    });
  });

  describe("platform-admin mutations", () => {
    it("refuse anonymous, normal and tenant-admin callers", async () => {
      for (const route of PLATFORM_ADMIN_WRITES) {
        expect(
          (await inject(route)).statusCode,
          `${route.url} anonymous`,
        ).toBe(401);
        expect(
          (await inject({ ...route, token: normalUser.token })).statusCode,
          `${route.url} normal user`,
        ).toBe(403);
        expect(
          (await inject({ ...route, token: tenantAdmin.token })).statusCode,
          `${route.url} tenant admin`,
        ).toBe(403);
      }
    });
  });

  describe("deleted actor", () => {
    it("refuses a token belonging to a user row that no longer exists", async () => {
      const ghost = await seedUser(deps, "ghost");
      const token = mintTokenWithRole(ghost.userId, ghost.email, "admin");
      await registerSessionForToken(deps, ghost.userId, token);
      await prisma.user.delete({ where: { id: ghost.userId } });

      const res = await inject({
        method: "GET",
        url: "/v1/admin/overview",
        token,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(401);
      expect(res.statusCode).toBeLessThan(500);
    });
  });
});
