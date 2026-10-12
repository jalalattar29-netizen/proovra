/**
 * GOVERNANCE POLICY EVALUATION FAILS CLOSED.
 *
 * "No configured policy" and "could not load policy" used to be the same
 * answer: `loadEffective` caught every read failure and returned `[]`, which
 * every evaluator turned into ALLOW — so a configured BLOCK policy
 * (requireMfa, requireSaml, blockedPublicExposure, disallowedProviders …)
 * stopped applying the moment its read failed.
 *
 * Pinned here, per kind, against the real evaluators and gates with a stubbed
 * client:
 *   - a REJECTING policy read rejects with PolicyEvaluationUnavailableError
 *     (code GOVERNANCE_CHECK_FAILED, bounded `<kind>_policy_unavailable`);
 *   - an EMPTY read (`[]`) is a real "nothing configured" and still ALLOWs;
 *   - a configured `requireLegalHoldCheck` whose legal-hold read fails is
 *     refused, not evaluated as "no hold".
 */
import { describe, expect, it } from "vitest";

import {
  PolicyEvaluationUnavailableError,
  evaluateIntelligencePolicy,
  evaluateRedactionPolicy,
  evaluateRetentionPolicy,
  evaluateReviewPolicy,
  evaluateSecurityPolicy,
  evaluateVerificationPolicy,
  isPolicyEvaluationUnavailable,
} from "../src/services/governance/policy-evaluation.service.js";
import {
  gateRetentionAction,
  gateReviewDecision,
  gateSecurityAction,
  gateVerificationAction,
} from "../src/services/governance/policy-runtime-gates.service.js";

function assignment(kind: string, rule: Record<string, unknown>, enforcementMode = "BLOCK") {
  return {
    scope: "WORKSPACE",
    scopeTargetId: "team-1",
    isOverride: false,
    policy: {
      id: "p-1",
      kind,
      slug: "rule-1",
      name: "rule-1",
      summary: "",
      state: "ACTIVE",
      enforcementMode,
      rule,
      version: 1,
      createdByUserId: "u",
      createdAt: new Date(),
    },
  };
}

type StubOpts = {
  findMany?: () => Promise<unknown>;
  legalHoldCount?: () => Promise<number>;
};

function stub(opts: StubOpts = {}) {
  const audits: string[] = [];
  const prisma = {
    governancePolicyAssignment: {
      findMany: opts.findMany ?? (async () => []),
    },
    governancePolicyAudit: {
      create: async (args: { data: { code: string } }) => {
        audits.push(args.data.code);
        return { id: "audit-1" };
      },
    },
    evidence: { findFirst: async () => ({ createdAt: new Date() }) },
    evidenceLegalHold: { count: opts.legalHoldCount ?? (async () => 0) },
    qcSample: { findFirst: async () => null },
    workflowReviewDecision: { findMany: async () => [] },
    mediaIntelligenceRecord: { findFirst: async () => null },
    trustCenterArticle: { count: async () => 1 },
  } as never;
  return { prisma, audits };
}

const READ_FAILS = async () => {
  throw new Error("connection terminated unexpectedly");
};

const KINDS = [
  {
    kind: "SECURITY",
    run: (prisma: never) =>
      evaluateSecurityPolicy({ prisma, teamId: "team-1", userId: "u-1", action: "session_authenticate" }),
  },
  {
    kind: "RETENTION",
    run: (prisma: never) =>
      evaluateRetentionPolicy({ prisma, teamId: "team-1", evidenceId: "ev-1", action: "DELETE" }),
  },
  {
    kind: "REVIEW",
    run: (prisma: never) =>
      evaluateReviewPolicy({ prisma, teamId: "team-1", workflowId: "wf-1", decision: "APPROVE" }),
  },
  {
    kind: "INTELLIGENCE",
    run: (prisma: never) =>
      evaluateIntelligencePolicy({ prisma, teamId: "team-1", provider: "OPENAI", operation: "OCR_IMAGE" }),
  },
  {
    kind: "VERIFICATION",
    run: (prisma: never) =>
      evaluateVerificationPolicy({ prisma, teamId: "team-1", evidenceId: "ev-1", action: "PUBLISH_PACKAGE" }),
  },
] as const;

