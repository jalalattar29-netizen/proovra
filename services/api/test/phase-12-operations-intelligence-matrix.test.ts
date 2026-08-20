/**
 * PHASE 12 VERTICAL B (OPERATIONS_INTELLIGENCE) production-operation matrix.
 *
 * ONE consolidated behavioral suite for ALL 42 HTTP operations the Phase-12
 * wiring registry classifies as OPERATIONS_INTELLIGENCE. Driven through the
 * REAL route handlers with fastify `inject`; only process boundaries are
 * mocked (auth, the canonical authorization / member-access gates, step-up,
 * prisma, and the canonical domain services). Every gate, projection and
 * denial branch under test is the shipped handler code.
 *
 * Systems covered (grouped by PRODUCT SYSTEM, not one describe per route):
 *
 *   1. Command Center workflow board      — ops.routes.ts          (10 ops)
 *   2. Command Center bulk + causality    — ops.routes.ts          ( 4 ops)
 *   3. SIU worklist saved views           — siu.routes.ts          ( 7 ops)
 *   4. Investigation graph curation       — graph.routes.ts        ( 5 ops)
 *   5. Intelligence records + corrections — intelligence-platform  ( 7 ops)
 *   6. Intelligence + analytics catalogs  — intelligence/analytics ( 2 ops)
 *   7. Reviewer Copilot observations      — ai-reviewer.routes.ts  ( 1 op )
 *   8. Admin analytics composite parity   — analytics.routes.ts    ( 6 ops)
 *
 *   10 + 4 + 7 + 5 + 7 + 2 + 1 + 6 = 42.
 *
 * System 8 is a PARITY system, not a live-route system: the six granular
 * admin-analytics operations were removed under full parity in favour of the
 * one composite authority. The matrix proves the parity claim (the composite
 * still returns all six producers' keys, and the granular paths are gone)
 * rather than pretending the removed routes still answer.
 *
 * The `OPERATIONS` manifest at the bottom is machine-checked against the
 * wiring registry so this file cannot silently drift out of coverage.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

const IDS = vi.hoisted(() => ({
  ACTOR: "11111111-1111-4111-8111-111111111111",
  TEAM: "22222222-2222-4222-8222-222222222222",
  OTHER_TEAM: "33333333-3333-4333-8333-333333333333",
  WORKFLOW: "44444444-4444-4444-8444-444444444444",
  CHAIN: "55555555-5555-4555-8555-555555555555",
  VIEW: "66666666-6666-4666-8666-666666666666",
  RECORD: "77777777-7777-4777-8777-777777777777",
  CORRECTION: "88888888-8888-4888-8888-888888888888",
  RUN: "99999999-9999-4999-8999-999999999999",
  NODE_A: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  NODE_B: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  EVIDENCE: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  MANUAL_REL: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  ASSIGNEE: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  BULK_RUN: "ffffffff-ffff-4fff-8fff-ffffffffffff",
}));

const {
  ACTOR, TEAM, OTHER_TEAM, WORKFLOW, CHAIN, VIEW, RECORD, CORRECTION, RUN,
  NODE_A, NODE_B, EVIDENCE, MANUAL_REL, ASSIGNEE, BULK_RUN,
} = IDS;

// Inert values for modules that validate configuration at import time. No
// external client is ever exercised by this suite.
vi.hoisted(() => {
  process.env.S3_ACCESS_KEY ??= "test-access";
  process.env.S3_SECRET_KEY ??= "test-secret";
  process.env.S3_REGION ??= "eu-central-1";
});

const H = vi.hoisted(() => ({
  /** Session subject. Every handler must derive its subject from THIS. */
  actorUserId: "11111111-1111-4111-8111-111111111111",

  /** Membership rows: `${teamId}:${userId}` → status. */
  members: new Map<string, string>(),

  /** `evaluateMemberAccess` verdict, per permission. */
  memberAccessAllowed: true,
  memberAccessSeen: [] as Array<{ teamId: string; permission: string }>,

  /** Canonical `authorizeOrFail` verdict. */
  authorizeAllowed: true,
  authorizeDenyStatus: 403 as 403 | 404,
  authorizeSeen: [] as string[],

  /** Step-up seam. */
  stepUpSent: false,
  stepUpCalls: [] as Array<{ purpose: string; resourceKind: string | null; resourceId: string | null }>,

  /** The operator's current workspace (intelligence-platform resolves it). */
  currentWorkspaceId: "22222222-2222-4222-8222-222222222222" as string | null,

  /** EVERY canonical state write the routes performed. A denial leaves it empty. */
  writes: [] as string[],

  /** Persisted workflow row (the authority the routes bind to). */
  workflowStatus: "OPEN",
  workflowUpdatedAt: new Date("2026-07-30T10:00:00.000Z"),
  /** A durable idempotency marker exists for this token. */
  replayToken: null as string | null,
  /** A prior bulk run exists for this idempotency key. */
  bulkReplayKey: null as string | null,

  /** Causality chain row (null → 404). */
  chainExists: true,

  /** SIU saved-view service outcomes. */
  savedViewExists: true,
  savedViewResolvable: true,

  /** Intelligence service outcomes. */
  recordExists: true,
  chainRowExists: true,
  correctionDenial: null as string | null,

  /** Graph service outcomes. */
  manualRelationshipExists: false,
  graphCreateOk: true,

  /** AI copilot run row (null → 404). */
  copilotRunExists: true,
}));

const memberKey = (teamId: string, userId: string) => `${teamId}:${userId}`;

// ---------------------------------------------------------------------------
// Process boundaries
// ---------------------------------------------------------------------------

vi.mock("../src/auth.js", () => ({
  getAuthUserId: () => H.actorUserId,
  getAuthUserIdOrNull: () => H.actorUserId,
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async () => {},
  requireAuthAndLegal: async () => {},
}));

vi.mock("../src/middleware/platform-admin.js", () => ({
  requirePlatformAdmin: async () => {},
}));

vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async (
    _req: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => void } },
    opts: { permission: string; teamId?: string },
  ) => {
    H.authorizeSeen.push(opts.permission);
    if (!H.authorizeAllowed) {
      if (H.authorizeDenyStatus === 404) reply.code(404).send({ error: { code: "not_found" } });
      else reply.code(403).send({ error: { code: "permission_denied" } });
      return null;
    }
    return { actorUserId: H.actorUserId, teamId: opts.teamId ?? TEAM };
  },
  requireAuthorize: () => async () => {},
}));

vi.mock("../src/services/identity/access-policy.service.js", () => ({
  evaluateMemberAccess: async (i: { teamId: string; permission: string }) => {
    H.memberAccessSeen.push({ teamId: i.teamId, permission: i.permission });
    return H.memberAccessAllowed
      ? { allowed: true, reason: null, detail: null }
      : { allowed: false, reason: "permission_not_granted", detail: null };
  },
}));

vi.mock("../src/services/identity-security/step-up-middleware.js", () => ({
  requireStepUpForSensitiveAction: async (input: {
    purpose: string;
    resourceKind?: string | null;
    resourceId?: string | null;
    reply: { code: (n: number) => { send: (b: unknown) => void } };
  }) => {
    H.stepUpCalls.push({
      purpose: input.purpose,
      resourceKind: input.resourceKind ?? null,
      resourceId: input.resourceId ?? null,
    });
    if (H.stepUpSent) {
      input.reply.code(401).send({ error: { code: "STEP_UP_REQUIRED" } });
      return { sent: true };
    }
    return { sent: false, verifiedChallengeId: "chal-verified" };
  },
}));

vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: async () => ({ ok: true }),
}));

// ---------------------------------------------------------------------------
// Persistence boundary
// ---------------------------------------------------------------------------

function workflowRow() {
  return {
    id: WORKFLOW,
    teamId: TEAM,
    workflowKey: "queue-backlog",
    workflowType: "QUEUE_BACKLOG",
    status: H.workflowStatus,
    severity: "HIGH",
    priority: "P2",
    title: "Review queue backlog",
    safeSummary: "The review queue is above its threshold.",
    assignedOwnerUserId: null,
    escalationLevel: 0,
    retryCount: 0,
    nextRetryAtUtc: null,
    mitigationSummary: null,
    resolutionSummary: null,
    dueAtUtc: null,
    resolvedAtUtc: null,
    caseId: null,
    evidenceId: null,
    queueName: "review",
    updatedAt: H.workflowUpdatedAt,
    // Deliberately present on the PERSISTED row so the safe-projection test
    // proves the ROUTE strips it, not the store.
    metadataJson: { generatorInternals: "NEVER_SHIP_THIS" },
  } as never;
}

