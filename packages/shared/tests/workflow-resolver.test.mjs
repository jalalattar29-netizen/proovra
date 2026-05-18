import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveWorkflowContext,
  safeParseWorkflowTemplate,
  safeParseWorkflowTemplateList,
  sanitizeWorkflowRules,
  sanitizeWorkflowSteps,
  templateMatchesIntakeMode,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function validStep(overrides = {}) {
  return {
    id: "primary_evidence",
    title: "Primary evidence",
    description: "Upload the principal evidence item.",
    purposeLabel: "Primary evidence",
    required: true,
    acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
    ...overrides,
  };
}

function validTemplatePayload(overrides = {}) {
  return {
    id: "general-evidence-record",
    slug: "general-evidence-record",
    version: 1,
    name: "General Evidence Record",
    description: "Balanced intake for primary evidence and supporting context.",
    locationRequirement: "recommended",
    planMode: "FLEXIBLE",
    intakeModes: ["AUTHENTICATED_STANDARD", "AUTHENTICATED_GUIDED"],
    archived: false,
    steps: [validStep()],
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// safeParseWorkflowTemplate
// -----------------------------------------------------------------------------

test("safeParseWorkflowTemplate accepts a server-projected template", () => {
  const parsed = safeParseWorkflowTemplate({
    ...validTemplatePayload(),
    // Server projection adds these extras — must be ignored gracefully.
    dbId: "00000000-0000-0000-0000-000000000099",
    source: "platform_seed",
  });
  assert.ok(parsed);
  assert.equal(parsed.slug, "general-evidence-record");
});

test("safeParseWorkflowTemplate coerces null optional fields to undefined", () => {
  const parsed = safeParseWorkflowTemplate({
    ...validTemplatePayload(),
    allowedRoles: null,
    workspaceCategory: null,
    rules: null,
  });
  assert.ok(parsed);
  assert.equal(parsed.allowedRoles, undefined);
  assert.equal(parsed.workspaceCategory, undefined);
  assert.equal(parsed.rules, undefined);
});

test("safeParseWorkflowTemplate returns null for a non-object input", () => {
  assert.equal(safeParseWorkflowTemplate(null), null);
  assert.equal(safeParseWorkflowTemplate(undefined), null);
  assert.equal(safeParseWorkflowTemplate("string"), null);
  assert.equal(safeParseWorkflowTemplate(42), null);
  assert.equal(safeParseWorkflowTemplate([]), null);
});

test("safeParseWorkflowTemplate returns null when slug is not kebab-case", () => {
  assert.equal(
    safeParseWorkflowTemplate(validTemplatePayload({ slug: "Bad_Slug" })),
    null,
  );
});

test("safeParseWorkflowTemplate returns null when intakeModes is empty", () => {
  assert.equal(
    safeParseWorkflowTemplate(validTemplatePayload({ intakeModes: [] })),
    null,
  );
});

test("safeParseWorkflowTemplate returns null when steps is empty", () => {
  assert.equal(
    safeParseWorkflowTemplate(validTemplatePayload({ steps: [] })),
    null,
  );
});

test("safeParseWorkflowTemplate returns null when step has unknown acceptedKind", () => {
  assert.equal(
    safeParseWorkflowTemplate(
      validTemplatePayload({
        steps: [validStep({ acceptedKinds: ["PHOTO", "HOLOGRAM"] })],
      }),
    ),
    null,
  );
});

// -----------------------------------------------------------------------------
// safeParseWorkflowTemplateList
// -----------------------------------------------------------------------------

test("safeParseWorkflowTemplateList returns templates from a valid list", () => {
  const list = [validTemplatePayload({ slug: "a-one" }), validTemplatePayload({ slug: "a-two" })];
  const result = safeParseWorkflowTemplateList(list);
  assert.equal(result.templates.length, 2);
  assert.equal(result.invalidCount, 0);
});

test("safeParseWorkflowTemplateList drops invalid entries without throwing", () => {
  const list = [
    validTemplatePayload({ slug: "good-row" }),
    { slug: "BadSlug", invalid: true },
    validTemplatePayload({ slug: "another-good" }),
    null,
  ];
  const result = safeParseWorkflowTemplateList(list);
  assert.equal(result.templates.length, 2);
  assert.equal(result.invalidCount, 2);
  assert.deepEqual(result.invalidSlugs, ["BadSlug", null]);
});

test("safeParseWorkflowTemplateList handles non-array input", () => {
  for (const value of [null, undefined, {}, "string", 42]) {
    const result = safeParseWorkflowTemplateList(value);
    assert.equal(result.templates.length, 0);
    assert.equal(result.invalidCount, 0);
  }
});

// -----------------------------------------------------------------------------
// sanitizeWorkflowRules
// -----------------------------------------------------------------------------

test("sanitizeWorkflowRules keeps valid rules and drops invalid ones", () => {
  const rules = [
    {
      id: "rule-good",
      when: { field: "intakeMode", op: "eq", value: "EXTERNAL_ONE_TIME" },
      then: { action: "requireStep", target: "primary_evidence" },
    },
    {
      id: "rule-bad",
      when: { field: "intakeMode", op: "eq", value: "EXTERNAL_ONE_TIME" },
      then: { action: "deleteEvidence", target: "primary_evidence" }, // unsupported action
    },
  ];
  const result = sanitizeWorkflowRules(rules);
  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].id, "rule-good");
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].ruleId, "rule-bad");
  assert.equal(result.warnings[0].reason, "schema_validation_failed");
});

