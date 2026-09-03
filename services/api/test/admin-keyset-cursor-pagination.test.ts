/**
 * KEYSET PAGINATION on the five admin lists that used to render their cap.
 *
 *   GET /v1/admin/identity/sessions
 *   GET /v1/admin/identity/quarantined-sessions
 *   GET /v1/security/events
 *   GET /v1/identity/mfa-admin/events/:teamId
 *   GET /v1/identity/mfa-admin/recovery-events
 *
 * Three layers, each proven on its own:
 *
 *   1. The cursor codec — round trip, opacity, refusal of junk. A cursor that
 *      does not decode must be `null` (a 400 at the route) and never
 *      `undefined` (page one), because "start over" on a bad cursor makes
 *      Next loop on the first page forever.
 *   2. The service query — the WHERE the service actually hands Prisma. The
 *      keyset predicate is ANDed with the list's own filters, the order
 *      carries the id tiebreaker, and `take` is one past the page so
 *      `hasMore` is observed rather than inferred from a full page.
 *   3. The route — a malformed cursor is a 400 with zero reads; a good one is
 *      decoded and handed down; the reply carries `nextCursor` and
 *      `hasMore`; and a caller sending no cursor gets exactly the first page
 *      it always got.
 *
 * Prisma is a recording fake so the assertions are about the query, which is
 * the thing keyset correctness depends on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetAfter,
  keysetPage,
} from "../src/services/pagination/keyset-cursor.js";

const TEAM = "11111111-1111-4111-8111-111111111111";
const ACTOR = "44444444-4444-4444-8444-444444444444";

// ---------------------------------------------------------------------------
// Recording prisma fake — bound before any SUT import.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  findManyArgs: [] as Array<{ model: string; args: Row }>,
  /** What the fake returns for the next findMany on each model. */
  rows: {} as Record<string, Row[]>,
}));

vi.mock("../src/db.js", () => {
  const model = (name: string) => ({
    findMany: async (args: Row) => {
      H.findManyArgs.push({ model: name, args });
      const take = typeof args.take === "number" ? args.take : undefined;
      const all = H.rows[name] ?? [];
      return take === undefined ? all : all.slice(0, take);
    },
    count: async () => 0,
    findUnique: async () => ({ role: "ADMIN" }),
  });
  return {
    prisma: {
      authenticatedSession: model("authenticatedSession"),
      securityEvent: model("securityEvent"),
      teamMember: {
        ...model("teamMember"),
        findMany: async () => [{ teamId: TEAM }],
      },
      team: { findMany: async () => [{ id: TEAM, name: "Northgate" }] },
    },
  };
});

vi.mock("../src/services/ops/metrics.service.js", () => ({
  bump: () => undefined,
  setGauge: () => undefined,
}));

// --- auth / authorization for the route layer -----------------------------
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { user?: unknown }) => {
    (req as { user: unknown }).user = { sub: ACTOR };
  },
}));
vi.mock("../src/auth.js", () => ({
  getAuthUserId: () => ACTOR,
}));
vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async () => ({ actorUserId: ACTOR, teamId: TEAM }),
}));

import {
  listActiveSessions,
} from "../src/services/access-control/session-inventory.service.js";
import { listQuarantinedSessions } from "../src/services/access-control/session-quarantine.service.js";
import { listSecurityEvents } from "../src/services/security/security-event.service.js";
import { securityRoutes } from "../src/routes/security.routes.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = new Date("2026-09-01T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(T0.getTime() - m * 60_000);

function sessionRow(i: number, over: Row = {}): Row {
  return {
    id: `s-${String(i).padStart(3, "0")}`,
    teamId: TEAM,
    userId: ACTOR,
    ssoConnectionId: null,
    issuedAtUtc: minutesAgo(i + 60),
    expiresAtUtc: new Date(T0.getTime() + 3_600_000),
    lastSeenAtUtc: minutesAgo(i),
    ipPreview: null,
    uaPreview: null,
    revokedAtUtc: null,
    revokedReason: null,
    quarantinedAtUtc: null,
    quarantineReleaseAtUtc: null,
    ...over,
  };
}

function eventRow(i: number): Row {
  return {
    id: `e-${String(i).padStart(3, "0")}`,
    teamId: TEAM,
    eventType: "scim_token_created",
    severity: "HIGH",
    evidenceId: null,
    apiCredentialId: null,
    webhookEndpointId: null,
    details: {},
    createdAt: minutesAgo(i),
    updatedAt: minutesAgo(i),
  };
}

beforeEach(() => {
  H.findManyArgs = [];
  H.rows = {};
});

// ===========================================================================
// 1. The codec
// ===========================================================================

