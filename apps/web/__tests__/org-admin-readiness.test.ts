/**
 * Phase 8 (Enterprise Production Readiness) — SCOPE D/E — Org admin /
 * Operational Readiness tab.
 *
 * Structural guarantees (source-inspection; mirrors
 * enterprise-admin-overview.test.ts). We assert that the readiness page:
 *
 *   - Exists on disk and is org-admin gated via PageRouteGate
 *     routeId="account.organization_admin_readiness".
 *   - Reads ONLY org/workspace-scoped health endpoints (ops/health,
 *     sso/health, integrations/health, ops/incidents) plus the org's own
 *     workspace list — and NEVER calls platform-internal endpoints
 *     (ops/metrics, schema-status, queues, prometheus).
 *   - Is read-only (no mutating verbs, no window.confirm).
 *   - Renders honest degraded / unknown / not-surfaced / last-checked
 *     states — with NO hardcoded "healthy"/uptime/availability literals.
 *   - Uses the safe-feedback error path (toSafeUserError).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const READINESS_PAGE = resolve(
  APP_ROOT,
  "app/(app)/organizations/[id]/admin/readiness/page.tsx",
);

function src(): string {
  return readFileSync(READINESS_PAGE, "utf8");
}

// ---------------------------------------------------------------------------
// Existence + gating.
// ---------------------------------------------------------------------------

test("Readiness page exists on disk", () => {
  assert.ok(
    existsSync(READINESS_PAGE),
    "organizations/[id]/admin/readiness/page.tsx must exist",
  );
});

test("Readiness is gated via PageRouteGate routeId=account.organization_admin_readiness", () => {
  const s = src();
  assert.match(s, /PageRouteGate/, "must wrap in PageRouteGate");
  assert.match(
    s,
    /routeId="account\.organization_admin_readiness"/,
    "must gate on the readiness route id",
  );
});

// ---------------------------------------------------------------------------
// Org/workspace-scoped endpoints ONLY — no platform internals.
// ---------------------------------------------------------------------------

test("Readiness reads the org-scoped health endpoints", () => {
  const s = src();
  for (const path of [
    /\/v1\/orgs\/\$\{encodeURIComponent\(orgId\)\}\/workspaces/,
    /\/v1\/ops\/health\$\{qs\}/,
    /\/v1\/sso\/health\$\{qs\}/,
    /\/v1\/integrations\/health\$\{qs\}/,
    /\/v1\/ops\/incidents\$\{qs\}/,
  ]) {
    assert.match(s, path, `must read ${path}`);
  }
});

test("Readiness is workspace-scoped — every health call carries teamId", () => {
  const s = src();
  assert.match(
    s,
    /const qs = `\?teamId=\$\{encodeURIComponent\(teamId\)\}`/,
    "health calls must be scoped by teamId",
  );
});

test("Readiness does NOT call platform-internal endpoints", () => {
  const s = src();
  // These are platform-admin / cross-tenant / raw-metrics surfaces that a
  // customer org admin must never see. Owned by the platform /operations
  // workstream, not this org-scoped page.
  for (const forbidden of [
    /\/v1\/ops\/metrics/,
    /\/admin\/runtime\/schema-status/,
    /\/v1\/ops\/workflows/,
    /\/v1\/ops\/causality/,
    /\/v1\/ops\/bulk-actions/,
    /\/metrics\b/, // prometheus exposition
    /\/readyz/,
    /\/healthz/,
  ]) {
    assert.doesNotMatch(
      s,
      forbidden,
      `must NOT call platform-internal endpoint ${forbidden}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Read-only + safe feedback.
// ---------------------------------------------------------------------------

test("Readiness is read-only — no mutating verbs, no native confirm", () => {
  const s = src();
  assert.doesNotMatch(s, /method:\s*"(POST|PUT|PATCH|DELETE)"/, "no mutations");
  assert.doesNotMatch(s, /window\.confirm\(/, "no native confirm dialog");
});

test("Readiness uses the safe-feedback error path", () => {
  const s = src();
  assert.match(s, /toSafeUserError/, "must use toSafeUserError");
  // No raw error.message passthrough (banned app-wide).
  assert.doesNotMatch(
    s,
    /\berr(or)?\.message\b/,
    "must not display raw error.message",
  );
});

// ---------------------------------------------------------------------------
// Honest states — no fabricated positives.
// ---------------------------------------------------------------------------

test("Readiness renders a real Last-checked timestamp (not a literal)", () => {
  const s = src();
  assert.match(s, /readiness-last-checked/, "must render a Last checked marker");
  assert.match(
    s,
    /formatUserDateTime\(/,
    "Last checked must format a real timestamp",
  );
});

test("Readiness derives statuses from response fields, not hardcoded health", () => {
  const s = src();
  // The database status must be read from the response, not asserted.
  assert.match(
    s,
    /panel\.data\.database === "up"/,
    "database status must derive from the real response field",
  );
  // Degraded / unknown states must be representable — no blanket
  // "healthy"/"100%"/"uptime" literal that fakes availability.
  assert.doesNotMatch(
    s,
    /uptime/i,
    "must not fabricate uptime",
  );
  assert.doesNotMatch(
    s,
    /"100%"|'100%'/,
    "must not hardcode a 100% availability figure",
  );
});

test("Readiness honestly reports null delivery/latency as no-data (—), not 0", () => {
  const s = src();
  assert.match(
    s,
    /successRateLast24h == null/,
    "null success rate must be handled as no-data",
  );
  assert.match(
    s,
    /averageLatencyMsLast24h == null/,
    "null latency must be handled as no-data",
  );
});

test("Readiness surfaces evidence-ops and marks TSA/OTS as not surfaced at org scope", () => {
  const s = src();
  // Report / package / storage are surfaced from real incident categories.
  for (const cat of ["REPORT", "PACKAGE", "STORAGE"]) {
    assert.ok(
      s.includes(`"${cat}"`),
      `evidence-ops must reference the ${cat} incident category`,
    );
  }
  // Timestamping (TSA) + anchoring (OTS) have no org-scoped signal — must
  // say so honestly, never invent a status.
  assert.match(
    s,
    /Not surfaced at organization scope/,
    "TSA/OTS must render an honest not-surfaced state",
  );
});

// ---------------------------------------------------------------------------
// Per-panel resilience + design system.
// ---------------------------------------------------------------------------

test("Readiness uses a per-panel state machine so one failure doesn't blank the page", () => {
  const s = src();
  assert.match(s, /Promise\.allSettled/, "must isolate per-panel failures");
  assert.match(s, /PanelState/, "must use a bounded panel state machine");
});

test("Readiness uses the shared design system primitives", () => {
  const s = src();
  assert.match(s, /components\/ui\/Card/, "deep-imports Card");
  assert.match(s, /components\/ui\/Badge/, "deep-imports Badge");
  assert.match(s, /tone=\{/, "uses Badge tones for status");
});
