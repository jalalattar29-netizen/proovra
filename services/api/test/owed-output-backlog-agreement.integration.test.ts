/**
 * ET-SEC-20 — every backlog aggregator counts only records an output is OWED
 * for, by the one owed-output decision (plan AND subscription lifecycle, the
 * rule issuance honours). Live PostgreSQL 16.
 *
 * On a40ca76f the narrowing asked the plan alone, and two aggregators (case
 * risk, org health) did not narrow at all: a lapsed PRO workspace's
 * plan-funded records — which the worker refuses to issue — counted as a
 * report backlog that never cleared, and a FREE workspace was penalized for
 * reports it was never owed.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("owed-output backlog agreement (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let outputEntitledEvidenceWhere: (typeof import("../src/services/billing/evidence-output-eligibility.service.js"))["outputEntitledEvidenceWhere"];
  let computeCaseRisk: (typeof import("../src/services/cases/case-risk-engine.service.js"))["computeCaseRisk"];
  let recordOrgHealth: (typeof import("../src/services/dashboard/org-health.service.js"))["recordOrgHealthSnapshotForWorkspace"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ outputEntitledEvidenceWhere } = await import("../src/services/billing/evidence-output-eligibility.service.js"));
    ({ computeCaseRisk } = await import("../src/services/cases/case-risk-engine.service.js"));
    ({ recordOrgHealthSnapshotForWorkspace: recordOrgHealth } = await import("../src/services/dashboard/org-health.service.js"));
  }, 180_000);

  afterAll(async () => {
    await prisma?.subscription.deleteMany({ where: { teamId: { in: [h.fixtures.teamA.teamId, h.fixtures.teamB.teamId] } } }).catch(() => undefined);
    await h?.cleanup();
  });

  /** Three signed, plan-funded records with no report, linked to one case. */
  async function backlog(teamId: string, ownerUserId: string) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    const { id: caseId } = await prisma.case.create({
      data: { name: `sec20-${randomUUID().slice(0, 8)}`, teamId, ownerUserId } as never,
      select: { id: true },
    });
    for (let i = 0; i < 3; i++) {
      const { id } = await prisma.evidence.create({
        data: { title: `sec20-${i}`, type: "PHOTO", status: "SIGNED", teamId, organizationId: team.organizationId, ownerUserId } as never,
        select: { id: true },
      });
      await prisma.caseEvidenceLink.create({ data: { caseId, evidenceId: id } as never });
    }
    return caseId;
  }

  const artifactScore = async (teamId: string) => {
    await recordOrgHealth({ teamId });
    const s = await prisma.organizationalHealthSnapshot.findFirstOrThrow({
      where: { teamId },
      orderBy: { createdAt: "desc" },
      select: { artifactReliabilityScore: true },
    });
    return s.artifactReliabilityScore;
  };

  it("a LAPSED paid (TEAM) workspace owes no plan-funded output: the narrowing, case risk and org health agree", async () => {
    const B = h.fixtures.teamB;
    await prisma.team.update({ where: { id: B.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    await prisma.subscription.create({
      data: {
        userId: B.ownerUserId,
        teamId: B.teamId,
        provider: "STRIPE",
        providerSubId: `sec20-${randomUUID()}`,
        status: "PAST_DUE",
        plan: "TEAM",
        currentPeriodEnd: new Date("2020-01-01T00:00:00.000Z"),
      } as never,
    });
    const caseId = await backlog(B.teamId, B.ownerUserId);

    expect(await outputEntitledEvidenceWhere({ teamId: B.teamId })).toEqual({ id: { in: [] } });
    const risk = await computeCaseRisk({ teamId: B.teamId, caseId });
    expect(risk.reasonCodes).not.toContain("REPORT_MISSING");
    expect(risk.evidenceGapCount).toBe(0);
    expect(await artifactScore(B.teamId)).toBe(100);
  });

  it("an ACTIVE paid (TEAM) workspace owes them: every aggregator counts the backlog (control)", async () => {
    const A = h.fixtures.teamA;
    await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    const caseId = await backlog(A.teamId, A.ownerUserId);

    expect(await outputEntitledEvidenceWhere({ teamId: A.teamId })).toBeNull();
    const risk = await computeCaseRisk({ teamId: A.teamId, caseId });
    expect(risk.reasonCodes).toContain("REPORT_MISSING");
    expect(risk.evidenceGapCount).toBe(3);
    expect((await artifactScore(A.teamId)) ?? 100).toBeLessThan(100);
  });
});
