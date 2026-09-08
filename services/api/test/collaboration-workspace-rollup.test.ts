/**
 * CROSS-GROUP ROLLUP — behaviour, not source shape.
 *
 * The list page could say how many groups a workspace had and nothing about
 * how much work they were carrying, so an Enterprise operator supervising
 * twenty groups had to open each one to find the one that was drowning. The
 * rollup answers that, and these tests pin the four properties that make the
 * answer trustworthy rather than merely present:
 *
 *   1. It is WORKSPACE-WIDE, not page-wide. Every query it issues is keyed on
 *      `workspaceId`; none of them is keyed on the ids of the rows returned.
 *      A supervision number computed from a page is wrong the moment there is
 *      a second page, and this is the assertion that stops one being written.
 *
 *   2. It is GOVERNOR-ONLY. A participation-scoped caller gets `null` — not a
 *      smaller number. Telling somebody how much work exists across groups
 *      they cannot see leaks the shape of the workspace to a caller the route
 *      already decided may not survey it.
 *
 *   3. ATTENTION is a DISTINCT count, never `overdue + highPriority`. An
 *      urgent item that is also late is one problem, and summing the columns
 *      would report it twice — inflating the only number anyone triages on.
 *
 *   4. It reads the ONE responsibility authority. No snapshot table, no second
 *      attention engine: every number is a live count over
 *      `CollaborationTeamAssignment`.
 *
 * The Prisma double records every `where` it is handed, so the assertions are
 * about the queries actually issued rather than about the numbers a stub chose
 * to return.
 */

import { describe, expect, it } from "vitest";

import { listCollaborationTeams } from "../src/services/collaboration-team/collaboration-team.service.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const GROUP_A = "33333333-3333-4333-8333-333333333333";
const GROUP_B = "44444444-4444-4444-8444-444444444444";

type Recorded = { model: string; op: string; args: Record<string, unknown> };

/**
 * A Prisma double that answers by CALL ORDER within each (model, op) pair and
 * records what it was asked.
 *
 * Counts are returned from a queue so each of the rollup's six counts can be
 * given a distinct value — which is what lets the "attention is not a sum"
 * assertion actually bite: overdue 4 + highPriority 3 would be 7, and the
 * distinct answer is deliberately 5.
 */
function makeClient(opts: {
  assignmentCounts: number[];
  groupByResults: Array<Array<Record<string, unknown>>>;
}) {
  const recorded: Recorded[] = [];
  let countIdx = 0;
  let groupByIdx = 0;

  const client = {
    collaborationTeam: {
      count: async (args: Record<string, unknown>) => {
        recorded.push({ model: "collaborationTeam", op: "count", args });
        return 2;
      },
      findMany: async (args: Record<string, unknown>) => {
        recorded.push({ model: "collaborationTeam", op: "findMany", args });
        return [
          {
            id: GROUP_A,
            name: "Alpha",
            description: null,
            teamType: "GENERAL",
            status: "ACTIVE",
            createdAt: new Date("2026-01-01T00:00:00Z"),
            updatedAt: new Date("2026-01-02T00:00:00Z"),
            archivedAtUtc: null,
            _count: { members: 3, invites: 0, assignments: 5 },
            activity: [],
            members: [{ role: "LEAD", status: "ACTIVE" }],
          },
        ];
      },
    },
    collaborationTeamAssignment: {
      count: async (args: Record<string, unknown>) => {
        recorded.push({
          model: "collaborationTeamAssignment",
          op: "count",
          args,
        });
        return opts.assignmentCounts[countIdx++] ?? 0;
      },
      groupBy: async (args: Record<string, unknown>) => {
        recorded.push({
          model: "collaborationTeamAssignment",
          op: "groupBy",
          args,
        });
        return opts.groupByResults[groupByIdx++] ?? [];
      },
    },
  };

  return { client: client as never, recorded };
}

/** The six rollup counts, in the order `computeWorkspaceRollup` issues them. */
const ROLLUP_COUNTS = [
  40, // open
  9, // unassigned
  4, // overdue
  3, // highPriority
  5, // attention — DISTINCT, deliberately less than overdue + highPriority
  6, // dueSoon
];

/**
 * groupBy answers in issue order:
 *   [0] page overdue-by-team, [1] page urgent-by-team,
 *   [2] rollup groups-with-work, [3] rollup open-by-assignee,
 *   [4] rollup overdue-by-assignee
 */
