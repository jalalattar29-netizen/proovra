/**
 * Phase R — Workflow template SLA override wiring.
 *
 * Phase 1 evidence showed the SLA template-override branch at
 * `services/api/src/services/reviewer-ops/sla-policy.service.ts:loadTemplateOverride`
 * was unreachable in production: every caller of `resolveEffectiveSlaPolicy`
 * omitted `templateId`, and `EvidenceReviewWorkflow` carries no template
 * column.
 *
 * Phase 2 wires resolution via the two existing UUID-anchored joins:
 *
 *   1. EvidenceWorkflowInstanceEvidence  → EvidenceWorkflowInstance.templateId
 *   2. WorkflowIntakeSession.evidenceId  → WorkflowIntakeLink.workflowTemplateId
 *
 * The wiring lives in `reviewer-operations-engine.service.ts` as
 * `resolveTemplateIdForEvidence`. The assignment site at
 * `assignReviewerToWorkflowInner` calls it, passes the resolved templateId
 * into `resolveEffectiveSlaPolicy`, and emits one audit row per
 * resolution with the precedence source label.
 *
 * These tests pin the contract:
 *
 *   1. No resolvable template → baseline SLA holds (no override).
 *   2. Evidence resolves to a template carrying `reviewPolicyJson.sla` →
 *      template SLA wins.
 *   3. Resolution failure (Prisma throws) → no exception bubbles,
 *      `source:"error"` is reported, baseline still holds.
 *   4. Audit emitter receives the correct source label
 *      ("template_override" / "team_default" / "platform_baseline").
 *
 * The tests use unit-level mocks of the Prisma client so they exercise
 * the wiring in `reviewer-operations-engine.service.ts` directly without
 * a real database.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  REVIEWER_OPS_DEFAULT_SLA_POLICY,
  resolveReviewerOpsSlaPolicy,
} from "@proovra/shared";

import { resolveTemplateIdForEvidence } from "../src/services/reviewer-ops/reviewer-operations-engine.service.js";
import { resolveEffectiveSlaPolicy } from "../src/services/reviewer-ops/sla-policy.service.js";

// ---------------------------------------------------------------------------
// Helpers — build a thin Prisma stub that satisfies the joins our resolver
// uses. The stub only implements the methods the resolver touches:
//
//   - evidenceReviewWorkflow.findUnique        (Phase T direct-trio read;
//                                               default-null so the legacy
//                                               two-join path runs)
//   - evidenceWorkflowInstanceEvidence.findFirst
//   - workflowIntakeSession.findUnique
//   - evidenceWorkflowTemplate.findUnique      (used by sla-policy.service)
//   - evidenceWorkflowTemplate.findFirst       (Phase T slug→DB lookup;
//                                               default-null so the direct
//                                               path falls through cleanly)
//   - workspaceGovernancePolicy.findUnique     (used by sla-policy.service)
// ---------------------------------------------------------------------------

type PrismaStub = {
  evidenceReviewWorkflow: { findUnique: ReturnType<typeof vi.fn> };
  evidenceWorkflowInstanceEvidence: { findFirst: ReturnType<typeof vi.fn> };
  workflowIntakeSession: { findUnique: ReturnType<typeof vi.fn> };
  evidenceWorkflowTemplate: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  workspaceGovernancePolicy: { findUnique: ReturnType<typeof vi.fn> };
};

// Each top-level model can be overridden independently AND each method
// inside an override is itself optional, so tests can pass e.g.
// `{ evidenceWorkflowTemplate: { findUnique: vi.fn() } }` without having
// to restate the unused findFirst default.
type PrismaStubOverrides = {
  [K in keyof PrismaStub]?: Partial<PrismaStub[K]>;
};

function makePrismaStub(overrides: PrismaStubOverrides = {}): PrismaStub {
  const base: PrismaStub = {
    evidenceReviewWorkflow: {
      // Default: no trio columns set → resolver falls through to legacy joins.
      findUnique: vi.fn().mockResolvedValue(null),
    },
    evidenceWorkflowInstanceEvidence: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    workflowIntakeSession: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    evidenceWorkflowTemplate: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    workspaceGovernancePolicy: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
  // Merge per-model so a partial override on one method does not erase
  // sibling method defaults on the same model.
  for (const key of Object.keys(overrides) as (keyof PrismaStub)[]) {
    const partial = overrides[key];
    if (!partial) continue;
    (base[key] as Record<string, unknown>) = {
      ...(base[key] as Record<string, unknown>),
      ...(partial as Record<string, unknown>),
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// resolveTemplateIdForEvidence — direct contract.
// ---------------------------------------------------------------------------

describe("resolveTemplateIdForEvidence", () => {
  it("returns source:'none' when no instance link and no intake session exist", async () => {
    const prisma = makePrismaStub();
    const res = await resolveTemplateIdForEvidence(
      "evidence-1",
      prisma as never,
    );
    expect(res).toEqual({ templateId: null, source: "none" });
    expect(prisma.evidenceWorkflowInstanceEvidence.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { evidenceId: "evidence-1" } }),
    );
    expect(prisma.workflowIntakeSession.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { evidenceId: "evidence-1" } }),
    );
  });

  it("prefers workflow_instance over intake_link when both exist", async () => {
    const prisma = makePrismaStub({
      evidenceWorkflowInstanceEvidence: {
        findFirst: vi.fn().mockResolvedValue({
          id: "link-1",
          instance: { templateId: "tpl-from-instance" },
        }),
      },
      workflowIntakeSession: {
        findUnique: vi.fn().mockResolvedValue({
          intakeLink: { workflowTemplateId: "tpl-from-intake" },
        }),
      },
    });
    const res = await resolveTemplateIdForEvidence(
      "evidence-2",
      prisma as never,
    );
    expect(res).toEqual({
      templateId: "tpl-from-instance",
      source: "workflow_instance",
    });
    // Intake session must NOT have been consulted because instance
    // path already produced a UUID.
    expect(prisma.workflowIntakeSession.findUnique).not.toHaveBeenCalled();
  });

  it("falls through to intake_link when instance link has no templateId", async () => {
    const prisma = makePrismaStub({
      evidenceWorkflowInstanceEvidence: {
        // Mapping row exists but the instance has no template binding.
        findFirst: vi.fn().mockResolvedValue({
          id: "link-2",
          instance: { templateId: null },
        }),
      },
      workflowIntakeSession: {
        findUnique: vi.fn().mockResolvedValue({
          intakeLink: { workflowTemplateId: "tpl-from-intake" },
        }),
      },
    });
    const res = await resolveTemplateIdForEvidence(
      "evidence-3",
      prisma as never,
    );
    expect(res).toEqual({
      templateId: "tpl-from-intake",
      source: "intake_link",
    });
  });

  it("returns source:'error' and never throws when the instance join throws", async () => {
    const prisma = makePrismaStub({
      evidenceWorkflowInstanceEvidence: {
        findFirst: vi
          .fn()
          .mockRejectedValue(new Error("simulated db connection drop")),
      },
    });
    const res = await resolveTemplateIdForEvidence(
      "evidence-4",
      prisma as never,
    );
    expect(res).toEqual({ templateId: null, source: "error" });
    // Intake path must NOT be attempted after an instance-side failure;
    // the resolver short-circuits to "error" so the caller can fall back
    // to baseline deterministically.
    expect(prisma.workflowIntakeSession.findUnique).not.toHaveBeenCalled();
  });

  it("returns source:'error' when the intake-session join throws", async () => {
    const prisma = makePrismaStub({
      workflowIntakeSession: {
        findUnique: vi
          .fn()
          .mockRejectedValue(new Error("simulated db connection drop")),
      },
    });
    const res = await resolveTemplateIdForEvidence(
      "evidence-5",
      prisma as never,
    );
    expect(res).toEqual({ templateId: null, source: "error" });
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveSlaPolicy — end-to-end with a templateId.
//
// The shared resolver (`resolveReviewerOpsSlaPolicy`) is already covered
// by the Phase 25.5 hardening tests; here we pin the SERVICE-layer
// contract: when a templateId is passed AND the template row has a
// well-formed `reviewPolicyJson.sla`, those values override the baseline.
// ---------------------------------------------------------------------------

describe("resolveEffectiveSlaPolicy — template override branch", () => {
  it("baseline holds when templateId is omitted (pre-Phase-R behaviour)", async () => {
    const prisma = makePrismaStub();
    const { policy, sources } = await resolveEffectiveSlaPolicy(
      { teamId: "team-1" },
      prisma as never,
    );
    expect(policy.completionHours).toBe(
      REVIEWER_OPS_DEFAULT_SLA_POLICY.completionHours,
    );
    expect(sources.template).toEqual({});
    expect(sources.workspace).toEqual({});
    // The template row must NOT be read when templateId is null/undefined.
    expect(prisma.evidenceWorkflowTemplate.findUnique).not.toHaveBeenCalled();
  });

  it("template SLA wins when reviewPolicyJson.sla is present and well-formed", async () => {
    const prisma = makePrismaStub({
      evidenceWorkflowTemplate: {
        findUnique: vi.fn().mockResolvedValue({
          reviewPolicyJson: {
            sla: {
              completionHours: 12,
              firstReviewHours: 6,
            },
          },
        }),
      },
    });
    const { policy, sources } = await resolveEffectiveSlaPolicy(
      { teamId: "team-1", templateId: "tpl-1" },
      prisma as never,
    );
    expect(policy.completionHours).toBe(12);
    expect(policy.firstReviewHours).toBe(6);
    // Fields not in the override fall back to the baseline.
    expect(policy.escalationHours).toBe(
      REVIEWER_OPS_DEFAULT_SLA_POLICY.escalationHours,
    );
    expect(sources.template).toEqual({
      completionHours: 12,
      firstReviewHours: 6,
    });
  });

  it("baseline holds when reviewPolicyJson lacks an sla sub-key", async () => {
    const prisma = makePrismaStub({
      evidenceWorkflowTemplate: {
        findUnique: vi.fn().mockResolvedValue({
          reviewPolicyJson: { requireReview: true, defaultPriority: "HIGH" },
        }),
      },
    });
    const { policy, sources } = await resolveEffectiveSlaPolicy(
      { teamId: "team-1", templateId: "tpl-2" },
      prisma as never,
    );
    expect(policy.completionHours).toBe(
      REVIEWER_OPS_DEFAULT_SLA_POLICY.completionHours,
    );
    expect(sources.template).toEqual({});
  });

  it("baseline holds when reviewPolicyJson.sla is structurally invalid (fail-open)", async () => {
    const prisma = makePrismaStub({
      evidenceWorkflowTemplate: {
        findUnique: vi.fn().mockResolvedValue({
          reviewPolicyJson: {
            sla: {
              // Out-of-bounds: schema clamps to [1, 720]. The ReviewerOps
              // SLA schema is .strict() so an over-bound value fails parse.
              completionHours: 99999,
            },
          },
        }),
      },
    });
    const { policy, sources } = await resolveEffectiveSlaPolicy(
      { teamId: "team-1", templateId: "tpl-3" },
      prisma as never,
    );
    expect(policy.completionHours).toBe(
      REVIEWER_OPS_DEFAULT_SLA_POLICY.completionHours,
    );
    expect(sources.template).toEqual({});
  });

  it("workspace override wins for keys the template does not set (existing precedence preserved)", async () => {
    const prisma = makePrismaStub({
      evidenceWorkflowTemplate: {
        findUnique: vi.fn().mockResolvedValue({
          reviewPolicyJson: { sla: { completionHours: 12 } },
        }),
      },
      workspaceGovernancePolicy: {
        findUnique: vi.fn().mockResolvedValue({
          defaultAssignmentDueHours: null,
          defaultFirstResponseDueHours: 3,
          defaultCompletionDueHours: 48,
          defaultEscalationDueHours: 24,
          defaultDueSoonHours: null,
        }),
      },
    });
    const { policy, sources } = await resolveEffectiveSlaPolicy(
      { teamId: "team-1", templateId: "tpl-4" },
      prisma as never,
    );
    // Template SLA wins for completionHours.
    expect(policy.completionHours).toBe(12);
    // Workspace wins for firstReviewHours + escalationHours (template
    // did not set them).
    expect(policy.firstReviewHours).toBe(3);
    expect(policy.escalationHours).toBe(24);
    expect(sources.template.completionHours).toBe(12);
    expect(sources.workspace.firstReviewHours).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Source-label derivation — what the assignment audit row will carry.
//
// The audit emit site picks a label from sources.{template,workspace} so
// operators can trace which precedence layer set the SLA. We pin the
// derivation logic here so the test file does not need to spin up the
// full assignment pipeline.
// ---------------------------------------------------------------------------

function deriveSourceLabel(sources: {
  template: Record<string, unknown>;
  workspace: Record<string, unknown>;
}): "template_override" | "team_default" | "platform_baseline" {
  if (Object.keys(sources.template).length > 0) return "template_override";
  if (Object.keys(sources.workspace).length > 0) return "team_default";
  return "platform_baseline";
}

describe("SLA precedence source label (assignment audit metadata)", () => {
  it("'template_override' when a template field contributed", () => {
    expect(
      deriveSourceLabel({
        template: { completionHours: 12 },
        workspace: { firstReviewHours: 3 },
      }),
    ).toBe("template_override");
  });

  it("'team_default' when only the workspace contributed", () => {
    expect(
      deriveSourceLabel({
        template: {},
        workspace: { completionHours: 48 },
      }),
    ).toBe("team_default");
  });

  it("'platform_baseline' when neither template nor workspace contributed", () => {
    expect(
      deriveSourceLabel({ template: {}, workspace: {} }),
    ).toBe("platform_baseline");
  });

  it("matches the shared resolver's behaviour for the canonical override case", () => {
    const policy = resolveReviewerOpsSlaPolicy({
      templateOverride: { completionHours: 12 },
      workspaceOverride: { firstReviewHours: 3 },
      envDefaults: {},
    });
    expect(policy.completionHours).toBe(12);
    expect(policy.firstReviewHours).toBe(3);
    expect(policy.escalationHours).toBe(
      REVIEWER_OPS_DEFAULT_SLA_POLICY.escalationHours,
    );
  });
});

// ---------------------------------------------------------------------------
// Source-text contract — pin the wiring at the call site so future
// refactors do not silently drop the templateId pass-through.
// ---------------------------------------------------------------------------

describe("reviewer-operations-engine.service.ts — Phase R wiring source check", () => {
  // We import the source as text for the same reason
  // phase25_5-reviewer-ops-hardening.test.ts does: it pins the wiring
  // independent of execution coverage.
  const src = readFileSync(
    join(
      __dirname,
      "..",
      "src",
      "services",
      "reviewer-ops",
      "reviewer-operations-engine.service.ts",
    ),
    "utf8",
  );

  it("exports resolveTemplateIdForEvidence with the two-path implementation", () => {
    expect(src).toMatch(/export\s+async\s+function\s+resolveTemplateIdForEvidence/);
    expect(src).toMatch(/evidenceWorkflowInstanceEvidence\.findFirst/);
    expect(src).toMatch(/workflowIntakeSession\.findUnique/);
  });

  it("the assignment site passes a resolved templateId into resolveEffectiveSlaPolicy", () => {
    // The call to resolveEffectiveSlaPolicy must include a templateId
    // field; pre-Phase-R it was `{ teamId: ctx.teamId }` only.
    expect(src).toMatch(
      /resolveEffectiveSlaPolicy\([\s\S]*?templateId:\s*templateResolution\.templateId/,
    );
  });

  it("the assignment site emits a reviewer.sla_policy.resolve audit row with a source label", () => {
    expect(src).toMatch(/action:\s*"reviewer\.sla_policy\.resolve"/);
    expect(src).toMatch(/templateResolutionSource:\s*templateResolution\.source/);
    expect(src).toMatch(/source:\s*sourceLabel/);
  });

  it("the template-resolution call is wrapped in try/catch so it cannot break assignment", () => {
    // Look for the inline call followed by a catch; we don't try to
    // match the body exactly, just that defensive bracketing is present
    // around resolveTemplateIdForEvidence.
    expect(src).toMatch(
      /try\s*{[\s\S]*?resolveTemplateIdForEvidence\([\s\S]*?}\s*catch/,
    );
  });

  it("the resolveEffectiveSlaPolicy call is wrapped in try/catch with a baseline fallback", () => {
    expect(src).toMatch(
      /try\s*{[\s\S]*?resolveEffectiveSlaPolicy\([\s\S]*?}\s*catch[\s\S]*?REVIEWER_OPS_DEFAULT_SLA_POLICY/,
    );
  });
});
