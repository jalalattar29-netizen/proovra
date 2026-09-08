/**
 * MEDIA-INTELLIGENCE RUN LISTING — executed against live PostgreSQL 16.
 *
 * =============================================================================
 * WHAT WAS MISSING (ADM-P2-005 / ADM-P2-003)
 * =============================================================================
 * `/admin/platform/media-graph` offered two actions that each name a run —
 * retry and dismiss — and listed no run. The console rendered a "Failed runs"
 * gauge it could not expand, so the only way to retry anything was to type an
 * id reconstructed from an evidence id obtained out of band, and the "Run
 * dismissed (operator)" tile counted an action the page did not offer at all.
 *
 * `GET /v1/ops/media-intelligence/runs` is the record surface those two
 * actions were missing.
 *
 * =============================================================================
 * THE IDENTIFIER TRAP THIS FILE EXISTS TO PIN
 * =============================================================================
 * The two actions share a path segment name and do not share a namespace:
 *
 *   POST /v1/ops/media-intelligence/runs/:runId/retry     -> BullMQ JOB id
 *   POST /v1/ops/media-intelligence/runs/:runId/dismiss   -> run ROW uuid
 *
 * Today the job id is derived from the row (`mi-run-<runId>`), which makes the
 * two look interchangeable and is exactly why the listing returns BOTH,
 * spelled out, rather than letting a client build one from the other. The
 * assertions below hold the derivation to the queue registry's own function,
 * so moving the prefix moves the listing with it instead of silently
 * de-synchronising a page.
 */
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";
import { buildCanonicalJobId } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  bootstrapPersonalSpace,
  seedPersonalTenant,
  seedUser,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

const LIST = "/v1/ops/media-intelligence/runs";

describe("MEDIA-INTELLIGENCE RUN LISTING (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let platformAdmin: SeededUser;
  let tenantUser: SeededUser;
  let tenantWorkspaceId: string;
  let failedRunId: string;
  let dismissedRunId: string;

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
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    const deps: FixtureDeps = {
      prisma: prisma as never,
      tag: `mi-list-${Date.now().toString(36)}`,
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

    const tenant = await seedPersonalTenant(deps, "PRO");
    tenantUser = tenant.owner;
    tenantWorkspaceId = tenant.personalTeamId;

    platformAdmin = await seedUser(deps, "mi-list-platform-admin");
    await bootstrapPersonalSpace(deps, platformAdmin.userId);
    await prisma.user.update({
      where: { id: platformAdmin.userId },
      data: { platformRole: "admin" },
    });

    // Two runs in the tenant's workspace, in two different statuses, so the
    // status filter has something to distinguish and the listing has something
    // to return. `evidenceId` is a bare uuid: the run table carries no foreign
    // key to Evidence, and this suite is about the listing, not about custody.
    failedRunId = (
      await prisma.mediaIntelligenceRun.create({
        data: {
          teamId: tenantWorkspaceId,
          evidenceId: randomUUID(),
          kind: "extract_exif",
          status: "FAILED",
          attemptCount: 3,
          lastError: "x".repeat(400),
        },
        select: { id: true },
      })
    ).id;

    dismissedRunId = (
      await prisma.mediaIntelligenceRun.create({
        data: {
          teamId: tenantWorkspaceId,
          evidenceId: randomUUID(),
          kind: "analyze_metadata",
          status: "DISMISSED",
        },
        select: { id: true },
      })
    ).id;
  });

  // ==========================================================================
  // Authorization. The listing is cross-tenant, so the gate is the boundary.
  // ==========================================================================

  describe("only a platform admin may read it", () => {
    it("refuses an anonymous caller", async () => {
      const res = await get(LIST);
      expect(res.statusCode).not.toBe(200);
    });

    it("refuses an ordinary workspace member", async () => {
      // The listing spans every workspace on the deployment. No tenant
      // permission can be the right key for that, which is the same reasoning
      // that moved the metrics beside it behind the platform gate.
      const res = await get(LIST, tenantUser.token);
      expect(
        res.statusCode,
        "a tenant caller read the cross-tenant run listing",
      ).not.toBe(200);
    });

    it("admits a platform admin", async () => {
      const res = await get(LIST, platformAdmin.token);
      expect(res.statusCode).toBe(200);
      expect(res.json().scope).toBe("PLATFORM");
    });
  });

  // ==========================================================================
  // The row. Both identifiers, and the workspace the run belongs to.
  // ==========================================================================

  describe("each row carries what the two actions need", () => {
    it("returns the run uuid AND the job id, derived by the queue registry", async () => {
      const res = await get(`${LIST}?status=FAILED&limit=50`, platformAdmin.token);
      expect(res.statusCode).toBe(200);
      const row = res
        .json()
        .runs.find((r: { runId: string }) => r.runId === failedRunId);
      expect(row, "the seeded FAILED run was not listed").toBeTruthy();

      expect(row.runId).toBe(failedRunId);
      // Held to the registry's own builder rather than a literal, so a change
      // to the prefix moves this listing instead of stranding the page.
      expect(row.jobId).toBe(
        buildCanonicalJobId({ jobIdPrefix: "mi-run" }, failedRunId),
      );
      expect(row.jobId).not.toBe(row.runId);
    });

    it("names the run's own workspace, because dismiss filters on it", async () => {
      // `dismissRun(runId, teamId)` uses teamId as a WHERE clause, unlike
      // retry and DLQ replay where it is the audit scope. A console that could
      // not see the run's workspace would have to send the operator's, which
      // matches no row and reads as "already dismissed".
      const res = await get(`${LIST}?status=FAILED&limit=50`, platformAdmin.token);
      const row = res
        .json()
        .runs.find((r: { runId: string }) => r.runId === failedRunId);
      expect(row.teamId).toBe(tenantWorkspaceId);
    });

    it("bounds lastError rather than returning the whole column", async () => {
      const res = await get(`${LIST}?status=FAILED&limit=50`, platformAdmin.token);
      const row = res
        .json()
        .runs.find((r: { runId: string }) => r.runId === failedRunId);
      expect(row.lastError.length).toBeLessThanOrEqual(200);
    });
  });

  // ==========================================================================
  // The query.
  // ==========================================================================

  describe("filtering and bounds", () => {
    it("filters by status", async () => {
      const res = await get(
        `${LIST}?status=DISMISSED&limit=100`,
        platformAdmin.token,
      );
      expect(res.statusCode).toBe(200);
      const ids = res.json().runs.map((r: { runId: string }) => r.runId);
      expect(ids).toContain(dismissedRunId);
      expect(
        ids,
        "a status filter returned a run in a different status",
      ).not.toContain(failedRunId);
      for (const r of res.json().runs) expect(r.status).toBe("DISMISSED");
    });

    it("caps the page and says whether there is more", async () => {
      const res = await get(`${LIST}?limit=1`, platformAdmin.token);
      expect(res.statusCode).toBe(200);
      expect(res.json().runs).toHaveLength(1);
      expect(res.json().limit).toBe(1);
      expect(typeof res.json().hasMore).toBe("boolean");
    });

    it("refuses an out-of-range limit with a bounded 400", async () => {
      const res = await get(`${LIST}?limit=5000`, platformAdmin.token);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("INVALID_QUERY");
    });

    it("refuses an unknown status rather than ignoring it", async () => {
      // Silently dropping an unrecognised filter would answer a question the
      // operator did not ask, with a list they would read as complete.
      const res = await get(`${LIST}?status=NOPE`, platformAdmin.token);
      expect(res.statusCode).toBe(400);
    });
  });
});
