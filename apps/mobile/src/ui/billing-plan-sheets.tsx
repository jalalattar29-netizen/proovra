/**
 * BILLING PLAN SHEETS — the web's ManagePlanDrawer (read + cancel) and the
 * Pricing page (`app/pricing/page.tsx`) as a read-only reference sheet.
 *
 * What is deliberately absent: the plan MOVES of ManagePlanDrawer, the
 * CheckoutDrawer, PaymentMethodChoice and every pricing CTA that starts a
 * purchase. Starting or changing a paid plan is the pending
 * distribution-policy decision (src/product/billing.ts PURCHASE_TRANSACTIONS);
 * prices and plans are shown, never sold.
 */
import React from "react";
import { View } from "react-native";

import { theme } from "../theme/theme";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraText } from "./index";
import { ProovraSheet } from "./patterns";
import {
  BILLING_PAGE_COPY as COPY,
  formatMoney,
  managePlanTitle,
  presentLifecycle,
  type BillingProjection,
} from "../product/billing-account";
import { PURCHASE_PENDING_NOTE } from "../product/billing";
import {
  formatAddonSize,
  formatMonthlyPrice,
  isCurrentPlan,
  planSummaryLine,
  type EvidenceCreditOffer,
  type PricingCatalogue,
  type StorageAddonOffer,
} from "../product/pricing";
import { billingDate } from "./billing-account-sections";

/* -------------------------------------------------------- Manage plan */

export function ManagePlanSheet({
  visible,
  projection,
  onClose,
  onCancelSubscription,
  cancelBusy,
}: {
  visible: boolean;
  projection: BillingProjection;
  onClose: () => void;
  onCancelSubscription: () => void;
  cancelBusy: boolean;
}) {
  const { plan, actions } = projection;
  const periodEnd = billingDate(plan.currentPeriodEndUtc);
  const lifecycle = presentLifecycle(plan.lifecycle, periodEnd, billingDate(plan.graceEndsAtUtc));
  const price = formatMoney(plan.priceCents, plan.currency);
  return (
    <ProovraSheet visible={visible} title={managePlanTitle(plan.accessKind)} onClose={onClose}>
      <View style={{ gap: theme.space.s3 }} testID="billing-manage-plan">
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {plan.accessKind === "SUBSCRIPTION"
            ? `Your subscription for ${projection.accountDisplayName}.`
            : `Your plan for ${projection.accountDisplayName}.`}
        </ProovraText>
        <View style={{ gap: 2 }}>
          <ProovraText variant="body" weight="semibold">
            {price ? `${plan.displayName} · ${price}${plan.model === "MONTHLY" ? " / month" : ""}` : plan.displayName}
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {[
              lifecycle.label,
              periodEnd && plan.model === "MONTHLY" ? `${plan.cancelAtPeriodEnd ? "Access until" : "Renews"} ${periodEnd}` : null,
              plan.paymentProviderLabel ? `Paid by ${plan.paymentProviderLabel}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </ProovraText>
          {plan.scheduledChange ? (
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {billingDate(plan.scheduledChange.effectiveAtUtc)
                ? `Moving to ${plan.scheduledChange.displayName} on ${billingDate(plan.scheduledChange.effectiveAtUtc)}. You keep everything you have now until then.`
                : `Moving to ${plan.scheduledChange.displayName} at the end of this billing period. You keep everything you have now until then.`}
            </ProovraText>
          ) : null}
        </View>

        {plan.providerTransition ? (
          <View style={{ gap: 2 }} testID="billing-provider-transition">
            <ProovraText variant="bodySm" weight="semibold">{plan.providerTransition.displayName}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {[
                plan.providerTransition.providerLabel
                  ? `Awaiting confirmation from ${plan.providerTransition.providerLabel}`
                  : "Awaiting confirmation from your payment provider",
                billingDate(plan.providerTransition.effectiveAtUtc) ? `Expected ${billingDate(plan.providerTransition.effectiveAtUtc)}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </ProovraText>
          </View>
        ) : null}

        {plan.accessKind === "GRANTED" ? (
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{COPY.grantedAccess(plan.displayName)}</ProovraText>
        ) : plan.accessKind === "CONTRACT" ? (
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{COPY.agreement}</ProovraText>
        ) : plan.accessKind === "SUBSCRIPTION" ? (
          <View style={{ gap: theme.space.s2 }}>
            <ProovraText variant="bodySm" weight="semibold">Cancel subscription</ProovraText>
            {plan.cancelAtPeriodEnd ? (
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                {periodEnd
                  ? `Cancels on ${periodEnd}. You keep ${plan.displayName} until then, and nothing is charged again.`
                  : "This subscription is cancelling at the end of the period you have paid for. Nothing is charged again."}
              </ProovraText>
            ) : actions.canRequestCancellation ? (
              <>
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  {`${
                    periodEnd
                      ? `Your plan will move to Free at the end of the period you have paid for, on ${periodEnd}.`
                      : "Your plan will move to Free once your payment provider confirms; we will tell you the exact date then."
                  } ${COPY.cancelEvidenceNote}`}
                </ProovraText>
                <ProovraButton label="Cancel subscription" variant="secondary" fullWidth={false} loading={cancelBusy} onPress={onCancelSubscription} />
              </>
            ) : (
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                {actions.cancellationUnavailableReason === "NO_SUBSCRIPTION_BOUND" ? COPY.noSubscriptionBound : COPY.notAuthorized}
              </ProovraText>
            )}
          </View>
        ) : null}

        {/* Plan moves are purchases/changes of a paid entitlement: pending decision. */}
        {projection.hasPlanOffers && plan.accessKind === "SUBSCRIPTION" ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>{PURCHASE_PENDING_NOTE}</ProovraText>
        ) : null}
        <ProovraButton label="Close" variant="ghost" onPress={onClose} />
      </View>
    </ProovraSheet>
  );
}

