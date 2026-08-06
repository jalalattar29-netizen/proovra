/**
 * Phase 3 — QC sampling producer wiring.
 *
 * Locks the canonical wiring of `sampleClosedWorkflow` into the
 * reviewer-ops engine close path (approveReview + rejectReview).
 *
 * Single chokepoint: the engine layer. Every route, bulk, and future
 * programmatic close funnels through approveReview/rejectReview, so
 * one wiring point covers all callers.
 *
 * Hard rules locked here:
 *
 *   1. Approving a workflow calls sampleClosedWorkflow with
 *      { teamId, workflowId, decision: "APPROVE_INTERNAL" }.
 *
 *   2. Rejecting a workflow calls sampleClosedWorkflow with
 *      { teamId, workflowId, decision: "REJECT_INSUFFICIENT" }.
 *
 *   3. Idempotency: sampleClosedWorkflow short-circuits when a
 *      QcSample already exists for (workflowId, teamId). The
 *      existence check runs BEFORE the RNG roll so a second close
 *      attempt is guaranteed to return the existing sample id
 *      rather than re-rolling.
 *
 *   4. Best-effort: when sampleClosedWorkflow throws, the close
 *      transaction still succeeds. The engine logs a structured
 *      warn ("qc.sample_on_close.failed") and returns the workflow
 *      projection as if QC sampling had never been attempted.
 *
 *   5. Source-text wiring contract: the engine imports
 *      sampleClosedWorkflow from the canonical qc-sample.service
 *      module and uses the same constant from both approve + reject
 *      branches.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — bound BEFORE the SUT import so the engine sees stubs.
// ---------------------------------------------------------------------------

const sampleClosedWorkflowMock = vi.fn();
vi.mock(
  "../src/services/reviewer-workspace/qc-sample.service.js",
  () => ({
    sampleClosedWorkflow: sampleClosedWorkflowMock,
  }),
);

const legacyProjectReviewWorkflowMock = vi.fn(() => ({
  workflowId: "wf-1",
  stage: "APPROVED",
}));
vi.mock("../src/services/review-operations/review-operations.service.js", () => ({
  // Only the symbols the engine imports need to be exported.
  assignReviewer: vi.fn(),
  bulkReviewAction: vi.fn(),
  claimReviewerWorkflow: vi.fn(),
  ensureReviewWorkflow: vi.fn(),
  getReviewQueueCounts: vi.fn(),
  listReviewQueue: vi.fn(),
  projectReviewWorkflow: legacyProjectReviewWorkflowMock,
  reconcileReviewSlas: vi.fn(),
  updateReviewSla: vi.fn(),
}));

// Track 1C — the engine records verdicts through the canonical
// decision authority (immutable decision row + derived projection in
// one transaction). The mock returns the authority result envelope.
const canonicalRecordReviewDecisionMock = vi.fn();
vi.mock("../src/services/reviewer-ops/review-decision.service.js", () => ({
  ReviewDecisionAuthorityError: class ReviewDecisionAuthorityError extends Error {
    constructor(
      public readonly code: string,
      public readonly details?: Record<string, unknown>,
    ) {
      super(code);
    }
  },
  recordReviewDecision: canonicalRecordReviewDecisionMock,
}));

function authorityResult(workflow: Record<string, unknown>) {
  return {
    workflow,
    decision: { id: "dec-1" },
    state: "resolved",
    idempotent: false,
  };
}

const findOpenEscalationForWorkflowMock = vi.fn(async () => null);
vi.mock("../src/services/reviewer-ops/escalation-engine.service.js", () => ({
  createEscalation: vi.fn(),
  findOpenEscalationForWorkflow: findOpenEscalationForWorkflowMock,
}));

vi.mock("../src/services/reviewer-ops/workload.service.js", () => ({
  snapshotWorkspaceWorkload: vi.fn(),
  suggestReviewers: vi.fn(),
  listLatestWorkloadSnapshots: vi.fn(),
}));

vi.mock("../src/services/reviewer-ops/sla-policy.service.js", () => ({
  loadWorkspaceReviewerOpsFlags: vi.fn(),
  resolveEffectiveSlaPolicy: vi.fn(),
}));

vi.mock("../src/services/reviewer-ops/reminder-engine.service.js", () => ({
  sweepDueSoonReminders: vi.fn(),
  sweepInactivityReminders: vi.fn(),
}));

const safeEmitSecurityEventMock = vi.fn();
vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: safeEmitSecurityEventMock,
}));

const appendPlatformAuditLogMock = vi.fn(async () => undefined);
vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: appendPlatformAuditLogMock,
}));

vi.mock("../src/services/observability/incident.service.js", () => ({
  recordIncident: vi.fn(),
}));

vi.mock("../src/services/ops/metrics.service.js", () => ({
  bump: vi.fn(),
  setGauge: vi.fn(),
}));

const logWarnMock = vi.fn();
vi.mock("../src/utils/logger.js", () => ({
  warn: logWarnMock,
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../src/observability/otel.js", () => ({
  PROOVRA_SPAN_NAMES: {
    REVIEWER_QUEUE_BUILD: "x",
    REVIEWER_CONSOLE_LOAD: "x",
    REVIEWER_ASSIGNMENT_CREATE: "x",
    REVIEWER_ASSIGNMENT_COMPLETE: "x",
    REVIEWER_RECONCILE: "x",
  },
  withProovraSpan: async <T,>(_name: string, _attrs: unknown, fn: () => Promise<T>) => fn(),
}));

vi.mock("@proovra/shared-runtime/ops", () => ({
  wireStringFor: (k: string) => k,
}));

// Minimal prisma stub. The engine calls
// `client.evidenceReviewWorkflow.findFirst` to load the workflow row
// and later updates / projections; we provide a deterministic stub.
const prismaStub: {
  evidenceReviewWorkflow: {
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
} = {
  evidenceReviewWorkflow: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock("../src/db.js", () => ({
  prisma: prismaStub,
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks are bound.
// ---------------------------------------------------------------------------

const { approveReview, rejectReview } = await import(
  "../src/services/reviewer-ops/reviewer-operations-engine.service.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEAM_ID = "00000000-0000-0000-0000-000000000001";
const WORKFLOW_ID = "00000000-0000-0000-0000-000000000002";
const EVIDENCE_ID = "00000000-0000-0000-0000-000000000003";
const ACTOR_ID = "00000000-0000-0000-0000-000000000004";

function makeWorkflowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    evidenceId: EVIDENCE_ID,
    teamId: TEAM_ID,
    status: "IN_REVIEW",
    priority: "NORMAL",
    assignedToUserId: ACTOR_ID,
    assignedAtUtc: new Date(),
    slaPausedAtUtc: null,
    assignmentDueAtUtc: null,
    firstResponseDueAtUtc: null,
    dueAt: null,
    completionDueAtUtc: null,
    completedAtUtc: null,
    escalationDueAtUtc: null,
    lastReviewedAt: null,
    ...overrides,
  };
}

function makeCtx() {
  return {
    teamId: TEAM_ID,
    actorUserId: ACTOR_ID,
    isReviewerCapable: true,
    isServiceAccount: false,
  } as const;
}

beforeEach(() => {
  sampleClosedWorkflowMock.mockReset();
  canonicalRecordReviewDecisionMock.mockReset();
  findOpenEscalationForWorkflowMock.mockReset();
  findOpenEscalationForWorkflowMock.mockResolvedValue(null);
  safeEmitSecurityEventMock.mockReset();
  logWarnMock.mockReset();
  prismaStub.evidenceReviewWorkflow.findFirst.mockReset();
  prismaStub.evidenceReviewWorkflow.update.mockReset();
});

// ---------------------------------------------------------------------------
// 1 — Approve triggers QC sampling at close
// ---------------------------------------------------------------------------

describe("Phase 3 — approveReview wires sampleClosedWorkflow", () => {
  it("calls sampleClosedWorkflow with the workflow id + team id on a successful approve", async () => {
    prismaStub.evidenceReviewWorkflow.findFirst.mockResolvedValueOnce(
      makeWorkflowRow(),
    );
    canonicalRecordReviewDecisionMock.mockResolvedValueOnce(
      authorityResult(makeWorkflowRow({ status: "APPROVED_INTERNAL" })),
    );
    sampleClosedWorkflowMock.mockResolvedValueOnce({ sampleId: "qc-1" });

    await approveReview(makeCtx(), { workflowId: WORKFLOW_ID, note: null });

    expect(sampleClosedWorkflowMock).toHaveBeenCalledTimes(1);
    const args = sampleClosedWorkflowMock.mock.calls[0][0] as {
      teamId: string;
      workflowId: string;
      decision?: string;
    };
    expect(args.teamId).toBe(TEAM_ID);
    expect(args.workflowId).toBe(WORKFLOW_ID);
    expect(args.decision).toBe("APPROVE_INTERNAL");
  });

  it("returns the workflow projection even when sampleClosedWorkflow throws", async () => {
    prismaStub.evidenceReviewWorkflow.findFirst.mockResolvedValueOnce(
      makeWorkflowRow(),
    );
    canonicalRecordReviewDecisionMock.mockResolvedValueOnce(
      authorityResult(makeWorkflowRow({ status: "APPROVED_INTERNAL" })),
    );
    sampleClosedWorkflowMock.mockRejectedValueOnce(new Error("qc service down"));

    const result = await approveReview(makeCtx(), {
      workflowId: WORKFLOW_ID,
      note: null,
    });

    // Approve still succeeded — the close transaction is NOT rolled back.
    expect(result).toBeDefined();
    expect(canonicalRecordReviewDecisionMock).toHaveBeenCalledTimes(1);
    // And the engine logged a structured warn so operators see the
    // sampling failure surface rather than silently swallowing.
    expect(logWarnMock).toHaveBeenCalled();
    const warnTags = logWarnMock.mock.calls.map((c) => c[0]);
    expect(warnTags).toContain("qc.sample_on_close.failed");
  });

  it("returns null sample without throwing when the workflow was not selected", async () => {
    prismaStub.evidenceReviewWorkflow.findFirst.mockResolvedValueOnce(
      makeWorkflowRow(),
    );
    canonicalRecordReviewDecisionMock.mockResolvedValueOnce(
      authorityResult(makeWorkflowRow({ status: "APPROVED_INTERNAL" })),
    );
    sampleClosedWorkflowMock.mockResolvedValueOnce(null);

    await approveReview(makeCtx(), { workflowId: WORKFLOW_ID, note: null });

    // The engine MUST NOT panic on a null return — that's the
    // normal "not sampled this time" path.
    expect(sampleClosedWorkflowMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock).not.toHaveBeenCalledWith(
      "qc.sample_on_close.failed",
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2 — Reject triggers QC sampling at close
// ---------------------------------------------------------------------------

describe("Phase 3 — rejectReview wires sampleClosedWorkflow", () => {
  it("calls sampleClosedWorkflow with the workflow id + team id on a successful reject", async () => {
    prismaStub.evidenceReviewWorkflow.findFirst.mockResolvedValueOnce(
      makeWorkflowRow(),
    );
    canonicalRecordReviewDecisionMock.mockResolvedValueOnce(
      authorityResult(makeWorkflowRow({ status: "REJECTED_INSUFFICIENT" })),
    );
    sampleClosedWorkflowMock.mockResolvedValueOnce({ sampleId: "qc-2" });

    await rejectReview(makeCtx(), {
      workflowId: WORKFLOW_ID,
      note: "Insufficient evidence",
    });

    expect(sampleClosedWorkflowMock).toHaveBeenCalledTimes(1);
    const args = sampleClosedWorkflowMock.mock.calls[0][0] as {
      teamId: string;
      workflowId: string;
      decision?: string;
    };
    expect(args.teamId).toBe(TEAM_ID);
    expect(args.workflowId).toBe(WORKFLOW_ID);
    expect(args.decision).toBe("REJECT_INSUFFICIENT");
  });

  it("returns the workflow projection even when sampleClosedWorkflow throws", async () => {
    prismaStub.evidenceReviewWorkflow.findFirst.mockResolvedValueOnce(
      makeWorkflowRow(),
    );
    canonicalRecordReviewDecisionMock.mockResolvedValueOnce(
      authorityResult(makeWorkflowRow({ status: "REJECTED_INSUFFICIENT" })),
    );
    sampleClosedWorkflowMock.mockRejectedValueOnce(
      new Error("qc service down"),
    );

    const result = await rejectReview(makeCtx(), {
      workflowId: WORKFLOW_ID,
      note: "Insufficient evidence",
    });

    expect(result).toBeDefined();
    expect(canonicalRecordReviewDecisionMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock).toHaveBeenCalled();
    const warnTags = logWarnMock.mock.calls.map((c) => c[0]);
    expect(warnTags).toContain("qc.sample_on_close.failed");
  });
});

// ---------------------------------------------------------------------------
// 3 — Idempotency contract on the qc-sample service.
// ---------------------------------------------------------------------------

describe("Phase 3 — sampleClosedWorkflow idempotency", () => {
  // Exercise the real qc-sample service against a stub prisma supplied
  // through the `input.prisma` arg. This bypasses the engine mock above
  // and directly proves the service short-circuits when an existing
  // QcSample row is on file for (workflowId, teamId).
  it("returns the existing sample id on a duplicate close (no second insert)", async () => {
    vi.resetModules();
    // The top-level vi.mock for qc-sample is sticky across the whole
    // file. Restore the real module so this test exercises the actual
    // service logic, not the spy.
    vi.doUnmock("../src/services/reviewer-workspace/qc-sample.service.js");
    const innerPrismaStub: {
      qcSample: {
        findFirst: ReturnType<typeof vi.fn>;
        create: ReturnType<typeof vi.fn>;
      };
    } = {
      qcSample: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    // Existing sample on file — second close must return it without creating.
    innerPrismaStub.qcSample.findFirst.mockResolvedValueOnce({ id: "qc-existing" });

    const mod = await import(
      "../src/services/reviewer-workspace/qc-sample.service.js"
    );
    const sampleClosedWorkflow = mod.sampleClosedWorkflow as (input: {
      prisma?: unknown;
      teamId: string;
      workflowId: string;
    }) => Promise<{ sampleId: string } | null>;

    const result = await sampleClosedWorkflow({
      prisma: innerPrismaStub,
      teamId: TEAM_ID,
      workflowId: WORKFLOW_ID,
    });

    expect(result).toEqual({ sampleId: "qc-existing" });
    expect(innerPrismaStub.qcSample.create).not.toHaveBeenCalled();
  });

  it("performs the existence check BEFORE the RNG roll (idempotency at the top)", async () => {
    // Source contract — Phase 3 hardening pinned the order so a second
    // close attempt always returns the existing sample id rather than
    // re-rolling and potentially missing the sample.
    const src = readFileSync(
      fileURLToPath(
        new URL(
          "../src/services/reviewer-workspace/qc-sample.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // Locate the function declaration, then bound the body by the
    // next exported declaration. Lazy-match-to-\n} is unreliable
    // because the signature itself contains "}\n)" and nested
    // object closes.
    const declIdx = src.indexOf("export async function sampleClosedWorkflow");
    expect(declIdx).toBeGreaterThan(-1);
    const nextExportIdx = src.indexOf("export async function ", declIdx + 1);
    const body = src.slice(declIdx, nextExportIdx === -1 ? undefined : nextExportIdx);
    const findFirstIdx = body.indexOf("findFirst");
    const rollIdx = body.indexOf("Math.random");
    expect(findFirstIdx).toBeGreaterThan(-1);
    expect(rollIdx).toBeGreaterThan(-1);
    expect(findFirstIdx).toBeLessThan(rollIdx);
  });
});

// ---------------------------------------------------------------------------
// 4 — Source-text wiring contract — locks placement choice (engine layer).
// ---------------------------------------------------------------------------

describe("Phase 3 — engine layer wiring contract", () => {
  const engineSrc = readFileSync(
    fileURLToPath(
      new URL(
        "../src/services/reviewer-ops/reviewer-operations-engine.service.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("engine imports sampleClosedWorkflow from the canonical qc-sample service", () => {
    expect(engineSrc).toMatch(
      /from\s+"\.\.\/reviewer-workspace\/qc-sample\.service\.js"/,
    );
    expect(engineSrc).toMatch(/sampleClosedWorkflow/);
  });

  it("approveReviewInner calls sampleClosedWorkflow inside a try/catch", () => {
    const declIdx = engineSrc.indexOf("async function approveReviewInner");
    expect(declIdx).toBeGreaterThan(-1);
    const nextFn = engineSrc.indexOf("\n// -", declIdx + 1);
    const body = engineSrc.slice(declIdx, nextFn === -1 ? undefined : nextFn);
    expect(body).toMatch(/sampleClosedWorkflow\(/);
    expect(body).toMatch(/try \{[\s\S]*?sampleClosedWorkflow[\s\S]*?\} catch/);
  });

  it("rejectReview / rejectReviewInner calls sampleClosedWorkflow inside a try/catch", () => {
    // rejectReview is implemented inline (no Inner) — locate the
    // exported function body.
    const declIdx = engineSrc.indexOf("export async function rejectReview");
    expect(declIdx).toBeGreaterThan(-1);
    const nextFn = engineSrc.indexOf("\n// -", declIdx + 1);
    const body = engineSrc.slice(declIdx, nextFn === -1 ? undefined : nextFn);
    expect(body).toMatch(/sampleClosedWorkflow\(/);
    expect(body).toMatch(/try \{[\s\S]*?sampleClosedWorkflow[\s\S]*?\} catch/);
  });

  it("both branches log qc.sample_on_close.failed on failure (structured tag)", () => {
    const occurrences = engineSrc.match(/qc\.sample_on_close\.failed/g) ?? [];
    // One log call per branch (approve + reject).
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("propagates the decision context to the QC service for traceability", () => {
    expect(engineSrc).toMatch(/decision:\s*"APPROVE_INTERNAL"/);
    expect(engineSrc).toMatch(/decision:\s*"REJECT_INSUFFICIENT"/);
  });
});
