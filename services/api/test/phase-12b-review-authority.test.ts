/**
 * Track 1C — Review-decision authority convergence.
 *
 * ONE behavioral matrix driving the REAL canonical service
 * (src/services/reviewer-ops/review-decision.service.ts) over a mocked
 * prisma transport, plus the authority guard: no route/service outside
 * the canonical service writes workflow.status for a review decision.
 *
 * Matrix:
 *   - decision success — immutable row + derived projection + audit in
 *     ONE transaction
 *   - duplicate / idempotent decision — no duplicate row, returns the
 *     existing row, zero mutation
 *   - stale / terminal workflow — conflict with ZERO mutation
 *   - optimistic precondition mismatch — conflict with ZERO mutation
 *   - cross-workspace denial — anti-enumeration (indistinguishable from
 *     missing)
 *   - second-review flow — FIRST verdict does not project a terminal
 *     status while a second review is required; disagreeing SECOND
 *     projects ESCALATED; adjudication resolves
 *   - reconciliation repairs a diverged projection (and leaves
 *     lifecycle-reset / consistent workflows alone)
 *   - decision rows are never mutated (append-only source contract)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — bound BEFORE the SUT import.
// ---------------------------------------------------------------------------

vi.mock("../src/db.js", () => ({ prisma: {} }));

const notifyNeedsMoreInfoMock = vi.fn(async () => null);
vi.mock(
  "../src/services/review-operations/review-notifications.service.js",
  () => ({
    notifyReviewAssigned: vi.fn(async () => null),
    notifyReviewEscalated: vi.fn(async () => null),
    notifyReviewNeedsMoreInfo: notifyNeedsMoreInfoMock,
    notifyReviewSlaBreached: vi.fn(async () => null),
  }),
);

const {
  ReviewDecisionAuthorityError,
  deriveDecisionProjection,
  recordReviewDecision,
  reconcileWorkflowProjection,
  scanReviewDecisionProjections,
} = await import("../src/services/reviewer-ops/review-decision.service.js");

// ---------------------------------------------------------------------------
// In-memory prisma fake (transaction-shaped).
// ---------------------------------------------------------------------------

const TEAM_ID = "00000000-0000-0000-0000-0000000000aa";
const OTHER_TEAM_ID = "00000000-0000-0000-0000-0000000000bb";
const WORKFLOW_ID = "00000000-0000-0000-0000-000000000001";
const EVIDENCE_ID = "00000000-0000-0000-0000-000000000002";
const ACTOR_A = "00000000-0000-0000-0000-00000000000a";
const ACTOR_B = "00000000-0000-0000-0000-00000000000b";
const ACTOR_C = "00000000-0000-0000-0000-00000000000c";

type SeedDecision = {
  id?: string;
  stage: "FIRST" | "SECOND" | "ADJUDICATION";
  decision: string;
  reviewerUserId: string;
  decidedAt?: Date;
};

function makeDb(seed: {
  workflow?: Record<string, unknown> | null;
  decisions?: SeedDecision[];
  openEscalation?: boolean;
  legalHolds?: number;
  redactions?: number;
}) {
  const state = {
    workflow: seed.workflow === null
      ? null
      : {
          id: WORKFLOW_ID,
          evidenceId: EVIDENCE_ID,
          teamId: TEAM_ID,
          status: "IN_REVIEW",
          escalationLevel: 0,
          reopenCount: 0,
          completedAtUtc: null as Date | null,
          reopenedAtUtc: null as Date | null,
          lastReviewedAt: null as Date | null,
          rejectionReason: null as string | null,
          ...(seed.workflow ?? {}),
        },
    decisions: (seed.decisions ?? []).map((d, i) => ({
      id: d.id ?? `dec-seed-${i}`,
      workflowId: WORKFLOW_ID,
      teamId: TEAM_ID,
      reasonCode: null,
      rationale: "seed rationale",
      decidedAt: d.decidedAt ?? new Date("2026-07-01T00:00:00Z"),
      ...d,
    })),
    events: [] as Array<Record<string, unknown>>,
    activities: [] as Array<Record<string, unknown>>,
    workflowUpdates: [] as Array<Record<string, unknown>>,
    txCalls: 0,
  };

  const tx = {
    evidenceReviewWorkflow: {
      findFirst: async (args: {
        where: { id: string; teamId?: string };
      }) =>
        state.workflow &&
        state.workflow.id === args.where.id &&
        (args.where.teamId === undefined ||
          state.workflow.teamId === args.where.teamId)
          ? { ...state.workflow }
          : null,
      findUnique: async (args: { where: { id: string } }) =>
        state.workflow && state.workflow.id === args.where.id
          ? { ...state.workflow }
          : null,
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        if (!state.workflow || state.workflow.id !== args.where.id) {
          throw new Error("workflow missing");
        }
        state.workflowUpdates.push(args.data);
        Object.assign(state.workflow, args.data);
        return { ...state.workflow };
      },
    },
    workflowReviewDecision: {
      findMany: async (args: {
        where?: { workflowId?: string; teamId?: string };
        select?: { workflowId?: boolean };
        distinct?: string[];
      }) => {
        const rows = state.decisions.filter(
          (d) =>
            (args.where?.workflowId === undefined ||
              d.workflowId === args.where.workflowId) &&
            (args.where?.teamId === undefined ||
              d.teamId === args.where.teamId),
        );
        if (args.distinct?.includes("workflowId")) {
          const seen = new Set<string>();
          return rows
            .filter((r) =>
              seen.has(r.workflowId) ? false : (seen.add(r.workflowId), true),
            )
            .map((r) => ({ workflowId: r.workflowId }));
        }
        return rows.map((r) => ({ ...r }));
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const dup = state.decisions.some(
          (d) =>
            d.workflowId === args.data.workflowId &&
            d.stage === args.data.stage,
        );
        if (dup) {
          const err = new Error("unique violation") as Error & {
            code: string;
          };
          err.code = "P2002";
          throw err;
        }
        const row = {
          id: `dec-${state.decisions.length + 1}`,
          reasonCode: null,
          decidedAt: new Date(),
          ...args.data,
        } as (typeof state.decisions)[number];
        state.decisions.push(row);
        return { ...row };
      },
      // Deliberately NO update / delete — the immutable log has no
      // mutation surface; any attempt would throw at runtime.
    },
    reviewEscalation: {
      findFirst: async () => (seed.openEscalation ? { id: "esc-1" } : null),
    },
    evidenceLegalHold: {
      count: async () => seed.legalHolds ?? 0,
    },
    evidenceWorkflowVisibilityDecision: {
      count: async () => seed.redactions ?? 0,
    },
    evidenceReviewWorkflowEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.events.push(args.data);
        return args.data;
      },
    },
    teamActivity: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.activities.push(args.data);
        return args.data;
      },
    },
  };

  const prisma = {
    ...tx,
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
      state.txCalls += 1;
      return fn(tx);
    },
  };

  return { prisma: prisma as never, state };
}

beforeEach(() => {
  notifyNeedsMoreInfoMock.mockClear();
});

// ---------------------------------------------------------------------------
// 1 — Behavioral matrix (table-driven core + targeted cases).
// ---------------------------------------------------------------------------

describe("canonical recordReviewDecision — decision success", () => {
  it("appends the immutable row, derives the projection, and audits in ONE transaction", async () => {
    const { prisma, state } = makeDb({});
    const result = await recordReviewDecision(
      {
        workflowId: WORKFLOW_ID,
        teamId: TEAM_ID,
        actorUserId: ACTOR_A,
        decision: "APPROVE",
        rationale: "Looks complete.",
      },
      prisma,
    );

    expect(result.idempotent).toBe(false);
    expect(result.state).toBe("resolved");
    // Immutable row appended.
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]).toMatchObject({
      stage: "FIRST",
      decision: "APPROVE",
      reviewerUserId: ACTOR_A,
    });
    // Projection derived in the same transaction.
    expect(state.workflow?.status).toBe("APPROVED_INTERNAL");
    expect(state.workflow?.completedAtUtc).toBeInstanceOf(Date);
    // Audit: workflow event history + workspace activity feed.
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ eventType: "DECISION_LOGGED" });
    expect(state.activities).toHaveLength(1);
    expect(state.activities[0]).toMatchObject({
      eventType: "REVIEWER_DECISION_FIRST",
      targetType: "workflow_review_decision",
    });
    // ONE transaction wrapped the whole command.
    expect(state.txCalls).toBe(1);
  });

  // Table-driven outcome mapping for single-stage resolutions.
  const outcomes = [
    { decision: "APPROVE", rationale: "", projected: "APPROVED_INTERNAL" },
    {
      decision: "REJECT",
      rationale: "Insufficient custody data.",
      projected: "REJECTED_INSUFFICIENT",
    },
    {
      decision: "REQUEST_INFO",
      rationale: "Need the original capture context.",
      /*
       * NEEDS_INFO, not NEEDS_MORE_INFO.
       *
       * This row asserted the STAGE name, and the stage name is not the value
       * the column stores: EvidenceReviewWorkflowStatus has NEEDS_INFO. The
       * service reached the column through a blanket cast, so the fake prisma
       * here accepted the stage string and this assertion locked it in —
       * while a real Postgres rejected it and turned a valid
       * request-more-info decision into a 500.
       */
      projected: "NEEDS_INFO",
    },
  ] as const;
  for (const row of outcomes) {
    it(`projects ${row.decision} → ${row.projected}`, async () => {
      const { prisma, state } = makeDb({});
      await recordReviewDecision(
        {
          workflowId: WORKFLOW_ID,
          teamId: TEAM_ID,
          actorUserId: ACTOR_A,
          decision: row.decision,
          rationale: row.rationale,
        },
        prisma,
      );
      expect(state.workflow?.status).toBe(row.projected);
    });
  }

  it("REJECT stores the rationale as the rejection reason", async () => {
    const { prisma, state } = makeDb({});
    await recordReviewDecision(
      {
        workflowId: WORKFLOW_ID,
        teamId: TEAM_ID,
        actorUserId: ACTOR_A,
        decision: "REJECT",
        rationale: "Chain of custody gap.",
      },
      prisma,
    );
    expect(state.workflow?.rejectionReason).toBe("Chain of custody gap.");
    expect(state.workflow?.completedAtUtc).toBeInstanceOf(Date);
  });

  it("requires a rationale for non-APPROVE decisions (zero mutation)", async () => {
    const { prisma, state } = makeDb({});
    await expect(
      recordReviewDecision(
        {
          workflowId: WORKFLOW_ID,
          teamId: TEAM_ID,
          actorUserId: ACTOR_A,
          decision: "REJECT",
          rationale: "   ",
        },
        prisma,
      ),
    ).rejects.toMatchObject({ code: "rationale_required" });
    expect(state.decisions).toHaveLength(0);
    expect(state.workflowUpdates).toHaveLength(0);
  });
});