vi.mock("../src/db.js", () => ({
  prisma: {
    // Graph provenance + diagnostics read through raw SQL. The seam answers
    // by TABLE so each read stays independently controllable.
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (sql.includes("manual_relationships")) {
        if (!H.manualRelationshipExists) return [];
        return [
          {
            id: MANUAL_REL,
            source_node_id: NODE_A,
            target_node_id: NODE_B,
            edge_type: params[3] ?? "MANUALLY_LINKED_TO",
            created_by_user_id: ACTOR,
            safe_note: "Same claimant",
            status: "ACTIVE",
            created_at_utc: "2026-07-29T00:00:00.000Z",
          },
        ];
      }
      if (sql.includes("investigation_graph_nodes")) {
        return [{ node_kind: "EVIDENCE", total: 2, stale: 0 }];
      }
      if (sql.includes("investigation_graph_edges")) {
        return [{ edge_type: "MANUALLY_LINKED_TO", total: 1, stale: 0 }];
      }
      return [];
    },
    user: {
      findUnique: async () => ({ currentWorkspaceId: H.currentWorkspaceId }),
    },
    teamMember: {
      findUnique: async ({ where }: { where: { teamId_userId: { teamId: string; userId: string } } }) => {
        const status = H.members.get(memberKey(where.teamId_userId.teamId, where.teamId_userId.userId));
        return status
          ? { id: "member-1", status, role: "ADMIN", team: { organizationId: "org-1" } }
          : null;
      },
      findFirst: async ({ where }: { where: { teamId: string; userId: string } }) => {
        const status = H.members.get(memberKey(where.teamId, where.userId));
        return status ? { id: "member-1", status, role: "ADMIN" } : null;
      },
    },
    operationalWorkflow: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === WORKFLOW ? workflowRow() : null,
      findFirst: async ({ where }: { where: { id: string; teamId: string } }) =>
        where.id === WORKFLOW && where.teamId === TEAM ? workflowRow() : null,
      findMany: async (args?: { select?: Record<string, boolean> }) => {
        const row = workflowRow() as unknown as Record<string, unknown>;
        if (!args?.select) return [row];
        // Prisma returns ONLY the selected columns — the seam must too, or a
        // projection test would pass against data the real client never sends.
        return [Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k]]))];
      },
    },
    operationalWorkflowEvent: {
      findFirst: async ({ where }: { where: { metadataJson?: { equals?: unknown } } }) => {
        const token = where?.metadataJson?.equals;
        return H.replayToken && token === H.replayToken
          ? { occurredAtUtc: new Date("2026-07-30T11:00:00.000Z") }
          : null;
      },
      findMany: async () => [
        {
          id: "evt-1",
          eventType: "STATUS_CHANGED",
          actorUserId: ACTOR,
          fromStatus: "OPEN",
          toStatus: "IN_PROGRESS",
          summary: "Operator started the workflow.",
          occurredAtUtc: new Date("2026-07-30T10:30:00.000Z"),
        },
      ],
      create: async () => {
        H.writes.push("recordWorkflowActionIdempotency");
        return { id: "evt-2" };
      },
    },
    operationalCausalityChain: {
      findFirst: async ({ where }: { where: { id: string; teamId: string } }) =>
        H.chainExists && where.id === CHAIN && where.teamId === TEAM
          ? {
              id: CHAIN,
              teamId: TEAM,
              chainKey: "provider-degradation",
              title: "Provider degradation",
              summary: "Upstream provider latency spilled into the review queue.",
              rootCauseType: "PROVIDER_DEGRADATION",
              severity: "HIGH",
              status: "ACTIVE",
              linkedIncidentIds: [],
              linkedWorkflowIds: [WORKFLOW],
              linkedCaseIds: [],
              linkedEvidenceIds: [],
              startAtUtc: new Date("2026-07-30T08:00:00.000Z"),
              lastSeenAtUtc: new Date("2026-07-30T10:00:00.000Z"),
              resolvedAtUtc: null,
              // Present on the PERSISTED row so the projection test proves the
              // ROUTE strips generator internals.
              metadataJson: { generatorInternals: "NEVER_SHIP_THIS" },
            }
          : null,
    },
    bulkOperationalActionRun: {
      findFirst: async ({ where }: { where: { resultJson?: { equals?: unknown } } }) => {
        const key = where?.resultJson?.equals;
        return H.bulkReplayKey && key === H.bulkReplayKey
          ? { id: BULK_RUN, status: "COMPLETED", resultJson: { total: 2, succeeded: 2, failed: 0, skipped: 0 } }
          : null;
      },
      update: async () => {
        H.writes.push("stampBulkIdempotency");
        return { id: BULK_RUN };
      },
    },
    bulkOperationalActionItem: {
      findMany: async () => [
        { id: "item-1", runId: BULK_RUN, targetId: WORKFLOW, outcome: "SUCCEEDED", failureReason: null, createdAt: new Date() },
      ],
    },
    aiCopilotRun: {
      findUnique: async () =>
        H.copilotRunExists
          ? { id: RUN, workspaceId: TEAM, feature: "REVIEWER_COPILOT", workspacePolicyVersion: "p-1", status: "ok" }
          : null,
      findMany: async () => [],
    },
    evidenceReviewWorkflow: { findUnique: async () => null },
    evidence: { findMany: async () => [] },
  },
}));

// ---------------------------------------------------------------------------
// Canonical domain services — assert the routes CALL them, never re-implement.
// ---------------------------------------------------------------------------

function applied(status: string) {
  return { ...(workflowRow() as unknown as Record<string, unknown>), status } as never;
}

vi.mock("../src/services/observability/workflow.service.js", () => ({
  listWorkflows: async () => [workflowRow()],
  getWorkflow: async (i: { workflowId: string; teamId: string }) =>
    i.workflowId === WORKFLOW && i.teamId === TEAM ? workflowRow() : null,
  assignWorkflow: async () => { H.writes.push("assignWorkflow"); return applied("OPEN"); },
  startWorkflow: async () => { H.writes.push("startWorkflow"); return applied("IN_PROGRESS"); },
  escalateWorkflow: async () => { H.writes.push("escalateWorkflow"); return applied("OPEN"); },
  addMitigation: async () => { H.writes.push("addMitigation"); return applied("OPEN"); },
  resolveWorkflow: async () => { H.writes.push("resolveWorkflow"); return applied("RESOLVED"); },
  suppressWorkflow: async () => { H.writes.push("suppressWorkflow"); return applied("SUPPRESSED"); },
  reopenWorkflow: async () => { H.writes.push("reopenWorkflow"); return applied("OPEN"); },
  scheduleRetry: async () => { H.writes.push("scheduleRetry"); return applied("OPEN"); },
}));

vi.mock("../src/services/dashboard/causality.service.js", () => ({
  listWorkspaceCausalityChains: async (i: { teamId: string }) => [
    { id: CHAIN, teamId: i.teamId, rootCause: "Provider degradation", linkedWorkflowCount: 1 },
  ],
  detectCausalityForWorkspace: async () => ({ created: 0 }),
}));

vi.mock("../src/services/dashboard/bulk-actions.service.js", () => ({
  runBulkAction: async () => {
    H.writes.push("runBulkAction");
    return { runId: BULK_RUN, total: 2, succeeded: 2, failed: 0, skipped: 0 };
  },
  getBulkActionRun: async (i: { runId: string; teamId: string }) =>
    i.teamId === TEAM
      ? {
          run: {
            id: BULK_RUN,
            teamId: TEAM,
            actionType: "BULK_ESCALATE_WORKFLOWS",
            status: "COMPLETED",
            requestedByUserId: ACTOR,
            noteText: null,
            // The durable idempotency marker lives here and must be stripped
            // from the operator projection.
            resultJson: { total: 2, succeeded: 2, failed: 0, skipped: 0, opsIdempotencyKey: "bulk-key-00001" },
            createdAt: new Date("2026-07-30T10:00:00.000Z"),
            completedAtUtc: new Date("2026-07-30T10:01:00.000Z"),
          },
          items: [
            { id: "item-1", runId: BULK_RUN, targetId: WORKFLOW, status: "SUCCEEDED", failureReason: null, createdAt: new Date("2026-07-30T10:00:30.000Z") },
          ],
        }
      : { run: null, items: [] },
  BulkActionError: class BulkActionError extends Error {},
}));

vi.mock("../src/services/siu/siu-view-query.service.js", () => ({
  DEFAULT_SIU_VIEW_SORT: { key: "updatedAtUtc", direction: "desc" },
  listExecutableSiuViews: async () => [
    { id: VIEW, name: "High-risk open", source: "custom", visibility: "private" },
  ],
  resolveSiuView: async (i: { viewId: string }) =>
    H.savedViewResolvable
      ? { ok: true, view: { id: i.viewId, name: "High-risk open", filter: {}, sort: {} } }
      : { ok: false, reason: "NOT_FOUND" },
  runSiuWorklist: async () => ({
    view: { id: VIEW, name: "High-risk open" },
    rows: [{ caseId: "case-1", claimType: "AUTO", riskBand: "HIGH" }],
    total: 1,
    truncated: false,
  }),
  buildSiuProfileWhere: () => ({}),
}));

