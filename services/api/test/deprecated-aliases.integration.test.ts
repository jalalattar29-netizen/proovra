/**
 * DEPRECATED ROUTE ALIASES — executed against live PostgreSQL 16.
 *
 * =============================================================================
 * WHAT OWN-3 ASKED FOR, AND WHY THIS FILE IS THE ANSWER
 * =============================================================================
 * Four paths survive a rename:
 *
 *   GET /v1/admin/organizations      -> GET /v1/admin/customers
 *   GET /v1/admin/organizations/:id  -> GET /v1/admin/customers/:id
 *   GET /v1/ops/metrics              -> GET /v1/admin/platform/metrics
 *   GET /v1/ops/alerts               -> GET /v1/admin/platform/alerts
 *
 * The audit recommended deleting all four because a repository search found no
 * consumer. That reasoning does not survive contact with the repository: the
 * search MISSED `apps/web/app/(app)/investigation/page.tsx`, which calls
 * `/v1/ops/metrics` on a sixty-second poll. A search that cannot see an
 * in-repository caller is not evidence about callers outside it, and this
 * repository publishes no OpenAPI document and keeps no access log that could
 * settle the question. So the aliases are RETAINED, and this file pins the two
 * properties that make retaining them safe:
 *
 *   1. ONE implementation. The alias and its successor are the SAME handler
 *      function registered twice — not two bodies that agree today.
 *   2. A bounded removal path, announced on the wire (RFC 8594 / RFC 8288)
 *      rather than in a comment nobody outside this repository can read.
 *
 * =============================================================================
 * WHY "EQUIVALENT" IS NOT ASSERTED AS A BYTE COMPARISON EVERYWHERE
 * =============================================================================
 * The telemetry pair carries a fresh `sampledAtUtc` and a live counter
 * registry; comparing two responses byte-for-byte would be a test of the clock.
 * Equivalence is asserted where it is actually decidable: identical field sets,
 * and — the part a second implementation could not fake — the alias OBSERVING a
 * mutation made through the successor, and the successor observing one made
 * through the alias.
 *
 * The customer pair reads durable rows and carries no timestamp, so that one IS
 * compared as a whole parsed body.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  bootstrapPersonalSpace,
  seedOrganizationTenant,
  seedUser,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

/** Alias -> successor. The whole contract of this file, in one table. */
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["/v1/ops/metrics", "/v1/admin/platform/metrics"],
  ["/v1/ops/alerts", "/v1/admin/platform/alerts"],
  ["/v1/admin/organizations", "/v1/admin/customers"],
];

