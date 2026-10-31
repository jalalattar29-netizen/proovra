/**
 * READ-ONLY RELEASE PREVIEW — what the billing sweep would do to existing records.
 *
 * In `src/`, so it ships compiled in the API image. Run it as a one-off container
 * of the NEW image, after the migrations and before that image serves anything:
 *
 *   node dist/scripts/billing-automatic-effects-preview.js
 *   node dist/scripts/billing-automatic-effects-preview.js --with-provider-reads
 *
 * It decides with the functions the sweep calls (`owedDependentCancellations`, the
 * live-base read, `lowersPlan`), so it cannot describe a different set. Every
 * statement runs on a connection Postgres itself holds read-only, and the script
 * refuses to start unless Postgres says so. `--with-provider-reads` makes one
 * provider GET per live subscription, because only the provider knows a plan it
 * has ended or a price the local row does not show.
 *
 * Prints record ids, dates and counts. No name, email or user id, and amounts only
 * as totals per currency. Exit 0: complete. Exit 2: the run failed. Exit 3: done,
 * but some reads did not answer, so the preview is incomplete.
 */
import "../env.js";

import * as prismaPkg from "@prisma/client";

type Line = Record<string, string | number | boolean | null>;

function month(date: Date | null): string {
  return date ? date.toISOString().slice(0, 7) : "NO_DATE";
}

