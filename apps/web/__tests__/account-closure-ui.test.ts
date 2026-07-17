/**
 * Account closure + data export UI contracts (lifecycle Phases 4–5,
 * 2026-07-17). Pins the /settings/privacy surface: real backend-wired
 * controls only, typed confirmation, step-up reuse, stable-code error
 * handling.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 2026-07-17 IA refactor — the privacy page became the Privacy SECTION of
// the unified /settings workspace; the implementation is unchanged.
const PAGE = readFileSync(
  resolve(APP_ROOT, "app/(app)/settings/_sections/PrivacySection.tsx"),
  "utf8",
);

test("data export card calls the canonical routes through apiFetch (never raw fetch)", () => {
  assert.match(PAGE, /apiFetch\("\/v1\/identity\/data-export"/);
  assert.match(PAGE, /apiFetch\(`\/v1\/identity\/data-export\/\$\{id\}\/download`/);
  assert.doesNotMatch(PAGE, /fetch\("\/api\//);
});

test("closure card requires the typed phrase and sends it to the backend for validation", () => {
  assert.match(PAGE, /apiFetch\("\/v1\/identity\/account-closure"/);
  assert.match(PAGE, /confirmation:\s*phrase/);
  // The submit button stays disabled until the typed phrase matches —
  // and the page NEVER sends a `confirmed: true` style boolean.
  assert.match(PAGE, /phrase\.trim\(\)\.toLowerCase\(\) !== phraseExpected/);
  assert.doesNotMatch(PAGE, /confirmed:\s*true/);
});

test("both cards reuse the shared StepUpVerify client and retry with proof", () => {
  assert.match(PAGE, /StepUpVerify/);
  assert.match(PAGE, /extractStepUp/);
  assert.match(PAGE, /void requestClosure\(proof\)/);
});

test("closure errors surface by STABLE code, not message matching", () => {
  assert.match(PAGE, /code === "closure_blocked"/);
  assert.match(PAGE, /code === "confirmation_mismatch"/);
  assert.match(PAGE, /code === "closure_request_active"/);
});

test("an open request shows the cancellation window and a cancel action", () => {
  assert.match(PAGE, /data-cc-closure-cancel/);
  assert.match(PAGE, /account-closure\/\$\{id\}\/cancel/);
  assert.match(PAGE, /coolingOffEndsAtUtc/);
});

test("evidence-preservation honesty copy is present (closure never deletes evidence)", () => {
  assert.match(PAGE, /Evidence is\s+never deleted by account closure/);
});
