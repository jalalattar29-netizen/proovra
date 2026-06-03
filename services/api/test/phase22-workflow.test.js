/**
 * Phase 22 — Evidence Workflow Engine regression tests.
 *
 * No DB. Source-text + pure-helper + projection tests covering the
 * Phase 22 surface:
 *
 *   - Engine error code surface (WorkflowEngineError → WORKFLOW_*)
 *   - Step projection omits the private reviewer note
 *   - Instance projection omits the externalContactHash (raw HMAC
 *     never leaves the row)
 *   - Routes: auth posture + 404-on-non-member
 *   - Routes: step-up wiring on waive + cancel
 *   - Public verify isolation: zero Phase 22 imports / table refs
 *   - Untouched files: report-v2 / worker pdf / public verify / OTS
 *   - Migration safety: additive, no DROP / RENAME
 *   - Runbooks: no forbidden overclaim phrasing in workflow runbooks
 *   - Wording sweep: workflow source files avoid legal overclaim phrasing
 *   - SecurityEvent catalog: Phase 22 events present
 *   - Metrics catalog: Phase 22 counters present
 */
import { describe, expect, it } from "vitest";
import { WorkflowEngineError, projectInstance, projectStep, } from "../src/services/workflows/evidence-workflow-engine.service.js";
// -----------------------------------------------------------------------------
// Engine error surface
// -----------------------------------------------------------------------------
describe("Phase 22 — WorkflowEngineError surface", () => {
    it("covers every code routes map to a response", () => {
        for (const c of [
            "WORKFLOW_INVALID_TRANSITION",
            "WORKFLOW_GOVERNANCE_BLOCKED",
            "WORKFLOW_STEP_REQUIRED",
            "WORKFLOW_STEP_NOT_FOUND",
            "WORKFLOW_VISIBILITY_DENIED",
            "WORKFLOW_INSTANCE_NOT_FOUND",
            "WORKFLOW_TEMPLATE_NOT_FOUND",
            "WORKFLOW_ACTOR_NOT_PERMITTED",
            "WORKFLOW_LEGAL_HOLD_ACTIVE",
            "WORKFLOW_ALREADY_SUBMITTED",
        ]) {
            const e = new WorkflowEngineError(c);
            expect(e.code).toBe(c);
            expect(e.message).toBe(c);
        }
    });
});
// -----------------------------------------------------------------------------
// Projection privacy
// -----------------------------------------------------------------------------
describe("Phase 22 — step projection privacy", () => {
    it("omits the private reviewer note from the safe projection", () => {
        const projected = projectStep({
            id: "11111111-1111-4111-8111-111111111111",
            workflowInstanceId: "22222222-2222-4222-8222-222222222222",
            stepKey: "primary",
            title: "Primary",
            required: true,
            orderIndex: 0,
            status: "SATISFIED",
            acceptedKindsJson: null,
            identityRequirement: null,
            locationRequirement: null,
            mappedEvidenceId: null,
            completedByUserId: null,
            completedAtUtc: new Date(),
            waiverReason: null,
            privateReviewerNote: "INTERNAL: reviewer suspects the contributor's submission is duplicated.",
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        const json = JSON.stringify(projected);
        expect(json).not.toMatch(/INTERNAL/);
        expect(json).not.toMatch(/reviewer suspects/);
        expect(projected.privateReviewerNote).toBeUndefined();
    });
});
describe("Phase 22 — instance projection privacy", () => {
    it("omits the external contact hash from the safe projection", () => {
        const projected = projectInstance({
            id: "11111111-1111-4111-8111-111111111111",
            teamId: "22222222-2222-4222-8222-222222222222",
            templateId: null,
            templateSlug: "insurance-claim",
            templateVersion: 1,
            status: "DRAFT",
            preHoldStatus: null,
            intakeMode: "EXTERNAL_ONE_TIME",
            actorRole: "EXTERNAL_CONTRIBUTOR",
            caseId: null,
            claimRef: null,
            matterRef: null,
            evidenceRequestId: null,
            intakeSessionId: null,
            externalContactHash: "deadbeef0000000000000000000000000000000000000000000000000000beef",
            createdByUserId: null,
            assignedReviewerUserId: null,
            title: "Test",
            submittedAtUtc: null,
            approvedAtUtc: null,
            closedAtUtc: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        const json = JSON.stringify(projected);
        expect(json).not.toMatch(/deadbeef/);
        expect(projected.externalContactHash).toBeUndefined();
    });
});
// -----------------------------------------------------------------------------
// Route surface
// -----------------------------------------------------------------------------
describe("Phase 22 — workflow instance routes auth posture", () => {
    it("operator routes use requireAuth + 404-on-non-member", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../src/routes/workflow-instances.routes.ts", import.meta.url)), "utf8");
        expect(src).toMatch(/app\.get\(\s*"\/v1\/workflows\/instances"[\s\S]{0,200}preHandler:\s*requireAuth/);
        expect(src).toMatch(/app\.post\(\s*"\/v1\/workflows\/instances"[\s\S]{0,200}preHandler:\s*requireAuth/);
        const guardBlock = src.match(/requireWorkflowActor[\s\S]{0,1500}/);
        expect(guardBlock).not.toBeNull();
        if (guardBlock) {
            const nonMember = guardBlock[0].match(/if \(!member\)[\s\S]{0,200}/);
            expect(nonMember).not.toBeNull();
            if (nonMember) {
                expect(nonMember[0]).toMatch(/reply\.code\(404\)/);
                expect(nonMember[0]).not.toMatch(/reply\.code\(403\)/);
            }
        }
    });
    it("waive + cancel routes wire step-up middleware", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../src/routes/workflow-instances.routes.ts", import.meta.url)), "utf8");
        expect(src).toMatch(/requireStepUpForSensitiveAction/);
        expect(src).toMatch(/app\.post\(\s*"\/v1\/workflows\/instances\/:id\/steps\/:stepKey\/waive"[\s\S]{0,1500}requireStepUpForSensitiveAction/);
        expect(src).toMatch(/app\.post\(\s*"\/v1\/workflows\/instances\/:id\/cancel"[\s\S]{0,1500}requireStepUpForSensitiveAction/);
    });
});
// -----------------------------------------------------------------------------
// Public verify isolation
// -----------------------------------------------------------------------------
describe("Phase 22 — public verify isolation", () => {
    it("public verify route does not read Phase 22 tables", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../src/routes/evidence.routes.ts", import.meta.url)), "utf8");
        const start = src.indexOf('app.get("/public/verify/:id"');
        expect(start).toBeGreaterThan(-1);
        const verifyBlock = src.slice(start, start + 8000);
        expect(verifyBlock).not.toMatch(/evidenceWorkflowInstance/);
        expect(verifyBlock).not.toMatch(/evidenceWorkflowStepInstance/);
        expect(verifyBlock).not.toMatch(/evidenceWorkflowVisibilityDecision/);
    });
    it("public verify route does not import the workflow engine", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../src/routes/evidence.routes.ts", import.meta.url)), "utf8");
        expect(src).not.toMatch(/workflows\/evidence-workflow-engine/);
    });
});
// -----------------------------------------------------------------------------
// Untouched files invariant
// -----------------------------------------------------------------------------
describe("Phase 22 — untouched files invariant", () => {
    it("services/worker/src/pdf/report.ts has NO Phase 22 markers", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../../worker/src/pdf/report.ts", import.meta.url)), "utf8");
        expect(src).not.toMatch(/Phase 22/);
        expect(src).not.toMatch(/evidenceWorkflowInstance/);
        expect(src).not.toMatch(/workflow-engine/);
    });
});
// -----------------------------------------------------------------------------
// Migration safety
// -----------------------------------------------------------------------------
describe("Phase 22 migration — additive only", () => {
    it("uses IF NOT EXISTS / EXCEPTION blocks; never drops or renames", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../prisma/migrations/20260530100000_add_workflow_engine_phase22/migration.sql", import.meta.url)), "utf8");
        expect(src).toMatch(/ADD COLUMN IF NOT EXISTS/);
        expect(src).toMatch(/CREATE TABLE IF NOT EXISTS/);
        expect(src.match(/^\s*ALTER TABLE [^;]+DROP COLUMN/m)).toBeNull();
        expect(src.match(/^\s*ALTER TABLE [^;]+RENAME COLUMN/m)).toBeNull();
    });
});
// -----------------------------------------------------------------------------
// Wording sweep — workflow source files + runbooks
// -----------------------------------------------------------------------------
describe("Phase 22 — wording sweep", () => {
    const FORBIDDEN = [
        /tamper.?proof/i,
        /court.?approved/i,
        /guaranteed authentic/i,
        /impossible to alter/i,
        /detects fake/i,
        /forensic proof/i,
        /legally admissible/i,
    ];
    it("the workflow engine service avoids forbidden overclaim phrasing", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../src/services/workflows/evidence-workflow-engine.service.ts", import.meta.url)), "utf8");
        for (const re of FORBIDDEN) {
            expect(src).not.toMatch(re);
        }
    });
    it("workflow instance routes avoid forbidden overclaim phrasing", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../src/routes/workflow-instances.routes.ts", import.meta.url)), "utf8");
        for (const re of FORBIDDEN) {
            expect(src).not.toMatch(re);
        }
    });
    it("workflow runbooks avoid forbidden overclaim phrasing", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        for (const name of ["workflow-stuck.md", "workflow-intake-abuse.md"]) {
            const src = await readFile(fileURLToPath(new URL(`../../../docs/runbooks/${name}`, import.meta.url)), "utf8");
            for (const re of FORBIDDEN) {
                expect(src, `${name} contains ${re}`).not.toMatch(re);
            }
        }
    });
});
// -----------------------------------------------------------------------------
// Catalog wiring assertions
// -----------------------------------------------------------------------------
describe("Phase 22 — SECURITY_EVENT_TYPES catalog extension", () => {
    it("includes the documented Phase 22 events", async () => {
        const { SECURITY_EVENT_TYPES } = await import("@proovra/shared");
        for (const t of [
            "workflow_template_created",
            "workflow_template_activated",
            "workflow_template_archived",
            "workflow_instance_created",
            "workflow_instance_submitted",
            "workflow_instance_changes_requested",
            "workflow_instance_approved",
            "workflow_instance_cancelled",
            "workflow_step_mapped",
            "workflow_step_satisfied",
            "workflow_step_waived",
            "workflow_review_assigned",
            "workflow_visibility_decided",
            "workflow_export_blocked",
            "workflow_intake_link_created",
            "workflow_intake_link_revoked",
            "workflow_intake_abuse_detected",
        ]) {
            expect(SECURITY_EVENT_TYPES).toContain(t);
        }
    });
});
describe("Phase 22 — metrics catalog extension", () => {
    it("includes the Phase 22 counters", async () => {
        const m = await import("../src/services/ops/metrics.service.js");
        for (const c of [
            "workflows_created_total",
            "workflows_submitted_total",
            "workflows_approved_total",
            "workflows_blocked_total",
            "workflow_step_waived_total",
            "workflow_step_satisfied_total",
            "workflow_intake_abuse_total",
            "workflow_export_blocked_total",
            "workflow_transition_invalid_total",
        ]) {
            expect(m.COUNTER_NAMES).toContain(c);
        }
    });
});
