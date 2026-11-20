/**
 * WS-REL / RG-22 (DEC-20) — "Unknown security context fails closed with a
 * retryable infrastructure response, not an authorization success or a
 * permanent denial."
 *
 *   NEW-RG-22-4  reviewer-workspace.routes.ts `resolveTeam` (every
 *                /v1/reviewer/* route) answered an evaluator outage (503) or
 *                an unauthenticated context (401) as 403.
 *   NEW-RG-22-5  trust-and-governance.routes.ts `resolveWorkspace` (every
 *                /v1/trust/* and /v1/governance/* route resolving the current
 *                workspace) did the same.
 *   NEW-RG-22-6  ai.routes.ts `resolveAiCommercialScope` silently fell back to
 *                the caller's PERSONAL scope, policy and ledger when the
 *                workspace evaluation was unavailable.
 *
 * Real route plugins via fastify `inject`; only the process boundaries are
 * mocked. The canonical evaluator is replaced by a seam returning the outcome
 * under test, while `sendDenyResponse` (the canonical answer) stays real.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.S3_ACCESS_KEY ??= "test-access";
  process.env.S3_SECRET_KEY ??= "test-secret";
  process.env.S3_REGION ??= "eu-central-1";
});

const USER = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";

const H = vi.hoisted(() => ({
  outcome: { allowed: true } as Record<string, unknown>,
  calls: [] as string[],
}));

vi.mock("../src/middleware/authorize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/middleware/authorize.js")>();
  return {
    ...actual,
    evaluateCurrentWorkspace: async () => H.outcome,
    evaluateAuthorizedWorkspace: async () => H.outcome,
  };
});
vi.mock("../src/auth.js", () => ({ getAuthUserId: () => USER }));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { sub: USER };
  },
}));
vi.mock("../src/middleware/require-legal-acceptance.js", () => ({
  requireLegalAcceptance: async () => {},
}));
vi.mock("../src/middleware/require-workspace-permission.js", () => ({
  requireWorkspacePermission: () => async () => {},
}));
vi.mock("../src/services/rate-limit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/rate-limit.js")>()),
  enforceRateLimit: async () => ({ allowed: true, remaining: 10, resetAtMs: Date.now() + 60_000 }),
}));
vi.mock("../src/services/ai/ai-rate-limit.service.js", () => ({
  enforceAiEndpointGuard: async () => ({ allowed: true }),
}));
vi.mock("../src/services/billing/commercial-context.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/billing/commercial-context.service.js")>()),
  resolveCommercialContext: async (subject: { type: string }) => {
    H.calls.push(`resolveCommercialContext:${subject.type}`);
    throw new Error("must not resolve a commercial scope during an authorization outage");
  },
}));
vi.mock("../src/services/ai/workspace-ai-policy.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/ai/workspace-ai-policy.service.js")>()),
  evaluateWorkspaceAiPolicy: async () => {
    H.calls.push("evaluateWorkspaceAiPolicy");
    throw new Error("must not evaluate a policy during an authorization outage");
  },
}));
vi.mock("../src/services/ai/ai-usage-ledger.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/ai/ai-usage-ledger.service.js")>()),
  tryReserveAiBudget: async () => {
    H.calls.push("tryReserveAiBudget");
    throw new Error("must not reserve AI budget during an authorization outage");
  },
}));
vi.mock("../src/services/billing-enforcement.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/billing-enforcement.service.js")>()),
  assertWorkspaceAllowsAiOperation: async () => {
    H.calls.push("assertWorkspaceAllowsAiOperation");
  },
  evaluateWorkspaceAiOperation: async () => {
    H.calls.push("evaluateWorkspaceAiOperation");
    return { denial: null };
  },
  reserveWorkspaceAiOperation: async () => {
    H.calls.push("reserveWorkspaceAiOperation");
  },
  workspaceIncludesReviewCapability: async () => true,
}));
vi.mock("../src/db.js", () => ({
  prisma: {
    user: {
      findUnique: async () => ({ platformRole: "USER" }),
    },
    team: {
      findFirst: async () => {
        H.calls.push("team.findFirst(personal)");
        return { id: "personal-team" };
      },
    },
  },
}));

import { aiRoutes } from "../src/routes/ai.routes.js";
import { reviewerWorkspaceRoutes } from "../src/routes/reviewer-workspace.routes.js";
import { trustAndGovernanceRoutes } from "../src/routes/trust-and-governance.routes.js";

async function build(plugin: (app: FastifyInstance) => Promise<void>): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(plugin);
  await app.ready();
  return app;
}

const OUTAGE = { allowed: false, reasonCode: "authorization_unavailable", httpStatus: 503 };
const UNAUTH = { allowed: false, reasonCode: "missing_actor", httpStatus: 401 };
const DENIED = { allowed: false, reasonCode: "permission_denied", httpStatus: 403 };
const NO_WORKSPACE = { allowed: false, reasonCode: "missing_team_id", httpStatus: 403 };

beforeEach(() => {
  H.calls = [];
});

describe("NEW-RG-22-4 reviewer workspace resolveTeam keeps the canonical outcome", () => {
  it("evaluator outage (503) → 503 authorization_unavailable, not 403", async () => {
    H.outcome = OUTAGE;
    const app = await build(reviewerWorkspaceRoutes);
    for (const url of ["/v1/reviewer/workspace", `/v1/reviewer/workspace?teamId=${TEAM}`, "/v1/reviewer/metrics"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(503);
      expect(res.json(), url).toMatchObject({ error: { code: "authorization_unavailable" } });
    }
  });

  it("unauthenticated context (401) → 401 unauthenticated, not 403", async () => {
    H.outcome = UNAUTH;
    const res = await (await build(reviewerWorkspaceRoutes)).inject({ method: "GET", url: "/v1/reviewer/workspace" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("a real denial is still the bounded 403 envelope (unchanged)", async () => {
    const app = await build(reviewerWorkspaceRoutes);
    H.outcome = DENIED;
    const denied = await app.inject({ method: "GET", url: "/v1/reviewer/workspace" });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ denial: "NOT_PERMITTED" });
    H.outcome = NO_WORKSPACE;
    const none = await app.inject({ method: "GET", url: "/v1/reviewer/workspace" });
    expect(none.statusCode).toBe(403);
    expect(none.json()).toEqual({ denial: "WORKSPACE_NOT_FOUND" });
  });
});

describe("NEW-RG-22-5 trust/governance resolveWorkspace keeps the canonical outcome", () => {
  it("evaluator outage (503) → 503 authorization_unavailable, not 403 WORKSPACE_NOT_FOUND", async () => {
    H.outcome = OUTAGE;
    const app = await build(trustAndGovernanceRoutes);
    for (const url of ["/v1/trust/articles", "/v1/trust/subprocessors"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(503);
      expect(res.json(), url).toMatchObject({ error: { code: "authorization_unavailable" } });
    }
  });

  it("unauthenticated context (401) → 401 unauthenticated", async () => {
    H.outcome = UNAUTH;
    const res = await (await build(trustAndGovernanceRoutes)).inject({ method: "GET", url: "/v1/trust/articles" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("a real denial is still 403 WORKSPACE_NOT_FOUND (unchanged)", async () => {
    H.outcome = DENIED;
    const res = await (await build(trustAndGovernanceRoutes)).inject({ method: "GET", url: "/v1/trust/articles" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ denial: "WORKSPACE_NOT_FOUND" });
  });
});

describe("NEW-RG-22-6 the AI scope resolver never falls back to the personal scope on an outage", () => {
  it("GET /v1/ai/availability → 503, no personal scope, policy or allowance read", async () => {
    H.outcome = OUTAGE;
    const res = await (await build(aiRoutes)).inject({ method: "GET", url: "/v1/ai/availability" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "authorization_unavailable" } });
    expect(H.calls).toEqual([]);
  });

  it("POST /v1/ai/chat → 503 before any personal ledger, reservation or charge", async () => {
    H.outcome = OUTAGE;
    const res = await (await build(aiRoutes)).inject({
      method: "POST",
      url: "/v1/ai/chat",
      payload: { messages: [{ role: "user", content: "How do I export a report?" }] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "authorization_unavailable" } });
    expect(H.calls).toEqual([]);
  });

  it("a real 'no usable workspace' outcome still uses the personal account (unchanged fallback)", async () => {
    H.outcome = NO_WORKSPACE;
    const res = await (await build(aiRoutes)).inject({ method: "GET", url: "/v1/ai/availability" });
    // The personal fallback is taken (the seam then throws, so the request errors).
    expect(H.calls).toContain("resolveCommercialContext:PERSONAL_ACCOUNT");
    expect(res.statusCode).toBe(500);
  });
});