describe("canonical recordReviewDecision — second-review flow", () => {
  it("FIRST verdict under a second-review trigger does NOT project a terminal status", async () => {
    const { prisma, state } = makeDb({ legalHolds: 1 });
    const result = await recordReviewDecision(
      {
        workflowId: WORKFLOW_ID,
        teamId: TEAM_ID,
        actorUserId: ACTOR_A,
        decision: "APPROVE",
        rationale: "First pass fine.",
      },
      prisma,
    );
    expect(result.state).toBe("second_required");
    expect(state.decisions).toHaveLength(1);
    // Status projection unchanged — the log does not yet resolve.
    expect(state.workflow?.status).toBe("IN_REVIEW");
  });

  it("blocks the FIRST reviewer from submitting the SECOND (independence)", async () => {
    const { prisma, state } = makeDb({
      legalHolds: 1,
      decisions: [
        { stage: "FIRST", decision: "APPROVE", reviewerUserId: ACTOR_A },
      ],
    });
    await expect(
      recordReviewDecision(
        {
          workflowId: WORKFLOW_ID,
          teamId: TEAM_ID,
          actorUserId: ACTOR_A,
          decision: "REJECT",
          rationale: "Changed my mind.",
        },
        prisma,
      ),
    ).rejects.toMatchObject({ code: "same_reviewer_blocked" });
    expect(state.decisions).toHaveLength(1);
    expect(state.workflowUpdates).toHaveLength(0);
  });

  it("a disagreeing SECOND verdict projects ESCALATED (conflict)", async () => {
    const { prisma, state } = makeDb({
      legalHolds: 1,
      decisions: [
        { stage: "FIRST", decision: "APPROVE", reviewerUserId: ACTOR_A },
      ],
    });
    const result = await recordReviewDecision(
      {
        workflowId: WORKFLOW_ID,
        teamId: TEAM_ID,
        actorUserId: ACTOR_B,
        decision: "REJECT",
        rationale: "Integrity concern.",
      },
      prisma,
    );
    expect(result.state).toBe("conflict_detected");
    expect(state.workflow?.status).toBe("ESCALATED");
    expect(state.workflow?.escalationLevel).toBe(1);
  });

  it("adjudication requires caller-asserted OWNER/ADMIN authority", async () => {
    const seed = {
      decisions: [
        { stage: "FIRST" as const, decision: "APPROVE", reviewerUserId: ACTOR_A },
        { stage: "SECOND" as const, decision: "REJECT", reviewerUserId: ACTOR_B },
      ],
    };
    const denied = makeDb(seed);
    await expect(
      recordReviewDecision(
        {
          workflowId: WORKFLOW_ID,
          teamId: TEAM_ID,
          actorUserId: ACTOR_C,
          decision: "UPHOLD_FIRST",
          rationale: "First review stands.",
          actorIsAdjudicator: false,
        },
        denied.prisma,
      ),
    ).rejects.toMatchObject({ code: "adjudicator_role_required" });
    expect(denied.state.decisions).toHaveLength(2);
    expect(denied.state.workflowUpdates).toHaveLength(0);

    const allowed = makeDb(seed);
    const result = await recordReviewDecision(
      {
        workflowId: WORKFLOW_ID,
        teamId: TEAM_ID,
        actorUserId: ACTOR_C,
        decision: "UPHOLD_FIRST",
        rationale: "First review stands.",
        actorIsAdjudicator: true,
      },
      allowed.prisma,
    );
    expect(result.state).toBe("resolved");
    // UPHOLD_FIRST resolves to the FIRST verdict (APPROVE).
    expect(allowed.state.workflow?.status).toBe("APPROVED_INTERNAL");
    expect(allowed.state.activities[0]).toMatchObject({
      eventType: "REVIEWER_DECISION_ADJUDICATION",
    });
  });

  it("rejects adjudication-only kinds outside ADJUDICATION", async () => {
    const { prisma, state } = makeDb({});
    await expect(
      recordReviewDecision(
        {
          workflowId: WORKFLOW_ID,
          teamId: TEAM_ID,
          actorUserId: ACTOR_A,
          decision: "UPHOLD_FIRST",
          rationale: "n/a",
        },
        prisma,
      ),
    ).rejects.toMatchObject({ code: "decision_kind_not_allowed" });
    expect(state.decisions).toHaveLength(0);
  });
});

