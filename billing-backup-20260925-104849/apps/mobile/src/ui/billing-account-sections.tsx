/**
 * BILLING ACCOUNT SECTIONS — the web Billing page's panels
 * (apps/web/app/(app)/billing/_sections/*) over the ONE account projection.
 *
 * Presentation only: every figure and every offered action comes from
 * `BillingProjection` (src/product/billing-account.ts). The purchase
 * affordances of the web panels — Buy credits, Add/Manage storage, the plan
 * chooser and plan moves, Resume payment — are the pending distribution-policy
 * decision and are not rendered here.
 */
import React from "react";
import { View } from "react-native";

import { theme } from "../theme/theme";
import { formatUserDate } from "../lib/date";
import {
  ProovraBadge,
  ProovraButton,
  ProovraCard,
  ProovraText,
} from "./index";
import {
  BILLING_PAGE_COPY as COPY,
  billingStatusLabel,
  billingStatusTone,
  buildBillingMetrics,
  capabilityRows,
  contractActivationPresentation,
  contractRows,
  contractStatusPresentation,
  describeEvidenceAdmission,
  describeMeter,
  formatMoney,
  planCadence,
  planHeading,
  presentLifecycle,
  type ActiveAddonModel,
  type BillingProjection,
} from "../product/billing-account";

/** format.ts `formatDate`: null rather than "Not available". */
export function billingDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const f = formatUserDate(iso);
  return f === "Not available" ? null : f;
}

function PanelTitle({ children }: { children: string }) {
  return (
    <ProovraText variant="h3" weight="semibold">
      {children}
    </ProovraText>
  );
}

function FactRow({ label, value, tone }: { label: string; value: string; tone?: "pending" }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
      <ProovraText variant="label" color={tone ? theme.color.status.pending.fg : theme.color.ink.secondary} style={{ flex: 1 }}>
        {label}
      </ProovraText>
      <ProovraText variant="label" weight="semibold" color={tone ? theme.color.status.pending.fg : theme.color.ink.primary}>
        {value}
      </ProovraText>
    </View>
  );
}

/* ------------------------------------------------ PlanAndUsage: the banner */

export function BillingActionRequired({
  projection,
  onRetry,
  onSupport,
  busy,
}: {
  projection: BillingProjection;
  onRetry: () => void;
  onSupport: () => void;
  busy: boolean;
}) {
  const banner = projection.actionRequired;
  if (!banner) return null;
  const tone = banner.severity === "CRITICAL" ? theme.color.status.risk : theme.color.status.pending;
  const outstanding = projection.dependentStorageCancellation;
  return (
    <ProovraCard testID="billing-action-required" style={{ gap: theme.space.s2, borderColor: tone.border, backgroundColor: tone.bg }}>
      <ProovraText variant="body" weight="semibold" color={tone.fg}>
        {banner.title}
      </ProovraText>
      {banner.messages.map((m) => (
        <ProovraText key={m} variant="bodySm" color={theme.color.ink.secondary}>
          {m}
        </ProovraText>
      ))}
      {banner.reassurance ? (
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {banner.reassurance}
        </ProovraText>
      ) : null}
      {outstanding && outstanding.actionAvailable ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
          <ProovraButton label="Retry stopping storage add-ons" variant="secondary" fullWidth={false} loading={busy} onPress={onRetry} />
          {outstanding.supportRequired ? (
            <ProovraButton label="Contact support" variant="secondary" fullWidth={false} onPress={onSupport} />
          ) : null}
        </View>
      ) : null}
    </ProovraCard>
  );
}

/* ---------------------------------------------------------- the overview */

