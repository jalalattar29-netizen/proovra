/**
 * PHASE 12 POINT 4 PASS C5 — a named workspace is never silently replaced.
 *
 * THE DEFECT THIS LOCKS DOWN, AND WHERE IT NOW LIVES.
 *
 * `resolveActiveOperationalWorkspace` used to be the live workspace-context
 * authority for the collaboration surfaces. When a request NAMED a workspace
 * that produced no ACTIVE membership, it fell through to the caller's PERSONAL
 * workspace and reported success — so an operation meant for workspace X
 * quietly became a Personal-space one.
 *
 * WORKSPACE AND COLLABORATION ARCHITECTURE RECONCILIATION (2026-09-06) —
 * that resolver was deleted and this contract MOVED with the behaviour it
 * describes, to `authorizeCollaborationWorkspace`, the one authorization entry
 * point for every collaboration surface. The rule is unchanged and the
 * replacement is stricter exactly where the old one was loose: there is no
 * fallback at all, named or otherwise. Every candidate — a named workspace, or
 * the caller's own pointer — is revalidated in full by the canonical
 * primitive, and a request that cannot prove which workspace it is operating
 * in is a DENIAL rather than an invitation to pick one on the caller's behalf.
 *
 * The rule proven here: a named workspace DECIDES the outcome. The pointer is
 * consulted only for a request that named no workspace at all, and it too is
 * revalidated.
 *
 * Only the canonical authorization primitive and Prisma are faked — both real
 * module/process boundaries. The binding itself runs for real, and each fake
 * RECORDS what it was asked, so "which workspace was authorized" is observed
 * rather than assumed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  /** Every call the binding made into the canonical primitive, in order. */
  calls: [] as Array<{ fn: string; workspaceId?: string; permission: string }>,
  /** Workspaces where `authorizeWorkspaceOrFail` succeeds. */
  authorizedNamed: new Set<string>(),
  /** The workspace the caller's own pointer resolves to, when authorized. */
  currentWorkspaceId: null as string | null,
  /** Workspaces whose `Team.closedAtUtc` is set. */
  closed: new Set<string>(),
  /** Workspace ids with no `Team` row at all. */
  missing: new Set<string>(),
}));

vi.mock("../src/middleware/authorize.js", () => ({
  authorizeWorkspaceOrFail: async (
    _req: unknown,
    reply: { code: (c: number) => { send: (b: unknown) => void } },
    opts: { workspaceId: string; permission: string },
  ) => {
    H.calls.push({
      fn: "authorizeWorkspaceOrFail",
      workspaceId: opts.workspaceId,
      permission: opts.permission,
    });
    if (!H.authorizedNamed.has(opts.workspaceId)) {
      reply.code(404).send({ error: { code: "not_found" } });
      return null;
    }
    return { workspaceId: opts.workspaceId, userId: "actor-1" };
  },
  authorizeCurrentWorkspaceOrFail: async (
    _req: unknown,
    reply: { code: (c: number) => { send: (b: unknown) => void } },
    opts: { permission: string },
  ) => {
    H.calls.push({
      fn: "authorizeCurrentWorkspaceOrFail",
      permission: opts.permission,
    });
    if (!H.currentWorkspaceId) {
      reply.code(404).send({ error: { code: "not_found" } });
      return null;
    }
    return { workspaceId: H.currentWorkspaceId, userId: "actor-1" };
  },
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    team: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        H.missing.has(where.id)
          ? null
          : { closedAtUtc: H.closed.has(where.id) ? new Date() : null },
    },
  },
}));

const { authorizeCollaborationWorkspace, readNamedWorkspaceId } = await import(
  "../src/services/collaboration-team/collaboration-authorization.js"
);

type Reply = {
  status: number | null;
  body: unknown;
  code: (c: number) => { send: (b: unknown) => void };
};

function makeReply(): Reply {
  const reply: Reply = {
    status: null,
    body: null,
    code(c: number) {
      reply.status = c;
      return {
        send(b: unknown) {
          reply.body = b;
        },
      };
    },
  };
  return reply;
}

const req = (headers: Record<string, string> = {}, query: unknown = {}) =>
  ({ headers, query }) as never;

beforeEach(() => {
  H.calls.length = 0;
  H.authorizedNamed = new Set();
  H.currentWorkspaceId = null;
  H.closed = new Set();
  H.missing = new Set();
});

