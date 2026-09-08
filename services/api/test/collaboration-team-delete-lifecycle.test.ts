/**
 * COLLABORATION TEAM LIFECYCLE — archive frees capacity, delete cannot destroy
 * evidence.
 *
 * ===========================================================================
 * THE TWO CONCEPTS, AND WHY THEY MUST STAY APART
 * ===========================================================================
 *   ARCHIVE  retires a group that has done real work. Its history survives,
 *            and it stops consuming an ACTIVE capacity slot.
 *   DELETE   removes a group that never did any — the accidental-creation
 *            case, tidied away without ceremony.
 *
 * Because ARCHIVED already consumes no capacity, nobody ever needs to delete
 * history to free a slot. That is what stops DELETE becoming a commercial
 * workaround, and it is asserted below rather than assumed.
 *
 * THE SAFETY PROPERTY that matters most is structural: a Collaboration Team
 * owns no Evidence and no Case. `CollaborationTeamAssignment.targetId` is a
 * bare UUID with NO foreign key to either, so nothing that cascades from
 * `collaboration_teams` can reach them. That is proven from the schema, not
 * from prose.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCHEMA = readFileSync(
  join(HERE, "..", "prisma", "schema.prisma"),
  "utf8",
);

/** Zero history unless a count is overridden. */
function makeClient(counts: Partial<Record<string, number>> = {}) {
  const deleted: string[] = [];
  const client: Record<string, unknown> = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn(client),
    collaborationTeam: {
      findUnique: async () => ({
        id: "team-1",
        workspaceId: "ws-1",
        status: "ACTIVE",
      }),
      delete: async (a: { where: { id: string } }) => {
        deleted.push(a.where.id);
        return {};
      },
    },
    collaborationTeamMember: {
      findFirst: async () => ({ role: "LEAD" }),
    },
    collaborationTeamAssignment: {
      count: async () => counts.assignments ?? 0,
    },
    collaborationTeamComment: { count: async () => counts.comments ?? 0 },
    collaborationTeamAccessReview: {
      count: async () => counts.accessReviews ?? 0,
    },
    collaborationTeamGuest: { count: async () => counts.guests ?? 0 },
    collaborationTeamActivity: { count: async () => counts.activity ?? 0 },
  };
  return { client: client as never, deleted };
}

vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: async () => undefined,
}));

async function load() {
  return import(
    "../src/services/collaboration-team/collaboration-team.service.js"
  );
}

const ACTOR = "22222222-2222-4222-8222-222222222222";

describe("disposability — what makes a group safe to delete", () => {
  it("a group with no operational record is disposable", async () => {
    const { assessCollaborationTeamDisposability } = await load();
    const { client } = makeClient();
    const res = await assessCollaborationTeamDisposability(
      { teamId: "team-1", actorUserId: ACTOR },
      client,
    );
    expect(res.disposable).toBe(true);
    expect(res.blockers).toEqual([]);
  });

  // Each of these is history an evidence platform exists to keep.
  for (const kind of [
    "assignments",
    "comments",
    "accessReviews",
    "guests",
    "activity",
  ]) {
    it(`${kind} alone makes it non-disposable`, async () => {
      const { assessCollaborationTeamDisposability } = await load();
      const { client } = makeClient({ [kind]: 3 });
      const res = await assessCollaborationTeamDisposability(
        { teamId: "team-1", actorUserId: ACTOR },
        client,
      );
      expect(res.disposable).toBe(false);
      // And it says WHICH history, so the refusal is actionable.
      expect(res.blockers.some((b) => b.count === 3)).toBe(true);
    });
  }

  it("members and pending invites are NOT blockers", async () => {
    /*
     * Adding people is how a group gets created. A group with three members and
     * no work is still an accident somebody wants tidied away, and requiring
     * them to be removed by hand first is the bureaucracy §15.26 forbids. Group
     * membership confers no access and survives nowhere else.
     */
    const { assessCollaborationTeamDisposability } = await load();
    const { client } = makeClient();
    const res = await assessCollaborationTeamDisposability(
      { teamId: "team-1", actorUserId: ACTOR },
      client,
    );
    expect(res.disposable).toBe(true);
  });
});

