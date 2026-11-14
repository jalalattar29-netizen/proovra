/**
 * Free-user audit (2026-11-14) — two navigation decisions, driven through the
 * real registry, resolver and surface-tier rules.
 *
 * A1-03 — the evidence-request inspector loads for any member who can view the
 *   workspace's evidence (the API reads a request on `evidence.read`), with no
 *   plan key; its management actions keep the intake-links decision.
 *
 * A1-04 — the "no active workspace" panel offers a way out: following every
 *   action it offers (through the surface-tier redirects a direct visit
 *   applies) lands on a page that LOADS for the same person, never back on the
 *   same panel. It used to offer `/workspaces`, which a non-Enterprise context
 *   is redirected from to `/collaboration-teams`, a PERSONAL_OR_ORG route
 *   answering with the same panel.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { ROUTE_REGISTRY, getRouteDefinition } from "../lib/navigation/routeRegistry";
import { resolveRouteAccess, type RouteAccessInput } from "../lib/navigation/routeAccessResolver";
import { getDirectAccessDecision, type SurfaceUserContext } from "../lib/surface/access";

type Caps = RouteAccessInput["capabilities"];

function decide(routeId: string, over: Partial<RouteAccessInput>) {
  const route = getRouteDefinition(routeId);
  assert.ok(route, `${routeId} is registered`);
  return resolveRouteAccess({
    route,
    activeSpaceType: "ORGANIZATION",
    isPlatformAdmin: false,
    capabilities: {},
    planFeatures: null,
    ...over,
  } as RouteAccessInput);
}

// ---------------------------------------------------------------------------
// A1-03
// ---------------------------------------------------------------------------

// A workspace VIEWER: the universally granted reads, no INTAKE_LINKS_MANAGE.
const VIEWER_CAPS: Caps = { DASHBOARD_VIEW: true, EVIDENCE_VIEW: true, CASES_VIEW: true, SETTINGS_VIEW: true };
// A writer on a plan that includes intake.
const WRITER_CAPS: Caps = { ...VIEWER_CAPS, INTAKE_LINKS_MANAGE: true };

test("A1-03 — a viewer opening an inbox item loads the request inspector, but may not manage it", () => {
  const planFeatures = { intakeIncluded: true } as RouteAccessInput["planFeatures"];
  const read = decide("workspace.evidence_requests", { capabilities: VIEWER_CAPS, planFeatures });
  assert.equal(read.canLoad, true, `${read.accessState}: ${read.reason}`);
  const manage = decide("workspace.intake_links", { capabilities: VIEWER_CAPS, planFeatures });
  assert.equal(manage.canLoad, false);
});

test("A1-03 — after a downgrade (no intake on the plan) a retained request stays readable, management does not", () => {
  const planFeatures = { intakeIncluded: false } as RouteAccessInput["planFeatures"];
  const read = decide("workspace.evidence_requests", { capabilities: WRITER_CAPS, planFeatures });
  assert.equal(read.canLoad, true, `${read.accessState}: ${read.reason}`);
  const manage = decide("workspace.intake_links", { capabilities: WRITER_CAPS, planFeatures });
  assert.equal(manage.canLoad, false);
  assert.equal(manage.accessState, "NEEDS_UPGRADE");
});

test("A1-03 — a writer on a plan with intake still manages (positive control)", () => {
  const planFeatures = { intakeIncluded: true } as RouteAccessInput["planFeatures"];
  assert.equal(decide("workspace.intake_links", { capabilities: WRITER_CAPS, planFeatures }).canLoad, true);
});

// ---------------------------------------------------------------------------
// A1-04
// ---------------------------------------------------------------------------

// What the server grants with no workspace at all (capability-registry.ts,
// `if (!scope)`): account surfaces only.
const NO_WORKSPACE_CAPS: Caps = {
  SETTINGS_VIEW: true,
  ACCOUNT_SETTINGS_VIEW: true,
  ACCOUNT_BILLING_VIEW: true,
  ACCOUNT_UPGRADE_VIEW: true,
  ORGANIZATION_CREATE: true,
  ORGANIZATION_JOIN: true,
};
const NO_WORKSPACE: Partial<RouteAccessInput> = {
  activeSpaceType: null,
  capabilities: NO_WORKSPACE_CAPS,
  workspace: null,
  personalSpace: null,
} as Partial<RouteAccessInput>;
const NOT_ENTERPRISE: SurfaceUserContext = {
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
  planFeatures: { intakeIncluded: null, professionalSurfacesIncluded: null },
} as SurfaceUserContext;

/** Where a direct visit to `href` ends after the surface-tier redirects. */
function land(href: string): string {
  let at = href;
  for (let hop = 0; hop < 5; hop += 1) {
    const d = getDirectAccessDecision(NOT_ENTERPRISE, at);
    if (d.kind !== "redirect") return at;
    at = d.to;
  }
  return at;
}

test("A1-04 — every action of the no-workspace panel leads to a page that loads with no workspace", () => {
  const panel = decide("workspace.home", NO_WORKSPACE);
  assert.equal(panel.accessState, "NEEDS_PERSONAL_OR_ORG");
  const actions = [panel.primaryAction, panel.secondaryAction].filter(
    (a): a is { label: string; href: string } => a !== null,
  );
  assert.ok(actions.length > 0, "the panel offers at least one way forward");
  for (const action of actions) {
    const href = land(action.href);
    const route = ROUTE_REGISTRY.find((r) => r.href === href);
    assert.ok(route, `${action.label} → ${href} is a registered page`);
    const next = decide(route.id, NO_WORKSPACE);
    assert.notEqual(next.accessState, "NEEDS_PERSONAL_OR_ORG", `${action.label} → ${href} loops back to the same panel`);
    assert.equal(next.canLoad, true, `${action.label} → ${href}: ${next.accessState}`);
  }
});
