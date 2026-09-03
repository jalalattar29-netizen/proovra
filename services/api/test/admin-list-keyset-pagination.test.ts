/**
 * KEYSET PAGINATION ON THE THREE ADMIN FEEDS THAT RENDERED EVERYTHING AT ONCE.
 *
 * A browser review measured /admin/audit at nine screens, the identity
 * timeline at ten and the Operations security-event table at most of a page,
 * and in every case the cause was the request: 25 cards with no way past
 * them, `limit=250`, `limit=100`. The fix is server pagination, and this file
 * drives the REAL route handlers with fastify `inject` to prove the contract
 * each one now honours:
 *
 *   - the page is `limit` rows in `createdAt desc, id desc` order;
 *   - `hasMore` is the server's own answer, not "we got what we asked for";
 *   - `nextCursor` names the last row shown, and following it yields the rows
 *     strictly after it — no repeat, no gap, including across two rows that
 *     share a timestamp;
 *   - every filter is part of the keyset predicate, so a cursor and its page
 *     describe the same set;
 *   - a cursor that does not decode is a 400, never a silent restart.
 *
 * Only process boundaries are mocked (auth, the platform-admin decision, the
 * database, the rate limiter, audit emission). The in-memory `prisma` below
 * evaluates the handlers' `where` objects for real — a stub that ignored the
 * predicate would pass a handler that ignored the cursor.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const IDS = vi.hoisted(() => ({
  TEAM: "22222222-2222-4222-8222-222222222222",
  ACTOR: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
}));

type SecurityEventRow = {
  id: string;
  teamId: string;
  userId: string | null;
  eventType: string;
  severity: string;
  createdAt: Date;
};

type AdminAuditRow = {
  id: string;
  userId: string | null;
  action: string;
  category: string | null;
  severity: string | null;
  outcome: string | null;
  source: string | null;
  resourceType: string | null;
  createdAt: Date;
};

const H = vi.hoisted(() => ({
  platformAdmin: true,
  securityEvents: [] as Array<{
    id: string;
    teamId: string;
    userId: string | null;
    eventType: string;
    severity: string;
    createdAt: Date;
  }>,
  auditRows: [] as Array<{
    id: string;
    userId: string | null;
    action: string;
    category: string | null;
    severity: string | null;
    outcome: string | null;
    source: string | null;
    resourceType: string | null;
    createdAt: Date;
  }>,
  /** Every findMany the handlers issued, with the args they passed. */
  reads: [] as Array<{ model: string; args: Record<string, unknown> }>,
  /** Every listAdminAuditLogs call the audit route made. */
  auditListCalls: [] as Array<Record<string, unknown>>,
}));

// ---------------------------------------------------------------------------
// A small Prisma `where` evaluator.
//
// Enough of the filter grammar to run the handlers' predicates for real:
// scalar equality (including Date and null), `lt`, `in` (with the
// case-insensitive mode the audit severity filter uses), `contains`, and the
// `AND` / `OR` / `NOT` combinators. Anything else throws, so a handler that
// starts using an operator this cannot evaluate fails loudly here rather
// than passing on a predicate that was never checked.
// ---------------------------------------------------------------------------

function sameScalar(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function matchesField(value: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== "object" || cond instanceof Date) {
    return sameScalar(value, cond);
  }
  const c = cond as Record<string, unknown>;
  for (const [op, operand] of Object.entries(c)) {
    if (op === "mode") continue;
    if (op === "lt") {
      const l = value instanceof Date ? value.getTime() : (value as number);
      const r = operand instanceof Date ? operand.getTime() : (operand as number);
      if (!(l < r)) return false;
    } else if (op === "in") {
      const list = operand as unknown[];
      const insensitive = c.mode === "insensitive";
      const hit = list.some((x) =>
        insensitive && typeof x === "string" && typeof value === "string"
          ? x.toLowerCase() === value.toLowerCase()
          : sameScalar(x, value),
      );
      if (!hit) return false;
    } else if (op === "contains") {
      if (typeof value !== "string" || !value.includes(operand as string)) return false;
    } else if (op === "equals") {
      if (!sameScalar(value, operand)) return false;
    } else {
      throw new Error(`unsupported field operator: ${op}`);
    }
  }
  return true;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "AND") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (!list.every((w) => matches(row, w as Record<string, unknown>))) return false;
    } else if (key === "OR") {
      const list = cond as Array<Record<string, unknown>>;
      if (!list.some((w) => matches(row, w))) return false;
    } else if (key === "NOT") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (list.some((w) => matches(row, w as Record<string, unknown>))) return false;
    } else if (!matchesField(row[key], cond)) {
      return false;
    }
  }
  return true;
}

