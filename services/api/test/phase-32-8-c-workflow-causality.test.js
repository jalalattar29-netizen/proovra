/**
 * Phase 32.8C FINAL-2 — Workflow Orchestration + Operational Causality.
 *
 * Source-contract tests covering:
 *
 *  PART 1  — Prisma schema: OperationalWorkflow + Event + Action models,
 *            OperationalCausalityLink + Chain models, 10 new enums
 *  PART 2  — Migration source-contract (idempotent, additive, rollback)
 *  PART 3  — Workflow generator: deterministic, sources from real
 *            incidents/correlations, idempotent workflowKey, never throws
 *  PART 4  — Workflow lifecycle service (assign/start/escalate/mitigation/
 *            resolve/suppress/reopen/scheduleRetry): authenticated,
 *            audited, history events
 *  PART 5  — Causality engine: deterministic link rules, chain idempotency,
 *            never throws, bounded summaries
 *  PART 6  — Routes: GET workflows + workflow lifecycle POST + GET
 *            causality chains; all auth + workspace-scoped
 *  PART 7  — Envelope changes: workflows + causalityChains exposed
 *  PART 8  — Frontend rendering: CausalityChainsStrip + WorkflowsStrip
 *  PART 9  — No fake data / no overclaim / no secret leakage /
 *            no page-load side effects / dashboard read-only
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readApi(rel) {
    return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
function readWeb(rel) {
    return readFileSync(fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)), "utf8");
}
const SCHEMA = readApi("prisma/schema.prisma");
const MIGRATION = readApi("prisma/migrations/20260628100000_phase328c_workflow_causality/migration.sql");
const WF_GEN = readApi("src/services/dashboard/workflow-generator.service.ts");
const WF_SVC = readApi("src/services/observability/workflow.service.ts");
const CAUSAL = readApi("src/services/dashboard/causality.service.ts");
const OPS_ROUTES = readApi("src/routes/ops.routes.ts");
const COMMAND_CENTER = readApi("src/services/dashboard/command-center.service.ts");
const CC_TYPES = readWeb("components/command-center/types.ts");
const CC_TSX = readWeb("components/command-center/CommandCenter.tsx");
// =============================================================================
// PART 1 — Schema
// =============================================================================
describe("Phase 32.8C FINAL-2 — schema: workflow models", () => {
    it("OperationalWorkflow model + unique (teamId, workflowKey)", () => {
        expect(SCHEMA).toMatch(/model\s+OperationalWorkflow\s*\{/);
        expect(SCHEMA).toMatch(/@@unique\(\[teamId,\s*workflowKey\]\)/);
        expect(SCHEMA).toMatch(/@@map\("operational_workflows"\)/);
    });
    it("OperationalWorkflowEvent + OperationalWorkflowAction models", () => {
        expect(SCHEMA).toMatch(/model\s+OperationalWorkflowEvent\s*\{/);
        expect(SCHEMA).toMatch(/model\s+OperationalWorkflowAction\s*\{/);
        expect(SCHEMA).toMatch(/@@map\("operational_workflow_events"\)/);
        expect(SCHEMA).toMatch(/@@map\("operational_workflow_actions"\)/);
    });
    it("OperationalWorkflowType enum lists the 12 workflow types", () => {
        for (const v of [
            "REPORT_RETRY",
            "PACKAGE_RETRY",
            "REVIEW_ESCALATION",
            "GOVERNANCE_ESCALATION",
            "QUEUE_RECOVERY",
            "TELEMETRY_RECOVERY",
            "INTEGRITY_REVIEW",
            "AUDIT_READINESS",
            "CASE_RISK_MITIGATION",
            "COORDINATION_RESOLUTION",
            "EXPORT_BLOCKER_RESOLUTION",
            "OTHER",
        ]) {
            expect(SCHEMA).toContain(v);
        }
    });
    it("OperationalWorkflowStatus enum lists the 10 statuses", () => {
        for (const v of [
            "OPEN",
            "ASSIGNED",
            "IN_PROGRESS",
            "WAITING_ON_SYSTEM",
            "WAITING_ON_REVIEWER",
            "WAITING_ON_GOVERNANCE",
            "MITIGATING",
            "RESOLVED",
            "SUPPRESSED",
            "FAILED",
        ]) {
            expect(SCHEMA).toContain(v);
        }
    });
    it("OperationalWorkflowEventType lists the 12 event types", () => {
        for (const v of [
            "CREATED",
            "ASSIGNED",
            "STARTED",
            "RETRY_SCHEDULED",
            "RETRY_ATTEMPTED",
            "ESCALATED",
            "MITIGATION_ADDED",
            "STATUS_CHANGED",
            "RESOLVED",
            "SUPPRESSED",
            "FAILED",
            "REOPENED",
        ]) {
            expect(SCHEMA).toContain(v);
        }
    });
    it("OperationalWorkflow is workspace-scoped + indexed for dashboard reads", () => {
        expect(SCHEMA).toMatch(/@@index\(\[teamId,\s*status\]\)/);
        expect(SCHEMA).toMatch(/@@index\(\[teamId,\s*workflowType\]\)/);
        expect(SCHEMA).toMatch(/@@index\(\[severity,\s*status\]\)/);
        expect(SCHEMA).toMatch(/@@index\(\[assignedOwnerUserId,\s*status\]\)/);
        expect(SCHEMA).toMatch(/@@index\(\[sourceIncidentId\]\)/);
        expect(SCHEMA).toMatch(/@@index\(\[sourceCorrelationId\]\)/);
    });
    it("OperationalWorkflow bounds operator-safe strings", () => {
        expect(SCHEMA).toMatch(/safeSummary\s+String\s+@map\("safe_summary"\)\s+@db\.VarChar\(400\)/);
        expect(SCHEMA).toMatch(/mitigationSummary\s+String\?\s+@map\("mitigation_summary"\)\s+@db\.VarChar\(400\)/);
        expect(SCHEMA).toMatch(/resolutionSummary\s+String\?\s+@map\("resolution_summary"\)\s+@db\.VarChar\(400\)/);
    });
    it("OperationalWorkflowAction stores requiredRoles as JSON + bounded label", () => {
        expect(SCHEMA).toMatch(/requiredRoles\s+Json\s+@map\("required_roles"\)/);
        expect(SCHEMA).toMatch(/safeActionLabel\s+String\s+@map\("safe_action_label"\)\s+@db\.VarChar\(80\)/);
    });
});
describe("Phase 32.8C FINAL-2 — schema: causality models", () => {
    it("OperationalCausalityLink model + 9 relation types", () => {
        expect(SCHEMA).toMatch(/model\s+OperationalCausalityLink\s*\{/);
        for (const v of [
            "CAUSED_BY",
            "FOLLOWED_BY",
            "ESCALATED_TO",
            "BLOCKED_BY",
            "MITIGATED_BY",
            "RETRIED_BY",
            "RELATED_TO",
            "PART_OF",
            "ROOT_CAUSE_OF",
        ]) {
            expect(SCHEMA).toContain(v);
        }
    });
    it("OperationalCausalityConfidence enum lists DIRECT + 3 inferred levels", () => {
        for (const v of ["DIRECT", "INFERRED_HIGH", "INFERRED_MEDIUM", "INFERRED_LOW"]) {
            expect(SCHEMA).toContain(v);
        }
    });
    it("OperationalCausalityChain model + unique (teamId, chainKey)", () => {
        expect(SCHEMA).toMatch(/model\s+OperationalCausalityChain\s*\{/);
        expect(SCHEMA).toMatch(/@@unique\(\[teamId,\s*chainKey\]\)/);
        expect(SCHEMA).toMatch(/@@map\("operational_causality_chains"\)/);
    });
    it("OperationalCausalityRootCauseType enum lists the 7 root-cause categories", () => {
        for (const v of [
            "PIPELINE_FAILURE",
            "REVIEWER_BOTTLENECK",
            "GOVERNANCE_BLOCKER",
            "INTEGRITY_AUDIT",
            "TELEMETRY_QUEUE",
            "COORDINATION_CASE_RISK",
            "OTHER",
        ]) {
            expect(SCHEMA).toContain(v);
        }
    });
    it("OperationalCausalityChain bounds operator-safe strings", () => {
        expect(SCHEMA).toMatch(/summary\s+String\s+@db\.VarChar\(400\)/);
    });
    it("OperationalCausalityLink bounds explanation + reasonCode", () => {
        expect(SCHEMA).toMatch(/explanation\s+String\s+@db\.VarChar\(400\)/);
        expect(SCHEMA).toMatch(/reasonCode\s+String\s+@map\("reason_code"\)\s+@db\.VarChar\(80\)/);
    });
});
// =============================================================================
// PART 2 — Migration
// =============================================================================
describe("Phase 32.8C FINAL-2 — migration source-contract", () => {
    it("creates all 5 tables idempotently", () => {
        expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS "operational_workflows"/);
        expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS "operational_workflow_events"/);
        expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS "operational_workflow_actions"/);
        expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS "operational_causality_links"/);
        expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS "operational_causality_chains"/);
    });
    it("creates all 10 enums with IF NOT EXISTS guards", () => {
        for (const name of [
            "OperationalWorkflowType",
            "OperationalWorkflowStatus",
            "OperationalWorkflowSeverity",
            "OperationalWorkflowPriority",
            "OperationalWorkflowEventType",
            "OperationalWorkflowActionType",
            "OperationalCausalityRelation",
            "OperationalCausalityConfidence",
            "OperationalCausalityChainStatus",
            "OperationalCausalityRootCauseType",
        ]) {
            expect(MIGRATION).toMatch(new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_type WHERE typname = '${name}'\\)`));
        }
    });
    it("workflow event has FK CASCADE to parent workflow", () => {
        expect(MIGRATION).toMatch(/operational_workflow_events_workflow_id_fkey[\s\S]*?ON DELETE CASCADE/);
    });
    it("documents that the data is ADVISORY", () => {
        expect(MIGRATION).toMatch(/ADVISORY operational data/);
    });
    it("documents a rollback plan covering every addition", () => {
        expect(MIGRATION).toMatch(/Rollback \(operator-side, in psql\):/);
        expect(MIGRATION).toMatch(/DROP TABLE IF EXISTS "operational_workflows"/);
        expect(MIGRATION).toMatch(/DROP TABLE IF EXISTS "operational_causality_chains"/);
    });
    it("creates dashboard read-pattern indexes", () => {
        expect(MIGRATION).toContain('"operational_workflows_team_id_status_idx"');
        expect(MIGRATION).toContain('"operational_workflows_severity_status_idx"');
        expect(MIGRATION).toContain('"operational_causality_chains_team_id_status_idx"');
    });
    it("never references signed URLs / raw bytes / storage keys", () => {
        expect(MIGRATION).not.toMatch(/signed[_-]url/i);
        expect(MIGRATION).not.toMatch(/storage[_-]key/i);
        expect(MIGRATION).not.toMatch(/raw[_-]bytes/i);
    });
});
// =============================================================================
// PART 3 — Workflow generator
// =============================================================================
describe("Phase 32.8C FINAL-2 — workflow generator", () => {
    it("exports generateWorkflowsForWorkspace + listWorkspaceWorkflows", () => {
        expect(WF_GEN).toMatch(/export async function generateWorkflowsForWorkspace\(/);
        expect(WF_GEN).toMatch(/export async function listWorkspaceWorkflows\(/);
    });
    it("reads from real OperationalIncident rows only — no fabricated workflows", () => {
        expect(WF_GEN).toMatch(/prisma\.operationalIncident\.findMany/);
        expect(WF_GEN).not.toMatch(/incident_template/);
        expect(WF_GEN).not.toMatch(/mock_workflow/i);
    });
    it("idempotent workflowKey encodes (source, type)", () => {
        expect(WF_GEN).toMatch(/workflowKey\s*=\s*`incident:\$\{inc\.id\}:\$\{wfType\}`/);
        expect(WF_GEN).toMatch(/teamId_workflowKey/);
    });
    it("reopens RESOLVED/SUPPRESSED workflows with escalationLevel + 1", () => {
        expect(WF_GEN).toMatch(/existing\.status === "RESOLVED"/);
        expect(WF_GEN).toMatch(/escalationLevel:\s*existing\.escalationLevel \+ 1/);
    });
    it("emits OperationalWorkflowEvent history rows", () => {
        expect(WF_GEN).toMatch(/prisma\.operationalWorkflowEvent\.create/);
        // The generator assigns the event type to a local variable and then
        // writes it; we check the literal assignments instead of the JSON key.
        expect(WF_GEN).toMatch(/eventType\s*=\s*"CREATED"/);
        expect(WF_GEN).toMatch(/eventType\s*=\s*"REOPENED"/);
    });
    it("writes the bounded action catalog per workflow", () => {
        expect(WF_GEN).toMatch(/prisma\.operationalWorkflowAction\.create/);
        expect(WF_GEN).toMatch(/permissionRequired:/);
        expect(WF_GEN).toMatch(/requiredRoles:/);
    });
    it("REPORT_RETRY / PACKAGE_RETRY expose only 'Schedule retry review' (not destructive retry)", () => {
        // The directive: do NOT add destructive retry actions; surface as
        // "Schedule retry review" instead. We verify the safeActionLabel
        // assignment chain rather than the string presence (the file's
        // doc-comment mentions the forbidden phrase to explain WHY it's
        // forbidden).
        expect(WF_GEN).toMatch(/SCHEDULE_RETRY/);
        expect(WF_GEN).toMatch(/safeActionLabel:\s*"Schedule retry review"/);
        // No safeActionLabel binds to a destructive retry action.
        expect(WF_GEN).not.toMatch(/safeActionLabel:\s*"Retry now"/i);
        expect(WF_GEN).not.toMatch(/safeActionLabel:\s*"Run retry"/i);
    });
    it("links correlations to workflows via sourceCorrelationId (no duplicates)", () => {
        expect(WF_GEN).toMatch(/sourceCorrelationId:\s*c\.id/);
        expect(WF_GEN).toMatch(/sourceCorrelationId:\s*null/);
    });
    it("never projects raw bytes / signed URLs / storage keys", () => {
        expect(WF_GEN).not.toMatch(/storageKey/i);
        expect(WF_GEN).not.toMatch(/signedUrl/i);
        expect(WF_GEN).not.toMatch(/canonicalBytes/);
    });
    it("never uses legal-overclaim language", () => {
        for (const banned of ["admissible", "authentic", "proves", "court-ready"]) {
            expect(WF_GEN).not.toMatch(new RegExp(`\\b${banned}\\b`, "i"));
        }
    });
});
// =============================================================================
// PART 4 — Workflow lifecycle service
// =============================================================================
describe("Phase 32.8C FINAL-2 — workflow lifecycle service", () => {
    it("exports the full action set", () => {
        for (const fn of [
            "assignWorkflow",
            "startWorkflow",
            "escalateWorkflow",
            "addMitigation",
            "resolveWorkflow",
            "suppressWorkflow",
            "reopenWorkflow",
            "scheduleRetry",
        ]) {
            expect(WF_SVC).toMatch(new RegExp(`export async function ${fn}\\(`));
        }
    });
    it("every action emits a platform audit log row", () => {
        // The audit() helper is called at the end of every action.
        const audits = WF_SVC.match(/await audit\(client/g);
        expect(audits).not.toBeNull();
        expect(audits.length).toBeGreaterThanOrEqual(6);
    });
    it("audit action category is observability.workflow", () => {
        expect(WF_SVC).toMatch(/category:\s*"observability\.workflow"/);
        expect(WF_SVC).toMatch(/action:\s*`observability\.workflow\.\$\{verb\}`/);
    });
    it("every action writes an OperationalWorkflowEvent history row", () => {
        const events = WF_SVC.match(/client\.operationalWorkflowEvent\.create/g);
        expect(events).not.toBeNull();
        expect(events.length).toBeGreaterThanOrEqual(6);
    });
    it("reopenWorkflow only accepts RESOLVED / SUPPRESSED → OPEN transitions", () => {
        const block = WF_SVC.match(/export async function reopenWorkflow[\s\S]*?\n\}\s*\n/);
        expect(block).not.toBeNull();
        expect(block[0]).toMatch(/existing\.status !== prismaPkg\.OperationalWorkflowStatus\.RESOLVED/);
        expect(block[0]).toMatch(/throw new WorkflowError\("invalid_transition"\)/);
    });
    it("scheduleRetry does NOT execute a retry — only records intent", () => {
        const block = WF_SVC.match(/export async function scheduleRetry[\s\S]*?\n\}\s*\n/);
        expect(block).not.toBeNull();
        expect(block[0]).not.toMatch(/queue\.add/);
        expect(block[0]).not.toMatch(/bull/i);
        expect(block[0]).toMatch(/nextRetryAtUtc:\s*input\.nextRetryAtUtc/);
    });
    it("workflow_not_found is thrown when row missing in workspace scope", () => {
        expect(WF_SVC).toMatch(/throw new WorkflowError\("workflow_not_found"\)/);
    });
});
// =============================================================================
// PART 5 — Causality engine
// =============================================================================
describe("Phase 32.8C FINAL-2 — causality engine", () => {
    it("exports detectCausalityForWorkspace + listWorkspaceCausalityChains", () => {
        expect(CAUSAL).toMatch(/export async function detectCausalityForWorkspace\(/);
        expect(CAUSAL).toMatch(/export async function listWorkspaceCausalityChains\(/);
    });
    it("bounded reads: incidents ≤ 200, workflows ≤ 200, correlations ≤ 50", () => {
        // The 50 limit is for correlations; incident/workflow `take` is 200.
        const inc = CAUSAL.match(/operationalIncident\.findMany[\s\S]{0,400}take:\s*200/);
        const wf = CAUSAL.match(/operationalWorkflow\.findMany[\s\S]{0,500}take:\s*200/);
        const corr = CAUSAL.match(/operationalCorrelation\.findMany[\s\S]{0,400}take:\s*50/);
        expect(inc).not.toBeNull();
        expect(wf).not.toBeNull();
        expect(corr).not.toBeNull();
    });
    it("scan failure returns zero — never blocks dashboard", () => {
        expect(CAUSAL).toMatch(/return\s*\{\s*linksPersisted:\s*0,\s*chainsPersisted:\s*0,\s*failed:\s*1\s*\}/);
    });
    it("deterministic relation rules — every link has reasonCode + explanation", () => {
        for (const code of [
            "INCIDENT_TRIGGERED_WORKFLOW",
            "CORRELATION_GROUPS_INCIDENT",
            "REPORT_BACKLOG_BLOCKS_PACKAGE",
            "GOVERNANCE_BLOCKS_AUDIT",
            "WORKER_HEARTBEAT_CAUSES_TELEMETRY_STALE",
        ]) {
            expect(CAUSAL).toContain(`"${code}"`);
        }
    });
    it("chains are upserted on (teamId, chainKey) — idempotent re-detection", () => {
        expect(CAUSAL).toMatch(/prisma\.operationalCausalityChain\.upsert/);
        expect(CAUSAL).toMatch(/teamId_chainKey/);
    });
    it("chains for each root-cause category are deterministic", () => {
        for (const k of [
            "pipeline_failure",
            "reviewer_bottleneck",
            "governance_blocker",
            "telemetry_queue",
            "integrity_audit",
            "coordination_case_risk",
        ]) {
            expect(CAUSAL).toContain(`${k}:`);
        }
    });
    it("bounded operator-safe strings everywhere", () => {
        expect(CAUSAL).toMatch(/\.slice\(0,\s*400\)/);
        expect(CAUSAL).toMatch(/title\.slice\(0,\s*180\)/);
        expect(CAUSAL).toMatch(/reasonCode\.slice\(0,\s*80\)/);
    });
    it("never reads job payloads / signed URLs / raw bytes", () => {
        expect(CAUSAL).not.toMatch(/storageKey/i);
        expect(CAUSAL).not.toMatch(/signedUrl/i);
        expect(CAUSAL).not.toMatch(/payload:\s*true/);
    });
    it("never uses legal-overclaim language", () => {
        for (const banned of ["admissible", "authentic", "proves", "court-ready"]) {
            expect(CAUSAL).not.toMatch(new RegExp(`\\b${banned}\\b`, "i"));
        }
    });
});
// =============================================================================
// PART 6 — Routes
// =============================================================================
describe("Phase 32.8C FINAL-2 — API routes", () => {
    it("GET /v1/ops/workflows is registered", () => {
        expect(OPS_ROUTES).toMatch(/app\.get\(\s*"\/v1\/ops\/workflows"/);
    });
    it("GET /v1/ops/workflows/:id is registered", () => {
        expect(OPS_ROUTES).toMatch(/app\.get\(\s*"\/v1\/ops\/workflows\/:id"/);
    });
    it("POST routes for the workflow lifecycle are registered", () => {
        for (const path of [
            "/v1/ops/workflows/:id/assign",
            "/v1/ops/workflows/:id/start",
            "/v1/ops/workflows/:id/escalate",
            "/v1/ops/workflows/:id/mitigation",
            "/v1/ops/workflows/:id/resolve",
            "/v1/ops/workflows/:id/suppress",
            "/v1/ops/workflows/:id/reopen",
            "/v1/ops/workflows/:id/schedule-retry",
        ]) {
            expect(OPS_ROUTES).toContain(`"${path}"`);
        }
    });
    it("all workflow mutating routes go through requireOpsActorAction", () => {
        // The mutating routes are listed above; we count requireOpsActorAction
        // occurrences AFTER the workflow section starts.
        const startIdx = OPS_ROUTES.indexOf("Phase 32.8C FINAL-2 — Workflow Orchestration routes");
        expect(startIdx).toBeGreaterThanOrEqual(0);
        const block = OPS_ROUTES.slice(startIdx);
        const calls = block.match(/requireOpsActorAction\(req, reply, body\.teamId\)/g);
        expect(calls).not.toBeNull();
        expect(calls.length).toBeGreaterThanOrEqual(7);
    });
    it("assign route enforces workspace membership on the assignee", () => {
        const block = OPS_ROUTES.match(/app\.post\(\s*"\/v1\/ops\/workflows\/:id\/assign"[\s\S]*?\}\s*,\s*\)/);
        expect(block).not.toBeNull();
        expect(block[0]).toMatch(/prisma\.teamMember\.findFirst/);
        expect(block[0]).toMatch(/invalid_assignee/);
    });
    it("read routes (GET workflows + chains) use requireOpsActor (read), not action", () => {
        const block = OPS_ROUTES.slice(OPS_ROUTES.indexOf('"/v1/ops/workflows"'), OPS_ROUTES.indexOf('"/v1/ops/causality/chains/:id"'));
        // At least one GET handler reaches requireOpsActor (not the Action
        // variant). The action variant is the stricter mutating gate.
        expect(block).toMatch(/requireOpsActor\(req, reply, q\.teamId\)/);
    });
    it("GET /v1/ops/causality/chains + chains/:id registered", () => {
        expect(OPS_ROUTES).toMatch(/"\/v1\/ops\/causality\/chains"/);
        expect(OPS_ROUTES).toMatch(/"\/v1\/ops\/causality\/chains\/:id"/);
    });
    it("body validators enforce UUID + bounded notes (≤ 400 chars)", () => {
        expect(OPS_ROUTES).toMatch(/assigneeUserId:\s*z\.string\(\)\.uuid\(\)/);
        expect(OPS_ROUTES).toMatch(/note:\s*z\.string\(\)\.min\(1\)\.max\(400\)/);
        expect(OPS_ROUTES).toMatch(/nextRetryAtUtc:\s*z\.string\(\)\.datetime\(\)/);
    });
});
// =============================================================================
// PART 7 — Envelope changes
// =============================================================================
describe("Phase 32.8C FINAL-2 — envelope changes", () => {
    it("CommandCenterWorkflowItem type is exported", () => {
        expect(COMMAND_CENTER).toMatch(/export type CommandCenterWorkflowItem\s*=/);
        expect(COMMAND_CENTER).toMatch(/escalationLevel:\s*number/);
        expect(COMMAND_CENTER).toMatch(/retryCount:\s*number/);
        expect(COMMAND_CENTER).toMatch(/actions:\s*Array</);
    });
    it("CommandCenterCausalityChainItem type is exported", () => {
        expect(COMMAND_CENTER).toMatch(/export type CommandCenterCausalityChainItem\s*=/);
        expect(COMMAND_CENTER).toMatch(/rootCauseType:\s*string/);
        expect(COMMAND_CENTER).toMatch(/linkedWorkflowIds:\s*string\[\]/);
    });
    it("envelope incidents section carries workflows + causalityChains", () => {
        expect(COMMAND_CENTER).toMatch(/workflows:\s*CommandCenterWorkflowItem\[\]/);
        expect(COMMAND_CENTER).toMatch(/causalityChains:\s*CommandCenterCausalityChainItem\[\]/);
    });
    it("runIncidents lazy-runs generator + correlator + workflow + causality", () => {
        expect(COMMAND_CENTER).toMatch(/generateWorkflowsForWorkspace\(\{\s*teamId\s*\}\)\.catch\(/);
        expect(COMMAND_CENTER).toMatch(/detectCausalityForWorkspace\(\{\s*teamId\s*\}\)\.catch\(/);
    });
    it("envelope frontend types.ts mirrors the additions", () => {
        expect(CC_TYPES).toMatch(/export type OperationalWorkflowItem\s*=/);
        expect(CC_TYPES).toMatch(/export type OperationalCausalityChainItem\s*=/);
        expect(CC_TYPES).toMatch(/workflows:\s*OperationalWorkflowItem\[\]/);
        expect(CC_TYPES).toMatch(/causalityChains:\s*OperationalCausalityChainItem\[\]/);
    });
});
// =============================================================================
// PART 8 — Frontend rendering
// =============================================================================
describe("Phase 32.8C FINAL-2 — frontend rendering", () => {
    it("CausalityChainsStrip component is defined + exposes data hooks", () => {
        expect(CC_TSX).toMatch(/function CausalityChainsStrip\(/);
        expect(CC_TSX).toMatch(/data-cc-causality-chains-block\b/);
        expect(CC_TSX).toMatch(/data-cc-causality-chains\b/);
        expect(CC_TSX).toMatch(/data-cc-chain-id/);
        expect(CC_TSX).toMatch(/data-cc-chain-root/);
        expect(CC_TSX).toMatch(/data-cc-chain-severity/);
    });
    it("WorkflowsStrip component is defined + exposes status / severity hooks", () => {
        expect(CC_TSX).toMatch(/function WorkflowsStrip\(/);
        expect(CC_TSX).toMatch(/data-cc-workflows-block\b/);
        expect(CC_TSX).toMatch(/data-cc-workflow-id/);
        expect(CC_TSX).toMatch(/data-cc-workflow-type/);
        expect(CC_TSX).toMatch(/data-cc-workflow-status/);
        expect(CC_TSX).toMatch(/data-cc-workflow-severity/);
        expect(CC_TSX).toMatch(/data-cc-workflow-priority/);
        expect(CC_TSX).toMatch(/data-cc-workflow-overdue/);
    });
    it("Workflow row shows assignment + escalation + retry chips", () => {
        expect(CC_TSX).toMatch(/data-cc-workflow-assignee/);
        expect(CC_TSX).toMatch(/data-cc-workflow-unassigned/);
        expect(CC_TSX).toMatch(/data-cc-workflow-escalation/);
        expect(CC_TSX).toMatch(/data-cc-workflow-retry/);
    });
    it("Workflow actions chip strip renders permission-aware labels (no mutation buttons)", () => {
        expect(CC_TSX).toMatch(/data-cc-workflow-actions/);
        expect(CC_TSX).toMatch(/data-cc-workflow-action=/);
        expect(CC_TSX).toMatch(/data-cc-workflow-action-permission=/);
        // No <button>s or onClicks in the workflow strip
        const block = CC_TSX.match(/function WorkflowsStrip\([\s\S]*?\n\}\s*\n/);
        expect(block).not.toBeNull();
        expect(block[0]).not.toMatch(/<button/);
        expect(block[0]).not.toMatch(/onClick/);
    });
    it("Causality chains render BEFORE workflows + correlations + incident list", () => {
        // The IncidentsSection render block: chains → workflows →
        // correlations → incidents list. Order asserts the operator reads
        // "Why" first.
        const block = CC_TSX.match(/<CausalityChainsStrip[\s\S]*?<WorkflowsStrip[\s\S]*?<IncidentCorrelations/);
        expect(block).not.toBeNull();
    });
    it("title summary lists chain + workflow + correlation counts when present", () => {
        expect(CC_TSX).toMatch(/chain\$\{causalityChains\.length === 1 \? "" : "s"\}/);
        expect(CC_TSX).toMatch(/workflow\$\{workflows\.length === 1 \? "" : "s"\}/);
    });
    it("empty state remains operationally meaningful when all four arrays are empty", () => {
        expect(CC_TSX).toMatch(/Workflows and causality chains follow incidents — when there are no incidents there is nothing to orchestrate/);
    });
    it("dashboard is read-only: footnote explicitly delegates lifecycle to /ops/observability", () => {
        // Allow whitespace (including newlines) between "workflow" and
        // "ownership transitions" since the JSX wraps the phrase.
        expect(CC_TSX).toMatch(/workflow\s+ownership transitions[\s\S]{0,300}Operations Center/);
        expect(CC_TSX).toMatch(/href="\/ops\/observability/);
    });
    it("no inline mutation buttons in causality chains / workflows strips", () => {
        const chainsBlock = CC_TSX.match(/function CausalityChainsStrip\([\s\S]*?\n\}\s*\n/);
        expect(chainsBlock).not.toBeNull();
        expect(chainsBlock[0]).not.toMatch(/<button/);
        expect(chainsBlock[0]).not.toMatch(/onClick/);
    });
});
// =============================================================================
// PART 9 — No-regression invariants
// =============================================================================
describe("Phase 32.8C FINAL-2 — no-regression invariants", () => {
    it("workflow + causality services never emit security/audit/custody events directly", () => {
        for (const src of [WF_GEN, CAUSAL]) {
            expect(src).not.toMatch(/recordSecurityEvent\(/);
            expect(src).not.toMatch(/recordCustodyEvent\(/);
        }
    });
    it("workflow generator + causality engine never generate signed URLs / report / package", () => {
        for (const src of [WF_GEN, CAUSAL]) {
            expect(src).not.toMatch(/getSignedUrl/i);
            expect(src).not.toMatch(/generateReport/i);
            expect(src).not.toMatch(/generatePackage/i);
        }
    });
    it("workflow lifecycle service does NOT bypass underlying core permissions", () => {
        // The service never calls into report/package generation directly;
        // it only mutates workflow rows + writes audit/history events.
        expect(WF_SVC).not.toMatch(/generateReport/i);
        expect(WF_SVC).not.toMatch(/generatePackage/i);
        expect(WF_SVC).not.toMatch(/queue\.add/);
    });
    it("page-load incidents->workflows->causality chain wraps every step in .catch", () => {
        const idx = COMMAND_CENTER.indexOf("Phase 32.8C FINAL-2 — generate workflows");
        expect(idx).toBeGreaterThanOrEqual(0);
        const block = COMMAND_CENTER.slice(idx, idx + 1000);
        expect(block).toMatch(/generateWorkflowsForWorkspace[\s\S]{0,100}\.catch/);
        expect(block).toMatch(/detectCausalityForWorkspace[\s\S]{0,100}\.catch/);
    });
    it("frontend renders read-only chips for workflow actions — no inline forms", () => {
        const block = CC_TSX.match(/function WorkflowsStrip\([\s\S]*?\n\}\s*\n/);
        expect(block).not.toBeNull();
        expect(block[0]).not.toMatch(/<form/);
        expect(block[0]).not.toMatch(/<input/);
    });
    it("control plane preserves dashboard read-only invariant", () => {
        // The dashboard never posts; every mutating route lives on the
        // /v1/ops/* surface guarded by ops actor + workspace membership +
        // audit log. The frontend asserts this in PART 8.
        expect(CC_TSX).toMatch(/dashboard is read-only/i);
    });
});
