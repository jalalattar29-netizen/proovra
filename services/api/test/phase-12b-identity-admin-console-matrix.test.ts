/**
 * PHASE 12B ACCEPTANCE — GROUP A: ADMIN IDENTITY CONSOLE.
 *
 * Behavioral coverage for the 20 operations exposed by
 * `src/routes/admin-identity.routes.ts` (`adminIdentityRoutes` +
 * `adminIdentityRuntimeRoutes`). The REAL route handlers run under fastify
 * `inject`; only process boundaries are substituted: token verification, the
 * canonical `authorizeOrFail` primitive, the access-policy evaluator, the
 * step-up transport, the runtime adaptive gate, the db client, and the
 * canonical domain services the routes DELEGATE to. Those service fakes are
 * TENANT-SCOPED (they only ever see rows of the workspace they were asked for)
 * and record every invocation, so the assertions prove the route→service chain
 * and the concealment/ordering guarantees, not re-implemented service logic.
 *
 * Proof categories, per product system:
 *   1. happy path — status + canonical service called exactly ONCE on the
 *      workspace the route resolved, under the permission it claims to gate on
 *   2. denial — bounded denial body + ZERO service invocation
 *   3. cross-Organization concealment — a foreign target id is byte-identical
 *      to a non-existent one
 *   4. step-up denial — structured 401 with ZERO service invocation
 *   5. bounded conflict / state-machine denial — a real status, never a 404
 *      dressed as "gone", never a silent success, with ZERO state change
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// -----------------------------------------------------------------------------
// Fixtures. (Literals are repeated inside the hoisted mock factories because
// vi.mock hoists above these declarations.)
// -----------------------------------------------------------------------------

const ACTOR = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const OTHER_TEAM = "33333333-3333-4333-8333-333333333333";
const NOWHERE_TEAM = "99999999-9999-4999-8999-99999999990f";

const SUBJECT = "55555555-5555-4555-8555-555555555551";
const FOREIGN_SUBJECT = "55555555-5555-4555-8555-555555555559";
const MISSING_SUBJECT = "55555555-5555-4555-8555-55555555550f";
const CONN = "66666666-6666-4666-8666-666666666661";
const CONN_REVOKED = "66666666-6666-4666-8666-666666666662";
const FOREIGN_CONN = "66666666-6666-4666-8666-666666666669";
const MISSING_CONN = "66666666-6666-4666-8666-66666666660f";
const TOKEN = "77777777-7777-4777-8777-777777777771";
const FOREIGN_TOKEN = "77777777-7777-4777-8777-777777777779";
const MISSING_TOKEN = "77777777-7777-4777-8777-77777777770f";
const SESSION = "88888888-8888-4888-8888-888888888881";
const SESSION_REVOKED = "88888888-8888-4888-8888-888888888882";
const SESSION_QUAR = "88888888-8888-4888-8888-888888888883";
const FOREIGN_SESSION = "88888888-8888-4888-8888-888888888889";
const MISSING_SESSION = "88888888-8888-4888-8888-88888888880f";
const CRON_SECRET = "phase-12b-cron-secret";

// -----------------------------------------------------------------------------
// Hoisted mutable state
// -----------------------------------------------------------------------------

type Call = { fn: string; teamId?: string; args: Record<string, unknown> };
type StepUp = { teamId: string; purpose: string; kind: string; id: string | null };
type Check = { teamId: string; permission: string };

const H = vi.hoisted(() => ({
  actorUserId: "11111111-1111-4111-8111-111111111111",
  /** Verified session present? (the machine reconcile path needs none.) */
  sessionPresent: true,
  /** Actor's membership status in the requested workspace (null = no row). */
  memberStatus: "ACTIVE" as "ACTIVE" | "SUSPENDED" | null,
  policyAllows: true,
  authorizeAllows: true,
  /** Persisted server-derived workspace rail (`User.currentWorkspaceId`). */
  currentWorkspaceId: "22222222-2222-4222-8222-222222222222" as string | null,
  stepUpDenies: false,
  runtimeGateDenies: false,
  /** EVERY canonical-service invocation, in order. */
  calls: [] as Call[],
  /** Only invocations that actually CHANGED state. */
  writes: [] as string[],
  stepUps: [] as StepUp[],
  policyChecks: [] as Check[],
  authorizeChecks: [] as Array<Check & { anti: boolean }>,
  audits: [] as Array<Record<string, unknown>>,
  events: [] as Array<{ id: string; teamId: string; eventType: string; severity: string; createdAt: Date }>,
}));

function rec(fn: string, args: Record<string, unknown>): void {
  H.calls.push({ fn, teamId: args["teamId"] as string | undefined, args });
}
/** Fake-service body: record the invocation, optionally record a state change. */
function R<T>(fn: string, args: Record<string, unknown>, value: T, write?: string): T {
  rec(fn, args);
  if (write) H.writes.push(write);
  return value;
}
const hits = (fn: string): Call[] => H.calls.filter((c) => c.fn === fn);

type Reply = { code: (n: number) => { send: (b: unknown) => void } };

// -----------------------------------------------------------------------------
// Boundary substitutions
// -----------------------------------------------------------------------------

vi.mock("../src/auth.js", () => ({
  getAuthUserId: () => H.actorUserId,
  getAuthSessionId: () => "session-hash",
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (_req: unknown, reply: Reply) => {
    if (!H.sessionPresent) reply.code(401).send({ error: { code: "unauthenticated" } });
  },
}));

// Reproduces the real primitive's denial surface: with `antiEnumeration` a
// denial is a concealed 404, otherwise 403 permission_denied.
vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async (
    _req: unknown,
    reply: Reply,
    o: { teamId: string; permission: string; antiEnumeration?: boolean },
  ) => {
    H.authorizeChecks.push({ teamId: o.teamId, permission: o.permission, anti: o.antiEnumeration === true });
    if (H.authorizeAllows) return { actorUserId: H.actorUserId, teamId: o.teamId };
    if (o.antiEnumeration) reply.code(404).send({ error: { code: "not_found" } });
    else reply.code(403).send({ error: { code: "permission_denied", reason: "forbidden" } });
    return null;
  },
}));

vi.mock("../src/services/identity/access-policy.service.js", () => ({
  evaluateMemberAccess: async (i: { teamId: string; permission: string }) => {
    H.policyChecks.push({ teamId: i.teamId, permission: i.permission });
    return H.policyAllows
      ? { allowed: true, reason: "ROLE_MATRIX", detail: null }
      : { allowed: false, reason: "ROLE_DENIED", detail: null };
  },
}));

