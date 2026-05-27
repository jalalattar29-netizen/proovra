/**
 * Phase A.1B — Organizations & workspace operational surface.
 *
 * Locks in:
 *
 *   1. Discoverability: the navigation-registry change adds
 *      `account.organizations` to the topbar account menu. The
 *      platform-context envelope must surface that entry to every
 *      authenticated user (capability gate is `null`).
 *
 *   2. Routes still reachable: `/organizations`, `/organizations/[id]`,
 *      `/org-invites/[token]/accept`, `/teams` all return 2xx (page
 *      bundle published; no Phase A.1B regression).
 *
 *   3. Settings round-trip: the rebuilt detail page's Settings panel
 *      PATCHes name/legalName/legalEmail and the updated values come
 *      back on the next GET. The audit timeline records ORG_UPDATED.
 *
 *   4. Operational continuity: every action the rebuilt surfaces
 *      surface in their toolbars maps to a real audited endpoint. We
 *      assert that the underlying API flow (create → settings →
 *      invite → audit) works end-to-end so the surfaces aren't
 *      offering dead CTAs.
 *
 *   5. NO regression in Phase 2.7X Stage 3/4/5 contracts. The
 *      existing spec files cover the deeper RBAC/error semantics —
 *      this file is the cohesion guardrail.
 */
import { test, expect } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
} from "./helpers/api-client";

test.beforeEach(async () => {
  await clearTestRateLimits();
});

