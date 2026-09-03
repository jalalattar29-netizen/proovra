/**
 * PHASE 12B — CONSOLIDATED ENTERPRISE_IDENTITY_SECURITY PRODUCTION-ENTRY MATRIX.
 *
 * ONE suite for the whole vertical. It drives REAL production entry points —
 * fastify `inject` through the real route handlers, and the real service
 * functions over an in-memory Prisma transport. Only process boundaries
 * (auth resolution, the DB driver, SMS delivery) are mocked; every authority
 * under test is production code.
 *
 * Structural scans are used ONLY for uniqueness / deletion guards and are
 * labelled as such — never as behavioral proof.
 *
 * SECTIONS
 *   1. Shared authority — atomic policy versioning (B1)
 *   2. Shared authority — target-bound step-up (B3)
 *   3. Support Access + Break-Glass (C10)
 *   4. Organization Security Policy (C1)
 *
 * Later sections are appended here as each product system lands — this file is
 * the ONE consolidated matrix for the vertical, not one file per surface.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// ===========================================================================
// SECTION 1 — ATOMIC POLICY VERSIONING (B1)
//
// `upsertWorkspaceAiPolicy` used to read the row, compare `policyVersion` in
// application memory, then issue an unconditional `update`. Two administrators
// saving concurrently BOTH passed the comparison and BOTH wrote: last-write-
// wins, one change silently lost, and both callers got HTTP 200 plus a success
// audit event for a mutation that had already been overwritten.
//
// The transport below models the ONE property that makes the fix work: an
// `updateMany` whose `where` includes `policyVersion` matches nothing once a
// concurrent writer has bumped it. If the production code ever reverts to a
// read-compare-write, "exactly one winner" fails here.
// ===========================================================================

type PolicyRow = {
  teamId: string;
  policyVersion: number;
  aiEnabled: boolean;
  supportChatEnabled: boolean;
  updatedByUserId: string | null;
  createdByUserId: string | null;
};

const POLICY_TEAM = "11111111-1111-4111-8111-111111111111";

function makePolicyWorld(seed?: PolicyRow) {
  const rows: PolicyRow[] = seed ? [seed] : [];
  /** Every write the transport actually performed — the mutation ledger. */
  const writes: string[] = [];

  const workspaceAiPolicy = {
    // Real Prisma returns a SNAPSHOT, not a live handle on the stored row. The
    // copy matters: `upsertWorkspaceAiPolicy` returns the pre-write row as
    // `previous` for the before/after audit, and a live handle would show the
    // post-increment version there.
    findUnique: async (args: { where: { teamId: string } }) => {
      const row = rows.find((r) => r.teamId === args.where.teamId);
      return row ? { ...row } : null;
    },
    findUniqueOrThrow: async (args: { where: { teamId: string } }) => {
      const row = rows.find((r) => r.teamId === args.where.teamId);
      if (!row) throw new Error("policy row missing");
      return { ...row };
    },
    updateMany: async (args: {
      where: { teamId: string; policyVersion?: number };
      data: Record<string, unknown>;
    }) => {
      const matched = rows.filter(
        (r) =>
          r.teamId === args.where.teamId &&
          (args.where.policyVersion === undefined ||
            r.policyVersion === args.where.policyVersion),
      );
      for (const row of matched) {
        for (const [k, v] of Object.entries(args.data)) {
          if (
            v !== null &&
            typeof v === "object" &&
            "increment" in (v as Record<string, unknown>)
          ) {
            (row as unknown as Record<string, number>)[k] +=
              (v as { increment: number }).increment;
          } else {
            (row as unknown as Record<string, unknown>)[k] = v;
          }
        }
        writes.push(`update:${row.teamId}`);
      }
      return { count: matched.length };
    },
    create: async (args: { data: PolicyRow }) => {
      if (rows.some((r) => r.teamId === args.data.teamId)) {
        const err = new Error("unique constraint") as Error & { code: string };
        err.code = "P2002";
        throw err;
      }
      // The service does not set policyVersion on create (the column defaults
      // to 1 in the schema), so the transport supplies the default only when
      // the payload omits it.
      const row: PolicyRow = { ...args.data, policyVersion: args.data.policyVersion ?? 1 };
      rows.push(row);
      writes.push(`create:${row.teamId}`);
      return row;
    },
  };

  return { rows, writes, client: { workspaceAiPolicy } };
}

// ONE mutable Prisma transport handle for the whole file. Services import the
// module-level singleton, so this is the single seam every section swaps.
//
// `vi.mock` is hoisted to the top of the module, so a mock declared anywhere in
// this file applies to ALL of it. That is why the step-up middleware is NOT
// mocked here: section 3 needs the REAL middleware (section 2 proves it), so
// section 3 seeds real challenge rows in this transport instead of stubbing the
// gate. A file-wide middleware stub would have made section 2 assert against
// its own mock.
const DB = vi.hoisted(() => ({ client: {} as Record<string, unknown> }));

vi.mock("../src/db.js", () => ({
  get prisma() {
    return DB.client as never;
  },
}));
vi.mock("../src/config/runtime-secrets.js", () => ({
  getSecret: () => "test-key",
}));

const P = { policy: null as null | ReturnType<typeof makePolicyWorld> };

function makePolicyWorldOuter(seed?: PolicyRow) {
  const world = makePolicyWorld(seed);
  DB.client = world.client as unknown as Record<string, unknown>;
  return world;
}