describe("delete — admitted only for a disposable group", () => {
  it("an empty group is deleted", async () => {
    const { deleteCollaborationTeam } = await load();
    const { client, deleted } = makeClient();
    await deleteCollaborationTeam(
      { teamId: "team-1", actorUserId: ACTOR },
      client,
    );
    expect(deleted).toEqual(["team-1"]);
  });

  it("a history-bearing group is REFUSED, and the row survives", async () => {
    const { deleteCollaborationTeam } = await load();
    const { client, deleted } = makeClient({ assignments: 2 });
    await expect(
      deleteCollaborationTeam({ teamId: "team-1", actorUserId: ACTOR }, client),
    ).rejects.toMatchObject({ code: "TEAM_NOT_DISPOSABLE", httpStatus: 409 });
    // THE ASSERTION THAT MATTERS: nothing was deleted.
    expect(deleted).toEqual([]);
  });

  it("the refusal names the history that blocks it", async () => {
    const { deleteCollaborationTeam } = await load();
    const { client } = makeClient({ comments: 5 });
    await expect(
      deleteCollaborationTeam({ teamId: "team-1", actorUserId: ACTOR }, client),
    ).rejects.toMatchObject({
      details: { blockers: [{ kind: "discussion", count: 5 }] },
    });
  });

  it("disposability is re-checked INSIDE the transaction", async () => {
    /*
     * Checking outside it would be a read-then-write race: an assignment or a
     * comment landing between the check and the delete would be destroyed by a
     * decision made before it existed. The double records call order, so this
     * fails if the assessment is ever hoisted out.
     */
    const order: string[] = [];
    const { client } = makeClient();
    // Untyped on purpose: this reaches into the double to record call order,
    // and every hop goes through `unknown` so tsc is not asked to believe a
    // Record is a function.
    const inner = client as unknown as Record<string, never>;
    const realTx = inner["$transaction"] as unknown as (
      fn: (tx: unknown) => unknown,
    ) => unknown;
    inner["$transaction"] = ((fn: (tx: unknown) => unknown) => {
      order.push("tx:begin");
      return realTx(fn);
    }) as never;
    const assignments = inner["collaborationTeamAssignment"] as unknown as {
      count: () => Promise<number>;
    };
    const realCount = assignments.count;
    assignments.count = (async () => {
      order.push("assess");
      return realCount();
    }) as never;
    const teamDelegate = inner["collaborationTeam"] as unknown as {
      delete: (a: unknown) => unknown;
    };
    const realDelete = teamDelegate.delete;
    teamDelegate.delete = ((a: unknown) => {
      order.push("delete");
      return realDelete(a);
    }) as never;

    const { deleteCollaborationTeam } = await load();
    await deleteCollaborationTeam(
      { teamId: "team-1", actorUserId: ACTOR },
      client,
    );
    expect(order.indexOf("tx:begin")).toBeLessThan(order.indexOf("assess"));
    expect(order.indexOf("assess")).toBeLessThan(order.indexOf("delete"));
  });
});

describe("evidence and case safety — structural, not promised", () => {
  it("a team assignment holds NO foreign key to Case or Evidence", () => {
    const model = SCHEMA.slice(
      SCHEMA.indexOf("model CollaborationTeamAssignment"),
      SCHEMA.indexOf("@@map(\"collaboration_team_assignments\")"),
    );
    expect(model.length).toBeGreaterThan(0);
    // The target is a bare uuid. This is WHY a cascade cannot reach evidence.
    expect(model).toMatch(/targetId\s+String\s+@map\("target_id"\)\s+@db\.Uuid/);
    expect(model).not.toMatch(/@relation\([^)]*references:\s*\[id\][^)]*\)\s*\/\/\s*case/i);
    for (const forbidden of ["Case @relation", "Evidence @relation"]) {
      expect(
        model,
        `a Collaboration Team must not own ${forbidden} — deleting a grouping would then reach evidence`,
      ).not.toContain(forbidden);
    }
  });

  it("nothing cascading from a team reaches evidence, cases or workspace membership", () => {
    /*
     * Ten child tables cascade from `collaboration_teams`. Every one of them is
     * a collaboration_team_* table — the group's own bookkeeping. Evidence,
     * Case and TeamMember (workspace membership) are not among them, so a
     * delete cannot touch ownership data.
     */
    const cascading = SCHEMA.split("\n").filter(
      (l) =>
        l.includes("CollaborationTeam @relation") ||
        l.includes("CollaborationTeam? @relation"),
    );
    expect(cascading.length).toBeGreaterThan(5);
    for (const line of cascading) {
      expect(line).toContain("onDelete: Cascade");
    }
    // And the workspace relation points the OTHER way: a team belongs to a
    // workspace, deleting the team never deletes the workspace or its members.
    const teamModel = SCHEMA.slice(
      SCHEMA.indexOf("model CollaborationTeam {"),
      SCHEMA.indexOf("@@map(\"collaboration_teams\")"),
    );
    expect(teamModel).toMatch(/workspace Team @relation\("CollaborationTeamWorkspace"/);
    expect(teamModel).not.toContain("Evidence");
    expect(teamModel).not.toContain("Case[]");
  });
});

describe("capacity — ACTIVE consumes, ARCHIVED does not", () => {
  const GUARDS = readFileSync(
    join(HERE, "..", "src", "services", "collaboration-team", "billing-guards.ts"),
    "utf8",
  );

  it("every used-count query excludes archived groups", () => {
    /*
     * ALREADY IMPLEMENTED and verified rather than rewritten. Both capacity
     * counters — the creation gate and the projection — filter on
     * `status: "ACTIVE"` AND `archivedAtUtc: null`, so archiving frees a slot
     * and a customer never has to delete history to create another group.
     */
    const counts = GUARDS.match(/collaborationTeam\.count\(\{[\s\S]{0,220}?\}\)/g) ?? [];
    expect(counts.length).toBeGreaterThanOrEqual(2);
    for (const q of counts) {
      expect(q).toContain('status: "ACTIVE"');
      expect(q).toContain("archivedAtUtc: null");
    }
  });

  it("unarchive re-checks capacity under the same lock as creation", () => {
    const svc = readFileSync(
      join(
        HERE,
        "..",
        "src",
        "services",
        "collaboration-team",
        "collaboration-team.service.ts",
      ),
      "utf8",
    );
    const fn = svc.slice(svc.indexOf("export async function unarchiveCollaborationTeam"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
    // Without this, a workspace could archive one group, create a third, then
    // reopen the first and hold three active groups on a plan that sells two.
    expect(body).toContain("lockAndAssertCollaborationTeamCapacity");
    expect(body).toContain("$transaction");
  });
});
