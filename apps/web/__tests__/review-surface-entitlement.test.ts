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
import { normalizeHomeViewModel, type NormalizeInputs } from "../components/home-experience/home-view-model";

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

// PRO-R2-06 (WS-ENT) — the refusal is a PLAN refusal with a way forward
// ("forbidden"), not a 404 that reads as a broken link. It is still a refusal:
// PRO and an unknown answer never open the surface.
test("PRO (not included) and an unknown answer are refused with the plan refusal, never opened", () => {
  for (const value of [false, null]) {
    for (const path of OPERATIONS) {
      const decision = getDirectAccessDecision(ctx(value), path);
      assert.equal(decision.kind, "forbidden", `${path} (${value})`);
    }
  }
});

// PRO-R2-06 — the reviewer workspace, schemas, QC, disagreements and metrics
// follow reviewQueuesIncluded (the capability the API serves them under) and
// External Review follows externalReviewIncluded. The operations flag ALONE
// never opens them, and an unknown answer never does.
test("advanced review surfaces follow their own capability, not the operations flag", () => {
  for (const path of ADVANCED) {
    assert.equal(getDirectAccessDecision(ctx(true), path).kind, "forbidden", path);
  }
  const withFeatures = (features: Record<string, boolean | null>): SurfaceUserContext => ({
    isPlatformAdmin: false,
    isEnterpriseWorkspace: false,
    planFeatures: { intakeIncluded: true, professionalSurfacesIncluded: true, reviewerOperationsIncluded: false, ...features },
  });
  for (const path of ADVANCED.filter((p) => p !== "/review/external")) {
    assert.equal(getDirectAccessDecision(withFeatures({ reviewQueuesIncluded: true }), path).kind, "allow", path);
    assert.equal(getDirectAccessDecision(withFeatures({ reviewQueuesIncluded: false }), path).kind, "forbidden", path);
    assert.equal(getDirectAccessDecision(withFeatures({ externalReviewIncluded: true }), path).kind, "forbidden", path);
  }
  // External Review is PRO and above: it opens without any reviewer-operations capability.
  assert.equal(getDirectAccessDecision(withFeatures({ externalReviewIncluded: true }), "/review/external").kind, "allow");
  assert.equal(getDirectAccessDecision(withFeatures({ externalReviewIncluded: false }), "/review/external").kind, "forbidden");
  assert.equal(getDirectAccessDecision(withFeatures({ reviewQueuesIncluded: true }), "/review/external").kind, "forbidden");
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
/**
 * AUD-0049 (reopened 2026-11-11) — /review/queues is the fourth page the
 * finding names. The plan catalogue gives TEAM `reviewQueuesIncluded`
 * (REVIEW_TASKS_AND_QUEUES) and the API serves its queue to a Team workspace,
 * but the route stayed in ENTERPRISE_ONLY_ROUTE_IDS, so a Team owner was still
 * told to upgrade there.
 */
test("AUD-0049 — /review/queues opens on TEAM (reviewQueuesIncluded) and refuses PRO, FREE and an unknown answer", () => {
  const route = ROUTE_REGISTRY.find((r) => r.id === "workspace.review_queues");
  assert.ok(route);
  assert.equal(route!.href, "/review/queues");
  assert.equal(routeRequiresEnterpriseWorkspace(route!), false);
  const base = {
    route: route!,
    activeSpaceType: "PERSONAL" as const,
    isPlatformAdmin: false,
    capabilities: Object.fromEntries((route!.requiredCapabilities ?? []).map((c) => [c, true])),
    workspace: { id: "w-1", status: "active" },
    personalSpace: { id: "w-1", status: "active" },
    isEnterpriseWorkspace: false,
  };
  const team = resolveRouteAccess({ ...base, planFeatures: { reviewQueuesIncluded: true } });
  assert.equal(team.canLoad, true, team.reason);
  assert.equal(team.canSeeNav, true);
  for (const value of [false, null]) {
    const pro = resolveRouteAccess({ ...base, planFeatures: { reviewQueuesIncluded: value } });
    assert.equal(pro.canLoad, false, String(value));
    assert.equal(pro.canSeeNav, false, String(value));
    assert.doesNotMatch(pro.reason, /Enterprise workspace experience/);
  }
  // Enterprise is unchanged: its context carries the flag too.
  const ent = resolveRouteAccess({ ...base, isEnterpriseWorkspace: true, planFeatures: { reviewQueuesIncluded: true } });
  assert.equal(ent.canLoad, true, ent.reason);
});

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
  // TEAM-SPEC R1/R2 (2026-11-23) — the console and the advanced review
  // surfaces are no longer Enterprise-workspace routes: they follow the active
  // workspace's Team entitlement (reviewQueuesIncluded / reviewerOperationsIncluded).
  // Was: workspace.review and workspace.review_metrics pinned as Enterprise-only.
  for (const id of ["workspace.review", "workspace.review_metrics", "workspace.review_qc"]) {
    const route = ROUTE_REGISTRY.find((r) => r.id === id);
    assert.ok(route, id);
    assert.equal(routeRequiresEnterpriseWorkspace(route!), false, id);
  }
});

// NEW-RG-14-1 (DEC-11) — Home's Operations rows link to a page only when the
// same surface decision the navigation uses lets the viewer open it. A PRO
// owner with stale review workflows or an escalation must not get a row
// linking to the TEAM-only review queue / escalations pages.
function homeWithReviewConditions(surfaceAccess: SurfaceUserContext | undefined) {
  return normalizeHomeViewModel({
    plan: "PRO",
    planFeatures: null,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    workspaceName: "Workspace",
    activeSpaceType: "PERSONAL",
    commandCenter: null,
    trustSummary: null,
    billing: null,
    reports: null,
    intakeLinks: null,
    inbox: null,
    communications: null,
    orgs: [],
    operationsSummary: {
      open: 2,
      critical: 0,
      high: 0,
      warning: 2,
      assignedToMe: 0,
      mayAssertAllClear: false,
      groups: [
        { sourceId: "review.stale_workflows", conditionCount: 1, statusPosture: "OPEN" },
        { sourceId: "review.escalation", conditionCount: 1, statusPosture: "OPEN" },
      ],
    },
    ...(surfaceAccess ? { surfaceAccess } : {}),
  } as NormalizeInputs);
}
const opsHref = (vm: ReturnType<typeof normalizeHomeViewModel>, sourceId: string) =>
  vm.workspacePriorities.find((p) => p.key === `ops:${sourceId}`)?.href;

test("NEW-RG-14-1 — on PRO (reviewer operations not included) the review Operations rows never link to the TEAM-only pages", () => {
  for (const access of [ctx(false), ctx(null), undefined]) {
    const vm = homeWithReviewConditions(access);
    const stale = opsHref(vm, "review.stale_workflows");
    const escalation = opsHref(vm, "review.escalation");
    assert.ok(stale, "the stale-workflow row is still shown");
    assert.ok(escalation, "the escalation row is still shown");
    assert.notEqual(stale, "/review/queues");
    assert.notEqual(escalation, "/reviewer-ops/escalations");
    assert.equal(getDirectAccessDecision(access ?? ctx(null), stale!).kind, "allow");
    assert.equal(getDirectAccessDecision(access ?? ctx(null), escalation!).kind, "allow");
  }
});

test("NEW-RG-14-1 — on TEAM (reviewer operations included) the rows keep their review destinations", () => {
  const vm = homeWithReviewConditions(ctx(true));
  assert.equal(opsHref(vm, "review.stale_workflows"), "/review/queues");
  assert.equal(opsHref(vm, "review.escalation"), "/reviewer-ops/escalations");
});
