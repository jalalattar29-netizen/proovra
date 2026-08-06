/**
 * Phase 3 (Enterprise Identity) — identity-surface visibility + Domains page.
 *
 * Two guarantees, both encoded as structural properties (no DOM runtime):
 *
 *   PART A — VISIBILITY: the enterprise identity surfaces (Security Center,
 *            SSO / Identity Providers, SCIM, Domains, MFA policy, Session
 *            policy, Login policy, Identity audit) are accessible for an
 *            ENTERPRISE context and are NOT accessible for FREE / PAYG /
 *            PRO / TEAM. Uses the real `canAccessSurface` (the same helper
 *            the sidebar, command palette, and direct-URL middleware use),
 *            mirroring enterprise-tier-gating.test.ts.
 *
 *   PART B — DOMAINS PAGE: the new page exists on disk, is org-admin gated
 *            (PageRouteGate routeId="account.organization-detail"), and
 *            calls the four /v1/orgs/:orgId/domains endpoints (list / add /
 *            verify / remove). The route id is registered + pillar-mapped.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canAccessSurface,
  type SurfaceUserContext,
} from "../lib/surface/access";
import type { WorkspacePlan } from "../lib/platform-context/types";
import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";
import { PILLAR_FOR_ROUTE_ID } from "../lib/navigation/pillarRegistry";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ============================================================================
// PART A — enterprise identity surface visibility
// ============================================================================

const NON_ENTERPRISE: WorkspacePlan[] = ["FREE", "PAYG", "PRO", "TEAM"];

// Mirror the backend derivation: an enterprise workspace is one on the
// ENTERPRISE plan. Nothing else.
function ctxFor(plan: WorkspacePlan): SurfaceUserContext {
  return {
    // PHASE 12B Track 1A — server-projected booleans, never the plan name.
    planFeatures: {
      intakeIncluded: null,
      professionalSurfacesIncluded:
        plan === "PRO" || plan === "TEAM" || (plan as string) === "ENTERPRISE",
    },
    isPlatformAdmin: false,
    isEnterpriseWorkspace: plan === "ENTERPRISE",
  };
}

// Every enterprise identity surface the phase must gate. Each is an
// ENTERPRISE-tier path prefix in lib/surface/tiers.ts.
const IDENTITY_SURFACES = [
  "/security-center", // Security Center
  "/security-center/sso", // SSO / Identity providers
  "/admin/identity", // Identity operations hub
  "/admin/identity/scim", // SCIM provisioning
  "/admin/identity/sessions", // Session policy
  "/organizations/abc/admin/domains", // Domains (this phase)
  "/organizations/abc/admin/security", // Org security (MFA/SSO/SCIM readiness)
  "/audit-transparency", // Identity / compliance audit
];

test("Phase 3 — FREE / PAYG / PRO / TEAM cannot access any enterprise identity surface", () => {
  for (const plan of NON_ENTERPRISE) {
    const ctx = ctxFor(plan);
    for (const href of IDENTITY_SURFACES) {
      assert.equal(
        canAccessSurface(ctx, href),
        false,
        `${plan} must NOT access identity surface ${href}`,
      );
    }
  }
});

test("Phase 3 — ENTERPRISE can access every enterprise identity surface", () => {
  const ent = ctxFor("ENTERPRISE");
  for (const href of IDENTITY_SURFACES) {
    assert.equal(
      canAccessSurface(ent, href),
      true,
      `ENTERPRISE must access identity surface ${href}`,
    );
  }
});

test("Phase 3 — TEAM (locked-model regression) cannot reach SSO / SCIM / Domains", () => {
  const team = ctxFor("TEAM");
  assert.equal(canAccessSurface(team, "/security-center/sso"), false);
  assert.equal(canAccessSurface(team, "/admin/identity/scim"), false);
  assert.equal(
    canAccessSurface(team, "/organizations/abc/admin/domains"),
    false,
  );
});

// ============================================================================
// PART B — Domains page: exists, org-admin gated, calls the endpoints
// ============================================================================

const DOMAINS_PAGE = resolve(
  APP_ROOT,
  "app/(app)/organizations/[id]/admin/domains/page.tsx",
);

test("Phase 3 — Domains page exists on disk", () => {
  assert.ok(
    existsSync(DOMAINS_PAGE),
    "organizations/[id]/admin/domains/page.tsx must exist",
  );
});

test("Phase 3 — Domains page is org-admin gated via PageRouteGate", () => {
  const src = readFileSync(DOMAINS_PAGE, "utf8");
  assert.match(
    src,
    /PageRouteGate/,
    "Domains page must wrap in PageRouteGate",
  );
  assert.match(
    src,
    /routeId="account\.organization-detail"/,
    "Domains page must gate on the org-detail route id (org membership)",
  );
});

test("Phase 3 — Domains page calls all four domain endpoints", () => {
  const src = readFileSync(DOMAINS_PAGE, "utf8");
  // GET list + POST add share the collection path.
  assert.match(
    src,
    /\/v1\/orgs\/\$\{orgId\}\/domains`/,
    "must call the /v1/orgs/:orgId/domains collection endpoint (list + add)",
  );
  // POST verify.
  assert.match(
    src,
    /\/v1\/orgs\/\$\{orgId\}\/domains\/\$\{domain\.id\}\/verify`/,
    "must call the verify endpoint",
  );
  // DELETE remove.
  assert.match(
    src,
    /\/v1\/orgs\/\$\{orgId\}\/domains\/\$\{domain\.id\}`/,
    "must call the DELETE remove endpoint",
  );
  assert.match(src, /method:\s*"DELETE"/, "remove must be a DELETE");
});

test("Phase 3 — Domains page routes verify + remove through step-up", () => {
  const src = readFileSync(DOMAINS_PAGE, "utf8");
  assert.match(src, /useStepUpAction/, "must use step-up hook");
  assert.match(src, /runStepUpAction/, "must run mutations through step-up");
  assert.match(src, /StepUpModal/, "must render the step-up modal");
});

test("Phase 3 — Domains page uses the safe-feedback error path only", () => {
  const src = readFileSync(DOMAINS_PAGE, "utf8");
  assert.match(src, /toSafeUserError/, "must use toSafeUserError");
  assert.doesNotMatch(
    src,
    /window\.confirm\(/,
    "must not use the native browser confirm dialog (use ConfirmActionModal)",
  );
});

// ============================================================================
// PART B (cont.) — registry + pillar registration for the new route id
// ============================================================================

const DOMAINS_ROUTE_ID = "account.organization_admin_domains";

test("Phase 3 — Domains route id is registered with the enterprise-safe contract", () => {
  const entry = (ROUTE_REGISTRY as ReadonlyArray<Record<string, unknown>>).find(
    (r) => r.id === DOMAINS_ROUTE_ID,
  );
  assert.ok(entry, `ROUTE_REGISTRY must contain ${DOMAINS_ROUTE_ID}`);
  assert.equal(
    entry!.href,
    "/organizations/:id/admin/domains",
    "Domains route href must match the org-admin tab path",
  );
  // /organizations is ENTERPRISE-tier by path prefix; the entry must stay
  // out of the sidebar (deep-linked from the admin shell tab bar instead).
  assert.equal(
    entry!.sidebarEligible,
    false,
    "Domains tab must not be sidebar-eligible (deep-linked from org admin shell)",
  );
});

test("Phase 3 — Domains route id is mapped to a pillar (phase-1a coverage)", () => {
  assert.ok(
    PILLAR_FOR_ROUTE_ID.has(DOMAINS_ROUTE_ID),
    `${DOMAINS_ROUTE_ID} must be in PILLAR_FOR_ROUTE_ID or the phase-1a guard fails`,
  );
  assert.equal(PILLAR_FOR_ROUTE_ID.get(DOMAINS_ROUTE_ID), "ADMIN");
});
