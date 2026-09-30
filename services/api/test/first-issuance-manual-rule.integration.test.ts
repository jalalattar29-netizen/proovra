/**
 * ET-COM-06 — a customer's Generate click follows the historical first-issuance
 * rule the automatic path follows. Live PostgreSQL 16, real HTTP.
 *
 * The worker issues a record's FIRST report only when the entitlement says
 * mayIssueHistoricalFirstOutputs (a confirmed paid subscription, or a
 * credit-funded record). On a40ca76f the manual path needed only ENTITLED —
 * which includes a payment GRACE — so a click issued what the automatic path
 * withholds.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("first issuance: the manual path follows the historical rule (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let clearRates: () => Promise<unknown>;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
  }, 180_000);

  beforeEach(async () => {
    await clearRates();
  });

  afterAll(async () => {
    await prisma?.subscription.deleteMany({ where: { teamId: { in: [h.fixtures.teamA.teamId, h.fixtures.teamB.teamId] } } }).catch(() => undefined);
    await h?.cleanup();
  });

  /** A signed record finalized long ago, never issued a report. */
  async function historical(teamId: string, ownerUserId: string) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    const { id } = await prisma.evidence.create({
      data: {
        title: "COM-06 fixture",
        type: "PHOTO",
        status: "SIGNED",
        lifecycleState: "ACTIVE",
        teamId,
        organizationId: team.organizationId,
        ownerUserId,
        sizeBytes: 5_000n,
        signedAtUtc: new Date(Date.now() - 60 * 24 * 3600_000),
      } as never,
      select: { id: true },
    });
    return id;
  }
  const generate = (token: string, id: string) =>
    h.app.inject({
      method: "POST",
      url: `/v1/evidence/${id}/reports/regenerate`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
  const requests = (id: string) => prisma.reportGenerationRequest.count({ where: { evidenceId: id } });

  it("in a payment GRACE, a click on a record's first report creates nothing", async () => {
    const B = h.fixtures.teamB;
    await prisma.team.update({ where: { id: B.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    await prisma.subscription.create({
      data: {
        userId: B.ownerUserId,
        teamId: B.teamId,
        provider: "STRIPE",
        providerSubId: `com06-${randomUUID()}`,
        status: "PAST_DUE",
        plan: "TEAM",
        currentPeriodEnd: new Date(Date.now() - 24 * 3600_000),
      } as never,
    });
    const id = await historical(B.teamId, B.ownerUserId);

    const res = await generate(B.ownerToken, id);
    expect(res.statusCode, res.body).not.toBe(202);
    expect(await requests(id)).toBe(0);
  });

  it("with a confirmed paid subscription, the same click is accepted (control)", async () => {
    const A = h.fixtures.teamA;
    await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    const id = await historical(A.teamId, A.ownerUserId);

    const res = await generate(A.ownerToken, id);
    expect(res.statusCode, res.body).toBe(202);
    expect(await requests(id)).toBe(1);
  });
});