export function BillingOverviewCard({
  projection,
  onManagePlan,
}: {
  projection: BillingProjection;
  onManagePlan: () => void;
}) {
  const { plan } = projection;
  const periodEnd = billingDate(plan.currentPeriodEndUtc);
  const lifecycle = presentLifecycle(plan.lifecycle, periodEnd, billingDate(plan.graceEndsAtUtc));
  const price = formatMoney(plan.priceCents, plan.currency);
  const metrics = buildBillingMetrics(projection);
  const notes: string[] = [];
  if (periodEnd && plan.accessKind === "SUBSCRIPTION") {
    notes.push(plan.cancelAtPeriodEnd ? `Cancels on ${periodEnd} — you keep ${plan.displayName} until then.` : `Renews on ${periodEnd}.`);
  }
  if (plan.scheduledChange) {
    const on = billingDate(plan.scheduledChange.effectiveAtUtc);
    notes.push(
      on
        ? `Moving to ${plan.scheduledChange.displayName} on ${on}. You keep everything you have now until then.`
        : `Moving to ${plan.scheduledChange.displayName} at the end of this billing period. You keep everything you have now until then.`,
    );
  }
  if (lifecycle.detail && plan.lifecycle !== "PAST_DUE") notes.push(lifecycle.detail);

  return (
    <ProovraCard testID="billing-overview" style={{ gap: theme.space.s3 }}>
      <View style={{ gap: 2 }}>
        <ProovraText variant="label" weight="bold" color={theme.color.ink.muted}>
          CURRENT PLAN
        </ProovraText>
        <ProovraText variant="h2" weight="bold">
          {planHeading(projection)}
        </ProovraText>
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {`${projection.accountDisplayName} · ${planCadence(plan.accessKind)}`}
        </ProovraText>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.space.s2 }}>
        {/* A price only for what the server priced: a subscription, or Free's zero. */}
        {price ? (
          <ProovraText variant="h3" weight="bold">{`${price} / month`}</ProovraText>
        ) : plan.accessKind === "FREE" ? (
          <ProovraText variant="h3" weight="bold">{formatMoney(0, plan.currency) ?? "0"}</ProovraText>
        ) : null}
        <ProovraText variant="label" weight="semibold" color={theme.color.status[lifecycle.tone].fg}>
          {lifecycle.label}
        </ProovraText>
      </View>
      {/* ONE plan action, named by the server. */}
      <ProovraButton
        label={projection.actions.planManagement.label}
        fullWidth={false}
        disabled={!projection.actions.planManagement.enabled}
        onPress={onManagePlan}
      />
      {notes.map((n) => (
        <ProovraText key={n} variant="label" color={theme.color.ink.secondary}>
          {n}
        </ProovraText>
      ))}
      <View style={{ gap: theme.space.s3 }} testID="billing-metrics">
        {metrics.map((m) => (
          <View key={m.label} style={{ gap: 4 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
              <ProovraText variant="label" color={theme.color.ink.secondary}>{m.label}</ProovraText>
              <ProovraText variant="label" weight="semibold">{m.value}</ProovraText>
            </View>
            {/* The track exists for every metric; only a measured one fills and is a progressbar. */}
            <View
              accessibilityRole={m.ratio !== null ? "progressbar" : undefined}
              accessibilityLabel={m.ratio !== null ? `${m.label}: ${m.value}` : undefined}
              style={{ height: 6, borderRadius: 999, backgroundColor: theme.color.surface.muted, overflow: "hidden" }}
            >
              {m.ratio !== null ? (
                <View
                  style={{
                    width: `${Math.min(100, Math.round(m.ratio * 100))}%`,
                    height: "100%",
                    backgroundColor: m.tone === "pending" ? theme.color.status.pending.solid : theme.color.accent.a500,
                  }}
                />
              ) : null}
            </View>
            {m.note ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {m.note}
              </ProovraText>
            ) : null}
          </View>
        ))}
      </View>
    </ProovraCard>
  );
}

/* ------------------------------------------------------------- Evidence */

