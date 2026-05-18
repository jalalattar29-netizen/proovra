import test from "node:test";
import assert from "node:assert/strict";

import {
  WORKFLOW_INTAKE_MODES,
  WORKFLOW_WORKSPACE_CATEGORIES,
  WorkflowContextSchema,
  WorkflowRuleSchema,
  WorkflowStepSchema,
  WorkflowTemplateSchema,
  isExternalWorkflowIntakeMode,
  meetsWorkflowIdentityTier,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Enum sanity
// -----------------------------------------------------------------------------

test("intake modes cover the eight required modes (Phase 4 added EXTERNAL_REUSABLE and EXTERNAL_PSEUDONYMOUS)", () => {
  assert.deepEqual(
    [...WORKFLOW_INTAKE_MODES].sort(),
    [
      "AUTHENTICATED_GUIDED",
      "AUTHENTICATED_STANDARD",
      "EXTERNAL_ANONYMOUS",
      "EXTERNAL_ONE_TIME",
      "EXTERNAL_PSEUDONYMOUS",
      "EXTERNAL_REUSABLE",
      "FIELD_TEAM",
      "REVIEWER_REQUEST",
    ],
  );
});

test("workspace categories cover the named verticals plus GENERAL/OTHER", () => {
  const expected = [
    "COMPLIANCE",
    "FIELD_OPERATIONS",
    "GENERAL",
    "INSURANCE",
    "INVESTIGATIONS",
    "JOURNALISM",
    "LEGAL",
    "OTHER",
    "RESEARCH",
  ];
  assert.deepEqual([...WORKFLOW_WORKSPACE_CATEGORIES].sort(), expected);
});

test("isExternalWorkflowIntakeMode flags external-only modes", () => {
  assert.equal(isExternalWorkflowIntakeMode("EXTERNAL_ONE_TIME"), true);
  assert.equal(isExternalWorkflowIntakeMode("EXTERNAL_ANONYMOUS"), true);
  assert.equal(isExternalWorkflowIntakeMode("AUTHENTICATED_STANDARD"), false);
  assert.equal(isExternalWorkflowIntakeMode("FIELD_TEAM"), false);
  assert.equal(isExternalWorkflowIntakeMode("REVIEWER_REQUEST"), false);
  assert.equal(isExternalWorkflowIntakeMode(null), false);
  assert.equal(isExternalWorkflowIntakeMode(undefined), false);
});

test("meetsWorkflowIdentityTier respects the ordered ladder", () => {
  assert.equal(meetsWorkflowIdentityTier("VERIFIED_ORGANIZATION", "BASIC_ACCOUNT"), true);
  assert.equal(meetsWorkflowIdentityTier("BASIC_ACCOUNT", "VERIFIED_EMAIL"), false);
  assert.equal(
    meetsWorkflowIdentityTier("ORGANIZATION_ACCOUNT", "ORGANIZATION_ACCOUNT"),
    true,
  );
});

// -----------------------------------------------------------------------------
// Schema validation
// -----------------------------------------------------------------------------

function validStep(overrides = {}) {
  return {
    id: "primary_evidence",
    title: "Primary evidence file",
    description: "Upload the principal evidence item that establishes the record.",
    purposeLabel: "Primary evidence",
    required: true,
    acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
    ...overrides,
  };
}

function validTemplate(overrides = {}) {
  return {
    id: "general-evidence-record",
    slug: "general-evidence-record",
    version: 1,
    name: "General Evidence Record",
    description: "Balanced intake for primary evidence and supporting context.",
    locationRequirement: "recommended",
    planMode: "FLEXIBLE",
    intakeModes: ["AUTHENTICATED_STANDARD"],
    archived: false,
    steps: [validStep()],
    ...overrides,
  };
}

test("WorkflowStepSchema accepts a shape compatible with the existing seed", () => {
  const parsed = WorkflowStepSchema.parse(validStep());
  assert.equal(parsed.id, "primary_evidence");
  assert.equal(parsed.required, true);
});

test("WorkflowStepSchema rejects an empty acceptedKinds array", () => {
  assert.throws(() =>
    WorkflowStepSchema.parse(validStep({ acceptedKinds: [] })),
  );
});

test("WorkflowStepSchema rejects an unknown accepted kind", () => {
  assert.throws(() =>
    WorkflowStepSchema.parse(validStep({ acceptedKinds: ["PHOTO", "HOLOGRAM"] })),
  );
});

test("WorkflowTemplateSchema parses a seed-shaped template", () => {
  const parsed = WorkflowTemplateSchema.parse(validTemplate());
  assert.equal(parsed.slug, "general-evidence-record");
  assert.equal(parsed.steps.length, 1);
});

test("WorkflowTemplateSchema enforces kebab-case slug", () => {
  assert.throws(() => WorkflowTemplateSchema.parse(validTemplate({ slug: "Bad_Slug" })));
  assert.throws(() => WorkflowTemplateSchema.parse(validTemplate({ slug: "-bad" })));
  assert.throws(() => WorkflowTemplateSchema.parse(validTemplate({ slug: "bad-" })));
});

test("WorkflowTemplateSchema requires at least one intake mode", () => {
  assert.throws(() => WorkflowTemplateSchema.parse(validTemplate({ intakeModes: [] })));
});

test("WorkflowTemplateSchema requires at least one step", () => {
  assert.throws(() => WorkflowTemplateSchema.parse(validTemplate({ steps: [] })));
});

test("WorkflowRuleSchema accepts the four named actions", () => {
  for (const action of [
    "requireStep",
    "hideStep",
    "requireField",
    "requireIdentityTier",
  ]) {
    WorkflowRuleSchema.parse({
      id: "rule-1",
      when: { field: "intakeMode", op: "eq", value: "EXTERNAL_ONE_TIME" },
      then: { action, target: "primary_evidence" },
    });
  }
});

test("WorkflowRuleSchema rejects an unknown action", () => {
  assert.throws(() =>
    WorkflowRuleSchema.parse({
      id: "rule-1",
      when: { field: "intakeMode", op: "eq", value: "EXTERNAL_ONE_TIME" },
      then: { action: "deleteEvidence", target: "primary_evidence" },
    }),
  );
});

test("WorkflowContextSchema parses a complete context", () => {
  const ctx = {
    workspaceId: "ws-1",
    workspaceCategory: "INSURANCE",
    template: validTemplate(),
    intakeMode: "AUTHENTICATED_STANDARD",
    planMode: "FLEXIBLE",
    submitterRole: "MEMBER",
    submitterIdentityTier: "VERIFIED_EMAIL",
  };
  const parsed = WorkflowContextSchema.parse(ctx);
  assert.equal(parsed.workspaceCategory, "INSURANCE");
  assert.equal(parsed.template.slug, "general-evidence-record");
});