test("sanitizeWorkflowRules handles non-array inputs", () => {
  for (const value of [null, undefined, {}, "string"]) {
    const result = sanitizeWorkflowRules(value);
    assert.equal(result.rules.length, 0);
    assert.equal(result.warnings.length, 0);
  }
});

test("sanitizeWorkflowRules captures null ruleId when the rule has no id", () => {
  const result = sanitizeWorkflowRules([{ when: {}, then: {} }]);
  assert.equal(result.rules.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].ruleId, null);
});

// -----------------------------------------------------------------------------
// sanitizeWorkflowSteps
// -----------------------------------------------------------------------------

test("sanitizeWorkflowSteps keeps valid steps and drops invalid ones", () => {
  const steps = [
    validStep({ id: "step-good" }),
    { id: "step-bad", required: true, acceptedKinds: ["PHOTO"] }, // missing title/purposeLabel
  ];
  const result = sanitizeWorkflowSteps(steps);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].id, "step-good");
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].stepId, "step-bad");
});

// -----------------------------------------------------------------------------
// resolveWorkflowContext
// -----------------------------------------------------------------------------

const sharedTemplate = safeParseWorkflowTemplate(validTemplatePayload());
assert.ok(sharedTemplate, "fixture template must parse");

test("resolveWorkflowContext returns null when template is missing", () => {
  const result = resolveWorkflowContext({
    template: null,
    workspaceId: "ws-1",
  });
  assert.equal(result.context, null);
  assert.equal(result.reason, "missing_template");
});

test("resolveWorkflowContext returns null when workspaceId is missing", () => {
  const result = resolveWorkflowContext({
    template: sharedTemplate,
    workspaceId: null,
  });
  assert.equal(result.context, null);
  assert.equal(result.reason, "missing_workspace_id");
});

test("resolveWorkflowContext returns context with safe defaults", () => {
  const result = resolveWorkflowContext({
    template: sharedTemplate,
    workspaceId: "ws-1",
  });
  assert.ok(result.context);
  assert.equal(result.reason, "ok");
  // Defaults to first allowed intake mode on the template
  assert.equal(result.context.intakeMode, "AUTHENTICATED_STANDARD");
  assert.equal(result.context.planMode, "FLEXIBLE");
  assert.equal(result.context.workspaceCategory, "GENERAL");
  assert.equal(result.context.submitterIdentityTier, "BASIC_ACCOUNT");
  assert.equal(result.context.submitterRole, null);
});

test("resolveWorkflowContext honors an explicit intake mode when whitelisted", () => {
  const result = resolveWorkflowContext({
    template: sharedTemplate,
    workspaceId: "ws-1",
    intakeMode: "AUTHENTICATED_GUIDED",
  });
  assert.equal(result.context?.intakeMode, "AUTHENTICATED_GUIDED");
});

test("resolveWorkflowContext rejects an intake mode the template does not allow", () => {
  const result = resolveWorkflowContext({
    template: sharedTemplate,
    workspaceId: "ws-1",
    intakeMode: "EXTERNAL_ONE_TIME",
  });
  assert.equal(result.context, null);
  assert.equal(result.reason, "template_intake_mode_mismatch");
});

test("resolveWorkflowContext promotes workspace category from input over template default", () => {
  const result = resolveWorkflowContext({
    template: sharedTemplate,
    workspaceId: "ws-1",
    workspaceCategory: "INSURANCE",
  });
  assert.equal(result.context?.workspaceCategory, "INSURANCE");
});

test("resolveWorkflowContext propagates intakeLinkId when provided", () => {
  const result = resolveWorkflowContext({
    template: sharedTemplate,
    workspaceId: "ws-1",
    intakeLinkId: "link-1",
  });
  assert.equal(result.context?.intakeLinkId, "link-1");
});

test("resolveWorkflowContext does NOT add an intakeLinkId field when not provided", () => {
  const result = resolveWorkflowContext({
    template: sharedTemplate,
    workspaceId: "ws-1",
  });
  assert.equal(result.context?.intakeLinkId, undefined);
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.context, "intakeLinkId"),
    false,
  );
});

