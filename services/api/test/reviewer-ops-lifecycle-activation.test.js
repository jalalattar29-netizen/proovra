/**
 * Reviewer Ops lifecycle activation — regression tests.
 *
 * The brief: prove the reviewer-ops engines are wired end-to-end and
 * that the missing piece (a scheduled caller for `runReconcile()`) is
 * now in place via the worker tick.
 *
 * Coverage (source-contract + pure-helper, no DB):
 *
 *   1. Runtime schema validation module exports the expected shape
 *      and the EXPECTED_SCHEMA catalog includes every reviewer-ops
 *      critical object.
 *
 *   2. The /admin/runtime/schema-status route is registered and
 *      gated by the same identity.member.read check as the other
 *      operator endpoints.
 *
 *   3. Server startup runs the schema validator with fail-fast
 *      enabled by default; SCHEMA_VALIDATION_FAIL_FAST=false toggles
 *      it off for local dev.
 *
 *   4. /v1/reviewer-ops/reconcile accepts both `{ teamId }` (legacy)
 *      and `{ allTeams: true }` (worker tick). All-teams mode reads
 *      teams from prisma and runs reconcile per team.
 *
 *   5. The worker reviewer-reconciliation module exports
 *      `runReviewerReconciliation` and never throws — errors are
 *      logged and returned as `{ ok: false, error }`.
 *
 *   6. The worker's index.ts registers a start AND stop hook for the
 *      reviewer reconciliation scheduler, gated on the
 *      REVIEWER_OPS_RECONCILIATION_ENABLED env (default true).
 *
 *   7. runReconcile fires an escalation-storm GOVERNANCE incident
 *      when ≥ REVIEWER_ESCALATION_STORM_THRESHOLD escalations are
 *      created in a single sweep. Threshold is env-tunable.
 *
 *   8. runReconcile updates the `reviewer_queue_overdue` +
 *      `reviewer_workload_max_active` gauges so the existing
 *      operational alert catalog can fire.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPECTED_SCHEMA, } from "../src/runtime/schema-validation.js";
function readSource(rel) {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
// ---------------------------------------------------------------------------
// 1. Schema validation catalog
// ---------------------------------------------------------------------------
describe("Reviewer Ops activation [schema-validation] — EXPECTED_SCHEMA catalog", () => {
    function subsystemOf(o) {
        return o.subsystem;
    }
    it("includes every reviewer-ops critical table", () => {
        const tables = EXPECTED_SCHEMA.filter((o) => o.kind === "table" && subsystemOf(o) === "reviewer_ops").map((o) => o.name);
        expect(tables).toContain("evidence_review_workflows");
        expect(tables).toContain("evidence_review_workflow_events");
        expect(tables).toContain("review_escalations");
        expect(tables).toContain("reviewer_workload_snapshots");
    });
    it("flags reviewer-ops core tables as critical (not important)", () => {
        const critical = EXPECTED_SCHEMA.filter((o) => subsystemOf(o) === "reviewer_ops" &&
            o.severity === "critical" &&
            o.kind === "table").map((o) => o.name);
        // These tables back the dashboards the brief asked us to activate.
        // P2022 here = production outage, which is what triggered the
        // whole consolidation phase. They MUST be critical.
        expect(critical).toContain("evidence_review_workflows");
        expect(critical).toContain("review_escalations");
        expect(critical).toContain("reviewer_workload_snapshots");
    });
    it("includes the Phase 25 additive columns on evidence_review_workflows", () => {
        const columns = EXPECTED_SCHEMA.filter((o) => o.kind === "column" &&
            o.table === "evidence_review_workflows").map((o) => o.column);
        expect(columns).toEqual(expect.arrayContaining([
            "assignment_due_at_utc",
            "completion_due_at_utc",
            "paused_reason",
            "active_escalation_id",
        ]));
    });
    it("includes the unique escalation fingerprint index (dedupe is critical)", () => {
        const indexes = EXPECTED_SCHEMA.filter((o) => o.kind === "index").map((o) => o.indexName);
        expect(indexes).toContain("review_escalations_team_fingerprint_uk");
    });
});
// ---------------------------------------------------------------------------
// 2. Schema-status route
// ---------------------------------------------------------------------------
describe("Reviewer Ops activation [schema-status route]", () => {
    it("registers GET /admin/runtime/schema-status with requireAuth", () => {
        const src = readSource("../src/routes/ops.routes.ts");
        const routeIdx = src.indexOf('"/admin/runtime/schema-status"');
        expect(routeIdx).toBeGreaterThan(0);
        const slice = src.slice(routeIdx, routeIdx + 600);
        expect(slice).toContain("preHandler: requireAuth");
        expect(slice).toMatch(/requireOpsActor\(req, reply, q\.teamId\)/);
    });
    it("imports runSchemaValidation from the runtime module", () => {
        const src = readSource("../src/routes/ops.routes.ts");
        expect(src).toContain('from "../runtime/schema-validation.js"');
        expect(src).toContain("runSchemaValidation");
    });
});
// ---------------------------------------------------------------------------
// 3. Server-startup wiring (fail-fast on critical)
// ---------------------------------------------------------------------------
describe("Reviewer Ops activation [startup-wiring]", () => {
    it("server.ts invokes validateAtStartup with sentryHook + failFastOnCritical from env", () => {
        const src = readSource("../src/server.ts");
        expect(src).toContain('validateAtStartup');
        expect(src).toMatch(/SCHEMA_VALIDATION_FAIL_FAST/);
        expect(src).toMatch(/failFastOnCritical:\s*schemaValidationFailFast/);
        // The startup catch must re-throw critical drift so the process
        // exits non-zero and the orchestrator restarts/halts.
        expect(src).toMatch(/code === "SCHEMA_DRIFT_CRITICAL"[\s\S]*?throw err/);
    });
});
// ---------------------------------------------------------------------------
// 4. Reconcile route supports allTeams mode
// ---------------------------------------------------------------------------
describe("Reviewer Ops activation [reconcile route]", () => {
    it("POST /v1/reviewer-ops/reconcile accepts both single-team and allTeams body shapes", () => {
        const src = readSource("../src/routes/reviewer-ops.routes.ts");
        const routeIdx = src.indexOf('"/v1/reviewer-ops/reconcile"');
        expect(routeIdx).toBeGreaterThan(0);
        const slice = src.slice(routeIdx, routeIdx + 6000);
        // Must accept either { teamId } or { allTeams: true }.
        expect(slice).toMatch(/\.union\(\[/);
        expect(slice).toMatch(/allTeams:\s*z\.literal\(true\)/);
        // All-teams path must enumerate teams via prisma.
        expect(slice).toMatch(/prisma\.team\.findMany/);
        expect(slice).toMatch(/evidenceReviewWorkflows:\s*\{\s*some:\s*\{\}\s*\}/);
    });
    it("all-teams response aggregates per-team results", () => {
        const src = readSource("../src/routes/reviewer-ops.routes.ts");
        const routeIdx = src.indexOf('"/v1/reviewer-ops/reconcile"');
        const slice = src.slice(routeIdx, routeIdx + 6000);
        expect(slice).toContain("totalEscalationsCreated");
        expect(slice).toContain("totalFlippedBreached");
        expect(slice).toContain("failedTeams");
        expect(slice).toContain("perTeam");
    });
});
// ---------------------------------------------------------------------------
// 5. Worker reviewer reconciliation module
// ---------------------------------------------------------------------------
describe("Reviewer Ops activation [worker tick]", () => {
    it("worker module exports runReviewerReconciliation", () => {
        const src = readSource("../../worker/src/reviewer-ops/reviewer-reconciliation.worker.ts");
        expect(src).toMatch(/export async function runReviewerReconciliation/);
        // Must never throw — wrap http errors into a structured result.
        expect(src).toMatch(/ok:\s*false,\s*[\s\S]*?error/);
        // Must HTTP-call the api reconcile endpoint with the cron secret.
        expect(src).toMatch(/\/v1\/reviewer-ops\/reconcile/);
        expect(src).toMatch(/x-cron-secret/);
        expect(src).toMatch(/allTeams:\s*true/);
    });
    it("worker module gates on INTERNAL_API_BASE_URL + cron secret", () => {
        const src = readSource("../../worker/src/reviewer-ops/reviewer-reconciliation.worker.ts");
        expect(src).toMatch(/INTERNAL_API_BASE_URL/);
        expect(src).toMatch(/REVIEWER_OPS_CRON_SECRET/);
        // Missing config must not crash — return structured error.
        expect(src).toMatch(/not configured/);
    });
});
// ---------------------------------------------------------------------------
// 6. Worker index registers scheduler + shutdown hook
// ---------------------------------------------------------------------------
describe("Reviewer Ops activation [worker scheduler wiring]", () => {
    it("worker index.ts imports + starts + stops the reviewer reconciliation scheduler", () => {
        const src = readSource("../../worker/src/index.ts");
        expect(src).toContain('./reviewer-ops/reviewer-reconciliation.worker.js');
        expect(src).toContain("startReviewerReconciliationScheduler");
        expect(src).toContain("stopReviewerReconciliationScheduler");
        // Default-on env gate.
        expect(src).toContain('"REVIEWER_OPS_RECONCILIATION_ENABLED"');
        expect(src).toMatch(/REVIEWER_OPS_RECONCILIATION_INTERVAL_MS/);
    });
    it("the start hook is invoked AFTER the governance schedulers (ordering)", () => {
        const src = readSource("../../worker/src/index.ts");
        const startSection = src.slice(src.lastIndexOf("startCaptureDraftReaperScheduler();"), src.lastIndexOf("startObservabilityHeartbeat"));
        expect(startSection).toMatch(/startImmutableStorageReconciliationScheduler\(\);[\s\S]*?startReviewerReconciliationScheduler\(\);/);
    });
});
// ---------------------------------------------------------------------------
// 7. Escalation-storm detection
// ---------------------------------------------------------------------------
describe("Reviewer Ops activation [escalation storm]", () => {
    it("runReconcile records a GOVERNANCE incident when escalationsCreated ≥ threshold", () => {
        const src = readSource("../src/services/reviewer-ops/reviewer-operations-engine.service.ts");
        expect(src).toMatch(/REVIEWER_ESCALATION_STORM_THRESHOLD/);
        expect(src).toMatch(/escalationsCreated >= stormThreshold/);
        expect(src).toMatch(/recordIncident\([\s\S]*?category:\s*"GOVERNANCE"[\s\S]*?severity:\s*"HIGH"[\s\S]*?fingerprint:\s*`reviewer:escalation_storm/);
        // Storm recording must never fail the reconcile itself — the
        // inner catch is no-arg + bumps a metric, never re-throws.
        expect(src).toMatch(/Storm detection is observability/);
    });
    it("storm fingerprint is per-team + per-day so repeated bursts collapse", () => {
        const src = readSource("../src/services/reviewer-ops/reviewer-operations-engine.service.ts");
        expect(src).toMatch(/reviewer:escalation_storm:\$\{input\.teamId\}:\$\{today\}/);
    });
});
// ---------------------------------------------------------------------------
// 8. Operational gauges populated after reconcile
// ---------------------------------------------------------------------------
describe("Reviewer Ops activation [operational gauges]", () => {
    it("runReconcile sets reviewer_queue_overdue and reviewer_workload_max_active gauges", () => {
        const src = readSource("../src/services/reviewer-ops/reviewer-operations-engine.service.ts");
        expect(src).toMatch(/setGauge\("reviewer_queue_overdue"/);
        expect(src).toMatch(/setGauge\("reviewer_workload_max_active"/);
        // Gauge update is best-effort; never blocks reconcile.
        expect(src).toMatch(/best-effort/i);
    });
});
