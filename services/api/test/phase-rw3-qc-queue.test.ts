/**
 * Phase RW3-3 — QC discovery card on /review/queues.
 *
 * Phase 0 decision: Option B (link only, count card). The queue Prisma
 * query is workflow-centric (`evidenceReviewWorkflow.findMany` keyed on
 * priority/dueAt/slaStatus/status/assignedToUserId), so QC rows cannot
 * be cleanly absorbed without breaking the bulk-assign / bulk-decide
 * semantics. Instead we surface a TOP-OF-PAGE count card linking to
 * /review/qc.
 *
 *   Route (services/api/src/routes/reviewer-ops.routes.ts):
 *     - New GET /v1/reviewer-ops/qc/pending-count.
 *     - Resolves teamId from query, falling back to currentWorkspaceId
 *       (mirrors the queue + assignable-reviewers pattern).
 *     - Gates on requireReviewerActor (team membership) AND
 *       requireReviewerCapable (`evidence_request.review`) — the same
 *       gate the canonical QC list route (/v1/reviewer/qc/samples) uses.
 *
 *   Service (services/api/src/services/reviewer-workspace/qc-sample.service.ts):
 *     - New countPendingQcSamples reads QcSample.count keyed on teamId
 *       and state ∈ {SAMPLED, ASSIGNED}. VERDICT_RENDERED is terminal
 *       and excluded.
 *     - Bounded projection { pendingCount }. No row ids, no PII.
 *
 *   Frontend (apps/web/app/(app)/review/queues/page.tsx):
 *     - Renders a tagged QcDiscoveryState card (LOADING / FORBIDDEN /
 *       ERROR / READY) keyed on the new endpoint. The card links to
 *       /review/qc but the QC samples table itself is NOT duplicated.
 *
 * This file is source-contract + behavioural. The behavioural half mocks
 * Prisma's `qcSample.count` so we can prove:
 *
 *   1. Empty workspace → pendingCount === 0 (honest zero, not faked).
 *   2. Mixed states → only SAMPLED and ASSIGNED contribute to the count.
 *      VERDICT_RENDERED rows are excluded.
 *   3. Cross-team isolation → Prisma count is always scoped to teamId.
 *      No cross-workspace leakage.
 *   4. (Source contract) Route gates on requireReviewerCapable so
 *      non-reviewer callers see REVIEW_PERMISSION_DENIED 403.
 *   5. (Source contract) REVIEWER_OPS_QUEUE_TYPES still has no QC
 *      branch. The discovery card is the canonical surface; the
 *      queues filter must NOT grow a fake QC option.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";


// ---------------------------------------------------------------------------
// Source-contract helpers
// ---------------------------------------------------------------------------

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const ROUTE_SRC = readSource("../src/routes/reviewer-ops.routes.ts");
const SERVICE_SRC = readSource(
  "../src/services/reviewer-workspace/qc-sample.service.ts",
);
const PAGE_SRC = readSource(
  "../../../apps/web/components/reviewer-experience/ReviewInbox.tsx",
);

// ---------------------------------------------------------------------------
// Mocks — bound BEFORE the SUT import.
// ---------------------------------------------------------------------------

const qcSampleCountMock = vi.fn();

vi.mock("../src/db.js", () => ({
  prisma: {
    qcSample: { count: qcSampleCountMock },
  },
}));

vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_TEAM_ID = "22222222-2222-2222-2222-222222222222";

// ---------------------------------------------------------------------------
// SUT import — after mocks are bound.
// ---------------------------------------------------------------------------

const qcMod = await import(
  "../src/services/reviewer-workspace/qc-sample.service.js"
);

beforeEach(() => {
  qcSampleCountMock.mockReset();
});

// ===========================================================================
// PART 1 — Source contract: route wiring
// ===========================================================================

describe("Phase RW3-3 — route source contract", () => {
  it("declares GET /v1/reviewer-ops/qc/pending-count", () => {
    expect(ROUTE_SRC).toMatch(
      /app\.get\(\s*"\/v1\/reviewer-ops\/qc\/pending-count"/,
    );
  });

  it("uses requireReviewerActor (team membership gate)", () => {
    expect(ROUTE_SRC).toMatch(
      // 2026-10-24 — the gate also names the commercial capability.
      /\/v1\/reviewer-ops\/qc\/pending-count[\s\S]{0,2000}?requireReviewerActor\(req,\s*reply,\s*q\.teamId,\s*"REVIEW_TASKS_AND_QUEUES"\)/,
    );
  });

  it("gates on requireReviewerCapable (evidence_request.review)", () => {
    // The shared helper resolves the cap via evaluateMemberAccess
    // with `evidence_request.review`. The QC list endpoint uses the
    // same gate; the count card must not be more permissive than the
    // surface it points to.
    expect(ROUTE_SRC).toMatch(
      /\/v1\/reviewer-ops\/qc\/pending-count[\s\S]{0,2000}?requireReviewerCapable\(ctx,\s*reply\)/,
    );
  });

  it("Zod query bounds teamId to a uuid", () => {
    expect(ROUTE_SRC).toMatch(
      /\/v1\/reviewer-ops\/qc\/pending-count[\s\S]{0,2000}?teamId:\s*z\.string\(\)\.uuid\(\)/,
    );
  });

  it("resolves teamId from the request's workspace when query omits it", () => {
    expect(ROUTE_SRC).toMatch(
      /\/v1\/reviewer-ops\/qc\/pending-count[\s\S]{0,2000}?requestWorkspaceCandidate/,
    );
  });

  it("forwards teamId and the reader into countPendingQcSamples", () => {
    expect(ROUTE_SRC).toMatch(
      /countPendingQcSamples\(\s*\{\s*teamId:\s*q\.teamId,\s*viewerUserId:\s*ctx\.actorUserId\s*\}\s*\)/,
    );
  });

  it("imports countPendingQcSamples from the qc-sample service", () => {
    expect(ROUTE_SRC).toMatch(
      /import\s*\{\s*countPendingQcSamples\s*\}\s*from\s*"\.\.\/services\/reviewer-workspace\/qc-sample\.service\.js"/,
    );
  });

  it("wraps the count() call in try/catch with sendEngineError fallback", () => {
    expect(ROUTE_SRC).toMatch(
      /\/v1\/reviewer-ops\/qc\/pending-count[\s\S]{0,2000}?try\s*\{[\s\S]{0,400}?countPendingQcSamples[\s\S]{0,200}?catch\s*\(err\)\s*\{[\s\S]{0,200}?sendEngineError\(reply,\s*err\)/,
    );
  });
});

describe("Phase RW3-3 — service source contract", () => {
  it("exports countPendingQcSamples", () => {
    expect(SERVICE_SRC).toMatch(
      /export\s+async\s+function\s+countPendingQcSamples/,
    );
  });

  it("excludes VERDICT_RENDERED from the count", () => {
    // The pending count is keyed on the pending state set only.
    // VERDICT_RENDERED is terminal and must NOT be included; otherwise
    // the card would inflate over time as samples complete. We slice
    // the count fn body up to the next top-level `export` (so the
    // assertion does NOT trip on the sibling getQcAccuracy7d service
    // that legitimately reads VERDICT_RENDERED rows) AND strip `//`
    // line comments so an explanatory comment mentioning the terminal
    // state does not collide with the rule.
    const fnIdx = SERVICE_SRC.indexOf("async function countPendingQcSamples");
    expect(fnIdx).toBeGreaterThan(-1);
    const tail = SERVICE_SRC.slice(fnIdx);
    const nextExportIdx = tail.indexOf("\nexport ");
    const fnBody = nextExportIdx > 0 ? tail.slice(0, nextExportIdx) : tail;
    // Strip single-line `//` comments before searching for the literal.
    const codeOnly = fnBody.replace(/\/\/[^\n]*/g, "");
    // Stage C (T-054) — the ONE "awaiting verdict" count, shared with the rail.
    expect(codeOnly).toMatch(/countQcSamplesAwaitingVerdict\(/);
    expect(codeOnly).not.toMatch(/VERDICT_RENDERED/);
  });

  it("scopes the count to teamId (no cross-team leakage)", () => {
    const fnIdx = SERVICE_SRC.indexOf("async function countPendingQcSamples");
    const tail = SERVICE_SRC.slice(fnIdx);
    const nextExportIdx = tail.indexOf("\nexport ");
    const fnBody = nextExportIdx > 0 ? tail.slice(0, nextExportIdx) : tail;
    expect(fnBody).toMatch(/teamId:\s*input\.teamId/);
  });

  it("returns the bounded { pendingCount } projection only", () => {
    // The fn signature must surface { pendingCount } and nothing else
    // — no row ids, no PII spilling through the response.
    expect(SERVICE_SRC).toMatch(
      /countPendingQcSamples[\s\S]{0,400}?Promise<\{\s*pendingCount:\s*number\s*\}>/,
    );
  });
});