vi.mock("../src/services/identity-security/step-up-middleware.js", () => ({
  requireStepUpForSensitiveAction: async (i: {
    teamId: string; purpose: string; resourceKind: string;
    resourceId: string | null; reply: Reply;
  }) => {
    H.stepUps.push({ teamId: i.teamId, purpose: i.purpose, kind: i.resourceKind, id: i.resourceId ?? null });
    if (!H.stepUpDenies) return { sent: false, verifiedChallengeId: "challenge-1" };
    i.reply.code(401).send({ error: { code: "STEP_UP_REQUIRED", purpose: i.purpose } });
    return { sent: true };
  },
}));

vi.mock("../src/services/access-control/adaptive-runtime-gate.service.js", () => ({
  runtimeAdaptiveGate: async (i: { teamId: string; action: string; reply: Reply }) => {
    rec("runtimeAdaptiveGate", { teamId: i.teamId, action: i.action });
    if (!H.runtimeGateDenies) return { allow: true };
    i.reply.code(403).send({ error: { code: "runtime_gate_blocked", action: i.action } });
    return { allow: false, sent: true, decision: "BLOCK" };
  },
}));

vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: async (env: Record<string, unknown>) => { H.audits.push(env); },
}));

// --- SSO ----------------------------------------------------------------------
vi.mock("../src/services/access-control/sso.service.js", () => {
  class SsoServiceError extends Error {
    constructor(public readonly code: string, public readonly details?: Record<string, unknown>) {
      super(code);
      this.name = "SsoServiceError";
    }
  }
  const T = "22222222-2222-4222-8222-222222222222";
  const O = "33333333-3333-4333-8333-333333333333";
  const rows = [
    { id: "66666666-6666-4666-8666-666666666661", teamId: T, status: "ACTIVE" },
    { id: "66666666-6666-4666-8666-666666666662", teamId: T, status: "REVOKED" },
    { id: "66666666-6666-4666-8666-666666666669", teamId: O, status: "ACTIVE" },
  ];
  return {
    SsoServiceError,
    listSsoConnections: async (i: { teamId: string }) =>
      R("listSsoConnections", { teamId: i.teamId }, rows.filter((r) => r.teamId === i.teamId).map((r) => ({ ...r }))),
    createSsoConnection: async (i: Record<string, unknown>) =>
      R("createSsoConnection", i, { id: "new-conn", teamId: i["teamId"], status: "PENDING" }, "createSsoConnection"),
    updateSsoConnectionPolicy: async (i: Record<string, unknown>) =>
      R("updateSsoConnectionPolicy", i, { id: i["id"], samlSpKeyFingerprint: "fp-1" }, "updateSsoConnectionPolicy"),
    transitionSsoConnection: async (i: { teamId: string; id: string; nextStatus: string }) => {
      rec("transitionSsoConnection", { ...i });
      const row = rows.find((r) => r.id === i.id && r.teamId === i.teamId);
      if (!row) throw new SsoServiceError("SSO_CONNECTION_NOT_FOUND");
      // REVOKED is terminal in the shared lifecycle table.
      if (row.status === "REVOKED" && i.nextStatus !== "REVOKED") {
        throw new SsoServiceError("SSO_INVALID_TRANSITION", { from: "REVOKED", to: i.nextStatus });
      }
      H.writes.push("transitionSsoConnection");
      return { id: row.id, status: i.nextStatus };
    },
  };
});

// --- RBAC ---------------------------------------------------------------------
vi.mock("../src/services/access-control/rbac-engine.service.js", () => {
  class RbacEngineError extends Error {
    constructor(public readonly code: string, public readonly details?: Record<string, unknown>) {
      super(code);
      this.name = "RbacEngineError";
    }
  }
  // Only this subject is an ACTIVE member of the workspace under test.
  const MEMBERS = new Set(["55555555-5555-4555-8555-555555555551"]);
  return {
    RbacEngineError,
    buildPermissionSnapshot: async (i: { teamId: string; userId: string }) => {
      rec("buildPermissionSnapshot", { ...i });
      if (!MEMBERS.has(i.userId)) throw new RbacEngineError("RBAC_MEMBER_NOT_FOUND");
      return { teamId: i.teamId, userId: i.userId, permissions: [] };
    },
    computeEffectiveRoleMatrix: () =>
      R("computeEffectiveRoleMatrix", {}, [{ role: "OWNER", permissions: ["identity.org_policy.read"] }]),
    grantTemporaryElevation: async (i: { teamId: string; userId: string; ttlSeconds: number }) => {
      rec("grantTemporaryElevation", { ...i });
      if (!MEMBERS.has(i.userId)) throw new RbacEngineError("RBAC_MEMBER_NOT_FOUND");
      H.writes.push("grantTemporaryElevation");
      return { id: "elev-1", teamId: i.teamId, ttlSeconds: i.ttlSeconds };
    },
  };
});

// --- SCIM ---------------------------------------------------------------------
vi.mock("../src/services/access-control/scim.service.js", () => {
  const rows = [
    { id: "77777777-7777-4777-8777-777777777771", teamId: "22222222-2222-4222-8222-222222222222" },
    { id: "77777777-7777-4777-8777-777777777779", teamId: "33333333-3333-4333-8333-333333333333" },
  ];
  return {
    listScimTokens: async (i: { teamId: string }) =>
      R("listScimTokens", { teamId: i.teamId }, rows.filter((r) => r.teamId === i.teamId).map((r) => ({ ...r }))),
    createScimToken: async (i: Record<string, unknown>) =>
      R("createScimToken", i, { id: "tok-new", secret: "scim_live_xxx" }, "createScimToken"),
    revokeScimToken: async (i: { teamId: string; id: string }) => {
      rec("revokeScimToken", { ...i });
      const row = rows.find((r) => r.id === i.id && r.teamId === i.teamId);
      if (!row) return null;
      H.writes.push("revokeScimToken");
      return { id: row.id, revokedAtUtc: "2026-07-30T00:00:00.000Z" };
    },
  };
});

// --- Sessions -----------------------------------------------------------------
const LOCAL_SESSIONS = [
  "88888888-8888-4888-8888-888888888881",
  "88888888-8888-4888-8888-888888888882",
  "88888888-8888-4888-8888-888888888883",
];