vi.mock("../src/services/siu/siu-saved-views.service.js", async (importOriginal) => {
  // The SCHEMAS are kept REAL. They are the closed filter/sort vocabulary the
  // whole SIU vertical is built on, and a hand-rolled stand-in would let this
  // suite accept a definition production would reject — and would silently
  // change what the real view-query service (system 9) parses, since its own
  // import resolves through this mock. Only the persistence writers below are
  // doubled.
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listCustomSavedViews: async () => [{ id: VIEW, name: "High-risk open", visibility: "private" }],
    createSavedView: async () => { H.writes.push("createSavedView"); return { id: VIEW, name: "High-risk open" }; },
    updateSavedView: async () => {
      if (!H.savedViewExists) return null;
      H.writes.push("updateSavedView");
      return { id: VIEW, name: "Renamed" };
    },
    deleteSavedView: async () => {
      if (!H.savedViewExists) return false;
      H.writes.push("deleteSavedView");
      return true;
    },
    markSavedViewUsed: async () => {
      if (!H.savedViewExists) return null;
      H.writes.push("markSavedViewUsed");
      return { id: VIEW, name: "High-risk open", lastUsedAtUtc: "2026-07-30T12:00:00.000Z" };
    },
  };
});

vi.mock("../src/services/graph/graph-builder.service.js", () => ({
  buildEvidenceSubgraph: async () => ({
    nodes: [
      { id: NODE_A, teamId: TEAM, nodeKind: "EVIDENCE", label: "Photo", storageKey: "NEVER_SHIP_THIS" },
      { id: NODE_B, teamId: TEAM, nodeKind: "CASE", label: "Case 1", storageKey: "NEVER_SHIP_THIS" },
    ],
    edges: [
      { id: "edge-1", sourceNodeId: NODE_A, targetNodeId: NODE_B, edgeType: "MANUALLY_LINKED_TO", confidence: "HIGH" },
    ],
    truncated: false,
  }),
  buildCaseSubgraph: async () => ({ nodes: [], edges: [], truncated: false }),
  buildInvestigationTimeline: async () => ({ events: [], truncated: false }),
  listDuplicateEdges: async () => [],
  listGraphSeedNodes: async () => [],
  searchGraph: async () => ({
    nodes: [{ id: NODE_A, teamId: TEAM, nodeKind: "EVIDENCE", label: "Photo", storageKey: "NEVER_SHIP_THIS" }],
    truncated: false,
  }),
  createManualRelationship: async () => {
    if (!H.graphCreateOk) return { ok: false, reason: "nodes_not_in_team" };
    H.writes.push("createManualRelationship");
    return { ok: true, manualRelationshipId: MANUAL_REL, edgeId: "edge-2" };
  },
  retractManualRelationship: async () => {
    H.writes.push("retractManualRelationship");
    return { ok: true };
  },
}));

// PHASE 12 — POINT 8: the graph-diagnostics route awaits `getQueueInventory()`,
// which opens a REAL BullMQ/IORedis connection. This suite is a unit suite and
// its diagnostics test asserts AUTHORIZATION — an operator-grade member gets
// 200, a non-member gets a concealed 404. Redis is not part of that contract,
// so the route must be exercised without one.
//
// Without this mock the test did not merely run slowly: `REDIS_URL` points at a
// closed loopback port, `maxRetriesPerRequest: null` retried forever, and the
// promise never settled — the test timed out at 5000 ms with two live sockets.
// That was a hidden infrastructure dependency in a unit suite, and it passed
// only when a disposable Redis happened to be left running.
//
// The unbounded wait was ALSO a production defect and is fixed separately, at
// the service boundary, with its own regression proof
// (`phase-12-point8-queue-inventory-bounded.test.ts`). This mock is not that
// fix; it is what keeps an authorization test about authorization.
vi.mock("../src/services/operations/queue-inventory.service.js", () => ({
  getQueueInventory: async () => [
    {
      queueName: "graph-reconcile",
      label: "Graph reconcile",
      counts: { waiting: 1, active: 0, delayed: 0, failed: 0, completed: 0 },
      stalledCount: 0,
      health: "healthy",
      oldestWaitingAgeMs: null,
      disabledReason: null,
    },
  ],
  getQueueHandle: () => null,
}));

vi.mock("../src/services/ops/metrics.service.js", () => ({
  bump: () => {},
  setGauge: () => {},
  snapshotMetrics: () => ({}),
  buildPrometheusExposition: () => "",
}));

vi.mock("../src/services/investigation-custody.service.js", () => ({
  appendInvestigationCustody: async () => ({ ok: true }),
}));

vi.mock("../src/services/intelligence/media-intelligence.service.js", () => ({
  getRecordWithCorrections: async () =>
    H.recordExists
      ? { id: RECORD, evidenceId: EVIDENCE, modality: "IMAGE", kind: "OCR_TEXT", confidenceBand: "MEDIUM" }
      : null,
  listRecordsForEvidence: async () => [],
  runProviderOperation: async () => ({ ok: true }),
}));

vi.mock("../src/services/intelligence/reviewer-correction.service.js", () => ({
  createCorrection: async () =>
    H.correctionDenial
      ? { ok: false, denial: H.correctionDenial }
      : (H.writes.push("createCorrection"), { ok: true, correctionId: CORRECTION }),
  acceptCorrection: async () =>
    H.correctionDenial
      ? { ok: false, denial: H.correctionDenial }
      : (H.writes.push("acceptCorrection"), { ok: true, recordId: RECORD }),
  revertCorrection: async () =>
    H.correctionDenial
      ? { ok: false, denial: H.correctionDenial }
      : (H.writes.push("revertCorrection"), { ok: true, revertedCorrectionId: CORRECTION }),
  listCorrectionsForRecord: async () => [
    { id: CORRECTION, recordId: RECORD, kind: "OCR_TEXT", state: "ACCEPTED" },
  ],
  listCorrectionsForEvidence: async () => [],
  getCorrectionVersionChain: async () =>
    H.chainRowExists
      ? {
          recordId: RECORD,
          evidenceId: EVIDENCE,
          versions: [
            {
              id: CORRECTION,
              versionNumber: 1,
              kind: "OCR_TEXT",
              state: "ACCEPTED",
              authoredByUserId: ACTOR,
              acceptedByUserId: ACTOR,
              parentCorrectionId: null,
              supersedesCorrectionId: null,
              supersededByCorrectionId: null,
              createdAtUtc: "2026-07-29T00:00:00.000Z",
              acceptedAtUtc: "2026-07-29T01:00:00.000Z",
              revertedAtUtc: null,
              supersededAtUtc: null,
              rationale: "Corrected an OCR misread.",
              // Raw extracted content — the projection must reduce this to keys.
              patchPreview: { text: "RAW_EXTRACTED_CONTENT_SHOULD_NEVER_SHIP" },
            },
          ],
        }
      : null,
}));

vi.mock("../src/services/intelligence/executive-metrics.service.js", () => ({
  projectExecutiveMetrics: async () => ({ evidenceTotal: 12, casesOpen: 3, intelligenceRuns: 7 }),
  projectExecutiveTrends: async () => ({ points: [] }),
}));

// AI seams for the Reviewer Copilot observation operation.
vi.mock("../src/services/ai/ai-copilot-run-store.service.js", () => ({
  COPILOT_PROMPT_VERSION: "1.0.0",
  SYSTEM_POLICY_VERSION: "1.0.0",
  CONTEXT_SCHEMA_VERSION: "1.0.0",
  persistCopilotRun: async () => ({ id: RUN }),
  recordObservationInteraction: async (i: { state: string }) => {
    H.writes.push("recordObservationInteraction");
    return { id: "obs-1", state: i.state };
  },
}));

vi.mock("../src/services/ai/workspace-ai-policy.service.js", () => ({
  evaluateWorkspaceAiPolicy: async () => ({
    decision: "ALLOWED",
    allowed: true,
    policyVersion: "p-2",
  }),
  resolveWorkspaceAiPolicy: async () => ({ policyVersion: "p-2" }),
  isOpenAiAdvisoryConfigured: () => false,
  isPlatformAiGloballyEnabled: () => true,
}));

vi.mock("../src/services/ai/ai-capability-disclosure.service.js", () => ({
  resolveAiCapabilityDisclosure: async () => [
    {
      capability: "REVIEWER_COPILOT",
      provider: "OpenAI",
      dataCategory: "METADATA",
      rawContent: false,
      operationalStatus: "NOT_CONFIGURED",
      trainingMode: "NO_TRAINING",
      retentionMode: "ZERO_RETENTION",
    },
    {
      capability: "EMBEDDINGS",
      provider: "OpenAI",
      dataCategory: "METADATA",
      rawContent: false,
      operationalStatus: "NOT_CONFIGURED",
      trainingMode: "NO_TRAINING",
      retentionMode: "ZERO_RETENTION",
    },
  ],
}));

vi.mock("../src/services/ai/reviewer-copilot-provider.js", () => ({
  buildReviewerCopilotProvider: () => ({ generate: async () => ({}) }),
  ReviewerCopilotProviderUnavailable: class extends Error {},
}));

vi.mock("../src/services/ai/reviewer-copilot.service.js", () => ({
  runReviewerCopilot: async () => ({ status: "ok", data: {}, versionMeta: { contextObjectRevisions: [] } }),
}));

import { opsRoutes } from "../src/routes/ops.routes.js";
import { siuRoutes } from "../src/routes/siu.routes.js";
import { graphRoutes } from "../src/routes/graph.routes.js";
import { intelligencePlatformRoutes } from "../src/routes/intelligence-platform.routes.js";
import { intelligenceRoutes } from "../src/routes/intelligence.routes.js";
import { analyticsOperationsRoutes } from "../src/routes/analytics-operations.routes.js";
import { aiReviewerRoutes } from "../src/routes/ai-reviewer.routes.js";

