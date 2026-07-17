/**
 * Leave-organization UI contracts (lifecycle Phase 1, 2026-07-16).
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

test("leave action is hidden for ORG_OWNER (backend enforces the same guard)", () => {
  assert.match(PAGE, /callerRole !== "ORG_OWNER"[\s\S]{0,400}data-action="leave-organization"/);
});

test("leave requires an explicit confirmation dialog, not a bare click", () => {
  assert.match(PAGE, /useConfirmAction/);
  assert.match(PAGE, /confirmLabel: "Leave organization"/);
  assert.match(PAGE, /tone: "danger"/);
});

test("leave calls the canonical route, refreshes the envelope, and navigates away", () => {
  assert.match(PAGE, /apiFetch\(`\/v1\/orgs\/\$\{orgId\}\/leave`, \{ method: "POST" \}\)/);
  assert.match(PAGE, /platformCtx\.refresh\(\)/);
  assert.match(PAGE, /router\.replace\("\/organizations"\)/);
});

test("the owner-block denial surfaces by STABLE code, not message matching", () => {
  assert.match(PAGE, /error\?\.code === "OWNERSHIP_TRANSFER_REQUIRED"/);
});