describe("PHASE 12B B1 — atomic workspace AI policy versioning", () => {
  beforeEach(() => {
    P.policy = null;
  });

  const baseRow = (): PolicyRow => ({
    teamId: POLICY_TEAM,
    policyVersion: 3,
    aiEnabled: true,
    supportChatEnabled: true,
    updatedByUserId: null,
    createdByUserId: null,
  });

  it("a matching expectedVersion writes once and increments the version once", async () => {
    P.policy = makePolicyWorldOuter(baseRow());
    const { upsertWorkspaceAiPolicy } = await import(
      "../src/services/ai/workspace-ai-policy.service.js"
    );

    const { row, previous } = await upsertWorkspaceAiPolicy({
      teamId: POLICY_TEAM,
      actorUserId: "admin-a",
      patch: { aiEnabled: false },
      expectedVersion: 3,
    });

    expect(row.policyVersion).toBe(4);
    expect(row.aiEnabled).toBe(false);
    expect(previous?.policyVersion).toBe(3);
    expect(P.policy!.writes).toEqual([`update:${POLICY_TEAM}`]);
  });

  it("EXACTLY ONE of two concurrent writers wins; the loser mutates nothing", async () => {
    P.policy = makePolicyWorldOuter(baseRow());
    const { upsertWorkspaceAiPolicy, WorkspaceAiPolicyVersionConflictError } =
      await import("../src/services/ai/workspace-ai-policy.service.js");

    // Both administrators read version 3 and save. The DATABASE decides.
    const results = await Promise.allSettled([
      upsertWorkspaceAiPolicy({
        teamId: POLICY_TEAM,
        actorUserId: "admin-a",
        patch: { aiEnabled: false },
        expectedVersion: 3,
      }),
      upsertWorkspaceAiPolicy({
        teamId: POLICY_TEAM,
        actorUserId: "admin-b",
        patch: { supportChatEnabled: false },
        expectedVersion: 3,
      }),
    ]);

    const winners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r) => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const loser = (losers[0] as PromiseRejectedResult).reason;
    expect(loser).toBeInstanceOf(WorkspaceAiPolicyVersionConflictError);
    // Stable wire code the client reconciles on.
    expect(loser.code).toBe("POLICY_VERSION_CONFLICT");
    expect(loser.currentVersion).toBe(4);

    // Version incremented EXACTLY once, and exactly one write was performed.
    expect(P.policy!.rows[0]!.policyVersion).toBe(4);
    expect(P.policy!.writes).toEqual([`update:${POLICY_TEAM}`]);
  });

  it("a stale expectedVersion is rejected with ZERO mutation", async () => {
    P.policy = makePolicyWorldOuter(baseRow());
    const { upsertWorkspaceAiPolicy } = await import(
      "../src/services/ai/workspace-ai-policy.service.js"
    );

    await expect(
      upsertWorkspaceAiPolicy({
        teamId: POLICY_TEAM,
        actorUserId: "admin-c",
        patch: { aiEnabled: false },
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "POLICY_VERSION_CONFLICT" });

    expect(P.policy!.writes).toEqual([]);
    expect(P.policy!.rows[0]!.policyVersion).toBe(3);
    expect(P.policy!.rows[0]!.aiEnabled).toBe(true);
  });

  it("an omitted expectedVersion still pins the predicate to the version read", async () => {
    P.policy = makePolicyWorldOuter(baseRow());
    const { upsertWorkspaceAiPolicy } = await import(
      "../src/services/ai/workspace-ai-policy.service.js"
    );
    // A caller that simply omits expectedVersion must not be able to clobber an
    // interleaved writer: the predicate is pinned to the version just read.
    const { row } = await upsertWorkspaceAiPolicy({
      teamId: POLICY_TEAM,
      actorUserId: "admin-d",
      patch: { aiEnabled: false },
    });
    expect(row.policyVersion).toBe(4);
    expect(P.policy!.writes).toEqual([`update:${POLICY_TEAM}`]);
  });

  it("a CONCURRENT create race has a deterministic first-writer conflict path", async () => {
    P.policy = makePolicyWorldOuter(); // no row yet
    const { upsertWorkspaceAiPolicy, WorkspaceAiPolicyVersionConflictError } =
      await import("../src/services/ai/workspace-ai-policy.service.js");

    // Both writers must observe "no policy yet" BEFORE either has created one —
    // that is the actual race. (Sequentially, the second caller correctly sees
    // the row and takes the UPDATE path instead, which is a different case,
    // covered above.)
    const results = await Promise.allSettled([
      upsertWorkspaceAiPolicy({
        teamId: POLICY_TEAM,
        actorUserId: "admin-a",
        patch: { aiEnabled: true },
      }),
      upsertWorkspaceAiPolicy({
        teamId: POLICY_TEAM,
        actorUserId: "admin-b",
        patch: { aiEnabled: false },
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    // The loser takes the unique violation and is reported as a version
    // conflict — never a crash, never a second row.
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      WorkspaceAiPolicyVersionConflictError,
    );
    expect(P.policy!.rows).toHaveLength(1);
    expect(P.policy!.writes).toEqual([`create:${POLICY_TEAM}`]);
  });

  it("expectedVersion against a non-existent policy is a stale read, not a create", async () => {
    P.policy = makePolicyWorldOuter();
    const { upsertWorkspaceAiPolicy } = await import(
      "../src/services/ai/workspace-ai-policy.service.js"
    );
    await expect(
      upsertWorkspaceAiPolicy({
        teamId: POLICY_TEAM,
        actorUserId: "admin-a",
        patch: { aiEnabled: false },
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "POLICY_VERSION_CONFLICT" });
    expect(P.policy!.writes).toEqual([]);
    expect(P.policy!.rows).toHaveLength(0);
  });
});

// ===========================================================================
// SECTION 2 — TARGET-BOUND STEP-UP (B3)
//
// The challenge must be bound to session + user + purpose + target Organization
// + target workspace + expiry, and consumed exactly once. Every denial must
// leave the caller's mutation unperformed.
//
// These drive the REAL `consumeApprovedChallenge` / `checkStepUpChallenge`.
// ===========================================================================

const SU_TEAM_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SU_TEAM_B = "bbbbbbbb-1111-4111-8111-111111111111";
const ORG_A = "aaaaaaaa-2222-4222-8222-222222222222";
const ORG_B = "bbbbbbbb-2222-4222-8222-222222222222";
const SU_USER = "cccccccc-3333-4333-8333-333333333333";
const SU_OTHER_USER = "dddddddd-3333-4333-8333-333333333333";
const SU_SESSION = "session-hash-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SU_OTHER_SESSION = "session-hash-bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SU_CHAL = "eeeeeeee-4444-4444-8444-444444444444";
const SU_TARGET = "ffffffff-5555-4555-8555-555555555555";
/**
 * PHASE 13 (NEW-058) — the ENROLLED FACTOR the challenge was minted against.
 *
 * Before this, a challenge carried no factor: its destination came from the
 * request body, so an approved elevation proved possession of a handset the
 * CALLER chose. Both the approval and the SPEND paths now re-read the factor,
 * so the world has to hold one — and holding one is what lets the two new
 * negative cases below (revoked factor, superseded generation) exist at all.
 */
const SU_FACTOR = "aaaaaaaa-6666-4666-8666-666666666666";
const SU_FACTOR_GENERATION = 3;

type ChalRow = {
  id: string;
  teamId: string;
  organizationId: string | null;
  sessionIdHash: string | null;
  initiatedByUserId: string;
  status: string;
  purpose: string;
  resourceKind: string | null;
  resourceId: string | null;
  expiresAtUtc: Date;
  approvedAtUtc: Date | null;
  verificationAttemptId: string | null;
  factorId: string | null;
  factorGeneration: number | null;
};

function makeStepUpWorld(overrides: Partial<ChalRow> = {}) {
  const row: ChalRow = {
    id: SU_CHAL,
    teamId: SU_TEAM_A,
    organizationId: ORG_A,
    sessionIdHash: SU_SESSION,
    initiatedByUserId: SU_USER,
    status: "APPROVED",
    purpose: "MEMBER_ROLE_CHANGE",
    resourceKind: "MEMBER",
    resourceId: SU_TARGET,
    expiresAtUtc: new Date(Date.now() + 10 * 60_000),
    approvedAtUtc: new Date(),
    verificationAttemptId: null,
    factorId: SU_FACTOR,
    factorGeneration: SU_FACTOR_GENERATION,
    ...overrides,
  };
  const rows: ChalRow[] = [row];
  /** Workspace → Organization, as persisted. */
  const teams = [
    { id: SU_TEAM_A, organizationId: ORG_A },
    { id: SU_TEAM_B, organizationId: ORG_B },
  ];
  /** Mutations the CALLER performed past the gate. */
  const mutations: string[] = [];

  /** The enrolled factor this challenge was minted against. */
  let factor: {
    id: string;
    userId: string;
    status: string;
    revokedAt: Date | null;
    verifiedAtUtc: Date | null;
    generation: number;
  } | null = {
    id: SU_FACTOR,
    userId: SU_USER,
    status: "ACTIVE",
    revokedAt: null,
    verifiedAtUtc: new Date(),
    generation: SU_FACTOR_GENERATION,
  };

  const client = {
    stepUpChallenge: {
      findFirst: async (args: { where: { id: string; teamId: string } }) =>
        rows.find(
          (r) => r.id === args.where.id && r.teamId === args.where.teamId,
        ) ?? null,
      findUniqueOrThrow: async (args: { where: { id: string } }) => {
        const found = rows.find((r) => r.id === args.where.id);
        if (!found) throw new Error("missing");
        return found;
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const found = rows.find((r) => r.id === args.where.id);
        if (found) Object.assign(found, args.data);
        return found;
      },
      updateMany: async (args: {
        where: { id: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        const matched = rows.filter(
          (r) =>
            r.id === args.where.id &&
            (args.where.status === undefined || r.status === args.where.status),
        );
        for (const m of matched) Object.assign(m, args.data);
        return { count: matched.length };
      },
    },
    team: {
      findUnique: async (args: { where: { id: string } }) =>
        teams.find((t) => t.id === args.where.id) ?? null,
    },
    /**
     * The enrolled factor, as the consume path re-reads it.
     *
     * `factor` is mutable so a case can revoke it or move its generation
     * BETWEEN approval and spend — which is the window NEW-058 closes and the
     * reason the check lives on the consume path rather than only on approval.
     */
    mfaFactor: {
      findFirst: async (args: {
        where: {
          id: string;
          userId: string;
          status?: string;
          revokedAt?: unknown;
          verifiedAtUtc?: unknown;
        };
      }) => {
        if (factor === null) return null;
        if (args.where.id !== factor.id) return null;
        if (args.where.userId !== factor.userId) return null;
        if (factor.status !== "ACTIVE") return null;
        if (factor.revokedAt !== null) return null;
        if (factor.verifiedAtUtc === null) return null;
        return { generation: factor.generation };
      },
    },
    riskSignal: { findMany: async () => [] },
    securityEvent: { create: async () => ({ id: "sec" }) },
  };
  return { rows, mutations, client, factorRef: () => factor, setFactor: (f: typeof factor) => { factor = f; } };
}

/** The canonical route shape: gate, THEN mutate. */
async function guardedMutation(
  world: ReturnType<typeof makeStepUpWorld>,
  opts: {
    teamId?: string;
    userId?: string;
    sessionIdHash?: string | null;
    purpose?: string;
    resourceId?: string | null;
    header?: string | null;
  } = {},
) {
  const { requireStepUpForSensitiveAction } = await import(
    "../src/services/identity-security/step-up-middleware.js"
  );
  const captured: { statusCode: number | null; body: unknown } = {
    statusCode: null,
    body: null,
  };
  const reply = {
    code(n: number) {
      captured.statusCode = n;
      return reply;
    },
    send(b: unknown) {
      captured.body = b;
      return reply;
    },
  };
  const header = opts.header === undefined ? SU_CHAL : opts.header;
  const req = {
    headers: header ? { "x-proovra-step-up-challenge-id": header } : {},
    // The middleware reads the session from the AUTHENTICATED request.
    user: {
      sessionIdHash:
        opts.sessionIdHash === undefined ? SU_SESSION : opts.sessionIdHash,
    },
  };
  const outcome = await requireStepUpForSensitiveAction(
    {
      req: req as never,
      reply: reply as never,
      teamId: opts.teamId ?? SU_TEAM_A,
      userId: opts.userId ?? SU_USER,
      purpose: (opts.purpose ?? "MEMBER_ROLE_CHANGE") as never,
      resourceKind: "MEMBER",
      resourceId: opts.resourceId === undefined ? SU_TARGET : opts.resourceId,
    },
    world.client as never,
  );
  if (!outcome.sent) world.mutations.push("member.role.changed");
  return { outcome, reply: captured, mutations: world.mutations };
}

describe("PHASE 12B B3 — target-bound step-up", () => {
  it("a valid, fully bound challenge mutates exactly once and is consumed", async () => {
    const w = makeStepUpWorld();
    const r = await guardedMutation(w);
    expect(r.outcome.sent).toBe(false);
    expect(r.mutations).toEqual(["member.role.changed"]);
    expect(w.rows[0]!.status).not.toBe("APPROVED");
  });

  it("REPLAY of a consumed challenge is denied with zero further mutation", async () => {
    const w = makeStepUpWorld();
    await guardedMutation(w);
    const replay = await guardedMutation(w);
    expect(replay.outcome.sent).toBe(true);
    expect(replay.reply.statusCode).toBe(401);
    expect(w.mutations).toEqual(["member.role.changed"]);
  });

  it("an EXPIRED challenge is denied with zero mutation", async () => {
    const w = makeStepUpWorld({ expiresAtUtc: new Date(Date.now() - 1_000) });
    const r = await guardedMutation(w);
    expect(r.outcome.sent).toBe(true);
    expect(r.mutations).toEqual([]);
    expect(w.rows[0]!.status).toBe("EXPIRED");
  });

  it("a WRONG-PURPOSE challenge is denied and stays unconsumed", async () => {
    const w = makeStepUpWorld();
    const r = await guardedMutation(w, { purpose: "MEMBER_REVOKE" });
    expect(r.outcome.sent).toBe(true);
    expect(r.mutations).toEqual([]);
    // An approval for a DIFFERENT action must not be burned.
    expect(w.rows[0]!.status).toBe("APPROVED");
  });

  it("a WRONG-USER challenge is denied with zero mutation", async () => {
    const w = makeStepUpWorld();
    const r = await guardedMutation(w, { userId: SU_OTHER_USER });
    expect(r.outcome.sent).toBe(true);
    expect(r.mutations).toEqual([]);
    expect(w.rows[0]!.status).toBe("APPROVED");
  });

  it("a WRONG-SESSION challenge is denied with zero mutation", async () => {
    const w = makeStepUpWorld();
    const r = await guardedMutation(w, { sessionIdHash: SU_OTHER_SESSION });
    expect(r.outcome.sent).toBe(true);
    expect(r.reply.statusCode).toBe(401);
    expect(r.mutations).toEqual([]);
    expect(w.rows[0]!.status).toBe("APPROVED");
  });

  it("a session-less caller cannot spend a session-bound challenge", async () => {
    const w = makeStepUpWorld();
    const r = await guardedMutation(w, { sessionIdHash: null });
    expect(r.outcome.sent).toBe(true);
    expect(r.mutations).toEqual([]);
    expect(w.rows[0]!.status).toBe("APPROVED");
  });

  it("a WRONG-TARGET challenge is denied with zero mutation", async () => {
    const w = makeStepUpWorld();
    const r = await guardedMutation(w, {
      resourceId: "99999999-5555-4555-8555-555555555555",
    });
    expect(r.outcome.sent).toBe(true);
    expect(r.mutations).toEqual([]);
    expect(w.rows[0]!.status).toBe("APPROVED");
  });

  it("an Organization-A challenge cannot mutate Organization B, even for an admin of both", async () => {
    // The row is minted for team A / org A. The caller now aims the SAME
    // challenge id at team B (org B) — the arbitrary request-declared teamId
    // case. Both the workspace binding and the Organization binding must refuse.
    const w = makeStepUpWorld();
    const r = await guardedMutation(w, { teamId: SU_TEAM_B });
    expect(r.outcome.sent).toBe(true);
    expect(r.reply.statusCode).toBe(401);
    expect(r.mutations).toEqual([]);
    expect(w.rows[0]!.status).toBe("APPROVED");
  });

  it("a challenge whose Organization no longer matches the workspace is refused", async () => {
    // Same workspace id, but the row carries a DIFFERENT Organization than the
    // workspace is currently parented to (re-parenting / stale mint).
    const w = makeStepUpWorld({ organizationId: ORG_B });
    const r = await guardedMutation(w);
    expect(r.outcome.sent).toBe(true);
    expect(r.mutations).toEqual([]);
    expect(w.rows[0]!.status).toBe("APPROVED");
  });

  it("a missing challenge yields the structured 401 the client modal opens on", async () => {
    const w = makeStepUpWorld();
    const r = await guardedMutation(w, { header: null });
    expect(r.outcome.sent).toBe(true);
    expect(r.reply.statusCode).toBe(401);
    const body = r.reply.body as {
      error: { code: string; message?: string; details?: { purpose?: string } };
    };
    expect(body.error.code).toBe("STEP_UP_REQUIRED");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.details?.purpose).toBe("MEMBER_ROLE_CHANGE");
    expect(r.mutations).toEqual([]);
  });

  it("a challenge may only be APPROVED from the session that started it", async () => {
    const w = makeStepUpWorld({ status: "PENDING", approvedAtUtc: null });
    const { checkStepUpChallenge, StepUpError } = await import(
      "../src/services/identity-security/step-up.service.js"
    );
    await expect(
      checkStepUpChallenge(
        {
          teamId: SU_TEAM_A,
          userId: SU_USER,
          challengeId: SU_CHAL,
          code: "123456",
          // PHASE 13 (NEW-058): the destination is no longer an input. It is
          // re-resolved from the factor the challenge was minted against, so a
          // caller cannot verify against a different number than the one the
          // code was sent to.
          sessionIdHash: SU_OTHER_SESSION,
        },
        w.client as never,
      ),
    ).rejects.toBeInstanceOf(StepUpError);
    // Still PENDING — the wrong session did not advance the challenge.
    expect(w.rows[0]!.status).toBe("PENDING");
  });
});

// ===========================================================================
// SECTION 3 — SUPPORT ACCESS AND BREAK-GLASS (C10)
//
// Restricted INTERNAL STAFF capabilities. Before this pass the family gated on
// `identity.org_policy.manage` — a CUSTOMER capability — so an Organization
// admin holding it in their own workspace could mint a support grant over their
// own Organization and enter support context with it.
//
// Driven through the REAL `enterpriseSecurityRoutes` handlers via fastify
// inject; only the auth/staff/db/service process boundaries are mocked.
// ===========================================================================

const S = vi.hoisted(() => ({
  // Real UUIDs — these flow through zod-validated request bodies.
  actorUserId: "11111111-aaaa-4aaa-8aaa-111111111111",
  isStaff: true,
  authAllowed: true,
  approverIsOrgAdmin: true,
  /** Section 4 sets this: the caller IS an org admin of the subject org. */
  actorIsOrgAdmin: false,
  writes: [] as string[],
  supportGrantRows: [] as Array<Record<string, unknown>>,
  emergencyGrantRows: [] as Array<Record<string, unknown>>,
  // Section 4 — what the OrganizationSecurityPolicy authority actually received.
  lastPatch: null as null | Record<string, unknown>,
  lastExpectedVersion: undefined as number | null | undefined,
  policyApplicability: "ORGANIZATION" as "ORGANIZATION" | "NOT_APPLICABLE",
  policyNotProvisioned: false,
  staleVersion: false,
}));

vi.mock("../src/auth.js", () => ({
  getAuthUserId: () => S.actorUserId,
  getAuthSessionId: () => "support-session-hash",
}));
vi.mock("../src/middleware/auth.js", () => ({ requireAuth: async () => {} }));
vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async (
    _req: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => void } },
  ) => {
    if (!S.authAllowed) {
      reply.code(403).send({ error: { code: "permission_denied" } });
      return null;
    }
    return { actorUserId: S.actorUserId, teamId: "ws-1" };
  },
}));
vi.mock("../src/middleware/authorize-emergency.js", () => ({
  authorizeWithEmergencyOverlay: async () => ({
    actorUserId: S.actorUserId,
    viaEmergency: true,
    emergencyCapability: "session.revoke",
  }),
}));
// The staff gate under test — the REAL route calls this resolver.
vi.mock("../src/services/platform-admin.service.js", () => ({
  isPlatformAdmin: async () => S.isStaff,
}));
// NOTE: `step-up-middleware` is deliberately NOT mocked — see the DB comment.
// Section 3 exercises the REAL gate over seeded challenge rows.
vi.mock("../src/services/organization/org-access.js", () => ({
  checkOrgAccess: async (
    _p: unknown,
    args: { userId: string; minRole: string },
  ) => {
    // Two DIFFERENT questions reach this helper:
    //   * "is the CALLER an org admin?" — asked by requireOrgPolicyAdmin on the
    //     OrganizationSecurityPolicy routes (section 4).
    //   * "is the DECLARED APPROVER an org admin?" — asked by
    //     /v1/support-access/start (section 3). There the support actor must
    //     NOT be an org admin of the customer org, which is the whole point.
    if (args.userId === S.actorUserId) {
      return S.actorIsOrgAdmin ? { kind: "ok" } : { kind: "forbidden" };
    }
    return S.approverIsOrgAdmin ? { kind: "ok" } : { kind: "forbidden" };
  },
}));
vi.mock("../src/services/identity/org-security-policy.service.js", () => ({
  resolveOrgPolicyByOrgId: async () => {
    if (S.policyNotProvisioned) {
      const e = new Error("no policy") as Error & { statusCode: number; code: string };
      e.statusCode = 503;
      e.code = "POLICY_NOT_PROVISIONED";
      throw e;
    }
    if (S.policyApplicability === "NOT_APPLICABLE") {
      return { applicability: "NOT_APPLICABLE", reason: "PERSONAL" };
    }
    return {
      applicability: "ORGANIZATION",
      organizationId: ORG,
      policy: { policyVersion: 1 },
    };
  },
  orgCanonicalTeamId: async () => WS,
  applySecurityPolicyPatch: async (i: {
    patch: Record<string, unknown>;
    expectedPolicyVersion?: number | null;
  }) => {
    if (S.staleVersion) {
      const e = new Error("stale") as Error & {
        statusCode: number;
        code: string;
        details: unknown;
      };
      e.statusCode = 409;
      e.code = "POLICY_VERSION_CONFLICT";
      e.details = { expected: i.expectedPolicyVersion, current: 7 };
      throw e;
    }
    S.lastPatch = i.patch;
    S.lastExpectedVersion = i.expectedPolicyVersion;
    S.writes.push("applySecurityPolicyPatch");
    return { policyVersion: 2, ...i.patch };
  },
  checkHighSecurityReadiness: async () => ({ readiness: { ok: true } }),
  activateHighSecurityMode: async () => ({
    ok: true,
    policy: {},
    affectedSessionUserCount: 4,
  }),
}));
vi.mock("../src/services/identity/break-glass.service.js", () => ({
  activateBreakGlass: async () => {
    S.writes.push("activateBreakGlass");
    return {
      id: "bg-1",
      grantedRole: "EMERGENCY_READ_ONLY",
      expiresAtUtc: new Date(),
    };
  },
  revokeBreakGlass: async () => {
    S.writes.push("revokeBreakGlass");
  },
}));
vi.mock("../src/services/identity/support-access.service.js", () => ({
  startSupportAccess: async () => {
    S.writes.push("startSupportAccess");
    return { id: "sa-1", accessLevel: "READ_ONLY", expiresAtUtc: new Date() };
  },
  revokeSupportAccess: async () => {
    S.writes.push("revokeSupportAccess");
  },
}));
vi.mock("../src/services/access-control/session-quarantine.service.js", () => ({
  emergencyOrgRevoke: async () => {
    S.writes.push("emergencyOrgRevoke");
    return { revokedCount: 2 };
  },
}));
vi.mock("../src/services/identity/support-runtime.service.js", () => ({
  validateGrantForSupportContextEntry: async () => ({
    valid: true,
    grant: { id: "sa-1", supportUserId: S.actorUserId },
  }),
}));
vi.mock("../src/services/identity/support-context-token.service.js", () => ({
  signSupportContextToken: () => "opaque-support-token",
  SUPPORT_CONTEXT_TOKEN_TTL_SECONDS: 900,
}));

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const WS = "bbbbbbbb-0000-4000-8000-000000000002";
const GRANT = "cccccccc-0000-4000-8000-000000000003";
const EMERGENCY_USER = "dddddddd-0000-4000-8000-000000000004";
const APPROVER = "eeeeeeee-0000-4000-8000-000000000005";

