/**
 * Phase 2A — Reviewer Workspace contract test.
 *
 * Pins the canonical surface introduced by Phase 2A:
 *
 *   1. Shared reviewer-workspace contracts (roles, field types,
 *      verdicts, QC states, disagreement state machine, hotkeys)
 *   2. Prisma schema declares the 5 new models with bounded fields
 *      and the workflow extension.
 *   3. Backend services exist (coding-schema, coding-value,
 *      disagreement, QC, workspace aggregator, metrics).
 *   4. Routes are registered and the bounded paths exist.
 *   5. Frontend pages exist (workspace, schemas, qc, disagreements,
 *      metrics) and consume the bounded contracts.
 *   6. Pillar registry maps the new routes to REVIEW.
 *   7. Hotkey catalog is bounded + non-overlapping.
 *
 * Plus a small runtime test for the disagreement state machine.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DISAGREEMENT_STATES,
  REVIEWER_HOTKEY_CODES,
  REVIEWER_DEFAULT_HOTKEYS,
  isAllowedDisagreementTransition,
  reviewerCapabilitiesForRole,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const SHARED = readSource(
  "../../../packages/shared/src/reviewer-workspace.ts",
);
const SHARED_INDEX = readSource("../../../packages/shared/src/index.ts");
const SCHEMA = readSource("../../../services/api/prisma/schema.prisma");
const ROLES = readSource(
  "../../../services/api/src/services/reviewer-workspace/reviewer-roles.ts",
);
const CODING_SCHEMA = readSource(
  "../../../services/api/src/services/reviewer-workspace/coding-schema.service.ts",
);
const CODING_VALUE = readSource(
  "../../../services/api/src/services/reviewer-workspace/coding-value.service.ts",
);
const DISAGREE_SVC = readSource(
  "../../../services/api/src/services/reviewer-workspace/reviewer-disagreement.service.ts",
);
const QC_SVC = readSource(
  "../../../services/api/src/services/reviewer-workspace/qc-sample.service.ts",
);
const WORKSPACE_SVC = readSource(
  "../../../services/api/src/services/reviewer-workspace/reviewer-workspace.service.ts",
);
const METRICS_SVC = readSource(
  "../../../services/api/src/services/reviewer-workspace/reviewer-metrics.service.ts",
);
const ROUTES = readSource(
  "../../../services/api/src/routes/reviewer-workspace.routes.ts",
);
const SERVER = readSource("../../../services/api/src/server.ts");
const PILLAR_REGISTRY = readSource(
  "../../../apps/web/lib/navigation/pillarRegistry.ts",
);
const ROUTE_REGISTRY = readSource(
  "../../../apps/web/lib/navigation/routeRegistry.ts",
);
const WORKSPACE_PAGE = readSource(
  "../../../apps/web/app/(app)/review/workspace/page.tsx",
);
const SCHEMAS_PAGE = readSource(
  "../../../apps/web/app/(app)/review/schemas/page.tsx",
);
const QC_PAGE = readSource(
  "../../../apps/web/app/(app)/review/qc/page.tsx",
);
const DISAGREE_PAGE = readSource(
  "../../../apps/web/app/(app)/review/disagreements/page.tsx",
);
const METRICS_PAGE = readSource(
  "../../../apps/web/app/(app)/review/metrics/page.tsx",
);
const CODING_PANEL = readSource(
  "../../../apps/web/components/reviewer-workspace/CodingPanel.tsx",
);
const HOTKEYS_LIB = readSource(
  "../../../apps/web/lib/reviewer-workspace/reviewer-hotkeys.ts",
);
const REVIEWER_API = readSource(
  "../../../apps/web/lib/reviewer-workspace/reviewer-api.ts",
);

// ===========================================================================
// 1 — Shared contracts
// ===========================================================================

describe("Phase 2A — shared contracts", () => {
  it("declares REVIEWER_ROLES with the 5 canonical roles", () => {
    expect(SHARED).toMatch(/REVIEWER_ROLES\s*=\s*\[/);
    for (const role of [
      "REVIEWER",
      "SENIOR_REVIEWER",
      "QC_REVIEWER",
      "SUPERVISOR",
      "REVIEW_ADMIN",
    ]) {
      expect(SHARED).toContain(`"${role}"`);
    }
  });

  it("declares CODING_FIELD_TYPES with all 9 bounded types", () => {
    for (const type of [
      "TEXT",
      "NUMERIC",
      "SINGLE_SELECT",
      "MULTI_SELECT",
      "BOOLEAN",
      "CONFIDENCE_SCORE",
      "REVIEWER_VERDICT",
      "RISK_LEVEL",
      "ESCALATION_LEVEL",
    ]) {
      expect(SHARED).toContain(`"${type}"`);
    }
  });

  it("declares DISAGREEMENT_STATES + bounded transitions", () => {
    for (const s of [
      "FILED",
      "UNDER_SECOND_REVIEW",
      "UNDER_SUPERVISOR_REVIEW",
      "RESOLVED_UPHELD",
      "RESOLVED_OVERTURNED",
      "RESOLVED_PARTIAL",
      "WITHDRAWN",
    ]) {
      expect(SHARED).toContain(`"${s}"`);
    }
    expect(SHARED).toMatch(/DISAGREEMENT_TRANSITIONS/);
  });

  it("declares QC_VERDICTS + QC_FAILURE_REASONS", () => {
    for (const v of ["PASS", "FAIL", "PARTIAL"]) {
      expect(SHARED).toContain(`"${v}"`);
    }
    for (const r of [
      "INCORRECT_CODING",
      "MISSING_REQUIRED_FIELDS",
      "WRONG_DECISION",
      "MISSED_ESCALATION",
    ]) {
      expect(SHARED).toContain(`"${r}"`);
    }
  });

  it("declares hotkey codes + default key bindings", () => {
    expect(SHARED).toMatch(/REVIEWER_HOTKEY_CODES\s*=/);
    expect(SHARED).toMatch(/REVIEWER_DEFAULT_HOTKEYS/);
    for (const c of ["APPROVE", "REJECT", "ESCALATE", "REQUEST_INFO", "NEXT_ITEM"]) {
      expect(SHARED).toContain(`"${c}"`);
    }
  });

  it("hotkey default bindings have unique keys (no collisions)", () => {
    const used = new Set<string>();
    for (const code of REVIEWER_HOTKEY_CODES) {
      const key = REVIEWER_DEFAULT_HOTKEYS[code];
      expect(used.has(key), `collision on ${key}`).toBe(false);
      used.add(key);
    }
  });

  it("shared index re-exports the Phase 2A contracts", () => {
    expect(SHARED_INDEX).toMatch(/REVIEWER_ROLES/);
    expect(SHARED_INDEX).toMatch(/CODING_FIELD_TYPES/);
    expect(SHARED_INDEX).toMatch(/DISAGREEMENT_STATES/);
    expect(SHARED_INDEX).toMatch(/REVIEWER_HOTKEY_CODES/);
    expect(SHARED_INDEX).toMatch(/ReviewerWorkspaceProjection/);
  });
});

// ===========================================================================
// 2 — Role catalog runtime check (capabilities are bounded + non-empty)
// ===========================================================================

describe("Phase 2A — role capability matrix", () => {
  it("REVIEW_ADMIN has every capability", () => {
    const caps = reviewerCapabilitiesForRole("REVIEW_ADMIN");
    expect(caps.size).toBeGreaterThan(0);
    for (const required of [
      "review.code",
      "review.decide",
      "review.adjudicate",
      "review.assign",
      "review.qc.verdict",
      "review.schema.author",
      "review.sampling.policy",
    ] as const) {
      expect(caps.has(required), `REVIEW_ADMIN missing ${required}`).toBe(true);
    }
  });
  it("REVIEWER cannot adjudicate or author schemas", () => {
    const caps = reviewerCapabilitiesForRole("REVIEWER");
    expect(caps.has("review.adjudicate")).toBe(false);
    expect(caps.has("review.schema.author")).toBe(false);
    expect(caps.has("review.qc.verdict")).toBe(false);
  });
  it("QC_REVIEWER has qc verdict but not decisions", () => {
    const caps = reviewerCapabilitiesForRole("QC_REVIEWER");
    expect(caps.has("review.qc.verdict")).toBe(true);
    expect(caps.has("review.decide")).toBe(false);
  });
});

// ===========================================================================
// 3 — Disagreement state machine runtime check
// ===========================================================================

describe("Phase 2A — disagreement state machine", () => {
  it("FILED → UNDER_SECOND_REVIEW is allowed", () => {
    expect(isAllowedDisagreementTransition("FILED", "UNDER_SECOND_REVIEW")).toBe(true);
  });
  it("FILED → RESOLVED_UPHELD is NOT allowed (must pass through second review)", () => {
    expect(isAllowedDisagreementTransition("FILED", "RESOLVED_UPHELD")).toBe(false);
  });
  it("RESOLVED_* is terminal", () => {
    for (const terminal of [
      "RESOLVED_UPHELD",
      "RESOLVED_OVERTURNED",
      "RESOLVED_PARTIAL",
      "WITHDRAWN",
    ] as const) {
      for (const to of DISAGREEMENT_STATES) {
        expect(isAllowedDisagreementTransition(terminal, to)).toBe(false);
      }
    }
  });
});

// ===========================================================================
// 4 — Prisma schema
// ===========================================================================

describe("Phase 2A — Prisma schema", () => {
  it("declares CodingSchema model", () => {
    expect(SCHEMA).toMatch(/^model CodingSchema \{/m);
  });
  it("declares CodingField model + uniqueness", () => {
    expect(SCHEMA).toMatch(/^model CodingField \{/m);
    const block = SCHEMA.match(/^model CodingField \{[\s\S]*?\n\}/m)![0];
    expect(block).toMatch(/@@unique\(\[schemaId,\s*slug\]/);
  });
  it("declares CodingValue model + (workflow, field) uniqueness", () => {
    expect(SCHEMA).toMatch(/^model CodingValue \{/m);
    const block = SCHEMA.match(/^model CodingValue \{[\s\S]*?\n\}/m)![0];
    expect(block).toMatch(/@@unique\(\[workflowId,\s*fieldId\]/);
  });
  it("declares ReviewerDisagreement + QcSample", () => {
    expect(SCHEMA).toMatch(/^model ReviewerDisagreement \{/m);
    expect(SCHEMA).toMatch(/^model QcSample \{/m);
  });
  it("extends EvidenceReviewWorkflow with coding-schema binding", () => {
    const block = SCHEMA.match(
      /^model EvidenceReviewWorkflow \{[\s\S]*?\n\}/m,
    )![0];
    expect(block).toContain("codingSchemaId");
    expect(block).toContain("codingSchemaVersion");
  });
});

// ===========================================================================
// 5 — Services
// ===========================================================================

describe("Phase 2A — backend services", () => {
  it("coding schema service exposes the bounded surface", () => {
    expect(CODING_SCHEMA).toMatch(/createSchema/);
    expect(CODING_SCHEMA).toMatch(/publishSchema/);
    expect(CODING_SCHEMA).toMatch(/archiveSchema/);
    expect(CODING_SCHEMA).toMatch(/bindSchemaToWorkflow/);
    expect(CODING_SCHEMA).toMatch(/seedDefaultSchemas/);
  });
  it("coding value service validates per type + blocks closed workflows", () => {
    expect(CODING_VALUE).toMatch(/writeCodingValue/);
    expect(CODING_VALUE).toMatch(/WORKFLOW_CLOSED/);
    expect(CODING_VALUE).toMatch(/evaluateRequiredFieldsCoverage/);
  });
  it("disagreement service uses isAllowedDisagreementTransition", () => {
    expect(DISAGREE_SVC).toMatch(/isAllowedDisagreementTransition/);
    expect(DISAGREE_SVC).toMatch(/DISAGREEMENT_SELF_FILE/);
  });
  it("QC service has sampleClosedWorkflow + renderQcVerdict", () => {
    expect(QC_SVC).toMatch(/sampleClosedWorkflow/);
    expect(QC_SVC).toMatch(/renderQcVerdict/);
    expect(QC_SVC).toMatch(/getQcAccuracy7d/);
  });
  it("workspace aggregator returns bounded projection shape", () => {
    expect(WORKSPACE_SVC).toMatch(/projectReviewerWorkspace/);
    expect(WORKSPACE_SVC).toMatch(/REVIEWER_WORKSPACE_SCHEMA_VERSION/);
  });
  it("metrics service exposes per-reviewer + team aggregates", () => {
    expect(METRICS_SVC).toMatch(/getReviewerMetrics7d/);
    expect(METRICS_SVC).toMatch(/getReviewerMetricsTeam/);
  });
  it("roles service exposes resolveReviewerRole + callerHasCapability", () => {
    expect(ROLES).toMatch(/resolveReviewerRole/);
    expect(ROLES).toMatch(/callerHasCapability/);
  });
});

// ===========================================================================
// 6 — Routes
// ===========================================================================

describe("Phase 2A — routes", () => {
  it("declares the canonical bounded paths", () => {
    for (const path of [
      '"/v1/reviewer/workspace"',
      '"/v1/reviewer/metrics"',
      '"/v1/coding/schemas"',
      '"/v1/coding/schemas/:id"',
      '"/v1/coding/schemas/:id/publish"',
      '"/v1/coding/schemas/:id/archive"',
      '"/v1/coding/schemas/seed-defaults"',
      '"/v1/reviewer/work/:workflowId/coding"',
      '"/v1/reviewer/work/:workflowId/code"',
      '"/v1/reviewer/work/:workflowId/disagree"',
      '"/v1/reviewer/work/:workflowId/bind-schema"',
      '"/v1/reviewer/disagreements"',
      '"/v1/reviewer/disagreements/:id/transition"',
      '"/v1/reviewer/qc/samples"',
      '"/v1/reviewer/qc/samples/:id/assign"',
      '"/v1/reviewer/qc/samples/:id/verdict"',
    ]) {
      expect(ROUTES).toContain(path);
    }
  });
  it("server.ts registers reviewerWorkspaceRoutes", () => {
    expect(SERVER).toMatch(/reviewerWorkspaceRoutes/);
    expect(SERVER).toMatch(/app\.register\(reviewerWorkspaceRoutes\)/);
  });
  it("routes use bounded denial reasons", () => {
    expect(ROUTES).toMatch(/WORKSPACE_NOT_FOUND/);
    expect(ROUTES).toMatch(/NOT_PERMITTED/);
  });
});

// ===========================================================================
// 7 — Frontend pages + libs
// ===========================================================================

describe("Phase 2A — frontend pages", () => {
  it("workspace page wraps in PageRouteGate + uses hotkeys", () => {
    expect(WORKSPACE_PAGE).toMatch(/PageRouteGate routeId="workspace\.review_workspace"/);
    expect(WORKSPACE_PAGE).toMatch(/useReviewerHotkeys/);
    expect(WORKSPACE_PAGE).toMatch(/CodingPanel/);
  });
  it("schemas page wires seed-defaults action", () => {
    expect(SCHEMAS_PAGE).toMatch(/seedDefaultSchemas/);
    expect(SCHEMAS_PAGE).toMatch(/data-coding-seed-defaults/);
  });
  it("QC page renders pass/fail/partial verdict buttons", () => {
    expect(QC_PAGE).toMatch(/data-qc-verdict-btn/);
    expect(QC_PAGE).toMatch(/QC_VERDICTS/);
    expect(QC_PAGE).toMatch(/QC_FAILURE_REASONS/);
  });
  it("disagreements page renders state-machine buttons", () => {
    expect(DISAGREE_PAGE).toMatch(/data-disagreement-transition-btn/);
    expect(DISAGREE_PAGE).toMatch(/DISAGREEMENT_STATES/);
  });
  it("metrics page renders bounded metric cards", () => {
    expect(METRICS_PAGE).toMatch(/data-reviewer-metric-card/);
    expect(METRICS_PAGE).toMatch(/throughput7d/);
    expect(METRICS_PAGE).toMatch(/approvalRate7dPct/);
    expect(METRICS_PAGE).toMatch(/qcFailureRate7dPct/);
  });
  it("CodingPanel renders the 9 field-type widgets", () => {
    for (const type of [
      '"TEXT"',
      '"NUMERIC"',
      '"BOOLEAN"',
      '"CONFIDENCE_SCORE"',
      '"REVIEWER_VERDICT"',
      '"RISK_LEVEL"',
      '"ESCALATION_LEVEL"',
      '"SINGLE_SELECT"',
      '"MULTI_SELECT"',
    ]) {
      expect(CODING_PANEL).toContain(`case ${type}`);
    }
  });
  it("hotkeys lib registers a global keydown handler", () => {
    expect(HOTKEYS_LIB).toMatch(/window\.addEventListener\(\s*"keydown"/);
    expect(HOTKEYS_LIB).toMatch(/isEditable/);
  });
  it("reviewer-api binds the canonical bounded endpoints", () => {
    for (const url of [
      "/v1/reviewer/workspace",
      "/v1/reviewer/metrics",
      "/v1/coding/schemas",
      "/v1/reviewer/work/${input.workflowId}/code",
      "/v1/reviewer/disagreements/${input.disagreementId}/transition",
      "/v1/reviewer/qc/samples/${input.sampleId}/verdict",
    ]) {
      expect(REVIEWER_API).toContain(url);
    }
  });
});

// ===========================================================================
// 8 — Nav wiring (REVIEW pillar)
// ===========================================================================

describe("Phase 2A — pillar nav", () => {
  it("routeRegistry registers the 5 new Phase 2A routes", () => {
    for (const id of [
      "workspace.review_workspace",
      "workspace.coding_schemas",
      "workspace.review_qc",
      "workspace.review_disagreements",
      "workspace.review_metrics",
    ]) {
      expect(ROUTE_REGISTRY).toMatch(new RegExp(`id:\\s*"${id}"`));
    }
  });
  it("pillarRegistry maps every new route to the REVIEW pillar", () => {
    for (const id of [
      "workspace.review_workspace",
      "workspace.coding_schemas",
      "workspace.review_qc",
      "workspace.review_disagreements",
      "workspace.review_metrics",
    ]) {
      expect(PILLAR_REGISTRY).toMatch(
        new RegExp(`"${id}"[\\s,]+"REVIEW"`),
      );
    }
  });
});
