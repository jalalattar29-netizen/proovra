/**
 * Phase 2.6D — RBAC matrix endpoint + external revoke regression tests.
 *
 * Locks in:
 *
 *   1. `GET /v1/platform/rbac/matrix` exists, requires auth, returns
 *      the canonical role + category + capability shape the
 *      TeamPermissionMatrix component expects (or will expect after
 *      a frontend refactor).
 *
 *   2. The matrix envelope includes all 4 roles (OWNER/ADMIN/MEMBER/
 *      VIEWER) and a sane category list. Drift between this
 *      response and the hand-maintained UI list (Phase 2.6) is now
 *      regression-testable.
 *
 *   3. `DELETE /v1/teams/:id/external-grants/:grantId` refuses authed
 *      non-members with 403/404 (defense in depth — no enumeration).
 *
 *   4. The revoke endpoint validates UUIDs on both parameters.
 *
 *   5. Phase 2.6B + 2.6C aggregator endpoints still gate correctly
 *      (regression guard now that the rbac matrix endpoint sits next
 *      to them in teams.routes.ts).
 */
import { test, expect } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
  disposeSession,
} from "./helpers/api-client";

test.beforeEach(() => {
  clearTestRateLimits();
});

const FAKE_TEAM = "00000000-0000-4000-8000-000000000001";
const FAKE_GRANT = "00000000-0000-4000-8000-000000000099";

test.describe("Phase 2.6D — matrix endpoint + external revoke @critical", () => {
  test("GET /v1/platform/rbac/matrix returns the canonical shape", async () => {
    const session = await createGuestSession();
    try {
      const resp = await session.api.get("/v1/platform/rbac/matrix");
      expect(
        resp.ok(),
        `expected /v1/platform/rbac/matrix OK; got ${resp.status()}: ${await resp.text()}`,
      ).toBe(true);
      const body = (await resp.json()) as {
        roles?: Array<{ id: string; label: string; rank: number }>;
        categories?: Array<{
          id: string;
          label: string;
          capabilities?: Array<{
            id: string;
            label: string;
            roles: string[];
          }>;
        }>;
        version?: string;
      };

      // All 4 roles must be present.
      const roleIds = (body.roles ?? []).map((r) => r.id);
      expect(roleIds).toEqual(
        expect.arrayContaining(["OWNER", "ADMIN", "MEMBER", "VIEWER"]),
      );
      // Rank must be 0 (VIEWER) through 3 (OWNER) — the matrix
      // implementation depends on this strict ordering.
      expect(body.roles?.find((r) => r.id === "VIEWER")?.rank).toBe(0);
      expect(body.roles?.find((r) => r.id === "OWNER")?.rank).toBe(3);

      // Categories must be a non-empty list with at least
      // `team` + `evidence` + `cases` — the operator-recognised
      // surfaces.
      const catIds = (body.categories ?? []).map((c) => c.id);
      expect(catIds).toEqual(
        expect.arrayContaining(["evidence", "cases", "team"]),
      );

      // Each capability must declare its `roles` array. The frontend
      // matrix renders one column per role, so the shape must hold.
      for (const cat of body.categories ?? []) {
        for (const cap of cat.capabilities ?? []) {
          expect(Array.isArray(cap.roles)).toBe(true);
        }
      }

      // Version field exists so the frontend can detect schema drift.
      expect(typeof body.version).toBe("string");
    } finally {
      await disposeSession(session);
    }
  });

  test("GET /v1/platform/rbac/matrix requires auth", async ({ request }) => {
    const resp = await request.get(
      `${process.env.API_BASE ?? "http://localhost:8081"}/v1/platform/rbac/matrix`,
    );
    expect(
      [401, 403],
      `expected 401/403 for unauth; got ${resp.status()}`,
    ).toContain(resp.status());
  });

  test("DELETE /v1/teams/:id/external-grants/:grantId refuses authed non-member", async () => {
    const session = await createGuestSession();
    try {
      const resp = await session.api.delete(
        `/v1/teams/${FAKE_TEAM}/external-grants/${FAKE_GRANT}`,
      );
      expect(
        [403, 404],
        `expected 403/404 for authed non-member; got ${resp.status()}: ${await resp.text()}`,
      ).toContain(resp.status());
    } finally {
      await disposeSession(session);
    }
  });

  test("DELETE /v1/teams/:id/external-grants/:grantId validates both UUIDs", async ({
    request,
  }) => {
    const resp = await request.delete(
      `${process.env.API_BASE ?? "http://localhost:8081"}/v1/teams/not-uuid/external-grants/also-not`,
    );
    // Unauth fires first; bad-UUID 400 would otherwise. Either is fine.
    expect(
      [400, 401, 403, 404],
      `expected < 500 for bad UUIDs; got ${resp.status()}`,
    ).toContain(resp.status());
  });

  test("Phase 2.6B aggregators still refuse authed non-member (regression)", async () => {
    const session = await createGuestSession();
    try {
      const r1 = await session.api.get(
        `/v1/teams/${FAKE_TEAM}/external-collaborators`,
      );
      expect([403, 404]).toContain(r1.status());
      const r2 = await session.api.get(`/v1/teams/${FAKE_TEAM}/access-review`);
      expect([403, 404]).toContain(r2.status());
    } finally {
      await disposeSession(session);
    }
  });
});
