/**
 * PHASE 12B — Identity administration behavioral matrix.
 *
 * Drives the REAL production code (identity.routes + the rbac transition
 * engine) over an in-memory prisma transport. Only process boundaries are
 * substituted: token verification, the step-up challenge transport, the audit
 * sinks, and the db client. Every decision under test — scope derivation,
 * anti-enumeration, managed-identity ownership, last-administrator protection,
 * transaction atomicity — executes production code.
 *
 * Matrix:
 *   1. cross-Organization target → CONCEALED 404, byte-identical to a target
 *      that does not exist, with ZERO mutation
 *   2. declared teamId that disagrees with the persisted scope → 404 (the
 *      client cannot choose the workspace it acts in)
 *   3. SCIM/SSO-managed identity → bounded 409, ZERO mutation; an unresolvable
 *      identity mode fails CLOSED
 *   4. step-up denial → ZERO mutation
 *   5. last-administrator protection is ATOMIC: two concurrent demotions of the
 *      last two administrators cannot both commit, and the guard's re-count runs
 *      INSIDE the mutating transaction
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const TEAM = "33333333-3333-4333-8333-333333333333";
const OTHER_TEAM = "44444444-4444-4444-8444-444444444444";
const ORG = "55555555-5555-4555-8555-555555555555";

const MEMBER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const MEMBER_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const MEMBER_MANAGED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const FOREIGN_MEMBER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9";
const MISSING_MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const USER_A = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const USER_B = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const USER_MANAGED = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const USER_FOREIGN = "cccccccc-cccc-4ccc-8ccc-ccccccccccc9";

// ---------------------------------------------------------------------------
// Boundaries — bound BEFORE the SUT import.
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  /** Authenticated principal (token verification is the substituted seam). */
  actorUserId: "11111111-1111-4111-8111-111111111111",
  /** When true the step-up gate denies (challenge missing / not approved). */
  stepUpDenies: false,
  /** When true the identity-mode read throws (schema unavailable). */
  identityModeThrows: false,
  writes: [] as string[],
  audits: [] as Array<Record<string, unknown>>,
  /** Was every last-administrator re-count observed inside a transaction? */
  countTxDepths: [] as number[],
  txDepth: 0,
  txCommits: 0,
  db: null as unknown as ReturnType<typeof makeDb>,
}));

vi.mock("../src/middleware/auth.js", () => ({ requireAuth: async () => {} }));
vi.mock("../src/auth.js", () => ({
  getAuthUserId: () => H.actorUserId,
  getAuthSessionId: () => "session-hash",
}));
vi.mock("../src/services/identity-security/step-up-middleware.js", () => ({
  requireStepUpForSensitiveAction: async (input: {
    reply: { code: (n: number) => { send: (b: unknown) => void } };
  }) => {
    if (H.stepUpDenies) {
      input.reply.code(401).send({
        error: { code: "STEP_UP_REQUIRED", message: "Step-up required." },
      });
      return { sent: true };
    }
    return { sent: false, verifiedChallengeId: "challenge-1" };
  },
}));
vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: () => undefined,
}));
vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: async (entry: Record<string, unknown>) => {
    H.audits.push(entry);
  },
}));
vi.mock("../src/db.js", () => ({
  prisma: new Proxy(
    {},
    {
      get(_t, prop: string) {
        return (H.db.client as unknown as Record<string, unknown>)[prop];
      },
    },
  ),
}));

// ---------------------------------------------------------------------------
// In-memory transport (transaction-shaped, serialized like a real
// interactive transaction so a concurrency race is observable).
// ---------------------------------------------------------------------------

type MemberRow = {
  id: string;
  teamId: string;
  userId: string;
  role: string;
  status: string;
  accessExpiresAtUtc: Date | null;
};

type UserRow = {
  id: string;
  currentWorkspaceId: string | null;
  identityMode: string;
  managingOrganizationId: string | null;
  managedIdentitySource: string | null;
  managedBySsoConnectionId: string | null;
};

