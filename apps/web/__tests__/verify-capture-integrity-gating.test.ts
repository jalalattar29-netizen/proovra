/**
 * Public Verify — Capture Integrity gating (Part 2 hardening).
 *
 * Source-contract test over apps/web/app/verify/[token]/page.tsx. Pins:
 *   1. No terse "absent" internal-constant strings appear as primary
 *      user-facing text ("RFC3161 absent", "OpenTimestamps absent",
 *      "Server-countersigned no", "Source signature: MISSING", etc.).
 *   2. The capture-side panel is gated on a POSITIVE capture-side signal
 *      and otherwise routed into an Advanced details accordion
 *      (`verify-capture-trust-advanced`) with reassuring human wording.
 *   3. The current-preservation language (preservation shown above) is
 *      preserved so the page emphasises current verification.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
// CR4 decomposition — the capture-integrity gating + the technical-
// metadata cards were extracted out of the verify orchestrator into
// dedicated components. The orchestrator page now only wires data into
// them, so the gating/wording source-contract assertions scan the
// extracted component. The "no terse absent language" check scans BOTH
// the page and the component to prove the language exists nowhere.
const PAGE =
  readFileSync(resolve(HERE, "..", "app", "verify", "[token]", "page.tsx"), "utf8") +
  readFileSync(
    resolve(HERE, "..", "components", "verify-v2", "VerifyCaptureIntegritySection.tsx"),
    "utf8",
  );

test("no terse RFC3161/OTS/countersign 'absent' language as primary text", () => {
  for (const banned of [
    "RFC3161 absent",
    "OpenTimestamps absent",
    "Server-countersigned no",
    "RFC3161 was not applied by the capture client",
    "OpenTimestamps was not applied by the capture client",
    "Source signature: {captureTrust.signatureVerdict}",
    "Device attestation: {captureTrust.attestationVerdict}",
  ]) {
    assert.ok(
      !PAGE.includes(banned),
      `verify page must not contain terse/absent text: ${banned}`,
    );
  }
});

test("capture-side integrity is gated on a positive signal", () => {
  // The render is conditional on at least one positive capture-side
  // signal (signature present / attestation attempted / countersigned /
  // capture-side rfc3161 or ots applied).
  assert.ok(
    PAGE.includes('captureTrust.signatureVerdict !== "MISSING"'),
    "must gate on signatureVerdict !== MISSING",
  );
  assert.ok(
    PAGE.includes('captureTrust.attestationVerdict !== "NOT_ATTEMPTED"'),
    "must gate on attestationVerdict !== NOT_ATTEMPTED",
  );
  assert.ok(
    PAGE.includes("captureTrust.serverCountersigned") &&
      PAGE.includes("captureTrust.rfc3161Applied") &&
      PAGE.includes("captureTrust.otsApplied"),
    "must include positive-signal checks for countersign/rfc3161/ots",
  );
});

test("absent case is routed into an Advanced details accordion with reassuring wording", () => {
  assert.ok(
    PAGE.includes("verify-capture-trust-advanced"),
    "must render an Advanced details accordion for the absent case",
  );
  assert.ok(
    PAGE.includes("does not reduce the recorded preservation"),
    "advanced note must reassure that preservation verdict is unaffected",
  );
  assert.ok(
    PAGE.includes("Advanced: capture-side integrity"),
    "advanced accordion must have a clear summary label",
  );
});

test("current-preservation emphasis is preserved", () => {
  // Contiguous substrings (the surrounding copy is line-wrapped in JSX).
  assert.ok(
    PAGE.includes("verified preservation") ||
      PAGE.includes("Current preservation verification"),
    "must point reviewers to the current preservation verification",
  );
});

// ============================================================================
// PHASE 12B (Evidence Operations, 2026-07-29) — redaction verification.
//
// The anonymous evidenceId probe GET /v1/redaction/public/verify/:evidenceId
// was DELETED. Its fields were converged onto this page's own token-bound
// projection (`GET /public/verify/:id` → `redaction`) so the badge inherits
// that route's rate limits, publication / integrity / destroyed /
// finalization gates, audit, and workspace anchoring.
// ============================================================================

test("verify page renders the redaction badge from its own token-bound projection", () => {
  const orchestrator = readFileSync(
    resolve(HERE, "..", "app", "verify", "[token]", "page.tsx"),
    "utf8",
  );
  assert.match(orchestrator, /<VerifyRedactionSection/);
  assert.match(orchestrator, /setRedaction\(/);
  // Never CALL the deleted anonymous probe (the file names the removed
  // path in a deletion note on purpose — assert on the call form).
  assert.ok(!/apiFetch\([^)]*\/v1\/redaction\/public\/verify/.test(orchestrator));
  assert.ok(!/fetch\(\s*["'`][^"'`]*\/v1\/redaction\/public\/verify/.test(orchestrator));
});

test("redaction section is count-only and renders nothing without data", () => {
  const section = readFileSync(
    resolve(HERE, "..", "components", "verify-v2", "VerifyRedactionSection.tsx"),
    "utf8",
  );
  assert.match(section, /if \(!redaction\) return null;/);
  for (const field of [
    "hasPublishedDerivative",
    "publishedVersionOrdinal",
    "publishedAtUtc",
    "approvalCount",
    "videoProvenance",
  ]) {
    assert.ok(section.includes(field), `missing converged field ${field}`);
  }
  // Bounded limitation codes are rendered through a copy map, never raw.
  assert.match(section, /REDACTION_NEVER_MODIFIES_ORIGINAL/);
  assert.match(section, /LIMITATION_COPY\[code\]/);
  // Never geometry / detection text / rationale as rendered fields.
  assert.ok(!/redaction\.geometry/.test(section));
  assert.ok(!/redaction\.rationale/.test(section));
  assert.ok(!/redaction\.detections/.test(section));
});