vi.mock("../src/services/access-control/session-inventory.service.js", () => {
  const T = "22222222-2222-4222-8222-222222222222";
  const O = "33333333-3333-4333-8333-333333333333";
  const rows = [
    { id: "88888888-8888-4888-8888-888888888881", teamId: T, revoked: false },
    { id: "88888888-8888-4888-8888-888888888882", teamId: T, revoked: true },
    { id: "88888888-8888-4888-8888-888888888883", teamId: T, revoked: false },
    { id: "88888888-8888-4888-8888-888888888889", teamId: O, revoked: false },
  ];
  return {
    listActiveSessions: async (i: Record<string, unknown>) =>
      R("listActiveSessions", i, rows.filter((r) => r.teamId === i["teamId"]).map((r) => ({ id: r.id, teamId: r.teamId }))),
    revokeAllSessionsForUserAdmin: async (i: Record<string, unknown>) =>
      R("revokeAllSessionsForUserAdmin", i, { revokedCount: 3 }, "revokeAllSessionsForUserAdmin"),
    sweepStaleSessions: async (i: Record<string, unknown>) =>
      R("sweepStaleSessions", i, { scanned: 4, revoked: 1 }, "sweepStaleSessions"),
    refreshHighRiskSessionGauge: async (i: Record<string, unknown>) =>
      R("refreshHighRiskSessionGauge", i, 0),
    revokeActiveSession: async (i: { teamId: string; sessionId: string }) => {
      rec("revokeActiveSession", { ...i });
      const row = rows.find((r) => r.id === i.sessionId && r.teamId === i.teamId);
      if (!row) return { ok: false, reason: "not_found" };
      if (row.revoked) return { ok: false, reason: "already_revoked" };
      H.writes.push("revokeActiveSession");
      return { ok: true, projection: { id: row.id, revoked: true } };
    },
  };
});

vi.mock("../src/services/access-control/suspicious-session.service.js", () => {
  const T = "22222222-2222-4222-8222-222222222222";
  const local = [1, 2, 3].map((n) => `88888888-8888-4888-8888-88888888888${n}`);
  return {
    detectAndScoreSession: async (i: { teamId: string; sessionId: string }) => {
      rec("detectAndScoreSession", { ...i });
      if (i.teamId !== T || !local.includes(i.sessionId)) return null;
      return { sessionId: i.sessionId, riskScore: 42, signals: [] };
    },
  };
});

vi.mock("../src/services/access-control/sso-hardening.service.js", () => ({
  sweepStaleCallbackAttempts: async (i: Record<string, unknown>) =>
    R("sweepStaleCallbackAttempts", i, { expired: 2 }),
}));

vi.mock("../src/services/access-control/session-quarantine.service.js", () => {
  const T = "22222222-2222-4222-8222-222222222222";
  const QUAR = "88888888-8888-4888-8888-888888888883";
  const local = [1, 2, 3].map((n) => `88888888-8888-4888-8888-88888888888${n}`);
  return {
    listQuarantinedSessions: async (i: Record<string, unknown>) =>
      R("listQuarantinedSessions", i, i["teamId"] === T ? [{ sessionId: QUAR, reason: "MANUAL_OPERATOR" }] : []),
    sweepQuarantineReleases: async (i: Record<string, unknown>) =>
      R("sweepQuarantineReleases", i, { released: 1 }, "sweepQuarantineReleases"),
    emergencyOrgRevoke: async (i: Record<string, unknown>) =>
      R("emergencyOrgRevoke", i, { usersRevoked: 2, sessionsAffected: 5 }, "emergencyOrgRevoke"),
    quarantineSession: async (i: { teamId: string; sessionId: string; reason: string }) => {
      rec("quarantineSession", { ...i });
      if (i.teamId !== T || !local.includes(i.sessionId)) return null;
      H.writes.push("quarantineSession");
      return { sessionId: i.sessionId, reason: i.reason, releaseAtUtc: null };
    },
    // Mirrors production: `false` both for "no such session HERE" AND for
    // "session exists but is not quarantined".
    releaseQuarantine: async (i: { teamId: string; sessionId: string }) => {
      rec("releaseQuarantine", { ...i });
      if (i.teamId !== T || i.sessionId !== QUAR) return false;
      H.writes.push("releaseQuarantine");
      return true;
    },
  };
});

vi.mock("../src/services/access-control/runtime-risk.service.js", () => ({
  runtimeRiskRecomputeSweep: async (i: Record<string, unknown>) =>
    R("runtimeRiskRecomputeSweep", i, { recomputed: 7 }, "runtimeRiskRecomputeSweep"),
}));
vi.mock("../src/services/access-control/trusted-device-decay.service.js", () => ({
  sweepTrustedDeviceDecay: async (i: Record<string, unknown>) =>
    R("sweepTrustedDeviceDecay", i, { decayed: 3 }, "sweepTrustedDeviceDecay"),
}));
vi.mock("../src/services/access-control/geo-intelligence.service.js", () => ({
  sweepGeoCache: async () => R("sweepGeoCache", {}, { purged: 1 }),
}));

// --- db -----------------------------------------------------------------------
vi.mock("../src/db.js", () => ({
  prisma: {
    teamMember: {
      // The actor is a member of TEAM only — never of any other workspace.
      findUnique: async (a: { where: { teamId_userId: { teamId: string; userId: string } } }) => {
        const { teamId, userId } = a.where.teamId_userId;
        if (userId !== H.actorUserId) return null;
        if (teamId !== "22222222-2222-4222-8222-222222222222") return null;
        if (H.memberStatus === null) return null;
        return { id: "tm-1", status: H.memberStatus };
      },
    },
    user: { findUnique: async () => ({ currentWorkspaceId: H.currentWorkspaceId }) },
    team: {
      findUnique: async (a: { where: { id: string } }) =>
        a.where.id === "22222222-2222-4222-8222-222222222222"
          ? { organizationId: "44444444-4444-4444-8444-444444444444" }
          : null,
    },
    organizationDomain: { count: async () => 2 },
    securityEvent: {
      findMany: async (a: { where: { teamId: string; eventType?: { in: string[] } }; take: number }) =>
        R(
          "securityEvent.findMany",
          { teamId: a.where.teamId, kinds: a.where.eventType?.in ?? null, take: a.take },
          H.events
            .filter((e) => e.teamId === a.where.teamId)
            .filter((e) => (a.where.eventType ? a.where.eventType.in.includes(e.eventType) : true))
            .slice(0, a.take),
        ),
    },
  },
}));

import {
  adminIdentityRoutes,
  adminIdentityRuntimeRoutes,
} from "../src/routes/admin-identity.routes.js";

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

const JSON_HEADERS = { "content-type": "application/json" };
const savedEnv = {
  a: process.env["IDENTITY_RECONCILE_CRON_SECRET"],
  b: process.env["INTEGRATION_CRON_SECRET"],
};

let app: FastifyInstance;
type Res = { statusCode: number; body: string };

const GET = (url: string): Promise<Res> => app.inject({ method: "GET", url });
const POST = (url: string, payload: Record<string, unknown> = {}): Promise<Res> =>
  app.inject({ method: "POST", url, headers: JSON_HEADERS, payload });