describe("a failed effective-policy read REFUSES — per kind", () => {
  for (const { kind, run } of KINDS) {
    it(`${kind}: rejecting read → PolicyEvaluationUnavailableError (GOVERNANCE_CHECK_FAILED), never ALLOW`, async () => {
      const { prisma, audits } = stub({ findMany: READ_FAILS });
      const err = await run(prisma).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PolicyEvaluationUnavailableError);
      expect(isPolicyEvaluationUnavailable(err)).toBe(true);
      const e = err as PolicyEvaluationUnavailableError;
      expect(e.code).toBe("GOVERNANCE_CHECK_FAILED");
      expect(e.reason).toBe(`${kind.toLowerCase()}_policy_unavailable`);
      // Bounded: the driver's message is not the reason.
      expect(e.reason).not.toContain("connection");
      // No POLICY_EVALUATED row claims an evaluation that never happened.
      expect(audits).toEqual([]);
    });

    it(`${kind}: an EMPTY read ([]) is "nothing configured" → ALLOW`, async () => {
      const { prisma, audits } = stub({ findMany: async () => [] });
      const result = await run(prisma);
      expect(result.decision).toBe("ALLOW");
      expect(audits).toContain("POLICY_EVALUATED");
    });
  }

  it("REDACTION never reads the policy set (bridged to the Phase 3A engine) — unaffected", async () => {
    const { prisma } = stub({ findMany: READ_FAILS });
    const result = await evaluateRedactionPolicy({ prisma, teamId: "team-1", evidenceId: "ev-1" });
    expect(result.decision).toBe("ALLOW");
  });

  it("a configured BLOCK policy still blocks when the read succeeds (control)", async () => {
    const { prisma } = stub({
      findMany: async () => [assignment("SECURITY", { requireMfa: true })],
    });
    const result = await evaluateSecurityPolicy({
      prisma,
      teamId: "team-1",
      userId: "u-1",
      action: "session_authenticate",
      mfaSatisfied: false,
    });
    expect(result.decision).toBe("BLOCK");
  });
});

describe("the runtime gates REJECT on unavailability (callers fail closed)", () => {
  it("gateSecurityAction rejects", async () => {
    const { prisma } = stub({ findMany: READ_FAILS });
    await expect(
      gateSecurityAction({ prisma, teamId: "team-1", userId: "u-1", action: "session_authenticate" }),
    ).rejects.toMatchObject({ code: "GOVERNANCE_CHECK_FAILED", reason: "security_policy_unavailable" });
  });

  it("gateVerificationAction rejects", async () => {
    const { prisma } = stub({ findMany: READ_FAILS });
    await expect(
      gateVerificationAction({ prisma, teamId: "team-1", evidenceId: "ev-1", action: "PUBLISH_PACKAGE" }),
    ).rejects.toMatchObject({ code: "GOVERNANCE_CHECK_FAILED", reason: "verification_policy_unavailable" });
  });

  it("gateRetentionAction rejects", async () => {
    const { prisma } = stub({ findMany: READ_FAILS });
    await expect(
      gateRetentionAction({ prisma, teamId: "team-1", evidenceId: "ev-1", action: "DELETE" }),
    ).rejects.toMatchObject({ code: "GOVERNANCE_CHECK_FAILED" });
  });

  it("gateReviewDecision rejects", async () => {
    const { prisma } = stub({ findMany: READ_FAILS });
    await expect(
      gateReviewDecision({ prisma, teamId: "team-1", workflowId: "wf-1", decision: "APPROVE" }),
    ).rejects.toMatchObject({ code: "GOVERNANCE_CHECK_FAILED" });
  });

  it("an empty policy set still resolves ok:true", async () => {
    const { prisma } = stub({ findMany: async () => [] });
    await expect(
      gateSecurityAction({ prisma, teamId: "team-1", userId: "u-1", action: "session_authenticate" }),
    ).resolves.toEqual({ ok: true });
  });
});

describe("RETENTION — a legal-hold read a policy depends on is never 'no hold'", () => {
  it("requireLegalHoldCheck + failed legal-hold read → refused (retention_policy_input_unavailable)", async () => {
    const { prisma } = stub({
      findMany: async () => [assignment("RETENTION", { requireLegalHoldCheck: true })],
      legalHoldCount: READ_FAILS,
    });
    await expect(
      evaluateRetentionPolicy({ prisma, teamId: "team-1", evidenceId: "ev-1", action: "DELETE" }),
    ).rejects.toMatchObject({
      code: "GOVERNANCE_CHECK_FAILED",
      reason: "retention_policy_input_unavailable",
    });
  });

  it("requireLegalHoldCheck + an ACTIVE hold → BLOCK (control)", async () => {
    const { prisma } = stub({
      findMany: async () => [assignment("RETENTION", { requireLegalHoldCheck: true })],
      legalHoldCount: async () => 1,
    });
    const r = await evaluateRetentionPolicy({ prisma, teamId: "team-1", evidenceId: "ev-1", action: "DELETE" });
    expect(r.decision).toBe("BLOCK");
    expect(r.reason).toBe("legal_hold_active");
  });

  it("no policy needs the legal-hold read → its failure does not matter (ALLOW)", async () => {
    const { prisma } = stub({ findMany: async () => [], legalHoldCount: READ_FAILS });
    const r = await evaluateRetentionPolicy({ prisma, teamId: "team-1", evidenceId: "ev-1", action: "DELETE" });
    expect(r.decision).toBe("ALLOW");
  });
});