describe("canonical recordReviewDecision — idempotency", () => {
  it("an identical decision (same workflow + actor + kind) returns the existing row, zero mutation", async () => {
    const { prisma, state } = makeDb({
      decisions: [
        {
          id: "dec-original",
          stage: "FIRST",
          decision: "APPROVE",
          reviewerUserId: ACTOR_A,
        },
      ],
      workflow: { status: "APPROVED_INTERNAL" },
    });
    const result = await recordReviewDecision(
      {
        workflowId: WORKFLOW_ID,
        teamId: TEAM_ID,
        actorUserId: ACTOR_A,
        decision: "APPROVE",
        rationale: "retry after network blip",
      },
      prisma,
    );
    expect(result.idempotent).toBe(true);
    expect(result.decision.id).toBe("dec-original");
    // No duplicate row, no projection churn, no audit spam.
    expect(state.decisions).toHaveLength(1);
    expect(state.workflowUpdates).toHaveLength(0);
    expect(state.events).toHaveLength(0);
    expect(state.activities).toHaveLength(0);
  });

  it("a concurrent duplicate at the same stage surfaces as a conflict (P2002 → duplicate_stage_decision)", async () => {
    const { prisma, state } = makeDb({});
    // Simulate the race: another writer lands a FIRST row between the
    // read and the create.
    const origFindMany = (
      prisma as unknown as {
        workflowReviewDecision: { findMany: (a: unknown) => Promise<unknown[]> };
      }
    ).workflowReviewDecision.findMany;
    let injected = false;
    (
      prisma as unknown as {
        workflowReviewDecision: { findMany: (a: unknown) => Promise<unknown[]> };
      }
    ).workflowReviewDecision.findMany = async (a: unknown) => {
      const rows = await origFindMany(a);
      if (!injected) {
        injected = true;
        state.decisions.push({
          id: "dec-racer",
          workflowId: WORKFLOW_ID,
          teamId: TEAM_ID,
          stage: "FIRST",
          decision: "REJECT",
          reviewerUserId: ACTOR_B,
          reasonCode: null,
          rationale: "raced",
          decidedAt: new Date(),
        });
      }
      return rows;
    };
    await expect(
      recordReviewDecision(
        {
          workflowId: WORKFLOW_ID,
          teamId: TEAM_ID,
          actorUserId: ACTOR_A,
          decision: "APPROVE",
          rationale: "",
        },
        prisma,
      ),
    ).rejects.toMatchObject({ code: "duplicate_stage_decision" });
    // Only the racer's row exists; ours was rejected by the unique
    // constraint and the projection was never touched.
    expect(state.decisions).toHaveLength(1);
    expect(state.workflowUpdates).toHaveLength(0);
  });
});

