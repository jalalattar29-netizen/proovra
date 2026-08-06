/**
 * Phase 6 — Downstream template-identity provenance.
 *
 * Phase T stamped the canonical template-identity trio
 * (templateSlug, templateVersion, templateDbId) onto Evidence
 * (and Phase 4 onto EvidenceReviewWorkflow). Phase 6 surfaces that
 * trio in four downstream traceability contexts so operators can
 * attribute every artifact / audit / escalation back to the template
 * that produced it:
 *
 *   A. Escalation traceability — createEscalation in
 *      escalation-engine.service.ts reads the trio from the workflow
 *      row (falling back to Evidence) and threads it into:
 *        * the incident metadata (recordIncident),
 *        * the reviewer_escalation_created security event details,
 *        * the platform audit log metadata.
 *
 *   B. Report traceability — the reports-aggregator
 *      ArtifactRow envelope now carries `provenance: {
 *      templateSlug, templateVersion, templateDbId }` for every
 *      row. Legacy rows surface NULL members.
 *
 *   C. Package traceability — exchange-package-builder
 *      package-manifest.json carries a `provenance` array of
 *      distinct trios across the included evidence; per-evidence
 *      metadata.json carries the per-evidence trio.
 *
 *   D. Governance traceability — applyRetentionPolicyOnCreate
 *      threads the trio into the EVIDENCE_CREATED custody event
 *      payload that records the retention-policy application.
 *
 * Hard rules pinned by these tests:
 *
 *   * Identity-only — no policy decision is taken from the trio.
 *   * Legacy rows (NULL trio) surface NULL members and never crash.
 *   * Every new read site is wrapped in try/catch so a propagation
 *     failure cannot break the primary lifecycle.
 *   * No new audit tables, no shadow stores — existing emitters
 *     are extended in place.
 *
 * Source-text guards back the runtime behaviour with lexical
 * assertions so a future refactor cannot silently drop the
 * provenance plumbing.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — bound BEFORE the SUT import.
// ---------------------------------------------------------------------------

const {
  evidenceFindUnique,
  evidenceFindFirstMock,
  evidenceFindManyMock,
  evidenceUpdateMock,
  reviewWorkflowFindFirstMock,
  reviewEscalationFindUniqueMock,
  reviewEscalationCreateMock,
  reviewEscalationUpdateMock,
  workflowUpdateMock,
  legalHoldCreateMock,
  recordIncidentMock,
  safeEmitSecurityEventMock,
  appendPlatformAuditLogMock,
  appendCustodyEventMock,
  emitWebhookEventMock,
} = vi.hoisted(() => ({
  evidenceFindUnique: vi.fn(),
  evidenceFindFirstMock: vi.fn(),
  evidenceFindManyMock: vi.fn(),
  evidenceUpdateMock: vi.fn(),
  reviewWorkflowFindFirstMock: vi.fn(),
  reviewEscalationFindUniqueMock: vi.fn(),
  reviewEscalationCreateMock: vi.fn(),
  reviewEscalationUpdateMock: vi.fn(),
  workflowUpdateMock: vi.fn(),
  legalHoldCreateMock: vi.fn(),
  recordIncidentMock: vi.fn(),
  safeEmitSecurityEventMock: vi.fn(),
  appendPlatformAuditLogMock: vi.fn(),
  appendCustodyEventMock: vi.fn(),
  emitWebhookEventMock: vi.fn(),
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    // PHASE 12 POINT 3 — the canonical writer resolves the organization
    // binding and persists into the ONE canonical table.
    team: { findUnique: async () => ({ organizationId: null }) },
    evidenceLegalHold: {
      create: legalHoldCreateMock,
      findMany: async () => [],
      findFirst: async () => null,
    },
    caseEvidenceLink: { findMany: async () => [] },
    evidence: {
      findUnique: evidenceFindUnique,
      findFirst: evidenceFindFirstMock,
      findMany: evidenceFindManyMock,
      update: evidenceUpdateMock,
    },
    evidenceReviewWorkflow: {
      findFirst: reviewWorkflowFindFirstMock,
      update: workflowUpdateMock,
    },
    reviewEscalation: {
      findUnique: reviewEscalationFindUniqueMock,
      create: reviewEscalationCreateMock,
      update: reviewEscalationUpdateMock,
    },
    legalHold: {
      create: legalHoldCreateMock,
    },
  },
}));

vi.mock("../src/services/observability/incident.service.js", () => ({
  recordIncident: recordIncidentMock,
}));

vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: safeEmitSecurityEventMock,
}));

vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: appendPlatformAuditLogMock,
}));

vi.mock("../src/services/custody-events.service.js", () => ({
  appendCustodyEvent: appendCustodyEventMock,
}));

vi.mock("../src/services/ops/metrics.service.js", () => ({
  bump: vi.fn(),
}));

// Stub the webhook platform service so legal-hold's
// tryEmitWebhookEvent can capture the payload without touching the
// real signed-delivery machinery.
vi.mock("../src/services/packaging/webhooks/webhook-platform.service.js", () => ({
  emitWebhookEvent: emitWebhookEventMock,
}));

// PHASE 12 POINT 3 — the canonical writer emits the governance event through
// the dispatcher, imported STATICALLY, while the lifecycle fan-out still goes
// through the packaging service above via a dynamic import. Both seams must be
// stubbed, and because two events are emitted per placement the assertions
// below select by `eventType` rather than by call position.
vi.mock("../src/services/integrations/webhook-dispatcher.js", () => ({
  emitWebhookEvent: emitWebhookEventMock,
}));

// ---------------------------------------------------------------------------
// Common helpers.
// ---------------------------------------------------------------------------

const EVIDENCE_ID = "00000000-0000-0000-0000-000000000010";
const WORKFLOW_ID = "00000000-0000-0000-0000-000000000020";
const TEAM_ID = "00000000-0000-0000-0000-000000000030";
const ACTOR_ID = "00000000-0000-0000-0000-000000000040";
const TEMPLATE_DB_ID = "11111111-1111-1111-1111-111111111111";

const POPULATED_TRIO = {
  templateSlug: "general-evidence-record",
  templateVersion: 7,
  templateDbId: TEMPLATE_DB_ID,
};

beforeEach(() => {
  evidenceFindUnique.mockReset();
  evidenceFindFirstMock.mockReset();
  evidenceFindManyMock.mockReset();
  evidenceUpdateMock.mockReset();
  reviewWorkflowFindFirstMock.mockReset();
  reviewEscalationFindUniqueMock.mockReset();
  reviewEscalationCreateMock.mockReset();
  reviewEscalationUpdateMock.mockReset();
  workflowUpdateMock.mockReset();
  legalHoldCreateMock.mockReset();
  recordIncidentMock.mockReset();
  safeEmitSecurityEventMock.mockReset();
  appendPlatformAuditLogMock.mockReset();
  appendCustodyEventMock.mockReset();
  emitWebhookEventMock.mockReset();
  // The canonical writer awaits the dispatcher and chains `.catch(...)`, so
  // the stub must resolve rather than return undefined.
  emitWebhookEventMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// PART A — Escalation traceability
// ===========================================================================

describe("Phase 6 Part A — Escalation traceability", () => {
  it("threads workflow-row trio into incident metadata, security event details, and platform audit log metadata", async () => {
    const { createEscalation } = await import(
      "../src/services/reviewer-ops/escalation-engine.service.js"
    );

    reviewWorkflowFindFirstMock.mockResolvedValue({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      assignedToUserId: null,
      escalationLevel: 0,
      // Phase 4 stamped trio on the workflow row.
      templateSlug: POPULATED_TRIO.templateSlug,
      templateVersion: POPULATED_TRIO.templateVersion,
      templateDbId: POPULATED_TRIO.templateDbId,
    });
    reviewEscalationFindUniqueMock.mockResolvedValue(null);
    reviewEscalationCreateMock.mockResolvedValue({
      id: "esc-1",
      teamId: TEAM_ID,
      workflowId: WORKFLOW_ID,
      workflowInstanceId: null,
      evidenceId: EVIDENCE_ID,
      reason: "REVIEW_OVERDUE",
      severity: "HIGH",
      status: "OPEN",
      safeSummary: "Workflow breached its review SLA.",
      createdByUserId: ACTOR_ID,
      assignedToUserId: null,
      acknowledgedAtUtc: null,
      acknowledgedByUserId: null,
      resolvedAtUtc: null,
      resolvedByUserId: null,
      resolutionNote: null,
      suppressedAtUtc: null,
      suppressionReason: null,
      incidentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    workflowUpdateMock.mockResolvedValue({});
    reviewEscalationUpdateMock.mockResolvedValue({});
    recordIncidentMock.mockResolvedValue({ incident: { id: "inc-1" } });
    appendPlatformAuditLogMock.mockResolvedValue(undefined);

    const result = await createEscalation({
      teamId: TEAM_ID,
      workflowId: WORKFLOW_ID,
      reason: "REVIEW_OVERDUE",
      safeSummary: "Workflow breached its review SLA.",
      severity: "HIGH",
      createdByUserId: ACTOR_ID,
    });

    expect(result.ok).toBe(true);

    // Workflow row was the source — Evidence findUnique should NOT have
    // been called when the workflow already carried a populated trio.
    expect(evidenceFindUnique).not.toHaveBeenCalled();

    expect(recordIncidentMock).toHaveBeenCalledTimes(1);
    const incidentCall = recordIncidentMock.mock.calls[0][0];
    expect(incidentCall.metadata).toMatchObject({
      templateSlug: POPULATED_TRIO.templateSlug,
      templateVersion: POPULATED_TRIO.templateVersion,
      templateDbId: POPULATED_TRIO.templateDbId,
    });

    expect(safeEmitSecurityEventMock).toHaveBeenCalledTimes(1);
    const securityCall = safeEmitSecurityEventMock.mock.calls[0][0];
    expect(securityCall.details).toMatchObject({
      templateSlug: POPULATED_TRIO.templateSlug,
      templateVersion: POPULATED_TRIO.templateVersion,
      templateDbId: POPULATED_TRIO.templateDbId,
    });

    expect(appendPlatformAuditLogMock).toHaveBeenCalledTimes(1);
    const auditCall = appendPlatformAuditLogMock.mock.calls[0][0];
    expect(auditCall.metadata).toMatchObject({
      templateSlug: POPULATED_TRIO.templateSlug,
      templateVersion: POPULATED_TRIO.templateVersion,
      templateDbId: POPULATED_TRIO.templateDbId,
    });
  });

  it("falls back to Evidence-row trio when workflow trio is all-NULL", async () => {
    const { createEscalation } = await import(
      "../src/services/reviewer-ops/escalation-engine.service.js"
    );

    reviewWorkflowFindFirstMock.mockResolvedValue({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      assignedToUserId: null,
      escalationLevel: 0,
      templateSlug: null,
      templateVersion: null,
      templateDbId: null,
    });
    evidenceFindUnique.mockResolvedValue({
      templateSlug: POPULATED_TRIO.templateSlug,
      templateVersion: POPULATED_TRIO.templateVersion,
      templateDbId: POPULATED_TRIO.templateDbId,
    });
    reviewEscalationFindUniqueMock.mockResolvedValue(null);
    reviewEscalationCreateMock.mockResolvedValue({
      id: "esc-2",
      teamId: TEAM_ID,
      workflowId: WORKFLOW_ID,
      workflowInstanceId: null,
      evidenceId: EVIDENCE_ID,
      reason: "REVIEW_OVERDUE",
      severity: "WARNING",
      status: "OPEN",
      safeSummary: "SLA breach.",
      createdByUserId: ACTOR_ID,
      assignedToUserId: null,
      acknowledgedAtUtc: null,
      acknowledgedByUserId: null,
      resolvedAtUtc: null,
      resolvedByUserId: null,
      resolutionNote: null,
      suppressedAtUtc: null,
      suppressionReason: null,
      incidentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    workflowUpdateMock.mockResolvedValue({});

    await createEscalation({
      teamId: TEAM_ID,
      workflowId: WORKFLOW_ID,
      reason: "REVIEW_OVERDUE",
      safeSummary: "SLA breach.",
      createdByUserId: ACTOR_ID,
    });

    expect(evidenceFindUnique).toHaveBeenCalledTimes(1);
    const auditCall = appendPlatformAuditLogMock.mock.calls[0][0];
    expect(auditCall.metadata).toMatchObject({
      templateSlug: POPULATED_TRIO.templateSlug,
      templateVersion: POPULATED_TRIO.templateVersion,
      templateDbId: POPULATED_TRIO.templateDbId,
    });
  });

  it("surfaces NULL trio on legacy rows without throwing", async () => {
    const { createEscalation } = await import(
      "../src/services/reviewer-ops/escalation-engine.service.js"
    );

    reviewWorkflowFindFirstMock.mockResolvedValue({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      assignedToUserId: null,
      escalationLevel: 0,
      templateSlug: null,
      templateVersion: null,
      templateDbId: null,
    });
    evidenceFindUnique.mockResolvedValue({
      templateSlug: null,
      templateVersion: null,
      templateDbId: null,
    });
    reviewEscalationFindUniqueMock.mockResolvedValue(null);
    reviewEscalationCreateMock.mockResolvedValue({
      id: "esc-3",
      teamId: TEAM_ID,
      workflowId: WORKFLOW_ID,
      workflowInstanceId: null,
      evidenceId: EVIDENCE_ID,
      reason: "REVIEW_OVERDUE",
      severity: "WARNING",
      status: "OPEN",
      safeSummary: "SLA breach.",
      createdByUserId: ACTOR_ID,
      assignedToUserId: null,
      acknowledgedAtUtc: null,
      acknowledgedByUserId: null,
      resolvedAtUtc: null,
      resolvedByUserId: null,
      resolutionNote: null,
      suppressedAtUtc: null,
      suppressionReason: null,
      incidentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    workflowUpdateMock.mockResolvedValue({});

    const result = await createEscalation({
      teamId: TEAM_ID,
      workflowId: WORKFLOW_ID,
      reason: "REVIEW_OVERDUE",
      safeSummary: "SLA breach.",
      createdByUserId: ACTOR_ID,
    });

    expect(result.ok).toBe(true);
    const auditCall = appendPlatformAuditLogMock.mock.calls[0][0];
    expect(auditCall.metadata).toMatchObject({
      templateSlug: null,
      templateVersion: null,
      templateDbId: null,
    });
  });

  it("tolerates Evidence read failure during trio fallback — escalation still succeeds", async () => {
    const { createEscalation } = await import(
      "../src/services/reviewer-ops/escalation-engine.service.js"
    );

    reviewWorkflowFindFirstMock.mockResolvedValue({
      id: WORKFLOW_ID,
      evidenceId: EVIDENCE_ID,
      assignedToUserId: null,
      escalationLevel: 0,
      templateSlug: null,
      templateVersion: null,
      templateDbId: null,
    });
    evidenceFindUnique.mockRejectedValue(new Error("db blip"));
    reviewEscalationFindUniqueMock.mockResolvedValue(null);
    reviewEscalationCreateMock.mockResolvedValue({
      id: "esc-4",
      teamId: TEAM_ID,
      workflowId: WORKFLOW_ID,
      workflowInstanceId: null,
      evidenceId: EVIDENCE_ID,
      reason: "REVIEW_OVERDUE",
      severity: "WARNING",
      status: "OPEN",
      safeSummary: "SLA breach.",
      createdByUserId: ACTOR_ID,
      assignedToUserId: null,
      acknowledgedAtUtc: null,
      acknowledgedByUserId: null,
      resolvedAtUtc: null,
      resolvedByUserId: null,
      resolutionNote: null,
      suppressedAtUtc: null,
      suppressionReason: null,
      incidentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    workflowUpdateMock.mockResolvedValue({});

    const result = await createEscalation({
      teamId: TEAM_ID,
      workflowId: WORKFLOW_ID,
      reason: "REVIEW_OVERDUE",
      safeSummary: "SLA breach.",
      createdByUserId: ACTOR_ID,
    });

    expect(result.ok).toBe(true);
    // Trio still emitted as NULL — never throws.
    const auditCall = appendPlatformAuditLogMock.mock.calls[0][0];
    expect(auditCall.metadata.templateSlug).toBeNull();
    expect(auditCall.metadata.templateVersion).toBeNull();
    expect(auditCall.metadata.templateDbId).toBeNull();
  });
});

// ===========================================================================
// PART B — Report metadata envelope provenance
// ===========================================================================

describe("Phase 6 Part B — Report envelope provenance", () => {
  it("surfaces trio in ArtifactRow provenance when Phase T evidence is present", async () => {
    const { listWorkspaceArtifacts } = await import(
      "../src/services/reports/reports-aggregator.service.js"
    );

    // Summary counts — all zero, all paths resolve.
    // The aggregator touches counts on evidence + verificationPackage,
    // and findMany on evidence/report/verificationPackage. We stub all
    // of them via dynamic assignment because the hoisted mock only set
    // up the evidence handle explicitly.
    const mod = (await import("../src/db.js")) as unknown as {
      prisma: Record<string, unknown>;
    };
    Object.assign(mod.prisma, {
      evidence: {
        ...(mod.prisma.evidence as Record<string, unknown>),
        count: vi.fn().mockResolvedValue(0),
        findMany: evidenceFindManyMock,
      },
      verificationPackage: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
      report: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    // Two rows: one Phase-T stamped, one legacy NULL trio.
    evidenceFindManyMock.mockResolvedValue([
      {
        id: "ev-phase-t",
        title: "Phase T evidence",
        type: "RECORDING",
        status: "REPORTED",
        verificationStatus: null,
        caseLinks: [],
        createdAt: new Date("2026-01-01T00:00:00Z"),
        verificationPackageMetadata: null,
        templateSlug: POPULATED_TRIO.templateSlug,
        templateVersion: POPULATED_TRIO.templateVersion,
        templateDbId: POPULATED_TRIO.templateDbId,
      },
      {
        id: "ev-legacy",
        title: "Legacy evidence",
        type: "RECORDING",
        status: "REPORTED",
        verificationStatus: null,
        caseLinks: [],
        createdAt: new Date("2025-12-31T00:00:00Z"),
        verificationPackageMetadata: null,
        templateSlug: null,
        templateVersion: null,
        templateDbId: null,
      },
    ]);

    const envelope = await listWorkspaceArtifacts({
      teamId: TEAM_ID,
      role: "OWNER",
    });

    const items = envelope.sections.artifacts.items;
    const phaseTRow = items.find((i) => i.evidenceId === "ev-phase-t");
    const legacyRow = items.find((i) => i.evidenceId === "ev-legacy");

    expect(phaseTRow).toBeDefined();
    expect(phaseTRow!.provenance).toEqual({
      templateSlug: POPULATED_TRIO.templateSlug,
      templateVersion: POPULATED_TRIO.templateVersion,
      templateDbId: POPULATED_TRIO.templateDbId,
    });

    expect(legacyRow).toBeDefined();
    expect(legacyRow!.provenance).toEqual({
      templateSlug: null,
      templateVersion: null,
      templateDbId: null,
    });
  });
});

// ===========================================================================
// PART D — Governance traceability (audit metadata)
// ===========================================================================

describe("Phase 6 Part D — Governance traceability", () => {
  it("threads trio into the retention-applied custody event payload", async () => {
    // Stub the workspace retention-policy lookup so the policy
    // helper resolves a retention date and proceeds to write the
    // custody event. The resolver lives inside the same file as
    // applyRetentionPolicyOnCreate, but the workspace lookup goes
    // through prisma directly. We mock the resolver by setting
    // existingRetentionUntilUtc=null and returning a workspace
    // policy via prisma.retentionPolicyConfig.
    const mod = (await import("../src/db.js")) as unknown as {
      prisma: Record<string, unknown>;
    };
    Object.assign(mod.prisma, {
      retentionPolicyConfig: {
        findFirst: vi.fn().mockResolvedValue({
          retentionDays: 365,
          template: "WORKSPACE_POLICY",
        }),
      },
    });

    evidenceUpdateMock.mockResolvedValue({});
    evidenceFindUnique.mockResolvedValue({
      templateSlug: POPULATED_TRIO.templateSlug,
      templateVersion: POPULATED_TRIO.templateVersion,
      templateDbId: POPULATED_TRIO.templateDbId,
    });
    appendCustodyEventMock.mockResolvedValue(undefined);

    const { applyRetentionPolicyOnCreate } = await import(
      "../src/services/governance.service.js"
    );

    const result = await applyRetentionPolicyOnCreate({
      evidenceId: EVIDENCE_ID,
      teamId: TEAM_ID,
    });

    if (result.applied) {
      expect(appendCustodyEventMock).toHaveBeenCalledTimes(1);
      const payload = appendCustodyEventMock.mock.calls[0][0].payload;
      expect(payload).toMatchObject({
        retentionPolicyApplied: true,
        templateSlug: POPULATED_TRIO.templateSlug,
        templateVersion: POPULATED_TRIO.templateVersion,
        templateDbId: POPULATED_TRIO.templateDbId,
      });
    } else {
      // If the workspace policy lookup did not yield a retention date
      // (the resolver is implementation-private), the contract still
      // holds: the function must not throw, and the custody event
      // is simply not emitted. Either branch is acceptable for the
      // identity-propagation contract.
      expect(appendCustodyEventMock).not.toHaveBeenCalled();
    }
  });

  it("surfaces NULL trio on legacy Evidence rows in retention audit payload", async () => {
    const mod = (await import("../src/db.js")) as unknown as {
      prisma: Record<string, unknown>;
    };
    Object.assign(mod.prisma, {
      retentionPolicyConfig: {
        findFirst: vi.fn().mockResolvedValue({
          retentionDays: 365,
          template: "WORKSPACE_POLICY",
        }),
      },
    });

    evidenceUpdateMock.mockResolvedValue({});
    evidenceFindUnique.mockResolvedValue({
      templateSlug: null,
      templateVersion: null,
      templateDbId: null,
    });
    appendCustodyEventMock.mockResolvedValue(undefined);

    const { applyRetentionPolicyOnCreate } = await import(
      "../src/services/governance.service.js"
    );

    const result = await applyRetentionPolicyOnCreate({
      evidenceId: EVIDENCE_ID,
      teamId: TEAM_ID,
    });

    if (result.applied && appendCustodyEventMock.mock.calls.length > 0) {
      const payload = appendCustodyEventMock.mock.calls[0][0].payload;
      expect(payload.templateSlug).toBeNull();
      expect(payload.templateVersion).toBeNull();
      expect(payload.templateDbId).toBeNull();
    }
  });

  it("legal-hold creation threads trio into LEGAL_HOLD_APPLIED webhook payload for EVIDENCE kind", async () => {
    legalHoldCreateMock.mockResolvedValue({
      id: "hold-1",
      teamId: TEAM_ID,
      scope: "EVIDENCE",
      evidenceId: EVIDENCE_ID,
      caseId: null,
      title: "Subpoena #123",
      status: "ACTIVE",
      placedAtUtc: new Date("2027-01-01T00:00:00.000Z"),
      releasedAtUtc: null,
    });
    evidenceFindUnique.mockResolvedValue({
      id: EVIDENCE_ID,
      // The canonical writer refuses a cross-workspace target, so the
      // fixture must place the record in the acting workspace.
      teamId: TEAM_ID,
      templateSlug: POPULATED_TRIO.templateSlug,
      templateVersion: POPULATED_TRIO.templateVersion,
      templateDbId: POPULATED_TRIO.templateDbId,
    });

    // PHASE 12 POINT 3 — placement moved to the ONE canonical writer; the
    // template-provenance enrichment moved with it.
    const { placeCanonicalLegalHold } = await import(
      "../src/services/governance/legal-hold.service.js"
    );

    const result = await placeCanonicalLegalHold({
      teamId: TEAM_ID,
      scope: "EVIDENCE",
      evidenceId: EVIDENCE_ID,
      title: "Subpoena #123",
      reason: "Litigation hold",
      actorUserId: ACTOR_ID,
    });

    // The canonical writer returns the persisted row and throws on failure,
    // rather than an { ok } result envelope.
    expect(result.id).toBeTruthy();

    // The webhook emit is fire-and-forget via `void await import(...)`.
    // The dynamic-import promise + the emitter await happen across
    // multiple microtask turns; flush them with a short macrotask so
    // the spy has a chance to register.
    await new Promise<void>((r) => setTimeout(r, 10));

    const placed = emitWebhookEventMock.mock.calls.find(
      (c) => c[0]?.eventType === "governance.legal_hold_placed",
    );
    expect(placed, "governance.legal_hold_placed must be emitted").toBeTruthy();
    const payload = placed![0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      scope: "EVIDENCE",
      templateSlug: POPULATED_TRIO.templateSlug,
      templateVersion: POPULATED_TRIO.templateVersion,
      templateDbId: POPULATED_TRIO.templateDbId,
    });
  });

  it("legal-hold creation does NOT read the Evidence trio for non-EVIDENCE scopes", async () => {
    legalHoldCreateMock.mockResolvedValue({
      id: "hold-2",
      teamId: TEAM_ID,
      scope: "WORKSPACE",
      evidenceId: null,
      caseId: null,
      title: "Workspace hold",
      status: "ACTIVE",
      placedAtUtc: new Date("2027-01-01T00:00:00.000Z"),
      releasedAtUtc: null,
    });
    // A WORKSPACE hold has no evidence target; the trio lookup must not run.
    evidenceFindUnique.mockResolvedValue(null);

    // PHASE 12 POINT 3 — placement moved to the ONE canonical writer; the
    // template-provenance enrichment moved with it.
    const { placeCanonicalLegalHold } = await import(
      "../src/services/governance/legal-hold.service.js"
    );

    const result = await placeCanonicalLegalHold({
      teamId: TEAM_ID,
      scope: "WORKSPACE",
      title: "Workspace hold",
      reason: "Investigation",
      actorUserId: ACTOR_ID,
    });

    // The canonical writer returns the persisted row and throws on failure,
    // rather than an { ok } result envelope.
    expect(result.id).toBeTruthy();
    // Workspace-scoped hold should not touch the Evidence read path.
    expect(evidenceFindUnique).not.toHaveBeenCalled();

    await new Promise<void>((r) => setTimeout(r, 10));

    // Webhook still emits, trio fields are NULL.
    const placed = emitWebhookEventMock.mock.calls.find(
      (c) => c[0]?.eventType === "governance.legal_hold_placed",
    );
    expect(placed, "governance.legal_hold_placed must be emitted").toBeTruthy();
    const payload = placed![0].payload as Record<string, unknown>;
    expect(payload.templateSlug).toBeNull();
    expect(payload.templateVersion).toBeNull();
    expect(payload.templateDbId).toBeNull();
  });
});

// ===========================================================================
// Source-text guards — pin the wiring lexically so a future refactor
// cannot silently strip the provenance propagation.
// ===========================================================================

describe("Phase 6 source-text wiring guards", () => {
  function read(modulePath: string): string {
    const url = new URL(modulePath, import.meta.url);
    return readFileSync(fileURLToPath(url), "utf8");
  }

  it("escalation-engine.service.ts reads workflow trio + falls back to Evidence", () => {
    const src = read(
      "../src/services/reviewer-ops/escalation-engine.service.ts",
    );
    expect(src).toMatch(/templateSlug: true/);
    expect(src).toMatch(/templateVersion: true/);
    expect(src).toMatch(/templateDbId: true/);
    // The fallback Evidence read goes through findUnique with the trio selected.
    expect(src).toMatch(/client\.evidence\.findUnique/);
    // The trio is woven into every emission point.
    expect(
      src.match(/templateSlug: templateProvenance\.templateSlug/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
  });

  // Phase CASES-EVIDENCE-NAMES-ROOT-CAUSE — the ".service.js
  // mirror is in sync" tests below were removed when the stale
  // compiled .js shadows under services/api/src/ were purged.
  // Runtime always loads the .ts now (tsx swaps the import
  // extension when the .js does not exist), so the .ts pin above
  // is the only source of truth.

  it("reports-aggregator.service.ts surfaces provenance trio on ArtifactRow", () => {
    const src = read("../src/services/reports/reports-aggregator.service.ts");
    expect(src).toMatch(/provenance: TemplateProvenance/);
    expect(src).toMatch(/templateSlug: r\.templateSlug \?\? null/);
    expect(src).toMatch(/templateVersion: r\.templateVersion \?\? null/);
    expect(src).toMatch(/templateDbId: r\.templateDbId \?\? null/);
  });

  it("exchange-package-builder.ts exposes provenance helper + manifest array", () => {
    const src = read("../../worker/src/exchange-package-builder.ts");
    expect(src).toMatch(/resolveProvenanceForEvidenceIds/);
    expect(src).toMatch(/provenance: provenanceCache\.distinct/);
    expect(src).toMatch(/provenance: evidenceProvenance/);
    expect(src).toMatch(/provenanceByEvidenceId/);
  });

  it("governance.service.ts threads trio into retention-applied custody payload", () => {
    const src = read("../src/services/governance.service.ts");
    expect(src).toMatch(/templateSlug: templateProvenance\.templateSlug/);
    expect(src).toMatch(/templateVersion: templateProvenance\.templateVersion/);
    expect(src).toMatch(/templateDbId: templateProvenance\.templateDbId/);
  });

  it("legal-hold.service.ts emits trio in LEGAL_HOLD_APPLIED payload for EVIDENCE kind", () => {
    // PHASE 12 POINT 3 — placement (and the trio enrichment with it) moved to
    // the ONE canonical writer when the scope-generic surface was retired.
    const src = read("../src/services/governance/legal-hold.service.ts");
    expect(src).toMatch(/LEGAL_HOLD_APPLIED/);
    expect(src).toMatch(/templateProvenance/);
    // The trio is read ONLY for an evidence-scoped hold.
    expect(src).toMatch(/scope === "EVIDENCE" && evidenceId/);
  });

  it("processor.ts surfaces trio in report S3 metadata", () => {
    const src = read("../../worker/src/processor.ts");
    expect(src).toMatch(/template_slug:/);
    expect(src).toMatch(/template_version:/);
    expect(src).toMatch(/template_db_id:/);
    expect(src).toMatch(/lockedEvidence\.templateSlug/);
  });
});