function ordered<T extends { createdAt: Date; id: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

function findMany<T extends { createdAt: Date; id: string }>(
  model: string,
  source: T[],
  args: { where?: Record<string, unknown>; take?: number; select?: unknown },
): T[] {
  H.reads.push({ model, args: args as Record<string, unknown> });
  const rows = ordered(source).filter((r) =>
    matches(r as unknown as Record<string, unknown>, args.where ?? {}),
  );
  return typeof args.take === "number" ? rows.slice(0, args.take) : rows;
}

// ---------------------------------------------------------------------------
// Process boundaries
// ---------------------------------------------------------------------------

vi.mock("../src/auth.js", () => ({
  getAuthUserId: () => IDS.ACTOR,
  getAuthSessionId: () => "session-hash",
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { sub: IDS.ACTOR, platformRole: "admin" };
  },
}));

vi.mock("../src/services/platform-admin.service.js", () => ({
  isPlatformAdmin: async () => H.platformAdmin,
  resolvePlatformAdmin: async () => ({
    allowed: H.platformAdmin,
    source: H.platformAdmin ? "DATABASE_ROLE" : "NOT_ADMIN",
    claimedAdmin: H.platformAdmin,
  }),
}));

vi.mock("../src/services/rate-limit.js", () => ({
  enforceRateLimit: async () => ({ allowed: true }),
}));

vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitPlatformAudit: async () => {},
  emitAdminManualAudit: async () => {},
  emitTenantAudit: async () => {},
}));

vi.mock("../src/services/identity/access-policy.service.js", () => ({
  evaluateMemberAccess: async () => ({ allowed: true, reason: "ROLE_MATRIX", detail: null }),
}));

vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async (_r: unknown, _p: unknown, o: { teamId: string }) => ({
    actorUserId: IDS.ACTOR,
    teamId: o.teamId,
  }),
}));

// The identity router imports every identity service at module load. None
// of them is exercised here; they are stubbed so the import graph stops at
// the boundary rather than reaching a real client.
vi.mock("../src/services/identity-security/step-up-middleware.js", () => ({
  requireStepUpForSensitiveAction: async () => ({ sent: false }),
}));
vi.mock("../src/services/access-control/adaptive-runtime-gate.service.js", () => ({
  runtimeAdaptiveGate: async () => ({ allow: true }),
}));
vi.mock("../src/services/access-control/sso.service.js", () => ({
  SsoServiceError: class SsoServiceError extends Error {},
  createSsoConnection: async () => ({}),
  listSsoConnections: async () => [],
  transitionSsoConnection: async () => ({}),
  updateSsoConnectionPolicy: async () => ({}),
}));
vi.mock("../src/services/access-control/sso-list-bounds.js", () => ({
  SSO_CONNECTION_LIST_CAP: 100,
}));
vi.mock("../src/services/access-control/rbac-engine.service.js", () => ({
  RbacEngineError: class RbacEngineError extends Error {},
  buildPermissionSnapshot: async () => ({}),
  computeEffectiveRoleMatrix: async () => ({}),
  grantTemporaryElevation: async () => ({}),
}));
vi.mock("../src/services/access-control/scim.service.js", () => ({
  createScimToken: async () => ({}),
  listScimTokens: async () => [],
  revokeScimToken: async () => ({}),
}));
vi.mock("../src/services/access-control/session-inventory.service.js", () => ({
  listActiveSessions: async () => ({ sessions: [], nextCursor: null, hasMore: false }),
  refreshHighRiskSessionGauge: async () => {},
  revokeActiveSession: async () => ({}),
  revokeAllSessionsForUserAdmin: async () => ({}),
  sweepStaleSessions: async () => ({}),
}));
vi.mock("../src/services/access-control/suspicious-session.service.js", () => ({
  detectAndScoreSession: async () => ({}),
}));
vi.mock("../src/services/access-control/sso-hardening.service.js", () => ({
  sweepStaleCallbackAttempts: async () => ({}),
}));
vi.mock("../src/services/access-control/session-quarantine.service.js", () => ({
  emergencyOrgRevoke: async () => ({}),
  listQuarantinedSessions: async () => ({ sessions: [], nextCursor: null, hasMore: false }),
  quarantineSession: async () => ({}),
  releaseQuarantine: async () => ({}),
  sweepQuarantineReleases: async () => ({}),
}));
vi.mock("../src/services/access-control/runtime-risk.service.js", () => ({
  runtimeRiskRecomputeSweep: async () => ({}),
}));
vi.mock("../src/services/access-control/trusted-device-decay.service.js", () => ({
  sweepTrustedDeviceDecay: async () => ({}),
}));
vi.mock("../src/services/access-control/geo-intelligence.service.js", () => ({
  sweepGeoCache: async () => ({}),
}));
vi.mock("../src/services/observability/incident.service.js", () => ({
  projectIncident: (i: unknown) => i,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    teamMember: {
      findUnique: async () => ({ id: "tm-1", status: "ACTIVE" }),
    },
    securityEvent: {
      findMany: async (args: { where?: Record<string, unknown>; take?: number }) =>
        findMany("securityEvent", H.securityEvents, args),
      groupBy: async () => [],
    },
    adminAuditLog: {
      findMany: async (args: { where?: Record<string, unknown>; take?: number }) =>
        findMany("adminAuditLog", H.auditRows, args),
      count: async () => 0,
    },
  },
}));

