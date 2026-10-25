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
import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";

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
