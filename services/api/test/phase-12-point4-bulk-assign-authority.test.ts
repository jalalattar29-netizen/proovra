/**
 * PHASE 12 POINT 4 PASS C1 — bulk assignment goes through the ONE assignment
 * authority.
 *
 * `bulkAssign` used to write `status: "ASSIGNED"` and the assignment columns
 * straight onto each row. That skipped the stage-transition rule, the
 * ASSIGNED / REASSIGNED lifecycle event and the assignee notification, so a
 * bulk assignment produced a materially different record from a single one —
 * and could force a workflow out of a terminal stage with no history of it.
 *
 * Only Prisma is faked (an injected client, exactly as the service accepts).
 * `assignReviewer`, the transition rule and the event writer all run for real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { bulkAssign } from "../src/services/reviewer-workspace/bulk-operations.service.js";

const state = {
  status: "QUEUED" as string,
  updates: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
};

// Notification dispatch is an external boundary; assignment must not depend
// on it succeeding.
vi.mock("../src/services/review-operations/review-notifications.service.js", () => ({
  notifyReviewAssigned: () => Promise.resolve(),
  notifyReviewNeedsMoreInfo: () => Promise.resolve(),
  notifyReviewEscalated: () => Promise.resolve(),
  notifyReviewSlaBreached: () => Promise.resolve(),
  notifyReviewDecision: () => Promise.resolve(),
}));

function workflowRow() {
  return {
    id: "wf-1",
    evidenceId: "ev-1",
    teamId: "team-1",
    status: state.status,
    assignedToUserId: null,
    assignedByUserId: null,
    assignedAtUtc: null,
    reassignedAtUtc: null,
    escalationLevel: 0,
    slaStatus: null,
  };
}

const prismaFake = {
  evidenceReviewWorkflow: {
    findFirst: async () => workflowRow(),
    findUnique: async () => workflowRow(),
    updateMany: async (args: { data: Record<string, unknown> }) => {
      state.updates.push(args.data);
      return { count: 1 };
    },
    findUniqueOrThrow: async () => workflowRow(),
  },
  evidenceReviewWorkflowEvent: {
    create: async (args: { data: Record<string, unknown> }) => {
      state.events.push(args.data);
      return args.data;
    },
  },
} as never;

beforeEach(() => {
  state.status = "QUEUED";
  state.updates = [];
  state.events = [];
});

describe("Phase 12 Point 4 — bulkAssign delegates to the assignment authority", () => {
  it("records the lifecycle event the single-item path records", async () => {
    const res = await bulkAssign({
      prisma: prismaFake,
      teamId: "team-1",
      actorUserId: "user-1",
      assigneeUserId: "user-2",
      workflowIds: ["wf-1"],
    });
    expect(res).toMatchObject({ ok: true, succeeded: 1 });
    // The proof of delegation: a direct row write cannot produce this.
    expect(state.events.map((e) => e.eventType)).toContain("ASSIGNED");
    expect(state.updates[0]).toMatchObject({
      status: "ASSIGNED",
      assignedToUserId: "user-2",
      assignedByUserId: "user-1",
    });
  });

  it("cannot drag a terminal workflow back to ASSIGNED", async () => {
    // Re-assigning a closed record changes WHO owns it, never its stage:
    // the transition rule keeps the terminal stage, so a bulk action can
    // no longer silently re-open finished work.
    state.status = "CLOSED";
    const res = await bulkAssign({
      prisma: prismaFake,
      teamId: "team-1",
      actorUserId: "user-1",
      assigneeUserId: "user-2",
      workflowIds: ["wf-1"],
    });
    expect(res).toMatchObject({ ok: true, succeeded: 1 });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      status: "CLOSED",
      assignedToUserId: "user-2",
    });
    // And the reassignment is on the record's history.
    expect(state.events.map((e) => e.eventType)).toContain("ASSIGNED");
  });

  it("conceals a workflow from another workspace and writes nothing", async () => {
    const base = prismaFake as unknown as Record<string, Record<string, unknown>>;
    const foreign = {
      ...base,
      evidenceReviewWorkflow: {
        ...base.evidenceReviewWorkflow,
        findFirst: async () => null,
      },
    } as never;
    const res = await bulkAssign({
      prisma: foreign,
      teamId: "other-team",
      actorUserId: "user-1",
      assigneeUserId: "user-2",
      workflowIds: ["wf-1"],
    });
    expect(res).toMatchObject({ ok: true, succeeded: 0 });
    expect(state.updates).toEqual([]);
  });
});
