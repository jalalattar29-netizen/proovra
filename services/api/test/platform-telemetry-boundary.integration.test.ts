/**
 * PLATFORM TELEMETRY BOUNDARY — executed against live PostgreSQL 16.
 *
 * THE DEFECT THESE TESTS EXIST TO PIN
 * ---------------------------------------------------------------------------
 * `GET /v1/ops/metrics` and `GET /v1/ops/alerts` proved ACTIVE membership of a
 * workspace and then returned `snapshotMetrics()` — the process-global counter
 * and gauge registry — unfiltered. The workspace id was an authorization
 * TICKET, not a FILTER, so any member of any workspace could read platform-wide
 * telemetry: incident counts across every tenant, `secrets_fallback_total`,
 * `authorize_allowed_total`, queue and worker state.
 *
 * A source-contract test cannot catch this. The gate was present, spelled
 * correctly, and returned true — the data was simply wider than the gate. So
 * these tests issue real HTTP through the real app and assert on the BODY.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  bootstrapPersonalSpace,
  seedOrganizationTenant,
  seedPersonalTenant,
  seedUser,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

/** Metric names that must never appear in a tenant-facing response. */
const GLOBAL_METRIC_NAMES = [
  "operational_incidents_open",
  "operational_incidents_open_high",
  "operational_incidents_open_critical",
  "secrets_fallback_total",
  "authorize_allowed_total",
  "observability_alerts_firing",
];

describe("PLATFORM TELEMETRY BOUNDARY (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];
  let secret: string;
  let deps: FixtureDeps;

  /** Mint the way auth.routes.ts does, without any admin role claim. */
  function mint(userId: string, email: string): string {
    return signJwt(
      {
        sub: userId,
        provider: "EMAIL",
        email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
      },
      secret,
      60 * 60,
    );
  }

  let freeUser: SeededUser;
  let proUser: SeededUser;
  let orgOwner: SeededUser;
  let platformAdmin: SeededUser;
  let freeWorkspaceId: string;
  let otherWorkspaceId: string;

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
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `tele-${Date.now().toString(36)}`,
      mintToken: (userId, email) => mint(userId, email),
    };

    const freeTenant = await seedPersonalTenant(deps, "FREE");
    freeUser = freeTenant.owner;
    freeWorkspaceId = freeTenant.personalTeamId;

    const proTenant = await seedPersonalTenant(deps, "PRO");
    proUser = proTenant.owner;
    otherWorkspaceId = proTenant.personalTeamId;

    orgOwner = (await seedOrganizationTenant(deps)).owner;

    platformAdmin = await seedUser(deps, "tele-platform-admin");
    await bootstrapPersonalSpace(deps, platformAdmin.userId);
    await prisma.user.update({
      where: { id: platformAdmin.userId },
      data: { platformRole: "admin" },
    });
  });

  // =========================================================================
  // The leak itself.
  // =========================================================================

  describe("global runtime telemetry is refused to every non-platform caller", () => {
    const globalRoutes = [
      "/v1/ops/metrics",
      "/v1/ops/alerts",
      "/v1/admin/platform/metrics",
      "/v1/admin/platform/alerts",
    ];

    it("refuses a FREE workspace member — the exact account shape that could read it", async () => {
      for (const url of globalRoutes) {
        const res = await get(
          `${url}?teamId=${encodeURIComponent(freeWorkspaceId)}`,
          freeUser.token,
        );
        expect(
          res.statusCode,
          `${url} served global telemetry to a FREE member`,
        ).not.toBe(200);
      }
    });

    it("refuses PRO and organization-owner callers", async () => {
      for (const actor of [proUser, orgOwner]) {
        for (const url of globalRoutes) {
          const res = await get(url, actor.token);
          expect(res.statusCode, `${url} admitted ${actor.email}`).not.toBe(200);
        }
      }
    });

    it("refuses anonymous callers", async () => {
      for (const url of globalRoutes) {
        const res = await get(url);
        expect(res.statusCode, `${url} admitted an anonymous caller`).not.toBe(200);
      }
    });

    it("admits a real platform admin", async () => {
      for (const url of ["/v1/admin/platform/metrics", "/v1/admin/platform/alerts"]) {
        const res = await get(url, platformAdmin.token);
        expect(res.statusCode, `${url} refused a platform admin`).toBe(200);
        expect(res.json().scope).toBe("PLATFORM");
      }
    });

    it("carries genuinely PLATFORM-WIDE data — which is why it had to be gated", async () => {
      // The point of the fix is not that the endpoint is sensitive in the
      // abstract: it is that the payload is the process-global registry. This
      // asserts the payload really is global, so the test suite records WHY a
      // membership gate could never have been correct for it.
      const res = await get("/v1/admin/platform/metrics", platformAdmin.token);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.metrics).toBeTruthy();
      expect(body.countersResetOnRestart).toBe(true);
      const raw = JSON.stringify(body);
      const present = GLOBAL_METRIC_NAMES.filter((n) => raw.includes(n));
      expect(
        present.length,
        "the global registry shape is absent — this endpoint may no longer be the thing being protected",
      ).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // No bypass. The ticket was the defect; removing it must not restore access.
  // =========================================================================

  describe("the workspace ticket cannot be used to widen scope again", () => {
    it("omitting teamId does not fall back to global access", async () => {
      for (const url of ["/v1/ops/metrics", "/v1/ops/alerts"]) {
        const res = await get(url, freeUser.token);
        expect(res.statusCode, `${url} leaked with no teamId`).not.toBe(200);
      }
    });

    it("naming a workspace the caller does not belong to does not help", async () => {
      const res = await get(
        `/v1/ops/metrics?teamId=${encodeURIComponent(otherWorkspaceId)}`,
        freeUser.token,
      );
      expect(res.statusCode).not.toBe(200);
    });

    it("a well-formed but unknown workspace id does not expose global data", async () => {
      const res = await get(
        `/v1/ops/metrics?teamId=${randomUUID()}`,
        freeUser.token,
      );
      expect(res.statusCode).not.toBe(200);
    });
  });

});