// Stage D (T-068) — the Queues page and its QC card are retired. The Inbox
// shows ONE line only while samples are pending, and no link into a refusal;
// proven behaviourally in apps/web/__tests__/render/review-inbox-views.render.test.tsx.
describe("Stage D — the Inbox QC line (source contract)", () => {
  it("reads /v1/reviewer-ops/qc/pending-count and shows nothing at zero", () => {
    expect(PAGE_SRC).toContain("/v1/reviewer-ops/qc/pending-count");
    expect(PAGE_SRC).toContain("n > 0 ? { kind: \"pending\", count: n } : { kind: \"none\" }");
  });
});

describe("Phase RW3-3 — count returns zero when no samples", () => {
  it("empty workspace → pendingCount === 0 (honest zero)", async () => {
    qcSampleCountMock.mockResolvedValueOnce(0);

    const result = await qcMod.countPendingQcSamples({ teamId: TEAM_ID, viewerUserId: null });

    expect(result).toEqual({ pendingCount: 0 });
    expect(qcSampleCountMock).toHaveBeenCalledTimes(1);
  });
});

describe("Phase RW3-3 — count returns correct N when pending", () => {
  it("non-zero pending samples → pendingCount reflects the count", async () => {
    qcSampleCountMock.mockResolvedValueOnce(7);

    const result = await qcMod.countPendingQcSamples({ teamId: TEAM_ID, viewerUserId: null });

    expect(result).toEqual({ pendingCount: 7 });
  });

  it("only the awaiting-verdict states are counted (VERDICT_RENDERED excluded; stage C T-054 adds IN_PROGRESS)", async () => {
    qcSampleCountMock.mockResolvedValueOnce(0);

    await qcMod.countPendingQcSamples({ teamId: TEAM_ID, viewerUserId: null });

    const call = qcSampleCountMock.mock.calls[0]![0] as {
      where: { teamId: string; state: { in: string[] } };
    };
    expect(call.where.state.in.sort()).toEqual(["ASSIGNED", "IN_PROGRESS", "SAMPLED"]);
    expect(call.where.state.in).not.toContain("VERDICT_RENDERED");
  });
});

