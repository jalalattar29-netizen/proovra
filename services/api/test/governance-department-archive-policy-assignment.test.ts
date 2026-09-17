/**
 * Batch J — two governance mutations wired to operator surfaces.
 *
 *   POST /v1/governance/departments/:id/archive
 *     The audit helper was handed actorUserId "system". The audit row's actor
 *     column is a uuid, so the insert failed inside the helper's catch and the
 *     archive left NO DEPARTMENT_ARCHIVED record. The route now passes the
 *     operator and the service awaits the write.
 *
 *   POST /v1/governance/policies/:id/assignments
 *     The route handed any policy id and any target straight to an upsert.
 *     It now refuses a policy outside the caller's workspace and a target the
 *     effective resolver would never read (not this workspace's Organization,
 *     not one of its departments, not the workspace itself).
 *
 * Real route + real department service; auth, workspace resolution, prisma,
 * and the governance-policy service are the mocked boundaries.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.hoisted(() => {
  process.env.S3_ACCESS_KEY ??= "test-access";
  process.env.S3_SECRET_KEY ??= "test-secret";
  process.env.S3_REGION ??= "eu-central-1";
});

const H = vi.hoisted(() => ({
  actor: "11111111-1111-4111-8111-111111111111",
  team: "22222222-2222-4222-8222-222222222222",
  org: "33333333-3333-4333-8333-333333333333",
  dept: "44444444-4444-4444-8444-444444444444",
  policy: "55555555-5555-4555-8555-555555555555",
  departmentState: "ACTIVE" as "ACTIVE" | "ARCHIVED" | null,
  departmentUpdates: [] as unknown[],
  auditRows: [] as Array<Record<string, unknown>>,
  policyInTeam: true,
  assignCalls: [] as unknown[],
}));

vi.mock("../src/auth.js", () => ({ getAuthUserId: () => H.actor }));
vi.mock("../src/middleware/auth.js", () => ({ requireAuth: async () => {} }));
vi.mock("../src/middleware/require-delegated-tier.js", () => ({
  requireDelegatedTier: () => async () => {},
  requireDelegatedTierAny: () => async () => {},
}));
vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async () => ({ actorUserId: H.actor, teamId: H.team }),
  requireAuthorize: () => async () => {},
  evaluateCurrentWorkspace: async () => ({
    allowed: true,
    context: { workspaceId: H.team, userId: H.actor },
  }),
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    user: { findUnique: async () => ({ currentWorkspaceId: H.team }) },
    team: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === H.team ? { id: H.team, organizationId: H.org } : null,
    },
    department: {
      findFirst: async ({ where }: { where: { id: string; teamId: string } }) =>
        where.id === H.dept && where.teamId === H.team && H.departmentState
          ? { id: H.dept, state: H.departmentState }
          : null,
      update: async (args: unknown) => {
        H.departmentUpdates.push(args);
        H.departmentState = "ARCHIVED";
        return {};
      },
    },
    governancePolicy: {
      findFirst: async ({ where }: { where: { id: string; teamId: string } }) =>
        H.policyInTeam && where.id === H.policy && where.teamId === H.team
          ? { id: H.policy }
          : null,
    },
    intelligenceActivityEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        // The real column is `@db.Uuid`: a non-uuid actor fails the insert.
        if (
          data.actorUserId !== null &&
          !/^[0-9a-f-]{36}$/i.test(String(data.actorUserId))
        ) {
          throw new Error("invalid input syntax for type uuid");
        }
        H.auditRows.push(data);
        return { id: "audit-1" };
      },
    },
  },
}));

vi.mock("../src/services/governance/governance-policy.service.js", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    assignPolicy: async (input: unknown) => {
      H.assignCalls.push(input);
      return { ok: true, assignmentId: "assignment-1" };
    },
  };
});

import { trustAndGovernanceRoutes } from "../src/routes/trust-and-governance.routes.js";

let app: FastifyInstance;

beforeEach(async () => {
  H.departmentState = "ACTIVE";
  H.departmentUpdates.length = 0;
  H.auditRows.length = 0;
  H.policyInTeam = true;
  H.assignCalls.length = 0;
  app = Fastify();
  await app.register(trustAndGovernanceRoutes);
  await app.ready();
});

describe("POST /v1/governance/departments/:id/archive", () => {
  it("archives and records DEPARTMENT_ARCHIVED against the operator", async () => {
    const res = await app.inject({ method: "POST", url: `/v1/governance/departments/${H.dept}/archive` });
    expect(res.statusCode).toBe(200);
    expect(H.departmentUpdates).toHaveLength(1);
    expect(H.auditRows).toEqual([
      expect.objectContaining({
        code: "DEPARTMENT_ARCHIVED",
        actorUserId: H.actor,
        targetType: "DEPARTMENT",
        targetId: H.dept,
        teamId: H.team,
      }),
    ]);
  });

  it("is idempotent and writes nothing for an already archived department", async () => {
    H.departmentState = "ARCHIVED";
    const res = await app.inject({ method: "POST", url: `/v1/governance/departments/${H.dept}/archive` });
    expect(res.statusCode).toBe(200);
    expect(H.departmentUpdates).toHaveLength(0);
    expect(H.auditRows).toHaveLength(0);
  });

  it("answers 404 for a department outside the workspace and writes nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/governance/departments/66666666-6666-4666-8666-666666666666/archive",
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ denial: "NOT_FOUND" });
    expect(H.departmentUpdates).toHaveLength(0);
    expect(H.auditRows).toHaveLength(0);
  });
});

describe("POST /v1/governance/policies/:id/assignments", () => {
  const url = () => `/v1/governance/policies/${H.policy}/assignments`;

  it.each([
    ["ORGANIZATION", () => H.org],
    ["DEPARTMENT", () => H.dept],
    ["WORKSPACE", () => H.team],
  ] as const)("assigns at %s scope with the operator as assigner", async (scope, target) => {
    const res = await app.inject({
      method: "POST",
      url: url(),
      payload: { scope, scopeTargetId: target(), inheritFromParent: false, isOverride: true },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ assignmentId: "assignment-1" });
    expect(H.assignCalls).toEqual([
      expect.objectContaining({
        teamId: H.team,
        policyId: H.policy,
        scope,
        scopeTargetId: target(),
        inheritFromParent: false,
        isOverride: true,
        assignedByUserId: H.actor,
      }),
    ]);
  });

  it("refuses a policy that is not in the caller's workspace", async () => {
    H.policyInTeam = false;
    const res = await app.inject({
      method: "POST",
      url: url(),
      payload: { scope: "WORKSPACE", scopeTargetId: H.team },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ denial: "NOT_FOUND" });
    expect(H.assignCalls).toHaveLength(0);
  });

  it.each([
    ["ORGANIZATION", "77777777-7777-4777-8777-777777777777"],
    ["DEPARTMENT", "77777777-7777-4777-8777-777777777777"],
    ["WORKSPACE", "77777777-7777-4777-8777-777777777777"],
  ] as const)("refuses a foreign %s target", async (scope, target) => {
    const res = await app.inject({
      method: "POST",
      url: url(),
      payload: { scope, scopeTargetId: target },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ denial: "SCOPE_TARGET_NOT_FOUND" });
    expect(H.assignCalls).toHaveLength(0);
  });
});