async function main(): Promise<number> {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.searchParams.set("options", "-c default_transaction_read_only=on");
  process.env.DATABASE_URL = url.toString();

  // After the URL is set: `db.js` connects with what it finds on import.
  const { prisma } = await import("../db.js");
  const { addonCancellationModeForProvider } = await import(
    "../services/billing/storage-addon-cancellation.service.js"
  );
  const { UNRESOLVED_STATES, owedDependentCancellations, owedGrantEndedCancellations } = await import(
    "../services/billing/dependent-cancellation.service.js"
  );
  const { findLivePersonalBaseSubscription } = await import("../services/billing/base-subscription.service.js");
  const { automaticAddonCancellationEnabled, automaticPlanLoweringEnabled, lowersPlan } = await import(
    "../services/billing/automatic-effects.js"
  );
  const { storageAddonEligibleForPlan, storageAddonRequiresPaidPlan } = await import(
    "../services/billing/storage-addon-rules.js"
  );

  const readOnly = await prisma.$queryRaw<Array<{ transaction_read_only: string }>>`SHOW transaction_read_only`;
  if (readOnly[0]?.transaction_read_only !== "on") {
    console.error("preview_refused connection_is_writable");
    return 2;
  }

  const now = new Date();
  const totals = new Map<string, { count: number; cents: Map<string, number> }>();
  const emit = (line: Line, amount?: { cents: number | null; currency: string | null }) => {
    console.log(JSON.stringify(line));
    const key = [line.action, line.provider, line.effectiveMonth].join(" ");
    const total = totals.get(key) ?? { count: 0, cents: new Map<string, number>() };
    total.count += 1;
    if (amount?.cents && amount.currency) {
      total.cents.set(amount.currency, (total.cents.get(amount.currency) ?? 0) + amount.cents);
    }
    totals.set(key, total);
  };

  // ---- 1. Add-ons the sweep would start cancelling at the provider ---------
  const payers = await prisma.workspaceStorageAddon.findMany({
    where: {
      billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
      externalSubscriptionId: { not: null },
      status: { in: [prismaPkg.WorkspaceStorageAddonStatus.ACTIVE, prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE] },
      dependentCancellationState: "NONE",
    },
    distinct: ["ownerUserId"],
    select: { ownerUserId: true },
  });
  const addonFacts = (id: string) =>
    prisma.workspaceStorageAddon.findUniqueOrThrow({
      where: { id },
      select: { extraStorageBytes: true, amountCents: true, currency: true, teamId: true, team: { select: { workspaceKind: true } } },
    });
  const paidPeriodKept = (addon: {
    status: string;
    activatedAtUtc: Date | null;
    currentPeriodEnd: Date | null;
  }): boolean =>
    addon.status === prismaPkg.WorkspaceStorageAddonStatus.ACTIVE &&
    addon.activatedAtUtc !== null &&
    addon.currentPeriodEnd !== null &&
    addon.currentPeriodEnd > now;

  for (const { ownerUserId } of payers) {
    const { owed } = await owedDependentCancellations({ ownerUserId, teamId: null, now }, prisma);
    for (const { addon, trigger } of owed) {
      if (addon.dependentCancellationState !== "NONE") continue;
      const facts = await addonFacts(addon.id);
      const provider = addon.paymentProvider as prismaPkg.PaymentProvider;
      const mode = addonCancellationModeForProvider(provider);
      emit(
        {
          action: "CANCEL_ADDON_AT_PROVIDER",
          provider,
          effectiveMonth: month(addon.currentPeriodEnd),
          addonId: addon.id,
          addonKey: addon.addonKey,
          status: addon.status,
          scope: facts.teamId === null || facts.team?.workspaceKind === "PERSONAL" ? "PERSONAL" : "OLDER_WORKSPACE",
          // PERIOD_END: Stripe stops at the date below. IMMEDIATE: PayPal stops
          // renewing when the sweep calls it.
          providerStopsRenewing: mode === "PERIOD_END" ? "AT_PAID_THROUGH" : "AT_SWEEP",
          paidThroughUtc: addon.currentPeriodEnd?.toISOString() ?? null,
          capacityKeptUntilPaidThrough: mode === "PERIOD_END" ? addon.currentPeriodEnd !== null : paidPeriodKept(addon),
          triggerSubscriptionId: trigger!.id,
          held: !automaticAddonCancellationEnabled(),
        },
        { cents: facts.amountCents, currency: facts.currency },
      );
    }
  }

  // ---- 1b. Add-ons a grant's end stops: recorded when it closes, never held -
  const grantDependent = await prisma.workspaceStorageAddon.findMany({
    where: {
      dependsOnPlanGrantId: { not: null },
      status: { in: [prismaPkg.WorkspaceStorageAddonStatus.ACTIVE, prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE] },
      dependentCancellationState: "NONE",
    },
    distinct: ["dependsOnPlanGrantId"],
    select: { dependsOnPlanGrantId: true },
  });
  const endingGrants = await prisma.planGrant.findMany({
    where: {
      id: { in: grantDependent.map((row) => row.dependsOnPlanGrantId!) },
      revokedAtUtc: null,
      expiresAtUtc: { not: null },
    },
    select: { id: true, userId: true, expiresAtUtc: true },
  });
  for (const grant of endingGrants) {
    const endsAt = grant.expiresAtUtc! > now ? grant.expiresAtUtc! : now;
    const owed = await owedGrantEndedCancellations({ userId: grant.userId, grantIds: [grant.id], now: endsAt }, prisma);
    for (const addon of owed) {
      const facts = await addonFacts(addon.id);
      const provider = addon.paymentProvider as prismaPkg.PaymentProvider;
      const mode = addonCancellationModeForProvider(provider);
      emit(
        {
          action: "CANCEL_ADDON_GRANT_ENDED",
          provider,
          effectiveMonth: month(endsAt),
          addonId: addon.id,
          addonKey: addon.addonKey,
          status: addon.status,
          grantEndsUtc: endsAt.toISOString(),
          providerStopsRenewing: mode === "PERIOD_END" ? "AT_PAID_THROUGH" : "AT_GRANT_END",
          paidThroughUtc: addon.currentPeriodEnd?.toISOString() ?? null,
          capacityKeptUntilPaidThrough: mode === "PERIOD_END" ? addon.currentPeriodEnd !== null : paidPeriodKept(addon),
          held: false,
        },
        { cents: facts.amountCents, currency: facts.currency },
      );
    }
  }

  // ---- 2. Obligations already recorded: retried, never held ---------------
  const open = await prisma.workspaceStorageAddon.findMany({
    where: { dependentCancellationState: { in: [...UNRESOLVED_STATES] } },
    select: {
      id: true,
      paymentProvider: true,
      currentPeriodEnd: true,
      dependentCancellationState: true,
      dependentCancellationReasonCode: true,
      amountCents: true,
      currency: true,
    },
  });
  for (const row of open) {
    emit(
      {
        action: "RETRY_RECORDED_CANCELLATION",
        provider: row.paymentProvider,
        effectiveMonth: month(row.currentPeriodEnd),
        addonId: row.id,
        state: row.dependentCancellationState,
        reason: row.dependentCancellationReasonCode,
        paidThroughUtc: row.currentPeriodEnd?.toISOString() ?? null,
        held: false,
      },
      { cents: row.amountCents, currency: row.currency },
    );
  }

  // ---- 3. Purchases that would be refused if the provider reports them active
  const pending = await prisma.workspaceStorageAddon.findMany({
    where: { status: prismaPkg.WorkspaceStorageAddonStatus.PENDING, externalSubscriptionId: { not: null } },
    select: { id: true, ownerUserId: true, teamId: true, addonKey: true, paymentProvider: true, createdAt: true },
  });
  for (const row of pending) {
    const entitlement = await prisma.entitlement.findFirst({
      where: { userId: row.ownerUserId, active: true },
      orderBy: { createdAt: "desc" },
      select: { plan: true },
    });
    const eligible =
      row.teamId === null &&
      (!storageAddonRequiresPaidPlan(row.addonKey) ||
        (entitlement !== null && storageAddonEligibleForPlan(entitlement.plan, row.addonKey)));
    if (eligible) continue;
    emit({
      action: "REFUSE_PENDING_PURCHASE_IF_PROVIDER_ACTIVE",
      provider: row.paymentProvider,
      effectiveMonth: month(now),
      addonId: row.id,
      addonKey: row.addonKey,
      createdAtUtc: row.createdAt.toISOString(),
      held: false,
    });
  }

  // ---- 4. Plans the sweep would lower --------------------------------------
  const withProviderReads = process.argv.includes("--with-provider-reads");
  let providerUnanswered = 0;
  let providerNotChecked = 0;
  const { defaultReconciliationProviders, observationEndsSubscription, ownersWithLiveSubscriptions } = await import(
    "../services/billing/reconciliation/reconciliation.service.js"
  );
  const { planFromStripePriceId } = await import("../services/billing-pricing.service.js");
  const providers = withProviderReads ? defaultReconciliationProviders() : null;

  for (const userId of await ownersWithLiveSubscriptions()) {
    const live = await findLivePersonalBaseSubscription(userId);
    if (!live) continue;
    const entitlement = await prisma.entitlement.findFirst({
      where: { userId, active: true },
      orderBy: { createdAt: "desc" },
      select: { plan: true },
    });
    if (entitlement && lowersPlan(entitlement.plan, live.plan)) {
      emit({
        action: "LOWER_ENTITLEMENT_TO_SUBSCRIPTION",
        provider: live.provider,
        effectiveMonth: month(now),
        subscriptionId: live.id,
        from: entitlement.plan,
        to: live.plan,
        renewsOrEndsUtc: live.currentPeriodEnd?.toISOString() ?? null,
        held: !automaticPlanLoweringEnabled(),
      });
    }
    const adapter = providers?.[live.provider];
    if (!adapter) {
      providerNotChecked += 1;
      continue;
    }
    const observation = await adapter.observeSubscription(live.providerSubId);
    if (observation.state === "UNKNOWN") {
      providerUnanswered += 1;
      continue;
    }
    if (observationEndsSubscription(observation)) {
      emit({
        action: "END_PLAN_PROVIDER_REPORTS_ENDED",
        provider: live.provider,
        effectiveMonth: month(now),
        subscriptionId: live.id,
        from: entitlement?.plan ?? null,
        to: "SURVIVING_PLAN_OR_FREE",
        localPeriodEndUtc: live.currentPeriodEnd?.toISOString() ?? null,
        held: !automaticPlanLoweringEnabled(),
      });
      continue;
    }
    const billed = live.provider === prismaPkg.PaymentProvider.STRIPE ? planFromStripePriceId(observation.planId) : null;
    if (billed && lowersPlan(live.plan, billed)) {
      emit({
        action: "LOWER_SUBSCRIPTION_TO_BILLED_PRICE",
        provider: live.provider,
        effectiveMonth: month(now),
        subscriptionId: live.id,
        from: live.plan,
        to: billed,
        pendingPlan: live.pendingPlan ?? null,
        renewsOrEndsUtc: live.currentPeriodEnd?.toISOString() ?? null,
        held: !automaticPlanLoweringEnabled(),
      });
    }
  }

  for (const [key, total] of [...totals.entries()].sort()) {
    const [action, provider, effectiveMonth] = key.split(" ");
    console.log(
      JSON.stringify({
        summary: action,
        provider,
        effectiveMonth,
        count: total.count,
        recurringCents: Object.fromEntries(total.cents),
      }),
    );
  }
  console.log(
    JSON.stringify({
      summary: "SWITCHES",
      BILLING_AUTO_ADDON_CANCELLATION: automaticAddonCancellationEnabled() ? "on" : "off (held)",
      BILLING_AUTO_PLAN_LOWERING: automaticPlanLoweringEnabled() ? "on" : "off (held)",
      subscriptionsNotCheckedAtProvider: providerNotChecked,
      providerReadsThatDidNotAnswer: providerUnanswered,
    }),
  );
  return providerUnanswered > 0 ? 3 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: { code?: string; name?: string } | null) => {
    console.error("preview_failed", err?.code ?? err?.name ?? "unknown");
    process.exit(2);
  });
