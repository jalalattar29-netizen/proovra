/**
 * Workspace closure UI contracts (lifecycle Phase 7, 2026-07-17).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CARD = readFileSync(
  resolve(APP_ROOT, "app/(app)/teams/[id]/components/WorkspaceClosureCard.tsx"),
  "utf8",
);
const PAGE = readFileSync(
  resolve(APP_ROOT, "app/(app)/teams/[id]/page.tsx"),
  "utf8",
);
const LIFECYCLE = readFileSync(
  resolve(APP_ROOT, "app/(app)/settings/_sections/WorkspaceLifecycleSection.tsx"),
  "utf8",
);

// MEMBERS AUDIT LIFE-01/02 — the closure card moved off Members & Access to
// the workspace's Lifecycle surface, mounted only for the OWNER of a kind the
// server's policy says can close (a Personal Workspace never shows it).
test("the card mounts owner-only, and only where the server's lifecycle policy says the workspace closes", () => {
  assert.doesNotMatch(PAGE, /<WorkspaceClosureCard/);
  assert.match(LIFECYCLE, /policy\.kind === "OWNED" && isOwner/);
  assert.match(LIFECYCLE, /policy\.closable \? <WorkspaceClosureCard teamId=\{workspace\.id\} \/> : null/);
  assert.doesNotMatch(LIFECYCLE, /Delete workspace|method: "DELETE"/);
});

test("closure requires the typed phrase sent to the backend (no boolean)", () => {
  assert.match(CARD, /apiFetch\(`\/v1\/teams\/\$\{teamId\}\/closure`/);
  assert.match(CARD, /confirmation:\s*phrase/);
  assert.match(CARD, /phrase\.trim\(\)\.toLowerCase\(\) !== phraseExpected/);
  assert.doesNotMatch(CARD, /confirmed:\s*true/);
});

test("collaboration consequence + evidence preservation copy are honest", () => {
  assert.match(CARD, /membersLosingAccess/);
  assert.match(CARD, /Evidence is never deleted by workspace closure/);
});

test("step-up reuse + stable-code error handling + cancel action", () => {
  assert.match(CARD, /StepUpVerify/);
  assert.match(CARD, /code === "closure_blocked"/);
  assert.match(CARD, /code === "confirmation_mismatch"/);
  assert.match(CARD, /closure\/\$\{requestId\}\/cancel/);
  assert.match(CARD, /data-action="cancel-workspace-closure"/);
});
