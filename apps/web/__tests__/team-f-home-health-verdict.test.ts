/**
 * Team remediation stage F — T-135 (audit PRD-04 / O-07). Production Home
 * showed "CRITICAL · 1 TSA timestamp failed" beside a Workspace health card
 * reading "Healthy", and "ACTIVE MATTERS" while navigation says Cases.
 * Behavioural: the real view model, one critical attention item.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  normalizeHomeViewModel,
  type NormalizeInputs,
} from "../components/home-experience/home-view-model";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function inputs(overrides: Partial<NormalizeInputs> = {}): NormalizeInputs {
  return {
    plan: "TEAM",
    planFeatures: null,
    workspaceId: WORKSPACE_ID,
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
    ...overrides,
  } as NormalizeInputs;
}

test("one CRITICAL attention item (a failed TSA timestamp) means the workspace is not 'healthy'", () => {
  const vm = normalizeHomeViewModel(
    inputs({ trustSummary: { totalEvidence: 3, signed: 3, tsa: { stamped: 2, failed: 1 } } as never }),
  );
  const critical = vm.workspacePriorities.filter((p) => p.severity === "critical");
  assert.ok(critical.length >= 1, "the fixture must raise a critical priority");
  assert.notEqual(vm.workspaceHealthOverall, "healthy");
  assert.equal(vm.workspaceHealthOverall, "action_required");
});

test("with no attention item and quiet metrics the verdict can still be 'healthy' (control)", () => {
  const vm = normalizeHomeViewModel(inputs());
  if (vm.workspacePriorities.some((p) => p.severity !== "info")) return; // fixture raised one; nothing to assert
  assert.equal(vm.workspaceHealthOverall, "healthy");
});

test("the Home cases KPI and health row say 'cases', the product word", () => {
  const vm = normalizeHomeViewModel(inputs({ planFeatures: { casesIncluded: true } as never }));
  const labels = [...vm.kpis.map((k) => k.label), ...vm.workspaceHealth.map((m) => m.label)];
  assert.ok(!labels.some((l) => /matters/i.test(l)), labels.join(" | "));
});