export function BillingEvidenceCard({
  projection,
  onChoosePlan,
  onOpenReports,
  onBuyCredits,
}: {
  projection: BillingProjection;
  onChoosePlan: () => void;
  onOpenReports: () => void;
  onBuyCredits?: () => void;
}) {
  const a = projection.evidenceAdmission;
  const meter = projection.usage.evidence;
  const hasMeter = meter.state === "MEASURED";
  if (!a && !hasMeter && projection.walletCredits === null) return null;
  const described = hasMeter ? describeMeter(meter) : null;
  const offered = a ? describeEvidenceAdmission(a, { canBuyCredits: projection.actions.canBuyEvidenceCredits, hasPlanOffer: projection.hasPlanOffers }) : null;
  const headline = offered?.headline ?? described?.headline ?? null;
  const windowNote =
    meter.state === "MEASURED" ? (meter.window === "ROLLING_30_DAYS" ? "Rolling 30-day window" : meter.window === "CALENDAR_MONTH" ? "Resets each month" : null) : null;
  const grandfathered =
    a !== null && a.capSource === "LEGACY_RECORD_CAP_OVERRIDE" && a.planIncludedLifetime !== null && a.effectiveLifetimeCap !== null && a.planIncludedLifetime !== a.effectiveLifetimeCap;
  const over = a && a.effectiveLifetimeCap !== null && a.recordsHeld > a.effectiveLifetimeCap ? a.recordsHeld - a.effectiveLifetimeCap : 0;
  const credits = a?.creditsAvailable ?? projection.walletCredits;
  const next = offered?.next ?? described?.detail ?? null;
  const n = projection.historicalEligible;

  return (
    <ProovraCard testID="billing-evidence-allowance" style={{ gap: theme.space.s2 }}>
      <PanelTitle>Evidence</PanelTitle>
      {headline ? (
        <ProovraText variant="body" weight="semibold">
          {headline}
        </ProovraText>
      ) : null}
      {offered?.breakdown ? (
        <ProovraText variant="label" color={theme.color.ink.secondary}>{offered.breakdown}</ProovraText>
      ) : null}
      {a && a.planIncludedLifetime !== null ? (
        <FactRow label={`Included with ${projection.plan.displayName}`} value={a.planIncludedLifetime.toLocaleString()} />
      ) : null}
      {grandfathered && a ? <FactRow label="Agreed account limit" value={(a.effectiveLifetimeCap as number).toLocaleString()} /> : null}
      {over > 0 ? <FactRow label={`Above the ${grandfathered ? "agreed limit" : "included allowance"}`} value={over.toLocaleString()} tone="pending" /> : null}
      {windowNote ? <FactRow label="Allowance period" value={windowNote} /> : null}
      {credits !== null ? <FactRow label="Credits available" value={credits.toLocaleString()} /> : null}
      {next ? (
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {next}
        </ProovraText>
      ) : null}
      {/* A COUNT and a link, never a "generate all". */}
      {n > 0 ? (
        <View style={{ gap: 4 }}>
          <ProovraText variant="bodySm">
            {`${n.toLocaleString()} existing evidence ${n === 1 ? "record is" : "records are"} now eligible for a report and verification package.`}
          </ProovraText>
          <ProovraButton label="Open Reports" variant="ghost" fullWidth={false} onPress={onOpenReports} />
        </View>
      ) : null}
      {projection.actions.canBuyEvidenceCredits && onBuyCredits ? (
        <ProovraButton label="Buy evidence credits" variant="secondary" fullWidth={false} onPress={onBuyCredits} />
      ) : null}
      {offered?.action === "SEE_PLANS" ? (
        <ProovraButton label="Choose a plan" variant="secondary" fullWidth={false} onPress={onChoosePlan} />
      ) : null}
    </ProovraCard>
  );
}

/* -------------------------------------------------------------- Storage */

function AddonRow({ addon, busy, onCancel }: { addon: ActiveAddonModel; busy: boolean; onCancel: () => void }) {
  const price = formatMoney(addon.priceCents, addon.currency);
  const renews = billingDate(addon.currentPeriodEndUtc);
  return (
    <View style={{ gap: 4, paddingVertical: theme.space.s1 }} testID={`billing-addon-${addon.id}`}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: theme.space.s2 }}>
        <ProovraText variant="bodySm" weight="semibold" style={{ flex: 1 }}>
          {price ? `${addon.storageLabel} · ${price}${addon.legacyOneTime ? "" : " / month"}` : addon.storageLabel}
        </ProovraText>
        <ProovraBadge label={billingStatusLabel(addon.status)} tone={billingStatusTone(addon.status)} />
      </View>
      <ProovraText variant="label" color={theme.color.ink.muted}>
        {addon.legacyOneTime
          ? "One-time purchase from before add-ons became monthly — kept, and never charged again."
          : renews
            ? `Renews ${renews}`
            : "Recurring monthly"}
      </ProovraText>
      {/* The SERVER decides whether this add-on can be cancelled. */}
      {addon.canCancel ? (
        <ProovraButton
          label="Cancel"
          accessibilityLabel={`Cancel storage add-on ${addon.storageLabel}`}
          variant="ghost"
          fullWidth={false}
          loading={busy}
          onPress={onCancel}
        />
      ) : null}
    </View>
  );
}

