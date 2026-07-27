/**
 * WAVE A CHAIN 1 — PRODUCTION-ROUTE behavioral test (fastify inject).
 *
 * Mounts the REAL `identityRoutes` module and drives the REAL
 * POST /v1/identity/members/:id/suspend mutation end-to-end:
 *
 *   authenticated request (requireAuth preHandler)
 *   → tenant-bound resource (membership existence, anti-enumeration 404)
 *   → canonical authorization (evaluateMemberAccess: workspace
 *     classification → org lifecycle → ACTIVE membership → capability)
 *   → step-up gate
 *   → Membership-Orchestrator-subordinated transition engine (suspendMember)
 *   → TeamMember persistence + hash-chained platform audit + session revoke.
 *
 * Only the process boundaries are substituted: db client (recording proxy),
 * JWT verification (auth middleware), step-up challenge transport. Every
 * decision — classification, lifecycle, ACTIVE-membership, capability,
 * OWNER-safety, status-transition legality — executes production code.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const TARGET_MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const TEAM = "33333333-3333-4333-8333-333333333333";

const H = vi.hoisted(() => ({
  actorId: "11111111-1111-4111-8111-111111111111",
  /** Actor's membership row (null → wrong workspace / not a member). */
  actorRow: null as Record<string, unknown> | null,
  /** Target member row for the transition engine. */
  targetRow: null as Record<string, unknown> | null,
  writes: [] as string[],
}));

// Boundary 1 — authentication: token verification is the substituted seam;
// the authenticated principal id is what production code consumes.
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async () => {},
}));
vi.mock("../src/auth.js", () => ({
  getAuthUserId: () => H.actorId,
}));
// Boundary 2 — step-up challenge transport (satisfied).
vi.mock("../src/services/identity-security/step-up-middleware.js", () => ({
  requireStepUpForSensitiveAction: async () => ({ sent: false }),
}));

// Boundary 3 — db: recording proxy. Distinguishes the three production
// teamMember reads by their argument shape.
vi.mock("../src/db.js", () => ({ prisma: fakePrisma() }));
function fakePrisma(): unknown {
  return new Proxy(
    {},
    {
      get(_t, model: string) {
        if (model === "$transaction")
          return async (fn: (tx: unknown) => unknown) => fn(fakePrisma());
        if (model === "$executeRaw" || model === "$executeRawUnsafe")
          return async () => 0;
        if (model === "$queryRaw" || model === "$queryRawUnsafe")
          return async () => [];
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return async (...args: unknown[]) => {
                const a = (args[0] ?? {}) as {
                  where?: Record<string, unknown>;
                  select?: Record<string, unknown>;
                  include?: Record<string, unknown>;
                };
                if (/^(create|update|upsert|delete)/.test(method)) {
                  H.writes.push(`${model}.${method}`);
                }
                if (model === "teamMember") {
                  if (method === "findUnique" && a.select?.id && !a.include) {
                    return H.actorRow ? { id: "tm-actor" } : null; // existence probe
                  }
                  if (method === "findUnique" && a.include) {
                    return H.actorRow; // canonical access snapshot
                  }
                  if (method === "findFirst" && a.where?.id) {
                    return H.targetRow; // transition target load
                  }
                  if (method === "update") {
                    return { ...(H.targetRow ?? {}), status: "SUSPENDED" };
                  }
                }
                if (method === "findFirst" || method === "findUnique") return null;
                if (method === "findMany") return [];
                if (method === "count") return 0;
                if (method === "updateMany" || method === "deleteMany") return { count: 0 };
                if (/^(create|upsert)/.test(method)) return { id: "row-1" };
                return {};
              };
            },
          },
        );
      },
    },
  );
}

import { identityRoutes } from "../src/routes/identity.routes.js";

function actorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "tm-actor",
    teamId: TEAM,
    userId: ACTOR,
    role: "OWNER",
    status: "ACTIVE",
    accessExpiresAtUtc: null,
    team: {
      isPersonal: false,
      workspaceKind: "ORGANIZATION",
      billingPlan: "ENTERPRISE",
      organization: { status: "ACTIVE" },
    },
    capabilityGrants: [],
    delegatedAdminScopes: [],
    ...overrides,
  };
}

function targetRow() {
  return {
    id: TARGET_MEMBER_ID,
    teamId: TEAM,
    userId: "44444444-4444-4444-8444-444444444444",
    role: "MEMBER",
    status: "ACTIVE",
  };
}

let app: FastifyInstance;
beforeEach(async () => {
  H.writes.length = 0;
  H.actorRow = actorRow();
  H.targetRow = targetRow();
  app = Fastify();
  await app.register(identityRoutes);
  await app.ready();
});

async function suspend() {
  return app.inject({
    method: "POST",
    url: `/v1/identity/members/${TARGET_MEMBER_ID}/suspend`,
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    payload: { teamId: TEAM, reason: "chain-1 integration" },
  });
}

const MUTATIONS = /teamMember\.update|teamMember\.delete/;

describe("Wave A CHAIN 1 — real route: auth → context → classification → lifecycle → membership → capability → mutation → audit", () => {
  it("POSITIVE: authorized OWNER suspends an ACTIVE member → 200 + persistence + canonical audit", async () => {
    const res = await suspend();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).member.status).toBe("SUSPENDED");
    expect(H.writes.filter((w) => MUTATIONS.test(w))).toHaveLength(1);
    // Canonical hash-chained audit + security event written by the engine.
    expect(H.writes.join(",")).toMatch(/platformAuditLog\.create|securityEvent\.create/);
  });

  it("wrong Workspace (actor not a member) → 404 with NO existence distinction and ZERO mutation", async () => {
    H.actorRow = null;
    const res = await suspend();
    expect(res.statusCode).toBe(404);
    // Bare anti-enumeration shape — nothing about the target leaks.
    expect(JSON.parse(res.body)).toEqual({ error: { code: "not_found" } });
    expect(H.writes.filter((w) => MUTATIONS.test(w))).toEqual([]);
  });

  it("SUSPENDED actor membership → 403 member_not_active, ZERO mutation", async () => {
    H.actorRow = actorRow({ status: "SUSPENDED" });
    const res = await suspend();
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.reason).toBe("member_not_active");
    expect(H.writes.filter((w) => MUTATIONS.test(w))).toEqual([]);
  });

  it("suspended Organization → 403 organization_not_active (lifecycle gate), ZERO mutation", async () => {
    H.actorRow = actorRow({
      team: {
        isPersonal: false,
        workspaceKind: "ORGANIZATION",
        billingPlan: "ENTERPRISE",
        organization: { status: "SUSPENDED" },
      },
    });
    const res = await suspend();
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.reason).toBe("organization_not_active");
    expect(H.writes.filter((w) => MUTATIONS.test(w))).toEqual([]);
  });

  it("missing capability (VIEWER actor) → 403, ZERO mutation", async () => {
    H.actorRow = actorRow({ role: "VIEWER" });
    const res = await suspend();
    expect(res.statusCode).toBe(403);
    expect(H.writes.filter((w) => MUTATIONS.test(w))).toEqual([]);
  });

  it("engine safety survives subordination: suspending an OWNER target is refused, ZERO mutation", async () => {
    H.targetRow = { ...targetRow(), role: "OWNER" };
    const res = await suspend();
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(H.writes.filter((w) => MUTATIONS.test(w))).toEqual([]);
  });
});