/* ------------------------------------------------------------ Pricing */

export const PRICING_COPY = {
  kicker: "Pricing & Plans",
  title: "Choose the right operational model for your evidence program.",
  intro: "Flexible plans for professionals, teams, and enterprise organizations that require trusted evidence operations.",
  capacity: "Plans & Capacity",
  enterpriseKicker: "Built for enterprise",
  enterpriseTitle: "Built for procurement, governance, and large-scale evidence operations.",
  enterpriseBody: "We support complex organizational needs with security, compliance, and scalability.",
  talkToSales: "Talk to Sales →",
} as const;

export function PricingSheet({
  visible,
  onClose,
  catalogue,
  addons,
  credit,
  currentPlan,
  onTalkToSales,
}: {
  visible: boolean;
  onClose: () => void;
  catalogue: PricingCatalogue | null;
  addons: StorageAddonOffer[];
  credit: EvidenceCreditOffer | null;
  currentPlan: string | null;
  /** Null when no web origin is configured: the button is hidden rather than dead. */
  onTalkToSales: (() => void) | null;
}) {
  return (
    <ProovraSheet visible={visible} title={PRICING_COPY.kicker} onClose={onClose}>
      <View style={{ gap: theme.space.s3 }} testID="billing-pricing">
        <ProovraText variant="h3" weight="bold">{PRICING_COPY.title}</ProovraText>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{PRICING_COPY.intro}</ProovraText>

        {catalogue === null ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>Plans could not be loaded just now.</ProovraText>
        ) : (
          catalogue.plans.map((offer) => (
            <ProovraCard key={offer.key} style={{ gap: theme.space.s1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2 }}>
                <ProovraText variant="body" weight="semibold">{offer.displayName}</ProovraText>
                {isCurrentPlan(offer, currentPlan) ? <ProovraBadge tone="verified" label="Your plan" /> : null}
              </View>
              <ProovraText variant="body">{formatMonthlyPrice(offer.monthlyPriceCents, catalogue.currency)}</ProovraText>
              {planSummaryLine(offer) ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>{planSummaryLine(offer)}</ProovraText>
              ) : null}
              {offer.capabilities.map((c) => (
                <ProovraText key={c} variant="label" color={theme.color.ink.secondary}>{`• ${c}`}</ProovraText>
              ))}
            </ProovraCard>
          ))
        )}

        {catalogue && (addons.length > 0 || credit) ? (
          <View style={{ gap: theme.space.s2 }}>
            <ProovraText variant="label" weight="bold" color={theme.color.ink.muted}>{PRICING_COPY.capacity.toUpperCase()}</ProovraText>
            {addons.length > 0 ? (
              <ProovraCard style={{ gap: theme.space.s1 }}>
                <ProovraText variant="bodySm" weight="semibold">Storage add-ons</ProovraText>
                {addons.map((a) => (
                  <View key={a.key} style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <ProovraText variant="bodySm">{formatAddonSize(a.storageBytes) ?? a.label}</ProovraText>
                    <ProovraText variant="label" color={theme.color.ink.muted}>{formatMonthlyPrice(a.priceCents, catalogue.currency)}</ProovraText>
                  </View>
                ))}
              </ProovraCard>
            ) : null}
            {credit ? (
              <ProovraCard style={{ gap: theme.space.s1 }}>
                <ProovraText variant="bodySm" weight="semibold">{credit.displayName}</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {[
                    credit.unitPriceCents !== null
                      ? formatMonthlyPrice(credit.unitPriceCents, catalogue.currency).replace(" / month", " per credit")
                      : null,
                    credit.creditsRequiredPerCompletion !== null ? `${credit.creditsRequiredPerCompletion} credit(s) per completed record` : null,
                    // Reported, not assumed.
                    credit.creditsExpire === false ? "Credits do not expire" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </ProovraText>
              </ProovraCard>
            ) : null}
          </View>
        ) : null}

        {catalogue?.currency ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {`Prices shown in ${catalogue.currency}. ${COPY.taxNote}`}
          </ProovraText>
        ) : null}

        <ProovraCard style={{ gap: theme.space.s1 }} testID="billing-pricing-enterprise">
          <ProovraText variant="label" weight="bold" color={theme.color.ink.muted}>{PRICING_COPY.enterpriseKicker.toUpperCase()}</ProovraText>
          <ProovraText variant="bodySm" weight="semibold">{PRICING_COPY.enterpriseTitle}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{PRICING_COPY.enterpriseBody}</ProovraText>
          {onTalkToSales ? (
            <ProovraButton label={PRICING_COPY.talkToSales} variant="secondary" fullWidth={false} onPress={onTalkToSales} />
          ) : null}
        </ProovraCard>

        {/* Named on its own: display, never a purchase. */}
        <ProovraText variant="label" color={theme.color.ink.muted}>{PURCHASE_PENDING_NOTE}</ProovraText>
        <ProovraButton label="Close" variant="ghost" onPress={onClose} />
      </View>
    </ProovraSheet>
  );
}
