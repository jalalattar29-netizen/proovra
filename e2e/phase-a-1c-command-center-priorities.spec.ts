/**
 * Phase A.1C — Account-level operational priorities + Command Center
 * completion.
 *
 * Locks in:
 *
 *   1. `GET /v1/me/operational-priorities` exists, requires auth + legal
 *      acceptance, returns the documented envelope shape, NEVER leaks
 *      data scoped to another user, and is permission-safe for guests
 *      (no email-identity).
 *
 *   2. The endpoint surfaces "pending org invite" items for the
 *      addressed user (email-matched), and does NOT surface them for
 *      anyone else — even an org admin with full admin rights.
 *
 *   3. The endpoint surfaces "admin pending invites" items for ORG_ADMIN
 *      / ORG_OWNER callers across orgs they administer.
 *
 *   4. The /home page bundle still serves 2xx after Phase A.1C; the
 *      AccountPrioritiesBanner marker is present in the rendered DOM.
 *
 *   5. The dashboard quick-actions resolver now includes Organizations
 *      as a PERSONAL-mode shortcut (Phase A.1C discoverability bump).
 *      The Phase R3 contract still enforces 4-actions-max.
 *
 *   6. NO regression on Phase 2.7X / A.1B contracts that the new
 *      surface depends on (`/v1/me/orgs`, `/v1/orgs/:id/invites`).
 */
import { test, expect } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
} from "./helpers/api-client";

test.beforeEach(async () => {
  await clearTestRateLimits();
});

test.describe("Phase A.1C — account-level operational priorities @critical", () => {
  // ---------------------------------------------------------------------------
  // Shape — envelope is small and stable.
  // ---------------------------------------------------------------------------
  /**
   * CONTRACT MIGRATION — Attention Architecture Phase 7 (2026-08-22).
   *
   * The five tests that stood here exercised
   * `GET /v1/me/operational-priorities`, which was REMOVED as a duplicate
   * general-attention authority. It computed "what needs your attention
   * right now" from its own reads of org invites, org-admin governance and
   * onboarding state, all three of which already had a canonical home:
   *
   *   pending org invites  ->  org_invite notifications (ORGANIZATION scope,
   *                            addressed by email; Phase 2.4 stopped
   *                            workspace narrowing from hiding them)
   *   org-admin backlog    ->  org_admin notifications
   *   onboarding           ->  GUIDANCE, which Phase 1.6 removed from the
   *                            attention workload entirely
   *
   * The PROPERTIES they protected did not go away, and are not weakened:
   *
   *   envelope shape        ->  pinned on the canonical aggregation by
   *                             phase-opscenter-redesign.test.ts
   *   auth required         ->  every /v1/me/inbox route sits behind
   *                             requireAuthAndLegal (phase-ia-reliability)
   *   cross-user isolation  ->  attention-arch-phase2-correctness.test.ts
   *                             SS2.5, which is strictly stronger: it asserts
   *                             the tenancy gate on EVERY source rather than
   *                             on this one endpoint
   *
   * What replaces them here is the removal itself, so the endpoint cannot
   * come back without somebody reading this note.
   */
  test("the removed account-priorities endpoint is gone, not merely unused", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get("/v1/me/operational-priorities");
    // 404, not 403: the route is DEREGISTERED, so there is no handler left
    // to authorize. A 403 would mean the duplicate authority still exists
    // and is merely refusing this caller.
    expect(resp.status()).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Auth — anonymous callers cannot read this endpoint.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Fresh guest → first-time-user onboarding signals.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Owner-admin perspective — when the caller has open invites in orgs
  // they administer, the `admin_pending_invites` item appears.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Cross-user leak guard — a different user does NOT see the first
  // user's pending invites in their admin_pending_invites count.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // /home page bundle still serves; AccountPrioritiesBanner marker
  // exists in the rendered DOM (PageRouteGate wraps the bundle so
  // even unauth pageserver renders the gate shell, but the banner
  // component is included in the bundle).
  // ---------------------------------------------------------------------------
  test("/home page route returns 2xx after A.1C", async ({ page }) => {
    const resp = await page.goto("/home", { waitUntil: "load" });
    expect(resp?.ok(), `expected 2xx from /home, got ${resp?.status()}`).toBe(
      true,
    );
  });

  // ---------------------------------------------------------------------------
  // Quick-actions contract — Phase R3 bound = 4 actions max; PERSONAL
  // mode now includes Organizations.
  // ---------------------------------------------------------------------------
  test("Dashboard quick-actions: PERSONAL mode advertises Organizations and stays under the 4-action cap", async () => {
    // The resolver is pure & client-side, but we re-verify the rule by
    // importing the rules module via dynamic import in the page
    // context. We assert via a small inline page that imports the rules.
    //
    // We can't easily import frontend code in Playwright spec; instead
    // we exercise the contract observationally: confirm the source file
    // declares the org entry. This guards regression of the dashboard
    // rules without coupling the test to a build artifact.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const filePath = path.resolve(
      process.cwd(),
      "apps/web/lib/dashboard/dashboardModeRules.ts",
    );
    const src = await fs.readFile(filePath, "utf8");
    expect(src).toContain("personal.organizations");
    expect(src).toContain('href: "/organizations"');
    // Bound assertion — anchor on MODE_QUICK_ACTIONS specifically so we
    // don't accidentally match MODE_SECTION_PRIORITY.PERSONAL (which
    // also lives in this file and lists section ids, not action ids).
    const quickActionsMatch = src.match(
      /MODE_QUICK_ACTIONS[\s\S]+?PERSONAL:\s*\[([\s\S]+?)\],\s*ORGANIZATION:/,
    );
    expect(
      quickActionsMatch,
      "MODE_QUICK_ACTIONS.PERSONAL must be locatable in dashboardModeRules.ts",
    ).toBeTruthy();
    const personalBlock = quickActionsMatch![1];
    const idCount = (personalBlock.match(/id:\s*"/g) ?? []).length;
    expect(idCount).toBeLessThanOrEqual(4);
    expect(idCount).toBeGreaterThanOrEqual(1);
    expect(personalBlock).toContain("personal.organizations");
  });
});
