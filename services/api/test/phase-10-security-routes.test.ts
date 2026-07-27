/**
 * PHASE 10 §10.4/§10.6/§10.8 — PRODUCTION-ROUTE tests (fastify inject) through
 * the real `enterpriseSecurityRoutes` handlers: authorization + step-up +
 * canonical-service calls. Only auth/step-up/db process boundaries are mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const H = vi.hoisted(() => ({
  actorUserId: "admin-1",
  authAllowed: true,
  stepUpSent: false,
  readiness: {
    hasActiveSsoConnection: true, ssoConnectionTested: true, hasVerifiedDomain: true,
    hasBreakGlassReadiness: true, unresolvedPersonalCustodyUserIds: [] as string[], contractActive: true,
  },
  writes: [] as string[],
  // §10.6 emergency-operate + §10.8 support-runtime consumption seams.
  emergencyAllow: true,
  emergencyReason: "forbidden_action" as string,
  emergencyAction: "" as string,
  supportContext: null as null | { grantId: string; supportActorUserId: string; organizationId: string; teamId: string | null; mode: string; reason: string; expiresAtUtc: string },
  supportContextReason: "no_grant" as string,
  supportAllow: true,
  supportDenyReason: "support_read_only" as string,
  supportActionSeen: "" as string,
}));

vi.mock("../src/auth.js", () => ({ getAuthUserId: () => H.actorUserId }));
vi.mock("../src/middleware/auth.js", () => ({ requireAuth: async () => {} }));
vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    if (!H.authAllowed) { reply.code(403).send({ error: { code: "permission_denied" } }); return null; }
    return { actorUserId: H.actorUserId, teamId: "ws-1" };
  },
}));
vi.mock("../src/services/identity-security/step-up-middleware.js", () => ({
  requireStepUpForSensitiveAction: async (input: { reply: { code: (n: number) => { send: (b: unknown) => void } } }) => {
    if (H.stepUpSent) { input.reply.code(401).send({ error: { code: "STEP_UP_REQUIRED" } }); return { sent: true }; }
    return { sent: false, verifiedChallengeId: "verified-chal-1" };
  },
}));
// Canonical services — assert the routes CALL them (behavioral), not re-impl.
vi.mock("../src/services/identity/org-security-policy.service.js", () => ({
  resolveSecurityPolicy: async () => ({ teamId: "ws-1", policyVersion: 1, ssoRequired: false }),
  applySecurityPolicyPatch: async (i: { patch: Record<string, unknown> }) => { H.writes.push("applySecurityPolicyPatch"); return { teamId: "ws-1", policyVersion: 2, ...i.patch }; },
  assembleHighSecurityReadiness: async () => H.readiness,
  activateHighSecurityMode: async () => {
    H.writes.push("activateHighSecurityMode");
    const { evaluateHighSecurityActivation } = await import("../src/services/identity/enterprise-security-policy.policy.js");
    const v = evaluateHighSecurityActivation(H.readiness);
    return v.ok ? { ok: true, policy: { securityMode: "HIGH_SECURITY", policyVersion: 2 }, affectedSessionUserCount: 3 } : { ok: false, missing: (v as { missing: string[] }).missing };
  },
}));
vi.mock("../src/services/identity/break-glass.service.js", () => ({
  activateBreakGlass: async (i: { reason: string; stepUpProofId: string }) => {
    H.writes.push("activateBreakGlass");
    if (!i.stepUpProofId) { const e = new Error("no proof") as Error & { statusCode: number; code: string }; e.statusCode = 403; e.code = "BREAK_GLASS_STEP_UP_REQUIRED"; throw e; }
    return { id: "eag-1", grantedRole: "EMERGENCY_READ_ONLY", expiresAtUtc: new Date(Date.now() + 3600_000) };
  },
  revokeBreakGlass: async () => { H.writes.push("revokeBreakGlass"); },
  // The ONE emergency authority — the real overlay (authorize-emergency.ts) runs
  // and defers its entire decision here. We record the action it was evaluated
  // against so the route→overlay→authority chain is proven, not stubbed away.
  evaluateEmergencyAccess: async (_grantId: string, ctx: { actorUserId: string; organizationId: string; action: string }) => {
    H.emergencyAction = ctx.action;
    return H.emergencyAllow
      ? { allowed: true, actorUserId: ctx.actorUserId, organizationId: ctx.organizationId, capability: "operate" }
      : { allowed: false, reason: H.emergencyReason };
  },
}));
// Downstream containment operation — assert it runs ONLY on emergency allow.
vi.mock("../src/services/access-control/session-quarantine.service.js", () => ({
  emergencyOrgRevoke: async () => { H.writes.push("emergencyOrgRevoke"); return { usersRevoked: 2, sessionsAffected: 5 }; },
}));
// Support runtime authority — the route composes resolve + per-request guard.
vi.mock("../src/services/identity/support-runtime.service.js", () => ({
  resolveSupportRuntimeContext: async () => (H.supportContext ? { context: H.supportContext } : { context: null, reason: H.supportContextReason }),
  authorizeSupportAction: async (i: { action: string }) => { H.supportActionSeen = i.action; return H.supportAllow ? { allowed: true } : { allowed: false, reason: H.supportDenyReason }; },
}));
vi.mock("../src/services/identity/support-access.service.js", () => ({
  startSupportAccess: async (i: { accessLevel?: string; approvedByUserId?: string | null }) => {
    H.writes.push("startSupportAccess");
    if (i.accessLevel === "ELEVATED" && !i.approvedByUserId) { const e = new Error("approval") as Error & { statusCode: number; code: string }; e.statusCode = 403; e.code = "SUPPORT_APPROVAL_REQUIRED"; throw e; }
    return { id: "sag-1", accessLevel: i.accessLevel ?? "READ_ONLY", expiresAtUtc: new Date(Date.now() + 3600_000) };
  },
  revokeSupportAccess: async () => { H.writes.push("revokeSupportAccess"); },
}));

import { enterpriseSecurityRoutes } from "../src/routes/enterprise-security.routes.js";

const TEAM = "33333333-3333-4333-8333-333333333333";
const ORG = "44444444-4444-4444-8444-444444444444";
const EMG = "55555555-5555-4555-8555-555555555555";

let app: FastifyInstance;
beforeEach(async () => {
  H.authAllowed = true; H.stepUpSent = false; H.writes.length = 0;
  H.emergencyAllow = true; H.emergencyReason = "forbidden_action"; H.emergencyAction = "";
  H.supportContext = { grantId: "sag-1", supportActorUserId: "support-1", organizationId: ORG, teamId: null, mode: "READ_ONLY", reason: "ticket", expiresAtUtc: new Date(Date.now() + 3600_000).toISOString() };
  H.supportContextReason = "no_grant"; H.supportAllow = true; H.supportDenyReason = "support_read_only"; H.supportActionSeen = "";
  H.readiness = { hasActiveSsoConnection: true, ssoConnectionTested: true, hasVerifiedDomain: true, hasBreakGlassReadiness: true, unresolvedPersonalCustodyUserIds: [], contractActive: true };
  app = Fastify();
  await app.register(enterpriseSecurityRoutes);
  await app.ready();
});

const stepUpHeaders = { "content-type": "application/json", "x-proovra-step-up-challenge-id": "chal-1" };

describe("§10.1/§10.7 — PATCH security policy (authorized + step-up)", () => {
  it("authorized manager with step-up patches the versioned policy", async () => {
    const res = await app.inject({ method: "PATCH", url: "/v1/security-policy", headers: stepUpHeaders, payload: { teamId: TEAM, ssoRequired: true, maxSessionAgeSeconds: 3600 } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).policy.policyVersion).toBe(2);
    expect(H.writes).toContain("applySecurityPolicyPatch");
  });
  it("missing step-up → 401, ZERO policy write", async () => {
    H.stepUpSent = true;
    const res = await app.inject({ method: "PATCH", url: "/v1/security-policy", headers: { "content-type": "application/json" }, payload: { teamId: TEAM, ssoRequired: true } });
    expect(res.statusCode).toBe(401);
    expect(H.writes).toEqual([]);
  });
  it("unauthorized → 403, ZERO write", async () => {
    H.authAllowed = false;
    const res = await app.inject({ method: "PATCH", url: "/v1/security-policy", headers: stepUpHeaders, payload: { teamId: TEAM, ssoRequired: true } });
    expect(res.statusCode).toBe(403);
    expect(H.writes).toEqual([]);
  });
});

describe("§10.4 — high-security atomic activation route", () => {
  it("all prerequisites met → activates HIGH_SECURITY + reports affected sessions", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/security-policy/high-security/activate", headers: stepUpHeaders, payload: { teamId: TEAM } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.policy.securityMode).toBe("HIGH_SECURITY");
    expect(body.affectedSessionUserCount).toBe(3);
  });
  it("a missing prerequisite → 409, exact missing reasons, ZERO activation", async () => {
    H.readiness.hasVerifiedDomain = false;
    H.readiness.unresolvedPersonalCustodyUserIds = ["u1"];
    const res = await app.inject({ method: "POST", url: "/v1/security-policy/high-security/activate", headers: stepUpHeaders, payload: { teamId: TEAM } });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("HIGH_SECURITY_PREREQUISITES_UNMET");
    expect(body.error.missing).toEqual(expect.arrayContaining(["verified_domain", "unresolved_personal_custody"]));
  });
});

describe("§10.6 — break-glass route", () => {
  it("activate with step-up proof → grant returned", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/break-glass/activate", headers: stepUpHeaders, payload: { teamId: TEAM, organizationId: ORG, emergencyUserId: EMG, reason: "SSO provider outage recovery" } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).grant.grantedRole).toBe("EMERGENCY_READ_ONLY");
    expect(H.writes).toContain("activateBreakGlass");
  });
});

describe("§10.8 — support-access route (dual identity, read-only default)", () => {
  it("start records the support ACTOR and defaults READ_ONLY", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/support-access/start", headers: { "content-type": "application/json" }, payload: { teamId: TEAM, organizationId: ORG, reason: "investigate support ticket" } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).grant.accessLevel).toBe("READ_ONLY");
  });
  it("ELEVATED without approval → 403", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/support-access/start", headers: { "content-type": "application/json" }, payload: { teamId: TEAM, organizationId: ORG, reason: "investigate support ticket", accessLevel: "ELEVATED" } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("SUPPORT_APPROVAL_REQUIRED");
  });
});

// The GRANT the emergency-operate route consumes (uuid; the mocked authority
// records the action it is evaluated against).
const GRANT = "66666666-6666-4666-8666-666666666666";

describe("§10.6 Step 4 — break-glass EMERGENCY OPERATE (route CONSUMES a grant via the overlay)", () => {
  const emgPayload = { teamId: TEAM, organizationId: ORG, grantId: GRANT, stepUpProofId: "verified-chal-1", reason: "contain compromised sessions" };

  it("valid grant + allowlisted action → overlay allows → canonical revoke runs (viaEmergency)", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/break-glass/emergency/sessions/revoke", headers: { "content-type": "application/json" }, payload: emgPayload });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.viaEmergency).toBe(true);
    expect(body.usersRevoked).toBe(2);
    // The overlay was evaluated against the RESTRICTED operator action string.
    expect(H.emergencyAction).toBe("session.revoke");
    // The containment op ran ONLY after the overlay allowed.
    expect(H.writes).toContain("emergencyOrgRevoke");
  });

  it("overlay denial (forbidden/expired/revoked) → 403 break_glass_denied, ZERO operation", async () => {
    H.emergencyAllow = false; H.emergencyReason = "grant_expired";
    const res = await app.inject({ method: "POST", url: "/v1/break-glass/emergency/sessions/revoke", headers: { "content-type": "application/json" }, payload: emgPayload });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatchObject({ code: "break_glass_denied", reason: "grant_expired" });
    // Fail closed: the canonical containment op was NEVER reached.
    expect(H.writes).not.toContain("emergencyOrgRevoke");
  });

  it("schema/infra unavailability → 503 (fail-closed retry posture), ZERO operation", async () => {
    H.emergencyAllow = false; H.emergencyReason = "schema_unavailable";
    const res = await app.inject({ method: "POST", url: "/v1/break-glass/emergency/sessions/revoke", headers: { "content-type": "application/json" }, payload: emgPayload });
    expect(res.statusCode).toBe(503);
    expect(H.writes).not.toContain("emergencyOrgRevoke");
  });
});

// §10.8 Step 5 — support enforcement is now server-side on the canonical
// authorization path (evaluateAuthorize → applySupportAccessGuard). Its
// behavioral coverage lives in phase-10-support-enforcement.test.ts; the former
// client-called `/authorize-action` oracle was removed so enforcement is never
// delegated to the client.
