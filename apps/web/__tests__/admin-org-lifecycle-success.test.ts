/**
 * Platform Control Center — Customer Lifecycle (B) + Customer Success (C) +
 * Platform Map (F) UI contract.
 *
 * File-text contract (node:test) pinning the additive surface on the existing
 * org roster + detail pages:
 *   • roster renders a "Lifecycle" column with a lifecycle Badge;
 *   • detail renders a "Customer Success" Card panel and a "Workspaces"
 *     platform-map DataTable;
 *   • honest "Not modelled" copy is present for unmodelled fields
 *     (accountManager / supportContact / renewalDate / supportTickets /
 *     onboardingCompletion) — never fabricated.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");

const ROSTER = "app/(app)/admin/organizations/page.tsx";
const DETAIL = "app/(app)/admin/organizations/[id]/page.tsx";

test("roster renders a Lifecycle column with a lifecycle Badge", () => {
  const src = read(ROSTER);
  assert.match(src, /header: "Lifecycle"/, "roster must have a Lifecycle column");
  assert.match(src, /lifecycleStage/, "roster must read lifecycleStage");
  assert.match(src, /LIFECYCLE_TONE\[/, "lifecycle badge must be toned");
});

test("detail has a Customer Success panel", () => {
  const src = read(DETAIL);
  assert.match(src, /title="Customer Success"/, "detail must have a Customer Success Card");
  assert.match(src, /customerSuccess\./, "detail must read the customerSuccess block");
  assert.match(src, /First evidence/, "must surface the first-evidence milestone");
  assert.match(src, /Last login/, "must surface the last-login milestone");
});

test("detail has a Workspaces platform-map DataTable", () => {
  const src = read(DETAIL);
  assert.match(src, /title="Workspaces"/, "detail must have a Workspaces Card");
  assert.match(src, /Platform map/, "must describe it as the platform map");
  assert.match(src, /DataTable/, "workspaces must render through a DataTable");
  assert.match(src, /workspaceColumns/, "must define workspace columns");
});

test("detail shows honest 'Not modelled' copy for unmodelled fields", () => {
  const src = read(DETAIL);
  assert.match(src, /Not modelled/, "must render 'Not modelled' copy");
  assert.match(src, /Account manager/, "account manager field present (not modelled)");
  assert.match(src, /Renewal date/, "renewal date field present (not modelled)");
  assert.match(src, /Support tickets/, "support tickets field present (not modelled)");
});

test("lifecycle UNKNOWN is a real stage (no fabricated ACTIVE default)", () => {
  const roster = read(ROSTER);
  const detail = read(DETAIL);
  assert.match(roster, /UNKNOWN/, "roster lifecycle map must include UNKNOWN");
  assert.match(detail, /UNKNOWN/, "detail lifecycle map must include UNKNOWN");
});
