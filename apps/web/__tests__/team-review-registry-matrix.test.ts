/**
 * TEAM-SPEC §1 R1/R2/R4 + §3 — the review routes, per context.
 *
 * One table: for every context the product sells (Free / Pro / Team on the
 * Personal Workspace by role / Enterprise org / a legacy Team OWNED workspace)
 * and every review route, the registry gate (`resolveRouteAccess`) AND the
 * surface tier (`canAccessSurface`) answer what the spec says. A route the
 * table marks ALLOWED is one the Review hub may link to; every other route
 * must not be offered — so no rendered review link resolves to a refusal.
 *
 * Capabilities mirror `services/api/src/services/platform-context/
 * capability-registry.ts` for each role under each plan.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";
import { resolveRouteAccess } from "../lib/navigation/routeAccessResolver";
import { canAccessSurface, ruleEntitlement, type SurfaceUserContext } from "../lib/surface/access";
import { findSurfaceTierRule } from "../lib/surface/tiers";

type Ctx = {
  name: string;
  activeSpaceType: "PERSONAL" | "ORGANIZATION";
  isEnterpriseWorkspace: boolean;
  planFeatures: Record<string, boolean>;
  capabilities: Record<string, boolean>;
};

const BASE_CAPS = { DASHBOARD_VIEW: true, EVIDENCE_VIEW: true, CASES_VIEW: true, REPORTS_VIEW: true, SEARCH_VIEW: true, SETTINGS_VIEW: true };
const WRITER = { EVIDENCE_MANAGE: true, REPORTS_GENERATE: true };
const REVIEW_VIEW = { REVIEWER_OPS_VIEW: true, SLA_VIEW: true, ESCALATIONS_VIEW: true };
const REVIEW_ACT = { REVIEWER_OPS_ACT: true, REVIEW_ESCALATE: true };
const REVIEW_ADMIN = { REVIEW_ASSIGN: true, REVIEW_REASSIGN: true, CASE_ASSIGN: true, BULK_ACTIONS: true };

const NONE = { reviewerOperationsIncluded: false, reviewQueuesIncluded: false, externalReviewIncluded: false, basicRecordReviewIncluded: false };
const PRO = { ...NONE, externalReviewIncluded: true, basicRecordReviewIncluded: true };
const TEAM = { reviewerOperationsIncluded: true, reviewQueuesIncluded: true, externalReviewIncluded: true, basicRecordReviewIncluded: true };

const CONTEXTS: Ctx[] = [
  { name: "FREE personal owner", activeSpaceType: "PERSONAL", isEnterpriseWorkspace: false, planFeatures: NONE, capabilities: { ...BASE_CAPS, ...WRITER } },
  { name: "PRO personal owner", activeSpaceType: "PERSONAL", isEnterpriseWorkspace: false, planFeatures: PRO, capabilities: { ...BASE_CAPS, ...WRITER } },
  { name: "TEAM personal Owner", activeSpaceType: "PERSONAL", isEnterpriseWorkspace: false, planFeatures: TEAM, capabilities: { ...BASE_CAPS, ...WRITER, ...REVIEW_VIEW, ...REVIEW_ACT, ...REVIEW_ADMIN } },
  { name: "TEAM personal Admin", activeSpaceType: "PERSONAL", isEnterpriseWorkspace: false, planFeatures: TEAM, capabilities: { ...BASE_CAPS, ...WRITER, ...REVIEW_VIEW, ...REVIEW_ACT, ...REVIEW_ADMIN } },
  { name: "TEAM personal Member", activeSpaceType: "PERSONAL", isEnterpriseWorkspace: false, planFeatures: TEAM, capabilities: { ...BASE_CAPS, ...WRITER, ...REVIEW_VIEW, ...REVIEW_ACT } },
  { name: "TEAM personal Viewer", activeSpaceType: "PERSONAL", isEnterpriseWorkspace: false, planFeatures: TEAM, capabilities: { ...BASE_CAPS, ...REVIEW_VIEW } },
  { name: "ENTERPRISE org Owner", activeSpaceType: "ORGANIZATION", isEnterpriseWorkspace: true, planFeatures: TEAM, capabilities: { ...BASE_CAPS, ...WRITER, ...REVIEW_VIEW, ...REVIEW_ACT, ...REVIEW_ADMIN, GOVERNANCE_VIEW: true, GOVERNANCE_ACT: true } },
  { name: "TEAM legacy OWNED org Owner", activeSpaceType: "ORGANIZATION", isEnterpriseWorkspace: false, planFeatures: TEAM, capabilities: { ...BASE_CAPS, ...WRITER, ...REVIEW_VIEW, ...REVIEW_ACT, ...REVIEW_ADMIN, GOVERNANCE_VIEW: true, GOVERNANCE_ACT: true } },
];

const ROUTES = [
  "review.queue",
  "workspace.review",
  "workspace.review_queues",
  "review.sla",
  "review.escalations",
  "review.settings",
  "review.queue_detail",
  "review.operations",
  "workspace.review_workspace",
  "workspace.coding_schemas",
  "workspace.review_qc",
  "workspace.review_disagreements",
  "workspace.review_metrics",
  "workspace.review_external",
  "governance.policy",
] as const;
type RouteId = (typeof ROUTES)[number];

const ALL_TEAM: RouteId[] = ROUTES.filter((r) => r !== "governance.policy");
const EXPECTED_ALLOWED: Record<string, ReadonlyArray<RouteId>> = {
  "FREE personal owner": [],
  // R4 — External Review is Pro and above; nothing else in review is.
  "PRO personal owner": ["workspace.review_external"],
  "TEAM personal Owner": ALL_TEAM,
  "TEAM personal Admin": ALL_TEAM,
  // Metrics needs review.assign (OWNER / ADMIN).
  "TEAM personal Member": ALL_TEAM.filter((r) => r !== "workspace.review_metrics"),
  // §1 defaults — a Viewer is not offered pages whose API refuses Viewers:
  // review operations (evidence_request.review), metrics (review.assign),
  // external review (audit.read).
  "TEAM personal Viewer": ALL_TEAM.filter(
    (r) => r !== "workspace.review_metrics" && r !== "review.operations" && r !== "workspace.review_external",
  ),
  // Enterprise keeps everything, including the Enterprise policy page.
  "ENTERPRISE org Owner": ROUTES,
  // The kind is never the question; /governance/policy stays Enterprise.
  "TEAM legacy OWNED org Owner": ALL_TEAM,
};

function surfaceCtx(ctx: Ctx): SurfaceUserContext {
  return {
    isPlatformAdmin: false,
    isEnterpriseWorkspace: ctx.isEnterpriseWorkspace,
    planFeatures: { intakeIncluded: true, professionalSurfacesIncluded: true, ...ctx.planFeatures },
  } as SurfaceUserContext;
}

function access(ctx: Ctx, id: RouteId) {
  const route = ROUTE_REGISTRY.find((r) => r.id === id);
  assert.ok(route, `route ${id} registered`);
  const decision = resolveRouteAccess({
    route,
    activeSpaceType: ctx.activeSpaceType,
    isPlatformAdmin: false,
    capabilities: ctx.capabilities,
    workspace: { id: "w-1", status: "active" },
    personalSpace: { id: "p-1", status: "active" },
    isEnterpriseWorkspace: ctx.isEnterpriseWorkspace,
    planFeatures: ctx.planFeatures,
  });
  const href = id === "review.queue_detail" ? "/reviewer-ops/00000000-0000-4000-8000-000000000001" : route.href;
  return { decision, surface: canAccessSurface(surfaceCtx(ctx), href) };
}

for (const ctx of CONTEXTS) {
  test(`TEAM-SPEC matrix — ${ctx.name}`, () => {
    const allowed = new Set(EXPECTED_ALLOWED[ctx.name]);
    for (const id of ROUTES) {
      const { decision, surface } = access(ctx, id);
      const opens = decision.canLoad && decision.accessState === "ALLOWED" && surface;
      assert.equal(opens, allowed.has(id), `${ctx.name} × ${id}: ${decision.accessState}, surface=${surface}`);
      if (!allowed.has(id)) {
        // Refused review destinations are never upgrade-to-Enterprise copy for
        // a Team context (R1/R2), and are hidden from navigation where the
        // plan or role decides.
        if (ctx.planFeatures.reviewQueuesIncluded && id !== "governance.policy") {
          assert.doesNotMatch(decision.reason, /Enterprise workspace experience/, `${ctx.name} × ${id}`);
        }
      }
    }
  });
}

test("the seven review ids are no longer Enterprise-only; their plan features are R1/R2/R4", () => {
  const expected: Record<string, string> = {
    "workspace.review": "reviewerOperationsIncluded",
    "workspace.review_workspace": "reviewQueuesIncluded",
    "workspace.coding_schemas": "reviewQueuesIncluded",
    "workspace.review_qc": "reviewQueuesIncluded",
    "workspace.review_disagreements": "reviewQueuesIncluded",
    "workspace.review_metrics": "reviewQueuesIncluded",
    "workspace.review_external": "externalReviewIncluded",
    "review.settings": "reviewerOperationsIncluded",
  };
  for (const [id, feature] of Object.entries(expected)) {
    const route = ROUTE_REGISTRY.find((r) => r.id === id)!;
    assert.equal(route.requiredActiveSpace, "PERSONAL_OR_ORG", id);
    assert.equal(route.requiredPlanFeature, feature, id);
  }
});

test("one sidebar entry for review: Review → /review; queues, escalations and SLA are hub-only", () => {
  const reviewSidebar = ROUTE_REGISTRY.filter((r) => r.domain === "REVIEW_OPERATIONS" && r.sidebarEligible);
  assert.deepEqual(
    reviewSidebar.map((r) => r.id),
    ["workspace.review"],
  );
  for (const id of ["review.escalations", "review.sla", "workspace.review_queues", "review.settings"]) {
    const route = ROUTE_REGISTRY.find((r) => r.id === id)!;
    assert.equal(route.commandPaletteVisible, true, `${id} stays reachable from the palette`);
  }
});

test("Review settings has a surface-tier rule on reviewerOperationsIncluded; /governance/policy stays Enterprise", () => {
  // T-125 — the tier rule follows the registry route (`review.settings`).
  assert.equal(ruleEntitlement(findSurfaceTierRule("/review/settings"))?.key, "reviewerOperationsIncluded");
  const team = surfaceCtx(CONTEXTS[2]!);
  const pro = surfaceCtx(CONTEXTS[1]!);
  assert.equal(canAccessSurface(team, "/review/settings"), true);
  assert.equal(canAccessSurface(pro, "/review/settings"), false);
  assert.equal(canAccessSurface(team, "/governance/policy"), false);
});
