/**
 * Organization lifecycle UI contracts (lifecycle Phase 6, 2026-07-17).
 * Pins the owner-only transfer + closure controls on the organization
 * detail page — real backend-wired actions only.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = readFileSync(
  resolve(APP_ROOT, "app/(app)/organizations/[id]/page.tsx"),
  "utf8",
);

test("lifecycle controls render for ORG_OWNER only (backend enforces the same)", () => {
  assert.match(PAGE, /callerRole === "ORG_OWNER" \? \(\s*<OrgLifecycleControls/);
});

test("the stale 'not yet self-service' honesty notes are gone", () => {
  assert.doesNotMatch(PAGE, /not yet a self-service action/);
  assert.doesNotMatch(PAGE, /not yet a one-step/);
  assert.doesNotMatch(PAGE, /archive-organization-note/);
});

test("transfer targets existing members and calls the canonical route", () => {
  assert.match(PAGE, /m\.role !== "ORG_OWNER"/);
  assert.match(PAGE, /apiFetch\(`\/v1\/orgs\/\$\{orgId\}\/transfer-ownership`/);
  assert.match(PAGE, /targetUserId,/);
});

test("closure requires the typed phrase sent to the backend (no boolean)", () => {
  assert.match(PAGE, /apiFetch\(`\/v1\/orgs\/\$\{orgId\}\/closure`/);
  assert.match(PAGE, /confirmation:\s*phrase/);
  assert.match(PAGE, /phrase\.trim\(\)\.toLowerCase\(\) !== phraseExpected/);
  assert.doesNotMatch(PAGE, /confirmed:\s*true/);
});

test("both lifecycle actions reuse the shared StepUpVerify client", () => {
  assert.match(PAGE, /StepUpVerify/);
  assert.match(PAGE, /void transferOwnership\(proof\)/);
  assert.match(PAGE, /void requestClosure\(proof\)/);
});

test("closure state machine surfaces blockers and a cancel action", () => {
  assert.match(PAGE, /data-action="cancel-organization-closure"/);
  assert.match(PAGE, /closure\/\$\{requestId\}\/cancel/);
  assert.match(PAGE, /data-org-closure-blockers/);
});

test("errors surface by STABLE code, not message matching", () => {
  assert.match(PAGE, /code === "target_not_member"/);
  assert.match(PAGE, /code === "closure_blocked"/);
  assert.match(PAGE, /code === "confirmation_mismatch"/);
});
