// Authoring helper, batch 18: the five findings that waited on an owner
// decision (ET-COM-02, ET-COM-04, ET-PKG-07, ET-SM-07, ET-Q-07). Each entry
// states the decision it implements. Idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));

const T = (f) => `services/api/test/${f}`;
const W = (f) => `services/worker/test/${f}`;

Object.assign(L.findings, {
  "ET-COM-02": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause:
      "The plan allowance counted only records with deletedAt null, so moving a record to Trash freed its slot: trash one of three, create a fourth, restore the first, and a FREE account held four. The workspace usage meter additionally spread its predicate over an existing AND key and counted every record in the database; the settlement cursor dropped the predicate the same way.",
    canonicalAuthority:
      "OWNER DECISION: a trashed record keeps its quota slot and its original funding; restore consumes nothing; only governed permanent destruction releases the slot. Implemented as ONE predicate, shared-runtime evidence-reservation allowanceSlotEvidenceWhere (counted reservation AND not DESTROYED AND (live OR TRASHED / PENDING_DESTRUCTION)), used by every count in billing-enforcement, the workspace usage meter and the billing account projection (recordsInTrash). Copy from one shared module (evidence-trash-copy) on web and mobile.",
    obsoleteRemoved:
      "the deletedAt-null allowance count; the spread-over-AND compositions in the usage meter and the settlement cursor (now AND: [a, b], with a source guard)",
    redTest: `${T("trash-keeps-allowance-slot.integration.test.ts")} (evidence/ET-COM-02-red-baseline.txt)`,
    greenTest: `${T("trash-keeps-allowance-slot.integration.test.ts")}; ${T("billing-personal-funding-boundary.integration.test.ts")}; ${T("reservation-authority.test.ts")}; packages/shared/tests/plan-lapse-and-trash-copy.test.mjs`,
    concurrencyTest: `${T("trash-keeps-allowance-slot.integration.test.ts")} — "concurrent trash and create at 3/3: the create is refused whichever commits first"; "concurrent create and restore with one of three trashed: never a fourth record"`,
    migrationImpact: "none",
    compatibilityImpact:
      "An account that used Trash to exceed its allowance now reads over its limit and cannot create until it destroys records or upgrades; nothing existing is removed. Billing, Home and the Evidence library read the same count.",
  },
  "ET-COM-04": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause:
      "A lapsed paid subscription was treated like a security suspension: evidence creation was refused outright (402) even under the Free allowance and even with valid prepaid credits, and the worker re-derived output entitlement from the live plan, so a record finalized while PRO lost its report after the lapse and counted as unfunded owed backlog.",
    canonicalAuthority:
      "OWNER DECISION: a billing lapse is not a security suspension. A lapsed Personal account creates under the FREE-equivalent policy and may spend valid prepaid credits; existing evidence and outputs earned while paid stay available; a security suspension stays fail-closed. billing-enforcement evidenceCreationScope (lapsed personal -> FREE scope, shared unchanged) with refusal PLAN_LAPSED_ALLOWANCE_EXHAUSTED; the output entitlement is a STORED fact written in the completion transaction (evidence.output_earned_plan/basis/at_utc, shared-billing readOutputEarnedFact / resolveOutputIssuanceEntitlement basis EARNED_AT_FINALIZATION) that the worker and every owed-output aggregator read; Billing projection evidenceAdmission.planLapse with one shared copy module (plan-lapse-copy).",
    obsoleteRemoved:
      "the blanket lapsed-plan creation refusal; the worker's live-plan re-derivation of output entitlement for already finalized records",
    redTest: `${T("lapsed-plan-creation-policy.integration.test.ts")} (evidence/ET-COM-04-red-baseline.txt)`,
    greenTest: `${T("lapsed-plan-creation-policy.integration.test.ts")}; ${T("output-issuance-entitlement.test.ts")}; ${W("output-issuance-earned-fact.test.ts")}; ${T("owed-output-backlog-agreement.integration.test.ts")}; packages/shared/tests/plan-lapse-and-trash-copy.test.mjs`,
    negativeAuthTests: `${T("lapsed-plan-creation-policy.integration.test.ts")} — "a SUSPENDED organization is still refused, and owner credits do not open it: the lapse fallback loosens no security gate"; "a lapsed SHARED workspace has no Free-equivalent: creation is still refused with the lifecycle code"`,
    concurrencyTest: `${T("lapsed-plan-creation-policy.integration.test.ts")} — "two lapsed records settling on ONE credit: exactly one is funded, the balance never goes negative"`,
    migrationImpact:
      "20280814000000_evidence_output_earned_fact — three nullable columns on evidence, no backfill (expand).",
    compatibilityImpact:
      "Records finalized before the migration carry no earned fact and are decided by the live entitlement exactly as before. New refusal code PLAN_LAPSED_ALLOWANCE_EXHAUSTED (409) is registered on web and mobile.",
  },
  "ET-PKG-07": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause:
      "Public verification was reachable at /verify/<evidence id>: the record's primary key — which also appears in reports, packages, storage keys and internal URLs — was the public capability, records were PUBLISHED by default at finalization, and there was no expiry, rotation, or way to withdraw one recipient's access.",
    canonicalAuthority:
      "OWNER DECISION: evidence is private by default; a raw id is never a public capability; public verification is granted by opaque, revocable share tokens. shared-runtime verification-share/authority (random pvs_ token, SHA-256 at rest, scoped to one record and one projection, audience, purpose, creator, optional expiry and use limit, revoke, rotate, last-used); API verification-share.service + verification-share.routes (owner controls behind evidence.publish_verify, step-up on first publication, legacy inventory); Public Verify resolves the token (404 unknown, 410 revoked / expired / exhausted) and narrows to the link's projection; reports carry their own REPORT link; completion always writes NOT_PUBLISHED. Legacy id links: bounded 180-day grace for records already published when the migration runs, shown with its end date, owner-revocable, never auto-published.",
    obsoleteRemoved:
      "publication by default at finalization; the evidence-id public link builders in the worker report pipeline, shared anchor.ts, the web Home view-model and library, and the mobile inspector; the report-v2 evidence-id fallback",
    redTest: `${T("verification-share-links.integration.test.ts")} (evidence/ET-PKG-07-red-baseline.txt)`,
    greenTest: `${T("verification-share-links.integration.test.ts")}; ${T("public-verify-privacy-boundaries.integration.test.ts")}; apps/web/__tests__/render/public-verification-links-panel.render.test.tsx; apps/mobile/test/evidence-library.render.test.mjs; e2e/evidence-detail-layout/public-verification-links.spec.ts`,
    negativeAuthTests: `${T("verification-share-links.integration.test.ts")} — "links are bound to their own record and workspace: another tenant can neither see nor manage them"; "a member who can read but not publish is refused; creating the first link on an unpublished record needs step-up"; "a random token, a malformed one and an unknown id are byte-identical 404s"; "guessing tokens is rate limited per client before any lookup"; "a link is necessary, not sufficient: suspending or unpublishing the record closes every link"`,
    concurrencyTest: `${T("verification-share-links.integration.test.ts")} — "a use limit is exact, even under concurrent requests; use count and last-used are recorded"`,
    migrationImpact:
      "20280816000000_verification_share_tokens (table + evidence.legacy_verify_uuid_until_utc, expand); 20280816000001_verification_share_legacy_grace (one-time: +180 days for records PUBLISHED when it runs); 20280816000002_evidence_unpublished_by_default (column default, WAIT_FOR_RUNTIME_CUTOVER).",
    compatibilityImpact:
      "Links and QR codes built from a record id keep working for 180 days for records that were public at migration time, then answer 404; records finalized afterwards are private until the owner creates a link. No token is minted on an owner's behalf. The web shows 'not available yet' against an API that predates the routes.",
  },
  "ET-SM-07": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause:
      "A record's stored bytes were re-hashed only inside the report pipeline, which is commercially gated: a record that never received a report was never re-verified, storage drift on it was invisible, and nothing recorded when — or whether — a record had last been checked, so every surface presented the finalization-time result as current.",
    canonicalAuthority:
      "OWNER DECISION: integrity rechecking is a core commitment for every signed record, not a plan feature. shared-runtime integrity-recheck/authority (eligibility, due rule, claim with a 30-minute lease, recordIntegrityCheckTx, requestIntegrityRecheck, readStoredBytesIntegrity) and worker integrity-recheck.ts (reads the exact recorded VersionId; recordIntegrityObservation is the sole caller of rejectEvidenceIntegrity; runIntegrityRecheckSweep as a recorded GovernanceReconciliationRun). Triggers: finalization, report and package issuance, Public Verify, release of an original, recovery, storage anomaly, and a scheduled sweep (INTEGRITY_RECHECK_INTERVAL_DAYS, default 30). History in evidence_integrity_checks; states from shared stored-bytes-integrity (verified-current / verified-stale / pending / failed / unknown) — only verified-current is presented as verified. The worker capture reaper is likewise a recorded, paged run, and both sweeps report last run / last success / failures through readScheduledSweepHealth into the platform health snapshot.",
    obsoleteRemoved:
      "the report pipeline's direct rejectEvidenceIntegrity calls; the unused 'api.completion' rejection source; the capture reaper's unrecorded, single-page tick",
    redTest: `${T("integrity-recheck.integration.test.ts")} + ${W("integrity-recheck-digest-rule.test.ts")} (evidence/ET-SM-07-red-baseline.txt)`,
    greenTest: `${T("integrity-recheck.integration.test.ts")}; ${W("integrity-recheck-digest-rule.test.ts")}; ${T("capture-reaper-run.integration.test.ts")}; ${W("scheduled-sweeps-deployment-topology.test.ts")}; ${T("point5/family-evidence-finalization.integration.test.ts")} (IntegrityRecheckSweep conformance)`,
    negativeAuthTests: `${T("integrity-recheck.integration.test.ts")} — "destroyed and pending-destruction records are never read; a trashed record is rechecked where it is"; "a temporary storage failure is UNAVAILABLE: nothing is claimed about the bytes, and it is retried after the lease"`,
    concurrencyTest: `${T("integrity-recheck.integration.test.ts")} — "duplicate jobs for one record: exactly one reads it, one history row"; "a report-time observation and a concurrent recheck both record; a double mismatch rejects once"; ${T("capture-reaper-run.integration.test.ts")} — "a repeated run and concurrent runs expire nothing twice"`,
    migrationImpact:
      "20280815000000_integrity_recheck_reconciliation_kinds (enum values INTEGRITY_RECHECK, CAPTURE_REAPER); 20280815000001_evidence_integrity_checks (table, six nullable evidence columns, two guarded indexes). Expand only, no backfill.",
    compatibilityImpact:
      "Every existing signed record starts as 'not yet rechecked' and is shown that way until the sweep reaches it (25 records per 15 minutes by default, configurable). Public Verify adds a stored-file row; it never upgrades an unknown or stale state to verified.",
    remainingExternalProof:
      "AWS S3 Object Lock on the exact VersionId is proven against MinIO only — docs/operations/external-proof-register.md row 1.",
  },
  "ET-Q-07": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause:
      "Five queues (mi-exif, mi-search-index, graph-domain-sync, graph-timeline-sync, org-health-refresh) each had a registered consumer, a CURRENT_RUNTIME registry entry, a legacy payload adapter, a replay policy, an Operations inventory row and green contract tests — and no producer: no enqueue helper for any of them was ever called, so none ever received a job, while the registry credited them with recovery coverage nobody wrote.",
    canonicalAuthority:
      "OWNER DECISION: retire all five. Consumers, schedulers, registry entries, DLQ wiring, health rows, metrics, configuration and contracts are removed; the work they claimed is done by real reconcilers (derived assets in intelligence-run-reconciler; graph and signal projections in search-index-reconciler), so RECONCILER_PENDING is empty. Resurrection guard et-q-07-retired-queues-resurrection-guard reads string literals from the syntax tree; producer-call-site and reconciler-authority gates hold the registry to what the code does. Historical migrations are unchanged.",
    obsoleteRemoved:
      "the five queues' names, job names, registry entries, worker consumers, enqueue helpers, legacy payload adapters, drain commands, DLQ and replay rows, Operations inventory labels, metrics and their contract tests",
    redTest: `${W("et-q-07-retired-queues-resurrection-guard.test.ts")} (evidence/ET-Q-07-red-baseline.txt; evidence/ET-Q-07-no-producer-proof.txt)`,
    greenTest: `${W("et-q-07-retired-queues-resurrection-guard.test.ts")}; ${W("et-q-07-derived-asset-reconciler.test.ts")}; ${W("et-q-07-projection-recovery.test.ts")}; ${T("point5/family-reconciliation.integration.test.ts")}; ${T("point5/family-intelligence-operations.integration.test.ts")}`,
    concurrencyTest: `${T("point5/family-reconciliation.integration.test.ts")} and ${T("point5/family-intelligence-operations.integration.test.ts")} — the reconcilers' claim / duplicate-delivery conformance cases`,
    migrationImpact: "none (historical migrations that name the queues are unchanged)",
    compatibilityImpact:
      "No behaviour is lost: nothing was ever enqueued. Redis keys left under the five queue names are inert. Registry counts are now 10 jobs / 12 queues / 20 sweeps.",
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
