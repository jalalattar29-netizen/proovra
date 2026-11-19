/**
 * WS-REL / PRO-BL2-06 — requireWorkspacePermission must not report an
 * authorization outage as a permanent permission denial.
 *
 * The canonical authority (authorize.ts sendDenyResponse) maps 503 / 401 / 404
 * / 403 distinctly. The pre-handler collapsed every non-allowed outcome to
 * 403 PERMISSION_REQUIRED, so a retryable evaluator failure looked permanent.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  outcome: { allowed: true } as Record<string, unknown>,
  trustEvents: 0,
}));

vi.mock("../src/middleware/authorize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/middleware/authorize.js")>();
  return {
    ...actual,
    evaluateCurrentWorkspace: async () => H.outcome,
  };
});
vi.mock("../src/auth.js", () => ({ getAuthUserId: () => "user-1" }));
vi.mock("../src/services/trust/trust-and-governance-audit.service.js", () => ({
  emitTrustEvent: async () => {
    H.trustEvents += 1;
  },
}));

import { requireWorkspacePermission } from "../src/middleware/require-workspace-permission.js";

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  app.get("/guarded", { preHandler: requireWorkspacePermission("governance.policy.read" as never) }, async () => ({
    ok: true,
  }));
  await app.ready();
  return app;
}

beforeEach(() => {
  H.trustEvents = 0;
});

describe("PRO-BL2-06 requireWorkspacePermission keeps the canonical outcome", () => {
  it("allowed → handler", async () => {
    H.outcome = { allowed: true, context: { workspaceId: "w", userId: "user-1" } };
    const res = await (await build()).inject({ method: "GET", url: "/guarded" });
    expect(res.statusCode).toBe(200);
  });

  it("evaluator outage (503) → 503 authorization_unavailable, not 403 PERMISSION_REQUIRED", async () => {
    H.outcome = { allowed: false, reasonCode: "authorization_unavailable", httpStatus: 503 };
    const res = await (await build()).inject({ method: "GET", url: "/guarded" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "authorization_unavailable" } });
    expect(H.trustEvents).toBe(0);
  });

  it("real permission denial → 403 PERMISSION_REQUIRED (unchanged)", async () => {
    H.outcome = { allowed: false, reasonCode: "permission_denied", httpStatus: 403 };
    const res = await (await build()).inject({ method: "GET", url: "/guarded" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ denial: "PERMISSION_REQUIRED" });
  });
});
