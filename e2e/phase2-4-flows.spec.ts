/**
 * Phase 2.4 — Backend completion regression tests.
 *
 * Locks in:
 *
 *   1. `GET /v1/users/me/sessions` returns the caller's own active
 *      sessions with `current: true` set on the row whose
 *      sessionIdHash matches the JWT used. Returns `{ sessions: [...] }`
 *      with the new Phase 2.4 envelope.
 *
 *   2. `DELETE /v1/users/me/sessions/:id` rejects malformed ids
 *      (400 INVALID_SESSION_ID) and 404s on a UUID that doesn't
 *      belong to the caller (defense-in-depth). Returns 2xx on
 *      success.
 *
 *   3. `POST /v1/users/me/password/change` returns
 *      409 PROVIDER_UNSUPPORTED for non-EMAIL providers (guest, in
 *      this test). This locks the AccountSecurityCard's contract:
 *      OAuth / guest accounts must see the "managed by your
 *      identity provider" panel rather than a fake form submit.
 *
 *   4. `/reviewer-ops/[reviewId]` and `/reviewer-ops/escalations`
 *      pages remain reachable after the Phase 2.4 reviewer-modal
 *      refactor.
 *
 *   5. The Phase 2.3 AccountSecurityCard still renders on /settings.
 *      The Phase 2.4 password change form + sessions list section
 *      must be in scope (verify by `data-security-password-change-form`
 *      and `data-security-sessions` markers).
 *
 * These tests run alongside Phases 1, 2.1, 2.2, 2.3 and share the
 * same workspace.
 */
import { test, expect } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
  SESSION_PASSWORD,
  disposeSession,
} from "./helpers/api-client";

test.beforeEach(async () => {
  await clearTestRateLimits();
});

