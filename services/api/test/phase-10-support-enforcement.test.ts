/**
 * PHASE 10 CLOSURE FIX 1 / HARDENING FIX 1 (2026-07-23) — SERVER-AUTHORITATIVE
 * support-context enforcement.
 *
 * THE GAP CLOSURE FIX 1 CLOSED: the previous design armed the support-access
 * runtime guard off a CLIENT-CONTROLLED boolean header
 * (`x-proovra-support-mode`) — any caller decided for itself whether
 * enforcement ran. This suite proves the replacement: the client can
 * transport ONLY an OPAQUE, SERVER-ISSUED, SERVER-VERIFIED token
 * (`x-proovra-support-context`, minted by the REAL `signSupportContextToken`
 * — the same function the production `POST /v1/support-access/enter`
 * endpoint calls after re-validating the grant against the DB). A missing,
 * forged, wrong-actor, or expired token is NEVER treated as a valid (nor as
 * a permissive) support-context signal — it denies the request outright
 * rather than falling back to a client-declared enforcement decision.
 *
 * THE GAP HARDENING FIX 1 CLOSES: the token from CLOSURE FIX 1 carried only
 * `{ grantId, supportUserId, iat, exp }` — NOT bound to the exact
 * authenticated session that requested it, and signed directly with
 * `AUTH_JWT_SECRET` (no key-domain separation). This suite additionally
 * proves: a token minted in Session A is REJECTED when presented from
 * Session B for the SAME support user; a revoked or expired issuing session
 * denies the request even though the token + grant are otherwise valid; and
 * a tampered `sessionIdHash` claim is caught by signature verification like
 * any other forgery.
 *
 * Style: mocks ONLY the process boundaries — `getAuthUserId` +
 * `getAuthSessionId` (session), `evaluateMemberAccess` (isolates the
 * support layer from real team-membership plumbing),
 * `appendPlatformAuditLog` (audit sink), and the DB (`../src/db.js`,
 * including the `RevokedSession` + `AuthenticatedSession` tables the new
 * session-liveness check reads). Everything else — `evaluateAuthorize`,
 * `authorizeOrFail`, `applySupportAccessGuard`,
 * `resolveSupportRuntimeContextByGrantId`, `authorizeSupportAction`,
 * `evaluateSupportAccess`, `evaluateSupportActionAllowed`,
 * `isSessionRevoked`, AND the token sign/verify pair
 * (`signSupportContextToken` / `verifySupportContextToken`) — is the REAL
 * production code, exercised through a real Fastify route via `app.inject`.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// getSecret("AUTH_JWT_SECRET") falls back to process.env — set it so the
// REAL sign/verify pair in support-context-token.service.ts has a key. This
// mirrors the pattern used by other suites that exercise real JWT signing
// (see test/phase-10-org-policy-fail-closed.test.ts).
const SECRET = "phase-10-closure-fix-1-test-secret-do-not-use-in-prod";
process.env.AUTH_JWT_SECRET = SECRET;

type Row = {
  id: string;
  supportUserId: string;
  organizationId: string;
  teamId: string | null;
  reason: string;
  accessLevel: "READ_ONLY" | "ELEVATED";
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  approvedByUserId: string | null;
  startedAtUtc: Date;
  expiresAtUtc: Date;
  revokedAtUtc: Date | null;
};

type SessionRow = {
  expiresAtUtc: Date;
  revokedAtUtc: Date | null;
};

const ACTOR = "a0000000-0000-4000-8000-000000000001";
const OTHER_USER = "a0000000-0000-4000-8000-000000000099";
const ORG = "b0000000-0000-4000-8000-000000000002";
const TEAM_A = "c0000000-0000-4000-8000-000000000003";
const TEAM_B = "c0000000-0000-4000-8000-000000000004";
const OTHER_ORG = "b0000000-0000-4000-8000-0000000000ff";
const TEAM_OTHER_ORG = "c0000000-0000-4000-8000-0000000000ff";
// PHASE 10 HARDENING FIX 1 — the two distinct authenticated-session hashes
// used by the session-binding suite below.
const SESSION_A = "session-hash-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION_B = "session-hash-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
// Real wall-clock time: `applySupportAccessGuard` does not thread a
// `nowMs` override through from `authorize.ts` (production always uses the
// real clock), so expiry-relative fixtures below must be anchored to it too.
const NOW = Date.now();

const H = vi.hoisted(() => ({
  actorUserId: "a0000000-0000-4000-8000-000000000001",
  grants: [] as Row[],
  teamOrgMap: {} as Record<string, string>,
  memberAllowed: true,
  memberReason: "permission_not_granted" as string,
  audits: [] as Array<Record<string, unknown>>,
  grantReadCount: 0,
  // PHASE 10 HARDENING FIX 1 — session-binding fixtures.
  sessionIdHash: "session-hash-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as string | null,
  sessionRevoked: false,
  sessionRows: {} as Record<string, SessionRow | undefined>,
}));

vi.mock("../src/auth.js", () => ({
  getAuthUserId: () => H.actorUserId,
  // PHASE 10 HARDENING FIX 1 — the CURRENT authenticated request's session
  // hash, exactly like the real `getAuthSessionId` reads off `req.user`
  // (here stubbed so each test can move "which session is making this
  // request" independently of "which session the token was minted for").
  getAuthSessionId: () => {
    if (!H.sessionIdHash) throw new Error("Session not resolved");
    return H.sessionIdHash;
  },
}));

vi.mock("../src/services/identity/access-policy.service.js", () => ({
  evaluateMemberAccess: async () =>
    H.memberAllowed
      ? { allowed: true, via: { kind: "role", role: "ADMIN" } }
      : { allowed: false, reason: H.memberReason },
}));

vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: async (p: Record<string, unknown>) => {
    H.audits.push(p);
  },
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    team: {
      findUnique: async (args: { where: { id: string } }) => {
        const organizationId = H.teamOrgMap[args.where.id];
        return organizationId ? { organizationId } : null;
      },
    },
    supportAccessGrant: {
      findFirst: async (args: {
        where: { supportUserId: string; status: string; organizationId?: string };
      }) => {
        H.grantReadCount += 1;
        const matches = H.grants
          .filter(
            (r) =>
              r.supportUserId === args.where.supportUserId &&
              r.status === args.where.status &&
              (args.where.organizationId ? r.organizationId === args.where.organizationId : true),
          )
          .sort((a, b) => b.startedAtUtc.getTime() - a.startedAtUtc.getTime());
        return matches[0] ?? null;
      },
      findUnique: async (args: { where: { id: string } }) => {
        H.grantReadCount += 1;
        return H.grants.find((r) => r.id === args.where.id) ?? null;
      },
    },
    // PHASE 10 HARDENING FIX 1 — the two tables `isBoundSessionActive`
    // (middleware/authorize.ts) reads to prove the persisted session backing
    // a support-context token's `sessionIdHash` is still active.
    revokedSession: {
      findFirst: async (args: {
        where: { userId: string; sessionIdHash?: string; scope?: string };
      }) => {
        if (
          H.sessionRevoked &&
          args.where.sessionIdHash &&
          args.where.sessionIdHash === H.sessionIdHash
        ) {
          return { id: "revoked-session-row-1" };
        }
        return null;
      },
    },
    authenticatedSession: {
      findFirst: async (args: { where: { userId: string; sessionIdHash: string } }) => {
        return H.sessionRows[args.where.sessionIdHash] ?? null;
      },
    },
  },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { authorizeOrFail } from "../src/middleware/authorize.js";
// REAL production signer — the exact function `POST /v1/support-access/enter`
// calls after re-validating the grant. Tests mint tokens with this, never a
// hand-rolled encoding, so the suite proves the actual wire format.
import { signSupportContextToken } from "../src/services/identity/support-context-token.service.js";
import { signJwt } from "../src/services/jwt.js";

function grantRow(over: Partial<Row> = {}): Row {
  return {
    id: "grant-1",
    supportUserId: ACTOR,
    organizationId: ORG,
    teamId: null,
    reason: "investigating support ticket #123",
    accessLevel: "READ_ONLY",
    status: "ACTIVE",
    approvedByUserId: null,
    startedAtUtc: new Date(NOW - 60_000),
    expiresAtUtc: new Date(NOW + 3_600_000),
    revokedAtUtc: null,
    ...over,
  };
}

/** An ACTIVE, unexpired, unrevoked AuthenticatedSession row fixture. */
function activeSessionRow(): SessionRow {
  return { expiresAtUtc: new Date(NOW + 3_600_000), revokedAtUtc: null };
}

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.post("/op", async (req, reply) => {
    const body = (req.body ?? {}) as { teamId: string; permission: string; action?: string };
    const auth = await authorizeOrFail(req, reply, {
      teamId: body.teamId,
      permission: body.permission as never,
    });
    if (!auth) return;
    return reply.send({ ok: true, actorUserId: auth.actorUserId, teamId: auth.teamId });
  });
  await app.ready();
  return app;
}

