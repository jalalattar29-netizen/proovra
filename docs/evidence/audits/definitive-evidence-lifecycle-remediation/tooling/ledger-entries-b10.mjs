// Authoring helper, batch 10: finalize/upload/storage (ET-SEC-11, -13, ET-SM-02,
// -03, -08, ET-PKG-15, ET-UPL-02, -03, -05). Idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));

const T = (f) => `services/api/test/${f}`;
const ONESHOT = T("finalize-and-session-oneshot.integration.test.ts");
const UPLKEY = T("upload-session-key-and-terminal.integration.test.ts");

Object.assign(L.findings, {
  "ET-SEC-11": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "A repeat complete on a REPORTED record fell through the SIGNED short-circuit and re-ran finalization against a record whose report was already issued.",
    canonicalAuthority: "evidence-complete.service completeEvidence: SIGNED and REPORTED both answer alreadyFinalized with the existing chain",
    redTest: `${ONESHOT} [ET-SEC-11] (evidence/ET-SEC-11-13-SM-02-red-baseline.txt)`,
    greenTest: `${ONESHOT} [ET-SEC-11]`,
  },
  "ET-SEC-13": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "completeUploadSession's UPDATE did not exclude terminal states, so an ABORTED/EXPIRED/FAILED session could be flipped to COMPLETED.",
    canonicalAuthority: "upload-session.service completeUploadSession: the atomic UPDATE admits only live (non-terminal) sessions",
    redTest: `${ONESHOT} [ET-SEC-13] (evidence/ET-SEC-11-13-SM-02-red-baseline.txt)`,
    greenTest: `${ONESHOT} [ET-SEC-13]`,
    concurrencyTest: `${ONESHOT} [ET-SEC-13: a session aborted between the read and the write is NOT completed]`,
  },
  "ET-SM-02": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The report commit wrote REPORTED without re-reading the record under its lock, overwriting an integrity failure, trash or destruction that landed while the report rendered.",
    canonicalAuthority: "services/worker/src/processor.ts REPORTABLE_AT_COMMIT_WHERE / isReportableAtCommit (conditional commit; REPORT_EVIDENCE_STATE_CHANGED otherwise)",
    redTest: `${T("point5/report-package-recovery.integration.test.ts")} [ET-SM-02] (evidence/ET-SEC-11-13-SM-02-red-baseline.txt)`,
    greenTest: `${T("point5/report-package-recovery.integration.test.ts")} [ET-SM-02: integrity rejection and trash during render]`,
    concurrencyTest: `${T("point5/report-package-recovery.integration.test.ts")} [ET-SM-02: an integrity rejection that lands while the PDF renders is never overwritten by REPORTED]`,
  },
  "ET-SM-03": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The verify link, retention application, lock snapshot and archive copy addressed latest-at-the-key instead of the sealed object version.",
    canonicalAuthority: "storage.ts versioned applyObjectRetention / applyDefaultObjectRetention / headObject / copyObjectStorageClass(sourceVersionId); evidence-complete RetentionTarget.versionId; buildPublicEvidenceContent pins sealedVersionId",
    redTest: `${T("storage-sealed-version.test.ts")} (evidence/ET-SM-03-red-baseline.txt)`,
    greenTest: T("storage-sealed-version.test.ts"),
  },
  "ET-SM-08": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Web and mobile each mapped record statuses with their own tables; an integrity failure rendered as \"Status not recorded\".",
    canonicalAuthority: "packages/shared/src/evidence-record-status.ts evidenceRecordStatusLabel / evidenceRecordStatusTone (EVIDENCE_RECORD_STATUSES_PRESENTED); web and mobile delegate",
    obsoleteRemoved: "per-surface status label/tone tables in apps/web evidence-library-status.ts and mobile",
    redTest: `${T("evidence-record-status-coverage.test.ts")} (evidence/ET-SM-08-red-baseline.txt)`,
    greenTest: `${T("evidence-record-status-coverage.test.ts")}; apps/mobile/test/evidence-library.test.mjs`,
  },
  "ET-PKG-15": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The integrity pre-read was pinned to the sealed version but the package stream read latest-at-the-key, so a newer object at the key failed the build as a digest mismatch.",
    canonicalAuthority: "services/worker verification-package: getObjectStream versionId = VerificationEvidenceFile.storageVersionId from the processor's pre-read",
    redTest: "services/worker/test/package-sealed-version.test.ts (evidence/ET-PKG-15-red-baseline.txt)",
    greenTest: "services/worker/test/package-sealed-version.test.ts",
  },
  "ET-UPL-02": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "One ABORTED/EXPIRED session blocked its record's finalization forever, the retry got the dead session back through its idempotency key, and any team member could abort another member's session.",
    canonicalAuthority: "upload-session.service: evaluateUploadSessionFinalizeGate (abandoned sessions skipped, superseded FAILED skipped, abandoned-only = applies:false); createUploadSession releases a terminal session's key; abortUploadSession limited to the session actor or record owner",
    redTest: `${UPLKEY} [ET-UPL-02] (evidence/ET-UPL-02-03-red-baseline.txt)`,
    greenTest: `${UPLKEY} [ET-UPL-02]; ${T("phase-30-11-unified-evidence-model.test.ts")}; ${T("phase-30-7-finalize-gate.test.ts")}`,
  },
  "ET-UPL-03": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "An idempotency key collapsed onto ANY team session with that key, so a member who pre-created the key for their own record diverted another member's upload to it.",
    canonicalAuthority: "upload-session.service createUploadSession: a key reuses only the SAME record and actor; otherwise idempotency_key_conflict (409)",
    redTest: `${UPLKEY} [ET-UPL-03] (evidence/ET-UPL-02-03-red-baseline.txt)`,
    greenTest: `${UPLKEY} [ET-UPL-03]`,
  },
  "ET-UPL-05": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Multipart completion never enforced the declared total size and marked every part VERIFIED whenever the server hashed the object, even with no client-declared reference hash.",
    canonicalAuthority: "upload-session.service completeStorageMultipart: size_mismatch fails the session; parts settle VERIFIED only on a matched declared reference, else HASHED; SETTLED_PART_STATES_SQL is the one settled set",
    redTest: `${T("upload-multipart-size-and-reference.test.ts")} (evidence/ET-UPL-05-red-baseline.txt)`,
    greenTest: `${T("upload-multipart-size-and-reference.test.ts")}; ${UPLKEY} [ET-UPL-05: HASHED admitted by the live constraint]`,
    migrationImpact: "20280810000000_upload_part_state_hashed: CHECK constraint swap to a strictly wider set (EXPAND); apply before the image",
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