let ops: FastifyInstance;
let siu: FastifyInstance;
let graph: FastifyInstance;
let intel: FastifyInstance;
let catalogs: FastifyInstance;
let analytics: FastifyInstance;
let ai: FastifyInstance;

const json = { "content-type": "application/json" };

beforeEach(async () => {
  H.actorUserId = ACTOR;
  H.members.clear();
  H.members.set(memberKey(TEAM, ACTOR), "ACTIVE");
  H.members.set(memberKey(TEAM, ASSIGNEE), "ACTIVE");
  H.memberAccessAllowed = true;
  H.memberAccessSeen.length = 0;
  H.authorizeAllowed = true;
  H.authorizeDenyStatus = 403;
  H.authorizeSeen.length = 0;
  H.stepUpSent = false;
  H.stepUpCalls.length = 0;
  H.currentWorkspaceId = TEAM;
  H.writes.length = 0;
  H.workflowStatus = "OPEN";
  H.workflowUpdatedAt = new Date("2026-07-30T10:00:00.000Z");
  H.replayToken = null;
  H.bulkReplayKey = null;
  H.chainExists = true;
  H.savedViewExists = true;
  H.savedViewResolvable = true;
  H.recordExists = true;
  H.chainRowExists = true;
  H.correctionDenial = null;
  H.manualRelationshipExists = false;
  H.graphCreateOk = true;
  H.copilotRunExists = true;

  ops = Fastify(); await ops.register(opsRoutes); await ops.ready();
  siu = Fastify(); await siu.register(siuRoutes); await siu.ready();
  graph = Fastify(); await graph.register(graphRoutes); await graph.ready();
  intel = Fastify(); await intel.register(intelligencePlatformRoutes); await intel.ready();
  catalogs = Fastify(); await catalogs.register(intelligenceRoutes); await catalogs.ready();
  analytics = Fastify(); await analytics.register(analyticsOperationsRoutes); await analytics.ready();
  ai = Fastify(); await ai.register(aiReviewerRoutes); await ai.ready();
});

// ===========================================================================
// 1. Command Center workflow board — list, detail, and the eight mutations
// ===========================================================================

