/**
 * PHASE 11 — production-entry behavioral tests establishing the authorities as
 * REAL consumers: POST /v1/deep-link/resolve → resolveDeepLink + emitTenantAudit;
 * GET /v1/audit/tenant → authorizeOrFail + queryTenantAudit (scope-pinned).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { JsonRecord } from "./support/prisma-double.js";

const H = vi.hoisted(() => ({
  actorUserId: "u1",
  deepLink: null as unknown,
  audits: [] as JsonRecord[],
  authAllowed: true,
  queryArg: null as JsonRecord | null,
}));

vi.mock("../src/auth.js", () => ({ getAuthUserId: () => H.actorUserId }));
vi.mock("../src/middleware/auth.js", () => ({ requireAuth: async () => {} }));
vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async (_r: unknown, reply: FastifyReply) => {
    if (!H.authAllowed) { reply.code(403).send({ error: { code: "permission_denied" } }); return null; }
    return { actorUserId: H.actorUserId, teamId: "proven-team" };
  },
}));
vi.mock("../src/services/identity/deep-link-resolution.service.js", () => ({
  resolveDeepLink: async () => H.deepLink,
}));
vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: async (e: JsonRecord) => { H.audits.push(e); },
  queryTenantAudit: async (arg: JsonRecord) => { H.queryArg = arg; return { items: [{ eventId: "e1" }], nextCursorId: null }; },
}));

import { phase11TenantRoutes } from "../src/routes/phase11-tenant.routes.js";

let app: FastifyInstance;
beforeEach(async () => {
  H.actorUserId = "u1"; H.deepLink = null; H.audits = []; H.authAllowed = true; H.queryArg = null;
  app = Fastify();
  await app.register(phase11TenantRoutes);
  await app.ready();
});

const RID = "11111111-1111-4111-8111-111111111111";

describe("§2 POST /v1/deep-link/resolve — canonical deep-link consumer", () => {
  it("resolved + authorized → 200 with the PERSISTED-resource workspace + success audit", async () => {
    H.deepLink = { ok: true, actorUserId: "u1", teamId: "team-of-resource", resourceType: "evidence", resourceId: "ev-1" };
    const res = await app.inject({ method: "POST", url: "/v1/deep-link/resolve", headers: { "content-type": "application/json" }, payload: { resourceType: "evidence", resourceId: "ev-1" } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, workspaceId: "team-of-resource" });
    expect(H.audits[0]).toMatchObject({ action: "deep_link.resolve", outcome: "success", workspaceId: "team-of-resource" });
  });

  it("denied (not found / mismatch / unauthorized) → 404 anti-enumeration + denial audit, no workspace leaked", async () => {
    H.deepLink = { ok: false, reason: "context_mismatch", httpStatus: 404 };
    const res = await app.inject({ method: "POST", url: "/v1/deep-link/resolve", headers: { "content-type": "application/json" }, payload: { resourceType: "evidence", resourceId: "ev-1", declaredWorkspaceId: RID } });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: "not_found" } });
    expect(res.body).not.toContain("team");
    expect(H.audits[0]).toMatchObject({ action: "deep_link.resolve", outcome: "denied", denialReason: "context_mismatch" });
  });
});

describe("§4 GET /v1/audit/tenant — authorized, scope-pinned query/export", () => {
  it("authorized → queries the PROVEN workspace scope (never a client-declared tenant)", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/audit/tenant?teamId=${RID}` });
    expect(res.statusCode).toBe(200);
    expect(H.queryArg?.scope).toEqual({ kind: "WORKSPACE", workspaceId: "proven-team" });
    expect(JSON.parse(res.body).items).toHaveLength(1);
  });

  it("unauthorized → canonical deny, NO query executed", async () => {
    H.authAllowed = false;
    const res = await app.inject({ method: "GET", url: `/v1/audit/tenant?teamId=${RID}` });
    expect(res.statusCode).toBe(403);
    expect(H.queryArg).toBeNull();
  });

  it("export shares the exact same authorization + query path", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/audit/tenant?teamId=${RID}&export=true` });
    expect(res.statusCode).toBe(200);
    expect(H.queryArg?.scope).toEqual({ kind: "WORKSPACE", workspaceId: "proven-team" });
  });
});
