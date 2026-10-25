/**
 * Review workflow — a repeated click has ONE outcome (2026-10-23).
 *
 * Claim, Escalate and Reopen from the Evidence page looked like they did
 * nothing, and a second click made it worse: a claim by the reviewer who
 * already owned the review appended another CLAIMED event; a second Escalate
 * raised the escalation level and emailed the assignee again; a second Reopen
 * bumped the reopen count. The shared stage matrix allows a stage to
 * "transition" to itself (a heartbeat), and both services leaned on it.
 *
 * These drive the REAL service functions against an injected client that
 * records every write, so the assertion is about what reaches the database.
 */

import { describe, expect, it, vi } from "vitest";

// The escalation engine is its own authority with its own (real-database)
// coverage in review-workflow-state-machine.integration.test.ts; here only
// what the lifecycle service ASKS it for is recorded.
const escalations: Array<Record<string, unknown>> = [];
vi.mock("../src/services/reviewer-ops/escalation-engine.service.js", () => ({
  createEscalation: async (input: Record<string, unknown>) => {
    escalations.push(input);
    return { ok: true, created: true, escalation: { id: "esc-1" } };
  },
  suppressEscalation: async () => ({}),
  resolveOpenReviewEscalation: async () => undefined,
}));
// Review activity (reviewer audit + tenant audit — never custody) has its own real-database coverage
// (review-roles-and-journey.integration.test.ts); here only what the
// lifecycle service records is kept.
const activity: Array<Record<string, unknown>> = [];
vi.mock("../src/services/evidence-review/reviewer-audit.service.js", () => ({
  recordReviewActivityTx: async (_tx: unknown, input: Record<string, unknown>) => {
    activity.push(input);
  },
}));

import {
  ReviewOperationError,
  claimReviewerWorkflow,
  recordLifecycleTransition,
} from "../src/services/review-operations/review-operations.service.js";

// Who may claim is proven against PostgreSQL (members-unassigned-rule and the
// review suites); this suite is about the claim's idempotency.
vi.mock("../src/services/assignment/assignee-eligibility.js", () => ({
  AssigneeEligibilityError: class AssigneeEligibilityError extends Error {},
  assertWorkAssigneeEligible: async () => undefined,
}));


// The placement prerequisite is proven against PostgreSQL in
// members-unassigned-rule.integration.test.ts; this suite tests its own module.
vi.mock("../src/services/assignment/placement-policy.js", () => ({
  assignmentRequiresPlacement: async () => false,
  meetsPlacementPolicy: async () => true,
  placedUserIdsForWorkspace: async (_workspaceId: string, ids: readonly string[]) => new Set(ids),
}));


const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const EVIDENCE = "22222222-2222-4222-8222-222222222222";

function workflow(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    evidenceId: EVIDENCE,
    teamId: "33333333-3333-4333-8333-333333333333",
    status: "NOT_STARTED",
    assignedToUserId: null,
    assignedByUserId: null,
    assignedAtUtc: null,
    escalationLevel: 0,
    reopenCount: 0,
    ...over,
  };
}

/** A client that answers the reads and RECORDS every write. */
function recordingClient(row: Record<string, unknown>) {
  const writes: Array<{ op: string; args: unknown }> = [];
  const client = {
    evidenceReviewWorkflow: {
      findUnique: async () => row,
      findUniqueOrThrow: async () => row,
      findFirst: async () => row,
      updateMany: async (args: unknown) => {
        writes.push({ op: "workflow.updateMany", args });
        return { count: 1 };
      },
      update: async (args: unknown) => {
        writes.push({ op: "workflow.update", args });
        return row;
      },
    },
    evidenceReviewWorkflowEvent: {
      create: async (args: unknown) => {
        writes.push({ op: "event.create", args });
        return {};
      },
    },
  };
  // A lifecycle decision that opens an escalation runs in one transaction.
  (client as Record<string, unknown>).$transaction = async (fn: (tx: unknown) => unknown) => fn(client);
  return { client: client as never, writes };
}

async function refusal(p: Promise<unknown>): Promise<ReviewOperationError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ReviewOperationError);
    return err as ReviewOperationError;
  }
  throw new Error("expected a refusal");
}