describe("canonical recordReviewDecision — stale / terminal denial", () => {
  const terminalStatuses = ["APPROVED_INTERNAL", "REJECTED_INSUFFICIENT", "CLOSED"];
  for (const status of terminalStatuses) {
    it(`terminal workflow (${status}) → conflict with ZERO mutation`, async () => {
      const { prisma, state } = makeDb({ workflow: { status } });
      await expect(
        recordReviewDecision(
          {
            workflowId: WORKFLOW_ID,
            teamId: TEAM_ID,
            actorUserId: ACTOR_B,
            decision: "REJECT",
            rationale: "too late",
          },
          prisma,
        ),
      ).rejects.toMatchObject({ code: "review_already_resolved" });
      expect(state.decisions).toHaveLength(0);
      expect(state.workflowUpdates).toHaveLength(0);
      expect(state.events).toHaveLength(0);
    });
  }

  it("optimistic precondition mismatch → stale_decision conflict, ZERO mutation", async () => {
    const { prisma, state } = makeDb({ workflow: { status: "IN_REVIEW" } });
    await expect(
      recordReviewDecision(
        {
          workflowId: WORKFLOW_ID,
          teamId: TEAM_ID,
          actorUserId: ACTOR_A,
          decision: "APPROVE",
          rationale: "",
          expectedStatus: "ASSIGNED",
        },
        prisma,
      ),
    ).rejects.toMatchObject({ code: "stale_decision" });
    expect(state.decisions).toHaveLength(0);
    expect(state.workflowUpdates).toHaveLength(0);
  });

  it("an already-resolved decision log (different actor) → conflict, no duplicate row", async () => {
    const { prisma, state } = makeDb({
      decisions: [
        { stage: "FIRST", decision: "APPROVE", reviewerUserId: ACTOR_A },
      ],
      workflow: { status: "APPROVED_INTERNAL" },
    });
    await expect(
      recordReviewDecision(
        {
          workflowId: WORKFLOW_ID,
          teamId: TEAM_ID,
          actorUserId: ACTOR_B,
          decision: "REJECT",
          rationale: "I disagree",
        },
        prisma,
      ),
    ).rejects.toMatchObject({ code: "review_already_resolved" });
    expect(state.decisions).toHaveLength(1);
    expect(state.workflowUpdates).toHaveLength(0);
  });
});

