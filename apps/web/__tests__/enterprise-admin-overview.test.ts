/**
 * Phase 4 (Enterprise Administration) — Org admin / Overview tab is the real
 * Enterprise Admin HOME.
 *
 * Structural guarantees (no DOM runtime — mirrors
 * enterprise-identity-domains.test.ts):
 *
 *   - The overview page exists and is org-admin gated (PageRouteGate
 *     routeId="account.organization-detail") — enterprise-only by the
 *     /organizations path-prefix tier + org membership.
 *   - It is read-only: no mutating apiFetch verbs, no window.confirm.
 *   - It reads the EXISTING org REST surface (org / members / audit /
 *     domains / retention / billing-rollup) — no new aggregate endpoint.
 *   - It renders the required posture sections (org, plan, seats, members,
 *     SSO/SCIM, verified domains, MFA/session, retention/legal-hold, recent
 *     audit, API/integration).
 *   - It wires every required evidence-platform quick action as a deep-link.
 *   - It uses the safe-feedback error path (toSafeUserError) only.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const OVERVIEW_PAGE = resolve(
  APP_ROOT,
  "app/(app)/organizations/[id]/admin/overview/page.tsx",
);

function src(): string {
  return readFileSync(OVERVIEW_PAGE, "utf8");
}

// ---------------------------------------------------------------------------
// Existence + gating.
// ---------------------------------------------------------------------------

test("Overview page exists on disk", () => {
  assert.ok(
    existsSync(OVERVIEW_PAGE),
    "organizations/[id]/admin/overview/page.tsx must exist",
  );
});

test("Overview is org-admin gated via PageRouteGate (enterprise-only)", () => {
  const s = src();
  assert.match(s, /PageRouteGate/, "must wrap in PageRouteGate");
  assert.match(
    s,
    /routeId="account\.organization-detail"/,
    "must gate on the org-detail route id (org membership + enterprise tier)",
  );
});

// ---------------------------------------------------------------------------
// Read-only posture — reuse existing endpoints, no mutations, no aggregate.
// ---------------------------------------------------------------------------

test("Overview reuses the existing org REST reads", () => {
  const s = src();
  for (const path of [
    /\/v1\/orgs\/\$\{orgId\}`/, // org profile
    /\/v1\/orgs\/\$\{orgId\}\/members`/,
    /\/v1\/orgs\/\$\{orgId\}\/audit-events`/,
    /\/v1\/orgs\/\$\{orgId\}\/domains`/,
    /\/v1\/orgs\/\$\{orgId\}\/policies\/retention`/,
    /\/v1\/orgs\/\$\{orgId\}\/billing\/rollup`/,
  ]) {
    assert.match(s, path, `must read ${path}`);
  }
});

test("Overview did NOT introduce a new aggregate admin endpoint", () => {
  const s = src();
  assert.doesNotMatch(
    s,
    /\/v1\/orgs\/\$\{orgId\}\/admin\/overview/,
    "must fetch existing endpoints directly, not a bespoke aggregate",
  );
});

test("Overview is read-only — no mutating verbs, no native confirm", () => {
  const s = src();
  assert.doesNotMatch(s, /method:\s*"(POST|PUT|PATCH|DELETE)"/, "no mutations");
  assert.doesNotMatch(s, /window\.confirm\(/, "no native confirm dialog");
});

test("Overview uses the safe-feedback error path", () => {
  assert.match(src(), /toSafeUserError/, "must use toSafeUserError");
});

// ---------------------------------------------------------------------------
// Required posture sections.
// ---------------------------------------------------------------------------

test("Overview renders every required posture section", () => {
  const s = src();
  // Tiles pass their id via the `dataAttr` prop (rendered as data-tile);
  // readiness rows + quick actions via the `testId` prop (data-testid).
  for (const attr of [
    'dataAttr="tile-organization"',
    'dataAttr="tile-plan"',
    'dataAttr="tile-seats"',
    'dataAttr="tile-members"',
    'dataAttr="tile-pending-invites"',
    'testId="readiness-sso"',
    'testId="readiness-scim"',
    'testId="readiness-domains"',
    'testId="readiness-mfa"',
    'testId="readiness-retention"',
    'testId="readiness-api"',
    'data-section="overview-audit"',
  ]) {
    assert.ok(s.includes(attr), `overview must render ${attr}`);
  }
});

// ---------------------------------------------------------------------------
// Evidence-platform quick-action deep-links.
// ---------------------------------------------------------------------------

const QUICK_ACTIONS: ReadonlyArray<[string, RegExp]> = [
  ["quick-action-invite-members", /\/organizations\/\$\{orgId\}\/admin\/members/],
  ["quick-action-configure-sso", /\/admin\/identity/],
  ["quick-action-configure-scim", /\/admin\/identity\/scim/],
  ["quick-action-verify-domain", /\/organizations\/\$\{orgId\}\/admin\/domains/],
  ["quick-action-review-audit", /\/organizations\/\$\{orgId\}\/admin\/audit/],
  ["quick-action-configure-mfa", /\/organizations\/\$\{orgId\}\/admin\/security/],
  ["quick-action-manage-retention", /\/organizations\/\$\{orgId\}\/admin\/retention/],
  ["quick-action-manage-api", /\/admin\/identity/],
  ["quick-action-review-access", /\/organizations\/\$\{orgId\}\/admin\/access-reviews/],
  // PHASE 11 URL convergence (2026-07-23) — the `?org=` query param was a
  // dead reference (the `/teams` → `/collaboration-teams` redirect never
  // read it); the workspace-admin deep link now carries no tenant param.
  ["quick-action-configure-billing", /href="\/teams"/],
];

test("Overview wires every required evidence-platform quick action", () => {
  const s = src();
  for (const [testId] of QUICK_ACTIONS) {
    assert.ok(
      s.includes(`testId="${testId}"`),
      `quick action ${testId} must be present`,
    );
  }
});

test("Every quick action deep-links to an existing admin tab / canonical surface", () => {
  const s = src();
  // Each quick-action testId prop must be near its expected href in source.
  // In the QuickAction JSX, `href` immediately follows the `testId` prop.
  for (const [testId, hrefPattern] of QUICK_ACTIONS) {
    const idx = s.indexOf(`testId="${testId}"`);
    assert.ok(idx >= 0, `${testId} present`);
    const window = s.slice(idx, idx + 200);
    assert.match(
      window,
      hrefPattern,
      `${testId} must deep-link to ${hrefPattern}`,
    );
  }
});
