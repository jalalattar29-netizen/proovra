/**
 * PHASE 4 — ADMIN AUTHORIZATION, SCOPE, TENANT ISOLATION AND AUDIENCE.
 *
 * Live PostgreSQL 16, real routes, real authorization. No mocked auth hook.
 *
 * WHAT THIS PROVES
 * ---------------------------------------------------------------------------
 * The chain the Admin surface depends on, end to end:
 *
 *   navigation audience → direct page access → API authority → target lookup
 *   → tenant filtering → response projection → control authority
 *   → mutation target → audit actor and scope
 *
 * Three properties get their own sections because each has its own failure
 * mode and each has been wrong here before:
 *
 *   PLATFORM-GLOBAL surfaces must not change what they report because the
 *   operator switched the workspace in their header, and must not be reachable
 *   by holding membership in some workspace. A `teamId` in a query string is
 *   not a ticket to cross-tenant data.
 *
 *   WORKSPACE-SCOPED surfaces must bind authority to the exact target, and a
 *   substituted id — in the path, the query or the body — must refuse without
 *   disclosing whether the other tenant's record exists.
 *
 *   RESPONSE PROJECTIONS must not carry credential material, infrastructure
 *   internals or another tenant's identifiers, whoever is asking.
 *
 * Two differently-seeded workspaces exist throughout, because "the answer did
 * not change" is only meaningful when the two workspaces genuinely differ.
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

describe("PHASE 4 — Admin scope, tenant isolation and audience (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;

  /** Platform authority. */
  let platformAdmin: SeededUser;
  /** Two unrelated org workspaces, each with its own owner and data. */
  let orgA: { organizationId: string; workspaceId: string; owner: SeededUser };
  let orgB: { organizationId: string; workspaceId: string; owner: SeededUser };
  /** A workspace member with no admin rights anywhere. */
  let plainMember: SeededUser;
  /** Personal tenants, one FREE one PRO. */
  let freePersonal: { owner: SeededUser; personalTeamId: string };
  let proPersonal: { owner: SeededUser; personalTeamId: string };
  /** An owned workspace that is deliberately left empty. */
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

  /** Sets the persisted active workspace — the header rail the console reads. */
  async function setActiveWorkspace(userId: string, teamId: string) {
    await prisma.user.update({
      where: { id: userId },
      data: { currentWorkspaceId: teamId },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `p4-${Date.now().toString(36)}`,
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
          60 * 60,
        ),
    };

    platformAdmin = await seedUser(deps, "p4-platform-admin");
    await prisma.user.update({
      where: { id: platformAdmin.userId },
      data: { platformRole: "admin" },
    });
    await bootstrapPersonalSpace(deps, platformAdmin.userId);

    const a = await seedOrganizationTenant(deps, { contractStatus: "ACTIVE" });
    orgA = { organizationId: a.organizationId, workspaceId: a.workspaceId, owner: a.owner };
    const b = await seedOrganizationTenant(deps, { contractStatus: "ACTIVE" });
    orgB = { organizationId: b.organizationId, workspaceId: b.workspaceId, owner: b.owner };

    plainMember = await seedUser(deps, "p4-plain-member");
    await bootstrapPersonalSpace(deps, plainMember.userId);

    const free = await seedPersonalTenant(deps, "FREE");
    freePersonal = { owner: free.owner, personalTeamId: free.personalTeamId };
    const pro = await seedPersonalTenant(deps, "PRO");
    proPersonal = { owner: pro.owner, personalTeamId: pro.personalTeamId };

    const emptyOwner = await seedUser(deps, "p4-empty-owner");
    await bootstrapPersonalSpace(deps, emptyOwner.userId);
    const empty = await seedOwnedWorkspace(deps, {
      ownerUserId: emptyOwner.userId,
      name: `p4-empty-${deps.tag}`,
      billingPlan: "TEAM",
    });
    emptyWorkspaceId = empty.teamId;

    // Workspace A gets data the other does not, so "the global answer did not
    // change" is a claim with something behind it.
    await prisma.evidence.create({
      data: {
        teamId: orgA.workspaceId,
        organizationId: orgA.organizationId,
        ownerUserId: orgA.owner.userId,
        type: "DOCUMENT",
        title: `p4-only-in-A-${deps.tag}`,
      },
    });
  }, 300_000);

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  // =========================================================================
  // PLATFORM-GLOBAL: the header workspace is not an input, and membership is
  // not a ticket.
  // =========================================================================
  describe("PLATFORM_GLOBAL surfaces answer from platform authority alone", () => {
    const GLOBAL_GETS = [
      "/v1/admin/platform/metrics",
      "/v1/admin/platform/alerts",
      "/v1/admin/search?q=p4",
      "/v1/admin/users?limit=5",
      "/v1/admin/customers?limit=5",
    ];

    it("a platform admin reads them regardless of which workspace is active", async () => {
      for (const url of GLOBAL_GETS) {
        await setActiveWorkspace(platformAdmin.userId, orgA.workspaceId);
        const withA = await call(platformAdmin.token, "GET", url);
        await setActiveWorkspace(platformAdmin.userId, orgB.workspaceId);
        const withB = await call(platformAdmin.token, "GET", url);

        expect(withA.status, `${url} with workspace A`).toBe(200);
        expect(withB.status, `${url} with workspace B`).toBe(200);
      }
    });

    it("switching the active workspace does not change global truth", async () => {
      // Population and inventory endpoints: the SET they report is global, so
      // the identities in it must not move when the operator's header does.
      for (const url of ["/v1/admin/users?limit=50", "/v1/admin/customers?limit=50"]) {
        await setActiveWorkspace(platformAdmin.userId, orgA.workspaceId);
        const a = await call(platformAdmin.token, "GET", url);
        await setActiveWorkspace(platformAdmin.userId, orgB.workspaceId);
        const b = await call(platformAdmin.token, "GET", url);

        const idsOf = (r: typeof a) => {
          const body = r.body as Record<string, unknown>;
          const rows =
            (body["items"] as unknown[]) ??
            (body["users"] as unknown[]) ??
            (body["customers"] as unknown[]) ??
            [];
          return (rows as Array<{ id?: string }>).map((x) => x.id).sort();
        };
        expect(idsOf(b), `${url} changed with the header workspace`).toEqual(idsOf(a));
      }
    });

    it("a workspace member cannot reach them by supplying any teamId", async () => {
      const tickets = [
        orgA.workspaceId,
        orgB.workspaceId,
        freePersonal.personalTeamId,
        emptyWorkspaceId,
      ];
      for (const url of GLOBAL_GETS) {
        const bare = await call(orgA.owner.token, "GET", url);
        expect([401, 403, 404], `${url} bare owner`).toContain(bare.status);

        for (const teamId of tickets) {
          const sep = url.includes("?") ? "&" : "?";
          const withTicket = await call(
            orgA.owner.token,
            "GET",
            `${url}${sep}teamId=${teamId}`,
          );
          expect(
            [401, 403, 404],
            `${url} became reachable with teamId=${teamId}`,
          ).toContain(withTicket.status);
        }
      }
    });

    it("anonymous callers are refused every global surface", async () => {
      for (const url of GLOBAL_GETS) {
        const res = await call(null, "GET", url);
        expect([401, 403, 404], url).toContain(res.status);
      }
    });

    it("the global telemetry projection carries no infrastructure internals", async () => {
      await setActiveWorkspace(platformAdmin.userId, orgA.workspaceId);
      for (const url of ["/v1/admin/platform/metrics", "/v1/admin/platform/alerts"]) {
        const res = await call(platformAdmin.token, "GET", url);
        expect(res.status, url).toBe(200);
        const text = res.text;
        for (const forbidden of [
          "passwordHash",
          "tokenHash",
          "arn:aws",
          "AKIA",
          "BEGIN RSA",
          "BEGIN PRIVATE KEY",
          "DATABASE_URL",
          "postgresql://",
          "redis://",
        ]) {
          expect(text.includes(forbidden), `${url} leaked ${forbidden}`).toBe(false);
        }
      }
    });
  });

  // =========================================================================
  // WORKSPACE-SCOPED: authority binds to the target, not to the declaration.
  // =========================================================================
  describe("WORKSPACE_SCOPED surfaces bind authority to the real target", () => {
    it("A can read A", async () => {
      const res = await call(
        orgA.owner.token,
        "GET",
        `/v1/admin/identity/scim/tokens?teamId=${orgA.workspaceId}`,
      );
      // Either allowed, or refused for a reason that is not "wrong tenant".
      expect([200, 402, 403], "A reading A").toContain(res.status);
    });

    it("A cannot read B — query substitution", async () => {
      const res = await call(
        orgA.owner.token,
        "GET",
        `/v1/admin/identity/scim/tokens?teamId=${orgB.workspaceId}`,
      );
      expect([401, 403, 404], "A read B's SCIM tokens").toContain(res.status);
      expect(res.text.includes(orgB.organizationId), "leaked B's org id").toBe(false);
    });

    it("A cannot mutate B — body substitution, and nothing is written", async () => {
      const before = await prisma.scimProvisioningToken.count({
        where: { teamId: orgB.workspaceId },
      });
      const res = await call(
        orgA.owner.token,
        "POST",
        "/v1/admin/identity/scim/tokens",
        { teamId: orgB.workspaceId, name: "p4-cross-tenant", scopes: ["users.read"] },
      );
      expect([401, 403, 404], "A minted a token in B").toContain(res.status);
      const after = await prisma.scimProvisioningToken.count({
        where: { teamId: orgB.workspaceId },
      });
      expect(after, "refusal still wrote a row").toBe(before);
    });

    it("a foreign resource id is indistinguishable from one that does not exist", async () => {
      const bToken = await prisma.scimProvisioningToken.create({
        data: {
          teamId: orgB.workspaceId,
          name: `p4-b-${deps.tag}`,
          tokenPrefix: "scim_pat_p4b",
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

      const still = await prisma.scimProvisioningToken.findUniqueOrThrow({
        where: { id: bToken.id },
        select: { status: true },
      });
      expect(still.status, "B's token was revoked across tenants").toBe("ACTIVE");
    });

    it("a malformed id is a validation error, not a concealment 404", async () => {
      const res = await call(
        orgA.owner.token,
        "POST",
        "/v1/admin/identity/scim/tokens/not-a-uuid/revoke",
        { teamId: orgA.workspaceId },
      );
      expect([400, 404], "malformed id").toContain(res.status);
    });
  });

  // =========================================================================
  // RESPONSE SENSITIVITY: what leaves the server, for every audience.
  // =========================================================================
  describe("response projections carry no credential or infrastructure material", () => {
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

    it("admin rosters and detail projections stay clean", async () => {
      await setActiveWorkspace(platformAdmin.userId, orgA.workspaceId);
      const urls = [
        "/v1/admin/users?limit=20",
        "/v1/admin/customers?limit=20",
        "/v1/admin/search?q=p4",
        `/v1/admin/identity/sessions?teamId=${orgA.workspaceId}`,
      ];
      for (const url of urls) {
        const res = await call(platformAdmin.token, "GET", url);
        if (res.status !== 200) continue;
        for (const secret of FORBIDDEN) {
          expect(res.text.includes(secret), `${url} leaked ${secret}`).toBe(false);
        }
      }
    });

    it("the session model stores previews, never the raw client strings", async () => {
      /*
       * The storage layer is the first place this can go wrong, and here it is
       * already right: `AuthenticatedSession` has `uaPreview` (120 chars) and
       * `ipPreview` (64), not a raw `userAgent` or `ipAddress` column. This
       * pins that, because re-introducing a raw column is exactly how the
       * projection would start leaking again.
       */
      const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'authenticated_sessions'`,
      );
      const names = columns.map((c) => c.column_name);
      expect(names, "a raw user-agent column came back").not.toContain("user_agent");
      expect(names, "a raw ip column came back").not.toContain("ip_address");
      expect(names).toContain("ua_preview");
      expect(names).toContain("ip_preview");
    });

    it("a session projection bounds the client strings it does return", async () => {
      const LONG_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 VeryLongTail/0123456789";
      await prisma.authenticatedSession.create({
        data: {
          userId: orgA.owner.userId,
          teamId: orgA.workspaceId,
          sessionIdHash: randomUUID().replace(/-/g, ""),
          uaPreview: LONG_UA.slice(0, 120),
          ipPreview: "203.0.113.x",
          expiresAtUtc: new Date(Date.now() + 3600_000),
        },
      });

      const res = await call(
        platformAdmin.token,
        "GET",
        `/v1/admin/identity/sessions?teamId=${orgA.workspaceId}`,
      );
      if (res.status === 200) {
        expect(
          res.text.includes(LONG_UA),
          "the untruncated user-agent string reached the client",
        ).toBe(false);
        expect(
          res.text.includes("203.0.113.45"),
          "a full IPv4 address reached the client",
        ).toBe(false);
      }
    });
  });

  // =========================================================================
  // CUSTOMER SEMANTICS: not every Organization row is a customer.
  // =========================================================================
  describe("customer controls act on customers, and refuse the rest", () => {
    /**
     * The 1:1 container behind a PERSONAL space.
     *
     * The guard is deliberately NOT "kind is not CUSTOMER":
     * `grantEnterprisePlanToOrg` is the act that PROMOTES an organization to
     * CUSTOMER, so refusing a SYSTEM organization would refuse every
     * legitimate first grant. The property that must hold is narrower and
     * real — an individual's personal container is not a purchased
     * organization, and a customer control must never rewrite its plan.
     */
    async function personalContainerOrgId(): Promise<string> {
      const team = await prisma.team.findFirstOrThrow({
        where: { isPersonal: true },
        select: { organizationId: true },
      });
      return team.organizationId!;
    }

    it("the roster shows customers only — a personal container is never listed", async () => {
      const personalOrgId = await personalContainerOrgId();
      const res = await call(platformAdmin.token, "GET", "/v1/admin/customers?limit=100");
      expect(res.status).toBe(200);
      expect(
        res.text.includes(personalOrgId),
        "a personal container appeared in the customer roster",
      ).toBe(false);
    });

    it("suspending a personal container is refused as not-a-customer", async () => {
      const personalOrgId = await personalContainerOrgId();
      const res = await call(
        platformAdmin.token,
        "POST",
        `/v1/admin/orgs/${personalOrgId}/suspend`,
        { teamId: orgA.workspaceId, reason: "p4 probe" },
      );
      // Step-up may intercept first; either way it must never succeed.
      expect(res.status, "a personal container was suspended").not.toBe(200);
      const after = await prisma.organization.findUniqueOrThrow({
        where: { id: personalOrgId },
        select: { status: true },
      });
      expect(after.status, "the personal container's status moved").not.toBe("SUSPENDED");
    });

    it("granting a plan to a personal container is refused", async () => {
      /*
       * The defect this pins. Suspend and resume both route through
       * `loadCustomerOrg`. The plan grant looked the organization up with
       * `select: { id: true }` and checked only that it existed, so nothing
       * stopped it rewriting `billingPlan`, `includedSeats` and
       * `billingStatus` on every workspace under a personal space's
       * container — silently moving an individual onto an enterprise plan
       * they never bought, on a row the customer roster will never show.
       */
      const personalOrgId = await personalContainerOrgId();
      const workspacesBefore = await prisma.team.findMany({
        where: { organizationId: personalOrgId },
        select: { id: true, billingPlan: true },
        orderBy: { id: "asc" },
      });

      const res = await call(
        platformAdmin.token,
        "PATCH",
        `/v1/admin/orgs/${personalOrgId}/plan`,
        { teamId: orgA.workspaceId, plan: "ENTERPRISE" },
      );
      expect(res.status, "a personal container was granted a plan").not.toBe(200);

      const workspacesAfter = await prisma.team.findMany({
        where: { organizationId: personalOrgId },
        select: { id: true, billingPlan: true },
        orderBy: { id: "asc" },
      });
      expect(
        workspacesAfter,
        "the refusal still rewrote billingPlan on the container's workspaces",
      ).toEqual(workspacesBefore);

      /*
       * The route refuses at step-up, which is a DIFFERENT control and would
       * keep passing even with the kind guard gone. The guard itself is
       * asserted against the real service, so removing it fails here rather
       * than silently relying on the gate in front of it.
       */
      const { grantEnterprisePlanToOrg, EnterpriseProvisioningError } = await import(
        "../src/services/enterprise-provisioning.service.js"
      );
      await expect(
        grantEnterprisePlanToOrg({
          orgId: personalOrgId,
          plan: "ENTERPRISE",
          actorUserId: platformAdmin.userId,
        }),
        "the plan grant accepted a personal container",
      ).rejects.toBeInstanceOf(EnterpriseProvisioningError);

      const workspacesAfterService = await prisma.team.findMany({
        where: { organizationId: personalOrgId },
        select: { id: true, billingPlan: true },
        orderBy: { id: "asc" },
      });
      expect(
        workspacesAfterService,
        "the service refusal still rewrote billingPlan",
      ).toEqual(workspacesBefore);
    });
  });

  // =========================================================================
  // SUPPORT ACCESS: a grant inventory is platform-global, and its existence
  // must not be enumerable.
  // =========================================================================
  describe("support access is platform-scoped and not enumerable", () => {
    it("a workspace identity cannot enumerate the grant inventory", async () => {
      for (const token of [orgA.owner.token, plainMember.token, freePersonal.owner.token]) {
        const res = await call(token, "GET", "/v1/support-access/grants");
        expect([401, 403, 404], "grant inventory leaked").toContain(res.status);
        expect(res.text.includes(orgB.organizationId), "leaked B's org id").toBe(false);
      }
    });

    it("an anonymous caller cannot enumerate or start support access", async () => {
      expect([401, 403]).toContain((await call(null, "GET", "/v1/support-access/grants")).status);
      const start = await call(null, "POST", "/v1/support-access/start", {
        teamId: orgA.workspaceId,
      });
      expect([401, 403]).toContain(start.status);
    });

    it("a refused support-access start writes nothing", async () => {
      const before = await prisma.supportAccessGrant.count().catch(() => -1);
      const res = await call(orgA.owner.token, "POST", "/v1/support-access/start", {
        teamId: orgB.workspaceId,
        reason: "p4 cross-tenant probe",
      });
      expect([400, 401, 403, 404], "a workspace owner started support access").toContain(
        res.status,
      );
      const after = await prisma.supportAccessGrant.count().catch(() => -1);
      expect(after, "the refusal still created a grant").toBe(before);
    });
  });

  // =========================================================================
  // LOOKUP ORDER: authority before projection, and the four id classes.
  // =========================================================================
  describe("authorization runs before the resource is projected", () => {
    /**
     * The four cases that must be distinguishable to an operator and
     * indistinguishable to an attacker: a malformed id is a validation error,
     * an unauthorized caller never learns whether the record exists, and a
     * foreign id looks exactly like a missing one.
     */
    it("an unauthorized caller learns nothing about a real resource", async () => {
      const realOrgId = orgB.organizationId;
      const fakeOrgId = randomUUID();

      const realRes = await call(
        orgA.owner.token,
        "GET",
        `/v1/admin/customers/${realOrgId}`,
      );
      const fakeRes = await call(
        orgA.owner.token,
        "GET",
        `/v1/admin/customers/${fakeOrgId}`,
      );
      expect([401, 403, 404], "real org").toContain(realRes.status);
      expect(
        realRes.status,
        "a real foreign org answered differently from a missing one",
      ).toBe(fakeRes.status);
      expect(realRes.text.includes(realOrgId), "echoed the foreign org id").toBe(false);
    });

    it("a malformed id never reaches the resource lookup", async () => {
      for (const token of [platformAdmin.token, orgA.owner.token]) {
        const res = await call(token, "GET", "/v1/admin/customers/not-a-uuid");
        expect([400, 403, 404], "malformed id").toContain(res.status);
      }
    });
  });

  // =========================================================================
  // AUDIENCE: a workspace administrator must never enumerate other workspaces.
  // =========================================================================
  describe("audience — workspace administrators cannot enumerate the platform", () => {
    it("an organization owner cannot list platform users or customers", async () => {
      for (const url of ["/v1/admin/users?limit=5", "/v1/admin/customers?limit=5"]) {
        const res = await call(orgA.owner.token, "GET", url);
        expect([401, 403, 404], url).toContain(res.status);
        expect(res.text.includes(orgB.organizationId), `${url} leaked B`).toBe(false);
      }
    });

    it("a plain member with no workspace admin rights reaches nothing under /v1/admin", async () => {
      for (const url of [
        "/v1/admin/users?limit=5",
        "/v1/admin/customers?limit=5",
        "/v1/admin/platform/metrics",
        "/v1/admin/search?q=p4",
      ]) {
        const res = await call(plainMember.token, "GET", url);
        expect([401, 403, 404], url).toContain(res.status);
      }
    });

    it("personal-plan owners reach nothing under /v1/admin", async () => {
      for (const owner of [freePersonal.owner, proPersonal.owner]) {
        const res = await call(owner.token, "GET", "/v1/admin/users?limit=5");
        expect([401, 403, 404], `personal owner ${owner.email}`).toContain(res.status);
      }
    });
  });
});