describe("canonical recordReviewDecision — cross-workspace denial (anti-enumeration)", () => {
  it("a workflow in another workspace is indistinguishable from a missing workflow", async () => {
    const other = makeDb({ workflow: { teamId: OTHER_TEAM_ID } });
    const missing = makeDb({ workflow: null });

    const probeOther = recordReviewDecision(
      {
        workflowId: WORKFLOW_ID,
        teamId: TEAM_ID,
        actorUserId: ACTOR_A,
        decision: "APPROVE",
        rationale: "",
      },
      other.prisma,
    );
    const probeMissing = recordReviewDecision(
      {
        workflowId: WORKFLOW_ID,
        teamId: TEAM_ID,
        actorUserId: ACTOR_A,
        decision: "APPROVE",
        rationale: "",
      },
      missing.prisma,
    );
    const [errOther, errMissing] = await Promise.all([
      probeOther.catch((e) => e),
      probeMissing.catch((e) => e),
    ]);
    expect(errOther).toBeInstanceOf(ReviewDecisionAuthorityError);
    expect(errMissing).toBeInstanceOf(ReviewDecisionAuthorityError);
    expect(errOther.code).toBe("workflow_not_found");
    expect(errMissing.code).toBe("workflow_not_found");
    // ZERO mutation on the cross-workspace target.
    expect(other.state.decisions).toHaveLength(0);
    expect(other.state.workflowUpdates).toHaveLength(0);
  });
});