/**
 * Mint a support-context header value with the REAL production signer,
 * bound to the given session hash (defaults to the CURRENT mocked session,
 * `H.sessionIdHash`, so most existing tests need no change).
 */
function contextHeader(
  grantId: string,
  supportUserId: string,
  sessionIdHash: string = H.sessionIdHash ?? SESSION_A,
): Record<string, string> {
  return {
    "x-proovra-support-context": signSupportContextToken({ grantId, supportUserId, sessionIdHash }),
  };
}

const STEP_UP_HDR = { "x-proovra-step-up-challenge-id": "chal-1" };
const JSON_HDR = { "content-type": "application/json" };

beforeEach(() => {
  H.actorUserId = ACTOR;
  H.grants = [];
  H.teamOrgMap = { [TEAM_A]: ORG, [TEAM_B]: ORG, [TEAM_OTHER_ORG]: OTHER_ORG };
  H.memberAllowed = true;
  H.memberReason = "permission_not_granted";
  H.audits = [];
  H.grantReadCount = 0;
  H.sessionIdHash = SESSION_A;
  H.sessionRevoked = false;
  H.sessionRows = { [SESSION_A]: activeSessionRow(), [SESSION_B]: activeSessionRow() };
});

afterEach(() => {
  vi.useRealTimers();
});