const json = (r: Res): Record<string, unknown> => JSON.parse(r.body) as Record<string, unknown>;

beforeEach(async () => {
  Object.assign(H, {
    actorUserId: ACTOR,
    sessionPresent: true,
    memberStatus: "ACTIVE",
    policyAllows: true,
    authorizeAllows: true,
    currentWorkspaceId: TEAM,
    stepUpDenies: false,
    runtimeGateDenies: false,
  });
  H.calls.length = 0;
  H.writes.length = 0;
  H.stepUps.length = 0;
  H.policyChecks.length = 0;
  H.authorizeChecks.length = 0;
  H.audits.length = 0;
  H.events = [
    { id: "se-1", teamId: TEAM, eventType: "sso_login_success", severity: "INFO", createdAt: new Date("2026-07-01T00:00:00Z") },
    { id: "se-2", teamId: TEAM, eventType: "session_revoked", severity: "WARN", createdAt: new Date("2026-07-02T00:00:00Z") },
    { id: "se-9", teamId: OTHER_TEAM, eventType: "sso_login_success", severity: "INFO", createdAt: new Date("2026-07-03T00:00:00Z") },
  ];
  delete process.env["IDENTITY_RECONCILE_CRON_SECRET"];
  delete process.env["INTEGRATION_CRON_SECRET"];

  app = Fastify();
  await app.register(adminIdentityRoutes);
  await app.register(adminIdentityRuntimeRoutes);
  await app.ready();
});

