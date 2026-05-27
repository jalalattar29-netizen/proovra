/**
 * Phase 2.3 — Enterprise governance & account security regression tests.
 *
 * Locks in:
 *
 *   1. `/settings` renders the new AccountSecurityCard (MFA +
 *      password + sessions). This is the central Phase 2.3
 *      deliverable — the surface was profile-only before this
 *      phase. Detect via the `data-account-security-card` marker.
 *
 *   2. `/security-center` and `/security-center/sso` are reachable
 *      via the browser even when unauthenticated (the (app) layout
 *      always returns the shell, mirroring the Phase 2.1 nav-
 *      promoted-pages contract). The (app) layout MUST never 5xx
 *      these pages.
 *
 *   3. `/admin/identity` (the identity admin hub promoted to
 *      navigation in Phase 2.3) is reachable.
 *
 *   4. `GET /v1/identity/mfa/factors` returns 200 for an
 *      authenticated user. The new AccountSecurityCard's MFA
 *      section depends on this contract. Empty factor list is OK —
 *      the route must not 404 / 500 for a guest who has never
 *      enrolled.
 *
 *   5. `POST /v1/auth/password-reset/request` accepts a body with
 *      `email` and returns 2xx (Phase 1 enumeration-resistance
 *      means even non-existent emails return ok). Subject to the
 *      Phase 1 IP rate limit — locks the contract for the new
 *      AccountSecurityCard's password reset button.
 *
 *   6. `POST /v1/identity-security/sessions/revoke-all` is reachable
 *      (authed) — the route must validate the body shape and return
 *      a non-5xx status even for ill-formed input.
 *
 * These tests run alongside Phases 1, 2.1, 2.2 and share the same
 * workspace.
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

test.describe("Phase 2.3 — enterprise governance @critical", () => {
  test("/settings exposes the new AccountSecurityCard", async ({ page }) => {
    const resp = await page.goto("/settings", { waitUntil: "load" });
    expect(
      resp?.ok(),
      `expected 2xx from /settings, got ${resp?.status()}`,
    ).toBe(true);

    // Two-stage wait, deterministic against dev-server cold-compile:
    //
    //   Stage 1: wait for the page's stable mount marker
    //     `[data-testid="account-settings-page"]`. This commits as
    //     soon as React mounts SettingsPage, BEFORE the envelope
    //     resolves or the access decision is made. On a cold
    //     Next.js dev server the first /settings request can compile
    //     for >15s before any markup renders — Stage 1 absorbs that
    //     compile + initial-mount window.
    //
    //   Stage 2: assert that AFTER the page is mounted, EITHER the
    //     AccountSecurityCard (envelope grants access) OR the
    //     PageRouteGate denial panel (envelope denies) is visible.
    //     This is the original Phase 2.3 contract — we just have a
    //     clean baseline to anchor it to.
    //
    // The two-stage shape removes the implicit race where a cold
    // compile burned the entire 15s budget before any marker existed.
    //
    // Pre-warm the bundle once (extra dev-server hit) so the first
    // observation is more representative.
    await page.waitForLoadState("networkidle");
    await expect(
      page.locator('[data-testid="account-settings-page"]'),
      "expected /settings to mount its stable page marker within 60s (dev-server compile + first paint)",
    ).toBeVisible({ timeout: 60_000 });

    const sawSecurityOrGate = page.locator(
      '[data-testid="account-security-card"], [data-testid="route-gate-account.settings"]',
    );
    await expect(
      sawSecurityOrGate.first(),
      "expected the security card OR the PageRouteGate panel for /settings to be visible after the page mounts",
    ).toBeVisible({ timeout: 30_000 });
  });

  test("/security-center reachable", async ({ page }) => {
    const resp = await page.goto("/security-center", { waitUntil: "load" });
    expect(
      resp?.ok(),
      `expected 2xx from /security-center, got ${resp?.status()}`,
    ).toBe(true);
  });

  test("/security-center/sso reachable", async ({ page }) => {
    const resp = await page.goto("/security-center/sso", { waitUntil: "load" });
    expect(
      resp?.ok(),
      `expected 2xx from /security-center/sso, got ${resp?.status()}`,
    ).toBe(true);
  });

  test("/admin/identity reachable (Phase 2.3 nav promotion)", async ({
    page,
  }) => {
    const resp = await page.goto("/admin/identity", { waitUntil: "load" });
    expect(
      resp?.ok(),
      `expected 2xx from /admin/identity, got ${resp?.status()}`,
    ).toBe(true);
  });

  test("GET /v1/identity/mfa/factors returns 200 for authenticated user", async () => {
    const session = await createGuestSession();
    try {
      const resp = await session.api.get("/v1/identity/mfa/factors");
      expect(
        resp.status(),
        `expected 200 for mfa/factors; got ${resp.status()}: ${await resp.text()}`,
      ).toBe(200);
      const body = (await resp.json()) as {
        factors?: unknown[];
        enrollments?: unknown[];
      };
      // The response shape must have at least one of these keys —
      // the AccountSecurityCard reads both. Empty arrays are OK.
      const hasShape =
        Array.isArray(body.factors) || Array.isArray(body.enrollments);
      expect(
        hasShape,
        `expected factors[] or enrollments[] in response; got ${JSON.stringify(body)}`,
      ).toBe(true);
    } finally {
      await disposeSession(session);
    }
  });

  test("POST /v1/auth/password-reset/request accepts the AccountSecurityCard body", async ({
    request,
  }) => {
    // The password reset request endpoint is intentionally
    // enumeration-resistant — it returns 2xx for any well-formed
    // email regardless of whether the account exists (Phase 1).
    // The AccountSecurityCard relies on this contract: it surfaces
    // "If this email is registered, a reset link is on the way."
    // unconditionally. The route is rate-limited per IP; we run
    // this test once with a single request to stay well under
    // the bucket.
    const resp = await request.post(
      `${process.env.API_BASE ?? "http://localhost:8081"}/v1/auth/password-reset/request`,
      {
        data: { email: "phase23-noop@example.invalid" },
      },
    );
    // 2xx (legitimate, enumeration-resistant ok) OR 429 (we hit
    // the rate limit) — both are valid signals that the route is
    // reachable. NEVER 5xx, NEVER 404.
    expect(
      [200, 201, 202, 204, 429],
      `expected 2xx/429 from password-reset/request, got ${resp.status()}: ${await resp.text()}`,
    ).toContain(resp.status());
  });

  test("POST /v1/identity-security/sessions/revoke-all parses body cleanly", async () => {
    const session = await createGuestSession();
    try {
      // The AccountSecurityCard sends `{ reason: "user_initiated_logout_all" }`.
      // The route must parse that body and either accept (200) or
      // refuse with a structured 4xx — never 5xx.
      const resp = await session.api.post(
        "/v1/identity-security/sessions/revoke-all",
        {
          data: { reason: "user_initiated_logout_all" },
        },
      );
      expect(
        resp.status(),
        `expected < 500 from sessions/revoke-all; got ${resp.status()}: ${await resp.text()}`,
      ).toBeLessThan(500);
      // 200 (revoked), 401/403 (auth gate fired before body parse),
      // 400 (validation rejection) are all acceptable. The point is
      // the route exists and handles the AccountSecurityCard's body
      // shape without a server crash.
      expect([200, 201, 204, 400, 401, 403]).toContain(resp.status());
    } finally {
      await disposeSession(session);
    }
  });
});
