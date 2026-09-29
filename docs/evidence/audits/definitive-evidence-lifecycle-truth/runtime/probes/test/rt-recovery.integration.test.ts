/**
 * RUNTIME PROBE RT-RECOVERY — audit-only. Disposable loopback PostgreSQL 16 +
 * Redis, real Fastify inject on POST /v1/evidence/:id/reports/regenerate (the
 * endpoint behind every web/mobile Recover/Retry control, RC-1..RC-4).
 *
 * Double-click race: two concurrent RECOVER requests for the missing package,
 * first without a client key, then twice with the same key. Records request
 * rows, report versions and credit-ledger rows before/after.
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

describe("RT-RECOVERY (audit probe)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../../../../../../services/api/src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import(`${API}/test/integration-harness.js`);
    h = await bootIntegrationHarness();
    ({ prisma } = await import(`${API}/src/db.js`));
    await prisma.team.update({ where: { id: h.fixtures.teamB.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 300_000);
  afterAll(async () => { await h?.cleanup(); });

  it("RECOVER double-click is idempotent", async () => {
    const B = h.fixtures.teamB;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: B.teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: { title: "ET recovery", type: "PHOTO", status: "REPORTED", teamId: B.teamId, organizationId: team.organizationId, ownerUserId: B.ownerUserId, fileSha256: createHash("sha256").update(randomUUID()).digest("hex"), signedAtUtc: new Date(Date.now() - 3600_000) } as never,
      select: { id: true },
    });
    const v1At = new Date(Date.now() - 1800_000);
    await prisma.report.create({ data: { evidenceId: ev.id, version: 1, storageBucket: "b", storageKey: `reports/${ev.id}/v1.pdf`, generatedAtUtc: v1At, checksumSha256: "0".repeat(64) } as never }).catch(async () => prisma.report.create({ data: { evidenceId: ev.id, version: 1, storageBucket: "b", storageKey: `reports/${ev.id}/v1.pdf`, generatedAtUtc: v1At } as never }));
    await prisma.reportGenerationRequest.create({
      data: { teamId: B.teamId, evidenceId: ev.id, artifactType: "PACKAGE", purpose: "evidence_completed", requestedByUserId: B.ownerUserId, idempotencyKey: `et-${randomUUID()}`, state: "FAILED_RETRYABLE", terminalReasonCode: "unknown_error", attemptCount: 3, createdAtUtc: new Date(v1At.getTime() + 1000) } as never,
    });
    const snap = async () => ({
      requests: await prisma.reportGenerationRequest.findMany({ where: { evidenceId: ev.id }, orderBy: { createdAtUtc: "asc" }, select: { artifactType: true, state: true, intent: true, clientRequestKey: true } as never }),
      reports: await prisma.report.count({ where: { evidenceId: ev.id } }),
      creditLedger: await prisma.evidenceCreditLedgerEntry.count({ where: { evidenceId: ev.id } }),
    });
    const auth = { authorization: `Bearer ${B.ownerToken}` };
    const call = (key?: string) => h.app.inject({ method: "POST", url: `/v1/evidence/${ev.id}/reports/regenerate`, headers: auth, payload: { intent: "RECOVER", output: "verificationPackage", ...(key ? { clientRequestKey: key } : {}) } });
    const before = await snap();
    const [a, b] = await Promise.all([call(), call()]);
    const afterNoKey = await snap();
    const key = `et-key-${randomUUID().slice(0, 12)}`;
    const [c, d] = await Promise.all([call(key), call(key)]);
    const afterKey = await snap();
    const brief = (r: { statusCode: number; body: string }) => ({ status: r.statusCode, body: r.body.slice(0, 220) });
    const out = { probe: "RT-RECOVERY", before, concurrentNoKey: [brief(a), brief(b)], afterNoKey, concurrentSameKey: [brief(c), brief(d)], afterKey };
    record("rt-recovery", out);
    expect(before.reports).toBe(1);
  });
});
