// Authoring helper, batch 3: Invariant D (current authority). Idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));
const T = "services/api/test/stale-authority.integration.test.ts";
const RED = "red on a40ca76f: 'expected 200 to be 404' (evidence/stale-authority-red-baseline.txt)";

Object.assign(L.findings, {
  "ET-SEC-03": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The legacy read gate and the byte-release gate's role lookup checked TeamMember.status === ACTIVE only, ignoring access expiry and organization lifecycle.",
    canonicalAuthority: "resolveEvidenceRecordAccess / evaluateMemberAccess (access-policy): read gate delegates with evidence.read; the byte-release gate asks for the exact download capability",
    obsoleteRemoved: "the hand-rolled ACTIVE-status membership reads in getEvidenceWithReadAccess",
    redTest: `${T} [ET-SEC-03 expired member; suspended organization] (${RED})`,
    greenTest: `${T} [ET-SEC-03 x2]; artifact-action-contract.integration.test.ts (suspended organization -> 404)`,
    negativeAuthTests: "expired member read + download refused; suspended-organization member refused",
    compatibilityImpact: "members of a suspended organization get the anti-enumeration 404 on record reads (canonical engine denies every permission while the organization is not ACTIVE)",
  },
  "ET-SEC-04": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "CaseAccess grants and case ownership were honoured without membership re-proof in the legacy read gate and requireCaseAccess.",
    canonicalAuthority: "resolveCaseRecordAccess (case-permission.service): current workspace authority first; case owner / CaseAccess only narrow it; personal-scope cases owner-only",
    obsoleteRemoved: "requireCaseAccess's own owner / CaseAccess / ACTIVE-status branches; the case-derived branches of the legacy read gate",
    redTest: `${T} [ET-SEC-04] (${RED})`,
    greenTest: `${T} [ET-SEC-04]; byte-release-authority.integration.test.ts (CaseAccess on a personal record grants nothing); phase-32-8-d-cases-reports.test.ts`,
    negativeAuthTests: "CaseAccess outsider refused on case and record; a current member on the access list keeps access",
    compatibilityImpact: "a CaseAccess row no longer lets a non-member read a record (including personal records shared through a personal case)",
  },
  "ET-SEC-05": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Creator identity short-circuited read and moderation checks after the creator left the workspace.",
    canonicalAuthority: "canonical engine first; creator / OWNER / ADMIN only after current authority passes",
    redTest: `${T} [ET-SEC-05] (${RED})`,
    greenTest: `${T} [ET-SEC-05]`,
    negativeAuthTests: "revoked former creator refused",
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