// -----------------------------------------------------------------------------
// templateMatchesIntakeMode
// -----------------------------------------------------------------------------

test("templateMatchesIntakeMode returns true for an allowed mode", () => {
  assert.equal(
    templateMatchesIntakeMode(sharedTemplate, "AUTHENTICATED_STANDARD"),
    true,
  );
});

test("templateMatchesIntakeMode returns false for a disallowed mode", () => {
  assert.equal(
    templateMatchesIntakeMode(sharedTemplate, "EXTERNAL_ANONYMOUS"),
    false,
  );
});

// -----------------------------------------------------------------------------
// Seed compatibility: every shape produced by liftIntakeTemplateToWorkflowTemplate
// in Phase 2 must round-trip through safeParseWorkflowTemplate. We mirror the
// expected lifted shape here without importing Phase 2 service code.
// -----------------------------------------------------------------------------

test("a seed-lift-shaped template parses cleanly", () => {
  // This object mirrors the projection emitted by
  // services/api/src/services/workflow-template.service.ts for a platform_seed
  // template. Keep this fixture in sync with the lift function defaults.
  const seedShape = {
    id: "insurance-claim",
    slug: "insurance-claim",
    version: 1,
    name: "Insurance Claim",
    description: "Capture damage, policy documentation, and ownership context.",
    locationRequirement: "recommended",
    planMode: "FLEXIBLE",
    intakeModes: ["AUTHENTICATED_STANDARD", "AUTHENTICATED_GUIDED"],
    allowedRoles: null,
    workspaceCategory: null,
    archived: false,
    rules: [],
    steps: [
      {
        id: "overview_media",
        title: "Overview photo/video",
        description: "Capture a high-level image or video overview of the insured loss.",
        purposeLabel: "Overview media",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
    ],
  };
  const parsed = safeParseWorkflowTemplate(seedShape);
  assert.ok(parsed, "seed-lift-shaped payload must parse");
  assert.equal(parsed.slug, "insurance-claim");
  assert.equal(parsed.planMode, "FLEXIBLE");
});

test("a malformed list returned by the workflow API does not crash the parser", () => {
  // Simulates a corrupted server response. The parser must tolerate it and
  // return zero templates rather than throw.
  const result = safeParseWorkflowTemplateList({
    not_an_array: true,
  });
  assert.equal(result.templates.length, 0);
});

// -----------------------------------------------------------------------------
// Phase 3 "rules do not crash capture" contract
// -----------------------------------------------------------------------------

test("a template with unsupported rules still parses with rules stripped", () => {
  const tpl = validTemplatePayload({
    rules: [
      {
        id: "weird-rule",
        when: { field: "x", op: "eq", value: "y" },
        then: { action: "yeetEvidence", target: "primary_evidence" },
      },
    ],
  });

  // Phase 3 contract: a template with malformed rules should still be usable.
  // safeParseWorkflowTemplate strips the rule list on retry and returns the
  // template. Capture does not yet evaluate rules anyway.
  const parsed = safeParseWorkflowTemplate(tpl);
  assert.ok(parsed, "template with bad rules must still parse (rules stripped)");
  assert.equal(parsed.rules, undefined);

  // sanitizeWorkflowRules is the explicit salvage path: callers that want
  // per-rule diagnostics can route through it to learn what was dropped.
  const sanitized = sanitizeWorkflowRules(tpl.rules);
  assert.equal(sanitized.rules.length, 0);
  assert.equal(sanitized.warnings.length, 1);
});

test("safeParseWorkflowTemplate does not strip rules when they are all valid", () => {
  const tpl = validTemplatePayload({
    rules: [
      {
        id: "good-rule",
        when: { field: "intakeMode", op: "eq", value: "AUTHENTICATED_STANDARD" },
        then: { action: "requireStep", target: "primary_evidence" },
      },
    ],
  });
  const parsed = safeParseWorkflowTemplate(tpl);
  assert.ok(parsed);
  assert.equal(parsed.rules?.length, 1);
  assert.equal(parsed.rules?.[0].id, "good-rule");
});

test("safeParseWorkflowTemplate still fails when a non-rule field is invalid even if rules are bad too", () => {
  // If the template fundamentally won't validate (e.g., bad slug), retrying
  // without rules can't save it. Must return null.
  const tpl = validTemplatePayload({
    slug: "Bad_Slug",
    rules: [
      {
        id: "weird-rule",
        when: { field: "x", op: "eq", value: "y" },
        then: { action: "yeetEvidence", target: "primary_evidence" },
      },
    ],
  });
  assert.equal(safeParseWorkflowTemplate(tpl), null);
});