afterAll(() => {
  for (const [k, v] of [
    ["IDENTITY_RECONCILE_CRON_SECRET", savedEnv.a],
    ["INTEGRATION_CRON_SECRET", savedEnv.b],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// -----------------------------------------------------------------------------
// The operation catalogue — one row per production operation.
//   gate "member"    → requireIdentityAdmin (membership row + access-policy)
//   gate "canonical" → resolveAdminWorkspace (server-derived + authorizeOrFail)
// -----------------------------------------------------------------------------

type Op = {
  name: string;
  method: "GET" | "POST";
  url: string;
  payload?: Record<string, unknown>;
  /** Canonical service the handler must delegate to. */
  service: string;
  /** Permission the handler must gate on. */
  perm: string;
  gate: "member" | "canonical";
  ok: number;
};

const NEW_PROVIDER = {
  teamId: TEAM, provider: "GENERIC_OIDC", displayName: "Corp IdP",
  issuerUrl: "https://idp.example.com", clientId: "client-abc", clientSecret: "super-secret-value",
};
const ELEVATION = { teamId: TEAM, userId: SUBJECT, permission: "identity.member.read", reason: "incident bridge" };

const OPS: Op[] = [
  // providers
  { name: "GET providers", method: "GET", url: `/v1/admin/identity/providers?teamId=${TEAM}`, service: "listSsoConnections", perm: "identity.org_policy.read", gate: "member", ok: 200 },
  { name: "POST providers", method: "POST", url: "/v1/admin/identity/providers", payload: NEW_PROVIDER, service: "createSsoConnection", perm: "identity.external_mapping.manage", gate: "member", ok: 201 },
  { name: "POST providers/:id/transition", method: "POST", url: `/v1/admin/identity/providers/${CONN}/transition`, payload: { teamId: TEAM, nextStatus: "DISABLED" }, service: "transitionSsoConnection", perm: "identity.external_mapping.manage", gate: "member", ok: 200 },
  // permission + role matrix, elevations
  { name: "GET permission-matrix", method: "GET", url: `/v1/admin/identity/permission-matrix?teamId=${TEAM}&subjectUserId=${SUBJECT}`, service: "buildPermissionSnapshot", perm: "identity.member.read", gate: "member", ok: 200 },
  { name: "GET role-matrix", method: "GET", url: `/v1/admin/identity/role-matrix?teamId=${TEAM}`, service: "computeEffectiveRoleMatrix", perm: "identity.org_policy.read", gate: "canonical", ok: 200 },
  { name: "POST elevations", method: "POST", url: "/v1/admin/identity/elevations", payload: ELEVATION, service: "grantTemporaryElevation", perm: "identity.capability.grant", gate: "canonical", ok: 201 },
  // SCIM tokens
  { name: "GET scim/tokens", method: "GET", url: `/v1/admin/identity/scim/tokens?teamId=${TEAM}`, service: "listScimTokens", perm: "identity.external_mapping.read", gate: "member", ok: 200 },
  { name: "POST scim/tokens", method: "POST", url: "/v1/admin/identity/scim/tokens", payload: { teamId: TEAM, name: "Okta provisioning", scopes: ["users.read"] }, service: "createScimToken", perm: "identity.external_mapping.manage", gate: "member", ok: 201 },
  { name: "POST scim/tokens/:id/revoke", method: "POST", url: `/v1/admin/identity/scim/tokens/${TOKEN}/revoke`, payload: { teamId: TEAM, reason: "rotated" }, service: "revokeScimToken", perm: "identity.external_mapping.manage", gate: "member", ok: 200 },
  // sessions + quarantine
  { name: "GET sessions", method: "GET", url: `/v1/admin/identity/sessions?teamId=${TEAM}`, service: "listActiveSessions", perm: "identity.org_policy.read", gate: "member", ok: 200 },
  { name: "POST sessions/:id/revoke", method: "POST", url: `/v1/admin/identity/sessions/${SESSION}/revoke`, payload: { teamId: TEAM, reason: "OPERATOR_REVOKED" }, service: "revokeActiveSession", perm: "identity.contributor_session.revoke", gate: "member", ok: 200 },
  { name: "POST sessions/user/:userId/revoke-all", method: "POST", url: `/v1/admin/identity/sessions/user/${SUBJECT}/revoke-all`, payload: { teamId: TEAM, reason: "MEMBER_SUSPENDED" }, service: "revokeAllSessionsForUserAdmin", perm: "identity.contributor_session.revoke", gate: "member", ok: 200 },
  { name: "GET timeline", method: "GET", url: `/v1/admin/identity/timeline?teamId=${TEAM}`, service: "securityEvent.findMany", perm: "identity.org_policy.read", gate: "member", ok: 200 },
  { name: "POST sessions/:id/score", method: "POST", url: `/v1/admin/identity/sessions/${SESSION}/score`, payload: { teamId: TEAM }, service: "detectAndScoreSession", perm: "identity.org_policy.read", gate: "member", ok: 200 },
  { name: "GET quarantined-sessions", method: "GET", url: `/v1/admin/identity/quarantined-sessions?teamId=${TEAM}`, service: "listQuarantinedSessions", perm: "identity.org_policy.read", gate: "member", ok: 200 },
  { name: "POST sessions/:id/quarantine", method: "POST", url: `/v1/admin/identity/sessions/${SESSION}/quarantine`, payload: { teamId: TEAM, reason: "MANUAL_OPERATOR" }, service: "quarantineSession", perm: "identity.contributor_session.revoke", gate: "member", ok: 200 },
  { name: "POST sessions/:id/release", method: "POST", url: `/v1/admin/identity/sessions/${SESSION_QUAR}/release`, payload: { teamId: TEAM, note: "investigated" }, service: "releaseQuarantine", perm: "identity.contributor_session.revoke", gate: "member", ok: 204 },
  { name: "POST emergency-revoke", method: "POST", url: "/v1/admin/identity/emergency-revoke", payload: { teamId: TEAM, reason: "credential stuffing wave" }, service: "emergencyOrgRevoke", perm: "identity.contributor_session.revoke", gate: "member", ok: 200 },
  // reconcile (dual-mode)
  { name: "POST sessions/reconcile-stale", method: "POST", url: "/v1/admin/identity/sessions/reconcile-stale", payload: { teamId: TEAM }, service: "sweepStaleSessions", perm: "identity.contributor_session.revoke", gate: "canonical", ok: 200 },
  { name: "POST runtime/reconcile", method: "POST", url: "/v1/admin/identity/runtime/reconcile", payload: { teamId: TEAM }, service: "runtimeRiskRecomputeSweep", perm: "identity.contributor_session.revoke", gate: "canonical", ok: 200 },
];

const op = (name: string): Op => {
  const found = OPS.find((o) => o.name === name);
  if (!found) throw new Error(`unknown operation ${name}`);
  return found;
};
const run = (o: Op): Promise<Res> =>
  o.method === "GET" ? GET(o.url) : POST(o.url, o.payload ?? {});
const table = (rows: Op[] = OPS) => rows.map((o) => [o.name, o] as const);

// =============================================================================
// PROOF 1 — authorized happy path (all 20 operations)
// =============================================================================

describe("PROOF 1 — authorized happy path delegates to the canonical service", () => {
  it.each(table())(
    "%s → canonical service called exactly once on the resolved workspace",
    async (_n, o) => {
      const res = await run(o);
      expect(res.statusCode).toBe(o.ok);

      const h = hits(o.service);
      expect(h).toHaveLength(1);
      // The workspace the service acted on is the one the route resolved and
      // authorized — never a second, different id.
      if (h[0].teamId !== undefined) expect(h[0].teamId).toBe(TEAM);

      // The gate the route actually ran, and the permission it claimed.
      if (o.gate === "member") {
        expect(H.policyChecks).toEqual([{ teamId: TEAM, permission: o.perm }]);
        expect(H.authorizeChecks).toEqual([]);
      } else {
        expect(H.authorizeChecks).toEqual([{ teamId: TEAM, permission: o.perm, anti: true }]);
        expect(H.policyChecks).toEqual([]);
      }
    },
  );

  it("GET providers also projects the owning Organization's verified-domain count", async () => {
    const body = json(await run(op("GET providers")));
    const providers = body["providers"] as Array<{ id: string }>;
    expect(providers.map((p) => p.id)).toEqual([CONN, CONN_REVOKED]);
    expect(body["verifiedDomainCount"]).toBe(2);
  });

  it("GET timeline projects ONLY the authorized workspace's events, honouring the kinds filter", async () => {
    const res = await GET(`/v1/admin/identity/timeline?teamId=${TEAM}&kinds=session_revoked,%20&limit=50`);
    expect(res.statusCode).toBe(200);
    const events = json(res)["events"] as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "se-2", kind: "session_revoked", summary: "Session Revoked" });
    // Scoped to the authorized workspace; blank kinds tokens dropped rather
    // than turned into an empty-string filter.
    expect(hits("securityEvent.findMany")[0].args).toMatchObject({
      teamId: TEAM, kinds: ["session_revoked"], take: 50,
    });
  });

  it("POST sessions/:id/revoke returns the projection and carries the operator reason", async () => {
    const res = await run(op("POST sessions/:id/revoke"));
    expect(json(res)["projection"]).toMatchObject({ id: SESSION, revoked: true });
    expect(hits("revokeActiveSession")[0].args).toMatchObject({
      sessionId: SESSION, actorUserId: ACTOR, reason: "OPERATOR_REVOKED",
    });
  });

  it("POST elevations honours the platform TTL bound and writes into the DERIVED workspace", async () => {
    const res = await POST("/v1/admin/identity/elevations", { ...ELEVATION, ttlSeconds: 4 * 3600 });
    expect(res.statusCode).toBe(201);
    expect(hits("grantTemporaryElevation")[0].args).toMatchObject({
      teamId: TEAM, grantedByUserId: ACTOR, ttlSeconds: 4 * 3600,
    });
  });
});

// =============================================================================
// PROOF 2 — denial with ZERO canonical-service work (all 20 operations)
// =============================================================================

describe("PROOF 2 — denial is bounded and performs ZERO canonical-service work", () => {
  it.each(table())("%s — non-member actor → concealed 404, service NOT called", async (_n, o) => {
    H.memberStatus = null; // requireIdentityAdmin path
    H.currentWorkspaceId = null; // resolveAdminWorkspace path
    const res = await run(o);
    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ error: { code: "not_found" } });
    expect(hits(o.service)).toEqual([]);
    expect(H.writes).toEqual([]);
  });

  it.each(table())(
    "%s — member WITHOUT the required permission → bounded denial, service NOT called",
    async (_n, o) => {
      H.policyAllows = false;
      H.authorizeAllows = false;
      const res = await run(o);
      const body = json(res);
      if (o.gate === "member") {
        // requireIdentityAdmin surfaces the reason to an established member.
        expect(res.statusCode).toBe(403);
        expect(body).toMatchObject({ error: { code: "permission_denied", reason: "ROLE_DENIED" } });
      } else {
        // The canonical primitive conceals under anti-enumeration.
        expect(res.statusCode).toBe(404);
        expect(body).toEqual({ error: { code: "not_found" } });
      }
      expect(hits(o.service)).toEqual([]);
      expect(H.writes).toEqual([]);
    },
  );

  it.each(table(OPS.filter((o) => o.gate === "member")))(
    "%s — SUSPENDED membership → 403 member_inactive, service NOT called",
    async (_n, o) => {
      H.memberStatus = "SUSPENDED";
      const res = await run(o);
      expect(res.statusCode).toBe(403);
      expect(json(res)).toEqual({ error: { code: "member_inactive" } });
      expect(hits(o.service)).toEqual([]);
      expect(H.writes).toEqual([]);
    },
  );
});