describe("PHASE 12 POINT 4 C5 — a named workspace decides the outcome", () => {
  it("a named workspace the actor CAN act in is the one authorized", async () => {
    H.authorizedNamed.add("ws-named");
    H.currentWorkspaceId = "ws-personal";
    const reply = makeReply();
    const ctx = await authorizeCollaborationWorkspace(
      req({ "x-proovra-workspace-id": "ws-named" }),
      reply as never,
      "collaboration.thread.read",
    );
    expect(ctx?.workspaceId).toBe("ws-named");
    expect(H.calls).toEqual([
      {
        fn: "authorizeWorkspaceOrFail",
        workspaceId: "ws-named",
        permission: "collaboration.thread.read",
      },
    ]);
  });

  it("a named workspace the actor CANNOT act in is REFUSED, never replaced", async () => {
    // The exact regression: the personal workspace is perfectly usable here,
    // and must not be substituted for the one the request asked for.
    H.currentWorkspaceId = "ws-personal";
    const reply = makeReply();
    const ctx = await authorizeCollaborationWorkspace(
      req({ "x-proovra-workspace-id": "ws-foreign" }),
      reply as never,
      "collaboration.thread.read",
    );
    expect(ctx).toBeNull();
    expect(reply.status).toBe(404);
    // The pointer was never consulted — no second chance was taken.
    expect(H.calls.map((c) => c.fn)).toEqual(["authorizeWorkspaceOrFail"]);
  });

  it("the legacy header names a workspace too, and is held to the same rule", async () => {
    H.currentWorkspaceId = "ws-personal";
    const reply = makeReply();
    const ctx = await authorizeCollaborationWorkspace(
      req({ "x-team-id": "ws-foreign" }),
      reply as never,
      "collaboration.thread.read",
    );
    expect(ctx).toBeNull();
    expect(H.calls[0]).toMatchObject({ workspaceId: "ws-foreign" });
  });

  it("only a request naming NOTHING falls to the caller's pointer — revalidated", async () => {
    H.currentWorkspaceId = "ws-personal";
    const reply = makeReply();
    const ctx = await authorizeCollaborationWorkspace(
      req(),
      reply as never,
      "collaboration.thread.read",
    );
    expect(ctx?.workspaceId).toBe("ws-personal");
    expect(H.calls.map((c) => c.fn)).toEqual([
      "authorizeCurrentWorkspaceOrFail",
    ]);
  });

  it("no name and no usable pointer is a DENIAL, not a default", async () => {
    const reply = makeReply();
    const ctx = await authorizeCollaborationWorkspace(
      req(),
      reply as never,
      "collaboration.thread.read",
    );
    expect(ctx).toBeNull();
    expect(reply.status).toBe(404);
  });

  it("a collaboration-team id can never name a workspace", async () => {
    // The old resolver accepted a `teamId` field as a workspace id. That is
    // the confusion this module exists to end: on these routes the word means
    // the GROUP, not the tenant.
    expect(readNamedWorkspaceId(req({}, { teamId: "ct-1" }))).toBeNull();
    expect(readNamedWorkspaceId(req({}, { workspaceId: "ws-1" }))).toBe("ws-1");
    expect(
      readNamedWorkspaceId(
        req({ "x-proovra-workspace-id": "ws-h" }, { workspaceId: "ws-q" }),
      ),
    ).toBe("ws-h");
  });

  it("a CLOSED workspace is refused even when membership still authorizes it", async () => {
    H.authorizedNamed.add("ws-closed");
    H.closed.add("ws-closed");
    const reply = makeReply();
    const ctx = await authorizeCollaborationWorkspace(
      req({ "x-proovra-workspace-id": "ws-closed" }),
      reply as never,
      "collaboration.thread.read",
    );
    expect(ctx).toBeNull();
    expect(reply.status).toBe(404);
  });

  it("a workspace row that has vanished is refused, not treated as open", async () => {
    H.authorizedNamed.add("ws-gone");
    H.missing.add("ws-gone");
    const reply = makeReply();
    const ctx = await authorizeCollaborationWorkspace(
      req({ "x-proovra-workspace-id": "ws-gone" }),
      reply as never,
      "collaboration.thread.read",
    );
    expect(ctx).toBeNull();
    expect(reply.status).toBe(404);
  });

  it("the permission the caller asked for is the one evaluated — never widened", async () => {
    H.authorizedNamed.add("ws-1");
    const reply = makeReply();
    await authorizeCollaborationWorkspace(
      req({ "x-proovra-workspace-id": "ws-1" }),
      reply as never,
      "collaboration.contributor.access.manage",
    );
    expect(H.calls[0].permission).toBe(
      "collaboration.contributor.access.manage",
    );
  });

  it("every refusal is the SAME opaque body — foreign, closed and absent are indistinguishable", async () => {
    const bodies: unknown[] = [];
    const setups = [
      () => {
        /* foreign: nothing authorized */
      },
      () => {
        H.authorizedNamed.add("ws-x");
        H.closed.add("ws-x");
      },
      () => {
        H.authorizedNamed.add("ws-x");
        H.missing.add("ws-x");
      },
    ];
    for (const setup of setups) {
      H.authorizedNamed = new Set();
      H.closed = new Set();
      H.missing = new Set();
      setup();
      const reply = makeReply();
      await authorizeCollaborationWorkspace(
        req({ "x-proovra-workspace-id": "ws-x" }),
        reply as never,
        "collaboration.thread.read",
      );
      bodies.push({ status: reply.status, body: reply.body });
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });
});