function makeDb(seed: { members: MemberRow[]; users: UserRow[] }) {
  const state = {
    members: seed.members.map((m) => ({ ...m })),
    users: seed.users.map((u) => ({ ...u })),
  };

  const teamOf = () => ({
    isPersonal: false,
    workspaceKind: "ORGANIZATION",
    billingPlan: "ENTERPRISE",
    organization: { status: "ACTIVE" },
  });

  const model = {
    user: {
      findUnique: async (args: { where: { id: string } }) => {
        if (H.identityModeThrows) {
          const err = new Error("column does not exist") as Error & {
            code: string;
          };
          err.code = "P2022";
          throw err;
        }
        return state.users.find((u) => u.id === args.where.id) ?? null;
      },
    },
    teamMember: {
      findUnique: async (args: {
        where: { teamId_userId?: { teamId: string; userId: string }; id?: string };
        include?: unknown;
      }) => {
        const key = args.where.teamId_userId;
        const row = key
          ? state.members.find(
              (m) => m.teamId === key.teamId && m.userId === key.userId,
            )
          : state.members.find((m) => m.id === args.where.id);
        if (!row) return null;
        return args.include
          ? {
              ...row,
              team: teamOf(),
              capabilityGrants: [],
              delegatedAdminScopes: [],
            }
          : { ...row };
      },
      findFirst: async (args: {
        where: { id?: string; teamId?: string };
      }) => {
        const row = state.members.find(
          (m) =>
            (args.where.id === undefined || m.id === args.where.id) &&
            (args.where.teamId === undefined || m.teamId === args.where.teamId),
        );
        return row ? { ...row } : null;
      },
      count: async (args: {
        where: {
          teamId: string;
          id?: { not: string };
          status?: string;
          role?: { in: string[] };
        };
      }) => {
        // Record whether the guard's re-count happened inside a transaction.
        H.countTxDepths.push(H.txDepth);
        return state.members.filter(
          (m) =>
            m.teamId === args.where.teamId &&
            (args.where.id?.not === undefined || m.id !== args.where.id.not) &&
            (args.where.status === undefined || m.status === args.where.status) &&
            (args.where.role?.in === undefined ||
              args.where.role.in.includes(m.role)),
        ).length;
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        H.writes.push("teamMember.update");
        const row = state.members.find((m) => m.id === args.where.id);
        if (!row) throw new Error("member missing");
        Object.assign(row, args.data);
        return { ...row };
      },
    },
  };

  // Any model/method the production path touches incidentally (provenance,
  // risk, projections) is a recorded no-op — it must never mask a real write.
  const fallback = new Proxy(
    {},
    {
      get(_t, modelName: string) {
        if (modelName === "$transaction") {
          return undefined;
        }
        const known = (model as Record<string, unknown>)[modelName];
        if (known) return known;
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return async () => {
                if (/^(create|update|upsert|delete)/.test(method)) {
                  H.writes.push(`${modelName}.${method}`);
                }
                if (method === "findMany") return [];
                if (method === "count") return 0;
                if (method === "updateMany" || method === "deleteMany") {
                  return { count: 0 };
                }
                if (/^(create|upsert)/.test(method)) return { id: "row-1" };
                return null;
              };
            },
          },
        );
      },
    },
  ) as Record<string, unknown>;

  // Serialized interactive transaction: the guard's re-count and the write see
  // one snapshot at a time, exactly as a row-locked transaction would.
  let queue: Promise<unknown> = Promise.resolve();
  const client = new Proxy(fallback, {
    get(target, prop: string) {
      if (prop === "$transaction") {
        return <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
          const run = queue.then(async () => {
            H.txDepth += 1;
            try {
              const out = await fn(client);
              H.txCommits += 1;
              return out;
            } finally {
              H.txDepth -= 1;
            }
          });
          // Keep the chain alive even when a transaction rejects.
          queue = run.then(
            () => undefined,
            () => undefined,
          );
          return run;
        };
      }
      return (target as Record<string, unknown>)[prop];
    },
  });

  return { client, state };
}

function seedDefault() {
  return makeDb({
    members: [
      {
        id: "tm-actor",
        teamId: TEAM,
        userId: ACTOR,
        role: "OWNER",
        status: "ACTIVE",
        accessExpiresAtUtc: null,
      },
      {
        id: MEMBER_A,
        teamId: TEAM,
        userId: USER_A,
        role: "MEMBER",
        status: "ACTIVE",
        accessExpiresAtUtc: null,
      },
      {
        id: MEMBER_MANAGED,
        teamId: TEAM,
        userId: USER_MANAGED,
        role: "MEMBER",
        status: "ACTIVE",
        accessExpiresAtUtc: null,
      },
      {
        id: FOREIGN_MEMBER,
        teamId: OTHER_TEAM,
        userId: USER_FOREIGN,
        role: "MEMBER",
        status: "ACTIVE",
        accessExpiresAtUtc: null,
      },
    ],
    users: [
      {
        id: ACTOR,
        currentWorkspaceId: TEAM,
        identityMode: "STANDARD",
        managingOrganizationId: null,
        managedIdentitySource: null,
        managedBySsoConnectionId: null,
      },
      {
        id: USER_A,
        currentWorkspaceId: TEAM,
        identityMode: "STANDARD",
        managingOrganizationId: null,
        managedIdentitySource: null,
        managedBySsoConnectionId: null,
      },
      {
        id: USER_MANAGED,
        currentWorkspaceId: TEAM,
        // SCIM-owned: the directory is the authority for this membership.
        identityMode: "MANAGED_ENTERPRISE",
        managingOrganizationId: ORG,
        managedIdentitySource: "SCIM",
        managedBySsoConnectionId: null,
      },
      {
        id: USER_FOREIGN,
        currentWorkspaceId: OTHER_TEAM,
        identityMode: "STANDARD",
        managingOrganizationId: null,
        managedIdentitySource: null,
        managedBySsoConnectionId: null,
      },
    ],
  });
}

