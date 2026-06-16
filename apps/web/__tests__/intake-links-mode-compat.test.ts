/**
 * Intake-links-e2e mode-compat bugfix — frontend source-contract.
 *
 * Pins the three frontend behaviours added to fix the
 * `intake_mode_not_supported_by_template` regression:
 *
 *   1) When the operator changes Request Type, the modal auto-picks
 *      a supported intake mode if the current one isn't in the new
 *      template's `intakeModes` list, and clears any stale error.
 *   2) The friendlyCreateError helper maps backend reason codes
 *      (especially `intake_mode_not_supported_by_template`) to plain
 *      English. Raw enum strings must never reach the user.
 *   3) The frontend INTAKE_MODES values match the backend
 *      WORKFLOW_INTAKE_MODES enum exactly.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const PAGE = resolve(REPO_ROOT, "apps/web/app/(app)/intake-links/page.tsx");
const SHARED = resolve(
  REPO_ROOT,
  "packages/shared/src/workflow-types.ts",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

test("INTAKE_MODES on the page references the EXTERNAL_* values the backend accepts", () => {
  const src = read(PAGE);
  for (const mode of [
    "EXTERNAL_ONE_TIME",
    "EXTERNAL_REUSABLE",
    "EXTERNAL_ANONYMOUS",
    "EXTERNAL_PSEUDONYMOUS",
  ]) {
    assert.ok(
      src.includes(`value: "${mode}"`),
      `INTAKE_MODES is missing value: "${mode}"`,
    );
  }
});

test("frontend INTAKE_MODES are a subset of the shared WORKFLOW_INTAKE_MODES enum", () => {
  const pageSrc = read(PAGE);
  const sharedSrc = read(SHARED);
  // Pull the four EXTERNAL_* literals out of the page constant and
  // confirm every one appears in the shared enum source. If a future
  // refactor renames either side, this fails loudly instead of
  // shipping a silent enum drift.
  for (const mode of [
    "EXTERNAL_ONE_TIME",
    "EXTERNAL_REUSABLE",
    "EXTERNAL_ANONYMOUS",
    "EXTERNAL_PSEUDONYMOUS",
  ]) {
    assert.ok(
      pageSrc.includes(mode),
      `page is missing literal "${mode}"`,
    );
    assert.ok(
      sharedSrc.includes(`"${mode}"`),
      `shared enum is missing literal "${mode}"`,
    );
  }
});

test("changing request type auto-corrects to a supported intake mode + clears the stale error", () => {
  const src = read(PAGE);
  // The effect lives in CreateLinkModal and re-runs on (slug,
  // selectedTemplate, intakeMode) change. Pin the literal so a
  // refactor can't quietly drop the auto-correct.
  assert.match(src, /useEffect\(\(\) => \{[\s\S]{0,400}selectedTemplate/);
  // Auto-pick prefers EXTERNAL_ONE_TIME, falls back to the first
  // supported mode. Pin both branches.
  assert.match(
    src,
    /supported\.includes\("EXTERNAL_ONE_TIME"\)\s*\n?\s*\?\s*"EXTERNAL_ONE_TIME"\s*\n?\s*:\s*supported\[0\]/,
  );
  // The effect clears the create error every time it runs so the
  // user never sees a stale "intake_mode_not_supported_by_template"
  // after switching templates.
  assert.match(src, /setError\(null\);[\s\S]{0,80}\}, \[slug, selectedTemplate, intakeMode\]\);/);
});

test("friendlyCreateError maps the intake_mode_not_supported_by_template code to plain English", () => {
  const src = read(PAGE);
  assert.match(src, /function friendlyCreateError\(/);
  // The exact required copy — quoted from the bug brief.
  assert.match(
    src,
    /This request type does not support the selected intake mode\. Please choose another mode\./,
  );
  // The raw enum key must be mapped (so the user never sees the raw code).
  assert.match(src, /intake_mode_not_supported_by_template:/);
});

test("friendlyCreateError also covers the other create-time reason codes operators might hit", () => {
  const src = read(PAGE);
  for (const code of [
    "FEATURE_DISABLED",
    "template_not_found",
    "rate_limited",
  ]) {
    assert.ok(
      src.includes(`${code}:`),
      `friendlyCreateError missing mapping for "${code}"`,
    );
  }
});

test("submit catch block now routes through friendlyCreateError (no raw enum leak)", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /setError\(friendlyCreateError\(e\?\.code, e\?\.message\)\)/,
  );
});

test("REQUEST_TYPES — every catalog slug matches a real seed (no dropdown 404 at submit)", () => {
  const src = read(PAGE);
  // The slugs the catalog references must match the seed IDs in
  // capture-intake-templates.ts (asserted on the backend side too).
  for (const slug of [
    "general-evidence-record",
    "photos-videos",
    "documents",
    "insurance-claim",
    "legal-matter",
    "property-damage",
    "incident-investigation",
    "compliance-audit",
    "journalism-field-capture",
  ]) {
    assert.ok(
      src.includes(`slug: "${slug}"`),
      `REQUEST_TYPES missing slug "${slug}"`,
    );
  }
});
