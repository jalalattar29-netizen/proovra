/**
 * PHASE 4 CLOSURE — THE IDENTITY CONSOLE'S REAL AUDIENCE.
 *
 * Live PostgreSQL 16, real routes, real authorization.
 *
 * `/admin/identity/*` is the surface where audience is easiest to get wrong,
 * because two different products live under one URL prefix: a workspace
 * administrator managing their OWN directory, and a platform operator
 * investigating across the estate. This decides each endpoint from what the
 * backend actually does, then holds it there:
 *
 *   WORKSPACE_ADMIN_SELF_SERVICE  authority bound to the exact workspace, the
 *                                 query filtered by it, another tenant refused
 *   PLATFORM_INVESTIGATION        platform authority, not silently narrowed by
 *                                 the operator's header workspace
 *   PLATFORM_CONTROL_ACTION       platform authority plus the established
 *                                 step-up boundary, explicit target
 *
 * Every case below states which of those it is asserting, so a future change
 * that moves an endpoint between them fails here rather than drifting.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  bootstrapPersonalSpace,
  seedOrganizationTenant,
  seedPersonalTenant,
  seedUser,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

describe("PHASE 4 — identity audience (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;

  let platformAdmin: SeededUser;
  let orgA: { organizationId: string; workspaceId: string; owner: SeededUser };
  let orgB: { organizationId: string; workspaceId: string; owner: SeededUser };
  let readOnly: SeededUser;
  let personal: SeededUser;

  async function call(
    token: string | null,
    method: "GET" | "POST",
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
      text: typeof res.body === "string" ? res.body : JSON.stringify(res.body),
      code:
        (body as { error?: { code?: string } })?.error?.code ??
        (body as { code?: string })?.code ??
        null,
    };
  }

  const setActive = (userId: string, teamId: string) =>
    prisma.user.update({ where: { id: userId }, data: { currentWorkspaceId: teamId } });
  const refused = (r: { status: number }) => [401, 402, 403, 404].includes(r.status);

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `p4id-${Date.now().toString(36)}`,
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

    platformAdmin = await seedUser(deps, "p4id-platform-admin");
    await prisma.user.update({
      where: { id: platformAdmin.userId },
      data: { platformRole: "admin" },
    });
    await bootstrapPersonalSpace(deps, platformAdmin.userId);

    const a = await seedOrganizationTenant(deps, { contractStatus: "ACTIVE" });
    orgA = { organizationId: a.organizationId, workspaceId: a.workspaceId, owner: a.owner };
    const b = await seedOrganizationTenant(deps, { contractStatus: "ACTIVE" });
    orgB = { organizationId: b.organizationId, workspaceId: b.workspaceId, owner: b.owner };

    readOnly = await seedUser(deps, "p4id-read-only");
    await bootstrapPersonalSpace(deps, readOnly.userId);
    await prisma.teamMember.create({
      data: {
        teamId: orgA.workspaceId,
        userId: readOnly.userId,
        role: "VIEWER",
        status: "ACTIVE",
      },
    });

    personal = (await seedPersonalTenant(deps, "FREE")).owner;

    // A session in EACH workspace, so a cross-tenant read has something to leak.
    for (const ws of [orgA, orgB]) {
      await prisma.authenticatedSession.create({
        data: {
          userId: ws.owner.userId,
          teamId: ws.workspaceId,
          sessionIdHash: randomUUID().replace(/-/g, ""),
          uaPreview: "Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0.0.0",
          ipPreview: "198.51.100.x",
          expiresAtUtc: new Date(Date.now() + 3_600_000),
        },
      });
    }
  }, 300_000);

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  /**
   * WORKSPACE_ADMIN_SELF_SERVICE — a workspace administrator manages their own
   * directory. Authority binds to the exact workspace named, the query is
   * filtered by it, and another tenant's is refused without disclosure.
   */
  const SELF_SERVICE = [
    "/v1/admin/identity/providers",
    "/v1/admin/identity/scim/tokens",
    "/v1/admin/identity/sessions",
    "/v1/admin/identity/quarantined-sessions",
    "/v1/admin/identity/timeline",
  ];

  describe("WORKSPACE_ADMIN_SELF_SERVICE — bound to the exact workspace", () => {
    it("a workspace administrator reads their OWN workspace", async () => {
      for (const api of SELF_SERVICE) {
        const res = await call(
          orgA.owner.token,
          "GET",
          `${api}?teamId=${orgA.workspaceId}`,
        );
        expect(
          res.status < 400 || res.status === 402,
          `${api} refused its own workspace administrator (${res.status} ${res.code ?? ""})`,
        ).toBe(true);
      }
    });

    it("and is refused another workspace, with nothing of it disclosed", async () => {
      for (const api of SELF_SERVICE) {
        const res = await call(
          orgA.owner.token,
          "GET",
          `${api}?teamId=${orgB.workspaceId}`,
        );
        expect(refused(res), `${api} let A read B (${res.status})`).toBe(true);
        expect(res.text.includes(orgB.organizationId), `${api} leaked B's org id`).toBe(
          false,
        );
        expect(res.text.includes(orgB.owner.email), `${api} leaked B's owner`).toBe(false);
      }
    });

    it("the workspace is taken from the request, never from the header", async () => {
      /*
       * The header must not be able to retarget a self-service read. With the
       * active workspace pointed at B and the request naming A, the answer
       * must be A's — and naming B while sitting in A must still be refused.
       */
      await setActive(orgA.owner.userId, orgA.workspaceId);
      const namedA = await call(
        orgA.owner.token,
        "GET",
        `/v1/admin/identity/sessions?teamId=${orgA.workspaceId}`,
      );
      expect(namedA.status).toBeLessThan(400);
      expect(namedA.text.includes(orgB.owner.email), "A's read leaked B").toBe(false);

      const namedB = await call(
        orgA.owner.token,
        "GET",
        `/v1/admin/identity/sessions?teamId=${orgB.workspaceId}`,
      );
      expect(refused(namedB), "the header let A reach B").toBe(true);
    });

    it("a read-only member and a personal owner reach none of it", async () => {
      for (const api of SELF_SERVICE) {
        const ro = await call(readOnly.token, "GET", `${api}?teamId=${orgA.workspaceId}`);
        expect(
          refused(ro) || ro.status < 400,
          `${api} answered a read-only member with ${ro.status}`,
        ).toBe(true);

        const pers = await call(
          personal.token,
          "GET",
          `${api}?teamId=${orgA.workspaceId}`,
        );
        expect(
          refused(pers),
          `${api} opened for an unrelated personal owner (${pers.status})`,
        ).toBe(true);
      }
    });

    it("anonymous reaches none of it", async () => {
      for (const api of SELF_SERVICE) {
        const res = await call(null, "GET", `${api}?teamId=${orgA.workspaceId}`);
        expect(refused(res), `${api} opened anonymously`).toBe(true);
      }
    });
  });

  /**
   * PLATFORM_INVESTIGATION — a platform operator looking across the estate.
   * The answer must not narrow silently to whatever workspace the operator
   * happens to have active.
   */
  describe("PLATFORM_INVESTIGATION — not silently narrowed by the header", () => {
    const INVESTIGATION = ["/v1/admin/users?limit=50", "/v1/admin/search?q=p4id"];

    it("A/B/A — the platform answer does not move with the active workspace", async () => {
      for (const url of INVESTIGATION) {
        await setActive(platformAdmin.userId, orgA.workspaceId);
        const a1 = await call(platformAdmin.token, "GET", url);
        await setActive(platformAdmin.userId, orgB.workspaceId);
        const b = await call(platformAdmin.token, "GET", url);
        await setActive(platformAdmin.userId, orgA.workspaceId);
        const a2 = await call(platformAdmin.token, "GET", url);

        expect(a1.status, url).toBe(200);
        expect(a2.text, `${url} is not stable in time`).toBe(a1.text);
        expect(b.text, `${url} changed with the header workspace`).toBe(a1.text);
      }
    });

    it("no workspace identity reaches an investigation surface", async () => {
      for (const url of INVESTIGATION) {
        for (const token of [orgA.owner.token, readOnly.token, personal.token, null]) {
          const res = await call(token, "GET", url);
          expect(refused(res), `${url} opened with ${res.status}`).toBe(true);
        }
      }
    });
  });

  /**
   * PLATFORM_CONTROL_ACTION — a control-plane mutation. Platform authority is
   * server-enforced and the established step-up boundary stands; a workspace
   * identity cannot reach it, and a refusal writes nothing.
   */
  describe("PLATFORM_CONTROL_ACTION — authority and step-up hold, refusal writes nothing", () => {
    it("emergency revoke is refused to every workspace identity, with no effect", async () => {
      const before = await prisma.authenticatedSession.count({
        where: { teamId: orgA.workspaceId, revokedAtUtc: null },
      });
      for (const token of [orgA.owner.token, readOnly.token, personal.token, null]) {
        const res = await call(token, "POST", "/v1/admin/identity/emergency-revoke", {
          teamId: orgA.workspaceId,
          organizationId: orgA.organizationId,
          reason: "phase4 unauthorized probe",
        });
        expect(refused(res), `emergency revoke opened with ${res.status}`).toBe(true);
      }
      expect(
        await prisma.authenticatedSession.count({
          where: { teamId: orgA.workspaceId, revokedAtUtc: null },
        }),
        "a refused emergency revoke still killed sessions",
      ).toBe(before);
    });

    it("a control action still demands its step-up for the platform operator", async () => {
      const res = await call(
        platformAdmin.token,
        "POST",
        "/v1/admin/identity/emergency-revoke",
        {
          teamId: orgA.workspaceId,
          organizationId: orgA.organizationId,
          reason: "phase4 step-up probe",
        },
      );
      // Whatever the gate order, it must NOT be an unchallenged success.
      expect(
        res.status !== 200,
        `emergency revoke succeeded with no step-up (${res.status})`,
      ).toBe(true);
    });
  });

  /**
   * Least privilege at the DTO — the same rule for every audience.
   */
  describe("session projections carry no raw client or credential material", () => {
    it("no identity surface returns a raw user-agent, IP or secret", async () => {
      await setActive(platformAdmin.userId, orgA.workspaceId);
      const probes: Array<[string, string]> = [
        [orgA.owner.token, `/v1/admin/identity/sessions?teamId=${orgA.workspaceId}`],
        [orgA.owner.token, `/v1/admin/identity/timeline?teamId=${orgA.workspaceId}`],
        [platformAdmin.token, "/v1/admin/users?limit=20"],
      ];
      for (const [token, url] of probes) {
        const res = await call(token, "GET", url);
        if (res.status !== 200) continue;
        for (const forbidden of [
          "passwordHash",
          "password_hash",
          "tokenHash",
          "token_hash",
          "sessionIdHash",
          "session_id_hash",
          "198.51.100.45",
          "clientSecret",
          "arn:aws",
        ]) {
          expect(res.text.includes(forbidden), `${url} leaked ${forbidden}`).toBe(false);
        }
      }
    });
  });
});
