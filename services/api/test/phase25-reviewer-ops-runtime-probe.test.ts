import { describe, expect, it, vi } from "vitest";

import { DISAGREEMENT_STATES, REVIEW_ESCALATION_STATUSES } from "@proovra/shared";

import { buildReviewerOpsRuntimeProbe } from "../src/services/reviewer-ops/reviewer-ops-runtime-probe.service";

describe("Phase 25 — reviewer ops runtime probe service", () => {
  it("returns a stable safe shape with zero counts when no team data exists", async () => {
    const mockPrisma = {
      evidenceReviewWorkflow: {
        groupBy: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
      reviewEscalation: { groupBy: vi.fn().mockResolvedValue([]) },
      reviewerOpsReminder: { groupBy: vi.fn().mockResolvedValue([]) },
      workflowReviewDecision: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
      reviewerDisagreement: {
        groupBy: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      qcSample: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
      codingSchema: { groupBy: vi.fn().mockResolvedValue([]) },
      workspaceGovernancePolicy: { findUnique: vi.fn().mockResolvedValue(null) },
    } as const;

    const result = await buildReviewerOpsRuntimeProbe({
      teamId: "team-1",
      prisma: mockPrisma as never,
      env: { REVIEWER_OPS_RECONCILIATION_ENABLED: "true" },
    });

    expect(result).toEqual({
      teamId: "team-1",
      workflowCounts: {
        total: 0,
        byStatus: {
          NOT_STARTED: 0,
          IN_REVIEW: 0,
          NEEDS_INFO: 0,
          READY_FOR_EXTERNAL_REVIEW: 0,
          ESCALATED: 0,
          APPROVED_INTERNAL: 0,
          REJECTED_INSUFFICIENT: 0,
          RESPONSE_RECEIVED: 0,
          REOPENED: 0,
          QUEUED: 0,
          ASSIGNED: 0,
          CLOSED: 0,
        },
        queueCounts: {
          assigned: 0,
          queued: 0,
          inProgress: 0,
          escalated: 0,
          completed: 0,
          readyForExternalReview: 0,
        },
        schemaBinding: {
          withSchema: 0,
          withoutSchema: 0,
        },
      },
      decisionCounts: { total: 0 },
      disagreementCounts: {
        total: 0,
        byState: DISAGREEMENT_STATES.reduce(
          (acc, state) => ({ ...acc, [state]: 0 }),
          {} as Record<string, number>,
        ),
      },
      qcSampleCounts: {
        pending: 0,
        rendered7d: 0,
        failureRate7dPct: 0,
      },
      escalationCounts: {
        total: 0,
        byStatus: REVIEW_ESCALATION_STATUSES.reduce(
          (acc, status) => ({ ...acc, [status]: 0 }),
          {} as Record<string, number>,
        ),
      },
      reminderCounts: {
        total: 0,
        byStatus: {
          SCHEDULED: 0,
          DELIVERED: 0,
          FAILED: 0,
          SUPPRESSED: 0,
        },
      },
      schemaCounts: {
        total: 0,
        byStatus: {
          DRAFT: 0,
          PUBLISHED: 0,
          ARCHIVED: 0,
        },
      },
      sla: {
        workspacePolicyConfigured: false,
        workspacePolicyFlags: {
          requireStepUpForApprove: false,
          requireStepUpForReject: false,
          requireStepUpForEscalationResolve: false,
          requireStepUpForBulk: false,
          reviewerInactivityHours: null,
        },
      },
      metrics: {
        throughput7d: 0,
        approvalRate7dPct: 0,
        escalationRate7dPct: 0,
        disagreementRate7dPct: 0,
        qcFailureRate7dPct: 0,
        avgReviewDurationMs7d: 0,
      },
      reconciliation: { enabled: true },
    });
  });

  it("passes the requested teamId into every scoped Prisma query", async () => {
    const mockPrisma = {
      evidenceReviewWorkflow: {
        groupBy: vi.fn().mockResolvedValue([{ status: "IN_REVIEW", _count: { _all: 2 } }]),
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
      reviewEscalation: { groupBy: vi.fn().mockResolvedValue([{ status: "OPEN", _count: { _all: 1 } }]) },
      reviewerOpsReminder: { groupBy: vi.fn().mockResolvedValue([{ status: "SCHEDULED", _count: { _all: 3 } }]) },
      workflowReviewDecision: {
        count: vi.fn().mockResolvedValue(5),
        findMany: vi.fn().mockResolvedValue([]),
      },
      reviewerDisagreement: {
        groupBy: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(2),
      },
      qcSample: {
        count: vi.fn().mockResolvedValue(4),
        findMany: vi.fn().mockResolvedValue([]),
      },
      codingSchema: { groupBy: vi.fn().mockResolvedValue([]) },
      workspaceGovernancePolicy: { findUnique: vi.fn().mockResolvedValue(null) },
    } as const;

    const result = await buildReviewerOpsRuntimeProbe({
      teamId: "team-42",
      prisma: mockPrisma as never,
      env: { REVIEWER_OPS_RECONCILIATION_ENABLED: "false" },
    });

    expect(mockPrisma.evidenceReviewWorkflow.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: "team-42" } }),
    );
    expect(mockPrisma.reviewEscalation.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: "team-42" } }),
    );
    expect(mockPrisma.reviewerOpsReminder.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: "team-42" } }),
    );
    expect(mockPrisma.workflowReviewDecision.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: "team-42" } }),
    );
    expect(mockPrisma.reviewerDisagreement.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: "team-42" } }),
    );
    expect(mockPrisma.qcSample.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ teamId: "team-42" }),
      }),
    );

    expect(result.workflowCounts.total).toBe(2);
    expect(result.escalationCounts.total).toBe(1);
    expect(result.reminderCounts.total).toBe(3);
    expect(result.decisionCounts.total).toBe(5);
    expect(result.disagreementCounts.total).toBe(2);
    expect(result.qcSampleCounts.pending).toBe(4);
    expect(result.reconciliation.enabled).toBe(false);
  });
});
