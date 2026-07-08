/**
 * Phase 4 (Enterprise Administration) — Billing & Seats + API & Integrations
 * tabs, plus the completed canonical Audit tab.
 *
 * Structural guarantees (no DOM runtime — mirrors
 * enterprise-admin-overview.test.ts):
 *
 *   - Billing tab: exists, org-admin gated, read-only, consumes the
 *     read-only rollup GET /v1/orgs/:id/billing/rollup, renders plan /
 *     seats / usage / billing contact, has the enterprise
 *     "Contact your account manager" CTA, and never touches the
 *     self-serve checkout / pricing flow.
 *   - Integrations tab: exists, org-admin gated, read-only, reuses the
 *     existing /integrations portal + /v1/orgs/:id/workspaces (no second
 *     developer portal), and only advertises producer-backed evidence
 *     webhook events.
 *   - Audit tab: filters by event type + actor + date window, supports
 *     CSV export, is role-gated, and stays the ORG audit (does not pull in
 *     the platform-admin audit or custody/public-verify timelines).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BILLING_PAGE = resolve(
  APP_ROOT,
  "app/(app)/organizations/[id]/admin/billing/page.tsx",
);
const INTEGRATIONS_PAGE = resolve(
  APP_ROOT,
  "app/(app)/organizations/[id]/admin/integrations/page.tsx",
);
const AUDIT_PAGE = resolve(
  APP_ROOT,
  "app/(app)/organizations/[id]/admin/audit/page.tsx",
);

const read = (p: string): string => readFileSync(p, "utf8");

// ---------------------------------------------------------------------------
// Billing & Seats tab.
// ---------------------------------------------------------------------------

test("Billing page exists on disk", () => {
  assert.ok(existsSync(BILLING_PAGE), "admin/billing/page.tsx must exist");
});

test("Billing tab is org-admin gated via PageRouteGate", () => {
  const s = read(BILLING_PAGE);
  assert.match(s, /PageRouteGate/);
  assert.match(s, /routeId="account\.organization-detail"/);
});

test("Billing tab consumes the read-only rollup endpoint", () => {
  const s = read(BILLING_PAGE);
  assert.match(s, /\/v1\/orgs\/\$\{orgId\}\/billing\/rollup`/);
});

test("Billing tab is read-only — no mutating verbs, no native confirm", () => {
  const s = read(BILLING_PAGE);
  assert.doesNotMatch(s, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(s, /window\.confirm\(/);
});

test("Billing tab renders plan / seats / usage rollup + billing contact", () => {
  const s = read(BILLING_PAGE);
  for (const marker of [
    // Stat cards receive their id via the `testId` prop (rendered as
    // data-testid on the Stat component).
    'testId="billing-stat-included-seats"',
    'testId="billing-stat-used-seats"',
    'testId="billing-stat-over-seat"',
    'testId="billing-stat-active-workspaces"',
    'data-testid="billing-workspaces-list"',
    'data-section="billing-contact"',
  ]) {
    assert.ok(s.includes(marker), `billing tab must render ${marker}`);
  }
});

test("Billing tab has the enterprise account-manager CTA, NOT self-serve checkout", () => {
  const s = read(BILLING_PAGE);
  assert.match(s, /data-testid="billing-contact-account-manager"/);
  assert.match(s, /account manager/i);
  // Must NOT link into the self-serve pricing / upgrade / checkout flow,
  // and must issue no checkout mutation. (The doc-comment may mention
  // "not the Stripe flow" for context — we assert on wiring, not prose.)
  assert.doesNotMatch(s, /href=["'`][^"'`]*\/pricing/);
  assert.doesNotMatch(s, /href=["'`][^"'`]*\/upgrade/);
  assert.doesNotMatch(s, /href=["'`][^"'`]*\/checkout/);
  assert.doesNotMatch(s, /\/v1\/billing\/checkout/);
});

test("Billing tab uses the safe-feedback error path", () => {
  assert.match(read(BILLING_PAGE), /toSafeUserError/);
});

// ---------------------------------------------------------------------------
// API & Integrations tab.
// ---------------------------------------------------------------------------

test("Integrations page exists on disk", () => {
  assert.ok(
    existsSync(INTEGRATIONS_PAGE),
    "admin/integrations/page.tsx must exist",
  );
});

test("Integrations tab is org-admin gated via PageRouteGate", () => {
  const s = read(INTEGRATIONS_PAGE);
  assert.match(s, /PageRouteGate/);
  assert.match(s, /routeId="account\.organization-detail"/);
});

test("Integrations tab reuses the existing portal + workspaces read (no 2nd portal)", () => {
  const s = read(INTEGRATIONS_PAGE);
  // Deep-links into the canonical /integrations portal.
  assert.match(s, /href="\/integrations"/);
  assert.match(s, /data-testid="integrations-deep-link-portal"/);
  // Reads the existing org workspaces endpoint to build the index.
  assert.match(s, /\/v1\/orgs\/\$\{orgId\}\/workspaces`/);
  // Does NOT rebuild the API-key / webhook CRUD surface here.
  assert.doesNotMatch(s, /\/v1\/integrations\/api-keys/);
  assert.doesNotMatch(s, /\/v1\/integrations\/webhooks/);
});

test("Integrations tab is read-only — no mutating verbs, no native confirm", () => {
  const s = read(INTEGRATIONS_PAGE);
  assert.doesNotMatch(s, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(s, /window\.confirm\(/);
});

test("Integrations tab only advertises producer-backed evidence webhook events", () => {
  const s = read(INTEGRATIONS_PAGE);
  // Producer-backed events that are safe to advertise.
  assert.match(s, /"evidence\.completed"/);
  assert.match(s, /"governance\.legal_hold_placed"/);
  // Worker-only events without a live API producer must NOT be invented.
  assert.doesNotMatch(s, /"evidence\.report_generated"/);
  assert.doesNotMatch(s, /"evidence\.package_generated"/);
});

// ---------------------------------------------------------------------------
// Audit tab — completed as the canonical enterprise ORG audit.
// ---------------------------------------------------------------------------

test("Audit tab is org-auditor gated via PageRouteGate", () => {
  const s = read(AUDIT_PAGE);
  assert.match(s, /PageRouteGate/);
  assert.match(s, /routeId="account\.organization-detail"/);
});

test("Audit tab reads the ORG audit endpoint (not the platform-admin audit)", () => {
  const s = read(AUDIT_PAGE);
  assert.match(s, /\/v1\/orgs\/\$\{orgId\}\/audit-events/);
  // Must NOT pull in the platform-admin audit surface.
  assert.doesNotMatch(s, /\/v1\/admin\/audit/);
  assert.doesNotMatch(s, /\/v1\/platform\/audit/);
});

test("Audit tab supports event-type + actor + date filters", () => {
  const s = read(AUDIT_PAGE);
  for (const testId of [
    'data-testid="audit-type-filter"',
    'data-testid="audit-actor-filter"',
    'data-testid="audit-from-filter"',
    'data-testid="audit-to-filter"',
  ]) {
    assert.ok(s.includes(testId), `audit tab must render ${testId}`);
  }
  // Event type is applied server-side via the eventType query param.
  assert.match(s, /audit-events\?eventType=/);
});

test("Audit tab supports CSV export", () => {
  const s = read(AUDIT_PAGE);
  assert.match(s, /data-testid="audit-export-csv"/);
  assert.match(s, /text\/csv/);
});

test("Audit tab is read-only — no mutating verbs, no native confirm", () => {
  const s = read(AUDIT_PAGE);
  assert.doesNotMatch(s, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(s, /window\.confirm\(/);
});