const GROUP_BY_RESULTS = [
  [{ teamId: GROUP_A, _count: { _all: 2 } }],
  [{ teamId: GROUP_A, _count: { _all: 1 } }],
  [
    { teamId: GROUP_A, _count: { _all: 30 } },
    { teamId: GROUP_B, _count: { _all: 10 } },
  ],
  [
    { assigneeUserId: ACTOR, _count: { _all: 18 } },
    { assigneeUserId: GROUP_B, _count: { _all: 13 } },
  ],
  [{ assigneeUserId: ACTOR, _count: { _all: 4 } }],
];

describe("cross-group rollup — the workspace's position, not the page's", () => {
  it("a NON-GOVERNOR gets no rollup at all", async () => {
    const { client, recorded } = makeClient({
      assignmentCounts: ROLLUP_COUNTS,
      groupByResults: GROUP_BY_RESULTS,
    });

    const res = await listCollaborationTeams(
      // No `canSurveyWorkspace`. Absent must mean refused, not defaulted.
      { workspaceId: WORKSPACE, actorUserId: ACTOR, scope: "PARTICIPATING" },
      client,
    );

    expect(res.scope).toBe("PARTICIPATING");
    // `null`, not a narrowed number. A smaller answer would still be an answer
    // to a question this caller may not ask.
    expect(res.rollup).toBeNull();

    // And the work was not merely hidden — it was never done. No workspace-wide
    // count was issued for a caller who may not survey the workspace.
    const workspaceWideCounts = recorded.filter(
      (r) =>
        r.model === "collaborationTeamAssignment" &&
        r.op === "count" &&
        (r.args.where as Record<string, unknown>)?.workspaceId === WORKSPACE,
    );
    expect(workspaceWideCounts).toHaveLength(0);
  });

  it("a GOVERNOR gets the rollup even while viewing only their own teams", async () => {
    /*
     * THE REVEAL DEFECT THIS CLOSES.
     *
     * The rollup used to be gated on the GRANTED LIST SCOPE, which conflated a
     * view preference with an authorization decision. A governor looking at
     * "Teams I'm in" saw no operational summary at all, and had to switch the
     * list to All Teams to discover that open work, unassigned work and
     * workload figures existed — supervision hidden behind a toggle nobody
     * would think to press.
     *
     * Which ROWS you asked for and whether you may SURVEY the workspace are
     * different questions, and they are answered separately now.
     */
    const { client } = makeClient({
      assignmentCounts: ROLLUP_COUNTS,
      groupByResults: GROUP_BY_RESULTS,
    });

    const res = await listCollaborationTeams(
      {
        workspaceId: WORKSPACE,
        actorUserId: ACTOR,
        scope: "PARTICIPATING",
        canSurveyWorkspace: true,
      },
      client,
    );

    // The narrow list, and the whole workspace's position beside it.
    expect(res.scope).toBe("PARTICIPATING");
    expect(res.rollup).not.toBeNull();
    expect(res.rollup!.work.open).toBe(40);
  });

  it("a governor gets a rollup keyed on the WORKSPACE, never on the page", async () => {
    const { client, recorded } = makeClient({
      assignmentCounts: ROLLUP_COUNTS,
      groupByResults: GROUP_BY_RESULTS,
    });

    const res = await listCollaborationTeams(
      { workspaceId: WORKSPACE, actorUserId: ACTOR, scope: "ALL", canSurveyWorkspace: true },
      client,
    );

    expect(res.scope).toBe("ALL");
    expect(res.rollup).not.toBeNull();

    /**
     * THE PAGE-INDEPENDENCE PROOF.
     *
     * The page's own two grouped queries legitimately filter by the ids on
     * screen (`teamId: { in: [...] }`). Every OTHER assignment query the call
     * issued must be keyed on `workspaceId` and must NOT carry a `teamId in`
     * filter — because the moment one does, the number moves when the operator
     * pages, and a supervision figure that moves under paging is a lie.
     */
    const assignmentQueries = recorded.filter(
      (r) => r.model === "collaborationTeamAssignment",
    );
    const pageScoped = assignmentQueries.filter((r) => {
      const where = (r.args.where ?? {}) as Record<string, unknown>;
      const teamId = where.teamId as { in?: unknown } | undefined;
      return Boolean(teamId && typeof teamId === "object" && "in" in teamId);
    });
    const workspaceScoped = assignmentQueries.filter(
      (r) => (r.args.where as Record<string, unknown>)?.workspaceId === WORKSPACE,
    );

    // Exactly the two per-row comparison queries are page-scoped.
    expect(pageScoped).toHaveLength(2);
    // The six counts plus the three grouped reads are workspace-scoped.
    expect(workspaceScoped).toHaveLength(9);
    // No query is both.
    for (const q of workspaceScoped) {
      expect(pageScoped).not.toContain(q);
    }
  });

  it("attention counts DISTINCT rows in trouble — it is never overdue + high priority", async () => {
    const { client, recorded } = makeClient({
      assignmentCounts: ROLLUP_COUNTS,
      groupByResults: GROUP_BY_RESULTS,
    });

    const res = await listCollaborationTeams(
      { workspaceId: WORKSPACE, actorUserId: ACTOR, scope: "ALL", canSurveyWorkspace: true },
      client,
    );
    const rollup = res.rollup!;

    expect(rollup.work.overdue).toBe(4);
    expect(rollup.work.highPriority).toBe(3);
    // The sum would be 7. The distinct answer is 5, because three of the late
    // items are also urgent — one problem each, not two.
    expect(rollup.work.attention).toBe(5);
    expect(rollup.work.attention).not.toBe(
      rollup.work.overdue + rollup.work.highPriority,
    );

    // And it is an OR over the two conditions, which is the only way to get a
    // distinct count out of the database rather than by arithmetic here.
    const orQuery = recorded.find(
      (r) =>
        r.model === "collaborationTeamAssignment" &&
        r.op === "count" &&
        Array.isArray((r.args.where as Record<string, unknown>)?.OR),
    );
    expect(orQuery).toBeDefined();
    const or = (orQuery!.args.where as { OR: Array<Record<string, unknown>> }).OR;
    expect(or).toHaveLength(2);
    expect(JSON.stringify(or)).toContain("dueAtUtc");
    expect(JSON.stringify(or)).toContain("priority");
  });

  it("reports how much of the workspace is actually carrying work, and who is heaviest", async () => {
    const { client } = makeClient({
      assignmentCounts: ROLLUP_COUNTS,
      groupByResults: GROUP_BY_RESULTS,
    });

    const res = await listCollaborationTeams(
      { workspaceId: WORKSPACE, actorUserId: ACTOR, scope: "ALL", canSurveyWorkspace: true },
      client,
    );
    const rollup = res.rollup!;

    expect(rollup.work.open).toBe(40);
    expect(rollup.work.unassigned).toBe(9);
    expect(rollup.work.dueSoon).toBe(6);
    // Two groups hold open work; the workspace has two active groups.
    expect(rollup.groups.withOpenWork).toBe(2);
    expect(rollup.groups.active).toBe(2);
    // Two people hold open work, heaviest first.
    expect(rollup.workload.people).toBe(2);
    expect(rollup.workload.busiest).toEqual({
      userId: ACTOR,
      open: 18,
      overdue: 4,
    });
  });

  it("says nobody is carrying work rather than inventing a busiest person", async () => {
    const { client } = makeClient({
      assignmentCounts: [0, 0, 0, 0, 0, 0],
      // Nothing assigned to an individual: the last two grouped reads are empty.
      groupByResults: [[], [], [], [], []],
    });

    const res = await listCollaborationTeams(
      { workspaceId: WORKSPACE, actorUserId: ACTOR, scope: "ALL", canSurveyWorkspace: true },
      client,
    );
    const rollup = res.rollup!;

    expect(rollup.workload.people).toBe(0);
    // `null`, not a zero-valued placeholder person.
    expect(rollup.workload.busiest).toBeNull();
    expect(rollup.groups.withOpenWork).toBe(0);
  });

  it("counts only OPEN and IN_PROGRESS work — completed work is not a backlog", async () => {
    const { client, recorded } = makeClient({
      assignmentCounts: ROLLUP_COUNTS,
      groupByResults: GROUP_BY_RESULTS,
    });

    await listCollaborationTeams(
      { workspaceId: WORKSPACE, actorUserId: ACTOR, scope: "ALL", canSurveyWorkspace: true },
      client,
    );

    const workspaceQueries = recorded.filter(
      (r) =>
        r.model === "collaborationTeamAssignment" &&
        (r.args.where as Record<string, unknown>)?.workspaceId === WORKSPACE,
    );
    expect(workspaceQueries.length).toBeGreaterThan(0);
    for (const q of workspaceQueries) {
      const status = (q.args.where as { status?: { in?: string[] } }).status;
      expect(status?.in).toEqual(["OPEN", "IN_PROGRESS"]);
    }
  });
});