describe("Phase RW3-3 — team scoping (no cross-team leakage)", () => {
  it("Prisma count is always scoped to the requested teamId", async () => {
    qcSampleCountMock.mockResolvedValueOnce(3);

    await qcMod.countPendingQcSamples({ teamId: TEAM_ID, viewerUserId: null });

    const call = qcSampleCountMock.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(call.where.teamId).toBe(TEAM_ID);
    // No way for the where clause to spill into another team.
    expect(JSON.stringify(call.where)).not.toContain(OTHER_TEAM_ID);
  });

  it("two callers with different teamIds query independent counts", async () => {
    qcSampleCountMock
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(5);

    const a = await qcMod.countPendingQcSamples({ teamId: TEAM_ID, viewerUserId: null });
    const b = await qcMod.countPendingQcSamples({ teamId: OTHER_TEAM_ID, viewerUserId: null });

    expect(a).toEqual({ pendingCount: 2 });
    expect(b).toEqual({ pendingCount: 5 });
    expect(qcSampleCountMock.mock.calls[0]![0].where.teamId).toBe(TEAM_ID);
    expect(qcSampleCountMock.mock.calls[1]![0].where.teamId).toBe(OTHER_TEAM_ID);
  });
});

describe("Phase RW3-3 — bounded projection (no PII)", () => {
  it("returns ONLY { pendingCount } (no row ids, no extra fields)", async () => {
    qcSampleCountMock.mockResolvedValueOnce(4);

    const result = await qcMod.countPendingQcSamples({ teamId: TEAM_ID, viewerUserId: null });

    expect(Object.keys(result).sort()).toEqual(["pendingCount"]);
    expect(typeof result.pendingCount).toBe("number");
  });
});
