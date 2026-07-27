/**
 * Phase T (Phase 4) — Evidence-to-EvidenceReviewWorkflow template identity propagation.
 *
 * The reviewer queue is initialised at capture-finalize via
 * upsertEvidenceReviewerWorkflow. Phase 4 threads the canonical
 * template-identity trio (templateSlug + templateVersion + optional
 * templateDbId) from the Evidence row through that upsert so the workflow
 * row carries the same trio as the evidence it tracks.
 *
 * Asserted contracts:
 *
 *   1. The service accepts a `templateIdentity` parameter. When the
 *      caller passes a trio with a slug, the trio is persisted on the
 *      workflow row at create time AND on subsequent updates.
 *
 *   2. Legacy evidence (NULL trio) writes NULL columns and DOES NOT emit
 *      the audit event — never throws.
 *
 *   3. The capture-finalize call site at evidence.routes.ts reads the
 *      trio off the freshly-completed Evidence row inside a try/catch,
 *      passes it through, and the upsert tolerates an outright read
 *      failure (the trio block is wrapped in its own inner try/catch).
 *
 *   4. When trio is present, the service emits
 *      "reviewer_workflow.template_identity.stamped" via
 *      appendPlatformAuditLog, with a bounded metadata payload built by
 *      templateIdentityAuditMetadata. Audit emission failure NEVER
 *      breaks the upsert (it is fire-and-forget via void + .catch).
 *
 *   5. The manual reviewer-workflow PATCH route (evidence.routes.ts:6696)
 *      also threads the trio with source "direct" so a later UI update
 *      backfills the trio onto legacy workflow rows.
 *
 *   6. Hard-rules guard: the service does NOT mutate policy/business
 *      logic — only identity columns are touched. The new audit action
 *      does not introduce a new audit table; it reuses
 *      appendPlatformAuditLog.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — bound BEFORE the SUT import. vi.mock is hoisted to the top of the
// file by Vitest, so the factory cannot capture closure variables declared
// after the hoisted block. We therefore declare the mocks themselves inside
// a vi.hoisted() block so they exist in the hoisted scope.
// ---------------------------------------------------------------------------

const {
  findUniqueMock,
  updateMock,
  createMock,
  eventCreateMock,
  txMock,
  appendPlatformAuditLogMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
  createMock: vi.fn(),
  eventCreateMock: vi.fn(),
  txMock: vi.fn(),
  appendPlatformAuditLogMock: vi.fn(),
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    evidenceReviewWorkflow: {
      findUnique: findUniqueMock,
      update: updateMock,
      create: createMock,
    },
    evidenceReviewWorkflowEvent: {
      create: eventCreateMock,
    },
    $transaction: txMock,
  },
}));

vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: appendPlatformAuditLogMock,
}));

// Re-import the SUT after mocks are in place. We import lazily inside each
// describe-block so the mock module graph is honoured.
//
// We import the type helpers directly because the resolver is a pure
// module that does not touch prisma at import time.
import {
  templateIdentityAuditMetadata,
  type TemplateIdentityTrio,
} from "../src/services/templates/identity-resolver.service.js";

// ---------------------------------------------------------------------------
// Common helpers.
// ---------------------------------------------------------------------------

const EVIDENCE_ID = "00000000-0000-0000-0000-000000000010";
const WORKFLOW_ID = "00000000-0000-0000-0000-000000000020";
const ACTOR_ID = "00000000-0000-0000-0000-000000000030";

const POPULATED_TRIO: TemplateIdentityTrio = {
  templateSlug: "general-evidence-record",
  templateVersion: 7,
  templateDbId: "11111111-1111-1111-1111-111111111111",
};

const EMPTY_TRIO: TemplateIdentityTrio = {
  templateSlug: null,
  templateVersion: null,
  templateDbId: null,
};

beforeEach(() => {
  findUniqueMock.mockReset();
  updateMock.mockReset();
  createMock.mockReset();
  eventCreateMock.mockReset();
  txMock.mockReset();
  appendPlatformAuditLogMock.mockReset();
  // Resolve appendPlatformAuditLog as the default success case. Tests that
  // exercise the failure-tolerance contract override this.
  appendPlatformAuditLogMock.mockResolvedValue(undefined);
  // The reviewer-workflow service only batches the workflow-event creates
  // through $transaction. Resolve to a no-op array so we don't crash.
  txMock.mockResolvedValue([]);
  // Default event-create stub returns a promise-shaped object that the
  // service awaits via $transaction. Returning a thenable is sufficient.
  eventCreateMock.mockReturnValue({ then: () => undefined });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Create-branch stamps the trio when supplied.
// ---------------------------------------------------------------------------

describe("Phase T — upsertEvidenceReviewerWorkflow create-branch", () => {
  it("stamps templateSlug/templateVersion/templateDbId at create time when trio is supplied", async () => {
    findUniqueMock.mockResolvedValueOnce(null); // no existing row -> create branch
    findUniqueMock.mockResolvedValueOnce({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      workspaceType: "TEAM",
      teamId: "team-1",
      status: "NOT_STARTED",
      priority: "NORMAL",
      dueAt: null,
      lastReviewedAt: null,
      closedAt: null,
      createdAt: new Date("2026-06-05T00:00:00Z"),
      updatedAt: new Date("2026-06-05T00:00:00Z"),
      assignedTo: null,
      assignedBy: null,
    });
    createMock.mockResolvedValue({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      status: "NOT_STARTED",
      priority: "NORMAL",
      assignedToUserId: null,
      dueAt: null,
      templateSlug: POPULATED_TRIO.templateSlug,
      templateVersion: POPULATED_TRIO.templateVersion,
      templateDbId: POPULATED_TRIO.templateDbId,
    });

    const { upsertEvidenceReviewerWorkflow } = await import(
      "../src/services/evidence-review/reviewer-workflow.service.js"
    );

    await upsertEvidenceReviewerWorkflow({
      evidenceId: EVIDENCE_ID,
      workspaceType: "TEAM",
      teamId: "team-1",
      actorUserId: ACTOR_ID,
      note: "Created automatically on Capture finalization.",
      templateIdentity: POPULATED_TRIO,
      templateIdentitySource: "capture",
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const data = createMock.mock.calls[0][0].data;
    expect(data.templateSlug).toBe(POPULATED_TRIO.templateSlug);
    expect(data.templateVersion).toBe(POPULATED_TRIO.templateVersion);
    expect(data.templateDbId).toBe(POPULATED_TRIO.templateDbId);
    expect(data.evidenceId).toBe(EVIDENCE_ID);
    expect(data.workspaceType).toBe("TEAM");
  });

  it("writes NULL columns when the trio is the empty trio (legacy evidence)", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      workspaceType: "PERSONAL",
      teamId: null,
      status: "NOT_STARTED",
      priority: "NORMAL",
      dueAt: null,
      lastReviewedAt: null,
      closedAt: null,
      createdAt: new Date("2026-06-05T00:00:00Z"),
      updatedAt: new Date("2026-06-05T00:00:00Z"),
      assignedTo: null,
      assignedBy: null,
    });
    createMock.mockResolvedValue({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      status: "NOT_STARTED",
      priority: "NORMAL",
      assignedToUserId: null,
      dueAt: null,
      templateSlug: null,
      templateVersion: null,
      templateDbId: null,
    });

    const { upsertEvidenceReviewerWorkflow } = await import(
      "../src/services/evidence-review/reviewer-workflow.service.js"
    );

    await upsertEvidenceReviewerWorkflow({
      evidenceId: EVIDENCE_ID,
      workspaceType: "PERSONAL",
      teamId: null,
      actorUserId: ACTOR_ID,
      templateIdentity: EMPTY_TRIO,
      templateIdentitySource: "capture",
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const data = createMock.mock.calls[0][0].data;
    expect(data.templateSlug).toBeNull();
    expect(data.templateVersion).toBeNull();
    expect(data.templateDbId).toBeNull();
  });

  it("does not touch the trio columns when templateIdentity is undefined (legacy callers)", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      workspaceType: "TEAM",
      teamId: "team-1",
      status: "NOT_STARTED",
      priority: "NORMAL",
      dueAt: null,
      lastReviewedAt: null,
      closedAt: null,
      createdAt: new Date("2026-06-05T00:00:00Z"),
      updatedAt: new Date("2026-06-05T00:00:00Z"),
      assignedTo: null,
      assignedBy: null,
    });
    createMock.mockResolvedValue({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      status: "NOT_STARTED",
      priority: "NORMAL",
      assignedToUserId: null,
      dueAt: null,
    });

    const { upsertEvidenceReviewerWorkflow } = await import(
      "../src/services/evidence-review/reviewer-workflow.service.js"
    );

    await upsertEvidenceReviewerWorkflow({
      evidenceId: EVIDENCE_ID,
      workspaceType: "TEAM",
      teamId: "team-1",
      actorUserId: ACTOR_ID,
      // templateIdentity intentionally omitted.
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const data = createMock.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("templateSlug");
    expect(data).not.toHaveProperty("templateVersion");
    expect(data).not.toHaveProperty("templateDbId");
  });
});

// ---------------------------------------------------------------------------
// 2. Update-branch stamps the trio when supplied.
// ---------------------------------------------------------------------------

describe("Phase T — upsertEvidenceReviewerWorkflow update-branch", () => {
  it("stamps the trio onto an existing workflow row when the caller passes it", async () => {
    // First findUnique inside the upsert returns an existing row -> update branch.
    findUniqueMock.mockResolvedValueOnce({
      id: WORKFLOW_ID,
      status: "NOT_STARTED",
      priority: "NORMAL",
      dueAt: null,
      assignedToUserId: null,
      assignedByUserId: null,
      templateSlug: null,
      templateVersion: null,
      templateDbId: null,
    });
    // Second findUnique is the summary read at the end. Return a populated row.
    findUniqueMock.mockResolvedValueOnce({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      workspaceType: "TEAM",
      teamId: "team-1",
      status: "IN_REVIEW",
      priority: "HIGH",
      dueAt: null,
      lastReviewedAt: new Date("2026-06-05T00:00:00Z"),
      closedAt: null,
      createdAt: new Date("2026-06-04T00:00:00Z"),
      updatedAt: new Date("2026-06-05T00:00:00Z"),
      assignedTo: null,
      assignedBy: null,
    });
    updateMock.mockResolvedValue({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      status: "IN_REVIEW",
      priority: "HIGH",
      assignedToUserId: null,
      dueAt: null,
      templateSlug: POPULATED_TRIO.templateSlug,
      templateVersion: POPULATED_TRIO.templateVersion,
      templateDbId: POPULATED_TRIO.templateDbId,
    });

    const { upsertEvidenceReviewerWorkflow } = await import(
      "../src/services/evidence-review/reviewer-workflow.service.js"
    );

    await upsertEvidenceReviewerWorkflow({
      evidenceId: EVIDENCE_ID,
      workspaceType: "TEAM",
      teamId: "team-1",
      actorUserId: ACTOR_ID,
      status: "IN_REVIEW" as never,
      priority: "HIGH" as never,
      templateIdentity: POPULATED_TRIO,
      templateIdentitySource: "direct",
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    const data = updateMock.mock.calls[0][0].data;
    expect(data.templateSlug).toBe(POPULATED_TRIO.templateSlug);
    expect(data.templateVersion).toBe(POPULATED_TRIO.templateVersion);
    expect(data.templateDbId).toBe(POPULATED_TRIO.templateDbId);
  });

  it("does not touch trio columns on update when templateIdentity is undefined", async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: WORKFLOW_ID,
      status: "NOT_STARTED",
      priority: "NORMAL",
      dueAt: null,
      assignedToUserId: null,
      assignedByUserId: null,
      templateSlug: "preserved",
      templateVersion: 4,
      templateDbId: "22222222-2222-2222-2222-222222222222",
    });
    findUniqueMock.mockResolvedValueOnce({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      workspaceType: "TEAM",
      teamId: "team-1",
      status: "IN_REVIEW",
      priority: "NORMAL",
      dueAt: null,
      lastReviewedAt: null,
      closedAt: null,
      createdAt: new Date("2026-06-04T00:00:00Z"),
      updatedAt: new Date("2026-06-05T00:00:00Z"),
      assignedTo: null,
      assignedBy: null,
    });
    updateMock.mockResolvedValue({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      status: "IN_REVIEW",
      priority: "NORMAL",
      assignedToUserId: null,
      dueAt: null,
    });

    const { upsertEvidenceReviewerWorkflow } = await import(
      "../src/services/evidence-review/reviewer-workflow.service.js"
    );

    await upsertEvidenceReviewerWorkflow({
      evidenceId: EVIDENCE_ID,
      workspaceType: "TEAM",
      teamId: "team-1",
      actorUserId: ACTOR_ID,
      status: "IN_REVIEW" as never,
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    const data = updateMock.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("templateSlug");
    expect(data).not.toHaveProperty("templateVersion");
    expect(data).not.toHaveProperty("templateDbId");
  });
});

// ---------------------------------------------------------------------------
// 3. Audit emission.
// ---------------------------------------------------------------------------

describe("Phase T — reviewer_workflow.template_identity.stamped audit", () => {
  it("emits the canonical audit action when a slug is present", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      workspaceType: "TEAM",
      teamId: "team-1",
      status: "NOT_STARTED",
      priority: "NORMAL",
      dueAt: null,
      lastReviewedAt: null,
      closedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      assignedTo: null,
      assignedBy: null,
    });
    createMock.mockResolvedValue({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      status: "NOT_STARTED",
      priority: "NORMAL",
      assignedToUserId: null,
      dueAt: null,
    });

    const { upsertEvidenceReviewerWorkflow } = await import(
      "../src/services/evidence-review/reviewer-workflow.service.js"
    );

    await upsertEvidenceReviewerWorkflow({
      evidenceId: EVIDENCE_ID,
      workspaceType: "TEAM",
      teamId: "team-1",
      actorUserId: ACTOR_ID,
      templateIdentity: POPULATED_TRIO,
      templateIdentitySource: "capture",
    });

    expect(appendPlatformAuditLogMock).toHaveBeenCalledTimes(1);
    const payload = appendPlatformAuditLogMock.mock.calls[0][0];
    expect(payload.action).toBe("reviewer_workflow.template_identity.stamped");
    expect(payload.resourceType).toBe("evidence_review_workflow");
    expect(payload.resourceId).toBe(WORKFLOW_ID);
    expect(payload.metadata).toMatchObject({
      evidenceId: EVIDENCE_ID,
      workflowId: WORKFLOW_ID,
      source: "capture",
      templateSlug: POPULATED_TRIO.templateSlug,
      templateVersion: POPULATED_TRIO.templateVersion,
      templateDbId: POPULATED_TRIO.templateDbId,
    });
    expect(payload.userId).toBe(ACTOR_ID);
  });

  it("does NOT emit when trio is the empty trio (no slug => no audit noise)", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      workspaceType: "PERSONAL",
      teamId: null,
      status: "NOT_STARTED",
      priority: "NORMAL",
      dueAt: null,
      lastReviewedAt: null,
      closedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      assignedTo: null,
      assignedBy: null,
    });
    createMock.mockResolvedValue({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      status: "NOT_STARTED",
      priority: "NORMAL",
      assignedToUserId: null,
      dueAt: null,
    });

    const { upsertEvidenceReviewerWorkflow } = await import(
      "../src/services/evidence-review/reviewer-workflow.service.js"
    );

    await upsertEvidenceReviewerWorkflow({
      evidenceId: EVIDENCE_ID,
      workspaceType: "PERSONAL",
      teamId: null,
      actorUserId: ACTOR_ID,
      templateIdentity: EMPTY_TRIO,
      templateIdentitySource: "capture",
    });

    expect(appendPlatformAuditLogMock).not.toHaveBeenCalled();
  });

  it("does NOT emit when templateIdentity is undefined (legacy caller)", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      workspaceType: "PERSONAL",
      teamId: null,
      status: "NOT_STARTED",
      priority: "NORMAL",
      dueAt: null,
      lastReviewedAt: null,
      closedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      assignedTo: null,
      assignedBy: null,
    });
    createMock.mockResolvedValue({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      status: "NOT_STARTED",
      priority: "NORMAL",
      assignedToUserId: null,
      dueAt: null,
    });

    const { upsertEvidenceReviewerWorkflow } = await import(
      "../src/services/evidence-review/reviewer-workflow.service.js"
    );

    await upsertEvidenceReviewerWorkflow({
      evidenceId: EVIDENCE_ID,
      workspaceType: "PERSONAL",
      teamId: null,
      actorUserId: ACTOR_ID,
    });

    expect(appendPlatformAuditLogMock).not.toHaveBeenCalled();
  });

  it("audit emission failure does NOT break the upsert", async () => {
    appendPlatformAuditLogMock.mockRejectedValue(new Error("BOOM"));
    findUniqueMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      workspaceType: "TEAM",
      teamId: "team-1",
      status: "NOT_STARTED",
      priority: "NORMAL",
      dueAt: null,
      lastReviewedAt: null,
      closedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      assignedTo: null,
      assignedBy: null,
    });
    createMock.mockResolvedValue({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      status: "NOT_STARTED",
      priority: "NORMAL",
      assignedToUserId: null,
      dueAt: null,
    });

    const { upsertEvidenceReviewerWorkflow } = await import(
      "../src/services/evidence-review/reviewer-workflow.service.js"
    );

    // Must NOT throw despite appendPlatformAuditLogMock rejecting.
    await expect(
      upsertEvidenceReviewerWorkflow({
        evidenceId: EVIDENCE_ID,
        workspaceType: "TEAM",
        teamId: "team-1",
        actorUserId: ACTOR_ID,
        templateIdentity: POPULATED_TRIO,
        templateIdentitySource: "capture",
      })
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Audit metadata sanity — confirm the helper produces the wire shape we
// expect the audit consumer to receive.
// ---------------------------------------------------------------------------

describe("Phase T — templateIdentityAuditMetadata shape", () => {
  it("produces a bounded object with no extra keys beyond the documented trio", () => {
    const meta = templateIdentityAuditMetadata({
      evidenceId: EVIDENCE_ID,
      source: "capture",
      trio: POPULATED_TRIO,
    });
    expect(Object.keys(meta).sort()).toEqual(
      ["evidenceId", "source", "templateDbId", "templateSlug", "templateVersion"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 5-6. Source-contract greps — wiring on the canonical call sites.
// ---------------------------------------------------------------------------

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("Phase T — evidence.routes.ts capture-finalize wiring", () => {
  const src = readSource("../src/routes/evidence.routes.ts");

  it("reads the trio off the freshly-completed Evidence row before upsert", () => {
    // The select block at the workflow-init call site must request the
    // three template columns alongside teamId/ownerUserId.
    expect(src).toMatch(
      /select:\s*\{\s*teamId:\s*true,\s*ownerUserId:\s*true,\s*templateSlug:\s*true,\s*templateVersion:\s*true,\s*templateDbId:\s*true/,
    );
  });

  it("passes templateIdentity + templateIdentitySource into upsertEvidenceReviewerWorkflow", () => {
    expect(src).toContain("templateIdentity: workflowTrio");
    expect(src).toMatch(/templateIdentitySource:\s*"capture"/);
  });

  it("wraps the trio read in its own try/catch with a non-fatal warn log", () => {
    expect(src).toContain("reviewer_workflow_trio_read_failed");
  });

  it("keeps the outer capture_finalize_workflow_init_failed log in place", () => {
    expect(src).toContain("capture_finalize_workflow_init_failed");
  });

  it("manual reviewer-workflow PATCH route also threads the trio with source: direct", () => {
    expect(src).toContain("templateIdentity: manualTrio");
    expect(src).toMatch(/templateIdentitySource:\s*"direct"/);
  });
});

// ---------------------------------------------------------------------------
// 7. Hard-rules guard — the reviewer-workflow service only touches identity
// columns and emits via the existing audit helper.
// ---------------------------------------------------------------------------

describe("Phase T — reviewer-workflow.service.ts hard-rules guard", () => {
  const src = readSource(
    "../src/services/evidence-review/reviewer-workflow.service.ts",
  );

  it("imports emitTenantAudit from the canonical tenant-audit facade", () => {
    // PHASE 11 §3 Batch A — migrated off the direct appendPlatformAuditLog
    // call onto the canonical tenant-audit facade, which still writes
    // through appendPlatformAuditLog under the hood (same hash-chained
    // sink) but now records an authoritative workspaceId column.
    expect(src).toContain("emitTenantAudit");
    expect(src).toContain("audit/tenant-audit.service");
  });

  it("imports templateIdentityAuditMetadata + TemplateIdentityTrio from the canonical resolver", () => {
    expect(src).toContain("templateIdentityAuditMetadata");
    expect(src).toContain("TemplateIdentityTrio");
    expect(src).toContain("templates/identity-resolver.service");
  });

  it("uses the canonical action name on the audit emission", () => {
    expect(src).toContain('action: "reviewer_workflow.template_identity.stamped"');
  });

  it("does NOT touch billing / RBAC / governance / webhook surfaces", () => {
    // Identity propagation only.
    expect(src).not.toMatch(/billing-enforcement/);
    expect(src).not.toMatch(/rbac-engine/);
    expect(src).not.toMatch(/governance/);
    expect(src).not.toMatch(/webhook-dispatcher/);
  });

  it("calls audit emission via void + .catch so it cannot break the upsert", () => {
    // Either emitTenantAudit is followed by .catch, or the call is
    // wrapped in void + chained .catch. Both patterns are acceptable.
    expect(src).toMatch(/emitTenantAudit\([\s\S]*?\}\)\.catch/);
  });
});
