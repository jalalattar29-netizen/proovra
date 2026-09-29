/**
 * RUNTIME PROBE RT-COMMERCIAL — audit-only. Disposable loopback PostgreSQL 16 +
 * loopback MinIO, real Fastify inject through the product harness, a FREE
 * personal user minted by the harness. No payment provider is contacted: the
 * credit is granted through the ledger service the webhook uses.
 *
 *   FREE-3      records 1..3 admitted, the 4th refused (and the exact code).
 *   FREE-RACE   two concurrent creates at 2/3 (creation is check-then-insert).
 *   COMMERCIAL-02 trash -> create -> restore yields more than 3 active records.
 *   ACQ-02      an uncompleted (UPLOADING) row occupies a slot.
 *   CREDIT      with one credit purchased at 3/3, which record is admitted and
 *               do the existing three change funding?
 *   COMMERCIAL-01 the Stripe ordering stamp: a reconciliation stamp equal to
 *               current_period_end makes a later cancellation "older".
 */
import { randomUUID } from "node:crypto";
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

describe("RT-COMMERCIAL (audit probe)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../../../../../../services/api/src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import(`${API}/test/integration-harness.js`);
    h = await bootIntegrationHarness();
    ({ prisma } = await import(`${API}/src/db.js`));
  }, 300_000);
  afterAll(async () => { await h?.cleanup(); });

  const create = (token: string) =>
    h.app.inject({ method: "POST", url: "/v1/evidence", headers: { authorization: `Bearer ${token}` }, payload: { type: "PHOTO", mimeType: "image/png", originalFileName: `et-${randomUUID().slice(0, 6)}.png` } });
  const activeCount = (userId: string) =>
    prisma.evidence.count({ where: { ownerUserId: userId, deletedAt: null, lifecycleState: { not: "DESTROYED" } } as never });

  it("FREE-3, FREE-RACE, COMMERCIAL-02, ACQ-02, CREDIT", async () => {
    const P = h.fixtures.personal;
    const auth = { authorization: `Bearer ${P.token}` };
    const plan = await prisma.entitlement.findFirst({ where: { userId: P.userId } as never, select: { plan: true, credits: true } as never }).catch(() => null);
    const trace: Array<Record<string, unknown>> = [];
    const step = async (label: string) => {
      const r = await create(P.token);
      const row = { label, status: r.statusCode, code: r.json()?.code ?? r.json()?.error?.code ?? null, message: (r.json()?.message ?? "").slice(0, 160), activeAfter: await activeCount(P.userId) };
      trace.push(row);
      return r;
    };
    const start = await activeCount(P.userId);
    // Fill up to 2/3 (the harness already seeds one personal record).
    while ((await activeCount(P.userId)) < 2) await step("fill");
    // FREE-RACE: two concurrent creates at 2/3.
    const [r1, r2] = await Promise.all([create(P.token), create(P.token)]);
    const afterRace = await activeCount(P.userId);
    trace.push({ label: "race", statuses: [r1.statusCode, r2.statusCode], activeAfter: afterRace });
    // 4th (or 5th) attempt at >= 3/3.
    const over = await step("attempt at cap");
    // ACQ-02: every row above is UPLOADING/CREATED (never completed) and still counts.
    const statuses = await prisma.evidence.groupBy({ by: ["status"], where: { ownerUserId: P.userId, deletedAt: null } as never, _count: true });
    // COMMERCIAL-02: trash one, create one, restore the trashed one.
    const victim = await prisma.evidence.findFirstOrThrow({ where: { ownerUserId: P.userId, deletedAt: null } as never, orderBy: { createdAt: "asc" }, select: { id: true } });
    const trash = await h.app.inject({ method: "DELETE", url: `/v1/evidence/${victim.id}`, headers: auth });
    const afterTrash = await activeCount(P.userId);
    const refill = await step("create after trash");
    const restore = await h.app.inject({ method: "POST", url: `/v1/evidence/${victim.id}/restore`, headers: auth, payload: {} });
    const afterRestore = await activeCount(P.userId);
    // CREDIT: grant one credit via the ledger path the purchase webhook uses, then create again.
    // Grant through the SAME service the verified purchase webhook calls.
    const { grantEvidenceCredits } = await import(`${API}/src/services/billing/evidence-credits.service.js`);
    let creditGrant: unknown;
    try {
      creditGrant = await grantEvidenceCredits({ userId: P.userId, credits: 1, provider: "STRIPE" as never, providerRef: `et-probe-${randomUUID()}` });
    } catch (e) {
      creditGrant = `grant failed: ${String((e as Error).message).slice(0, 160)}`;
    }
    const withCredit = await step("attempt at cap with 1 credit");
    const ledger = await prisma.evidenceCreditLedgerEntry.findMany({ where: { userId: P.userId }, orderBy: { createdAt: "asc" }, select: { entryType: true, creditsDelta: true, evidenceId: true, balanceAfter: true } });
    const out = {
      probe: "RT-COMMERCIAL/FREE",
      entitlementRow: plan ?? null,
      startActive: start,
      trace,
      overCap: { status: over.statusCode, body: over.body.slice(0, 300) },
      uncompletedStatuses: statuses,
      commercial02: { trash: trash.statusCode, afterTrash, refill: refill.statusCode, restore: restore.statusCode, restoreBody: restore.body.slice(0, 200), afterRestore },
      credit: { creditGrant, attemptWithCredit: { status: withCredit.statusCode, body: withCredit.body.slice(0, 200) }, ledgerAfter: ledger, note: "no record is completed here; CONSUMPTION is written only at a NEW record's completion (settleEvidenceCompletionFunding)" },
    };
    record("rt-commercial-free", out);
    expect(start).toBeGreaterThanOrEqual(0);
  });

  it("COMMERCIAL-01: a reconciliation stamp at current_period_end makes a later cancellation older", async () => {
    const { decideSubscriptionStatusWrite } = await import(`${API}/src/services/billing/subscription-status.js`);
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 20 * 24 * 3600 * 1000);
    // What stripe.provider.ts:386 records as observedAtUtc, and
    // reconciliation.service.ts:641 stamps into providerStateAtUtc when local and
    // provider agree (ACTIVE, same period end).
    const stamped = periodEnd;
    // A Stripe customer.subscription.deleted webhook later this week (event.created = now + 3d).
    const cancel = decideSubscriptionStatusWrite({ current: "ACTIVE", currentObservedAtUtc: stamped, next: "CANCELED", observedAtUtc: new Date(now.getTime() + 3 * 24 * 3600 * 1000) });
    const pastDue = decideSubscriptionStatusWrite({ current: "ACTIVE", currentObservedAtUtc: stamped, next: "PAST_DUE", observedAtUtc: new Date(now.getTime() + 5 * 24 * 3600 * 1000) });
    const control = decideSubscriptionStatusWrite({ current: "ACTIVE", currentObservedAtUtc: now, next: "CANCELED", observedAtUtc: new Date(now.getTime() + 3 * 24 * 3600 * 1000) });
    const out = { probe: "RT-COMMERCIAL/COMMERCIAL-01", stampedProviderStateAtUtc: stamped.toISOString(), cancelWebhookDecision: cancel, pastDueWebhookDecision: pastDue, controlWithHonestStamp: control };
    record("rt-commercial-01", out);
    expect((cancel as { apply: boolean }).apply).toBe(false);
  });
});
