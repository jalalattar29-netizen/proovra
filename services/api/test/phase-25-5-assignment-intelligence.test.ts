/**
 * Phase 25.5 — Reviewer Assignment Intelligence engine tests.
 *
 * Pure behavioural tests against the @proovra/shared eligibility +
 * ranking + balance engines. The engines are deterministic so we can
 * test them end-to-end without Prisma/Fastify/I/O.
 *
 * Coverage targets:
 *   - Eligibility refuses ineligible reviewers (cross-workspace,
 *     missing permission, reviewer-restricted, contributor-private,
 *     legal-hold conflict, escalation-owner conflict, terminal
 *     workflow, self-assignment, inactivity > 30d).
 *   - Ineligibility reasons are bounded vocabulary — no evidence-side
 *     details leak.
 *   - Ranker NEVER ranks ineligible reviewers.
 *   - Workload balancing influences score but never overrides a
 *     governance refusal (eligibility gate comes first).
 *   - Risk flags fire on overloaded / overdue / escalation-pressure
 *     / burst / imbalance / inactivity-warning.
 *   - Score is bounded to [0, SCORE_MAX] and deterministic.
 *   - Reasons sorted by delta descending (UI top-N rendering).
 *   - `evaluateTeamBalance` correctly counts overloaded / starved /
 *     inactive / imbalanced.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ASSIGNMENT_INELIGIBILITY_CODES,
  ASSIGNMENT_RANK_REASON_CODES,
  ASSIGNMENT_RISK_FLAG_CODES,
  evaluateReviewerEligibility,
  evaluateTeamBalance,
  rankReviewerSuggestions,
  type AssignmentIneligibilityCode,
  type ReviewerCandidate,
  type WorkflowAssignmentFacts,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// Test fixtures — bounded, deterministic
// =============================================================================

const NOW = Date.parse("2026-05-19T12:00:00Z");

const baseFacts: WorkflowAssignmentFacts = {
  nowEpochMs: NOW,
  workflowId: "11111111-1111-1111-1111-111111111111",
  teamId: "team-a",
  status: "IN_REVIEW",
  hasActiveLegalHold: false,
  reviewerRestricted: false,
  contributorPrivate: false,
  actorUserId: "actor-1",
  currentReviewerUserId: null,
  requiredCaseTeamId: null,
  escalationOwnerUserId: null,
};

const baseCandidate: ReviewerCandidate = {
  reviewerId: "reviewer-1",
  workspaceTeamId: "team-a",
  role: "REVIEWER",
  permissions: {
    canAssignReviewer: true,
    canSeeReviewerRestricted: true,
    canSeeContributorPrivate: true,
    canActOnLegalHold: true,
  },
  isCaseTeamMember: false,
  expertiseTags: [],
  workload: {
    activeReviews: 3,
    overdueReviews: 0,
    dueSoonReviews: 0,
    escalatedReviews: 0,
    recentCompleted: 4,
    pressure: "balanced",
    lastActivityAtEpochMs: NOW - 2 * 24 * 60 * 60 * 1000,
    recentAssignmentBurstCount: 0,
  },
};

// =============================================================================
// PART 1 — Eligibility engine
// =============================================================================

describe("Phase 25.5 — reviewer eligibility engine", () => {
  it("a baseline-eligible reviewer passes", () => {
    const r = evaluateReviewerEligibility(baseFacts, baseCandidate);
    expect(r.eligible).toBe(true);
    expect(r.reasons.length).toBe(0);
  });

  it("refuses cross-workspace reviewers (anti-leak: workspace scope)", () => {
    const r = evaluateReviewerEligibility(baseFacts, {
      ...baseCandidate,
      workspaceTeamId: "team-b",
    });
    expect(r.eligible).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain("outside_workspace_scope");
  });

  it("refuses reviewers lacking canAssignReviewer permission", () => {
    const r = evaluateReviewerEligibility(baseFacts, {
      ...baseCandidate,
      permissions: { ...baseCandidate.permissions, canAssignReviewer: false },
    });
    expect(r.eligible).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain("missing_assign_permission");
  });

  it("refuses reviewer-restricted workflows when the candidate lacks visibility", () => {
    const r = evaluateReviewerEligibility(
      { ...baseFacts, reviewerRestricted: true },
      {
        ...baseCandidate,
        permissions: {
          ...baseCandidate.permissions,
          canSeeReviewerRestricted: false,
        },
      },
    );
    expect(r.eligible).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain(
      "reviewer_restricted_blocked",
    );
  });

  it("refuses contributor-private workflows when the candidate lacks visibility", () => {
    const r = evaluateReviewerEligibility(
      { ...baseFacts, contributorPrivate: true },
      {
        ...baseCandidate,
        permissions: {
          ...baseCandidate.permissions,
          canSeeContributorPrivate: false,
        },
      },
    );
    expect(r.eligible).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain(
      "contributor_private_blocked",
    );
  });

  it("refuses legal-hold workflows when the candidate lacks hold permission", () => {
    const r = evaluateReviewerEligibility(
      { ...baseFacts, hasActiveLegalHold: true },
      {
        ...baseCandidate,
        permissions: {
          ...baseCandidate.permissions,
          canActOnLegalHold: false,
        },
      },
    );
    expect(r.eligible).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain("legal_hold_owner_conflict");
  });

  it("refuses non-reviewer roles (reviewer scope)", () => {
    const r = evaluateReviewerEligibility(baseFacts, {
      ...baseCandidate,
      role: "CONTRIBUTOR",
    });
    expect(r.eligible).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain("reviewer_scope_blocked");
  });

  it("refuses terminal workflow states (COMPLETED / CANCELLED / REJECTED)", () => {
    for (const state of ["COMPLETED", "CANCELLED", "REJECTED"]) {
      const r = evaluateReviewerEligibility(
        { ...baseFacts, status: state },
        baseCandidate,
      );
      expect(r.eligible).toBe(false);
      expect(r.reasons.map((x) => x.code)).toContain("workflow_state_terminal");
    }
  });

  it("refuses everyone except the named escalation owner", () => {
    const escalationOwner = "owner-1";
    const ownerCandidate = {
      ...baseCandidate,
      reviewerId: escalationOwner,
    };
    const otherCandidate = {
      ...baseCandidate,
      reviewerId: "other-reviewer",
    };
    const facts = {
      ...baseFacts,
      escalationOwnerUserId: escalationOwner,
    };
    expect(evaluateReviewerEligibility(facts, ownerCandidate).eligible).toBe(
      true,
    );
    const otherResult = evaluateReviewerEligibility(facts, otherCandidate);
    expect(otherResult.eligible).toBe(false);
    expect(otherResult.reasons.map((x) => x.code)).toContain(
      "escalation_owner_conflict",
    );
  });

  it("refuses self-assignment by the actor", () => {
    const r = evaluateReviewerEligibility(
      { ...baseFacts, actorUserId: "actor-1" },
      { ...baseCandidate, reviewerId: "actor-1" },
    );
    expect(r.eligible).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain(
      "reviewer_self_assignment_blocked",
    );
  });

  it("refuses inactive reviewers (no activity in 30+ days)", () => {
    const r = evaluateReviewerEligibility(baseFacts, {
      ...baseCandidate,
      workload: {
        ...baseCandidate.workload,
        lastActivityAtEpochMs: NOW - 31 * 24 * 60 * 60 * 1000,
      },
    });
    expect(r.eligible).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain("reviewer_inactive");
  });

  it("refuses when a case-team membership is required but the candidate is not in it", () => {
    const r = evaluateReviewerEligibility(
      { ...baseFacts, requiredCaseTeamId: "case-team-x" },
      { ...baseCandidate, isCaseTeamMember: false },
    );
    expect(r.eligible).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain("reviewer_scope_blocked");
  });

  it("ineligibility reasons are entirely from the bounded catalog (no free-text leak)", () => {
    const facts: WorkflowAssignmentFacts = {
      ...baseFacts,
      reviewerRestricted: true,
      contributorPrivate: true,
      hasActiveLegalHold: true,
      status: "COMPLETED",
      escalationOwnerUserId: "someone-else",
      requiredCaseTeamId: "case-team-z",
    };
    const candidate: ReviewerCandidate = {
      ...baseCandidate,
      workspaceTeamId: "team-other",
      role: "CONTRIBUTOR",
      permissions: {
        canAssignReviewer: false,
        canSeeReviewerRestricted: false,
        canSeeContributorPrivate: false,
        canActOnLegalHold: false,
      },
      isCaseTeamMember: false,
      workload: {
        ...baseCandidate.workload,
        lastActivityAtEpochMs: NOW - 100 * 24 * 60 * 60 * 1000,
      },
    };
    const r = evaluateReviewerEligibility(facts, candidate);
    expect(r.eligible).toBe(false);
    for (const reason of r.reasons) {
      expect(ASSIGNMENT_INELIGIBILITY_CODES).toContain(reason.code);
      // Labels must not contain workflow ID, evidence ID, or other
      // record-identifying details.
      expect(reason.label).not.toContain(facts.workflowId);
      expect(reason.label).not.toContain(facts.teamId);
    }
  });
});

// =============================================================================
// PART 2 — Ranker
// =============================================================================

describe("Phase 25.5 — reviewer suggestion ranker", () => {
  it("ranks an eligible reviewer + emits at least one ranking reason", () => {
    const { ranked, ineligible } = rankReviewerSuggestions(baseFacts, [
      baseCandidate,
    ]);
    expect(ranked.length).toBe(1);
    expect(ineligible.length).toBe(0);
    expect(ranked[0]!.reviewerId).toBe("reviewer-1");
    expect(ranked[0]!.reasons.length).toBeGreaterThan(0);
  });

  it("NEVER ranks ineligible reviewers — they appear in `ineligible` instead", () => {
    const eligibleA: ReviewerCandidate = {
      ...baseCandidate,
      reviewerId: "rev-A",
    };
    const ineligibleB: ReviewerCandidate = {
      ...baseCandidate,
      reviewerId: "rev-B",
      workspaceTeamId: "team-other-workspace",
    };
    const { ranked, ineligible } = rankReviewerSuggestions(baseFacts, [
      eligibleA,
      ineligibleB,
    ]);
    expect(ranked.map((r) => r.reviewerId)).toEqual(["rev-A"]);
    expect(ineligible.map((r) => r.reviewerId)).toEqual(["rev-B"]);
    expect(ineligible[0]!.reasons[0]!.code).toBe("outside_workspace_scope");
  });

  it("ranked order is descending by score (UI gets the right top-N)", () => {
    const high: ReviewerCandidate = {
      ...baseCandidate,
      reviewerId: "rev-high",
      workload: {
        ...baseCandidate.workload,
        pressure: "available",
        recentCompleted: 15,
      },
    };
    const low: ReviewerCandidate = {
      ...baseCandidate,
      reviewerId: "rev-low",
      workload: {
        ...baseCandidate.workload,
        pressure: "balanced",
        recentCompleted: 0,
      },
    };
    const { ranked } = rankReviewerSuggestions(baseFacts, [low, high]);
    expect(ranked[0]!.reviewerId).toBe("rev-high");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("is deterministic — same inputs produce same output", () => {
    const a = rankReviewerSuggestions(baseFacts, [baseCandidate]);
    const b = rankReviewerSuggestions(baseFacts, [baseCandidate]);
    expect(a.ranked[0]!.score).toBe(b.ranked[0]!.score);
    expect(a.ranked[0]!.recommendationBand).toBe(b.ranked[0]!.recommendationBand);
  });

  it("score is bounded to [0, 1000]", () => {
    const everything: ReviewerCandidate = {
      ...baseCandidate,
      isCaseTeamMember: true,
      expertiseTags: ["evidence", "fraud", "forensics"],
      workload: {
        ...baseCandidate.workload,
        pressure: "available",
        recentCompleted: 20,
        lastActivityAtEpochMs: NOW - 1 * 60 * 60 * 1000,
      },
    };
    const r = rankReviewerSuggestions(
      { ...baseFacts, requiredCaseTeamId: "case-x" },
      [everything],
    );
    expect(r.ranked[0]!.score).toBeLessThanOrEqual(1000);
    expect(r.ranked[0]!.score).toBeGreaterThanOrEqual(0);
  });

  it("reasons + risk flags belong to the bounded catalogs", () => {
    const overloaded: ReviewerCandidate = {
      ...baseCandidate,
      reviewerId: "rev-over",
      workload: {
        activeReviews: 12,
        overdueReviews: 5,
        dueSoonReviews: 2,
        escalatedReviews: 3,
        recentCompleted: 8,
        pressure: "overloaded",
        lastActivityAtEpochMs: NOW - 20 * 24 * 60 * 60 * 1000,
        recentAssignmentBurstCount: 7,
      },
    };
    const { ranked } = rankReviewerSuggestions(baseFacts, [overloaded]);
    expect(ranked.length).toBe(1);
    for (const reason of ranked[0]!.reasons) {
      expect(ASSIGNMENT_RANK_REASON_CODES).toContain(reason.code);
    }
    for (const flag of ranked[0]!.riskFlags) {
      expect(ASSIGNMENT_RISK_FLAG_CODES).toContain(flag.code);
    }
  });

  it("workload balancing influences score but NEVER bypasses governance — ineligible reviewers stay ineligible", () => {
    // An "ideal capacity" reviewer who is OUTSIDE the workspace must
    // NOT appear in ranked results no matter how attractive their
    // workload signals are.
    const idealButCrossWorkspace: ReviewerCandidate = {
      ...baseCandidate,
      reviewerId: "rev-cross",
      workspaceTeamId: "team-other",
      workload: {
        ...baseCandidate.workload,
        pressure: "available",
        recentCompleted: 20,
      },
    };
    const { ranked, ineligible } = rankReviewerSuggestions(baseFacts, [
      idealButCrossWorkspace,
    ]);
    expect(ranked.length).toBe(0);
    expect(ineligible.length).toBe(1);
  });

  it("overloaded reviewers receive a HIGH-severity risk flag", () => {
    const overloaded: ReviewerCandidate = {
      ...baseCandidate,
      workload: {
        ...baseCandidate.workload,
        pressure: "overloaded",
      },
    };
    const { ranked } = rankReviewerSuggestions(baseFacts, [overloaded]);
    const overloadFlag = ranked[0]!.riskFlags.find(
      (f) => f.code === "reviewer_overloaded",
    );
    expect(overloadFlag).toBeDefined();
    expect(overloadFlag!.severity).toBe("HIGH");
  });

  it("recommendation band scales monotonically with reviewer quality", () => {
    const ideal: ReviewerCandidate = {
      ...baseCandidate,
      reviewerId: "rev-ideal",
      isCaseTeamMember: true,
      expertiseTags: ["x"],
      workload: {
        ...baseCandidate.workload,
        pressure: "available",
        recentCompleted: 15,
        lastActivityAtEpochMs: NOW - 1 * 60 * 60 * 1000,
      },
    };
    const minimal: ReviewerCandidate = {
      ...baseCandidate,
      reviewerId: "rev-minimal",
      isCaseTeamMember: false,
      expertiseTags: [],
      workload: {
        ...baseCandidate.workload,
        pressure: "balanced",
        recentCompleted: 0,
        lastActivityAtEpochMs: NOW - 12 * 24 * 60 * 60 * 1000,
      },
    };
    // No required case-team — both candidates must clear eligibility
    // so we can compare ranked output. The case-team bump still
    // applies because the ideal candidate is a case-team member.
    const { ranked } = rankReviewerSuggestions(baseFacts, [minimal, ideal]);
    // Both eligible, both ranked; the ideal candidate's band must be
    // at least as strong as the minimal candidate's, and the score
    // must be higher.
    const bandOrder: Record<string, number> = {
      NOT_RECOMMENDED: 0,
      LAST_RESORT: 1,
      ACCEPTABLE: 2,
      RECOMMENDED: 3,
    };
    const idealResult = ranked.find((r) => r.reviewerId === "rev-ideal")!;
    const minimalResult = ranked.find((r) => r.reviewerId === "rev-minimal")!;
    expect(idealResult.score).toBeGreaterThan(minimalResult.score);
    expect(bandOrder[idealResult.recommendationBand]).toBeGreaterThanOrEqual(
      bandOrder[minimalResult.recommendationBand]!,
    );
    // The ideal candidate clears ACCEPTABLE.
    expect(bandOrder[idealResult.recommendationBand]).toBeGreaterThanOrEqual(
      bandOrder.ACCEPTABLE!,
    );
  });

  it("reasons are sorted by delta descending (UI top-N rendering)", () => {
    const { ranked } = rankReviewerSuggestions(baseFacts, [
      {
        ...baseCandidate,
        workload: {
          ...baseCandidate.workload,
          pressure: "available",
          recentCompleted: 15,
        },
      },
    ]);
    for (let i = 1; i < ranked[0]!.reasons.length; i++) {
      expect(ranked[0]!.reasons[i]!.delta).toBeLessThanOrEqual(
        ranked[0]!.reasons[i - 1]!.delta,
      );
    }
  });

  it("imbalance risk flag fires when this reviewer is carrying > 1.5× team mean", () => {
    const heavy: ReviewerCandidate = {
      ...baseCandidate,
      reviewerId: "rev-heavy",
      workload: {
        ...baseCandidate.workload,
        activeReviews: 20,
      },
    };
    const light: ReviewerCandidate = {
      ...baseCandidate,
      reviewerId: "rev-light",
      workload: {
        ...baseCandidate.workload,
        activeReviews: 2,
      },
    };
    const { ranked } = rankReviewerSuggestions(baseFacts, [heavy, light]);
    const heavyResult = ranked.find((r) => r.reviewerId === "rev-heavy");
    expect(heavyResult).toBeDefined();
    expect(
      heavyResult!.riskFlags.some((f) => f.code === "workload_imbalance"),
    ).toBe(true);
  });
});

// =============================================================================
// PART 3 — Team balance detector
// =============================================================================

describe("Phase 25.5 — team balance evaluator", () => {
  function reviewer(
    id: string,
    activeReviews: number,
    pressure: ReviewerCandidate["workload"]["pressure"],
    lastActivityDaysAgo: number,
  ): ReviewerCandidate {
    return {
      ...baseCandidate,
      reviewerId: id,
      workload: {
        ...baseCandidate.workload,
        activeReviews,
        pressure,
        lastActivityAtEpochMs:
          Date.now() - lastActivityDaysAgo * 24 * 60 * 60 * 1000,
      },
    };
  }

  it("counts overloaded reviewers", () => {
    const r = evaluateTeamBalance({
      reviewers: [
        reviewer("a", 8, "overloaded", 1),
        reviewer("b", 9, "overloaded", 1),
        reviewer("c", 2, "balanced", 1),
      ],
    });
    expect(r.overloadedCount).toBe(2);
  });

  it("counts starved (zero active) reviewers", () => {
    const r = evaluateTeamBalance({
      reviewers: [
        reviewer("a", 0, "available", 1),
        reviewer("b", 0, "available", 1),
        reviewer("c", 4, "balanced", 1),
      ],
    });
    expect(r.starvedCount).toBe(2);
  });

  it("counts inactive (30+ days) reviewers", () => {
    const r = evaluateTeamBalance({
      reviewers: [
        reviewer("a", 4, "balanced", 35),
        reviewer("b", 2, "balanced", 1),
      ],
    });
    expect(r.inactiveCount).toBe(1);
  });

  it("flags imbalance when stdev > 0.5×mean AND mean ≥ 4", () => {
    const r = evaluateTeamBalance({
      reviewers: [
        reviewer("a", 20, "overloaded", 1),
        reviewer("b", 1, "available", 1),
        reviewer("c", 1, "available", 1),
        reviewer("d", 1, "available", 1),
      ],
    });
    expect(r.imbalanced).toBe(true);
    expect(r.topActiveReviewerCount).toBe(20);
  });

  it("does NOT flag imbalance when the team is small (mean < 4)", () => {
    const r = evaluateTeamBalance({
      reviewers: [
        reviewer("a", 1, "available", 1),
        reviewer("b", 5, "balanced", 1),
      ],
    });
    expect(r.imbalanced).toBe(false);
  });
});

// =============================================================================
// PART 4 — Source contract + privacy invariants
// =============================================================================

describe("Phase 25.5 — source contract + privacy invariants", () => {
  const src = readSource(
    "../../../packages/shared/src/reviewer-assignment.ts",
  );

  it("the engine is pure (no Prisma / Node / Fastify imports)", () => {
    expect(src).not.toMatch(/from\s+"@prisma\/client"/);
    expect(src).not.toMatch(/from\s+"fastify"/);
    expect(src).not.toMatch(/from\s+"node:/);
  });

  it("documents the privacy invariants in the file header", () => {
    expect(src).toMatch(/never recommends a reviewer who lacks the canonical assign/i);
    expect(src).toMatch(/outside the workspace/i);
    expect(src).toMatch(/never leaks evidence details/i);
    expect(src).toMatch(/governance-first/i);
  });

  it("ineligibility reason labels never contain forbidden wording", () => {
    const banned =
      /\btamper(ed|ing)?\b|\bforged\b|\bforgery\b|\baltered content\b|\bmanipulated evidence\b/i;
    const stringLiterals = src.match(/"[^"\n]+"/g) ?? [];
    expect(stringLiterals.join(" ")).not.toMatch(banned);
  });

  it("eligibility evaluator never reads evidence-side fields (no `evidenceId`, `caseId` traversal)", () => {
    // The pure engine accepts a bounded `WorkflowAssignmentFacts` shape
    // and a bounded `ReviewerCandidate` shape. Neither has evidence-
    // text / preview / hash / signature fields. Assert the source
    // doesn't reference any of the forbidden columns.
    expect(src).not.toMatch(/\bprivateReviewerNote\b/);
    expect(src).not.toMatch(/\blegalNoteBody\b/);
    expect(src).not.toMatch(/\bstorageKey\b/);
    expect(src).not.toMatch(/\bsigned_url\b|\bsignedUrl\b/);
    expect(src).not.toMatch(/\braw_gps\b|\bgpsCoordinates\b/);
  });

  it("the bounded reason / risk catalogs are exported (test surface for downstream consumers)", () => {
    expect(ASSIGNMENT_INELIGIBILITY_CODES.length).toBeGreaterThan(0);
    expect(ASSIGNMENT_RANK_REASON_CODES.length).toBeGreaterThan(0);
    expect(ASSIGNMENT_RISK_FLAG_CODES.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// PART 5 — Metric catalogue (Phase 25.5 additions)
// =============================================================================

describe("Phase 25.5 — metric catalogue", () => {
  const src = readSource(
    "../../../services/api/src/services/ops/metrics.service.ts",
  );

  it("registers every Phase 25.5 reviewer + assignment counter", () => {
    for (const m of [
      "reviewer_assignment_rank_computed_total",
      "reviewer_assignment_auto_blocked_total",
      "reviewer_assignment_overload_detected_total",
      "reviewer_assignment_imbalance_total",
      "reviewer_assignment_applied_total",
      "reviewer_reassignment_total",
      "reviewer_queue_pressure_total",
      "reviewer_stuck_workflow_escalated_total",
      "reviewer_escalation_reopened_total",
      "reviewer_operational_incident_created_total",
    ]) {
      expect(src, `metric ${m} not registered`).toContain(`"${m}"`);
    }
  });
});

// =============================================================================
// PART 6 — Cross-engine invariant — pure modules
// =============================================================================

describe("Phase 25.5 — cross-engine invariants", () => {
  const ENGINE_FILES = [
    "../../../packages/shared/src/reviewer-assignment.ts",
    "../../../packages/shared/src/reviewer-priority.ts",
    "../../../packages/shared/src/stuck-workflow-detector.ts",
    "../../../packages/shared/src/search-projection.ts",
  ];

  it("every engine is browser-safe (no Prisma / Node / Fastify imports)", () => {
    for (const rel of ENGINE_FILES) {
      const src = readSource(rel);
      expect(src).not.toMatch(/from\s+"@prisma\/client"/);
      expect(src).not.toMatch(/from\s+"fastify"/);
      expect(src).not.toMatch(/from\s+"node:/);
    }
  });

  it("no engine fabricates operational counters", () => {
    for (const rel of ENGINE_FILES) {
      const src = readSource(rel);
      expect(src).not.toMatch(/escalations:\s*\d+,/);
      expect(src).not.toMatch(/incidents:\s*\d+,/);
      expect(src).not.toMatch(/overdue:\s*\d+,/);
    }
  });
});

// Avoid unused-import lint noise on the type-only imports.
type _AssignmentIneligibilityCheck = AssignmentIneligibilityCode;