// The audit-log list route reads through the canonical service, which owns
// its own cursor (the row id). Reproduced here over the same fixture so the
// route's probe for "is there a row past this one" is evaluated for real.
vi.mock("../src/services/platform-audit-log.service.js", () => ({
  listAdminAuditLogs: async (params: {
    limit: number;
    cursorId?: string | null;
    severity?: string | null;
  }) => {
    H.auditListCalls.push(params as Record<string, unknown>);
    let rows = ordered(H.auditRows);
    if (params.severity) rows = rows.filter((r) => r.severity === params.severity);
    if (params.cursorId) {
      const idx = rows.findIndex((r) => r.id === params.cursorId);
      rows = idx === -1 ? [] : rows.slice(idx + 1);
    }
    return {
      items: rows.slice(0, params.limit).map((r) => ({
        ...r,
        isPublic: false,
        resourceId: null,
        requestId: null,
        metadata: {},
        ipAddress: null,
        userAgent: null,
        hash: "h",
        prevHash: null,
        chainVersion: 1,
        createdAt: r.createdAt.toISOString(),
        anchoredAt: null,
      })),
    };
  },
  verifyAdminAuditChain: async () => ({ valid: true }),
}));

import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetPage,
} from "../src/services/pagination/keyset-cursor.js";
import { adminIdentityRoutes } from "../src/routes/admin-identity.routes.js";
import { adminSecurityRoutes } from "../src/routes/admin-security.routes.js";
import { adminAuditRoutes } from "../src/routes/admin-audit.routes.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-09-01T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(T0 - minutesAgo * 60_000);

function seed() {
  H.reads.length = 0;
  H.auditListCalls.length = 0;
  H.platformAdmin = true;

  // 30 security events one minute apart, plus TWO in the SAME millisecond as
  // event 10 — the tie a timestamp-only cursor would repeat or skip.
  const events: SecurityEventRow[] = [];
  for (let i = 0; i < 30; i += 1) {
    events.push({
      id: `se-${String(i).padStart(2, "0")}`,
      teamId: IDS.TEAM,
      userId: null,
      eventType: i % 3 === 0 ? "sso_login_failed" : "session_revoked_admin",
      severity: i % 5 === 0 ? "HIGH" : "INFO",
      createdAt: at(i),
    });
  }
  events.push(
    { id: "se-tie-a", teamId: IDS.TEAM, userId: null, eventType: "sso_login_failed", severity: "INFO", createdAt: at(10) },
    { id: "se-tie-b", teamId: IDS.TEAM, userId: null, eventType: "sso_login_failed", severity: "INFO", createdAt: at(10) },
  );
  // An event in ANOTHER workspace, which must never appear.
  events.push({
    id: "se-other",
    teamId: "33333333-3333-4333-8333-333333333333",
    userId: null,
    eventType: "sso_login_failed",
    severity: "HIGH",
    createdAt: at(0.5),
  });
  H.securityEvents = events;

  const audit: AdminAuditRow[] = [];
  for (let i = 0; i < 30; i += 1) {
    audit.push({
      id: `aa-${String(i).padStart(2, "0")}`,
      userId: IDS.ACTOR,
      action: i % 2 === 0 ? "identity.role_changed" : "billing.plan_changed",
      category: "identity",
      severity: i % 4 === 0 ? "critical" : i % 4 === 1 ? "Warning" : "info",
      outcome: "success",
      source: "admin_console",
      resourceType: "user",
      // Interleaved with the security events: 30 seconds after each.
      createdAt: new Date(at(i).getTime() + 30_000),
    });
  }
  H.auditRows = audit;
}

