/**
 * BILLING ACCEPTANCE (2026-10-31) — the release preview, run as the operator runs
 * it, against what the sweep then actually does. A preview that merely looks right
 * is worse than none: it is what an operator approves.
 *
 * Stripe is synthetic. The rows, the rule and the read-only connection are real.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Line = Record<string, unknown>;

function runPreview(databaseUrl: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/scripts/billing-automatic-effects-preview.ts"], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl, ...env },
    encoding: "utf8",
    timeout: 120_000,
  });
  const lines = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Line);
  return { status: result.status, stderr: result.stderr, lines };
}

describe("billing automatic effects preview (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: typeof import("../src/db.js").prisma;
  let databaseUrl: string;
  const day = 86_400_000;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    databaseUrl = process.env.DATABASE_URL!;
  }, 120_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  async function user(plan: "FREE" | "PRO" | "TEAM" = "FREE") {
    const { ensureEntitlement, setPersonalPlan } = await import("../src/services/billing.service.js");
    const id = randomUUID();
    const email = `preview-${id}@example.test`;
    await prisma.user.create({ data: { id, email, provider: "EMAIL", providerUserId: email } });
    await ensureEntitlement(id);
    if (plan !== "FREE") await setPersonalPlan(id, plan);
    return id;
  }

  const subscription = (userId: string, data: Record<string, unknown>) =>
    prisma.subscription.create({
      data: {
        userId,
        provider: "STRIPE",
        providerSubId: `sub_${randomUUID().slice(0, 14)}`,
        plan: "TEAM",
        status: "ACTIVE",
        currentPeriodEnd: new Date(Date.now() + 9 * day),
        activatedAtUtc: new Date(Date.now() - 40 * day),
        ...data,
      } as never,
    });

  const addon = (ownerUserId: string, data: Record<string, unknown> = {}) =>
    prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId,
        addonKey: "TEAM_100_GB",
        extraStorageBytes: 107_374_182_400n,
        billingCycle: "MONTHLY",
        status: "ACTIVE",
        paymentProvider: "STRIPE",
        externalSubscriptionId: `sub_${randomUUID().slice(0, 14)}`,
        activatedAtUtc: new Date(Date.now() - 20 * day),
        currentPeriodEnd: new Date(Date.now() + 9 * day),
        amountCents: 999,
        currency: "EUR",
        ...data,
      } as never,
    });

  const endedTeam = (userId: string) =>
    subscription(userId, { status: "CANCELED", canceledAtUtc: new Date(Date.now() - day) });

  it("lists exactly what the sweep then cancels, with the dates that protect what was paid for", async () => {
    const owed = await user();
    await endedTeam(owed);
    const stripeRow = await addon(owed);
    const paypalRow = await addon(owed, { paymentProvider: "PAYPAL" });
    const pastDueRow = await addon(owed, { paymentProvider: "PAYPAL", status: "PAST_DUE" });

    const covered = await user("TEAM");
    await subscription(covered, {});
    const safe = await addon(covered);

    const { status, stderr, lines } = runPreview(databaseUrl);
    expect(stderr).toBe("");
    expect(status).toBe(0);

    const listed = lines.filter((l) => l.action === "CANCEL_ADDON_AT_PROVIDER");
    const ids = listed.map((l) => l.addonId);
    expect(ids).toEqual(expect.arrayContaining([stripeRow.id, paypalRow.id, pastDueRow.id]));
    expect(ids).not.toContain(safe.id);

    const line = (id: string) => listed.find((l) => l.addonId === id)!;
    expect(line(stripeRow.id)).toMatchObject({
      providerStopsRenewing: "AT_PAID_THROUGH",
      capacityKeptUntilPaidThrough: true,
      paidThroughUtc: stripeRow.currentPeriodEnd!.toISOString(),
      held: true,
    });
    expect(line(paypalRow.id)).toMatchObject({ providerStopsRenewing: "AT_SWEEP", capacityKeptUntilPaidThrough: true });
    // The honest exception: a past-due PayPal add-on does not keep a paid period.
    expect(line(pastDueRow.id)).toMatchObject({ capacityKeptUntilPaidThrough: false });

    const { recordDependentCancellationObligations } = await import(
      "../src/services/billing/dependent-cancellation.service.js"
    );
    await recordDependentCancellationObligations({ ownerUserId: owed, teamId: null }, prisma);
    const obligated = await prisma.workspaceStorageAddon.findMany({
      where: { ownerUserId: owed, dependentCancellationState: { not: "NONE" } },
      select: { id: true },
    });
    expect(obligated.map((r) => r.id).sort()).toEqual([stripeRow.id, paypalRow.id, pastDueRow.id].sort());
  }, 150_000);

  it("lists what a grant's end stops, which is what closing the grant then records", async () => {
    const admin = await user();
    const grant = (userId: string, expiresAtUtc: Date) =>
      prisma.planGrant.create({
        data: {
          userId,
          plan: "TEAM",
          source: "INTERNAL_TEST",
          reason: "Internal test access",
          grantedByUserId: admin,
          idempotencyKey: randomUUID(),
          grantedAtUtc: new Date(Date.now() - 20 * day),
          expiresAtUtc,
        } as never,
      });
    const ended = await user();
    const endedRow = await addon(ended, { dependsOnPlanGrantId: (await grant(ended, new Date(Date.now() - day))).id });
    const ending = await user();
    const endsAt = new Date(Date.now() + 5 * day);
    const endingRow = await addon(ending, { dependsOnPlanGrantId: (await grant(ending, endsAt)).id });
    const covered = await user("TEAM");
    await subscription(covered, {});
    const coveredRow = await addon(covered, { dependsOnPlanGrantId: (await grant(covered, new Date(Date.now() - day))).id });

    const { status, lines } = runPreview(databaseUrl);
    expect(status).toBe(0);
    const listed = lines.filter((l) => l.action === "CANCEL_ADDON_GRANT_ENDED");
    expect(listed.map((l) => l.addonId)).toEqual(expect.arrayContaining([endedRow.id, endingRow.id]));
    expect(listed.map((l) => l.addonId)).not.toContain(coveredRow.id);
    expect(listed.find((l) => l.addonId === endingRow.id)).toMatchObject({
      grantEndsUtc: endsAt.toISOString(),
      providerStopsRenewing: "AT_PAID_THROUGH",
      capacityKeptUntilPaidThrough: true,
      held: false,
    });

    const { expireInternalPlanGrants } = await import("../src/services/billing/internal-plan-grant.service.js");
    await expireInternalPlanGrants(prisma);
    const state = async (id: string) =>
      (await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id } })).dependentCancellationState;
    expect(await state(endedRow.id)).toBe("PENDING");
    expect(await state(endingRow.id)).toBe("NONE");
    expect(await state(coveredRow.id)).toBe("NONE");
  }, 150_000);

  it("lists a plan the sweep would lower, and only that", async () => {
    const drifted = await user("TEAM");
    const lower = await subscription(drifted, { plan: "PRO" });
    const raised = await user("FREE");
    const higher = await subscription(raised, { plan: "PRO" });

    const { lines } = runPreview(databaseUrl);
    const ids = lines.filter((l) => l.action === "LOWER_ENTITLEMENT_TO_SUBSCRIPTION").map((l) => l.subscriptionId);
    expect(ids).toContain(lower.id);
    expect(ids).not.toContain(higher.id);
    const switches = lines.find((l) => l.summary === "SWITCHES")!;
    expect(switches).toMatchObject({ BILLING_AUTO_PLAN_LOWERING: "off (held)", BILLING_AUTO_ADDON_CANCELLATION: "off (held)" });
    expect(Number(switches.subscriptionsNotCheckedAtProvider)).toBeGreaterThan(0);
  }, 150_000);

  it("writes nothing, on a connection Postgres itself keeps read-only", async () => {
    const owed = await user();
    await endedTeam(owed);
    const row = await addon(owed);
    const counts = () =>
      Promise.all([prisma.billingReviewItem.count(), prisma.workspaceStorageAddon.count(), prisma.subscription.count()]);
    const before = await counts();
    const updatedAt = row.updatedAt;

    const { status, lines } = runPreview(databaseUrl);
    expect(status).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(await counts()).toEqual(before);
    expect((await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: row.id } })).updatedAt).toEqual(updatedAt);

    const url = new URL(databaseUrl);
    url.searchParams.set("options", "-c default_transaction_read_only=on");
    const pg = (await import("pg")).default;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await expect(client.query("UPDATE users SET updated_at = now()")).rejects.toMatchObject({ code: "25006" });
    await client.end();
  }, 150_000);
});
