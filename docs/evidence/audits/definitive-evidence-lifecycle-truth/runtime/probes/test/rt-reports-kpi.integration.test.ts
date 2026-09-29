/**
 * RUNTIME PROBE RT-REPORTS — audit-only. Disposable loopback PostgreSQL 16.
 *
 * REPORTS-01: a record that already has Report v1 and whose LATER report
 * request failed terminally. The Reports summary cards and the row come from
 * the same aggregator call (listWorkspaceArtifacts); we record what each says.
 * Also records the control: a first-issuance failure with no report.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../../../../../../../services/api/test/integration-harness.js";

const RESULTS = path.resolve(__dirname, "..", "..", "results");
const record = (name: string, data: unknown) => {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(path.join(RESULTS, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
};
const API = "../../../../../../../services/api";

describe("RT-REPORTS (audit probe)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../../../../../../services/api/src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import(`${API}/test/integration-harness.js`);
    h = await bootIntegrationHarness();
    ({ prisma } = await import(`${API}/src/db.js`));
    await prisma.team.update({ where: { id: h.fixtures.teamB.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 300_000);
  afterAll(async () => { await h?.cleanup(); });

  async function finalized(title: string) {
    const B = h.fixtures.teamB;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: B.teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: { title, type: "PHOTO", status: "REPORTED", teamId: B.teamId, organizationId: team.organizationId, ownerUserId: B.ownerUserId, fileSha256: createHash("sha256").update(title).digest("hex"), signedAtUtc: new Date(Date.now() - 3600_000) } as never,
      select: { id: true },
    });
  }

  it("REPORTS-01: a failed updated-report request is not counted as failed", async () => {
    const B = h.fixtures.teamB;
    const { listWorkspaceArtifacts } = await import(`${API}/src/services/reports/reports-aggregator.service.js`);
    const base = await listWorkspaceArtifacts({ teamId: B.teamId, role: "OWNER", callerUserId: B.ownerUserId, includeSummary: true });

    const withReport = await finalized(`ET has v1 then failed ${randomUUID().slice(0, 6)}`);
    const v1At = new Date(Date.now() - 1800_000);
    await prisma.report.create({ data: { evidenceId: withReport.id, version: 1, storageBucket: "b", storageKey: `reports/${withReport.id}/v1.pdf`, generatedAtUtc: v1At } as never });
    await prisma.reportGenerationRequest.create({
      data: { teamId: B.teamId, evidenceId: withReport.id, artifactType: "REPORT", purpose: "updated_report", forceRegenerate: true, regenerateReason: "et probe", requestedByUserId: B.ownerUserId, idempotencyKey: `et-${randomUUID()}`, state: "FAILED_TERMINAL", terminalReasonCode: "unknown_error", attemptCount: 12, createdAtUtc: new Date(v1At.getTime() + 60_000), completedAtUtc: new Date() } as never,
    });
    const firstFail = await finalized(`ET first issuance failed ${randomUUID().slice(0, 6)}`);
    await prisma.reportGenerationRequest.create({
      data: { teamId: B.teamId, evidenceId: firstFail.id, artifactType: "REPORT", purpose: "evidence_completed", requestedByUserId: B.ownerUserId, idempotencyKey: `et-${randomUUID()}`, state: "FAILED_TERMINAL", terminalReasonCode: "unknown_error", attemptCount: 12, completedAtUtc: new Date() } as never,
    });

    const after = await listWorkspaceArtifacts({ teamId: B.teamId, role: "OWNER", callerUserId: B.ownerUserId, includeSummary: true });
    const row = (id: string) => (after.sections.artifacts.items as Array<{ evidenceId?: string; id?: string; outputs?: unknown }>).find((i) => (i.evidenceId ?? i.id) === id) ?? null;
    const summaryKeys = (s: unknown) => Object.fromEntries(Object.entries((s ?? {}) as Record<string, unknown>).filter(([k]) => /report|package|fail|ready|pending|blocked/i.test(k)));
    const out = {
      probe: "RT-REPORTS/REPORTS-01",
      summaryBefore: summaryKeys(base.sections.summary.data),
      summaryAfter: summaryKeys(after.sections.summary.data),
      rowWithV1ThenFailedRequest: row(withReport.id),
      rowFirstIssuanceFailed: row(firstFail.id),
    };
    record("rt-reports-01", out);
    expect(after.sections.summary.status).toBeTruthy();
  });
});