describe("reconcileWorkflowProjection — repairing divergence", () => {
  it("repairs a diverged projection from the immutable log", async () => {
    // Log says resolved-APPROVE; projection was never updated (the
    // exact pre-convergence divergence this track closes).
    const { prisma, state } = makeDb({
      decisions: [
        { stage: "FIRST", decision: "APPROVE", reviewerUserId: ACTOR_A },
      ],
      workflow: { status: "IN_REVIEW" },
    });
    const result = await reconcileWorkflowProjection(WORKFLOW_ID, prisma);
    expect(result).toMatchObject({
      repaired: true,
      reason: "repaired",
      fromStage: "IN_REVIEW",
      toStage: "APPROVED_INTERNAL",
    });
    expect(state.workflow?.status).toBe("APPROVED_INTERNAL");
    expect(state.workflow?.completedAtUtc).toBeInstanceOf(Date);
    expect(state.events[0]).toMatchObject({ eventType: "STAGE_CHANGED" });
  });

  it("is a no-op when the projection is consistent", async () => {
    const { prisma, state } = makeDb({
      decisions: [
        { stage: "FIRST", decision: "REJECT", reviewerUserId: ACTOR_A },
      ],
      workflow: { status: "REJECTED_INSUFFICIENT" },
    });
    const result = await reconcileWorkflowProjection(WORKFLOW_ID, prisma);
    expect(result).toMatchObject({ repaired: false, reason: "consistent" });
    expect(state.workflowUpdates).toHaveLength(0);
  });

  it("leaves lifecycle-only workflows (no decisions) alone", async () => {
    const { prisma, state } = makeDb({ workflow: { status: "ASSIGNED" } });
    const result = await reconcileWorkflowProjection(WORKFLOW_ID, prisma);
    expect(result).toMatchObject({ repaired: false, reason: "no_decisions" });
    expect(state.workflowUpdates).toHaveLength(0);
  });

  it("does NOT repair a workflow reopened AFTER the latest decision (lifecycle reset wins)", async () => {
    const { prisma, state } = makeDb({
      decisions: [
        {
          stage: "FIRST",
          decision: "APPROVE",
          reviewerUserId: ACTOR_A,
          decidedAt: new Date("2026-07-01T00:00:00Z"),
        },
      ],
      workflow: {
        status: "REOPENED",
        reopenedAtUtc: new Date("2026-07-02T00:00:00Z"),
      },
    });
    const result = await reconcileWorkflowProjection(WORKFLOW_ID, prisma);
    expect(result).toMatchObject({
      repaired: false,
      reason: "reopened_after_decisions",
    });
    expect(state.workflow?.status).toBe("REOPENED");
  });

  it("does not project intermediate states (awaiting second review)", async () => {
    const { prisma, state } = makeDb({
      legalHolds: 1,
      decisions: [
        { stage: "FIRST", decision: "APPROVE", reviewerUserId: ACTOR_A },
      ],
      workflow: { status: "IN_REVIEW" },
    });
    const result = await reconcileWorkflowProjection(WORKFLOW_ID, prisma);
    expect(result).toMatchObject({
      repaired: false,
      reason: "no_projectable_outcome",
    });
    expect(state.workflow?.status).toBe("IN_REVIEW");
  });

  it("bounded scan variant reconciles workflows with decisions and reports repairs", async () => {
    const { prisma, state } = makeDb({
      decisions: [
        { stage: "FIRST", decision: "APPROVE", reviewerUserId: ACTOR_A },
      ],
      workflow: { status: "IN_REVIEW" },
    });
    const result = await scanReviewDecisionProjections(
      { teamId: TEAM_ID, batchSize: 50 },
      prisma,
    );
    expect(result.scanned).toBe(1);
    expect(result.repaired).toBe(1);
    expect(result.failures).toBe(0);
    expect(state.workflow?.status).toBe("APPROVED_INTERNAL");
  });
});

