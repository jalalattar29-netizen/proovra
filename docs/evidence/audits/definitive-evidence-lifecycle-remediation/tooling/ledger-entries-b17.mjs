// Authoring helper, batch 17: public Verify truth, billing reversal, and the
// safe-default owner items (ET-PKG-05, -06, -08, ET-COM-03, -06, ET-DC-04,
// ET-SEC-20, -24, -26, ET-ACQ-05). Idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));

const T = (f) => `services/api/test/${f}`;

Object.assign(L.findings, {
  "ET-PKG-05": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Public Verify's package verdict was derived from artifact-presence flags, so an unsealed legacy package got the success badge, and a partial package was described as absent.",
    canonicalAuthority: "worker assertSealSignatureVerifies (a seal that does not verify is never published); API withPackageSealState (packageFormatVersion + sealed) on both package-integrity projections; web badge requires sealed",
    redTest: `${T("public-verify-package-sealed.integration.test.ts")} + services/worker/test/package-seal-self-verification.test.ts + apps/web/__tests__/verify-package-sealed-badge.test.ts (evidence/ET-PKG-05-red-baseline.txt)`,
    greenTest: `${T("public-verify-package-sealed.integration.test.ts")}; services/worker/test/package-seal-self-verification.test.ts; apps/web/__tests__/verify-package-sealed-badge.test.ts`,
  },
  "ET-PKG-06": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Public Verify reported a row's storage-lock snapshot as verified and immutable with no expiry check and no object check, and counted it as a passed signal.",
    canonicalAuthority: "StorageProtectionSummary source RECORDED | OBSERVED + expired (retentionState); web presents recorded / expired, only an observed lock is a passed signal; BASIC names what it checked",
    redTest: `${T("public-verify-storage-recorded.integration.test.ts")} + apps/web/__tests__/verify-storage-recorded.test.ts (evidence/ET-PKG-06-red-baseline.txt)`,
    greenTest: `${T("public-verify-storage-recorded.integration.test.ts")}; apps/web/__tests__/verify-storage-recorded.test.ts`,
  },
  "ET-PKG-08": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The package eligibility gate ran only for team-governed packages, so Personal records and records whose workspace kind was unresolved skipped the lifecycle, destruction and drift checks.",
    canonicalAuthority: "worker createVerificationPackage runs assertPackageEligibleOrDeny for every package (teamId null for a legacy Personal record); an unresolved workspace kind is denied before any build. Owner confirmation: holds now block Personal packages (fail closed).",
    redTest: "services/worker/test/package-gate-every-package.test.ts (evidence/ET-PKG-08-red-baseline.txt)",
    greenTest: "services/worker/test/package-gate-every-package.test.ts",
  },
  "ET-COM-03": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Stripe refunds and lost disputes never reversed evidence credits: no charge.refunded / charge.dispute.* handling.",
    canonicalAuthority: "stripe-settlement applyStripeChargeAdverseEvent -> the one reverseEvidenceCreditPurchase (grant providerRef = Checkout Session); partial refunds and shortfalls to billing review",
    redTest: `${T("stripe-credit-refund-reversal.integration.test.ts")} (evidence/ET-COM-03-red-baseline.txt)`,
    greenTest: T("stripe-credit-refund-reversal.integration.test.ts"),
  },
  "ET-COM-06": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "A customer's Generate click issued a record's first report under any ENTITLED decision (grace, trial), while the automatic path requires mayIssueHistoricalFirstOutputs; the backfill flag's state was undocumented.",
    canonicalAuthority: "requestReportGeneration applies mayIssueHistoricalFirstOutputs to a person's first-report request (completion-time issuance exempt); runbook documents OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED (default OFF). Owner decision: enabling the backfill in production.",
    redTest: `${T("first-issuance-manual-rule.integration.test.ts")} (evidence/ET-COM-06-red-baseline.txt)`,
    greenTest: T("first-issuance-manual-rule.integration.test.ts"),
  },
  "ET-DC-04": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "With EXTENSION_OAUTH_REDIRECT_ALLOW unset the extension OAuth accepted any chromiumapp.org extension id and issued a code from the ambient session.",
    canonicalAuthority: "extension-oauth isAllowedExtensionRedirect: the explicit allow-list is the only authority (unset refuses every redirect). Owner confirmation: the variable must be set in production.",
    redTest: `${T("uc1-extension-oauth.integration.test.ts")} [ET-DC-04] (evidence/ET-DC-04-red-baseline.txt)`,
    greenTest: T("uc1-extension-oauth.integration.test.ts"),
  },
  "ET-SEC-20": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The report/package backlog was computed by five aggregators with three rules: plan-only narrowing, no narrowing in case risk and org health, and a worker package-owed check without the lifecycle.",
    canonicalAuthority: "outputEntitledEvidenceWhere decides through resolveOutputIssuanceEntitlement (plan + paid lifecycle); case risk and org health narrow through it; worker verificationPackageOwed uses resolveEvidenceOutputIssuance",
    obsoleteRemoved: "the plan-only reportsIncluded narrowing; the un-narrowed case-risk and org-health backlog counts; the worker's plan+funding package-owed rule",
    redTest: `${T("owed-output-backlog-agreement.integration.test.ts")} (evidence/ET-SEC-20-red-baseline.txt)`,
    greenTest: T("owed-output-backlog-agreement.integration.test.ts"),
  },
  "ET-SEC-24": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Two reapers expired capture drafts; the API sweep wrote EXPIRED events for every selected row, including rows the worker had already expired.",
    canonicalAuthority: "worker capture-reaper (CAPTURE_DRAFT_REAPER) is the one reaper",
    obsoleteRemoved: "services/api/src/jobs/capture-draft-expiry.job.ts, services/api/scripts/sweep-capture-drafts.ts, the server.ts in-process timer",
    redTest: `${T("capture-draft-expiry-sweeper.test.ts")} (evidence/ET-SEC-24-red-baseline.txt)`,
    greenTest: T("capture-draft-expiry-sweeper.test.ts"),
  },
  "ET-SEC-26": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Redacted derivative downloads presigned bytes outside the canonical byte-release gate (no legal hold / lifecycle / export eligibility).",
    canonicalAuthority: "artifact-download-gate evaluateArtifactDownload kind \"redaction\" on GET /v1/redaction/derivatives/:id/download-url. Owner confirmation: no download policy names derivatives.",
    redTest: `${T("redaction-derivative-byte-release.integration.test.ts")} (evidence/ET-SEC-26-red-baseline.txt)`,
    greenTest: `${T("redaction-derivative-byte-release.integration.test.ts")}; ${T("phase-12b-redaction-request.test.ts")}`,
  },
  "ET-ACQ-05": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The required-checklist gate enforced only the client-written intakePlanJson (omit it and the gate did not apply), and the template identity stamp read any capture session id.",
    canonicalAuthority: "capture-checklist-gate effectiveChecklistPlan (the owner's capture session plan mode + the template's required steps; a client plan can only add); identity-resolver reads only the owner's session. Owner confirmation: checklist completion is a product guarantee for CHECKLIST_REQUIRED sessions.",
    redTest: `${T("checklist-plan-server-authority.integration.test.ts")} (evidence/ET-ACQ-05-red-baseline.txt)`,
    greenTest: `${T("checklist-plan-server-authority.integration.test.ts")}; ${T("capture-finalize-checklist-gate.test.ts")}; ${T("phase-t-capture-to-evidence-identity.test.ts")}`,
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
