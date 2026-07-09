/**
 * Phase 8 Enterprise Production Readiness — SCOPE A (Bulk Invite) +
 * SCOPE B (CSV Import): org-admin Bulk invite page contract.
 *
 * Structural (no DOM runtime), mirroring enterprise-identity-domains.test.ts:
 *
 *   PART A — the page exists, is gated by
 *            PageRouteGate routeId="account.organization_admin_bulk_invite",
 *            calls the bulk / CSV endpoints, and uses the safe-feedback error
 *            path (toSafeUserError / notifyApiError) exclusively.
 *
 *   PART B — registry wiring. The route id + pillar mapping are owned by the
 *            shared wiring files (routeRegistry / pillarRegistry), which are
 *            registered separately. These assertions verify the wiring ONCE
 *            it is present; until then they surface a clear pending message
 *            rather than a hard failure (the page-contract guarantees in
 *            PART A do not depend on the registry).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";
import { PILLAR_FOR_ROUTE_ID } from "../lib/navigation/pillarRegistry";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BULK_INVITE_PAGE = resolve(
  APP_ROOT,
  "app/(app)/organizations/[id]/admin/bulk-invite/page.tsx",
);
const ROUTE_ID = "account.organization_admin_bulk_invite";

// ============================================================================
// PART A — page exists, gated, calls endpoints, safe error path
// ============================================================================

test("Phase 8 — Bulk-invite page exists on disk", () => {
  assert.ok(
    existsSync(BULK_INVITE_PAGE),
    "organizations/[id]/admin/bulk-invite/page.tsx must exist",
  );
});

test("Phase 8 — Bulk-invite page is gated via PageRouteGate on the bulk-invite route id", () => {
  const src = readFileSync(BULK_INVITE_PAGE, "utf8");
  assert.match(src, /PageRouteGate/, "must wrap in PageRouteGate");
  assert.match(
    src,
    /routeId="account\.organization_admin_bulk_invite"/,
    "must gate on the bulk-invite route id",
  );
});

test("Phase 8 — Bulk-invite page calls the bulk + CSV endpoints", () => {
  const src = readFileSync(BULK_INVITE_PAGE, "utf8");
  assert.match(
    src,
    /\/v1\/orgs\/\$\{orgId\}\/invites\/bulk\/validate`/,
    "must call the dry-run /validate endpoint",
  );
  assert.match(
    src,
    /\/v1\/orgs\/\$\{orgId\}\/invites\/bulk`/,
    "must call the execute /bulk endpoint",
  );
  assert.match(
    src,
    /\/v1\/orgs\/\$\{orgId\}\/invites\/bulk\/resend`/,
    "must call the /bulk/resend endpoint",
  );
  assert.match(
    src,
    /\/v1\/orgs\/\$\{orgId\}\/invites\/csv/,
    "must call the CSV endpoint",
  );
});

test("Phase 8 — Bulk-invite page uses the safe-feedback error path only", () => {
  const src = readFileSync(BULK_INVITE_PAGE, "utf8");
  assert.match(src, /toSafeUserError/, "must use toSafeUserError");
  assert.match(src, /notifyApiError/, "must use notifyApiError for toasts");
  assert.doesNotMatch(
    src,
    /window\.confirm\(/,
    "must not use the native browser confirm dialog",
  );
  // No raw error.message passthrough (banned app-wide per safe-feedback).
  assert.doesNotMatch(
    src,
    /addToast\(\s*(?:err|error)\.message/,
    "must not toast raw error.message",
  );
});

test("Phase 8 — Bulk-invite page offers preview, send, resend, and template download", () => {
  const src = readFileSync(BULK_INVITE_PAGE, "utf8");
  assert.match(src, /data-testid="bulk-invite-preview"/, "has a Preview control");
  assert.match(src, /data-testid="bulk-invite-send"/, "has a Send invites control");
  assert.match(src, /data-testid="bulk-invite-resend-failed"/, "has a Resend failed control");
  assert.match(src, /data-testid="bulk-invite-download-template"/, "has a template download");
  assert.match(src, /data-testid="bulk-invite-csv-file"/, "has a CSV upload input");
});

// ============================================================================
// PART B — registry + pillar wiring (owned by shared wiring files)
// ============================================================================

// These two assertions verify wiring owned by the shared registry files
// (routeRegistry / pillarRegistry). They are marked `todo` so they DO NOT
// hard-fail the slice before the shared-wiring owner registers the route id;
// once the entry + pillar mapping land, remove `{ todo: true }` to promote
// them to enforced guards. The PART A page-contract guarantees above do not
// depend on the registry.
test(
  "Phase 8 — Bulk-invite route id is registered with the enterprise-safe contract",
  { todo: "pending shared-wiring owner registering the route id" },
  () => {
    const entry = (ROUTE_REGISTRY as ReadonlyArray<Record<string, unknown>>).find(
      (r) => r.id === ROUTE_ID,
    );
    assert.ok(
      entry,
      `ROUTE_REGISTRY must contain ${ROUTE_ID} ` +
        `(href "/organizations/:id/admin/bulk-invite", sidebarEligible: false).`,
    );
    assert.equal(entry!.href, "/organizations/:id/admin/bulk-invite");
    assert.equal(entry!.sidebarEligible, false);
  },
);

test(
  "Phase 8 — Bulk-invite route id is mapped to the ADMIN pillar (phase-1a coverage)",
  { todo: "pending shared-wiring owner mapping the route id to ADMIN" },
  () => {
    assert.ok(PILLAR_FOR_ROUTE_ID.has(ROUTE_ID), `${ROUTE_ID} must be in PILLAR_FOR_ROUTE_ID`);
    assert.equal(PILLAR_FOR_ROUTE_ID.get(ROUTE_ID), "ADMIN");
  },
);
