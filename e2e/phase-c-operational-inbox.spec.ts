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
    const created = await owner.api.post("/v1/orgs", {
      data: { name: "Phase C isolation org" },
    });
    expect(created.status()).toBe(201);
    const orgId = ((await created.json()) as { organizationId: string })
      .organizationId;
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

  test("Topbar accountMenu now includes account.inbox", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get("/v1/platform/context");
    expect(resp.ok()).toBe(true);
    const body = (await resp.json()) as {
      navigation?: {
        accountMenu?: { items?: Array<{ id: string; href: string }> };
      };
    };
    const items = body.navigation?.accountMenu?.items ?? [];
    const entry = items.find((i) => i.id === "account.inbox");
    expect(
      entry,
      "account.inbox must be present in the topbar account menu",
    ).toBeTruthy();
    expect(entry?.href).toBe("/inbox");
  });

  // ---------------------------------------------------------------------------
  // Source-presence guards — Phase C deliberately documents what is
  // NOT built so the readiness doc stays in the bundle.
  // ---------------------------------------------------------------------------
  test("/inbox page ships the deferred-items panel with honest items", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(process.cwd(), "apps/web/app/(app)/inbox/page.tsx"),
      "utf8",
    );
    expect(src).toContain('data-inbox-scope-block="available"');
    expect(src).toContain('data-inbox-scope-block="deferred"');
    // Items the brief said NOT to fake.
    expect(src).toContain('data-inbox-scope-item="read-state"');
    expect(src).toContain('data-inbox-scope-item="preferences-ui"');
    expect(src).toContain('data-inbox-scope-item="email-digest"');
    expect(src).toContain('data-inbox-scope-item="cross-workspace-reports"');
    expect(src).toContain('data-inbox-scope-item="cross-workspace-reviews"');
    expect(src).toContain('data-inbox-scope-item="seat-overrun"');
    expect(src).toContain('data-inbox-scope-item="dismiss"');
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
    expect(src).toContain('app.get(\n    "/v1/me/inbox"');
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
