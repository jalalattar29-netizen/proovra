/**
 * TEAM-SPEC §0 / R1 (2026-11-23, cancel disclosure) — a Team owner sees, BEFORE
 * confirming a cancellation, that review queues, assignments, escalations and
 * SLA tracking stop, with the ACTUAL date the plan leaves TEAM: the billing
 * projection's `cancellation.endsReviewerOperations`. The date is the
 * subscription's `currentPeriodEnd` (Stripe cancels at period end; PayPal keeps
 * the paid period) — "immediately" when a PayPal cancel ends it at once.
 * Read-only counts; nothing is changed. Real PostgreSQL, real projection, real
 * account route.
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
let cancellationEffectiveDate: typeof import("../src/services/billing/reviewer-operations-ending.service.js").cancellationEffectiveDate;

const OWNER_CAPS = ["BILLING_VIEW", "BILLING_MANAGE", "BILLING_CANCEL", "BILLING_AMOUNT_VIEW", "BILLING_ADDON_PURCHASE"];

const account = (id: string, capabilities: string[] = OWNER_CAPS) =>
  ({
    type: "PERSONAL" as const,
    id,
    displayName: "Personal",
    capabilities: capabilities as never,
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
      activatedAtUtc: new Date(Date.now() - 10 * 86_400_000),
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
        data: { title: `cancel-${status}`, type: "PHOTO", status: "CREATED", teamId, organizationId: team.organizationId, ownerUserId } as never,
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
  for (const status of ["OPEN", "RESOLVED"]) {
    await prisma.reviewEscalation.create({
      data: { teamId, workflowId: ids[0]!, reason: "REVIEW_OVERDUE", status, safeSummary: "Overdue", fingerprint: `fp-${randomUUID()}` },
    });
  }
}

beforeAll(async () => {
  h = await bootIntegrationHarness();
  prisma = (await import("../src/db.js")).prisma;
  ({ buildBillingAccountProjection } = await import("../src/services/billing/billing-account-projection.service.js"));
  ({ cancellationEffectiveDate } = await import("../src/services/billing/reviewer-operations-ending.service.js"));
  deps = {
    prisma: prisma as never,
    tag: `tbcd-${Date.now().toString(36)}`,
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

describe("the billing projection discloses what cancelling TEAM ends, before confirming", () => {
  it("TEAM on Stripe: effectiveAt is the subscription's currentPeriodEnd, with the open reviews and active escalations", async () => {
    const t = await seedPersonalTenant(deps, "TEAM", { credits: 0 });
    const periodEnd = new Date("2031-03-14T09:30:00.000Z");
    const sub = await subscription(t.owner.userId, "TEAM", { currentPeriodEnd: periodEnd });
    await seedReviewWork(t.personalTeamId, t.owner.userId);
    const workBefore = await prisma.evidenceReviewWorkflow.findMany({ where: { teamId: t.personalTeamId }, select: { id: true, status: true }, orderBy: { id: "asc" } });

    const p = await buildBillingAccountProjection({ account: account(t.owner.userId), viewerUserId: t.owner.userId });
    expect(p.actions.canRequestCancellation).toBe(true);
    expect(p.cancellation).toEqual({
      endsReviewerOperations: {
        openWorkflows: 2,
        activeEscalations: 1,
        effectiveAt: "2031-03-14T09:30:00.000Z",
        effectiveImmediately: false,
      },
    });

    // The same answer on the real account route the page reads.
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/billing/accounts/PERSONAL/${t.owner.userId}`,
      headers: { authorization: `Bearer ${t.owner.token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).cancellation?.endsReviewerOperations).toEqual(p.cancellation?.endsReviewerOperations);

    // Read-only: nothing moved, nothing scheduled.
    expect(await prisma.evidenceReviewWorkflow.findMany({ where: { teamId: t.personalTeamId }, select: { id: true, status: true }, orderBy: { id: "asc" } })).toEqual(workBefore);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id }, select: { cancelAtPeriodEnd: true, canceledAtUtc: true, status: true } })).toEqual({
      cancelAtPeriodEnd: false,
      canceledAtUtc: null,
      status: "ACTIVE",
    });
  });

  it("TEAM on PayPal keeps the paid period: effectiveAt = currentPeriodEnd; a refunded payment ends it immediately", async () => {
    const t = await seedPersonalTenant(deps, "TEAM", { credits: 0 });
    const periodEnd = new Date(Date.now() + 9 * 86_400_000);
    periodEnd.setUTCMilliseconds(0);
    const sub = await subscription(t.owner.userId, "TEAM", { provider: "PAYPAL", providerSubId: `I-${randomUUID()}`, currentPeriodEnd: periodEnd });
    const p = await buildBillingAccountProjection({ account: account(t.owner.userId), viewerUserId: t.owner.userId });
    expect(p.cancellation?.endsReviewerOperations).toEqual({
      openWorkflows: 0,
      activeEscalations: 0,
      effectiveAt: periodEnd.toISOString(),
      effectiveImmediately: false,
    });

    // A PayPal paid period already over: the CANCELED webhook lowers at once.
    expect(
      await cancellationEffectiveDate({ provider: "PAYPAL", providerSubId: sub.providerSubId, currentPeriodEnd: new Date(Date.now() - 1000) }, prisma as never),
    ).toEqual({ effectiveAt: null, effectiveImmediately: true });
    // A Stripe period end behind us is not a date Stripe will use: none is claimed.
    expect(
      await cancellationEffectiveDate({ provider: "STRIPE", providerSubId: "sub-x", currentPeriodEnd: new Date(Date.now() - 1000) }, prisma as never),
    ).toEqual({ effectiveAt: null, effectiveImmediately: false });
  });

  it("PRO: absent", async () => {
    const pro = await seedPersonalTenant(deps, "PRO", { credits: 0 });
    await subscription(pro.owner.userId, "PRO");
    const p = await buildBillingAccountProjection({ account: account(pro.owner.userId), viewerUserId: pro.owner.userId });
    expect(p.actions.canRequestCancellation).toBe(true);
    expect(p.cancellation).toBeUndefined();
  });

  it("an internal TEAM grant governs: absent", async () => {
    const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
    await prisma.planGrant.create({
      data: {
        userId: t.owner.userId,
        plan: "TEAM",
        source: "INTERNAL_TEST",
        reason: "cancel disclosure test",
        grantedByUserId: t.owner.userId,
        idempotencyKey: `tbcd-${randomUUID()}`,
      },
    });
    const p = await buildBillingAccountProjection({ account: account(t.owner.userId), viewerUserId: t.owner.userId });
    expect(p.plan).toMatchObject({ planKey: "TEAM", accessSource: "INTERNAL_GRANT" });
    expect(p.cancellation).toBeUndefined();
  });

  it("a viewer who may not cancel: absent; whoever may cancel is told", async () => {
    const t = await seedPersonalTenant(deps, "TEAM", { credits: 0 });
    await subscription(t.owner.userId, "TEAM");
    const viewer = await buildBillingAccountProjection({ account: account(t.owner.userId, ["BILLING_VIEW"]), viewerUserId: t.owner.userId });
    expect(viewer.actions.canRequestCancellation).toBe(false);
    expect(viewer.cancellation).toBeUndefined();
    const manageOnly = await buildBillingAccountProjection({ account: account(t.owner.userId, ["BILLING_VIEW", "BILLING_MANAGE"]), viewerUserId: t.owner.userId });
    expect(manageOnly.cancellation).toBeUndefined();
    const cancelOnly = await buildBillingAccountProjection({ account: account(t.owner.userId, ["BILLING_VIEW", "BILLING_CANCEL"]), viewerUserId: t.owner.userId });
    expect(cancelOnly.actions.canRequestCancellation).toBe(true);
    expect(cancelOnly.cancellation?.endsReviewerOperations).toMatchObject({ effectiveImmediately: false });
  });
});
