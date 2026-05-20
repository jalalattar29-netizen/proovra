/**
 * Phase 25 — Reviewer Operations Intelligence + Search Worker Rebuild.
 *
 * Two-part coverage:
 *
 *   1. Search worker rebuild completion — API and worker import the
 *      same canonical projection engine from `@proovra/shared`; both
 *      handle the documented job kinds; the worker upserts the same
 *      document shape the API does; lag-pointers unwind only on a
 *      successful rebuild; deleted/destroyed evidence is removed
 *      from the index.
 *
 *   2. Reviewer Operations Intelligence — pure priority scoring,
 *      stuck-workflow detection, bounded reason catalogs, governance-
 *      first precedence, metric registration.
 *
 * Mix of pure-function behavioural tests (priority + stuck detector)
 * and source-contract assertions (worker / API wiring + privacy).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildEvidenceProjection,
  buildWorkflowInstanceProjection,
  computeReviewerPriority,
  detectStuckWorkflow,
  PRIORITY_REASON_CODES,
  sanitiseSearchBody,
  sanitiseSearchString,
  sanitiseSearchTags,
  STUCK_REASON_CODES,
  summarisePriorityReasons,
  type PriorityFacts,
  type SearchDocumentProjection,
  type StuckWorkflowFacts,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — Shared projection engine
// =============================================================================

describe("Phase 25 — shared search projection engine", () => {
  const sourceSrc = readSource(
    "../../../packages/shared/src/search-projection.ts",
  );

  it("is pure (no Prisma / Node / Fastify imports)", () => {
    expect(sourceSrc).not.toMatch(/from\s+"@prisma\/client"/);
    expect(sourceSrc).not.toMatch(/from\s+"fastify"/);
    expect(sourceSrc).not.toMatch(/import.*node:/);
  });

  it("documents the privacy invariants in the file header", () => {
    expect(sourceSrc).toMatch(/privateReviewerNote/);
    expect(sourceSrc).toMatch(/legal-note bodies/);
    expect(sourceSrc).toMatch(/storage keys/);
    expect(sourceSrc).toMatch(/signed URLs/);
    expect(sourceSrc).toMatch(/raw GPS/);
  });

  it("the API indexer + worker BOTH import from @proovra/shared", () => {
    const apiSrc = readSource(
      "../../../services/api/src/services/search/evidence-indexing.service.ts",
    );
    const workerSrc = readSource(
      "../../../services/worker/src/search-indexing.processor.ts",
    );
    // The import block may span multiple lines with several
    // co-imported types — widen the gap allowance accordingly.
    expect(apiSrc).toMatch(
      /buildEvidenceProjection[\s\S]{0,600}from\s+"@proovra\/shared"/,
    );
    expect(workerSrc).toMatch(
      /buildEvidenceProjection[\s\S]{0,600}from\s+"@proovra\/shared"/,
    );
  });

  it("sanitiseSearchString strips overclaim phrases + control chars + trims to max", () => {
    expect(sanitiseSearchString("legally admissible record", 200)).toBe(
      "[redacted-overclaim] record",
    );
    // Control chars collapsed.
    expect(sanitiseSearchString("a\x07b\x1Fc", 200)).toBe("a b c");
    // Truncated with ellipsis.
    const long = "x".repeat(250);
    const out = sanitiseSearchString(long, 50);
    expect(out).not.toBeNull();
    expect((out ?? "").length).toBeLessThanOrEqual(50);
    expect(out).toMatch(/…$/);
    // Empty / null inputs collapse to null.
    expect(sanitiseSearchString(null, 200)).toBeNull();
    expect(sanitiseSearchString("   ", 200)).toBeNull();
  });

  it("sanitiseSearchBody bounds to 16 KiB", () => {
    const huge = "a".repeat(50_000);
    const out = sanitiseSearchBody(huge);
    expect(out).not.toBeNull();
    expect((out ?? "").length).toBeLessThanOrEqual(16 * 1024);
  });

  it("sanitiseSearchTags caps to SEARCH_TAG_MAX_COUNT + drops empty/non-string", () => {
    const tags = Array(50).fill("tag");
    const out = sanitiseSearchTags([...tags, null, undefined, "  ", "x"]);
    expect(out.length).toBeLessThanOrEqual(32);
    expect(out.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
  });

  it("buildEvidenceProjection returns ok with the canonical projection for a healthy ACTIVE record", () => {
    const result = buildEvidenceProjection({
      teamId: "11111111-1111-1111-1111-111111111111",
      evidenceId: "22222222-2222-2222-2222-222222222222",
      evidence: {
        id: "22222222-2222-2222-2222-222222222222",
        teamId: "11111111-1111-1111-1111-111111111111",
        title: "Vehicle accident scene photo",
        displayFileName: "scene.jpg",
        originalFileName: "IMG_0001.JPG",
        type: "PHOTO",
        mimeType: "image/jpeg",
        captureMethod: "MOBILE_CAPTURE",
        caseId: null,
        deletedAt: null,
        lifecycleState: "ACTIVE",
        archivedAt: null,
        publicVerifyState: "PUBLISHED",
        storageObjectLockLegalHoldStatus: null,
        retentionPolicySource: "WORKSPACE_POLICY",
        retentionUntilUtc: null,
        reviewReadyAtUtc: new Date("2026-05-01T00:00:00Z"),
        updatedAt: new Date("2026-05-19T12:00:00Z"),
      },
      workflowState: "IN_REVIEW",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p: SearchDocumentProjection = result.projection;
    expect(p.documentType).toBe("EVIDENCE");
    expect(p.title).toBe("Vehicle accident scene photo");
    expect(p.exportState).toBe("PUBLIC");
    expect(p.workflowState).toBe("IN_REVIEW");
    expect(p.reviewState).toBe("REVIEW_READY");
    expect(p.contributorScoped).toBe(false);
    expect(p.reviewerRestricted).toBe(false);
    expect(p.searchableTags).toContain("PHOTO");
    expect(p.searchableTags).toContain("PUBLISHED");
  });

  it("buildEvidenceProjection refuses team-mismatched records (anti-enumeration)", () => {
    const r = buildEvidenceProjection({
      teamId: "11111111-1111-1111-1111-111111111111",
      evidenceId: "22222222-2222-2222-2222-222222222222",
      evidence: {
        id: "22222222-2222-2222-2222-222222222222",
        teamId: "99999999-9999-9999-9999-999999999999",
        title: "x",
        displayFileName: null,
        originalFileName: null,
        type: null,
        mimeType: null,
        captureMethod: null,
        caseId: null,
        deletedAt: null,
        lifecycleState: "ACTIVE",
        archivedAt: null,
        publicVerifyState: null,
        storageObjectLockLegalHoldStatus: null,
        retentionPolicySource: null,
        retentionUntilUtc: null,
        reviewReadyAtUtc: null,
        updatedAt: new Date(),
      },
      workflowState: null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("team_mismatch");
    expect(r.deleteFromIndex).toBe(false);
  });

  it("buildEvidenceProjection asks for delete-from-index when the row is deleted / DESTROYED / PENDING_DESTRUCTION", () => {
    const base = {
      id: "22222222-2222-2222-2222-222222222222",
      teamId: "11111111-1111-1111-1111-111111111111",
      title: "x",
      displayFileName: null,
      originalFileName: null,
      type: null,
      mimeType: null,
      captureMethod: null,
      caseId: null,
      lifecycleState: "ACTIVE",
      archivedAt: null,
      publicVerifyState: null,
      storageObjectLockLegalHoldStatus: null,
      retentionPolicySource: null,
      retentionUntilUtc: null,
      reviewReadyAtUtc: null,
      updatedAt: new Date(),
    };
    for (const variant of [
      { ...base, deletedAt: new Date(), expectedReason: "deleted" as const },
      {
        ...base,
        deletedAt: null,
        lifecycleState: "DESTROYED",
        expectedReason: "lifecycle_destroyed" as const,
      },
      {
        ...base,
        deletedAt: null,
        lifecycleState: "PENDING_DESTRUCTION",
        expectedReason: "lifecycle_pending_destruction" as const,
      },
    ]) {
      const { expectedReason, ...evidence } = variant;
      const r = buildEvidenceProjection({
        teamId: "11111111-1111-1111-1111-111111111111",
        evidenceId: "22222222-2222-2222-2222-222222222222",
        evidence: { ...evidence, deletedAt: evidence.deletedAt ?? null },
        workflowState: null,
      });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe(expectedReason);
      expect(r.deleteFromIndex).toBe(true);
    }
  });

  it("buildWorkflowInstanceProjection sets contributorScoped for EXTERNAL_CONTRIBUTOR / ANONYMOUS_SOURCE", () => {
    for (const role of ["EXTERNAL_CONTRIBUTOR", "ANONYMOUS_SOURCE"]) {
      const r = buildWorkflowInstanceProjection({
        teamId: "11111111-1111-1111-1111-111111111111",
        workflowInstanceId: "33333333-3333-3333-3333-333333333333",
        instance: {
          id: "33333333-3333-3333-3333-333333333333",
          teamId: "11111111-1111-1111-1111-111111111111",
          title: "Intake form",
          templateSlug: "external-intake",
          templateVersion: 1,
          intakeMode: "EXTERNAL",
          actorRole: role,
          status: "SUBMITTED",
          caseId: null,
          claimRef: null,
          matterRef: null,
          assignedReviewerUserId: null,
          updatedAt: new Date(),
        },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.projection.contributorScoped).toBe(true);
    }
  });
});

// =============================================================================
// PART 2 — Worker source-contract wiring
// =============================================================================

describe("Phase 25 — search worker rebuild source contract", () => {
  const workerSrc = readSource(
    "../../../services/worker/src/search-indexing.processor.ts",
  );

  it("handles every Phase 25 document kind", () => {
    for (const kind of [
      '"evidence"',
      '"workflow_instance"',
      '"workflow_step"',
      '"ocr_text"',
      '"transcript"',
      '"relationship"',
    ]) {
      expect(workerSrc, `kind ${kind} not handled`).toContain(kind);
    }
  });

  it("delegates projection to @proovra/shared (no duplicated logic)", () => {
    // The worker MUST NOT redefine its own buildEvidenceProjection /
    // buildWorkflowInstanceProjection. It only imports them.
    const importMatch = workerSrc.match(
      /import\s*\{([\s\S]*?)\}\s*from\s+"@proovra\/shared"/,
    );
    expect(importMatch).not.toBeNull();
    const importList = importMatch?.[1] ?? "";
    expect(importList).toContain("buildEvidenceProjection");
    expect(importList).toContain("buildWorkflowInstanceProjection");
    // No local redefinition.
    expect(workerSrc).not.toMatch(
      /function buildEvidenceProjection\(/,
    );
    expect(workerSrc).not.toMatch(
      /function buildWorkflowInstanceProjection\(/,
    );
  });

  it("upserts via prisma.evidenceSearchDocument.upsert (the canonical persistence path)", () => {
    expect(workerSrc).toMatch(/prisma\.evidenceSearchDocument\.upsert/);
  });

  it("removes the row when the shared builder asks for delete-from-index", () => {
    expect(workerSrc).toMatch(/prisma\.evidenceSearchDocument\.deleteMany/);
    expect(workerSrc).toMatch(/outcome\.kind === "delete"/);
  });

  it("only unwinds OCR + transcript indexing-lag pointers AFTER a successful upsert", () => {
    expect(workerSrc).toMatch(/upserted && projectedEvidenceId/);
    // The UPDATE that clears indexed_at_utc is inside the `if (upserted && …)` block.
    expect(workerSrc).toMatch(
      /if \(upserted && projectedEvidenceId\)[\s\S]*?UPDATE "evidence_ocr_text"[\s\S]*?SET "indexed_at_utc"/,
    );
  });

  it("OCR + transcript reads filter to TEAM scope + non-redacted (governance gate)", () => {
    expect(workerSrc).toMatch(
      /FROM "evidence_ocr_text"[\s\S]*?"visibility_scope" = 'TEAM'[\s\S]*?"redacted" = FALSE/,
    );
    expect(workerSrc).toMatch(
      /FROM "evidence_transcript_segments"[\s\S]*?"visibility_scope" = 'TEAM'[\s\S]*?"redacted" = FALSE/,
    );
  });

  it("emits structured started / succeeded / failed / skipped events", () => {
    expect(workerSrc).toContain('"worker.search.indexing.started"');
    expect(workerSrc).toContain('"worker.search.indexing.succeeded"');
    expect(workerSrc).toContain('"worker.search.indexing.failed"');
    expect(workerSrc).toContain('"worker.search.indexing.skipped"');
  });

  it("never references private notes / storage keys / signed URLs / GPS in executable code", () => {
    // Strip comments first.
    const noComments = workerSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(noComments).not.toContain("privateReviewerNote");
    expect(noComments).not.toContain("legalNoteBody");
    expect(noComments).not.toContain("storageKey");
    expect(noComments).not.toMatch(/\braw_gps\b|\bgpsCoordinates\b/);
  });
});

// =============================================================================
// PART 3 — Reviewer priority engine (pure behavioural)
// =============================================================================

describe("Phase 25 — reviewer priority scoring engine", () => {
  const baseFacts: PriorityFacts = {
    nowEpochMs: Date.parse("2026-05-19T12:00:00Z"),
    slaStatus: "ON_TRACK",
    activeEscalationSeverity: null,
    hasActiveLegalHold: false,
    hasOpenImmutableDriftIncident: false,
    packageBlocked: false,
    exportBlocked: false,
    evidencePriority: "NORMAL",
    isExternalIntake: false,
    isStuck: false,
    assignedReviewerPressure: "balanced",
    workflowCreatedAtEpochMs: Date.parse("2026-05-19T12:00:00Z"),
    lastTouchAtEpochMs: Date.parse("2026-05-19T12:00:00Z"),
    caseCriticality: "STANDARD",
  };

  it("a calm workflow ranks STANDARD", () => {
    const r = computeReviewerPriority(baseFacts);
    expect(r.band).toBe("STANDARD");
    expect(r.score).toBeLessThan(300);
  });

  it("legal-hold + SLA-breached + CRITICAL escalation rank URGENT (governance-first)", () => {
    const r = computeReviewerPriority({
      ...baseFacts,
      slaStatus: "BREACHED",
      activeEscalationSeverity: "CRITICAL",
      hasActiveLegalHold: true,
    });
    expect(r.band).toBe("URGENT");
    expect(r.score).toBeGreaterThanOrEqual(600);
    expect(r.reasons.map((x) => x.code)).toEqual(
      expect.arrayContaining([
        "legal_hold_active",
        "sla_breached",
        "escalation_critical",
      ]),
    );
  });

  it("workload balancing CANNOT suppress a governance signal", () => {
    const balanced = computeReviewerPriority({
      ...baseFacts,
      slaStatus: "BREACHED",
      activeEscalationSeverity: "CRITICAL",
      hasActiveLegalHold: true,
      assignedReviewerPressure: "available",
    });
    const overloaded = computeReviewerPriority({
      ...baseFacts,
      slaStatus: "BREACHED",
      activeEscalationSeverity: "CRITICAL",
      hasActiveLegalHold: true,
      assignedReviewerPressure: "overloaded",
    });
    // Both URGENT — workload only adds, never subtracts.
    expect(balanced.band).toBe("URGENT");
    expect(overloaded.band).toBe("URGENT");
    expect(overloaded.score).toBeGreaterThan(balanced.score);
  });

  it("score is bounded to [0, 1000] and deterministic", () => {
    const everything: PriorityFacts = {
      ...baseFacts,
      slaStatus: "BREACHED",
      activeEscalationSeverity: "CRITICAL",
      hasActiveLegalHold: true,
      hasOpenImmutableDriftIncident: true,
      packageBlocked: true,
      exportBlocked: true,
      evidencePriority: "CRITICAL",
      isExternalIntake: true,
      isStuck: true,
      assignedReviewerPressure: "overloaded",
      workflowCreatedAtEpochMs: Date.parse("2026-04-01T00:00:00Z"),
      lastTouchAtEpochMs: Date.parse("2026-05-10T00:00:00Z"),
      caseCriticality: "CRITICAL",
    };
    const a = computeReviewerPriority(everything);
    const b = computeReviewerPriority(everything);
    expect(a.score).toBe(b.score);
    expect(a.score).toBeLessThanOrEqual(1000);
    expect(a.band).toBe("URGENT");
  });

  it("reasons are sorted by delta descending (UI can render top-3)", () => {
    const r = computeReviewerPriority({
      ...baseFacts,
      slaStatus: "BREACHED",
      activeEscalationSeverity: "HIGH",
      hasActiveLegalHold: true,
    });
    for (let i = 1; i < r.reasons.length; i++) {
      expect(r.reasons[i]!.delta).toBeLessThanOrEqual(r.reasons[i - 1]!.delta);
    }
  });

  it("every reason code is in the bounded catalog", () => {
    const r = computeReviewerPriority({
      ...baseFacts,
      slaStatus: "BREACHED",
      activeEscalationSeverity: "CRITICAL",
      hasActiveLegalHold: true,
      hasOpenImmutableDriftIncident: true,
      packageBlocked: true,
      exportBlocked: true,
      evidencePriority: "CRITICAL",
      isExternalIntake: true,
      isStuck: true,
      assignedReviewerPressure: "overloaded",
      caseCriticality: "CRITICAL",
    });
    for (const reason of r.reasons) {
      expect(PRIORITY_REASON_CODES).toContain(reason.code);
    }
  });

  it("summarisePriorityReasons returns a bounded chip label", () => {
    const r = computeReviewerPriority({
      ...baseFacts,
      slaStatus: "BREACHED",
      activeEscalationSeverity: "CRITICAL",
    });
    const chip = summarisePriorityReasons(r.reasons, 3);
    expect(chip.length).toBeGreaterThan(0);
    expect(chip.split(" · ").length).toBeLessThanOrEqual(3);
  });

  it("reason labels are operator-readable, not free-text from input", () => {
    const r = computeReviewerPriority({
      ...baseFacts,
      slaStatus: "BREACHED",
    });
    // Labels should match the bounded vocabulary.
    expect(r.reasons.some((x) => x.label === "Reviewer SLA breached")).toBe(
      true,
    );
  });

  it("priority engine is pure — no banned wording in labels", () => {
    const banned =
      /\btamper(ed|ing)?\b|\bforged\b|\bforgery\b|\baltered content\b|\bmanipulated evidence\b/i;
    const everything: PriorityFacts = {
      ...baseFacts,
      slaStatus: "BREACHED",
      activeEscalationSeverity: "CRITICAL",
      hasActiveLegalHold: true,
      hasOpenImmutableDriftIncident: true,
      packageBlocked: true,
      exportBlocked: true,
      evidencePriority: "CRITICAL",
      isExternalIntake: true,
      isStuck: true,
      assignedReviewerPressure: "overloaded",
      caseCriticality: "CRITICAL",
    };
    const r = computeReviewerPriority(everything);
    for (const reason of r.reasons) {
      expect(reason.label).not.toMatch(banned);
    }
  });
});

// =============================================================================
// PART 4 — Stuck workflow detector
// =============================================================================

describe("Phase 25 — stuck workflow detector", () => {
  const now = Date.parse("2026-05-19T12:00:00Z");
  const baseFacts: StuckWorkflowFacts = {
    nowEpochMs: now,
    status: "IN_REVIEW",
    submittedAtEpochMs: now - 1 * 60 * 60 * 1000,
    assignedAtEpochMs: now - 30 * 60 * 1000,
    firstOpenedAtEpochMs: now - 20 * 60 * 1000,
    lastReviewerTouchAtEpochMs: now - 10 * 60 * 1000,
    lastContributorResponseAtEpochMs: null,
    slaStatus: "ON_TRACK",
    hasOpenEscalation: false,
    escalationAcknowledged: false,
    approvedButExportBlocked: false,
  };

  it("a healthy active review is NOT stuck", () => {
    const r = detectStuckWorkflow(baseFacts);
    expect(r.isStuck).toBe(false);
    expect(r.reasons.length).toBe(0);
    expect(r.topSeverity).toBe("INFO");
  });

  it("submitted > 24h without assignment is stuck (HIGH)", () => {
    const r = detectStuckWorkflow({
      ...baseFacts,
      status: "SUBMITTED",
      submittedAtEpochMs: now - 26 * 60 * 60 * 1000,
      assignedAtEpochMs: null,
      firstOpenedAtEpochMs: null,
      lastReviewerTouchAtEpochMs: null,
    });
    expect(r.isStuck).toBe(true);
    expect(r.reasons.some((x) => x.code === "submitted_never_assigned")).toBe(
      true,
    );
    expect(r.topSeverity).toBe("HIGH");
  });

  it("SLA breached without an escalation is stuck (CRITICAL)", () => {
    const r = detectStuckWorkflow({
      ...baseFacts,
      slaStatus: "BREACHED",
      hasOpenEscalation: false,
    });
    expect(r.isStuck).toBe(true);
    expect(r.topSeverity).toBe("CRITICAL");
    expect(
      r.reasons.some((x) => x.code === "sla_overdue_no_escalation"),
    ).toBe(true);
  });

  it("escalated but unacknowledged > 8h is stuck (HIGH)", () => {
    const r = detectStuckWorkflow({
      ...baseFacts,
      hasOpenEscalation: true,
      escalationAcknowledged: false,
      lastReviewerTouchAtEpochMs: now - 9 * 60 * 60 * 1000,
    });
    expect(r.isStuck).toBe(true);
    expect(
      r.reasons.some((x) => x.code === "escalated_unacknowledged"),
    ).toBe(true);
  });

  it("approved but export still blocked is stuck (WARNING)", () => {
    const r = detectStuckWorkflow({
      ...baseFacts,
      status: "APPROVED",
      approvedButExportBlocked: true,
    });
    expect(r.isStuck).toBe(true);
    expect(
      r.reasons.some((x) => x.code === "approved_export_blocked"),
    ).toBe(true);
  });

  it("every reason code is in the bounded catalog", () => {
    const r = detectStuckWorkflow({
      ...baseFacts,
      status: "SUBMITTED",
      submittedAtEpochMs: now - 48 * 60 * 60 * 1000,
      assignedAtEpochMs: null,
      slaStatus: "BREACHED",
      hasOpenEscalation: false,
    });
    for (const reason of r.reasons) {
      expect(STUCK_REASON_CODES).toContain(reason.code);
    }
  });

  it("detector is deterministic", () => {
    const a = detectStuckWorkflow(baseFacts);
    const b = detectStuckWorkflow(baseFacts);
    expect(a.isStuck).toBe(b.isStuck);
    expect(a.topSeverity).toBe(b.topSeverity);
    expect(a.reasons.length).toBe(b.reasons.length);
  });
});

// =============================================================================
// PART 5 — Metric catalogue + cross-surface invariants
// =============================================================================

describe("Phase 25 — metric catalogue", () => {
  const src = readSource(
    "../../../packages/shared-runtime/src/ops/metrics.service.ts",
  );

  it("registers every Phase 25 counter from the brief", () => {
    for (const m of [
      "reviewer_priority_computed_total",
      "reviewer_assignment_suggested_total",
      "reviewer_assignment_ineligible_total",
      "reviewer_stuck_workflow_detected_total",
      "reviewer_escalation_storm_detected_total",
      "reviewer_workload_pressure_total",
      "search_indexing_rebuild_started_total",
      "search_indexing_rebuild_succeeded_total",
      "search_indexing_rebuild_failed_total",
      "search_indexing_stale_documents_total",
    ]) {
      expect(src, `metric ${m} missing`).toContain(`"${m}"`);
    }
  });
});

describe("Phase 25 — cross-surface invariants", () => {
  const FILES = [
    "../../../packages/shared/src/reviewer-priority.ts",
    "../../../packages/shared/src/stuck-workflow-detector.ts",
    "../../../packages/shared/src/search-projection.ts",
    "../../../services/api/src/services/search/evidence-indexing.service.ts",
    "../../../services/worker/src/search-indexing.processor.ts",
  ];

  it("no surface uses banned wording in string literals", () => {
    const banned =
      /\btamper(ed|ing)?\b|\bforged\b|\bforgery\b|\baltered content\b|\bmanipulated evidence\b/i;
    for (const rel of FILES) {
      const src = readSource(rel);
      const literals = src.match(/"[^"\n]+"/g) ?? [];
      expect(literals.join(" "), `banned wording in ${rel}`).not.toMatch(
        banned,
      );
    }
  });

  it("no surface fabricates operational counters or fake reviewer analytics", () => {
    for (const rel of FILES) {
      const src = readSource(rel);
      expect(src).not.toMatch(/escalations:\s*\d+,/);
      expect(src).not.toMatch(/incidents:\s*\d+,/);
      expect(src).not.toMatch(/overdue:\s*\d+,/);
      expect(src).not.toMatch(/reviewers:\s*\d+,/);
    }
  });

  it("priority + stuck-workflow engines never depend on Prisma / Node / Fastify", () => {
    for (const rel of [
      "../../../packages/shared/src/reviewer-priority.ts",
      "../../../packages/shared/src/stuck-workflow-detector.ts",
    ]) {
      const src = readSource(rel);
      expect(src).not.toMatch(/from\s+"@prisma\/client"/);
      expect(src).not.toMatch(/from\s+"fastify"/);
      expect(src).not.toMatch(/from\s+"node:/);
    }
  });
});
