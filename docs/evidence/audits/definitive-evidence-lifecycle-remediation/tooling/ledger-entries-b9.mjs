// Authoring helper, batch 9: queues (ET-Q-03..06, -08..10). Idempotent.
// ET-Q-07 is NOT authored: its remaining half (keep-and-wire vs retire the five
// producer-less queues) is an owner decision; it stays STILL_PRESENT.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));

const T = (f) => `services/api/test/${f}`;
const JEC = "services/worker/test/job-event-context.test.ts";

Object.assign(L.findings, {
  "ET-Q-03": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Several media-intelligence run kinds (perceptual hashes, technical metadata, text similarity, reserved, scope mismatch) never touched their run row, which stayed PENDING with attempt_count 0 and was re-enqueued forever.",
    canonicalAuthority: "shared-runtime run tracker (markRunProcessing / fenced markRunCompleted / markRunFailed) via media-intelligence.processor settleRunAround + refuseRun",
    redTest: `${T("point5/family-intelligence-operations.integration.test.ts")} [ET-Q-03] (evidence/ET-Q-03-red-baseline.txt)`,
    greenTest: `${T("point5/family-intelligence-operations.integration.test.ts")} [ET-Q-03: COMPLETED; FAILED kind_not_implemented / evidence_scope_mismatch]`,
  },
  "ET-Q-04": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "A RENDERING derivative after a transient error or crash was never reclaimable: the retry's claim required QUEUED, the reconciler scanned QUEUED, and the registry's 20-minute lease was implemented nowhere.",
    canonicalAuthority: "redaction-derivative-writer: claimDerivativeForRender (QUEUED or lease-expired RENDERING, REDACTION_RENDER_LEASE_MS from the registry), releaseDerivativeClaim; reconciler lists lease-expired RENDERING",
    redTest: `${T("point5/family-redaction.integration.test.ts")} [ET-Q-04] (evidence/ET-Q-04-red-baseline.txt)`,
    greenTest: `${T("point5/family-redaction.integration.test.ts")} [ET-Q-04: stale taken over, live not stolen, transient releases]`,
    concurrencyTest: `${T("point5/family-redaction.integration.test.ts")} [a live RENDERING claim is not stolen]`,
  },
  "ET-Q-05": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The trash-grace candidate query re-read the same oldest 200 rows every tick, so blocked rows starved eligible ones; the purge job's BLOCKED reschedule collapsed onto itself.",
    canonicalAuthority: "worker_sweep_cursors keyset cursor (trash-grace, wraps at the end); enqueueWork/enqueueEvidencePurgeJob selfJobId",
    redTest: `${T("point5/family-trash-grace.integration.test.ts")} [ET-Q-05] (evidence/ET-Q-05-red-baseline.txt)`,
    greenTest: `${T("point5/family-trash-grace.integration.test.ts")} [ET-Q-05: next tick passes the blocked rows; dry run does not move the cursor]`,
    migrationImpact: "20280809000000_worker_sweep_cursors: one new table (EXPAND); read/write fail-open",
  },
  "ET-Q-06": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "14 of 15 BullMQ workers autorun at import and 4 claiming sweeps started at top level, before secrets, signer and Object Lock bootstrap.",
    canonicalAuthority: "services/worker/src/index.ts startConsumers() — every Worker autorun:false; called once after bootstrapObjectLockVerification",
    redTest: "services/worker/test/worker-bootstrap-hotfix.test.ts [ET-Q-06] (evidence/ET-Q-06-red-baseline.txt)",
    greenTest: "services/worker/test/worker-bootstrap-hotfix.test.ts [ET-Q-06: all autorun off, one .run() site, one call after storage bootstrap]",
  },
  "ET-Q-08": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The report DLQ recorded still-retrying requests with raw stacks, and media-intelligence-dlq was a phantom sink never written.",
    canonicalAuthority: "report DLQ written only by the terminal (non-retriable) branch with a bounded code; media-intelligence DLQ written on a job's final attempt (job-event-context isFinalAttempt / boundedErrorCode)",
    redTest: `${JEC} [ET-Q-08] (evidence/ET-Q-08-red-baseline.txt)`,
    greenTest: JEC,
  },
  "ET-Q-09": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Job event logs read a payload evidenceId the canonical payload never carries; OTS pending-retry classification keyed on an error no longer thrown; malformed payloads were retried for the full budget.",
    canonicalAuthority: "services/worker/src/job-event-context.ts (jobCommandId, isExpectedOtsPendingError); UnprocessableJobPayload extends BullMQ UnrecoverableError",
    redTest: `${JEC} [ET-Q-09] (evidence/ET-Q-09-red-baseline.txt)`,
    greenTest: JEC,
  },
  "ET-Q-10": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The embed-owed reconciler selected the legacy `embedding` column nothing writes, so every chunk in the window was owed forever regardless of AI policy.",
    canonicalAuthority: "intelligence-run-reconciler selectChunksOwingEmbedding (embedding_vector IS NULL, AI policy allows embeddings)",
    redTest: `${T("embed-owed-predicate.integration.test.ts")} (evidence/ET-Q-10-red-baseline.txt)`,
    greenTest: T("embed-owed-predicate.integration.test.ts"),
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