describe("keyset cursor codec", () => {
  it("round-trips a (timestamp, id) key through an opaque base64url token", () => {
    const at = new Date("2026-09-01T12:34:56.789Z");
    const token = encodeKeysetCursor({ at, id: "s-042" });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("s-042");
    expect(decodeKeysetCursor(token)).toEqual({ at, id: "s-042" });
  });

  it("no cursor is page one (undefined), not a refusal", () => {
    expect(decodeKeysetCursor(undefined)).toBeUndefined();
    expect(decodeKeysetCursor(null)).toBeUndefined();
    expect(decodeKeysetCursor("")).toBeUndefined();
  });

  it.each([
    ["not base64 json", "definitely-not-a-cursor"],
    ["json but not an object", Buffer.from("[1,2]").toString("base64url")],
    ["missing id", Buffer.from(JSON.stringify({ at: T0.toISOString() })).toString("base64url")],
    ["unparseable timestamp", Buffer.from(JSON.stringify({ at: "yesterday", id: "x" })).toString("base64url")],
    ["id with injection-shaped characters", Buffer.from(JSON.stringify({ at: T0.toISOString(), id: "x' OR 1=1" })).toString("base64url")],
    ["oversized", "A".repeat(600)],
  ])("a malformed cursor (%s) decodes to null, never to page one", (_n, token) => {
    expect(decodeKeysetCursor(token)).toBeNull();
  });

  it("keysetAfter is 'strictly after (at, id)' under `<field> desc, id desc`", () => {
    const at = new Date("2026-09-01T12:00:00.000Z");
    expect(keysetAfter("lastSeenAtUtc", { at, id: "s-010" })).toEqual({
      OR: [
        { lastSeenAtUtc: { lt: at } },
        { lastSeenAtUtc: at, id: { lt: "s-010" } },
      ],
    });
  });

  it("keysetPage drops the probe row and names the last SHOWN row in the cursor", () => {
    const fetched = [1, 2, 3, 4].map((i) => ({ id: `r-${i}`, at: minutesAgo(i) }));
    const page = keysetPage(fetched, 3, (r) => ({ at: r.at, id: r.id }));
    expect(page.rows.map((r) => r.id)).toEqual(["r-1", "r-2", "r-3"]);
    expect(page.hasMore).toBe(true);
    expect(decodeKeysetCursor(page.nextCursor)).toEqual({ at: minutesAgo(3), id: "r-3" });

    const last = keysetPage(fetched.slice(0, 3), 3, (r) => ({ at: r.at, id: r.id }));
    expect(last.hasMore).toBe(false);
    expect(last.nextCursor).toBeNull();
    expect(last.rows).toHaveLength(3);
  });
});

// ===========================================================================
// 2. The service queries
// ===========================================================================

