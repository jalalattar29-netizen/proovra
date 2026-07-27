/**
 * Phase 4 — Reviewer-workspace audit emission wiring.
 *
 * Locks the canonical wiring of `emitTenantAudit` into the three
 * previously-silent reviewer-workspace services:
 *
 *   - qc-sample.service.ts         (renderQcVerdict + sampleClosedWorkflow)
 *   - reviewer-disagreement.service.ts (fileDisagreement + transitionDisagreement)
 *   - coding-schema.service.ts     (createSchema + publishSchema + archiveSchema)
 *
 * Hard rules locked here:
 *
 *   1. Each successful primary mutation emits exactly one bounded
 *      audit event via the canonical tenant-audit facade.
 *
 *   2. Emission is best-effort — when `emitTenantAudit`
 *      throws, the primary mutation still succeeds (the call is
 *      wrapped in `.catch(() => {})`).
 *
 *   3. Bounded metadata only — raw rationale text, raw note bodies,
 *      and raw field option blobs are NEVER included in metadata.
 *      Only IDs, slugs, enum values, and version numbers are emitted.
 *
 *   4. Actor user id (when available on the service signature) is
 *      propagated to `actorUserId` on the envelope so the tenant
 *      audit chain attributes the action to a real user.
 *
 *   5. Source-text contract: each of the three service files imports
 *      `emitTenantAudit` from the canonical
 *      `../audit/tenant-audit.service.js` module path.
 *
 *   6. Tenant scope: `teamId` is carried on the envelope's top-level
 *      `workspaceId` field (authoritative DB column), not duplicated
 *      into `metadata`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — bound BEFORE the SUT imports so the services see the stub.
// ---------------------------------------------------------------------------

const emitTenantAuditMock = vi.fn(async () => undefined);
vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: emitTenantAuditMock,
}));

// Minimal prisma stub — each test sets up the methods it needs.
type AnyFn = ReturnType<typeof vi.fn>;
const prismaStub: {
  qcSample: { findFirst: AnyFn; create: AnyFn; update: AnyFn };
  workflowReviewDecision: { findFirst: AnyFn };
  reviewerDisagreement: { findFirst: AnyFn; create: AnyFn; update: AnyFn };
  codingSchema: { findFirst: AnyFn; create: AnyFn; update: AnyFn };
} = {
  qcSample: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  workflowReviewDecision: { findFirst: vi.fn() },
  reviewerDisagreement: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  codingSchema: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
};

vi.mock("../src/db.js", () => ({
  prisma: prismaStub,
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks are bound.
// ---------------------------------------------------------------------------

const qcMod = await import(
  "../src/services/reviewer-workspace/qc-sample.service.js"
);
const disagreeMod = await import(
  "../src/services/reviewer-workspace/reviewer-disagreement.service.js"
);
const codingMod = await import(
  "../src/services/reviewer-workspace/coding-schema.service.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEAM_ID = "00000000-0000-0000-0000-000000000001";
const WORKFLOW_ID = "00000000-0000-0000-0000-000000000002";
const ACTOR_ID = "00000000-0000-0000-0000-000000000004";
const DECISION_ID = "00000000-0000-0000-0000-000000000005";
const ORIGINAL_REVIEWER_ID = "00000000-0000-0000-0000-000000000006";

beforeEach(() => {
  emitTenantAuditMock.mockReset();
  emitTenantAuditMock.mockResolvedValue(undefined);
  for (const model of Object.values(prismaStub)) {
    for (const fn of Object.values(model)) {
      (fn as AnyFn).mockReset();
    }
  }
});

type AuditParams = {
  actorUserId: string | null;
  action: string;
  severity?: string;
  sourceApp?: string;
  outcome?: string;
  workspaceId?: string | null;
  resourceType?: string;
  resourceId?: string;
  metadata: Record<string, unknown>;
};

function findAuditCall(action: string): AuditParams | undefined {
  const calls = emitTenantAuditMock.mock.calls as unknown as Array<
    [AuditParams]
  >;
  const found = calls.find((c) => c[0]?.action === action);
  return found ? found[0] : undefined;
}

// ===========================================================================
// 1 — QC sample audit emissions
// ===========================================================================

describe("Phase 4 — qc-sample.service audit emission", () => {
  it("emits reviewer.qc.sampled when a new sample row is created", async () => {
    // No existing sample on file -> proceed to RNG roll.
    prismaStub.qcSample.findFirst.mockResolvedValueOnce(null);
    prismaStub.qcSample.create.mockResolvedValueOnce({ id: "qc-new-1" });
    // Pin the RNG so the workflow IS sampled (roll 0 < default 5%).
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0);

    const result = await qcMod.sampleClosedWorkflow({
      teamId: TEAM_ID,
      workflowId: WORKFLOW_ID,
      decision: "APPROVE_INTERNAL",
    });

    rnd.mockRestore();
    expect(result).toEqual({ sampleId: "qc-new-1" });

    const audit = findAuditCall("reviewer.qc.sampled");
    expect(audit).toBeDefined();
    expect(audit!.resourceType).toBe("qc_sample");
    expect(audit!.resourceId).toBe("qc-new-1");
    expect(audit!.workspaceId).toBe(TEAM_ID);
    expect(audit!.metadata.workflowId).toBe(WORKFLOW_ID);
    expect(audit!.metadata.sampleId).toBe("qc-new-1");
    expect(audit!.metadata.decision).toBe("APPROVE_INTERNAL");
  });

  it("does NOT emit reviewer.qc.sampled when short-circuiting on existing sample", async () => {
    prismaStub.qcSample.findFirst.mockResolvedValueOnce({ id: "qc-exists" });

    const result = await qcMod.sampleClosedWorkflow({
      teamId: TEAM_ID,
      workflowId: WORKFLOW_ID,
    });

    expect(result).toEqual({ sampleId: "qc-exists" });
    // No create -> no audit emit. We use the existing-row short
    // circuit; the audit chain should only carry NEW sample events.
    expect(findAuditCall("reviewer.qc.sampled")).toBeUndefined();
    expect(prismaStub.qcSample.create).not.toHaveBeenCalled();
  });

  it("emits reviewer.qc.verdict_rendered with bounded metadata (no raw rationale)", async () => {
    prismaStub.qcSample.findFirst.mockResolvedValueOnce({
      id: "qc-1",
      state: "ASSIGNED",
      qcReviewerUserId: ACTOR_ID,
    });
    prismaStub.qcSample.update.mockResolvedValueOnce({});

    const rationale =
      "This is the reviewer's private QC commentary that must never leak into the audit chain.";
    const result = await qcMod.renderQcVerdict({
      teamId: TEAM_ID,
      sampleId: "qc-1",
      actorUserId: ACTOR_ID,
      verdict: "FAIL",
      failureReason: "WRONG_DECISION",
      rationale,
    });

    expect(result).toEqual({ ok: true });

    const audit = findAuditCall("reviewer.qc.verdict_rendered");
    expect(audit).toBeDefined();
    expect(audit!.actorUserId).toBe(ACTOR_ID);
    expect(audit!.severity).toBe("warning"); // FAIL bumps to warning
    expect(audit!.resourceType).toBe("qc_sample");
    expect(audit!.workspaceId).toBe(TEAM_ID);
    expect(audit!.metadata.sampleId).toBe("qc-1");
    expect(audit!.metadata.verdict).toBe("FAIL");
    expect(audit!.metadata.failureReason).toBe("WRONG_DECISION");
    expect(audit!.metadata.qcReviewerUserId).toBe(ACTOR_ID);

    // Bounded metadata contract: the raw rationale body MUST NOT
    // appear anywhere in the emitted metadata payload.
    const flat = JSON.stringify(audit!.metadata);
    expect(flat).not.toContain("private QC commentary");
    expect(flat).not.toContain(rationale);
  });

  it("primary verdict mutation succeeds even when audit emission throws", async () => {
    prismaStub.qcSample.findFirst.mockResolvedValueOnce({
      id: "qc-2",
      state: "ASSIGNED",
      qcReviewerUserId: ACTOR_ID,
    });
    prismaStub.qcSample.update.mockResolvedValueOnce({});
    emitTenantAuditMock.mockRejectedValueOnce(new Error("audit chain down"));

    const result = await qcMod.renderQcVerdict({
      teamId: TEAM_ID,
      sampleId: "qc-2",
      actorUserId: ACTOR_ID,
      verdict: "PASS",
    });

    expect(result).toEqual({ ok: true });
    expect(prismaStub.qcSample.update).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 2 — Disagreement audit emissions
// ===========================================================================

describe("Phase 4 — reviewer-disagreement.service audit emission", () => {
  it("emits reviewer.disagreement.filed with bounded metadata (no raw rationale)", async () => {
    prismaStub.workflowReviewDecision.findFirst.mockResolvedValueOnce({
      id: DECISION_ID,
      reviewerUserId: ORIGINAL_REVIEWER_ID,
    });
    prismaStub.reviewerDisagreement.create.mockResolvedValueOnce({
      id: "dis-1",
    });

    const rationale =
      "Sensitive disagreement rationale that must never enter the audit chain payload.";
    const result = await disagreeMod.fileDisagreement({
      teamId: TEAM_ID,
      workflowId: WORKFLOW_ID,
      originalDecisionId: DECISION_ID,
      challengerUserId: ACTOR_ID,
      rationale,
    });

    expect(result).toEqual({ ok: true, disagreementId: "dis-1" });

    const audit = findAuditCall("reviewer.disagreement.filed");
    expect(audit).toBeDefined();
    expect(audit!.actorUserId).toBe(ACTOR_ID);
    expect(audit!.resourceType).toBe("reviewer_disagreement");
    expect(audit!.resourceId).toBe("dis-1");
    expect(audit!.workspaceId).toBe(TEAM_ID);
    expect(audit!.metadata.workflowId).toBe(WORKFLOW_ID);
    expect(audit!.metadata.disagreementId).toBe("dis-1");
    expect(audit!.metadata.originalDecisionId).toBe(DECISION_ID);
    expect(audit!.metadata.challengerUserId).toBe(ACTOR_ID);

    const flat = JSON.stringify(audit!.metadata);
    expect(flat).not.toContain("Sensitive disagreement rationale");
    expect(flat).not.toContain(rationale);
  });

  it("emits reviewer.disagreement.transitioned with bounded metadata", async () => {
    prismaStub.reviewerDisagreement.findFirst.mockResolvedValueOnce({
      id: "dis-1",
      state: "FILED",
      challengerUserId: ACTOR_ID,
    });
    prismaStub.reviewerDisagreement.update.mockResolvedValueOnce({});

    const supervisorRationale =
      "Supervisor's bounded explanation that must never leak into the audit metadata.";
    const result = await disagreeMod.transitionDisagreement({
      teamId: TEAM_ID,
      disagreementId: "dis-1",
      to: "UNDER_SECOND_REVIEW",
      actorUserId: ACTOR_ID,
      verdict: "APPROVE",
      rationale: supervisorRationale,
    });

    expect(result).toEqual({ ok: true });

    const audit = findAuditCall("reviewer.disagreement.transitioned");
    expect(audit).toBeDefined();
    expect(audit!.actorUserId).toBe(ACTOR_ID);
    expect(audit!.resourceType).toBe("reviewer_disagreement");
    expect(audit!.resourceId).toBe("dis-1");
    expect(audit!.workspaceId).toBe(TEAM_ID);
    expect(audit!.metadata.disagreementId).toBe("dis-1");
    expect(audit!.metadata.fromState).toBe("FILED");
    expect(audit!.metadata.toState).toBe("UNDER_SECOND_REVIEW");
    expect(audit!.metadata.resolution).toBe("APPROVE");
    expect(audit!.metadata.actorUserId).toBe(ACTOR_ID);

    const flat = JSON.stringify(audit!.metadata);
    expect(flat).not.toContain("Supervisor's bounded explanation");
    expect(flat).not.toContain(supervisorRationale);
  });

  it("primary file mutation succeeds even when audit emission throws", async () => {
    prismaStub.workflowReviewDecision.findFirst.mockResolvedValueOnce({
      id: DECISION_ID,
      reviewerUserId: ORIGINAL_REVIEWER_ID,
    });
    prismaStub.reviewerDisagreement.create.mockResolvedValueOnce({
      id: "dis-2",
    });
    emitTenantAuditMock.mockRejectedValueOnce(new Error("audit chain down"));

    const result = await disagreeMod.fileDisagreement({
      teamId: TEAM_ID,
      workflowId: WORKFLOW_ID,
      originalDecisionId: DECISION_ID,
      challengerUserId: ACTOR_ID,
      rationale: "Reason",
    });

    expect(result).toEqual({ ok: true, disagreementId: "dis-2" });
    expect(prismaStub.reviewerDisagreement.create).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 3 — Coding-schema audit emissions
// ===========================================================================

describe("Phase 4 — coding-schema.service audit emission", () => {
  it("emits reviewer.coding_schema.created with bounded metadata (no field definitions)", async () => {
    prismaStub.codingSchema.findFirst.mockResolvedValueOnce(null); // no prior version
    prismaStub.codingSchema.create.mockResolvedValueOnce({
      id: "schema-1",
      version: 1,
    });

    const sensitiveFieldLabel =
      "Secret internal field label that must never enter the audit chain.";
    const result = await codingMod.createSchema({
      teamId: TEAM_ID,
      authorUserId: ACTOR_ID,
      slug: "test-schema",
      label: "Test Schema",
      category: "GENERAL_EVIDENCE",
      description: undefined,
      fields: [
        {
          slug: "f1",
          label: sensitiveFieldLabel,
          fieldType: "TEXT",
          required: false,
          orderIndex: 0,
        },
      ],
    });

    expect(result).toEqual({ ok: true, schemaId: "schema-1", version: 1 });

    const audit = findAuditCall("reviewer.coding_schema.created");
    expect(audit).toBeDefined();
    expect(audit!.actorUserId).toBe(ACTOR_ID);
    expect(audit!.resourceType).toBe("coding_schema");
    expect(audit!.resourceId).toBe("schema-1");
    expect(audit!.workspaceId).toBe(TEAM_ID);
    expect(audit!.metadata.schemaId).toBe("schema-1");
    expect(audit!.metadata.slug).toBe("test-schema");
    expect(audit!.metadata.category).toBe("GENERAL_EVIDENCE");
    expect(audit!.metadata.version).toBe(1);

    // Bounded metadata contract: the raw field definitions (labels,
    // helpText, options blobs) MUST NOT leak into the audit payload.
    const flat = JSON.stringify(audit!.metadata);
    expect(flat).not.toContain("Secret internal field label");
    expect(flat).not.toContain(sensitiveFieldLabel);
    expect(audit!.metadata.fields).toBeUndefined();
  });

  it("emits reviewer.coding_schema.published with bounded metadata", async () => {
    prismaStub.codingSchema.findFirst.mockResolvedValueOnce({
      id: "schema-1",
      status: "DRAFT",
      version: 2,
      slug: "test-schema",
    });
    prismaStub.codingSchema.update.mockResolvedValueOnce({});

    const result = await codingMod.publishSchema({
      teamId: TEAM_ID,
      schemaId: "schema-1",
    });

    expect(result).toEqual({
      ok: true,
      schemaId: "schema-1",
      publishedVersion: 2,
    });

    const audit = findAuditCall("reviewer.coding_schema.published");
    expect(audit).toBeDefined();
    expect(audit!.resourceType).toBe("coding_schema");
    expect(audit!.resourceId).toBe("schema-1");
    expect(audit!.workspaceId).toBe(TEAM_ID);
    expect(audit!.metadata.schemaId).toBe("schema-1");
    expect(audit!.metadata.slug).toBe("test-schema");
    expect(audit!.metadata.version).toBe(2);
  });

  it("emits reviewer.coding_schema.archived with bounded metadata", async () => {
    prismaStub.codingSchema.findFirst.mockResolvedValueOnce({
      id: "schema-1",
      status: "PUBLISHED",
      slug: "test-schema",
    });
    prismaStub.codingSchema.update.mockResolvedValueOnce({});

    const result = await codingMod.archiveSchema({
      teamId: TEAM_ID,
      schemaId: "schema-1",
    });

    expect(result).toEqual({ ok: true });

    const audit = findAuditCall("reviewer.coding_schema.archived");
    expect(audit).toBeDefined();
    expect(audit!.resourceType).toBe("coding_schema");
    expect(audit!.resourceId).toBe("schema-1");
    expect(audit!.workspaceId).toBe(TEAM_ID);
    expect(audit!.metadata.schemaId).toBe("schema-1");
    expect(audit!.metadata.slug).toBe("test-schema");
  });

  it("primary schema mutation succeeds even when audit emission throws", async () => {
    prismaStub.codingSchema.findFirst.mockResolvedValueOnce({
      id: "schema-3",
      status: "PUBLISHED",
      slug: "test-schema-3",
    });
    prismaStub.codingSchema.update.mockResolvedValueOnce({});
    emitTenantAuditMock.mockRejectedValueOnce(new Error("audit chain down"));

    const result = await codingMod.archiveSchema({
      teamId: TEAM_ID,
      schemaId: "schema-3",
    });

    expect(result).toEqual({ ok: true });
    expect(prismaStub.codingSchema.update).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 4 — Source-text wiring contract
// ===========================================================================

describe("Phase 4 — service-source wiring contract", () => {
  const QC_SRC = readFileSync(
    fileURLToPath(
      new URL(
        "../src/services/reviewer-workspace/qc-sample.service.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const DISAGREE_SRC = readFileSync(
    fileURLToPath(
      new URL(
        "../src/services/reviewer-workspace/reviewer-disagreement.service.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const CODING_SRC = readFileSync(
    fileURLToPath(
      new URL(
        "../src/services/reviewer-workspace/coding-schema.service.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("each service imports emitTenantAudit from the canonical facade module", () => {
    const importRe =
      /import\s+\{\s*emitTenantAudit\s*\}\s+from\s+"\.\.\/audit\/tenant-audit\.service\.js"/;
    expect(QC_SRC).toMatch(importRe);
    expect(DISAGREE_SRC).toMatch(importRe);
    expect(CODING_SRC).toMatch(importRe);
  });

  it("every audit emission is wrapped in .catch(() => {}) so it stays best-effort", () => {
    for (const src of [QC_SRC, DISAGREE_SRC, CODING_SRC]) {
      // Match each emitTenantAudit(...) call and verify that the
      // following 60 chars include .catch(() => {}). The check
      // tolerates whitespace inside the empty handler.
      const re = /emitTenantAudit\(/g;
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = re.exec(src)) !== null) {
        count += 1;
        // Locate the matching closing paren by depth.
        let depth = 1;
        let i = m.index + "emitTenantAudit(".length;
        while (depth > 0 && i < src.length) {
          const c = src[i];
          if (c === "(") depth += 1;
          else if (c === ")") depth -= 1;
          i += 1;
        }
        const tail = src.slice(i, i + 60);
        expect(tail).toMatch(/^\s*\.catch\(\(\)\s*=>\s*\{\s*\}\)/);
      }
      expect(count).toBeGreaterThan(0);
    }
  });

  it("all expected canonical action ids appear at least once", () => {
    expect(QC_SRC).toMatch(/"reviewer\.qc\.sampled"/);
    expect(QC_SRC).toMatch(/"reviewer\.qc\.verdict_rendered"/);
    expect(DISAGREE_SRC).toMatch(/"reviewer\.disagreement\.filed"/);
    expect(DISAGREE_SRC).toMatch(/"reviewer\.disagreement\.transitioned"/);
    expect(CODING_SRC).toMatch(/"reviewer\.coding_schema\.created"/);
    expect(CODING_SRC).toMatch(/"reviewer\.coding_schema\.published"/);
    expect(CODING_SRC).toMatch(/"reviewer\.coding_schema\.archived"/);
  });
});
