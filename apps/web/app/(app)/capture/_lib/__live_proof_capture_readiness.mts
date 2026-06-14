// Phase CAPTURE-PRIMARY-LIVE-FIX — runtime proof script.
// Not a test. Reads the live API templates from a JSON file the
// caller wrote to disk (passed via argv[2]) and runs the production
// readiness helpers against the EXACT (role, checklistStepId) pairs
// the live dropdown would produce. Prints a per-step result and
// exits non-zero on any mismatch.

import {
  hasPrimaryEvidence,
  getRoleFromChecklistStep,
  computeCaptureReadiness,
} from "./captureReadiness";
import { readFileSync } from "node:fs";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("usage: tsx __live_proof_capture_readiness.mts <templates.json>");
  process.exit(2);
}
const templates = JSON.parse(readFileSync(inputPath, "utf8"));

let pass = 0;
let fail = 0;
const failures: string[] = [];

for (const t of templates) {
  for (const step of t.steps) {
    if (!step.required) continue;
    const role = getRoleFromChecklistStep(step) + " evidence";
    // The SessionItem shape — only the fields the predicate touches.
    const item = {
      id: "x",
      file: undefined as never,
      previewUrl: null,
      mimeType: "image/jpeg",
      relativePath: null,
      uploadProgress: 100,
      uploading: false,
      error: null,
      role,
      checklistStepId: step.id,
      privateNote: "",
      sourceLabel: "",
      clientSignals: {
        captureTimeUtc: new Date().toISOString(),
        browserMediaCaptureAvailable: true,
        folderPathPresent: false,
        locationIncluded: false,
      },
    } as never;

    const isPrimaryByLabel = getRoleFromChecklistStep(step) === "Primary";
    const predicateResult = hasPrimaryEvidence([item]);
    const readiness = computeCaptureReadiness({
      items: [item],
      workflow: "VERIFICATION_DOCUMENTATION",
    });
    const has_primary = readiness.criteria.find((c) => c.id === "has_primary");
    const satisfied = Boolean(has_primary && has_primary.satisfied);

    const expected = isPrimaryByLabel;
    const ok = predicateResult === expected && satisfied === expected;
    if (ok) {
      pass++;
      console.log(
        `✓ ${t.templateId}/${step.id} role="${role}" predicate=${predicateResult} satisfied=${satisfied}`,
      );
    } else {
      fail++;
      const msg = `✗ ${t.templateId}/${step.id} role="${role}" predicate=${predicateResult} satisfied=${satisfied} expected=${expected}`;
      failures.push(msg);
      console.error(msg);
    }
  }
}

console.log("");
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
