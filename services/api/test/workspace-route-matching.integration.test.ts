/**
 * ROUTE MATCHING — one bounded test that distinguishes seven failure modes.
 *
 * The workspace operational-health route returned Fastify's global 404 for
 * every request, including a MALFORMED workspace id that should have hit the
 * route's own Zod guard and returned 400. Authorization was already shown to
 * ALLOW the request (`evaluateAuthorize` → `allowed: true`) and the path
 * appeared in `printRoutes()`, so the usual suspects were already excluded.
 *
 * Rather than keep guessing, this asserts on the distinguishable evidence:
 *
 *   1. route not registered          → absent from this instance's printRoutes
 *   2. registered under a prefix     → present, but at a different final URL
 *   3. different Fastify instance    → printRoutes and inject disagree
 *   4. handler entered               → the marker header is present
 *   5. Zod entered                   → malformed id returns the route's 400
 *   6. authorization entered         → non-member gets the handler's 404 body
 *   7. projection entered            → 200 with the workspace envelope
 *
 * The marker is a response header set as the FIRST statement of the handler,
 * before validation. A status code alone cannot separate "handler ran and
 * refused" from "Fastify never found the route" — both are 404.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedPersonalTenant,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

/** Set by the handler before anything else. Absence ⇒ handler never ran. */
const MARKER = "x-proovra-handler";

describe("WORKSPACE ROUTE MATCHING (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];
  let secret: string;
  let deps: FixtureDeps;

  let member: SeededUser;
  let outsider: SeededUser;
  let workspaceId: string;
  let foreignWorkspaceId: string;

  function mint(userId: string, email: string): string {
    return signJwt(
      {
        sub: userId,
        provider: "EMAIL",
        email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
      },
      secret,
      60 * 60,
    );
  }

  async function get(url: string, token?: string) {
    return harness.app.inject({
      method: "GET",
      url,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `wsroute-${Date.now().toString(36)}`,
      mintToken: (userId, email) => mint(userId, email),
    };

    const mine = await seedPersonalTenant(deps, "FREE");
    member = mine.owner;
    workspaceId = mine.personalTeamId;

    const theirs = await seedPersonalTenant(deps, "FREE");
    outsider = theirs.owner;
    foreignWorkspaceId = theirs.personalTeamId;
  });

  // =========================================================================
  // 1-3. Registration and instance identity.
  // =========================================================================

  it("the route is registered on THE SAME instance that serves inject", () => {
    // `printRoutes` renders a nested TREE — the full path never appears on one
    // line — so it cannot answer "is this exact URL registered". `hasRoute`
    // can, and it is asked of the very object `inject` dispatches into, which
    // is what rules out a second Fastify instance.
    for (const url of [
      "/v1/teams/:workspaceId/operations/health",
      "/v1/teams/:workspaceId/operations/alerts",
    ]) {
      expect(
        harness.app.hasRoute({ method: "GET", url }),
        `${url} is not registered on the serving instance`,
      ).toBe(true);
    }

    // And the ALIAS path must NOT be registered directly: `/v1/workspaces` is
    // rewritten to `/v1/teams` by `rewriteUrl` before routing, so a route
    // registered there would appear in printRoutes and never be reachable.
    // That is exactly the defect this suite was written to catch.
    expect(
      harness.app.hasRoute({
        method: "GET",
        url: "/v1/workspaces/:workspaceId/operations/health",
      }),
      "route registered at the alias prefix — it can never be reached",
    ).toBe(false);
  });

  // =========================================================================
  // 4-5. Does execution reach the handler at all?
  // =========================================================================

  it("a MALFORMED workspace id enters the handler and returns the route's own 400", async () => {
    const res = await get("/v1/workspaces/not-a-uuid/operations/health", member.token);

    // The decisive assertion. Fastify's route-miss cannot set this header.
    expect(
      res.headers[MARKER],
      `handler never ran — this is a Fastify route-miss, not a handler refusal. body=${res.body}`,
    ).toBe("workspace-operations-health");

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_WORKSPACE_ID");
  });

  // =========================================================================
  // 6-7. Correct outcomes, for correct and DIFFERENT reasons.
  // =========================================================================

  it("a member reaches the projection and gets the workspace envelope", async () => {
    const res = await get(
      `/v1/workspaces/${workspaceId}/operations/health`,
      member.token,
    );
    expect(res.headers[MARKER]).toBe("workspace-operations-health");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope).toBe("WORKSPACE");
    expect(body.workspaceId).toBe(workspaceId);
  });

  it("a NON-MEMBER is refused BY THE HANDLER, not by a route miss", async () => {
    const res = await get(
      `/v1/workspaces/${foreignWorkspaceId}/operations/health`,
      member.token,
    );
    // Same status as a route miss — so the header is what separates them.
    expect(
      res.headers[MARKER],
      "non-member 404 came from Fastify, not from the membership check",
    ).toBe("workspace-operations-health");
    expect(res.statusCode).toBe(404);
    // The handler's own non-disclosing body, distinguishable from the global
    // canonical NOT_FOUND envelope.
    expect(res.json().error.code).toBe("not_found");
  });

  it("an unknown workspace is refused identically — no existence oracle", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    const missing = await get(
      `/v1/workspaces/${unknown}/operations/health`,
      member.token,
    );
    const foreign = await get(
      `/v1/workspaces/${foreignWorkspaceId}/operations/health`,
      member.token,
    );
    expect(missing.statusCode).toBe(foreign.statusCode);
    expect(missing.json()).toEqual(foreign.json());
  });

  it("the outsider sees their own workspace, and never the other one", async () => {
    const res = await get(
      `/v1/workspaces/${foreignWorkspaceId}/operations/health`,
      outsider.token,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().workspaceId).toBe(foreignWorkspaceId);
    expect(JSON.stringify(res.json())).not.toContain(workspaceId);
  });
});
