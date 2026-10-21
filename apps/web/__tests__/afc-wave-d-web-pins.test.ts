/**
 * Independent forward audit closure — Wave D source pins on the web app.
 *
 * F-16: the Reports page fallback maps the canonical output state through THE
 *       shared row mapping; its own copy read a BLOCKED package as
 *       "not requested". (Behaviour: packages/shared afc-presentation-authorities
 *       and services/api afc-reports-row-lifecycle.)
 * F-27: the admin TSA tile names what it counts — validation failures.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(WEB, p), "utf8");

test("F-16: the Reports page reads THE shared row mapping and keeps no copy of it", () => {
  const src = read("components/reports-experience/ReportsIndex.tsx");
  assert.match(src, /import \{ outputRowLifecycle, type EvidenceOutputState \} from "@proovra\/shared"/);
  assert.match(src, /const toPackageLifecycle = \(state: EvidenceOutputState\): PackageLifecycle => outputRowLifecycle\(state\)/);
  assert.doesNotMatch(src, /case "BLOCKED":\s*return "not_requested"/);
  assert.doesNotMatch(src, /function toPackageLifecycle\(/);
});

test("F-27: the admin TSA tiles say validation failures", () => {
  for (const page of ["app/(app)/admin/page.tsx", "app/(app)/admin/evidence-ops/page.tsx"]) {
    const src = read(page);
    assert.match(src, /label="TSA validation failures"/, page);
    assert.doesNotMatch(src, /label="TSA failures"/, page);
  }
});

// ---------------------------------------------------------------------------
// Closure audit (Wave F)
// ---------------------------------------------------------------------------
test("F-13 (closure): the relationships section and the home fallback state no raw or assumed status", () => {
  const rel = read("app/(app)/evidence/[id]/components/EvidenceRelationshipsSection.tsx");
  assert.ok(rel.includes("evidenceRecordStatusLabel(item.linkedEvidence.status)"));
  assert.ok(!rel.includes("linkedEvidence.status.replace("));
  const home = read("components/home-experience/home-view-model.ts");
  assert.ok(!home.includes('r.status ?? "SIGNED"'));
});

test("F-28 (closure): Public Verify and the appendix tab state the custody verdict in words", () => {
  const verify = read("app/verify/[token]/page.tsx");
  assert.ok(verify.includes("custodyChainVerdictLabel({ valid: false, reason: custodyChainFailureReason })"));
  assert.ok(!verify.includes("Custody chain check reported: {custodyChainFailureReason}"));
  const tab = read("app/(app)/evidence/[id]/_tabs/EvidenceTechnicalAppendixTab.tsx");
  assert.ok(tab.includes("value: custodyChainVerdictLabel(preservation.custodyChain),"));
  assert.ok(!tab.includes("Review required (${"));
  const lib = read("app/(app)/evidence/[id]/_tabs/_lib.tsx");
  assert.ok(lib.includes("return pdfSignatureStatusLabel(artifactStatus.report.pdfSignature.status);"));
});