async function buildSupportApp(): Promise<FastifyInstance> {
  const app = Fastify();
  const { enterpriseSecurityRoutes } = await import(
    "../src/routes/enterprise-security.routes.js"
  );
  await app.register(enterpriseSecurityRoutes);
  await app.ready();
  return app;
}

/** The step-up challenge the break-glass success path spends. */
/** PHASE 13 (NEW-058) — the enrolled factor the break-glass challenge binds to. */
const BG_FACTOR = "bbbbbbbb-7777-4777-8777-777777777777";
const BG_CHALLENGE = "22222222-aaaa-4aaa-8aaa-222222222222";

/**
 * Transport for section 3. Serves the grant read routes AND the REAL step-up
 * gate (challenge row + risk signals + security-event sink), so the gate is
 * genuinely exercised rather than stubbed.
 */
function installSupportTransport(opts: { seedApprovedChallenge: boolean }) {
  const challenges: Array<Record<string, unknown>> = opts.seedApprovedChallenge
    ? [
        {
          id: BG_CHALLENGE,
          teamId: WS,
          organizationId: null,
          sessionIdHash: null,
          initiatedByUserId: S.actorUserId,
          status: "APPROVED",
          purpose: "ORG_SECURITY_POLICY_UPDATE",
          resourceKind: null,
          resourceId: null,
          expiresAtUtc: new Date(Date.now() + 10 * 60_000),
          // PHASE 13 (NEW-058): the consume path re-reads the enrolled factor
          // this challenge was minted against, so a challenge with none is
          // unspendable. That is the fix, not an inconvenience — before it, an
          // elevation survived the enrolment being revoked.
          factorId: BG_FACTOR,
          factorGeneration: 1,
        },
      ]
    : [];
  DB.client = {
    supportAccessGrant: {
      findMany: async () => S.supportGrantRows,
      // The route now reads a COUNT alongside the rows so the page can say
      // "Showing 50 of 137" instead of presenting a capped read as the whole
      // population. A double carrying only findMany turns that into a 500 —
      // the double has to move with the contract it stands in for.
      count: async () => S.supportGrantRows.length,
    },
    emergencyAccessGrant: { findMany: async () => S.emergencyGrantRows },
    stepUpChallenge: {
      findFirst: async (args: { where: { id: string; teamId: string } }) =>
        challenges.find(
          (c) => c.id === args.where.id && c.teamId === args.where.teamId,
        ) ?? null,
      findUniqueOrThrow: async (args: { where: { id: string } }) => {
        const c = challenges.find((x) => x.id === args.where.id);
        if (!c) throw new Error("missing");
        return c;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const c = challenges.find((x) => x.id === args.where.id);
        if (c) Object.assign(c, args.data);
        return c;
      },
      updateMany: async (args: {
        where: { id: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        const matched = challenges.filter(
          (c) =>
            c.id === args.where.id &&
            (args.where.status === undefined || c.status === args.where.status),
        );
        for (const m of matched) Object.assign(m, args.data);
        return { count: matched.length };
      },
    },
    // NEW-058: the enrolled factor, ACTIVE and at the generation the challenge
    // records. A case that wanted to prove the revoked-factor refusal would
    // return null here.
    mfaFactor: {
      findFirst: async (args: { where: { id: string; userId: string } }) =>
        args.where.id === BG_FACTOR && args.where.userId === S.actorUserId
          ? { generation: 1 }
          : null,
    },
    team: { findUnique: async () => ({ id: WS, organizationId: ORG }) },
    riskSignal: { findMany: async () => [] },
    securityEvent: { create: async () => ({ id: "sec" }) },
  };
  return challenges;
}

describe("PHASE 12B C10 — support access + break-glass are platform-staff only", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    S.isStaff = true;
    S.authAllowed = true;
    S.approverIsOrgAdmin = true;
    S.writes = [];
    S.supportGrantRows = [];
    S.emergencyGrantRows = [];
    installSupportTransport({ seedApprovedChallenge: false });
    app = await buildSupportApp();
  });

  const STAFF_ROUTES: Array<{ method: "POST" | "GET"; url: string; payload?: unknown }> = [
    {
      method: "POST",
      url: "/v1/support-access/start",
      payload: { teamId: WS, organizationId: ORG, reason: "incident 4821 triage" },
    },
    {
      method: "POST",
      url: "/v1/support-access/revoke",
      payload: { teamId: WS, grantId: GRANT },
    },
    {
      method: "POST",
      url: "/v1/support-access/enter",
      payload: { teamId: WS, grantId: GRANT },
    },
    {
      method: "POST",
      url: "/v1/break-glass/activate",
      payload: {
        teamId: WS,
        organizationId: ORG,
        emergencyUserId: EMERGENCY_USER,
        reason: "primary on-call unreachable",
      },
    },
    {
      method: "POST",
      url: "/v1/break-glass/revoke",
      payload: { teamId: WS, grantId: GRANT },
    },
    { method: "GET", url: "/v1/support-access/grants" },
    { method: "GET", url: "/v1/break-glass/grants" },
  ];

  for (const route of STAFF_ROUTES) {
    it(`${route.method} ${route.url} — a NON-STAFF caller is concealed-denied with zero mutation`, async () => {
      S.isStaff = false;
      const res = await app.inject({
        method: route.method,
        url: route.url,
        payload: route.payload as never,
      });
      // Flat 404: a customer admin must not learn the support surface exists.
      expect(res.statusCode).toBe(404);
      expect(S.writes).toEqual([]);
    });
  }

  it("a staff caller can start support access", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/support-access/start",
      payload: { teamId: WS, organizationId: ORG, reason: "incident 4821 triage" },
    });
    expect(res.statusCode).toBe(200);
    expect(S.writes).toContain("startSupportAccess");
  });

  it("a fabricated customer approver is rejected with zero mutation", async () => {
    S.approverIsOrgAdmin = false;
    const res = await app.inject({
      method: "POST",
      url: "/v1/support-access/start",
      payload: {
        teamId: WS,
        organizationId: ORG,
        reason: "incident 4821 triage",
        approvedByUserId: APPROVER,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("SUPPORT_ACCESS_APPROVER_INVALID");
    expect(S.writes).toEqual([]);
  });

  it("the support actor cannot be their own customer-side approver", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/support-access/start",
      payload: {
        teamId: WS,
        organizationId: ORG,
        reason: "incident 4821 triage",
        // A real UUID that happens to be the actor's own — the self-approval
        // case, distinct from "approver is not an org admin".
        approvedByUserId: S.actorUserId,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("SUPPORT_ACCESS_APPROVER_INVALID");
    expect(S.writes).toEqual([]);
  });

  it("break-glass activation is step-up gated: no challenge ⇒ 401, ZERO mutation", async () => {
    // The REAL gate, with no challenge header on the request.
    const res = await app.inject({
      method: "POST",
      url: "/v1/break-glass/activate",
      payload: {
        teamId: WS,
        organizationId: ORG,
        emergencyUserId: EMERGENCY_USER,
        reason: "primary on-call unreachable",
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
    expect(S.writes).toEqual([]);
  });

  it("break-glass activation succeeds with a valid challenge and consumes it once", async () => {
    const challenges = installSupportTransport({ seedApprovedChallenge: true });
    const res = await app.inject({
      method: "POST",
      url: "/v1/break-glass/activate",
      headers: { "x-proovra-step-up-challenge-id": BG_CHALLENGE },
      payload: {
        teamId: WS,
        organizationId: ORG,
        emergencyUserId: EMERGENCY_USER,
        reason: "primary on-call unreachable",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(S.writes).toEqual(["activateBreakGlass"]);
    // Single-use: the challenge is no longer spendable.
    expect(challenges[0]!.status).not.toBe("APPROVED");

    // REPLAY of the same challenge performs no second activation.
    S.writes = [];
    const replay = await app.inject({
      method: "POST",
      url: "/v1/break-glass/activate",
      headers: { "x-proovra-step-up-challenge-id": BG_CHALLENGE },
      payload: {
        teamId: WS,
        organizationId: ORG,
        emergencyUserId: EMERGENCY_USER,
        reason: "primary on-call unreachable",
      },
    });
    expect(replay.statusCode).toBe(401);
    expect(S.writes).toEqual([]);
  });

  it("support context entry mints a SESSION-BOUND token and never a grant mutation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/support-access/enter",
      payload: { teamId: WS, grantId: GRANT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.supportContextToken).toBe("opaque-support-token");
    expect(body.expiresInSeconds).toBe(900);
    // Entry is READ-ONLY on the grant authority.
    expect(S.writes).toEqual([]);
  });

  it("the break-glass grant projection never exposes the strong-auth proof id", async () => {
    S.emergencyGrantRows = [
      {
        id: "bg-1",
        organizationId: ORG,
        emergencyUserId: EMERGENCY_USER,
        grantedRole: "EMERGENCY_OPERATOR",
        reason: "primary on-call unreachable",
        status: "ACTIVE",
        requestedByUserId: S.actorUserId,
        // The secret under test.
        stepUpProofId: "chal-secret-must-not-leak",
        startedAtUtc: new Date(),
        expiresAtUtc: new Date(Date.now() + 60_000),
        revokedAtUtc: null,
        revokedByUserId: null,
      },
    ];
    const res = await app.inject({ method: "GET", url: "/v1/break-glass/grants" });
    expect(res.statusCode).toBe(200);
    const raw = res.body;
    expect(raw).not.toContain("chal-secret-must-not-leak");
    const grant = res.json().grants[0];
    // Presence is the auditable fact; the id itself is strong-auth material.
    expect(grant.stepUpProofRecorded).toBe(true);
    expect(grant.stepUpProofId).toBeUndefined();
  });

  it("the support grant projection carries dual identity and no token material", async () => {
    S.supportGrantRows = [
      {
        id: "sa-1",
        supportUserId: S.actorUserId,
        organizationId: ORG,
        teamId: null,
        reason: "incident 4821 triage",
        accessLevel: "READ_ONLY",
        status: "ACTIVE",
        approvedByUserId: APPROVER,
        startedAtUtc: new Date(),
        expiresAtUtc: new Date(Date.now() - 1_000), // already lapsed
        revokedAtUtc: null,
      },
    ];
    const res = await app.inject({ method: "GET", url: "/v1/support-access/grants" });
    expect(res.statusCode).toBe(200);
    const grant = res.json().grants[0];
    // Dual identity: support actor AND customer Organization.
    expect(grant.supportUserId).toBe(S.actorUserId);
    expect(grant.organizationId).toBe(ORG);
    expect(grant.approvedByUserId).toBe(APPROVER);
    // Live expiry is server-derived, not recomputed on a client clock.
    expect(grant.expired).toBe(true);
    expect(res.body).not.toContain("supportContextToken");
  });
});

// ===========================================================================
// SECTION 4 — ORGANIZATION SECURITY POLICY (C1)
//
// ONE writer, ONE public authority, versioned + step-up gated. The fields
// folded in when the legacy PUT /v1/identity/policy writer was deleted must
// actually reach that authority: the PATCH body has accepted them since the
// fold, but no product surface set them, so they were backend-only.
// ===========================================================================

describe("PHASE 12B C1 — organization security policy authority", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    S.isStaff = true;
    S.authAllowed = true;
    S.approverIsOrgAdmin = true;
    S.writes = [];
    S.lastPatch = null;
    S.lastExpectedVersion = undefined;
    S.policyApplicability = "ORGANIZATION";
    S.policyNotProvisioned = false;
    S.staleVersion = false;
    // Section 4's caller is an ORG_ADMIN of the subject organization — the
    // authorization these routes actually require.
    S.actorIsOrgAdmin = true;
    installSupportTransport({ seedApprovedChallenge: true });
    app = await buildSupportApp();
  });

  /** The policy PATCH is step-up gated, so every write needs the challenge. */
  const withChallenge = { "x-proovra-step-up-challenge-id": BG_CHALLENGE };

  it("carries every folded legacy field through to the ONE writer", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/security-policy",
      headers: withChallenge,
      payload: {
        organizationId: ORG,
        expectedPolicyVersion: 1,
        // Fields folded from the DELETED legacy identity-policy writer. If the
        // canonical authority ever stops accepting one, this fails rather than
        // silently dropping an operator's security decision.
        mfaRequiredFlag: true,
        allowedEmailDomains: ["example.com"],
        restrictedIpRanges: ["203.0.113.0/24"],
        reviewerSessionTimeoutSeconds: 1800,
        contributorSessionTimeoutSeconds: 900,
        ssoReadyFlag: true,
        scimReadyFlag: true,
        notes: "Posture set during onboarding review.",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(S.writes).toEqual(["applySecurityPolicyPatch"]);
    expect(S.lastPatch).toMatchObject({
      mfaRequiredFlag: true,
      allowedEmailDomains: ["example.com"],
      restrictedIpRanges: ["203.0.113.0/24"],
      reviewerSessionTimeoutSeconds: 1800,
      contributorSessionTimeoutSeconds: 900,
      ssoReadyFlag: true,
      scimReadyFlag: true,
      notes: "Posture set during onboarding review.",
    });
    // organizationId is the authoritative KEY, never part of the patch payload.
    expect(S.lastPatch).not.toHaveProperty("organizationId");
    expect(S.lastPatch).not.toHaveProperty("expectedPolicyVersion");
    expect(S.lastExpectedVersion).toBe(1);
  });

  it("a stale expectedPolicyVersion is a 409 with ZERO mutation", async () => {
    S.staleVersion = true;
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/security-policy",
      headers: withChallenge,
      payload: { organizationId: ORG, expectedPolicyVersion: 1, ssoRequired: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("POLICY_VERSION_CONFLICT");
    expect(S.writes).toEqual([]);
  });

  it("the policy PATCH is step-up gated: no challenge means 401 and ZERO mutation", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/security-policy",
      payload: { organizationId: ORG, expectedPolicyVersion: 1, ssoRequired: true },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
    expect(S.writes).toEqual([]);
  });

  it("a Personal / non-customer subject reads NOT_APPLICABLE, never a permissive default", async () => {
    S.policyApplicability = "NOT_APPLICABLE";
    const res = await app.inject({
      method: "GET",
      url: `/v1/security-policy?organizationId=${ORG}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.applicability).toBe("NOT_APPLICABLE");
    expect(body.policy).toBeNull();
  });

  it("an unprovisioned customer policy FAILS CLOSED with 503, not an empty policy", async () => {
    S.policyNotProvisioned = true;
    const res = await app.inject({
      method: "GET",
      url: `/v1/security-policy?organizationId=${ORG}`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("POLICY_NOT_PROVISIONED");
  });

  it("high-security activation reports the affected-session revocation result", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/security-policy/high-security/activate",
      headers: withChallenge,
      payload: { organizationId: ORG },
    });
    expect(res.statusCode).toBe(200);
    // The operator must see the blast radius, not just "done".
    expect(res.json().affectedSessionUserCount).toBe(4);
  });

  it("a non-org-admin caller is concealed-denied on both read and write", async () => {
    S.actorIsOrgAdmin = false; // drives requireOrgPolicyAdmin -> 404
    const read = await app.inject({
      method: "GET",
      url: `/v1/security-policy?organizationId=${ORG}`,
    });
    expect(read.statusCode).toBe(404);
    const write = await app.inject({
      method: "PATCH",
      url: "/v1/security-policy",
      headers: withChallenge,
      payload: { organizationId: ORG, expectedPolicyVersion: 1, ssoRequired: true },
    });
    expect(write.statusCode).toBe(404);
    expect(S.writes).toEqual([]);
  });
});