// =============================================================================
// PROOF 3 — cross-Organization concealment, once per product system
// =============================================================================

describe("PROOF 3 — cross-Organization target is indistinguishable from non-existent", () => {
  const pairs: Array<[system: string, probe: (id: string) => Promise<Res>, foreign: string, missing: string]> = [
    [
      "providers — SSO connection owned by another Organization",
      (id) => POST(`/v1/admin/identity/providers/${id}/transition`, { teamId: TEAM, nextStatus: "DISABLED" }),
      FOREIGN_CONN, MISSING_CONN,
    ],
    [
      "matrix — subject user who belongs to another Organization",
      (id) => GET(`/v1/admin/identity/permission-matrix?teamId=${TEAM}&subjectUserId=${id}`),
      FOREIGN_SUBJECT, MISSING_SUBJECT,
    ],
    [
      "scim — provisioning token owned by another Organization",
      (id) => POST(`/v1/admin/identity/scim/tokens/${id}/revoke`, { teamId: TEAM }),
      FOREIGN_TOKEN, MISSING_TOKEN,
    ],
    [
      "sessions — session owned by another Organization",
      (id) => POST(`/v1/admin/identity/sessions/${id}/revoke`, { teamId: TEAM }),
      FOREIGN_SESSION, MISSING_SESSION,
    ],
    [
      "reconcile — a workspace the operator does not occupy",
      (id) => POST("/v1/admin/identity/runtime/reconcile", { teamId: id }),
      OTHER_TEAM, NOWHERE_TEAM,
    ],
  ];

  it.each(pairs)(
    "%s → same status AND same body as a non-existent id, ZERO mutation",
    async (_system, probe, foreign, missing) => {
      const a = await probe(foreign);
      const b = await probe(missing);
      expect(a.statusCode).toBe(404);
      expect(b.statusCode).toBe(404);
      expect(a.body).toBe(b.body);
      expect(H.writes).toEqual([]);
    },
  );

  it("the elevation GRANT conceals a subject from another Organization the same way", async () => {
    const foreign = await POST("/v1/admin/identity/elevations", { ...ELEVATION, userId: FOREIGN_SUBJECT });
    const missing = await POST("/v1/admin/identity/elevations", { ...ELEVATION, userId: MISSING_SUBJECT });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toBe(missing.body);
    expect(H.writes).toEqual([]);
  });

  it("the SSO provider and SCIM token LISTS leak no other Organization's rows", async () => {
    const providers = (json(await run(op("GET providers")))["providers"] as Array<{ id: string }>).map((p) => p.id);
    expect(providers).not.toContain(FOREIGN_CONN);
    const tokens = (json(await run(op("GET scim/tokens")))["tokens"] as Array<{ id: string }>).map((t) => t.id);
    expect(tokens).toEqual([TOKEN]);
    const sessions = (json(await run(op("GET sessions")))["sessions"] as Array<{ id: string }>).map((s) => s.id);
    expect(sessions).toEqual(LOCAL_SESSIONS);
  });

  it("a client-declared workspace can never override the server-derived one", async () => {
    // The operator IS authorized somewhere (currentWorkspaceId = TEAM) but
    // declares OTHER_TEAM. The route rejects instead of switching scope.
    const res = await GET(`/v1/admin/identity/role-matrix?teamId=${OTHER_TEAM}`);
    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ error: { code: "not_found" } });
    // The authorization primitive was never even consulted for OTHER_TEAM.
    expect(H.authorizeChecks).toEqual([]);
    expect(hits("computeEffectiveRoleMatrix")).toEqual([]);
  });

  it("role-matrix echoes the SERVER-derived workspace when the client declares none", async () => {
    const res = await GET("/v1/admin/identity/role-matrix");
    expect(res.statusCode).toBe(200);
    expect(json(res)["teamId"]).toBe(TEAM);
  });
});

// =============================================================================
// PROOF 4 — step-up gating with ZERO mutation on denial.
// Rows derived from the route source; each pins the PURPOSE and the RESOURCE
// the challenge is bound to, so a gate silently rebound to a weaker purpose
// fails here.
// =============================================================================

const STEP_UP: Array<[name: string, purpose: string, kind: string, id: string | null]> = [
  ["POST providers", "EXTERNAL_IDENTITY_LINK", "sso_connection", null],
  ["POST scim/tokens", "EXTERNAL_IDENTITY_LINK", "scim_token", null],
  ["POST scim/tokens/:id/revoke", "EXTERNAL_IDENTITY_UNLINK", "SCIM_TOKEN", TOKEN],
  ["POST sessions/user/:userId/revoke-all", "CONTRIBUTOR_SESSION_REVOKE", "user", SUBJECT],
  ["POST elevations", "CAPABILITY_GRANT", "temporary_elevation", SUBJECT],
  ["POST emergency-revoke", "ORG_SECURITY_POLICY_UPDATE", "team", TEAM],
  ["POST sessions/reconcile-stale", "ORG_SECURITY_POLICY_UPDATE", "team", TEAM],
  ["POST runtime/reconcile", "ORG_SECURITY_POLICY_UPDATE", "team", TEAM],
];