describe("DEPRECATED ROUTE ALIASES (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let platformAdmin: SeededUser;
  let tenantUser: SeededUser;
  let customerOrgId: string;

  async function get(url: string, token?: string) {
    return harness.app.inject({
      method: "GET",
      url,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    const { prisma } = await import("../src/db.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    const deps: FixtureDeps = {
      prisma: prisma as never,
      tag: `alias-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          60 * 60,
        ),
    };

    // A real CUSTOMER organization, so the roster and the detail read have
    // something to return other than an empty page.
    customerOrgId = (await seedOrganizationTenant(deps)).organizationId;

    tenantUser = await seedUser(deps, "alias-tenant");
    await bootstrapPersonalSpace(deps, tenantUser.userId);

    platformAdmin = await seedUser(deps, "alias-platform-admin");
    await bootstrapPersonalSpace(deps, platformAdmin.userId);
    await prisma.user.update({
      where: { id: platformAdmin.userId },
      data: { platformRole: "admin" },
    });
  });

  // ==========================================================================
  // The wire signal. This is the whole "bounded removal path".
  // ==========================================================================

  describe("every alias declares its own deprecation", () => {
    it("carries Deprecation, a successor Link, and a future Sunset", async () => {
      for (const [alias, canonical] of ALIASES) {
        const res = await get(alias, platformAdmin.token);
        expect(res.statusCode, `${alias} did not answer`).toBe(200);
        expect(
          res.headers.deprecation,
          `${alias} carries no Deprecation header`,
        ).toBe("true");
        expect(res.headers.link).toBe(`<${canonical}>; rel="successor-version"`);
        const sunset = String(res.headers.sunset ?? "");
        expect(
          Number.isFinite(new Date(sunset).getTime()),
          `${alias} Sunset is not a parseable date: ${sunset}`,
        ).toBe(true);
        expect(
          new Date(sunset).getTime(),
          `${alias} Sunset is in the past — removal is overdue, not bounded`,
        ).toBeGreaterThan(Date.now());
      }
    });

    it("marks the parameterised detail alias too", async () => {
      const res = await get(
        `/v1/admin/organizations/${customerOrgId}`,
        platformAdmin.token,
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers.deprecation).toBe("true");
      expect(res.headers.link).toBe(
        '</v1/admin/customers/:id>; rel="successor-version"',
      );
    });

    it("does NOT mark the successor — the path callers are being sent to", async () => {
      // A wrapper applied to the wrong registration would deprecate the
      // destination, which is worse than not marking anything.
      for (const [, canonical] of ALIASES) {
        const res = await get(canonical, platformAdmin.token);
        expect(
          res.headers.deprecation,
          `${canonical} is marked deprecated`,
        ).toBeUndefined();
        expect(res.headers.sunset).toBeUndefined();
      }
      const detail = await get(
        `/v1/admin/customers/${customerOrgId}`,
        platformAdmin.token,
      );
      expect(detail.headers.deprecation).toBeUndefined();
    });
  });

  // ==========================================================================
  // One implementation, not two agreeing ones.
  // ==========================================================================

  describe("an alias runs the successor's handler", () => {
    it("returns the successor's exact field set", async () => {
      for (const [alias, canonical] of ALIASES) {
        const a = await get(alias, platformAdmin.token);
        const c = await get(canonical, platformAdmin.token);
        expect(a.statusCode).toBe(200);
        expect(c.statusCode).toBe(200);
        expect(
          Object.keys(a.json()).sort(),
          `${alias} and ${canonical} returned different fields`,
        ).toEqual(Object.keys(c.json()).sort());
      }
    });

    it("returns the customer roster whole, field for field", async () => {
      // Durable rows, no timestamp in the payload: this pair CAN be compared
      // as a whole body, so it is.
      const a = await get(
        "/v1/admin/organizations?page=1&limit=5",
        platformAdmin.token,
      );
      const c = await get(
        "/v1/admin/customers?page=1&limit=5",
        platformAdmin.token,
      );
      expect(a.statusCode).toBe(200);
      expect(a.json()).toEqual(c.json());
      expect(
        JSON.stringify(a.json()),
        "the roster came back without the seeded customer — this comparison would prove nothing",
      ).toContain(customerOrgId);
    });

    it("returns the customer detail whole, field for field", async () => {
      const a = await get(
        `/v1/admin/organizations/${customerOrgId}`,
        platformAdmin.token,
      );
      const c = await get(
        `/v1/admin/customers/${customerOrgId}`,
        platformAdmin.token,
      );
      expect(a.statusCode).toBe(200);
      expect(a.json()).toEqual(c.json());
    });

    it("observes a registry mutation made through the successor", async () => {
      // The decisive one. Identical field sets are compatible with two
      // independent handlers reading two independent snapshots; seeing the
      // OTHER path's write is not.
      const before = alertEvaluations(
        await get("/v1/ops/metrics", platformAdmin.token),
      );
      const viaCanonical = await get(
        "/v1/admin/platform/alerts",
        platformAdmin.token,
      );
      expect(viaCanonical.statusCode).toBe(200);
      const after = alertEvaluations(
        await get("/v1/ops/metrics", platformAdmin.token),
      );
      expect(
        after,
        "the alias did not see a counter the successor incremented",
      ).toBeGreaterThan(before);
    });

    it("performs the successor's writes when called through the alias", async () => {
      const before = alertEvaluations(
        await get("/v1/admin/platform/metrics", platformAdmin.token),
      );
      const viaAlias = await get("/v1/ops/alerts", platformAdmin.token);
      expect(viaAlias.statusCode).toBe(200);
      const after = alertEvaluations(
        await get("/v1/admin/platform/metrics", platformAdmin.token),
      );
      expect(
        after,
        "/v1/ops/alerts did not run the successor's gauge writes",
      ).toBeGreaterThan(before);
    });
  });

  // ==========================================================================
  // The two regressions the delegation removes.
  // ==========================================================================

  describe("a platform-wide read no longer demands a workspace", () => {
    it("answers without ?teamId=", async () => {
      // `/v1/ops/metrics` resolved the caller's `currentWorkspaceId` and
      // answered 400 WORKSPACE_CONTEXT_REQUIRED when there was none — on a read
      // that has nothing to do with a workspace. `/v1/ops/alerts` was worse: it
      // called `TeamIdQuery.parse`, not `safeParse`, so omitting the parameter
      // raised a ZodError the central handler served as a 500.
      for (const url of ["/v1/ops/metrics", "/v1/ops/alerts"]) {
        const res = await get(url, platformAdmin.token);
        expect(res.statusCode, `${url} still requires a workspace`).toBe(200);
        expect(res.json().scope).toBe("PLATFORM");
      }
    });

    it("ignores a teamId that is present but meaningless", async () => {
      const res = await get(
        "/v1/ops/metrics?teamId=not-a-uuid",
        platformAdmin.token,
      );
      expect(
        res.statusCode,
        "a decorative parameter still influences the response",
      ).toBe(200);
    });
  });

  // ==========================================================================
  // Deprecating a path must not soften its gate.
  // ==========================================================================

  describe("the alias is gated exactly as the successor is", () => {
    it("refuses an anonymous caller on every alias", async () => {
      for (const [alias] of ALIASES) {
        const res = await get(alias);
        expect(res.statusCode, `${alias} admitted an anonymous caller`).not.toBe(
          200,
        );
      }
    });

    it("refuses a tenant caller on every alias", async () => {
      for (const [alias] of ALIASES) {
        const res = await get(alias, tenantUser.token);
        expect(res.statusCode, `${alias} admitted a tenant caller`).not.toBe(
          200,
        );
      }
    });
  });
});

/**
 * The one counter both telemetry paths write and both read.
 *
 * Read defensively: a response that lost the envelope reads as 0 rather than
 * throwing, so the assertion that fails is the meaningful one ("did not
 * increase") rather than a TypeError three frames down.
 */
function alertEvaluations(res: { json: () => unknown }): number {
  const body = res.json() as {
    metrics?: { counters?: Record<string, number> };
  } | null;
  return Number(
    body?.metrics?.counters?.observability_alert_evaluations_total ?? 0,
  );
}
