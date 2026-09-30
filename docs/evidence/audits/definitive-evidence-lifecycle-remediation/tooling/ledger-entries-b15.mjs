// Authoring helper, batch 15: authorization closure (ET-SEC-14, -15, -16,
// -31). Idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));

const T = (f) => `services/api/test/${f}`;

Object.assign(L.findings, {
  "ET-SEC-14": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Report regeneration checked only the evidence.generate_report permission, so review-before-report, the report/package switches and the template overlay were bypassed by a recovery or an updated version.",
    canonicalAuthority: "finalization-governance decideGovernedOutputActions (the one output-policy decision); evaluateOutputRegenerationGovernance (generate_report + generate_package) on POST /v1/evidence/:id/reports/regenerate",
    redTest: `${T("report-regenerate-governance.integration.test.ts")} (evidence/ET-SEC-14-red-baseline.txt)`,
    greenTest: T("report-regenerate-governance.integration.test.ts"),
  },
  "ET-SEC-15": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The paid AI categorization run loaded the record with read access and asked the AI policy with no role and no plan answer.",
    canonicalAuthority: "getEvidenceWithRecordAccess(evidence.update_metadata); evaluateWorkspaceAiPolicy with the ACTIVE membership role and scopeIncludesAiOperations (billing-enforcement decideAiOperationAllowance) for the record's commercial subject",
    redTest: `${T("ai-categorization-run-authority.integration.test.ts")} (evidence/ET-SEC-15-red-baseline.txt)`,
    greenTest: T("ai-categorization-run-authority.integration.test.ts"),
  },
  "ET-SEC-16": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Single, bulk and case-workspace link/unlink answered the case permission three ways: bulk admitted any member and checked no case on remove; the single routes ignored CaseAccess and gated on the record's creator.",
    canonicalAuthority: "case-permission.service authorizeCaseEvidenceLink (resolveCaseRecordAccess + EVIDENCE_LINK matrix + canonical record access) on every link and unlink path; detachEvidenceFromCase the one detach (teamId unchanged since ET-SEC-02)",
    obsoleteRemoved: "the bulk canAccessCase check; the single routes' owner shortcut and creator gate; case-workspace's per-route requireCaseAccess + gateCaseMutation for EVIDENCE_LINK",
    redTest: `${T("case-link-authority.integration.test.ts")} (evidence/ET-SEC-16-red-baseline.txt)`,
    greenTest: T("case-link-authority.integration.test.ts"),
  },
  "ET-SEC-31": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Case-filtered evidence lists, capture drafts and unauthenticated public verify of an unfinalized record answered differently for a hidden resource than for a missing one.",
    canonicalAuthority: "uniform 404: assertCaseAccess over resolveCaseRecordAccess; capture loadOwnedDraft; /public/verify/:id not-finalized branch (audit keeps the real outcome); case attach via authorizeCaseEvidenceLink",
    obsoleteRemoved: "EVIDENCE_NOT_FINALIZED response, its shared copy and web registry entry",
    redTest: `${T("existence-oracles-uniform-404.integration.test.ts")} (evidence/ET-SEC-31-red-baseline.txt)`,
    greenTest: T("existence-oracles-uniform-404.integration.test.ts"),
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