describe("claim", () => {
  it("an unassigned, not-started review: assigns, moves to ASSIGNED, writes ONE CLAIMED event", async () => {
    const { client, writes } = recordingClient(workflow());
    await claimReviewerWorkflow({ evidenceId: EVIDENCE, actorUserId: ME }, client);
    const update = writes.find((w) => w.op === "workflow.updateMany")!.args as { data: Record<string, unknown> };
    expect(update.data.assignedToUserId).toBe(ME);
    expect(update.data.status).toBe("ASSIGNED");
    expect(writes.filter((w) => w.op === "event.create")).toHaveLength(1);
  });

  it("the owner claiming again writes NOTHING and returns the workflow unchanged", async () => {
    const row = workflow({ status: "ASSIGNED", assignedToUserId: ME });
    const { client, writes } = recordingClient(row);
    const out = await claimReviewerWorkflow({ evidenceId: EVIDENCE, actorUserId: ME }, client);
    expect(out).toBe(row);
    expect(writes).toEqual([]);
  });

  it("someone else's review is refused (409 already_assigned_elsewhere), nothing written", async () => {
    const { client, writes } = recordingClient(workflow({ status: "ASSIGNED", assignedToUserId: OTHER }));
    const err = await refusal(claimReviewerWorkflow({ evidenceId: EVIDENCE, actorUserId: ME }, client));
    expect(err.code).toBe("already_assigned_elsewhere");
    expect(writes).toEqual([]);
  });
});

describe("lifecycle decisions into the stage the review is already in", () => {
  for (const [status, decision, note] of [
    ["ESCALATED", "ESCALATE", "still blocked"],
    ["REOPENED", "REOPEN", "again"],
    ["CLOSED", "CLOSE", null],
  ] as const) {
    it(`${decision} from ${status} is refused with already_in_stage and writes nothing`, async () => {
      const { client, writes } = recordingClient(workflow({ status, assignedToUserId: ME }));
      const err = await refusal(
        recordLifecycleTransition(
          { evidenceId: EVIDENCE, actorUserId: ME, decision, note, escalationReason: note },
          client,
        ),
      );
      expect(err.code).toBe("already_in_stage");
      expect(writes).toEqual([]);
    });
  }

  it("a real transition still happens: ESCALATE from IN_REVIEW raises the level once and writes one event", async () => {
    const { client, writes } = recordingClient(workflow({ status: "IN_REVIEW", assignedToUserId: ME }));
    await recordLifecycleTransition(
      { evidenceId: EVIDENCE, actorUserId: ME, decision: "ESCALATE", note: "needs counsel", escalationReason: "needs counsel" },
      client,
    );
    const update = writes.find((w) => w.op === "workflow.updateMany")!.args as { data: Record<string, unknown> };
    expect(update.data.status).toBe("ESCALATED");
    expect(update.data.escalationLevel).toBe(1);
    expect(writes.filter((w) => w.op === "event.create")).toHaveLength(1);
    // Recorded once as Review activity, in the same transaction — never custody.
    const escalatedActivity = activity.filter((a) => a.code === "REVIEW_ESCALATION_CREATED");
    expect(escalatedActivity).toHaveLength(1);
    expect(escalatedActivity[0]).toMatchObject({ actorUserId: ME, resultingState: "IN_REVIEW" });
    // A real escalation, routed to the workspace's admins (unassigned), with
    // the reviewer's reason.
    expect(escalations.at(-1)).toMatchObject({
      reason: "REVIEWER_ESCALATED",
      routeToWorkspaceAdmins: true,
      createdByUserId: ME,
      safeSummary: "needs counsel",
    });
  });
});

describe("the route maps the new refusal to 409", () => {
  it("already_in_stage is a conflict, like already_assigned_elsewhere", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../src/routes/review-operations.routes.ts"), "utf8");
    expect(src).toMatch(/err\.code === "already_assigned_elsewhere" \|\| err\.code === "already_in_stage"\s*\n\s*\? 409/);
  });
});

describe("the administrative PATCH cannot record a verdict", () => {
  it("READY_FOR_EXTERNAL_REVIEW (the legacy approval, which satisfies the export gate) is not a routing state", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../src/routes/evidence.routes.ts"), "utf8");
    expect(src).toContain(`LEGACY_VERDICT_WORKFLOW_STATUSES: ReadonlySet<string> = new Set(["READY_FOR_EXTERNAL_REVIEW"])`);
    expect(src).toContain("!isDecisionDerivedWorkflowStatus(s) && !LEGACY_VERDICT_WORKFLOW_STATUSES.has(s)");
    expect(src).toContain("status: z.enum(ROUTING_WORKFLOW_STATUSES).optional()");
  });
});
