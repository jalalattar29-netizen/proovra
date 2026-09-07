/**
 * REVIEW-LOAD FAN-IN — the group overview reads the reviewer authority.
 *
 * A group's own `workload` counts the assignments that group holds. It says
 * nothing about the evidence reviews the same people are carrying elsewhere in
 * the workspace, so a lead could reassign to the member with the lightest
 * group load and hand it to the person with the deepest review queue.
 *
 * `reviewLoad` closes that by PROJECTING the canonical
 * `ReviewerWorkloadSnapshot` rows — the same rows `/v1/reviewer-ops/workload`
 * serves. These tests pin the three things that make a fan-in safe:
 *
 *   1. NARROWING. The workspace snapshot covers every reviewer in the
 *      workspace; this surface is authorized for a GROUP. A reviewer who is
 *      not in the group must not appear, or a group member would be reading
 *      the workspace's reviewer roster through a group endpoint.
 *
 *   2. UNKNOWN IS NOT ZERO. No snapshot for anyone in the group yields `null`,
 *      never a list of zeros. A reviewer with no snapshot and a reviewer with
 *      an empty queue are not the same person, and only one of them is safe to
 *      load up.
 *
 *   3. NO NEW ENGINE. Nothing is recomputed and nothing is stored — and when
 *      the neighbouring subsystem is unavailable the group's own roster still
 *      renders, degrading to UNKNOWN rather than failing the whole overview.
 */

import { describe, expect, it } from "vitest";

import { getTeamOverview } from "../src/services/collaboration-team/collaboration-team.service.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const GROUP = "33333333-3333-4333-8333-333333333333";
const LEAD = "22222222-2222-4222-8222-222222222222";
const IN_GROUP = "55555555-5555-4555-8555-555555555555";
/** A reviewer in the WORKSPACE who is not in this group. */
const OUTSIDER = "66666666-6666-4666-8666-666666666666";

function snapshot(userId: string, active: number) {
  return {
    reviewerUserId: userId,
    activeReviewCount: active,
    overdueReviewCount: 1,
    dueSoonReviewCount: 2,
    escalatedReviewCount: 0,
    needsInfoReviewCount: 0,
    capacityScore: 50,
    computedAtUtc: new Date("2026-09-06T00:00:00Z"),
    teamId: WORKSPACE,
  };
}

function makeClient(opts: {
  groupMemberIds: string[];
  snapshots?: Array<ReturnType<typeof snapshot>>;
  snapshotsThrow?: boolean;
}) {
  const zeroGroup: Array<Record<string, unknown>> = [];
  return {
    collaborationTeam: {
      findUnique: async () => ({
        id: GROUP,
        workspaceId: WORKSPACE,
        status: "ACTIVE",
      }),
    },
    collaborationTeamMember: {
      findFirst: async () => ({ role: "LEAD" }),
      groupBy: async () => [{ status: "ACTIVE", _count: { _all: 2 } }],
      count: async () => 1,
      findMany: async () => opts.groupMemberIds.map((userId) => ({ userId })),
    },
    collaborationTeamAssignment: {
      groupBy: async () => zeroGroup,
      count: async () => 0,
    },
    reviewerWorkloadSnapshot: {
      findMany: async () => {
        if (opts.snapshotsThrow) throw new Error("reviewer-ops unavailable");
        return opts.snapshots ?? [];
      },
    },
  } as never;
}

describe("group overview — evidence-review load fan-in", () => {
  it("shows only the group's own people, never the workspace's reviewer roster", async () => {
    const overview = await getTeamOverview(
      { teamId: GROUP, actorUserId: LEAD },
      makeClient({
        groupMemberIds: [LEAD, IN_GROUP],
        // The workspace snapshot legitimately contains a reviewer who is not
        // in this group. Reading it through a GROUP endpoint would be the leak.
        snapshots: [
          snapshot(OUTSIDER, 99),
          snapshot(IN_GROUP, 7),
          snapshot(LEAD, 3),
        ],
      }),
    );

    const ids = (overview.reviewLoad ?? []).map((r) => r.userId);
    expect(ids).not.toContain(OUTSIDER);
    expect(ids).toEqual([IN_GROUP, LEAD]);
  });

  it("orders heaviest first so the person to avoid is the first one read", async () => {
    const overview = await getTeamOverview(
      { teamId: GROUP, actorUserId: LEAD },
      makeClient({
        groupMemberIds: [LEAD, IN_GROUP],
        snapshots: [snapshot(LEAD, 2), snapshot(IN_GROUP, 11)],
      }),
    );

    expect(overview.reviewLoad?.map((r) => r.activeReviewCount)).toEqual([
      11, 2,
    ]);
    expect(overview.reviewLoad?.[0]?.userId).toBe(IN_GROUP);
  });

  it("reports UNKNOWN — not a list of zeros — when no snapshot covers this group", async () => {
    const overview = await getTeamOverview(
      { teamId: GROUP, actorUserId: LEAD },
      makeClient({
        groupMemberIds: [LEAD, IN_GROUP],
        // The pass has run for the workspace but produced nothing for anyone
        // in THIS group.
        snapshots: [snapshot(OUTSIDER, 40)],
      }),
    );

    // `null` is the honest answer. Zeros would say "these people are free",
    // which is the one thing the absence of a snapshot does not establish.
    expect(overview.reviewLoad).toBeNull();
  });

  it("reports UNKNOWN when the snapshot pass has never run at all", async () => {
    const overview = await getTeamOverview(
      { teamId: GROUP, actorUserId: LEAD },
      makeClient({ groupMemberIds: [LEAD, IN_GROUP], snapshots: [] }),
    );

    expect(overview.reviewLoad).toBeNull();
    // The group's OWN numbers are unaffected — the fan-in is additive.
    expect(overview.members.active).toBe(2);
  });

  it("keeps the group's roster rendering when reviewer-ops is unavailable", async () => {
    const overview = await getTeamOverview(
      { teamId: GROUP, actorUserId: LEAD },
      makeClient({ groupMemberIds: [LEAD, IN_GROUP], snapshotsThrow: true }),
    );

    // A neighbouring subsystem being down must not take the group's own
    // surface with it. It degrades to UNKNOWN, which is exactly what it is.
    expect(overview.reviewLoad).toBeNull();
    expect(overview.members.active).toBe(2);
    expect(overview.work.open).toBe(0);
  });

  it("asks for nothing when the group has no members", async () => {
    const overview = await getTeamOverview(
      { teamId: GROUP, actorUserId: LEAD },
      makeClient({
        groupMemberIds: [],
        snapshots: [snapshot(OUTSIDER, 40)],
      }),
    );

    expect(overview.reviewLoad).toBeNull();
  });
});
