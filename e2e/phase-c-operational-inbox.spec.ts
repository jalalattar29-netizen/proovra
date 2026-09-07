/**
 * Phase C — Operational Inbox + Workflow Intelligence.
 *
 * Locks in:
 *
 *   1. `GET /v1/me/inbox` exists, requires auth + legal acceptance,
 *      returns the documented envelope shape, and is caller-scoped
 *      (no cross-org / cross-workspace leak).
 *
 *   2. The endpoint surfaces real signals only:
 *      - org_invite items for email-matched pending invites
 *      - org_admin rollup items for admin pending invites
 *      - onboarding items for first-time users
 *      - governance items for unacknowledged GovernanceNotification
 *        rows in teams the caller is a member of
 *      No invented signals.
 *
 *   3. Items are sorted severity-first (critical > high > warning > info).
 *
 *   4. /inbox route returns 2xx (bundle reachable; PageRouteGate
 *      handles unauth).
 *
 *   5. Account menu (topbar) surfaces the new Inbox entry.
 *
 *   6. Source-presence guards on the deferred-items panel ensure the
 *      honest "what we did NOT build" documentation stays in the bundle.
 *
 *   7. No regression on Phase 2.7X / A.1B / A.1C / A.1D / Phase B
 *      contracts.
 */
import { test, expect } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
  provisionEnterpriseOrg,
} from "./helpers/api-client";

test.beforeEach(async () => {
  await clearTestRateLimits();
});