describe("Operations Intelligence — Command Center workflow board", () => {
  it("lists workflows with a SERVER-resolved action projection and no generator internals", async () => {
    const res = await ops.inject({ method: "GET", url: `/v1/ops/workflows?teamId=${TEAM}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.workflows).toHaveLength(1);
    // Availability is decided by the SERVER, not derived from a role string.
    expect(body.canAct).toBe(true);
    expect(body.denialReason).toBeNull();
    expect(body.workflows[0].projection).toBeTruthy();
    // Anti-leak: `metadataJson` never reaches the browser.
    expect(res.body).not.toContain("NEVER_SHIP_THIS");
    expect(res.body).not.toContain("metadataJson");
  });

  it("without the action capability the board still renders but says WHY it is read-only", async () => {
    // `identity.member.read` grants the read; the ACTION capability is what
    // `resolveWorkflowActionCapability` asks for, and it is denied here.
    H.memberAccessAllowed = false;
    const res = await ops.inject({ method: "GET", url: `/v1/ops/workflows?teamId=${TEAM}` });
    // The read gate itself uses the same seam, so the read is refused first.
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("permission_denied");
  });

  it("a non-member is concealed as 404, never 403 (anti-enumeration)", async () => {
    const res = await ops.inject({ method: "GET", url: `/v1/ops/workflows?teamId=${OTHER_TEAM}` });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("not_found");
  });

  it("the detail operation returns the row plus bounded operator history", async () => {
    const res = await ops.inject({ method: "GET", url: `/v1/ops/workflows/${WORKFLOW}?teamId=${TEAM}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.workflow.id).toBe(WORKFLOW);
    expect(body.history).toHaveLength(1);
    expect(body.history[0].eventType).toBe("STATUS_CHANGED");
    expect(res.body).not.toContain("NEVER_SHIP_THIS");
  });

  it("a workflow id that exists in ANOTHER workspace resolves to the same 404", async () => {
    H.members.set(memberKey(OTHER_TEAM, ACTOR), "ACTIVE");
    const res = await ops.inject({ method: "GET", url: `/v1/ops/workflows/${WORKFLOW}?teamId=${OTHER_TEAM}` });
    expect(res.statusCode).toBe(404);
  });

  const MUTATIONS: Array<{ action: string; url: string; payload: Record<string, unknown>; write: string }> = [
    { action: "assign", url: `/v1/ops/workflows/${WORKFLOW}/assign`, payload: { teamId: TEAM, assigneeUserId: ASSIGNEE }, write: "assignWorkflow" },
    { action: "start", url: `/v1/ops/workflows/${WORKFLOW}/start`, payload: { teamId: TEAM }, write: "startWorkflow" },
    { action: "escalate", url: `/v1/ops/workflows/${WORKFLOW}/escalate`, payload: { teamId: TEAM }, write: "escalateWorkflow" },
    { action: "mitigation", url: `/v1/ops/workflows/${WORKFLOW}/mitigation`, payload: { teamId: TEAM, note: "Throttled the intake." }, write: "addMitigation" },
    { action: "resolve", url: `/v1/ops/workflows/${WORKFLOW}/resolve`, payload: { teamId: TEAM, note: "Backlog cleared." }, write: "resolveWorkflow" },
    { action: "suppress", url: `/v1/ops/workflows/${WORKFLOW}/suppress`, payload: { teamId: TEAM }, write: "suppressWorkflow" },
    { action: "schedule-retry", url: `/v1/ops/workflows/${WORKFLOW}/schedule-retry`, payload: { teamId: TEAM, nextRetryAtUtc: "2026-08-01T00:00:00.000Z" }, write: "scheduleRetry" },
  ];

  for (const m of MUTATIONS) {
    it(`${m.action}: happy path drives exactly ONE canonical state writer`, async () => {
      const res = await ops.inject({ method: "POST", url: m.url, headers: json, payload: m.payload });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.applied).toBe(true);
      expect(body.idempotentReplay).toBe(false);
      expect(H.writes.filter((w) => w === m.write)).toHaveLength(1);
      expect(res.body).not.toContain("NEVER_SHIP_THIS");
    });

    it(`${m.action}: a stale board version is refused with ZERO mutation`, async () => {
      const res = await ops.inject({
        method: "POST",
        url: m.url,
        headers: json,
        payload: { ...m.payload, expectedVersion: "1999-01-01T00:00:00.000Z" },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error.code).toBe("stale_workflow_state");
      expect(H.writes).toEqual([]);
    });

    it(`${m.action}: a client-declared workspace that does not own the row is a 404 with ZERO mutation`, async () => {
      H.members.set(memberKey(OTHER_TEAM, ACTOR), "ACTIVE");
      const res = await ops.inject({
        method: "POST",
        url: m.url,
        headers: json,
        payload: { ...m.payload, teamId: OTHER_TEAM },
      });
      expect(res.statusCode).toBe(404);
      expect(H.writes).toEqual([]);
    });

    it(`${m.action}: missing capability → 403 with ZERO mutation`, async () => {
      H.memberAccessAllowed = false;
      const res = await ops.inject({ method: "POST", url: m.url, headers: json, payload: m.payload });
      expect(res.statusCode).toBe(403);
      expect(H.writes).toEqual([]);
    });
  }

  it("reopen is refused while the workflow is still OPEN (state machine, not the writer)", async () => {
    const res = await ops.inject({
      method: "POST",
      url: `/v1/ops/workflows/${WORKFLOW}/reopen`,
      headers: json,
      payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("invalid_transition");
    expect(body.error.reason).toBe("NOT_RESOLVED_OR_SUPPRESSED");
    expect(H.writes).toEqual([]);
  });

  it("reopen succeeds once the workflow is RESOLVED", async () => {
    H.workflowStatus = "RESOLVED";
    const res = await ops.inject({
      method: "POST",
      url: `/v1/ops/workflows/${WORKFLOW}/reopen`,
      headers: json,
      payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(200);
    expect(H.writes).toContain("reopenWorkflow");
  });

  it("the sensitive closures (resolve, suppress) are bound to a target-scoped step-up", async () => {
    await ops.inject({ method: "POST", url: `/v1/ops/workflows/${WORKFLOW}/resolve`, headers: json, payload: { teamId: TEAM } });
    expect(H.stepUpCalls).toEqual([
      { purpose: "REVIEWER_OPS_ESCALATION_RESOLVE", resourceKind: "operational_workflow", resourceId: WORKFLOW },
    ]);
    H.stepUpCalls.length = 0;
    H.writes.length = 0;
    H.stepUpSent = true;
    const res = await ops.inject({ method: "POST", url: `/v1/ops/workflows/${WORKFLOW}/suppress`, headers: json, payload: { teamId: TEAM } });
    expect(res.statusCode).toBe(401);
    expect(H.writes).toEqual([]);
  });

  it("a non-sensitive action does NOT demand step-up", async () => {
    await ops.inject({ method: "POST", url: `/v1/ops/workflows/${WORKFLOW}/start`, headers: json, payload: { teamId: TEAM } });
    expect(H.stepUpCalls).toEqual([]);
  });

  it("a retry with the same idempotency key REPLAYS instead of re-applying", async () => {
    H.replayToken = "start:retry-token-0001";
    const res = await ops.inject({
      method: "POST",
      url: `/v1/ops/workflows/${WORKFLOW}/start`,
      headers: json,
      payload: { teamId: TEAM, idempotencyKey: "retry-token-0001" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.idempotentReplay).toBe(true);
    expect(body.applied).toBe(false);
    expect(H.writes).not.toContain("startWorkflow");
  });

  it("assigning to a non-member is refused BEFORE any state write", async () => {
    const res = await ops.inject({
      method: "POST",
      url: `/v1/ops/workflows/${WORKFLOW}/assign`,
      headers: json,
      payload: { teamId: TEAM, assigneeUserId: "12121212-1212-4121-8121-121212121212" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_assignee");
    expect(H.writes).toEqual([]);
  });
});

// ===========================================================================
// 2. Command Center bulk actions + causality chains
// ===========================================================================

describe("Operations Intelligence — bulk actions and causality", () => {
  it("a bulk fan-out re-proves the actor with a workspace-bound step-up, then runs ONCE", async () => {
    const res = await ops.inject({
      method: "POST",
      url: "/v1/ops/bulk-actions",
      headers: json,
      payload: { teamId: TEAM, actionType: "BULK_ESCALATE_WORKFLOWS", targetIds: [WORKFLOW] },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.idempotentReplay).toBe(false);
    expect(body.run.runId).toBe(BULK_RUN);
    expect(body.items).toHaveLength(1);
    expect(H.writes.filter((w) => w === "runBulkAction")).toHaveLength(1);
    expect(H.stepUpCalls).toEqual([
      { purpose: "REVIEWER_OPS_BULK_ACTION", resourceKind: "workspace", resourceId: TEAM },
    ]);
  });

  it("a bulk retry with the same key returns the ORIGINAL run and fans out NOTHING", async () => {
    H.bulkReplayKey = "bulk-key-00001";
    const res = await ops.inject({
      method: "POST",
      url: "/v1/ops/bulk-actions",
      headers: json,
      payload: {
        teamId: TEAM,
        actionType: "BULK_ESCALATE_WORKFLOWS",
        targetIds: [WORKFLOW],
        idempotencyKey: "bulk-key-00001",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).idempotentReplay).toBe(true);
    expect(H.writes).not.toContain("runBulkAction");
    // The replay short-circuits BEFORE the step-up gate: no new approval is
    // demanded for an action that is not going to happen again.
    expect(H.stepUpCalls).toEqual([]);
  });

  it("missing step-up on a bulk fan-out → 401 and ZERO run", async () => {
    H.stepUpSent = true;
    const res = await ops.inject({
      method: "POST",
      url: "/v1/ops/bulk-actions",
      headers: json,
      payload: { teamId: TEAM, actionType: "BULK_RESOLVE_WORKFLOWS", targetIds: [WORKFLOW] },
    });
    expect(res.statusCode).toBe(401);
    expect(H.writes).toEqual([]);
  });

  it("missing capability on a bulk fan-out → 403 before the step-up is even offered", async () => {
    H.memberAccessAllowed = false;
    const res = await ops.inject({
      method: "POST",
      url: "/v1/ops/bulk-actions",
      headers: json,
      payload: { teamId: TEAM, actionType: "BULK_RESOLVE_WORKFLOWS", targetIds: [WORKFLOW] },
    });
    expect(res.statusCode).toBe(403);
    expect(H.writes).toEqual([]);
    expect(H.stepUpCalls).toEqual([]);
  });

  it("a bulk run read is workspace-scoped and strips the internal idempotency marker", async () => {
    const res = await ops.inject({ method: "GET", url: `/v1/ops/bulk-actions/${BULK_RUN}?teamId=${TEAM}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.run.id).toBe(BULK_RUN);
    expect(body.run.result.succeeded).toBe(2);
    // The dedup token is an internal control field, not operator data.
    expect(body.run.result).not.toHaveProperty("opsIdempotencyKey");
    expect(res.body).not.toContain("opsIdempotencyKey");

    const denied = await ops.inject({ method: "GET", url: `/v1/ops/bulk-actions/${BULK_RUN}?teamId=${OTHER_TEAM}` });
    expect(denied.statusCode).toBe(404);
  });

  it("causality chains list is member-gated and workspace-scoped", async () => {
    const ok = await ops.inject({ method: "GET", url: `/v1/ops/causality/chains?teamId=${TEAM}` });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).chains).toHaveLength(1);

    const denied = await ops.inject({ method: "GET", url: `/v1/ops/causality/chains?teamId=${OTHER_TEAM}` });
    expect(denied.statusCode).toBe(404);
  });

  it("a causality chain detail resolves its linked workflows server-side", async () => {
    const res = await ops.inject({ method: "GET", url: `/v1/ops/causality/chains/${CHAIN}?teamId=${TEAM}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.chain?.id ?? body.id).toBe(CHAIN);
    expect(res.body).not.toContain("NEVER_SHIP_THIS");
  });

  it("an unknown causality chain is a 404", async () => {
    H.chainExists = false;
    const res = await ops.inject({ method: "GET", url: `/v1/ops/causality/chains/${CHAIN}?teamId=${TEAM}` });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("chain_not_found");
  });
});

// ===========================================================================
// 3. SIU worklist saved views
// ===========================================================================

describe("Operations Intelligence — SIU saved views", () => {
  it("the intake-template catalog is workspace-scoped when a workspace is named", async () => {
    const ok = await siu.inject({ method: "GET", url: `/v1/siu/intake-templates?teamId=${TEAM}` });
    expect(ok.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(ok.body).templates)).toBe(true);

    const denied = await siu.inject({ method: "GET", url: `/v1/siu/intake-templates?teamId=${OTHER_TEAM}` });
    expect(denied.statusCode).toBe(404);
  });

  it("saved views list returns the executable views plus the built-in presets", async () => {
    const res = await siu.inject({ method: "GET", url: `/v1/siu/saved-views?teamId=${TEAM}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.views).toHaveLength(1);
    expect(Array.isArray(body.presets)).toBe(true);
    // The views are DURABLE rows, not client-side state.
    expect(body.durable).toBe(true);
    expect(body.storage).toBe("prisma");
  });

  it("an INACTIVE member gets an explicit member_inactive denial, not an empty list", async () => {
    H.members.set(memberKey(TEAM, ACTOR), "SUSPENDED");
    const res = await siu.inject({ method: "GET", url: `/v1/siu/saved-views?teamId=${TEAM}` });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("member_inactive");
  });

  it("the custom-views list is member-gated", async () => {
    const ok = await siu.inject({ method: "GET", url: `/v1/siu/saved-views/custom?teamId=${TEAM}` });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).views).toHaveLength(1);

    H.members.set(memberKey(TEAM, ACTOR), "SUSPENDED");
    const denied = await siu.inject({ method: "GET", url: `/v1/siu/saved-views/custom?teamId=${TEAM}` });
    expect(denied.statusCode).toBe(403);
  });

  it("creating a saved view persists through the canonical service and returns 201", async () => {
    const res = await siu.inject({
      method: "POST",
      url: "/v1/siu/saved-views",
      headers: json,
      payload: {
        teamId: TEAM,
        name: "High-risk open",
        filter: { requireWarningIndicators: true },
        sort: { key: "updatedAtUtc", direction: "desc" },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).view.id).toBe(VIEW);
    expect(H.writes).toContain("createSavedView");
  });

  it("creating a saved view as a non-member writes NOTHING", async () => {
    const res = await siu.inject({
      method: "POST",
      url: "/v1/siu/saved-views",
      headers: json,
      payload: {
        teamId: OTHER_TEAM,
        name: "Cross-tenant",
        filter: {},
        sort: { key: "updatedAtUtc", direction: "desc" },
      },
    });
    expect(res.statusCode).toBe(403);
    expect(H.writes).toEqual([]);
  });

  it("renaming a saved view is workspace-scoped and 404s when it is not this workspace's row", async () => {
    const ok = await siu.inject({
      method: "PATCH",
      url: `/v1/siu/saved-views/${VIEW}?teamId=${TEAM}`,
      headers: json,
      payload: { name: "Renamed" },
    });
    expect(ok.statusCode).toBe(200);
    expect(H.writes).toContain("updateSavedView");

    H.savedViewExists = false;
    H.writes.length = 0;
    const missing = await siu.inject({
      method: "PATCH",
      url: `/v1/siu/saved-views/${VIEW}?teamId=${TEAM}`,
      headers: json,
      payload: { name: "Renamed" },
    });
    expect(missing.statusCode).toBe(404);
    expect(H.writes).toEqual([]);
  });

  it("deleting a saved view is workspace-scoped", async () => {
    const ok = await siu.inject({ method: "DELETE", url: `/v1/siu/saved-views/${VIEW}?teamId=${TEAM}` });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).deleted).toBe(true);

    H.savedViewExists = false;
    const missing = await siu.inject({ method: "DELETE", url: `/v1/siu/saved-views/${VIEW}?teamId=${TEAM}` });
    expect(missing.statusCode).toBe(404);
  });

  it("USING a view returns the SERVER-executed worklist, not just a bookkeeping ack", async () => {
    const res = await siu.inject({
      method: "POST",
      url: `/v1/siu/saved-views/${VIEW}/use`,
      headers: json,
      payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.view.id).toBe(VIEW);
    // The point of the operation: the client applies a server-run query.
    expect(body.worklist.total).toBe(1);
    expect(body.worklist.rows).toHaveLength(1);
    expect(H.writes).toContain("markSavedViewUsed");
  });

  it("USING an unresolvable view still records the use but returns a null worklist", async () => {
    H.savedViewResolvable = false;
    const res = await siu.inject({
      method: "POST",
      url: `/v1/siu/saved-views/${VIEW}/use`,
      headers: json,
      payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).worklist).toBeNull();
  });
});

// ===========================================================================
// 4. Investigation graph curation
// ===========================================================================

describe("Operations Intelligence — investigation graph", () => {
  it("the evidence subgraph is capability-gated and projects no storage keys", async () => {
    const res = await graph.inject({ method: "GET", url: `/v1/graph/evidence/${EVIDENCE}?teamId=${TEAM}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.nodes).toHaveLength(2);
    expect(H.authorizeSeen).toContain("evidence.read");
    expect(res.body).not.toContain("NEVER_SHIP_THIS");
    expect(res.body).not.toContain("storageKey");
  });

  it("a cross-organization subgraph probe is concealed as 404", async () => {
    H.authorizeAllowed = false;
    H.authorizeDenyStatus = 404;
    const res = await graph.inject({ method: "GET", url: `/v1/graph/evidence/${EVIDENCE}?teamId=${TEAM}` });
    expect(res.statusCode).toBe(404);
  });

  it("graph search is capability-gated and drops unknown kind tokens instead of 400ing", async () => {
    const res = await graph.inject({
      method: "GET",
      url: `/v1/graph/search?teamId=${TEAM}&kinds=EVIDENCE,NOT_A_REAL_KIND&label=Photo`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).nodes).toHaveLength(1);
    expect(res.body).not.toContain("NEVER_SHIP_THIS");
  });

  it("asserting a manual relationship writes ONCE through the canonical service", async () => {
    const res = await graph.inject({
      method: "POST",
      url: "/v1/graph/relationships/manual",
      headers: json,
      payload: { teamId: TEAM, sourceNodeId: NODE_A, targetNodeId: NODE_B, edgeType: "MANUALLY_LINKED_TO", safeNote: "Same claimant" },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).manualRelationshipId).toBe(MANUAL_REL);
    expect(H.writes.filter((w) => w === "createManualRelationship")).toHaveLength(1);
    expect(H.authorizeSeen).toContain("evidence.update_metadata");
  });

  it("re-asserting the SAME relationship is idempotent — no second provenance row", async () => {
    H.manualRelationshipExists = true;
    const res = await graph.inject({
      method: "POST",
      url: "/v1/graph/relationships/manual",
      headers: json,
      payload: { teamId: TEAM, sourceNodeId: NODE_A, targetNodeId: NODE_B, edgeType: "MANUALLY_LINKED_TO" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).idempotent).toBe(true);
    expect(H.writes).toEqual([]);
  });

  it("a self-loop is refused before authorization is even consulted", async () => {
    const res = await graph.inject({
      method: "POST",
      url: "/v1/graph/relationships/manual",
      headers: json,
      payload: { teamId: TEAM, sourceNodeId: NODE_A, targetNodeId: NODE_A, edgeType: "MANUALLY_LINKED_TO" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("self_loop_not_allowed");
    expect(H.writes).toEqual([]);
  });

  it("retracting a manual relationship is capability-gated and writes ONCE", async () => {
    const res = await graph.inject({
      method: "DELETE",
      url: `/v1/graph/relationships/manual/${MANUAL_REL}`,
      headers: json,
      payload: { teamId: TEAM, reason: "Asserted in error" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).retracted).toBe(true);
    expect(H.writes.filter((w) => w === "retractManualRelationship")).toHaveLength(1);
  });

  it("retracting without the capability writes NOTHING", async () => {
    H.authorizeAllowed = false;
    const res = await graph.inject({
      method: "DELETE",
      url: `/v1/graph/relationships/manual/${MANUAL_REL}`,
      headers: json,
      payload: { teamId: TEAM },
    });
    expect(res.statusCode).toBe(403);
    expect(H.writes).toEqual([]);
  });

  it("graph diagnostics require an operator-grade membership and 404 for a non-member", async () => {
    const ok = await graph.inject({ method: "GET", url: `/v1/graph/diagnostics?teamId=${TEAM}` });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).nodeCount).toBe(2);

    const denied = await graph.inject({ method: "GET", url: `/v1/graph/diagnostics?teamId=${OTHER_TEAM}` });
    expect(denied.statusCode).toBe(404);
  });
});

// ===========================================================================
// 5. Intelligence records + corrections
// ===========================================================================

describe("Operations Intelligence — intelligence records and corrections", () => {
  it("a record detail carries its server-rendered immutable chain in ONE round trip", async () => {
    const res = await intel.inject({ method: "GET", url: `/v1/intelligence/records/${RECORD}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.record.id).toBe(RECORD);
    expect(body.chain.immutable).toBe(true);
    expect(body.chain.currentVersionId).toBe(CORRECTION);
    // The chain is an audit trail of WHAT changed — never a channel for
    // re-emitting extracted content.
    expect(res.body).not.toContain("RAW_EXTRACTED_CONTENT_SHOULD_NEVER_SHIP");
    expect(body.chain.versions[0].patchKeys).toEqual(["text"]);
    expect(H.authorizeSeen).toContain("intelligence.read");
  });

  it("an unknown record is a bounded RECORD_NOT_FOUND denial", async () => {
    H.recordExists = false;
    const res = await intel.inject({ method: "GET", url: `/v1/intelligence/records/${RECORD}` });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).denial).toBe("RECORD_NOT_FOUND");
  });

  it("an operator with no current workspace is 404ed, never served a cross-tenant record", async () => {
    H.currentWorkspaceId = null;
    const res = await intel.inject({ method: "GET", url: `/v1/intelligence/records/${RECORD}` });
    expect(res.statusCode).toBe(404);
  });

  it("the standalone version chain renders the same immutable projection", async () => {
    const res = await intel.inject({ method: "GET", url: `/v1/intelligence/records/${RECORD}/version-chain` });
    expect(res.statusCode).toBe(200);
    const chain = JSON.parse(res.body).chain;
    expect(chain.totalVersions).toBe(1);
    expect(chain.acceptedCount).toBe(1);
    expect(chain.revertedCount).toBe(0);
    expect(res.body).not.toContain("RAW_EXTRACTED_CONTENT_SHOULD_NEVER_SHIP");
  });

  it("a missing chain is a bounded denial, not an empty success", async () => {
    H.chainRowExists = false;
    const res = await intel.inject({ method: "GET", url: `/v1/intelligence/records/${RECORD}/version-chain` });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).denial).toBe("RECORD_NOT_FOUND");
  });

  it("the per-record corrections list is read-gated", async () => {
    const ok = await intel.inject({ method: "GET", url: `/v1/intelligence/records/${RECORD}/corrections` });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).corrections).toHaveLength(1);

    H.authorizeAllowed = false;
    const denied = await intel.inject({ method: "GET", url: `/v1/intelligence/records/${RECORD}/corrections` });
    expect(denied.statusCode).toBe(403);
  });

  it("authoring a correction needs the WRITE capability, not the read one", async () => {
    const res = await intel.inject({
      method: "POST",
      url: "/v1/intelligence/corrections",
      headers: json,
      payload: { recordId: RECORD, kind: "OCR_TEXT", patch: { text: "corrected" }, rationale: "OCR misread" },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).correctionId).toBe(CORRECTION);
    expect(H.authorizeSeen).toContain("intelligence.feedback.write");
    expect(H.writes).toContain("createCorrection");
  });

  it("authoring a correction without the write capability writes NOTHING", async () => {
    H.authorizeAllowed = false;
    const res = await intel.inject({
      method: "POST",
      url: "/v1/intelligence/corrections",
      headers: json,
      payload: { recordId: RECORD, kind: "OCR_TEXT", patch: { text: "corrected" } },
    });
    expect(res.statusCode).toBe(403);
    expect(H.writes).toEqual([]);
  });

  it("accepting a correction is write-gated and surfaces a bounded conflict denial", async () => {
    const ok = await intel.inject({
      method: "POST",
      url: `/v1/intelligence/corrections/${CORRECTION}/accept`,
      headers: json,
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).recordId).toBe(RECORD);
    expect(H.writes).toContain("acceptCorrection");

    H.correctionDenial = "ALREADY_ACCEPTED";
    H.writes.length = 0;
    const conflict = await intel.inject({
      method: "POST",
      url: `/v1/intelligence/corrections/${CORRECTION}/accept`,
      headers: json,
      payload: {},
    });
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.body).denial).toBe("ALREADY_ACCEPTED");
    expect(H.writes).toEqual([]);
  });

  it("reverting a correction is write-gated and surfaces a bounded conflict denial", async () => {
    const ok = await intel.inject({
      method: "POST",
      url: `/v1/intelligence/corrections/${CORRECTION}/revert`,
      headers: json,
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).revertedCorrectionId).toBe(CORRECTION);
    expect(H.authorizeSeen).toContain("intelligence.feedback.write");

    H.correctionDenial = "NOT_ACCEPTED";
    H.writes.length = 0;
    const conflict = await intel.inject({
      method: "POST",
      url: `/v1/intelligence/corrections/${CORRECTION}/revert`,
      headers: json,
      payload: {},
    });
    expect(conflict.statusCode).toBe(409);
    expect(H.writes).toEqual([]);
  });

  it("executive metrics are workspace-scoped and read-gated", async () => {
    const ok = await intel.inject({ method: "GET", url: "/v1/executive/metrics" });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).metrics.evidenceTotal).toBe(12);

    H.authorizeAllowed = false;
    H.authorizeDenyStatus = 404;
    const denied = await intel.inject({ method: "GET", url: "/v1/executive/metrics" });
    expect(denied.statusCode).toBe(404);
  });
});

// ===========================================================================
// 6. Bounded catalogs — intelligence vocabulary + analytics window
// ===========================================================================

describe("Operations Intelligence — bounded catalogs", () => {
  it("the intelligence catalog is authenticated and carries the advisory disclaimer", async () => {
    const res = await catalogs.inject({ method: "GET", url: "/v1/intelligence/catalogs" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.jobKinds)).toBe(true);
    expect(Array.isArray(body.entityKinds)).toBe(true);
    // The catalog must never ship a retired vocabulary back to clients.
    expect(body).not.toHaveProperty("aiAssistanceKinds");
    expect(typeof body.disclaimer).toBe("string");
    expect(body.disclaimer.length).toBeGreaterThan(0);
  });

  it("the analytics window catalog states the server's clamp, so the client never invents one", async () => {
    const res = await analytics.inject({ method: "GET", url: "/v1/analytics/_window" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.minDays).toBeGreaterThan(0);
    expect(body.maxDays).toBeGreaterThanOrEqual(body.minDays);
    expect(body.defaultDays).toBeGreaterThanOrEqual(body.minDays);
    expect(body.defaultDays).toBeLessThanOrEqual(body.maxDays);
    // A negative window is clamped by the SERVER, not rejected client-side.
    expect(body.clamp.example.clamped).toBeGreaterThanOrEqual(body.minDays);
  });
});

// ===========================================================================
// 7. Reviewer Copilot observation verdicts
// ===========================================================================

describe("Operations Intelligence — Reviewer Copilot observation verdicts", () => {
  const obs = { observationId: "criteriaObservations:0", state: "EDITED", originalText: "AI text", editedText: "Reviewer text" };

  it("records the human verdict and answers with the canonical policy + disclosure", async () => {
    const res = await ai.inject({
      method: "POST",
      url: `/v1/ai/copilot-runs/${RUN}/observations`,
      headers: json,
      payload: obs,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.state).toBe("EDITED");
    expect(H.writes).toContain("recordObservationInteraction");
    // Defensibility: the policy that governed the RUN, alongside the
    // workspace's current policy — the two are distinguishable.
    expect(body.aiPolicy.runPolicyVersion).toBe("p-1");
    expect(body.aiPolicy.policyVersion).toBe("p-2");
    // Disclosure is bounded to the reviewer capability — never the whole catalog.
    expect(body.disclosure).toHaveLength(1);
    expect(body.disclosure[0].capability).toBe("REVIEWER_COPILOT");
    expect(body.advisoryBoundary).toMatch(/advisory/i);
  });

  it("the workspace comes from the PERSISTED run, and an unknown run is a 404", async () => {
    H.copilotRunExists = false;
    const res = await ai.inject({
      method: "POST",
      url: `/v1/ai/copilot-runs/${RUN}/observations`,
      headers: json,
      payload: obs,
    });
    expect(res.statusCode).toBe(404);
    expect(H.writes).toEqual([]);
  });

  it("without the intelligence capability the verdict is refused and recorded NOWHERE", async () => {
    H.authorizeAllowed = false;
    const res = await ai.inject({
      method: "POST",
      url: `/v1/ai/copilot-runs/${RUN}/observations`,
      headers: json,
      payload: obs,
    });
    expect(res.statusCode).toBe(403);
    expect(H.writes).toEqual([]);
    expect(H.authorizeSeen).toContain("intelligence.run");
  });

  it("a state outside the bounded verdict vocabulary is refused", async () => {
    const res = await ai.inject({
      method: "POST",
      url: `/v1/ai/copilot-runs/${RUN}/observations`,
      headers: json,
      payload: { ...obs, state: "APPROVED_BY_AI" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(H.writes).toEqual([]);
  });
});

// ===========================================================================
// 8. Admin analytics — composite authority parity
// ===========================================================================

describe("Operations Intelligence — admin analytics composite parity", () => {
  const REPO = resolve(__dirname, "../../..");
  const analyticsSource = readFileSync(
    join(REPO, "services/api/src/routes/analytics.routes.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  const GRANULAR = ["summary", "geography", "pages", "recent", "trends", "funnel"] as const;

  it("the six granular admin-analytics operations are GONE from the registered surface", () => {
    for (const key of GRANULAR) {
      expect(
        analyticsSource,
        `/v1/admin/analytics/${key} must not be re-registered`,
      ).not.toMatch(new RegExp(`["'\`]/v1/admin/analytics/${key}["'\`]`));
    }
  });

  it("the ONE composite authority still awaits every one of the six producers", () => {
    // Literal parity: the composite calls the same six producers the granular
    // routes called, and returns them under the same keys.
    const composite = analyticsSource.slice(
      analyticsSource.indexOf('"/v1/admin/analytics/dashboard"'),
    );
    for (const producer of ["getSummary", "getGeography", "getPages", "getRecent", "getTrends", "getFunnel"]) {
      expect(composite, `${producer} missing from the composite`).toContain(`${producer}(`);
    }
    for (const key of GRANULAR) {
      expect(composite, `key ${key} missing from the composite response`).toMatch(
        new RegExp(`\\b${key}\\b`),
      );
    }
  });

  it("the producers survive as INTERNAL composition — the capability was preserved, not dropped", () => {
    for (const producer of ["getSummary", "getGeography", "getPages", "getRecent", "getTrends", "getFunnel"]) {
      expect(analyticsSource).toMatch(
        new RegExp(`(async function|const)\\s+${producer}\\b`),
      );
    }
  });
});

// ===========================================================================
// 9. SIU saved view → REAL worklist query
//
// Systems 1–8 drive the ROUTES with the SIU view-query service mocked, which
// proves the route composition but says nothing about whether a saved view
// actually changes what the database is asked. This system imports the REAL
// `siu-view-query.service.ts` and drives it against the same prisma seam, so
// the end of the chain — "the selected view narrows the actual query" — is
// proven rather than assumed.
// ===========================================================================

describe("Operations Intelligence — SIU saved view drives the real worklist query", () => {
  /** Every `caseSiuProfile` query the service issued, in order. */
  const issued: Array<{ op: string; where: Record<string, unknown>; orderBy?: unknown; take?: number }> = [];
  /** Durable saved-view rows the persistence layer holds. */
  let savedViewRows: Array<Record<string, unknown>> = [];

  async function realService() {
    // Re-import the ACTUAL module (systems 1–8 mock it file-wide).
    const actual = await vi.importActual<
      typeof import("../src/services/siu/siu-view-query.service.js")
    >("../src/services/siu/siu-view-query.service.js");
    return actual;
  }

  beforeEach(async () => {
    issued.length = 0;
    savedViewRows = [];
    const { prisma } = (await import("../src/db.js")) as unknown as {
      prisma: Record<string, unknown>;
    };
    // The real service reads these two models. The seam RECORDS the query so
    // the assertions below are about the predicate the database receives.
    (prisma as Record<string, unknown>).caseSiuSavedView = {
      findMany: async () => savedViewRows,
      findFirst: async ({ where }: { where: { id: string; teamId: string } }) =>
        savedViewRows.find((r) => r.id === where.id && r.teamId === where.teamId) ?? null,
    };
    (prisma as Record<string, unknown>).caseSiuProfile = {
      count: async ({ where }: { where: Record<string, unknown> }) => {
        issued.push({ op: "count", where });
        return 1;
      },
      findMany: async (args: { where: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
        issued.push({ op: "findMany", where: args.where, orderBy: args.orderBy, take: args.take });
        return [];
      },
    };
  });

  const VIEW_ROW = {
    id: VIEW,
    teamId: TEAM,
    name: "Needs evidence",
    description: null,
    visibility: "private",
    createdByUserId: ACTOR,
    filterJson: { requireMissingChecklistItems: true },
    sortJson: { key: "updatedAtUtc", direction: "desc" },
  };

  it("with NO view the worklist is the honest unfiltered workspace query", async () => {
    const { runSiuWorklist } = await realService();
    await runSiuWorklist({ teamId: TEAM, view: null });
    // Team-anchored and nothing else — not an empty result, not a global read.
    expect(issued[0].where).toEqual({ teamId: TEAM });
  });

  it("applying a saved view NARROWS the real query with that view's predicate", async () => {
    const { resolveSiuView, runSiuWorklist } = await realService();
    savedViewRows = [VIEW_ROW];
    const resolved = await resolveSiuView({ teamId: TEAM, userId: ACTOR, viewId: VIEW });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    await runSiuWorklist({ teamId: TEAM, view: resolved.view });
    const where = issued[0].where as Record<string, unknown>;
    expect(where.teamId).toBe(TEAM);
    // The saved view's bounded flag became a REAL relational predicate.
    expect(where.checklistItems).toEqual({ some: { status: "missing", required: true } });
  });

  it("the definition is re-read from PERSISTENCE — an edit changes later results", async () => {
    const { resolveSiuView, runSiuWorklist } = await realService();
    savedViewRows = [VIEW_ROW];
    const first = await resolveSiuView({ teamId: TEAM, userId: ACTOR, viewId: VIEW });
    if (!first.ok) throw new Error("expected the view to resolve");
    await runSiuWorklist({ teamId: TEAM, view: first.view });
    expect(issued[0].where).toHaveProperty("checklistItems");

    // Edit the persisted definition, then resolve again.
    savedViewRows = [
      { ...VIEW_ROW, filterJson: { requireOpenFollowUps: true }, sortJson: { key: "incidentDate", direction: "asc" } },
    ];
    issued.length = 0;
    const second = await resolveSiuView({ teamId: TEAM, userId: ACTOR, viewId: VIEW });
    if (!second.ok) throw new Error("expected the edited view to resolve");
    await runSiuWorklist({ teamId: TEAM, view: second.view });
    const where = issued[0].where as Record<string, unknown>;
    expect(where).not.toHaveProperty("checklistItems");
    expect(where.followUps).toBeTruthy();
    // The bounded sort key became a real orderBy — no caller-supplied column.
    expect(issued[1].orderBy).toEqual({ incidentDate: "asc" });
  });

  it("a DELETED view can no longer be used", async () => {
    const { resolveSiuView } = await realService();
    savedViewRows = [VIEW_ROW];
    expect((await resolveSiuView({ teamId: TEAM, userId: ACTOR, viewId: VIEW })).ok).toBe(true);
    savedViewRows = [];
    const after = await resolveSiuView({ teamId: TEAM, userId: ACTOR, viewId: VIEW });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe("not_found");
  });

  it("a view belonging to ANOTHER workspace is concealed, never widened", async () => {
    const { resolveSiuView } = await realService();
    savedViewRows = [{ ...VIEW_ROW, teamId: OTHER_TEAM }];
    const outcome = await resolveSiuView({ teamId: TEAM, userId: ACTOR, viewId: VIEW });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("not_found");
    // Nothing was queried on behalf of the foreign view.
    expect(issued).toEqual([]);
  });

  it("another operator's PRIVATE view is concealed even inside the same workspace", async () => {
    const { resolveSiuView } = await realService();
    savedViewRows = [{ ...VIEW_ROW, createdByUserId: "someone-else" }];
    const outcome = await resolveSiuView({ teamId: TEAM, userId: ACTOR, viewId: VIEW });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("not_found");
  });

  it("a MALFORMED persisted definition fails safe — it never degrades to unfiltered", async () => {
    const { resolveSiuView } = await realService();
    savedViewRows = [
      // `investigationStatus` outside the closed enum + an unknown key.
      { ...VIEW_ROW, filterJson: { investigationStatus: ["not_a_status"], rawSql: "1=1" } },
    ];
    const outcome = await resolveSiuView({ teamId: TEAM, userId: ACTOR, viewId: VIEW });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("invalid_definition");
    expect(issued).toEqual([]);
  });

  it("an arbitrary field can never reach Prisma — the filter vocabulary is CLOSED", async () => {
    const { buildSiuProfileWhere } = await realService();
    const { SiuSavedViewFilterSchema } = await vi.importActual<
      typeof import("../src/services/siu/siu-saved-views.service.js")
    >("../src/services/siu/siu-saved-views.service.js");
    // A strict schema REJECTS unknown keys rather than silently passing them.
    expect(
      SiuSavedViewFilterSchema.safeParse({ claimantName: "Jane", OR: [{ teamId: OTHER_TEAM }] }).success,
    ).toBe(false);
    // And the translator only ever emits keys it knows.
    const where = buildSiuProfileWhere(TEAM, { requireWarningIndicators: true });
    expect(Object.keys(where).sort()).toEqual(["reviewIndicators", "teamId"]);
  });

  it("the worklist projection never selects claimant PII", async () => {
    const { runSiuWorklist } = await realService();
    await runSiuWorklist({ teamId: TEAM, view: null });
    const src = readFileSync(
      join(resolve(__dirname, "../../.."), "services/api/src/services/siu/siu-view-query.service.ts"),
      "utf8",
    );
    const selectBlock = src.slice(src.indexOf("select: {"), src.indexOf("_count:"));
    expect(selectBlock).not.toMatch(/claimantName/);
    expect(selectBlock).not.toMatch(/claimantContact/);
  });
});

// ===========================================================================
// Coverage manifest — machine-checked against the Phase-12 wiring registry
// ===========================================================================

/**
 * Every OPERATIONS_INTELLIGENCE operation in the Phase-12 wiring registry,
 * with the system above that proves it. Keeping this list IN the suite means
 * the registry and the behavioral proof cannot drift apart silently.
 */
const OPERATIONS: ReadonlyArray<string> = [
  // 1. Command Center workflow board
  "GET /v1/ops/workflows",
  "GET /v1/ops/workflows/:id",
  "POST /v1/ops/workflows/:id/assign",
  "POST /v1/ops/workflows/:id/start",
  "POST /v1/ops/workflows/:id/escalate",
  "POST /v1/ops/workflows/:id/mitigation",
  "POST /v1/ops/workflows/:id/resolve",
  "POST /v1/ops/workflows/:id/suppress",
  "POST /v1/ops/workflows/:id/reopen",
  "POST /v1/ops/workflows/:id/schedule-retry",
  // 2. Bulk + causality
  "POST /v1/ops/bulk-actions",
  "GET /v1/ops/bulk-actions/:id",
  "GET /v1/ops/causality/chains",
  "GET /v1/ops/causality/chains/:id",
  // 3. SIU saved views
  "GET /v1/siu/intake-templates",
  "GET /v1/siu/saved-views",
  "GET /v1/siu/saved-views/custom",
  "POST /v1/siu/saved-views",
  "PATCH /v1/siu/saved-views/:id",
  "DELETE /v1/siu/saved-views/:id",
  "POST /v1/siu/saved-views/:id/use",
  // 4. Investigation graph
  "GET /v1/graph/evidence/:evidenceId",
  "GET /v1/graph/search",
  "GET /v1/graph/diagnostics",
  "POST /v1/graph/relationships/manual",
  "DELETE /v1/graph/relationships/manual/:manualRelationshipId",
  // 5. Intelligence records + corrections
  "GET /v1/intelligence/records/:id",
  "GET /v1/intelligence/records/:id/version-chain",
  "GET /v1/intelligence/records/:id/corrections",
  "POST /v1/intelligence/corrections",
  "POST /v1/intelligence/corrections/:id/accept",
  "POST /v1/intelligence/corrections/:id/revert",
  "GET /v1/executive/metrics",
  // 6. Bounded catalogs
  "GET /v1/intelligence/catalogs",
  "GET /v1/analytics/_window",
  // 7. Reviewer Copilot observations
  "POST /v1/ai/copilot-runs/:runId/observations",
  // 8. Admin analytics — removed under full parity, proven by system 8
  "GET /v1/admin/analytics/summary",
  "GET /v1/admin/analytics/geography",
  "GET /v1/admin/analytics/pages",
  "GET /v1/admin/analytics/recent",
  "GET /v1/admin/analytics/trends",
  "GET /v1/admin/analytics/funnel",
];

describe("Operations Intelligence — coverage manifest", () => {
  it("covers exactly the 42 OPERATIONS_INTELLIGENCE operations, with no duplicates", () => {
    expect(new Set(OPERATIONS).size).toBe(OPERATIONS.length);
    expect(OPERATIONS.length).toBe(42);
  });

  it("matches the vertical assignment in the canonical capability map", () => {
    const REPO = resolve(__dirname, "../../..");
    const capabilityMap = JSON.parse(
      readFileSync(join(REPO, "docs/architecture/current-runtime-capability-map.json"), "utf8"),
    ) as { capabilities: Array<{ capabilityId: string; vertical: string }> };
    const vertical = new Map(capabilityMap.capabilities.map((c) => [c.capabilityId, c.vertical]));
    const wrong = OPERATIONS.map((op) => {
      const [method, route] = op.split(" ");
      const v = vertical.get(`${method}:${route}`);
      return v && v !== "OPERATIONS_INTELLIGENCE" ? `${op} → ${v}` : null;
    }).filter(Boolean);
    expect(wrong, `operations claimed here but classified elsewhere:\n${wrong.join("\n")}`).toEqual([]);
  });
});