describe("derivation — pure projection function", () => {
  it("UNRESOLVED adjudication projects ESCALATED", () => {
    const projection = deriveDecisionProjection(
      [
        { stage: "FIRST", decision: "APPROVE", reviewerUserId: ACTOR_A },
        { stage: "SECOND", decision: "REJECT", reviewerUserId: ACTOR_B },
        { stage: "ADJUDICATION", decision: "UNRESOLVED", reviewerUserId: ACTOR_C },
      ],
      false,
    );
    expect(projection.state).toBe("resolved");
    expect(projection.projectedStage).toBe("ESCALATED");
  });

  it("UPHOLD_SECOND resolves to the SECOND verdict", () => {
    const projection = deriveDecisionProjection(
      [
        { stage: "FIRST", decision: "APPROVE", reviewerUserId: ACTOR_A },
        { stage: "SECOND", decision: "REJECT", reviewerUserId: ACTOR_B },
        {
          stage: "ADJUDICATION",
          decision: "UPHOLD_SECOND",
          reviewerUserId: ACTOR_C,
        },
      ],
      false,
    );
    expect(projection.projectedStage).toBe("REJECTED_INSUFFICIENT");
  });
});

// ---------------------------------------------------------------------------
// 2 — Authority guard: decision rows are never mutated, and no
// route/service outside the canonical service writes workflow.status
// for a review decision.
// ---------------------------------------------------------------------------

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