describe("PROOF 4 — step-up gating on the sensitive mutations", () => {
  it.each(STEP_UP)(
    "%s — challenge bound to the authorized workspace, purpose and resource",
    async (name, purpose, kind, id) => {
      const o = op(name);
      const res = await run(o);
      expect(res.statusCode).toBe(o.ok);
      expect(H.stepUps).toEqual([{ teamId: TEAM, purpose, kind, id }]);
    },
  );

  it.each(STEP_UP)("%s — step-up denial → 401 STEP_UP_REQUIRED, ZERO mutation", async (name) => {
    H.stepUpDenies = true;
    const o = op(name);
    const res = await run(o);
    expect(res.statusCode).toBe(401);
    expect(json(res)).toMatchObject({ error: { code: "STEP_UP_REQUIRED" } });
    expect(hits(o.service)).toEqual([]);
    expect(H.writes).toEqual([]);
  });

  it("SSO transition to REVOKED is step-up gated; a reversible transition is not", async () => {
    const revoke = await POST(`/v1/admin/identity/providers/${CONN}/transition`, { teamId: TEAM, nextStatus: "REVOKED" });
    expect(revoke.statusCode).toBe(200);
    expect(H.stepUps).toEqual([
      { teamId: TEAM, purpose: "EXTERNAL_IDENTITY_UNLINK", kind: "sso_connection", id: CONN },
    ]);
    H.stepUps.length = 0;
    const disable = await POST(`/v1/admin/identity/providers/${CONN}/transition`, { teamId: TEAM, nextStatus: "DISABLED" });
    expect(disable.statusCode).toBe(200);
    expect(H.stepUps).toEqual([]);
  });

  it("SSO transition to REVOKED with step-up denied → 401, connection NOT transitioned", async () => {
    H.stepUpDenies = true;
    const res = await POST(`/v1/admin/identity/providers/${CONN}/transition`, { teamId: TEAM, nextStatus: "REVOKED" });
    expect(res.statusCode).toBe(401);
    expect(hits("transitionSsoConnection")).toEqual([]);
    expect(H.writes).toEqual([]);
  });

  it("the runtime adaptive gate fails CLOSED before step-up and before the write", async () => {
    H.runtimeGateDenies = true;
    const gated: Array<[string, string]> = [
      ["POST providers", "SSO_CONNECTION_CREATE"],
      ["POST scim/tokens", "SCIM_TOKEN_CREATE"],
      ["POST elevations", "RBAC_TEMPORARY_ELEVATION"],
      ["POST sessions/:id/quarantine", "MEMBER_SUSPEND"],
    ];
    for (const [name, action] of gated) {
      H.calls.length = 0;
      H.writes.length = 0;
      H.stepUps.length = 0;
      const o = op(name);
      const res = await run(o);
      expect(res.statusCode).toBe(403);
      expect(json(res)["error"]).toMatchObject({ code: "runtime_gate_blocked", action });
      expect(hits(o.service)).toEqual([]);
      expect(H.stepUps).toEqual([]);
      expect(H.writes).toEqual([]);
    }
  });
});

// =============================================================================
// PROOF 5 — bounded conflict / state-machine denials with ZERO state change
// =============================================================================

describe("PROOF 5 — bounded conflicts: never a 404-as-gone, never a silent success", () => {
  it("re-revoking an already-revoked session → 409 session_already_revoked, ZERO re-write", async () => {
    const res = await POST(`/v1/admin/identity/sessions/${SESSION_REVOKED}/revoke`, { teamId: TEAM });
    expect(res.statusCode).toBe(409);
    expect(json(res)).toEqual({ error: { code: "session_already_revoked" } });
    // The canonical service WAS consulted (that is how live state is read) but
    // performed no second revocation, so the audit trail cannot be
    // re-attributed to the second caller.
    expect(hits("revokeActiveSession")).toHaveLength(1);
    expect(H.writes).toEqual([]);
  });

  it("the already-revoked 409 is DISTINCT from the concealed 404 of an unknown session", async () => {
    const conflict = await POST(`/v1/admin/identity/sessions/${SESSION_REVOKED}/revoke`, { teamId: TEAM });
    const unknown = await POST(`/v1/admin/identity/sessions/${MISSING_SESSION}/revoke`, { teamId: TEAM });
    expect(conflict.statusCode).toBe(409);
    expect(unknown.statusCode).toBe(404);
    expect(conflict.body).not.toBe(unknown.body);
  });

  it("releasing a session that is NOT quarantined → 404, never a silent 204", async () => {
    const res = await POST(`/v1/admin/identity/sessions/${SESSION}/release`, { teamId: TEAM });
    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ error: { code: "not_found" } });
    expect(H.writes).toEqual([]);
  });

  it("quarantine → release is the sanctioned state machine (200 then 204)", async () => {
    const q = await POST(`/v1/admin/identity/sessions/${SESSION_QUAR}/quarantine`, {
      teamId: TEAM, reason: "SUSPICIOUS_ADMIN_ACTIVITY", releaseHours: 6,
    });
    expect(q.statusCode).toBe(200);
    expect(json(q)["quarantine"]).toMatchObject({
      sessionId: SESSION_QUAR, reason: "SUSPICIOUS_ADMIN_ACTIVITY",
    });
    const r = await POST(`/v1/admin/identity/sessions/${SESSION_QUAR}/release`, { teamId: TEAM });
    expect(r.statusCode).toBe(204);
    expect(r.body).toBe("");
    expect(H.writes).toEqual(["quarantineSession", "releaseQuarantine"]);
  });

  it("an invalid SSO lifecycle transition is a bounded 400, not a 404 and not a success", async () => {
    // REVOKED is terminal; reactivating it is refused with the invariant named.
    const res = await POST(`/v1/admin/identity/providers/${CONN_REVOKED}/transition`, {
      teamId: TEAM, nextStatus: "ACTIVE",
    });
    expect(res.statusCode).toBe(400);
    expect(json(res)).toEqual({
      error: { code: "SSO_INVALID_TRANSITION", details: { from: "REVOKED", to: "ACTIVE" } },
    });
    expect(H.writes).toEqual([]);
  });

  it("a malformed provider-create body is a 400 validation_error with ZERO service work", async () => {
    // OIDC provider with no issuer / client credentials.
    const res = await POST("/v1/admin/identity/providers", {
      teamId: TEAM, provider: "GENERIC_OIDC", displayName: "x",
    });
    expect(res.statusCode).toBe(400);
    expect((json(res)["error"] as Record<string, unknown>)["code"]).toBe("validation_error");
    expect(hits("createSsoConnection")).toEqual([]);
    // Validation precedes authorization, so no permission decision was spent.
    expect(H.policyChecks).toEqual([]);
  });

  it("a malformed elevation body is a 400 validation_error with ZERO grant", async () => {
    const res = await POST("/v1/admin/identity/elevations", { teamId: TEAM, userId: SUBJECT, permission: "x" });
    expect(res.statusCode).toBe(400);
    expect((json(res)["error"] as Record<string, unknown>)["code"]).toBe("validation_error");
    expect(hits("grantTemporaryElevation")).toEqual([]);
  });

  it("scoring a session that does not exist here → 404, no fabricated score", async () => {
    const res = await POST(`/v1/admin/identity/sessions/${MISSING_SESSION}/score`, { teamId: TEAM });
    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ error: { code: "not_found" } });
  });
});

// =============================================================================
// RECONCILE — the dual-mode entrypoints, proven mode by mode
// =============================================================================

const RECONCILES = [
  ["sessions/reconcile-stale", "/v1/admin/identity/sessions/reconcile-stale", "sweepStaleSessions", "identity.sessions.reconcile_stale"],
  ["runtime/reconcile", "/v1/admin/identity/runtime/reconcile", "runtimeRiskRecomputeSweep", "identity.runtime.reconcile"],
] as const;

