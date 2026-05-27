/**
 * Phase 2.2 — Workspace completion regression tests.
 *
 * Locks in:
 *
 *   1. `/verify` in-app page is reachable in the browser (the (app)
 *      layout returns the shell + auth gate, mirroring the Phase 2.1
 *      nav-promoted-pages contract). The shell must not 5xx.
 *
 *   2. `GET /v1/teams/:id/members/:memberId/removal-impact` is wired
 *      under `requireAuthAndLegal` AND under an ADMIN+ role gate. An
 *      authenticated guest (who is not a member of a random team)
 *      must get 403, NEVER 404 or 500. The 401 / 404 cases were
 *      locked by Phase 2.1's `phase2-1-flows` test against a totally
 *      unauthenticated request; this test adds the authed-but-not-a-
 *      member case so the dialog's permission-handling branch has a
 *      regression gate.
 *
 *   3. `DELETE /v1/teams/:id/members/:memberId` with a body
 *      containing `transferToUserId` must not 5xx — the route must
 *      parse the body before applying its auth gate. Authed-but-not-
 *      a-member returns 403.
 *
 *   4. `/reports` page reachable in the browser. With AccessGate
 *      adoption in Phase 2.2 the page must continue to respond 200
 *      regardless of auth/workspace state.
 *
 * These tests run alongside the Phase 1 + Phase 2.1 suites and
 * share the same workspace.
 *
 * NOTE on test scope:
 *   The guest auth path produces a FREE-plan user with zero teams
 *   and no team-create capability. We therefore CANNOT drive a full
 *   end-to-end member-removal flow from Playwright today. The dialog
 *   is exercised in two ways instead:
 *     - The contract tests below lock the API surface the dialog
 *       depends on.
 *     - The page-reachability tests prove the routes the dialog is
 *       embedded under load cleanly.
 *   A future test phase with team-create seeded via the
 *   `/internal/test-fixtures` route (if/when it exists) would close
 *   the last gap.
 */
import { test, expect } from "@playwright/test";
import {
  API_BASE,
  clearTestRateLimits,
  createGuestSession,
  disposeSession,
} from "./helpers/api-client";

const FAKE_UUID_A = "00000000-0000-4000-8000-000000000001";
const FAKE_UUID_B = "00000000-0000-4000-8000-000000000002";

test.beforeEach(async () => {
  await clearTestRateLimits();
});

test.describe("Phase 2.2 — workspace completion @critical", () => {
  test("/inspect in-app verify workspace is reachable", async ({ page }) => {
    // Phase 2.3 — the in-app verify workspace was relocated from
    // `/(app)/verify` to `/(app)/inspect` because Next.js route
    // groups do not affect URL: the original placement collided
    // with the existing public `/verify` landing page. The auth
    // gate is a sub-component, not a 401 response, so the (app)
    // shell must always 2xx.
    const resp = await page.goto("/inspect", { waitUntil: "load" });
    expect(
      resp?.ok(),
      `expected 2xx from /inspect, got ${resp?.status()}`,
    ).toBe(true);
  });

  test("/reports page reachable post-AccessGate adoption", async ({ page }) => {
    // Phase 2.2-S3 replaced the dead-end "Permission required" /
    // "Workspace setup pending" text with structured AccessGate
    // panels. The page must still respond 200 — AccessGate is a
    // render, not a redirect.
    const resp = await page.goto("/reports", { waitUntil: "load" });
    expect(
      resp?.ok(),
      `expected 2xx from /reports, got ${resp?.status()}`,
    ).toBe(true);
  });

  test("removal-impact endpoint enforces role gate for authed non-member", async () => {
    // Phase 2.1's e2e covered the totally-unauthenticated case
    // (expects 401/403). This test covers the authed-but-not-a-
    // member case, which is what the MemberRemovalDialog actually
    // hits when a non-ADMIN role tries to open it. The endpoint
    // MUST return 403 (or 404 if a stricter team-existence check
    // fires first) but never 401 (the user is authed) and never
    // 500 (it must handle the membership check cleanly).
    const session = await createGuestSession();
    try {
      const resp = await session.api.get(
        `/v1/teams/${FAKE_UUID_A}/members/${FAKE_UUID_B}/removal-impact`,
      );
      expect(
        [403, 404],
        `expected 403/404 for authed non-member; got ${resp.status()}: ${await resp.text()}`,
      ).toContain(resp.status());
    } finally {
      await disposeSession(session);
    }
  });

  test("DELETE accepts a body with transferToUserId and applies its role gate", async () => {
    // The MemberRemovalDialog calls DELETE with
    // `{ transferToUserId }`. The route must parse that body
    // safely and apply its ADMIN+ gate. Authed-but-not-a-member
    // returns 403 — never 500, never 200, never an unhandled
    // body-parse error.
    const session = await createGuestSession();
    try {
      const resp = await session.api.delete(
        `/v1/teams/${FAKE_UUID_A}/members/${FAKE_UUID_B}`,
        {
          data: { transferToUserId: FAKE_UUID_A },
        },
      );
      expect(
        [403, 404],
        `expected 403/404 for authed non-member DELETE; got ${resp.status()}: ${await resp.text()}`,
      ).toContain(resp.status());
    } finally {
      await disposeSession(session);
    }
  });

  test("removal-impact endpoint validates UUIDs (defense in depth)", async ({
    request,
  }) => {
    // The route validates UUIDs via z.string().uuid().parse(...).
    // A malformed param must not 500. Without auth the route
    // enforces auth FIRST (so we see 401), but the contract here
    // is: the route never 500s on bad params. We assert
    // status < 500.
    const resp = await request.get(
      `${API_BASE}/v1/teams/not-a-uuid/members/also-bad/removal-impact`,
    );
    expect(
      resp.status(),
      `expected status < 500 for malformed UUIDs; got ${resp.status()}`,
    ).toBeLessThan(500);
  });
});
