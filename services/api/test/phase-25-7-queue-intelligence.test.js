/**
 * Phase 25.7 — Queue intelligence integration source-contract tests.
 *
 * Two-part coverage:
 *
 *   1. queue-intelligence.service.ts — orchestrates the shared engines
 *      (priority + stuck + assignment ranking) into one typed
 *      projection. Tests assert imports, bounded request size, fail-
 *      closed behaviour, governance gates, and no privacy leaks.
 *
 *   2. reviewer-operations-engine.service.ts — Phase 25.7 wires
 *      detectStuckWorkflow into the runReconcile sweep. Tests assert
 *      the sweep exists, is bounded, escalates only CRITICAL stuck
 *      classifications, and emits the right metrics.
 *
 * Pure source-contract. No DB, no Fastify.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readSource(rel) {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
// =============================================================================
// PART 1 — Queue intelligence service
// =============================================================================
describe("Phase 25.7 — queue intelligence service", () => {
    const src = readSource("../../../services/api/src/services/reviewer-ops/queue-intelligence.service.ts");
    it("imports the SHARED engines (no duplicated logic)", () => {
        expect(src).toMatch(/import\s*\{[\s\S]*?computeReviewerPriority[\s\S]*?detectStuckWorkflow[\s\S]*?rankReviewerSuggestions[\s\S]*?\}\s*from\s+"@proovra\/shared"/);
    });
    it("exports projectQueueIntelligence with a bounded input contract", () => {
        expect(src).toMatch(/export async function projectQueueIntelligence\([\s\S]*?QueueIntelligenceInput/);
        expect(src).toMatch(/MAX_WORKFLOWS_PER_CALL\s*=\s*100/);
        expect(src).toMatch(/MAX_CANDIDATES_PER_WORKFLOW\s*=\s*50/);
    });
    it("declares the full QueueWorkflowIntelligence projection (priority + stuck + assignmentSuggestions + reviewerPressure + governanceBlockers + slaState + escalationState + queueAging)", () => {
        expect(src).toMatch(/priority:\s*PriorityScoreResult/);
        expect(src).toMatch(/stuckState:\s*StuckClassification/);
        expect(src).toMatch(/assignmentSuggestions:\s*RankerResult/);
        expect(src).toMatch(/reviewerPressure:\s*"available" \| "balanced" \| "overloaded" \| null/);
        expect(src).toMatch(/governanceBlockers:\s*GovernanceBlockerProjection/);
        expect(src).toMatch(/slaState:\s*\{/);
        expect(src).toMatch(/escalationState:\s*\{/);
        expect(src).toMatch(/queueAging:\s*\{/);
    });
    it("anchors every read on teamId (anti-cross-workspace + anti-enumeration)", () => {
        expect(src).toMatch(/where:\s*\{\s*teamId:\s*input\.teamId/);
        expect(src).toMatch(/where:\s*\{\s*teamId\s*,/);
    });
    it("fails closed: any per-workflow compute error returns degraded, never throws", () => {
        expect(src).toMatch(/degradations\.push\(\{[\s\S]*?reason:\s*"compute_error"/);
        expect(src).toMatch(/try\s*\{[\s\S]*?\}\s*catch\s*\{[\s\S]*?\}/);
    });
    it("collects workflow_not_found degradations for IDs that did not match (no silent drop)", () => {
        expect(src).toMatch(/workflow_not_found/);
        expect(src).toMatch(/foundIds\.has\(id\)/);
    });
    it("never references private notes / legal-note bodies / storage keys / signed URLs / GPS", () => {
        const noComments = src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "");
        for (const forbidden of [
            "privateReviewerNote",
            "legalNoteBody",
            "storageKey",
            "signed_url",
            "raw_gps",
            "gpsCoordinates",
        ]) {
            expect(noComments).not.toContain(forbidden);
        }
    });
    it("bumps reviewer_priority_computed_total + reviewer_assignment_rank_computed_total per row", () => {
        expect(src).toMatch(/bump\("reviewer_priority_computed_total"\)/);
        expect(src).toMatch(/bump\("reviewer_assignment_rank_computed_total"\)/);
    });
    it("derives pressure from real workload signals (no fabricated counts)", () => {
        // The pressure ladder mirrors the engine's `overloaded` /
        // `balanced` / `available` categorical with explicit thresholds.
        expect(src).toMatch(/activeReviews \+ overdueReviews >= 12/);
        expect(src).toMatch(/activeReviews \+ overdueReviews >= 5/);
    });
    it("permissions are derived from team-member role (no hardcoded reviewer)", () => {
        expect(src).toMatch(/canAssignReviewer:\s*\n?\s*m\.role === "OWNER" \|\| m\.role === "ADMIN" \|\| m\.role === "REVIEWER"/);
        expect(src).toMatch(/canSeeReviewerRestricted:\s*m\.role === "OWNER" \|\| m\.role === "ADMIN"/);
    });
});
// =============================================================================
// PART 2 — Queue intelligence route
// =============================================================================
describe("Phase 25.7 — POST /v1/reviewer-ops/queue-intelligence route", () => {
    const src = readSource("../../../services/api/src/routes/reviewer-ops.routes.ts");
    it("declares the route gated by requireReviewerActor (RBAC enforced at the boundary)", () => {
        expect(src).toMatch(/"\/v1\/reviewer-ops\/queue-intelligence"/);
        expect(src).toMatch(/\/v1\/reviewer-ops\/queue-intelligence"[\s\S]*?requireReviewerActor\(req, reply, body\.teamId\)/);
    });
    it("validates body with bounded workflowIds (max 100, min 1)", () => {
        expect(src).toMatch(/workflowIds:\s*z\.array\(z\.string\(\)\.uuid\(\)\)\.min\(1\)\.max\(100\)/);
    });
    it("imports projectQueueIntelligence from the service (no inline orchestration)", () => {
        expect(src).toMatch(/import\s*\{\s*projectQueueIntelligence\s*\}\s*from\s+"\.\.\/services\/reviewer-ops\/queue-intelligence\.service\.js"/);
    });
    it("propagates actor + isReviewerCapable so the engine enforces self-assignment + reviewer-restricted rules", () => {
        expect(src).toMatch(/projectQueueIntelligence\(\{[\s\S]*?actorUserId:\s*ctx\.actorUserId[\s\S]*?isReviewerCapable:\s*ctx\.isReviewerCapable/);
    });
});
// =============================================================================
// PART 3 — Reconciliation wiring (Phase 25.7)
// =============================================================================
describe("Phase 25.7 — stuck workflow sweep wired into runReconcile", () => {
    const src = readSource("../../../services/api/src/services/reviewer-ops/reviewer-operations-engine.service.ts");
    it("imports detectStuckWorkflow from @proovra/shared", () => {
        expect(src).toMatch(/import\s*\{[\s\S]*?detectStuckWorkflow[\s\S]*?\}\s*from\s+"@proovra\/shared"/);
    });
    it("loads non-terminal workflows in a bounded scan (take: 200)", () => {
        expect(src).toMatch(/evidenceReviewWorkflow\.findMany\(\{[\s\S]*?status:\s*\{\s*notIn:\s*\[[\s\S]*?"CLOSED"[\s\S]*?"APPROVED_INTERNAL"[\s\S]*?"REJECTED_INSUFFICIENT"[\s\S]*?\]\s*as never[\s\S]*?\}[\s\S]*?take:\s*200/);
    });
    it("computes detectStuckWorkflow per row inside the reconcile sweep", () => {
        expect(src).toMatch(/const classification:\s*StuckClassification = detectStuckWorkflow\(/);
    });
    it("bumps reviewer_stuck_workflow_detected_total on every stuck classification", () => {
        expect(src).toMatch(/bump\("reviewer_stuck_workflow_detected_total"\)/);
    });
    it("only escalates CRITICAL-severity stuck rows (never WARNING/HIGH — guards against storm)", () => {
        expect(src).toMatch(/classification\.topSeverity === "CRITICAL"[\s\S]*?!wf\.activeEscalationId/);
    });
    it("escalation reuses the existing WORKFLOW_STALLED reason (existing fingerprint dedup)", () => {
        expect(src).toMatch(/createEscalation\(\s*\{[\s\S]*?reason:\s*"WORKFLOW_STALLED"/);
    });
    it("bumps reviewer_stuck_workflow_escalated_total on the escalation creation path", () => {
        expect(src).toMatch(/bump\("reviewer_stuck_workflow_escalated_total"\)/);
    });
    it("stuck sweep is best-effort — failure does not abort reconcile (try/catch around the sweep)", () => {
        expect(src).toMatch(/\/\/ Phase 25\.7 — stuck workflow sweep[\s\S]*?try\s*\{[\s\S]*?\}\s*catch\s*\{[\s\S]*?\/\/ Stuck sweep is best-effort/);
    });
    it("the run-summary SecurityEvent carries stuckDetected + stuckEscalated counters", () => {
        // Phase 32.7 — the literal `"reviewer_reconcile_run"` is no longer
        // inlined. The writer resolves it through
        // `canonicalOperationalWireStringFor("WORKER_HEARTBEAT")`. The
        // surrounding payload shape (stuckDetected + stuckEscalated) is
        // preserved.
        expect(src).toMatch(/safeEmitSecurityEvent\(\{[\s\S]*?eventType:\s*canonicalOperationalWireStringFor\([\s\S]{0,100}"WORKER_HEARTBEAT"[\s\S]*?stuckDetected[\s\S]*?stuckEscalated/);
    });
});
// =============================================================================
// PART 4 — Privacy + governance invariants on the new code
// =============================================================================
describe("Phase 25.7 — privacy + governance invariants", () => {
    const FILES = [
        "../../../services/api/src/services/reviewer-ops/queue-intelligence.service.ts",
        "../../../services/api/src/routes/reviewer-ops.routes.ts",
        "../../../services/api/src/services/reviewer-ops/reviewer-operations-engine.service.ts",
    ];
    it("no surface uses banned wording in string literals", () => {
        const banned = /\btamper(ed|ing)?\b|\bforged\b|\bforgery\b|\baltered content\b|\bmanipulated evidence\b/i;
        for (const rel of FILES) {
            const src = readSource(rel);
            const literals = src.match(/"[^"\n]+"/g) ?? [];
            expect(literals.join(" "), `banned wording in ${rel}`).not.toMatch(banned);
        }
    });
    it("queue-intelligence projection NEVER selects evidence text content", () => {
        const src = readSource("../../../services/api/src/services/reviewer-ops/queue-intelligence.service.ts");
        // Strip comments for the assertion — the doc-header legitimately
        // documents the forbidden vocabulary.
        const noComments = src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "");
        expect(noComments).not.toMatch(/select:\s*\{[^}]*\btextContent\b/);
        expect(noComments).not.toMatch(/select:\s*\{[^}]*\boriginalText\b/);
    });
    it("queue-intelligence enforces team_id on every Prisma read (no global lookups)", () => {
        const src = readSource("../../../services/api/src/services/reviewer-ops/queue-intelligence.service.ts");
        // Strip comments first.
        const noComments = src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "");
        // Every findMany / findFirst on a reviewer-ops table must include
        // teamId. Spot-check the canonical calls.
        expect(noComments).toMatch(/evidenceReviewWorkflow\.findMany\(\{[\s\S]*?teamId/);
        expect(noComments).toMatch(/teamMember\.findMany\(\{[\s\S]*?teamId/);
    });
    it("route handler does NOT call Prisma directly (orchestration stays in the service)", () => {
        const routeSrc = readSource("../../../services/api/src/routes/reviewer-ops.routes.ts");
        // Look only inside the queue-intelligence handler block.
        const handler = routeSrc.slice(routeSrc.indexOf('"/v1/reviewer-ops/queue-intelligence"'), routeSrc.indexOf('"/v1/reviewer-ops/queue-intelligence"') + 1200);
        expect(handler).not.toMatch(/prisma\./);
    });
});
// =============================================================================
// PART 5 — Metric registration
// =============================================================================
describe("Phase 25.7 — metric registration", () => {
    const src = readSource("../../../packages/shared-runtime/src/ops/metrics.service.ts");
    it("registers the Phase 25.5 + 25.7 counters used by the new orchestration", () => {
        for (const m of [
            "reviewer_priority_computed_total",
            "reviewer_assignment_rank_computed_total",
            "reviewer_stuck_workflow_detected_total",
            "reviewer_stuck_workflow_escalated_total",
        ]) {
            expect(src, `metric ${m} missing`).toContain(`"${m}"`);
        }
    });
});