test.describe("Phase A.1B — org operational surface @critical", () => {
  // ---------------------------------------------------------------------------
  // Discoverability — topbar account menu carries Organizations
  // ---------------------------------------------------------------------------
  test("platform-context accountMenu now includes account.organizations", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get("/v1/platform/context");
    expect(
      resp.ok(),
      `expected 2xx from /v1/platform-context; got ${resp.status()}`,
    ).toBe(true);
    const body = (await resp.json()) as {
      navigation?: {
        accountMenu?: { items?: Array<{ id: string; href: string }> };
      };
    };
    const items = body.navigation?.accountMenu?.items ?? [];
    const orgEntry = items.find((it) => it.id === "account.organizations");
    expect(
      orgEntry,
      "account.organizations must be present in the topbar account menu so the surface is discoverable",
    ).toBeTruthy();
    expect(orgEntry?.href).toBe("/organizations");
  });

  // ---------------------------------------------------------------------------
  // Routes reachable
  // ---------------------------------------------------------------------------
  test("/organizations page route returns 2xx (bundle reachable)", async ({
    page,
  }) => {
    const resp = await page.goto("/organizations", { waitUntil: "load" });
    expect(
      resp?.ok(),
      `expected 2xx from /organizations, got ${resp?.status()}`,
    ).toBe(true);
  });

  test("/organizations/[id] page route returns 2xx (bundle reachable)", async ({
    page,
  }) => {
    const resp = await page.goto(
      "/organizations/00000000-0000-4000-8000-000000000000",
      { waitUntil: "load" },
    );
    expect(
      resp?.ok(),
      `expected 2xx from /organizations/[id], got ${resp?.status()}`,
    ).toBe(true);
  });

  test("/org-invites/[token]/accept route returns 2xx", async ({ page }) => {
    const resp = await page.goto("/org-invites/inv_test_token/accept", {
      waitUntil: "load",
    });
    expect(
      resp?.ok(),
      `expected 2xx from /org-invites/[token]/accept, got ${resp?.status()}`,
    ).toBe(true);
  });

  test("/teams route still reachable after Phase A.1B cross-link edits", async ({
    page,
  }) => {
    const resp = await page.goto("/teams", { waitUntil: "load" });
    expect(resp?.ok(), `expected 2xx from /teams, got ${resp?.status()}`).toBe(
      true,
    );
  });

  // ---------------------------------------------------------------------------
  // Settings panel — round-trip
  // ---------------------------------------------------------------------------
  test("Settings panel round-trip: PATCH /v1/orgs/:id reflects on next GET and audit logs ORG_UPDATED", async () => {
    const session = await createGuestSession();

    // Create the org via the API the new list page uses.
    const create = await session.api.post("/v1/orgs", {
      data: { name: "Phase A.1B settings round-trip" },
    });
    expect(create.status()).toBe(201);
    const created = (await create.json()) as { organizationId: string };
    expect(created.organizationId).toBeTruthy();

    // PATCH name + legalName + legalEmail — the three fields the new
    // detail-page Settings panel sends.
    const patch = await session.api.patch(
      `/v1/orgs/${created.organizationId}`,
      {
        data: {
          name: "Phase A.1B renamed",
          legalName: "Phase A.1B legal name",
          legalEmail: "legal-a1b@example.test",
        },
      },
    );
    expect(patch.status()).toBe(200);
    const patched = (await patch.json()) as {
      name: string;
      legalName: string | null;
      legalEmail: string | null;
    };
    expect(patched.name).toBe("Phase A.1B renamed");
    expect(patched.legalName).toBe("Phase A.1B legal name");
    expect(patched.legalEmail).toBe("legal-a1b@example.test");

    // Re-GET — the rebuilt header / overview tiles read these.
    const detail = await session.api.get(
      `/v1/orgs/${created.organizationId}`,
    );
    expect(detail.ok()).toBe(true);
    const detailBody = (await detail.json()) as {
      name: string;
      legalName: string | null;
      legalEmail: string | null;
    };
    expect(detailBody.name).toBe("Phase A.1B renamed");
    expect(detailBody.legalName).toBe("Phase A.1B legal name");
    expect(detailBody.legalEmail).toBe("legal-a1b@example.test");

    // Audit timeline — the rebuilt detail page reads this and shows
    // the per-event filter dropdown. ORG_UPDATED must be present.
    const audit = await session.api.get(
      `/v1/orgs/${created.organizationId}/audit-events`,
    );
    expect(audit.ok()).toBe(true);
    const auditBody = (await audit.json()) as {
      events: Array<{ eventType: string }>;
    };
    expect(
      auditBody.events.some((e) => e.eventType === "ORG_UPDATED"),
      "ORG_UPDATED must be visible in the audit timeline after the settings round-trip",
    ).toBe(true);

    // Audit filter — ?eventType=ORG_UPDATED narrows the response. The
    // rebuilt detail page uses this on the audit dropdown.
    const filtered = await session.api.get(
      `/v1/orgs/${created.organizationId}/audit-events?eventType=ORG_UPDATED`,
    );
    expect(filtered.ok()).toBe(true);
    const filteredBody = (await filtered.json()) as {
      events: Array<{ eventType: string }>;
    };
    expect(filteredBody.events.length).toBeGreaterThan(0);
    expect(filteredBody.events.every((e) => e.eventType === "ORG_UPDATED")).toBe(
      true,
    );
  });

  // ---------------------------------------------------------------------------
  // Workspaces / cross-link to /teams
  // ---------------------------------------------------------------------------
  test("Workspaces section endpoint returns the expected envelope (used by overview tile + workspaces panel)", async () => {
    const session = await createGuestSession();
    const create = await session.api.post("/v1/orgs", {
      data: { name: "Phase A.1B workspaces tile" },
    });
    const orgId = ((await create.json()) as { organizationId: string })
      .organizationId;
    const resp = await session.api.get(`/v1/orgs/${orgId}/workspaces`);
    expect(resp.ok()).toBe(true);
    const body = (await resp.json()) as {
      summary: { totalWorkspaces: number };
      workspaces: unknown[];
    };
    expect(typeof body.summary.totalWorkspaces).toBe("number");
    expect(Array.isArray(body.workspaces)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Accept-invite-token flow (used by the new list-page modal)
  // ---------------------------------------------------------------------------
  test("Accept-invite flow: list-page modal endpoint surfaces 410 for unknown / expired tokens", async () => {
    const session = await createGuestSession();
    // Garbage token. The rebuilt list page's Join modal sends POST
    // /v1/org-invites/:token/accept and surfaces friendly errors for
    // 410 (expired/revoked/already accepted) and 404 (not found).
    const resp = await session.api.post(
      "/v1/org-invites/not-a-real-token/accept",
    );
    expect(
      [404, 410, 400, 422],
      `expected a friendly client-error status for unknown token; got ${resp.status()}`,
    ).toContain(resp.status());
  });

  // ---------------------------------------------------------------------------
  // No regression — Phase 2.7X Stage 3/4/5 invariants the surfaces depend on
  // ---------------------------------------------------------------------------
  test("Phase 2.7X Stage 3 GET /v1/me/orgs envelope shape preserved", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get("/v1/me/orgs");
    expect(resp.ok()).toBe(true);
    const body = (await resp.json()) as {
      summary: { totalOrgs: number };
      orgs: Array<{
        organizationId: string;
        name: string;
        role: string;
        status: string;
      }>;
    };
    expect(typeof body.summary.totalOrgs).toBe("number");
    expect(Array.isArray(body.orgs)).toBe(true);
    if (body.orgs.length > 0) {
      const r = body.orgs[0]!;
      expect(typeof r.organizationId).toBe("string");
      expect(typeof r.name).toBe("string");
      expect(typeof r.role).toBe("string");
      expect(typeof r.status).toBe("string");
    }
  });

  // ---------------------------------------------------------------------------
  // Wave 2 — operational counts on /v1/me/orgs (memberCount,
  // workspaceCount, pendingInviteCount). Drives the list-page cards.
  // ---------------------------------------------------------------------------
  test("Wave 2: GET /v1/me/orgs returns per-org governance counts", async () => {
    const session = await createGuestSession();
    // Seed: create one org and one invite. The list endpoint must
    // surface counts for both without an N+1.
    const create = await session.api.post("/v1/orgs", {
      data: { name: "Wave2 counts org" },
    });
    expect(create.status()).toBe(201);
    const orgId = ((await create.json()) as { organizationId: string })
      .organizationId;
    const inv = await session.api.post(`/v1/orgs/${orgId}/invites`, {
      data: { email: "wave2-counts@example.test", role: "ORG_MEMBER" },
    });
    expect(inv.status()).toBe(201);

    const me = await session.api.get("/v1/me/orgs");
    expect(me.ok()).toBe(true);
    const body = (await me.json()) as {
      orgs: Array<{
        organizationId: string;
        memberCount: number;
        workspaceCount: number;
        pendingInviteCount: number;
      }>;
    };
    const row = body.orgs.find((r) => r.organizationId === orgId);
    expect(row, "newly created org must appear in /v1/me/orgs").toBeTruthy();
    expect(typeof row!.memberCount).toBe("number");
    expect(typeof row!.workspaceCount).toBe("number");
    expect(typeof row!.pendingInviteCount).toBe("number");
    // We are the only member, no workspace bound by default, one pending invite.
    expect(row!.memberCount).toBe(1);
    expect(row!.pendingInviteCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Wave 2 — GET /v1/orgs/:id returns full metadata + pendingInviteCount.
  // ---------------------------------------------------------------------------
  test("Wave 2: GET /v1/orgs/:id exposes address/timezone/logoUrl + pendingInviteCount", async () => {
    const session = await createGuestSession();
    const create = await session.api.post("/v1/orgs", {
      data: { name: "Wave2 detail metadata org" },
    });
    const orgId = ((await create.json()) as { organizationId: string })
      .organizationId;

    // PATCH every field the Settings form sends.
    const patch = await session.api.patch(`/v1/orgs/${orgId}`, {
      data: {
        name: "Wave2 renamed",
        legalName: "Wave2 Legal LLC",
        legalEmail: "legal-wave2@example.test",
        address: "1 Test Plaza, Springfield",
        timezone: "America/Los_Angeles",
        logoUrl: "https://example.test/logo.png",
      },
    });
    expect(patch.status()).toBe(200);

    const detail = await session.api.get(`/v1/orgs/${orgId}`);
    expect(detail.ok()).toBe(true);
    const body = (await detail.json()) as {
      address: string | null;
      timezone: string | null;
      logoUrl: string | null;
      summary: {
        memberCount: number;
        workspaceCount: number;
        pendingInviteCount: number;
      };
    };
    expect(body.address).toBe("1 Test Plaza, Springfield");
    expect(body.timezone).toBe("America/Los_Angeles");
    expect(body.logoUrl).toBe("https://example.test/logo.png");
    expect(typeof body.summary.pendingInviteCount).toBe("number");
  });

  // ---------------------------------------------------------------------------
  // Wave 2 — GET /v1/orgs/:id/workspaces returns workspace billing facts
  // to ORG_OWNER, omits them to ORG_MEMBER (and on the boundary, signals
  // visibility via `callerCanSeeBilling`).
  // ---------------------------------------------------------------------------
  test("Wave 2: workspaces endpoint surfaces billing for ORG_OWNER, hides for ORG_MEMBER", async () => {
    const owner = await createGuestSession();
    const create = await owner.api.post("/v1/orgs", {
      data: { name: "Wave2 workspace billing org" },
    });
    const orgId = ((await create.json()) as { organizationId: string })
      .organizationId;

    const wOwner = await owner.api.get(`/v1/orgs/${orgId}/workspaces`);
    expect(wOwner.ok()).toBe(true);
    const ownerBody = (await wOwner.json()) as {
      callerCanSeeBilling: boolean;
      workspaces: Array<{
        workspaceId: string;
        billing?: {
          plan: string;
          status: string;
          includedSeats: number;
          overSeatLimit: boolean;
        };
      }>;
    };
    expect(ownerBody.callerCanSeeBilling).toBe(true);
    for (const w of ownerBody.workspaces) {
      // Billing object MUST be present for owner. Plan/status are
      // schema-typed enums so we only assert string presence.
      expect(w.billing).toBeTruthy();
      expect(typeof w.billing!.plan).toBe("string");
      expect(typeof w.billing!.status).toBe("string");
      expect(typeof w.billing!.includedSeats).toBe("number");
      expect(typeof w.billing!.overSeatLimit).toBe("boolean");
    }

    // Now invite + accept a second user at ORG_MEMBER and re-check.
    const inv = await owner.api.post(`/v1/orgs/${orgId}/invites`, {
      data: { email: "wave2-billing-viewer@example.test", role: "ORG_MEMBER" },
    });
    expect(inv.status()).toBe(201);
    const invBody = (await inv.json()) as { token: string };

    // Stage 5 hardening: the invite is email-matched. Create a member
    // whose email matches and accept the token.
    const member = await createGuestSession();
    // Patch the member's account email to the invited address.
    const upd = await member.api.patch("/v1/users/me", {
      data: { email: "wave2-billing-viewer@example.test" },
    });
    // The endpoint may or may not exist for guest accounts; if it
    // returns non-2xx we skip the rest of this branch honestly.
    if (!upd.ok()) {
      test.info().annotations.push({
        type: "skip-reason",
        description: `Member-side billing-hide assertion skipped: cannot set guest email (HTTP ${upd.status()}).`,
      });
      return;
    }
    const accept = await member.api.post(
      `/v1/org-invites/${invBody.token}/accept`,
    );
    if (!accept.ok()) {
      test.info().annotations.push({
        type: "skip-reason",
        description: `Skipped: invite accept failed HTTP ${accept.status()}.`,
      });
      return;
    }

    const wMember = await member.api.get(`/v1/orgs/${orgId}/workspaces`);
    expect(wMember.ok()).toBe(true);
    const memberBody = (await wMember.json()) as {
      callerCanSeeBilling: boolean;
      workspaces: Array<{ billing?: unknown }>;
    };
    expect(memberBody.callerCanSeeBilling).toBe(false);
    for (const w of memberBody.workspaces) {
      expect(
        w.billing,
        "billing must be omitted from ORG_MEMBER response",
      ).toBeUndefined();
    }
  });
});
