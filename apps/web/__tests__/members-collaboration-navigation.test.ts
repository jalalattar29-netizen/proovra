/**
 * MEMBERS EXPERIENCE A — "Collaboration Teams" sits directly after "Members &
 * Access", under Governance, on every plan that sells it, and nowhere on a
 * plan that does not.
 *
 * Production showed "Teams" as its own item in the Workspace group, far from
 * "Members & Access" in Governance — two halves of one model presented as
 * unrelated products, under a word that also reads as a name for a Workspace.
 *
 * RUNTIME, not source text: every registered route goes through the real
 * access resolver for a real envelope shape, then the real exposure and
 * grouping resolvers — the same three steps the sidebar runs.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resolveNavigationGroups } from "../lib/navigation/navigationGroupingResolver";
import { resolveNavigationExposure } from "../lib/navigation/navigationExposureResolver";
import { resolveRouteAccess } from "../lib/navigation/routeAccessResolver";
import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";
import { paletteGroupFor, paletteTitleFor } from "../lib/navigation/paletteModel";

type Plan = "FREE" | "PAYG" | "PRO" | "TEAM" | "ENTERPRISE";

const CAPABILITIES = {
  DASHBOARD_VIEW: true,
  CASES_VIEW: true,
  EVIDENCE_VIEW: true,
  EVIDENCE_CAPTURE: true,
  SEARCH_VIEW: true,
  REPORTS_VIEW: true,
  TEAM_VIEW: true,
  ACCOUNT_BILLING_VIEW: true,
} as const;

function sidebar(plan: Plan) {
  const collaboration = plan === "PRO" || plan === "TEAM" || plan === "ENTERPRISE";
  const organization = plan === "ENTERPRISE";
  const routes = ROUTE_REGISTRY.map((route) => ({
    route,
    access: resolveRouteAccess({
      route,
      activeSpaceType: organization ? "ORGANIZATION" : "PERSONAL",
      isPlatformAdmin: false,
      capabilities: CAPABILITIES,
      isEnterpriseWorkspace: organization,
      planFeatures: {
        teamCollaborationIncluded: collaboration,
        intakeIncluded: plan !== "FREE",
        professionalSurfacesIncluded: collaboration,
        reviewerOperationsIncluded: plan === "TEAM" || plan === "ENTERPRISE",
        reviewQueuesIncluded: plan === "TEAM" || plan === "ENTERPRISE",
        externalReviewIncluded: collaboration,
      },
      workspace: { id: "w-1", status: "active" },
      personalSpace: { id: "w-1", status: "active" },
    }),
  }));
  const exposure = resolveNavigationExposure({ routes });
  return resolveNavigationGroups({
    primaryItems: exposure.primaryItems,
    secondaryItems: exposure.secondaryItems,
  });
}

const allItems = (plan: Plan) =>
  [
    ...sidebar(plan).groups.flatMap((g) => g.items.map((i) => ({ group: g.title, id: i.route.id, label: i.route.label }))),
    ...sidebar(plan).overflowItems.map((i) => ({ group: "More", id: i.route.id, label: i.route.label })),
  ];

for (const plan of ["PRO", "TEAM", "ENTERPRISE"] as const) {
  test(`${plan}: "Collaboration Teams" is in Governance, immediately after "Members & Access"`, () => {
    const governance = sidebar(plan).groups.find((g) => g.title === "Governance");
    assert.ok(governance, "a Governance group renders");
    const ids = governance.items.map((i) => i.route.id);
    const members = ids.indexOf("workspace.people");
    assert.ok(members >= 0, `Members & Access is in Governance (${ids.join(", ")})`);
    assert.equal(ids[members + 1], "workspace.collaboration_teams", `order: ${ids.join(", ")}`);
    const entry = governance.items[members + 1]!;
    assert.equal(entry.route.label, "Collaboration Teams");
  });

  test(`${plan}: no other group carries Collaboration Teams`, () => {
    const hits = allItems(plan).filter((i) => i.id === "workspace.collaboration_teams");
    assert.deepEqual(hits.map((h) => h.group), ["Governance"]);
  });
}

for (const plan of ["FREE", "PAYG"] as const) {
  test(`${plan}: neither Members & Access nor Collaboration Teams is a navigation item`, () => {
    const ids = allItems(plan).map((i) => i.id);
    assert.ok(!ids.includes("workspace.collaboration_teams"), "no dead Collaboration Teams item");
    assert.ok(!ids.includes("workspace.people"));
  });
}

test("no navigation label calls anything a bare 'Team' or 'Teams'", () => {
  /*
   * "Team" never names a Workspace in the product. Every registered label a
   * person can see — sidebar, All Tools, palette, breadcrumb — is checked.
   */
  for (const route of ROUTE_REGISTRY) {
    assert.notEqual(route.label, "Teams", route.id);
    assert.notEqual(route.label, "Team", route.id);
  }
});

test("the command palette names it in full, in the same group as Members & Access", () => {
  const teams = ROUTE_REGISTRY.find((r) => r.id === "workspace.collaboration_teams")!;
  const members = ROUTE_REGISTRY.find((r) => r.id === "workspace.people")!;
  assert.equal(paletteTitleFor(teams), "Collaboration Teams");
  assert.equal(paletteGroupFor(teams), paletteGroupFor(members));
});
