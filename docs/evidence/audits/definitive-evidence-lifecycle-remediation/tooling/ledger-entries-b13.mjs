// Authoring helper, batch 13: intake + seeders (ET-INT-06, -07, -08, -09, -11,
// -12, -13, -15, ET-SEC-33, ET-UPL-04). Idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));

const T = (f) => `services/api/test/${f}`;
const GATE = T("intake-link-mint-gate.integration.test.ts");
const RESTR = T("intake-link-restrictions.integration.test.ts");

Object.assign(L.findings, {
  "ET-INT-06": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "A link's ipAllowlistCidrs and maxBytesPerSession were stored and never enforced.",
    canonicalAuthority: "workflow-intake-session assertIntakeClientAllowed via the route's validateIntakeTokenFromClient (every public call); submitExternalIntake byte cap; isValidIpAllowlistEntry at creation",
    redTest: `${RESTR} (evidence/ET-INT-06-red-baseline.txt)`,
    greenTest: RESTR,
  },
  "ET-INT-07": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Evidence-request send and request-more minted intake links without the secure-intake plan gate and the governance policy.",
    canonicalAuthority: "services/intake/intake-link-mint-gate.ts intakeLinkMintRefusal — the one plan + governance gate for every workspace mint (request send, request-more, POST /v1/workflow/intake-links)",
    obsoleteRemoved: "the route's inline plan + governance blocks and its dead personal-account branch",
    redTest: `${GATE} (evidence/ET-INT-07-red-baseline.txt)`,
    greenTest: GATE,
  },
  "ET-INT-08": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Cancelling or closing an evidence request left its intake links live, so submissions kept finalizing into a terminal request.",
    canonicalAuthority: "evidence-request.service transitionEvidenceRequest -> revokeRequestIntakeLinksTx (bound link + every request-more follow-up, same transaction)",
    redTest: `${GATE} [ET-INT-08] (evidence/ET-INT-08-red-baseline.txt)`,
    greenTest: `${GATE} [ET-INT-08]`,
  },
  "ET-INT-09": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "ONE_TIME use, per-session record creation and the per-submission file cap were check-then-write races.",
    canonicalAuthority: "reserveIntakeLinkUse / releaseIntakeLinkUse (conditional used_count < max_uses); createOrLoadExternalEvidence conditional session claim + releaseEvidenceReservationTx(INTAKE_SESSION_RACE_LOST); writeEvidencePart maxPartCount under the record lock",
    obsoleteRemoved: "the SUBMITTED transition's unconditional usedCount increment; the route's pre-insert part count",
    redTest: `${T("intake-concurrency.integration.test.ts")} (evidence/ET-INT-09-red-baseline.txt)`,
    greenTest: T("intake-concurrency.integration.test.ts"),
    concurrencyTest: `${T("intake-concurrency.integration.test.ts")} [concurrent ONE_TIME submits; concurrent first parts; concurrent uploads at the cap]`,
  },
  "ET-INT-11": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Intake consent was client-asserted: acceptance time from the body, termsAcknowledged and the disclosure hash unchecked, re-postable.",
    canonicalAuthority: "workflow-intake-session recordIntakeConsent: server time, termsAcknowledged required, the link's disclosure hash and policy version, one-shot conditional claim",
    redTest: `${T("intake-consent-server-truth.integration.test.ts")} (evidence/ET-INT-11-red-baseline.txt)`,
    greenTest: T("intake-consent-server-truth.integration.test.ts"),
  },
  "ET-INT-12": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Public Verify presented the intake link creator's email, provider and identity level as the submitter's, while the report printed a contributor role.",
    canonicalAuthority: "shared INTAKE_SUBMITTED_BY_LABEL (report, custody summarizer isIntake branch, Verify overview)",
    redTest: `${T("intake-verify-attribution.integration.test.ts")} (evidence/ET-INT-12-red-baseline.txt)`,
    greenTest: T("intake-verify-attribution.integration.test.ts"),
  },
  "ET-INT-13": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Intake submit could answer failure after the record was finalized, and governance-denied retries appended a custody event each.",
    canonicalAuthority: "submitExternalIntake idempotent post-commit steps (already-finalized retry path; once-per-session EXTERNAL_INTAKE_SUBMITTED; SUBMITTED transition tolerant); evaluateFinalizationGovernance one event per unchanged refusal",
    redTest: `${T("intake-finalization-governance.integration.test.ts")} (evidence/ET-INT-13-red-baseline.txt)`,
    greenTest: T("intake-finalization-governance.integration.test.ts"),
  },
  "ET-INT-15": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Intake P3s: a dead first-part capture-environment write, an untrue UPLOAD_AUTHORIZED meaning and magic-byte comment, stale citizen-capture comments (the custody-swallow and caseId items closed by ET-CUS-13 and ET-SEC-33).",
    canonicalAuthority: "external-intake route capture environment on the part's record; evidence.service intake UPLOAD_AUTHORIZED meaning",
    redTest: `${RESTR} [ET-INT-15] (evidence/ET-INT-15-red-baseline.txt)`,
    greenTest: `${RESTR} [ET-INT-15]`,
  },
  "ET-SEC-33": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Caller-supplied caseId / evidenceId on intake links and evidence requests were stored without tenant validation.",
    canonicalAuthority: "createWorkflowIntakeLink and createEvidenceRequest refuse ids outside the workspace (404, like a missing row)",
    redTest: `${GATE} [ET-SEC-33] (evidence/ET-SEC-33-red-baseline.txt)`,
    greenTest: `${GATE} [ET-SEC-33]`,
  },
  "ET-UPL-04": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "seed-home-personas loaded dotenv/config and refused only NODE_ENV=production, so it could write fabricated evidence into the database .env named.",
    canonicalAuthority: "services/api/scripts/lib/local-seed-guard.ts — the one refusal (name AND host) every seeder runs before its first write",
    redTest: `${T("local-seed-guard.test.ts")} (evidence/ET-UPL-04-red-baseline.txt)`,
    greenTest: `${T("local-seed-guard.test.ts")}; both seeders exit 1 on a remote host`,
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
