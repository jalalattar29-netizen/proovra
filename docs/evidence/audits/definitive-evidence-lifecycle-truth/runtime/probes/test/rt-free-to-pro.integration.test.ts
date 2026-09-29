/**
 * RUNTIME PROBE RT-FREE-PRO — audit-only. Disposable loopback PostgreSQL 16.
 *
 * A FREE user holds two finalized records (signed 1 day and 10 days ago) with
 * no report. A provider-confirmed ACTIVE PRO subscription is applied through
 * the production plan authority (syncPlanForSubscription) with a FAKE
 * subscription id; the superseded-subscription canceller is injected so no
 * provider is contacted. We record what the customer-facing Reports projection
 * says about each record before and after.
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

describe("RT-FREE-PRO (audit probe)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../../../../../../services/api/src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import(`${API}/test/integration-harness.js`);
    h = await bootIntegrationHarness();
    ({ prisma } = await import(`${API}/src/db.js`));
  }, 300_000);
  afterAll(async () => { await h?.cleanup(); });

  it("existing FREE records after an ACTIVE PRO subscription", async () => {
    const P = h.fixtures.personal;
    const org = (await prisma.team.findUniqueOrThrow({ where: { id: P.teamId }, select: { organizationId: true } })).organizationId;
    const mk = (daysAgo: number) =>
      prisma.evidence.create({
        data: { title: `ET free record signed ${daysAgo}d ago`, type: "PHOTO", status: "SIGNED", teamId: P.teamId, organizationId: org, ownerUserId: P.userId, fileSha256: createHash("sha256").update(randomUUID()).digest("hex"), signedAtUtc: new Date(Date.now() - daysAgo * 86_400_000) } as never,
        select: { id: true },
      });
    const recent = await mk(1);
    const old = await mk(10);
    const { listWorkspaceArtifacts } = await import(`${API}/src/services/reports/reports-aggregator.service.js`);
    const view = async () => {
      const env = await listWorkspaceArtifacts({ teamId: P.teamId, role: "OWNER", callerUserId: P.userId, includeSummary: true });
      const items = env.sections.artifacts.items as Array<{ evidenceId?: string; id?: string; outputs?: { report?: unknown } }>;
      const pick = (id: string) => items.find((i) => (i.evidenceId ?? i.id) === id)?.outputs?.report ?? null;
      return { summary: env.sections.summary.data, recent: pick(recent.id), old: pick(old.id) };
    };
    const before = await view();
    const { syncPlanForSubscription } = await import(`${API}/src/services/billing/subscription-lifecycle.handlers.js`);
    let sync: unknown;
    try {
      sync = await syncPlanForSubscription({
        userId: P.userId, plan: "PRO" as never, provider: "STRIPE" as never, providerSubId: `sub_et_${randomUUID().slice(0, 12)}`,
        status: "ACTIVE" as never, currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000), observedAtUtc: new Date(),
        cancelSupersededAtProvider: async () => ({ canceled: false, observedAtUtc: null }) as never,
      });
    } catch (e) {
      sync = `sync failed: ${String((e as Error).message).slice(0, 200)}`;
    }
    const after = await view();
    const reportsCreated = await prisma.report.count({ where: { evidenceId: { in: [recent.id, old.id] } } });
    const requestsCreated = await prisma.reportGenerationRequest.count({ where: { evidenceId: { in: [recent.id, old.id] } } });
    const out = { probe: "RT-FREE-PRO", before, sync, after, reportsCreatedByTheUpgradeItself: reportsCreated, requestsCreatedByTheUpgradeItself: requestsCreated, note: "automatic first issuance is the worker's job (first-issuance-reconciliation.ts: 7-day windows, OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED off by default); not executed here" };
    record("rt-free-to-pro", out);
    expect(before).toBeTruthy();
  });
});