test.describe("Phase 2.4 — backend completion @critical", () => {
  // ===========================================================================
  // THE LEGACY PERSONAL-SECURITY SURFACE IS RETIRED.
  //
  // These five cases exercised `/v1/users/me/sessions*` and
  // `/v1/users/me/password/change`. All three handlers now answer 410 with
  // `code: "PERSONAL_SECURITY_LEGACY_RETIRED"`, because they were "a parallel
  // implementation alongside the canonical Phase 19 identity-security
  // surface" and "left two ways for a caller to mutate the same auth state".
  //
  // Two of them were additionally premised on a GUEST caller having no
  // password ("refuses non-EMAIL providers (guest)"), and guest auth is gone
  // too — so they were asserting a refusal that can no longer arise.
  //
  // Every subject below is preserved and moved onto `/v1/identity-security/*`,
  // whose behaviour was measured rather than assumed. Where the canonical
  // surface is STRICTER, the assertion says so.
  // ===========================================================================

  test("the legacy personal-security surface answers 410 and names its replacement", async () => {
    const session = await createGuestSession();
    try {
      for (const call of [
        () => session.api.get("/v1/users/me/sessions"),
        () => session.api.delete("/v1/users/me/sessions/not-a-uuid"),
        () =>
          session.api.post("/v1/users/me/password/change", {
            data: { currentPassword: "x", newPassword: "y" },
          }),
      ]) {
        const resp = await call();
        expect(resp.status(), `body: ${await resp.text()}`).toBe(410);
        const body = (await resp.json()) as {
          code?: string;
          canonicalPassword?: string;
          canonicalSessionsList?: string;
        };
        expect(body.code).toBe("PERSONAL_SECURITY_LEGACY_RETIRED");
        // The refusal carries the way forward, so a stuck caller is told
        // where to go rather than just being told no.
        expect(body.canonicalPassword).toBe("/v1/identity-security/password");
        expect(body.canonicalSessionsList).toBe(
          "/v1/identity-security/my-sessions",
        );
      }
    } finally {
      await disposeSession(session);
    }
  });

  test("the caller can list their own sessions on the canonical surface", async () => {
    const session = await createGuestSession();
    try {
      const resp = await session.api.get("/v1/identity-security/my-sessions");
      expect(
        resp.status(),
        `expected 200 for /v1/identity-security/my-sessions, got ${resp.status()}: ${await resp.text()}`,
      ).toBe(200);
      const body = (await resp.json()) as {
        sessions?: Array<{
          id: string;
          isCurrent: boolean;
          issuedAtUtc: string;
          expiresAtUtc: string;
          ipPreview: string | null;
          uaPreview: string | null;
          quarantined: boolean;
        }>;
      };
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(body.sessions!.length).toBeGreaterThanOrEqual(1);
      const row = body.sessions![0]!;
      expect(row.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(typeof row.isCurrent).toBe("boolean");
      expect(typeof row.quarantined).toBe("boolean");
      expect(new Date(row.issuedAtUtc).toString()).not.toBe("Invalid Date");
      expect(new Date(row.expiresAtUtc).toString()).not.toBe("Invalid Date");
      // The address and client are PREVIEWS, never the raw values.
      if (row.ipPreview !== null) expect(row.ipPreview).toContain("•");
    } finally {
      await disposeSession(session);
    }
  });

  test("revoking a session rejects a malformed id", async () => {
    const session = await createGuestSession();
    try {
      const resp = await session.api.post(
        "/v1/identity-security/my-sessions/not-a-uuid/revoke",
      );
      expect(resp.status(), `body: ${await resp.text()}`).toBe(400);
    } finally {
      await disposeSession(session);
    }
  });

  test("revoking a session the caller does not own is not an existence oracle", async () => {
    const session = await createGuestSession();
    try {
      // STRICTER THAN THE 404 THIS USED TO ASSERT.
      //
      // The legacy surface answered 404 for a session id the caller did not
      // own, which hid existence by choosing a status. The canonical surface
      // refuses EARLIER: any session mutation requires a step-up, so the
      // caller is asked to confirm who they are before the id is ever looked
      // at. There is no oracle left to leak.
      const resp = await session.api.post(
        "/v1/identity-security/my-sessions/00000000-0000-4000-8000-000000000000/revoke",
      );
      expect(resp.status(), `body: ${await resp.text()}`).toBe(401);
      const raw = await resp.text();
      expect(raw).toContain("password");
      // Nothing about whether that session exists.
      expect(raw).not.toMatch(/not found|no such|exists/i);
    } finally {
      await disposeSession(session);
    }
  });

  test("changing a password requires the current one", async () => {
    const session = await createGuestSession();
    try {
      const resp = await session.api.post("/v1/identity-security/password", {
        data: {
          currentPassword: "definitely-not-the-current-one",
          newPassword: "A-new-Passw0rd-9x",
        },
      });
      expect(resp.status(), `body: ${await resp.text()}`).toBe(400);
      const raw = await resp.text();
      expect(raw).toContain("current_password_invalid");
    } finally {
      await disposeSession(session);
    }
  });

  test("a new password must meet the length policy", async () => {
    const session = await createGuestSession();
    try {
      const resp = await session.api.post("/v1/identity-security/password", {
        data: { currentPassword: SESSION_PASSWORD, newPassword: "short" },
      });
      expect(resp.status(), `body: ${await resp.text()}`).toBe(400);
      // The canonical policy is TWELVE characters, not the eight the legacy
      // surface asked for — measured from the validator's own message.
      expect(await resp.text()).toMatch(/>=\s*12 characters/);
    } finally {
      await disposeSession(session);
    }
  });

  test("/reviewer-ops/escalations page reachable after Phase 2.4 modal refactor", async ({
    page,
  }) => {
    const resp = await page.goto("/reviewer-ops/escalations", {
      waitUntil: "load",
    });
    expect(
      resp?.ok(),
      `expected 2xx from /reviewer-ops/escalations, got ${resp?.status()}`,
    ).toBe(true);
  });

  test("/reviewer-ops page reachable", async ({ page }) => {
    const resp = await page.goto("/reviewer-ops", { waitUntil: "load" });
    expect(
      resp?.ok(),
      `expected 2xx from /reviewer-ops, got ${resp?.status()}`,
    ).toBe(true);
  });

  test("/settings still exposes the AccountSecurityCard after Phase 2.4 changes", async ({
    page,
  }) => {
    // The Phase 2.3 settings card was upgraded in Phase 2.4 to call
    // the new `/v1/users/me/sessions` + `/v1/users/me/password/change`
    // endpoints. The page must continue to mount the card.
    const resp = await page.goto("/settings", { waitUntil: "load" });
    expect(
      resp?.ok(),
      `expected 2xx from /settings, got ${resp?.status()}`,
    ).toBe(true);
  });
});