describe("listActiveSessions — keyset over (lastSeenAtUtc, id)", () => {
  it("page one: filters only, id tiebreaker in the order, take = limit + 1", async () => {
    H.rows.authenticatedSession = [sessionRow(1), sessionRow(2), sessionRow(3)];
    const page = await listActiveSessions({ teamId: TEAM, limit: 2 });
    const q = H.findManyArgs[0]!.args;
    expect(q.where).toEqual({
      teamId: TEAM,
      revokedAtUtc: null,
      expiresAtUtc: { gt: expect.any(Date) },
    });
    expect(q.orderBy).toEqual([{ lastSeenAtUtc: "desc" }, { id: "desc" }]);
    expect(q.take).toBe(3);
    // The probe row is not shown; it is the proof of a next page.
    expect(page.sessions.map((s) => s.id)).toEqual(["s-001", "s-002"]);
    expect(page.hasMore).toBe(true);
    expect(decodeKeysetCursor(page.nextCursor)).toEqual({ at: minutesAgo(2), id: "s-002" });
  });

  it("page two: the cursor predicate is ANDed with the SAME filters", async () => {
    H.rows.authenticatedSession = [sessionRow(3)];
    const after = { at: minutesAgo(2), id: "s-002" };
    const page = await listActiveSessions({
      teamId: TEAM,
      limit: 2,
      includeRevoked: true,
      after,
    });
    const q = H.findManyArgs[0]!.args as { where: { AND: Row[] } };
    expect(q.where.AND).toHaveLength(2);
    // includeRevoked drops the revokedAtUtc predicate; expired stays hidden.
    expect(q.where.AND[0]).toEqual({
      teamId: TEAM,
      expiresAtUtc: { gt: expect.any(Date) },
    });
    expect(q.where.AND[1]).toEqual(keysetAfter("lastSeenAtUtc", after));
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("projects the hold flag so a paged inventory still says which row is quarantined", async () => {
    H.rows.authenticatedSession = [
      sessionRow(1, { quarantinedAtUtc: minutesAgo(5), quarantineReleaseAtUtc: null }),
      sessionRow(2, {
        quarantinedAtUtc: minutesAgo(500),
        quarantineReleaseAtUtc: minutesAgo(400), // already auto-released
      }),
      sessionRow(3),
    ];
    const page = await listActiveSessions({ teamId: TEAM, limit: 10 });
    expect(page.sessions.map((s) => s.quarantined)).toEqual([true, false, false]);
  });
});

describe("listQuarantinedSessions — keyset over (quarantinedAtUtc, id)", () => {
  it("keeps the not-null hold predicate under the cursor", async () => {
    H.rows.authenticatedSession = [];
    const after = { at: minutesAgo(9), id: "s-009" };
    await listQuarantinedSessions({ teamId: TEAM, limit: 5, after });
    const q = H.findManyArgs[0]!.args as { where: { AND: Row[] }; orderBy: unknown; take: number };
    expect(q.where.AND[0]).toEqual({ teamId: TEAM, quarantinedAtUtc: { not: null } });
    expect(q.where.AND[1]).toEqual(keysetAfter("quarantinedAtUtc", after));
    expect(q.orderBy).toEqual([{ quarantinedAtUtc: "desc" }, { id: "desc" }]);
    expect(q.take).toBe(6);
  });
});

describe("listSecurityEvents — keyset over (createdAt, id)", () => {
  it("severity + eventType filters travel under the cursor", async () => {
    H.rows.securityEvent = [eventRow(1), eventRow(2)];
    const after = { at: minutesAgo(0), id: "e-000" };
    const page = await listSecurityEvents({
      teamId: TEAM,
      severity: "HIGH",
      eventType: "scim_token_created",
      limit: 1,
      after,
    });
    const q = H.findManyArgs[0]!.args as { where: { AND: Row[] }; orderBy: unknown; take: number };
    expect(q.where.AND[0]).toEqual({
      teamId: TEAM,
      severity: "HIGH",
      eventType: "scim_token_created",
    });
    expect(q.where.AND[1]).toEqual(keysetAfter("createdAt", after));
    expect(q.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(q.take).toBe(2);
    expect(page.rows.map((r) => r.id)).toEqual(["e-001"]);
    expect(page.hasMore).toBe(true);
    expect(decodeKeysetCursor(page.nextCursor)).toEqual({ at: minutesAgo(1), id: "e-001" });
  });

  it("no cursor → the plain filter object, exactly what callers always sent", async () => {
    H.rows.securityEvent = [];
    await listSecurityEvents({ teamId: TEAM });
    expect(H.findManyArgs[0]!.args.where).toEqual({ teamId: TEAM });
  });
});

// ===========================================================================
// 3. The route
// ===========================================================================

describe("GET /v1/security/events — the cursor at the boundary", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(securityRoutes);
    await app.ready();
  });

  it("a malformed cursor is a 400 and reads NOTHING", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/security/events?teamId=${TEAM}&cursor=not-a-cursor`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: { code: "validation_error", reason: "cursor does not decode" },
    });
    expect(H.findManyArgs.filter((c) => c.model === "securityEvent")).toHaveLength(0);
  });

  it("a good cursor is decoded, handed down, and the reply names the next page", async () => {
    H.rows.securityEvent = [eventRow(5), eventRow(6), eventRow(7)];
    const cursor = encodeKeysetCursor({ at: minutesAgo(4), id: "e-004" });
    const res = await app.inject({
      method: "GET",
      url: `/v1/security/events?teamId=${TEAM}&limit=2&cursor=${cursor}`,
    });
    expect(res.statusCode).toBe(200);
    const q = H.findManyArgs.find((c) => c.model === "securityEvent")!.args as {
      where: { AND: Row[] };
      take: number;
    };
    expect(q.where.AND[1]).toEqual(keysetAfter("createdAt", { at: minutesAgo(4), id: "e-004" }));
    expect(q.take).toBe(3);
    const body = JSON.parse(res.body) as {
      events: Array<{ id: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(body.events.map((e) => e.id)).toEqual(["e-005", "e-006"]);
    expect(body.hasMore).toBe(true);
    expect(decodeKeysetCursor(body.nextCursor)).toEqual({ at: minutesAgo(6), id: "e-006" });
  });

  it("no cursor: the first page, with hasMore=false and nextCursor=null on the last one", async () => {
    H.rows.securityEvent = [eventRow(1)];
    const res = await app.inject({
      method: "GET",
      url: `/v1/security/events?teamId=${TEAM}&limit=25`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { events: unknown[]; nextCursor: unknown; hasMore: unknown };
    expect(body.events).toHaveLength(1);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
    const q = H.findManyArgs.find((c) => c.model === "securityEvent")!.args;
    expect(q.where).toEqual({ teamId: TEAM });
  });
});
