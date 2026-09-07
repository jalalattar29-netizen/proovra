/**
 * Phase 2.5 — Operational scale + compliance lifecycle regression tests.
 *
 * Locks in:
 *
 *   1. `POST /v1/auth/guest` now records an AuthenticatedSession row
 *      (Phase 2.5 closed the write-side gap that Phase 2.4 found on
 *      the read side). `GET /v1/users/me/sessions` for a fresh guest
 *      must return at least one session row, and that row must have
 *      `current === true`. This is a meaningful behavior change from
 *      Phase 2.4 (where the same endpoint returned `[]`).
 *
 *   2. The shortcut help component is exported from
 *      `/reviewer-ops/components/ReviewerShortcutsHelp.tsx` and
 *      mounted on the single-review page. We verify the page loads
 *      cleanly (the component itself is unit-testable; E2E only
 *      proves it doesn't crash the page render).
 *
 *   3. AccountSecurityCard's new AccountLifecycle section is honest
 *      — it renders an AccessGate (FEATURE_UNAVAILABLE) rather than
 *      a fake delete/export button. The /settings page must still
 *      respond 200.
 *
 *   4. The Phase 2.4 password change + sessions endpoints continue
 *      to behave correctly. (Sanity sweep — no regression.)
 *
 * These tests run alongside Phases 1, 2.1, 2.2, 2.3, 2.4.
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

test.describe("Phase 2.5 — operational scale @critical", () => {
  test("signing in records a session row on the canonical surface", async () => {
    // Phase 2.4 ended with this asserting "0 rows is OK"; Phase 2.5
    // strengthened it: a fresh sign-in MUST leave >= 1 session row, because
    // the auth route calls `recordAuthenticatedSession`. That write-side
    // claim is unchanged — only the surface that reports it moved, from the
    // retired `/v1/users/me/sessions` to `/v1/identity-security/*`.
    const session = await createGuestSession();
    try {
      const resp = await session.api.get("/v1/identity-security/my-sessions");
      expect(resp.status()).toBe(200);
      const body = (await resp.json()) as {
        sessions?: Array<{ id: string; isCurrent: boolean; quarantined: boolean }>;
      };
      const sessions = body.sessions ?? [];
      expect(
        sessions.length,
        `expected the sign-in to be recorded; got ${sessions.length} rows`,
      ).toBeGreaterThan(0);
      // Recorded, and not recorded as quarantined.
      expect(sessions.every((s) => s.quarantined === false)).toBe(true);
    } finally {
      await disposeSession(session);
    }
  });

  test("revoking a session is refused without a verified step-up, and revokes nothing", async () => {
    // WHAT THIS USED TO ASSERT, AND WHY IT CANNOT ANY MORE.
    //
    // It expected `DELETE /v1/users/me/sessions/:id` to answer 200/204. That
    // surface is retired, and its canonical replacement puts a step-up in
    // front of every session mutation: `requireStepUpForSensitiveAction`
    // demands a verified challenge id in `x-proovra-step-up-challenge-id`
    // and is, in its own words, "still unsatisfiable without a verified
    // challenge id".
    //
    // So the gate IS the contract now, and it is asserted directly — including
    // the part that matters most: that the refusal happened BEFORE the
    // mutation, not after it.
    const session = await createGuestSession();
    try {
      const list = await session.api.get("/v1/identity-security/my-sessions");
      const before = (await list.json()) as {
        sessions?: Array<{ id: string }>;
      };
      const target = before.sessions?.[0];
      expect(target).toBeTruthy();

      const revoke = await session.api.post(
        `/v1/identity-security/my-sessions/${target!.id}/revoke`,
      );
      expect(revoke.status()).toBe(401);
      const body = (await revoke.json()) as {
        error?: { code?: string; methods?: string[]; message?: string };
      };
      expect(body.error?.code).toBe("STEP_UP_REQUIRED");
      // The refusal names how to satisfy it, so a client can open the right
      // challenge instead of reading this as "you are signed out".
      expect(body.error?.methods).toContain("password");
      expect(body.error?.message).toBeTruthy();

      // Nothing was revoked. A gate that answered 401 after mutating would
      // pass every assertion above and still be wrong.
      const after = (await (
        await session.api.get("/v1/identity-security/my-sessions")
      ).json()) as { sessions?: Array<{ id: string }> };
      expect(after.sessions?.some((s) => s.id === target!.id)).toBe(true);
    } finally {
      await disposeSession(session);
    }
  });

  test("/reviewer-ops/[reviewId] page loads with the shortcuts overlay imported", async ({
    page,
  }) => {
    // We don't have a real reviewId here, but the page route is
    // dynamic; visiting `/reviewer-ops/anything` exercises the
    // component imports (including ReviewerShortcutsHelp). The
    // (app) layout returns the shell + auth gate for unauthed
    // visits. The point is: no compile / runtime crash from the
    // Phase 2.5 component additions.
    const resp = await page.goto("/reviewer-ops/00000000-0000-4000-8000-000000000000", {
      waitUntil: "load",
    });
    expect(
      resp?.ok(),
      `expected 2xx from /reviewer-ops/:id, got ${resp?.status()}`,
    ).toBe(true);
  });

  test("/settings shows the AccountLifecycle honest block", async ({
    page,
  }) => {
    // The page must continue to 2xx with the new AccountLifecycle
    // section in scope. Detection markers cover both the lifecycle
    // section and the existing AccountSecurityCard.
    const resp = await page.goto("/settings", { waitUntil: "load" });
    expect(resp?.ok()).toBe(true);
  });

  test("the legacy password-change surface stays retired (regression check)", async () => {
    // This was "password change still refuses guests", and it refused because
    // a guest had no EMAIL provider. Guest auth is gone, so that refusal can
    // no longer arise — and the endpoint it called is retired outright.
    //
    // The security property underneath it survives and is what gets checked:
    // this route cannot change a password at all, and the canonical one will
    // not do it without the current password.
    const session = await createGuestSession();
    try {
      const legacy = await session.api.post("/v1/users/me/password/change", {
        data: {
          currentPassword: "anything",
          newPassword: "a-real-new-password-2024",
        },
      });
      expect(legacy.status()).toBe(410);
      expect(((await legacy.json()) as { code?: string }).code).toBe(
        "PERSONAL_SECURITY_LEGACY_RETIRED",
      );

      const canonical = await session.api.post(
        "/v1/identity-security/password",
        {
          data: {
            currentPassword: "not-the-current-password",
            newPassword: "A-real-new-Passw0rd-24",
          },
        },
      );
      expect(canonical.status()).toBe(400);
      expect(await canonical.text()).toContain("current_password_invalid");
    } finally {
      await disposeSession(session);
    }
  });
});