describe("RECONCILE — dual-mode entrypoints (machine vs operator)", () => {
  const cronHeaders = { ...JSON_HEADERS, "x-cron-secret": CRON_SECRET };

  it.each(RECONCILES)(
    "%s — MACHINE mode: shared secret, NO session, no step-up, no operator audit",
    async (_n, url, primary) => {
      process.env["IDENTITY_RECONCILE_CRON_SECRET"] = CRON_SECRET;
      H.sessionPresent = false; // a session-authenticated request would 401 here
      const res: Res = await app.inject({ method: "POST", url, headers: cronHeaders, payload: { teamId: OTHER_TEAM } });
      expect(res.statusCode).toBe(200);
      // The scheduler names the workspace it was configured for.
      expect(json(res)["teamId"]).toBe(OTHER_TEAM);
      expect(hits(primary)).toHaveLength(1);
      expect(H.stepUps).toEqual([]);
      expect(H.authorizeChecks).toEqual([]);
      expect(H.audits).toEqual([]);
    },
  );

  it.each(RECONCILES)("%s — MACHINE mode without a workspace → 400, ZERO sweep", async (_n, url, primary) => {
    process.env["IDENTITY_RECONCILE_CRON_SECRET"] = CRON_SECRET;
    const res: Res = await app.inject({ method: "POST", url, headers: cronHeaders, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(json(res)).toEqual({ error: { code: "validation_error" } });
    expect(hits(primary)).toEqual([]);
    expect(H.writes).toEqual([]);
  });

  it.each(RECONCILES)(
    "%s — a WRONG shared secret is not a machine and must present a session",
    async (_n, url, primary) => {
      process.env["IDENTITY_RECONCILE_CRON_SECRET"] = CRON_SECRET;
      H.sessionPresent = false;
      const res: Res = await app.inject({
        method: "POST", url,
        headers: { ...JSON_HEADERS, "x-cron-secret": "not-the-secret" },
        payload: { teamId: OTHER_TEAM },
      });
      expect(res.statusCode).toBe(401);
      expect(json(res)).toEqual({ error: { code: "unauthenticated" } });
      expect(hits(primary)).toEqual([]);
      expect(H.writes).toEqual([]);
    },
  );

  it.each(RECONCILES)(
    "%s — OPERATOR mode: server-derived workspace + canonical authorization + audited outcome",
    async (_n, url, primary, action) => {
      const res = await POST(url, {});
      expect(res.statusCode).toBe(200);
      expect(json(res)["teamId"]).toBe(TEAM);
      expect(H.authorizeChecks).toEqual([
        { teamId: TEAM, permission: "identity.contributor_session.revoke", anti: true },
      ]);
      expect(hits(primary)).toHaveLength(1);
      expect(hits(primary)[0].teamId).toBe(TEAM);
      // Exactly one operator audit entry, naming the actor and the workspace.
      expect(H.audits).toHaveLength(1);
      expect(H.audits[0]).toMatchObject({
        action, outcome: "success", actorUserId: ACTOR, workspaceId: TEAM, resourceId: TEAM,
      });
      expect((H.audits[0]["metadata"] as Record<string, unknown>)["trigger"]).toBe("operator");
    },
  );

  it("runtime/reconcile runs the full sweep set for the derived workspace only", async () => {
    const res = await POST("/v1/admin/identity/runtime/reconcile", {
      recomputeWindowMinutes: 30, decayStaleDays: 14,
    });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({
      risk: { recomputed: 7 }, decay: { decayed: 3 },
      releases: { released: 1 }, geo: { purged: 1 }, teamId: TEAM,
    });
    for (const fn of ["runtimeRiskRecomputeSweep", "sweepTrustedDeviceDecay", "sweepQuarantineReleases"]) {
      expect(hits(fn)).toHaveLength(1);
      expect(hits(fn)[0].teamId).toBe(TEAM);
    }
    expect(hits("runtimeRiskRecomputeSweep")[0].args).toMatchObject({ recomputeWindowMinutes: 30 });
    expect(hits("sweepTrustedDeviceDecay")[0].args).toMatchObject({ staleDays: 14 });
  });

  it("sessions/reconcile-stale also sweeps callback attempts and refreshes the risk gauge", async () => {
    const res = await POST("/v1/admin/identity/sessions/reconcile-stale", { staleMinutes: 45, batchSize: 25 });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({
      sessions: { scanned: 4, revoked: 1 }, callbackAttempts: { expired: 2 }, teamId: TEAM,
    });
    expect(hits("sweepStaleSessions")[0].args).toMatchObject({
      teamId: TEAM, staleMinutes: 45, batchSize: 25, revoke: true,
    });
    expect(hits("refreshHighRiskSessionGauge")).toHaveLength(1);
  });

  it("an audit-sink failure never masks a committed operator sweep", async () => {
    const audit = await import("../src/services/audit/tenant-audit.service.js");
    const spy = vi.spyOn(audit, "emitTenantAudit").mockRejectedValueOnce(new Error("audit sink down"));
    const res = await POST("/v1/admin/identity/runtime/reconcile", {});
    expect(res.statusCode).toBe(200);
    expect(hits("runtimeRiskRecomputeSweep")).toHaveLength(1);
    spy.mockRestore();
  });
});

// =============================================================================
// STRUCTURAL (non-behavioral, clearly labelled) — the one invariant that cannot
// be expressed as a request/response behaviour: the catalogue above must stay
// in lockstep with the operations the console actually registers.
// =============================================================================

describe("STRUCTURAL — catalogue completeness (non-behavioral guard)", () => {
  it("every registered admin-identity operation appears in the behavioral catalogue", async () => {
    const registered: string[] = [];
    const probe = Fastify();
    probe.addHook("onRoute", (r) => {
      for (const m of Array.isArray(r.method) ? r.method : [r.method]) {
        if (m !== "HEAD" && m !== "OPTIONS") registered.push(`${m} ${r.url}`);
      }
    });
    await probe.register(adminIdentityRoutes);
    await probe.register(adminIdentityRuntimeRoutes);
    await probe.ready();

    const covered = new Set(
      OPS.map((o) =>
        `${o.method} ${(o.url.split("?")[0] as string)
          .replace(CONN, ":id")
          .replace(TOKEN, ":id")
          .replace(SESSION_QUAR, ":id")
          .replace(SESSION, ":id")
          .replace(SUBJECT, ":userId")}`,
      ),
    );
    // `/providers/:id/policy` belongs to the Enterprise SAML SP-key track and
    // is covered by that track's suite, not this console matrix.
    const outOfScope = new Set(["POST /v1/admin/identity/providers/:id/policy"]);
    expect(registered.filter((r) => !covered.has(r) && !outOfScope.has(r))).toEqual([]);
    await probe.close();
  });
});
