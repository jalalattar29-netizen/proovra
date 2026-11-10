/**
 * MEMBERS AUDIT ENT-01 (2026-10-25) — the reviewer-operations surfaces follow
 * the server's review capability answer, not the workspace kind.
 *
 * TEAM sells reviewer operations on the Personal Workspace it lives on, so the
 * console, queue, escalations, SLA and the per-workflow inspector open there;
 * PRO does not sell them and the same paths stay not-found. The advanced review
 * surfaces (schemas, QC, metrics, disagreements, external, workspace) remain
 * Enterprise-only, and an unknown answer fails closed.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { getDirectAccessDecision, type SurfaceUserContext } from "../lib/surface/access";
import { ROUTE_REGISTRY, routeRequiresEnterpriseWorkspace } from "../lib/navigation/routeRegistry";
import { resolveRouteAccess } from "../lib/navigation/routeAccessResolver";

function ctx(reviewerOperationsIncluded: boolean | null): SurfaceUserContext {
  return {
    isPlatformAdmin: false,
    isEnterpriseWorkspace: false,
    planFeatures: {
      intakeIncluded: true,
      professionalSurfacesIncluded: true,
      reviewerOperationsIncluded,
    },
  };
}

const OPERATIONS = [
  "/review",
  "/review/operations",
  "/review/queues",
  "/reviewer-ops/queue",
  "/reviewer-ops/escalations",
  "/reviewer-ops/sla",
  "/reviewer-ops/0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0",
];
const ADVANCED = ["/review/schemas", "/review/qc", "/review/metrics", "/review/disagreements", "/review/external", "/review/workspace"];

test("TEAM (reviewer operations included, Personal Workspace) opens the reviewer operations surfaces", () => {
  for (const path of OPERATIONS) {
    assert.equal(getDirectAccessDecision(ctx(true), path).kind, "allow", path);
  }
});

test("PRO (not included) and an unknown answer keep them not-found", () => {
  for (const value of [false, null]) {
    for (const path of OPERATIONS) {
      assert.equal(getDirectAccessDecision(ctx(value), path).kind, "notFound", `${path} (${value})`);
    }
  }
});

test("advanced review surfaces stay Enterprise-only even when operations are included", () => {
  for (const path of ADVANCED) {
    assert.equal(getDirectAccessDecision(ctx(true), path).kind, "notFound", path);
  }
});

test("the reviewer-operations navigation entries are reachable from a Personal Workspace", () => {
  for (const href of ["/review", "/reviewer-ops/escalations", "/reviewer-ops/queue", "/reviewer-ops/sla", "/review/operations", "/review/queues"]) {
    const entries = ROUTE_REGISTRY.filter((r) => r.href === href);
    assert.ok(entries.length > 0, href);
    for (const e of entries) assert.equal(e.requiredActiveSpace, "PERSONAL_OR_ORG", `${e.id} (${href})`);
  }
});

/**
 * AUD-0049 — the route gate (the "Plan upgrade required — part of the Enterprise
 * workspace experience" panel) asked `isEnterpriseWorkspace` for the reviewer
 * queue, operations, escalations, queue detail and SLA pages, so a TEAM owner
 * whose plan includes them, and whose API serves them, was told to upgrade.
 */
test("AUD-0049 — the route gate opens the reviewer operations pages on TEAM and refuses them on PRO", () => {
  const ids = ["review.queue", "review.operations", "review.escalations", "review.queue_detail", "review.sla"];
  for (const id of ids) {
    const route = ROUTE_REGISTRY.find((r) => r.id === id);
    assert.ok(route, id);
    const base = {
      route: route!,
      activeSpaceType: "PERSONAL" as const,
      isPlatformAdmin: false,
      capabilities: Object.fromEntries((route!.requiredCapabilities ?? []).map((c) => [c, true])),
      workspace: { id: "w-1", status: "active" },
      personalSpace: { id: "w-1", status: "active" },
      isEnterpriseWorkspace: false,
    };
    const team = resolveRouteAccess({ ...base, planFeatures: { reviewerOperationsIncluded: true } });
    assert.equal(team.canLoad, true, `${id}: ${team.reason}`);
    assert.equal(team.canSeeNav, true, id);
    for (const value of [false, null]) {
      const pro = resolveRouteAccess({ ...base, planFeatures: { reviewerOperationsIncluded: value } });
      assert.equal(pro.canLoad, false, `${id} (${value})`);
      assert.doesNotMatch(pro.reason, /Enterprise workspace experience/, id);
    }
  }
  // The advanced surfaces are still Enterprise-workspace routes.
  for (const id of ["workspace.review", "workspace.review_queues", "workspace.review_metrics"]) {
    const route = ROUTE_REGISTRY.find((r) => r.id === id);
    if (route) assert.equal(routeRequiresEnterpriseWorkspace(route), true, id);
  }
});