function readSrc(rel: string): string {
  return readFileSync(join(SRC_ROOT, rel), "utf8");
}

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTsFiles(full, acc);
    else if (full.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

describe("authority guard — ONE decision writer", () => {
  const CANONICAL = join(
    SRC_ROOT,
    "services",
    "reviewer-ops",
    "review-decision.service.ts",
  );

  it("workflowReviewDecision.create exists ONLY in the canonical service (repo-wide src scan, no allowlist)", () => {
    const offenders = walkTsFiles(SRC_ROOT).filter((file) => {
      if (file === CANONICAL) return false;
      return /workflowReviewDecision\s*\.\s*create\s*\(/.test(
        readFileSync(file, "utf8"),
      );
    });
    expect(offenders).toEqual([]);
  });

  it("decision rows are append-only — the canonical service never updates or deletes them", () => {
    const src = readFileSync(CANONICAL, "utf8");
    expect(src).not.toMatch(
      /workflowReviewDecision\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\s*\(/,
    );
    // And nowhere else in src either.
    const offenders = walkTsFiles(SRC_ROOT).filter((file) =>
      /workflowReviewDecision\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\s*\(/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("the legacy lifecycle service no longer carries verdict branches (approve/reject/request-info removed)", () => {
    const src = readSrc(
      join("services", "review-operations", "review-operations.service.ts"),
    );
    // The lifecycle transition writer is narrowed to routing transitions.
    expect(src).toMatch(
      /ReviewLifecycleTransitionType\s*=\s*Extract<\s*ReviewDecisionType,\s*"ESCALATE"\s*\|\s*"REOPEN"\s*\|\s*"CLOSE"\s*>/,
    );
    expect(src).not.toMatch(/case "APPROVE_INTERNAL":/);
    expect(src).not.toMatch(/case "REJECT_INSUFFICIENT":/);
    // REQUEST_MORE_INFO remains ONLY as the bulk-action case that
    // delegates to the canonical authority.
    const bulkCase = src.match(
      /case "REQUEST_MORE_INFO":[\s\S]*?break;/,
    );
    expect(bulkCase).not.toBeNull();
    expect(bulkCase![0]).toMatch(/recordCanonicalReviewDecision\(/);
  });

  it("the reviewer-ops engine records verdicts ONLY through the canonical authority", () => {
    const src = readSrc(
      join("services", "reviewer-ops", "reviewer-operations-engine.service.ts"),
    );
    expect(src).not.toMatch(/legacyRecordReviewDecision/);
    for (const fn of [
      "async function approveReviewInner",
      "export async function rejectReview",
      "export async function requestInformation",
    ]) {
      const declIdx = src.indexOf(fn);
      expect(declIdx).toBeGreaterThan(-1);
      const nextFn = src.indexOf("\n// -", declIdx + 1);
      const body = src.slice(declIdx, nextFn === -1 ? undefined : nextFn);
      expect(body).toMatch(/recordDecisionViaAuthority\(/);
      // No direct decision-status write inside the verdict paths.
      expect(body).not.toMatch(
        /status:\s*"(APPROVED_INTERNAL|REJECTED_INSUFFICIENT|NEEDS_MORE_INFO|NEEDS_INFO)"/,
      );
    }
  });

  it("neither review route file writes decision status directly or creates decision rows inline", () => {
    for (const rel of [
      join("routes", "review-operations.routes.ts"),
      join("routes", "reviewer-ops.routes.ts"),
    ]) {
      const src = readSrc(rel);
      expect(src).not.toMatch(/workflowReviewDecision\s*\.\s*create\s*\(/);
      expect(src).not.toMatch(
        /status:\s*"(APPROVED_INTERNAL|REJECTED_INSUFFICIENT|NEEDS_MORE_INFO|NEEDS_INFO)"/,
      );
    }
  });

  it("the /v1/review-operations decision route splits verdicts (canonical) from lifecycle routing", () => {
    const src = readSrc(join("routes", "review-operations.routes.ts"));
    // Verdicts flow through the canonical import.
    expect(src).toMatch(
      /from "\.\.\/services\/reviewer-ops\/review-decision\.service\.js"/,
    );
    expect(src).toMatch(/recordReviewDecision\(\{/);
    // Lifecycle routing (escalate / reopen / close) uses the narrowed
    // transition writer, and the verdict vocabulary can never reach it.
    expect(src).toMatch(/recordLifecycleTransition\(\{/);
    expect(src).not.toMatch(
      /recordLifecycleTransition\(\{[\s\S]{0,600}?"(APPROVE_INTERNAL|REJECT_INSUFFICIENT|REQUEST_MORE_INFO)"/,
    );
  });

  it("the reviewer-ops multi-stage decision POST delegates to the canonical authority", () => {
    const src = readSrc(join("routes", "reviewer-ops.routes.ts"));
    expect(src).toMatch(/recordCanonicalReviewDecision\(\{/);
  });
});