export function BillingStorageCard({
  projection,
  onChoosePlan,
  onCancelAddon,
  cancelBusyId,
  onBuyStorage,
}: {
  projection: BillingProjection;
  onChoosePlan: () => void;
  onCancelAddon: (addon: ActiveAddonModel) => void;
  cancelBusyId: string | null;
  onBuyStorage?: () => void;
}) {
  const meter = projection.usage.storage;
  const locked = projection.storageAddonsLocked;
  if (locked) {
    return (
      <ProovraCard testID="billing-storage-locked" style={{ gap: theme.space.s2 }}>
        <PanelTitle>Storage</PanelTitle>
        {meter.state === "MEASURED" ? (
          <ProovraText variant="body" weight="semibold">{`${meter.usedLabel} of ${meter.limitLabel} used`}</ProovraText>
        ) : null}
        <ProovraText variant="label" color={theme.color.ink.secondary}>{locked.reason}</ProovraText>
        {locked.unlockedByPlan ? <ProovraButton label="View plans" variant="secondary" fullWidth={false} onPress={onChoosePlan} /> : null}
      </ProovraCard>
    );
  }
  const addons = projection.storageAddons;
  if (!addons || (addons.offerCount === 0 && addons.active.length === 0)) return null;
  return (
    <ProovraCard testID="billing-storage" style={{ gap: theme.space.s2 }}>
      <PanelTitle>Storage</PanelTitle>
      {meter.state === "MEASURED" ? (
        <>
          <ProovraText variant="body" weight="semibold">{`${meter.usedLabel} of ${meter.limitLabel}`}</ProovraText>
          <FactRow label="Included with your plan" value={meter.baseLabel || "—"} />
          {meter.recurringAddonBytes !== "0" ? <FactRow label="Add-ons" value={meter.recurringAddonLabel} /> : null}
          {meter.legacyAddonBytes !== "0" ? <FactRow label="Kept from earlier purchases" value={meter.legacyAddonLabel} /> : null}
        </>
      ) : null}
      {addons.active.map((a) => (
        <AddonRow key={a.id} addon={a} busy={cancelBusyId === a.id} onCancel={() => onCancelAddon(a)} />
      ))}
      {addons.offerCount > 0 && onBuyStorage ? (
        <ProovraButton label="Add storage" variant="secondary" fullWidth={false} onPress={onBuyStorage} />
      ) : null}
      {addons.active.length === 0 ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.noExtraStorage}</ProovraText>
      ) : null}
    </ProovraCard>
  );
}

/* ---------------------------------------------------- Plan capabilities */

export function BillingCapabilitiesCard({ projection }: { projection: BillingProjection }) {
  const r = capabilityRows(projection);
  if (r.length === 0) return null;
  return (
    <ProovraCard testID="billing-capabilities" style={{ gap: theme.space.s2 }}>
      <PanelTitle>Plan capabilities</PanelTitle>
      {r.map((row) => (
        <FactRow key={row.label} label={row.label} value={row.value} />
      ))}
      <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.capabilitiesNote}</ProovraText>
    </ProovraCard>
  );
}

/* ------------------------------------------------------------ Agreement */

export function BillingContractCard({ projection }: { projection: BillingProjection }) {
  const c = projection.contract;
  if (!c) return null;
  const status = contractStatusPresentation(c.status);
  const activation = contractActivationPresentation(c.activationState);
  const r = contractRows(c, billingDate);
  return (
    <ProovraCard testID="billing-contract" style={{ gap: theme.space.s2 }}>
      <PanelTitle>Agreement</PanelTitle>
      {status ? (
        <ProovraText variant="label" weight="semibold" color={theme.color.status[status.tone].fg}>{status.label}</ProovraText>
      ) : null}
      {activation ? (
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {activation.detail ? `${activation.label} — ${activation.detail}` : activation.label}
        </ProovraText>
      ) : null}
      {c.derivedFromLegacyFallback ? (
        <ProovraText variant="label" color={theme.color.ink.secondary}>{COPY.contractLegacy}</ProovraText>
      ) : null}
      {r.map(([label, value]) => (
        <FactRow key={label} label={label} value={value} />
      ))}
    </ProovraCard>
  );
}

/* ------------------------------------------------------------- Support */

export function BillingSupportStrip({ projection, onPress }: { projection: BillingProjection; onPress: () => void }) {
  const agreement = projection.actions.contactAccountManager;
  return (
    <ProovraCard testID="billing-support" style={{ gap: theme.space.s2 }}>
      <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
        {agreement ? COPY.supportAgreement : COPY.supportGeneral}
      </ProovraText>
      <ProovraButton label={agreement ? "Contact your account manager" : "Get help"} variant="secondary" fullWidth={false} onPress={onPress} />
    </ProovraCard>
  );
}
