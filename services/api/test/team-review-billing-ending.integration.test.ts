/**
 * TEAM-SPEC §0 / R1 (2026-11-23) — lowering a Personal account from TEAM says
 * what it ends on the Personal Workspace's reviewer operations, BEFORE the
 * customer confirms (the DOWNGRADE plan offer in the billing projection) and
 * on the cancel answer. Read-only counts; never blocks; nothing is changed.
 * Real PostgreSQL, real projection, real cancel route.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps } from "./point7/product-fixtures.js";
import { signJwt } from "../src/services/jwt.js";

let h: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let deps: FixtureDeps;
// Loaded after the harness points the database at the test clone (it imports db.js).
let buildBillingAccountProjection: typeof import("../src/services/billing/billing-account-projection.service.js").buildBillingAccountProjection;

const owner = (id: string) =>
  ({
    type: "PERSONAL" as const,
    id,
    displayName: "Personal",
    capabilities: ["BILLING_VIEW", "BILLING_MANAGE", "BILLING_CANCEL", "BILLING_AMOUNT_VIEW", "BILLING_ADDON_PURCHASE"] as never,
    billingOwnerMissing: false,
  });

async function subscription(userId: string, plan: "PRO" | "TEAM", over: Record<string, unknown> = {}) {
  return prisma.subscription.create({
    data: {
      userId,
      provider: "STRIPE",
      providerSubId: `sub-${randomUUID()}`,
      status: "ACTIVE",
      plan,
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      cancelAtPeriodEnd: false,
      teamId: null,
      ...over,
    },
  });
}

/** Two open reviews, one closed, one active and one resolved escalation. */
async function seedReviewWork(teamId: string, ownerUserId: string) {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
  const ids: string[] = [];
  for (const status of ["NOT_STARTED", "IN_REVIEW", "CLOSED"]) {
    const evidenceId = (
      await prisma.evidence.create({
        data: { title: `bill-${status}`, type: "PHOTO", status: "CREATED", teamId, organizationId: team.organizationId, ownerUserId } as never,
        select: { id: true },
      })
    ).id;
    ids.push(
      (
        await prisma.evidenceReviewWorkflow.create({
          data: { evidenceId, teamId, status: status as never, workspaceType: "PERSONAL" },
          select: { id: true },
        })
      ).id,
    );
  }
  for (const status of ["ACKNOWLEDGED", "RESOLVED"]) {
    await prisma.reviewEscalation.create({
      data: { teamId, workflowId: ids[0]!, reason: "REVIEW_OVERDUE", status, safeSummary: "Overdue", fingerprint: `fp-${randomUUID()}` },
    });
  }
  return ids;
}

beforeAll(async () => {
  h = await bootIntegrationHarness();
  prisma = (await import("../src/db.js")).prisma;
  ({ buildBillingAccountProjection } = await import("../src/services/billing/billing-account-projection.service.js"));
  deps = {
    prisma: prisma as never,
    tag: `trbe-${Date.now().toString(36)}`,
    mintToken: (userId, email) =>
      signJwt(
        { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
        process.env.AUTH_JWT_SECRET!,
        3600,
      ),
  };
}, 900_000);

afterAll(async () => {
  await h?.cleanup();
}, 300_000);

describe("the billing projection warns before a TEAM → PRO downgrade", () => {
  it("the DOWNGRADE offer carries endsReviewerOperations with the open reviews and active escalations", async () => {
    const t = await seedPersonalTenant(deps, "TEAM", { credits: 0 });
    await subscription(t.owner.userId, "TEAM");
    await seedReviewWork(t.personalTeamId, t.owner.userId);
    const before = await prisma.evidenceReviewWorkflow.findMany({ where: { teamId: t.personalTeamId }, select: { id: true, status: true } });

    const p = await buildBillingAccountProjection({ account: owner(t.owner.userId), viewerUserId: t.owner.userId });
    const offers = p.planOffers ?? [];
    expect(offers.map((o) => [o.planKey, o.action])).toEqual([["PRO", "DOWNGRADE"]]);
    expect(offers[0]!.endsReviewerOperations).toEqual({ openWorkflows: 2, activeEscalations: 1 });
    // Read-only: nothing moved.
    expect(await prisma.evidenceReviewWorkflow.findMany({ where: { teamId: t.personalTeamId }, select: { id: true, status: true } })).toEqual(before);
  });

  it("a TEAM account with no review work still says so (zeros); a PRO account's UPGRADE offer carries nothing", async () => {
    const team = await seedPersonalTenant(deps, "TEAM", { credits: 0 });
    await subscription(team.owner.userId, "TEAM");
    const p = await buildBillingAccountProjection({ account: owner(team.owner.userId), viewerUserId: team.owner.userId });
    expect(p.planOffers?.[0]?.endsReviewerOperations).toEqual({ openWorkflows: 0, activeEscalations: 0 });

    const pro = await seedPersonalTenant(deps, "PRO", { credits: 0 });
    await subscription(pro.owner.userId, "PRO");
    const q = await buildBillingAccountProjection({ account: owner(pro.owner.userId), viewerUserId: pro.owner.userId });
    expect(q.planOffers?.[0]?.action).toBe("UPGRADE");
    expect(q.planOffers?.[0]?.endsReviewerOperations).toBeUndefined();
  });
});

describe("the cancel answer says what cancelling TEAM ends", () => {
  async function cancel(token: string) {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/billing/subscription/cancel",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: "{}",
    });
    return { status: res.statusCode, body: JSON.parse(res.body), raw: res.body };
  }

  it("TEAM: endsReviewerOperations on the cancel response; PRO: absent", async () => {
    // An already-scheduled cancellation is the idempotent repeat: the route's
    // full answer without a provider call.
    const t = await seedPersonalTenant(deps, "TEAM", { credits: 0 });
    await subscription(t.owner.userId, "TEAM", { cancelAtPeriodEnd: true });
    await seedReviewWork(t.personalTeamId, t.owner.userId);
    const res = await cancel(t.owner.token);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.cancellation.alreadyScheduled).toBe(true);
    expect(res.body.endsReviewerOperations).toEqual({ openWorkflows: 2, activeEscalations: 1 });

    const pro = await seedPersonalTenant(deps, "PRO", { credits: 0 });
    await subscription(pro.owner.userId, "PRO", { cancelAtPeriodEnd: true });
    const proRes = await cancel(pro.owner.token);
    expect(proRes.status, proRes.raw).toBe(200);
    expect(proRes.body.endsReviewerOperations).toBeUndefined();
  });
});
