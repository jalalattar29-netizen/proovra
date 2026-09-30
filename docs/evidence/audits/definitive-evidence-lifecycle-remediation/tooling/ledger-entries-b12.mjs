// Authoring helper, batch 12: OTS + concurrency (ET-OTS-04, -05, -06, ET-SEC-19,
// -27, -28, -29, -30). Idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));

const T = (f) => `services/api/test/${f}`;
const W = (f) => `services/worker/test/${f}`;

Object.assign(L.findings, {
  "ET-OTS-04": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "createOpenTimestamp returned every `ots stamp` error as a per-record FAILED with the raw command text (server paths) as its reason; nothing retried it and every reader showed the text.",
    canonicalAuthority: "worker ots.service throws OtsStampCallFailed into the initializer's retry budget; shared boundedOtsFailureCode / OTS_FAILURE_CODE_LABELS is the only failure value any reader shows",
    redTest: `${W("ots-initialization-truth.test.ts")}; ${T("ots-failure-reason-bounded.integration.test.ts")} (evidence/ET-OTS-04-05-red-baseline.txt)`,
    greenTest: `${W("ots-initialization-truth.test.ts")}; ${T("ots-failure-reason-bounded.integration.test.ts")}`,
  },
  "ET-OTS-05": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Initialization promoted `ots upgrade` text ('timestamp complete' / 'bitcoin transaction') to ANCHORED with no hash or attestation check, and a txid parsed by the generic fallback kept the ladder from re-checking it.",
    canonicalAuthority: "createOpenTimestamp always returns PENDING; the upgrade ladder's classifier alone establishes an anchor",
    obsoleteRemoved: "shouldTreatOtsAsAnchored (the last text-only promotion) and isPendingLikeUpgradeMessage",
    redTest: `${W("ots-initialization-truth.test.ts")} (evidence/ET-OTS-04-05-red-baseline.txt)`,
    greenTest: `${W("ots-initialization-truth.test.ts")}; ${W("ots-upgrade-output.test.ts")}`,
  },
  "ET-OTS-06": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Deterministic proof-read failures were routed to TRANSIENT_ERROR forever, and an attested proof with no readable txid was neither recorded nor withdrawn.",
    canonicalAuthority: "ots-upgrade.processor: hash-matching attested proof -> ANCHOR_PROVEN PROOF_STRUCTURE; getOtsProofInfo.deterministic + OTS_UNREADABLE_PROOF_STRIKES (3, counted from custody OTS_ATTEMPT_ERROR) -> MALFORMED_PROOF",
    redTest: `${W("ots-upgrade-processor.behaviour.test.ts")} (evidence/ET-OTS-06-red-baseline.txt)`,
    greenTest: W("ots-upgrade-processor.behaviour.test.ts"),
  },
  "ET-SEC-19": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The exchange-package signed URL (minted behind generate_package + step-up) was stored on the row and serialized by the evidence.read list projection.",
    canonicalAuthority: "evidence-exchange.service generateSignedUrl returns the URL to its minter only; the row keeps only signedUrlExpiresAtUtc; the list projection carries no URL",
    redTest: `${T("exchange-signed-url-not-listed.integration.test.ts")} (evidence/ET-SEC-19-red-baseline.txt)`,
    greenTest: T("exchange-signed-url-not-listed.integration.test.ts"),
  },
  "ET-SEC-27": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The exchange builder uploaded to a fixed key before its conditional READY transition and its FAILED write was unfenced, so a late builder could overwrite a committed object or fail the live build.",
    canonicalAuthority: "exchange-package-builder: claim token = started_at_utc; attempt-scoped object key; READY only while attemptStillOwnsBuild (FOR UPDATE); UPLOADED / FAILED / DRAFT-revert fenced by the attempt",
    redTest: `${T("point5/family-exchange-package.integration.test.ts")} [ET-SEC-27] (evidence/ET-SEC-27-red-baseline.txt)`,
    greenTest: `${T("point5/family-exchange-package.integration.test.ts")} [ET-SEC-27]`,
    concurrencyTest: `${T("point5/family-exchange-package.integration.test.ts")} [lease re-claimed mid-build]`,
  },
  "ET-SEC-28": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The completion's storage check ran before the per-workspace capacity lock, so two concurrent finalizes of different records could both pass.",
    canonicalAuthority: "billing-enforcement lockEvidenceCapacitySubject taken before assertWorkspaceAllowsStorageGrowth inside the finalize transaction",
    redTest: `${T("storage-capacity-concurrent-finalize.integration.test.ts")} (evidence/ET-SEC-28-red-baseline.txt)`,
    greenTest: T("storage-capacity-concurrent-finalize.integration.test.ts"),
    concurrencyTest: `${T("storage-capacity-concurrent-finalize.integration.test.ts")} [two concurrent finalizes -> exactly one 409]`,
  },
  "ET-SEC-29": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The package commit set evidence.verificationPackageVersion unconditionally, so an older package-only recovery moved the pointer backwards.",
    canonicalAuthority: "worker processor package commit: conditional updateMany (NULL or <= this version)",
    redTest: `${T("point5/report-package-recovery.integration.test.ts")} [EXACT VERSION v1 while v2] (evidence/ET-SEC-29-30-red-baseline.txt)`,
    greenTest: `${T("point5/report-package-recovery.integration.test.ts")} [pointer stays 2]`,
  },
  "ET-SEC-30": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The report request lease had no fencing token, so a late worker's retryable/terminal write overwrote the re-claimer's PROCESSING row.",
    canonicalAuthority: "report-generation-authority: ResolvedReportCommand.claimedAtUtc is the fence; markRequestRetryable/markRequestTerminal(fence) and claimFenceWhere for the in-run stage writes (ReportClaimLost rolls back)",
    redTest: `${T("phase-12-point5-report-authority.integration.test.ts")} [21b] (evidence/ET-SEC-29-30-red-baseline.txt)`,
    greenTest: `${T("phase-12-point5-report-authority.integration.test.ts")} [21b]`,
    concurrencyTest: `${T("phase-12-point5-report-authority.integration.test.ts")} [late worker after re-claim writes nothing]`,
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
