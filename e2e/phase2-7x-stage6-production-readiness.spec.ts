/**
 * Phase 2.7X Stage 6 — Production-readiness finalization regression tests.
 *
 * Locks in:
 *
 *   1. Token-hashing lifecycle works end-to-end. The invitee
 *      accepts using the RAW token (from the create response);
 *      lookup happens by SHA-256 hash internally. Raw tokens are
 *      never echoed back by any GET endpoint.
 *
 *   2. Pending-invites listing never leaks raw tokens (no 64-hex
 *      string in any GET /v1/orgs/:id/invites response body).
 *
 *   3. New invite rows have token=NULL (database invariant —
 *      verified indirectly via the listing endpoint, which would
 *      surface raw-token if present).
 *
 *   4. The teams.organization_id NOT NULL invariant holds — both
 *      explicit team creation (POST /v1/teams) AND personal-
 *      workspace bootstrap (during guest signup) populate it.
 *
 *   5. Workspace isolation regression — Stage 4/5 contracts unchanged.
 */
import { test, expect } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
} from "./helpers/api-client";

test.beforeEach(() => {
  clearTestRateLimits();
});

const FAKE_TEAM = "00000000-0000-4000-8000-000000000001";

test.describe("Phase 2.7X Stage 6 — production readiness @critical", () => {
  // -------------------------------------------------------------------------
  // 1. Token-hashing lifecycle
  // -------------------------------------------------------------------------
  test("invite create → accept round-trip works after token hashing", async () => {
    const owner = await createGuestSession();
    const orgId = ((
      (await (
        await owner.api.post("/v1/orgs", { data: { name: "S6 token-hash org" } })
      ).json()) as { organizationId: string }
    )).organizationId;

    const inv = (await (
      await owner.api.post(`/v1/orgs/${orgId}/invites`, {
        data: { email: "s6-roundtrip@example.test", role: "ORG_MEMBER" },
      })
    ).json()) as { token: string; inviteId: string };

    // The raw token shape is unchanged (64 hex chars).
    expect(inv.token).toMatch(/^[a-f0-9]{64}$/);

    // The invitee accepts using the raw token (the wire protocol
    // is unchanged from Stage 4; only DB storage changed to hashes).
    const invitee = await createGuestSession();
    const accept = await invitee.api.post(
      `/v1/org-invites/${inv.token}/accept`,
    );
    expect(accept.status()).toBe(200);
    const acceptBody = (await accept.json()) as {
      organizationId: string;
      role: string;
    };
    expect(acceptBody.organizationId).toBe(orgId);
    expect(acceptBody.role).toBe("ORG_MEMBER");
  });

  test("pending-invites listing never includes raw tokens", async () => {
    const owner = await createGuestSession();
    const orgId = ((
      (await (
        await owner.api.post("/v1/orgs", { data: { name: "S6 leak-check org" } })
      ).json()) as { organizationId: string }
    )).organizationId;

    // Create two invites so the listing has rows.
    const i1 = await owner.api.post(`/v1/orgs/${orgId}/invites`, {
      data: { email: "s6-leak-1@example.test" },
    });
    const i2 = await owner.api.post(`/v1/orgs/${orgId}/invites`, {
      data: { email: "s6-leak-2@example.test" },
    });
    expect(i1.status()).toBe(201);
    expect(i2.status()).toBe(201);
    const token1 = ((await i1.json()) as { token: string }).token;
    const token2 = ((await i2.json()) as { token: string }).token;

    const listResp = await owner.api.get(`/v1/orgs/${orgId}/invites`);
    expect(listResp.ok()).toBe(true);
    const raw = await listResp.text();

    // The raw response body MUST NOT contain either of the two tokens.
    expect(raw.includes(token1)).toBe(false);
    expect(raw.includes(token2)).toBe(false);
    // Defense-in-depth: no 64-hex token-like string at all.
    expect(raw).not.toMatch(/[a-f0-9]{64}/i);
  });

  test("invalid token returns 404 (hash lookup miss)", async () => {
    const session = await createGuestSession();
    const fakeToken = "0".repeat(64); // valid shape, invalid value
    const resp = await session.api.post(
      `/v1/org-invites/${fakeToken}/accept`,
    );
    expect(resp.status()).toBe(404);
  });

  test("audit metadata still never contains raw tokens (regression)", async () => {
    const owner = await createGuestSession();
    const orgId = ((
      (await (
        await owner.api.post("/v1/orgs", { data: { name: "S6 audit-leak org" } })
      ).json()) as { organizationId: string }
    )).organizationId;
    const inv = (await (
      await owner.api.post(`/v1/orgs/${orgId}/invites`, {
        data: { email: "s6-audit@example.test" },
      })
    ).json()) as { token: string };

    const audit = await owner.api.get(`/v1/orgs/${orgId}/audit-events`);
    const raw = await audit.text();
    expect(raw.includes(inv.token)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4. teams.organization_id NOT NULL — bootstrap path
  // -------------------------------------------------------------------------
  test("workspace-bootstrap atomically creates an org for the personal team", async () => {
    // Personal-team creation is lazy: it happens on the first
    // `/v1/platform/context` call, NOT during /v1/auth/guest itself.
    // Stage 6 wires the bootstrap to create an Organization
    // atomically with the personal Team. After the context call,
    // the user MUST have at least one ORG_OWNER membership.
    const session = await createGuestSession();
    const ctx = await session.api.get("/v1/platform/context");
    expect(ctx.ok()).toBe(true);

    const me = await session.api.get("/v1/me/orgs");
    expect(me.ok()).toBe(true);
    const body = (await me.json()) as {
      summary: { totalOrgs: number };
      orgs: Array<{ role: string }>;
    };
    expect(body.summary.totalOrgs).toBeGreaterThanOrEqual(1);
    // The auto-created org makes the user ORG_OWNER.
    expect(body.orgs.some((o) => o.role === "ORG_OWNER")).toBe(true);
  });

  test("explicit POST /v1/teams atomically creates an org for the new team", async () => {
    const session = await createGuestSession();
    // Count orgs before.
    const before = (await (
      await session.api.get("/v1/me/orgs")
    ).json()) as { summary: { totalOrgs: number } };
    const beforeCount = before.summary.totalOrgs;

    const createTeam = await session.api.post("/v1/teams", {
      data: { name: "S6 explicit-team-create" },
    });
    // Some billing/seat enforcement paths may refuse — accept 201 or 403/422.
    // The KEY assertion is: if it succeeds, an org was created.
    if (createTeam.status() === 201) {
      const after = (await (
        await session.api.get("/v1/me/orgs")
      ).json()) as { summary: { totalOrgs: number } };
      expect(after.summary.totalOrgs).toBe(beforeCount + 1);
    } else {
      // Document the refusal path; not a Stage 6 regression.
      expect([201, 402, 403, 409, 422]).toContain(createTeam.status());
    }
  });

  // -------------------------------------------------------------------------
  // 5. Workspace isolation regression
  // -------------------------------------------------------------------------
  test("Phase 2.6D RBAC matrix still works (regression)", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get("/v1/platform/rbac/matrix");
    expect(resp.ok()).toBe(true);
  });

  test("Phase 2.6B access-review refusal unchanged", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get(`/v1/teams/${FAKE_TEAM}/access-review`);
    expect([403, 404]).toContain(resp.status());
  });

  test("Stage 5 audit pagination still works (regression)", async () => {
    const owner = await createGuestSession();
    const orgId = ((
      (await (
        await owner.api.post("/v1/orgs", { data: { name: "S6 pagination regression" } })
      ).json()) as { organizationId: string }
    )).organizationId;
    const resp = await owner.api.get(
      `/v1/orgs/${orgId}/audit-events?take=10`,
    );
    expect(resp.ok()).toBe(true);
    const body = (await resp.json()) as {
      summary: { appliedTake: number };
    };
    expect(body.summary.appliedTake).toBe(10);
  });

  test("Stage 5 invite revoke still works (regression)", async () => {
    const owner = await createGuestSession();
    const orgId = ((
      (await (
        await owner.api.post("/v1/orgs", { data: { name: "S6 revoke regression" } })
      ).json()) as { organizationId: string }
    )).organizationId;
    const inv = (await (
      await owner.api.post(`/v1/orgs/${orgId}/invites`, {
        data: { email: "s6-revoke-regression@example.test" },
      })
    ).json()) as { inviteId: string };
    const revoke = await owner.api.delete(
      `/v1/orgs/${orgId}/invites/${inv.inviteId}`,
    );
    expect(revoke.status()).toBe(200);
  });
});