const { identityRoutes } = await import("../src/routes/identity.routes.js");
const { changeMemberRole, suspendMember, RbacError } = await import(
  "../src/services/identity/membership-provisioning.service.js"
);

let app: FastifyInstance;

beforeEach(async () => {
  H.writes.length = 0;
  H.audits.length = 0;
  H.countTxDepths.length = 0;
  H.txDepth = 0;
  H.txCommits = 0;
  H.stepUpDenies = false;
  H.identityModeThrows = false;
  H.actorUserId = ACTOR;
  H.db = seedDefault();
  app = Fastify();
  await app.register(identityRoutes);
  await app.ready();
});

function suspend(memberId: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: `/v1/identity/members/${memberId}/suspend`,
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    payload,
  });
}

const MUTATIONS = /teamMember\.update/;

// ---------------------------------------------------------------------------
// 1 + 2 — server-derived scope + concealed cross-Organization denial
// ---------------------------------------------------------------------------

describe("scope is server-derived and cross-Organization targets are concealed", () => {
  it("a member of another Organization is byte-identical to a member that does not exist", async () => {
    const foreign = await suspend(FOREIGN_MEMBER);
    const missing = await suspend(MISSING_MEMBER);

    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    // No 403-with-detail, no "exists elsewhere" hint: the SAME bare shape.
    expect(JSON.parse(foreign.body)).toEqual({ error: { code: "not_found" } });
    expect(JSON.parse(foreign.body)).toEqual(JSON.parse(missing.body));
    expect(H.writes.filter((w) => MUTATIONS.test(w))).toEqual([]);
  });

  it("a declared teamId that disagrees with the persisted scope is refused (404), never honoured", async () => {
    const res = await suspend(MEMBER_A, { teamId: OTHER_TEAM });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: { code: "not_found" } });
    expect(H.writes.filter((w) => MUTATIONS.test(w))).toEqual([]);
    // The same target succeeds when no conflicting scope is declared, proving
    // the refusal came from the mismatch and not from the target itself.
    const ok = await suspend(MEMBER_A);
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).member.status).toBe("SUSPENDED");
  });

  it("an authorized transition audits BOTH the actor and the target identity", async () => {
    const res = await suspend(MEMBER_A);
    expect(res.statusCode).toBe(200);
    const entry = H.audits.find(
      (a) => a.action === "identity.member.suspend",
    ) as { actorUserId?: string; resourceId?: string; metadata?: Record<string, unknown> };
    expect(entry).toBeTruthy();
    expect(entry.actorUserId).toBe(ACTOR);
    expect(entry.resourceId).toBe(MEMBER_A);
    expect(entry.metadata?.subjectUserId).toBe(USER_A);
  });

  it("a non-member actor gets 404 with ZERO mutation (no membership oracle)", async () => {
    H.actorUserId = "99999999-9999-4999-8999-999999999999";
    const res = await suspend(MEMBER_A);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: { code: "not_found" } });
    expect(H.writes.filter((w) => MUTATIONS.test(w))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3 — managed identities are not mutable through the unmanaged path
// ---------------------------------------------------------------------------

describe("managed (SCIM/SSO-owned) identities are read-only here", () => {
  it("refuses a SCIM-owned member with a bounded 409 and ZERO mutation", async () => {
    const res = await suspend(MEMBER_MANAGED);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: { code: "managed_identity_readonly" },
    });
    expect(H.writes.filter((w) => MUTATIONS.test(w))).toEqual([]);
  });

  it("fails CLOSED when identity ownership cannot be resolved (never assumes unmanaged)", async () => {
    H.identityModeThrows = true;
    const res = await suspend(MEMBER_A);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe("identity_mode_unavailable");
    expect(H.writes.filter((w) => MUTATIONS.test(w))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4 — step-up denial mutates nothing
// ---------------------------------------------------------------------------

describe("step-up denial", () => {
  it("a denied step-up leaves the membership untouched", async () => {
    H.stepUpDenies = true;
    const res = await suspend(MEMBER_A);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("STEP_UP_REQUIRED");
    expect(H.writes.filter((w) => MUTATIONS.test(w))).toEqual([]);
    expect(H.db.state.members.find((m) => m.id === MEMBER_A)?.status).toBe(
      "ACTIVE",
    );
    // No transaction was even opened for the refused mutation.
    expect(H.txCommits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5 — last-administrator protection is ATOMIC
// ---------------------------------------------------------------------------

describe("last-administrator protection (atomic, under concurrency)", () => {
  function seedTwoAdmins() {
    return makeDb({
      members: [
        {
          id: "tm-actor",
          teamId: TEAM,
          userId: ACTOR,
          role: "ADMIN",
          status: "ACTIVE",
          accessExpiresAtUtc: null,
        },
        {
          id: MEMBER_A,
          teamId: TEAM,
          userId: USER_A,
          role: "ADMIN",
          status: "ACTIVE",
          accessExpiresAtUtc: null,
        },
        {
          id: MEMBER_B,
          teamId: TEAM,
          userId: USER_B,
          role: "ADMIN",
          status: "ACTIVE",
          accessExpiresAtUtc: null,
        },
      ],
      users: [],
    });
  }

  it("two concurrent demotions of the last two administrators cannot both commit", async () => {
    // Three ADMINs; the actor keeps its own row (self-action is refused), so
    // demoting BOTH others would leave exactly one — allowed. To force the
    // race, demote the actor's two peers when only they and the actor exist
    // AFTER the actor itself is suspended out of the administrative tier.
    const db = seedTwoAdmins();
    H.db = db;
    // Remove the actor from the ACTIVE administrative tier so that MEMBER_A and
    // MEMBER_B are the last two administrators.
    db.state.members.find((m) => m.id === "tm-actor")!.status = "SUSPENDED";

    const results = await Promise.allSettled([
      changeMemberRole(
        {
          teamId: TEAM,
          teamMemberId: MEMBER_A,
          actorUserId: ACTOR,
          newRole: "VIEWER" as never,
        },
        db.client as never,
      ),
      changeMemberRole(
        {
          teamId: TEAM,
          teamMemberId: MEMBER_B,
          actorUserId: ACTOR,
          newRole: "VIEWER" as never,
        },
        db.client as never,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      RbacError,
    );
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe(
      "last_administrator_protected",
    );

    // The workspace still has an administrator — the invariant held.
    const remaining = db.state.members.filter(
      (m) => m.status === "ACTIVE" && (m.role === "ADMIN" || m.role === "OWNER"),
    );
    expect(remaining).toHaveLength(1);

    // And the guard's re-count ran INSIDE a transaction every time.
    expect(H.countTxDepths.length).toBeGreaterThan(0);
    expect(H.countTxDepths.every((depth) => depth > 0)).toBe(true);
  });

  it("refuses to suspend the only remaining administrator (zero mutation)", async () => {
    const db = makeDb({
      members: [
        {
          id: "tm-actor",
          teamId: TEAM,
          userId: ACTOR,
          role: "ADMIN",
          status: "ACTIVE",
          accessExpiresAtUtc: null,
        },
        {
          id: MEMBER_A,
          teamId: TEAM,
          userId: USER_A,
          role: "ADMIN",
          status: "ACTIVE",
          accessExpiresAtUtc: null,
        },
      ],
      users: [],
    });
    H.db = db;
    // The actor is not in the ACTIVE administrative tier, so MEMBER_A is the
    // last administrator standing.
    db.state.members.find((m) => m.id === "tm-actor")!.status = "SUSPENDED";

    await expect(
      suspendMember(
        {
          teamId: TEAM,
          teamMemberId: MEMBER_A,
          actorUserId: ACTOR,
        },
        db.client as never,
      ),
    ).rejects.toMatchObject({ code: "last_administrator_protected" });

    expect(db.state.members.find((m) => m.id === MEMBER_A)?.status).toBe(
      "ACTIVE",
    );
    expect(H.writes.filter((w) => MUTATIONS.test(w))).toEqual([]);
  });

  it("a demotion that leaves another administrator standing is allowed", async () => {
    const db = seedTwoAdmins();
    H.db = db;
    const updated = await changeMemberRole(
      {
        teamId: TEAM,
        teamMemberId: MEMBER_A,
        actorUserId: ACTOR,
        newRole: "VIEWER" as never,
      },
      db.client as never,
    );
    expect(updated.role).toBe("VIEWER");
    expect(
      db.state.members.filter(
        (m) => m.status === "ACTIVE" && m.role === "ADMIN",
      ),
    ).toHaveLength(2);
  });
});