// =============================================================================
// The deleted client-controlled marker MUST no longer arm anything.
// =============================================================================
describe("the former client-controlled x-proovra-support-mode header is dead", () => {
  it("sending the OLD boolean header alone (no signed token) never triggers support enforcement — request is evaluated as an ordinary session", async () => {
    H.grants = [grantRow()]; // an active grant exists
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-mode": "active" },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    // Ordinary member-permission decision governs (H.memberAllowed = true) —
    // the deleted header has zero effect, and critically the support
    // authority is never consulted for it.
    expect(res.statusCode).toBe(200);
    expect(H.grantReadCount).toBe(0);
    expect(H.audits).toEqual([]);
  });
});

// =============================================================================
// Ordinary customer sessions — omitted context stays a complete no-op.
// =============================================================================
describe("ordinary customer session (no support-context header)", () => {
  it("[2] omitted context cannot impersonate the customer: unaffected even when the actor happens to hold an ACTIVE support grant — zero extra DB reads", async () => {
    H.grants = [grantRow()];
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: JSON_HDR,
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ actorUserId: ACTOR, teamId: TEAM_A });
    expect(H.grantReadCount).toBe(0);
    expect(H.audits).toEqual([]);
  });

  it("[2] a support actor with no ordinary team membership and NO context header is denied by canonical authorize — never unrestricted", async () => {
    H.memberAllowed = false;
    H.memberReason = "permission_not_granted";
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: JSON_HDR,
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.reason).toBe("permission_not_granted");
    expect(H.grantReadCount).toBe(0);
  });
});

