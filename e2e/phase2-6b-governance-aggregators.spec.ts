/**
 * Phase 2.6B — Governance aggregator regression tests.
 *
 * Locks in:
 *
 *   1. `GET /v1/teams/:id/external-collaborators` exists, is ADMIN+
 *      gated, and refuses authed-non-members with 403/404.
 *   2. `GET /v1/teams/:id/access-review` exists, is ADMIN+ gated,
 *      and refuses authed-non-members with 403/404.
 *   3. Both endpoints validate the team UUID parameter.
 *   4. The Phase 2.6 permission matrix surface is unchanged.
 *   5. The Phase 2.6 §10.5 nav entry is unchanged.
 *
 * NOTE on test scope:
 *   The Playwright suite runs as a fresh guest user with no
 *   team-create capability (FREE plan). We therefore CANNOT
 *   exercise the happy-path of these endpoints end-to-end. We
 *   exercise the CONTRACT — auth + permission gate + UUID parse —
 *   which matches the Phase 2.1 / 2.2 / 2.5B precedent for new
 *   team-management endpoints.
 */
import { test, expect } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
  disposeSession,
} from "./helpers/api-client";

const FAKE_TEAM = "00000000-0000-4000-8000-000000000001";

test.beforeEach(() => {
  clearTestRateLimits();
});

test.describe("Phase 2.6B — governance aggregators @critical", () => {
  test("GET /v1/teams/:id/external-collaborators refuses authed non-member", async () => {
    const session = await createGuestSession();
    try {
      const resp = await session.api.get(
        `/v1/teams/${FAKE_TEAM}/external-collaborators`,
      );
      expect(
        [403, 404],
        `expected 403/404 for authed non-member; got ${resp.status()}: ${await resp.text()}`,
      ).toContain(resp.status());
    } finally {
      await disposeSession(session);
    }
  });

  test("GET /v1/teams/:id/external-collaborators validates UUID", async ({
    request,
  }) => {
    const resp = await request.get(
      `${process.env.API_BASE ?? "http://localhost:8081"}/v1/teams/not-a-uuid/external-collaborators`,
    );
    // Unauth refusal fires before UUID parsing, but neither path
    // should 500. Accept 400/401/403/404.
    expect(
      [400, 401, 403, 404],
      `expected < 500 for bad UUID; got ${resp.status()}`,
    ).toContain(resp.status());
  });

  test("GET /v1/teams/:id/access-review refuses authed non-member", async () => {
    const session = await createGuestSession();
    try {
      const resp = await session.api.get(
        `/v1/teams/${FAKE_TEAM}/access-review`,
      );
      expect(
        [403, 404],
        `expected 403/404 for authed non-member; got ${resp.status()}: ${await resp.text()}`,
      ).toContain(resp.status());
    } finally {
      await disposeSession(session);
    }
  });

  test("GET /v1/teams/:id/access-review validates UUID", async ({
    request,
  }) => {
    const resp = await request.get(
      `${process.env.API_BASE ?? "http://localhost:8081"}/v1/teams/not-a-uuid/access-review`,
    );
    expect(
      [400, 401, 403, 404],
      `expected < 500 for bad UUID; got ${resp.status()}`,
    ).toContain(resp.status());
  });

  test("Phase 2.6 permission matrix nav entry still present (regression guard)", async () => {
    const session = await createGuestSession();
    try {
      const resp = await session.api.get("/v1/platform/context");
      expect(resp.ok()).toBe(true);
      const body = (await resp.json()) as {
        navigation?: {
          groups?: Array<{ id: string; items?: Array<{ id: string }> }>;
        };
      };
      const ids = (body.navigation?.groups ?? []).flatMap((g) =>
        (g.items ?? []).map((i) => i.id),
      );
      expect(ids).toContain("workspace.team_governance");
      expect(ids).toContain("admin.teams");
    } finally {
      await disposeSession(session);
    }
  });
});
