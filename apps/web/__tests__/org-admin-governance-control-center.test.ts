/**
 * Phase 5 (Enterprise Governance) — Org admin / Governance Control Center.
 *
 * Structural guarantees (no DOM runtime — mirrors
 * enterprise-admin-overview.test.ts): the governance tab is the canonical
 * evidence-Governance Control Center. It is org-admin gated, read-only,
 * reads the real org-scoped aggregate, renders the required governance
 * sections, degrades to honest empty/unavailable states, and deep-links to
 * the canonical governance surfaces.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const GOV_PAGE = resolve(
  APP_ROOT,
  "app/(app)/organizations/[id]/admin/governance/page.tsx",
);

function src(): string {
  return readFileSync(GOV_PAGE, "utf8");
}

// ---------------------------------------------------------------------------
// Existence + gating.
// ---------------------------------------------------------------------------

test("Governance page exists on disk", () => {
  assert.ok(existsSync(GOV_PAGE), "admin/governance/page.tsx must exist");
});

test("Governance control center is org-admin gated via PageRouteGate", () => {
  const s = src();
  assert.match(s, /PageRouteGate/, "must wrap in PageRouteGate");
  assert.match(
    s,
    /routeId="account\.organization-detail"/,
    "must gate on the org-detail route id (org membership + enterprise tier)",
  );
});

// ---------------------------------------------------------------------------
// Reads the real org-scoped aggregate (single read, org-admin gated).
// ---------------------------------------------------------------------------

test("Governance reads the org-scoped control-center aggregate", () => {
  assert.match(
    src(),
    /\/v1\/orgs\/\$\{orgId\}\/governance\/control-center`/,
    "must read the org governance control-center aggregate",
  );
});

test("Governance is read-only — no mutating verbs, no native confirm", () => {
  const s = src();
  assert.doesNotMatch(s, /method:\s*"(POST|PUT|PATCH|DELETE)"/, "no mutations");
  assert.doesNotMatch(s, /window\.confirm\(/, "no native confirm dialog");
});

test("Governance uses the safe-feedback error path", () => {
  assert.match(src(), /toSafeUserError/, "must use toSafeUserError");
});

// ---------------------------------------------------------------------------
// Required governance sections rendered.
// ---------------------------------------------------------------------------

test("Governance renders the required KPI tiles from real reads", () => {
  const s = src();
  for (const testId of [
    "kpi-active-legal-holds",
    "kpi-retention-policies",
    "kpi-pending-destruction",
    "kpi-external-grants",
  ]) {
    assert.ok(s.includes(`testId="${testId}"`), `must render ${testId}`);
  }
});

test("Governance renders every required governance section", () => {
  const s = src();
  // section-coverage renders data-testid inline; the ListSection-driven
  // sections receive their id via the testId prop (rendered as data-testid
  // inside the component). Accept either literal form.
  for (const testId of [
    "section-coverage",
    "section-legal-holds",
    "section-retention-policies",
    "section-destruction",
    "section-audit",
  ]) {
    assert.ok(
      s.includes(`data-testid="${testId}"`) || s.includes(`testId="${testId}"`),
      `must render ${testId}`,
    );
  }
});

test("Governance surfaces coverage / chain-of-custody health indicators", () => {
  const s = src();
  for (const testId of [
    "coverage-retention",
    "coverage-legal-hold",
    "coverage-destruction",
  ]) {
    assert.ok(s.includes(`testId="${testId}"`), `must render ${testId}`);
  }
});

// ---------------------------------------------------------------------------
// Honest empty / unavailable states — never a fabricated metric.
// ---------------------------------------------------------------------------

test("Governance renders honest empty + unavailable states", () => {
  const s = src();
  assert.match(s, /data-state="empty"/, "must have an honest empty state");
  assert.match(
    s,
    /data-state="unavailable"/,
    "must degrade to an honest unavailable state",
  );
  // "—" placeholder for a section whose count is unavailable — never a fake 0.
  assert.match(s, /return "—"/, "unavailable KPI must render an em-dash, not a fabricated number");
});

test("Governance honestly omits report/package generated counts (no fake metric)", () => {
  const s = src();
  // There is no org-scoped generated-count endpoint; the page must not
  // invent a 'reports generated' / 'packages generated' KPI.
  assert.doesNotMatch(
    s,
    /reports?\s+generated|packages?\s+generated/i,
    "must not fabricate a reports/packages-generated metric",
  );
});

// ---------------------------------------------------------------------------
// Deep-links to canonical governance surfaces.
// ---------------------------------------------------------------------------

const DEEP_LINKS: ReadonlyArray<[string, RegExp]> = [
  ["gov-deep-link-retention-tab", /\/organizations\/\$\{orgId\}\/admin\/retention/],
  ["gov-deep-link-access-reviews", /\/organizations\/\$\{orgId\}\/admin\/access-reviews/],
  ["gov-deep-link-audit-tab", /\/organizations\/\$\{orgId\}\/admin\/audit/],
  ["gov-deep-link-lifecycle-legal-holds", /\/evidence-lifecycle\/legal-holds/],
  ["gov-deep-link-lifecycle-destruction", /\/evidence-lifecycle\/destruction/],
  ["gov-deep-link-platform", /\/governance-platform/],
];

test("Governance deep-links to every canonical governance surface", () => {
  const s = src();
  for (const [testId, hrefPattern] of DEEP_LINKS) {
    const idx = s.indexOf(`testId="${testId}"`);
    assert.ok(idx >= 0, `${testId} present`);
    // On DeepLinkRow the href prop follows the testId; scan a forward window.
    const window = s.slice(Math.max(0, idx - 40), idx + 320);
    assert.match(window, hrefPattern, `${testId} must deep-link to ${hrefPattern}`);
  }
});
