// Authoring helper, batch 16: acquisition + direct capture (ET-ACQ-01, -03,
// -04, -06, -07, ET-DC-07, -08, -09, -10, -11). Idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));

const T = (f) => `services/api/test/${f}`;

Object.assign(L.findings, {
  "ET-ACQ-01": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "POST /v1/evidence authorized a workspace capture by any ACTIVE membership row: VIEWERs, expired members and members of suspended organizations created workspace Evidence.",
    canonicalAuthority: "evidence.service assertInteractiveEvidenceCreateAllowed — the canonical evaluateMemberAccess(evidence.create) before anything is written (direct capture already used authorizeOrFail(evidence.create))",
    redTest: `${T("evidence-create-authorization.integration.test.ts")} (evidence/ET-ACQ-01-red-baseline.txt)`,
    greenTest: T("evidence-create-authorization.integration.test.ts"),
  },
  "ET-ACQ-03": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The evidence.completed webhook, malware scan and finalization fan-out ran after the commit and only on the first finalize; a failure after the commit skipped them permanently because the retry returned early.",
    canonicalAuthority: "evidence-complete runCompletionFanoutOnce — a durable claim (evidence.completion_fanout_claimed_at_utc lease + _done_at_utc) reached by the first finalize and any retry; migrations 20280812000000 (EXPAND) and 20280812000001 (BACKFILL)",
    obsoleteRemoved: "the alreadyFinalized early return before the fan-out",
    redTest: `${T("completion-fanout-once.integration.test.ts")} (evidence/ET-ACQ-03-red-baseline.txt)`,
    greenTest: T("completion-fanout-once.integration.test.ts"),
    concurrencyTest: `${T("completion-fanout-once.integration.test.ts")} [concurrent retries run it exactly once; a lapsed lease is re-driven]`,
  },
  "ET-ACQ-04": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Every part was downloaded and hashed inside the 120 s transaction before the total was compared with MAX_EVIDENCE_SIZE.",
    canonicalAuthority: "evidence-complete prehashCompletionObjects (HEAD sum -> 413 before any GET; hash outside the transaction) + digestOf (a pre-computed digest reused only when bound to the exact bucket/key/version/ETag/size the in-transaction HEAD describes); the in-transaction multipart path refuses the HEAD total before any read. The presigned PUT's Content-Length is not signed: completion is the authority, so an oversize object can be stored but never sealed.",
    obsoleteRemoved: "the late post-hash multipart size check",
    redTest: `${T("completion-size-and-prehash.integration.test.ts")} (evidence/ET-ACQ-04-red-baseline.txt)`,
    greenTest: T("completion-size-and-prehash.integration.test.ts"),
  },
  "ET-ACQ-06": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The record-cap count was read with no lock before the insert, so concurrent creates at cap-1 were all admitted, and SHARED workspaces were never settled again.",
    canonicalAuthority: "createEvidence takes lockEvidenceCapacitySubject (the completion settlement lock) in the insert transaction and re-makes assertWorkspaceAllowsEvidenceCreation under it",
    redTest: `${T("evidence-cap-admission-serialized.integration.test.ts")} (evidence/ET-ACQ-06-red-baseline.txt)`,
    greenTest: T("evidence-cap-admission-serialized.integration.test.ts"),
    concurrencyTest: `${T("evidence-cap-admission-serialized.integration.test.ts")} [5 concurrent creates at cap-1 -> exactly 1, SHARED TEAM and FREE Personal]`,
  },
  "ET-ACQ-07": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "POST /v1/evidence/:id/parts had no upper bound on partIndex, no cap on part count and no rate limit.",
    canonicalAuthority: "evidence-part-writer MAX_EVIDENCE_PARTS (the one bound; indexes are unique so it bounds the count; direct capture reads it too) + per-user presign rate limit",
    redTest: `${T("evidence-parts-bounds.integration.test.ts")} (evidence/ET-ACQ-07-red-baseline.txt)`,
    greenTest: T("evidence-parts-bounds.integration.test.ts"),
  },
  "ET-DC-07": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "reserveDirectCaptureEvidence ran createEvidence on the global client inside its own transaction, so a failed reserve left an unbound committed record and the retry minted a second.",
    canonicalAuthority: "createEvidence({ transaction }) writes the record in the caller's transaction and returns afterCommit; the reserve runs it after its commit",
    redTest: `${T("direct-capture-reserve-atomic.integration.test.ts")} (evidence/ET-DC-07-red-baseline.txt)`,
    greenTest: T("direct-capture-reserve-atomic.integration.test.ts"),
  },
  "ET-DC-08": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "UC-2/UC-3/UC-5 opened their direct-capture session with no teamId, so every screen capture was filed in the personal workspace.",
    canonicalAuthority: "stageScreenCapture / beginContinuousSession take the active workspace from the one platform-context reader, as /capture does",
    redTest: "apps/mobile/test/screen-capture-workspace.test.mjs (evidence/ET-DC-08-red-baseline.txt)",
    greenTest: "apps/mobile/test/screen-capture-workspace.test.mjs",
  },
  "ET-DC-09": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Continuous-capture continuity was client-asserted beyond shape and sequence contiguity, and downstream completeness read a session status that is BOUND for every sealed record.",
    canonicalAuthority: "shared validateScreenContinuousManifest (timings, gaps, overlap, window, platform, completeness vs termination) + server size check against stored objects; continuousEndReasonFor / captureSessionAcquisitionComplete carry completeness past the seal to the worker",
    redTest: `packages/shared/tests/screen-continuous-manifest.test.mjs + ${T("uc3-continuous-capture.integration.test.ts")} [ET-DC-09] (evidence/ET-DC-09-red-baseline.txt)`,
    greenTest: `packages/shared/tests/screen-continuous-manifest.test.mjs; ${T("uc3-continuous-capture.integration.test.ts")}`,
  },
  "ET-DC-10": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The capture trust-event sub-chain was extended by an unlocked read of its head and an insert, with no unique (chain, sequence), so concurrent declarations forked it.",
    canonicalAuthority: "trust-event.service emitCaptureTrustEvent: sorted advisory locks on every chain the event belongs to; partial unique indexes (migration 20280813000000) as the backstop",
    redTest: `${T("capture-trust-chain-concurrency.integration.test.ts")} (evidence/ET-DC-10-red-baseline.txt)`,
    greenTest: T("capture-trust-chain-concurrency.integration.test.ts"),
    concurrencyTest: `${T("capture-trust-chain-concurrency.integration.test.ts")} [8 concurrent events -> distinct consecutive linked sequences]`,
  },
  "ET-DC-11": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Low-risk capture gaps: an extension token could presign parts on any owned unsealed record; the draft route used a bare membership check; the manifest part was relabelled after the seal; an uncalled device lookup.",
    canonicalAuthority: "req.user.tokenScope + extensionMayPresignPart; evaluateMemberAccess(evidence.create) on the draft route; manifest classed before completeDirectCapture",
    obsoleteRemoved: "device-identity findDeviceByPubkey; the post-seal CAPTURE_MANIFEST relabel",
    redTest: `${T("capture-scope-and-draft-authority.integration.test.ts")} (evidence/ET-DC-11-red-baseline.txt)`,
    greenTest: T("capture-scope-and-draft-authority.integration.test.ts"),
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
