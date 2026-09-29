// Authoring helper, batch 2: OTS ladder, provider ordering, intake lifecycle.
// Idempotent; the authored text is reviewable in the repository.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));
const LADDER = "services/api/test/ots-upgrade-ladder.integration.test.ts";
const INTAKE = "services/api/test/intake-lifecycle-remediation.integration.test.ts";

Object.assign(L.findings, {
  "ET-OTS-01": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The init branch enqueued its follow-up without selfJobId from inside the job whose id is the canonical ots-upgrade-<id>, so the enqueue collapsed onto the running job.",
    canonicalAuthority: "enqueueCanonicalJob (packages/shared/src/queue-integrity/enqueue.ts) with selfJobId at every processor call site",
    redTest: "services/worker/test/ots-followup-selfjobid.test.ts on a40ca76f (evidence/ots-red-baseline.txt: the init call lacked selfJobId)",
    greenTest: `services/worker/test/ots-followup-selfjobid.test.ts; ${LADDER} [ET-OTS-01 contract]`,
  },
  "ET-OTS-02": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The derived follow-up id recurred every other hop; BullMQ silently ignored an add whose id belonged to a retained completed job, so the ladder died on hop 3 while reporting enqueued.",
    canonicalAuthority: "enqueueCanonicalJob treats the derived id (selfFollowUpJobId) like the base id: joins it only while live, releases it otherwise",
    redTest: `${LADDER} [ET-OTS-02] on a40ca76f: 'expected 3 to be 8' (evidence/ots-red-baseline.txt)`,
    greenTest: `${LADDER} [ET-OTS-02: 8 of 8 hops]; phase-12-point5-queue-integrity-gate.test.ts ET-OTS-02 unit cases`,
    concurrencyTest: `${LADDER} (real BullMQ, one worker, self-rescheduling ladder)`,
  },
  "ET-OTS-03": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Only never-attempted (NULL status) rows were reconciled; a PENDING proof whose ladder was lost stayed PENDING forever.",
    canonicalAuthority: "runOtsInitializationReconciler second scan (pendingWithoutProgressWhere + isOtsUpgradeScheduled over both ladder ids): re-schedule once, never a parallel ladder",
    redTest: "no baseline red: the scan did not exist; defect source-proven in the audit",
    greenTest: "services/worker/test/ots-pending-recovery.integration.test.ts (live PostgreSQL + loopback Redis)",
    concurrencyTest: "same test: a second sweep leaves exactly one scheduled job",
    compatibilityImpact: "reconciler result gains pendingScanned / pendingAlreadyScheduled / pendingRescheduled; aged-pending guidance names the recovery sweep",
  },
  "ET-COM-01": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The Stripe reconciliation stamped providerStateAtUtc with the future current_period_end, so every later webhook compared as older and was refused.",
    canonicalAuthority: "stripe.provider observeSubscription stamps the provider read time; decideSubscriptionStatusWrite and isNotStale treat a future stamp as absent",
    redTest: "services/api/test/billing-subscription-status.test.ts [ET-COM-01] on a40ca76f: apply:false (evidence/com01-red-baseline.txt)",
    greenTest: "services/api/test/billing-subscription-status.test.ts [ET-COM-01]; services/api/test/billing-stripe-observation-ordering.test.ts",
    migrationImpact: "none: poisoned rows (future stamps) are treated as having no ordering information and heal on their next applied fact",
    remainingExternalProof: null,
  },
  "ET-INT-01": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The public /transition route allowed SUBMITTED, which consumed and expired one-time links without finalizing.",
    canonicalAuthority: "SUBMITTED only via /submit (submitExternalIntake -> completeEvidence); /transition is a typed 410 compatibility tombstone",
    obsoleteRemoved: "the /transition handler body, its TransitionBody schema and its catch-all",
    redTest: "audit runtime proof RT-INTAKE on a40ca76f (200, link EXPIRED, session SUBMITTED with no evidence)",
    greenTest: `${INTAKE} [ET-INT-01]`,
    compatibilityImpact: "POST .../transition answers 410 INTAKE_SESSION_TRANSITION_RETIRED (no first-party caller existed)",
  },
  "ET-INT-02": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The part row is reserved before the PUT, a retry of the index was refused, and completion's missing-object 404 was classified as a workspace refusal.",
    canonicalAuthority: "writeEvidencePart RETURN_EXISTING for a same-file retry of an unfinished index; submit maps missing objects to PART_NOT_UPLOADED; the intake page retries at the same index",
    redTest: "no baseline red recorded; defect source-proven in the audit",
    greenTest: "services/api/test/intake-part-retry.integration.test.ts",
    compatibilityImpact: "new public code PART_NOT_UPLOADED (409); the intake page shows 'Retry upload'",
  },
  "ET-INT-03": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Every allowance count included CREATED/UPLOADING rows of any age, and nothing released them.",
    canonicalAuthority: "countedEvidenceRecordWhere (services/evidence/evidence-record-counting.ts): established records + reservations younger than 24h, used by admission, settlement and all billing meters",
    redTest: "audit runtime proof RT-INTAKE on a40ca76f (anonymous never-submitted session -> owner refused 409)",
    greenTest: `${INTAKE} [ET-INT-03 / ET-ACQ-02]`,
    compatibilityImpact: "billing meters stop counting abandoned drafts older than 24h",
  },
  "ET-INT-04": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Follow-up links were recorded only on an event payload; the linker and the external view resolved requests by the request pointer alone.",
    canonicalAuthority: "resolveEvidenceRequestIdForIntakeLink (request pointer, else the append-only NEEDS_MORE_INFO event naming the follow-up link)",
    redTest: "no baseline red recorded; defect source-proven in the audit",
    greenTest: `${INTAKE} [ET-INT-04]`,
  },
  "ET-ACQ-02": {
    disposition: "PARTIALLY_FIXED",
    rootCause: "Interrupted captures leave CREATED/UPLOADING rows forever; they counted against caps and are never reaped.",
    canonicalAuthority: "counting: countedEvidenceRecordWhere (done); reaping of expired reservations and their objects: not yet implemented",
    greenTest: `${INTAKE} [ET-INT-03 / ET-ACQ-02] (counting only)`,
    finalResult: "OPEN — reaper for expired reservations and orphan objects still required",
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