async function buildApp(register: (app: FastifyInstance) => Promise<void>) {
  const app = Fastify();
  await register(app);
  await app.ready();
  return app;
}

const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;

// ===========================================================================
// The cursor itself
// ===========================================================================

describe("keyset cursor — opaque, round-trips, refuses garbage", () => {
  it("encodes (at, id) and decodes it back", () => {
    const key = { at: new Date("2026-09-01T00:00:00.000Z"), id: "row-1" };
    const decoded = decodeKeysetCursor(encodeKeysetCursor(key));
    expect(decoded).toEqual(key);
  });

  it("distinguishes an absent cursor from a broken one", () => {
    expect(decodeKeysetCursor(undefined)).toBeUndefined();
    expect(decodeKeysetCursor("")).toBeUndefined();
    expect(decodeKeysetCursor("not-base64-json")).toBeNull();
    expect(
      decodeKeysetCursor(Buffer.from(JSON.stringify({ at: "yesterday", id: "x" })).toString("base64url")),
    ).toBeNull();
  });

  it("keysetPage drops the probe row and issues a cursor only when it existed", () => {
    const rows = [1, 2, 3].map((n) => ({ id: `r${n}`, at: new Date(T0 - n) }));
    const full = keysetPage(rows, 2, (r) => r);
    expect(full.rows.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(full.hasMore).toBe(true);
    expect(decodeKeysetCursor(full.nextCursor!)).toEqual({ at: rows[1].at, id: "r2" });

    const short = keysetPage(rows, 3, (r) => r);
    expect(short.hasMore).toBe(false);
    expect(short.nextCursor).toBeNull();
  });
});

// ===========================================================================
// GET /v1/admin/identity/timeline
// ===========================================================================

describe("GET /v1/admin/identity/timeline — keyset pages over the workspace feed", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    seed();
    app = await buildApp(async (a) => { await a.register(adminIdentityRoutes); });
  });

  const get = (qs: string) =>
    app.inject({ method: "GET", url: `/v1/admin/identity/timeline?teamId=${IDS.TEAM}&${qs}` });

  it("page one is exactly `limit` rows, newest first, with the server's own hasMore", async () => {
    const res = await get("limit=25");
    expect(res.statusCode).toBe(200);
    const body = json(res) as { events: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null };
    expect(body.events).toHaveLength(25);
    expect(body.events[0].id).toBe("se-00");
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).not.toBeNull();
    // `take` is what the caller asked for; the continuation is a probe read
    // of ONE row past the page, not a silently larger page.
    const takes = H.reads.filter((r) => r.model === "securityEvent").map((r) => r.args.take);
    expect(takes).toEqual([25, 1]);
  });

  it("following nextCursor yields the rows strictly after the page — no repeat, no gap, ties included", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(`limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.statusCode).toBe(200);
      const body = json(res) as { events: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null };
      seen.push(...body.events.map((e) => e.id));
      cursor = body.nextCursor;
      pages += 1;
      if (!body.hasMore) expect(body.nextCursor).toBeNull();
    } while (cursor && pages < 20);

    const expected = ordered(H.securityEvents.filter((e) => e.teamId === IDS.TEAM)).map((e) => e.id);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
    // The two same-millisecond rows sit in one contiguous run in the order
    // the cursor encodes (id desc), and both came through exactly once.
    expect(seen.filter((id) => id.startsWith("se-tie"))).toEqual(["se-tie-b", "se-tie-a"]);
    expect(seen).not.toContain("se-other");
  });

  it("severity is applied by the SERVER and stays inside the keyset predicate", async () => {
    const first = await get("limit=3&severity=HIGH");
    const body = json(first) as { events: Array<{ id: string; severity: string }>; nextCursor: string };
    expect(body.events.every((e) => e.severity === "HIGH")).toBe(true);
    expect(body.events).toHaveLength(3);
    const pageRead = H.reads.find((r) => r.model === "securityEvent");
    expect((pageRead?.args.where as Record<string, unknown>).severity).toBe("HIGH");

    const second = await get(`limit=3&severity=HIGH&cursor=${encodeURIComponent(body.nextCursor)}`);
    const next = json(second) as { events: Array<{ id: string; severity: string }>; hasMore: boolean };
    expect(next.events.every((e) => e.severity === "HIGH")).toBe(true);
    expect(next.events.map((e) => e.id)).toEqual(["se-15", "se-20", "se-25"]);
    expect(next.hasMore).toBe(false);
  });

  it("a full last page reports hasMore=false rather than offering an empty Next", async () => {
    const teamRows = H.securityEvents.filter((e) => e.teamId === IDS.TEAM).length;
    const res = await get(`limit=${teamRows}`);
    const body = json(res) as { events: unknown[]; hasMore: boolean; nextCursor: string | null };
    expect(body.events).toHaveLength(teamRows);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("a cursor that does not decode is refused, not silently restarted", async () => {
    const res = await get("limit=25&cursor=garbage");
    expect(res.statusCode).toBe(400);
  });

  it("a caller that never sends a cursor keeps its existing shape", async () => {
    const res = await get("kinds=sso_login_failed&limit=50");
    expect(res.statusCode).toBe(200);
    const body = json(res) as { events: Array<{ kind: string }> };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e) => e.kind === "sso_login_failed")).toBe(true);
  });
});

// ===========================================================================
// GET /v1/admin/security-events
// ===========================================================================

describe("GET /v1/admin/security-events — one keyset over two merged sources", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    seed();
    app = await buildApp(async (a) => { await a.register(adminSecurityRoutes); });
  });

  const get = (qs: string) => app.inject({ method: "GET", url: `/v1/admin/security-events?${qs}` });

  it("page one merges both sources newest-first and says whether more exists", async () => {
    const res = await get("limit=25");
    expect(res.statusCode).toBe(200);
    const body = json(res) as {
      items: Array<{ id: string; createdAt: string; origin: string }>;
      hasMore: boolean;
      nextCursor: string | null;
      severityBreakdown: unknown;
      totalEvents: number;
    };
    expect(body.items).toHaveLength(25);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).not.toBeNull();
    // Both origins present, and strictly non-increasing by time.
    expect(new Set(body.items.map((i) => i.origin))).toEqual(new Set(["SECURITY_EVENT", "ADMIN_AUDIT"]));
    for (let i = 1; i < body.items.length; i += 1) {
      expect(body.items[i - 1].createdAt >= body.items[i].createdAt).toBe(true);
    }
    // Each source is read one row past the limit — that row is the proof.
    expect(H.reads.map((r) => r.args.take)).toEqual([26, 26]);
    // The breakdown the Overview tile reads is untouched by paging.
    expect(body.severityBreakdown).toBeDefined();
    expect(typeof body.totalEvents).toBe("number");
  });

  it("walking every page visits every row of both sources exactly once, in merged order", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(`limit=9${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.statusCode).toBe(200);
      const body = json(res) as { items: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null };
      seen.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 30);

    const all = ordered([
      ...H.securityEvents.map((e) => ({ id: e.id, createdAt: e.createdAt })),
      ...H.auditRows.map((a) => ({ id: a.id, createdAt: a.createdAt })),
    ]).map((r) => r.id);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(all.length);
  });

  it("severity narrows BOTH sources in the database and survives the cursor", async () => {
    const first = await get("limit=5&severity=CRITICAL");
    const body = json(first) as { items: Array<{ id: string; severity: string }>; nextCursor: string; hasMore: boolean };
    expect(body.items.every((i) => i.severity === "CRITICAL")).toBe(true);
    expect(body.items).toHaveLength(5);
    const auditRead = H.reads.find((r) => r.model === "adminAuditLog");
    expect((auditRead?.args.where as Record<string, unknown>).severity).toEqual({
      in: ["critical"],
      mode: "insensitive",
    });

    const second = await get(`limit=5&severity=CRITICAL&cursor=${encodeURIComponent(body.nextCursor)}`);
    const next = json(second) as { items: Array<{ id: string; severity: string }>; hasMore: boolean };
    expect(next.items.every((i) => i.severity === "CRITICAL")).toBe(true);
    // 8 critical audit rows in the fixture (i % 4 === 0): 5 then 3.
    expect(next.items.map((i) => i.id)).toEqual(["aa-20", "aa-24", "aa-28"]);
    expect(next.hasMore).toBe(false);
  });

  it("INFO is the residual bucket: a null or unknown audit severity lands there and nowhere else", async () => {
    H.auditRows[0] = { ...H.auditRows[0], severity: null };
    const res = await get("limit=100&severity=INFO");
    const body = json(res) as { items: Array<{ id: string; severity: string }> };
    expect(body.items.some((i) => i.id === "aa-00")).toBe(true);
    expect(body.items.every((i) => i.severity === "INFO")).toBe(true);
    const critical = json(await get("limit=100&severity=CRITICAL")) as { items: Array<{ id: string }> };
    expect(critical.items.some((i) => i.id === "aa-00")).toBe(false);
  });

  it("a cursor that does not decode is a 400", async () => {
    const res = await get("limit=25&cursor=%7Bnope");
    expect(res.statusCode).toBe(400);
  });

  it("a non-platform-admin is refused before any source is read", async () => {
    H.platformAdmin = false;
    const res = await get("limit=25");
    expect(res.statusCode).toBe(403);
    expect(H.reads).toEqual([]);
  });
});

