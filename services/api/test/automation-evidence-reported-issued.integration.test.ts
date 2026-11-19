/**
 * ET-REC-11 — EVIDENCE_REPORTED ("Report generated") fires once per ISSUED
 * report, never per generation request. Live PostgreSQL 16, the real request
 * writer and the real trigger detector.
 *
 * On a40ca76f it fired on the creation of every API-side request row —
 * package-only recovery, superseding retries, requests the worker later
 * refused — keyed by the request id and before any report existed, while
 * worker-originated first issuance never fired it.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("EVIDENCE_REPORTED follows issued reports (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function rule(teamId: string, userId: string) {
    return (
      await prisma.automationRule.create({
        data: {
          teamId,
          name: `reported-${randomUUID().slice(0, 6)}`,
          enabled: true,
          triggerType: "EVIDENCE_REPORTED",
          conditionJson: {} as never,
          actionType: "NOTIFY_USER",
          actionConfigJson: { userId } as never,
          createdByUserId: userId,
          updatedByUserId: userId,
        },
        select: { id: true },
      })
    ).id;
  }
  async function signed(teamId: string | null, ownerUserId: string) {
    const team = teamId ? await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } }) : null;
    return (
      await prisma.evidence.create({
        data: { title: `rep ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId, organizationId: team?.organizationId ?? null, ownerUserId } as never,
        select: { id: true },
      })
    ).id;
  }
  const issue = (evidenceId: string, version: number) =>
    prisma.report.create({
      data: { evidenceId, version, storageBucket: "rep", storageKey: `reports/${evidenceId}/v${version}.pdf`, generatedAtUtc: new Date() },
      select: { id: true },
    });
  /**
   * PRO-W2C2-06 — the detector pages the issued reports 100 at a time through a
   * durable cursor that wraps. On a database other suites have written reports
   * to, this case's report is reached within ceil(population / 100) ticks (plus
   * the wrap), so the detector is run for exactly that many.
   */
  async function detectEveryIssuedReport(): Promise<void> {
    const { detectTimeBasedAutomationTriggers } = await import("../src/services/automation/automation-triggers.js");
    const population = await prisma.report.count({
      where: { generatedAtUtc: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) } },
    });
    for (let tick = 0; tick < Math.ceil(population / 100) + 1; tick += 1) {
      await detectTimeBasedAutomationTriggers({ prisma });
    }
  }
  const runs = (ruleId: string, targetId: string) =>
    prisma.automationRun.findMany({ where: { ruleId, targetId }, select: { sourceEventId: true } });

  it("a generation request fires nothing; the issued report fires exactly once", async () => {
    const A = h.fixtures.teamA;
    const ruleId = await rule(A.teamId, A.ownerUserId);
    const evidenceId = await signed(A.teamId, A.ownerUserId);
    const { requestReportGeneration } = await import("../src/services/reports/report-generation-authority.service.js");
    await requestReportGeneration({
      evidenceId,
      purpose: "operator_regenerate",
      regenerateReason: "probe",
      requestedByUserId: A.ownerUserId,
    } as never).catch(() => null);
    expect(await runs(ruleId, evidenceId), "a REQUEST is not a report").toEqual([]);

    const report = await issue(evidenceId, 1);
    await detectEveryIssuedReport();
    await detectEveryIssuedReport();
    expect(await runs(ruleId, evidenceId)).toEqual([{ sourceEventId: `report.issued:${report.id}` }]);
  });

  it("a team_id-NULL Personal record's report fires in its owner's personal workspace", async () => {
    const P = h.fixtures.personal;
    const ruleId = await rule(P.teamId, P.userId);
    const evidenceId = await signed(null, P.userId);
    const report = await issue(evidenceId, 1);
    await detectEveryIssuedReport();
    expect(await runs(ruleId, evidenceId)).toEqual([{ sourceEventId: `report.issued:${report.id}` }]);
  });
});
