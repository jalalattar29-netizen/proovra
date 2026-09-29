// One-shot authoring helper: records the P0 pass (and the serialization /
// writer findings closed with it) into ledger-source.json. Kept in the repo so
// the authored text is reviewable; re-running it is idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));
const P0 = "services/api/test/evidence-lifecycle-p0.integration.test.ts";
const RED = "red on a40ca76f, recorded in evidence/p0-red-baseline.txt";
const SER = "services/api/test/legal-hold-destruction-serialization.integration.test.ts";
const W = "services/api/test/evidence-part-writer.integration.test.ts";

Object.assign(L.findings, {
  "ET-UPL-01": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Three EvidencePart writers with three guard sets; the resumable-upload bridge had none and session creation proved only team membership.",
    canonicalAuthority: "services/api/src/services/evidence/evidence-part-writer.service.ts (writeEvidencePart / lockEvidenceForByteWrite / assertEvidenceAcceptsByteWrites) under the finalize evidence lock",
    obsoleteRemoved: "direct evidencePart.create in evidence.routes.ts, external-intake-orchestration.service.ts and upload-session.service.ts",
    redTest: `${P0} [ET-UPL-01] (${RED}: 'expected [404,409] to include 201'; 'expected 201 to be 409')`,
    greenTest: `${P0} [ET-UPL-01]; ${W}; services/api/test/evidence-part-writer-authority.test.ts (structural guard: exactly one writer)`,
    negativeAuthTests: `${P0}: team MEMBER on the OWNER's SIGNED record -> 404/409; ${W}: non-owner -> 404`,
    concurrencyTest: `${W} [a write racing a finalize that holds the evidence lock waits, then is refused]`,
    migrationImpact: "none; a production scan is recommended for evidence_parts with uploaded_at_utc NULL on SIGNED/REPORTED records (pre-fix injections)",
    compatibilityImpact: "POST /v1/evidence/:id/parts answers 404 (was 403) to a non-owner; upload sessions refuse sealed/foreign records with evidence_not_writable (409) or evidence_not_found (404)",
  },
  "ET-INT-05": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "addExternalEvidencePart checked the session read at route start and took no completion lock.",
    canonicalAuthority: "writeEvidencePart with an INTAKE_SESSION principal (the same evidence lock finalize holds)",
    obsoleteRemoved: "direct evidencePart.create in external-intake-orchestration.service.ts",
    redTest: "no baseline red: the writer did not exist; the defect is source-proven in the audit",
    greenTest: `${W} [ET-INT-05: the intake principal is refused once the record is signed]`,
    concurrencyTest: `${W} race with the finalize lock`,
    compatibilityImpact: "an intake part on a signing/signed record -> 409 SESSION_NOT_OPEN_FOR_UPLOAD",
  },
  "ET-INT-14": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Intake reused session.evidenceId without a deletedAt filter.",
    canonicalAuthority: "writeEvidencePart refuses a soft-deleted record as not found",
    greenTest: `${W} [ET-INT-14: a soft-deleted in-progress record is not found, never reused]`,
    compatibilityImpact: "a part on a soft-deleted record -> 404",
  },
  "ET-SEC-02": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "detachEvidenceFromCase(clearEvidenceTeamIdWhenUnlinked) set Evidence.teamId to NULL when the last case link was removed.",
    canonicalAuthority: "case-evidence-link.service.ts detachEvidenceFromCase — Invariant C: case linkage never changes ownership",
    obsoleteRemoved: "the clearEvidenceTeamIdWhenUnlinked option and its two callers",
    redTest: `${P0} [ET-SEC-02] (${RED}: 'expected null to be <teamId>')`,
    greenTest: `${P0} [ET-SEC-02]; phase-12b-case-evidence-authority.test.ts detach matrix; runtime-proof-cases-review-a.integration.test.ts (expectation corrected from teamId null to the workspace)`,
    migrationImpact: "owner-reviewed backfill recommended: evidence whose teamId was NULLed by a detach (teamId NULL with a cases.evidence_unlinked tenant audit naming a workspace); not automatic",
    compatibilityImpact: "detach responses keep evidence.teamId",
  },
  "ET-SEC-09": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The link authority accepted null === null as a shared tenant and never checked the actor's rights on the evidence.",
    canonicalAuthority: "attachEvidenceToCase proves tenancy itself: same workspace; with no workspace, the case owner must own the evidence; the actor must pass resolveEvidenceRecordAccess(evidence.update_metadata)",
    redTest: `${P0} [ET-SEC-09] (${RED}: 'expected 200 to be 404')`,
    greenTest: `${P0} [ET-SEC-09]; phase-12b-case-evidence-authority.test.ts [ET-SEC-09 / ET-SEC-16] cases`,
    negativeAuthTests: "cross-user personal link -> 404; actor refused by the record-access engine -> refused",
    compatibilityImpact: "links answer 404 when the actor may not change the record",
  },
  "ET-SEC-01": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The executor decided eligibility from a caller-supplied legalHold boolean gathered before its claim.",
    canonicalAuthority: "executeEvidenceDestruction: claim + reload + union hold re-read (fail closed) + eligibility in ONE transaction under the evidence lock; EVIDENCE-scope placeCanonicalLegalHold takes the same lock and refuses destruction_committed; evaluateEffectiveLegalHold now lives once in packages/shared-runtime",
    obsoleteRemoved: "the byte-identical api and worker mirrors of effective-legal-hold.ts",
    redTest: `${P0} [ET-SEC-01] (${RED}: "expected 'DESTROYED' not to be 'DESTROYED'")`,
    greenTest: `${P0} [ET-SEC-01]; ${SER}; phase-12b-legal-hold-convergence.test.ts ET-SEC-01 cases`,
    concurrencyTest: `${SER}: a hold after the decision is refused; a governance-approved record accepts a hold that then stops the executor`,
    compatibilityImpact: "new LegalHoldError code destruction_committed (409)",
  },
  "ET-SEC-06": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The capability projection resolved PENDING_DESTRUCTION back to TRASHED, so restore was permitted while the executor destroyed the record.",
    canonicalAuthority: "applyEvidenceLifecycleAction write step under the evidence lock refuses a decided claim (DESTRUCTION_IN_PROGRESS)",
    redTest: "no baseline red recorded; the defect is source-proven in the audit",
    greenTest: `${SER} [ET-SEC-06: restore is refused while the executor holds a decided claim]`,
    compatibilityImpact: "new block reason DESTRUCTION_IN_PROGRESS (shared and web types)",
  },
  "ET-SEC-12": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Lifecycle writers (lifecycle service, governance orchestrator, executor tombstone) validated on a read and wrote WHERE id only.",
    canonicalAuthority: "lifecycle service: locked re-read + fresh capability + conditional updateMany; governance transitionLifecycle: locked conditional updateMany (no destruction claim); executor tombstone: conditional on its own claim",
    redTest: "no baseline red recorded; the defect is source-proven in the audit",
    greenTest: `${SER} [ET-SEC-12 concurrent restores produce one custody event] and [ET-SEC-12 (STATEMACHINE-04) an operator transition cannot resurrect a record the executor is destroying]`,
    concurrencyTest: `${SER} concurrent restores`,
  },
  "ET-CUS-01": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The public custody summarizer printed up to five raw payload fields for any event type it had no summary for.",
    canonicalAuthority: "summarizePublicPayload is an allow-list: legal-hold events carry a bounded statement; unmapped types print no payload text",
    redTest: `${P0} [ET-CUS-01] (${RED}: the body contained the hold title)`,
    greenTest: `${P0} [ET-CUS-01] (title, internal note, actor id and hold id all absent)`,
    compatibilityImpact: "public payloadSummary is null for event types without a public label",
  },
  "ET-SEC-10": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The headline trusted a stored report snapshot and the stored verificationStatus; a live check failure never reached it.",
    canonicalAuthority: "mapIntegrityHeadline: a live failure dominates and Verified requires overallIntegrity === true; both verify routes use the live trust decision when live core checks fail",
    redTest: `${P0} [ET-SEC-10] (${RED}: headline 'Core Integrity Verified' with signatureValid:false)`,
    greenTest: `${P0} [ET-SEC-10]`,
    compatibilityImpact: "trustDecisionConsistency.source reads LIVE_SHARED_FALLBACK when live checks fail",
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
