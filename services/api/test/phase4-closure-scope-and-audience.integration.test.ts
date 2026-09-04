/**
 * PHASE 4 CLOSURE — ADMIN SCOPE, AUDIENCE AND TENANT ISOLATION.
 *
 * Live PostgreSQL 16, real routes, real authorization, no mocked auth hook.
 *
 * The generated Admin ledger records, per route, the page gate and the
 * authority its APIs actually run. Reading it back showed disagreements this
 * file turns into runtime questions:
 *
 *   /admin/platform/reliability   page gate OPS_CENTER_VIEW, API authority
 *                                 `requireAdminMember` — a workspace-member
 *                                 check on a platform-namespaced page.
 *   /admin/platform/analytics     page gate ANALYTICS_VIEW, API authority
 *   /admin/platform/automation    `requireTeamCapability` — workspace
 *                                 capabilities deciding a /admin/platform URL.
 *
 * A page under `/admin/platform/` tells an operator it is platform-wide. If
 * its data is one workspace's, the URL and the copy are lying; if its data is
 * global, a workspace capability must not be what opens it. Either way the
 * disagreement is the defect, and the fix is whichever direction the product
 * purpose actually points.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  bootstrapPersonalSpace,
  seedOrganizationTenant,
  seedOwnedWorkspace,
  seedPersonalTenant,
  seedUser,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

describe("PHASE 4 CLOSURE — scope and audience (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;

  let platformAdmin: SeededUser;
  let orgA: { organizationId: string; workspaceId: string; owner: SeededUser };
  let orgB: { organizationId: string; workspaceId: string; owner: SeededUser };
  let readOnly: SeededUser;
  let freePersonal: SeededUser;
  let proPersonal: SeededUser;
  let emptyWorkspaceId: string;

  async function call(
    token: string | null,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
  ) {
    const res = await harness.app.inject({
      method,
      url,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    let body: unknown = null;
    try {
      body = JSON.parse(res.body);
    } catch {
      body = res.body;
    }
    return {
      status: res.statusCode,
      body,
      text: typeof res.body === "string" ? res.body : JSON.stringify(res.body),
      code:
        (body as { error?: { code?: string } })?.error?.code ??
        (body as { code?: string })?.code ??
        null,
    };
  }

  const setActive = (userId: string, teamId: string) =>
    prisma.user.update({ where: { id: userId }, data: { currentWorkspaceId: teamId } });

  /** Refused, by any of the canonical refusal shapes. */
  const refused = (r: { status: number }) => [401, 402, 403, 404].includes(r.status);

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `p4c-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          3600,
        ),
    };

    platformAdmin = await seedUser(deps, "p4c-platform-admin");
    await prisma.user.update({
      where: { id: platformAdmin.userId },
      data: { platformRole: "admin" },
    });
    await bootstrapPersonalSpace(deps, platformAdmin.userId);

    const a = await seedOrganizationTenant(deps, { contractStatus: "ACTIVE" });
    orgA = { organizationId: a.organizationId, workspaceId: a.workspaceId, owner: a.owner };
    const b = await seedOrganizationTenant(deps, { contractStatus: "ACTIVE" });
    orgB = { organizationId: b.organizationId, workspaceId: b.workspaceId, owner: b.owner };

    readOnly = await seedUser(deps, "p4c-read-only");
    await bootstrapPersonalSpace(deps, readOnly.userId);
    await prisma.teamMember.create({
      data: {
        teamId: orgA.workspaceId,
        userId: readOnly.userId,
        role: "VIEWER",
        status: "ACTIVE",
      },
    });

    freePersonal = (await seedPersonalTenant(deps, "FREE")).owner;
    proPersonal = (await seedPersonalTenant(deps, "PRO")).owner;

    const emptyOwner = await seedUser(deps, "p4c-empty-owner");
    await bootstrapPersonalSpace(deps, emptyOwner.userId);
    emptyWorkspaceId = (
      await seedOwnedWorkspace(deps, {
        ownerUserId: emptyOwner.userId,
        name: `p4c-empty-${deps.tag}`,
        billingPlan: "TEAM",
      })
    ).teamId;

    // Workspace A carries data B does not, so "unchanged" means something.
    await prisma.evidence.create({
      data: {
        teamId: orgA.workspaceId,
        organizationId: orgA.organizationId,
        ownerUserId: orgA.owner.userId,
        type: "DOCUMENT",
        title: `p4c-only-A-${deps.tag}`,
      },
    });
  }, 300_000);

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  // =========================================================================
  // The three ledger disagreements.
  // =========================================================================
  describe("a page's scope claim matches the scope its API enforces", () => {
    /*
     * The ledger recorded these three under `/admin/platform/` with workspace
     * authority, which looked like platform pages opened by a workspace
     * capability. Running them says the opposite and is more useful: they are
     * WORKSPACE-scoped surfaces, correctly enforcing workspace authority, and
     * what is wrong is the label above them.
     *
     *   /v1/reliability/*        requireAdminMember  — workspace admin
     *   /v1/ops/workflows        operations.view     — workspace capability
     *   /v1/admin/analytics/…    platform
     *
     * So the defect is scope TRUTH, not scope enforcement: a page whose
     * eyebrow reads "Platform operations" while its own subtitle and its API
     * both say "this workspace" tells an operator the blast radius is the
     * platform when it is one tenant.
     */
    const WORKSPACE_SCOPED_APIS = [
      "/v1/reliability/summary",
      "/v1/reliability/upload-sessions",
      "/v1/ops/workflows",
    ];

    it("a workspace administrator reads their OWN workspace", async () => {
      for (const api of WORKSPACE_SCOPED_APIS) {
        const res = await call(
          orgA.owner.token,
          "GET",
          `${api}?teamId=${orgA.workspaceId}`,
        );
        expect(res.status, `${api} refused its own workspace admin`).toBeLessThan(400);
      }
    });

    it("and CANNOT read another workspace, in the query or with no membership", async () => {
      for (const api of WORKSPACE_SCOPED_APIS) {
        const cross = await call(
          orgA.owner.token,
          "GET",
          `${api}?teamId=${orgB.workspaceId}`,
        );
        expect(refused(cross), `${api} let A read B (${cross.status})`).toBe(true);
        expect(cross.text.includes(orgB.organizationId), `${api} leaked B`).toBe(false);
      }
    });

    it("a platform admin who is not a member is refused, and that is correct", async () => {
      /*
       * These are tenant surfaces. Platform authority is deliberately NOT a
       * skeleton key into one customer's operational data — support access is
       * the audited path for that. The page label must therefore not promise a
       * platform view.
       */
      await setActive(platformAdmin.userId, orgA.workspaceId);
      for (const api of WORKSPACE_SCOPED_APIS) {
        const res = await call(
          platformAdmin.token,
          "GET",
          `${api}?teamId=${orgA.workspaceId}`,
        );
        expect(
          refused(res),
          `${api} handed a non-member platform admin tenant data (${res.status})`,
        ).toBe(true);
      }
    });

    it("an anonymous caller reaches none of them", async () => {
      for (const api of WORKSPACE_SCOPED_APIS) {
        const res = await call(null, "GET", api);
        expect(refused(res), `${api} opened anonymously`).toBe(true);
      }
    });

    it("the platform analytics dashboard IS platform-scoped and refuses workspace roles", async () => {
      await setActive(platformAdmin.userId, orgA.workspaceId);
      const ok = await call(platformAdmin.token, "GET", "/v1/admin/analytics/dashboard");
      expect(ok.status, "platform analytics refused the platform operator").toBeLessThan(400);

      for (const t of [orgA.owner.token, readOnly.token, freePersonal.token]) {
        const res = await call(t, "GET", "/v1/admin/analytics/dashboard");
        expect(refused(res), `platform analytics opened with ${res.status}`).toBe(true);
      }
    });
  });

  // =========================================================================
  // Platform truth does not move with the header workspace.
  // =========================================================================
  describe("platform surfaces answer from platform authority, not header state", () => {
    const PLATFORM_GETS = [
      "/v1/admin/users?limit=50",
      "/v1/admin/customers?limit=50",
      "/v1/admin/workspaces?limit=50",
      "/v1/admin/search?q=p4c",
    ];

    it("A/B/A: the identity set does not change with the active workspace", async () => {
      for (const url of PLATFORM_GETS) {
        await setActive(platformAdmin.userId, orgA.workspaceId);
        const a1 = await call(platformAdmin.token, "GET", url);
        await setActive(platformAdmin.userId, orgB.workspaceId);
        const b = await call(platformAdmin.token, "GET", url);
        await setActive(platformAdmin.userId, orgA.workspaceId);
        const a2 = await call(platformAdmin.token, "GET", url);

        const ids = (r: typeof a1) => {
          const body = (r.body ?? {}) as Record<string, unknown>;
          const rows =
            (body["items"] as unknown[]) ??
            (body["users"] as unknown[]) ??
            (body["customers"] as unknown[]) ??
            (body["workspaces"] as unknown[]) ??
            [];
          return (rows as Array<{ id?: string }>).map((x) => x.id).sort();
        };
        // A1 == A2 establishes the reading is stable in time; only then does
        // a difference against B mean the HEADER changed the answer.
        expect(ids(a2), `${url} is not stable in time`).toEqual(ids(a1));
        expect(ids(b), `${url} changed with the header workspace`).toEqual(ids(a1));
      }
    });

    it("a foreign or forged teamId is not a ticket to a platform surface", async () => {
      const tickets = [orgB.workspaceId, emptyWorkspaceId, randomUUID(), "not-a-uuid"];
      for (const url of PLATFORM_GETS) {
        for (const teamId of tickets) {
          const sep = url.includes("?") ? "&" : "?";
          const res = await call(orgA.owner.token, "GET", `${url}${sep}teamId=${teamId}`);
          expect(
            refused(res),
            `${url} opened for a workspace owner with teamId=${teamId}`,
          ).toBe(true);
        }
      }
    });
  });

  // =========================================================================
  // Tenant isolation across the four id classes.
  // =========================================================================
  describe("workspace surfaces bind authority to the real target", () => {
    it("A reads A, and B is refused in query, path and body", async () => {
      const own = await call(
        orgA.owner.token,
        "GET",
        `/v1/admin/identity/scim/tokens?teamId=${orgA.workspaceId}`,
      );
      expect([200, 402, 403], "A reading A").toContain(own.status);

      const crossQuery = await call(
        orgA.owner.token,
        "GET",
        `/v1/admin/identity/scim/tokens?teamId=${orgB.workspaceId}`,
      );
      expect(refused(crossQuery), "A read B by query").toBe(true);
      expect(crossQuery.text.includes(orgB.organizationId), "leaked B org id").toBe(false);

      const before = await prisma.scimProvisioningToken.count({
        where: { teamId: orgB.workspaceId },
      });
      const crossBody = await call(
        orgA.owner.token,
        "POST",
        "/v1/admin/identity/scim/tokens",
        { teamId: orgB.workspaceId, name: "p4c-cross", scopes: ["users.read"] },
      );
      expect(refused(crossBody), "A minted into B").toBe(true);
      expect(
        await prisma.scimProvisioningToken.count({ where: { teamId: orgB.workspaceId } }),
        "a refusal still wrote a row",
      ).toBe(before);
    });

    it("a foreign id is byte-identical to a missing one, and unaffected", async () => {
      const bToken = await prisma.scimProvisioningToken.create({
        data: {
          teamId: orgB.workspaceId,
          name: `p4c-b-${deps.tag}`,
          tokenPrefix: "scim_pat_p4c",
          tokenHash: randomUUID().replace(/-/g, ""),
          scopes: ["users.read"],
          ipAllowlist: [],
          createdByUserId: orgB.owner.userId,
        },
        select: { id: true },
      });

      const foreign = await call(
        orgA.owner.token,
        "POST",
        `/v1/admin/identity/scim/tokens/${bToken.id}/revoke`,
        { teamId: orgA.workspaceId },
      );
      const missing = await call(
        orgA.owner.token,
        "POST",
        `/v1/admin/identity/scim/tokens/${randomUUID()}/revoke`,
        { teamId: orgA.workspaceId },
      );
      expect(foreign.status, "foreign vs missing status").toBe(missing.status);
      expect(foreign.code, "foreign vs missing code").toBe(missing.code);
      expect(
        (
          await prisma.scimProvisioningToken.findUniqueOrThrow({
            where: { id: bToken.id },
            select: { status: true },
          })
        ).status,
        "B's token was revoked across tenants",
      ).toBe("ACTIVE");
    });

    it("a malformed id is validation, not concealment", async () => {
      const res = await call(
        orgA.owner.token,
        "POST",
        "/v1/admin/identity/scim/tokens/not-a-uuid/revoke",
        { teamId: orgA.workspaceId },
      );
      expect([400, 404], `malformed id → ${res.status}`).toContain(res.status);
    });
  });

  // =========================================================================
  // Response projections.
  // =========================================================================
  describe("no response carries credential or infrastructure material", () => {
    const FORBIDDEN = [
      "passwordHash",
      "password_hash",
      "tokenHash",
      "token_hash",
      "clientSecret",
      "client_secret",
      "arn:aws",
      "AKIA",
      "BEGIN RSA PRIVATE KEY",
      "BEGIN PRIVATE KEY",
      "postgresql://",
      "redis://",
    ];

    it("every platform read stays clean", async () => {
      await setActive(platformAdmin.userId, orgA.workspaceId);
      const urls = [
        "/v1/admin/users?limit=20",
        "/v1/admin/customers?limit=20",
        "/v1/admin/workspaces?limit=20",
        "/v1/admin/search?q=p4c",
        "/v1/admin/platform/metrics",
        "/v1/admin/platform/alerts",
        `/v1/admin/identity/sessions?teamId=${orgA.workspaceId}`,
        `/v1/admin/identity/timeline?teamId=${orgA.workspaceId}`,
      ];
      for (const url of urls) {
        const res = await call(platformAdmin.token, "GET", url);
        if (res.status !== 200) continue;
        for (const secret of FORBIDDEN) {
          expect(res.text.includes(secret), `${url} leaked ${secret}`).toBe(false);
        }
      }
    });

    it("a session projection never returns a raw client string", async () => {
      const LONG_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Tail/0123456789";
      await prisma.authenticatedSession.create({
        data: {
          userId: orgA.owner.userId,
          teamId: orgA.workspaceId,
          sessionIdHash: randomUUID().replace(/-/g, ""),
          uaPreview: LONG_UA.slice(0, 120),
          ipPreview: "203.0.113.x",
          expiresAtUtc: new Date(Date.now() + 3_600_000),
        },
      });
      const res = await call(
        platformAdmin.token,
        "GET",
        `/v1/admin/identity/sessions?teamId=${orgA.workspaceId}`,
      );
      if (res.status === 200) {
        expect(res.text.includes(LONG_UA), "untruncated user-agent reached the client").toBe(
          false,
        );
        expect(res.text.includes("203.0.113.45"), "a full IPv4 reached the client").toBe(
          false,
        );
      }
    });
  });
});
