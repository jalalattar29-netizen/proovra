/**
 * Platform Control Center — Cost Dashboard (item G) UX contracts.
 *
 * Source-contract style (matches admin-security-billing-consoles.test.ts):
 * asserts the cost console page exists, renders through the shared PageShell
 * (no marketing hero), is wrapped in the platform.admin PageRouteGate, labels
 * costs honestly as ESTIMATED, shows EUR embeddings spend separately, presents
 * honest not-connected states, and never fabricates a "$X saved" / uptime
 * literal or surfaces secrets.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");
const exists = (rel: string): boolean => existsSync(resolve(APP_ROOT, rel));

const COSTS = "app/(app)/admin/costs/page.tsx";

test("cost dashboard page exists", () => {
  assert.ok(exists(COSTS), "cost dashboard page must exist");
});

test("renders through the shared PageShell (no marketing hero / legacy classes)", () => {
  const src = read(COSTS);
  assert.match(src, /PageShell/, "must use the shared PageShell");
  assert.doesNotMatch(
    src,
    /app-hero-full|className="app-hero/,
    "must not render the marketing app-hero",
  );
  assert.doesNotMatch(src, /cc-page|btn-/, "must not use legacy cc-page/btn- classes");
  assert.match(src, /AdminConsoleNav/, "must render the admin console nav");
  assert.match(src, /data-testid="admin-costs"/, "must expose the admin-costs test id");
});

test("wraps the page in the platform.admin PageRouteGate", () => {
  const src = read(COSTS);
  assert.match(src, /PageRouteGate/, "must import/use PageRouteGate");
  assert.match(
    src,
    /routeId="platform\.admin"/,
    "must gate on the platform.admin route",
  );
});

test("routes errors through toSafeUserError (sanctioned path)", () => {
  assert.match(read(COSTS), /toSafeUserError/, "must use toSafeUserError");
});

test("labels costs as ESTIMATED (never billed) and reads from the costs endpoint", () => {
  const src = read(COSTS);
  assert.match(src, /ESTIMATED|[Ee]stimated/, "costs must be labelled estimated");
  assert.match(src, /estimatedCostUsdMicros/, "must reference the estimated-cost source");
  assert.match(src, /\/v1\/admin\/costs/, "must call the costs endpoint");
});

test("shows embeddings spend as EUR, separate from the USD total", () => {
  const src = read(COSTS);
  assert.match(src, /EUR/, "embeddings spend labelled EUR");
  assert.match(src, /never summed into the USD total/i, "EUR kept out of the USD total");
});

test("presents honest not-connected states (no fabricated numbers)", () => {
  const src = read(COSTS);
  assert.match(src, /EmptyState/, "must render EmptyState");
  assert.match(
    src,
    /Not connected — no usage recorded for this category/,
    "honest not-connected copy for unmetered categories",
  );
  assert.match(src, /notConnectedCategories/, "renders the not-connected categories block");
});

test("never fabricates a '$X saved' / uptime literal or surfaces secrets", () => {
  const src = read(COSTS);
  // No marketing-style fabricated savings or uptime literals.
  assert.doesNotMatch(src, /\$\d[\d,]*\s*saved/i, "no fabricated '$X saved' literal");
  assert.doesNotMatch(src, /\b99\.\d+%\s*uptime/i, "no fabricated uptime literal");
  // No secrets / keys / tokens surfaced in the client.
  assert.doesNotMatch(
    src,
    /apiKey|accessToken|\.token\b|\.secret\b|process\.env/i,
    "must not surface keys / tokens / secrets / env",
  );
});