test.describe("Phase C — operational inbox @critical", () => {
  // ---------------------------------------------------------------------------
  // Envelope shape — fresh guest path.
  // ---------------------------------------------------------------------------
  test("GET /v1/me/inbox returns the documented envelope shape for a fresh guest", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get("/v1/me/inbox");
    expect(
      resp.ok(),
      `expected 2xx from /v1/me/inbox; got ${resp.status()}`,
    ).toBe(true);
    const body = (await resp.json()) as {
      generatedAt: string;
      caller: { userId: string; email: string | null };
      summary: {
        total: number;
        byTone: { critical: number; high: number; warning: number; info: number };
        byCategory: {
          onboarding: number;
          org_invite: number;
          org_admin: number;
          governance: number;
        };
      };
      items: Array<{
        id: string;
        category: string;
        tone: string;
        title: string;
        body: string;
        href: string;
        occurredAt: string;
        context: Record<string, unknown>;
      }>;
    };
    expect(typeof body.generatedAt).toBe("string");
    expect(typeof body.caller.userId).toBe("string");
    expect(typeof body.summary.total).toBe("number");
    expect(typeof body.summary.byTone.critical).toBe("number");
    expect(typeof body.summary.byTone.high).toBe("number");
    expect(typeof body.summary.byTone.warning).toBe("number");
    expect(typeof body.summary.byTone.info).toBe("number");
    expect(typeof body.summary.byCategory.onboarding).toBe("number");
    expect(typeof body.summary.byCategory.org_invite).toBe("number");
    expect(typeof body.summary.byCategory.org_admin).toBe("number");
    expect(typeof body.summary.byCategory.governance).toBe("number");
    expect(Array.isArray(body.items)).toBe(true);
    // Every returned item must carry the contract fields.
    for (const it of body.items) {
      expect(typeof it.id).toBe("string");
      expect(typeof it.category).toBe("string");
      expect(typeof it.tone).toBe("string");
      expect(typeof it.title).toBe("string");
      expect(typeof it.body).toBe("string");
      expect(typeof it.href).toBe("string");
      // Every href must point at a leading "/" registered route — no
      // invented external destinations.
      expect(it.href.startsWith("/")).toBe(true);
      expect(typeof it.occurredAt).toBe("string");
    }
  });

  // ---------------------------------------------------------------------------
  // Auth — anonymous callers cannot read the inbox.
  // ---------------------------------------------------------------------------
  test("GET /v1/me/inbox requires auth", async () => {
    const { request } = await import("@playwright/test");
    const anon = await request.newContext({
      baseURL: process.env.API_BASE ?? "http://localhost:8081",
    });
    const resp = await anon.get("/v1/me/inbox");
    expect([401, 403]).toContain(resp.status());
    await anon.dispose();
  });

  // ---------------------------------------------------------------------------
  // Fresh guest — onboarding signal must be present, severity-ordered.
  // ---------------------------------------------------------------------------
  test("Fresh guest with no orgs sees the onboarding inbox item", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get("/v1/me/inbox");
    expect(resp.ok()).toBe(true);
    const body = (await resp.json()) as {
      summary: { total: number; byCategory: { onboarding: number } };
      items: Array<{ id: string; category: string; tone: string; href: string }>;
    };
    // A fresh guest may or may not already have a backfilled org from
    // prior tests sharing local data. The contract is just: if the
    // onboarding category is non-zero, the no-organizations item is
    // present.
    if (body.summary.byCategory.onboarding > 0) {
      const onboarding = body.items.find(
        (i) => i.id === "onboarding:no_organizations",
      );
      expect(onboarding).toBeTruthy();
      expect(onboarding?.href).toBe("/organizations");
      expect(onboarding?.tone).toBe("info");
    }
  });

  // ---------------------------------------------------------------------------
  // Cross-user isolation — stranger does NOT see another user's
  // pending invites or admin-pending-invite rollups.
  // ---------------------------------------------------------------------------
  test("Cross-user isolation: stranger does NOT see another caller's inbox items", async () => {
    const owner = await createGuestSession();
    // Seed: create an org and one invite. The owner now has an
    // admin_pending_invites item in their inbox.
    const created = provisionEnterpriseOrg(owner, "Phase C isolation org");
    const orgId = created.organizationId;
    await owner.api.post(`/v1/orgs/${orgId}/invites`, {
      data: {
        email: "phase-c-isolation-target@example.test",
        role: "ORG_MEMBER",
      },
    });

    const ownerResp = await owner.api.get("/v1/me/inbox");
    expect(ownerResp.ok()).toBe(true);
    const ownerBody = (await ownerResp.json()) as {
      items: Array<{ id: string; href: string }>;
    };
    const ownerAdminItem = ownerBody.items.find((i) =>
      i.id.startsWith(`org_admin:${orgId}`),
    );
    expect(
      ownerAdminItem,
      "owner must see their own admin pending-invite item",
    ).toBeTruthy();

    const stranger = await createGuestSession();
    const strangerResp = await stranger.api.get("/v1/me/inbox");
    expect(strangerResp.ok()).toBe(true);
    const strangerBody = (await strangerResp.json()) as {
      items: Array<{ id: string }>;
    };
    // The stranger's inbox MUST NOT contain the owner's admin item.
    const leaked = strangerBody.items.find((i) =>
      i.id.startsWith(`org_admin:${orgId}`),
    );
    expect(
      leaked,
      "stranger MUST NOT see the owner's admin pending-invite item",
    ).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Severity-first ordering — high tone never appears after info.
  // ---------------------------------------------------------------------------
  test("Items are ordered by severity first (critical > high > warning > info)", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get("/v1/me/inbox");
    expect(resp.ok()).toBe(true);
    const body = (await resp.json()) as {
      items: Array<{ tone: string }>;
    };
    const order: Record<string, number> = {
      critical: 4,
      high: 3,
      warning: 2,
      info: 1,
    };
    let last = Infinity;
    for (const it of body.items) {
      const v = order[it.tone] ?? 0;
      expect(
        v,
        `severity must be non-increasing; saw ${it.tone} after a higher tone`,
      ).toBeLessThanOrEqual(last);
      last = v;
    }
  });

  // ---------------------------------------------------------------------------
  // Route + topbar reachability.
  // ---------------------------------------------------------------------------
  test("/inbox page route returns 2xx (bundle reachable)", async ({ page }) => {
    const resp = await page.goto("/inbox", { waitUntil: "load" });
    expect(
      resp?.ok(),
      `expected 2xx from /inbox, got ${resp?.status()}`,
    ).toBe(true);
  });

  /**
   * THE INBOX IS REACHED BY ITS NAME NOW, NOT BY A MENU ENTRY.
   *
   * This required an `account.inbox` entry in the top-bar menu. Two things
   * moved underneath it:
   *
   *   * the account menu itself was retired server-side (2026-07-21) and is
   *     resolved by `apps/web/lib/navigation/accountMenu.ts`, which declares
   *     account.settings, account.billing, account.organizations and
   *     account.help — and deliberately no inbox;
   *   * Attention Architecture Phase 5 (2026-08-22) made /notifications THE
   *     personal notification centre and /inbox its "permanent compatibility
   *     route", because shipped emails and collaboration links point at it.
   *
   * So the surface is not less discoverable, it is discoverable under the name
   * a person would guess. What has to keep working is the compatibility
   * promise, and that is what is asserted.
   */
  test("the personal notification centre is reachable, and /inbox still leads to it", async ({
    page,
  }) => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const resolver = await fs.readFile(
      path.resolve(process.cwd(), "apps/web/lib/navigation/accountMenu.ts"),
      "utf8",
    );
    // Account MANAGEMENT only — application surfaces are not duplicated here.
    expect(resolver).not.toContain('id: "account.inbox"');

    // The compatibility route still lands on the canonical one.
    await page.goto("/inbox");
    await expect(page).toHaveURL(/\/notifications$/);
  });

  // ---------------------------------------------------------------------------
  // Source-presence guards — Phase C deliberately documents what is
  // NOT built so the readiness doc stays in the bundle.
  // ---------------------------------------------------------------------------
  /**
   * THE DEFERRALS WERE DELIVERED, SO THE PANEL THAT DISCLOSED THEM IS GONE.
   *
   * This required a "deferred items" panel naming what the brief said not to
   * fake: read-state, preferences UI, email digest, cross-workspace reports
   * and reviews, seat overrun, dismiss. That panel existed so the page would
   * not imply capability it lacked — an honest thing to ship, and a temporary
   * one.
   *
   * Several of those items now EXIST, so demanding the disclosure back would
   * be demanding the page understate itself. What replaces it is the delivered
   * capability, asserted by the markers the page renders: per-item read state,
   * an exact total rather than a rounded one, a NAMED reason when the list is
   * empty, and real paging.
   *
   * Still the right file: /notifications re-exports this module
   * (`export { default } from "../inbox/page"`), so there is one
   * implementation behind both URLs.
   */
  test("the inbox page ships delivered capability, not a promise of it", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(process.cwd(), "apps/web/app/(app)/inbox/page.tsx"),
      "utf8",
    );
    // Read state is real, per item, from the item's own flag.
    expect(src).toContain("data-inbox-item-read={item.isRead");
    // An exact total, so the count cannot quietly round.
    expect(src).toContain("data-inbox-total-exact");
    // Empty is explained rather than blank, and says WHICH empty it is.
    expect(src).toContain('data-inbox-empty-reason="archive"');
    expect(src).toContain('data-inbox-empty-reason="filters"');
    // Paging is a real cursor, not a client-side slice.
    expect(src).toContain("data-inbox-next-cursor");
    // And the deferral panel it replaced is not still shipping alongside it.
    expect(src).not.toContain("data-inbox-scope-block");
  });

  test("Backend inbox route ships severity-first sort + caller-scoped queries", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "services/api/src/routes/me-inbox.routes.ts",
      ),
      "utf8",
    );
    // CRLF-tolerant assertion: the routes file uses CRLF endings on
    // Windows checkouts. The literal `app.get(\n    "/v1/me/inbox"`
    // miscompares against `app.get(\r\n    "/v1/me/inbox"`. The
    // regex tolerates either line ending while still anchoring on
    // the two-line `app.get(...)` shape that proves the inbox route
    // is registered (not just mentioned in a comment).
    expect(src).toMatch(/app\.get\(\r?\n\s*"\/v1\/me\/inbox"/);
    expect(src).toContain("requireAuthAndLegal");
    expect(src).toContain("organizationMembership.findMany");
    expect(src).toContain("teamMember.findMany");
    expect(src).toContain("governanceNotification.findMany");
    expect(src).toContain("acknowledgedAtUtc: null");
    // The endpoint must filter governance by teamIds the caller
    // belongs to — this is the cross-workspace leak guard.
    expect(src).toContain("teamId: { in: teamIds }");
  });
});