// ===========================================================================
// GET /v1/admin/audit-log
// ===========================================================================

describe("GET /v1/admin/audit-log — the existing id cursor, now with a continuation", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    seed();
    app = await buildApp(async (a) => { await a.register(adminAuditRoutes); });
  });

  const get = (qs: string) => app.inject({ method: "GET", url: `/v1/admin/audit-log?${qs}` });

  it("page one is `limit` rows and nextCursor is the last row's id", async () => {
    const res = await get("limit=25");
    expect(res.statusCode).toBe(200);
    const body = json(res) as { items: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null };
    expect(body.items).toHaveLength(25);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe(body.items[24].id);
    // The page read, then ONE probe past its last row under the same filters.
    expect(H.auditListCalls.map((c) => [c.limit, c.cursorId])).toEqual([
      [25, null],
      [1, body.items[24].id],
    ]);
  });

  it("following the cursor reaches the rest, and the last page says so", async () => {
    const first = json(await get("limit=25")) as { nextCursor: string };
    const res = await get(`limit=25&cursor=${first.nextCursor}`);
    const body = json(res) as { items: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null };
    expect(body.items.map((i) => i.id)).toEqual(["aa-25", "aa-26", "aa-27", "aa-28", "aa-29"]);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
    // A short page needs no probe.
    expect(H.auditListCalls).toHaveLength(3);
  });

  it("the probe carries the SAME filters as the page", async () => {
    const res = await get("limit=4&severity=critical");
    const body = json(res) as { items: Array<{ severity: string }>; hasMore: boolean };
    expect(body.items).toHaveLength(4);
    expect(body.items.every((i) => i.severity === "critical")).toBe(true);
    expect(body.hasMore).toBe(true);
    expect(H.auditListCalls[1]).toMatchObject({ limit: 1, severity: "critical" });
  });

  it("an exactly-full last page reports hasMore=false", async () => {
    const res = await get("limit=30");
    const body = json(res) as { items: unknown[]; hasMore: boolean; nextCursor: string | null };
    expect(body.items).toHaveLength(30);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("a limit outside the bound is a 400, not a silent default", async () => {
    expect((await get("limit=0")).statusCode).toBe(400);
    expect((await get("limit=abc")).statusCode).toBe(400);
    expect((await get("limit=101")).statusCode).toBe(400);
  });

  it("omitting limit keeps the historical default of 20", async () => {
    const res = await get("");
    expect(res.statusCode).toBe(200);
    expect((json(res) as { items: unknown[] }).items).toHaveLength(20);
  });
});