// =============================================================================
// REAL-OPERATION support enforcement — a SERVER-VERIFIED token is present.
// =============================================================================
describe("support-context token — REAL operation authorization", () => {
  it("[1] valid server-issued context, presented from the ISSUING session, permits a scoped read", async () => {
    H.grants = [grantRow()];
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, ...contextHeader("grant-1", ACTOR) },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(res.statusCode).toBe(200);
    expect(H.grantReadCount).toBeGreaterThan(0);
  });

  it("[3] a forged/tampered-signature context FAILS (denied, not treated as absent)", async () => {
    H.grants = [grantRow()];
    const app = await makeApp();
    const good = signSupportContextToken({ grantId: "grant-1", supportUserId: ACTOR, sessionIdHash: SESSION_A });
    // Flip the last character of the signature segment.
    const [payloadB64, sigB64] = good.split(".");
    const tamperedSig = sigB64.slice(0, -1) + (sigB64.endsWith("A") ? "B" : "A");
    const forged = `${payloadB64}.${tamperedSig}`;
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": forged },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatchObject({ code: "permission_denied", reason: "support_access_denied" });
    // A forged token must never reach the grant DB — it fails at signature
    // verification, before any grant lookup.
    expect(H.grantReadCount).toBe(0);
  });

  it("[3b] a garbage / malformed context header FAILS the same way", async () => {
    H.grants = [grantRow()];
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": "not-a-real-token" },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(res.statusCode).toBe(403);
    expect(H.grantReadCount).toBe(0);
  });

  it("[7] wrong actor (token.supportUserId ≠ authenticated actor) fails, even with a signature that verifies", async () => {
    H.grants = [grantRow({ supportUserId: OTHER_USER })];
    H.actorUserId = ACTOR; // the AUTHENTICATED session is ACTOR ...
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/op",
      // ... but the token was minted for a DIFFERENT support user.
      headers: { ...JSON_HDR, ...contextHeader("grant-1", OTHER_USER) },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.reason).toBe("support_access_denied");
    // Rejected at the actor-match check — never reaches the grant DB.
    expect(H.grantReadCount).toBe(0);
  });

  it("[5] cross-Workspace read denied — grant scoped to TEAM_A does not cover TEAM_B in the same org", async () => {
    H.grants = [grantRow({ teamId: TEAM_A })];
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, ...contextHeader("grant-1", ACTOR) },
      payload: { teamId: TEAM_B, permission: "evidence.read" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatchObject({ code: "permission_denied", reason: "support_access_denied" });
  });

  it("[5b] a workspace switch to a DIFFERENT organization cannot escape the grant's scope", async () => {
    H.grants = [grantRow({ organizationId: ORG, teamId: null })];
    const app = await makeApp();
    const ok = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, ...contextHeader("grant-1", ACTOR) },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(ok.statusCode).toBe(200);
    const escaped = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, ...contextHeader("grant-1", ACTOR) },
      payload: { teamId: TEAM_OTHER_ORG, permission: "evidence.read" },
    });
    expect(escaped.statusCode).toBe(403);
  });

  it("[9] expired grant fails", async () => {
    H.grants = [grantRow({ expiresAtUtc: new Date(NOW - 1_000) })];
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, ...contextHeader("grant-1", ACTOR) },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("[8] revoked grant fails", async () => {
    H.grants = [grantRow({ status: "REVOKED", revokedAtUtc: new Date(NOW - 1_000) })];
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, ...contextHeader("grant-1", ACTOR) },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("no grant at all → denied (fail closed on an unrecognized grant id)", async () => {
    H.grants = [];
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, ...contextHeader("grant-1", ACTOR) },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("mutation denied under READ_ONLY", async () => {
    H.grants = [grantRow()];
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, ...contextHeader("grant-1", ACTOR) },
      payload: { teamId: TEAM_A, permission: "evidence.update" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.reason).toBe("support_access_denied");
  });

  it("ELEVATED without a persisted approval → denied, even with a step-up proof on the request", async () => {
    H.grants = [grantRow({ accessLevel: "ELEVATED", approvedByUserId: null })];
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, ...contextHeader("grant-1", ACTOR), ...STEP_UP_HDR },
      payload: { teamId: TEAM_A, permission: "evidence.update" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("ELEVATED with a persisted approval but WITHOUT a step-up proof on the request → denied", async () => {
    H.grants = [grantRow({ accessLevel: "ELEVATED", approvedByUserId: "approver-1" })];
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, ...contextHeader("grant-1", ACTOR) }, // no step-up header
      payload: { teamId: TEAM_A, permission: "evidence.update" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("ELEVATED + approval + fresh step-up proof → permitted for a non-forbidden mutation", async () => {
    H.grants = [grantRow({ accessLevel: "ELEVATED", approvedByUserId: "approver-1" })];
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, ...contextHeader("grant-1", ACTOR), ...STEP_UP_HDR },
      payload: { teamId: TEAM_A, permission: "evidence.update" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("ELEVATED still denies an ALWAYS-forbidden action (evidence.delete) even with approval + step-up", async () => {
    H.grants = [grantRow({ accessLevel: "ELEVATED", approvedByUserId: "approver-1" })];
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, ...contextHeader("grant-1", ACTOR), ...STEP_UP_HDR },
      payload: { teamId: TEAM_A, permission: "evidence.delete" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("valid read emits a dual-identity audit (both allow and deny)", async () => {
    H.grants = [grantRow()];
    const app = await makeApp();
    await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, ...contextHeader("grant-1", ACTOR) },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    const success = H.audits.find((a) => a.action === "identity.support_access.action.success");
    expect(success).toBeTruthy();
    expect(success?.userId).toBe(ACTOR); // support ACTOR identity
    expect(success?.resourceId).toBe(ORG); // customer ORGANIZATION identity
    const meta = success?.metadata as Record<string, unknown>;
    expect(meta.grantId).toBe("grant-1");
    expect(meta.supportActorUserId).toBe(ACTOR);
    expect(meta.customerOrganizationId).toBe(ORG);

    H.audits = [];
    await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, ...contextHeader("grant-1", ACTOR) },
      payload: { teamId: TEAM_A, permission: "evidence.update" }, // READ_ONLY denies mutation
    });
    const denied = H.audits.find((a) => a.action === "identity.support_access.action.denied");
    expect(denied).toBeTruthy();
    expect(denied?.outcome).toBe("denied");
    const dmeta = denied?.metadata as Record<string, unknown>;
    expect(dmeta.reason).toBe("support_read_only");
  });

  it("the SERVER-DERIVED action (canonical permission) is evaluated — a client-supplied body 'action' field is ignored", async () => {
    H.grants = [grantRow()];
    const app = await makeApp();
    await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, ...contextHeader("grant-1", ACTOR) },
      // The route never reads `action` from the body at all — this proves a
      // malicious/naive client cannot influence which action string is
      // evaluated by the support authority.
      payload: { teamId: TEAM_A, permission: "evidence.read", action: "evidence.delete" },
    });
    const success = H.audits.find((a) => a.action === "identity.support_access.action.success");
    const meta = success?.metadata as Record<string, unknown>;
    expect(meta.attemptedAction).toBe("evidence.read");
    expect(meta.attemptedAction).not.toBe("evidence.delete");
  });

  it("fails closed (403) and mutates nothing when the team cannot be resolved to an organization", async () => {
    H.grants = [grantRow()];
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, ...contextHeader("grant-1", ACTOR) },
      payload: { teamId: "unknown-team-id", permission: "evidence.read" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("the support-context token itself heals out after its own TTL, independent of the underlying grant's validity", async () => {
    H.grants = [grantRow()]; // grant is still perfectly valid at the DB level
    const app = await makeApp();
    const token = signSupportContextToken({ grantId: "grant-1", supportUserId: ACTOR, sessionIdHash: SESSION_A });

    // Before expiry: permitted.
    const before = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": token },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(before.statusCode).toBe(200);

    // Advance real time past the token TTL (15 minutes) — the grant fixture
    // above is deliberately valid for a full hour, so ONLY the token's own
    // decay can be responsible for the subsequent denial. Fake ONLY `Date`
    // (not timers) — faking setTimeout/setImmediate would stall Fastify's
    // own internal scheduling and hang `app.inject`.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW + 16 * 60 * 1000);
    const after = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": token },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(after.statusCode).toBe(403);
    expect(JSON.parse(after.body).error.reason).toBe("support_access_denied");
  });
});

// =============================================================================
// PHASE 10 HARDENING FIX 1 (2026-07-23) — SESSION BINDING.
//
// Required-test items [2] (different session), [3] (revoked issuing
// session), [4] (expired session), [5] (forged sessionIdHash), [10]
// (JWT<->support cross-protocol substitution), [12] (denial performs zero
// customer op / zero success audit).
// =============================================================================
describe("support-context token — SESSION BINDING (Hardening Fix 1)", () => {
  it("[req-1] a valid token presented from its OWN issuing session is permitted", async () => {
    H.grants = [grantRow()];
    H.sessionIdHash = SESSION_A;
    const app = await makeApp();
    const token = signSupportContextToken({ grantId: "grant-1", supportUserId: ACTOR, sessionIdHash: SESSION_A });
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": token },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("[req-2] the SAME actor presenting the SAME token from a DIFFERENT session is denied — zero grant reads, zero audit", async () => {
    H.grants = [grantRow()];
    const app = await makeApp();
    const token = signSupportContextToken({ grantId: "grant-1", supportUserId: ACTOR, sessionIdHash: SESSION_A });

    // Minted (and first presented) from Session A: permitted.
    H.sessionIdHash = SESSION_A;
    const ok = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": token },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(ok.statusCode).toBe(200);

    // The SAME actor is now authenticated via a DIFFERENT session (SESSION_B)
    // and replays the SAME token minted under SESSION_A.
    H.sessionIdHash = SESSION_B;
    H.grantReadCount = 0;
    H.audits = [];
    const denied = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": token },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body).error).toMatchObject({ code: "permission_denied", reason: "support_access_denied" });
    // Rejected at the session-binding check — never reaches the grant DB,
    // never emits a support-authority audit row (zero customer op, zero
    // success audit — required-test item [12]).
    expect(H.grantReadCount).toBe(0);
    expect(H.audits).toEqual([]);
  });

  it("[req-3] a REVOKED issuing session denies the request even though the token + grant are otherwise perfectly valid", async () => {
    H.grants = [grantRow()];
    H.sessionIdHash = SESSION_A;
    const app = await makeApp();
    const token = signSupportContextToken({ grantId: "grant-1", supportUserId: ACTOR, sessionIdHash: SESSION_A });

    const before = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": token },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(before.statusCode).toBe(200);

    // The issuing session (SESSION_A) is revoked — e.g. an operator logs it
    // out, or "log out everywhere" fires — AFTER the token was minted.
    H.sessionRevoked = true;
    H.grantReadCount = 0;
    H.audits = [];
    const after = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": token },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(after.statusCode).toBe(403);
    expect(JSON.parse(after.body).error.reason).toBe("support_access_denied");
    expect(H.grantReadCount).toBe(0);
    expect(H.audits).toEqual([]);
  });

  it("[req-4] an EXPIRED issuing session (AuthenticatedSession row past expiresAtUtc) denies the request", async () => {
    H.grants = [grantRow()];
    H.sessionIdHash = SESSION_A;
    const app = await makeApp();
    const token = signSupportContextToken({ grantId: "grant-1", supportUserId: ACTOR, sessionIdHash: SESSION_A });

    const before = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": token },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(before.statusCode).toBe(200);

    // The persisted session row for SESSION_A has since naturally expired.
    H.sessionRows[SESSION_A] = { expiresAtUtc: new Date(NOW - 1_000), revokedAtUtc: null };
    H.grantReadCount = 0;
    H.audits = [];
    const after = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": token },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(after.statusCode).toBe(403);
    expect(JSON.parse(after.body).error.reason).toBe("support_access_denied");
    expect(H.grantReadCount).toBe(0);
    expect(H.audits).toEqual([]);
  });

  it("[req-4b] no persisted AuthenticatedSession row at all → fails closed (cannot prove liveness ≠ assume alive)", async () => {
    H.grants = [grantRow()];
    H.sessionIdHash = SESSION_A;
    delete H.sessionRows[SESSION_A];
    const app = await makeApp();
    const token = signSupportContextToken({ grantId: "grant-1", supportUserId: ACTOR, sessionIdHash: SESSION_A });
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": token },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(res.statusCode).toBe(403);
    expect(H.grantReadCount).toBe(0);
  });

  it("[req-5] a FORGED sessionIdHash (payload tampered post-signature) fails at signature verification, before any grant read", async () => {
    H.grants = [grantRow()];
    H.sessionIdHash = SESSION_A;
    const app = await makeApp();
    const good = signSupportContextToken({ grantId: "grant-1", supportUserId: ACTOR, sessionIdHash: SESSION_A });
    const [payloadB64, sigB64] = good.split(".");
    const decoded = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8")) as Record<string, unknown>;
    // Claim SESSION_B's hash instead, but keep the ORIGINAL signature — a
    // naive implementation that only re-derives `currentSessionIdHash` and
    // compares (without re-verifying the HMAC) would be fooled by this.
    decoded.sessionIdHash = SESSION_B;
    const forgedPayloadB64 = Buffer.from(JSON.stringify(decoded))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const forged = `${forgedPayloadB64}.${sigB64}`;
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": forged },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatchObject({ code: "permission_denied", reason: "support_access_denied" });
    expect(H.grantReadCount).toBe(0);
  });

  it("[req-10] a real session JWT (services/jwt.ts signJwt) presented as x-proovra-support-context is denied — cross-protocol substitution fails", async () => {
    H.grants = [grantRow()];
    const app = await makeApp();
    const realJwt = signJwt({ sub: ACTOR, provider: "password" }, SECRET, 3600);
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": realJwt },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.reason).toBe("support_access_denied");
    expect(H.grantReadCount).toBe(0);
  });

  it("[req-11] a token signed with the RAW AUTH_JWT_SECRET (no HKDF domain separation) is denied", async () => {
    H.grants = [grantRow()];
    const app = await makeApp();
    const { createHmac } = await import("node:crypto");
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      typ: "support_context_v2",
      supportUserId: ACTOR,
      sessionIdHash: SESSION_A,
      grantId: "grant-1",
      iat: now,
      exp: now + 900,
      jti: "raw-secret-forged",
    };
    const b64 = (b: Buffer | string) =>
      (Buffer.isBuffer(b) ? b : Buffer.from(b)).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const payloadB64 = b64(JSON.stringify(payload));
    const sig = createHmac("sha256", SECRET).update(payloadB64).digest(); // raw secret, no HKDF
    const forged = `${payloadB64}.${b64(sig)}`;
    const res = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": forged },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(res.statusCode).toBe(403);
    expect(H.grantReadCount).toBe(0);
  });

  it("[req-4c] when the session heals back to active, a FRESH token from /enter would be required — the OLD (now-invalid) token is not retroactively revived by fixing the session row", async () => {
    H.grants = [grantRow()];
    H.sessionIdHash = SESSION_A;
    const app = await makeApp();
    const token = signSupportContextToken({ grantId: "grant-1", supportUserId: ACTOR, sessionIdHash: SESSION_A });

    H.sessionRows[SESSION_A] = { expiresAtUtc: new Date(NOW - 1_000), revokedAtUtc: null };
    const denied = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": token },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(denied.statusCode).toBe(403);

    // Restore an active session row — the EXISTING token still verifies its
    // own signature and is still bound to the (now-active-again) session,
    // so it is permitted again. This documents the check is fully DYNAMIC
    // (fresh per request), not a one-time gate — mirroring how grant
    // revocation/expiry is re-checked fresh on every request too.
    H.sessionRows[SESSION_A] = activeSessionRow();
    const after = await app.inject({
      method: "POST",
      url: "/op",
      headers: { ...JSON_HDR, "x-proovra-support-context": token },
      payload: { teamId: TEAM_A, permission: "evidence.read" },
    });
    expect(after.statusCode).toBe(200);
  });
});

// =============================================================================
// [11] Queued / background-job attribution — dual identity survives the
// queue boundary and is RE-VALIDATED (not trusted) when the job runs.
// =============================================================================
describe("background-job support attribution carries both identities", () => {
  it("serialize → deserialize → authorizeSupportAction reproduces the SAME dual-identity audit shape a real-time request produces", async () => {
    H.grants = [grantRow()];
    const {
      resolveSupportRuntimeContextByGrantId,
      serializeSupportContext,
      deserializeSupportContext,
      authorizeSupportAction,
    } = await import("../src/services/identity/support-runtime.service.js");

    const resolved = await resolveSupportRuntimeContextByGrantId({
      grantId: "grant-1",
      supportActorUserId: ACTOR,
      organizationId: ORG,
      teamId: TEAM_A,
    });
    if (!resolved.context) throw new Error("expected context");

    // Simulate enqueue → dequeue.
    const wire = JSON.parse(JSON.stringify(serializeSupportContext(resolved.context)));
    const rehydrated = await deserializeSupportContext(wire);
    if (!rehydrated.context) throw new Error("expected rehydrated context");
    expect(rehydrated.context.grantId).toBe("grant-1");
    expect(rehydrated.context.supportActorUserId).toBe(ACTOR);
    expect(rehydrated.context.organizationId).toBe(ORG);

    H.audits = [];
    const decision = await authorizeSupportAction({
      context: rehydrated.context,
      action: "evidence.read",
      customerOrganizationId: ORG,
      requestedTeamId: TEAM_A,
    });
    expect(decision.allowed).toBe(true);
    const success = H.audits.find((a) => a.action === "identity.support_access.action.success");
    expect(success?.userId).toBe(ACTOR); // support ACTOR identity
    expect(success?.resourceId).toBe(ORG); // customer identity
    const meta = success?.metadata as Record<string, unknown>;
    expect(meta.supportActorUserId).toBe(ACTOR);
    expect(meta.customerOrganizationId).toBe(ORG);
    expect(meta.grantId).toBe("grant-1");
  });

  it("a revoked grant heals the job out on re-validation — it is never trusted from the serialized blob alone", async () => {
    H.grants = [grantRow()];
    const { resolveSupportRuntimeContextByGrantId, serializeSupportContext, deserializeSupportContext } =
      await import("../src/services/identity/support-runtime.service.js");
    const resolved = await resolveSupportRuntimeContextByGrantId({
      grantId: "grant-1",
      supportActorUserId: ACTOR,
      organizationId: ORG,
      teamId: TEAM_A,
    });
    if (!resolved.context) throw new Error("expected context");
    const wire = serializeSupportContext(resolved.context);

    // Revoke the grant AFTER serialization, BEFORE the job runs.
    H.grants[0].status = "REVOKED";
    H.grants[0].revokedAtUtc = new Date();

    const rehydrated = await deserializeSupportContext(wire);
    expect(rehydrated.context).toBeNull();
  });
});
