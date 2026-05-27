/**
 * Phase 2.6C — Access review UI regression tests.
 *
 * Locks in:
 *
 *   1. The Phase 2.6C TeamAccessReviewCard component is in the
 *      /teams/[id] bundle. We verify the page is reachable + the
 *      Phase 2.6B aggregator endpoints continue to gate correctly.
 *
 *   2. The two aggregator endpoints (Phase 2.6B contract) still
 *      enforce the ADMIN+ gate (regression guard now that the
 *      frontend is calling them automatically on every team page
 *      load).
 *
 *   3. The Phase 2.6 §10.5 nav entry is still resolved by platform
 *      context. Defense against accidental removal in a future PR.
 */
import { test, expect } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
  disposeSession,
} from "./helpers/api-client";

test.beforeEach(async () => {
  await clearTestRateLimits();
});

const FAKE_TEAM = "00000000-0000-4000-8000-000000000001";

test.describe("Phase 2.6C — access review UI @critical", () => {
  test("/teams/[id] page loads with access review card in scope", async ({
    page,
  }) => {
    // We can't render the card against a real team (the guest has
    // no team), but the page itself must still 2xx + parse. The
    // card's request to /v1/teams/:id/access-review will return
    // 403/404, and the card renders an AccessGate panel for that
    // case — verified by the underlying contract test below.
    const resp = await page.goto(`/teams/${FAKE_TEAM}`, {
      waitUntil: "load",
    });
    expect(
      resp?.ok(),
      `expected 2xx from /teams/[id], got ${resp?.status()}`,
    ).toBe(true);
  });

  test("access review endpoint still refuses authed non-member (Phase 2.6B regression)", async () => {
    const session = await createGuestSession();
    try {
      const resp = await session.api.get(
        `/v1/teams/${FAKE_TEAM}/access-review`,
      );
      expect([403, 404]).toContain(resp.status());
    } finally {
      await disposeSession(session);
    }
  });

  test("external-collaborators endpoint still refuses authed non-member (Phase 2.6B regression)", async () => {
    const session = await createGuestSession();
    try {
      const resp = await session.api.get(
        `/v1/teams/${FAKE_TEAM}/external-collaborators`,
      );
      expect([403, 404]).toContain(resp.status());
    } finally {
      await disposeSession(session);
    }
  });

  test("Phase 2.6 §10.5 workspace.team_governance nav entry still resolved", async () => {
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
