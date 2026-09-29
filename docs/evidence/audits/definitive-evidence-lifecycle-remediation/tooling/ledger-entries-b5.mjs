// Authoring helper, batch 5: remaining P1s (SEC-07, DC-01..03, PKG-01/02) + PKG-03/12. Idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));

const PKG_MIG =
  "additive 20280803000000_verification_package_seal_identity (2 nullable verification_packages columns; EXPAND, SAFE_TO_APPLY_NOW; registered in curation, deployment plan, drift allowlist, inventory)";

Object.assign(L.findings, {
  "ET-SEC-07": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The relationship route accepted any target the caller could read, so a user in two workspaces linked them and every source-workspace reader saw the target's title, status and case.",
    canonicalAuthority: "relationship-summary.service sameRelationshipWorkspace (same Team, or same owner for a personal record): enforced in createEvidenceRelationship, applied as a scope filter in listEvidenceRelationships",
    obsoleteRemoved: "teamId: evidence.teamId ?? target.teamId fallback on the route",
    redTest: "services/api/test/evidence-relationship-scope.integration.test.ts (red: cross-workspace link 201 and target title listed; evidence/sec07-red-baseline.txt)",
    greenTest: "services/api/test/evidence-relationship-scope.integration.test.ts; bounded-domain-errors / runtime-proof relationship suites",
    negativeAuthTests: "dual-workspace member refused with anti-enumeration 404; pre-existing cross-workspace row hidden from the source workspace",
    compatibilityImpact: "existing cross-workspace relationship rows remain stored but are no longer listed",
  },
  "ET-DC-01": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Discard serialized only on the capture-session lock while finalization held the evidence lock; the finalize claim lacked deletedAt, and a lost bind claim still answered bound:true.",
    canonicalAuthority: "the shared evidence advisory lock (hashtext(evidenceId)): discard takes session lock then evidence lock before reading/writing; finalize claim requires deletedAt IS NULL; completion answers bound only for a session BOUND to the record",
    redTest: "services/api/test/direct-capture-discard-race.integration.test.ts (gated object read holds finalization; red: discard answered 500 DATABASE_ERROR — evidence/dc01-red-baseline.txt)",
    greenTest: "direct-capture-discard-race (3/3 repeated runs); uc0-acquisition-capture, uc0-discard-lifecycle, uc1-web-capture",
    concurrencyTest: "direct-capture-discard-race: discard issued while finalization holds the evidence lock mid-hash",
  },
  "ET-DC-02": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Acquisition statements asserted the session was 'started before the capture'; UC-1 and UC-2 open it after the capture and the server never checks.",
    canonicalAuthority: "packages/shared evidence-acquisition DESCRIPTORS: no statement asserts an ordering; limitation CAPTURE_CLIENT_ATTESTED states the timing is client-reported",
    redTest: "evidence/dc02-dc03-red-baseline.txt (prior resolver asserted the ordering for three modes)",
    greenTest: "packages/shared/tests/evidence-acquisition.test.mjs [ET-DC-02]",
    compatibilityImpact: "statement and label text for direct-capture modes changed on every surface that renders the acquisition projection",
  },
  "ET-DC-03": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Direct-capture provenance ('PROOVRA captured ... directly') followed the caller's mode string with no client proof.",
    canonicalAuthority: "owner decision 4: resolveEvidenceAcquisition.provenanceTier (SERVER_OBSERVED_CAPTURE | CLIENT_ATTESTED_CAPTURE | IMPORTED_EXISTING_MEDIA); every direct channel is CLIENT_ATTESTED (no positive attestation verdict exists); carried on public Verify and the package",
    redTest: "evidence/dc02-dc03-red-baseline.txt (no tier; statements asserted PROOVRA captured the bytes)",
    greenTest: "packages/shared/tests/evidence-acquisition.test.mjs [ET-DC-03]; uc0/uc1 integration suites",
    remainingExternalProof: "SERVER_OBSERVED_CAPTURE becomes reachable only with a real platform attestation provider (Play Integrity / App Attest), not available locally",
  },
  "ET-PKG-01": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The processor replaced each custody payload with its presentation copy before export, so custody.json could not recompute; the README gave no formula.",
    canonicalAuthority: "report-v2/normalizers packageCustodyEntry: payload verbatim + presentationPayload beside it; README states the canonical-JSON SHA-256 recomputation",
    obsoleteRemoved: "payload: normalizeCustodyEventPayloadForPresentation(...) in the package custody export",
    redTest: "services/worker/test/package-custody-recompute.test.ts [contrast: the prior export does not recompute] (evidence/pkg01-red-baseline.txt)",
    greenTest: "services/worker/test/package-custody-recompute.test.ts (independent README-formula recomputation of every exported event); custody-capture-presentation.test.ts",
    compatibilityImpact: "custody.json/forensic-custody.json payloads now show stored values (e.g. MULTIPART_PACKAGE); the relabelled copy is in presentationPayload",
  },
  "ET-PKG-02": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The seal key travelled only inside the ZIP and PROOVRA published no fingerprint, while Verify called the package sealed.",
    canonicalAuthority: "verification_packages.seal_signing_key_sha256 + seal_sha256 written from the seal the worker signed; Basic Verify package.sealKeyFingerprint + package.packageSha256; README step 2c",
    redTest: "public-verify-package-seal-identity.integration.test.ts (columns and fields did not exist on the prior tree; the page asserted 'sealed' unconditionally)",
    greenTest: "services/api/test/public-verify-package-seal-identity.integration.test.ts; apps/web render test [ET-PKG-02]; services/worker/test/package-readme-seal-instructions.test.ts",
    migrationImpact: PKG_MIG,
    compatibilityImpact: "packages issued before the migration show 'no key recorded' instead of a bare 'sealed'",
  },
  "ET-PKG-03": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "HOW TO VERIFY ignored the format-5 seal, step 6 was vague, the OTS hint named no digest, and the certification template claimed platform-independent verification.",
    canonicalAuthority: "verification-package buildReadme: sealed packages verified by the seal (a-e) incl. key fingerprint vs Public Verify; unsealed packages state what the manifest signature cannot show",
    greenTest: "services/worker/test/package-readme-seal-instructions.test.ts",
  },
  "ET-PKG-12": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Basic Verify said a report copy 'can be checked' via its recorded digest but returned only a boolean.",
    canonicalAuthority: "BasicVerification.report.sha256 (the latest report's pdfSha256)",
    greenTest: "public-verify-package-seal-identity.integration.test.ts [report.sha256]",
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
