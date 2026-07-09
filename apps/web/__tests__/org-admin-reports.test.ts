/**
 * Phase 8 (Enterprise Production Readiness) — SCOPE C.
 * Org admin / Operational reports page contract.
 *
 * SOURCE-SCANNING contract tests over the reports page + the pure org-role
 * model, matching the sibling web tests (node:test + assert, tsx loader).
 *
 * Pins:
 *   - the page exists and is wrapped in PageRouteGate
 *     routeId="account.organization_admin_reports";
 *   - orgId derives from the URL path param (useParams), never envelope;
 *   - it calls the six real report endpoints under /v1/orgs/${orgId}/reports/;
 *   - it role-filters the report cards via roleMeetsMin (backend still gates);
 *   - it surfaces errors via the sanctioned toSafeUserError / notifyApiError;
 *   - the download-audit report is marked honest "Not available".
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { roleMeetsMin } from "../app/(app)/organizations/[id]/admin/_lib/orgRoles";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_PAGE_PATH = resolve(
  APP_ROOT,
  "app",
  "(app)",
  "organizations",
  "[id]",
  "admin",
  "reports",
  "page.tsx",
);

test("reports page exists", () => {
  assert.ok(
    existsSync(REPORTS_PAGE_PATH),
    "organizations/[id]/admin/reports/page.tsx must exist",
  );
});

const PAGE = readFileSync(REPORTS_PAGE_PATH, "utf8");

test("page is wrapped in PageRouteGate routeId=account.organization_admin_reports", () => {
  assert.match(PAGE, /<PageRouteGate\s+routeId="account\.organization_admin_reports">/);
});

test("orgId derives from the URL path param (useParams), not the envelope", () => {
  assert.match(PAGE, /useParams/);
  assert.doesNotMatch(PAGE, /envelope\.workspace\.organizationId/);
  assert.doesNotMatch(PAGE, /envelope\.account\.organizationId/);
});

test("calls each of the six real report endpoints under /v1/orgs/${orgId}/reports/", () => {
  // The download URL is templated by orgId + the report file suffix.
  assert.match(PAGE, /\/v1\/orgs\/\$\{orgId\}\/reports\/\$\{report\.file\}/);
  for (const file of [
    "members.csv",
    "seats.csv",
    "audit.csv",
    "governance.csv",
    "external-access.csv",
    "download-audit.csv",
  ]) {
    assert.ok(
      PAGE.includes(`"${file}"`) || PAGE.includes(`file: "${file}"`),
      `reports catalog must list ${file}`,
    );
  }
});

test("no hard-coded literal org UUID (cross-org leak guard)", () => {
  const UUID_RE =
    /["'][0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}["']/;
  assert.doesNotMatch(PAGE, UUID_RE);
});

test("role-filters the report cards via roleMeetsMin (backend still authoritative)", () => {
  assert.match(PAGE, /roleMeetsMin\(/);
  // seats.csv must require ORG_BILLING_ADMIN; the catalog encodes minRole.
  assert.match(PAGE, /minRole:\s*"ORG_BILLING_ADMIN"/);
  assert.match(PAGE, /minRole:\s*"ORG_AUDITOR"/);
});

test("surfaces errors via the sanctioned feedback path (toSafeUserError / notifyApiError)", () => {
  assert.match(PAGE, /toSafeUserError/);
  assert.match(PAGE, /notifyApiError/);
  // Never a raw error.message toast passthrough.
  assert.doesNotMatch(PAGE, /addToast\(\s*err(or)?\.message/);
});

test("download-audit report is marked honest 'Not available'", () => {
  assert.match(PAGE, /available:\s*false/);
  assert.match(PAGE, /Not available/);
});

test("read-only page uses no raw window.confirm CALL", () => {
  // The doc-comment legitimately mentions the phrase; ban the actual call.
  assert.doesNotMatch(PAGE, /window\.confirm\(/);
});

// --- Pure-logic sanity: the role gate the page relies on ---

test("roleMeetsMin gates seats (billing) vs auditor reports correctly", () => {
  // An auditor may see auditor-tier reports but NOT the billing seats report.
  assert.equal(roleMeetsMin("ORG_AUDITOR", "ORG_AUDITOR"), true);
  assert.equal(roleMeetsMin("ORG_AUDITOR", "ORG_BILLING_ADMIN"), false);
  // A billing admin sees seats; an owner sees everything.
  assert.equal(roleMeetsMin("ORG_BILLING_ADMIN", "ORG_BILLING_ADMIN"), true);
  assert.equal(roleMeetsMin("ORG_OWNER", "ORG_BILLING_ADMIN"), true);
  // A plain member sees none of the auditor-tier reports.
  assert.equal(roleMeetsMin("ORG_MEMBER", "ORG_AUDITOR"), false);
});
