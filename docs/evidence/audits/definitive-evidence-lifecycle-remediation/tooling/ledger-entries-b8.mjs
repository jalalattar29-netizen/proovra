// Authoring helper, batch 8: reports / recovery (ET-RPT-01..07, -09; ET-REC-01..11). Idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));

const T = (f) => `services/api/test/${f}`;
const RB = T("reports-blocked-update-failed.integration.test.ts");
const OTS = T("operations-ots-remediation-truth.integration.test.ts");
const RECOVERY = T("point5/report-package-recovery.integration.test.ts");

Object.assign(L.findings, {
  "ET-RPT-01": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "A failed updated-report request on a record with a report was classified READY only; no card or filter found the failure the row's Retry/escalation signalled.",
    canonicalAuthority: "reports-aggregator classifyWorkspaceOutputs reportUpdateFailed (READY + latest report request failed) → reportsUpdateFailed card, report_update_failed filter, row report.updateFailed",
    redTest: `${RB} (evidence/ET-RPT-01-02-04-05-06-red-baseline.txt)`,
    greenTest: `${RB} [ET-RPT-01]; ${T("reports-summary-filter-parity.integration.test.ts")} (tile = filter total); apps/web/__tests__/reports-lifecycle-deep-link.test.ts; apps/mobile/test/reports.test.mjs`,
    compatibilityImpact: "additive summary field + filter; web/mobile feature-detect them (web deploys before the API)",
  },
  "ET-RPT-02": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Request-level BLOCKED was in no report bucket and read 'not requested'; the package row read 'not requested' unless the gate metadata flag was set while its tile counted it blocked.",
    canonicalAuthority: "toReportLifecycle/toPackageLifecycle: canonical BLOCKED → 'blocked' (server, web fallback, mobile fallback); reportsBlocked card + report_blocked filter",
    obsoleteRemoved: "the case-workspace route's hand-kept lifecycle enum (derived from REPORT_LIFECYCLE_FILTERS)",
    redTest: `${RB} (evidence/ET-RPT-01-02-04-05-06-red-baseline.txt: 'not_requested' to be 'blocked')`,
    greenTest: `${RB} [ET-RPT-02: every row the Packages blocked card opens says blocked]; apps/mobile/test/reports.test.mjs`,
  },
  "ET-RPT-03": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The report's only legal-hold row printed the inert S3 object-lock legal-hold header (default OFF) and never read the canonical hold.",
    canonicalAuthority: "worker finalized report path: evaluateEffectiveLegalHold → ReportRecordLegalHold (ACTIVE/NONE/UNAVAILABLE) → reportLegalHoldLabel; storage header its own 'Storage Object Lock legal hold' row",
    redTest: "services/worker/test/report-legal-hold-truth.test.ts (evidence/ET-RPT-03-red-baseline.txt)",
    greenTest: "services/worker/test/report-legal-hold-truth.test.ts",
  },
  "ET-RPT-04": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "A failed batched facts read gave every row NONE/PERMISSION_DENIED ('Needs permission') while the section said ok and polling stopped.",
    canonicalAuthority: "shared OUTPUT_ACTION_UNAVAILABLE_REASONS ACTIONS_UNAVAILABLE (+ copy); aggregator: degraded section, 15 s poll",
    redTest: `${RB} (evidence/ET-RPT-01-02-04-05-06-red-baseline.txt: 'ok' to be 'degraded')`,
    greenTest: `${RB} [ET-RPT-04]`,
  },
  "ET-RPT-05": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The summary started 'unavailable' (shown during load) and on the user-scoped fallback said 'temporarily unavailable' forever.",
    canonicalAuthority: "ReportsIndex summaryAnswered (loading phase) + fallback-view notice",
    redTest: "apps/web/__tests__/reports-lifecycle-deep-link.test.ts [ET-RPT-05/06] (evidence/ET-RPT-01-02-04-05-06-red-baseline.txt)",
    greenTest: "apps/web/__tests__/reports-lifecycle-deep-link.test.ts",
  },
  "ET-RPT-06": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The Reports row discarded readGenerationOutcome().tone and styled every outcome success-green.",
    canonicalAuthority: "readGenerationOutcome tone → app-status-text data-tone (GENERATION_OUTCOME_STATUS_TONE)",
    redTest: "apps/web/__tests__/reports-lifecycle-deep-link.test.ts [ET-RPT-05/06]",
    greenTest: "apps/web/__tests__/reports-lifecycle-deep-link.test.ts",
  },
  "ET-RPT-07": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "A succeeded request recorded the newest report as its result with code 'generated', whatever the run produced or targeted.",
    canonicalAuthority: "worker runReportGeneration → ReportRunResult (generated / package_built / pair_complete / already_issued) → resultReportId = that (evidence, version) row",
    redTest: `${RECOVERY} [EXACT VERSION, pair-complete retry] (evidence/ET-RPT-07-red-baseline.txt)`,
    greenTest: RECOVERY,
  },
  "ET-RPT-09": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The executive conclusion said 'finalized supporting publication materials' for an OTS anchor not checked against the chain.",
    canonicalAuthority: "truth-model buildExecutiveConclusion reads the bitcoin_anchoring signal's ANCHORED_NOT_CHECKED claim (OTS_ANCHOR_CLAIM_LABELS); scoring unchanged",
    redTest: "services/worker/test/report-anchoring-conclusion.test.ts (evidence/ET-RPT-09-red-baseline.txt)",
    greenTest: "services/worker/test/report-anchoring-conclusion.test.ts",
  },
  "ET-REC-01": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "requestEvidenceOtsAnchoring ignored enqueue's { enqueued: true, collapsed: true }, so a collapse answered QUEUED with a success audit.",
    canonicalAuthority: "ots-anchoring-authority: collapsed → { requested: false, reason: 'collapsed' } → executor ALREADY_IN_PROGRESS",
    redTest: `${OTS} [ET-REC-01] (evidence/ET-REC-01-02-06-red-baseline.txt)`,
    greenTest: `${OTS} [ET-REC-01]`,
  },
  "ET-REC-02": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The OTS:<id>:GLOBAL_BUDGET_EXHAUSTED incident was NOT_APPLICABLE to its probe forever and carried false WORKER guidance with no action.",
    canonicalAuthority: "shared parseOtsBudgetExhaustedFingerprint: the OTS probe resolves it when otsStatus leaves FAILED; entryForIncident routes it to the ots_failure entry",
    redTest: `${OTS} [ET-REC-02] (evidence/ET-REC-01-02-06-red-baseline.txt)`,
    greenTest: `${OTS} [ET-REC-02: offered Resume; stays open while failing; resolves when anchored]`,
  },
  "ET-REC-03": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The output facts set workspaceResolved from team_id alone, withdrawing Generate/Recover/Retry for team_id-NULL Personal records the writer and worker accept.",
    canonicalAuthority: "@proovra/shared-runtime resolveEvidenceWorkspaceIds (batched; resolveEvidenceWorkspaceId delegates) used by loadEvidenceOutputFacts",
    obsoleteRemoved: "the operator path's local workspace compensation in requestOutputRecovery",
    redTest: `${T("output-facts-null-team-workspace.integration.test.ts")} (evidence/ET-REC-03-red-baseline.txt)`,
    greenTest: `${T("output-facts-null-team-workspace.integration.test.ts")}; ${T("artifact-action-contract.integration.test.ts")}`,
  },
  "ET-REC-04": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The mobile parser dropped requiresReason and the remediate call sent no reason (400 remediation_reason_required).",
    canonicalAuthority: "mobile ops-console buildRemediateBody + remediationReasonReady; the inspector collects the reason",
    redTest: "apps/mobile/test/ops-remediation-reason.test.mjs (evidence/ET-REC-04-red-baseline.txt)",
    greenTest: "apps/mobile/test/ops-remediation-reason.test.mjs",
  },
  "ET-REC-05": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Non-2xx remediate answers were a bare { remediation } body the web apiFetch cannot lift, so the server's outcome became 'could not be started'.",
    canonicalAuthority: "ops.routes remediate: non-2xx also sends error { code: remediation_<result>, message, remediation }; operations/page.tsx shows it",
    redTest: `${OTS} [ET-REC-06 envelope] + apps/web/__tests__/operations-remediation-outcome-envelope.test.ts (evidence/ET-REC-05-red-baseline.txt)`,
    greenTest: "apps/web/__tests__/operations-remediation-outcome-envelope.test.ts (real apiFetch)",
  },
  "ET-REC-06": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Resume OTS anchoring was offered and answered QUEUED for a permanently invalid proof the worker skips.",
    canonicalAuthority: "@proovra/shared OTS_PERMANENT_PROOF_FAILURES (worker re-exports); registry drops Resume from the record's facts; executor NOT_ELIGIBLE",
    redTest: `${OTS} [ET-REC-06] (evidence/ET-REC-01-02-06-red-baseline.txt)`,
    greenTest: `${OTS} [ET-REC-06]`,
  },
  "ET-REC-07": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Workspace and platform remediation derived the audit outcome differently (refusals as success; intent-already-met as error).",
    canonicalAuthority: "remediation-registry remediationAuditOutcome (both paths)",
    redTest: `${OTS} [ET-REC-07] + ${T("remediation-audit-outcome.test.ts")} (evidence/ET-REC-07-red-baseline.txt)`,
    greenTest: `${T("remediation-audit-outcome.test.ts")}; ${OTS} [ET-REC-07]`,
  },
  "ET-REC-08": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Queue retry/replay of a GenerateReportJob whose durable request is settled reported success while the worker no-ops.",
    canonicalAuthority: "queue-replay-action settledReportRequestFor (SETTLED_REPORT_REQUEST_STATES) → 409 report_request_settled",
    redTest: `${T("runtime-proof-operations.integration.test.ts")} [ET-REC-08] (evidence/ET-REC-08-red-baseline.txt)`,
    greenTest: `${T("runtime-proof-operations.integration.test.ts")} [ET-REC-08]`,
  },
  "ET-REC-09": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Communications manual retry/cancel wrote no audit and updated by id after a separate read.",
    canonicalAuthority: "communications.routes transitionCommunicationForOperator (conditional updateMany + tenant audit in one transaction)",
    redTest: `${T("communications-retry-audit.integration.test.ts")} (evidence/ET-REC-09-red-baseline.txt)`,
    greenTest: `${T("communications-retry-audit.integration.test.ts")}`,
    concurrencyTest: `${T("communications-retry-audit.integration.test.ts")} [two concurrent cancels: one applies, one audited]`,
  },
  "ET-REC-10": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "BullMQ's per-run exhaustion (attempt 5) opened a 'retry budget exhausted' incident while the durable 12-claim budget kept the request retryable.",
    canonicalAuthority: "one budget: report-generation-authority opens the exhausted incident at FAILED_TERMINAL (REPORT_RECONCILE_MAX_ATTEMPTS)",
    obsoleteRemoved: "the per-run HIGH recordReportFailureIncident in the worker's retry-exhausted DLQ branch",
    redTest: `${RECOVERY} [ET-REC-10] (evidence/ET-REC-10-red-baseline.txt)`,
    greenTest: `${RECOVERY} [ET-REC-10 + D3]`,
  },
  "ET-REC-11": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "EVIDENCE_REPORTED fired per API-side generation request (before any report, keyed by request id) and never for worker first issuance.",
    canonicalAuthority: "automation-triggers detectTimeBasedAutomationTriggers: EVIDENCE_REPORTED detected from issued Report rows (report.issued:<reportId>), workspace by resolveEvidenceWorkspaceIds",
    obsoleteRemoved: "triggerEvidenceReported and its request-time call",
    redTest: `${T("automation-evidence-reported-issued.integration.test.ts")} (evidence/ET-REC-11-red-baseline.txt)`,
    greenTest: `${T("automation-evidence-reported-issued.integration.test.ts")}; ${T("phase-12-arch-005-automation-runtime.integration.test.ts")}`,
    compatibilityImpact: "owner question answered by the product contract ('Report generated'); rules now fire on issuance, up to one sweep interval later",
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
