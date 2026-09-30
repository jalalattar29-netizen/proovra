// Authoring helper, batch 14: integrity + commercial truth (ET-SEC-21, -22,
// -23, -35). Idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));

const T = (f) => `services/api/test/${f}`;
const RISK = T("case-risk-live-integrity.integration.test.ts");
const SNAP = T("integrity-snapshot-truth.test.ts");

Object.assign(L.findings, {
  "ET-SEC-21": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The case risk engine counted integrity failures from evidence_integrity_snapshots, backfilled once for SIGNED/REPORTED rows and never refreshed, so a FAILED_HASH_MISMATCH record raised no risk.",
    canonicalAuthority: "case-risk-engine.service reads the live evidence rows (status FAILED_HASH_MISMATCH / verificationStatus FAILED; REVIEW_REQUIRED for review)",
    obsoleteRemoved: "the risk engine's evidence_integrity_snapshots read",
    redTest: `${RISK} (evidence/ET-SEC-21-35-red-baseline.txt)`,
    greenTest: RISK,
  },
  "ET-SEC-22": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Personal-workspace storage was measured over the personal scope (legacy NULL-team rows + team) at creation and over the strict team id at completion, so completion undercounted every legacy byte.",
    canonicalAuthority: "workspace-usage.service getWorkspaceUsage over the canonical evidenceScopeFor population for both enforcement points",
    redTest: `${T("workspace-usage-population.integration.test.ts")} (evidence/ET-SEC-22-red-baseline.txt)`,
    greenTest: T("workspace-usage-population.integration.test.ts"),
  },
  "ET-SEC-23": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The Pricing page hard-coded FREE storage add-ons as \"Not available\" while the shared commercial policy and the API let a FREE account buy them.",
    canonicalAuthority: "@proovra/shared-billing resolveStorageAddonEntitlement — the Pricing row's storageAddonCell derives every self-service cell from it",
    obsoleteRemoved: "the hard-coded Storage add-ons cells",
    redTest: "apps/web/__tests__/pricing-storage-addons-truth.test.ts (evidence/ET-SEC-23-red-baseline.txt)",
    greenTest: "apps/web/__tests__/pricing-storage-addons-truth.test.ts",
  },
  "ET-SEC-35": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "deriveIntegritySnapshot wrote hash/signature/custody true for MATERIALS_AVAILABLE (nothing verified), all three false for a hash mismatch, and OTS matches from status alone.",
    canonicalAuthority: "dashboard/integrity-snapshot.service deriveIntegritySnapshot: only RECORDED_INTEGRITY_VERIFIED claims all three; FAILED is canonicalHashMatches false only; otsHashMatches compares otsHash with fingerprintHash",
    redTest: `${SNAP} (evidence/ET-SEC-21-35-red-baseline.txt)`,
    greenTest: SNAP,
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
